import crypto from 'crypto';
import { prisma } from '../config/prisma';
import { logger } from '../utils/logger';
import { decrypt } from './crypto.service';
import { capiQueue, CapiJobData, CapiEventName } from '../queues/capi.queue';

// ────────────────────────────────────────────────────────────────────────────────
// CAPI SERVICE — Fase 43 (2026-08-21)
//
// Dua tanggung jawab utama:
//
// 1. sendCapiEvent(jobData) — dipanggil oleh capi.worker.ts:
//    Bangun payload Meta CAPI dan kirim ke Graph API via fetch() native.
//    Lempar error kalau gagal supaya BullMQ bisa retry.
//
// 2. enqueueCapiIfNeeded(params) — dipanggil oleh leads.repository.ts
//    setelah upsertLeadProfile() commit:
//    Tentukan event apa yang perlu dikirim, hindari duplikat via capiEventsSent[],
//    enqueue ke BullMQ, update DB. TIDAK pernah throw — semua error hanya di-log.
//
// Kenapa dipisah dari queue/worker? Service ini punya logika bisnis (gerbang,
// deteksi transisi stage/konversi, dedup) yang perlu di-unit-test tanpa infrastruktur
// Redis/BullMQ. Worker hanya sebagai executor; service adalah "otak"-nya.
// ────────────────────────────────────────────────────────────────────────────────

const GRAPH_API_VERSION = 'v21.0';

// ── Ranking stage untuk deteksi "naik stage" ──
export const STAGE_RANK: Record<string, number> = {
  COLD: 0,
  WARM: 1,
  HOT: 2,
  VERY_HOT: 3,
};

// ── Normalisasi nomor HP ke format E.164 (62xxx) lalu hash SHA-256 ──
// Di-export untuk keperluan unit test.
export function hashPhone(waNumber: string): string {
  // waNumber sudah dalam format "6281234567890" dari sanitizeWaNumber()
  // tapi untuk safety: buang non-digit, pastikan prefix 62
  const digits = waNumber.replace(/\D/g, '');
  const normalized = digits.startsWith('62') ? digits : `62${digits}`;
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

// ── Hash nama (fn/ln) — lowercase + trim sesuai standar Meta ──
export function hashName(name: string): string {
  return crypto.createHash('sha256').update(name.toLowerCase().trim()).digest('hex');
}

// ── Bangun event_id ──
// Lead/ViewContent/AddToCart: deterministik per (leadId, eventName) — aman dikirim ulang,
//   Meta akan dedupe otomatis kalau event_id sama.
// Purchase: unik per instance closing via closingTimestamp — supaya REPEAT_ORDER
//   tidak di-dedupe dengan Purchase pertama.
export function buildEventId(eventName: CapiEventName, leadId: string, closingTimestamp?: string): string {
  if (closingTimestamp) {
    return `${leadId}-${eventName}-${closingTimestamp}`;
  }
  return `${leadId}-${eventName}`;
}

// ── Normalisasi URL untuk pencocokan multi-pixel yang kebal spoofing/variasi format ──
//
// Audit Fase 46 (2026-08-21): fallback path sebelumnya tidak strip ?query dan #hash —
// URL yang gagal parsing lewat new URL() (misal ada karakter aneh dari redirect chain)
// menghasilkan string berbeda dari path normal, sehingga tidak pernah match ke pixel.
export function normalizeUrl(rawUrl: string): string {
  try {
    const url = rawUrl.trim();
    const hasProto = url.startsWith('http://') || url.startsWith('https://');
    const parsed = new URL(hasProto ? url : `https://${url}`);
    // new URL() otomatis strip query string dan hash karena hanya pathname yang diambil
    return (parsed.hostname + parsed.pathname).toLowerCase().replace(/\/+$/, '');
  } catch {
    // Fallback untuk URL malformed: strip protocol, query string, hash, dan trailing slash
    // WAJIB konsisten dengan path normal di atas agar hasilnya bisa dibandingkan
    return rawUrl.trim()
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/[?#].*$/, '')  // strip ?query dan #hash
      .replace(/\/+$/, '');
  }
}


/**
 * Kirim satu event ke Meta Conversions API Graph API.
 * Dipanggil oleh capi.worker.ts — throw error supaya BullMQ bisa retry.
 */
export async function sendCapiEvent(jobData: CapiJobData): Promise<void> {
  const {
    eventName,
    waNumber,
    name,
    ctwaClid,
    pixelId,
    encryptedAccessToken,
    testEventCode,
    wabaId,
    currency,
    value,
    closingTimestamp,
    leadId,
    fbp,
    fbc,
    clientUserAgent,
    clientIp,
    eventSourceUrl,
  } = jobData;

  // Dekripsi access token saat diperlukan saja (lazy — crypto.service sudah punya guard env)
  const accessToken = decrypt(encryptedAccessToken);

  // ── Bangun user_data ──
  const userData: Record<string, string> = {
    ph: hashPhone(waNumber),
  };
  if (fbp) userData.fbp = fbp;
  if (fbc) userData.fbc = fbc;
  if (clientUserAgent) userData.client_user_agent = clientUserAgent;
  if (clientIp) userData.client_ip_address = clientIp;

  // fn/ln opsional — pecah nama kalau ada spasi
  if (name && name.trim()) {
    const parts = name.trim().split(/\s+/);
    userData.fn = hashName(parts[0]);
    if (parts.length > 1) {
      userData.ln = hashName(parts.slice(1).join(' '));
    }
  }

  // ── Pilih action_source berdasar ada/tidaknya ctwaClid ──
  const isCtwa = Boolean(ctwaClid && ctwaClid.trim());
  const actionSource = isCtwa ? 'business_messaging' : 'chat';

  // ── Bangun custom_data ──
  const customData: Record<string, unknown> = {};
  if (eventName === 'Purchase') {
    customData.currency = currency || 'IDR';
    if (value != null && value > 0) {
      customData.value = value;
    } else {
      customData.value = 0;
      logger.warn(
        `[CAPI] Purchase event leadId=${leadId} dikirim dengan value=0 ` +
        `(confirmedCodAmount null/0 — tidak optimal untuk optimasi ROAS)`,
      );
    }
  }

  // ── Bangun payload event ──
  const eventPayload: Record<string, unknown> = {
    event_name: eventName,
    event_time: Math.floor(Date.now() / 1000),
    event_id: buildEventId(eventName, leadId, closingTimestamp),
    action_source: actionSource,
    user_data: userData,
  };
  
  if (eventSourceUrl) {
    eventPayload.event_source_url = eventSourceUrl;
  }

  if (isCtwa) {
    // business_messaging butuh messaging_channel + ctwa_clid; wabaId opsional
    eventPayload.messaging_channel = 'whatsapp';
    if (ctwaClid) eventPayload.ctwa_clid = ctwaClid;
    if (wabaId && wabaId.trim()) {
      eventPayload.whatsapp_business_account_id = wabaId;
    }
  }

  if (Object.keys(customData).length > 0) {
    eventPayload.custom_data = customData;
  }

  // ── Kirim ke Graph API ──
  const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${encodeURIComponent(pixelId)}/events`;
  const body: Record<string, unknown> = {
    data: [eventPayload],
    access_token: accessToken,
  };
  if (testEventCode && testEventCode.trim()) {
    body.test_event_code = testEventCode.trim();
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const responseText = await res.text();

  if (!res.ok) {
    // Throw supaya BullMQ bisa retry dengan backoff eksponensial
    throw new Error(
      `[CAPI] Graph API HTTP ${res.status} untuk event ${eventName} leadId=${leadId}: ${responseText}`,
    );
  }

  logger.info(
    `[CAPI] Event ${eventName} terkirim — leadId=${leadId} pixel=${pixelId} ` +
    `action_source=${actionSource}${testEventCode ? ' [TEST]' : ''}`,
  );
}

// ── Parameter untuk enqueueCapiIfNeeded ──
export interface CapiHookParams {
  businessId: string;
  leadId: string;
  waNumber: string;
  name?: string | null;
  ctwaClid?: string | null;
  finalLeadCategory: string | null | undefined;
  finalStage: string;
  prevStage: string;
  atomicConversion: string;
  prevConversion: string;
  capiEventsSent: string[];
  confirmedCodAmount?: number | null;
  /** true = baris lead baru saja dibuat (dari path upsert create); false = update existing */
  isNewLead: boolean;
}

export const DEFAULT_EVENT_MAP = {
  NEW_LEAD: 'ViewContent',
  WARM: 'Lead',
  HOT: 'AddToCart',
  CLOSING: 'Purchase'
};

/**
 * Tentukan event CAPI yang perlu dikirim, lalu enqueue ke BullMQ.
 * Dipanggil oleh leads.repository.ts::upsertLeadProfile() SETELAH transaksi commit.
 *
 * TIDAK PERNAH throw — semua kegagalan hanya di-log supaya tidak pernah
 * memblokir atau membuat gagal pipeline leads.
 */
export async function enqueueCapiIfNeeded(params: CapiHookParams): Promise<void> {
  try {
    const {
      businessId,
      leadId,
      waNumber,
      name,
      ctwaClid,
      finalLeadCategory,
      finalStage,
      prevStage,
      atomicConversion,
      prevConversion,
      capiEventsSent,
      confirmedCodAmount,
      isNewLead,
    } = params;

    // ── GERBANG 2: Cek kategori lead — hanya PROSPEK_IKLAN yang dikirim ──
    if (finalLeadCategory !== 'PROSPEK_IKLAN') return;

    // ── GERBANG 1: Cek konfigurasi CAPI dari business ──
    const business = await prisma.business.findUnique({
      where: { id: businessId },
      select: {
        metaCapiEnabled: true,
        metaCapiPixelId: true,
        metaCapiAccessToken: true,
        metaCapiTestEventCode: true,
        metaCapiWabaId: true,
        metaCapiCurrency: true,
        metaCapiEventMap: true,
      },
    });

    if (
      !business?.metaCapiEnabled ||
      !business.metaCapiAccessToken ||
      !business.metaCapiPixelId
    ) {
      return;
    }

    // Ambil data terbaru lead (termasuk atribusi fbp/fbc setelah di-match oleh leads.repository.ts)
    // Fix #6 (Fase 47): hapus (prisma as any) — field fbp/fbc/eventSourceUrl/metaCapiPixelId
    // sudah confirmed ada di schema Lead (audit schema 2026-08-21)
    const leadRecord = await prisma.lead.findUnique({
      where: { id: leadId },
      select: { fbp: true, fbc: true, clientUserAgent: true, clientIp: true, eventSourceUrl: true }
    });

    let targetPixelId = business.metaCapiPixelId;
    let targetEncryptedAccessToken = business.metaCapiAccessToken;

    // Multi-Pixel Dynamic Routing via URL (Longest Match First)
    if (leadRecord?.eventSourceUrl) {
      try {
        const cleanIncomingUrl = normalizeUrl(leadRecord.eventSourceUrl);

        // Fix #7 (Fase 47): cache pixel config di Redis — query ini jalan setiap interaksi
        // lead (tiap pesan WA masuk), padahal config pixel hampir tidak pernah berubah.
        // TTL 60 detik: perubahan config berlaku max 60 detik kemudian, acceptable trade-off.
        //
        // Fix #7b (Fase 47 patch): Redis diakses dalam try/catch tersendiri (bukan outer) —
        // kalau Redis down, JANGAN crash ke outer catch yang akan membuang seluruh routing
        // dan fallback ke default pixel. Sebaliknya, gracefully fallback ke DB query.
        const PIXEL_CACHE_KEY = `salespintar:capi:pixels:${businessId}`;
        const PIXEL_CACHE_TTL = 60; // detik

        let customPixels: Array<{ id: string; pixelId: string; accessToken: string; landingPageUrls: string[] }> | null = null;

        try {
          const { redisCache } = await import('../config/redis');
          const cached = await redisCache.get(PIXEL_CACHE_KEY);
          if (cached) {
            customPixels = JSON.parse(cached);
          } else {
            // Fix #6: hapus (prisma as any) — MetaPixelConfig sudah confirmed ada di schema
            customPixels = await prisma.metaPixelConfig.findMany({
              where: { businessId, isActive: true },
              select: { id: true, pixelId: true, accessToken: true, landingPageUrls: true },
            });
            // Best-effort cache set — kalau gagal, tidak apa-apa (next request hit DB lagi)
            redisCache.set(PIXEL_CACHE_KEY, JSON.stringify(customPixels), 'EX', PIXEL_CACHE_TTL).catch(
              (e) => logger.warn(`[CAPI] Gagal set pixel cache: ${e}`)
            );
          }
        } catch (redisErr) {
          // Redis down atau parse error — fallback ke DB query langsung
          logger.warn(`[CAPI] Redis pixel cache error, fallback ke DB: ${redisErr}`);
          customPixels = await prisma.metaPixelConfig.findMany({
            where: { businessId, isActive: true },
            select: { id: true, pixelId: true, accessToken: true, landingPageUrls: true },
          });
        }

        // customPixels bisa null hanya kalau SEMUA path (Redis + DB fallback) gagal — tidak mungkin
        // dalam praktik, tapi TypeScript perlu guard eksplisit karena tipe nullable
        if (!customPixels) {
          logger.warn('[CAPI] Tidak bisa ambil pixel config dari Redis maupun DB, skip routing');
        } else {
          type PixelRow = { id: string; pixelId: string; accessToken: string; landingPageUrls: string[] };
          let bestMatchedPixel: PixelRow | null = null;
          let longestMatchLength = -1;

          for (const pixel of customPixels) {
            const urls: string[] = Array.isArray(pixel.landingPageUrls) ? pixel.landingPageUrls : [];
            for (const rawConfigUrl of urls) {
              const cleanConfigUrl = normalizeUrl(rawConfigUrl);
              // Audit Fase 46: hapus cleanIncomingUrl.includes(cleanConfigUrl) karena menyebabkan
              // false-positive lintas domain (misal config 'toko.com' bisa match lead dari 'tokobagus.com')
              // dan false-positive lintas path (config '/sepatu' match URL '/sepatu-anak').
              // Hanya 2 kondisi yang aman:
              //   1. Exact match: URL persis sama
              //   2. Prefix path: incoming adalah sub-path dari config (diawali configUrl + '/')
              if (cleanConfigUrl && (
                cleanIncomingUrl === cleanConfigUrl ||
                cleanIncomingUrl.startsWith(cleanConfigUrl + '/')
              )) {
                if (cleanConfigUrl.length > longestMatchLength) {
                  longestMatchLength = cleanConfigUrl.length;
                  bestMatchedPixel = pixel;
                }
              }
            }
          }

          if (bestMatchedPixel && bestMatchedPixel.pixelId && bestMatchedPixel.accessToken) {
            targetPixelId = bestMatchedPixel.pixelId;
            targetEncryptedAccessToken = bestMatchedPixel.accessToken;
            // Rekam jejak pixel ID ke Lead — Fix #6: hapus (prisma as any)
            prisma.lead.update({
              where: { id: leadId },
              data: { metaCapiPixelId: targetPixelId },
            }).catch((e) => logger.warn(`[CAPI] Gagal update lead.metaCapiPixelId: ${e}`));
          }
        }
      } catch (err) {
        logger.warn(`[CAPI] Gagal multi-pixel lookup, fallback ke default: ${err}`);
      }
    }

    // ── Bangun base job data (tanpa eventName/value/closingTimestamp) ──
    const baseJobData: Omit<CapiJobData, 'eventName' | 'value' | 'closingTimestamp'> = {
      businessId,
      leadId,
      waNumber,
      name,
      ctwaClid,
      pixelId: targetPixelId,
      encryptedAccessToken: targetEncryptedAccessToken,
      testEventCode: business.metaCapiTestEventCode,
      wabaId: business.metaCapiWabaId,
      currency: business.metaCapiCurrency || 'IDR',
      fbp: leadRecord?.fbp,
      fbc: leadRecord?.fbc,
      clientUserAgent: leadRecord?.clientUserAgent,
      clientIp: leadRecord?.clientIp,
      eventSourceUrl: leadRecord?.eventSourceUrl,
    };

    const eventMap: any = (business.metaCapiEventMap && typeof business.metaCapiEventMap === 'object') 
      ? business.metaCapiEventMap 
      : DEFAULT_EVENT_MAP;
    
    const evNewLead = eventMap.NEW_LEAD || DEFAULT_EVENT_MAP.NEW_LEAD;
    const evWarm = eventMap.WARM || DEFAULT_EVENT_MAP.WARM;
    const evHot = eventMap.HOT || DEFAULT_EVENT_MAP.HOT;
    const evClosing = eventMap.CLOSING || DEFAULT_EVENT_MAP.CLOSING;

    const eventsToSend: CapiEventName[] = [];
    // Track event one-time yang akan ditambahkan ke capiEventsSent (bukan Purchase)
    const newOneTimeEvents: CapiEventName[] = [];

    // ── Fase 45 (2026-08-21): State-based approach — capiEventsSent adalah satu-satunya
    // sumber kebenaran untuk deduplication, bukan isNewLead.
    //
    // Masalah sebelumnya (transition-based):
    //   ViewContent hanya dikirim kalau isNewLead=true. Jika saat pesan pertama masuk
    //   leadCategory belum PROSPEK_IKLAN (masih NEW_INBOUND), gerbang GERBANG 2 di atas
    //   sudah return sebelum ViewContent dikirim. Begitu kategori di-upgrade ke PROSPEK_IKLAN
    //   pada pesan berikutnya, isNewLead sudah false → ViewContent tidak pernah dikirim selamanya.
    //   Sama berlaku untuk stage events (Lead/AddToCart): gate stageNaik || isNewLead
    //   melewatkan catch-up untuk lead yang stage-nya sudah layak tapi event belum terkirim.
    //
    // Solusi: kirim event APAPUN yang:
    //   1. Secara state sudah layak (stage cukup, kategori sudah benar — sudah lolos gerbang atas)
    //   2. Belum pernah dikirim (tidak ada di capiEventsSent)
    // Meta CAPI auto-dedupe via event_id deterministik jadi aman kalau ada race.
    // Purchase tetap transition-based supaya REPEAT_ORDER bisa dikirim berulang. ──

    // ViewContent: kirim kalau belum pernah, apapun kondisi isNewLead
    if (!capiEventsSent.includes(evNewLead)) {
      eventsToSend.push(evNewLead);
      newOneTimeEvents.push(evNewLead);
    }

    // ── Stage-based events (state-based, tidak perlu stageNaik sebagai gate) ──
    const finalRank = STAGE_RANK[finalStage] ?? 0;

    // WARM ke atas, belum pernah dikirim
    if (
      finalRank >= STAGE_RANK['WARM'] &&
      !capiEventsSent.includes(evWarm) &&
      !newOneTimeEvents.includes(evWarm)
    ) {
      eventsToSend.push(evWarm);
      newOneTimeEvents.push(evWarm);
    }
    // HOT ke atas, belum pernah dikirim
    if (
      finalRank >= STAGE_RANK['HOT'] &&
      !capiEventsSent.includes(evHot) &&
      !newOneTimeEvents.includes(evHot)
    ) {
      eventsToSend.push(evHot);
      newOneTimeEvents.push(evHot);
    }

    // ── Purchase: tetap transition-based (supaya REPEAT_ORDER tidak di-dedupe) ──
    //
    // Fix Fase 48 (2026-08-21): tambah guard LOST di gate Purchase.
    // Sebelumnya hanya cek transisi (atomicConversion !== prevConversion) tapi tidak
    // cek apakah lead LOST. Skenario ghost purchase:
    //   CS set CLOSING → Purchase dienqueue → CS koreksi ke LOST → worker kirim ke Meta tetap
    // Guard LOST harus di depan supaya TypeScript tidak narrow tipe duluan.
    const isNewClosing =
      atomicConversion !== 'LOST' && // guard: jangan pernah kirim Purchase kalau sedang di-set ke LOST
      (atomicConversion === 'CLOSING' || atomicConversion === 'REPEAT_ORDER') &&
      atomicConversion !== prevConversion;

    let closingTimestamp: string | undefined;
    if (isNewClosing) {
      closingTimestamp = new Date().toISOString();
      eventsToSend.push(evClosing);
      newOneTimeEvents.push(evClosing);
    }

    if (eventsToSend.length === 0) return;

    // ── Enqueue semua event ke BullMQ ──
    for (const eventName of eventsToSend) {
      const isClosingEvent = eventName === evClosing;
      await capiQueue.add(`${eventName}-${leadId}`, {
        ...baseJobData,
        eventName,
        value: isClosingEvent ? (confirmedCodAmount ?? null) : undefined,
        closingTimestamp: isClosingEvent ? closingTimestamp : undefined,
      });
      logger.debug(`[CAPI] Enqueued event ${eventName} untuk leadId=${leadId}`);
    }

    // ── Update capiEventsSent di DB (best-effort, non-critical) ──
    // Hanya untuk one-time events; Purchase tidak masuk supaya REPEAT_ORDER tidak terblokir.
    if (newOneTimeEvents.length > 0) {
      const updatedSent = Array.from(new Set([...capiEventsSent, ...newOneTimeEvents]));
      await prisma.lead.update({
        where: { id: leadId },
        data: { capiEventsSent: updatedSent },
      });
    }
  } catch (err) {
    // SENGAJA tidak re-throw — kegagalan CAPI tidak boleh merusak pipeline leads
    logger.error(`[CAPI] enqueueCapiIfNeeded gagal untuk leadId=${params.leadId}: ${err}`);
  }
}

/**
 * Rekonsiliasi event CAPI yang terlewat untuk semua PROSPEK_IKLAN di satu bisnis.
 *
 * Dipanggil via POST /business/meta-capi/reconcile.
 * Menggunakan path yang SAMA dengan alur normal (enqueueCapiIfNeeded yang sudah difix),
 * sehingga sekaligus menjadi bukti bahwa perbaikan state-based benar.
 *
 * Idempoten: capiEventsSent di DB dan event_id deterministik di Meta mencegah duplikat.
 * TIDAK pernah throw — error per-lead hanya di-log.
 */
export async function reconcileCapiEvents(businessId: string): Promise<{ processed: number; skipped: number; errors: number }> {
  logger.info(`[CAPI/reconcile] Mulai rekonsiliasi untuk businessId=${businessId}`);

  const business = await prisma.business.findUnique({
    where: { id: businessId },
    select: { metaCapiEventMap: true },
  });

  const eventMap: any = (business?.metaCapiEventMap && typeof business.metaCapiEventMap === 'object')
    ? business.metaCapiEventMap
    : DEFAULT_EVENT_MAP;

  const evNewLead = eventMap.NEW_LEAD || DEFAULT_EVENT_MAP.NEW_LEAD;
  const evWarm = eventMap.WARM || DEFAULT_EVENT_MAP.WARM;
  const evHot = eventMap.HOT || DEFAULT_EVENT_MAP.HOT;

  const leads = await (prisma as any).lead.findMany({
    where: {
      businessId,
      leadCategory: 'PROSPEK_IKLAN',
    },
    select: {
      id: true,
      waNumber: true,
      name: true,
      leadStage: true,
      conversionStatus: true,
      capiEventsSent: true,
    },
  });

  let processed = 0;
  let skipped = 0;
  let errors = 0;

  for (const lead of leads) {
    try {
      const eventsSent: string[] = Array.isArray(lead.capiEventsSent) ? lead.capiEventsSent : [];

      // Cek apakah ada event yang mungkin terlewat berdasarkan state sekarang
      const finalRank = STAGE_RANK[lead.leadStage as string] ?? 0;
      const needsViewContent = !eventsSent.includes(evNewLead);
      const needsWarm = finalRank >= STAGE_RANK['WARM'] && !eventsSent.includes(evWarm);
      const needsHot = finalRank >= STAGE_RANK['HOT'] && !eventsSent.includes(evHot);

      if (!needsViewContent && !needsWarm && !needsHot) {
        skipped++;
        continue;
      }

      logger.info(
        `[CAPI/reconcile] leadId=${lead.id} stage=${lead.leadStage} ` +
        `missing=[${[needsViewContent && evNewLead, needsWarm && evWarm, needsHot && evHot].filter(Boolean).join(',')}]`
      );

      // Panggil enqueueCapiIfNeeded dengan state saat ini — logika state-based akan
      // mendeteksi event yang kurang dan mengirimkannya lewat queue yang sama
      await enqueueCapiIfNeeded({
        businessId,
        leadId: lead.id,
        waNumber: lead.waNumber,
        name: lead.name || null,
        ctwaClid: null,
        finalLeadCategory: 'PROSPEK_IKLAN',
        finalStage: lead.leadStage as string,
        prevStage: lead.leadStage as string, // same — biar tidak trigger Purchase via transisi
        atomicConversion: lead.conversionStatus as string,
        prevConversion: lead.conversionStatus as string, // same — biar Purchase tidak double-trigger
        capiEventsSent: eventsSent,
        confirmedCodAmount: null,
        isNewLead: false,
      });

      processed++;
    } catch (err) {
      logger.error(`[CAPI/reconcile] Error untuk leadId=${lead.id}: ${err}`);
      errors++;
    }
  }

  logger.info(
    `[CAPI/reconcile] Selesai businessId=${businessId}: ` +
    `processed=${processed} skipped=${skipped} errors=${errors}`
  );

  return { processed, skipped, errors };
}

/**
 * Rekonsiliasi retroaktif event Purchase untuk lead CLOSING yang terlewat.
 *
 * Kasus penggunaan: lead yang sudah CLOSING sebelum CAPI dipasang tidak pernah
 * mendapat Purchase karena tidak ada transisi baru yang memicu isNewClosing=true.
 * Reconcile biasa (reconcileCapiEvents) sengaja tidak mengirim Purchase.
 *
 * Fungsi ini spesifik mengirim Purchase ke:
 * - Lead dengan leadCategory = 'PROSPEK_IKLAN'
 * - conversionStatus = 'CLOSING'
 * - 'Purchase' belum ada di capiEventsSent
 *
 * Idempoten: Meta CAPI auto-dedupe via event_id = '${leadId}-Purchase'.
 * Aman dipanggil berulang.
 */
export async function reconcilePurchaseEvents(businessId: string): Promise<{ processed: number; skipped: number; errors: number }> {
  logger.info(`[CAPI/reconcile-purchase] Mulai untuk businessId=${businessId}`);

  const leads = await prisma.lead.findMany({
    where: {
      businessId,
      leadCategory: 'PROSPEK_IKLAN',
      conversionStatus: 'CLOSING',
      NOT: { capiEventsSent: { has: 'Purchase' } },
    },
    select: {
      id: true,
      waNumber: true,
      name: true,
      leadStage: true,
      conversionStatus: true,
      capiEventsSent: true,
      confirmedCodAmount: true,
      ctwaClid: true,
    },
  });

  logger.info(`[CAPI/reconcile-purchase] Ditemukan ${leads.length} CLOSING leads tanpa Purchase`);

  let processed = 0;
  let skipped = 0;
  let errors = 0;

  for (const lead of leads) {
    try {
      const eventsSent: string[] = Array.isArray(lead.capiEventsSent) ? lead.capiEventsSent : [];

      // Double-check: skip kalau somehow sudah ada Purchase (race condition guard)
      if (eventsSent.includes('Purchase')) {
        skipped++;
        continue;
      }

      logger.info(
        `[CAPI/reconcile-purchase] leadId=${lead.id} waNumber=${lead.waNumber} ` +
        `confirmedCodAmount=${lead.confirmedCodAmount}`
      );

      // Kirim via enqueueCapiIfNeeded — prevConversion='PENDING' memastikan
      // isNewClosing=true sehingga Purchase dienqueue. Stage events di-skip
      // karena capiEventsSent sudah punya VC/Lead/ATC (sudah dikirim reconcile sebelumnya).
      await enqueueCapiIfNeeded({
        businessId,
        leadId: lead.id,
        waNumber: lead.waNumber,
        name: lead.name || null,
        ctwaClid: lead.ctwaClid || null,
        finalLeadCategory: 'PROSPEK_IKLAN',
        finalStage: lead.leadStage as string,
        prevStage: lead.leadStage as string,   // sama — stage events tidak double-trigger
        atomicConversion: 'CLOSING',            // trigger isNewClosing=true
        prevConversion: 'PENDING',              // beda dari CLOSING agar transisi terdeteksi
        capiEventsSent: eventsSent,
        confirmedCodAmount: (lead as any).confirmedCodAmount ?? null,
        isNewLead: false,
      });

      processed++;
    } catch (err) {
      logger.error(`[CAPI/reconcile-purchase] Error untuk leadId=${lead.id}: ${err}`);
      errors++;
    }
  }

  logger.info(
    `[CAPI/reconcile-purchase] Selesai businessId=${businessId}: ` +
    `processed=${processed} skipped=${skipped} errors=${errors}`
  );

  return { processed, skipped, errors };
}
