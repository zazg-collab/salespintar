/**
 * Uji sambungan ongkir Mengantar — bukan bagian aplikasi, aman dihapus.
 *
 *     npx tsx uji-ongkir.ts                        (bandung → jakarta, tebak kode)
 *     npx tsx uji-ongkir.ts <origin_id> <dest_id>            (kode dipasang langsung)
 *     npx tsx uji-ongkir.ts <origin_id> <dest_id> 2          (sekalian beratnya)
 *     npx tsx uji-ongkir.ts "" "" 1 surabaya                 (ganti kota tujuan)
 *
 * Kode yang dimaksud adalah _id rekaman alamat (mis. 5fc62f5df8f44b34aa4c0d8c),
 * BUKAN ORIGIN_CODE seperti "TGR10000". Pakai `uji-lokasi.ts` untuk mencarinya.
 *
 * Kalau kode asal/tujuan diberikan langsung, pencarian lokasi dilewati —
 * berguna untuk memisahkan "kodenya salah" dari "endpoint-nya bermasalah".
 */

import { env } from './src/config/env';

const KEY = env.MENGANTAR_API_KEY;
const BASE = env.MENGANTAR_BASE_URL.replace(/\/+$/, '');

const argOrigin = process.argv[2];
const argDest = process.argv[3];
const argWeight = process.argv[4] ? Number(process.argv[4]) : 1;
/** Kota tujuan untuk diuji. Argumen ke-5, kalau kode tujuan tidak diberi langsung. */
const destKeyword = process.argv[5] || 'jakarta';

const aman = (url: string) => url.replace(KEY ?? '__none__', '<KUNCI>');

function potong(obj: unknown, maks = 1500): string {
  const s = JSON.stringify(obj, null, 2);
  return s.length > maks ? s.slice(0, maks) + `\n   ... (${s.length} karakter total)` : s;
}

/**
 * ID rekaman alamat — INI yang dipakai sebagai origin_id / destination_id.
 *
 * BUKAN ORIGIN_CODE / DESTINATION_CODE. Kode seperti "TGR10000" dan "CGK10302"
 * terlihat persis seperti pengenal lokasi dan itulah jebakannya: dikirim ke
 * endpoint tarif, hasilnya HTTP 404 tanpa penjelasan apa pun.
 */
function idAlamat(r: any): string {
  return String(r?._id ?? r?.id ?? '');
}

function unwrapArray(res: any): any[] {
  if (Array.isArray(res)) return res;
  if (Array.isArray(res?.data)) return res.data;
  if (Array.isArray(res?.result)) return res.result;
  return [];
}

async function ambil(path: string): Promise<{ status: number; body: any }> {
  const url = `${BASE}/api/public/${KEY}${path}`;
  console.log(`\n→ GET ${aman(url)}`);
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  const text = await res.text();
  console.log(`  HTTP ${res.status} ${res.statusText}`);
  try {
    return { status: res.status, body: JSON.parse(text) };
  } catch {
    console.log('  Balasan BUKAN JSON: ' + text.slice(0, 300));
    return { status: res.status, body: null };
  }
}

async function main() {
  console.log('═══ Uji sambungan ongkir Mengantar ═══');
  if (!KEY) { console.log('\n✗ MENGANTAR_API_KEY belum ada di backend/.env'); process.exit(1); }

  console.log(`\nBase URL : ${BASE}`);
  console.log(`Kunci    : ${KEY.slice(0, 4)}...${KEY.slice(-4)} (${KEY.length} karakter)`);

  let originId = argOrigin || env.MENGANTAR_ORIGIN_ID || '';
  let destId = argDest || '';

  // ── 1. Cari kode kalau belum diberikan ───────────────────────────────────
  if (!originId || !destId) {
    console.log('\n\n─── 1. Pencarian lokasi ───');

    if (!originId) {
      const kw = env.MENGANTAR_ORIGIN_KEYWORD || 'bandung';
      const r = await ambil(`/address/search?keyword=${encodeURIComponent(kw)}`);
      const rows = unwrapArray(r.body);
      console.log(`  "${kw}" → ${rows.length} baris`);
      if (rows[0]) {
        console.log('  field:', Object.keys(rows[0]).join(', '));
        console.log('  baris pertama:', potong(rows[0], 500));
        originId = idAlamat(rows[0]);
      }
    }

    if (!destId) {
      const r = await ambil(`/address/search?keyword=${encodeURIComponent(destKeyword)}`);
      const rows = unwrapArray(r.body);
      console.log(`  "${destKeyword}" → ${rows.length} baris`);
      if (rows[0]) {
        console.log('  baris pertama:', potong(rows[0], 500));
        destId = idAlamat(rows[0]);
      }
    }
  }

  console.log(`\nORIGIN dipakai : ${originId || '✗ KOSONG'}`);
  console.log(`DEST   dipakai : ${destId || '✗ KOSONG'}`);
  console.log(`Berat          : ${argWeight} kg`);

  if (!originId || !destId) {
    console.log('\n✗ Kode belum lengkap. Pakai `npx tsx uji-lokasi.ts <kota>` untuk mencarinya,');
    console.log('  lalu jalankan ulang: npx tsx uji-ongkir.ts <ORIGIN> <DEST>');
    process.exit(1);
  }

  // ── 2. Coba KETIGA endpoint tarif ────────────────────────────────────────
  // Dicoba semuanya sekaligus supaya ketahuan apakah 404 tadi berarti
  // "alamat endpoint-nya salah" atau "kode lokasinya yang tidak cocok".
  // Kalau ketiganya 404 → alamatnya. Kalau ada yang berhasil → kodenya.
  console.log('\n\n─── 2. Menguji ketiga endpoint tarif ───');

  const q = `origin_id=${encodeURIComponent(originId)}&destination_id=${encodeURIComponent(destId)}&weight=${argWeight}`;
  const kandidat = [
    ['allEstimatePublic', `/order/allEstimatePublic?${q}`],
    ['allEstimate3PL', `/order/allEstimate3PL?${q}`],
    ['estimate (courier=all)', `/order/estimate?${q}&courier=all`],
  ] as const;

  let berhasil: { nama: string; body: any } | null = null;

  for (const [nama, path] of kandidat) {
    const r = await ambil(path);
    if (r.status === 200 && r.body && r.body.success !== false) {
      console.log(`  ✓ ${nama} BERHASIL`);
      console.log(potong(r.body, 2000));
      if (!berhasil) berhasil = { nama, body: r.body };
    } else {
      console.log(`  ✗ ${nama} → ${potong(r.body, 200)}`);
    }
  }

  if (!berhasil) {
    console.log('\n✗ Ketiga endpoint menolak.');
    console.log('  Kalau semuanya 404, kemungkinan besar alamat endpoint-nya memang berbeda');
    console.log('  dari dokumentasi, ATAU kunci ini belum diberi izin untuk cek tarif.');
    console.log('  Tanyakan ke pihak Mengantar: alamat persis endpoint cek ongkir untuk kunci publik.');
    process.exit(1);
  }

  // ── 3. Lewat kode aplikasi ───────────────────────────────────────────────
  console.log(`\n\n─── 3. Lewat kode aplikasi (endpoint yang dipakai: allEstimatePublic) ───`);
  const { getShippingQuotes, quotesToKnowledgeChunk } = await import('./src/services/mengantar.service');
  const hasil = await getShippingQuotes({ destinationKeyword: destKeyword, weightKg: argWeight });

  if (!hasil) {
    console.log('\n✗ getShippingQuotes mengembalikan null.');
    console.log(`  Padahal endpoint "${berhasil.nama}" berhasil di bagian 2.`);
    console.log('  Kalau yang berhasil BUKAN allEstimatePublic, itu sebabnya — beri tahu saya');
    console.log('  endpoint mana yang jalan, nanti saya ganti di kodenya.');
    process.exit(1);
  }

  console.log(`\n✓ Tujuan : ${hasil.destinationLabel}`);
  console.log(`✓ Berat  : ${hasil.weightKg} kg`);
  for (const k of hasil.quotes) {
    console.log(`    ${k.courier.padEnd(12)} Rp ${k.price.toLocaleString('id-ID').padStart(10)}` +
      (k.eta ? `   (${k.eta})` : ''));
  }
  console.log('\n─── 4. Yang dibaca bot saat menyusun jawaban ───\n');
  console.log(quotesToKnowledgeChunk(hasil));
  console.log('\n═══ SELESAI ═══');
  process.exit(0);
}

main().catch(err => {
  console.error('\n✗ Uji gagal:', err?.message || err);
  process.exit(1);
});
