/** Uji provider gutstore lewat cangkang complete() sendiri, bukan curl mentah. */
import { complete, resolveModelSpec } from './src/services/llm';
import { redisCache, redisBull, waitForRedisReady } from './src/config/redis';
import { prisma } from './src/config/prisma';

const MODEL = process.argv[2] ?? 'gutstore:claude-haiku-4.5';
async function main() {
  await waitForRedisReady(redisCache, 'cache');
  console.log(`bawaan job audit : ${resolveModelSpec('audit')}`);
  console.log(`yang diuji       : ${MODEL}`);
  const t = Date.now();
  try {
    const r = await complete('audit', {
      model: MODEL,
      messages: [{ role: 'user', content: 'Balas persis satu kata: SIAP' }],
    });
    console.log(`LULUS ${Date.now()-t}ms | provider=${r.provider} model=${r.model} in=${r.promptTokens} out=${r.completionTokens}`);
    console.log(`jawaban: ${JSON.stringify((r.text ?? '').slice(0,80))}`);
  } catch (e) {
    console.log(`GAGAL ${Date.now()-t}ms | ${e instanceof Error ? e.message.slice(0,220) : e}`);
  }
  await Promise.allSettled([redisCache.quit(), redisBull.quit(), prisma.$disconnect()]);
}
main().catch(e => { console.error(e); process.exit(1); });
