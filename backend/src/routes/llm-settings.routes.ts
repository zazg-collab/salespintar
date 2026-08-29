/**
 * Pengaturan Model per pekerjaan.
 *
 * GET  /llm-settings  — daftar pekerjaan + model yang berlaku + pilihan model
 * PATCH /llm-settings — simpan pilihan (per business). PATCH, bukan PUT:
 *                       mengikuti konvensi repo (auto-learning.routes.ts:262),
 *                       dan `lib/api.ts` di frontend memang tidak punya apiPut.
 * GET  /llm-settings/pemakaian — ringkasan token dari tabel llm_calls
 *
 * Disimpan di `Business.aiConfig.llmModels`, bukan di `.env` dan bukan di
 * variabel proses. Alasannya sama dengan yang membuat `shadowMiningMode`
 * dipindah ke DB (lihat catatan di auto-learning.routes.ts): memutasi objek
 * konfigurasi saat runtime itu hilang saat restart, hanya berlaku di satu
 * instance, dan bocor lintas tenant.
 *
 * Perubahan berlaku tanpa restart — cache override di Redis berumur 60 detik dan
 * dikosongkan segera setelah Simpan. Itu disengaja: restart backend memutus
 * socket WhatsApp, jadi setelan yang butuh restart praktis tidak bisa dicoba-coba.
 */

import { Router, Request, Response, NextFunction } from 'express';
import { prisma } from '../config/prisma';
import { authenticate, authorize } from '../middleware/auth';
import { logger } from '../utils/logger';
import {
  ALL_LLM_JOBS,
  JOB_INFO,
  SUPPORTED_PROVIDERS,
  type LlmJob,
  type OverrideModel,
  bacaOverrideBisnis,
  lupakanOverrideBisnis,
  listAvailableModels,
  resolveModelBerlaku,
} from '../services/llm';

const router = Router();
router.use(authenticate);

// ── GET /llm-settings ─────────────────────────────────────────────────────────
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { businessId } = req.user!;

    const [modelTersedia, override] = await Promise.all([
      listAvailableModels(),
      bacaOverrideBisnis(businessId),
    ]);

    const pekerjaan = await Promise.all(
      ALL_LLM_JOBS.map(async (job) => {
        const { spec, sumber } = await resolveModelBerlaku(job, businessId);
        // Nilai yang AKAN berlaku kalau pilihan di halaman ini dikosongkan.
        // Dikirim supaya opsi "ikut .env" di dropdown bisa MENYEBUTKAN nilainya,
        // bukan menyembunyikannya. Memilih sesuatu yang tidak kelihatan itu
        // sumber ambiguitas — dan kalau nilai tersembunyi itu ternyata lebih
        // mahal, ambiguitasnya jadi mahal juga.
        const dasar = await resolveModelBerlaku(job, null);
        return {
          job,
          ...JOB_INFO[job],
          /** Nilai yang BENAR-BENAR dipakai sekarang. */
          berlaku: spec,
          /** 'bisnis' = dari halaman ini · 'env' = LLM_MODEL_* di .env · 'warisan' = GROQ_MODEL/GROQ_EXTRACTOR_MODEL */
          sumber,
          /** Nilai bawaan dari .env, dan dari baris .env yang mana. */
          nilaiEnv: dasar.spec,
          sumberEnv: dasar.sumber,
          /** Nilai yang tersimpan dari halaman ini. Kosong = ikut .env. */
          pilihan: override[job] ?? '',
        };
      }),
    );

    res.json({ pekerjaan, modelTersedia });
  } catch (err) {
    next(err);
  }
});

// ── PATCH /llm-settings ───────────────────────────────────────────────────────
router.patch('/', authorize('ADMIN'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { businessId } = req.user!;
    const masuk = (req.body?.pilihan ?? {}) as Record<string, unknown>;

    // ── Validasi ─────────────────────────────────────────────────────────────
    // Provider diperiksa KETAT: awalan yang belum diimplementasi akan gagal saat
    // dipakai, dan kegagalan itu akan terjadi di tengah percakapan pelanggan.
    // Lebih baik ditolak di sini.
    //
    // Nama model diperiksa LONGGAR (peringatan, bukan penolakan): daftar model
    // diambil live dari tiap layanan yang kuncinya terisi (Groq, Google) atau
    // dari `HARGA_MODEL` (OpenRouter, gutstore), dan kalau salah satu sumber itu
    // sedang tidak bisa dihubungi, pengaturan tetap harus bisa disimpan. Menolak
    // berdasarkan daftar yang mungkin gagal dimuat berarti membuat halaman ini
    // rusak saat satu layanan sedang bermasalah — justru saat orang paling ingin
    // mengganti model.
    const tersedia = await listAvailableModels();
    const specTersedia = new Set(tersedia.map((m) => m.spec));

    const bersih: OverrideModel = {};
    const peringatan: string[] = [];

    for (const job of ALL_LLM_JOBS) {
      const v = masuk[job];
      if (v === undefined || v === null || v === '') continue; // kosong = ikut env
      if (typeof v !== 'string') {
        res.status(400).json({ error: { message: `Nilai untuk "${job}" harus berupa teks` } });
        return;
      }
      const spec = v.trim();
      if (!spec) continue;

      const provider = spec.includes(':') ? spec.split(':')[0]! : 'groq';
      if (!(SUPPORTED_PROVIDERS as readonly string[]).includes(provider)) {
        res.status(400).json({
          error: {
            message:
              `Provider "${provider}" belum didukung (pekerjaan "${job}"). ` +
              `Yang tersedia: ${SUPPORTED_PROVIDERS.join(', ')}.`,
          },
        });
        return;
      }

      const spesLengkap = spec.includes(':') ? spec : `groq:${spec}`;
      if (!specTersedia.has(spesLengkap)) {
        peringatan.push(
          `"${spesLengkap}" (${job}) tidak ada di daftar model yang terbaca — ` +
          `tetap disimpan, tapi periksa ejaannya.`,
        );
      }
      bersih[job as LlmJob] = spesLengkap;
    }

    // ── Simpan: gabung ke aiConfig, JANGAN timpa seluruh objeknya ────────────
    // `aiConfig` sekarang praktis kosong, tapi menimpanya utuh berarti setiap
    // pengaturan lain yang menumpang di sana ke depan akan hilang diam-diam
    // setiap kali halaman ini disimpan.
    const b = await prisma.business.findUnique({
      where: { id: businessId },
      select: { aiConfig: true },
    });
    const aiConfigLama = (b?.aiConfig ?? {}) as Record<string, unknown>;

    await prisma.business.update({
      where: { id: businessId },
      data: { aiConfig: { ...aiConfigLama, llmModels: bersih } },
    });

    // Kosongkan cache supaya perubahan langsung berlaku, bukan menunggu 60 detik.
    await lupakanOverrideBisnis(businessId);

    const ringkas = Object.entries(bersih).map(([j, m]) => `${j}=${m}`).join(', ') || '(semua ikut env)';
    logger.info(`[LLM] Pengaturan model bisnis ${businessId} disimpan: ${ringkas}`);
    for (const p of peringatan) logger.warn(`[LLM] ${p}`);

    res.json({
      ok: true,
      pilihan: bersih,
      peringatan,
      message: 'Pengaturan model disimpan. Berlaku untuk panggilan berikutnya, tanpa restart.',
    });
  } catch (err) {
    next(err);
  }
});

// ── GET /llm-settings/pemakaian ────────────────────────────────────────────────
// Ringkasan token per pekerjaan. Inilah angka yang seharusnya dipakai untuk
// memutuskan pekerjaan mana yang layak model mahal — bukan taksiran.
router.get('/pemakaian', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { businessId } = req.user!;
    const hari = Math.min(90, Math.max(1, Number(req.query['hari'] ?? 7) || 7));
    const sejak = new Date(Date.now() - hari * 24 * 60 * 60 * 1000);

    const baris = await prisma.llmCall.groupBy({
      by: ['job', 'model'],
      where: { businessId, createdAt: { gte: sejak } },
      _count: { _all: true },
      _sum: { promptTokens: true, completionTokens: true, cachedTokens: true },
      _avg: { latencyMs: true },
    });

    const gagal = await prisma.llmCall.groupBy({
      by: ['job'],
      where: { businessId, createdAt: { gte: sejak }, ok: false },
      _count: { _all: true },
    });
    const petaGagal = new Map(gagal.map((g) => [g.job, g._count._all]));

    res.json({
      hari,
      // `null` bukan 0: belum ada data itu keadaan yang berbeda dari nol pemakaian,
      // dan membedakannya penting — persis pelajaran bug LID (Fase 57), di mana
      // "belum ada chat" dan "semua dibuang" sama-sama menampilkan nol.
      adaData: baris.length > 0,
      baris: baris
        .map((r) => ({
          job: r.job,
          model: r.model,
          panggilan: r._count._all,
          tokenMasuk: r._sum.promptTokens ?? 0,
          tokenKeluar: r._sum.completionTokens ?? 0,
          tokenCached: r._sum.cachedTokens ?? 0,
          latensiRata: Math.round(r._avg.latencyMs ?? 0),
          gagal: petaGagal.get(r.job) ?? 0,
        }))
        .sort((a, b) => b.tokenMasuk + b.tokenKeluar - (a.tokenMasuk + a.tokenKeluar)),
    });
  } catch (err) {
    next(err);
  }
});

export default router;
