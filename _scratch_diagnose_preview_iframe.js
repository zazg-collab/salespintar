const { PrismaClient } = require('@prisma/client');
const { decrypt } = require('./dist/services/crypto.service');
const prisma = new PrismaClient();

const BUSINESS_ID = '777779f9-6955-4b0d-95cd-84595bb34eb4';
const META_GRAPH_VERSION = 'v21.0';

// [adId, videoId, label]
const CASES = JSON.parse(process.argv[2]);

async function getActiveBmTokens() {
  const bms = await prisma.metaBusinessManager.findMany({ where: { businessId: BUSINESS_ID, isActive: true, tokenStatus: 'ACTIVE' } });
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

function extractIframeSrc(html) {
  if (!html) return null;
  const m = html.match(/<iframe[^>]+src=["']([^"']+)["']/i);
  return m ? m[1].replace(/&amp;/g, '&') : null;
}

function findMp4Like(text) {
  if (!text) return [];
  const matches = new Set();
  const re = /https:\\?\/\\?\/[^"'\s\\]+\.mp4[^"'\s\\]*/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    matches.add(m[0].replace(/\\\//g, '/'));
  }
  return Array.from(matches);
}

async function main() {
  const bmTokens = await getActiveBmTokens();
  for (const [adId, videoId, label] of CASES) {
    const token = await resolveAdOwnerToken(bmTokens, adId);
    if (!token) { console.log(JSON.stringify({ label, adId, error: 'NO_OWNER_TOKEN' })); continue; }

    const out = { label, adId, videoId };
    try {
      const prevRes = await fetch(`https://graph.facebook.com/${META_GRAPH_VERSION}/${adId}/previews?ad_format=MOBILE_FEED_STANDARD&access_token=${token}`);
      const prevData = await prevRes.json();
      const body = prevData?.data?.[0]?.body || null;
      out.previewBodyLength = body ? body.length : 0;
      out.previewError = prevData?.error || null;
      const iframeSrc = extractIframeSrc(body);
      out.iframeSrc = iframeSrc;
      out.mp4InBody = findMp4Like(body);

      if (iframeSrc) {
        try {
          const fullUrl = iframeSrc.startsWith('http') ? iframeSrc : `https://www.facebook.com${iframeSrc}`;
          const iframeResp = await fetch(fullUrl, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(20000) });
          const iframeHtml = await iframeResp.text();
          out.iframeHttpStatus = iframeResp.status;
          out.iframeHtmlLength = iframeHtml.length;
          const mp4s = findMp4Like(iframeHtml);
          out.mp4InIframe = mp4s.slice(0, 5);
          // coba juga cari pola dash/hls manifest
          const manifestMatch = iframeHtml.match(/https:\\?\/\\?\/[^"'\s\\]+\.(mpd|m3u8)[^"'\s\\]*/);
          out.manifestFound = manifestMatch ? manifestMatch[0].replace(/\\\//g, '/') : null;
        } catch (e) {
          out.iframeFetchError = e.message;
        }
      }
    } catch (e) {
      out.exception = e.message;
    }
    console.log(JSON.stringify(out));
  }
  await prisma.$disconnect();
}

main().catch(async (e) => { console.error('FATAL', e.message); await prisma.$disconnect(); process.exit(1); });
