/**
 * Ingatan jawaban — hemat token untuk pertanyaan yang berulang.
 *
 * Toko yang ramai menerima pertanyaan yang sama berpuluh kali sehari: "berapa
 * harga X", "ongkir ke Y berapa", "ready ga". Tiap satu di antaranya membakar
 * satu panggilan Groq untuk menghasilkan jawaban yang praktis identik. Di tier
 * gratis dengan 6.000 token per menit, itu bukan cuma boros — itu yang bikin
 * pelanggan lain harus antre.
 *
 * ── Kenapa pencocokannya lewat vektor, bukan teks persis ────────────────────
 * "berapa harga pisau daging" dan "pisau daging brp duit" adalah pertanyaan yang
 * sama bagi manusia dan berbeda total bagi pencocokan teks. Kalau cocoknya harus
 * persis, ingatan ini nyaris tidak pernah kena.
 *
 * ── Empat pengaman, dan semuanya perlu ──────────────────────────────────────
 *
 * 1. AMBANG SANGAT TINGGI (0.95). Menyajikan jawaban lama untuk pertanyaan yang
 *    ternyata beda adalah kesalahan yang jauh lebih mahal daripada sekadar
 *    memanggil Groq sekali lagi. Ragu sedikit → jangan pakai.
 *
 * 2. JAWABAN BERNAMA TIDAK PERNAH DISIMPAN. Bot menyapa pelanggan dengan
 *    namanya ("Halo Fatih!"). Menyajikan ulang kalimat itu ke pelanggan lain
 *    berarti memanggil orang dengan nama orang lain — kesalahan yang langsung
 *    terasa dan sulit dimaafkan. Jadi jawaban yang memuat nama penanya tidak
 *    ikut disimpan sama sekali.
 *
 * 3. JAWABAN BERISI KLAIM HARGA/ONGKIR TIDAK PERNAH DISIMPAN (Fase 91). Jawaban
 *    semacam ini nyaris selalu spesifik untuk satu momen tertentu (kurir yang
 *    kebetulan melayani rute itu, kota yang kebetulan sedang ditanyakan) — kalau
 *    disajikan ulang ke pelanggan lain dengan pertanyaan mirip tapi konteks beda,
 *    hasilnya persis insiden "Purwokerto" malam ini: jawaban lama yang benar
 *    untuk pelanggan A dipakaikan ke pelanggan B tanpa lewat Supervisor sama
 *    sekali. Diperiksa lewat isi jawabannya sendiri (PRICE_PATTERN), bukan lewat
 *    dugaan niat pesan pemicunya — supaya pengamannya tidak bisa dilewati hanya
 *    karena giliran itu tidak terdeteksi sebagai "soal ongkir".
 *
 * 4. SELURUH INGATAN DIBUANG BEGITU PUSTAKA BERUBAH. Kalau harga diperbarui di
 *    Obsidian tapi jawaban lama masih tersimpan, bot akan menyebut harga lama
 *    dengan penuh percaya diri — dan pengaman anti-ngarang tidak akan
 *    menangkapnya, sebab yang diperiksa jawaban baru, bukan jawaban dari lemari.
 *    Ini pengaman yang paling penting dari keempatnya.
 */

import { prisma } from '../config/prisma';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import { knowledgeService } from './knowledge.service';
import { PRICE_PATTERN } from './supervisor.service';

/** Ragu sedikit pun, lebih baik tanya Groq lagi. */
const SIMILARITY_THRESHOLD = 0.95;

/** Jawaban terlalu pendek biasanya sapaan; menyimpannya tidak menghemat apa pun. */
const MIN_ANSWER_CHARS = 40;

/**
 * Apakah jawaban ini aman disimpan untuk dipakai ulang ke pelanggan lain?
 *
 * Dibuat konservatif dengan sengaja: yang lolos hanyalah jawaban yang benar-benar
 * bersifat umum.
 */
function isReusable(reply: string, leadName: string | null): { ok: boolean; reason?: string } {
  const text = reply.trim();
  if (text.length < MIN_ANSWER_CHARS) return { ok: false, reason: 'terlalu pendek' };

  if (leadName) {
    // Nama bisa terdiri dari beberapa kata; tiap penggalan diperiksa supaya
    // "Halo Fatih" tetap tertangkap walau namanya "Fatih Ramadhan".
    const parts = leadName.split(/\s+/).filter(p => p.length >= 3);
    for (const part of parts) {
      const re = new RegExp(`(?:^|[^a-z0-9])${part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:[^a-z0-9]|$)`, 'i');
      if (re.test(text)) return { ok: false, reason: 'memuat nama pelanggan' };
    }
  }

  // Fase 91 — diperiksa lewat ISI jawabannya sendiri, bukan lewat dugaan niat
  // pesan pemicunya. Sebelum ini pengamannya cuma jalan lewat flag `giliranOngkir`
  // di ai.service.ts, yang dihitung dari intent pesan pengguna — kalau intent-nya
  // salah tebak (atau fungsi ini dipanggil dari jalur lain suatu hari nanti),
  // jawaban berisi harga/ongkir tetap bisa lolos tersimpan lewat celah itu.
  if (PRICE_PATTERN.test(text)) {
    return { ok: false, reason: 'memuat klaim harga/ongkir' };
  }

  return { ok: true };
}

export async function lookupCachedAnswer(
  businessId: string,
  question: string,
): Promise<string | null> {
  if (!env.ANSWER_CACHE_ENABLED) return null;

  try {
    // Pertanyaan → prefiks "query", sama seperti saat mencari pengetahuan.
    const embedding = await knowledgeService.getEmbedding(question, 'query');
    const vector = `[${embedding.join(',')}]`;

    const rows = await prisma.$queryRawUnsafe<{ answer: string; similarity: number }[]>(
      `SELECT answer, 1 - (embedding <=> $2::vector) AS similarity
         FROM answer_cache
        WHERE business_id = $1::uuid
          AND created_at > NOW() - ($3 || ' seconds')::interval
        ORDER BY embedding <=> $2::vector
        LIMIT 1`,
      businessId, vector, String(env.ANSWER_CACHE_TTL_SEC),
    );

    const hit = rows[0];
    if (!hit || Number(hit.similarity) < SIMILARITY_THRESHOLD) return null;

    logger.info(`[AnswerCache] Kena (kemiripan ${Number(hit.similarity).toFixed(3)}) — Groq tidak dipanggil`);
    return hit.answer;
  } catch (err) {
    // Ingatan ini murni penghemat. Kegagalannya tidak boleh menghalangi
    // pelanggan mendapat jawaban — cukup lewati dan panggil Groq seperti biasa.
    logger.warn(`[AnswerCache] Pencarian gagal, dilewati: ${err}`);
    return null;
  }
}

export async function rememberAnswer(params: {
  businessId: string;
  question: string;
  answer: string;
  leadName: string | null;
}): Promise<void> {
  if (!env.ANSWER_CACHE_ENABLED) return;

  const verdict = isReusable(params.answer, params.leadName);
  if (!verdict.ok) {
    logger.debug(`[AnswerCache] Tidak disimpan (${verdict.reason})`);
    return;
  }

  try {
    const embedding = await knowledgeService.getEmbedding(params.question, 'query');
    const vector = `[${embedding.join(',')}]`;
    await prisma.$executeRawUnsafe(
      `INSERT INTO answer_cache (id, business_id, question, answer, embedding, created_at)
       VALUES (gen_random_uuid(), $1::uuid, $2, $3, $4::vector, NOW())`,
      params.businessId, params.question.slice(0, 500), params.answer, vector,
    );
  } catch (err) {
    logger.warn(`[AnswerCache] Gagal menyimpan, diabaikan: ${err}`);
  }
}

/**
 * Buang seluruh ingatan milik satu bisnis.
 *
 * Dipanggil setiap kali pustaka berubah. Sengaja membuang SEMUANYA, bukan
 * mencoba menebak jawaban mana yang terpengaruh oleh dokumen yang barusan
 * diubah — tebakan semacam itu pasti salah sesekali, dan yang lolos adalah
 * harga lama yang disebut dengan penuh percaya diri.
 */
export async function forgetAllAnswers(businessId: string): Promise<void> {
  try {
    const deleted = await prisma.$executeRawUnsafe(
      `DELETE FROM answer_cache WHERE business_id = $1::uuid`,
      businessId,
    );
    if (deleted > 0) {
      logger.info(`[AnswerCache] Pustaka berubah — ${deleted} jawaban tersimpan dibuang`);
    }
  } catch (err) {
    logger.warn(`[AnswerCache] Gagal membuang ingatan: ${err}`);
  }
}
