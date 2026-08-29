/**
 * Penjelajah lokasi Mengantar — bukan bagian aplikasi, aman dihapus.
 *
 *     npx tsx uji-lokasi.ts bandung
 *     npx tsx uji-lokasi.ts "bandung wetan"
 *     npx tsx uji-lokasi.ts 40111            (kode pos juga bisa)
 *
 * Gunanya menemukan ORIGIN_CODE gudang yang BENAR, lalu memasangnya langsung di
 * `.env` sebagai MENGANTAR_ORIGIN_ID.
 *
 * Kenapa itu lebih baik daripada mengandalkan kata kunci: pencarian "bandung"
 * mengembalikan banyak baris — Kota Bandung, Kabupaten Bandung, Bandung Barat,
 * puluhan kecamatan, dan kadang desa bernama Bandung di kabupaten lain sama
 * sekali. Aplikasi mengambil baris PERTAMA, dan baris pertama belum tentu yang
 * Anda maksud. Memasang kodenya langsung menghapus seluruh tebakan itu.
 */

import { env } from './src/config/env';

const KEY = env.MENGANTAR_API_KEY;
const BASE = env.MENGANTAR_BASE_URL.replace(/\/+$/, '');

const keyword = process.argv.slice(2).join(' ').trim();

function unwrap(res: any): any[] {
  if (Array.isArray(res)) return res;
  if (Array.isArray(res?.data)) return res.data;
  if (Array.isArray(res?.result)) return res.result;
  return [];
}

async function main() {
  if (!KEY) {
    console.log('✗ MENGANTAR_API_KEY belum ada di backend/.env');
    process.exit(1);
  }
  if (!keyword) {
    console.log('Pakai: npx tsx uji-lokasi.ts <kata kunci>');
    console.log('Contoh: npx tsx uji-lokasi.ts bandung');
    process.exit(1);
  }

  const url = `${BASE}/api/public/${KEY}/address/search?keyword=${encodeURIComponent(keyword)}`;
  console.log(`Mencari "${keyword}" ...\n`);

  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) {
    console.log(`✗ HTTP ${res.status} ${res.statusText}`);
    console.log((await res.text()).slice(0, 300));
    process.exit(1);
  }

  const body = await res.json();
  const rows = unwrap(body);

  if (rows.length === 0) {
    console.log('Tidak ada hasil. Bentuk balasan mentahnya:');
    console.log(JSON.stringify(body, null, 2).slice(0, 800));
    process.exit(1);
  }

  console.log(`Ditemukan ${rows.length} lokasi.`);
  console.log('Nama field yang tersedia:', Object.keys(rows[0]).join(', '));
  console.log('');

  // _id yang dipakai sebagai origin_id / destination_id — BUKAN ORIGIN_CODE.
  // Kode seperti "TGR10000" terlihat meyakinkan tapi menghasilkan HTTP 404.
  const kolom = (r: any) => [
    String(r._id ?? r.id ?? '-').padEnd(26),
    String(r.SUBDISTRICT_NAME ?? r.DISTRICT_NAME ?? '-').slice(0, 20).padEnd(20),
    String(r.CITY_NAME ?? '-').slice(0, 22).padEnd(22),
    String(r.PROVINCE_NAME ?? '-').slice(0, 16).padEnd(16),
    String(r.ZIP_CODE ?? '-').padEnd(7),
    String(r.ORIGIN_CODE ?? '-'),
  ].join(' ');

  console.log(
    '_id (INI YANG DIPAKAI)'.padEnd(26) + ' ' + 'KECAMATAN'.padEnd(20) + ' ' +
    'KOTA'.padEnd(22) + ' ' + 'PROVINSI'.padEnd(16) + ' ' + 'POS'.padEnd(7) + ' (kode kurir)',
  );
  console.log('─'.repeat(105));

  rows.forEach((r, i) => {
    // Baris pertama diberi tanda: INILAH yang dipakai aplikasi kalau Anda
    // hanya mengandalkan kata kunci tanpa memasang MENGANTAR_ORIGIN_ID.
    const tanda = i === 0 ? ' ← dipakai aplikasi kalau pakai kata kunci' : '';
    console.log(kolom(r) + tanda);
  });

  console.log('\n' + '─'.repeat(105));
  console.log('Cari baris gudang Anda, salin kolom _id, lalu pasang di backend/.env:');
  console.log('\n    MENGANTAR_ORIGIN_ID=<isi kolom _id>\n');
  console.log('Sesudah itu kata kunci tidak dipakai lagi untuk kota asal — tidak ada tebakan.');
  process.exit(0);
}

main().catch(err => {
  console.error('✗ Gagal:', err?.message || err);
  process.exit(1);
});
