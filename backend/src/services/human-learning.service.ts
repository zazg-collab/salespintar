/**
 * Human Learning Service — CS Shadow Session Manager
 *
 * Arsitektur:
 * 1. Setiap CS staff punya sesi Baileys TERPISAH (read-only linked device).
 *    CS tetap balas dari HP biasa; sesi shadow hanya mendengar tanpa kirim.
 * 2. Setiap pesan yang terdeteksi (incoming/outgoing dari kontak pelanggan)
 *    di-buffer di Redis per kunci: hl:buf:{businessId}:{csPhone}:{contactJid}
 * 3. Buffer di-flush ke Shadow Mining (mode 'lenient') bila:
 *    - Sudah ada ≥ HL_BUFFER_MIN_PAIRS pair CS↔buyer, ATAU
 *    - Tidak ada pesan baru > HL_BUFFER_IDLE_SEC detik (diperiksa penyapu berulang
 *      `hl-idle-flush`, tiap HL_IDLE_CHECK_INTERVAL_SEC detik — lihat
 *      queues/hl-idle-flush.worker.ts)
 *
 * ⚠️ Baris di atas dulu berbunyi "diperiksa via BullMQ delayed job" — dan job itu
 *    TIDAK PERNAH DIBUAT. Selama itu, buffer yang tidak mencapai ambang baris
 *    dihapus Redis lewat TTL, bukan dikirim. Karena percakapan CS WhatsApp
 *    umumnya jauh di bawah ambang, hampir semua pengetahuan hilang tanpa jejak:
 *    30 Juli 2026 tercatat 37 pesan terbalas dengan 0 fakta disimpan. Kalau
 *    dokumentasi menjanjikan sesuatu, yang harus diperiksa keberadaannya, bukan
 *    dipercaya.
 * 4. Pipeline Shadow Mining tidak diubah sama sekali — hanya menerima kind:'human_learning'.
 *
 * Isolasi dari bot utama:
 * - Sesi CS disimpan di folder terpisah: {WA_SESSIONS_DIR}/cs-{csPhone}/
 * - Key Redis pakai prefix 'hl:' sehingga tidak bertabrakan dengan state bot.
 * - Model DB: CsHumanLearningSession (bukan WaCredential yang dipakai bot).
 */

import {
  makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  WASocket,
  proto,
} from '@whiskeysockets/baileys';
import type { WAVersion } from '@whiskeysockets/baileys';
import pino from 'pino';
import * as QRCode from 'qrcode';
import path from 'path';
import fs from 'fs';
import { prisma } from '../config/prisma';
import { logger } from '../utils/logger';
import { env } from '../config/env';
import { redisCache as redisClient } from '../config/redis';
import { shadowMiningQueue } from '../queues/shadow-mining.queue';
import { hitungBarisBerisi } from '../utils/text-chunker';
import { LeadProfilerService } from '../modules/leads/lead-profiler.service';

// ── Konfigurasi buffer ──────────────────────────────────────────────────────
/** Minimal baris supaya sebuah buffer layak dikirim. */
const HL_BUFFER_MIN_MESSAGES = env.HL_BUFFER_MIN_MESSAGES;
/** Kirim seketika begitu buffer mencapai jumlah baris ini. */
const HL_BUFFER_FLUSH_AT_LINES = env.HL_BUFFER_FLUSH_AT_LINES;
/** Detik tanpa pesan baru sebelum buffer dikirim oleh penyapu. */
const HL_BUFFER_IDLE_SEC = env.HL_BUFFER_IDLE_SEC;
/**
 * Umur kunci Redis — SENGAJA jauh lebih panjang dari ambang idle.
 *
 * Ini inti perbaikan 30 Juli 2026. Sebelumnya TTL = ambang idle, jadi buffer yang
 * tidak pernah mencapai ambang baris akan **DIHAPUS Redis** tepat saat ia
 * seharusnya dikirim. Tidak ada yang memungutnya lebih dulu, karena "BullMQ
 * delayed job" yang dijanjikan docstring di atas tidak pernah dibuat.
 *
 * Sekarang TTL cuma jaring pengaman terakhir (kalau penyapunya mati total),
 * bukan mekanisme kerja. Penyapu yang memutuskan, dan ia selalu tiba lebih dulu.
 */
/**
 * Umur buffer di Redis.
 *
 * Naik dari `max(idle*4, 3600)` = 60 menit jadi 6 JAM di Fase 69. 60 menit
 * terlihat cukup di atas kertas — penyapu jalan tiap 5 menit, jadi ia punya 12
 * kesempatan. Tapi kesempatan tidak menolong buffer yang belum memenuhi syarat:
 * ia dilewati 12 kali lalu dibuang.
 *
 * Dan 60 menit salah untuk alasan yang lebih sederhana: **percakapan WhatsApp
 * memang berhenti lalu lanjut lagi.** Pembeli bertanya harga, pergi makan, balas
 * dua jam kemudian. Dengan TTL 60 menit, separuh awal percakapan itu sudah
 * hilang saat separuh keduanya datang — dan yang tersisa jadi potongan pendek
 * yang tidak berarti apa-apa.
 *
 * Enam jam menampung jeda makan siang dan jeda rapat. Biayanya beberapa baris
 * teks di Redis per kontak; tidak sebanding dengan kehilangan konteksnya.
 */
const HL_BUFFER_TTL_SEC = Math.max(HL_BUFFER_IDLE_SEC * 12, 6 * 3600);
/** Prefix kunci Redis. */
const HL_PREFIX = 'hl:buf:';
/**
 * Stempel waktu pesan terakhir per buffer, epoch ms.
 *
 * Kunci terpisah, BUKAN diturunkan dari TTL. Cara lama menghitung
 * `idle = HL_BUFFER_IDLE_SEC - ttl` — cerdik, tapi pecah begitu TTL-nya diubah,
 * dan TTL memang harus diubah untuk perbaikan ini. Stempel eksplisit tidak bisa
 * salah baca.
 */
const HL_LAST_PREFIX = 'hl:last:';
/** Prefix kunci Redis untuk daftar id pesan yang sudah diproses (anti-dobel). */
const HL_SEEN_PREFIX = 'hl:seen:';
/** Umur daftar anti-dobel. */
const HL_SEEN_TTL_SEC = 86_400;
/**
 * Prefix penghitung pesan yang BELUM dititipkan ke Postgres.
 *
 * Naik seketika tiap pesan (INCR), lalu dititipkan ke kolom DB berbarengan
 * dengan pembaruan `lastSeenAt` yang sudah ter-throttle 60 detik. Satu UPDATE
 * Postgres per pesan masuk itu terlalu mahal untuk sesuatu yang cuma dipakai
 * memantau; sebaliknya, kalau hanya disimpan di DB per menit, angka di dashboard
 * terasa mati. Redis menutup jeda itu — API menjumlahkan (DB + pending).
 */
const HL_PEND_PREFIX = 'hl:pend:';
/**
 * Umur maksimal satu PERCOBAAN connect yang belum terautentikasi.
 *
 * QR WhatsApp berlaku ~60 detik dan Baileys menerbitkan QR baru selama socket
 * masih hidup. Selama percobaan masih di dalam jendela ini, permintaan QR
 * berikutnya TIDAK membuat socket baru — cukup ikut menunggu QR dari socket
 * yang sudah jalan. Kalau lewat, percobaan dianggap mati dan boleh diganti.
 *
 * Ini penjaga terhadap perang socket: sebelumnya tiap klik "Scan QR" membuat
 * socket baru yang menendang socket lama (pelajaran Fase 43 di bot utama).
 */
const HL_CONNECT_ATTEMPT_TTL_MS = 90_000;

// ── Tipe internal ────────────────────────────────────────────────────────────
interface CsInstance {
  sock: WASocket;
  csPhone: string;
  csName: string;
  businessId: string;
  sessionId: string;
  createdAt: number;
  isAuthenticated: boolean;
  /** Nomor yang sungguh-sungguh tertaut (dari creds.me.id), bukan yang didaftarkan. */
  linkedPhone?: string | null;
}

// Cache versi WA Web — shared dengan BaileysManager utama tapi HL punya
// cache sendiri supaya tidak tergantung internal BaileysManager yang private.
let cachedWaVersion: WAVersion | null = null;

async function resolveWaVersion(): Promise<WAVersion | undefined> {
  if (cachedWaVersion) return cachedWaVersion;
  try {
    const { version } = await fetchLatestBaileysVersion();
    cachedWaVersion = version;
    return version;
  } catch {
    return undefined;
  }
}

// ── JID helpers ──────────────────────────────────────────────────────────────
/**
 * Apakah JID ini kontak pribadi (bukan group/broadcast/newsletter)?
 *
 * ⚠️ Baileys v7 memakai **LID addressing**. Satu kontak pribadi bisa datang
 * dalam DUA bentuk:
 *   - `6285134245850@s.whatsapp.net`  → bentuk nomor telepon (lama)
 *   - `161581065339048@lid`           → bentuk LID (BARU, dan kini yang umum)
 *
 * Versi sebelumnya hanya menerima bentuk pertama. Akibatnya di sesi produksi
 * pada 2026-07-30 SELURUH pesan dibuang oleh `continue` di listener: buffer
 * kosong, `lastSeenAt` tak pernah terisi, `totalPairsCaptured` tetap 0 — padahal
 * socket-nya hidup dan berkas signal terus diperbarui. Buktinya seluruh berkas
 * di folder sesi bernama LID 15-digit (`session-161581065339048_1.0.json`),
 * bukan nomor telepon.
 *
 * Sekarang daftar TOLAK yang eksplisit, bukan daftar TERIMA — supaya bentuk
 * alamat baru dari WhatsApp tidak lagi lolos jadi pembuangan senyap.
 */
function isPersonalJid(jid: string): boolean {
  if (!jid) return false;
  if (jid.endsWith('@g.us')) return false;        // group
  if (jid.endsWith('@broadcast')) return false;   // status@broadcast & broadcast list
  if (jid.endsWith('@newsletter')) return false;  // channel
  return jid.endsWith('@s.whatsapp.net') || jid.endsWith('@c.us') || jid.endsWith('@lid');
}

/**
 * Identitas kontak yang STABIL untuk dijadikan kunci buffer.
 *
 * `key.remoteJidAlt` (Baileys v7) berisi pasangan alamat yang lain: kalau
 * `remoteJid` berbentuk LID, `remoteJidAlt` berisi bentuk nomor telepon, dan
 * sebaliknya. Selalu pilih bentuk NOMOR TELEPON kalau tersedia — kalau tidak,
 * kontak yang sama bisa punya dua buffer terpisah (satu ber-LID, satu
 * bernomor) tergantung bagaimana WhatsApp mengalamatkan pesan saat itu, dan
 * dua-duanya jadi terlalu pendek untuk lolos ambang flush.
 */
function isPhoneForm(j?: string | null): boolean {
  return !!j && (j.endsWith('@s.whatsapp.net') || j.endsWith('@c.us'));
}

function contactIdentity(remoteJid: string, remoteJidAlt?: string | null): string {
  if (isPhoneForm(remoteJid)) return remoteJid;
  if (isPhoneForm(remoteJidAlt)) return remoteJidAlt as string;
  return remoteJid;
}

/**
 * Versi `contactIdentity` yang bisa MENANYAKAN pemetaan LID→nomor ke Baileys.
 *
 * ── Kenapa perlu ─────────────────────────────────────────────────────────────
 * `remoteJidAlt` tidak selalu ada. Kalau tidak ada, pesan itu dikunci dengan
 * bentuk `@lid`; pesan berikutnya dari ORANG YANG SAMA yang kebetulan membawa
 * `remoteJidAlt` dikunci dengan bentuk nomor. Satu percakapan jadi DUA buffer,
 * masing-masing separuh panjangnya — dan karena keduanya lalu berada di bawah
 * ambang minimum, dua-duanya tidak pernah dikirim.
 *
 * Ini terlihat di dashboard 30 Juli: satu sesi CS punya tiga "kontak aktif"
 * berisi 1, 1, dan 3 baris. Angka sekecil itu dari 40 balasan CS mencurigakan,
 * dan salah satu kuncinya memang `113550915846385@lid` sementara dua lainnya
 * `…@s.whatsapp.net`.
 *
 * Baileys v7 menyimpan pemetaannya sendiri (berkas `lid-mapping-*` di folder
 * sesi, yang sudah terlihat sejak Fase 57) dan mengeksposnya lewat
 * `sock.signalRepository.lidMapping.getPNForLID()`.
 *
 * Gagal me-resolve → kembali ke bentuk `@lid` seperti sebelumnya. Buffer terpecah
 * itu tidak ideal, tapi jauh lebih baik daripada melempar galat di jalur pesan.
 */
async function contactIdentityResolved(
  sock: WASocket,
  remoteJid: string,
  remoteJidAlt?: string | null,
): Promise<string> {
  const langsung = contactIdentity(remoteJid, remoteJidAlt);
  if (isPhoneForm(langsung) || !langsung.endsWith('@lid')) return langsung;

  try {
    const pn = await sock.signalRepository?.lidMapping?.getPNForLID(langsung);
    if (pn && isPhoneForm(pn)) return pn;
  } catch (err) {
    logger.debug(`[HL] Pemetaan LID→nomor gagal untuk ${langsung}: ${err}`);
  }
  return langsung;
}

/**
 * Satukan buffer yang sudah tertulis di bawah kunci `@lid` ke kunci nomor.
 *
 * Dijalankan sekali saat sebuah LID BERHASIL di-resolve dan ternyata masih ada
 * buffer lama di kunci LID-nya. Tanpa ini, perbaikan di atas cuma berhenti
 * memecah buffer BARU sementara yang sudah terpecah tetap terpecah sampai
 * kedaluwarsa.
 *
 * Tidak atomik, dan itu diterima: kegagalan di tengah paling buruk menghasilkan
 * beberapa baris ganda di transkrip — tidak enak dibaca, tapi tidak merusak.
 * Alternatifnya (script Lua) tidak sebanding untuk operasi yang terjadi sekali
 * per kontak.
 */
async function satukanBufferLid(
  businessId: string, csPhone: string, lidJid: string, phoneJid: string,
): Promise<void> {
  const kunciLid = bufferKey(businessId, csPhone, lidJid);
  try {
    const barisLama = await redisClient.lrange(kunciLid, 0, -1);
    if (barisLama.length === 0) return;
    const kunciNomor = bufferKey(businessId, csPhone, phoneJid);
    // Baris lama ditaruh di DEPAN: ia memang terjadi lebih dulu.
    await redisClient.lpush(kunciNomor, ...barisLama.reverse());
    await redisClient.expire(kunciNomor, HL_BUFFER_TTL_SEC);
    await redisClient.del(kunciLid, lastSeenKey(businessId, csPhone, lidJid));
    logger.info(
      `[HL] ${barisLama.length} baris dari buffer ${lidJid} disatukan ke ${phoneJid} ` +
      `(satu kontak yang tadinya terpecah dua)`,
    );
  } catch (err) {
    logger.warn(`[HL] Gagal menyatukan buffer ${kunciLid}: ${err}`);
  }
}

/** Ambil nomor telanjang dari JID/creds id ('628xx:14@s.whatsapp.net' → '628xx'). */
export function bareNumberFromJid(jid?: string | null): string | null {
  if (!jid) return null;
  const digits = jid.split('@')[0]?.split(':')[0]?.replace(/\D/g, '');
  return digits && digits.length >= 8 ? digits : null;
}

/**
 * Normalisasi nomor HP Indonesia.
 *
 * Versi lama: `csPhone.replace(/\D/g,'').replace(/^0/,'62')` — awalan 62 hanya
 * ditambahkan kalau nomornya diawali 0. Mengetik `85134245850` (tanpa nol)
 * lolos apa adanya, lalu UI menampilkannya `+85134245850` yang itu kode Hong
 * Kong, dan folder sesinya jadi `cs-85134245850` — terpisah dari
 * `cs-6285134245850` untuk orang yang SAMA. Dua folder yatim di produksi
 * (`cs-85134245850`, `cs-8517121212`) lahir dari lubang ini.
 */
export function normalizePhoneId(input: string): { phone: string } | { error: string } {
  let d = (input ?? '').replace(/\D/g, '');
  if (!d) return { error: 'Nomor HP wajib diisi' };

  if (d.startsWith('620')) d = '62' + d.slice(3);   // 62 + 08xx → buang nol
  else if (d.startsWith('62')) { /* sudah benar */ }
  else if (d.startsWith('0')) d = '62' + d.slice(1);
  else if (d.startsWith('8')) d = '62' + d;         // ← 8xx tanpa 0/62 (yang dulu bolong)
  else return { error: `Nomor "${input}" bukan format Indonesia. Pakai 08xx, 628xx, atau +628xx.` };

  if (d.length < 11 || d.length > 15) {
    return { error: `Panjang nomor tidak wajar (${d.length} digit setelah dinormalkan jadi ${d})` };
  }
  return { phone: d };
}

/**
 * Apakah socket ini SUDAH PASTI mati?
 *
 * Sengaja pesimistis ke arah "masih hidup": kalau properti `ws` tidak bisa
 * dibaca, kembalikan false. `ws.isOpen` TIDAK boleh dipakai sendirian sebagai
 * tanda "terhubung" — saat handshake QR pun ws-nya sudah open, dan itu yang
 * dulu membuat modal QR menutup sendiri. Fungsi ini hanya dipakai sebagai
 * pemeriksaan TAMBAHAN di atas `isAuthenticated`.
 */
function isSocketDead(sock: WASocket): boolean {
  const ws = (sock as any)?.ws;
  if (!ws) return false;
  if (typeof ws.isOpen === 'boolean') return !ws.isOpen;
  if (typeof ws.readyState === 'number') return ws.readyState > 1; // 2=CLOSING, 3=CLOSED
  return false;
}

// ── Date & Timezone Helpers (WIB / Asia/Jakarta) ─────────────────────────────
export function getJakartaDateStr(d: Date = new Date()): string {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jakarta',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return formatter.format(d);
}

export function getYesterdayJakartaDateStr(): string {
  const now = new Date();
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  return getJakartaDateStr(yesterday);
}

// ── Buffer helpers ───────────────────────────────────────────────────────────
function bufferKey(businessId: string, csPhone: string, contactJid: string, dateStr?: string): string {
  const tgl = dateStr || getJakartaDateStr();
  return `${HL_PREFIX}${businessId}:${csPhone}:${contactJid}:${tgl}`;
}

function fullHistoryKey(businessId: string, csPhone: string, contactJid: string): string {
  return `hl:full_history:${businessId}:${csPhone}:${contactJid}`;
}

function lastSeenKey(businessId: string, csPhone: string, contactJid: string): string {
  return `${HL_LAST_PREFIX}${businessId}:${csPhone}:${contactJid}`;
}

/**
 * Pecah kunci buffer kembali jadi bagian-bagiannya.
 * Mendukung format terpartisi tanggal: hl:buf:{biz}:{phone}:{jid}:{YYYY-MM-DD}
 * Serta fallback legacy: hl:buf:{biz}:{phone}:{jid}
 */
export function pecahKunciBuffer(key: string): {
  businessId: string;
  csPhone: string;
  contactJid: string;
  dateStr: string;
} | null {
  const bagian = key.split(':');
  if (bagian.length < 5 || bagian[0] !== 'hl' || bagian[1] !== 'buf') return null;

  const lastPart = bagian[bagian.length - 1]!;
  const isDate = /^\d{4}-\d{2}-\d{2}$/.test(lastPart);

  const businessId = bagian[2]!;
  const csPhone = bagian[3]!;
  const dateStr = isDate ? lastPart : getJakartaDateStr();
  const contactJid = isDate
    ? bagian.slice(4, bagian.length - 1).join(':')
    : bagian.slice(4).join(':');

  return { businessId, csPhone, contactJid, dateStr };
}

async function appendToBuffer(
  businessId: string,
  csPhone: string,
  csName: string,
  contactJid: string,
  role: 'CS' | 'BUYER',
  text: string,
  msgTimestampMs?: number,
): Promise<void> {
  const tgl = getJakartaDateStr();
  const key = bufferKey(businessId, csPhone, contactJid, tgl);
  const lKey = lastSeenKey(businessId, csPhone, contactJid);
  const line = `[${role}] ${text.replace(/\n/g, ' ')}`;
  const fKey = fullHistoryKey(businessId, csPhone, contactJid);
  const ts = msgTimestampMs || Date.now();
  
  // Simpan ke partisi tanggal harian dengan TTL 7 hari
  await redisClient.rpush(key, line);
  await redisClient.expire(key, 7 * 24 * 3600);
  
  // Simpan ke Full History (maks 100 baris, TTL 12 jam)
  await redisClient.rpush(fKey, line);
  await redisClient.ltrim(fKey, -100, -1);
  await redisClient.expire(fKey, 43200);

  await redisClient.set(lKey, String(ts), 'EX', 7 * 24 * 3600);
}

async function flushBuffer(
  businessId: string,
  csPhone: string,
  csName: string,
  contactJid: string,
  sessionId: string,
  dateStr?: string,
): Promise<boolean> {
  const tgl = dateStr || getJakartaDateStr();
  const key = bufferKey(businessId, csPhone, contactJid, tgl);
  const lKey = lastSeenKey(businessId, csPhone, contactJid);
  const [lines, lastSeenStr] = await Promise.all([
    redisClient.lrange(key, 0, -1),
    redisClient.get(lKey),
  ]);

  if (!lines || lines.length === 0) return false;

  const rawTranscript = lines.join('\n');
  const jumlahBaris = hitungBarisBerisi(rawTranscript);

  // Pada batch harian, seluruh obrolan yang memiliki isi minimal 1 baris diproses
  if (jumlahBaris < 1) {
    await redisClient.del(key);
    return false;
  }

  const lastMessageTimestamp = lastSeenStr ? parseInt(lastSeenStr, 10) : undefined;
  const sourceLabel = `cs:${csPhone}:contact:${contactJid}`;
  await shadowMiningQueue.add('hl-flush', {
    kind: 'human_learning',
    rawTranscript,
    sourceLabel,
    businessId,
    triggeredBy: 'human_learning',
    csName,
    csSessionId: sessionId,
    lastMessageTimestamp,
  });

  logger.info(`[HL] Flush buffer ${contactJid} (${tgl}) → Shadow Mining (${jumlahBaris} baris, cs: ${csPhone})`);
  await redisClient.del(key, lKey);

  // Update statistik
  await prisma.csHumanLearningSession.update({
    where: { id: sessionId },
    data: { totalPairsCaptured: { increment: 1 }, lastSeenAt: new Date() },
  }).catch(e => logger.warn(`[HL] Abaikan update statistik flush: ${e.message}`));
  return true;
}

// ── Manager Utama ────────────────────────────────────────────────────────────
class HumanLearningManager {
  private instances: Map<string, CsInstance> = new Map(); // key: sessionId
  private connecting: Set<string> = new Set(); // key: sessionId

  /** Kunci session ID dari csPhone (untuk lookup mudah). */
  private phoneToSessionId: Map<string, string> = new Map(); // key: `${businessId}:${csPhone}`

  private getSessionDir(csPhone: string): string {
    const dir = path.resolve(env.WA_SESSIONS_DIR, `cs-${csPhone}`);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  async connect(sessionId: string): Promise<void> {
    if (this.connecting.has(sessionId)) {
      logger.warn(`[HL] Connect session ${sessionId} sudah berjalan, diabaikan`);
      return;
    }
    this.connecting.add(sessionId);
    try {
      await this.doConnect(sessionId);
    } finally {
      this.connecting.delete(sessionId);
    }
  }

  /**
   * Pastikan ada percobaan connect yang berjalan — TANPA MENUNGGU QR terbit.
   *
   * Ini pengganti pola lama `connect(id, waitForQR=true)`. Pola lama menahan
   * request HTTP sampai QR terbit (10-15 detik untuk sesi baru, karena Baileys
   * menulis ribuan berkas PreKey) DAN menahan flag `connecting` selama itu.
   * Akibatnya permintaan QR yang kedua — yang di dev dipicu otomatis oleh
   * StrictMode React, tanpa perlu diklik manusia — kena guard `connecting`,
   * mendapat `undefined`, dan oleh route diterjemahkan jadi
   * `status: 'CONNECTED'`. Frontend lalu menutup modal seketika. Itulah
   * "modal langsung kosong" yang dilaporkan.
   *
   * Sekarang: kembalikan keadaan sekarang saja. QR menyusul lewat DB dan
   * diambil frontend dari polling `GET /status`.
   */
  async ensureConnecting(sessionId: string): Promise<'CONNECTED' | 'PENDING'> {
    const inst = this.instances.get(sessionId);

    // Sudah benar-benar tersambung (bukan cuma ws open) → tidak perlu QR.
    if (inst?.isAuthenticated && !isSocketDead(inst.sock)) return 'CONNECTED';

    // Sedang di tengah pembuatan socket → jangan tumpuk.
    if (this.connecting.has(sessionId)) return 'PENDING';

    // Socket sudah jalan, belum discan, dan percobaannya belum kedaluwarsa →
    // biarkan dia yang menerbitkan QR. Membuat socket baru di sini justru
    // menendang socket lama (conflict 440) dan mengulang QR dari nol.
    if (inst && !isSocketDead(inst.sock) && Date.now() - inst.createdAt < HL_CONNECT_ATTEMPT_TTL_MS) {
      return 'PENDING';
    }

    // Mulai di latar belakang. TIDAK di-await: request HTTP harus balas segera.
    void this.connect(sessionId).catch((err) =>
      logger.error(`[HL] Connect latar belakang gagal untuk sesi ${sessionId}: ${err}`)
    );
    return 'PENDING';
  }

  private async doConnect(sessionId: string): Promise<void> {
    const session = await prisma.csHumanLearningSession.findUnique({
      where: { id: sessionId },
    });
    if (!session) throw new Error(`Session ${sessionId} tidak ditemukan`);

    const { csPhone, csName, businessId } = session;

    const existing = this.instances.get(sessionId);
    if (existing?.isAuthenticated && !isSocketDead(existing.sock)) {
      logger.info(`[HL] Session CS ${csPhone} sudah terhubung, lewati`);
      return;
    }

    // Bersihkan yang lama
    if (existing) {
      try { existing.sock.end(new Error('Restart session')); } catch { /* ignore */ }
      this.instances.delete(sessionId);
    }

    await prisma.csHumanLearningSession.update({
      where: { id: sessionId },
      data: { status: 'CONNECTING', qrCode: null, qrExpiresAt: null },
    });

    const sessionDir = this.getSessionDir(csPhone);
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    const version = await resolveWaVersion();

    const sock = makeWASocket({
      ...(version ? { version } : {}),
      auth: state,
      logger: pino({ level: 'warn' }) as any,
      browser: ['SalesPintar CS', 'Chrome', '120.0'],
      // READ-ONLY: sesi shadow hanya mendengar, tidak perlu fitur media berat
      generateHighQualityLinkPreview: false,
      syncFullHistory: true,
      emitOwnEvents: false,
    });

    const inst: CsInstance = { sock, csPhone, csName, businessId, sessionId, createdAt: Date.now(), isAuthenticated: false };
    this.instances.set(sessionId, inst);
    this.phoneToSessionId.set(`${businessId}:${csPhone}`, sessionId);

    // QR
    sock.ev.on('connection.update', async (update) => {
      // ── PENJAGA IDENTITAS SOCKET (pelajaran Fase 43 di bot utama) ────────
      // `instances` berkunci sessionId, jadi socket baru MENIMPA entri socket
      // lama — tapi penangan kejadian socket lama masih hidup. Tanpa penjaga
      // ini, event 'close' dari socket lama akan `instances.delete(sessionId)`
      // dan menghapus entri socket BARU (→ status DISCONNECTED walau
      // tersambung), lalu menjadwalkan reconnect yang menambah socket lagi.
      if (this.instances.get(sessionId) !== inst) {
        logger.info(`[HL] Socket CS ${csPhone} sudah digantikan — kejadian diabaikan`);
        return;
      }

      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        try {
          const qrBase64 = await QRCode.toDataURL(qr);
          const expiresAt = new Date(Date.now() + 60_000);
          await prisma.csHumanLearningSession.update({
            where: { id: sessionId },
            data: { qrCode: qrBase64, qrExpiresAt: expiresAt, status: 'CONNECTING' },
          });
          logger.info(`[HL] QR terbit untuk CS ${csPhone} (berlaku sampai ${expiresAt.toISOString()})`);
        } catch (err) {
          logger.error(`[HL] Gagal generate QR untuk CS ${csPhone}: ${err}`);
        }
      }

      if (connection === 'open') {
        inst.isAuthenticated = true;

        // ── Verifikasi nomor yang BENAR-BENAR menscan QR ────────────────────
        // Baileys menautkan HP siapa pun yang menscan; tidak ada jaminan itu
        // nomor yang didaftarkan. Di produksi 2026-07-30 folder
        // `cs-6285722193049` ternyata berisi kredensial HP 6285134245850 —
        // slot CS memantau orang lain tanpa ada tanda apa pun di dashboard.
        //
        // SENGAJA TIDAK memutus koneksi: memutus berarti clearSession() yang
        // menghapus folder sesi, dan itu merusak sesi yang mungkin sedang
        // dipakai. Cukup dicatat + dipaparkan ke UI, keputusannya milik manusia.
        inst.linkedPhone = bareNumberFromJid(state.creds?.me?.id);
        if (inst.linkedPhone && inst.linkedPhone !== csPhone) {
          logger.warn(
            `[HL] ⚠️ NOMOR TIDAK COCOK — sesi CS terdaftar ${csPhone} ` +
            `tetapi yang menscan QR adalah ${inst.linkedPhone}. ` +
            `Percakapan yang terekam adalah milik ${inst.linkedPhone}.`
          );
        }
        await prisma.csHumanLearningSession.update({
          where: { id: sessionId },
          data: { status: 'CONNECTED', qrCode: null, qrExpiresAt: null, linkedAt: new Date() },
        });
        logger.info(`[HL] CS ${csPhone} (${csName}) terhubung`);
      }

      if (connection === 'close') {
        const code = (lastDisconnect?.error as any)?.output?.statusCode;
        const shouldReconnect = code !== DisconnectReason.loggedOut && code !== 403;

        if (code === DisconnectReason.loggedOut || code === 403) {
          logger.warn(`[HL] CS ${csPhone} logged out (${code}) — harus scan ulang`);
          await this.clearSession(csPhone);
          // .catch() WAJIB: kalau sesi baru saja dihapus lewat tombol tempat
          // sampah, baris ini kena P2025 RecordNotFound dan — karena penangan
          // ini async tanpa pemanggil — jadi unhandled rejection yang
          // mematikan proses. Cabang reconnect di bawah sudah dijaga; cabang
          // ini tertinggal.
          await prisma.csHumanLearningSession.update({
            where: { id: sessionId },
            data: { status: 'DISCONNECTED', qrCode: null, qrExpiresAt: null, linkedAt: null },
          }).catch(e => logger.warn(`[HL] Abaikan update logout, sesi sudah dihapus: ${e.message}`));
          this.instances.delete(sessionId);
        } else if (shouldReconnect) {
          logger.info(`[HL] CS ${csPhone} putus (${code}), menyambung ulang...`);
          await prisma.csHumanLearningSession.update({
            where: { id: sessionId },
            data: { status: 'CONNECTING' },
          }).catch(e => logger.warn(`[HL] Abaikan reconnect, sesi sudah dihapus: ${e.message}`));
          this.instances.delete(sessionId);
          setTimeout(() => this.connect(sessionId).catch(err =>
            logger.error(`[HL] Gagal reconnect CS ${csPhone}: ${err}`)
          ), 5000);
        }
      }
    });

    sock.ev.on('creds.update', saveCreds);

    // ── SHADOW LISTENER: tangkap semua pesan ──────────────────────────────
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify' && type !== 'append') return;
      await this.processIncomingMessages(sock, sessionId, csPhone, csName, businessId, messages);
    });

    sock.ev.on('messaging-history.set', async ({ messages }) => {
      if (messages && messages.length > 0) {
        logger.info(`[HL] Menerima ${messages.length} riwayat pesan offline dari WhatsApp untuk CS ${csPhone}`);
        await this.processIncomingMessages(sock, sessionId, csPhone, csName, businessId, messages);
      }
    });

  }

  private async processIncomingMessages(
    sock: WASocket,
    sessionId: string,
    csPhone: string,
    csName: string,
    businessId: string,
    messages: proto.IWebMessageInfo[],
  ): Promise<void> {
    const hlPaused = await hlSedangDijeda();
    const crmPaused = await crmSedangDijeda();

    for (const msg of messages) {
      try {
        if (!msg || !msg.key) continue;
        const msgKey = msg.key as any;
        const rawJid = msgKey.remoteJid ?? '';
        if (!isPersonalJid(rawJid)) {
          this.noteSkippedJid(sessionId, rawJid);
          continue;
        }

        // Anti-dobel: 'append' / history sync bisa mengirim ulang pesan yang sudah diproses
        const msgId = msgKey.id;
        if (msgId) {
          const seenKey = `${HL_SEEN_PREFIX}${sessionId}`;
          const isNew = await redisClient.sadd(seenKey, msgId);
          if (!isNew) continue;
          await redisClient.expire(seenKey, HL_SEEN_TTL_SEC);
        }

        // Tentukan arah pesan
        const isFromMe = msgKey.fromMe === true;
        const role: 'CS' | 'BUYER' = isFromMe ? 'CS' : 'BUYER';

        // Ekstrak teks
        const text =
          msg.message?.conversation ||
          msg.message?.extendedTextMessage?.text ||
          msg.message?.imageMessage?.caption ||
          msg.message?.videoMessage?.caption ||
          '';
        if (!text.trim()) continue; // skip media tanpa caption, sticker, dll

        const jidMentah = contactIdentity(rawJid, msgKey.remoteJidAlt);
        const contactJid = await contactIdentityResolved(sock, rawJid, msgKey.remoteJidAlt);
        if (contactJid !== jidMentah && jidMentah.endsWith('@lid')) {
          await satukanBufferLid(businessId, csPhone, jidMentah, contactJid);
        }

        const msgTsSec = typeof msg.messageTimestamp === 'number'
          ? msg.messageTimestamp
          : (typeof msg.messageTimestamp === 'object' && msg.messageTimestamp !== null && 'low' in msg.messageTimestamp)
            ? (msg.messageTimestamp as any).low
            : Math.floor(Date.now() / 1000);
        const rawMsgTs = msgTsSec ? msgTsSec * 1000 : Date.now();

        await appendToBuffer(businessId, csPhone, csName, contactJid, role, text, rawMsgTs);

        // Penghitung per pesan
        await redisClient.incr(`${HL_PEND_PREFIX}${sessionId}:${role === 'CS' ? 'cs' : 'buyer'}`);
        const todayDateStr = getJakartaDateStr();
        const HL_DAILY_TTL = 7 * 24 * 3600;
        const dailyRoleKey = `hl:daily:${businessId}:${todayDateStr}:${role === 'CS' ? 'cs' : 'buyer'}`;
        await redisClient.incr(dailyRoleKey);
        await redisClient.expire(dailyRoleKey, HL_DAILY_TTL);
        const csDailyRoleKey = `hl:cs_daily:${sessionId}:${todayDateStr}:${role === 'CS' ? 'cs' : 'buyer'}`;
        await redisClient.incr(csDailyRoleKey);
        await redisClient.expire(csDailyRoleKey, HL_DAILY_TTL);

        // Lacak waktu respon CS terhadap pesan pembeli untuk Skor Respon ala Shopee
        const buyerTsKey = `hl:buyer_ts:${businessId}:${csPhone}:${contactJid}`;
        if (role === 'BUYER') {
          await redisClient.set(buyerTsKey, String(Date.now()), 'EX', 86400);
        } else if (role === 'CS') {
          try {
            const buyerTsStr = await redisClient.getdel(buyerTsKey);
            if (buyerTsStr) {
              const diffSec = Math.max(1, Math.round((Date.now() - parseInt(buyerTsStr, 10)) / 1000));
              if (diffSec <= 86400) {
                const respTimeKey = `hl:cs_daily:${sessionId}:${todayDateStr}:resp_time_sec`;
                const respCntKey  = `hl:cs_daily:${sessionId}:${todayDateStr}:resp_count`;
                await redisClient.incrby(respTimeKey, diffSec);
                await redisClient.expire(respTimeKey, HL_DAILY_TTL);
                await redisClient.incr(respCntKey);
                await redisClient.expire(respCntKey, HL_DAILY_TTL);
                if (diffSec <= 180) { // <= 3 menit
                  const fastKey = `hl:cs_daily:${sessionId}:${todayDateStr}:fast_resp_count`;
                  await redisClient.incr(fastKey);
                  await redisClient.expire(fastKey, HL_DAILY_TTL);
                }
              }
            }
          } catch {}
        }

        // Titipkan ke Postgres + perbarui lastSeenAt, ter-throttle 1 menit.
        const now = Date.now();
        if (!this._lastSeenUpdate.has(sessionId) || now - (this._lastSeenUpdate.get(sessionId) ?? 0) > 60_000) {
          this._lastSeenUpdate.set(sessionId, now);
          await this.commitPendingCounts(sessionId, { touchLastSeen: true });
        }

        // Cek ukuran buffer sekarang & Sinyal Closing Pintar
        const key = bufferKey(businessId, csPhone, contactJid);
        const bufLen = await redisClient.llen(key);

        // ── Realtime CRM Profiler (0-Second Latency) ──────────────────────
        if (!crmPaused) {
          const fKey = fullHistoryKey(businessId, csPhone, contactJid);
          redisClient.lrange(fKey, 0, -1).then(lines => {
            if (lines && lines.length > 0) {
              const fullTranscript = lines.join('\n');
              LeadProfilerService.processConversation({
                businessId,
                contactJid,
                csPhone,
                csName,
                rawTranscript: fullTranscript,
                messageTimestamp: new Date(rawMsgTs),
              }).catch(err => {
                logger.warn(`[HL] Realtime LeadProfiler background error: ${err.message}`);
              });
            }
          }).catch(() => {});
        }

        // Deteksi Sinyal Closing Pintar (Smart Instant Flush)
        const isCsClosingMessage =
          role === 'CS' &&
          (/CATATAN[\s\S]*?Pastikan\s+hp|pastikan\s+bayar\s+cod|save\s+no\s+saya/i.test(text) ||
            /baik\s+kami\s+proses|sudah\s+kami\s+catat|siap\s+pak\s+makasii|siap\s+dikirim|kami\s+proses/i.test(text));

        const isBuyerProofMessage =
          role === 'BUYER' &&
          (/bukti\s+transaksi|udah\s+order|sudah\s+tf|sudah\s+transfer/i.test(text));

        const hasSmartClosingSignal = isCsClosingMessage || isBuyerProofMessage;

        // Eksekusi Flush ke antrean Auto-Learning (Lapis 1 & 2) JIKA pilar 2 tidak sedang dijeda.
        if (!hlPaused && (bufLen >= HL_BUFFER_FLUSH_AT_LINES || (bufLen >= 2 && hasSmartClosingSignal))) {
          logger.info(
            `[HL] Smart Closing Flush terpicu untuk ${contactJid} (${bufLen} baris, trigger: ${
              hasSmartClosingSignal ? 'SMART_CLOSING' : 'BUFFER_LIMIT'
            })`,
          );
          await flushBuffer(businessId, csPhone, csName, contactJid, sessionId);
        }
      } catch (err) {
        logger.warn(`[HL] Error memproses pesan CS ${csPhone}: ${err}`);
      }
    }
  }

  private _lastSeenUpdate: Map<string, number> = new Map();
  private _skipLogged: Map<string, Set<string>> = new Map();

  /**
   * Catat sekali saja per (sesi, bentuk-alamat) bahwa ada pesan dibuang.
   *
   * Dibuat karena pembuangan SENYAP di listener adalah alasan bug LID tidak
   * terlihat: dashboard menunjukkan 0 pair, log tidak menunjukkan apa-apa, dan
   * socketnya sehat. Sekarang bentuk alamat yang tidak dikenal selalu muncul
   * di log — sekali, tidak membanjiri.
   */
  private noteSkippedJid(sessionId: string, jid: string): void {
    const shape = jid.includes('@') ? `@${jid.split('@').pop()}` : '(tanpa @)';
    let seen = this._skipLogged.get(sessionId);
    if (!seen) { seen = new Set(); this._skipLogged.set(sessionId, seen); }
    if (seen.has(shape)) return;
    seen.add(shape);
    logger.info(`[HL] Pesan dari alamat bentuk ${shape} dilewati (contoh: ${jid}) — sesi ${sessionId}`);
  }

  /**
   * Titipkan penghitung pesan dari Redis ke Postgres.
   *
   * Urutannya SENGAJA `GET → UPDATE → DECRBY`, bukan `GETSET → UPDATE`:
   * kalau Postgres sedang bermasalah, DECRBY tidak pernah dijalankan sehingga
   * hitungannya utuh dan dicoba lagi semenit kemudian. Dengan GETSET, kegagalan
   * DB akan MENGHILANGKAN hitungan itu selamanya. DECRBY (bukan set 0) juga
   * menjaga pesan yang masuk di tengah proses ini supaya tidak ikut terhapus.
   *
   * Risiko yang tersisa dan diterima: kalau proses mati persis antara UPDATE dan
   * DECRBY, hitungan itu terhitung dua kali di menit berikutnya. Untuk angka
   * pemantauan, kelebihan hitung saat crash lebih bisa ditoleransi daripada
   * kehilangan tiap kali DB tersendat.
   */
  private async commitPendingCounts(
    sessionId: string,
    opts: { touchLastSeen?: boolean } = {},
  ): Promise<void> {
    const csKey = `${HL_PEND_PREFIX}${sessionId}:cs`;
    const buyerKey = `${HL_PEND_PREFIX}${sessionId}:buyer`;
    try {
      const [csRaw, buyerRaw] = await redisClient.mget(csKey, buyerKey);
      const cs = parseInt(csRaw ?? '0', 10) || 0;
      const buyer = parseInt(buyerRaw ?? '0', 10) || 0;
      if (!cs && !buyer && !opts.touchLastSeen) return;

      await prisma.csHumanLearningSession.update({
        where: { id: sessionId },
        data: {
          ...(cs ? { totalCsReplies: { increment: cs } } : {}),
          ...(buyer ? { totalBuyerMessages: { increment: buyer } } : {}),
          ...(opts.touchLastSeen ? { lastSeenAt: new Date() } : {}),
        },
      });

      // Baru dikurangi SETELAH DB menerima.
      if (cs) await redisClient.decrby(csKey, cs);
      if (buyer) await redisClient.decrby(buyerKey, buyer);
    } catch (err: any) {
      logger.warn(`[HL] Gagal menitipkan hitungan pesan sesi ${sessionId} (dicoba lagi nanti): ${err?.message ?? err}`);
    }
  }

  /**
   * Hitungan yang belum sempat dititipkan ke DB.
   *
   * Dipakai API supaya angka di dashboard bergerak dalam hitungan detik, bukan
   * menunggu titipan 60 detik berikutnya: yang ditampilkan = kolom DB + ini.
   */
  async getPendingCounts(sessionId: string): Promise<{ cs: number; buyer: number }> {
    try {
      const [cs, buyer] = await redisClient.mget(
        `${HL_PEND_PREFIX}${sessionId}:cs`,
        `${HL_PEND_PREFIX}${sessionId}:buyer`,
      );
      return {
        cs: Math.max(0, parseInt(cs ?? '0', 10) || 0),
        buyer: Math.max(0, parseInt(buyer ?? '0', 10) || 0),
      };
    } catch {
      return { cs: 0, buyer: 0 };
    }
  }

  /**
   * Nomor yang sungguh tertaut untuk satu sesi CS.
   *
   * Dari memori kalau socketnya hidup; kalau tidak, dibaca dari
   * `creds.json` di disk supaya mismatch tetap terlihat walau sesi sedang
   * terputus. Berkasnya ~2KB, jadi baca langsung tanpa cache.
   */
  getLinkedPhone(sessionId: string, csPhone: string): string | null {
    const inst = this.instances.get(sessionId);
    if (inst?.linkedPhone) return inst.linkedPhone;
    try {
      const credsPath = path.resolve(env.WA_SESSIONS_DIR, `cs-${csPhone}`, 'creds.json');
      if (!fs.existsSync(credsPath)) return null;
      const creds = JSON.parse(fs.readFileSync(credsPath, 'utf-8'));
      return bareNumberFromJid(creds?.me?.id);
    } catch {
      return null;
    }
  }

  /**
   * Isi buffer yang sedang hidup untuk satu sesi CS.
   *
   * Tidak butuh socket hidup — bekerja langsung dari Redis, jadi tetap bisa
   * dipakai untuk memeriksa apa yang tertangkap walau sesinya baru putus.
   *
   * `lastMessageAt` diturunkan dari TTL kunci, bukan dari stempel waktu yang
   * disimpan. Alasannya: `appendToBuffer` menyetel ulang `EXPIRE` ke
   * HL_BUFFER_IDLE_SEC setiap kali ada pesan baru, jadi
   * `(IDLE_SEC - ttlSisa)` = detik sejak pesan terakhir. Cara ini tidak
   * mengubah format baris transkrip yang sudah dipakai pipeline Shadow Mining.
   */
  async inspectBuffers(businessId: string, csPhone: string): Promise<{
    idleSec: number;
    minMessages: number;
    flushAtLines: number;
    contacts: Array<{
      contactJid: string;
      lines: number;
      readyToFlush: boolean;
      secondsSinceLastMessage: number | null;
      preview: string[];
    }>;
  }> {
    const keys = await this.pindaiKunci(`${HL_PREFIX}${businessId}:${csPhone}:*`);
    const contacts = [];

    for (const key of keys) {
      const bagian = pecahKunciBuffer(key);
      if (!bagian) continue;
      const { contactJid, dateStr } = bagian;
      const [lines, lastRaw] = await Promise.all([
        redisClient.lrange(key, 0, -1),
        redisClient.get(lastSeenKey(businessId, csPhone, contactJid)),
      ]);
      const lastMs = lastRaw ? parseInt(lastRaw, 10) : NaN;
      const idleSec = Number.isFinite(lastMs)
        ? Math.max(0, Math.round((Date.now() - lastMs) / 1000))
        : null;
      const jumlahBaris = hitungBarisBerisi(lines.join('\n'));
      contacts.push({
        contactJid: `${contactJid} (${dateStr})`,
        lines: jumlahBaris,
        readyToFlush: jumlahBaris >= 1,
        secondsSinceLastMessage: idleSec,
        preview: lines.slice(-6),
      });
    }

    contacts.sort((a, b) =>
      (a.secondsSinceLastMessage ?? Number.MAX_SAFE_INTEGER) -
      (b.secondsSinceLastMessage ?? Number.MAX_SAFE_INTEGER)
    );
    return {
      idleSec: 0,
      minMessages: 1,
      flushAtLines: 9999,
      contacts,
    };
  }

  async disconnect(sessionId: string): Promise<void> {
    await this.commitPendingCounts(sessionId);
    const inst = this.instances.get(sessionId);
    if (inst) {
      try { inst.sock.end(new Error('Disconnect manual')); } catch { /* ignore */ }
      this.instances.delete(sessionId);
      this.phoneToSessionId.delete(`${inst.businessId}:${inst.csPhone}`);
    }
    await prisma.csHumanLearningSession.update({
      where: { id: sessionId },
      data: { status: 'DISCONNECTED', qrCode: null, qrExpiresAt: null },
    }).catch(e => logger.warn(`[HL] Abaikan update disconnect, sesi sudah dihapus: ${e.message}`));
    logger.info(`[HL] Session ${sessionId} diputus manual`);
  }

  private async clearSession(csPhone: string): Promise<void> {
    try {
      const dir = path.resolve(env.WA_SESSIONS_DIR, `cs-${csPhone}`);
      if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
        logger.info(`[HL] Sesi usang dihapus dari disk untuk CS ${csPhone}`);
      }
    } catch (err) {
      logger.error(`[HL] Gagal menghapus folder sesi CS ${csPhone}: ${err}`);
    }
  }

  /**
   * Kirim SEMUA buffer sesi ini sekarang secara manual (dari tombol UI).
   */
  async flushAllBuffersForSession(
    sessionId: string,
  ): Promise<{ dikirim: number; terlaluPendek: number; ambangMin: number }> {
    const sesi = await prisma.csHumanLearningSession.findUnique({
      where: { id: sessionId },
      select: { businessId: true, csPhone: true, csName: true },
    });
    if (!sesi) return { dikirim: 0, terlaluPendek: 0, ambangMin: 1 };

    const keys = await this.pindaiKunci(`${HL_PREFIX}${sesi.businessId}:${sesi.csPhone}:*`);
    let flushed = 0;
    let terlaluPendek = 0;
    for (const key of keys) {
      const bagian = pecahKunciBuffer(key);
      if (!bagian) continue;
      const sent = await flushBuffer(
        sesi.businessId, sesi.csPhone, sesi.csName, bagian.contactJid, sessionId, bagian.dateStr,
      );
      if (sent) flushed++;
      else terlaluPendek++;
    }
    return { dikirim: flushed, terlaluPendek, ambangMin: 1 };
  }

  private async pindaiKunci(pattern: string): Promise<string[]> {
    const hasil: string[] = [];
    let kursor = '0';
    do {
      const [kursorBaru, batch] = await redisClient.scan(kursor, 'MATCH', pattern, 'COUNT', 200);
      kursor = kursorBaru;
      hasil.push(...batch);
    } while (kursor !== '0');
    return [...new Set(hasil)];
  }

  /**
   * PENYAPU BATCH HARIAN & CHECKPOINT (Jam 00:01, 09:00, 12:00, 15:00, 18:00, 21:00 WIB)
   * Memproses semua buffer obrolan dari hari target secara utuh per pelanggan.
   */
  async sweepDailyBatch(targetDate?: string): Promise<{ diperiksa: number; dikirim: number; belumWaktunya: number }> {
    if (await hlSedangDijeda()) {
      logger.info('[AutoLearning/batch] Batch harian dilewati — Pilar 2 (Knowledge Base Auto-Learning) sedang DIJEDA');
      return { diperiksa: 0, dikirim: 0, belumWaktunya: 0 };
    }

    // Default target: Hari ini (atau KEMARIN jika run tengah malam 00:01)
    const jakartaHour = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Jakarta' })).getHours();
    const targetDateStr = targetDate || (jakartaHour === 0 ? getYesterdayJakartaDateStr() : getJakartaDateStr());
    logger.info(`[HL/batch] Memulai checkpoint batch flush untuk tanggal: ${targetDateStr}`);

    // Scan buffer dengan partisi tanggal target (atau semua buffer jika targetDate='all')
    const pattern = targetDate === 'all'
      ? `${HL_PREFIX}*`
      : `${HL_PREFIX}*:*:${targetDateStr}`;

    const keys = await this.pindaiKunci(pattern);
    let dikirim = 0;
    let dilewati = 0;

    const cacheSesi = new Map<string, { id: string; csName: string } | null>();

    for (const key of keys) {
      const bagian = pecahKunciBuffer(key);
      if (!bagian) continue;
      const { businessId, csPhone, contactJid, dateStr } = bagian;

      const kunciSesi = `${businessId}:${csPhone}`;
      if (!cacheSesi.has(kunciSesi)) {
        const sesi = await prisma.csHumanLearningSession
          .findUnique({
            where: { businessId_csPhone: { businessId, csPhone } },
            select: { id: true, csName: true },
          })
          .catch(() => null);
        cacheSesi.set(kunciSesi, sesi);
      }
      const sesi = cacheSesi.get(kunciSesi);
      if (!sesi) {
        logger.warn(`[HL/batch] Buffer ${key} yatim (sesi CS sudah dihapus) — dibuang`);
        await redisClient.del(key);
        continue;
      }

      try {
        const sent = await flushBuffer(businessId, csPhone, sesi.csName, contactJid, sesi.id, dateStr);
        if (sent) dikirim++;
        else dilewati++;
      } catch (err) {
        logger.warn(`[HL/batch] Gagal mengirim buffer ${key}: ${err}`);
      }
    }

    logger.info(`[HL/batch] Selesai batch flush tanggal ${targetDateStr}: ${dikirim} dikirim, ${dilewati} dilewati dari ${keys.length} buffer.`);
    return { diperiksa: keys.length, dikirim, belumWaktunya: dilewati };
  }

  /** Alias untuk worker */
  async sweepIdleBuffers(): Promise<{ diperiksa: number; dikirim: number; belumWaktunya: number }> {
    return this.sweepDailyBatch();
  }

  getStatus(sessionId: string): 'CONNECTED' | 'CONNECTING' | 'DISCONNECTED' {
    const inst = this.instances.get(sessionId);
    if (!inst) return 'DISCONNECTED';

    // `isAuthenticated` tetap syarat utama — ws.isOpen sudah true saat
    // handshake QR, jadi memakainya sendirian membuat status CONNECTED palsu.
    if (inst.isAuthenticated) return isSocketDead(inst.sock) ? 'DISCONNECTED' : 'CONNECTED';

    if (this.connecting.has(sessionId)) return 'CONNECTING';

    // Socket ada tapi belum discan. Dulu selalu 'CONNECTING' — itu sebabnya
    // badge bisa nyangkut "Menghubungkan..." selamanya untuk socket yang
    // sudah mati tapi belum dibersihkan. Sekarang dibatasi umur percobaan.
    if (!isSocketDead(inst.sock) && Date.now() - inst.createdAt < HL_CONNECT_ATTEMPT_TTL_MS) {
      return 'CONNECTING';
    }
    return 'DISCONNECTED';
  }

  /**
   * Pulihkan sesi CS setelah restart — HANYA yang benar-benar punya kredensial
   * di disk.
   *
   * Dulu kriterianya status DB `CONNECTED` ATAU `CONNECTING`. Masalahnya
   * `GET /qr` menyetel status jadi `CONNECTING` sebelum QR terbit, jadi setiap
   * sesi yang QR-nya tidak pernah discan tertinggal `CONNECTING` selamanya —
   * dan tiap restart backend (dengan `tsx watch`, artinya tiap kali ada berkas
   * disimpan) memulai connect latar belakang untuk sesi itu. Connect itulah
   * yang memegang flag `connecting` saat Angga menekan "Scan QR", sehingga
   * permintaan QR-nya kena guard.
   *
   * Tanpa `creds.json` di disk, memanggil connect() cuma menerbitkan QR yang
   * tidak ada yang melihat. Jadi sesi seperti itu dinolkan ke DISCONNECTED
   * dan dibiarkan sampai ada yang benar-benar minta QR.
   */
  async restoreActiveSessions(): Promise<void> {
    const allSessions = await prisma.csHumanLearningSession.findMany();
    if (allSessions.length === 0) return;

    const restorable: typeof allSessions = [];
    for (const session of allSessions) {
      const credsFile = path.resolve(env.WA_SESSIONS_DIR, `cs-${session.csPhone}`, 'creds.json');
      if (fs.existsSync(credsFile)) {
        restorable.push(session);
      } else {
        logger.info(`[HL] Sesi CS ${session.csPhone} (${session.csName}) tanpa creds.json — dinolkan`);
        await prisma.csHumanLearningSession.update({
          where: { id: session.id },
          data: { status: 'DISCONNECTED', qrCode: null, qrExpiresAt: null },
        }).catch(e => logger.warn(`[HL] Abaikan reset status: ${e.message}`));
      }
    }

    if (restorable.length === 0) return;
    logger.info(`[HL] Memulihkan ${restorable.length} sesi CS yang punya kredensial di disk...`);
    for (const session of restorable) {
      this.connect(session.id).catch(err =>
        logger.error(`[HL] Gagal memulihkan sesi CS ${session.csPhone}: ${err}`)
      );
    }
  }

  private healthTimer: NodeJS.Timeout | null = null;

  startHealthCheck(): void {
    if (this.healthTimer) return;
    this.healthTimer = setInterval(async () => {
      try {
        const sessions = await prisma.csHumanLearningSession.findMany();
        for (const session of sessions) {
          const credsFile = path.resolve(env.WA_SESSIONS_DIR, `cs-${session.csPhone}`, 'creds.json');
          if (!fs.existsSync(credsFile)) continue; // Belum pernah scan QR

          const inst = this.instances.get(session.id);
          const isConnected = inst?.isAuthenticated && !isSocketDead(inst.sock);
          const isConnecting = this.connecting.has(session.id) || (inst && !isSocketDead(inst.sock) && Date.now() - inst.createdAt < HL_CONNECT_ATTEMPT_TTL_MS);

          if (!isConnected && !isConnecting) {
            logger.warn(`[HL/Health] Sesi CS ${session.csPhone} (${session.csName}) terputus/belum aktif — menyambungkan ulang otomatis...`);
            this.connect(session.id).catch(err =>
              logger.error(`[HL/Health] Gagal menyambungkan ulang CS ${session.csPhone}: ${err}`)
            );
          }
        }
      } catch (err) {
        logger.warn(`[HL/Health] Health check CS error: ${err}`);
      }
    }, 45_000);
    logger.info('[HL] Pemantau kesehatan socket CS aktif (tiap 45 detik)');
  }

  stopHealthCheck(): void {
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
  }
}

// ─── Sakelar JEDA Human Learning (Fase 114) ──────────────────────────────────
/**
 * Selama dijeda, Human Learning BERHENTI TOTAL: pesan CS tidak lagi ditampung,
 * dan penyapu tidak lagi mengubah tampungan jadi pengetahuan.
 *
 * ── Kenapa BERHENTI, bukan MENUNDA ──────────────────────────────────────────
 * Menjeda dengan cara tetap menampung terdengar lebih baik ("nanti tinggal
 * dilanjut"), tapi akibatnya justru berbahaya: begitu dilanjutkan, berjam-jam
 * percakapan masuk sekaligus ke penambangan — termasuk percakapan yang terjadi
 * SAAT sistem sedang diperbaiki, yang justru paling mungkin cacat. Jeda dipakai
 * ketika sesuatu sedang tidak beres; menyimpan hasil dari saat tidak beres lalu
 * memasukkannya belakangan menghapus seluruh gunanya berjeda.
 *
 * ── Kenapa keadaannya di DB, bukan Redis ────────────────────────────────────
 * Redis boleh dikosongkan kapan saja (dan sudah pernah). Kalau sakelarnya hidup
 * di situ, jedanya bisa hilang tanpa ada yang sadar — dan yang menyadarinya
 * nanti adalah data yang sudah tercemar. Redis tetap dipakai, tapi hanya sebagai
 * singgahan 30 detik supaya jalur panas tidak menanyai Postgres tiap pesan.
 *
 * ── Batas waktu otomatis ────────────────────────────────────────────────────
 * `humanLearningPausedUntil` WAJIB ada isinya. Sakelar jeda yang lupa
 * dikembalikan adalah bug diam yang paling mahal: HL berhenti belajar berhari-
 * hari dan tidak ada satu pun galat yang muncul. Lewat dari waktu itu, jedanya
 * batal dengan sendirinya.
 *
 * ⚠️ Pemasangan ini mengasumsikan SATU bisnis (Juragan Pisau). Kalau nanti ada
 * bisnis kedua, `findFirst()` di bawah harus diganti pencarian per-businessId.
 */
const KUNCI_JEDA_HL = 'hl:jeda';
const KUNCI_JEDA_CRM = 'crm:jeda';
const TTL_JEDA_DETIK = 30;

export async function hlSedangDijeda(): Promise<boolean> {
  try {
    const singgah = await redisClient.get(KUNCI_JEDA_HL);
    if (singgah !== null) return singgah === '1';
  } catch { /* Redis bermasalah — tanya DB langsung */ }

  let dijeda = false;
  try {
    const b = await prisma.business.findFirst({ select: { aiConfig: true } });
    const cfg = (b?.aiConfig ?? {}) as Record<string, unknown>;
    if (cfg['humanLearningPaused'] === true) {
      const pausedUntil = cfg['humanLearningPausedUntil'];
      if (!pausedUntil || pausedUntil === 'PERMANENT') {
        dijeda = true; // Jeda permanen / on-off manual
      } else {
        const sampai = typeof pausedUntil === 'string' ? Date.parse(pausedUntil) : NaN;
        dijeda = Number.isFinite(sampai) && sampai > Date.now();
      }
    }
  } catch (err) {
    logger.warn(`[HL] Sakelar jeda tidak terbaca, dianggap TIDAK dijeda: ${err}`);
    dijeda = false;
  }

  try { await redisClient.set(KUNCI_JEDA_HL, dijeda ? '1' : '0', 'EX', TTL_JEDA_DETIK); }
  catch { /* gagal menyinggahkan bukan alasan gagal melayani */ }
  return dijeda;
}

export async function crmSedangDijeda(): Promise<boolean> {
  try {
    const singgah = await redisClient.get(KUNCI_JEDA_CRM);
    if (singgah !== null) return singgah === '1';
  } catch { /* Redis bermasalah — tanya DB langsung */ }

  let dijeda = false;
  try {
    const b = await prisma.business.findFirst({ select: { aiConfig: true } });
    const cfg = (b?.aiConfig ?? {}) as Record<string, unknown>;
    if (cfg['crmIntelligencePaused'] === true) {
      const pausedUntil = cfg['crmIntelligencePausedUntil'];
      if (!pausedUntil || pausedUntil === 'PERMANENT') {
        dijeda = true; // Jeda permanen / on-off manual
      } else {
        const sampai = typeof pausedUntil === 'string' ? Date.parse(pausedUntil) : NaN;
        dijeda = Number.isFinite(sampai) && sampai > Date.now();
      }
    }
  } catch (err) {
    logger.warn(`[CRM] Sakelar jeda tidak terbaca, dianggap TIDAK dijeda: ${err}`);
    dijeda = false;
  }

  try { await redisClient.set(KUNCI_JEDA_CRM, dijeda ? '1' : '0', 'EX', TTL_JEDA_DETIK); }
  catch { /* gagal menyinggahkan bukan alasan gagal melayani */ }
  return dijeda;
}

/**
 * Status jeda Auto-Learning untuk ditampilkan di UI
 */
export async function getHlJedaStatus(
  businessId: string,
): Promise<{ humanLearningPaused: boolean; humanLearningPausedUntil: string | null }> {
  const b = await prisma.business.findUnique({ where: { id: businessId }, select: { aiConfig: true } });
  const cfg = (b?.aiConfig ?? {}) as Record<string, unknown>;
  const paused = cfg['humanLearningPaused'] === true;
  const pausedUntil = typeof cfg['humanLearningPausedUntil'] === 'string'
    ? (cfg['humanLearningPausedUntil'] as string)
    : null;

  if (!paused) return { humanLearningPaused: false, humanLearningPausedUntil: null };
  if (!pausedUntil || pausedUntil === 'PERMANENT') {
    return { humanLearningPaused: true, humanLearningPausedUntil: null };
  }
  const sampai = Date.parse(pausedUntil);
  const aktif = Number.isFinite(sampai) && sampai > Date.now();
  return { humanLearningPaused: aktif, humanLearningPausedUntil: aktif ? pausedUntil : null };
}

export async function setHlJeda(
  businessId: string,
  dijeda: boolean,
  sampaiIso: string | null,
): Promise<void> {
  const b = await prisma.business.findUnique({ where: { id: businessId }, select: { aiConfig: true } });
  const cfg = { ...((b?.aiConfig ?? {}) as Record<string, unknown>) };
  cfg['humanLearningPaused'] = dijeda;
  cfg['humanLearningPausedUntil'] = dijeda ? sampaiIso : null;
  await prisma.business.update({ where: { id: businessId }, data: { aiConfig: cfg as any } });

  try { await redisClient.set(KUNCI_JEDA_HL, dijeda ? '1' : '0', 'EX', TTL_JEDA_DETIK); }
  catch { /* gagal menyinggahkan bukan alasan gagal menyimpan ke DB */ }

  logger.info(
    `[HL] Sakelar jeda Auto-Learning diubah: dijeda=${dijeda}` +
    (dijeda ? `, sampai=${sampaiIso || 'PERMANEN'}` : '') + ` (business ${businessId})`,
  );
}

/**
 * Status jeda CRM Intelligence untuk ditampilkan di UI
 */
export async function getCrmJedaStatus(
  businessId: string,
): Promise<{ crmIntelligencePaused: boolean; crmIntelligencePausedUntil: string | null }> {
  const b = await prisma.business.findUnique({ where: { id: businessId }, select: { aiConfig: true } });
  const cfg = (b?.aiConfig ?? {}) as Record<string, unknown>;
  const paused = cfg['crmIntelligencePaused'] === true;
  const pausedUntil = typeof cfg['crmIntelligencePausedUntil'] === 'string'
    ? (cfg['crmIntelligencePausedUntil'] as string)
    : null;

  if (!paused) return { crmIntelligencePaused: false, crmIntelligencePausedUntil: null };
  if (!pausedUntil || pausedUntil === 'PERMANENT') {
    return { crmIntelligencePaused: true, crmIntelligencePausedUntil: null };
  }
  const sampai = Date.parse(pausedUntil);
  const aktif = Number.isFinite(sampai) && sampai > Date.now();
  return { crmIntelligencePaused: aktif, crmIntelligencePausedUntil: aktif ? pausedUntil : null };
}

export async function setCrmJeda(
  businessId: string,
  dijeda: boolean,
  sampaiIso: string | null,
): Promise<void> {
  const b = await prisma.business.findUnique({ where: { id: businessId }, select: { aiConfig: true } });
  const cfg = { ...((b?.aiConfig ?? {}) as Record<string, unknown>) };
  cfg['crmIntelligencePaused'] = dijeda;
  cfg['crmIntelligencePausedUntil'] = dijeda ? sampaiIso : null;
  await prisma.business.update({ where: { id: businessId }, data: { aiConfig: cfg as any } });

  try { await redisClient.set(KUNCI_JEDA_CRM, dijeda ? '1' : '0', 'EX', TTL_JEDA_DETIK); }
  catch { /* gagal menyinggahkan bukan alasan gagal menyimpan ke DB */ }

  logger.info(
    `[CRM] Sakelar jeda CRM Intelligence diubah: dijeda=${dijeda}` +
    (dijeda ? `, sampai=${sampaiIso || 'PERMANEN'}` : '') + ` (business ${businessId})`,
  );
}


export const humanLearningManager = new HumanLearningManager();
