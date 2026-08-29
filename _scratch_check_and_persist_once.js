/**
 * Versi tahan-restart dari poll_and_persist.js: SEKALI JALAN (bukan loop panjang di dalam
 * container) -- cek status semua audit_id yang BELUM punya verdict di DB, persist yang baru
 * "done" (logic persis sama, ported dari video-guard.routes.js), lalu KELUAR. Dipanggil
 * berulang dari luar (SSH, oleh Cowork) tiap ~60-90 detik sampai semua kelar -- supaya kalau
 * container salespintar-api di-restart pihak lain (kejadian nyata 2026-08-26 12:19 UTC, container
 * di-restart manual tanpa sepengetahuan Cowork saat proses audit sedang jalan), TIDAK ADA proses
 * panjang yang ikut mati -- yang jalan lama cuma antrean di api-bridge/metaguard_service (VPS45,
 * TIDAK disentuh restart container Upcloud ini), jadi hasilnya tetap aman menunggu di-poll ulang.
 */
const { PrismaClient } = require('@prisma/client');
const { env } = require('./dist/config/env');

const prisma = new PrismaClient();
const BUSINESS_ID = '777779f9-6955-4b0d-95cd-84595bb34eb4';
const METAGUARD_SERVICE_URL = env.METAGUARD_SERVICE_URL;

function metaguardHeaders(extra) {
  const headers = { ...extra };
  if (env.METAGUARD_INTERNAL_API_KEY) headers['X-Internal-Api-Key'] = env.METAGUARD_INTERNAL_API_KEY;
  return headers;
}

function parseLayers(raw) {
  if (Array.isArray(raw)) return raw.map((v) => String(v).trim()).filter(Boolean);
  if (typeof raw === 'string') return raw.split(',').map((v) => v.trim()).filter(Boolean);
  return [];
}

async function persistAndStripEvidence(auditId, report) {
  const violations = report?.raw_assessment?.violations;
  if (!Array.isArray(violations)) return;
  for (const v of violations) {
    const evidence = v?.evidence;
    const b64 = evidence?.frame_jpeg_base64;
    if (!evidence || typeof b64 !== 'string' || !b64) continue;
    try {
      const frameJpeg = Buffer.from(b64, 'base64');
      await prisma.videoAdAuditEvidence.upsert({
        where: { auditId_violationId: { auditId, violationId: String(v.id) } },
        create: { auditId, violationId: String(v.id), evidenceType: String(evidence.evidence_type ?? 'video_frame'), frameJpeg, evidenceText: typeof evidence.evidence_text === 'string' ? evidence.evidence_text : null },
        update: { evidenceType: String(evidence.evidence_type ?? 'video_frame'), frameJpeg, evidenceText: typeof evidence.evidence_text === 'string' ? evidence.evidence_text : null },
      });
    } catch (e) {
      console.log('EVIDENCE_PERSIST_FAILED', auditId, v?.id, e.message);
    } finally {
      delete evidence.frame_jpeg_base64;
    }
  }
}

async function persistAuditReport(auditId, businessId, report) {
  await persistAndStripEvidence(auditId, report);
  const layers = parseLayers(report.channels_used ?? report.presentation_layers_applied);
  const existingRow = await prisma.videoAdAudit.findUnique({ where: { id: auditId }, select: { rawReportJson: true } });
  const existingAdContext = existingRow?.rawReportJson?._ad_context;
  await prisma.videoAdAudit.updateMany({
    where: { id: auditId, businessId },
    data: {
      overallScore: typeof report.overall_compliance_score === 'number' ? report.overall_compliance_score : undefined,
      verdict: typeof report.verdict === 'string' ? report.verdict : undefined,
      layersApplied: layers,
      rawReportJson: existingAdContext ? { ...report, _ad_context: existingAdContext } : report,
    },
  });
}

async function main() {
  const items = JSON.parse(require('fs').readFileSync('/app/audits_to_poll.json', 'utf8'));
  const pending = [];
  for (const it of items) {
    const row = await prisma.videoAdAudit.findUnique({ where: { id: it.auditId }, select: { verdict: true } });
    if (row && row.verdict !== null) continue; // sudah persisted sebelumnya -- skip
    pending.push(it);
  }

  if (pending.length === 0) {
    console.log('ALL_ALREADY_PERSISTED');
    await prisma.$disconnect();
    return;
  }

  const results = [];
  for (const it of pending) {
    try {
      const upstream = await fetch(`${METAGUARD_SERVICE_URL}/v1/audit/${encodeURIComponent(it.auditId)}`, {
        headers: metaguardHeaders(),
        signal: AbortSignal.timeout(15000),
      });
      if (upstream.status === 404) {
        results.push({ ...it, status: 'LOST_404' });
        continue;
      }
      const data = await upstream.json();
      if (data?.status === 'done' && data?.report) {
        await persistAuditReport(it.auditId, BUSINESS_ID, data.report);
        results.push({ ...it, status: 'DONE', verdict: data.report.verdict, score: data.report.overall_compliance_score });
      } else if (data?.status === 'error') {
        results.push({ ...it, status: 'ERROR', error: data.error });
      } else {
        results.push({ ...it, status: data?.status || 'unknown' });
      }
    } catch (e) {
      results.push({ ...it, status: 'FETCH_EXCEPTION', error: e.message });
    }
  }
  console.log('ROUND_RESULT=' + JSON.stringify(results));
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error('FATAL', e.message);
  await prisma.$disconnect();
  process.exit(1);
});
