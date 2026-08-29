const { PrismaClient } = require('@prisma/client');
const { decrypt } = require('./dist/services/crypto.service');
const prisma = new PrismaClient();

const BUSINESS_ID = '777779f9-6955-4b0d-95cd-84595bb34eb4';
const META_GRAPH_VERSION = 'v21.0';

// [videoId, adId, adAccountId] -- termasuk 1 video yg BERHASIL sbg pembanding
const CASES = [
  ['1001595629480113', '120243827277270461', 'act_875546131839616', 'FAILED'],
  ['1407810690271660', '120240876189420395', 'act_2428057244370161', 'FAILED'],
  ['2142749143174175', '120245204102690711', 'act_35693334826981755', 'FAILED'],
  ['1546139163900723', '120245204179120711', 'act_35693334826981755', 'FAILED'],
  ['1520523292118081', '120203635137710420', 'act_1482436509271298', 'FAILED'],
  ['1530361511381449', '52592630566093', 'act_1821630328818787', 'FAILED'],
  ['1461185907858050', '120209304058950301', 'act_1327235911788215', 'SUCCESS'],
  ['1913739362673722', '120245140618480711', 'act_35693334826981755', 'SUCCESS'],
  ['367962945785831', '120243259966490420', 'act_1482436509271298', 'SUCCESS'],
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
  for (const { token, bmId } of bmTokens) {
    try {
      const r = await fetch(`https://graph.facebook.com/${META_GRAPH_VERSION}/${adId}?fields=id&access_token=${token}`);
      const j = await r.json();
      if (r.ok && !j.error) return { token, bmId };
    } catch {}
  }
  return null;
}

async function main() {
  const bmTokens = await getActiveBmTokens();
  const results = [];
  for (const [videoId, adId, adAccountId, label] of CASES) {
    const owner = await resolveAdOwnerToken(bmTokens, adId);
    if (!owner) { results.push({ videoId, adId, label, error: 'NO_OWNER_TOKEN' }); continue; }
    const { token, bmId } = owner;

    // 1) ambil creative + page_id dari ad
    const adResp = await fetch(`https://graph.facebook.com/${META_GRAPH_VERSION}/${adId}?fields=creative{object_story_spec,effective_object_story_id,instagram_permalink_url}&access_token=${token}`);
    const adData = await adResp.json();
    const pageId = adData?.creative?.object_story_spec?.page_id || null;
    const effectiveStoryId = adData?.creative?.effective_object_story_id || null;

    // 2) coba ambil info Page (nama)
    let pageInfo = null;
    if (pageId) {
      const pr = await fetch(`https://graph.facebook.com/${META_GRAPH_VERSION}/${pageId}?fields=name,id&access_token=${token}`);
      pageInfo = await pr.json();
    }

    // 3) coba ambil video TANPA field source, field2 lain
    const vr = await fetch(`https://graph.facebook.com/${META_GRAPH_VERSION}/${videoId}?fields=id,description,length,from,privacy,published,status,permalink_url&access_token=${token}`);
    const videoMeta = await vr.json();

    // 4) coba ambil source dengan field terpisah (double-check)
    const vsr = await fetch(`https://graph.facebook.com/${META_GRAPH_VERSION}/${videoId}?fields=source&access_token=${token}`);
    const videoSource = await vsr.json();

    // 5) debug_token utk lihat scope token ini (cache per-token, tapi murah dipanggil ulang)
    let scopes = null;
    try {
      const dr = await fetch(`https://graph.facebook.com/${META_GRAPH_VERSION}/debug_token?input_token=${token}&access_token=${token}`);
      const dj = await dr.json();
      scopes = dj?.data?.scopes || dj?.data || dj;
    } catch (e) { scopes = { error: e.message }; }

    results.push({
      label, videoId, adId, adAccountId, bmId, pageId,
      pageInfo, effectiveStoryId, videoMeta, videoSourceResult: videoSource,
      tokenScopesSample: Array.isArray(scopes) ? scopes : scopes,
    });
    console.log(JSON.stringify(results[results.length - 1], null, 2));
  }
  await prisma.$disconnect();
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
