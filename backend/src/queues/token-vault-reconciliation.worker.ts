import { Job } from 'bullmq';
import { logger } from '../utils/logger';
import type { TokenVaultReconciliationJobData, TokenVaultReconciliationResult } from './token-vault-reconciliation.queue';
import { prisma } from '../config/prisma';
import { syncAllActiveTokensToBridge } from '../services/token-vault-sync.service';

export async function handleTokenVaultReconciliation(
  _job: Job<TokenVaultReconciliationJobData, TokenVaultReconciliationResult>,
): Promise<TokenVaultReconciliationResult> {
  const pending = await prisma.business.findMany({
    where: { pendingTokenSyncSince: { not: null } },
    select: { id: true, name: true, pendingTokenSyncSince: true },
  });

  if (pending.length === 0) {
    return { diperiksa: 0, disinkronkanUlang: 0 };
  }

  logger.info(`[TokenVaultReconciliation] ${pending.length} business butuh resync token ke VPS45 bridge.`);

  let disinkronkanUlang = 0;
  for (const biz of pending) {
    try {
      await syncAllActiveTokensToBridge(biz.id);
      disinkronkanUlang++;
    } catch (err) {
      logger.error(`[TokenVaultReconciliation] Gagal resync business ${biz.id} (${biz.name}): ${err instanceof Error ? err.message : err}`);
    }
  }

  logger.info(`[TokenVaultReconciliation] Selesai: ${pending.length} diperiksa, ${disinkronkanUlang} dicoba disinkronkan ulang.`);
  return { diperiksa: pending.length, disinkronkanUlang };
}
