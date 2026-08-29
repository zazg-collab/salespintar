// Backfill sekali-jalan (2026-08-25, feedback Bossfren): 9 baris VideoAdAudit hasil batch "Audit
// Semua" hari ini dibuat SEBELUM fitur _ad_context ada -- jadi rawReportJson-nya belum punya
// adName/originalHeadline/originalPrimaryText, dan layersApplied masih [] (bug lama, sudah
// diperbaiki di persistAuditReport tapi baris LAMA tidak otomatis ke-update). Skrip ini menutup
// gap itu: refetch live dari Meta Graph API (bukan hardcode dari ingatan) utk data yang sama
// persis dgn yang dipakai submit asli, lalu tulis _ad_context + perbaiki layersApplied.
const { PrismaClient } = require('@prisma/client');
const { decrypt } = require('/app/dist/services/crypto.service');
const prisma = new PrismaClient();
const META_GRAPH_VERSION = 'v21.0';
const BUSINESS_ID = '777779f9-6955-4b0d-95cd-84595bb34eb4';

function extractCreativeCopy(creative) {
  const headline = creative?.object_story_spec?.video_data?.title || creative?.title || undefined;
  const primaryText = creative?.object_story_spec?.video_data?.message || creative?.body || undefined;
  return { headline, primaryText };
}
function parseLayers(raw) {
  if (Array.isArray(raw)) return raw.map((v) => String(v).trim()).filter(Boolean);
  if (typeof raw === 'string') return raw.split(',').map((v) => v.trim()).filter(Boolean);
  return [];
}

async function main() {
  const bms = await prisma.metaBusinessManager.findMany({ where: { businessId: BUSINESS_ID, isActive: true, tokenStatus: 'ACTIVE' } });
  const tokens = bms.map((b) => decrypt(b.accessToken));

  const rows = await prisma.videoAdAudit.findMany({ where: { businessId: BUSINESS_ID, metaAdId: { not: null } } });
  console.log(`Ditemukan ${rows.length} baris dgn metaAdId utk di-backfill.`);

  let ok = 0, failed = 0;
  for (const row of rows) {
    let adData = null;
    for (const token of tokens) {
      try {
        const r = await fetch(`https://graph.facebook.com/${META_GRAPH_VERSION}/${row.metaAdId}?fields=id,name,creative{name,object_story_spec,body}&access_token=${token}`);
        const j = await r.json();
        if (r.ok && !j.error) { adData = j; break; }
      } catch { /* coba token lain */ }
    }
    const layers = parseLayers((row.rawReportJson || {}).channels_used);
    if (!adData) {
      // Tidak bisa refetch (mis. ad sudah dihapus) -- tetap perbaiki layersApplied minimal.
      await prisma.videoAdAudit.update({ where: { id: row.id }, data: { layersApplied: layers } });
      console.log(`[SKIP _ad_context] ${row.metaAdId} -- gagal refetch dari semua BM, layersApplied tetap diperbaiki (${layers.length} channel).`);
      failed += 1;
      continue;
    }
    const { headline, primaryText } = extractCreativeCopy(adData.creative || {});
    const adContext = { adName: adData.name || null, originalHeadline: headline || null, originalPrimaryText: primaryText || null };
    const mergedReport = { ...(row.rawReportJson || {}), _ad_context: adContext };
    await prisma.videoAdAudit.update({
      where: { id: row.id },
      data: { layersApplied: layers, rawReportJson: mergedReport },
    });
    console.log(`[OK] ${row.metaAdId} -> adName="${adContext.adName}", ${layers.length} channel, headline=${headline ? 'ada' : 'kosong'}, primaryText=${primaryText ? 'ada' : 'kosong'}`);
    ok += 1;
  }
  console.log(`SELESAI. ${ok} berhasil di-backfill, ${failed} gagal refetch (layersApplied tetap diperbaiki).`);
  await prisma.$disconnect();
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
