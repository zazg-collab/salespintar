import { Worker } from 'bullmq';
import { redisBull } from '../config/redis';
import { env } from '../config/env';
import { logger } from '../utils/logger';

export { shadowMiningQueue } from './shadow-mining.queue';
export { questionMiningQueue } from './question-mining.queue';
export { debounceQueue } from './debounce.queue';
export { hlIdleFlushQueue } from './hl-idle-flush.queue';
export { reconciliationSweeperQueue } from './reconciliation-sweeper.queue';
export { tokenVaultReconciliationQueue } from './token-vault-reconciliation.queue'; // [2026-08-25] Multi-BM Token Vault Tahap 1
export { capiQueue } from './capi.queue'; // Fase 43: Meta CAPI event queue

export async function setupWorkers() {
  const { handleShadowMining } = await import('./shadow-mining.worker');
  const { handleDebounceFlush } = await import('./debounce.worker');
  const { handleQuestionMining } = await import('./question-mining.worker');
  const { handleHlIdleFlush } = await import('./hl-idle-flush.worker');
  const { pasangJadwalPenyapuIdle } = await import('./hl-idle-flush.queue');
  const { handleReconciliationSweeper } = await import('./reconciliation-sweeper.worker');
  const { pasangJadwalReconciliationSweeper } = await import('./reconciliation-sweeper.queue');
  const { handleTokenVaultReconciliation } = await import('./token-vault-reconciliation.worker');
  const { pasangJadwalTokenVaultReconciliation } = await import('./token-vault-reconciliation.queue');

  // Shadow Mining worker: concurrency 1 (operasi berat, hindari flood Groq/LLM API)
  new Worker('shadow-mining', handleShadowMining, {
    connection: redisBull,
    concurrency: 1,
    limiter: { max: 5, duration: 60000 }, // maks 5 job per menit
  });

  // Worker penutup window debounce buffer
  new Worker('debounce-flush', handleDebounceFlush, {
    connection: redisBull,
    concurrency: 5,
  });

  // Question Miner: satu job = satu file chat, concurrency 1 untuk rate limiting LLM
  new Worker('question-mining', handleQuestionMining, {
    connection: redisBull,
    concurrency: 1,
    lockDuration: 120_000,
  });

  // Penyapu buffer Human Learning yang idle
  new Worker('hl-idle-flush', handleHlIdleFlush, {
    connection: redisBull,
    concurrency: 1,
    lockDuration: 120_000,
  });

  // Penyapu Rekonsiliasi CRM (Lapis 1)
  new Worker('reconciliation-sweeper', handleReconciliationSweeper, {
    connection: redisBull,
    concurrency: 1, // Hindari flood DB/Redis
  });

  // [2026-08-25] Penyapu Rekonsiliasi Token Vault (Blueprint Multi-BM Token Vault, Tahap 1 item 2)
  new Worker('token-vault-reconciliation', handleTokenVaultReconciliation, {
    connection: redisBull,
    concurrency: 1,
  });

  // Meta CAPI worker: concurrency 2, rate-limited 10/detik (Meta Graph API limit)
  const { handleCapiEvent } = await import('./capi.worker');
  new Worker('meta-capi', handleCapiEvent, {
    connection: redisBull,
    concurrency: 2,
    limiter: { max: 10, duration: 1000 }, // guard: maks 10 CAPI calls/detik
  });

  // Pasang jadwal batch harian jam 00:01 WIB
  await pasangJadwalPenyapuIdle();
  logger.info(
    `[HL/batch] Batch flush harian dijadwalkan setiap jam 00:01 WIB (Asia/Jakarta) ` +
    `memproses buffer hari kemarin secara utuh per pelanggan.`,
  );

  // Pasang jadwal rekonsiliasi sweeper (7x sehari)
  await pasangJadwalReconciliationSweeper();
  logger.info(`[CRM/batch] Reconciliation Sweeper dijadwalkan jalan 7x sehari.`);

  // [2026-08-25] Pasang jadwal rekonsiliasi Token Vault (tiap 15 menit)
  await pasangJadwalTokenVaultReconciliation();
  logger.info(`[TokenVault] Reconciliation dijadwalkan tiap 15 menit (menyapu business dgn pendingTokenSyncSince).`);

  logger.info('BullMQ workers initialized (Shadow Mining, Question Miner, Debounce, HL Flush, Reconciliation Sweeper, Meta CAPI — Fase 43)');
}

export async function closeQueues() {
  const { capiQueue: cq } = await import('./capi.queue'); // Fase 43
  const { shadowMiningQueue: smq } = await import('./shadow-mining.queue');
  const { debounceQueue: dq } = await import('./debounce.queue');
  const { questionMiningQueue: qmq } = await import('./question-mining.queue');
  const { hlIdleFlushQueue: hlq } = await import('./hl-idle-flush.queue');
  const { reconciliationSweeperQueue: rsq } = await import('./reconciliation-sweeper.queue');
  const { tokenVaultReconciliationQueue: tvrq } = await import('./token-vault-reconciliation.queue');
  await cq.close();
  await smq.close();
  await dq.close();
  await qmq.close();
  await hlq.close();
  await rsq.close();
  await tvrq.close();
}
