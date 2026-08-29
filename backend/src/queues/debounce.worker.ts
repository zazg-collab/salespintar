import { Job } from 'bullmq';
import { flushDebounceIfCurrent } from '../services/state.service';
import { logger } from '../utils/logger';
import type { DebounceFlushJobData } from './debounce.queue';

// ──────────────────────────────────────────────────────────────────────────────
// DEBOUNCE WORKER — Fix Audit A5
//
// Menggantikan callback setTimeout yang dulu jalan di dalam proses penerima
// pesan. Worker ini menutup window debounce: kalau nomor generasi job masih
// yang terbaru, buffer diambil, digabung, lalu diteruskan ke antrian AI.
// Kalau sudah ada pesan susulan, job ini basi dan sengaja tidak melakukan apa-apa
// — job generasi terbaru yang akan mengerjakannya.
// ──────────────────────────────────────────────────────────────────────────────

export async function handleDebounceFlush(job: Job<DebounceFlushJobData>) {
  const { businessId, waNumber, generation } = job.data;

  const buffered = await flushDebounceIfCurrent(businessId, waNumber, generation);
  if (!buffered) {
    logger.debug(`[Debounce] Job gen ${generation} untuk ${waNumber} basi/kosong — dilewati`);
    return;
  }

  const combined = buffered.chunks.join('\n');
  logger.info(`[Debounce] Flush ${buffered.chunks.length} chunk untuk ${waNumber} (gen ${generation})`);

  // Import dinamis: memutus lingkaran import message.service → queues → worker.
  const { enqueueAiReply } = await import('../services/message.service');
  await enqueueAiReply(
    businessId,
    buffered.conversationId,
    buffered.leadId,
    combined,
    buffered.leadName,
    buffered.waJid,
  );
}
