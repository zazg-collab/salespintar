/**
 * Uji manual Lapis 2.5 (karantina) — bukan bagian aplikasi, aman dihapus.
 *
 * Dijalankan dari DALAM folder backend supaya Node menemukan node_modules.
 * (Pelajaran yang sudah dua kali saya langgar: Node mencari modul relatif
 * terhadap lokasi file skrip, bukan folder tempat perintah dijalankan.)
 */
import fs from 'fs';
import path from 'path';
import matter from 'gray-matter';
import { assessDocument } from './src/queues/shadow-mining.worker';
import type { ExtractedKnowledge } from './src/queues/shadow-mining.worker';

const VAULT = process.env.OBSIDIAN_CS_PATH || '';

function show(label: string, doc: ExtractedKnowledge, harapan: string) {
  const hasil = assessDocument(doc);
  const status = hasil.forceReview ? 'DITAHAN' : 'LOLOS  ';
  const cocok = status.trim() === harapan ? '✓' : '✗ TIDAK SESUAI HARAPAN';
  console.log(`${status} | ${cocok} | ${label}`);
  if (hasil.reasons.length) console.log(`         alasan: ${hasil.reasons.join(', ')}`);
  console.log('');
  return status.trim() === harapan;
}

const kasus: [string, ExtractedKnowledge, string][] = [];

// ── Kasus 1: dokumen ASLI hasil tambangan dari vault ───────────────────────
const nyata = path.join(VAULT, 'Produk', '20260729-membelipisau.md');
if (fs.existsSync(nyata)) {
  const { data, content } = matter(fs.readFileSync(nyata, 'utf-8'));
  kasus.push([
    'ASLI dari vault: 20260729-membelipisau.md (waffle, tanpa angka)',
    { title: String(data.title || ''), category: 'Produk', filename: 'x', content },
    'DITAHAN',
  ]);
} else {
  console.log(`(lewati kasus asli — tidak ketemu di ${nyata})\n`);
}

// ── Kasus 2: menyebut harga ────────────────────────────────────────────────
kasus.push([
  'Menyebut harga: "Pisau daging Rp 150.000, sudah termasuk sarung."',
  {
    title: 'Harga Pisau Daging',
    category: 'Produk',
    filename: 'x',
    content: '# Harga\nPisau daging Rp 150.000, sudah termasuk sarung pelindung.',
  },
  'DITAHAN',
]);

// ── Kasus 3: klaim stok + janji waktu ──────────────────────────────────────
kasus.push([
  'Klaim stok + janji waktu: "ready stok, besok sampai"',
  {
    title: 'Ketersediaan',
    category: 'FAQ',
    filename: 'x',
    content: '# Stok\nSemua ukuran ready stok dan kalau order sebelum jam 2, besok sampai.',
  },
  'DITAHAN',
]);

// ── Kasus 4: SOP murni — HARUS lolos, ini yang tidak boleh kena ────────────
kasus.push([
  'SOP murni tanpa klaim: langkah klaim garansi',
  {
    title: 'Alur Klaim Garansi',
    category: 'SOP',
    filename: 'x',
    content:
      '# Alur Klaim Garansi\n' +
      '## Langkah\n' +
      'Pelanggan mengirim foto produk beserta bukti pembelian ke nomor CS. ' +
      'CS memeriksa kelengkapan berkas, lalu menerbitkan nomor tiket. ' +
      'Produk dikirim balik ke alamat gudang yang tercantum di tiket.',
  },
  'LOLOS',
]);

// ── Kasus 5: prosedur berangka — juga harus lolos (angka bukan pemicu) ─────
kasus.push([
  'Prosedur dengan angka langkah (bukan klaim volatil)',
  {
    title: 'Cara Merawat Pisau',
    category: 'SOP',
    filename: 'x',
    content:
      '# Cara Merawat Pisau\n' +
      'Cuci dengan air hangat, keringkan dengan lap kering, lalu simpan di rak kayu. ' +
      'Asah menggunakan batu asah grit 1000 untuk perawatan rutin.',
  },
  'LOLOS',
]);

console.log('═══ Uji Lapis 2.5 — karantina fakta volatil & dokumen hampa ═══\n');
let lulus = 0;
for (const [label, doc, harapan] of kasus) {
  if (show(label, doc, harapan)) lulus++;
}
console.log(`─── ${lulus}/${kasus.length} kasus sesuai harapan ───`);
process.exit(lulus === kasus.length ? 0 : 1);
