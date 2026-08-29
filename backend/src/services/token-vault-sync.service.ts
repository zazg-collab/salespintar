/**
 * token-vault-sync.service.ts — Blueprint "Ekstensi Fase 3: Global Agent Workspace & Multi-BM Token
 * Vault" v1.3, §1.B.2. Menyinkronkan token BM aktif satu business ke bm_tokens.json di VPS 45 lewat
 * PUT /v1/sync-tokens (bridge, sudah dienkripsi AES-256-GCM di sisi bridge sebelum ditulis ke disk --
 * lihat §1.B.1).
 *
 * Dipanggil dari 3 titik di business.routes.ts: POST /meta-bms, PUT /meta-bms/:id, DELETE /meta-bms/:id.
 * Semantik "full-replace-per-namespace": tiap panggilan mengirim SNAPSHOT LENGKAP semua BM aktif
 * (isActive=true DAN tokenStatus='ACTIVE') milik business itu -- BUKAN delta. Delete BM otomatis
 * tertangani karena BM yang dihapus tidak lagi ikut di snapshot berikutnya, tanpa perlu logic
 * "hapus 1 entry" terpisah.
 *
 * Kegagalan sync TIDAK BOLEH memblokir operasi CRUD utama (§1.B.2) -- caller (route handler) harus
 * memanggil fungsi ini SETELAH operasi Prisma sukses, dan TIDAK boleh melempar balik errornya ke
 * response utama. Kegagalan ditandai lewat kolom Business.pendingTokenSyncSince, disapu job
 * reconciliation periodik (lihat token-vault-reconciliation.queue.ts).
 */

import { prisma } from '../config/prisma';
import { decrypt } from './crypto.service';
import { env } from '../config/env';
import { logger } from '../utils/logger';

interface SyncTokensResult {
  ok: boolean;
  reason?: string;
}

const RETRY_DELAYS_MS = [1000, 3000, 9000]; // 1s / 3s / 9s, sesuai blueprint §1.B.1

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function callSyncTokensOnce(businessId: string, version: number, tokens: Record<string, string>, metadata: Record<string, any>): Promise<SyncTokensResult> {
  if (!env.AI_ADS_BRIDGE_URL || !env.AI_ADS_BRIDGE_API_KEY) {
    return { ok: false, reason: 'AI_ADS_BRIDGE_URL/API_KEY belum dikonfigurasi di backend .env' };
  }
  try {
    const resp = await fetch(`${env.AI_ADS_BRIDGE_URL}/v1/sync-tokens`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': env.AI_ADS_BRIDGE_API_KEY },
      body: JSON.stringify({ businessId, version, tokens, metadata }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      return { ok: false, reason: `HTTP ${resp.status}: ${text.slice(0, 300)}` };
    }
    const json: any = await resp.json().catch(() => null);
    if (json && json.accepted === false) {
      // stale_version -- bukan kegagalan, cuma sync yang lebih baru sudah menang di bridge.
      // Dianggap sukses (tidak perlu retry/reconciliation) karena state akhir sudah benar.
      logger.info(`[TokenVaultSync] Sync business ${businessId} ditolak bridge (stale_version, current=${json.currentVersion}) -- dianggap OK, state akhir sudah benar.`);
      return { ok: true };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Query ulang semua BM aktif milik `businessId`, dekripsi in-memory, kirim snapshot lengkap ber-
 * version ke bridge VPS45 dengan retry+backoff. Selalu resolve (tidak pernah throw) -- caller boleh
 * "fire and forget" tanpa await blocking response, TAPI disarankan tetap di-await supaya
 * pendingTokenSyncSince konsisten kalau proses Node mati sebelum promise selesai.
 */
export async function syncAllActiveTokensToBridge(businessId: string): Promise<void> {
  let bms: { id: string; accessToken: string }[];
  try {
    bms = await prisma.metaBusinessManager.findMany({
      where: { businessId, isActive: true, tokenStatus: 'ACTIVE' },
      select: { id: true, accessToken: true },
    });
  } catch (err) {
    logger.error(`[TokenVaultSync] Gagal query BM aktif utk business ${businessId}: ${err instanceof Error ? err.message : err}`);
    await markPendingSync(businessId);
    return;
  }

  
  let metadata: Record<string, any> = {};
  try {
    const biz = await prisma.business.findUnique({
      where: { id: businessId },
      select: { settings: true },
    });
    const settings = (biz?.settings ?? {}) as Record<string, any>;
    metadata = {
      globalDefaults: settings['aiAdsGlobalDefaults'] ?? {},
      bmBotEnabled: settings['bmBotEnabled'] ?? {},
    };
  } catch (err) {
    logger.error(`[TokenVaultSync] Gagal query metadata utk business ${businessId}: ${err}`);
  }

  const tokens: Record<string, string> = {};

  for (const bm of bms) {
    try {
      const plain = decrypt(bm.accessToken);
      if (plain) tokens[bm.id] = plain;
    } catch (err) {
      logger.warn(`[TokenVaultSync] Gagal dekripsi token BM ${bm.id}, dilewati dari snapshot: ${err instanceof Error ? err.message : err}`);
    }
  }

  const version = Date.now();
  let result: SyncTokensResult = { ok: false };
  for (let attempt = 0; attempt < RETRY_DELAYS_MS.length + 1; attempt++) {
    result = await callSyncTokensOnce(businessId, version, tokens, metadata);
    if (result.ok) break;
    if (attempt < RETRY_DELAYS_MS.length) {
      logger.warn(`[TokenVaultSync] Sync business ${businessId} gagal (percobaan ${attempt + 1}): ${result.reason} -- retry dalam ${RETRY_DELAYS_MS[attempt]}ms`);
      await sleep(RETRY_DELAYS_MS[attempt]!);
    }
  }

  if (result.ok) {
    logger.info(`[TokenVaultSync] Sync business ${businessId} sukses -- ${Object.keys(tokens).length} token, version ${version}.`);
    await clearPendingSync(businessId);
  } else {
    logger.error(`[TokenVaultSync] Sync business ${businessId} GAGAL TOTAL setelah retry: ${result.reason} -- ditandai pendingTokenSyncSince utk disapu job reconciliation.`);
    await markPendingSync(businessId);
  }
}

async function markPendingSync(businessId: string): Promise<void> {
  try {
    // Hanya set kalau belum ada nilai (biar timestamp mencerminkan kegagalan PERTAMA, bukan
    // ketimpa tiap retry gagal berikutnya) -- pakai updateMany dgn kondisi null di where.
    await prisma.business.updateMany({
      where: { id: businessId, pendingTokenSyncSince: null },
      data: { pendingTokenSyncSince: new Date() },
    });
  } catch (err) {
    logger.error(`[TokenVaultSync] Gagal menandai pendingTokenSyncSince utk business ${businessId}: ${err instanceof Error ? err.message : err}`);
  }
}

async function clearPendingSync(businessId: string): Promise<void> {
  try {
    await prisma.business.updateMany({
      where: { id: businessId, pendingTokenSyncSince: { not: null } },
      data: { pendingTokenSyncSince: null },
    });
  } catch (err) {
    logger.error(`[TokenVaultSync] Gagal membersihkan pendingTokenSyncSince utk business ${businessId}: ${err instanceof Error ? err.message : err}`);
  }
}
