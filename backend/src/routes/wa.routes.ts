import { Router, Request, Response, NextFunction } from 'express';
import { authenticate, authorize } from '../middleware/auth';
import { baileysManager } from '../services/baileys.service';
import { prisma } from '../config/prisma';
import { logger } from '../utils/logger';

const router = Router();

router.get('/qr', authenticate, authorize('ADMIN'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { businessId } = req.user!;
    let cred = await prisma.waCredential.findFirst({ where: { businessId } });

    if (!cred) {
      cred = await prisma.waCredential.create({
        data: {
          businessId,
          waNumber: 'pending',
          status: 'DISCONNECTED',
        },
      });
    }

    const qrCode = await baileysManager.connect(businessId, true);

    const updated = await prisma.waCredential.findFirst({ where: { businessId } });
    res.json({ qrCode: qrCode || updated?.qrCode, status: updated?.status, expiresAt: updated?.qrExpiresAt });
  } catch (err) { next(err); }
});

router.get('/status', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { businessId } = req.user!;
    const status = baileysManager.getStatus(businessId);
    const cred = await prisma.waCredential.findFirst({
      where: { businessId },
      select: { status: true, waNumber: true, lastConnectedAt: true },
    });

    res.json({
      connection: status,
      credential: cred || null,
    });
  } catch (err) { next(err); }
});

router.post('/disconnect', authenticate, authorize('ADMIN'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    await baileysManager.disconnect(req.user!.businessId);
    res.json({ message: 'WhatsApp diputuskan' });
  } catch (err) { next(err); }
});

/**
 * Jeda minimum antar permintaan Reconnect untuk satu business.
 *
 * ── Kenapa ini perlu ada di sisi server ─────────────────────────────────────
 * Tombol Reconnect di dashboard dulu tidak punya umpan balik apa pun — tidak ada
 * keadaan "sedang proses", tidak ada pesan galat. Jadi ketika sambungannya
 * bermasalah, yang terjadi persis seperti yang bisa diduga: tombolnya diklik
 * berulang-ulang karena tampak tidak bereaksi.
 *
 * Setiap klik membangun socket baru. Setiap socket baru membuat WhatsApp menutup
 * socket sebelumnya dengan conflict 440. Hasilnya perang rebutan yang memberi
 * makan dirinya sendiri — terlihat di log 30 Juli 2026 sebagai belasan siklus
 * "connected" lalu "Stream Errored (conflict)" dalam hitungan detik.
 *
 * Penjaga di sisi tampilan sudah dipasang juga, tapi tidak cukup: jeda ini harus
 * di server, sebab yang perlu dilindungi keadaan socket-nya — bukan tombolnya.
 */
const RECONNECT_COOLDOWN_MS = 10_000;
const lastReconnectAt = new Map<string, number>();

router.post('/reconnect', authenticate, authorize('ADMIN'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { businessId } = req.user!;

    const last = lastReconnectAt.get(businessId) ?? 0;
    const sinceMs = Date.now() - last;
    if (sinceMs < RECONNECT_COOLDOWN_MS) {
      const sisaDetik = Math.ceil((RECONNECT_COOLDOWN_MS - sinceMs) / 1000);
      logger.info(`[WA] Reconnect business ${businessId} ditolak: baru ${Math.round(sinceMs / 1000)} detik lalu`);
      // 429 supaya tampilan bisa membedakannya dari kegagalan sungguhan.
      res.status(429).json({
        message: `Percobaan sambung ulang baru saja dijalankan. Tunggu ${sisaDetik} detik lagi — menyambung berkali-kali justru membuat WhatsApp saling menendang koneksi.`,
      });
      return;
    }
    lastReconnectAt.set(businessId, Date.now());

    await baileysManager.disconnect(businessId);
    await baileysManager.connect(businessId);

    // Status dikembalikan supaya tampilan tidak menebak. Socket baru biasanya
    // belum selesai jabat tangan pada saat ini, jadi PENDING itu wajar dan
    // bukan kegagalan.
    res.json({
      message: 'Menyambung ulang...',
      connection: baileysManager.getStatus(businessId),
    });
  } catch (err) { next(err); }
});

export default router;
