/**
 * Diagnosa satu jalur: kenapa `"surabaya" tidak ketemu di daftar alamat`.
 *
 * Dijalankan sekali dari terminal, TIDAK mengubah apa pun kecuali menghapus
 * cache kalau kamu memintanya. Tujuannya memisahkan tiga kemungkinan yang dari
 * luar terlihat sama:
 *
 *   (a) cache Redis menyimpan jawaban KOSONG dari era kode yang masih rusak
 *   (b) API-nya sendiri memang mengembalikan kosong
 *   (c) baris datang lengkap tapi penyaring kandidat membuangnya semua
 *
 * Kunci API TIDAK PERNAH dicetak ke layar.
 *
 * Pakai:
 *   npx tsx diagnosa-ongkir.ts              ← cuma memeriksa
 *   npx tsx diagnosa-ongkir.ts --bersihkan  ← memeriksa lalu hapus cache Mengantar
 */

import { env } from './src/config/env';
import { redisCache, redisBull, waitForRedisReady } from './src/config/redis';
import { collectCandidates, type LocationRow } from './src/utils/location-resolver';
import { lookupAlias } from './src/utils/place-aliases';

const KATA = process.argv.find(a => !a.startsWith('-') && a !== process.argv[0] && a !== process.argv[1]) ?? 'surabaya';
const BERSIHKAN = process.argv.includes('--bersihkan');

function judul(t: string) {
  console.log(`\n${'─'.repeat(72)}\n${t}\n${'─'.repeat(72)}`);
}

async function main() {
  judul(`Kata yang diuji: "${KATA}"`);

  // ioredis menyambung secara ASINKRON sesudah objeknya dibuat, dan karena klien
  // di aplikasi ini memakai `enableOfflineQueue: false`, perintah apa pun yang
  // dikirim sebelum socket siap TIDAK diantre — ia langsung gagal dengan
  // "Stream isn't writeable". Peringatannya sudah tertulis di config/redis.ts
  // beserta penolongnya; versi pertama skrip ini mengabaikannya.
  await waitForRedisReady(redisCache, 'cache');

  // ── 0. Apakah fiturnya menyala? ──────────────────────────────────────────
  const aktif = Boolean(env.MENGANTAR_API_KEY && env.MENGANTAR_BASE_URL);
  console.log(`MENGANTAR_API_KEY terisi : ${env.MENGANTAR_API_KEY ? 'ya' : 'TIDAK'}`);
  console.log(`MENGANTAR_BASE_URL       : ${env.MENGANTAR_BASE_URL}`);
  console.log(`MENGANTAR_ORIGIN_ID      : ${env.MENGANTAR_ORIGIN_ID ? 'terisi' : 'kosong'}`);
  console.log(`Fitur ongkir aktif       : ${aktif ? 'ya' : 'TIDAK — ini saja sudah menjelaskan semuanya'}`);
  if (!aktif) { await tutup(); return; }

  const alias = lookupAlias(KATA);
  const query = alias?.query ?? KATA;
  if (alias) console.log(`Tabel padanan            : "${KATA}" → dicari sebagai "${query}" (harap ${alias.expect})`);

  // ── 1. Apa yang tersimpan di cache? ──────────────────────────────────────
  judul('1. Cache Redis');
  // Dua-duanya diperiksa: bentuk lama (tanpa nomor) dan bentuk sekarang (v2).
  const kunci = [
    `salespintar:mengantar:loc:${query.trim().toLowerCase()}`,
    `salespintar:mengantar:v2:loc:${query.trim().toLowerCase()}`,
  ];
  for (const cacheKey of kunci) {
    const cached = await redisCache.get(cacheKey);
    console.log(`Kunci "${cacheKey}"`);
    if (cached === null) {
      console.log('  → tidak ada.');
      continue;
    }
    let n = -1;
    let bentuk = 'tidak dikenali';
    try {
      const p = JSON.parse(cached);
      if (Array.isArray(p)) { n = p.length; bentuk = 'daftar'; }
      else { bentuk = `objek dengan kunci: ${Object.keys(p ?? {}).slice(0, 6).join(', ')}`; }
    } catch { bentuk = 'bukan JSON'; }
    const ttl = await redisCache.ttl(cacheKey);
    console.log(`  → ADA. Bentuk: ${bentuk}${n >= 0 ? `, ${n} baris` : ''}. Sisa ${ttl} detik (${Math.round(ttl / 86400)} hari)`);
    if (n === 0) {
      console.log('  ⚠️  Tersimpan sebagai daftar KOSONG.');
    } else if (n < 0) {
      console.log('  ⚠️  INI PENYEBABNYA. Yang tersimpan BUKAN daftar alamat, melainkan bentuk');
      console.log('      lain — hampir pasti pembungkus {success,data} dari versi kode sebelum');
      console.log('      Fase 38. collectCandidates memeriksa Array.isArray(), gagal, lalu');
      console.log('      melapor nol kandidat. Gejalanya "kota tidak ketemu", padahal API sehat.');
    }
  }

  const semuaKunci = await redisCache.keys('salespintar:mengantar:*');
  console.log(`\nTotal kunci Mengantar di Redis: ${semuaKunci.length}`);
  let kosong = 0;
  for (const k of semuaKunci) {
    if (!k.includes(':loc:')) continue;
    const v = await redisCache.get(k);
    if (v === '[]') { kosong += 1; console.log(`  KOSONG: ${k}`); }
  }
  if (kosong > 0) console.log(`  → ${kosong} kunci pencarian tersimpan sebagai kosong.`);

  // ── 2. Tanya API langsung, lewati cache ──────────────────────────────────
  judul('2. API langsung (cache dilewati)');
  const base = env.MENGANTAR_BASE_URL!.replace(/\/+$/, '');
  const url = `${base}/api/public/${env.MENGANTAR_API_KEY}/address/search?keyword=${encodeURIComponent(query)}`;
  let rows: LocationRow[] = [];
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    console.log(`HTTP ${res.status} ${res.statusText}`);
    const json: any = await res.json();
    const data = Array.isArray(json) ? json : (json?.data ?? json?.result ?? null);
    if (!Array.isArray(data)) {
      console.log('Bentuk balasan TIDAK dikenali. Cuplikan (tanpa kunci API):');
      console.log('  ' + JSON.stringify(json).slice(0, 300));
    } else {
      rows = data as LocationRow[];
      console.log(`Jumlah baris dari API: ${rows.length}`);
      const contoh = rows[0];
      if (contoh) {
        console.log('Nama field di baris pertama:');
        console.log('  ' + Object.keys(contoh).join(', '));
        console.log(`  _id ada? ${contoh._id ? 'ya' : 'TIDAK'}   id ada? ${(contoh as any).id ? 'ya' : 'TIDAK'}`);
        if (!contoh._id && !(contoh as any).id) {
          console.log('  ⚠️  Tidak ada _id maupun id. Seluruh baris akan disaring habis oleh');
          console.log('      collectCandidates, dan gejalanya persis "tidak ketemu di daftar alamat".');
        }
      }
    }
  } catch (err) {
    console.log(`GAGAL memanggil API: ${err instanceof Error ? err.message : String(err)}`);
  }

  // ── 3. Jalankan penyaring kandidat pada baris sungguhan ──────────────────
  judul('3. Penyaring kandidat pada baris sungguhan');
  if (rows.length === 0) {
    console.log('Tidak ada baris untuk disaring — masalahnya sudah di langkah 1 atau 2.');
  } else {
    const kand = collectCandidates(rows, query, alias?.expect);
    console.log(`Kandidat yang lolos: ${kand.length}`);
    for (const c of kand) {
      console.log(`  ${c.cityLabel.padEnd(24)} ${c.province.padEnd(18)} ${String(c.weight).padStart(3)} baris  ${c.primary ? 'nama-kota' : 'saingan'}`);
    }
    if (kand.length === 0) {
      console.log('  ⚠️  Baris ADA tapi penyaringnya membuang semuanya. Ini bug di');
      console.log('      collectCandidates, bukan di cache maupun API.');
      console.log('  Contoh 3 baris pertama supaya bisa dibaca:');
      for (const r of rows.slice(0, 3)) {
        console.log(`    CITY_NAME=${r.CITY_NAME} | CITY_NAME_SI=${r.CITY_NAME_SI} | DISTRICT=${r.DISTRICT_NAME} | SUB=${r.SUBDISTRICT_NAME} | PROV=${r.PROVINCE_NAME}`);
      }
    }
  }

  // ── 4. Bersihkan kalau diminta ───────────────────────────────────────────
  if (BERSIHKAN) {
    judul('4. Membersihkan cache Mengantar');
    if (semuaKunci.length > 0) {
      await redisCache.del(...semuaKunci);
      console.log(`${semuaKunci.length} kunci dihapus. Cache akan terisi ulang sendiri dari API.`);
    } else {
      console.log('Tidak ada yang perlu dihapus.');
    }
  } else {
    console.log('\nJalankan ulang dengan --bersihkan kalau mau cache Mengantar dihapus.');
  }

  await tutup();
}

/** Modul config/redis membuat DUA klien; dua-duanya harus ditutup atau proses menggantung. */
async function tutup() {
  await Promise.allSettled([redisCache.quit(), redisBull.quit()]);
}

main().catch(async err => {
  console.error('Diagnosa gagal:', err);
  try { await tutup(); } catch { /* biarkan */ }
  process.exit(1);
});
