const { PrismaClient } = require('@prisma/client');
const { decrypt } = require('./dist/services/crypto.service');
const prisma = new PrismaClient();

const BUSINESS_ID = '777779f9-6955-4b0d-95cd-84595bb34eb4';
const META_GRAPH_VERSION = 'v21.0';

const CASES = JSON.parse(process.argv[2]); // [[videoId, adId, label], ...]

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
  for (const [videoId, adId, label] of CASES) {
    const token = await resolveAdOwnerToken(bmTokens, adId);
    if (!token) { console.log(JSON.stringify({ videoId, adId, label, error: 'NO_OWNER_TOKEN' })); continue; }

    const adResp = await fetch(`https://graph.facebook.com/${META_GRAPH_VERSION}/${adId}?fields=creative{object_story_spec,effective_object_story_id}&access_token=${token}`);
    const adData = await adResp.json();
    const effectiveStoryId = adData?.creative?.effective_object_story_id || null;
    const pageId = effectiveStoryId ? effectiveStoryId.split('_')[0] : (adData?.creative?.object_story_spec?.page_id || null);

    let pageName = null;
    if (pageId) {
      try {
        const pr = await fetch(`https://graph.facebook.com/${META_GRAPH_VERSION}/${pageId}?fields=name&access_token=${token}`);
        const pj = await pr.json();
        pageName = pj.name || JSON.stringify(pj.error || pj);
      } catch (e) { pageName = 'FETCH_ERR:' + e.message; }
    }

    const vr = await fetch(`https://graph.facebook.com/${META_GRAPH_VERSION}/${videoId}?fields=source,from&access_token=${token}`);
    const videoResult = await vr.json();

    console.log(JSON.stringify({ label, videoId, adId, pageId, pageName, effectiveStoryId, videoResult }));
  }
  await prisma.$disconnect();
}

main().catch(async (e) => { console.error('FATAL', e.message); await prisma.$disconnect(); process.exit(1); });
