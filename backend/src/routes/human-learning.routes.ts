/**
 * Human Learning Routes
 *
 * GET    /human-learning/sessions          — daftar semua sesi CS
 * POST   /human-learning/sessions          — daftarkan CS baru
 * GET    /human-learning/sessions/:id/qr   — ambil QR (connect di latar belakang kalau belum)
 * DELETE /human-learning/sessions/:id      — hapus sesi + putus koneksi
 * POST   /human-learning/sessions/:id/flush — flush buffer sekarang
 * GET    /human-learning/sessions/:id/buffers — lihat buffer chat yang sedang hidup
 * GET    /human-learning/sessions/:id/status — cek status koneksi real-time
 */

import { Router } from 'express';
import { prisma } from '../config/prisma';
import { authenticate } from '../middleware/auth';
import { AppError } from '../utils/errors';
import { humanLearningManager, normalizePhoneId } from '../services/human-learning.service';
import { logger } from '../utils/logger';

const router = Router();
router.use(authenticate);

// ── GET /sessions ─────────────────────────────────────────────────────────────
router.get('/sessions', async (req, res, next) => {
  try {
    const { businessId } = req.user!;
    const sessions = await prisma.csHumanLearningSession.findMany({
      where: { businessId },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        csPhone: true,
        csName: true,
        status: true,
        linkedAt: true,
        lastSeenAt: true,
        totalPairsCaptured: true,
        totalCsReplies: true,
        totalBuyerMessages: true,
        totalFactsSaved: true,
        totalFactsDiscarded: true,
        totalDocsWritten: true,
        totalClosingDetected: true,
        totalLostDetected: true,
        intentStats: true,
        qrCode: true,
        qrExpiresAt: true,
        createdAt: true,
      },
    });

    // Enrichment: status real-time dari in-memory manager (lebih akurat dari DB)
    // + `linkedPhone`: nomor yang SUNGGUH menscan QR, dibaca dari creds.json.
    //   Bisa berbeda dari `csPhone` yang didaftarkan — Baileys menautkan HP
    //   siapa pun yang menscan. Ditampilkan supaya mismatch tidak lagi tak
    //   terlihat seperti kejadian 2026-07-30.
    // `csReplies`/`buyerMessages` = kolom DB + hitungan Redis yang belum
    // dititipkan. Kolom DB sendiri hanya ditulis tiap ~60 detik, jadi tanpa
    // penjumlahan ini angkanya terlihat mandek padahal pesan terus masuk.
    const enriched = await Promise.all(
      sessions.map(async (s) => {
        const pending = await humanLearningManager.getPendingCounts(s.id);
        return {
          ...s,
          liveStatus: humanLearningManager.getStatus(s.id),
          linkedPhone: humanLearningManager.getLinkedPhone(s.id, s.csPhone),
          csReplies: s.totalCsReplies + pending.cs,
          buyerMessages: s.totalBuyerMessages + pending.buyer,
        };
      })
    );

    res.json({ sessions: enriched });
  } catch (err) {
    next(err);
  }
});

// ── POST /sessions ────────────────────────────────────────────────────────────
router.post('/sessions', async (req, res, next) => {
  try {
    const { businessId } = req.user!;
    const { csPhone, csName } = req.body as { csPhone?: string; csName?: string };

    if (!csPhone || !csName) throw new AppError(400, 'csPhone dan csName wajib diisi');

    // Normalisasi nomor. Lihat normalizePhoneId() — versi lama hanya menambah
    // '62' kalau nomor diawali '0', sehingga `85134245850` lolos apa adanya dan
    // membuat folder sesi terpisah untuk orang yang sama.
    const norm = normalizePhoneId(csPhone);
    if ('error' in norm) throw new AppError(400, norm.error);
    const normalized = norm.phone;

    // Cek batas: maksimal 6 CS per business
    const count = await prisma.csHumanLearningSession.count({ where: { businessId } });
    if (count >= 6) throw new AppError(400, 'Maksimal 6 sesi CS per akun');

    const session = await prisma.csHumanLearningSession.upsert({
      where: { businessId_csPhone: { businessId, csPhone: normalized } },
      create: { businessId, csPhone: normalized, csName, status: 'DISCONNECTED' },
      update: { csName },
    });

    res.status(201).json({ session });
  } catch (err) {
    next(err);
  }
});

// ── GET /sessions/:id/qr ──────────────────────────────────────────────────────
router.get('/sessions/:id/qr', async (req, res, next) => {
  try {
    const { businessId } = req.user!;
    const { id } = req.params;

    const session = await prisma.csHumanLearningSession.findFirst({
      where: { id, businessId },
    });
    if (!session) throw new AppError(404, 'Sesi tidak ditemukan');

    // Sudah benar-benar tersambung → tidak ada QR yang perlu ditampilkan.
    const live = humanLearningManager.getStatus(id);
    if (live === 'CONNECTED') {
      return res.json({ status: 'CONNECTED', qrCode: null, qrExpiresAt: null });
    }

    // QR yang masih berlaku → kembalikan langsung, jangan sentuh socket.
    if (session.qrCode && session.qrExpiresAt && session.qrExpiresAt > new Date()) {
      return res.json({
        status: 'CONNECTING',
        qrCode: session.qrCode,
        qrExpiresAt: session.qrExpiresAt,
      });
    }

    // ── Belum ada QR yang berlaku ────────────────────────────────────────────
    // JANGAN menunggu QR di dalam request ini. Untuk sesi baru, Baileys perlu
    // 10-15 detik menulis ribuan berkas PreKey sebelum kejadian QR pertama
    // dipancarkan. Menahan request selama itu:
    //   (a) memegang flag `connecting` di manager, sehingga permintaan QR
    //       berikutnya — di dev dipicu otomatis oleh StrictMode React, tanpa
    //       perlu diklik manusia — mendapat `undefined` dari connect(), dan
    //   (b) dulu `undefined` itu diterjemahkan di sini menjadi
    //       `status: 'CONNECTED'`, yang membuat frontend memanggil
    //       onConnected() lalu MENUTUP modal seketika. Inilah "modal langsung
    //       kosong/blank" yang dilaporkan, sementara badge tetap
    //       "Menghubungkan..." karena socket-nya memang belum terautentikasi.
    //
    // Sekarang: mulai di latar belakang, balas 202 apa adanya. QR menyusul
    // ke DB dan diambil frontend lewat polling GET /status.
    logger.info(`[HL] Memastikan connect untuk CS ${session.csPhone} (diminta via QR endpoint)`);
    const state = await humanLearningManager.ensureConnecting(id);

    if (state === 'CONNECTED') {
      return res.json({ status: 'CONNECTED', qrCode: null, qrExpiresAt: null });
    }

    // 202 Accepted — permintaan diterima, QR belum siap. Bukan galat.
    return res.status(202).json({ status: 'PENDING', qrCode: null, qrExpiresAt: null });
  } catch (err) {
    next(err);
  }
});

// ── GET /sessions/:id/status ──────────────────────────────────────────────────
router.get('/sessions/:id/status', async (req, res, next) => {
  try {
    const { businessId } = req.user!;
    const { id } = req.params;

    const session = await prisma.csHumanLearningSession.findFirst({
      where: { id, businessId },
      select: {
        id: true, status: true, linkedAt: true, lastSeenAt: true,
        totalPairsCaptured: true, qrCode: true, qrExpiresAt: true,
      },
    });
    if (!session) throw new AppError(404, 'Sesi tidak ditemukan');

    res.json({
      ...session,
      liveStatus: humanLearningManager.getStatus(id),
    });
  } catch (err) {
    next(err);
  }
});

// ── DELETE /sessions/:id ──────────────────────────────────────────────────────
router.delete('/sessions/:id', async (req, res, next) => {
  try {
    const { businessId } = req.user!;
    const { id } = req.params;

    const session = await prisma.csHumanLearningSession.findFirst({ where: { id, businessId } });
    if (!session) throw new AppError(404, 'Sesi tidak ditemukan');

    await humanLearningManager.disconnect(id);
    await prisma.csHumanLearningSession.delete({ where: { id } });

    res.json({ ok: true, message: `Sesi CS ${session.csPhone} (${session.csName}) dihapus` });
  } catch (err) {
    next(err);
  }
});

// ── POST /sessions/:id/flush ──────────────────────────────────────────────────
router.post('/sessions/:id/flush', async (req, res, next) => {
  try {
    const { businessId } = req.user!;
    const { id } = req.params;

    const session = await prisma.csHumanLearningSession.findFirst({ where: { id, businessId } });
    if (!session) throw new AppError(404, 'Sesi tidak ditemukan');

    // Diganti nama dari `flushIdleBuffers` (Fase 63): nama lamanya bohong — ia
    // tidak pernah memeriksa idle. Sekarang ada fungsi lain yang BENAR-BENAR
    // memeriksa idle (`sweepIdleBuffers`, dipanggil job berulang `hl-idle-flush`),
    // jadi membedakan keduanya lewat nama bukan lagi soal kerapian.
    const hasil = await humanLearningManager.flushAllBuffersForSession(id);
    res.json({
      ok: true,
      flushedBuffers: hasil.dikirim,
      // Dua field ini yang membuat "0 terkirim" bisa dijelaskan, bukan cuma
      // dilaporkan. Sebelum Fase 68 buffer yang terlalu pendek DIHAPUS di sini
      // dan jawabannya tetap `0` — jadi Angga melihat "tidak ada apa-apa"
      // sementara yang sebenarnya terjadi "tiga percakapan baru saja dibuang".
      terlaluPendek: hasil.terlaluPendek,
      ambangMinBaris: hasil.ambangMin,
      message: hasil.dikirim > 0
        ? `${hasil.dikirim} buffer dikirim ke Shadow Mining.`
        : hasil.terlaluPendek > 0
          ? `Tidak ada yang dikirim: ${hasil.terlaluPendek} buffer masih di bawah ${hasil.ambangMin} baris. Semuanya DIBIARKAN, tidak dihapus — akan dikirim sendiri begitu cukup panjang.`
          : 'Tidak ada buffer untuk sesi ini.',
    });
  } catch (err) {
    next(err);
  }
});

// ── GET /sessions/:id/buffers ────────────────────────────────────────────────
// Jendela pantau: apa yang SEDANG tertangkap, sebelum di-flush ke Shadow Mining.
// Sebelum ini tidak ada satu pun cara melihatnya — buffer hanya hidup di Redis
// dan baru muncul setelah diolah jadi fakta, sehingga "capture jalan atau tidak"
// tidak bisa dibedakan dari "belum ada chat masuk".
router.get('/sessions/:id/buffers', async (req, res, next) => {
  try {
    const { businessId } = req.user!;
    const { id } = req.params;

    const session = await prisma.csHumanLearningSession.findFirst({
      where: { id, businessId },
      select: {
        csPhone: true, lastSeenAt: true,
        totalCsReplies: true, totalBuyerMessages: true,
      },
    });
    if (!session) throw new AppError(404, 'Sesi tidak ditemukan');

    const [result, pending] = await Promise.all([
      humanLearningManager.inspectBuffers(businessId, session.csPhone),
      humanLearningManager.getPendingCounts(id),
    ]);
    res.json({
      ...result,
      liveStatus: humanLearningManager.getStatus(id),
      lastSeenAt: session.lastSeenAt,
      csReplies: session.totalCsReplies + pending.cs,
      buyerMessages: session.totalBuyerMessages + pending.buyer,
    });
  } catch (err) {
    next(err);
  }
});

// ── POST /sweep-batch ─────────────────────────────────────────────────────────
// Pemicu batch flush manual (bisa memilih targetDate spesifik misal '2026-08-14' atau 'all')
router.post('/sweep-batch', async (req, res, next) => {
  try {
    const { targetDate } = req.body || {};
    const result = await humanLearningManager.sweepDailyBatch(targetDate);
    res.json({
      ok: true,
      result,
      message: `Batch flush selesai: ${result.dikirim} buffer dikirim ke AI.`,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
