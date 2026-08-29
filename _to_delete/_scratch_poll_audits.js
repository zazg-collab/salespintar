const { env } = require('./dist/config/env');

const METAGUARD_SERVICE_URL = env.METAGUARD_SERVICE_URL;
const METAGUARD_INTERNAL_API_KEY = env.METAGUARD_INTERNAL_API_KEY;

const AUDIT_MAP = {
  aud_d6ff861411c14a3a95c714f281da994e: '120209304058950301',
  aud_c3aa4f849f5a4031a535bdc6b1a09c78: '52592630566093',
  aud_df06bc7face64a628fc7886bad04a26a: '120243827277270461',
  aud_d69fb1d9058c4db4aca4edcef778e9b5: '120240876189420395',
  aud_2e7146f6646a479383381945c94a1c70: '120245204102690711',
  aud_7e5f6183cc584d4cab048b87c7c8167a: '120245140618480711',
  aud_1996e8dd9afa4191b1706acbe0526aee: '120245204179120711',
  aud_2bf634d315394d428d9d8d4430ce2d01: '120243259966490420',
  aud_6181ff4a5b2541bc95bc57919666c068: '120203635137710420',
  aud_e6574bcd61a34d769f03294f020c0d97: '120203635105600420',
  aud_d22602f162844b9b9930ac309aea5fc1: '120203635089210420',
  aud_fed328d315794055894feb93fabc6ef6: '120203424393800420',
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function checkOne(auditId) {
  const resp = await fetch(`${METAGUARD_SERVICE_URL}/v1/audit/${auditId}`, {
    headers: { 'X-Internal-Api-Key': METAGUARD_INTERNAL_API_KEY },
    signal: AbortSignal.timeout(15000),
  });
  if (!resp.ok) return { auditId, status: 'HTTP_ERROR_' + resp.status };
  const data = await resp.json();
  return {
    auditId,
    status: data.status || 'unknown',
    verdict: data.verdict || data.report?.verdict || null,
    overallScore: data.overall_score ?? data.report?.overall_score ?? null,
    error: data.error || null,
  };
}

async function main() {
  const auditIds = Object.keys(AUDIT_MAP);
  const maxAttempts = 20;
  const intervalMs = 20000;
  const done = new Map();

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const pending = auditIds.filter((id) => !done.has(id));
    if (pending.length === 0) break;

    const results = await Promise.all(pending.map(checkOne));
    for (const r of results) {
      if (r.status === 'done' || r.status === 'completed' || r.status === 'error' || r.status.startsWith('HTTP_ERROR')) {
        done.set(r.auditId, r);
      }
    }
    console.log(
      `ATTEMPT=${attempt} DONE=${done.size}/${auditIds.length} ` +
        JSON.stringify(results.map((r) => ({ adId: AUDIT_MAP[r.auditId], status: r.status })))
    );
    if (done.size === auditIds.length) break;
    await sleep(intervalMs);
  }

  const final = auditIds.map((id) => {
    const r = done.get(id) || { auditId: id, status: 'TIMEOUT_STILL_PENDING' };
    return { adId: AUDIT_MAP[id], auditId: id, status: r.status, verdict: r.verdict, overallScore: r.overallScore, error: r.error };
  });
  console.log('FINAL=' + JSON.stringify(final, null, 2));
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
