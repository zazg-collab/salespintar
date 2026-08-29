// Pola diambil PERSIS dari supervisor.service.ts hasil suntingan.
import fs from 'fs';
const src = fs.readFileSync('supervisor.service.ts', 'utf-8');
const ambil = (nama) => {
  const m = src.match(new RegExp(`const ${nama} = (new RegExp\\([\\s\\S]*?\\n\\);|/.*?/i;)`));
  if (!m) throw new Error('tidak ketemu: ' + nama);
  return m[1];
};
const JANJI = eval(ambil('JANJI_TINDAKAN_PATTERN').replace(/;$/, ''));
const MUTU  = eval(ambil('KLAIM_MUTU_PATTERN').replace(/;$/, ''));

const bocor = `Memang ongkir ke Kabupaten Garut, Jawa Barat sedikit lebih mahal, tapi kami menggunakan ekspedisi yang terpercaya dan memiliki reputasi baik untuk pengiriman. Kalau Anda mau, saya bisa lihat apakah ada opsi lain yang lebih murah, tapi mungkin dengan waktu pengiriman yang sedikit lebih lama. Atau, Anda bisa mempertimbangkan untuk menggunakan ekspedisi yang sama, karena mereka sudah terbukti memiliki layanan yang baik dan bisa COD, jadi Anda tidak perlu membayar dulu sebelum menerima paketnya.`;

console.log('######## BALASAN YANG BOCOR 30 Juli ########');
console.log('  janji_tindakan :', JANJI.test(bocor) ? 'TERTANGKAP ✓' : 'LOLOS ✗');
console.log('  klaim_mutu     :', MUTU.test(bocor) ? 'TERTANGKAP ✓' : 'LOLOS ✗');
const skor = (JANJI.test(bocor) ? 35 : 0) + (MUTU.test(bocor) ? 30 : 0);
console.log(`  baseScore      : ${skor}  →  ${skor >= 60 ? 'HIGH → DITAHAN & dialihkan ke manusia ✓' : skor >= 30 ? 'MEDIUM (dikirim, tercatat)' : 'LOW (lolos)'}`);

console.log('\n######## HARUS TERTANGKAP ########');
for (const t of [
  'saya bisa lihat apakah ada opsi lain yang lebih murah',
  'saya carikan yang lebih murah ya kak',
  'nanti saya negosiasikan ke kurir',
  'saya usahakan diskon untuk kakak',
  'coba saya mintakan potongan dulu',
  'bisa saya bantu turunkan ongkirnya',
  'ada pilihan lain yang lebih hemat',
]) console.log(`  ${JANJI.test(t) ? '✓' : '✗ BOCOR'}  "${t}"`);

console.log('\n######## HARUS LOLOS (kalimat sah) ########');
for (const t of [
  'Sebentar ya Kak, saya cek dulu biar infonya pasti',
  'akan saya cek dulu ya',
  'Baik kak, saya cek dulu ketersediaannya',
  'Ongkir ke Kabupaten Garut untuk paket 1 kg adalah Rp 10.000',
  'Garutnya yang di Jawa Barat atau yang di Sumatera Utara ya Kak?',
  'Terima kasih sudah order pak',
  'Pembayaran COD hanya dilakukan cash terhadap kurir',
]) console.log(`  ${!JANJI.test(t) && !MUTU.test(t) ? '✓' : '✗ FALSE POSITIVE'}  "${t}"`);

console.log('\n######## klaim_mutu: dimaafkan kalau ada di dokumen ########');
const pujian = 'kami memakai ekspedisi yang terpercaya';
const dok = 'Toko memakai ekspedisi yang terpercaya dan sudah bekerja sama lama.';
const flags = MUTU.flags.includes('g') ? MUTU.flags : MUTU.flags + 'g';
const found = pujian.match(new RegExp(MUTU.source, flags)) ?? [];
const berdasar = found.length > 0 && found.every(m => dok.toLowerCase().includes(m.toLowerCase()));
console.log(`  frasa tertangkap: [${found}]`);
console.log(`  ada di dokumen  : ${berdasar ? 'YA → dimaafkan ✓' : 'TIDAK → dihukum'}`);
