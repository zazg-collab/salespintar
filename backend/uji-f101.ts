/**
 * Uji perbaikan parser tujuan ongkir (Fase 101).
 * Memanggil jalur SUNGGUHAN: detectShippingIntent → getShippingQuotes → API Mengantar.
 * Tanpa LLM, jadi tidak memakai jatah token sama sekali.
 */
import { detectShippingIntent } from './src/utils/shipping-intent';
import { getShippingQuotes } from './src/services/mengantar.service';
import { redisCache, redisBull, waitForRedisReady } from './src/config/redis';
import { prisma } from './src/config/prisma';

const KASUS = [
  'order 1 golok sembelih kirim ke padang totalnya brp kak',
  'ongkir ke bandung brp',
  'ongkir ke padang brp ya buat 1 golok',
  'kirim ke bandar lampung totalnya berapa',
  'ongkir 2 pcs ke medan brp',
  'kirim ke jayapura ongkirnya brp',
];

async function main() {
  await waitForRedisReady(redisCache, 'cache');
  let lulus = 0, gagal = 0;
  for (const teks of KASUS) {
    const intent = detectShippingIntent(teks);
    const kw = intent?.destinationKeyword ?? '(null)';
    let hasil = 'TIDAK DIPANGGIL';
    if (intent?.destinationKeyword) {
      const q = await getShippingQuotes({ destinationKeyword: intent.destinationKeyword });
      if (!q) hasil = 'NULL (tarif tidak didapat)';
      else if ('ambiguous' in q && q.ambiguous) hasil = `AMBIGU → bertanya: ${q.question}`;
      else if ('quotes' in q) hasil = `${q.destinationLabel} — ${q.quotes.slice(0,2).map(x => `${x.courier} Rp${x.price.toLocaleString('id-ID')}`).join(', ')}`;
      else hasil = JSON.stringify(q);
    }
    const ok = hasil !== 'NULL (tarif tidak didapat)' && hasil !== 'TIDAK DIPANGGIL';
    ok ? lulus++ : gagal++;
    console.log(`${ok ? 'OK  ' : 'GAGAL'} "${teks}"\n      kata kunci: "${kw}"\n      hasil: ${hasil}`);
  }
  console.log(`\n${lulus} dapat tarif, ${gagal} tidak.`);
  await Promise.allSettled([redisCache.quit(), redisBull.quit(), prisma.$disconnect()]);
}
main().catch(e => { console.error(e); process.exit(1); });
