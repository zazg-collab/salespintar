import { redisCache } from '../config/redis';
import { logger } from '../utils/logger';

// ──────────────────────────────────────────────────────────────────────────────
// STATE SERVICE — Fix Audit A5
//
// Sebelumnya 3 state kritis disimpan di memory (Map) di ai.service.ts dan
// message.service.ts:
//   1. lastReplyTimestamps — rate limit antar balasan AI
//   2. consecutiveReplies  — counter balasan beruntun
//   3. debounceMap         — buffer pesan beruntun + timer setTimeout
//
// Dampak versi lama: hilang saat restart/deploy, tidak efektif saat horizontal
// scaling (tiap instance punya Map sendiri), dan debounceMap bocor pelan-pelan
// karena tidak pernah dibersihkan.
//
// Semua state sekarang pindah ke Redis dengan TTL. Timer setTimeout diganti
// BullMQ delayed job (lihat debounce.queue.ts / debounce.worker.ts) supaya
// instance manapun bisa mem-flush buffer, bukan cuma instance yang kebetulan
// menerima pesan pertama.
// ──────────────────────────────────────────────────────────────────────────────

const PREFIX = 'salespintar:state';

// ──────────────────────────────────────────────────────────────────────────────
// DAFTAR PESAN KIRIMAN BOT SENDIRI
//
// Dipakai fitur auto-pause. Persoalannya: WhatsApp mengirimkan balik SETIAP
// pesan keluar dari nomor ini sebagai kejadian `fromMe: true` — termasuk pesan
// yang baru saja dikirim bot sendiri. Kalau setiap `fromMe` dianggap "manusia
// mengambil alih", bot akan menidurkan dirinya sendiri tepat sesudah balasan
// pertamanya, dan seluruh fitur bot mati tanpa satu pun pesan galat.
//
// Karena itu tiap pesan yang dikirim bot dicatat id-nya sebentar. Saat kejadian
// `fromMe` datang, id-nya dicocokkan: ada di daftar berarti kiriman bot sendiri
// (abaikan), tidak ada berarti manusia yang mengetik dari HP (tidurkan bot).
//
// Disimpan di Redis, bukan di memori proses — supaya tetap benar sesudah restart
// dan tetap benar kalau nanti di VPS ada lebih dari satu instance yang jalan.
// Instance A bisa mengirim pesan sementara kejadian `fromMe`-nya diterima
// instance B; daftar di memori akan salah menuduh manusia.
// ──────────────────────────────────────────────────────────────────────────────

/** Cukup panjang untuk menampung keterlambatan echo WhatsApp, cukup pendek
 *  supaya daftarnya tidak menumpuk selamanya. */
const OUTGOING_ID_TTL_SEC = 60 * 30;

function outgoingKey(businessId: string, messageId: string): string {
  return `${PREFIX}:sent:${businessId}:${messageId}`;
}

/** Catat bahwa pesan ini dikirim oleh bot, bukan manusia. */
export async function rememberBotSentMessage(businessId: string, messageId: string): Promise<void> {
  if (!messageId) return;
  try {
    await redisCache.set(outgoingKey(businessId, messageId), '1', 'EX', OUTGOING_ID_TTL_SEC);
  } catch (err) {
    logger.warn(`[State] Gagal mencatat id pesan keluar ${messageId}: ${err}`);
  }
}

/**
 * Apakah pesan ini kiriman bot sendiri?
 *
 * Saat Redis bermasalah, jawabannya `true` — DISENGAJA. Salah menebak "ini
 * kiriman bot" cuma membuat auto-pause tidak jalan sekali itu. Salah menebak
 * "ini manusia" akan menidurkan bot untuk pelanggan yang sedang dilayaninya,
 * dan tidak ada yang akan membangunkannya. Dari dua kesalahan, pilih yang bisa
 * dipulihkan sendiri.
 */
export async function wasSentByBot(businessId: string, messageId: string): Promise<boolean> {
  if (!messageId) return true;
  try {
    return (await redisCache.exists(outgoingKey(businessId, messageId))) === 1;
  } catch (err) {
    logger.warn(`[State] Gagal memeriksa id pesan keluar ${messageId}, dianggap kiriman bot: ${err}`);
    return true;
  }
}

/** Jeda minimum antar balasan AI untuk satu lead. */
export const RATE_LIMIT_MS = 3000;
/** Maksimum balasan AI beruntun per lead dalam satu window. */
export const CONSECUTIVE_LIMIT = 3;
/** Panjang window counter beruntun (fixed window, bukan sliding). */
export const CONSECUTIVE_WINDOW_SEC = 60 * 60;
/** Lama menunggu pesan susulan sebelum buffer di-flush ke AI. */
export const DEBOUNCE_MS = 4000;
/** Batas chunk per window debounce (fix audit B7 — dipertahankan). */
export const DEBOUNCE_MAX_CHUNKS = 10;
/** Jaring pengaman: buffer yang tidak pernah ter-flush hilang sendiri. */
const DEBOUNCE_TTL_SEC = 300;

const rateKey = (leadId: string) => `${PREFIX}:ratelimit:${leadId}`;
const consKey = (leadId: string) => `${PREFIX}:consecutive:${leadId}`;
const chunkKey = (businessId: string, waNumber: string) =>
  `${PREFIX}:debounce:${businessId}:${waNumber}:chunks`;
const metaKey = (businessId: string, waNumber: string) =>
  `${PREFIX}:debounce:${businessId}:${waNumber}:meta`;

// ──────────────────────────────────────────────────────────────────────────────
// 1. Rate limit antar balasan
// ──────────────────────────────────────────────────────────────────────────────

/**
 * True kalau lead ini baru saja dibalas AI (< RATE_LIMIT_MS lalu).
 *
 * Fail-open: kalau Redis tidak bisa dihubungi kita IZINKAN balasan. Memblokir
 * semua balasan hanya karena cache mati akan membuat bot bisu total — kerugian
 * lebih besar daripada risiko satu balasan terlalu cepat.
 */
export async function isReplyRateLimited(leadId: string): Promise<boolean> {
  try {
    return (await redisCache.exists(rateKey(leadId))) === 1;
  } catch (err) {
    logger.warn(`[State] Redis error saat cek rate limit lead ${leadId} (fail-open): ${err}`);
    return false;
  }
}

/** Tandai lead baru saja dibalas. Key hilang sendiri setelah RATE_LIMIT_MS. */
export async function markReplied(leadId: string): Promise<void> {
  try {
    await redisCache.set(rateKey(leadId), Date.now().toString(), 'PX', RATE_LIMIT_MS);
  } catch (err) {
    logger.warn(`[State] Redis error saat set rate limit lead ${leadId}: ${err}`);
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// 2. Counter balasan beruntun
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Jumlah balasan AI beruntun untuk lead ini dalam window berjalan.
 * Fail-open (0) kalau Redis bermasalah — lihat alasan di isReplyRateLimited.
 */
export async function getConsecutiveCount(leadId: string): Promise<number> {
  try {
    const raw = await redisCache.get(consKey(leadId));
    return raw ? Number(raw) || 0 : 0;
  } catch (err) {
    logger.warn(`[State] Redis error saat baca consecutive lead ${leadId} (fail-open): ${err}`);
    return 0;
  }
}

/**
 * Naikkan counter beruntun.
 *
 * TTL hanya dipasang saat counter pertama kali dibuat, jadi ini FIXED window
 * 1 jam sejak balasan pertama — bukan sliding window. Ini menjaga perilaku
 * "reset per jam" dari fix audit A7 tanpa perlu setInterval global, sekaligus
 * mencegah lead yang chat terus-menerus terkunci selamanya (yang akan terjadi
 * kalau TTL di-refresh tiap increment).
 */
export async function incrementConsecutive(leadId: string): Promise<number> {
  try {
    const count = await redisCache.incr(consKey(leadId));
    if (count === 1) {
      await redisCache.expire(consKey(leadId), CONSECUTIVE_WINDOW_SEC);
    }
    return count;
  } catch (err) {
    logger.warn(`[State] Redis error saat increment consecutive lead ${leadId}: ${err}`);
    return 0;
  }
}

/** Reset counter beruntun (mis. saat percakapan diambil alih manusia). */
export async function resetConsecutive(leadId: string): Promise<void> {
  try {
    await redisCache.del(consKey(leadId));
  } catch (err) {
    logger.warn(`[State] Redis error saat reset consecutive lead ${leadId}: ${err}`);
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// 3. Buffer debounce pesan beruntun
// ──────────────────────────────────────────────────────────────────────────────

export interface DebounceMeta {
  conversationId: string;
  leadId: string;
  leadName: string | null;
  waJid: string;
}

export interface DebouncePushResult {
  /** Nomor generasi buffer setelah pesan ini masuk. */
  generation: number;
  /** Jumlah chunk yang benar-benar tersimpan. */
  chunkCount: number;
  /** True kalau pesan ini dibuang karena buffer sudah penuh (batas B7). */
  dropped: boolean;
}

export interface DebounceFlushResult extends DebounceMeta {
  chunks: string[];
}

// Lua: tambah chunk + naikkan generasi + pasang TTL, dalam satu operasi atomik.
// Tanpa ini, dua pesan yang datang nyaris bersamaan (bisa dari dua instance
// berbeda) bisa saling menimpa hitungan chunk atau nomor generasi.
const PUSH_SCRIPT = `
local len = redis.call('LLEN', KEYS[1])
local dropped = 0
if len < tonumber(ARGV[1]) then
  redis.call('RPUSH', KEYS[1], ARGV[2])
  len = len + 1
else
  dropped = 1
end
local gen = redis.call('HINCRBY', KEYS[2], 'gen', 1)
if gen == 1 then
  redis.call('HSET', KEYS[2], 'conversationId', ARGV[3], 'leadId', ARGV[4], 'leadName', ARGV[5], 'waJid', ARGV[6])
end
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[7]))
redis.call('EXPIRE', KEYS[2], tonumber(ARGV[7]))
return {gen, len, dropped}
`;

// Lua: flush buffer HANYA kalau nomor generasi masih cocok, lalu hapus.
// Pengecekan dan penghapusan wajib atomik supaya dua job yang fired bersamaan
// tidak sama-sama merasa jadi pemenang dan mengirim dua balasan AI.
const FLUSH_SCRIPT = `
local gen = redis.call('HGET', KEYS[2], 'gen')
if not gen or gen ~= ARGV[1] then
  return nil
end
local chunks = redis.call('LRANGE', KEYS[1], 0, -1)
local conversationId = redis.call('HGET', KEYS[2], 'conversationId')
local leadId = redis.call('HGET', KEYS[2], 'leadId')
local leadName = redis.call('HGET', KEYS[2], 'leadName')
local waJid = redis.call('HGET', KEYS[2], 'waJid')
redis.call('DEL', KEYS[1], KEYS[2])
return {conversationId, leadId, leadName, waJid, chunks}
`;

/**
 * Masukkan satu pesan ke buffer debounce.
 *
 * Nomor generasi yang dikembalikan harus ikut dibawa job flush. Tiap pesan baru
 * menaikkan generasi, sehingga job lama otomatis jadi basi dan tidak jadi
 * mem-flush — inilah pengganti clearTimeout() versi in-memory.
 */
export async function pushDebounceChunk(
  businessId: string,
  waNumber: string,
  chunk: string,
  meta: DebounceMeta,
): Promise<DebouncePushResult | null> {
  try {
    const result = (await redisCache.eval(
      PUSH_SCRIPT,
      2,
      chunkKey(businessId, waNumber),
      metaKey(businessId, waNumber),
      String(DEBOUNCE_MAX_CHUNKS),
      chunk,
      meta.conversationId,
      meta.leadId,
      meta.leadName ?? '',
      meta.waJid,
      String(DEBOUNCE_TTL_SEC),
    )) as [number, number, number];

    return { generation: Number(result[0]), chunkCount: Number(result[1]), dropped: Number(result[2]) === 1 };
  } catch (err) {
    logger.error(`[State] Gagal push debounce chunk untuk ${businessId}:${waNumber}: ${err}`);
    return null;
  }
}

/**
 * Ambil & bersihkan buffer, tapi hanya kalau generasi masih yang terbaru.
 * Mengembalikan null kalau job ini sudah basi (ada pesan susulan) atau buffer
 * sudah keburu di-flush pihak lain.
 */
export async function flushDebounceIfCurrent(
  businessId: string,
  waNumber: string,
  generation: number,
): Promise<DebounceFlushResult | null> {
  try {
    const result = (await redisCache.eval(
      FLUSH_SCRIPT,
      2,
      chunkKey(businessId, waNumber),
      metaKey(businessId, waNumber),
      String(generation),
    )) as [string, string, string, string, string[]] | null;

    if (!result) return null;

    const [conversationId, leadId, leadName, waJid, chunks] = result;
    if (!conversationId || !leadId || !waJid || !chunks || chunks.length === 0) return null;

    return { conversationId, leadId, leadName: leadName || null, waJid, chunks };
  } catch (err) {
    logger.error(`[State] Gagal flush debounce untuk ${businessId}:${waNumber}: ${err}`);
    return null;
  }
}
