import { Job } from 'bullmq';
import { complete, isRateLimit } from '../services/llm';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import { knowledgeService } from '../services/knowledge.service';
import { bumpProcessed, bumpFailed, upsertQuestion, getSessionStatus } from '../services/question-miner.repo';
import type { QuestionMiningJobData, QuestionMiningResult } from './question-mining.queue';


// ──────────────────────────────────────────────────────────────────────────────
// QUESTION MINER — worker
//
// Perbedaan mendasar dari Shadow Mining, dan ini bukan detail teknis melainkan
// seluruh alasan fitur ini ada:
//
//   Shadow Mining  membaca percakapan dan MENULIS SENDIRI jawabannya.
//   Question Miner cuma memungut PERTANYAAN. Jawaban CS tidak pernah sampai ke
//                  sini — sudah dibuang sebelum job dibuat.
//
// Konsekuensinya: apa pun yang salah diketik CS dua tahun lalu tidak bisa masuk
// pustaka lewat jalur ini. Pertanyaan pelanggan tidak pernah basi; "berapa harga
// X" tetap relevan bertahun-tahun kemudian, sedangkan jawabannya belum tentu.
// ──────────────────────────────────────────────────────────────────────────────

interface ExtractedQuestion {
  question: string;
  sample: string;
  category: 'Produk' | 'SOP' | 'FAQ';
}

// ──────────────────────────────────────────────────────────────────────────────
// PEMBATASAN LAJU GROQ
//
// Groq tier gratis membatasi 6.000 token PER MENIT untuk llama-3.1-8b-instant —
// dan itu batas gabungan input + output untuk seluruh organisasi, bukan per
// permintaan. Versi pertama fitur ini mengirim satu file utuh (12.000 karakter)
// dalam sekali panggil dan langsung ditolak 413: satu permintaan saja sudah
// melebihi jatah semenit penuh.
//
// Dua hal yang memperbaikinya, dan keduanya perlu:
//   1. Potongan diperkecil, supaya satu permintaan muat.
//   2. Jarak antar-permintaan dijaga, supaya sepuluh potongan kecil tidak
//      menghabiskan jatah semenit dalam lima detik.
//
// Kalau Angga naik ke tier berbayar, cukup kecilkan LLM_MIN_GAP_MS_MINER di .env
// — sejak lapisan llm.ts, itu env, bukan lagi konstanta di kode ini.
// ──────────────────────────────────────────────────────────────────────────────

/** ~700 token untuk teks Indonesia. Ditambah prompt sistem (~450) dan keluaran
 *  (maks 800), satu panggilan berada di sekitar 2.000 token — muat di jatah. */
const MAX_CHARS_PER_CALL = 2500;

/** Keluaran dibatasi karena ikut dihitung ke jatah token per menit. */
const MAX_OUTPUT_TOKENS = 800;

/** Pengaman supaya satu file raksasa tidak menyandera antrean berjam-jam. */
const MAX_CHUNKS_PER_FILE = 20;

// ── Pembatas laju & retry PINDAH ke src/services/llm.ts ─────────────────────
// Dulu di sini ada `MIN_GAP_MS`, `lastGroqCallAt`, `waitForSlot()`,
// `isRateLimit()`, dan satu loop backoff di `extractQuestions()`.
//
// `lastGroqCallAt` adalah variabel MODUL, dan itu hanya benar selama worker ini
// `concurrency: 1`. Kuota token Groq berlaku per ORGANISASI, sementara yang
// memanggilnya ada tiga proses: server Express (balasan pelanggan), worker ini,
// dan CLI audit. Penghitung per-proses tidak pernah mewakili keadaan sebenarnya
// — ia cuma belum terlihat salah karena kebetulan concurrency-nya satu.
//
// Sekarang gerbangnya kunci ber-TTL di Redis, per pekerjaan, dan jaraknya diatur
// `LLM_MIN_GAP_MS_MINER` (bawaan 21.000 ms ≈ 3 panggilan/menit — nilai yang sama
// seperti sebelumnya). Komentar lama di berkas ini sendiri sudah mengakui
// masalahnya: "kalau Angga naik ke tier berbayar, cukup kecilkan MIN_GAP_MS" —
// yaitu menyuruh mengedit KODE untuk hal yang seharusnya konfigurasi.

/** Pecah baris pelanggan jadi potongan yang muat di satu panggilan. Baris tunggal
 *  yang kelewat panjang dipotong keras — lebih baik kehilangan ekornya daripada
 *  seluruh potongan ditolak. */
function chunkLines(lines: string[], maxChars: number): string[][] {
  const chunks: string[][] = [];
  let current: string[] = [];
  let size = 0;
  for (const raw of lines) {
    const line = raw.length > maxChars ? raw.slice(0, maxChars) : raw;
    if (size + line.length + 1 > maxChars && current.length > 0) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(line);
    size += line.length + 1;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

async function extractQuestionsFromChunk(
  lines: string[],
  businessId?: string,
): Promise<ExtractedQuestion[]> {
  const joined = lines.join('\n');
  if (joined.trim().length < 20) return [];

  // Gerbang jeda, batas keluaran (MAX_OUTPUT_TOKENS), suhu 0, dan JSON dipasang
  // oleh JobConfig 'miner' di llm.ts. Tugasnya memungut & merapikan, bukan
  // menalar — jadi ini kandidat pertama untuk model paling murah.
  const resp = await complete('miner', {
    businessId,
    messages: [
      {
        role: 'system',
        content: `Kamu adalah alat penambang PERTANYAAN dari chat pelanggan.

Yang kamu terima HANYA ucapan pelanggan (ucapan CS sudah dibuang). Tugasmu:
kumpulkan pertanyaan yang pelanggan ajukan, lalu tulis ulang tiap pertanyaan
dalam bentuk baku yang rapi.

ATURAN:
1. HANYA ambil kalimat yang benar-benar menanyakan sesuatu. Sapaan, ucapan
   terima kasih, konfirmasi ("oke", "siap", "sudah tf"), dan curhat BUKAN
   pertanyaan.
2. JANGAN menjawab apa pun. Kamu tidak tahu jawabannya dan tidak boleh menebak.
3. JANGAN mengarang pertanyaan yang tidak ada di teks.
4. Buang data pribadi dari kutipan contoh: nama, nomor HP, alamat, nomor resi.
5. Tulis pertanyaan baku dalam Bahasa Indonesia yang wajar, huruf kecil, tanpa
   tanda tanya. Contoh: "bang pisau daging brp?" → "berapa harga pisau daging"
6. Kalau pelanggan menanyakan hal yang sama beberapa kali, cukup tulis SEKALI.

Kategori:
- Produk : menanyakan barang, harga, ukuran, bahan, ketersediaan
- SOP    : menanyakan pengiriman, ongkir, retur, garansi, pembayaran, prosedur
- FAQ    : selebihnya

Output JSON: {"questions": [{"question": "...", "sample": "kutipan asli singkat", "category": "Produk"}]}
Kalau tidak ada pertanyaan sama sekali: {"questions": []}`,
      },
      { role: 'user', content: `UCAPAN PELANGGAN:\n${joined}` },
    ],
  });

  try {
    const parsed = JSON.parse(resp.text || '{}');
    if (!Array.isArray(parsed.questions)) return [];
    return parsed.questions
      .filter((q: any) => q && typeof q.question === 'string' && q.question.trim().length >= 5)
      .map((q: any) => ({
        question: String(q.question).trim().toLowerCase(),
        sample: String(q.sample || q.question).trim(),
        category: ['Produk', 'SOP', 'FAQ'].includes(q.category) ? q.category : 'FAQ',
      }));
  } catch (err) {
    logger.warn(`[QuestionMiner] JSON parse error: ${err}`);
    return [];
  }
}

/**
 * Tambang seluruh file, potongan demi potongan.
 *
 * Kena batas laju TIDAK dianggap kegagalan — cuma disuruh menunggu lalu diulang.
 * Membiarkannya jadi galat akan menandai seluruh sesi gagal padahal yang terjadi
 * cuma antre.
 */
async function extractQuestions(
  customerLines: string[],
  filename: string,
  businessId?: string,
): Promise<ExtractedQuestion[]> {
  let chunks = chunkLines(customerLines, MAX_CHARS_PER_CALL);

  if (chunks.length > MAX_CHUNKS_PER_FILE) {
    // Aturan rumah: pembatasan cakupan tidak boleh diam-diam.
    logger.warn(
      `[QuestionMiner] ${filename} terlalu panjang: ${chunks.length} potongan, ` +
      `dipangkas ke ${MAX_CHUNKS_PER_FILE}. Sisa percakapan tidak ditambang.`,
    );
    chunks = chunks.slice(0, MAX_CHUNKS_PER_FILE);
  }

  const seen = new Set<string>();
  const all: ExtractedQuestion[] = [];

  // Loop retry untuk galat jatah token DIHAPUS dari sini — sekarang milik
  // llm.ts, satu tempat untuk kesembilan pekerjaan. Backoff-nya tetap linier
  // dengan batas 4 percobaan (`LLM_MAX_ATTEMPTS`), sama seperti sebelumnya.
  for (let i = 0; i < chunks.length; i++) {
    const found = await extractQuestionsFromChunk(chunks[i]!, businessId);
    for (const q of found) {
      // Dedup murah di dalam satu file, supaya tidak menghitung embedding
      // untuk pertanyaan yang sama berulang kali.
      if (seen.has(q.question)) continue;
      seen.add(q.question);
      all.push(q);
    }
    logger.info(`[QuestionMiner] ${filename}: potongan ${i + 1}/${chunks.length} selesai (${all.length} pertanyaan sejauh ini)`);
  }

  return all;
}

export async function handleQuestionMining(
  job: Job<QuestionMiningJobData>,
): Promise<QuestionMiningResult> {
  const { sessionId, businessId, filename, customerLines } = job.data;

  // Diperiksa SEBELUM memanggil Groq, bukan sesudah. Job yang antre bisa saja
  // baru dapat giliran beberapa menit setelah tombol Batal ditekan; menambang
  // dulu baru memeriksa berarti tokennya sudah terbakar sia-sia.
  const status = await getSessionStatus(sessionId);
  if (status === 'cancelled') {
    logger.info(`[QuestionMiner] ${filename} dilewati — sesi dibatalkan`);
    return { created: 0, merged: 0, skipped: 'cancelled' };
  }

  logger.info(`[QuestionMiner] Mulai ${filename} (${customerLines.length} baris pelanggan)`);

  try {
    const questions = await extractQuestions(customerLines, filename, businessId);
    await job.updateProgress(50);

    if (questions.length === 0) {
      logger.info(`[QuestionMiner] ${filename}: tidak ada pertanyaan`);
      await bumpProcessed(sessionId);
      return { created: 0, merged: 0, skipped: 'no_questions' };
    }

    let created = 0;
    let merged = 0;

    for (const q of questions) {
      // Ini PERTANYAAN, bukan dokumen — jadi prefiks "query", bukan "passage".
      // Salah prefiks pada E5 bukan cuma kurang optimal, tapi bisa membuat
      // hasilnya lebih buruk daripada tanpa prefiks sama sekali.
      const embedding = await knowledgeService.getEmbedding(q.question, 'query');
      const outcome = await upsertQuestion({
        businessId,
        sessionId,
        question: q.question,
        sampleRaw: q.sample,
        category: q.category,
        embedding,
      });
      if (outcome === 'created') created++; else merged++;
    }

    await bumpProcessed(sessionId);
    await job.updateProgress(100);
    logger.info(`[QuestionMiner] ${filename}: ${created} baru, ${merged} digabung`);
    return { created, merged };
  } catch (err) {
    // Satu file gagal tidak menjatuhkan seluruh sesi. Hitungannya tetap dinaikkan
    // supaya progresnya tidak menggantung selamanya di angka yang sama.
    const raw = err instanceof Error ? err.message : String(err);
    logger.error(
      `[QuestionMiner] ${filename} GAGAL${isRateLimit(err) ? ' (batas token Groq)' : ''}: ${raw}`,
    );

    if (job.attemptsMade >= 2) {
      await bumpProcessed(sessionId);
      await bumpFailed(sessionId);
    }
    throw err;
  }
}
