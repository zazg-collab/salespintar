const { PrismaClient } = require('@prisma/client');
const { decrypt } = require('./dist/services/crypto.service');
const prisma = new PrismaClient();

const BUSINESS_ID = '777779f9-6955-4b0d-95cd-84595bb34eb4';
const META_GRAPH_VERSION = 'v21.0';

// [videoId, one representative adId that uses it]
const CASES = [
  ['1001595629480113', '120243827277270461'],
  ['1407810690271660', '120240876189420395'],
  ['2142749143174175', '120245204102690711'],
  ['1546139163900723', '120245204179120711'],
  ['1520523292118081', '120203635137710420'],
  ['1530361511381449', '52592630566093'],
];

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

async function main() {
  const bmTokens = await getActiveBmTokens();
  for (const [videoId, adId] of CASES) {
    const token = await resolveAdOwnerToken(bmTokens, adId);
    if (!token) { console.log(JSON.stringify({ videoId, adId, error: 'NO_OWNER_TOKEN' })); continue; }
    try {
      const r = await fetch(`https://graph.facebook.com/${META_GRAPH_VERSION}/${videoId}?fields=source,status,length,permalink_url&access_token=${token}`);
      const j = await r.json();
      let sourceCheck = null;
      if (j.source) {
        try {
          const head = await fetch(j.source, { method: 'HEAD', signal: AbortSignal.timeout(15000) });
          sourceCheck = { ok: head.ok, status: head.status, contentLength: head.headers.get('content-length'), contentType: head.headers.get('content-type') };
        } catch (e) {
          sourceCheck = { fetchError: e.message };
        }
      }
      console.log(JSON.stringify({ videoId, adId, httpStatus: r.status, graphResponse: j, sourceCheck }, null, 2));
    } catch (e) {
      console.log(JSON.stringify({ videoId, adId, exception: e.message }));
    }
  }
  await prisma.$disconnect();
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
