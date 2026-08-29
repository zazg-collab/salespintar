import { logger } from '../utils/logger';
import { sendTelegram } from './telegram.service';

// ── Ambang Batas RSS ─────────────────────────────────────────────────────────
// 700 MB → Level 1: GC paksa + evict embedding model
// 850 MB → Level 2: alert Telegram ke Angga (container limit 1 GB)
// RSS idle setelah optimasi: ~600 MB. Peak 6 CS ramai: ~850–900 MB.
const RSS_WARN_MB  = 700;
const RSS_ALERT_MB = 850;

// Cek tiap 3 menit
const INTERVAL_MS = 3 * 60 * 1000;

// Cooldown alert: jangan spam Telegram, paling cepat tiap 30 menit
const ALERT_COOLDOWN_MS = 30 * 60 * 1000;
let lastAlertAt = 0;

// Callback eviction embedding model — dipasang dari server.ts via registerEvictEmbedding()
// Pakai pattern callback untuk hindari circular import
let evictEmbeddingFn: (() => void) | null = null;

/**
 * Daftarkan callback eviction embedding model.
 * Dipanggil dari server.ts setelah knowledge.service siap:
 *   registerEvictEmbedding(() => knowledgeService.evictModel());
 */
export function registerEvictEmbedding(fn: () => void): void {
  evictEmbeddingFn = fn;
}

let watchdogInterval: NodeJS.Timeout | null = null;

function runWatchdog(): void {
  const { rss, heapUsed, external } = process.memoryUsage();
  const rssMB  = rss      / 1024 / 1024;
  const heapMB = heapUsed / 1024 / 1024;
  const extMB  = external / 1024 / 1024;

  // Di bawah ambang → aman, tidak ada tindakan
  if (rssMB < RSS_WARN_MB) return;

  logger.warn(
    `[MemWatchdog] RSS ${rssMB.toFixed(0)} MB (heap ${heapMB.toFixed(0)} MB, ` +
    `ext ${extMB.toFixed(0)} MB) — melampaui ambang ${RSS_WARN_MB} MB, mulai cleanup`,
  );

  // ── Level 1: Force GC ─────────────────────────────────────────────────────
  // Butuh --expose-gc di NODE_OPTIONS. Kalau tidak ada, lewati.
  if (typeof (global as any).gc === 'function') {
    (global as any).gc();
    const after = process.memoryUsage().rss / 1024 / 1024;
    logger.info(`[MemWatchdog] GC selesai → RSS ${after.toFixed(0)} MB`);
  }

  // ── Level 1: Evict embedding model ───────────────────────────────────────
  if (evictEmbeddingFn) {
    evictEmbeddingFn();
    logger.info('[MemWatchdog] Embedding model di-evict dari RAM (lazy-load ulang saat dibutuhkan)');
  }

  // ── Level 2: Alert Telegram jika masih kritis ─────────────────────────────
  if (rssMB >= RSS_ALERT_MB) {
    const now = Date.now();
    if (now - lastAlertAt > ALERT_COOLDOWN_MS) {
      lastAlertAt = now;
      const msg =
        `⚠️ *SalesPintar RAM Warning*\n` +
        `RSS: *${rssMB.toFixed(0)} MB* (limit: 1.000 MB)\n` +
        `Heap: ${heapMB.toFixed(0)} MB | Ext: ${extMB.toFixed(0)} MB\n` +
        `GC + evict embedding sudah dijalankan otomatis.\n` +
        `Pantau: \`docker stats salespintar-api\``;
      sendTelegram(msg).catch((err: unknown) =>
        logger.warn(`[MemWatchdog] Gagal kirim Telegram: ${err}`),
      );

    }
  }
}

/** Aktifkan watchdog. Panggil sekali dari server.ts setelah bootstrap. */
export function startMemWatchdog(): void {
  if (watchdogInterval) return;
  watchdogInterval = setInterval(runWatchdog, INTERVAL_MS);
  watchdogInterval.unref(); // tidak menghalangi graceful shutdown
  logger.info(
    `[MemWatchdog] Aktif — cek RAM tiap ${INTERVAL_MS / 60000} mnt ` +
    `(warn >${RSS_WARN_MB} MB, alert >${RSS_ALERT_MB} MB)`,
  );
}

/** Hentikan watchdog saat SIGTERM. */
export function stopMemWatchdog(): void {
  if (watchdogInterval) {
    clearInterval(watchdogInterval);
    watchdogInterval = null;
    logger.info('[MemWatchdog] Dihentikan');
  }
}
