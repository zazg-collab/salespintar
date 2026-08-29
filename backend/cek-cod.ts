/**
 * Memeriksa dua hal soal COD yang sekarang jadi mendesak, karena 90 persen
 * pesanan toko ini dibayar COD.
 *
 * ── Yang diperiksa 1: margin ongkir per ekspedisi ───────────────────────────
 * Pelanggan dikutip `estimatedPrice`; toko membayar `estimatedSpecialPrice` ke
 * Mengantar. Selisihnya margin pemilik toko.
 *
 * Skrip ini menampilkan keduanya berdampingan supaya marginnya kelihatan sebagai
 * angka, dan supaya kalau suatu hari diskon akun berubah, itu terlihat di sini
 * lebih dulu — bukan nanti waktu penghasilan terasa menyusut tanpa sebab.
 *
 * CATATAN: Mengantar TIDAK memberitahukan biaya layanan COD lewat API ini. Jadi
 * selisih `estimatedPrice` dengan `estimatedSpecialPrice` BUKAN biaya COD —
 * itu diskon akun. (Anotasi saya sebelumnya menyebut itu biaya COD; salah, dan
 * dikoreksi Angga 30 Juli 2026.)
 *
 * ── Risiko 2: data "ekspedisi ini tidak melayani COD di sini" diabaikan ─────
 * Baris alamat Mengantar memuat field seperti `unsupportedCod`,
 * `unsupportedCodJT`, `unsupportedCodSi`, `unsupportedCodNinja`, dan seterusnya.
 * Artinya API SUDAH memberi tahu ekspedisi mana yang tidak bisa COD untuk
 * tujuan itu — dan kode kita tidak membacanya sama sekali.
 *
 * Untuk toko yang 90 persen COD, mengutip ekspedisi yang tidak bisa COD di
 * daerah itu berarti pelanggan memilih, menunggu, lalu pesanannya batal di
 * langkah terakhir.
 *
 * Kunci API tidak pernah dicetak ke layar.
 *
 * Pakai:
 *   npx tsx cek-cod.ts                 # tujuan bawaan: jakarta
 *   npx tsx cek-cod.ts bandung
 *   npx tsx cek-cod.ts "kota surabaya"
 */

import { env } from './src/config/env';
import { redisCache, redisBull, waitForRedisReady } from './src/config/redis';
import { prisma } from './src/config/prisma';
import { collectCandidates, prettyPlace, type LocationRow } from './src/utils/location-resolver';
import { __PETA_COD, __namaEkspedisi, __statusCod } from './src/services/mengantar.service';
import { lookupAlias } from './src/utils/place-aliases';

const TUJUAN = process.argv.slice(2).filter(a => !a.startsWith('--'))[0] ?? 'jakarta';

function judul(t: string) {
  console.log(`\n${'─'.repeat(74)}\n${t}\n${'─'.repeat(74)}`);
}

const base = () => env.MENGANTAR_BASE_URL!.replace(/\/+$/, '');
const jalur = (p: string) => `${base()}/api/public/${env.MENGANTAR_API_KEY}${p}`;

async function ambil(p: string): Promise<any> {
  const res = await fetch(jalur(p), { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = await res.json();
  return (j as any)?.data ?? j;
}

async function tutup() {
  await Promise.allSettled([redisCache.quit(), redisBull.quit(), prisma.$disconnect()]);
}

async function main() {
  await waitForRedisReady(redisCache, 'cache');

  if (!env.MENGANTAR_API_KEY) {
    console.error('MENGANTAR_API_KEY belum diisi.');
    await tutup();
    process.exit(1);
  }

  judul(`Tujuan yang diuji: "${TUJUAN}"`);

  const alias = lookupAlias(TUJUAN);
  const kunci = alias?.query ?? TUJUAN;
  const rows = (await ambil(`/address/search?keyword=${encodeURIComponent(kunci)}`)) as LocationRow[];
  const kandidat = collectCandidates(rows, kunci, alias?.expect);
  if (kandidat.length === 0) {
    console.error('Tujuan tidak ketemu.');
    await tutup();
    process.exit(1);
  }
  const pilih = kandidat[0]!;
  const destId = (pilih.row as any)._id;
  console.log(`Dipakai: ${prettyPlace(pilih.cityLabel)}, ${prettyPlace(pilih.province)}`);

  // ── Bagian 1: apa saja field COD di baris alamat ini ──────────────────────
  judul('1. Apa kata data alamat soal COD di daerah ini');
  const baris = pilih.row as Record<string, any>;
  const fieldCod = Object.keys(baris).filter(k => /cod/i.test(k)).sort();
  if (fieldCod.length === 0) {
    console.log('Tidak ada field bernama COD di baris alamat ini.');
  } else {
    console.log(`${fieldCod.length} field terkait COD ditemukan:\n`);
    for (const k of fieldCod) {
      const v = baris[k];
      const tak = v === true || v === 'true' || v === 1;
      console.log(`  ${tak ? '✗ TIDAK BISA COD' : '  bisa COD    '}  ${k} = ${JSON.stringify(v)}`);
    }
    const terlarang = fieldCod.filter(k => {
      const v = baris[k];
      return v === true || v === 'true' || v === 1;
    });
    console.log('');
    if (terlarang.length > 0) {
      console.log(`⚠️  ${terlarang.length} penanda menyatakan ADA ekspedisi yang tidak bisa COD di sini.`);
      console.log(`    Kode kita saat ini TIDAK membaca satu pun field ini — jadi ekspedisi yang`);
      console.log(`    tidak bisa COD tetap dikutip ke pelanggan seolah bisa.`);
    } else {
      console.log(`Semua penanda bernilai "bisa" untuk daerah ini. Belum tentu berlaku di daerah lain —`);
      console.log(`coba beberapa tujuan sebelum menyimpulkan.`);
    }
  }

  // ── Bagian 1b: AUDIT PETA — bagian yang paling perlu dibuktikan ───────────
  //
  // Yang diperiksa di sini bukan datanya, melainkan TAFSIRAN kita atas nama
  // field-nya. Tiga cara peta ini bisa salah, dan ketiganya kelihatan di bawah:
  //
  //   1. Ada kurir yang dikutip ke pelanggan tapi tidak punya padanan field
  //      → statusnya "belum diketahui" selamanya, dan pelanggan tidak pernah
  //        ditawari kurir itu untuk COD walau sebenarnya bisa.
  //   2. Ada field COD di data yang tidak dipakai satu pun kurir
  //      → kemungkinan nama kurirnya belum dikenali, jadi jawabannya terbuang.
  //   3. Peta menunjuk field yang tidak ada sama sekali di baris alamat
  //      → salah tulis nama field; hasilnya "belum diketahui" tanpa sebab jelas.
  judul('1b. Audit peta: apakah tafsiran nama field kita benar');

  const semuaFieldCod = new Set(fieldCod);
  const dipakaiPeta = new Set<string>();
  for (const fs of Object.values(__PETA_COD)) for (const f of fs) dipakaiPeta.add(f);

  // Kurir apa saja yang sungguh dikutip untuk tujuan ini?
  let kurirNyata: string[] = [];
  try {
    const qq = `origin_id=${encodeURIComponent(env.MENGANTAR_ORIGIN_ID ?? '')}&destination_id=${encodeURIComponent(destId)}&weight=1`;
    const e = await ambil(`/order/estimate?${qq}&courier=all`);
    kurirNyata = Object.entries(e as Record<string, any>)
      .filter(([k, v]) => !['success', 'message', 'status', 'data', 'result'].includes(k) && v && typeof v === 'object' && !v.unsupported)
      .map(([k]) => k);
  } catch { /* dilaporkan di bagian 2 */ }

  if (kurirNyata.length > 0) {
    console.log('Kurir yang dikutip untuk tujuan ini, beserta field yang dipakai menilainya:\n');
    console.log('  kunci API        nama tampilan          field yang dipakai              status');
    console.log('  ' + '-'.repeat(84));
    const tanpaField: string[] = [];
    for (const k of kurirNyata) {
      const nama = __namaEkspedisi(k);
      const fs = __PETA_COD[nama] ?? [];
      const st = __statusCod(pilih.row, nama);
      if (fs.length === 0) tanpaField.push(`${k} → "${nama}"`);
      console.log(
        `  ${k.padEnd(16)} ${nama.padEnd(22)} ${(fs.join(', ') || '(tidak ada)').padEnd(31)} ${st}`,
      );
    }
    console.log('');
    if (tanpaField.length > 0) {
      console.log(`⚠️  ${tanpaField.length} kurir tanpa padanan field COD: ${tanpaField.join(', ')}`);
      console.log(`    Untuk JNE ini SUDAH DIKETAHUI dan benar — data alamat memang tidak punya`);
      console.log(`    "unsupportedCodJNE". Untuk nama lain, berarti peta perlu ditambah.`);
    } else {
      console.log('Semua kurir yang dikutip punya padanan field.');
    }
  }

  // Field COD yang ada di data tapi tidak dipakai peta.
  const yatim = [...semuaFieldCod].filter(f => !dipakaiPeta.has(f));
  if (yatim.length > 0) {
    console.log(`\n⚠️  ${yatim.length} field COD ada di data tapi TIDAK dipakai peta mana pun:`);
    for (const f of yatim) console.log(`      ${f} = ${JSON.stringify((pilih.row as Record<string, unknown>)[f])}`);
    console.log(`    Kalau salah satunya milik kurir yang sungguh dipakai toko, jawabannya`);
    console.log(`    sedang terbuang percuma.`);
  }

  // Peta menunjuk field yang tidak ada di baris alamat.
  const hantu = [...dipakaiPeta].filter(f => !(f in (pilih.row as Record<string, unknown>)));
  if (hantu.length > 0) {
    console.log(`\n⚠️  Peta menunjuk ${hantu.length} field yang TIDAK ADA di baris alamat ini:`);
    for (const f of hantu) console.log(`      ${f}`);
    console.log(`    Bisa berarti salah tulis nama field, atau field itu memang cuma muncul`);
    console.log(`    di sebagian daerah. Coba beberapa tujuan sebelum menyimpulkan.`);
  }

  // ── Bagian 2: apakah harga yang kita kutip memuat biaya COD ───────────────
  judul('2. Margin ongkir: yang dikutip ke pelanggan vs yang dibayar toko');
  const q = `origin_id=${encodeURIComponent(env.MENGANTAR_ORIGIN_ID ?? '')}&destination_id=${encodeURIComponent(destId)}&weight=1`;
  let est: any = null;
  try {
    est = await ambil(`/order/estimate?${q}&courier=all`);
  } catch (err) {
    console.log(`Gagal mengambil estimasi: ${err instanceof Error ? err.message : err}`);
  }

  if (est && typeof est === 'object') {
    console.log('estimatedPrice = dikutip ke pelanggan. estimatedSpecialPrice = biaya toko.\n');
    console.log('  ekspedisi        price   DIKUTIP  biayaToko   MARGIN   diskon+ekstra');
    console.log('  ' + '-'.repeat(72));
    let totalMargin = 0;
    let tanpaMargin: string[] = [];
    for (const [nama, d] of Object.entries(est) as Array<[string, any]>) {
      if (['success', 'message', 'status', 'data', 'result'].includes(nama)) continue;
      if (!d || typeof d !== 'object' || d.unsupported) continue;
      const p = d.price ?? 0;
      const kutip = d.estimatedPrice ?? d.price ?? 0;
      const biaya = d.estimatedSpecialPrice ?? 0;
      const margin = biaya > 0 ? kutip - biaya : 0;
      const dis = (d.discount ?? 0) + (d.discountExtra ?? 0);
      if (biaya > 0) totalMargin += margin;
      if (biaya > 0 && margin <= 0) tanpaMargin.push(nama);
      console.log(
        `  ${nama.padEnd(16)} ${String(p).padStart(6)} ${String(kutip).padStart(8)} ` +
        `${String(biaya).padStart(10)} ${String(margin).padStart(8)} ${String(dis).padStart(14)}`,
      );
    }
    console.log('');
    if (tanpaMargin.length > 0) {
      console.log(`⚠️  ${tanpaMargin.length} ekspedisi TIDAK memberi margin: ${tanpaMargin.join(', ')}`);
      console.log(`    Untuk ekspedisi itu, harga kutipan sama dengan biaya toko — tidak ada`);
      console.log(`    selisih diskon yang bisa diambil. Bukan kerusakan, tapi perlu diketahui`);
      console.log(`    kalau salah satunya jadi yang termurah dan paling sering dipilih.`);
    } else {
      console.log(`Semua ekspedisi memberi margin. Total selisih pada berat & tujuan ini:`);
      console.log(`Rp ${totalMargin.toLocaleString('id-ID')} tersebar di seluruh pilihan.`);
    }

    // Aritmetika yang bisa diperiksa sendiri, supaya kesimpulannya bukan tebakan.
    judul('3. Uji aritmetika: memastikan angkanya memang berpasangan seperti dugaan');
    for (const [nama, d] of Object.entries(est).slice(0, 4) as Array<[string, any]>) {
      if (!d || typeof d !== 'object' || d.unsupported) continue;
      const p = d.price ?? 0, ep = d.estimatedPrice ?? 0, sp = d.estimatedSpecialPrice ?? 0;
      const dis = d.discount ?? 0, de = d.discountExtra ?? 0;
      const dariPrice = p - dis - de;
      const dariEstimated = ep - dis - de;
      console.log(`\n  ${nama}: bot mengutip ${sp}`);
      console.log(`    price - diskon - ekstra          = ${dariPrice}${dariPrice === sp ? '   ← COCOK' : ''}`);
      console.log(`    estimatedPrice - diskon - ekstra = ${dariEstimated}${dariEstimated === sp ? '   ← COCOK' : ''}`);
      if (dariPrice !== sp && dariEstimated !== sp) {
        console.log(`    (dua-duanya tidak cocok — ada komponen lain yang belum kita pahami)`);
      }
    }
  }

  console.log('');
  await tutup();
}

main().catch(async err => {
  console.error('\nGagal:', err);
  await tutup();
  process.exit(1);
});
