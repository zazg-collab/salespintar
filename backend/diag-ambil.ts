/**
 * Diagnostik pengambilan pengetahuan — GRATIS (embedding lokal, tanpa LLM).
 * Untuk tiap pertanyaan: cetak dokumen apa saja yang benar-benar terambil.
 * Tanpa ini, "kenapa bot tidak tahu" cuma tebakan.
 */
import { env } from './src/config/env';
import { prisma } from './src/config/prisma';
import { redisCache, redisBull, waitForRedisReady } from './src/config/redis';
import { knowledgeService } from './src/services/knowledge.service';

const TANYA = process.argv.slice(2).filter(a => !a.startsWith('--'));

async function main() {
  await waitForRedisReady(redisCache, 'cache');
  const b = await prisma.business.findFirst({ where: { isActive: true } });
  if (!b) throw new Error('tidak ada business aktif');
  console.log(`TOP_K=${env.KNOWLEDGE_TOP_K}  MAX_CHARS=${env.KNOWLEDGE_CONTEXT_MAX_CHARS}\n`);
  for (const q of TANYA) {
    const docs = await knowledgeService.searchRelevantKnowledge(b.id, q, env.KNOWLEDGE_TOP_K);
    console.log(`\n=== "${q}"  → ${docs.length} potongan`);
    let pakai = 0, n = 0;
    for (const d of docs) {
      const judul = d.split('\n')[0]!.slice(0, 70);
      const muat = pakai + d.length <= env.KNOWLEDGE_CONTEXT_MAX_CHARS;
      if (muat) { pakai += d.length; n++; }
      console.log(`  ${muat ? 'DIPAKAI ' : 'DIBUANG '} [${String(d.length).padStart(4)}] ${judul}`);
    }
    console.log(`  → ${n} potongan sampai ke model (${pakai} char)`);
  }
  await Promise.allSettled([redisCache.quit(), redisBull.quit(), prisma.$disconnect()]);
}
main().catch(e => { console.error(e); process.exit(1); });
