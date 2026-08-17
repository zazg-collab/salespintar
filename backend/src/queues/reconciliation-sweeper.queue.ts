import { Queue } from 'bullmq';
import { redisBull } from '../config/redis';

export const RECONCILIATION_SWEEPER_SCHEDULER_ID = 'reconciliation-sweeper-scheduler';

export type ReconciliationSweeperJobData = {
  // Kosong
};

export interface ReconciliationSweeperResult {
  diperiksa: number;
  diperbarui: number;
  dilewati: number;
}

export const reconciliationSweeperQueue = new Queue<ReconciliationSweeperJobData, ReconciliationSweeperResult>('reconciliation-sweeper', {
  connection: redisBull,
  defaultJobOptions: {
    attempts: 2,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: 50,
    removeOnFail: 20,
  },
});

export async function pasangJadwalReconciliationSweeper(): Promise<void> {
  await reconciliationSweeperQueue.upsertJobScheduler(
    RECONCILIATION_SWEEPER_SCHEDULER_ID,
    { pattern: '1 0,6,9,12,15,18,21 * * *', tz: 'Asia/Jakarta' },
    { name: 'daily-reconciliation-sweeper' },
  );
}
