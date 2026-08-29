/**
 * Memilih tujuan pengiriman dari hasil pencarian alamat — atau menyerah dan
 * menyuruh bot bertanya.
 *
 * ── Yang diukur dari data sungguhan (30 Juli 2026) ──────────────────────────
 *
 * 1. SATUAN HARGANYA Kota/Kabupaten, bukan kecamatan.
 *    Empat kecamatan berbeda di "BANDUNG", asal sama, 1 kg: sembilan dari
 *    sepuluh ekspedisi selisih NOL. Yang berbeda cuma J&T, dan garis
 *    pemisahnya Kota Bandung (10.500) versus Kab. Bandung (7.699).
 *    Sampai tingkat kelurahan pun (Cibaduyut / Wetan / Kidul): selisih nol
 *    di semua ekspedisi.
 *    → Cukup pastikan Kota/Kabupaten. Tidak perlu turun ke kecamatan.
 *
 * 2. `CITY_NAME` MENGGABUNGKAN Kota dan Kabupaten.
 *    Kota Bandung dan Kab. Bandung dua-duanya `CITY_NAME = "BANDUNG"`.
 *    Yang membedakan `CITY_NAME_SI`: "Kota Bandung" vs "Kab. Bandung".
 *    Versi sebelumnya mengelompokkan per `CITY_NAME`, jadi ia menganggap
 *    keduanya satu tempat lalu mengambil salah satu sembarang — tepat di garis
 *    di mana J&T berbeda 36%.
 *    → Pengelompokan WAJIB per `CITY_NAME_SI`.
 *
 * 3. SALAH TAFSIR LINTAS PROVINSI ITU FATAL.
 *    Kota Bandung → Kota Surabaya, JNE Rp 10.500.
 *    Kota Bandung → kecamatan Surabaya di Lampung Tengah, JNE Rp 23.800.
 *    Selisih +127%, dan pada SAP +186%. Kalau bot salah tafsir, penjualnya
 *    nombok lebih besar daripada seluruh ongkir yang dikutip.
 *    → Kalau kandidatnya beda tempat, JANGAN diasumsikan.
 *
 * 4. Baris pertama hasil pencarian TIDAK BOLEH dipercaya.
 *    Pencarian "bandung" mengembalikan baris pertama "SUMUR BANDUNG, Jayanti,
 *    Kab. Tangerang". Terbukti pada percobaan pertama, bukan dugaan.
 */

export interface LocationRow {
  _id?: string;
  id?: string;
  CITY_NAME?: string;
  CITY_NAME_SI?: string;
  DISTRICT_NAME?: string;
  SUBDISTRICT_NAME?: string;
  PROVINCE_NAME?: string;
  ZIP_CODE?: string;
  /**
   * Penanda "tidak bisa COD" — ada belasan, satu per ekspedisi.
   *
   * Sengaja dibiarkan terbuka daripada didaftar satu-satu, karena Mengantar bisa
   * menambah ekspedisi baru dan penandanya akan ikut muncul dengan nama baru.
   * Yang membacanya `statusCod()` di `mengantar.service.ts`, dan ia memperlakukan
   * penanda yang belum dikenal sebagai "belum diketahui" — bukan sebagai "bisa".
   */
  [key: string]: unknown;
}

export interface Candidate {
  /** Satu baris perwakilan; tarifnya berlaku untuk seluruh Kota/Kab ini. */
  row: LocationRow;
  /** "Kota Bandung", "Kab. Banyumas". Inilah satuan harganya. */
  cityLabel: string;
  province: string;
  /** Berapa baris hasil pencarian yang menunjuk ke sini. Dasar urutan. */
  weight: number;
  /**
   * Apakah NAMA KOTA-nya sendiri yang cocok dengan kata kunci?
   *
   * Ini pembeda yang paling berarti, dan jumlah baris bukan penggantinya. Orang
   * yang bilang "surabaya" hampir pasti memaksudkan kota bernama Surabaya —
   * bukan kecamatan bernama Surabaya di Lampung Tengah, walaupun kecamatan itu
   * punya LEBIH BANYAK baris (24 lawan 16). Tanpa penanda ini, urutan berdasarkan
   * jumlah baris menaruh Lampung di depan, dan bot akan menjawab "ongkir ke
   * Kabupaten Lampung Tengah" untuk orang yang menanyakan Surabaya.
   */
  primary: boolean;
}

function norm(s: unknown): string {
  return String(s ?? '').trim().toLowerCase();
}

export function addressId(r: LocationRow | null | undefined): string | null {
  return r?._id || r?.id || null;
}

/**
 * Singkatan yang justru salah kalau dijadikan Huruf Kapital Di Awal.
 * "DKI JAKARTA" tidak boleh jadi "Dki Jakarta" — itu terbaca seperti salah tulis.
 */
const TETAP_KAPITAL = new Set(['DKI', 'DI', 'NTB', 'NTT']);

/**
 * Rapikan nama supaya enak dibaca di WhatsApp.
 *
 * Data API memakai HURUF BESAR SEMUA ("JAWA BARAT") dan singkatan ("Kab."),
 * dan dua-duanya terbaca seperti keluaran mesin. Pelanggan sedang membaca chat,
 * bukan basis data.
 */
export function prettyPlace(s: string): string {
  return String(s ?? '')
    .trim()
    .replace(/^Kab\.\s*/i, 'Kabupaten ')
    .replace(/\s+/g, ' ')
    .split(' ')
    .map(w => (TETAP_KAPITAL.has(w.toUpperCase()) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()))
    .join(' ');
}

/** Label untuk ditampilkan ke pelanggan, lengkap dengan provinsi. */
export function describeCandidate(c: Candidate): string {
  return [c.row.DISTRICT_NAME, c.cityLabel, c.province]
    .map(v => prettyPlace(String(v ?? '')))
    .filter(Boolean)
    .join(', ');
}

/** Label pendek untuk pertanyaan pilihan. */
export function shortLabel(c: Candidate): string {
  return [c.cityLabel, c.province].map(v => prettyPlace(String(v ?? ''))).filter(Boolean).join(', ');
}

function matchesAnyName(r: LocationRow, kw: string): boolean {
  return [r.CITY_NAME, r.DISTRICT_NAME, r.SUBDISTRICT_NAME].some(v => norm(v).includes(kw));
}

/**
 * Berapa baris minimum sebelum sebuah kandidat lintas provinsi dianggap serius.
 *
 * Diambil dari data sungguhan. Pencarian "bandung" memunculkan kelurahan
 * bernama Bandung di Tangerang dan Muaro Jambi — MASING-MASING SATU BARIS.
 * Itu tempat kecil yang nyaris tidak mungkin dimaksud orang yang bilang
 * "kirim ke Bandung", dan mempertanyakannya cuma bikin repot.
 *
 * Sebaliknya, pencarian "surabaya" memunculkan kecamatan Surabaya di Lampung
 * Tengah dengan 24 BARIS — lebih banyak daripada Kota Surabaya sendiri (16).
 * Itu daerah sungguhan berpenduduk, dan salah menebaknya berarti selisih tarif
 * sampai 186%.
 *
 * Ambangnya memisahkan dua hal itu.
 */
const RIVAL_MIN_WEIGHT = 5;

/**
 * Kumpulkan kandidat Kota/Kabupaten dari hasil pencarian.
 *
 * Penyaring berlapisnya penting, dan urutannya bukan kebetulan:
 *
 *   Lapis 1 — kalau ADA baris yang NAMA KOTANYA memuat kata kunci, hanya baris
 *   itu yang dipakai. Ini yang meruntuhkan "bandung" dari 25 kandidat jadi 2:
 *   23 di antaranya nyangkut karena ada KELURAHAN bernama Bandung di sana
 *   (Sumur Bandung di Tangerang, Rengas Bandung di Muaro Jambi), sementara yang
 *   nama KOTA-nya Bandung cuma Kota dan Kabupaten Bandung.
 *
 *   Lapis 2 — kalau tidak ada yang cocok di tingkat kota, baru terima kecocokan
 *   di tingkat kecamatan/kelurahan. Ini yang membuat "bojongsoang" dan
 *   "cibaduyut" tetap berhasil, karena keduanya memang nama kecamatan.
 *
 *   Lapis 3 — saingan lintas provinsi yang besar dimasukkan KEMBALI, supaya
 *   Lapis 1 tidak menyembunyikan bahaya yang paling mahal.
 */
export function collectCandidates(
  rows: LocationRow[],
  keyword: string,
  expectCityLabel?: string,
): Candidate[] {
  const kw = norm(keyword);
  if (!kw || !Array.isArray(rows) || rows.length === 0) return [];

  const withId = rows.filter(r => addressId(r));

  if (expectCityLabel) {
    // Datang dari tabel pemetaan: hanya Kota/Kab yang disebutkan yang sah.
    return group(withId.filter(r => norm(r.CITY_NAME_SI) === norm(expectCityLabel)), true);
  }

  const cocokKota = withId.filter(r => norm(r.CITY_NAME).includes(kw));
  const cocokApaPun = withId.filter(r => matchesAnyName(r, kw));

  if (cocokKota.length === 0) return group(cocokApaPun, false);

  // ── Kandidat utama: yang NAMA KOTAnya cocok ─────────────────────────────
  // Ini yang meruntuhkan "bandung" dari 25 kandidat jadi 2 — 23 lainnya
  // nyangkut karena ada KELURAHAN bernama Bandung di sana.
  const utama = group(cocokKota, true);
  const provinsiUtama = new Set(utama.map(c => norm(c.province)));

  // ── Tapi jangan buang saingan lintas provinsi yang besar ───────────────
  // Penyaring di atas, kalau dibiarkan sendiri, MENYEMBUNYIKAN bahaya yang
  // paling mahal. "surabaya" akan menyisakan Kota Surabaya saja dan kecamatan
  // Surabaya di Lampung hilang tanpa jejak — jadi bot tidak akan pernah
  // bertanya, lalu mengutip tarif yang salah 186% dengan penuh percaya diri.
  //
  // Saingan yang sungguhan (banyak baris, provinsi lain) dimasukkan kembali,
  // supaya ambiguitasnya muncul ke permukaan dan bot bertanya.
  const saingan = group(cocokApaPun, false)
    .filter(c => !provinsiUtama.has(norm(c.province)))
    .filter(c => c.weight >= RIVAL_MIN_WEIGHT);

  return [...utama, ...saingan].sort(urutan);
}

/**
 * Urutan penyajian: yang nama kotanya cocok lebih dulu, baru jumlah baris.
 *
 * Dipakai untuk dua hal, dan dua-duanya penting: urutan pilihan di pertanyaan,
 * dan — kalau tarifnya ternyata nyaris sama — kandidat mana yang dipakai
 * menjawab tanpa bertanya.
 */
function urutan(a: Candidate, b: Candidate): number {
  if (a.primary !== b.primary) return a.primary ? -1 : 1;
  return b.weight - a.weight;
}

function group(rowsIn: LocationRow[], primary: boolean): Candidate[] {
  const byCity = new Map<string, Candidate>();
  for (const r of rowsIn) {
    // CITY_NAME_SI adalah satuan harga. CITY_NAME dipakai sebagai cadangan,
    // tapi itu berarti Kota dan Kabupaten bisa tergabung — dan tarif J&T-nya
    // berbeda 36%, jadi cadangan ini memang kurang tajam.
    const label = String(r.CITY_NAME_SI ?? r.CITY_NAME ?? '').trim();
    if (!label) continue;
    const key = norm(label);
    const found = byCity.get(key);
    if (found) {
      found.weight += 1;
    } else {
      byCity.set(key, {
        row: r,
        cityLabel: label,
        province: String(r.PROVINCE_NAME ?? '').trim(),
        weight: 1,
        primary,
      });
    }
  }
  return [...byCity.values()].sort(urutan);
}

/**
 * Susun pertanyaan untuk pelanggan.
 *
 * Dua bentuk, dan pemilihannya disengaja:
 *
 *   DUA kandidat → sebutkan keduanya. "Purwokertonya yang di Banyumas atau
 *   yang di Kendal ya Kak?" Pertanyaan tertutup, dijawab dalam satu kata.
 *
 *   TIGA ATAU LEBIH → JANGAN dienumerasi. Menyodorkan 25 pilihan ke WhatsApp
 *   lebih buruk daripada tidak menjawab. Yang ditanyakan provinsinya, karena:
 *   (a) semua orang tahu provinsinya tanpa berpikir, termasuk yang lanjut usia;
 *   (b) selisih tarif yang fatal itu memang selisih antar provinsi.
 *
 * Nama tempat yang disebut pelanggan diulang di dalam pertanyaan — supaya
 * terasa didengarkan, bukan diinterogasi.
 */
/**
 * Kata yang WAJIB muncul di balasan supaya pertanyaannya benar-benar tersampaikan.
 *
 * ── Kenapa ini perlu ada ────────────────────────────────────────────────────
 * Pertanyaan yang sudah disusun rapi tidak ada gunanya kalau model bahasa
 * memilih kalimatnya sendiri. Terpantau 30 Juli 2026: pertanyaan sudah benar di
 * log, tapi yang sampai ke pelanggan justru "ongkir ke Surabaya perlu saya cek
 * dulu" — sebab perintahnya diselundupkan sebagai POTONGAN PENGETAHUAN ("gunakan
 * jika relevan"), sementara prompt sistem punya ATURAN ("kalau belum tahu, bilang
 * akan dicek dulu"). Saran kalah melawan aturan.
 *
 * Daftar ini dipakai memeriksa hasilnya: kalau balasan model tidak memuat satu
 * pun kata pembeda ini, balasan itu dibuang dan pertanyaan aslinya yang dikirim.
 * Memeriksa kecocokan persis terlalu rapuh — model boleh saja menyusun kalimatnya
 * sendiri, asalkan pilihannya benar-benar disampaikan.
 */
export function questionMustMention(candidates: Candidate[]): string[] {
  const provinsi = [...new Set(candidates.map(c => prettyPlace(c.province)).filter(Boolean))];
  if (candidates.length === 2) {
    if (provinsi.length >= 2) return provinsi;
    return candidates.map(c => prettyPlace(c.cityLabel)).filter(Boolean);
  }
  // Tiga atau lebih tidak dienumerasi, jadi yang bisa diperiksa cuma bahwa
  // pertanyaannya menyoal tingkat wilayah yang benar.
  return provinsi.length === 1 ? ['kabupaten'] : ['provinsi'];
}

/**
 * Apakah balasan yang akan dikirim benar-benar MENANYAKAN pilihan itu?
 *
 * Dipisah dari `ai.service` supaya bisa diuji sendiri — ini penjaga terakhir
 * sebelum pelanggan menerima jawaban yang salah arah, dan penjaga terakhir yang
 * tidak pernah diuji bukan penjaga.
 *
 * Kecocokan persis SENGAJA tidak diharuskan. Model bahasa boleh menyusun
 * kalimatnya sendiri — "Oh Surabaya, yang di Jawa Timur atau yang di Lampung
 * nih Kak?" itu bagus, mungkin lebih bagus daripada susunan kaku kita. Yang
 * wajib cuma dua: pilihannya benar-benar disebut, dan bentuknya pertanyaan.
 */
export function questionDelivered(reply: string, mustMention: string[]): boolean {
  if (mustMention.length === 0) return true;
  const r = String(reply ?? '').toLowerCase();
  if (!r.includes('?')) return false;
  return mustMention.some(k => r.includes(String(k).toLowerCase()));
}

export function buildQuestion(keyword: string, candidates: Candidate[]): string {
  const tempat = prettyPlace(keyword);
  const provinsi = [...new Set(candidates.map(c => norm(c.province)).filter(Boolean))];

  if (candidates.length === 2) {
    const [a, b] = candidates as [Candidate, Candidate];
    // Yang disebut hanya hal yang SUNGGUH membedakan keduanya. Kalau
    // provinsinya sama, menyebutkannya dua kali cuma bikin kalimat panjang
    // tanpa menambah kejelasan: "Kota Bandung, Jawa Barat atau Kabupaten
    // Bandung, Jawa Barat" — pelanggan harus membaca dua kali untuk menemukan
    // satu kata yang berbeda.
    if (provinsi.length >= 2) {
      return `${tempat}nya yang di ${prettyPlace(a.province)} atau yang di ${prettyPlace(b.province)} ya Kak?`;
    }
    return `${tempat}nya ${prettyPlace(a.cityLabel)} atau ${prettyPlace(b.cityLabel)} ya Kak?`;
  }

  // Tiga atau lebih: JANGAN dienumerasi. Menyodorkan sepuluh pilihan ke
  // WhatsApp lebih buruk daripada tidak menjawab.
  if (provinsi.length === 1) {
    // Se-provinsi tapi beberapa kabupaten — provinsi tidak membedakan apa pun.
    return `${tempat}nya di kabupaten mana ya Kak?`;
  }
  // Yang ditanyakan provinsinya: semua orang tahu provinsinya tanpa berpikir,
  // dan selisih tarif yang fatal itu memang selisih antar provinsi.
  return `${tempat}nya provinsi mana ya Kak?`;
}
