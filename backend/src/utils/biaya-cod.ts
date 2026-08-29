/**
 * Biaya COD dihitung di KODE, bukan oleh model.
 *
 * ── Kenapa file ini ada ─────────────────────────────────────────────────────
 * Aturan tokonya sudah tertulis jelas di vault ("3% dari total, dibulatkan ke
 * bawah ke ribuan terdekat", lengkap dengan dua contoh). Modelnya tetap salah:
 * pada audit 1 Agustus 2026 ia menjawab 3% dari 139.000 = 4.170 — persennya
 * benar, pembulatannya tidak dikerjakan. Supervisor memblokirnya (skor 60),
 * jadi pelanggan menerima kalimat mengulur, bukan angka salah. Tapi mengulur
 * juga bukan jawaban.
 *
 * Menambah kalimat perintah di prompt tidak menyelesaikan ini. Model bahasa
 * memang lemah di aritmetika, dan pembulatan ke bawah ke ribuan adalah langkah
 * yang paling sering ia lewati. Selama angkanya dihitung oleh model, kesalahan
 * yang sama akan kembali dengan bentuk berbeda.
 *
 * Jadi angkanya dihitung di sini, lalu DISUNTIKKAN sebagai potongan pengetahuan
 * — cara yang sama persis dengan tarif ongkir dari Mengantar (lihat catatan di
 * `ai.service.ts`). Konsekuensinya bagus: Supervisor ikut melihat angka itu di
 * pengetahuan, jadi jawaban yang memakainya lolos dengan sendirinya, tanpa satu
 * pun pengaman dilonggarkan.
 *
 * Yang TIDAK dilakukan file ini: menulis ulang angka di balasan model. Menyunting
 * teks yang sudah jadi berarti menebak mana angka COD dan mana angka lain — dan
 * tebakan yang salah di sana merusak jawaban yang tadinya benar.
 */

/** Persentase biaya COD. Kalau toko mengubahnya, ubah juga dokumen vault. */
const PERSEN_COD = 0.03;

/**
 * 3% dari total, dibulatkan KE BAWAH ke ribuan terdekat.
 *
 * Contoh dari dokumen vault: 213.000 → 6.000 (3% = 6.390); 375.000 → 11.000
 * (3% = 11.250). Keduanya dipakai sebagai uji di `uji-biaya-cod.ts`.
 */
export function hitungBiayaCod(total: number): number {
  if (!Number.isFinite(total) || total <= 0) return 0;
  return Math.floor((total * PERSEN_COD) / 1000) * 1000;
}

/**
 * Apakah percakapan ini sedang menyangkut COD.
 *
 * Sengaja longgar: pelanggan hampir tidak pernah menulis "COD" dengan lengkap.
 * "bayar dirumah", "bayar pas sampai", "bayar ditempat" semuanya COD.
 */
const NIAT_COD =
  /\b(c\.?o\.?d\.?|bayar\s*di\s*(tempat|rumah)|bayar\s*di(tempat|rumah)|bayar\s*(pas|saat|waktu|nanti)\s*(barang(nya)?\s*)?(sampai|datang|dat[ae]ng|terima|diterima))\b/i;

export function adaNiatCod(teks: string): boolean {
  return NIAT_COD.test(teks);
}

/**
 * Mengumpulkan nominal rupiah dari teks percakapan.
 *
 * Batas bawah 10.000 dan batas atas 100.000.000 bukan hiasan — itu yang memisahkan
 * harga dari angka lain yang berseliweran di obrolan CS: "3" (persen), "2x24"
 * (jam), tanggal, nomor resi, dan nomor HP. Nomor HP 12 digit lewat di atas batas
 * atas; angka polos di bawah 10.000 ditolak kecuali ia memakai akhiran rb/ribu/k.
 */
export function kumpulkanNominal(teks: string): number[] {
  const hasil = new Set<number>();
  const pola = /(?:rp\.?\s*)?(\d{1,3}(?:[.,]\d{3})+|\d+)\s*(rb|ribu|k)?/gi;
  let cocok: RegExpExecArray | null;
  while ((cocok = pola.exec(teks)) !== null) {
    // Angka yang langsung diikuti '%' itu persentase, bukan rupiah.
    if (teks.slice(pola.lastIndex, pola.lastIndex + 1) === '%') continue;
    const mentah = cocok[1]!;
    const akhiran = (cocok[2] ?? '').toLowerCase();
    const adaPemisah = /[.,]/.test(mentah);
    let nilai = Number(mentah.replace(/[.,]/g, ''));
    if (!Number.isFinite(nilai)) continue;
    if (akhiran) {
      // "139rb" → 139.000. "139.000rb" tidak masuk akal, jadi diabaikan.
      if (adaPemisah) continue;
      nilai *= 1000;
    } else if (!adaPemisah && nilai < 10000) {
      continue;
    }
    if (nilai < 10000 || nilai > 100000000) continue;
    hasil.add(nilai);
  }
  return [...hasil];
}

/**
 * Nominal dari POTONGAN PENGETAHUAN yang akan dibaca model.
 *
 * Perlu terpisah karena pertanyaan seperti "cod ke bandung total brp" tidak
 * memuat satu angka pun — harganya ada di dokumen produk, ongkirnya di potongan
 * dari Mengantar. Tanpa sumber kedua ini, hitungan COD tidak pernah bisa
 * disajikan untuk pertanyaan yang justru paling sering ditanyakan.
 *
 * Baris yang membicarakan biaya COD itu sendiri DIBUANG lebih dulu: dokumen
 * aturan COD memuat contoh "213.000 → 6.000" dan "375.000 → 11.000", dan angka
 * contoh itu bukan total belanja siapa pun. Kalau ikut terkumpul, daftar
 * hitungan akan memuat total yang tidak ada hubungannya dengan pesanan ini.
 */
export function nominalDariDokumen(dokumen: string[]): number[] {
  const baris = dokumen
    .join('\n')
    .split('\n')
    .filter(b => !/biaya\s*cod|\b3\s*%/i.test(b));
  return kumpulkanNominal(baris.join('\n'));
}

/** "Rp139.000" — pemisah ribuan gaya Indonesia, tanpa bergantung pada ICU. */
function rupiah(n: number): string {
  return 'Rp' + Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

/** Batas jumlah baris supaya potongan ini tidak menenggelamkan pengetahuan lain. */
const MAKS_BARIS = 12;
/** Di atas angka ini dianggap harga produk; di bawahnya dianggap ongkir. */
const AMBANG_PRODUK = 50000;

/**
 * Menyusun potongan pengetahuan berisi hitungan yang SUDAH jadi.
 *
 * Selain tiap nominal apa adanya, dihitung juga penjumlahan harga produk +
 * ongkir — karena itulah bentuk pertanyaan yang sebenarnya ("kalau COD totalnya
 * berapa"), dan menjumlahkan lalu mempersen lalu membulatkan adalah tiga langkah
 * aritmetika berturut-turut, tempat model paling sering tergelincir.
 */
export function potonganHitunganCod(nominal: number[]): string | null {
  if (nominal.length === 0) return null;

  const produk = nominal.filter(n => n >= AMBANG_PRODUK);
  const ongkir = nominal.filter(n => n < AMBANG_PRODUK);
  const jumlah: number[] = [];
  for (const p of produk) {
    for (const o of ongkir) jumlah.push(p + o);
  }

  // Ongkir yang berdiri sendiri BUKAN total belanja. Kalau ada angka setingkat
  // harga produk, angka kecil dibuang dari daftar — kalau tidak, baris "Total
  // belanja Rp25.000 → biaya COD Rp0" ikut tersaji (terlihat di uji modul Fase
  // 109), dan dari situ model bisa menyimpulkan COD-nya gratis.
  const dasar = produk.length > 0 ? produk : nominal;

  const semua = [...new Set([...dasar, ...jumlah])]
    // Biaya nol tidak pernah layak dikutip ke pelanggan.
    .filter(n => hitungBiayaCod(n) > 0)
    .sort((a, b) => a - b)
    .slice(-MAKS_BARIS);

  if (semua.length === 0) return null;

  const baris = semua.map(n => {
    const biaya = hitungBiayaCod(n);
    return `- Total belanja ${rupiah(n)} → biaya COD ${rupiah(biaya)} → yang dibayar ke kurir ${rupiah(n + biaya)}`;
  });

  return [
    'HITUNGAN BIAYA COD — sudah dihitung sistem. Pakai angka di bawah ini apa adanya.',
    'JANGAN menghitung persennya sendiri dan jangan membulatkan sendiri.',
    ...baris,
    'Kalau total belanja pelanggan tidak ada di daftar di atas, jangan mengarang angkanya:',
    'sebutkan saja bahwa biaya COD 3% dari total, lalu tanyakan/pastikan dulu totalnya.',
  ].join('\n');
}
