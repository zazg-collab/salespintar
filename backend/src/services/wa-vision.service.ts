/**
 * Pembaca gambar dari pelanggan — Fase 65.
 *
 * ── Lubang yang ditutup ──────────────────────────────────────────────────────
 * Sebelum ini `message.service.ts` punya "Filter 2: Hanya pesan teks" yang
 * berbunyi `// Abaikan gambar, video, dokumen, stiker secara silent` lalu
 * `return`. Akibatnya pelanggan yang mengirim FOTO — bukti transfer, tangkapan
 * layar harga, foto produk yang dia mau — dijawab dengan **kesunyian total**.
 * Bahkan CAPTION-nya tidak dibaca, padahal caption itu teks biasa yang sudah
 * ada di payload dan tidak butuh model apa pun.
 *
 * Diam itu lebih buruk daripada jawaban yang kurang tepat: pelanggan tidak tahu
 * pesannya sampai atau tidak, dan tidak ada satu pun baris di dashboard yang
 * memberitahu Angga bahwa itu terjadi (log-nya `logger.debug`).
 *
 * ── Tiga lapis, dari yang paling murah ───────────────────────────────────────
 *  1. CAPTION — gratis, seketika, tidak butuh model. Selalu dibaca.
 *  2. MODEL PENGLIHATAN — `complete('vision', …)` dengan gambar base64.
 *     Mahal, jadi dibatasi: ukuran berkas, jumlah per pelanggan per hari, dan
 *     bisa dimatikan lewat `VISION_ENABLED`.
 *  3. AJAKAN MENGETIK — kalau dua lapis di atas tidak menghasilkan apa pun,
 *     pelanggan diberi satu pesan tetap (BUKAN dari model) supaya tidak pernah
 *     lagi ada kesunyian. Ber-jeda, supaya lima stiker tidak dijawab lima kali.
 *
 * ── Kenapa base64, bukan URL ─────────────────────────────────────────────────
 * Media WhatsApp terenkripsi dan tidak punya URL publik — harus diunduh lalu
 * didekripsi lokal. Groq membatasi 4 MB untuk gambar base64 (20 MB hanya untuk
 * URL), jadi batas itu yang berlaku di sini. Lihat `baileysManager.downloadMedia`.
 */

import { proto, extractMessageContent } from '@whiskeysockets/baileys';
import { complete, modelMungkinBisaGambar, resolveModelBerlaku } from './llm';
import { baileysManager } from './baileys.service';
import { redisCache as redisClient } from '../config/redis';
import { logger } from '../utils/logger';
import { env } from '../config/env';
import { toJakartaDateStr } from '../utils/timezone';

/** Jenis media yang bisa membawa caption. Urutannya tidak penting; keberadaannya iya. */
type MediaBerCaption =
  | proto.Message.IImageMessage
  | proto.Message.IVideoMessage
  | proto.Message.IDocumentMessage;

export interface IsiMedia {
  /** Ada media sama sekali di pesan ini? */
  adaMedia: boolean;
  /** Ada GAMBAR yang bisa dibaca model? (stiker & video sengaja tidak dihitung.) */
  adaGambar: boolean;
  /** Caption apa adanya. String kosong kalau tidak ada. */
  caption: string;
  /** Label pendek untuk kolom `messageType` & log: 'image' | 'video' | 'document' | 'sticker' | 'audio'. */
  jenis: string;
}

/**
 * Baca bagian media dari satu pesan — TANPA memanggil model apa pun.
 *
 * Dipisah dari pembacaan gambar supaya pemanggil bisa memutuskan urutannya:
 * simpan pesan ke DB dulu (pakai caption), baru keluarkan biaya untuk model.
 */
export function periksaMedia(msg: proto.IWebMessageInfo): IsiMedia {
  const m = extractMessageContent(msg.message);
  const gambar = m?.imageMessage ?? null;
  const video = m?.videoMessage ?? null;
  const dokumen = m?.documentMessage ?? null;
  const stiker = m?.stickerMessage ?? null;
  const audio = m?.audioMessage ?? null;

  const berCaption: MediaBerCaption | null = gambar ?? video ?? dokumen;
  const caption = (berCaption?.caption ?? '').trim();

  const jenis = gambar ? 'image'
    : video ? 'video'
    : dokumen ? 'document'
    : stiker ? 'sticker'
    : audio ? 'audio'
    : 'text';

  return {
    adaMedia: Boolean(gambar || video || dokumen || stiker || audio),
    // Stiker sengaja TIDAK dibaca model: hampir selalu tidak membawa informasi,
    // dan orang mengirimnya berturut-turut. Video juga tidak — model gambar tidak
    // bisa membacanya, dan mengirim thumbnail-nya akan menagih biaya untuk
    // jawaban yang hampir pasti salah.
    adaGambar: Boolean(gambar),
    caption,
    jenis,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Batas harian per pelanggan
//
// Gambar jauh lebih mahal daripada teks, dan satu orang bisa mengirim 30 foto
// dalam semenit tanpa niat jahat sama sekali. Kuota AI harian yang sudah ada
// (`incrementTodayAiCount`) tidak cukup: ia menghitung BALASAN, sedangkan yang
// mahal di sini adalah PEMBACAAN — dan pembacaan terjadi sebelum balasan.
//
// Kuncinya ber-tanggal supaya tidak perlu pekerjaan pembersih: kunci hari lalu
// kedaluwarsa sendiri. Pola yang sama dipakai `rate-limit.service.ts`.
// ─────────────────────────────────────────────────────────────────────────────
const KUNCI_KUOTA = (leadId: string, tanggal: string) => `vision:hari:${leadId}:${tanggal}`;

/** Tanggal zona Jakarta — sama seperti kuota harian AI, supaya reset-nya sejalan. */
function tanggalJakarta(): string {
  return toJakartaDateStr();
}

async function ambilKuotaGambar(leadId: string): Promise<{ boleh: boolean; terpakai: number }> {
  const kunci = KUNCI_KUOTA(leadId, tanggalJakarta());
  try {
    const terpakai = await redisClient.incr(kunci);
    // Pasang masa berlaku HANYA pada penambahan pertama; memanggilnya tiap kali
    // akan menggeser jendela dan membuat kuota tidak pernah benar-benar reset.
    if (terpakai === 1) await redisClient.expire(kunci, 36 * 60 * 60);
    return { boleh: terpakai <= env.VISION_DAILY_CAP_PER_LEAD, terpakai };
  } catch (err) {
    // Redis bermasalah → JANGAN diam-diam membuka kuota tanpa batas. Yang hilang
    // kalau kita menolak cuma pembacaan satu gambar; yang hilang kalau kita
    // membuka adalah tagihan tanpa pagar.
    logger.warn(`[Vision] Kuota gambar tidak bisa diperiksa (${err}) — pembacaan dilewati`);
    return { boleh: false, terpakai: -1 };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Jeda pesan "boleh diketik saja"
// ─────────────────────────────────────────────────────────────────────────────
const KUNCI_JEDA_AJAKAN = (leadId: string) => `vision:ajakan:${leadId}`;

/**
 * Sudah boleh mengirim ajakan mengetik ke pelanggan ini?
 *
 * `SET … PX … NX` sebagai gerbang — pola yang sama dengan gerbang laju di
 * `llm.ts`. Tanpa jeda ini, lima stiker berturut-turut dijawab lima kali, dan
 * itu terlihat lebih rusak daripada diam.
 */
export async function bolehKirimAjakanKetik(leadId: string): Promise<boolean> {
  try {
    const hasil = await redisClient.set(
      KUNCI_JEDA_AJAKAN(leadId), '1',
      'PX', Math.max(1, env.MEDIA_HINT_COOLDOWN_SEC) * 1000,
      'NX',
    );
    return hasil === 'OK';
  } catch (err) {
    // Gagal memeriksa jeda → jangan kirim. Diam sekali lebih baik daripada
    // membanjiri pelanggan dengan pesan yang sama.
    logger.warn(`[Vision] Jeda ajakan tidak bisa diperiksa (${err}) — ajakan dilewati`);
    return false;
  }
}

/** Pesan tetap, BUKAN dari model — supaya bunyinya tidak pernah berubah-ubah. */
export const AJAKAN_KETIK: Record<string, string> = {
  image: 'Maaf Kak, gambarnya belum bisa saya buka di sini. Boleh diketik saja isinya? Biar saya bantu lebih cepat.',
  video: 'Maaf Kak, videonya belum bisa saya buka. Boleh diketik saja yang mau ditanyakan?',
  document: 'Maaf Kak, dokumennya belum bisa saya buka di sini. Boleh diketik saja poin pentingnya?',
  sticker: 'Ada yang bisa saya bantu, Kak?',
  audio: 'Maaf Kak, pesan suaranya belum bisa saya dengar. Boleh diketik saja?',
};

// ─────────────────────────────────────────────────────────────────────────────
// Pembacaan gambar
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Instruksi pembaca. Ditulis sebagai ATURAN, bukan saran — pelajaran Fase 45,
 * dan di sini taruhannya konkret: model yang "membantu" akan menyimpulkan bahwa
 * transfer sudah masuk, padahal yang dilihatnya cuma tangkapan layar.
 */
const PROMPT_PEMBACA = `Kamu membaca satu gambar yang dikirim pelanggan ke customer service toko online.

Tugasmu HANYA melaporkan apa yang benar-benar terlihat. Kamu TIDAK menjawab pelanggan dan TIDAK memberi saran.

Aturan:
- Tulis dalam bahasa Indonesia, ringkas, maksimal 6 baris.
- Kalau ada tulisan di gambar (nominal, nama bank, nomor resi, nama produk, harga), SALIN apa adanya. Jangan dibulatkan, jangan diperbaiki.
- Kalau tulisannya tidak terbaca jelas, katakan "tidak terbaca". Jangan menebak angka.
- JANGAN menyimpulkan bahwa pembayaran sudah diterima, pesanan sudah dikirim, atau stok tersedia. Kamu cuma melihat gambar, bukan sistem toko.
- Kalau gambarnya tidak berhubungan dengan belanja, katakan itu apa dengan singkat.

Mulai jawabanmu langsung dengan isinya, tanpa pembukaan.`;

export interface HasilBacaGambar {
  ok: boolean;
  /** Deskripsi yang siap disuntikkan ke jalur balasan. Kosong kalau gagal. */
  bacaan: string;
  /** Kenapa gagal — untuk log, bukan untuk pelanggan. */
  alasan?: 'dimatikan' | 'kuota' | 'terlalu_besar' | 'unduh_gagal' | 'model_gagal' | 'kosong';
}

/**
 * Baca satu gambar dari pesan WhatsApp.
 *
 * Semua kegagalan mengembalikan `ok: false` dengan alasan — TIDAK melempar.
 * Kegagalan membaca satu foto tidak boleh menjatuhkan penanganan pesan, dan
 * `alasan` yang eksplisit membuat log bisa membedakan "dimatikan" dari "gagal",
 * dua hal yang tanpa itu terlihat sama persis (pelajaran Fase 57).
 */
export async function bacaGambar(
  businessId: string,
  leadId: string,
  msg: proto.IWebMessageInfo,
  correlationId?: string,
): Promise<HasilBacaGambar> {
  if (!env.VISION_ENABLED) return { ok: false, bacaan: '', alasan: 'dimatikan' };

  const { boleh, terpakai } = await ambilKuotaGambar(leadId);
  if (!boleh) {
    logger.info(
      `[Vision] Lewati gambar dari lead ${leadId} — kuota harian ` +
      `${terpakai}/${env.VISION_DAILY_CAP_PER_LEAD} terpakai`,
    );
    return { ok: false, bacaan: '', alasan: 'kuota' };
  }

  const media = await baileysManager.downloadMedia(businessId, msg);
  if (!media) return { ok: false, bacaan: '', alasan: 'unduh_gagal' };

  if (media.buffer.byteLength > env.VISION_MAX_IMAGE_BYTES) {
    logger.info(
      `[Vision] Gambar ${Math.round(media.buffer.byteLength / 1024)} KB melewati batas ` +
      `${Math.round(env.VISION_MAX_IMAGE_BYTES / 1024)} KB — tidak dikirim ke model`,
    );
    return { ok: false, bacaan: '', alasan: 'terlalu_besar' };
  }

  // Peringatan sekali per pembacaan, bukan pagar: daftar model bisa-gambar pasti
  // basi suatu hari, dan menolak berdasarkan daftar basi berarti mematikan fitur
  // pada hari Groq menerbitkan model yang lebih baik.
  const { spec } = await resolveModelBerlaku('vision', businessId);
  if (!modelMungkinBisaGambar(spec)) {
    logger.warn(
      `[Vision] Model "${spec}" tidak dikenali bisa membaca gambar. Percobaan tetap ` +
      `dijalankan; kalau balasannya galat 400, itu sebabnya.`,
    );
  }

  const mime = media.mimetype.startsWith('image/') ? media.mimetype : 'image/jpeg';
  const dataUrl = `data:${mime};base64,${media.buffer.toString('base64')}`;

  try {
    const hasil = await complete('vision', {
      businessId,
      ...(correlationId ? { correlationId } : {}),
      messages: [
        { role: 'user', content: [
          { type: 'text', text: PROMPT_PEMBACA },
          { type: 'image_url', image_url: { url: dataUrl } },
        ] },
      ],
    });

    const bacaan = (hasil.text ?? '').trim();
    if (!bacaan) return { ok: false, bacaan: '', alasan: 'kosong' };

    logger.info(
      `[Vision] Gambar dibaca (${Math.round(media.buffer.byteLength / 1024)} KB, ` +
      `${hasil.model}, ${hasil.usage.promptTokens}+${hasil.usage.completionTokens} tok, ` +
      `${hasil.latencyMs} ms)`,
    );
    return { ok: true, bacaan };
  } catch (err) {
    // Sudah dicatat ke `llm_calls` dengan ok=false oleh `complete()`, jadi di sini
    // cukup satu baris yang bisa dibaca manusia.
    logger.warn(`[Vision] Model gagal membaca gambar: ${(err as Error)?.message ?? err}`);
    return { ok: false, bacaan: '', alasan: 'model_gagal' };
  }
}

/**
 * Gabungkan caption + hasil bacaan jadi satu teks untuk jalur balasan.
 *
 * Bacaan gambar diberi tanda kurung siku dan disebut asalnya. Itu penting: tanpa
 * penanda, model pembalas tidak bisa membedakan "pelanggan MENGATAKAN sudah
 * transfer Rp 150.000" dari "SEBUAH GAMBAR memperlihatkan angka Rp 150.000" —
 * dan yang kedua bukan bukti apa pun soal uang masuk.
 */
export function gabungTeksDenganBacaan(caption: string, bacaan: string): string {
  const bagian: string[] = [];
  if (caption) bagian.push(caption);
  if (bacaan) {
    bagian.push(
      `[Pelanggan mengirim sebuah GAMBAR. Yang terlihat di gambar itu:\n${bacaan}\n` +
      `Catatan: ini hasil membaca gambar, BUKAN konfirmasi dari sistem toko. ` +
      `Jangan menyatakan pembayaran sudah diterima atau pesanan sudah diproses ` +
      `hanya berdasarkan gambar ini.]`,
    );
  }
  return bagian.join('\n\n');
}
