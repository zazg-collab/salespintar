/**
 * Uji hitungan biaya COD — TANPA memanggil LLM, tanpa menyalakan server.
 * Jalankan: npx tsx uji-biaya-cod.ts
 */
import { hitungBiayaCod, adaNiatCod, kumpulkanNominal, potonganHitunganCod } from './src/utils/biaya-cod';

let gagal = 0;
function cek(nama: string, dapat: unknown, harap: unknown) {
  const a = JSON.stringify(dapat), b = JSON.stringify(harap);
  const ok = a === b;
  if (!ok) gagal++;
  console.log(`${ok ? 'OK  ' : 'GAGAL'} ${nama}: dapat ${a}${ok ? '' : ` — seharusnya ${b}`}`);
}

// Dua contoh yang tertulis di dokumen vault.
cek('vault 213.000', hitungBiayaCod(213000), 6000);
cek('vault 375.000', hitungBiayaCod(375000), 11000);
// Kasus yang dijawab salah oleh model pada audit 1 Agustus 2026 (4.170).
cek('audit 139.000', hitungBiayaCod(139000), 4000);
// Batas: 3% tepat ribuan, dan total kecil yang biayanya nol.
cek('100.000 (3% = 3.000 pas)', hitungBiayaCod(100000), 3000);
cek('30.000 (3% = 900)', hitungBiayaCod(30000), 0);
cek('nol/negatif', [hitungBiayaCod(0), hitungBiayaCod(-5)], [0, 0]);

cek('niat: "bs cod?"', adaNiatCod('bs cod?'), true);
cek('niat: "bayar dirumah ya"', adaNiatCod('bayar dirumah ya'), true);
cek('niat: "bayar pas barang sampai"', adaNiatCod('bayar pas barang sampai'), true);
cek('bukan niat: "ongkir ke medan"', adaNiatCod('ongkir ke medan'), false);

cek('nominal harga+ongkir', kumpulkanNominal('harganya Rp139.000 ongkir 25.000').sort((a,b)=>a-b), [25000, 139000]);
cek('nominal "139rb"', kumpulkanNominal('139rb aja'), [139000]);
cek('abaikan persen', kumpulkanNominal('biayanya 3% dari total'), []);
cek('abaikan nomor HP', kumpulkanNominal('wa saya 081234567890'), []);
cek('abaikan 2x24 jam', kumpulkanNominal('resi update 2x24 jam'), []);

const potongan = potonganHitunganCod(kumpulkanNominal('harga 139.000 ongkir 25.000'));
cek('potongan memuat total gabungan 164.000 → 4.000',
  potongan?.includes('Total belanja Rp164.000 → biaya COD Rp4.000 → yang dibayar ke kurir Rp168.000'), true);
cek('potongan kosong kalau tidak ada nominal', potonganHitunganCod([]), null);
// Ongkir yang berdiri sendiri tidak boleh muncul sebagai "total belanja" —
// terlihat di uji modul Fase 109: "Total belanja Rp25.000 → biaya COD Rp0".
cek('ongkir tidak ikut jadi baris total', potongan?.includes('Rp25.000 \u2192 biaya COD Rp0'), false);
cek('biaya nol tidak pernah dikutip', /biaya COD Rp0\b/.test(potongan ?? ''), false);
cek('hanya ongkir kecil -> tidak ada potongan', potonganHitunganCod([25000]), null);

console.log(gagal === 0 ? '\n== SEMUA LULUS ==' : `\n== ${gagal} GAGAL ==`);
process.exit(gagal === 0 ? 0 : 1);
