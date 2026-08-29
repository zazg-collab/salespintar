/** Uji dua perbaikan Fase 104, tanpa LLM. */
import { pisahkanPenanda } from './src/services/katalog-gambar.service';
import { detectShippingIntent } from './src/utils/shipping-intent';

let lulus = 0, gagal = 0;
function cek(nama: string, dapat: unknown, harap: unknown) {
  const ok = JSON.stringify(dapat) === JSON.stringify(harap);
  ok ? lulus++ : gagal++;
  console.log(`${ok ? 'OK   ' : 'GAGAL'} ${nama}\n        dapat=${JSON.stringify(dapat)}${ok ? '' : `\n        harap=${JSON.stringify(harap)}`}`);
}

// ── penanda ────────────────────────────────────────────────────────────────
cek('bentuk resmi', pisahkanPenanda('Ini fotonya Kak.\n{{kirim-gambar: bedog-betekok}}'),
    { teksBersih: 'Ini fotonya Kak.', diminta: ['bedog-betekok'] });
cek('tanpa kurung kurawal (kejadian nyata FOT-06)', pisahkanPenanda('Mau lihat foto Golok Naga?\nkirim-gambar:golok-naga'),
    { teksBersih: 'Mau lihat foto Golok Naga?', diminta: ['golok-naga'] });
cek('tanpa kurung, ada spasi', pisahkanPenanda('Ini ya Kak\n  kirim-gambar : golok-zambia-40  '),
    { teksBersih: 'Ini ya Kak', diminta: ['golok-zambia-40'] });
// Bentuk BERSPASI adalah bahasa Indonesia wajar dan TIDAK boleh disentuh.
cek('"kirim gambar" berspasi TIDAK dimakan', pisahkanPenanda('Nanti saya kirim gambar ya Kak kalau sudah siap'),
    { teksBersih: 'Nanti saya kirim gambar ya Kak kalau sudah siap', diminta: [] });
// Kejadian nyata 2 Agustus: penanda karangan berisi URL, menempel di tengah baris sapaan.
cek('penanda URL di tengah baris (kejadian nyata sapaan)',
    pisahkanPenanda('Selamat datang! Ada yang bisa saya bantu? Kirim-gambar: https://salespintar.id/foto-produk/12345.jpg'),
    { teksBersih: 'Selamat datang! Ada yang bisa saya bantu?', diminta: [] });
cek('penanda sah di tengah baris tetap dicatat',
    pisahkanPenanda('Ini fotonya Kak kirim-gambar:bedog-betekok'),
    { teksBersih: 'Ini fotonya Kak', diminta: ['bedog-betekok'] });
cek('kalimat sesudah penanga tidak ikut terhapus',
    pisahkanPenanda('Ini ya Kak kirim-gambar:golok-naga silakan dilihat dulu'),
    { teksBersih: 'Ini ya Kak silakan dilihat dulu', diminta: ['golok-naga'] });
cek('kata sendirian tanpa nama (kejadian nyata FOT-01)', pisahkanPenanda('Tentu, produknya ada dan saya bisa bantu.\nkirim-gambar'),
    { teksBersih: 'Tentu, produknya ada dan saya bisa bantu.', diminta: [] });
cek('kata sendirian + titik dua kosong', pisahkanPenanda('Ini ya Kak\nkirim-gambar:'),
    { teksBersih: 'Ini ya Kak', diminta: [] });
cek('dua-duanya sekaligus', pisahkanPenanda('A\n{{kirim-gambar: satu}}\nB\nkirim-gambar: dua'),
    { teksBersih: 'A\n\nB', diminta: ['satu', 'dua'] });

// ── niat ongkir ────────────────────────────────────────────────────────────
// Kata kuncinya memang keluar kotor ("bandung total") — itu DISENGAJA sejak
// Fase 101: yang membereskan sisa kalimat adalah `getShippingQuotes()`, bukan
// `extractDestination()`. Jadi yang diuji di sini jalur PENUHnya sampai tarif
// sungguhan, bukan bentuk kata kuncinya. Menguji bentuk kata kunci berarti
// mengunci rincian yang sengaja dibiarkan longgar.
cek('COD-02 niat TERDETEKSI (dulu null)', detectShippingIntent('golok sembelih multifungsi cod ke bandung total brp') !== null, true);
cek('totalnya berapa + kota TERDETEKSI', detectShippingIntent('order 1 golok kirim ke padang totalnya berapa') !== null, true);
cek('dikirim ke', detectShippingIntent('kalau dikirim ke medan berapa')?.destinationKeyword, 'medan');
cek('yang lama tetap jalan', detectShippingIntent('ongkir ke bandung brp')?.destinationKeyword, 'bandung');
cek('"total brp" TANPA kota → jangan panggil API', detectShippingIntent('totalnya berapa kak'), null);
cek('kalimat biasa → bukan ongkir', detectShippingIntent('bagusan mana kak'), null);

// ── jalur penuh sampai tarif sungguhan ─────────────────────────────────────
// Dibungkus fungsi: tsx menyalurkan berkas ini lewat esbuild dengan keluaran
// CommonJS, dan `await` di tingkat atas ditolak di sana.
async function jalurPenuh() {
  const { getShippingQuotes } = await import('./src/services/mengantar.service');
  const { redisCache, redisBull, waitForRedisReady } = await import('./src/config/redis');
  const { prisma } = await import('./src/config/prisma');
  await waitForRedisReady(redisCache, 'cache');
  const kasus: Array<[string, string]> = [
    ['COD-02 dapat tarif nyata', 'golok sembelih multifungsi cod ke bandung total brp'],
    ['padang totalnya dapat tarif nyata', 'order 1 golok kirim ke padang totalnya berapa'],
  ];
  for (const [nama, teks] of kasus) {
    const i2 = detectShippingIntent(teks);
    const q = i2?.destinationKeyword ? await getShippingQuotes({ destinationKeyword: i2.destinationKeyword }) : null;
    const ringkas = !q ? 'NULL'
      : ('ambiguous' in q && q.ambiguous ? `AMBIGU: ${q.question}`
      : ('quotes' in q ? `${q.destinationLabel} — ${q.quotes[0]!.courier} Rp${q.quotes[0]!.price}` : JSON.stringify(q)));
    const ok = ringkas !== 'NULL';
    ok ? lulus++ : gagal++;
    console.log(`${ok ? 'OK   ' : 'GAGAL'} ${nama}\n        ${ringkas}`);
  }
  await Promise.allSettled([redisCache.quit(), redisBull.quit(), prisma.$disconnect()]);
  console.log(`\n${lulus} lulus, ${gagal} gagal.`);
  process.exit(gagal > 0 ? 1 : 0);
}
jalurPenuh().catch(e => { console.error(e); process.exit(1); });
