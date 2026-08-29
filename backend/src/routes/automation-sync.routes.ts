import { Router, Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { z } from 'zod';
import { prisma } from '../config/prisma';
import { env } from '../config/env';
import { logger } from '../utils/logger';

/**
 * [2026-08-27] Fase 2 "Automation Meta Bot 24/7" -- endpoint machine-to-machine
 * VPS45 (cron Python, "claude-ads-v2") -> VPS Upcloud (backend Node ini).
 *
 * Menerima temuan hasil draft dari VPS45 (budget action, ad fatigue, budget
 * waste, hasil A/B test, audit landing page) dan menuliskannya ke 6 tabel
 * Prisma Fase 1 (AdBudgetActionHistory, AdFatigueRecord, BudgetWasteAudit,
 * AdABTestSession, LandingPageAuditRecord).
 *
 * SENGAJA mount TERPISAH dari ai-ads.routes.ts (yang di-gate `router.use(authenticate)`
 * JWT user di paling atas) -- endpoint ini tidak pernah punya user login,
 * jadi digerbangi shared-secret header `X-Internal-Sync-Key` dibanding
 * `AI_ADS_INTERNAL_SYNC_KEY`, dibandingkan pakai `crypto.timingSafeEqual`
 * supaya tidak bisa ditebak lewat timing attack. Pola sama seperti
 * `METAGUARD_INTERNAL_API_KEY` (video-guard.routes.ts) yang sudah ada duluan.
 *
 * `businessId` (UUID internal Upcloud) WAJIB dikirim VPS45 di tiap payload --
 * VPS45 TIDAK bisa menebaknya sendiri dari ad_account_id/bm_id karena skema
 * DB kita tidak menyimpan ad_account_id sebagai tabel tersendiri (cuma kolom
 * teks biasa di tabel-tabel tujuan; satu-satunya identitas Meta yang punya
 * baris sendiri di DB adalah `MetaBusinessManager.metaBusinessId`, dan itu
 * pun tidak unique). `config/shift_targets.json` di VPS45 SUDAH menyediakan
 * slot field `business_id` per target (saat ini `null`, placeholder) --
 * itu yang harus diisi Bossfren manual per target real, sama seperti bm_id.
 */

const router = Router();

function requireInternalSyncKey(): string {
  if (!env.AI_ADS_INTERNAL_SYNC_KEY) {
    throw new Error('AI_ADS_INTERNAL_SYNC_KEY belum dikonfigurasi -- endpoint internal-sync nonaktif.');
  }
  return env.AI_ADS_INTERNAL_SYNC_KEY;
}

router.use((req: Request, res: Response, next: NextFunction) => {
  let expected: string;
  try {
    expected = requireInternalSyncKey();
  } catch {
    logger.error('[AutomationSync] Dipanggil tapi AI_ADS_INTERNAL_SYNC_KEY kosong -- endpoint ditolak.');
    res.status(503).json({ error: { message: 'Endpoint internal-sync belum dikonfigurasi di server.' } });
    return;
  }
  const provided = req.header('X-Internal-Sync-Key') || '';
  const expectedBuf = Buffer.from(expected);
  const providedBuf = Buffer.from(provided);
  const ok = expectedBuf.length === providedBuf.length && crypto.timingSafeEqual(expectedBuf, providedBuf);
  if (!ok) {
    logger.warn('[AutomationSync] Percobaan akses dengan X-Internal-Sync-Key salah/kosong.');
    res.status(401).json({ error: { message: 'Unauthorized' } });
    return;
  }
  next();
});

// ── GET /automation-sync/ping — cek konektivitas + validitas kunci ─────────
router.get('/ping', async (_req, res) => {
  res.json({ ok: true, service: 'salespintar-upcloud', timestamp: new Date().toISOString() });
});

// ── Skema per jenis temuan ──────────────────────────────────────────────────
const budgetActionSchema = z.object({
  type: z.literal('budget_action'),
  adAccountId: z.string().min(1),
  campaignId: z.string().min(1),
  campaignName: z.string().min(1),
  adSetId: z.string().min(1),
  adSetName: z.string().min(1),
  tacticalBadge: z.string().min(1).max(20),
  actionType: z.string().min(1).max(30),
  triggerReason: z.string().min(1),
  previousBudget: z.number().nonnegative(),
  newBudget: z.number().nonnegative(),
  shiftType: z.string().min(1).max(20),
});

const adFatigueSchema = z.object({
  type: z.literal('ad_fatigue'),
  adAccountId: z.string().min(1),
  campaignId: z.string().min(1),
  adSetId: z.string().min(1),
  adId: z.string().min(1),
  adName: z.string().min(1),
  frequency7d: z.number(),
  ctrDecayPct: z.number(),
  cpmCreepPct: z.number(),
  fatigueSeverity: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']),
});

const budgetWasteSchema = z.object({
  type: z.literal('budget_waste'),
  adAccountId: z.string().min(1),
  estimatedWaste: z.number().nonnegative(),
  emqScorePurchase: z.number(),
  emqScoreLead: z.number(),
  findings: z.any(),
});

const abTestSchema = z.object({
  type: z.literal('ab_test'),
  adAccountId: z.string().min(1),
  adSetId: z.string().min(1),
  variantAId: z.string().min(1),
  variantBId: z.string().min(1),
  variantAName: z.string().min(1),
  variantBName: z.string().min(1),
  confidenceLevel: z.number().min(0).max(1).default(0),
  pValue: z.number().min(0).max(1).default(1),
  verdict: z.enum(['RUNNING', 'WINNER_A', 'WINNER_B', 'INCONCLUSIVE', 'KILLED']).default('RUNNING'),
  winnerAdId: z.string().nullable().optional(),
});

const landingPageAuditSchema = z.object({
  type: z.literal('landing_page_audit'),
  adId: z.string().min(1),
  landingPageUrl: z.string().min(1),
  messageMatchScore: z.number().int().min(1).max(10),
  loadTimeSeconds: z.number().nonnegative(),
  httpStatus: z.number().int(),
  dropoffRisk: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']),
  rewriteH1: z.string().nullable().optional(),
  rewriteSubhead: z.string().nullable().optional(),
  rewriteBullets: z.any().nullable().optional(),
  rewriteCta: z.string().nullable().optional(),
});


// [Fase 1B] layer_mutation — layer deterministik baru (Layer 1-17, routing_type: mutation).
// Dikirim Python VPS45 SETELAH menulis file MutationPlan v1 ke PLANS_DIR (lib/mutation_plan.py).
// planPath WAJIB non-null (422 di /ai-ads/approve kalau null).
const layerMutationSchema = z.object({
  type: z.literal('layer_mutation'),
  layerKey: z.string().min(1).max(100),
  objectId: z.string().min(1),
  objectType: z.enum(['campaign', 'ad_set', 'ad', 'account']).default('ad_set'),
  operation: z.string().min(1).max(80),
  reason: z.string().min(1),
  planPath: z.string().min(1),          // WAJIB non-null untuk tipe ini
  planSummary: z.any().optional(),      // ringkasan JSON isi plan (opsional)
  isUrgent: z.boolean().default(false), // true untuk Layer 7/8/12 (darurat)
  bmId: z.string().min(1).max(100),
});

// [Fase 7A] content_review — layer AI yang menghasilkan konten/copy (Layer 11/13).
// Approve hanya mark APPROVED di DB, tidak eksekusi ke Meta (desain interim keputusan Bossfren 2026-08-29).
// planPath TIDAK wajib untuk tipe ini — pengecualian dari validasi 422 di /ai-ads/approve.
const contentReviewSchema = z.object({
  type: z.literal('content_review'),
  layerKey: z.string().min(1).max(100),
  objectId: z.string().min(1),          // Ad ID yang dianalisis
  objectType: z.enum(['ad', 'ad_set', 'campaign']).default('ad'),
  reason: z.string().min(1),            // alasan trigger (CTR < 0.6%, CVR LP < 0.8%, dst)
  bmId: z.string().min(1).max(100),
  // contentData: isi konten AI yang direview. Format per layer:
  //   Layer 11 (CTR Hook): { hooks: [{title, body}], hookType: "pattern_interrupt|numeric_proof|objection_buster" }
  //   Layer 13 (LP Message Match): { rewriteH1, rewriteSubhead, rewriteCta, originalH1 }
  contentData: z.record(z.any()),
});

const findingSchema = z.discriminatedUnion('type', [
  budgetActionSchema,
  adFatigueSchema,
  budgetWasteSchema,
  abTestSchema,
  landingPageAuditSchema,
  layerMutationSchema,
  contentReviewSchema,
]);

const syncBodySchema = z.object({
  businessId: z.string().uuid(),
  source: z.string().min(1).max(50).default('vps45'),
  findings: z.array(findingSchema).min(1).max(100),
});


// Jendela anti-duplikat -- emergency_brake.py TIDAK punya idempotency guard
// utk landing-page-down (lihat audit arsitektur Fase 2), jadi halaman yang
// persisten down bisa nge-draft temuan baru tiap 15 menit selama-lamanya.
// Bukan solusi permanen (yang benar dibenahi di VPS45 sendiri, Task #73),
// tapi ini pengaman murah di sisi penerima supaya tabel tidak banjir baris
// kembar untuk kondisi yang sama selama <10 menit terakhir.
const DUPLICATE_WINDOW_MS = 10 * 60 * 1000;

type SyncResult = { index: number; type: string; status: string; id?: string; error?: string };

// ── POST /automation-sync/findings — VPS45 push draft temuan ke Upcloud ────
router.post('/findings', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = syncBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: { message: 'Payload tidak valid', issues: parsed.error.issues } });
      return;
    }
    const { businessId, findings, source } = parsed.data;

    const business = await prisma.business.findUnique({ where: { id: businessId }, select: { id: true } });
    if (!business) {
      res.status(404).json({ error: { message: `businessId ${businessId} tidak ditemukan di Upcloud.` } });
      return;
    }

    const results: SyncResult[] = [];

    for (let i = 0; i < findings.length; i++) {
      const f = findings[i];
      try {
        if (f.type === 'budget_action') {
          const row = await prisma.adBudgetActionHistory.create({
            data: {
              businessId,
              adAccountId: f.adAccountId,
              campaignId: f.campaignId,
              campaignName: f.campaignName,
              adSetId: f.adSetId,
              adSetName: f.adSetName,
              tacticalBadge: f.tacticalBadge,
              actionType: f.actionType,
              triggerReason: f.triggerReason,
              previousBudget: f.previousBudget,
              newBudget: f.newBudget,
              shiftType: f.shiftType,
              // Draft dari VPS45 -- BELUM dieksekusi, nunggu keputusan manusia
              // lewat POST /ai-ads/automation/execute (Fase 1). 'PENDING_APPROVAL'
              // ini TAMBAHAN baru di luar 3 nilai yang disebut di komentar
              // schema.prisma (AUTO_EXECUTED | USER_APPROVED | REJECTED) --
              // aman karena kolomnya varchar biasa, bukan enum DB, jadi tidak
              // butuh migrasi. GET /automation/queue tetap menemukannya karena
              // filternya `executedAt: null`, bukan berdasar executionMode.
              executionMode: 'PENDING_APPROVAL',
              executedAt: null,
            },
          });
          results.push({ index: i, type: f.type, status: 'created', id: row.id });
        } else if (f.type === 'ad_fatigue') {
          const dupe = await prisma.adFatigueRecord.findFirst({
            where: {
              businessId,
              adId: f.adId,
              status: 'DETECTED',
              createdAt: { gte: new Date(Date.now() - DUPLICATE_WINDOW_MS) },
            },
            select: { id: true },
          });
          if (dupe) {
            results.push({ index: i, type: f.type, status: 'skipped_duplicate', id: dupe.id });
            continue;
          }
          const row = await prisma.adFatigueRecord.create({
            data: {
              businessId,
              adAccountId: f.adAccountId,
              campaignId: f.campaignId,
              adSetId: f.adSetId,
              adId: f.adId,
              adName: f.adName,
              frequency7d: f.frequency7d,
              ctrDecayPct: f.ctrDecayPct,
              cpmCreepPct: f.cpmCreepPct,
              fatigueSeverity: f.fatigueSeverity,
            },
          });
          results.push({ index: i, type: f.type, status: 'created', id: row.id });
        } else if (f.type === 'budget_waste') {
          const row = await prisma.budgetWasteAudit.create({
            data: {
              businessId,
              adAccountId: f.adAccountId,
              estimatedWaste: f.estimatedWaste,
              emqScorePurchase: f.emqScorePurchase,
              emqScoreLead: f.emqScoreLead,
              findings: f.findings ?? {},
            },
          });
          results.push({ index: i, type: f.type, status: 'created', id: row.id });
        } else if (f.type === 'ab_test') {
          const existing = await prisma.adABTestSession.findFirst({
            where: {
              businessId,
              adSetId: f.adSetId,
              variantAId: f.variantAId,
              variantBId: f.variantBId,
              verdict: 'RUNNING',
            },
          });
          if (existing) {
            const row = await prisma.adABTestSession.update({
              where: { id: existing.id },
              data: {
                confidenceLevel: f.confidenceLevel,
                pValue: f.pValue,
                verdict: f.verdict,
                winnerAdId: f.winnerAdId ?? null,
              },
            });
            results.push({ index: i, type: f.type, status: 'updated', id: row.id });
          } else {
            const row = await prisma.adABTestSession.create({
              data: {
                businessId,
                adAccountId: f.adAccountId,
                adSetId: f.adSetId,
                variantAId: f.variantAId,
                variantBId: f.variantBId,
                variantAName: f.variantAName,
                variantBName: f.variantBName,
                confidenceLevel: f.confidenceLevel,
                pValue: f.pValue,
                verdict: f.verdict,
                winnerAdId: f.winnerAdId ?? null,
              },
            });
            results.push({ index: i, type: f.type, status: 'created', id: row.id });
          }
        } else if (f.type === 'landing_page_audit') {
          const dupe = await prisma.landingPageAuditRecord.findFirst({
            where: {
              businessId,
              adId: f.adId,
              landingPageUrl: f.landingPageUrl,
              createdAt: { gte: new Date(Date.now() - DUPLICATE_WINDOW_MS) },
            },
            select: { id: true },
          });
          if (dupe) {
            results.push({ index: i, type: f.type, status: 'skipped_duplicate', id: dupe.id });
            continue;
          }
          const row = await prisma.landingPageAuditRecord.create({
            data: {
              businessId,
              adId: f.adId,
              landingPageUrl: f.landingPageUrl,
              messageMatchScore: f.messageMatchScore,
              loadTimeSeconds: f.loadTimeSeconds,
              httpStatus: f.httpStatus,
              dropoffRisk: f.dropoffRisk,
              rewriteH1: f.rewriteH1 ?? null,
              rewriteSubhead: f.rewriteSubhead ?? null,
              rewriteCta: f.rewriteCta ?? null,
              ...(f.rewriteBullets !== undefined && f.rewriteBullets !== null
                ? { rewriteBullets: f.rewriteBullets }
                : {}),
            },
          });
          results.push({ index: i, type: f.type, status: 'created', id: row.id });
        } else if (f.type === 'layer_mutation') {
          // [Fase 1B / Fase 7A] layer_mutation: upsert ke AiAdsRecommendation
          // Cek duplikat: skip kalau sudah ada baris PENDING_APPROVAL yang SAMA (layerKey + objectId)
          // dalam 30 menit terakhir — mencegah VPS45 spam dalam 1 shift window.
          // FIX AUDIT (2026-08-29): pakai planSummary.objectId sebagai dedupe key (bukan planPath
          // yang bisa berubah tiap run karena timestamp di nama file). Pola sama dengan content_review.
          const LAYER_DUPE_WINDOW_MS = 30 * 60 * 1000;
          const layerDupe = await (prisma as any).aiAdsRecommendation.findFirst({
            where: {
              businessId,
              layerKey: f.layerKey,
              // Cek via planSummary.objectId yang disimpan saat create — lebih stabil dari planPath
              planSummary: { path: ['objectId'], equals: f.objectId },
              status: 'PENDING_APPROVAL',
              createdAt: { gte: new Date(Date.now() - LAYER_DUPE_WINDOW_MS) },
            },
            select: { id: true },
          });
          if (layerDupe) {
            results.push({ index: i, type: f.type, status: 'skipped_duplicate', id: layerDupe.id });
            continue;
          }
          const layerRec = await (prisma as any).aiAdsRecommendation.create({
            data: {
              businessId,
              bmId: f.bmId,
              // shiftType null untuk rekomendasi dari layer generik (bukan run_shift.py lama)
              layerKey: f.layerKey,
              routingType: 'mutation',
              isUrgent: f.isUrgent ?? false,
              requestedBy: source,
              planPath: f.planPath,
              planSummary: f.planSummary ?? { objectId: f.objectId, objectType: f.objectType, operation: f.operation, reason: f.reason },
            },
          });
          results.push({ index: i, type: f.type, status: 'created', id: layerRec.id });
        } else if (f.type === 'content_review') {
          // [Fase 7A] content_review: upsert ke AiAdsRecommendation dengan contentData
          // TIDAK butuh planPath (pengecualian keputusan Bossfren 2026-08-29).
          // Approve di POST /ai-ads/approve hanya mark APPROVED di DB, tidak eksekusi ke Meta.
          // Dedupe: skip kalau sudah ada baris PENDING_APPROVAL untuk layerKey + objectId dalam 30 menit.
          const CONTENT_DUPE_WINDOW_MS = 30 * 60 * 1000;
          const contentDupe = await (prisma as any).aiAdsRecommendation.findFirst({
            where: {
              businessId,
              layerKey: f.layerKey,
              routingType: 'content_review',
              status: 'PENDING_APPROVAL',
              // objectId disimpan di planSummary.objectId
              planSummary: { path: ['objectId'], equals: f.objectId },
              createdAt: { gte: new Date(Date.now() - CONTENT_DUPE_WINDOW_MS) },
            },
            select: { id: true },
          });
          if (contentDupe) {
            results.push({ index: i, type: f.type, status: 'skipped_duplicate', id: contentDupe.id });
            continue;
          }
          const contentRec = await (prisma as any).aiAdsRecommendation.create({
            data: {
              businessId,
              bmId: f.bmId,
              layerKey: f.layerKey,
              routingType: 'content_review',
              isUrgent: false,  // content_review tidak pernah urgent berdasarkan desain Fase 7
              requestedBy: source,
              planPath: null,   // Sengaja null — approved tim kreatif eksekusi manual
              planSummary: { objectId: f.objectId, objectType: f.objectType, reason: f.reason },
              contentData: f.contentData,
            },
          });
          results.push({ index: i, type: f.type, status: 'created', id: contentRec.id });
        }

      } catch (errItem: any) {
        logger.error(`[AutomationSync] Gagal simpan finding #${i} (type=${f.type}, business=${businessId}): ${errItem?.message}`);
        results.push({ index: i, type: f.type, status: 'error', error: errItem?.message || 'unknown error' });
      }
    }

    const createdCount = results.filter((r) => r.status === 'created').length;
    logger.info(`[AutomationSync] source=${source} business=${businessId}: ${createdCount}/${findings.length} finding baru disimpan.`);
    res.json({ ok: true, businessId, receivedCount: findings.length, results });
  } catch (err) {
    next(err);
  }
});

export default router;
