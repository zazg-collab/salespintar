/**
 * Pemetaan nama tempat → kata kunci pencarian yang benar-benar berhasil.
 *
 * ── Kenapa tabel ini perlu ada ──────────────────────────────────────────────
 * Pencarian alamat Mengantar dibatasi 50 baris dan TIDAK diurut berdasarkan
 * kecocokan. Untuk sebagian nama kota, akibatnya kota yang dimaksud **tidak
 * muncul sama sekali** di hasil pencarian. Bukan tenggelam di urutan bawah —
 * benar-benar tidak ada, karena 50 baris pertama sudah habis dipakai kelurahan
 * lain yang namanya mengandung kata yang sama.
 *
 * Diukur langsung (30 Juli 2026, 61 nama kota diuji, 55 berhasil, 6 gagal):
 *
 *   "malang" → 46 dari 50 baris dari Kab. Bireuen, Aceh. Kota Malang TIDAK ADA.
 *   "tegal"  → 24 kota berbeda; Kota Tegal tenggelam.
 *   "padang" → Kota Tebing Tinggi, Kota Medan. Kota Padang tidak di urutan atas.
 *   "solo"   → 32 baris dari Kab. Solok, Sumatera Barat. Surakarta TIDAK ADA.
 *   "jogja"  → cuma 2 baris, dua-duanya salah.
 *   "bandar lampung" → Lampung Tengah/Timur/Utara; kotanya sendiri tenggelam.
 *
 * Tidak ada logika disambiguasi yang bisa menolong kalau datanya memang tidak
 * sampai. Satu-satunya jalan: ganti kata kuncinya dengan yang terbukti berhasil.
 *
 * ── Kenapa yang dipetakan KATA KUNCI, bukan ID lokasi ───────────────────────
 * Menyimpan `_id` alamat langsung terlihat lebih cepat — tidak perlu memanggil
 * pencarian sama sekali. Tapi `_id` itu milik basis data Mengantar; kalau tabel
 * alamat mereka dibangun ulang, seluruh tabel ini jadi menunjuk ke tempat yang
 * salah TANPA satu pun galat muncul. Memetakan kata kunci tetap melewati
 * pencarian, jadi kesalahan apa pun akan terlihat sebagai "tidak ketemu"
 * daripada sebagai tarif yang salah.
 *
 * `expect` dipakai untuk memastikan: hasil pencarian disaring ke Kota/Kabupaten
 * itu saja. Jadi kata kunci yang hasilnya campur pun tetap aman dipakai.
 */

export interface PlaceAlias {
  /** Kata kunci yang dikirim ke API, menggantikan yang diucapkan pelanggan. */
  query: string;
  /** Nilai CITY_NAME_SI yang harus dipilih dari hasilnya. */
  expect: string;
  /** Nama yang enak dibaca, dipakai bot saat menjawab. */
  label: string;
}

/**
 * Kunci harus huruf kecil tanpa tanda baca. Pencocokannya persis, bukan
 * sebagian — supaya "malangbong" (kecamatan di Garut) tidak ikut tertangkap
 * oleh entri "malang".
 */
export const PLACE_ALIASES: Record<string, PlaceAlias> = {
  // ── Nama sehari-hari yang tidak ada di data resmi ────────────────────────
  // "surakarta jawa tengah" → 50 baris, SELURUHNYA Kota Surakarta.
  solo:        { query: 'surakarta jawa tengah', expect: 'Kota Surakarta',  label: 'Surakarta (Solo), Jawa Tengah' },
  sala:        { query: 'surakarta jawa tengah', expect: 'Kota Surakarta',  label: 'Surakarta (Solo), Jawa Tengah' },
  // "umbulharjo" → 7 baris, SELURUHNYA Kota Yogyakarta.
  jogja:       { query: 'umbulharjo', expect: 'Kota Yogyakarta', label: 'Yogyakarta' },
  jogjakarta:  { query: 'umbulharjo', expect: 'Kota Yogyakarta', label: 'Yogyakarta' },
  yogya:       { query: 'umbulharjo', expect: 'Kota Yogyakarta', label: 'Yogyakarta' },
  jogyakarta:  { query: 'umbulharjo', expect: 'Kota Yogyakarta', label: 'Yogyakarta' },
  diy:         { query: 'umbulharjo', expect: 'Kota Yogyakarta', label: 'Yogyakarta' },
  // "pati" → 50 baris, TIDAK SATU PUN Kabupaten Pati. Pencarian alamat Mengantar
  // mencocokkan sampai ke nama kelurahan, dan kata "pati" muncul di dalam
  // SANGGAPATI, PATILUBAN, GUNUNGPATI — semuanya di luar Jawa Tengah, dan
  // semuanya lebih dulu memenuhi jatah 50 baris. Kabupaten Pati sendiri ADA di
  // data mereka (terbukti lewat "juwana", kecamatannya), cuma tidak pernah
  // terjangkau lewat namanya sendiri. Diukur 2 Agustus 2026.
  // ⚠️ BELUM TUNTAS: dengan `expect` ini hasilnya masih "tidak ketemu" (aman —
  // bot tidak mengarang), bukan tarif Pati. Nilai `expect` yang benar harus
  // dicocokkan ke `CITY_NAME_SI` di `location-resolver.ts`.
  pati:        { query: 'juwana', expect: 'Kabupaten Pati', label: 'Pati, Jawa Tengah' },

  // ── Kota yang tenggelam oleh kelurahan bernama sama di tempat lain ──────
  // "lowokwaru" → 12 baris, SELURUHNYA Kota Malang.
  malang:      { query: 'lowokwaru', expect: 'Kota Malang', label: 'Kota Malang, Jawa Timur' },
  // "margadana" → 7 baris, SELURUHNYA Kota Tegal.
  tegal:       { query: 'margadana', expect: 'Kota Tegal', label: 'Kota Tegal, Jawa Tengah' },
  // "padang barat" → 31 dari 50 baris Kota Padang; disaring lewat `expect`.
  padang:      { query: 'padang barat', expect: 'Kota Padang', label: 'Kota Padang, Sumatera Barat' },
  // "tanjung karang pusat" → 7 dari 8 baris Kota Bandar Lampung.
  'bandar lampung': { query: 'tanjung karang pusat', expect: 'Kota Bandar Lampung', label: 'Bandar Lampung' },
  tanjungkarang:    { query: 'tanjung karang pusat', expect: 'Kota Bandar Lampung', label: 'Bandar Lampung' },

  // ── Nama kecamatan/kota yang bukan nama kabupaten ───────────────────────
  // Purwokerto adalah bagian dari Kabupaten Banyumas, bukan kota tersendiri.
  // "purwokerto banyumas" → 27 baris, SELURUHNYA Kab. Banyumas.
  // TETAPI ada juga Purwokerto di Kendal, Pati, Lamongan, Kediri, Blitar —
  // jadi alias ini SENGAJA tidak dipasang. Pelanggan harus ditanya dulu, dan
  // itu ditangani jalur ambiguitas biasa. Dicatat di sini supaya tidak ada
  // yang "membantu" menambahkannya di kemudian hari.

  // Kota Cirebon tenggelam di bawah Kab. Cirebon (27 baris) pada pencarian biasa.
  // "kejaksan" → 4 baris, SELURUHNYA Kota Cirebon. Dipasang sebagai alias
  // TERPISAH, bukan menimpa "cirebon" — karena "cirebon" saja memang ambigu
  // antara kota dan kabupaten, dan itu pertanyaan yang sah untuk diajukan.
  'kota cirebon': { query: 'kejaksan', expect: 'Kota Cirebon', label: 'Kota Cirebon, Jawa Barat' },
};

/** Bersihkan teks jadi bentuk yang bisa dicocokkan ke kunci tabel. */
export function normalizePlace(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Cari padanan di tabel. Pencocokannya PERSIS pada seluruh frasa, atau pada
 * frasa yang tersisa setelah kata pembuka umum dibuang.
 *
 * Tidak dicocokkan sebagian dengan sengaja: "malangbong" adalah kecamatan di
 * Garut, dan mencocokkannya ke entri "malang" akan mengirim paket ke provinsi
 * yang salah.
 */
export function lookupAlias(rawPlace: string): PlaceAlias | null {
  const clean = normalizePlace(rawPlace);
  if (!clean) return null;

  if (PLACE_ALIASES[clean]) return PLACE_ALIASES[clean]!;

  // Buang kata pembuka yang tidak menambah arti: "kota solo", "daerah jogja".
  const tanpaPembuka = clean.replace(/^(kota|kab|kabupaten|daerah|wilayah|kec|kecamatan)\s+/, '');
  if (tanpaPembuka !== clean && PLACE_ALIASES[tanpaPembuka]) return PLACE_ALIASES[tanpaPembuka]!;

  return null;
}
