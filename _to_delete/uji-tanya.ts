/**
 * Uji pengumpulan kandidat + penyusunan pertanyaan.
 *
 * Barisnya tiruan, TAPI jumlah dan sebarannya diambil dari hasil pencarian
 * sungguhan yang dicatat di riset-ongkir-temuan.md. Jadi yang diuji di sini
 * bukan "apakah kodenya jalan" melainkan "apakah kodenya mengambil keputusan
 * yang benar pada bentuk data yang sebenarnya".
 */

import { collectCandidates, buildQuestion, describeCandidate, prettyPlace, LocationRow } from './src/utils/location-resolver';
import { lookupAlias } from './src/utils/place-aliases';
import { looksLikePlaceAnswer, combineAnswer } from './src/services/shipping-dialog.service';

let n = 0;
let gagal = 0;

function baris(
  city: string,
  citySi: string,
  district: string,
  sub: string,
  prov: string,
  jumlah: number,
): LocationRow[] {
  return Array.from({ length: jumlah }, (_, i) => ({
    _id: `${citySi}-${district}-${i}`,
    CITY_NAME: city,
    CITY_NAME_SI: citySi,
    DISTRICT_NAME: district,
    SUBDISTRICT_NAME: sub,
    PROVINCE_NAME: prov,
  }));
}

function cek(nama: string, benar: boolean, catatan = '') {
  n += 1;
  if (benar) {
    console.log(`  ✓  ${nama}${catatan ? ` — ${catatan}` : ''}`);
  } else {
    gagal += 1;
    console.log(`  ✗  ${nama}${catatan ? ` — ${catatan}` : ''}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n1. "bandung" — 2 kandidat se-provinsi (Kota vs Kabupaten)');
// Sungguhan: 50 baris, 25 kota. Nama KOTA yang cocok cuma Kota & Kab. Bandung;
// sisanya nyangkut lewat KELURAHAN bernama Bandung, 1 baris masing-masing.
{
  const rows = [
    ...baris('BANDUNG', 'Kota Bandung', 'Coblong', 'Dago', 'JAWA BARAT', 16),
    ...baris('BANDUNG', 'Kab. Bandung', 'Bojongsoang', 'Cipagalo', 'JAWA BARAT', 6),
    ...baris('TANGERANG', 'Kab. Tangerang', 'Jayanti', 'Sumur Bandung', 'BANTEN', 1),
    ...baris('MUARO JAMBI', 'Kab. Muaro Jambi', 'Sekernan', 'Rengas Bandung', 'JAMBI', 1),
  ];
  const k = collectCandidates(rows, 'bandung');
  const q = buildQuestion('bandung', k);
  k.forEach(c => console.log(`        ${c.cityLabel.padEnd(22)} ${c.province.padEnd(14)} ${c.weight} baris`));
  console.log(`        TANYA: "${q}"`);

  cek('2 kandidat, bukan 4', k.length === 2, `dapat ${k.length}`);
  cek('Kota dan Kabupaten TERPISAH', k.some(c => c.cityLabel === 'Kota Bandung') && k.some(c => c.cityLabel === 'Kab. Bandung'));
  cek('Tangerang & Muaro Jambi tersaring (1 baris < ambang 5)',
      !k.some(c => /Tangerang|Jambi/.test(c.cityLabel)));
  cek('provinsi TIDAK disebut (sama-sama Jawa Barat)', !/Jawa Barat/i.test(q), q);
  cek('menyebut Kota dan Kabupaten', /Kota Bandung/.test(q) && /Kabupaten Bandung/.test(q));
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n2. "surabaya" — INI KASUS 186% ITU');
// Sungguhan: Kota Surabaya 16 baris; kecamatan Surabaya di Lampung Tengah 24
// baris. Versi sebelum tambalan MENGHAPUS Lampung, jadi bot tidak pernah bertanya.
{
  const rows = [
    ...baris('SURABAYA', 'Kota Surabaya', 'Sukolilo', 'Keputih', 'JAWA TIMUR', 16),
    ...baris('LAMPUNG TENGAH', 'Kab. Lampung Tengah', 'Surabaya', 'Gedung Dalam', 'LAMPUNG', 24),
    ...baris('OGAN KOMERING ULU', 'Kab. Ogan Komering Ulu', 'Peninjauan', 'Surabaya', 'SUMATERA SELATAN', 2),
  ];
  const k = collectCandidates(rows, 'surabaya');
  const q = buildQuestion('surabaya', k);
  k.forEach(c => console.log(`        ${c.cityLabel.padEnd(22)} ${c.province.padEnd(18)} ${c.weight} baris`));
  console.log(`        TANYA: "${q}"`);

  cek('Lampung MUNCUL — bot jadi bertanya', k.some(c => /Lampung/.test(c.cityLabel)));
  cek('Ogan Komering Ulu tersaring (2 baris < ambang 5)',
      !k.some(c => /Ogan/.test(c.cityLabel)));
  cek('tepat 2 kandidat', k.length === 2, `dapat ${k.length}`);
  cek('yang ditanya PROVINSI (beda provinsi)', /provinsi|Jawa Timur|Lampung/i.test(q), q);
  cek('memakai kata "Surabaya" di pertanyaan', /Surabaya/.test(q));
  cek('tidak ada HURUF BESAR SEMUA', !/JAWA TIMUR|LAMPUNG/.test(q));
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n3. "purwokerto" — 6 kabupaten, JANGAN dienumerasi');
{
  const rows = [
    ...baris('BANYUMAS', 'Kab. Banyumas', 'Purwokerto Timur', 'Purwokerto Lor', 'JAWA TENGAH', 27),
    ...baris('KENDAL', 'Kab. Kendal', 'Patebon', 'Purwokerto', 'JAWA TENGAH', 2),
    ...baris('PATI', 'Kab. Pati', 'Margorejo', 'Purwokerto', 'JAWA TENGAH', 1),
    ...baris('LAMONGAN', 'Kab. Lamongan', 'Sukodadi', 'Purwokerto', 'JAWA TIMUR', 1),
    ...baris('KEDIRI', 'Kab. Kediri', 'Ngadiluwih', 'Purwokerto', 'JAWA TIMUR', 1),
    ...baris('BLITAR', 'Kab. Blitar', 'Srengat', 'Purwokerto', 'JAWA TIMUR', 2),
  ];
  const k = collectCandidates(rows, 'purwokerto');
  const q = buildQuestion('purwokerto', k);
  console.log(`        ${k.length} kandidat: ${k.map(c => c.cityLabel).join(' | ')}`);
  console.log(`        TANYA: "${q}"`);

  cek('tidak ada alias purwokerto (harus lewat jalur tanya)', lookupAlias('purwokerto') === null);
  cek('pertanyaan TIDAK mengenumerasi', !/\|/.test(q) && q.length < 70, `${q.length} karakter`);
  cek('menyebut "Purwokerto"', /Purwokerto/.test(q));
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n4. "bojongsoang" — kecamatan, tidak ambigu, jangan ditanya');
{
  const rows = baris('BANDUNG', 'Kab. Bandung', 'Bojongsoang', 'Cipagalo', 'JAWA BARAT', 6);
  const k = collectCandidates(rows, 'bojongsoang');
  cek('1 kandidat → langsung dipakai', k.length === 1, `dapat ${k.length}`);
  cek('label bersih', describeCandidate(k[0]!) === 'Bojongsoang, Kabupaten Bandung, Jawa Barat',
      describeCandidate(k[0]!));
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n5. Alias: kota yang tidak muncul di hasil pencarian biasa');
{
  cek('"solo" dipetakan', lookupAlias('solo')?.query === 'surakarta jawa tengah');
  cek('"kota solo" ikut dipetakan', lookupAlias('kota solo')?.expect === 'Kota Surakarta');
  cek('"malang" dipetakan ke lowokwaru', lookupAlias('malang')?.query === 'lowokwaru');
  cek('"malangbong" TIDAK ikut tertangkap', lookupAlias('malangbong') === null,
      'kecamatan di Garut — kalau tertangkap, paket ke provinsi yang salah');
  cek('"bandung" tidak dialias (memang ambigu)', lookupAlias('bandung') === null);

  // Alias memaksa penyaringan lewat `expect`, jadi hasil campur pun tetap aman.
  const rows = [
    ...baris('PADANG', 'Kota Padang', 'Padang Barat', 'Purus', 'SUMATERA BARAT', 31),
    ...baris('MEDAN', 'Kota Medan', 'Medan Barat', 'Glugur', 'SUMATERA UTARA', 19),
  ];
  const a = lookupAlias('padang')!;
  const k = collectCandidates(rows, a.query, a.expect);
  cek('`expect` membuang Medan dari hasil "padang barat"',
      k.length === 1 && k[0]!.cityLabel === 'Kota Padang', `dapat ${k.map(c => c.cityLabel).join(',')}`);
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n6. Jawaban pelanggan atas pertanyaan');
{
  cek('"jateng" dianggap jawaban', looksLikePlaceAnswer('jateng'));
  cek('"yang banyumas" dianggap jawaban', looksLikePlaceAnswer('yang banyumas'));
  cek('"oke makasih" BUKAN jawaban', !looksLikePlaceAnswer('oke makasih'),
      'kalau lolos, bot mencari kota bernama "oke"');
  cek('"besok aja deh" BUKAN jawaban', !looksLikePlaceAnswer('besok aja deh'));
  cek('kalimat panjang BUKAN jawaban',
      !looksLikePlaceAnswer('iya kak nanti saya kabari lagi ya soalnya masih mikir'));

  cek('jawaban DIGABUNG, bukan diganti', combineAnswer('purwokerto', 'banyumas') === 'purwokerto banyumas',
      combineAnswer('purwokerto', 'banyumas'));
  cek('"jateng" dibentangkan', combineAnswer('purwokerto', 'jateng') === 'purwokerto jawa tengah',
      combineAnswer('purwokerto', 'jateng'));
  cek('kata penghubung dibuang', combineAnswer('surabaya', 'yang di jawa timur') === 'surabaya jawa timur',
      combineAnswer('surabaya', 'yang di jawa timur'));
  cek('tidak mengulang tempat yang sama',
      combineAnswer('bandung', 'kota bandung') === 'bandung',
      combineAnswer('bandung', 'kota bandung'));
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n7. prettyPlace');
{
  cek('Kab. → Kabupaten', prettyPlace('Kab. Banyumas') === 'Kabupaten Banyumas', prettyPlace('Kab. Banyumas'));
  cek('HURUF BESAR → Huruf Besar', prettyPlace('JAWA BARAT') === 'Jawa Barat', prettyPlace('JAWA BARAT'));
  cek('DKI tetap DKI', prettyPlace('DKI JAKARTA') === 'DKI Jakarta', prettyPlace('DKI JAKARTA'));
  cek('DI tetap DI', prettyPlace('DI YOGYAKARTA') === 'DI Yogyakarta', prettyPlace('DI YOGYAKARTA'));
}

console.log(`\n${gagal === 0 ? 'SEMUA LULUS' : `${gagal} GAGAL`} — ${n - gagal}/${n}\n`);
process.exit(gagal === 0 ? 0 : 1);
