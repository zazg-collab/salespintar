const { PrismaClient } = require('@prisma/client');
const { decrypt } = require('/app/dist/services/crypto.service');

const prisma = new PrismaClient();

const META_GRAPH_VERSION = 'v21.0';
const BUSINESS_ID = '777779f9-6955-4b0d-95cd-84595bb34eb4';

function extractMetaVideoId(creative) {
  return creative?.object_story_spec?.video_data?.video_id || creative?.video_id || null;
}

async function getActiveBmTokens(businessId) {
  const bms = await prisma.metaBusinessManager.findMany({ where: { businessId, isActive: true, tokenStatus: 'ACTIVE' } });
  const out = [];
  for (const bm of bms) {
    const token = decrypt(bm.accessToken);
    if (token) out.push({ bmId: bm.id, bmName: bm.name, token });
  }
  return out;
}

async function main() {
  const t0 = Date.now();
  const tokens = await getActiveBmTokens(BUSINESS_ID);
  console.log(`[1] ${tokens.length} BM token aktif ditemukan.`);

  const alreadyAudited = new Set(
    (await prisma.videoAdAudit.findMany({ where: { businessId: BUSINESS_ID, metaAdId: { not: null } }, select: { metaAdId: true } }))
      .map((r) => r.metaAdId),
  );
  console.log(`[2] ${alreadyAudited.size} ad sudah punya baris VideoAdAudit (akan di-skip, sama seperti logika "Audit Semua").`);

  let target = null;
  for (const { bmId, bmName, token } of tokens) {
    if (target) break;
    const actQ = new URLSearchParams({ fields: 'id,name', access_token: token });
    const actResp = await fetch(`https://graph.facebook.com/${META_GRAPH_VERSION}/me/adaccounts?${actQ}`);
    const actData = await actResp.json();
    if (!actResp.ok || !Array.isArray(actData.data)) continue;
    for (const acc of actData.data) {
      if (target) break;
      const adsQ = new URLSearchParams({
        fields: 'id,name,creative{video_id,object_story_spec}',
        effective_status: JSON.stringify(['DISAPPROVED']),
        limit: '50',
        access_token: token,
      });
      const adsResp = await fetch(`https://graph.facebook.com/${META_GRAPH_VERSION}/${acc.id}/ads?${adsQ}`);
      const adsData = await adsResp.json();
      if (!adsResp.ok || !Array.isArray(adsData.data)) continue;
      for (const ad of adsData.data) {
        if (alreadyAudited.has(ad.id)) continue;
        const videoId = extractMetaVideoId(ad.creative || {});
        if (videoId) { target = { ad, videoId, bmName, token }; break; }
      }
    }
  }

  if (!target) {
    console.log('[3] TIDAK ADA ad DISAPPROVED ber-video yang belum diaudit saat ini -- tidak ada yang perlu diuji lewat jalur nyata. (Ini hasil valid, bukan kegagalan.)');
    process.exit(0);
  }

  console.log(`[3] Target ditemukan: ad "${target.ad.name}" (${target.ad.id}) di BM "${target.bmName}", video_id=${target.videoId}.`);

  const srcResp = await fetch(`https://graph.facebook.com/${META_GRAPH_VERSION}/${target.videoId}?fields=source&access_token=${target.token}`);
  const srcData = await srcResp.json();
  if (!srcResp.ok || !srcData.source) {
    console.log(`[4] GAGAL resolve source video: ${JSON.stringify(srcData).slice(0, 300)}`);
    process.exit(1);
  }
  const videoResp = await fetch(srcData.source);
  const videoBuf = Buffer.from(await videoResp.arrayBuffer());
  console.log(`[4] Video berhasil didownload: ${(videoBuf.byteLength / 1024 / 1024).toFixed(1)} MB.`);

  const form = new FormData();
  form.set('ad_title', `[UJI COWORK] ${target.ad.name}`);
  form.set('video_file', new Blob([videoBuf], { type: 'video/mp4' }), `test-${target.ad.id}.mp4`);

  const internalKey = process.env.METAGUARD_INTERNAL_API_KEY;
  const submitT0 = Date.now();
  const submitResp = await fetch(`${process.env.METAGUARD_SERVICE_URL}/v1/audit`, {
    method: 'POST',
    headers: internalKey ? { 'X-Internal-Api-Key': internalKey } : {},
    body: form,
  });
  const submitData = await submitResp.json();
  if (!submitResp.ok || !submitData.audit_id) {
    console.log(`[5] GAGAL submit ke metaguard_service: ${submitResp.status} ${JSON.stringify(submitData)}`);
    process.exit(1);
  }
  console.log(`[5] Audit disubmit: audit_id=${submitData.audit_id}, status=${submitData.status}.`);

  let finalReport = null;
  let finalStatus = null;
  for (let attempt = 0; attempt < 200; attempt++) {
    await new Promise((r) => setTimeout(r, 5000));
    const stResp = await fetch(`${process.env.METAGUARD_SERVICE_URL}/v1/audit/${submitData.audit_id}`, {
      headers: internalKey ? { 'X-Internal-Api-Key': internalKey } : {},
    });
    const stData = await stResp.json();
    if (stData.status === 'done' || stData.status === 'error') {
      finalStatus = stData.status;
      finalReport = stData.report || null;
      break;
    }
    if (attempt % 6 === 0) console.log(`[poll] ${((Date.now() - submitT0) / 1000).toFixed(0)}s -- status masih "${stData.status}"...`);
  }

  const totalSubmitToDoneSec = (Date.now() - submitT0) / 1000;
  const totalWallSec = (Date.now() - t0) / 1000;

  if (finalStatus === 'done' && finalReport) {
    console.log(`[6] BERHASIL. verdict=${finalReport.verdict}, score=${finalReport.overall_compliance_score}, waktu submit->selesai=${(totalSubmitToDoneSec / 60).toFixed(1)} menit.`);
    console.log(`    executive_summary: ${(finalReport.raw_assessment?.executive_summary || '').slice(0, 200)}`);
  } else {
    console.log(`[6] GAGAL/timeout. status=${finalStatus}, waktu tunggu=${(totalSubmitToDoneSec / 60).toFixed(1)} menit.`);
  }
  console.log(`[7] Total waktu skrip (termasuk download video): ${(totalWallSec / 60).toFixed(1)} menit.`);
  console.log(`RESULT_JSON:${JSON.stringify({ ok: finalStatus === 'done', verdict: finalReport?.verdict, score: finalReport?.overall_compliance_score, submitToDoneSec: totalSubmitToDoneSec, totalWallSec, adId: target.ad.id, adName: target.ad.name })}`);

  await prisma.$disconnect();
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
