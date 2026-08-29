import { Router, Request, Response, NextFunction } from 'express';
import { authenticate, authorize } from '../middleware/auth';
import { shadowMiningQueue } from '../queues/shadow-mining.queue';
import { prisma } from '../config/prisma';
import { env } from '../config/env';
import { resolveShadowMiningMode } from '../queues/shadow-mining.worker';
import { resolveModelBerlaku } from '../services/llm';

const router = Router();

// ──────────────────────────────────────────────────────────────────────────────
// POST /api/v1/shadow-mining/trigger/:conversationId
// Trigger shadow mining manual untuk satu percakapan
// ──────────────────────────────────────────────────────────────────────────────
router.post(
  '/trigger/:conversationId',
  authenticate,
  authorize('ADMIN'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const conversationId = req.params.conversationId as string;
      const businessId = req.user!.businessId;

      // Validasi conversation milik business ini
      const conversation = await prisma.conversation.findFirst({
        where: { id: conversationId, businessId },
        select: { id: true, status: true },
      });

      if (!conversation) {
        res.status(404).json({ error: { message: 'Percakapan tidak ditemukan' } });
        return;
      }

      const job = await shadowMiningQueue.add(
        'mine-conversation',
        { conversationId, businessId, triggeredBy: 'manual' },
        { priority: 10 }, // manual trigger dapat prioritas lebih tinggi
      );

      res.json({
        success: true,
        message: 'Shadow mining job ditambahkan ke antrian',
        data: { jobId: job.id, conversationId, status: 'queued' },
      });
    } catch (err) { next(err); }
  },
);

// ──────────────────────────────────────────────────────────────────────────────
// POST /api/v1/shadow-mining/trigger-batch
// Trigger shadow mining untuk semua percakapan RESOLVED yang belum pernah di-mine
// Body: { daysBack?: number } — default 7 hari terakhir
// ──────────────────────────────────────────────────────────────────────────────
router.post(
  '/trigger-batch',
  authenticate,
  authorize('ADMIN'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const businessId = req.user!.businessId;
      const daysBack = Number(req.body.daysBack) || 7;
      const since = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000);

      // Ambil semua conversation RESOLVED dalam rentang waktu
      const conversations = await prisma.conversation.findMany({
        where: {
          businessId,
          status: 'RESOLVED',
          updatedAt: { gte: since },
        },
        select: { id: true },
      });

      if (conversations.length === 0) {
        res.json({ success: true, message: 'Tidak ada percakapan resolved yang ditemukan', data: { queued: 0 } });
        return;
      }

      // Tambahkan semua ke queue dengan delay agar tidak flood Groq API
      const jobs = await shadowMiningQueue.addBulk(
        conversations.map((c, idx) => ({
          name: 'mine-conversation',
          data: { conversationId: c.id, businessId, triggeredBy: 'manual' as const },
          opts: { delay: idx * 2000 }, // delay 2 detik per job
        })),
      );

      res.json({
        success: true,
        message: `${jobs.length} percakapan ditambahkan ke antrian mining`,
        data: {
          queued: jobs.length,
          daysBack,
          jobIds: jobs.map(j => j.id),
        },
      });
    } catch (err) { next(err); }
  },
);

// ──────────────────────────────────────────────────────────────────────────────
// GET /api/v1/shadow-mining/status
// Status queue: waiting, active, completed, failed + konfigurasi mode
// ──────────────────────────────────────────────────────────────────────────────
router.get(
  '/status',
  authenticate,
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const [waiting, active, completed, failed, delayed] = await Promise.all([
        shadowMiningQueue.getWaitingCount(),
        shadowMiningQueue.getActiveCount(),
        shadowMiningQueue.getCompletedCount(),
        shadowMiningQueue.getFailedCount(),
        shadowMiningQueue.getDelayedCount(),
      ]);

      res.json({
        success: true,
        data: {
          queue: { waiting, active, completed, failed, delayed },
          config: {
            // Fix C9: mode per business dari DB, bukan env global
            mode: await resolveShadowMiningMode(_req.user!.businessId),
            minMessages: env.SHADOW_MINING_MIN_MESSAGES,
            similarityThreshold: env.SHADOW_MINING_SIMILARITY_THRESHOLD,
            // ⚠️ `resolveModelBerlaku('extract', …)`, BUKAN `env.GROQ_EXTRACTOR_MODEL`.
            // Baris ini dulu membaca env mentah, dan sejak Fase 59 itu berarti
            // MELAPORKAN YANG SALAH: `LLM_MODEL_EXTRACT` (dan pilihan di halaman
            // Pengaturan Model) mengalahkan `GROQ_EXTRACTOR_MODEL`, jadi dashboard
            // akan menyebut satu model sementara yang benar-benar menambang model
            // lain. Persis keluhan Angga 30 Juli: "nanti tau2 milihnya apa di
            // dashboard ternyata aslinya apa". Sumber yang menang harus jadi sumber
            // yang DILAPORKAN.
            extractorModel: (await resolveModelBerlaku('extract', _req.user!.businessId)).spec,
          },
        },
      });
    } catch (err) { next(err); }
  },
);

// ──────────────────────────────────────────────────────────────────────────────
// GET /api/v1/shadow-mining/job/:jobId
// Status satu job tertentu
// ──────────────────────────────────────────────────────────────────────────────
router.get(
  '/job/:jobId',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const jobId = req.params.jobId as string;
      const job = await shadowMiningQueue.getJob(jobId);

      if (!job) {
        res.status(404).json({ error: { message: 'Job tidak ditemukan' } });
        return;
      }

      const state = await job.getState();
      const progress = job.progress;

      res.json({
        success: true,
        data: {
          jobId,
          state,
          progress,
          data: job.data,
          result: job.returnvalue,
          failedReason: job.failedReason,
          timestamp: {
            created: job.timestamp ? new Date(job.timestamp).toISOString() : null,
            processed: job.processedOn ? new Date(job.processedOn).toISOString() : null,
            finished: job.finishedOn ? new Date(job.finishedOn).toISOString() : null,
          },
        },
      });
    } catch (err) { next(err); }
  },
);

// ──────────────────────────────────────────────────────────────────────────────
// PATCH /api/v1/shadow-mining/mode
// Ubah mode: auto (langsung aktif) atau draft (masuk Draft_AI folder)
// Body: { mode: "auto" | "draft" }
//
// Fix audit C9 (duplikat dari /auto-learning/mode — tidak tercatat di handover,
// ditemukan saat pengerjaan). Endpoint ini dulu juga memutasi objek env, jadi
// dua endpoint yang mengatur hal sama bisa berbeda perilaku. Keduanya kini
// menulis ke kolom Business.shadowMiningMode yang sama.
// ──────────────────────────────────────────────────────────────────────────────
router.patch(
  '/mode',
  authenticate,
  authorize('ADMIN'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { mode } = req.body as { mode: string };
      if (mode !== 'auto' && mode !== 'draft') {
        res.status(400).json({ error: { message: 'mode harus "auto" atau "draft"' } });
        return;
      }

      await prisma.business.update({
        where: { id: req.user!.businessId },
        data: { shadowMiningMode: mode },
      });

      res.json({
        success: true,
        message: `Shadow Mining mode diubah ke "${mode}"`,
        data: {
          mode,
          note: mode === 'auto'
            ? 'Hasil mining langsung masuk ke vault sebagai knowledge aktif'
            : 'Hasil mining masuk ke folder Draft_AI, menunggu approve manual',
        },
      });
    } catch (err) { next(err); }
  },
);

export default router;
