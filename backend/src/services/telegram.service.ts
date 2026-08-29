/**
 * Pemberitahuan ke Telegram untuk admin.
 *
 * Menggantikan rencana awal "kirim WhatsApp ke nomor admin", atas permintaan
 * Angga. Pilihan yang lebih baik daripada rencana semula: mengirim notifikasi
 * lewat nomor WhatsApp bisnis yang sama berarti bot mengirim pesan ke dirinya
 * sendiri, memakai sesi yang sama, di saat sesi itu justru sedang bermasalah —
 * kalau WhatsApp-nya putus, pemberitahuan "WhatsApp bermasalah" ikut hilang.
 * Telegram jalur terpisah, jadi tetap sampai walaupun WhatsApp sedang mati.
 *
 * ── Aturan penting ──────────────────────────────────────────────────────────
 * Modul ini TIDAK PERNAH melempar galat ke pemanggil. Notifikasi adalah lapisan
 * paling tidak penting di seluruh sistem; kegagalan mengirimnya tidak boleh
 * menjatuhkan pemrosesan pesan pelanggan yang sedang berjalan. Semua kesalahan
 * berhenti di sini dan cukup jadi baris log.
 *
 * Kalau token atau chat id belum diisi, modul ini diam sepenuhnya — tidak error,
 * tidak spam log. Fiturnya sekadar tidak aktif.
 */

import { env } from '../config/env';
import { logger } from '../utils/logger';

const TELEGRAM_TIMEOUT_MS = 8000;

export function isTelegramEnabled(): boolean {
  return Boolean(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID);
}

/** Lolos-kan karakter yang punya arti khusus di parse mode HTML Telegram. */
function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Kirim satu pesan. Sengaja tidak di-`await` di sebagian pemanggil — pelanggan
 * tidak boleh menunggu Telegram.
 */
export async function sendTelegram(text: string): Promise<void> {
  if (!isTelegramEnabled()) return;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TELEGRAM_TIMEOUT_MS);

  try {
    const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: env.TELEGRAM_CHAT_ID,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
      signal: controller.signal,
    });

    if (res.ok) {
      // Sengaja dicatat walau berhasil. Waktu notifikasi tidak sampai, pertanyaan
      // pertamanya selalu "apakah pesannya memang pernah dikirim?" — tanpa baris
      // ini, tidak ada cara membedakan "tidak terdeteksi" dari "gagal kirim".
      logger.info(`[Telegram] Pemberitahuan terkirim`);
    } else {
      const body = await res.text().catch(() => '');
      logger.warn(`[Telegram] Gagal kirim (${res.status}): ${body.slice(0, 200)}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`[Telegram] Gagal kirim: ${msg}`);
  } finally {
    clearTimeout(timer);
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Bentuk pesan siap pakai
//
// Ditulis supaya bisa dipahami sambil jalan, dari layar kunci HP: baris pertama
// menyatakan APA yang terjadi, baris berikutnya SIAPA, lalu barulah rinciannya.
// ──────────────────────────────────────────────────────────────────────────────

export function notifyHotLead(params: {
  leadName: string | null;
  waNumber: string;
  trigger: string;
}): void {
  void sendTelegram(
    `🔥 <b>Calon pembeli panas</b>\n` +
    `${escapeHtml(params.leadName || 'Tanpa nama')} — <code>${escapeHtml(params.waNumber)}</code>\n\n` +
    `Dia menulis: "${escapeHtml(params.trigger)}"\n\n` +
    `Sebaiknya dibalas manusia sekarang.`,
  );
}

export function notifyHandover(params: {
  leadName: string | null;
  waNumber: string | null;
  reason: string;
  detail?: string;
}): void {
  // Alasan teknis diterjemahkan; "ai_blocked:consecutive_limit" tidak berarti
  // apa-apa buat orang yang sedang pegang HP.
  const readable: Record<string, string> = {
    supervisor_high_risk: 'Jawaban bot berisiko salah, jadi ditahan',
    'ai_blocked:rate_limited': 'Pelanggan mengirim terlalu cepat',
    'ai_blocked:consecutive_limit': 'Bot sudah membalas beruntun tanpa jawaban',
    'ai_blocked:daily_cap': 'Kuota balasan harian pelanggan ini habis',
    'ai_blocked:lead_not_found': 'Data pelanggan tidak ditemukan',
    admin_takeover_phone: 'Anda membalas sendiri dari HP',
  };

  void sendTelegram(
    `🙋 <b>Percakapan butuh manusia</b>\n` +
    `${escapeHtml(params.leadName || 'Tanpa nama')}` +
    (params.waNumber ? ` — <code>${escapeHtml(params.waNumber)}</code>` : '') + `\n\n` +
    `Sebab: ${escapeHtml(readable[params.reason] || params.reason)}` +
    (params.detail ? `\n${escapeHtml(params.detail)}` : ''),
  );
}

export function notifySupervisorBlock(params: {
  leadName: string | null;
  waNumber: string | null;
  riskScore: number;
  riskReasons: string[];
  blockedReply: string;
}): void {
  void sendTelegram(
    `🛡️ <b>Jawaban bot diblokir pengaman</b>\n` +
    `${escapeHtml(params.leadName || 'Tanpa nama')}` +
    (params.waNumber ? ` — <code>${escapeHtml(params.waNumber)}</code>` : '') + `\n\n` +
    `Skor risiko: ${params.riskScore}\n` +
    `Alasan: ${escapeHtml(params.riskReasons.join(', ') || 'tidak dirinci')}\n\n` +
    `Yang urung dikirim:\n<i>${escapeHtml(params.blockedReply)}</i>\n\n` +
    `Pelanggan menerima pesan penunda, bukan jawaban ini.`,
  );
}
