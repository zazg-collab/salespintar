// Uji buangTranskripSumber() terhadap DOKUMEN SUNGGUHAN hasil tambang,
// bukan terhadap contoh karangan.
import fs from 'fs';

const src = fs.readFileSync('../../backend/src/utils/text-chunker.ts', 'utf-8');
const PENANDA = src.match(/export const PENANDA_TRANSKRIP = '(.*?)';/)[1];
// Anotasi tipe dibuang supaya bisa dijalankan `node` polos — yang diuji
// LOGIKANYA, dan logikanya tidak berubah karena tipenya dilepas.
const fnSrc = src.match(/export function buangTranskripSumber[\s\S]*?\n}/)[0]
  .replace('export function', 'function')
  .replace('(body: string): { teks: string; dibuang: boolean }', '(body)')
  .replace(/: number/g, '')
  .replace(/: string/g, '');
const buang = new Function('PENANDA_TRANSKRIP', `${fnSrc}; return buangTranskripSumber;`)(PENANDA);

const VAULT = '/sessions/rcw-01yhoslt9rxinsa7jmkkewpk/mnt/SalesPintar-CS-Brain';
const berkas = [
  'Draft_AI/20260730-pemesanangke40perakduralium2.md',
  'Draft_AI/20260730-prosespengiriman.md',
  'SOP/02-ongkos-kirim.md',
  'Produk/20260729-membelipisau.md',
];

// Angka & frasa volatil yang TIDAK BOLEH lolos ke bagian terindeks.
const VOLATIL = ['199.000', '252.000', '245.000', '53.000', '60.000', '6-8 harian'];

for (const rel of berkas) {
  let raw;
  try { raw = fs.readFileSync(`${VAULT}/${rel}`, 'utf-8'); } catch { console.log(`(lewat) ${rel}`); continue; }
  const body = raw.replace(/^---\n[\s\S]*?\n---\n/, '');   // buang frontmatter
  const { teks, dibuang } = buang(body.trim());

  const bocorSebelum = VOLATIL.filter(v => body.includes(v));
  const bocorSesudah = VOLATIL.filter(v => teks.includes(v));

  console.log(`\n### ${rel}`);
  console.log(`  transkrip ditemukan : ${dibuang ? 'ya' : 'tidak'}`);
  console.log(`  ukuran              : ${body.trim().length} → ${teks.length} char`);
  console.log(`  angka volatil di berkas   : [${bocorSebelum.join(', ') || '—'}]`);
  console.log(`  angka volatil TERINDEKS   : [${bocorSesudah.join(', ') || '—'}]  ${bocorSesudah.length === 0 ? '✓' : '✗ MASIH BOCOR'}`);
  if (teks.trim().length === 0) console.log('  ⚠️  HABIS TOTAL — dokumen jadi kosong, periksa!');
}
