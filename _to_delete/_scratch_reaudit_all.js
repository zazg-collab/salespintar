const { PrismaClient } = require('@prisma/client');
const { decrypt } = require('./dist/services/crypto.service');
const { env } = require('./dist/config/env');
const prisma = new PrismaClient();

const BUSINESS_ID = '777779f9-6955-4b0d-95cd-84595bb34eb4';
const META_GRAPH_VERSION = 'v21.0';
const METAGUARD_SERVICE_URL = env.METAGUARD_SERVICE_URL;
const METAGUARD_INTERNAL_API_KEY = env.METAGUARD_INTERNAL_API_KEY;
const MAX_VIDEO_BYTES = 200 * 1024 * 1024;

function extractMetaVideoId(creative) {
  return creative?.object_story_spec?.video_data?.video_id || creative?.video_id || null;
}
function extractLandingPageUrl(creative) {
  return creative?.object_story_spec?.video_data?.call_to_action?.value?.link
    || creative?.object_story_spec?.link_data?.link
    || null;
}
function extractCreativeCopy(creative) {
  const headline = creative?.object_story_spec?.video_data?.title || creative?.title || undefined;
  const primaryText = creative?.object_story_spec?.video_data?.message || creative?.body || undefined;
  return { headline, primaryText };
}

async function getActiveBmTokens() {
  const bms = await prisma.metaBusinessManager.findMany({
    where: { businessId: BUSINESS_ID, isActive: true, tokenStatus: 'ACTIVE' },
  });
  const out = [];
  for (const bm of bms) {
    const token = decrypt(bm.accessToken);
    if (token) out.push({ bmId: bm.id, token });
  }
  return out;
}

async function resolveAdOwnerToken(bmTokens, adId) {
  for (const { token } of bmTokens) {
    try {
      const r = await fetch(`https://graph.facebook.com/${META_GRAPH_VERSION}/${adId}?fields=id&access_token=${token}`);
      const j = await r.json();
      if (r.ok && !j.error) return token;
    } catch {}
  }
  return null;
}

async function downloadUrlAsBuffer(url, timeoutMs) {
  const resp = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!resp.ok) return null;
  const buffer = Buffer.from(await resp.arrayBuffer());
  if (buffer.byteLength > MAX_VIDEO_BYTES) throw new Error('File terlalu besar');
  return { buffer, contentType: resp.headers.get('content-type') || 'application/octet-stream' };
}

async function resolveBusinessGeminiKey() {
  const business = await prisma.business.findUnique({ where: { id: BUSINESS_ID }, select: { settings: true } });
  const settings = business?.settings || {};
  const encrypted = settings.metaGuardGeminiApiKeyEncrypted;
  if (typeof encrypted !== 'string' || !encrypted) return null;
  try { return decrypt(encrypted); } catch { return null; }
}

async function auditOneAd(bmTokens, geminiKey, adId) {
  const token = await resolveAdOwnerToken(bmTokens, adId);
  if (!token) return { adId, ok: false, error: 'NO_OWNER_TOKEN' };

  const q = new URLSearchParams({
    fields: 'id,name,ad_review_feedback,creative{id,name,thumbnail_url,image_url,video_id,object_story_spec,body}',
    access_token: token,
  });
  const adResp = await fetch(`https://graph.facebook.com/${META_GRAPH_VERSION}/${adId}?${q.toString()}`);
  const adData = await adResp.json();
  if (!adResp.ok || adData.error) return { adId, ok: false, error: 'AD_FETCH_FAILED: ' + (adData.error?.message || adResp.status) };

  const creative = adData.creative || {};
  const metaVideoId = extractMetaVideoId(creative);
  const landingPageUrl = extractLandingPageUrl(creative);
  const { headline, primaryText } = extractCreativeCopy(creative);
  const adTitle = creative.name || adData.name || `Meta Ad ${adId}`;

  let videoBuffer = null, videoContentType = 'video/mp4';
  if (metaVideoId) {
    const srcResp = await fetch(`https://graph.facebook.com/${META_GRAPH_VERSION}/${metaVideoId}?fields=source&access_token=${token}`);
    const srcData = await srcResp.json();
    if (srcResp.ok && srcData.source) {
      const downloaded = await downloadUrlAsBuffer(srcData.source, 60000);
      if (downloaded) { videoBuffer = downloaded.buffer; videoContentType = downloaded.contentType; }
    }
  }

  let thumbnailBuffer = null, thumbnailContentType = 'image/jpeg';
  const thumbUrl = creative.thumbnail_url || creative.image_url;
  if (thumbUrl) {
    try {
      const downloaded = await downloadUrlAsBuffer(thumbUrl, 20000);
      if (downloaded) { thumbnailBuffer = downloaded.buffer; thumbnailContentType = downloaded.contentType; }
    } catch {}
  }

  if (!videoBuffer && !thumbnailBuffer && !landingPageUrl) {
    return { adId, ok: false, error: 'NO_MEDIA_OR_LANDING_PAGE' };
  }

  const form = new FormData();
  form.set('ad_title', String(adTitle));
  if (primaryText) form.set('primary_text', String(primaryText));
  if (headline) form.set('headline', String(headline));
  if (landingPageUrl) form.set('landing_page_url', String(landingPageUrl));
  if (videoBuffer) form.set('video_file', new Blob([videoBuffer], { type: videoContentType }), `meta-ad-${adId}.mp4`);
  if (thumbnailBuffer) form.set('thumbnail_file', new Blob([thumbnailBuffer], { type: thumbnailContentType }), `meta-ad-${adId}-thumb.jpg`);

  const headers = { 'X-Internal-Api-Key': METAGUARD_INTERNAL_API_KEY };
  if (geminiKey) headers['X-Gemini-Api-Key'] = geminiKey;

  const upstream = await fetch(`${METAGUARD_SERVICE_URL}/v1/audit`, {
    method: 'POST',
    headers,
    body: form,
    signal: AbortSignal.timeout(15000),
  });
  const data = await upstream.json();
  if (!upstream.ok || typeof data?.audit_id !== 'string') {
    return { adId, ok: false, error: 'SUBMIT_FAILED: ' + upstream.status + ' ' + JSON.stringify(data).slice(0, 300) };
  }

  try {
    await prisma.videoAdAudit.create({
      data: {
        id: data.audit_id,
        businessId: BUSINESS_ID,
        adTitle: String(adTitle),
        metaAdId: adId,
        metaVideoId: metaVideoId || undefined,
        rawReportJson: {
          _ad_context: {
            adName: adData.name || null,
            originalHeadline: headline || null,
            originalPrimaryText: primaryText || null,
          },
        },
      },
    });
  } catch (e) {
    return { adId, ok: false, error: 'PERSIST_FAILED: ' + e.message, auditId: data.audit_id };
  }

  return { adId, ok: true, auditId: data.audit_id, adTitle, mediaType: metaVideoId ? 'VIDEO' : (thumbnailBuffer ? 'IMAGE' : 'NONE') };
}

async function main() {
  const adIds = process.argv.slice(2);
  if (adIds.length === 0) {
    console.error('NO_AD_IDS_PROVIDED');
    process.exit(1);
  }
  const bmTokens = await getActiveBmTokens();
  const geminiKey = await resolveBusinessGeminiKey();
  console.log('ACTIVE_BM_COUNT=' + bmTokens.length + ' GEMINI_KEY_PRESENT=' + Boolean(geminiKey));

  const results = [];
  for (const adId of adIds) {
    try {
      const r = await auditOneAd(bmTokens, geminiKey, adId);
      results.push(r);
      console.log('SUBMITTED ' + JSON.stringify(r));
    } catch (e) {
      results.push({ adId, ok: false, error: 'EXCEPTION: ' + e.message });
      console.log('SUBMIT_EXCEPTION ' + adId + ' ' + e.message);
    }
  }
  console.log('SUMMARY=' + JSON.stringify(results));
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
