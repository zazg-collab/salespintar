import { Job } from 'bullmq';
import { logger } from '../utils/logger';
import type { HlIdleFlushJobData, HlIdleFlushResult } from './hl-idle-flush.queue';

// ──────────────────────────────────────────────────────────────────────────────
// WORKER PENYAPU IDLE — Fase 63
//
// Tugasnya satu baris: panggil `sweepIdleBuffers()`. Seluruh logikanya ada di
// service karena di situlah bentuk kunci Redis dan aturan ambangnya hidup;
// menyalinnya ke worker berarti dua tempat yang harus diubah bersamaan tiap kali
// bentuk kuncinya bergeser.
//
// Logging-nya SENGAJA membedakan "tidak ada buffer sama sekali" dari "ada buffer
// tapi belum waktunya". Itu pelajaran termahal dari bug LID (Fase 57): di sana
// "belum ada chat masuk" dan "semua pesan dibuang" menampilkan angka yang sama —
// nol — dan bug itu bertahan berhari-hari karena tidak ada yang bisa membedakan
// keduanya. Jangan ulangi bentuk yang sama di penyapu ini.
// ──────────────────────────────────────────────────────────────────────────────

export async function handleHlIdleFlush(
  job: Job<HlIdleFlushJobData, HlIdleFlushResult>,
): Promise<HlIdleFlushResult> {
  const { humanLearningManager } = await import('../services/human-learning.service');

  const targetDate = job.data?.targetDate;
  logger.info(`[HL/Worker] Menjalankan batch flush harian (targetDate: ${targetDate || 'KEMARIN'})...`);

  const hasil = await humanLearningManager.sweepDailyBatch(targetDate);

  if (hasil.diperiksa === 0) {
    logger.info(`[HL/Worker] Tidak ada buffer obrolan untuk tanggal yang diproses.`);
  } else {
    logger.info(
      `[HL/Worker] Batch harian selesai: ${hasil.dikirim} buffer dikirim ke Shadow Mining ` +
      `(dari ${hasil.diperiksa} buffer, ${hasil.belumWaktunya} dilewati).`,
    );
  }

  return hasil;
}
