import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '../config/prisma';
import { authenticate } from '../middleware/auth';
import { decrypt } from '../services/crypto.service';
import { logger } from '../utils/logger';
import { ValidationError, AppError } from '../utils/errors';

/**
 * [2026-08-27, fitur multi-provider LLM Video Guard] Proxy tipis ke endpoint "list model" milik
 * tiap provider LLM yang didukung fitur Video Guard/Copywriting Ads (agy/google/openai/openrouter/
 * groq) -- dipakai halaman Pengaturan supaya dropdown model TERISI OTOMATIS begitu provider dipilih,
 * bukan lagi kolom teks manual yang harus diketik sendiri namanya.
 *
 * SENGAJA file terpisah (bukan ditambahkan ke copywriting.routes.ts/video-guard.routes.ts) --
 * dipakai BERSAMA oleh 3 slot config (Check Ads/Generate Ads/fallback Video Audit), jadi lebih
 * masuk akal berdiri sendiri drpd nebeng salah satu file yang scope-nya sebenarnya spesifik ke
 * satu fitur.
 *
 * Endpoint ini SENGAJA POST (bukan GET) -- body membawa API key mentah (kalau user baru ngetik,
 * belum di-save) supaya bisa preview daftar model SEBELUM key itu disimpan. Key TIDAK PERNAH lewat
 * query string (aturan privasi sesi ini -- data sensitif tidak boleh nyangkut di access log server/
 * proxy). Kalau `apiKey` tidak dikirim tapi `slot` disebut, key yang SUDAH tersimpan (terenkripsi)
 * utk slot itu didekripsi di server dan dipakai -- key mentahnya TETAP TIDAK PERNAH balik ke
 * frontend.
 *
 * `openrouter` PUBLIK (endpoint list model-nya tidak butuh API key sama sekali) -- provider lain
 * (google/openai/groq) WAJIB ada key (baru ATAU tersimpan) sebelum bisa list model, krn endpoint
 * list-nya sendiri butuh Authorization.
 */

const router = Router();
router.use(authenticate);

type Provider = 'agy' | 'google' | 'openai' | 'openrouter' | 'groq';
type Slot = 'checkAds' | 'generateAds' | 'videoAuditFallback';

// Field per-slot di Business.settings -- HARUS tetap sinkron dengan fieldNames() di
// copywriting.routes.ts (checkAds/generateAds) dan video-guard.routes.ts (videoAuditFallback,
// menyusul di fase berikutnya). Duplikasi kecil ini sengaja (lihat docstring file, pola yang sama
// dipakai copywriting.routes.ts vs video-guard.routes.ts utk metaguardHeaders/requireMetaguardUrl).
function slotFieldNames(slot: Slot) {
  const prefix = slot === 'checkAds' ? 'checkAds' : slot === 'generateAds' ? 'generateAds' : 'videoAuditFallback';
  return { provider: `${prefix}LlmProvider`, apiKey: `${prefix}LlmApiKeyEncrypted` };
}

async function resolveSavedKey(businessId: string, slot: Slot, provider: Provider): Promise<string | null> {
  const business = await prisma.business.findUnique({ where: { id: businessId }, select: { settings: true } });
  const settings = (business?.settings as Record<string, unknown>) ?? {};
  const fields = slotFieldNames(slot);
  const perSlot = settings[fields.apiKey];
  // Fallback ke key SHARED lama (copywritingLlmApiKeyEncrypted) khusus slot Check/Generate Ads --
  // sama persis logika backward-compat di resolveCopywritingLlmConfig(), supaya preview model
  // konsisten dgn key yang BENERAN dipakai saat request check/generate sesungguhnya jalan.
  const shared = slot !== 'videoAuditFallback' ? settings.copywritingLlmProvider && settings.copywritingLlmApiKeyEncrypted : null;
  const encrypted =
    typeof perSlot === 'string' && perSlot
      ? perSlot
      : typeof shared === 'string' && shared
      ? shared
      : provider === 'google'
      ? settings.metaGuardGeminiApiKeyEncrypted
      : null;
  if (typeof encrypted !== 'string' || !encrypted) return null;
  try {
    return decrypt(encrypted);
  } catch (e) {
    logger.warn(`[LlmModels] Gagal decrypt key tersimpan (slot=${slot}) business ${businessId}: ${(e as Error).message}`);
    return null;
  }
}

interface ModelEntry {
  id: string;
  label?: string;
  supportsVideo?: boolean;
}

// Filter model non-teks (transkripsi/TTS/moderasi/image-gen) yang tidak berguna utk Check/Generate
// Ads maupun fallback Video Audit -- dropdown akan menyesatkan kalau ini ikut ditawarkan. Pola regex
// SAMA dgn yang sudah dipakai fitur AI Ads lain (src/services/llm.ts) biar konsisten.
const IRRELEVANT_MODEL_RE = /whisper|tts|guard|playai|embedding|moderation|dall-e|davinci|babbage|ada-/i;

async function listOpenRouterModels(): Promise<ModelEntry[]> {
  const resp = await fetch('https://openrouter.ai/api/v1/models', { signal: AbortSignal.timeout(15_000) });
  if (!resp.ok) throw new Error(`OpenRouter /models HTTP ${resp.status}`);
  const data = (await resp.json()) as { data?: Array<{ id: string; name?: string; architecture?: { input_modalities?: string[] } }> };
  return (data.data ?? [])
    .filter((m) => !IRRELEVANT_MODEL_RE.test(m.id))
    .map((m) => ({ id: m.id, label: m.name, supportsVideo: Boolean(m.architecture?.input_modalities?.includes('video')) }));
}

async function listOpenAiCompatModels(baseUrl: string, apiKey: string, taggedVideoIfGemini: boolean): Promise<ModelEntry[]> {
  const resp = await fetch(`${baseUrl}/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) throw new Error(`${baseUrl}/models HTTP ${resp.status}`);
  const data = (await resp.json()) as { data?: Array<{ id: string }> };
  return (data.data ?? [])
    .map((m) => ({ id: m.id.replace(/^models\//, '') }))
    .filter((m) => !IRRELEVANT_MODEL_RE.test(m.id))
    // fix v1.8.0: heuristik SEDERHANA (bukan live capability check) -- model keluarga Gemini
    // ("gemini" di namanya, bukan varian embedding/image) DIANGGAP bisa video krn API Google
    // native-nya memang begitu. Provider lain (OpenAI/Groq) TIDAK PERNAH ditandai video-capable --
    // dikonfirmasi (2026-08-27) OpenAI belum ada native video input, Groq cuma vision/image.
    .map((m) => ({ ...m, supportsVideo: taggedVideoIfGemini && /gemini/i.test(m.id) }));
}

async function listModelsForProvider(provider: Provider, apiKey: string | null): Promise<ModelEntry[]> {
  if (provider === 'agy') return []; // agy tidak punya konsep model yang bisa dipilih dari sini.
  if (provider === 'openrouter') return listOpenRouterModels(); // publik, apiKey diabaikan kalau ada.
  if (!apiKey) {
    throw new ValidationError(`API key wajib diisi (atau sudah tersimpan) utk provider '${provider}' sebelum bisa lihat daftar model.`);
  }
  if (provider === 'google') return listOpenAiCompatModels('https://generativelanguage.googleapis.com/v1beta/openai', apiKey, true);
  if (provider === 'openai') return listOpenAiCompatModels('https://api.openai.com/v1', apiKey, false);
  if (provider === 'groq') return listOpenAiCompatModels('https://api.groq.com/openai/v1', apiKey, false);
  return [];
}

const listSchema = z.object({
  provider: z.enum(['agy', 'google', 'openai', 'openrouter', 'groq']),
  apiKey: z.string().optional(),
  slot: z.enum(['checkAds', 'generateAds', 'videoAuditFallback']).optional(),
});

router.post('/list', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const businessId = req.user!.businessId;
    const body = listSchema.parse(req.body);

    let apiKey: string | null = body.apiKey?.trim() || null;
    if (!apiKey && body.slot) {
      apiKey = await resolveSavedKey(businessId, body.slot, body.provider);
    }

    const models = await listModelsForProvider(body.provider, apiKey);
    res.json({ models });
  } catch (e) {
    if (e instanceof AppError) {
      next(e);
      return;
    }
    const err = e as Error;
    logger.warn(`[LlmModels] Gagal ambil daftar model: ${err.message}`);
    next(new AppError(502, `Gagal mengambil daftar model dari provider: ${err.message}`));
  }
});

export default router;
