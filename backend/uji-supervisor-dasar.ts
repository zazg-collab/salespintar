/**
 * Uji: klaim yang punya dasar di pengetahuan berhenti dihukum — TANPA
 * melonggarkan pengaman.
 *
 * ── Kenapa uji ini penting ──────────────────────────────────────────────────
 * Yang diubah di `hasRiskyPattern` itu PENGAMAN. Perubahan pada pengaman punya
 * dua cara gagal, dan yang kedua jauh lebih berbahaya:
 *
 *   1. Terlalu ketat → jawaban benar diblokir. Terlihat langsung, mengganggu,
 *      dan cepat dilaporkan.
 *   2. Terlalu longgar → jawaban karangan lolos ke pelanggan. TIDAK terlihat,
 *      tidak ada yang melapor, dan baru ketahuan waktu ada yang salah bayar.
 *
 * Karena itu uji pertama di bawah bukan uji fitur baru, melainkan uji bahwa
 * perilaku LAMA tidak berubah saat pengetahuannya kosong.
 *
 * Jalankan:
 *   npx tsx uji-supervisor-dasar.ts
 */

import { hasRiskyPattern } from './src/services/supervisor.service';
import { quotesToKnowledgeChunk } from './src/services/mengantar.service';

let n = 0;
let gagal = 0;

function cek(nama: string, benar: boolean, catatan = '') {
  n += 1;
  if (!benar) gagal += 1;
  console.log(`  ${benar ? '✓' : '✗'}  ${nama}${catatan ? ` — ${catatan}` : ''}`);
}

function skor(teks: string, dasar?: string) {
  return hasRiskyPattern(teks, 'strict', dasar);
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n1. TANPA pengetahuan, perilakunya harus IDENTIK seperti sebelumnya');
console.log('   (ini uji terpenting: memastikan tidak ada pengaman yang melonggar)');
{
  const kasus: Array<[string, number, string[]]> = [
    ['Harganya Rp 150.000 ya Kak',                       30, ['klaim_harga']],
    ['Stoknya masih ada Kak',                            25, ['klaim_stok']],
    ['Dikirim besok ya',                                 20, ['klaim_timeline']],
    ['Kami jamin sampai 3 hari',                         45, ['klaim_timeline', 'klaim_komitmen']],
    ['Rp 8.000, ready stok, besok kirim, dijamin sampai', 100, ['klaim_harga', 'klaim_stok', 'klaim_timeline', 'klaim_komitmen']],
    ['Terima kasih Kak, senang bisa membantu',            0,  []],
  ];
  for (const [teks, harapSkor, harapPola] of kasus) {
    const r = skor(teks);                       // tanpa argumen ketiga
    const r2 = skor(teks, '');                  // pengetahuan kosong
    const r3 = skor(teks, '   \n  ');           // pengetahuan cuma spasi
    const cocok = r.baseScore === harapSkor
      && r2.baseScore === harapSkor
      && r3.baseScore === harapSkor
      && harapPola.every(p => r.patterns.includes(p))
      && r.patterns.length === harapPola.length;
    cek(`"${teks.slice(0, 42)}"`.padEnd(48) + `→ ${harapSkor}`, cocok,
        `dapat ${r.baseScore} [${r.patterns.join(', ')}]`);
    cek(`   ...dan tidak ada yang ditandai berdasar`, r.grounded.length === 0,
        r.grounded.join(', ') || 'kosong');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n2. Potongan ongkir SUNGGUHAN — kasus yang memicu perbaikan ini');
{
  // Dibentuk lewat fungsi produksi, bukan ditulis tangan, supaya kalau bentuk
  // potongannya berubah suatu hari uji ini ikut berubah dan tidak diam-diam
  // menguji sesuatu yang sudah tidak ada.
  const dasar = quotesToKnowledgeChunk({
    destinationLabel: 'Kota Jakarta Pusat, DKI Jakarta',
    weightKg: 1,
    quotes: [
      { courier: 'SiCepat', price: 6655, eta: '1-2 hari' },
      { courier: 'JNE', price: 8000, eta: '2 hari' },
    ],
  });
  console.log('   potongan pengetahuan:');
  console.log(dasar.split('\n').map(l => '     │ ' + l).join('\n'));

  const balasan = 'Untuk ke Jakarta Pusat ongkirnya SiCepat Rp 6.655 estimasi 1-2 hari, JNE Rp 8.000 estimasi 2 hari ya Kak.';
  const r = skor(balasan, dasar);
  console.log(`\n   balasan: "${balasan}"`);
  cek('harga TIDAK dihukum (ada di pengetahuan)', !r.patterns.includes('klaim_harga'),
      `pola: [${r.patterns.join(', ')}]`);
  cek('harga ditandai berdasar', r.grounded.includes('klaim_harga'));
  cek('waktu TIDAK dihukum (ada di pengetahuan)', !r.patterns.includes('klaim_timeline'));
  cek('skornya LOW (< 30)', r.baseScore < 30, `skor ${r.baseScore} — sebelum perbaikan 50`);
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n3. Kombinasi yang DULU memblokir jawaban benar (75 → HIGH)');
{
  const dasar = [
    'Ongkos kirim ke Kota Bandung untuk paket 1 kg',
    'JNE: Rp 8.000 (estimasi 2 hari)',
    'Ekspedisi yang tersedia: JNE, J&T, SiCepat.',
  ].join('\n');
  const balasan = 'JNE Rp 8.000, estimasi 2 hari. Ekspedisi yang tersedia: JNE, J&T, SiCepat.';
  const r = skor(balasan, dasar);
  const rTanpaDasar = skor(balasan);
  console.log(`   tanpa dasar : ${rTanpaDasar.baseScore} [${rTanpaDasar.patterns.join(', ')}]  ← HIGH, diblokir`);
  console.log(`   dengan dasar: ${r.baseScore} [${r.patterns.join(', ') || 'tidak ada'}]`);
  cek('sebelum perbaikan memang mencapai ambang blokir', rTanpaDasar.baseScore >= 60,
      `${rTanpaDasar.baseScore} ≥ 60 — bukan kekhawatiran teoretis`);
  cek('sekarang tidak diblokir', r.baseScore < 60, `skor ${r.baseScore}`);
  cek('ketiganya ditandai berdasar', r.grounded.length === 3, r.grounded.join(', '));
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n4. Yang HARUS tetap tertangkap — halusinasi tidak boleh lolos');
{
  const dasar = 'Ongkos kirim ke Kota Bandung untuk paket 1 kg\nJNE: Rp 8.000 (estimasi 2 hari)';

  // Persis yang model karang di audit 30 Juli, pertanyaan nomor 7.
  const karangan = 'Biasanya ongkir berkisar Rp 200.000 - Rp 500.000 tergantung tujuan.';
  const r1 = skor(karangan, dasar);
  cek('angka karangan tetap dihukum', r1.patterns.includes('klaim_harga'),
      `skor ${r1.baseScore} — inilah yang diblokir di audit nomor 7`);

  // Yang paling menipu: satu angka benar, satu dikarang.
  const campur = 'JNE Rp 8.000 Kak, kalau mau lebih cepat ada yang Rp 25.000.';
  const r2 = skor(campur, dasar);
  cek('campuran benar+karangan tetap dihukum', r2.patterns.includes('klaim_harga'),
      `skor ${r2.baseScore} — angka benar tidak boleh "menumpangi" yang salah`);
  cek('dan tidak ditandai berdasar', !r2.grounded.includes('klaim_harga'));

  // Waktu yang tidak ada dasarnya.
  const waktu = 'JNE Rp 8.000, sampai hari ini juga kok Kak.';
  const r3 = skor(waktu, dasar);
  cek('"hari ini" tanpa dasar tetap dihukum', r3.patterns.includes('klaim_timeline'),
      `skor ${r3.baseScore}`);

  // Stok, yang dasarnya soal ekspedisi bukan barang.
  const stok = 'Barangnya ready stok Kak.';
  const r4 = skor(stok, dasar);
  cek('klaim stok tanpa dasar tetap dihukum', r4.patterns.includes('klaim_stok'));
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n5. Janji TIDAK pernah dimaafkan, walau tertulis di pengetahuan');
{
  const dasar = 'Kami jamin paket sampai dalam 3 hari untuk wilayah Jawa.';
  const balasan = 'Kami jamin sampai dalam 3 hari ya Kak.';
  const r = skor(balasan, dasar);
  cek('klaim_komitmen tetap dihukum', r.patterns.includes('klaim_komitmen'),
      `skor ${r.baseScore}`);
  cek('komitmen tidak pernah masuk daftar berdasar', !r.grounded.includes('klaim_komitmen'),
      'janji tidak jadi aman karena pernah ditulis — ia mengikat toko di percakapan ini');
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n6. Mode lenient (Shadow Mining / Human Learning) tidak terganggu');
{
  const kasus: Array<[string, boolean]> = [
    ['pesanan sudah ready dikemas', false],   // bukan klaim stok
    ['masih ada yang bisa dibantu?', false],  // bukan klaim stok
    ['stok ready Kak', true],                 // memang klaim stok
    ['ada stok warna hitam', true],
  ];
  for (const [teks, harapNyala] of kasus) {
    const r = hasRiskyPattern(teks, 'lenient');
    cek(`lenient "${teks}"`.padEnd(48) + `→ ${harapNyala ? 'nyala' : 'diam'}`,
        r.patterns.includes('klaim_stok') === harapNyala,
        `pola: [${r.patterns.join(', ') || 'tidak ada'}]`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n7. Nominal ditulis beda tapi nilainya sama');
{
  const dasar = 'JNE: Rp 8.000';
  for (const bentuk of ['Rp 8.000', 'Rp8.000', 'Rp 8000', 'Rp8000']) {
    const r = skor(`Ongkirnya ${bentuk} ya Kak`, dasar);
    cek(`"${bentuk}"`.padEnd(16) + '→ dianggap berdasar', r.grounded.includes('klaim_harga'),
        `skor ${r.baseScore}`);
  }
  // Angka yang MIRIP tapi beda tidak boleh lolos.
  const r = skor('Ongkirnya Rp 80.000 ya Kak', dasar);
  cek('Rp 80.000 (beda nol) TIDAK lolos', r.patterns.includes('klaim_harga'),
      'kalau ini lolos, artinya pencocokannya cuma substring dan berbahaya');
}

console.log(`\n${gagal === 0 ? 'SEMUA LULUS' : `${gagal} GAGAL`} — ${n - gagal}/${n}\n`);
process.exit(gagal === 0 ? 0 : 1);
