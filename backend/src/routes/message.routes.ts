import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { authenticate } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { prisma } from '../config/prisma';
import { NotFoundError } from '../utils/errors';
import { baileysManager } from '../services/baileys.service';
import { toSendableJid } from '../utils/wa-jid';
import { getIO } from '../websocket/handler';

const router = Router({ mergeParams: true });

const sendMessageSchema = z.object({
  message: z.string().min(1).max(4096),
  messageType: z.enum(['text', 'image', 'document', 'location']).default('text'),
  mediaUrl: z.string().optional(),
});

router.get('/', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { businessId } = req.user!;
    const conversationId = req.params.id as string;
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 50;
    const skip = (page - 1) * limit;

    const conversation = await prisma.conversation.findFirst({
      where: { id: conversationId, businessId },
    });
    if (!conversation) throw new NotFoundError('Conversation');

    const [messages, total] = await Promise.all([
      prisma.message.findMany({
        where: { conversationId, businessId },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        include: {
          human: { select: { id: true, name: true } },
        },
      }),
      prisma.message.count({ where: { conversationId, businessId } }),
    ]);

    // Fase 115b: diratakan dari `{ data: messages, … }` — datar adalah konvensi
    // de-facto repo ini, lihat catatan di `business.routes.ts` (Fase 107).
    res.json({ messages: messages.reverse(), total, page, limit });
  } catch (err) { next(err); }
});

router.post('/', authenticate, validate(sendMessageSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { businessId, userId } = req.user!;
    const conversationId = req.params.id as string;

    const conversation = await prisma.conversation.findFirst({
      where: { id: conversationId, businessId },
      include: { lead: true },
    });
    if (!conversation) throw new NotFoundError('Conversation');

    // ── Pastikan pesan benar-benar bisa dikirim SEBELUM disimpan ────────────
    // Dulu urutannya: simpan ke DB → baru kirim via Baileys. Kalau WhatsApp
    // sedang putus, sendMessage() melempar error, seluruh request jadi 500, dan
    // `onSuccess` di frontend tidak pernah jalan sehingga daftar pesan tidak
    // di-refresh. Hasilnya membingungkan: pesan sudah tersimpan di database dan
    // tercatat sebagai terkirim oleh CS, tapi tidak muncul di dashboard dan
    // tidak pernah sampai ke pelanggan. Lebih baik menolak di depan dengan
    // alasan yang jelas daripada meninggalkan pesan hantu.
    if (!baileysManager.isConnected(businessId)) {
      res.status(503).json({
        error: { message: 'WhatsApp sedang tidak tersambung. Sambungkan ulang di menu WhatsApp Setup, lalu kirim lagi.' },
      });
      return;
    }

    const targetJid = toSendableJid(conversation.lead?.waId || conversation.lead?.waNumber);
    if (!targetJid) {
      res.status(422).json({
        error: { message: 'Nomor WhatsApp lead ini tidak valid, pesan tidak bisa dikirim.' },
      });
      return;
    }

    if (conversation.status === 'AI') {
      await prisma.conversation.update({
        where: { id: conversation.id },
        data: { status: 'HUMAN', humanId: userId },
      });
    }

    // Kirim dulu, baru catat — supaya tidak ada pesan yang tercatat terkirim
    // padahal gagal di tengah jalan.
    await baileysManager.sendMessage(businessId, targetJid, { text: req.body.message });

    const message = await prisma.message.create({
      data: {
        businessId,
        conversationId: conversation.id,
        leadId: conversation.leadId, // Fix C5: denormalisasi leadId
        message: req.body.message,
        messageType: req.body.messageType,
        mediaUrl: req.body.mediaUrl,
        fromRole: 'HUMAN',
        humanId: userId,
      },
    });

    const io = getIO();
    if (io) {
      io.to(`business:${businessId}`).emit('chat:new', {
        conversationId: conversation.id,
        message: {
          ...message,
          human: { id: userId, name: req.user!.userId },
        },
      });
    }

    res.status(201).json(message);
  } catch (err) { next(err); }
});

export default router;
