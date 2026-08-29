const { PrismaClient } = require('@prisma/client');
const { decrypt } = require('./dist/services/crypto.service');
const { env } = require('./dist/config/env');
const prisma = new PrismaClient();

const BUSINESS_ID = '777779f9-6955-4b0d-95cd-84595bb34eb4';

async function main() {
  const business = await prisma.business.findUnique({ where: { id: BUSINESS_ID }, select: { settings: true } });
  const settings = business?.settings || {};
  const encrypted = settings.metaGuardGeminiApiKeyEncrypted;
  if (!encrypted) {
    console.log('NO_KEY_CONFIGURED');
    await prisma.$disconnect();
    return;
  }
  const geminiKey = decrypt(encrypted);

  const resp = await fetch(`${env.METAGUARD_SERVICE_URL}/v1/copywriting/check`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Internal-Api-Key': env.METAGUARD_INTERNAL_API_KEY,
      'X-Gemini-Api-Key': geminiKey,
    },
    body: JSON.stringify({ headline: 'Diskon 90% hari ini saja, dijamin awet 10 tahun!' }),
    signal: AbortSignal.timeout(30000),
  });
  const data = await resp.json();
  console.log('HTTP_STATUS=' + resp.status);
  console.log('BODY=' + JSON.stringify(data));
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error('FATAL', e.message);
  await prisma.$disconnect();
  process.exit(1);
});
