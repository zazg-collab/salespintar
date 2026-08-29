/**
 * Poll metaguard_service GET /v1/audit/:auditId untuk daftar audit_id yang sudah disubmit
 * (reaudit_all.js), dan begitu status jadi "done", PERSIST hasilnya ke Postgres PERSIS
 * meniru logic production di backend/src/routes/video-guard.routes.js
 * (persistAndStripEvidence + persistAuditReport + parseLayers, di-porting baris-per-baris
 * dari dist/routes/video-guard.routes.js -- BUKAN reimplementasi dari ingatan) supaya tidak
 * ulang insiden sebelumnya (script polling lama cuma console.log, hasil 12 audit hilang
 * permanen begitu AUDIT_STATUS in-memory metaguard_service ke-reset oleh restart service).
 *
 * Berbeda dari insiden itu: script ini PERSIST KE DB SEGERA begitu status="done" terdeteksi
 * per-ad (bukan menunggu semua selesai dulu baru diproses), jadi kalau proses/koneksi ini
 * sendiri terputus di tengah jalan, ad yang SUDAH sempat "done" tetap aman tersimpan --
 * tinggal ad yang belum "done" saat itu yang perlu dicek ulang (lihat log JSONL yang ditulis
 * skrip ini, baris terakhir per auditId menunjukkan status akhirnya).
 */
const { PrismaClient } = require('@prisma/client');
const { env } = require('./dist/config/env');
const fs = require('fs');

const prisma = new PrismaClient();
const BUSINESS_ID = '777779f9-6955-4b0d-95cd-84595bb34eb4';
const METAGUARD_SERVICE_URL = env.METAGUARD_SERVICE_URL;
const LOG_PATH = '/app/poll_and_persist.jsonl';

function metaguardHeaders(extra) {
  const headers = { ...extra };
  if (env.METAGUARD_INTERNAL_API_KEY) {
    headers['X-Internal-Api-Key'] = env.METAGUARD_INTERNAL_API_KEY;
  }
  return headers;
}

// --- Ported PERSIS dari dist/routes/video-guard.routes.js (lihat komentar file itu) ---
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
        create: {
          auditId,
          violationId: String(v.id),
          evidenceType: String(evidence.evidence_type ?? 'video_frame'),
          frameJpeg,
          evidenceText: typeof evidence.evidence_text === 'string' ? evidence.evidence_text : null,
        },
        update: {
          evidenceType: String(evidence.evidence_type ?? 'video_frame'),
          frameJpeg,
          evidenceText: typeof evidence.evidence_text === 'string' ? evidence.evidence_text : null,
        },
      });
    } catch (e) {
      log({ event: 'evidence_persist_failed', auditId, violationId: v?.id, error: e.message });
    } finally {
      delete evidence.frame_jpeg_base64;
    }
  }
}

async function persistAuditReport(auditId, businessId, report) {
  try {
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
    return true;
  } catch (e) {
    log({ event: 'persist_failed', auditId, error: e.message });
    return false;
  }
}
// --- akhir bagian ported ---

function log(obj) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...obj });
  console.log(line);
  fs.appendFileSync(LOG_PATH, line + '\n');
}

async function pollOne(auditId, adId, adTitle, maxWaitMs) {
  const start = Date.now();
  const pollIntervalMs = 8000;
  while (Date.now() - start < maxWaitMs) {
    let data, upstream;
    try {
      upstream = await fetch(`${METAGUARD_SERVICE_URL}/v1/audit/${encodeURIComponent(auditId)}`, {
        headers: metaguardHeaders(),
        signal: AbortSignal.timeout(15000),
      });
      data = await upstream.json();
    } catch (e) {
      log({ event: 'poll_fetch_error', auditId, adId, error: e.message });
      await new Promise((r) => setTimeout(r, pollIntervalMs));
      continue;
    }

    if (upstream.status === 404) {
      log({ event: 'poll_404', auditId, adId, note: 'audit_id hilang dari AUDIT_STATUS in-memory (restart service?)' });
      return { auditId, adId, adTitle, outcome: 'LOST_404' };
    }

    if (data?.status === 'done' && data?.report) {
      const persisted = await persistAuditReport(auditId, BUSINESS_ID, data.report);
      log({
        event: 'done_persisted',
        auditId,
        adId,
        adTitle,
        verdict: data.report.verdict,
        score: data.report.overall_compliance_score,
        persisted,
        elapsedMs: Date.now() - start,
      });
      return {
        auditId,
        adId,
        adTitle,
        outcome: 'DONE',
        verdict: data.report.verdict,
        score: data.report.overall_compliance_score,
      };
    }

    if (data?.status === 'error') {
      log({ event: 'audit_error', auditId, adId, adTitle, error: data.error, elapsedMs: Date.now() - start });
      return { auditId, adId, adTitle, outcome: 'ERROR', error: data.error };
    }

    // status masih processing/queued -- lanjut poll
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }
  log({ event: 'poll_timeout', auditId, adId, adTitle, maxWaitMs });
  return { auditId, adId, adTitle, outcome: 'TIMEOUT' };
}

async function main() {
  const items = JSON.parse(fs.readFileSync('/app/audits_to_poll.json', 'utf8'));
  const maxWaitMs = 20 * 60 * 1000; // 20 menit per audit -- longgar dari budget agy (15 menit max)
  log({ event: 'start', count: items.length });

  const results = [];
  // Poll semua SEKALIGUS (concurrent) -- aman krn ini cuma polling GET ringan tiap 8 detik,
  // pemrosesan sungguhan di metaguard_service sendiri tetap serial (pool video-guard,
  // AGY_MAX_CONCURRENT=1) jadi tidak membebani agy sama sekali walau di-poll paralel di sini.
  await Promise.all(
    items.map(async (it) => {
      const r = await pollOne(it.auditId, it.adId, it.adTitle, maxWaitMs);
      results.push(r);
    })
  );

  log({ event: 'all_done', results });
  fs.writeFileSync('/app/poll_and_persist_final.json', JSON.stringify(results, null, 2));
  await prisma.$disconnect();
}

main().catch(async (e) => {
  log({ event: 'fatal', error: e.message, stack: e.stack });
  await prisma.$disconnect();
  process.exit(1);
});
