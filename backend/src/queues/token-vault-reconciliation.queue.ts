import { Queue } from 'bullmq';
import { redisBull } from '../config/redis';

export const TOKEN_VAULT_RECONCILIATION_SCHEDULER_ID = 'token-vault-reconciliation-scheduler';

export type TokenVaultReconciliationJobData = {
  // Kosong
};

export interface TokenVaultReconciliationResult {
  diperiksa: number;
  disinkronkanUlang: number;
}

// [2026-08-25] Blueprint Global Agent Workspace & Multi-BM Token Vault, Tahap 1 item 2 (§1.B.1,
// syarat wajib bukan opsional). Menyapu business dengan pendingTokenSyncSince non-null (sync ke
// bridge VPS45 gagal total setelah retry) dan mengulang syncAllActiveTokensToBridge() -- aman
// diulang berkali-kali karena payload-nya versioned+idempotent di sisi bridge.
export const tokenVaultReconciliationQueue = new Queue<TokenVaultReconciliationJobData, TokenVaultReconciliationResult>('token-vault-reconciliation', {
  connection: redisBull,
  defaultJobOptions: {
    attempts: 2,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: 50,
    removeOnFail: 20,
  },
});

export async function pasangJadwalTokenVaultReconciliation(): Promise<void> {
  await tokenVaultReconciliationQueue.upsertJobScheduler(
    TOKEN_VAULT_RECONCILIATION_SCHEDULER_ID,
    { pattern: '*/15 * * * *' }, // tiap 15 menit, sesuai blueprint §1.B.1
    { name: 'token-vault-reconciliation-sweep' },
  );
}
