import { Router, Request, Response, NextFunction } from 'express';
import { authenticate } from '../middleware/auth';
import { prisma } from '../config/prisma';
import { NotFoundError, ConflictError } from '../utils/errors';
import { getIO } from '../websocket/handler';
import { shadowMiningQueue } from '../queues/shadow-mining.queue';
import { logger } from '../utils/logger';

const router = Router();

router.get('/', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { businessId } = req.user!;
    const status = req.query.status as string | undefined;
    const leadId = req.query.leadId as string | undefined;
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
    const skip = (page - 1) * limit;

    const where: any = { businessId };
    if (status) where.status = status;
    if (leadId) where.leadId = leadId;

    const [conversations, total] = await Promise.all([
      prisma.conversation.findMany({
        where,
        include: {
          lead: { select: { id: true, name: true, waNumber: true, avatarUrl: true } },
          human: { select: { id: true, name: true } },
          messages: { take: 1, orderBy: { createdAt: 'desc' }, select: { message: true, createdAt: true, fromRole: true } },
        },
        orderBy: { updatedAt: 'desc' },
        skip,
        take: limit,
      }),
      prisma.conversation.count({ where }),
    ]);

    // Fase 115b: diratakan dari `{ data: conversations, … }` — datar adalah
    // konvensi de-facto repo ini, lihat catatan di `business.routes.ts` (Fase 107).
    res.json({ conversations, total, page, limit });
  } catch (err) { next(err); }
});

router.get('/:id', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const conversation = await prisma.conversation.findFirst({
      where: { id: req.params.id as string, businessId: req.user!.businessId },
      include: {
        lead: true,
        human: { select: { id: true, name: true } },
      },
    });
    if (!conversation) throw new NotFoundError('Conversation');
    res.json(conversation);
  } catch (err) { next(err); }
});

router.patch('/:id', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const conversation = await prisma.conversation.findFirst({
      where: { id: req.params.id as string, businessId: req.user!.businessId },
    });
    if (!conversation) throw new NotFoundError('Conversation');

    // ── Fix A3: Whitelist fields yang boleh diupdate — cegah Mass Assignment/IDOR ───────────────────────────────────────────────────────────────────────────────────
    const { status, humanId } = req.body as { status?: string; humanId?: string | null };
    const updateData: { status?: string; humanId?: string | null } = {};
    if (status !== undefined) updateData.status = status;
    if (humanId !== undefined) updateData.humanId = humanId;

    if (Object.keys(updateData).length === 0) {
      res.status(400).json({ error: { message: 'No valid fields to update. Allowed: status, humanId' } });
      return;
    }
    // businessId di WHERE clause mencegah update conversation milik business lain
    const updated = await prisma.conversation.update({
      where: { id: req.params.id as string, businessId: req.user!.businessId },
      data: updateData,
    });
    // ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
    res.json(updated);
  } catch (err) { next(err); }
});

router.post('/:id/takeover', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const conversation = await prisma.conversation.findFirst({
      where: { id: req.params.id as string, businessId: req.user!.businessId },
    });
    if (!conversation) throw new NotFoundError('Conversation');

    if (conversation.status === 'HUMAN' && conversation.humanId) {
      throw new ConflictError('Conversation already taken over by another sales');
    }

    const updated = await prisma.conversation.update({
      where: { id: req.params.id as string },
      data: { status: 'HUMAN', humanId: req.user!.userId },
    });

    const io = getIO();
    if (io) {
      io.to(`business:${req.user!.businessId}`).emit('chat:status', {
        conversationId: req.params.id as string,
        status: 'HUMAN',
        humanId: req.user!.userId,
      });
    }

    res.json(updated);
  } catch (err) { next(err); }
});

router.post('/:id/release', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const conversation = await prisma.conversation.findFirst({
      where: { id: req.params.id as string, businessId: req.user!.businessId },
    });
    if (!conversation) throw new NotFoundError('Conversation');

    // ── Siapa yang boleh mengembalikan percakapan ke AI ───────────────────────
    // Dulu filternya `humanId: req.user.userId` — hanya pemiliknya. Dua kebuntuan
    // yang ditimbulkannya:
    //   1. Percakapan yang dialihkan Supervisor punya humanId KOSONG, jadi tidak
    //      pernah cocok dengan siapa pun → 404 → terkunci selamanya.
    //   2. CS yang resign meninggalkan percakapan yang tak seorang pun bisa lepas,
    //      bahkan admin.
    const isOwner = conversation.humanId === req.user!.userId;
    const isUnassigned = !conversation.humanId;
    const isAdmin = req.user!.role === 'ADMIN';
    if (!isOwner && !isUnassigned && !isAdmin) {
      throw new ConflictError('Percakapan ini sedang dipegang CS lain. Hanya dia atau admin yang bisa mengembalikannya.');
    }

    const updated = await prisma.conversation.update({
      where: { id: req.params.id as string },
      data: { status: 'AI', humanId: null },
    });

    const io = getIO();
    if (io) {
      io.to(`business:${req.user!.businessId}`).emit('chat:status', {
        conversationId: req.params.id as string,
        status: 'AI',
      });
    }

    res.json(updated);
  } catch (err) { next(err); }
});

router.post('/:id/complete', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const conversation = await prisma.conversation.findFirst({
      where: { id: req.params.id as string, businessId: req.user!.businessId },
    });
    if (!conversation) throw new NotFoundError('Conversation');

    const updated = await prisma.conversation.update({
      where: { id: req.params.id as string },
      data: { status: 'DONE', endedAt: new Date() },
    });

    const io = getIO();
    if (io) {
      io.to(`business:${req.user!.businessId}`).emit('chat:status', {
        conversationId: req.params.id as string,
        status: 'DONE',
      });
    }

    // ── Auto-trigger Shadow Mining (bisa dimatikan per business) ────────────
    // Delay 5 detik supaya semua pesan sudah benar-benar tersimpan lebih dulu.
    const { isAutoMiningEnabled } = await import('../queues/shadow-mining.worker');
    if (await isAutoMiningEnabled(updated.businessId)) {
      shadowMiningQueue
        .add(
          'mine-conversation',
          { conversationId: updated.id, businessId: updated.businessId, triggeredBy: 'auto' },
          { delay: 5000 },
        )
        .then(job => logger.info(`[ShadowMining] Auto-enqueued job ${job.id} for conv ${updated.id}`))
        .catch(err => logger.warn(`[ShadowMining] Auto-enqueue failed for conv ${updated.id}: ${err}`));
    } else {
      logger.info(`[ShadowMining] Auto-mining dimatikan untuk business ${updated.businessId} — conv ${updated.id} dilewati`);
    }
    // ────────────────────────────────────────────────────────────────────────

    res.json(updated);
  } catch (err) { next(err); }
});

export default router;
