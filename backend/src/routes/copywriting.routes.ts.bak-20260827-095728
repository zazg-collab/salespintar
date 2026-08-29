import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '../config/prisma';
import { Prisma } from '@prisma/client';
import { env } from '../config/env';
import { authenticate } from '../middleware/auth';
import { encrypt, decrypt, maskedPreview } from '../services/crypto.service';
import { logger } from '../utils/logger';
import { ValidationError } from '../utils/errors';

/**
 * Proxy tipis ke `metaguard_service` (FastAPI, Python) -- VPS Antigravity ("VPS 45"), endpoint
 * `/v1/copywriting/check` & `/v1/copywriting/generate` (blueprint
 * `20260826-blueprint-videoguard-media-analysis-copywriting.md` Bagian 5). Pola file ini SENGAJA
 * dicontek persis dari `video-guard.routes.ts` (helper `metaguardHeaders`/`requireMetaguardUrl`
 * diduplikasi kecil di sini, bukan di-import -- keduanya tidak di-export dari video-guard.routes.ts,
 * dan menambah export baru ke file production-critical itu demi fitur terpisah scope-nya dianggap
 * risiko yang tidak perlu diambil untuk beberapa fungsi pendek).
 *
 * Beda dari `/video-guard/audit`: 2 endpoint check/generate di sini SYNCHRONOUS (bukan submit+poll
 * job) -- `metaguard_service` sendiri sudah didesain synchronous utk fitur ini (blueprint Bagian
 * 5.4, teks doang lewat LLM, skip semua pipeline video/media) -- jadi proxy Node ini juga tinggal
 * forward-dan-tunggu, TIDAK ada tabel Prisma/status polling utk fitur ini (beda dari `VideoAdAudit`
 * yang menyimpan histori audit video -- Copywriting Ads stateless per Bagian 5, hasil cek/generate
 * tidak dipersist, murni request-response).
 *
 * [2026-08-26, Fase provider-agnostic] Sebelumnya modul ini HANYA meneruskan Gemini API key
 * (Business.settings.metaGuardGeminiApiKeyEncrypted, SATU kolom dipakai bersama dgn Video Guard).
 * Sekarang mendukung 4 provider LLM (agy/google/openai/openrouter) KHUSUS fitur Copywriting Ads --
 * pipeline audit video Video Guard TIDAK disentuh sama sekali. Setting provider/key/model baru
 * disimpan di kolom TERPISAH (`copywritingLlmProvider`/`copywritingLlmApiKeyEncrypted`/
 * `copywritingLlmModel`) -- provider `google` tanpa key sendiri di kolom baru ini otomatis fallback
 * ke `metaGuardGeminiApiKeyEncrypted` yang sudah ada (lihat `resolveCopywritingLlmConfig` di bawah).
 *
 * [2026-08-26, koreksi lanjutan] Ternyata Batch E (Check Ads + Generate Ads OTOMATIS tiap audit,
 * lihat metaguard_service main.py `_run_audit_job`) diam-diam memakai provider `google` (API key
 * per-business) tiap kali audit jalan -- itu yang menghabiskan kuota free-tier Gemini API key
 * (20 request/hari) dengan cepat, BUKAN audit videonya sendiri (yang sudah pakai `agy`/kuota Google
 * AI Pro subscription lewat AgyCliInvoker, sama sekali tidak menyentuh API key 20/hari itu). Default
 * provider DIGANTI ke `agy` (bukan `google` lagi) -- provider ini TIDAK butuh API key APAPUN dari
 * business (pakai kredensial api-bridge yang sama dgn Video Guard, pool "copywriting-ads" TERPISAH
 * dari pool "video-guard" biar tidak antre di belakang audit video yang bisa sampai 10 menit).
 * `google`/`openai`/`openrouter` TETAP tersedia sbg pilihan manual di halaman Pengaturan (utk yang
 * sengaja mau pilih provider/model tertentu), tapi bukan default lagi.
 *
 * Business logic AI SAMA SEKALI TIDAK ADA di sini -- sama seperti video-guard.routes.ts: (1) auth
 * JWT + resolve businessId, (2) resolve provider/key/model per-business dari Business.settings, (3)
 * forward ke metaguard_service lewat header `X-Llm-Provider`/`X-Llm-Api-Key`/`X-Llm-Model` (header
 * lama `X-Gemini-Api-Key` TIDAK dikirim lagi dari sisi sini -- metaguard_service tetap menerimanya
 * sbg fallback kompatibilitas kalau dipanggil dari jalur lain, tapi proxy Node ini sekarang SELALU
 * pakai header baru), (4) balikin hasilnya apa adanya ke frontend.
 */

const router = Router();
router.use(authenticate);

// Panggilan LLM synchronous bisa makan waktu lebih lama drpd submit/poll job ringan video-guard
// (METAGUARD_TIMEOUT_MS 15s di sana) -- kasih ruang lebih longgar di sini krn request ini BLOCKING
// sampai LLM benar-benar selesai jawab (bukan async job spt /v1/audit). [2026-08-26] Dinaikkan dari
// 60s -- provider `agy` (default baru) bisa makan waktu s/d 120s per percobaan + retry tenacity 2x
// di sisi metaguard_service (_call_agy_structured), jadi 60s terlalu pendek dan akan abort di tengah
// jalan. nginx proxy_read_timeout di host sudah 600s utk /api, jadi aman dinaikkan ke sini.
const COPYWRITING_TIMEOUT_MS = 260_000;

type CopywritingLlmProvider = 'agy' | 'google' | 'openai' | 'openrouter';

const KNOWN_PROVIDERS: CopywritingLlmProvider[] = ['agy', 'google', 'openai', 'openrouter'];

function metaguardHeaders(extra?: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = { ...extra };
  if (env.METAGUARD_INTERNAL_API_KEY) {
    headers['X-Internal-Api-Key'] = env.METAGUARD_INTERNAL_API_KEY;
  }
  return headers;
}

function requireMetaguardUrl(): string {
  if (!env.METAGUARD_SERVICE_URL) {
    throw new ValidationError(
      'METAGUARD_SERVICE_URL belum diset di .env backend -- fitur Copywriting Ads belum aktif.',
    );
  }
  return env.METAGUARD_SERVICE_URL;
}

interface CopywritingLlmConfig {
  provider: CopywritingLlmProvider;
  apiKey: string | null;
  model: string | null;
  usingLegacyGeminiKeyFallback: boolean;
}

/** Resolve provider/API key/model Copywriting Ads per-business. Default (tidak diset sama sekali) =
 *  `agy` -- TIDAK butuh API key dari business, pakai kredensial api-bridge yang sama dgn Video Guard
 *  (lihat docstring file di atas). Provider `google` TANPA key sendiri di `copywritingLlmApiKeyEncrypted`
 *  otomatis fallback ke `metaGuardGeminiApiKeyEncrypted` (kolom Video Guard yang sudah ada). Provider
 *  `openai`/`openrouter` TIDAK punya fallback apa pun -- wajib diisi sendiri di setting Copywriting
 *  Ads. */
async function resolveCopywritingLlmConfig(businessId: string): Promise<CopywritingLlmConfig> {
  const business = await prisma.business.findUnique({
    where: { id: businessId },
    select: { settings: true },
  });
  const settings = (business?.settings as Record<string, unknown>) ?? {};

  const rawProvider = settings.copywritingLlmProvider;
  const provider: CopywritingLlmProvider =
    rawProvider === 'google' || rawProvider === 'openai' || rawProvider === 'openrouter'
      ? rawProvider
      : 'agy';

  const model =
    typeof settings.copywritingLlmModel === 'string' && settings.copywritingLlmModel.trim()
      ? settings.copywritingLlmModel.trim()
      : null;

  let apiKey: string | null = null;
  const encrypted = settings.copywritingLlmApiKeyEncrypted;
  if (typeof encrypted === 'string' && encrypted) {
    try {
      apiKey = decrypt(encrypted);
    } catch (e) {
      logger.warn(
        `[CopywritingAds] Gagal decrypt copywritingLlmApiKeyEncrypted business ${businessId}: ${(e as Error).message}`,
      );
    }
  }

  let usingLegacyGeminiKeyFallback = false;
  if (provider === 'google' && !apiKey) {
    const legacyEncrypted = settings.metaGuardGeminiApiKeyEncrypted;
    if (typeof legacyEncrypted === 'string' && legacyEncrypted) {
      try {
        apiKey = decrypt(legacyEncrypted);
        usingLegacyGeminiKeyFallback = true;
      } catch (e) {
        logger.warn(
          `[CopywritingAds] Gagal decrypt metaGuardGeminiApiKeyEncrypted (fallback) business ${businessId}: ${(e as Error).message}`,
        );
      }
    }
  }

  return { provider, apiKey, model, usingLegacyGeminiKeyFallback };
}

function llmHeaders(config: CopywritingLlmConfig, extra?: Record<string, string>): Record<string, string> {
  return metaguardHeaders({
    ...extra,
    'X-Llm-Provider': config.provider,
    ...(config.apiKey ? { 'X-Llm-Api-Key': config.apiKey } : {}),
    ...(config.model ? { 'X-Llm-Model': config.model } : {}),
  });
}

// ══════════════════════════════════════════════════════════════════════════
// GET/PUT /copywriting-ads/settings — provider/API key/model LLM khusus Copywriting Ads
// Pola sama persis dengan GET/PUT /video-guard/settings: TIDAK PERNAH balikin key mentah/
// terenkripsi, cuma boolean "configured" + preview tersamar.
// ══════════════════════════════════════════════════════════════════════════

router.get('/settings', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const businessId = req.user!.businessId;
    const business = await prisma.business.findUnique({ where: { id: businessId }, select: { settings: true } });
    const settings = (business?.settings as Record<string, unknown>) ?? {};

    const rawProvider = settings.copywritingLlmProvider;
    const provider: CopywritingLlmProvider =
      rawProvider === 'google' || rawProvider === 'openai' || rawProvider === 'openrouter'
        ? rawProvider
        : 'agy';

    const encrypted = settings.copywritingLlmApiKeyEncrypted;
    let preview: string | null = null;
    if (typeof encrypted === 'string' && encrypted) {
      try {
        preview = maskedPreview(decrypt(encrypted));
      } catch (e) {
        logger.warn(`[CopywritingAds] Gagal decrypt utk preview, business ${businessId}: ${(e as Error).message}`);
        preview = '(gagal dibaca, isi ulang key)';
      }
    }

    const legacyEncrypted = settings.metaGuardGeminiApiKeyEncrypted;

    res.json({
      provider,
      apiKeyConfigured: Boolean(encrypted),
      apiKeyPreview: preview,
      model: typeof settings.copywritingLlmModel === 'string' ? settings.copywritingLlmModel : null,
      usingLegacyGeminiKeyFallback: provider === 'google' && !encrypted && Boolean(legacyEncrypted),
    });
  } catch (e) { next(e); }
});

const settingsSchema = z.object({
  provider: z.enum(['agy', 'google', 'openai', 'openrouter']).optional(),
  apiKey: z.string().optional(), // kirim string kosong "" utk hapus, undefined = tidak diubah
  model: z.string().optional(), // kirim string kosong "" utk hapus/pakai default provider
});

router.put('/settings', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const businessId = req.user!.businessId;
    const body = settingsSchema.parse(req.body);

    const business = await prisma.business.findUnique({ where: { id: businessId }, select: { settings: true } });
    const settings = { ...((business?.settings as Record<string, unknown>) ?? {}) };

    if (body.provider !== undefined) {
      settings.copywritingLlmProvider = body.provider;
    }
    if (body.apiKey !== undefined) {
      const trimmed = body.apiKey.trim();
      if (trimmed) settings.copywritingLlmApiKeyEncrypted = encrypt(trimmed);
      else delete settings.copywritingLlmApiKeyEncrypted;
    }
    if (body.model !== undefined) {
      const trimmed = body.model.trim();
      if (trimmed) settings.copywritingLlmModel = trimmed;
      else delete settings.copywritingLlmModel;
    }

    await prisma.business.update({ where: { id: businessId }, data: { settings: settings as Prisma.InputJsonValue } });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ══════════════════════════════════════════════════════════════════════════
// POST /copywriting-ads/check — proxy ke metaguard_service /v1/copywriting/check
// Tab "Check Ads": audit copy iklan yang SUDAH ADA (headline/primary_text) -- bisa dari paste
// manual, atau prefill dari hasil audit Video Guard/Ads Creative (blueprint 5.1 poin 2, frontend
// yang mengisi query param/state, endpoint ini sendiri tidak tahu-menahu soal sumbernya).
// ══════════════════════════════════════════════════════════════════════════

const checkSchema = z.object({
  headline: z.string().optional(),
  primary_text: z.string().optional(),
});

router.post('/check', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const businessId = req.user!.businessId;
    const payload = checkSchema.parse(req.body);

    const llmConfig = await resolveCopywritingLlmConfig(businessId);
    const baseUrl = requireMetaguardUrl();
    const upstream = await fetch(`${baseUrl}/v1/copywriting/check`, {
      method: 'POST',
      headers: llmHeaders(llmConfig, { 'Content-Type': 'application/json' }),
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(COPYWRITING_TIMEOUT_MS),
    });
    const data = await upstream.json();
    if (!upstream.ok) {
      logger.warn(`[CopywritingAds] metaguard_service /v1/copywriting/check menolak: ${upstream.status} ${JSON.stringify(data)}`);
    }
    res.status(upstream.status).json(data);
  } catch (e) { next(e); }
});

// ══════════════════════════════════════════════════════════════════════════
// POST /copywriting-ads/generate — proxy ke metaguard_service /v1/copywriting/generate
// Tab "Generate Ads": keyword/produk (+ opsional URL kompetitor) -> 3 angle x platform.
// ══════════════════════════════════════════════════════════════════════════

const generateSchema = z.object({
  product_or_keyword: z.string().min(1, 'product_or_keyword wajib diisi'),
  competitor_url: z.string().optional(),
  extra_context: z.string().optional(),
});

router.post('/generate', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const businessId = req.user!.businessId;
    const payload = generateSchema.parse(req.body);

    const llmConfig = await resolveCopywritingLlmConfig(businessId);
    const baseUrl = requireMetaguardUrl();
    const upstream = await fetch(`${baseUrl}/v1/copywriting/generate`, {
      method: 'POST',
      headers: llmHeaders(llmConfig, { 'Content-Type': 'application/json' }),
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(COPYWRITING_TIMEOUT_MS),
    });
    const data = await upstream.json();
    if (!upstream.ok) {
      logger.warn(`[CopywritingAds] metaguard_service /v1/copywriting/generate menolak: ${upstream.status} ${JSON.stringify(data)}`);
    }
    res.status(upstream.status).json(data);
  } catch (e) { next(e); }
});

export default router;
