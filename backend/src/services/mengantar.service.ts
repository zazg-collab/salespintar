/**
 * Sambungan ke API Mengantar — cek ongkir sungguhan.
 *
 * ── Kenapa ongkir tidak bisa jadi dokumen ───────────────────────────────────
 * Ongkir adalah fungsi dari (kota asal, kota tujuan, berat). Kombinasinya ratusan
 * ribu dan berubah tiap kali ekspedisi menyesuaikan tarif. Tidak ada jumlah
 * dokumen Obsidian yang bisa menampungnya. Satu-satunya jawaban benar adalah
 * menanyakannya pada saat pelanggan bertanya.
 *
 * ── Keputusan rancangan yang paling penting ─────────────────────────────────
 * Hasil dari API ini TIDAK diberi izin khusus untuk melewati pengaman
 * anti-halusinasi. Sebagai gantinya, hasilnya disuntikkan sebagai POTONGAN
 * PENGETAHUAN SEMENTARA ke dalam konteks yang dipakai menyusun jawaban.
 *
 * Efeknya: waktu Supervisor memeriksa "apakah angka ini ada di pengetahuan?",
 * tarif dari Mengantar memang sudah ada di sana — jadi lolos dengan sendirinya.
 * Tidak ada satu pun pengaman yang dilonggarkan, dan tidak ada daftar-putih
 * angka yang perlu dipelihara. Kalau nanti API-nya mati, yang terjadi cuma bot
 * kembali tidak tahu ongkir — bukan bot yang tiba-tiba boleh mengarang angka.
 *
 * ── Catatan keamanan ────────────────────────────────────────────────────────
 * Mengantar menaruh kunci API DI DALAM ALAMAT URL, bukan di header. Artinya
 * kunci itu ikut tercatat di setiap log yang mencatat URL. Karena itu di modul
 * ini alamat lengkap TIDAK PERNAH masuk ke log — yang dicatat hanya nama
 * endpoint-nya. Jangan menambahkan `logger.info(url)` di mana pun di sini.
 */

import { env } from '../config/env';
import { logger } from '../utils/logger';
import { redisCache } from '../config/redis';
import {
  collectCandidates,
  buildQuestion,
  questionMustMention,
  prettyPlace,
  addressId as rowAddressId,
  addressId as addressIdDari,
  type Candidate,
  type LocationRow,
} from '../utils/location-resolver';
import { lookupAlias } from '../utils/place-aliases';

/**
 * Awalan kunci cache, DENGAN nomor bentuk.
 *
 * ── Kejadian yang membuat nomor ini ada ─────────────────────────────────────
 * Versi modul ini sebelum Fase 38 menyimpan balasan API apa adanya — termasuk
 * pembungkus `{ success, data }`. Fase 38 memperbaiki pembacaannya, tapi entri
 * cache yang sudah tersimpan tetap berbentuk lama, dan masa berlakunya 30 HARI.
 *
 * Akibatnya, sebulan sesudah bug-nya diperbaiki, pencarian "surabaya" masih
 * mengembalikan objek (bukan array). `collectCandidates` memeriksa
 * `Array.isArray(rows)`, gagal, lalu melapor nol kandidat — dan bot menjawab
 * "ongkir ke Surabaya perlu saya cek dulu" persis seperti sebelum integrasi
 * Mengantar ada. Kodenya sudah benar; cache-nya yang masih menyajikan jawaban
 * dari kode yang rusak. Terpantau 30 Juli 2026.
 *
 * NAIKKAN nomor ini setiap kali bentuk yang disimpan berubah. Dengan begitu
 * entri lama ditinggalkan sendiri, tanpa perlu ada yang ingat membersihkan
 * Redis secara manual — dan "ingat membersihkan Redis" bukan hal yang boleh
 * diandalkan.
 */
const CACHE_PREFIX = 'salespintar:mengantar:v2';
/**
 * Daftar lokasi praktis tidak pernah berubah, jadi hasil yang BERISI boleh
 * disimpan lama.
 */
const ADDRESS_TTL_SEC = 30 * 24 * 60 * 60;
/**
 * Tapi hasil KOSONG hanya sebentar.
 *
 * Niat aslinya benar: tanpa menyimpan hasil kosong, pelanggan yang salah ketik
 * nama kota memicu panggilan API berulang tiap kali ia mengirim ulang pesannya.
 * Yang salah masa berlakunya. "Tidak ketemu" disimpan 30 hari berarti setiap
 * gangguan sesaat — API sedang bermasalah, kunci sempat salah, jaringan
 * terputus — ikut terkunci sebulan untuk kota itu.
 *
 * Sepuluh menit tetap menahan pengiriman berulang dalam satu percakapan, tanpa
 * mengubah kegagalan sesaat jadi kerusakan panjang.
 */
const EMPTY_ADDRESS_TTL_SEC = 10 * 60;
/** Tarif bisa berubah; sehari cukup untuk memangkas panggilan berulang. */
const ESTIMATE_TTL_SEC = 12 * 60 * 60;
const REQUEST_TIMEOUT_MS = 12_000;

export function isMengantarEnabled(): boolean {
  return Boolean(env.MENGANTAR_API_KEY && env.MENGANTAR_BASE_URL);
}

function endpoint(path: string): string {
  const base = env.MENGANTAR_BASE_URL!.replace(/\/+$/, '');
  return `${base}/api/public/${env.MENGANTAR_API_KEY}${path}`;
}

/**
 * Pemanggil dasar. Semua galat berhenti di sini dan menghasilkan `null` —
 * ongkir adalah pelengkap, bukan syarat. Kalau layanannya sedang bermasalah,
 * pelanggan tetap harus mendapat jawaban, cuma tanpa angka.
 */
async function call<T>(path: string, label: string): Promise<T | null> {
  const { data } = await callWithStatus<T>(path, label);
  return data;
}

/**
 * Versi yang ikut melaporkan kode status.
 *
 * Dibutuhkan karena 404 punya arti yang BERBEDA dari kegagalan lain: 404 berarti
 * endpoint-nya memang tidak ada, dan mencobanya lagi selamanya tidak akan pernah
 * berhasil. Kegagalan lain (500, timeout, jaringan) itu sesaat dan layak dicoba
 * ulang. Versi lama menyamakan keduanya sebagai `null`, sehingga endpoint yang
 * tidak pernah ada tetap ditembak pada SETIAP permintaan tarif.
 */
async function callWithStatus<T>(
  path: string,
  label: string,
  diamkanGalat = false,
): Promise<{ data: T | null; status: number | null }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(endpoint(path), {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!res.ok) {
      // Sengaja hanya label, BUKAN url — url memuat kunci API.
      if (!diamkanGalat) logger.warn(`[Mengantar] ${label} gagal (HTTP ${res.status})`);
      return { data: null, status: res.status };
    }
    return { data: (await res.json()) as T, status: res.status };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!diamkanGalat) logger.warn(`[Mengantar] ${label} gagal: ${msg}`);
    return { data: null, status: null };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Buka bungkus balasan.
 *
 * Mengantar membungkus hasilnya di dalam `{ success, data }`, bukan
 * mengembalikan array atau objek telanjang. Versi pertama modul ini membaca
 * balasan apa adanya sehingga selalu menganggapnya kosong — pencarian lokasi
 * "berhasil" di alat uji tapi gagal total di aplikasi, padahal keduanya menembak
 * alamat yang sama.
 *
 * Ditulis menerima DUA bentuk sekaligus supaya tidak pecah lagi kalau nanti
 * bentuknya berubah, dan supaya endpoint yang kebetulan tidak membungkus tetap
 * terbaca.
 */
function unwrap<T>(res: any): T | null {
  if (res === null || res === undefined) return null;
  if (Array.isArray(res)) return res as unknown as T;
  if (res.data !== undefined && res.data !== null) return res.data as T;
  if (res.result !== undefined && res.result !== null) return res.result as T;
  // `success: false` berarti API menjawab tapi menolak permintaannya.
  if (res.success === false) return null;
  return res as T;
}

// ─── Pencarian lokasi ─────────────────────────────────────────────────────────

export interface MengantarLocation {
  /**
   * ID rekaman alamat — INI yang dipakai sebagai origin_id / destination_id.
   *
   * Versi pertama modul ini memakai ORIGIN_CODE / DESTINATION_CODE (bentuknya
   * "TGR10000", "CGK10302") karena dokumentasi menyebut "address data IDs" dan
   * itu saya terjemahkan sebagai kode kurir. Salah: yang diminta adalah _id
   * rekaman alamatnya, bentuknya seperti "5fc62f5df8f44b34aa4c0d8c".
   *
   * Akibat dari salah tebak itu: HTTP 404 pada setiap permintaan tarif.
   */
  _id?: string;
  id?: string;
  DESTINATION_CODE?: string;
  ORIGIN_CODE?: string;
  CITY_NAME?: string;
  PROVINCE_NAME?: string;
  SUBDISTRICT_NAME?: string;
  DISTRICT_NAME?: string;
  ZIP_CODE?: string;
}

/**
 * Cari lokasi. Mengembalikan SELURUH baris, bukan cuma yang pertama.
 *
 * Versi sebelumnya langsung mengambil baris pertama, dan itu sumber bahaya yang
 * paling halus di seluruh fitur ini: kalau baris pertama meleset, yang terjadi
 * bukan galat melainkan tarif yang benar untuk kota yang salah. Pemilihan
 * sekarang diserahkan ke `collectCandidates`, dan kalau kandidatnya lebih dari
 * satu, tarif tiap kandidat dibandingkan dulu sebelum ada yang dikutip.
 */
export async function searchLocations(keyword: string): Promise<MengantarLocation[]> {
  const clean = keyword.trim().toLowerCase();
  if (clean.length < 3) return [];

  const key = `${CACHE_PREFIX}:loc:${clean}`;
  try {
    const cached = await redisCache.get(key);
    if (cached) {
      const parsed = JSON.parse(cached);
      // ── Cache itu masukan dari luar, bukan nilai yang sudah pasti ─────────
      // Dulu di sini langsung `JSON.parse(cached) as MengantarLocation[]`.
      // Kata `as` itu janji kepada pemeriksa tipe, BUKAN pemeriksaan — dan
      // isi Redis bisa saja ditulis oleh versi kode yang sudah tidak ada lagi.
      // Ketika yang tersimpan ternyata objek `{success,data}` dari versi lama,
      // ia mengalir jauh ke dalam sebagai "daftar alamat" dan baru terlihat
      // sebagai "kota tidak ketemu" — gejala yang menunjuk ke arah yang salah.
      if (Array.isArray(parsed)) return parsed as MengantarLocation[];
      logger.warn(`[Mengantar] Cache "${clean}" bentuknya bukan daftar — diabaikan, ambil ulang dari API`);
    }
  } catch { /* Redis bermasalah atau isinya bukan JSON — lanjut tanpa cache */ }

  const raw = await call<any>(
    `/address/search?keyword=${encodeURIComponent(clean)}`,
    'pencarian lokasi',
  );
  const rows = unwrap<MengantarLocation[]>(raw);
  const list = Array.isArray(rows) ? rows : [];

  // Hasil kosong ikut disimpan, tapi jauh lebih singkat — lihat catatan di
  // EMPTY_ADDRESS_TTL_SEC soal kenapa 30 hari untuk "tidak ketemu" itu keliru.
  try {
    const ttl = list.length > 0 ? ADDRESS_TTL_SEC : EMPTY_ADDRESS_TTL_SEC;
    await redisCache.set(key, JSON.stringify(list), 'EX', ttl);
  } catch { /* diabaikan */ }

  return list;
}

// CATATAN: dulu ada `searchLocation()` yang mengembalikan baris pertama saja.
// Sengaja DIHAPUS, bukan dibiarkan menganggur. Fungsi seperti itu terlihat wajar
// dan enak dipakai, lalu suatu hari dipanggil untuk tujuan pengiriman — dan hasil
// yang keluar bukan galat melainkan tarif yang benar untuk kota yang salah.
// Sudah terbukti: baris pertama untuk "bandung" ada di Kab. Tangerang.

/**
 * Kode lokasi gudang. Dicari sekali lalu diingat — asal kirim tidak berubah-ubah,
 * jadi mencarinya setiap kali pelanggan bertanya cuma pemborosan.
 */
let cachedOriginId: string | null = null;

export async function resolveOriginId(): Promise<string | null> {
  if (env.MENGANTAR_ORIGIN_ID) return env.MENGANTAR_ORIGIN_ID;
  if (cachedOriginId) return cachedOriginId;
  if (!env.MENGANTAR_ORIGIN_KEYWORD) {
    logger.warn('[Mengantar] MENGANTAR_ORIGIN_ID dan MENGANTAR_ORIGIN_KEYWORD dua-duanya kosong — ongkir tidak bisa dihitung');
    return null;
  }

  // Kota asal lewat penyaring yang sama seperti tujuan, BUKAN baris pertama.
  //
  // Ini bukan kehati-hatian berlebihan: dengan MENGANTAR_ORIGIN_KEYWORD="bandung",
  // baris pertama hasil pencarian adalah "SUMUR BANDUNG, Jayanti, Kab. Tangerang".
  // Seluruh tarif yang dikutip toko ini akan dihitung dari Tangerang, untuk
  // SEMUA pelanggan, tanpa satu pun galat muncul. Salah asal lebih berbahaya
  // daripada salah tujuan karena kelirunya berlaku menyeluruh.
  const alias = lookupAlias(env.MENGANTAR_ORIGIN_KEYWORD);
  const query = alias?.query ?? env.MENGANTAR_ORIGIN_KEYWORD;
  const rows = await searchLocations(query);
  const cands = collectCandidates(rows as LocationRow[], query, alias?.expect);

  if (cands.length === 0) {
    logger.warn(`[Mengantar] Kota asal "${env.MENGANTAR_ORIGIN_KEYWORD}" tidak ditemukan`);
    return null;
  }
  if (cands.length > 1) {
    // Asal ditentukan pemilik toko, bukan pelanggan — jadi tidak ada siapa pun
    // untuk ditanyai. Yang bisa dilakukan: ambil yang paling mungkin, lalu
    // berteriak di log supaya bisa dipatok pasti lewat MENGANTAR_ORIGIN_ID.
    logger.warn(
      `[Mengantar] Kota asal "${env.MENGANTAR_ORIGIN_KEYWORD}" AMBIGU ` +
      `(${cands.map(c => c.cityLabel).join(', ')}). Dipakai: ${cands[0]!.cityLabel}. ` +
      `Isi MENGANTAR_ORIGIN_ID di .env supaya pasti.`,
    );
  }

  const id = rowAddressId(cands[0]!.row);
  if (id) {
    cachedOriginId = id;
    logger.info(
      `[Mengantar] Kota asal "${env.MENGANTAR_ORIGIN_KEYWORD}" → ` +
      `${prettyPlace(cands[0]!.cityLabel)}, ${prettyPlace(cands[0]!.province)}`,
    );
  }
  return id;
}

// ─── Estimasi ongkir ──────────────────────────────────────────────────────────

interface CourierEstimate {
  unsupported?: boolean;
  /** Tarif dasar ekspedisi. */
  price?: number;
  estimate_delivery?: string;
  /**
   * Harga yang DIKUTIP KE PELANGGAN.
   *
   * ── Koreksi atas keterangan saya yang salah ────────────────────────────────
   * Sampai 30 Juli 2026 field ini saya beri komentar "price + biaya COD, masih
   * sebelum diskon". Itu SALAH, dan Angga mengoreksinya: **Mengantar tidak
   * memberitahukan biaya layanan COD lewat API ini sama sekali.** Jadi selisih
   * antara field ini dan `estimatedSpecialPrice` bukan biaya COD — itu diskon
   * akun.
   */
  estimatedPrice?: number;
  /**
   * BIAYA TOKO, bukan harga pelanggan. Jangan pernah dikutip ke pelanggan.
   *
   * Inilah yang toko bayarkan ke Mengantar sesudah seluruh diskon akun. Selisih
   * antara `estimatedPrice` dan angka ini adalah MARGIN pemilik toko — dan itu
   * memang haknya, karena diskon itu didapat dari akunnya sendiri.
   */
  estimatedSpecialPrice?: number;
  discount?: number;
  discountExtra?: number;
}

/**
 * Harga mana yang dikutip ke pelanggan, dan mana yang cuma biaya toko.
 *
 * ── Keputusan bisnis Angga, 30 Juli 2026 ────────────────────────────────────
 * Yang dikutip ke pelanggan `estimatedPrice`. Yang dibayar toko ke Mengantar
 * `estimatedSpecialPrice`. Selisihnya margin pemilik toko, dan itu memang
 * haknya — diskon itu didapat dari akunnya sendiri, bukan dari ekspedisi.
 *
 * Kata Angga: "aku maunya pake estimatedPrice yg lebih mahal (karena selisih
 * diskonnya buat aku) kalau dikasi spesialprice aku gak dapat untung dari
 * selisih diskon ongkir."
 *
 * ── Kesalahan saya yang perlu dicatat, bukan dilupakan ──────────────────────
 * Pada Fase 38 saya MENGUBAH urutan ini ke arah yang berlawanan, dan menulis di
 * ledger bahwa itu memperbaiki "kutipan 54% terlalu mahal". Contoh yang saya
 * pakai: price 26.000 sementara estimatedSpecialPrice 16.904.
 *
 * Perhitungannya benar; kesimpulannya salah. Saya menganggap harga yang benar
 * adalah yang dibayar TOKO, tanpa pernah menanyakan apakah margin dari diskon
 * itu memang bagian dari model usahanya. Selama beberapa jam sesudah itu, setiap
 * kutipan ongkir menyerahkan seluruh margin ongkir Angga ke pelanggan — dan
 * karena angkanya "benar" secara teknis, tidak ada satu pun galat yang muncul.
 *
 * Pelajarannya: soal ANGKA MANA yang benar untuk dikutip bukan pertanyaan
 * teknis. Itu pertanyaan bisnis, dan jawabannya cuma ada di pemilik usaha.
 *
 * Urutannya sekarang: harga pelanggan dulu, lalu tarif dasar sebagai cadangan.
 * `estimatedSpecialPrice` dipakai HANYA kalau dua-duanya tidak ada — lebih baik
 * mengutip angka yang terlalu murah daripada tidak bisa menjawab sama sekali,
 * tapi itu keadaan yang seharusnya tidak pernah terjadi.
 */
function hargaKePelanggan(d: CourierEstimate): number | null {
  const kandidat = [d.estimatedPrice, d.price, d.estimatedSpecialPrice];
  for (const n of kandidat) {
    if (typeof n === 'number' && n > 0) return n;
  }
  return null;
}

/**
 * Biaya toko ke Mengantar. HANYA untuk log dan perhitungan margin.
 *
 * TIDAK BOLEH masuk ke potongan pengetahuan. Kalau angka ini sampai ke konteks
 * yang dibaca model saat menyusun jawaban, model bisa menyebutkannya ke
 * pelanggan — dan pelanggan yang tahu harga aslinya akan menawar ke situ.
 */
function biayaToko(d: CourierEstimate): number | null {
  return typeof d.estimatedSpecialPrice === 'number' && d.estimatedSpecialPrice > 0
    ? d.estimatedSpecialPrice
    : null;
}

/**
 * Nama ekspedisi sebagaimana pelanggan mengenalnya.
 *
 * ── Kenapa peta ini perlu ada ───────────────────────────────────────────────
 * Kunci yang dikembalikan API itu nama internal, dan bot mengutipnya apa adanya
 * ke pelanggan. Terpantau di audit 30 Juli 2026:
 *
 *     - SAPLite: Rp 7.245
 *     - SiCepatCargo: Rp 7.699
 *     - JT: Rp 4.900
 *     - iDexpress: Rp 23.000
 *
 * "JT" bukan cara siapa pun menulis J&T, dan "SAPLite" tidak ada di kepala
 * pelanggan mana pun. Pelanggan sedang memilih ekspedisi untuk paketnya — nama
 * yang tidak dia kenali membuatnya ragu, dan ragu di titik itu berarti pesanan
 * tidak jadi.
 *
 * Kuncinya huruf kecil supaya pencocokannya tidak bergantung pada cara API
 * menuliskan huruf besarnya, yang bisa berubah tanpa pemberitahuan.
 */
const NAMA_EKSPEDISI: Record<string, string> = {
  jne: 'JNE',
  jnt: 'J&T',
  jt: 'J&T',
  'j&t': 'J&T',
  jtcargo: 'J&T Cargo',
  sicepat: 'SiCepat',
  sicepatcargo: 'SiCepat Cargo',
  ninja: 'Ninja Xpress',
  ninjaxpress: 'Ninja Xpress',
  anteraja: 'AnterAja',
  sap: 'SAP Express',
  sapexpress: 'SAP Express',
  // SAPLite layanan yang BERBEDA, bukan sekadar penulisan lain dari SAP Express.
  // Sempat saya samakan; itu keliru — pelanggan yang memilih "SAP Express" lalu
  // menerima layanan Lite tidak mendapat yang ia kira.
  saplite: 'SAP Express Lite',
  lion: 'Lion Parcel',
  lionparcel: 'Lion Parcel',
  pos: 'POS Indonesia',
  posindonesia: 'POS Indonesia',
  idexpress: 'ID Express',
  ide: 'ID Express',
  // Varian kargo, disebut eksplisit di dokumentasi Mengantar. Tanpa entri ini
  // "JNECargo" lolos ke pelanggan apa adanya — perapi otomatis tidak bisa
  // memecahnya karena tidak ada batas huruf-kecil-ke-besar di "JNEC".
  jnecargo: 'JNE Cargo',
  sapcargo: 'SAP Express Cargo',
  idexpresscargo: 'ID Express Cargo',
  paxel: 'Paxel',
  wahana: 'Wahana',
  tiki: 'TIKI',
  rex: 'REX',
  sentral: 'Sentral Cargo',
};

/** Nama yang enak dibaca, atau bentuk rapi kalau kuncinya belum dikenali. */
function namaEkspedisi(kunci: string): string {
  const k = String(kunci ?? '').trim();
  const cocok = NAMA_EKSPEDISI[k.toLowerCase().replace(/[\s_-]/g, '')];
  if (cocok) return cocok;
  // Belum dikenali: pisahkan gabungan kata ("SiCepatCargo" → "Si Cepat Cargo")
  // supaya setidaknya terbaca sebagai kata, bukan sebagai kode.
  return k.replace(/([a-z])([A-Z])/g, '$1 $2').trim() || k;
}

/**
 * Estimasi waktu yang layak dibaca pelanggan Indonesia.
 *
 * API mengembalikan teks apa adanya dari ekspedisi, dan bentuknya campur aduk:
 * "2 - 4 days", "2 - 3 Days", string kosong. Yang bocor ke audit:
 *
 *     - SAPLite: Rp 7.245 (estimasi 2 - 4 days)
 *     - Ninja: Rp 6.655 (estimasi)          ← kosong, tapi tanda kurungnya tetap muncul
 *
 * Bahasa Inggris di tengah kalimat Indonesia terasa seperti bocoran sistem, dan
 * "(estimasi)" tanpa isi lebih buruk daripada tidak ada tulisan sama sekali —
 * ia menjanjikan keterangan lalu tidak memberikannya.
 *
 * Mengembalikan `undefined` kalau tidak ada yang berguna, supaya pemanggilnya
 * bisa memilih tidak menulis apa pun.
 */
function rapikanEstimasi(mentah: string | undefined): string | undefined {
  let t = String(mentah ?? '').trim();
  if (!t) return undefined;
  t = t
    .replace(/\bdays?\b/gi, 'hari')
    .replace(/\bhours?\b/gi, 'jam')
    .replace(/\bweeks?\b/gi, 'minggu')
    .replace(/\s*-\s*/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
  // Harus memuat angka; "estimasi tidak tersedia" bukan estimasi.
  if (!/\d/.test(t)) return undefined;
  // Kalau satuannya belum tersebut, tambahkan — "2-3" saja ambigu.
  if (!/\b(hari|jam|minggu)\b/i.test(t)) t = `${t} hari`;
  return t;
}

/**
 * Penanda "TIDAK bisa COD" di baris alamat tujuan, per ekspedisi.
 *
 * ── Kenapa ini datang dari API, bukan dari dokumen ──────────────────────────
 * Dukungan COD berbeda per TUJUAN dan per EKSPEDISI sekaligus. Itu ribuan
 * kombinasi yang berubah sendiri saat ekspedisi mengubah jangkauannya.
 *
 * Dokumen `02-ongkos-kirim.md` versi pertama saya menyuruh pemilik toko mengisi
 * "daerah yang tidak bisa COD" dan "ekspedisi mana saja yang melayani COD"
 * secara manual. Angga mengoreksinya: itu ngaco, datanya banyak dan dinamis.
 * Dia benar, dan kesalahannya sejenis dengan menaruh tarif ongkir di dokumen —
 * dua-duanya fakta yang hanya benar pada satu saat, untuk satu tujuan.
 *
 * Mengantar sudah menyediakan jawabannya di baris alamat. Jadi ini dibaca, bukan
 * ditulis.
 *
 * ── Sekarang dicocokkan ke daftar kode kurir RESMI ─────────────────────────
 * Dokumentasi Mengantar (app.mengantar.com/docs) menyebutkan nilai sah untuk
 * parameter `courier` pada endpoint estimate:
 *
 *     'JNE' | 'SiCepat' | 'Sap' | 'iDexpress' | 'JT' | 'Ninja' | 'lion' | 'anteraja'
 *     ditambah varian kargo: SiCepatCargo, JNECargo, SapCargo, iDexpressCargo
 *
 * Dicocokkan dengan akhiran field COD yang ada di data alamat, tujuh dari
 * delapan kurir berpasangan langsung: Sap→Sap, JT→JT, lion→Lion, Ninja→Ninja,
 * anteraja→Anteraja, iDexpress→Id, SiCepat→Si.
 *
 * ── Dan satu temuan yang penting: JNE TIDAK PUNYA field COD ────────────────
 * Data alamat memuat `unsupportedJNE` (untuk pengiriman biasa) tapi TIDAK ada
 * `unsupportedCodJNE`. Jadi dukungan COD JNE memang tidak bisa diketahui dari
 * API ini — bukan karena petanya kurang lengkap.
 *
 * JNE sengaja TIDAK didaftarkan di bawah, supaya `statusCod()` melaporkannya
 * "belum diketahui". Jangan menambahkannya dengan tebakan: JNE kebetulan juga
 * ekspedisi yang disarankan toko ini kalau pelanggan tidak memilih, jadi
 * tebakan yang salah di sini akan mengenai jalur yang paling sering dipakai.
 *
 * Dokumentasi juga tidak menjelaskan arti field-field ini satu per satu — yang
 * dikonfirmasi baru daftar kurirnya. Karena itu ekspedisi tanpa padanan tetap
 * dilaporkan "belum diketahui", BUKAN "bisa": menjanjikan COD yang ternyata
 * tidak ada berarti pesanan batal di langkah terakhir, sesudah pelanggan
 * menunggu.
 */
const FIELD_TIDAK_BISA_COD: Record<string, string[]> = {
  'SiCepat': ['unsupportedCodSi'],
  'SiCepat Cargo': ['unsupportedCodSi'],
  'SAP Express': ['unsupportedCodSap', 'unsupportedCodCheckFirstSap'],
  'SAP Express Lite': ['unsupportedCodSap', 'unsupportedCodCheckFirstSap'],
  'SAP Express Cargo': ['unsupportedCodSap', 'unsupportedCodCheckFirstSap'],
  'J&T': ['unsupportedCodJT'],
  'J&T Cargo': ['unsupportedCodJT'],
  'Lion Parcel': ['unsupportedCodLion'],
  'Ninja Xpress': ['unsupportedCodNinja'],
  'AnterAja': ['unsupportedCodAnteraja'],
  'ID Express': ['unsupportedCodId'],
  'ID Express Cargo': ['unsupportedCodId'],
  'Paxel': ['unsupportedCodPaxel'],
  // JNE dan JNE Cargo SENGAJA tidak ada di sini — tidak ada
  // `unsupportedCodJNE` di data alamat. Lihat catatan di atas.
};

/** Dibuka untuk alat pemeriksa `cek-cod.ts`, supaya yang diaudit peta yang SAMA. */
export const __PETA_COD = FIELD_TIDAK_BISA_COD;
export const __NAMA_EKSPEDISI = NAMA_EKSPEDISI;
export { namaEkspedisi as __namaEkspedisi, statusCod as __statusCod };

/**
 * Penanda "ekspedisi ini TIDAK MELAYANI tujuan ini sama sekali" — bukan soal COD.
 *
 * ── Dari antarmuka Mengantar sendiri, 30 Juli 2026 ─────────────────────────
 * Tampilan cek ongkir Mengantar memakai tiga lambang, dan legendanya menjelaskan
 * seluruh model datanya:
 *
 *     🟠  tidak melayani COD ke tujuan ini
 *     ❌  tidak melayani COD MAUPUN NON-COD ke tujuan ini
 *     🟪  tidak melayani alamat ASAL
 *
 * Jadi liputan itu BERTINGKAT, dan versi kode sebelumnya cuma membaca tingkat
 * pertama. Pada contoh Tangerang → Kota Deli Serdang, JNE bertanda ❌ — tidak
 * melayani sama sekali — TAPI TETAP MENAMPILKAN HARGA Rp 47.200.
 *
 * Artinya endpoint tarif memberi angka untuk kombinasi yang sebenarnya tidak
 * bisa dikirim. Tanpa pemeriksaan ini, bot mengutip harga itu ke pelanggan,
 * pelanggan memilihnya, dan pesanannya baru gagal waktu hendak dibuat.
 *
 * ── Dan inilah yang menjelaskan JNE ────────────────────────────────────────
 * Tidak ada `unsupportedCodJNE` di data BUKAN karena datanya kurang lengkap.
 * Untuk JNE memang tidak ada keadaan "melayani non-COD tapi tidak COD" — ia
 * melayani dua-duanya, atau tidak melayani sama sekali. Itu sebabnya Angga
 * bilang liputan COD JNE justru paling luas, dan itu cocok dengan datanya.
 *
 * Jadi `unsupportedJNE` bernilai false sekarang berarti **bisa COD**, bukan
 * "belum diketahui" seperti kesimpulan saya di Fase 54.
 */
const FIELD_TIDAK_MELAYANI: Record<string, string[]> = {
  'JNE': ['unsupportedJNE'],
  'JNE Cargo': ['unsupportedJNE'],
  'SiCepat': ['unsupportedSi'],
  'SiCepat Cargo': ['unsupportedSi'],
  'SAP Express': ['unsupportedSap'],
  'SAP Express Lite': ['unsupportedSap'],
  'SAP Express Cargo': ['unsupportedSap'],
  'J&T': ['unsupportedJT'],
  'J&T Cargo': ['unsupportedJT'],
  'Lion Parcel': ['unsupportedLion'],
  'Ninja Xpress': ['unsupportedNinja'],
  'ID Express': ['unsupportedId'],
  'ID Express Cargo': ['unsupportedId'],
  'Paxel': ['unsupportedPaxel'],
};

/** Penanda menyeluruh: tujuan ini tidak bisa COD lewat ekspedisi mana pun. */
const FIELD_COD_MENYELURUH = 'unsupportedCod';

/**
 * Apakah ekspedisi ini melayani tujuan tersebut sama sekali?
 *
 * Dipakai untuk MEMBUANG kurir dari daftar kutipan — bukan sekadar menandainya.
 * Mengutip harga untuk pengiriman yang tidak mungkin terjadi lebih buruk
 * daripada tidak menyebutkannya: pelanggan sudah memilih dan sudah menunggu
 * waktu kegagalannya ketahuan.
 */
function melayaniTujuan(row: LocationRow, namaTampilan: string): boolean {
  const fields = FIELD_TIDAK_MELAYANI[namaTampilan];
  if (!fields || fields.length === 0) return true;   // tidak dikenali → jangan dibuang
  const r = row as Record<string, unknown>;
  return !fields.some(f => benar(r[f]));
}

export type StatusCod = 'bisa' | 'tidak' | 'belum diketahui';

function benar(v: unknown): boolean {
  return v === true || v === 'true' || v === 1 || v === '1';
}

/**
 * Bisa COD atau tidak, untuk satu ekspedisi ke satu tujuan.
 *
 * Mengembalikan 'belum diketahui' kalau tidak ada penanda yang bisa dibaca.
 * Ketidaktahuan dilaporkan apa adanya, tidak dibulatkan jadi 'bisa' — karena
 * yang menanggung akibat tebakan yang salah pelanggan yang pesanannya batal.
 */
function statusCod(row: LocationRow, namaTampilan: string): StatusCod {
  const r = row as Record<string, unknown>;

  // Tingkat 0 — penanda menyeluruh untuk tujuan ini.
  if (benar(r[FIELD_COD_MENYELURUH])) return 'tidak';

  // Tingkat 1 — tidak melayani sama sekali berarti tidak melayani COD juga.
  // Urutannya penting: kurir yang tidak melayani tujuan tidak boleh dinilai
  // "bisa COD" hanya karena penanda COD-nya kebetulan kosong.
  if (!melayaniTujuan(row, namaTampilan)) return 'tidak';

  // Tingkat 2 — melayani, tapi mungkin hanya untuk non-COD.
  const fieldsCod = FIELD_TIDAK_BISA_COD[namaTampilan] ?? [];
  if (fieldsCod.some(f => benar(r[f]))) return 'tidak';
  if (fieldsCod.some(f => f in r)) return 'bisa';

  // Tidak punya penanda COD tersendiri. Untuk kurir seperti JNE itu BUKAN
  // ketidaktahuan: memang tidak ada keadaan "melayani non-COD tapi tidak COD".
  // Selama kita tahu ia melayani tujuan ini, berarti ia melayani COD juga.
  const fieldsLayan = FIELD_TIDAK_MELAYANI[namaTampilan] ?? [];
  if (fieldsLayan.some(f => f in r)) return 'bisa';

  // Benar-benar tidak ada penanda apa pun — kurir baru yang belum dikenali.
  return 'belum diketahui';
}

export interface ShippingQuote {
  courier: string;
  /** Harga yang dikutip ke pelanggan (`estimatedPrice`). */
  price: number;
  eta?: string;
  /**
   * Biaya toko ke Mengantar. Dipakai HANYA untuk menghitung margin di log.
   *
   * Sengaja tidak ikut ke `quotesToKnowledgeChunk` — lihat catatan di
   * `biayaToko()` soal kenapa angka ini tidak boleh sampai ke model.
   */
  cost?: number;
  /** Bisa COD atau tidak untuk tujuan ini. Dibaca dari data alamat. */
  cod: StatusCod;
}

export interface ShippingResult {
  ambiguous?: false;
  unresolved?: false;
  destinationLabel: string;
  weightKg: number;
  quotes: ShippingQuote[];
}

/**
 * Kota tujuan belum pasti DAN selisih tarifnya cukup besar untuk merugikan.
 * Bot harus bertanya — pertanyaannya sudah disusun, siap dikirim apa adanya.
 */
export interface AmbiguousDestination {
  ambiguous: true;
  /** Mis. "Surabayanya yang di Jawa Timur atau yang di Lampung ya Kak?" */
  question: string;
  keyword: string;
  /**
   * Kata pembeda yang WAJIB muncul di balasan yang dikirim ke pelanggan.
   *
   * Dipakai memeriksa hasil model bahasa. Kalau tidak satu pun muncul, berarti
   * pertanyaannya tidak tersampaikan dan `question` di atas yang dikirim apa
   * adanya. Lihat catatan di `questionMustMention`.
   */
  mustMention: string[];
  /**
   * Pilihan yang ditawarkan, lengkap dengan id alamatnya.
   *
   * Disertakan supaya giliran berikutnya tidak perlu mencari ulang: jawaban
   * pelanggan cukup DICOCOKKAN ke daftar ini, lalu tarifnya diambil langsung.
   * Lihat catatan panjang di `PendingShippingQuestion.choices`.
   */
  choices: Array<{ addressId: string; cityLabel: string; province: string }>;
}

/**
 * Sudah ditanya sekali, jawabannya tetap tidak menyelesaikan, dan selisih
 * tarifnya besar. Bot menyerah dan menyerahkan ke manusia.
 *
 * Ini sengaja ADA sebagai keadaan tersendiri, bukan digabung dengan "tidak
 * ketemu". Bot yang menanyakan hal yang sama dua kali terasa lebih bodoh
 * daripada bot yang mengaku perlu dibantu orang — dan mengutip angka yang bisa
 * salah 186% jauh lebih mahal daripada dua-duanya.
 */
export interface UnresolvedDestination {
  unresolved: true;
  keyword: string;
}

export type ShippingLookup = ShippingResult | AmbiguousDestination | UnresolvedDestination;

/**
 * Di bawah selisih ini, kandidat mana pun yang dipilih tidak mengubah apa yang
 * dibayar secara berarti — jadi lebih baik langsung menjawab daripada bertanya.
 *
 * Dari pengukuran: empat kecamatan di Bandung memberi selisih NOL pada sembilan
 * dari sepuluh ekspedisi. Ambiguitas semacam itu memang tidak perlu diributkan.
 * Sebaliknya Kota Surabaya vs kecamatan Surabaya di Lampung berselisih 127–186%,
 * dan itu yang wajib ditanyakan.
 */
function safeGapPercent(): number {
  return env.MENGANTAR_SAFE_GAP_PERCENT;
}

/**
 * Berapa kandidat yang tarifnya diperbandingkan.
 *
 * Dibatasi tiga karena tiap kandidat berarti satu panggilan tarif. Kalau
 * kandidatnya lebih banyak dari ini dan bot masih boleh bertanya, bertanya jauh
 * lebih murah daripada membandingkan semuanya.
 */
const MAX_COMPARE = 3;

/**
 * Ambil tarif semua ekspedisi sekaligus.
 *
 * Yang diambil harga Mengantar yang sudah termasuk markup dan diskon mereka —
 * itu yang benar untuk toko yang mengirim LEWAT Mengantar, sebab itulah yang
 * benar-benar dibayar. Endpoint `allEstimate3PL` memberi tarif mentah ekspedisi
 * dan akan membuat pelanggan dikutip lebih murah dari biaya sesungguhnya — rugi
 * di tiap transaksi.
 *
 * Endpoint mana yang dipakai ditentukan sendiri saat berjalan; lihat catatan di
 * `ESTIMATE_ENDPOINTS`.
 */
/**
 * Potongan kata kunci yang lebih pendek, dari yang paling panjang ke yang
 * paling pendek, dengan membuang kata dari BELAKANG.
 *
 * `"padang totalnya brp"` → `["padang totalnya", "padang"]`.
 *
 * Membuang dari belakang, bukan dari depan, karena nama tempat selalu berada
 * di awal frasa yang diambil sesudah kata "ke" — yang menempel di belakangnya
 * itulah sisa kalimat pelanggan ("totalnya", "harganya", "semuanya").
 *
 * Potongan sepanjang <3 huruf dibuang: terlalu pendek untuk dicari sebagai
 * nama tempat, dan hampir pasti mengembalikan kandidat yang tidak nyambung.
 */
/**
 * Kata yang TIDAK PERNAH boleh berdiri sendiri sebagai kata kunci alamat.
 *
 * ── Cacat yang ditutup di sini (Fase 111) ───────────────────────────────────
 * Pemenggalan di `potonganKataKunci()` membuang kata dari BELAKANG. Untuk nama
 * tempat Indonesia itu justru terbalik: yang di depan sering cuma penanda
 * administratif, dan NAMANYA ada di belakang. Akibatnya terukur 2 Agustus 2026:
 *
 *     "kabupaten pati" → tidak ketemu → dipendekkan jadi "kabupaten"
 *                      → 1 kandidat → dikutip tarif KABUPATEN KLATEN
 *
 * Pelanggan bertanya ongkir ke Pati dan menerima tarif Klaten — dengan yakin,
 * tanpa satu pun galat muncul. Itu bentuk kegagalan terburuk di sistem ini:
 * angka yang salah tapi terlihat sah.
 *
 * Menambah kata satu per satu ke daftar ini bukan obatnya; yang menghapus
 * KELASNYA adalah aturan bahwa sisa pemenggalan yang SELURUHNYA kata umum tidak
 * pernah boleh dipakai mencari alamat.
 */
const KATA_UMUM_ALAMAT = new Set([
  'kabupaten', 'kab', 'kota', 'kotamadya', 'kec', 'kecamatan', 'kel', 'kelurahan',
  'desa', 'dusun', 'provinsi', 'prov', 'daerah', 'wilayah', 'kepulauan', 'pulau',
  'jalan', 'jln', 'jl', 'alamat', 'tujuan', 'ke', 'di', 'dari',
]);

function potonganKataKunci(keyword: string): string[] {
  const kata = keyword.trim().split(/\s+/).filter(Boolean);
  const hasil: string[] = [];
  for (let n = kata.length - 1; n >= 1; n--) {
    const potongan = kata.slice(0, n);
    // Sisa yang seluruhnya kata umum bukan nama tempat — lihat catatan di atas.
    if (potongan.every(w => KATA_UMUM_ALAMAT.has(w.toLowerCase()))) continue;
    const kandidat = potongan.join(' ');
    if (kandidat.length >= 3) hasil.push(kandidat);
  }
  return hasil;
}

export async function getShippingQuotes(params: {
  destinationKeyword: string;
  weightKg?: number;
  /**
   * Bot masih boleh bertanya?
   *
   * `false` pada giliran susulan — pelanggan sudah pernah ditanya sekali, dan
   * menanyakannya lagi lebih buruk daripada menyerah.
   */
  allowAsk?: boolean;
}): Promise<ShippingLookup | null> {
  if (!isMengantarEnabled()) return null;

  const allowAsk = params.allowAsk !== false;
  const weight = params.weightKg && params.weightKg > 0
    ? params.weightKg
    : env.MENGANTAR_DEFAULT_WEIGHT_KG;

  // ── Tabel padanan dulu ────────────────────────────────────────────────────
  // Untuk sebagian nama ("solo", "malang"), kota yang dimaksud TIDAK MUNCUL
  // SAMA SEKALI di hasil pencarian — 50 baris pertama sudah habis dipakai
  // kelurahan bernama sama di kabupaten lain. Tidak ada logika pemilihan yang
  // bisa menolong kalau datanya memang tidak sampai; yang bisa cuma mengganti
  // kata kuncinya dengan yang terbukti berhasil.
  let alias = lookupAlias(params.destinationKeyword);
  const queryKeyword = alias?.query ?? params.destinationKeyword;

  const cariKandidat = async (kw: string, harap = alias?.expect) =>
    collectCandidates((await searchLocations(kw)) as LocationRow[], kw, harap);

  const [originId, kandidatPertama] = await Promise.all([
    resolveOriginId(),
    cariKandidat(queryKeyword),
  ]);
  if (!originId) return null;

  // ── Kata kunci penuh dulu, baru dipotong dari belakang ────────────────────
  // `detectShippingIntent()` mengambil sampai TIGA kata sesudah "ke" dan cuma
  // berhenti pada daftar kata sambung yang ditulis tangan. Kalimat pelanggan
  // tidak menurut daftar itu: "order 1 golok sembelih kirim ke padang totalnya
  // brp kak" menghasilkan kata kunci `"padang totalnya"` — pencarian alamat
  // mengembalikan NOL baris, tarif sungguhan tidak pernah disuntikkan, dan
  // model lalu MENGARANG ongkirnya sendiri ("Ongkir ke Padang via JNE adalah
  // Rp 50.000", kejadian nyata 1 Agustus 2026, ditangkap Supervisor 60/HIGH).
  //
  // Menambahkan "totalnya" ke daftar kata sambung cuma menunda kejadian
  // berikutnya — kalimat pelanggan tidak terbatas, daftar kata buatan tangan
  // terbatas. Yang dilakukan di sini menghapus KELASNYA: kalau kata kunci utuh
  // tidak menghasilkan satu kandidat pun, coba lagi tanpa kata TERAKHIR, lalu
  // tanpa dua kata terakhir, dan seterusnya sampai tersisa satu kata.
  //
  // Urutannya sengaja dari yang PALING PANJANG: nama kota yang memang terdiri
  // dari beberapa kata ("bandar lampung", "kota bekasi", "jakarta selatan")
  // tetap dicoba utuh lebih dulu, jadi pemenggalan hanya terjadi kalau versi
  // utuhnya memang tidak ada di daftar alamat. Kata kunci yang dipakai dicatat
  // ke log supaya kalau suatu saat ia memilih kota yang salah, sebabnya
  // kelihatan tanpa perlu menebak.
  let candidates = kandidatPertama;
  let keywordDipakai = queryKeyword;
  if (candidates.length === 0) {
    for (const kwPendek of potonganKataKunci(queryKeyword)) {
      // Tabel padanan HARUS dicari ulang untuk kata kunci yang sudah dipendekkan.
      // Tanpa ini, "padang totalnya" jatuh ke "padang" tapi tetap memakai padanan
      // milik "padang totalnya" (tidak ada) — hasilnya bot menanyakan "Padangnya
      // provinsi mana?" padahal pertanyaan "ongkir ke padang" polos langsung
      // terjawab Kota Padang. Kata kunci yang sama harus berperilaku sama, tidak
      // peduli lewat jalan mana ia sampai ke sini.
      const aliasPendek = lookupAlias(kwPendek);
      const kwCari = aliasPendek?.query ?? kwPendek;
      const hasilPendek = await cariKandidat(kwCari, aliasPendek?.expect);
      if (hasilPendek.length === 0) continue;
      candidates = hasilPendek;
      keywordDipakai = kwPendek;
      alias = aliasPendek;
      logger.info(
        `[Mengantar] "${queryKeyword}" tidak ketemu; dicoba ulang sebagai ` +
        `"${kwPendek}" → ${hasilPendek.length} kandidat`,
      );
      break;
    }
  }
  if (candidates.length === 0) {
    logger.info(`[Mengantar] "${params.destinationKeyword}" tidak ketemu di daftar alamat`);
    return null;
  }

  // ── Satu kandidat: tidak ada yang perlu ditanyakan ────────────────────────
  if (candidates.length === 1) {
    return quoteFor(candidates[0]!, originId, weight, alias?.label);
  }

  // ── Terlalu banyak kandidat dan masih boleh bertanya ──────────────────────
  // Bertanya di sini lebih murah daripada memanggil tarif tiga kali, dan dengan
  // kandidat sebanyak ini salah satunya hampir pasti di provinsi yang jauh.
  if (candidates.length > MAX_COMPARE && allowAsk) {
    return bertanya(candidates, keywordDipakai);
  }

  // ── Bandingkan tarifnya dulu, baru putuskan perlu bertanya atau tidak ─────
  // Inilah yang memisahkan ambiguitas yang merugikan dari ambiguitas yang tidak
  // ada bedanya. Tanpa langkah ini, bot akan menanyai pelanggan Kota-atau-
  // Kabupaten Bandung padahal sembilan dari sepuluh ekspedisi memberi angka yang
  // sama persis — pertanyaan yang cuma bikin pelanggan mengetik tanpa guna.
  const dibandingkan = candidates.slice(0, MAX_COMPARE);
  const hasil = await Promise.all(
    dibandingkan.map(c => quoteFor(c, originId, weight, undefined)),
  );
  const berhasil = hasil
    .map((r, i) => ({ r, c: dibandingkan[i]! }))
    .filter((x): x is { r: ShippingResult; c: Candidate } => x.r !== null && x.r.quotes.length > 0);

  if (berhasil.length === 0) return null;

  // Kalau cuma satu kandidat yang tarifnya bisa diambil, ambiguitasnya selesai
  // dengan sendirinya — yang lain tidak dilayani ekspedisi mana pun.
  if (berhasil.length === 1) return berhasil[0]!.r;

  // Yang dibandingkan tarif TERMURAH tiap kandidat, karena itu yang paling
  // mungkin dipilih pelanggan dan itu yang muncul paling atas di jawaban.
  const termurah = berhasil.map(x => x.r.quotes[0]!.price);
  const min = Math.min(...termurah);
  const max = Math.max(...termurah);
  const selisihPersen = min > 0 ? ((max - min) / min) * 100 : 100;

  const daftar = berhasil
    .map((x, i) => `${x.c.cityLabel} Rp${termurah[i]!.toLocaleString('id-ID')}`)
    .join(' | ');

  if (selisihPersen <= safeGapPercent()) {
    // Kandidat terbanyak barisnya yang dipakai — bukan karena pasti benar,
    // melainkan karena pada selisih sekecil ini pilihan mana pun sama saja.
    const dominan = berhasil[0]!;
    logger.info(
      `[Mengantar] "${keywordDipakai}" ambigu tapi selisih cuma ` +
      `${selisihPersen.toFixed(1)}% (${daftar}) — dijawab langsung pakai ${dominan.c.cityLabel}`,
    );
    return dominan.r;
  }

  if (allowAsk) {
    logger.info(
      `[Mengantar] "${keywordDipakai}" ambigu, selisih ${selisihPersen.toFixed(0)}% ` +
      `(${daftar}) — tarif TIDAK dikutip, bot bertanya dulu`,
    );
    return bertanya(berhasil.map(x => x.c), keywordDipakai);
  }

  logger.warn(
    `[Mengantar] "${keywordDipakai}" masih ambigu SESUDAH ditanya, ` +
    `selisih ${selisihPersen.toFixed(0)}% (${daftar}) — diserahkan ke manusia`,
  );
  return { unresolved: true, keyword: keywordDipakai };
}

function bertanya(candidates: Candidate[], keyword: string): AmbiguousDestination {
  return {
    ambiguous: true,
    question: buildQuestion(keyword, candidates),
    keyword,
    mustMention: questionMustMention(candidates),
    choices: candidates
      .map(c => ({
        addressId: rowAddressId(c.row) ?? '',
        cityLabel: prettyPlace(c.cityLabel),
        province: prettyPlace(c.province),
      }))
      .filter(c => c.addressId),
  };
}

/**
 * Ambil tarif untuk satu pilihan yang SUDAH dipastikan.
 *
 * Dipakai pada giliran susulan, sesudah jawaban pelanggan dicocokkan ke daftar
 * pilihan. Tidak ada pencarian lokasi lagi di sini — id alamatnya sudah ada,
 * jadi tidak ada lagi kesempatan bagi kata kunci yang salah susun untuk
 * menggagalkan seluruh percakapan.
 */
export async function getShippingQuotesForChoice(params: {
  addressId: string;
  cityLabel: string;
  province: string;
  weightKg?: number | null;
}): Promise<ShippingResult | null> {
  if (!isMengantarEnabled()) return null;

  const originId = await resolveOriginId();
  if (!originId) return null;

  const weight = params.weightKg && params.weightKg > 0
    ? params.weightKg
    : env.MENGANTAR_DEFAULT_WEIGHT_KG;

  // ── Kenapa alamatnya dicari ulang di sini ─────────────────────────────────
  // Yang tersimpan di ingatan percakapan cuma `addressId`, dan itu cukup untuk
  // mengambil tarif. Tapi TIDAK cukup untuk mengetahui dukungan COD, karena
  // penandanya ada di baris alamat lengkapnya — bukan di hasil tarif.
  //
  // Untuk toko yang 90 persen pesanannya COD, kehilangan keterangan itu di
  // giliran kedua berarti bot menyebut ekspedisi yang tidak bisa COD tepat pada
  // saat pelanggan sudah memilih tujuan dan siap memesan.
  //
  // Pencarian ulangnya murah: hasil pencarian alamat di-cache 30 hari.
  let row: LocationRow = { _id: params.addressId };
  try {
    const rows = await searchLocations(params.cityLabel.replace(/^(Kota|Kabupaten)\s+/i, ''));
    const cocok = (rows as LocationRow[]).find(r => addressIdDari(r) === params.addressId);
    if (cocok) row = cocok;
  } catch { /* gagal mencari — lanjut tanpa keterangan COD */ }

  const cand: Candidate = {
    row,
    cityLabel: params.cityLabel,
    province: params.province,
    weight: 1,
    primary: true,
  };
  return quoteFor(cand, originId, weight, undefined);
}

/** Ambil tarif untuk satu kandidat. `null` kalau tidak ada yang bisa diambil. */
async function quoteFor(
  cand: Candidate,
  originId: string,
  weight: number,
  aliasLabel?: string,
): Promise<ShippingResult | null> {
  const destId = rowAddressId(cand.row);
  if (!destId) return null;

  const raw = await fetchEstimates(originId, destId, weight);
  if (!raw) return null;

  const quotes: ShippingQuote[] = [];
  for (const [courier, data] of Object.entries(raw)) {
    // Kunci pembungkus yang mungkin ikut terbawa kalau bentuk balasannya
    // berbeda. Tanpa penyaring ini, "success" bisa terbaca sebagai ekspedisi.
    if (['success', 'message', 'status', 'data', 'result'].includes(courier)) continue;
    if (!data || typeof data !== 'object') continue;
    if (data.unsupported) continue;
    const price = hargaKePelanggan(data);
    if (price === null) continue;
    const nama = namaEkspedisi(courier);

    // ── Buang yang tidak melayani tujuan ini ────────────────────────────────
    // Endpoint tarif TETAP memberi angka untuk kombinasi yang tidak terlayani —
    // terlihat langsung di antarmuka Mengantar: JNE bertanda "tidak melayani
    // COD maupun non-COD" ke Kota Deli Serdang, tapi harganya tetap tampil.
    // Jadi `data.unsupported` dari balasan tarif saja tidak cukup; liputan
    // sesungguhnya ada di baris alamat.
    if (!melayaniTujuan(cand.row, nama)) {
      logger.info(`[Mengantar] ${nama} tidak melayani ${cand.cityLabel} — tidak dikutip`);
      continue;
    }

    quotes.push({
      courier: nama,
      price,
      eta: rapikanEstimasi(data.estimate_delivery),
      cost: biayaToko(data) ?? undefined,
      cod: statusCod(cand.row, nama),
    });
  }
  if (quotes.length === 0) return null;
  quotes.sort((a, b) => a.price - b.price);

  // Margin dicatat di log supaya kelihatan tanpa perlu membuka Mengantar, dan
  // supaya kalau suatu hari selisihnya hilang (diskon akun berubah) itu terlihat
  // sebagai perubahan angka, bukan sebagai penghasilan yang menyusut diam-diam.
  const termurah = quotes[0]!;
  if (termurah.cost !== undefined) {
    const margin = termurah.price - termurah.cost;
    logger.info(
      `[Mengantar] ${termurah.courier}: dikutip Rp ${termurah.price.toLocaleString('id-ID')}, ` +
      `biaya toko Rp ${termurah.cost.toLocaleString('id-ID')}, margin Rp ${margin.toLocaleString('id-ID')}`,
    );
  }

  return {
    // Label dari tabel padanan dipakai kalau ada, karena ditulis untuk dibaca
    // orang ("Surakarta (Solo), Jawa Tengah"). Kalau tidak, data mentahnya
    // dirapikan supaya tidak muncul sebagai "KAB. BANYUMAS, JAWA TENGAH".
    destinationLabel: aliasLabel
      ?? [prettyPlace(cand.cityLabel), prettyPlace(cand.province)].filter(Boolean).join(', '),
    weightKg: weight,
    quotes: quotes.slice(0, 4),
  };
}

/**
 * Endpoint tarif yang mungkin dipakai, beserta ingatan mana yang benar-benar ada.
 *
 * ── Kejadian yang membuat bagian ini ada ────────────────────────────────────
 * Versi sebelumnya selalu mencoba `allEstimatePublic` lebih dulu lalu jatuh ke
 * `estimate?courier=all`. Di akun ini `allEstimatePublic` SELALU menjawab 404 —
 * jadi setiap permintaan tarif membuang satu perjalanan penuh ke server dan
 * menulis satu peringatan palsu ke log. Saat audit berjalan, log-nya dipenuhi
 * `estimasi ongkir gagal (HTTP 404)` padahal ongkirnya berhasil diambil; Angga:
 * "ada yg ganggu pikiranku sering banget 404 ni".
 *
 * Yang menipu dari bug ini: hasil akhirnya BENAR, jadi tidak ada yang rusak dan
 * tidak ada yang menuntut perbaikan. Yang rusak cuma kecepatan dan kepercayaan
 * pada log — dan log yang penuh peringatan palsu adalah log yang berhenti dibaca.
 *
 * ── Kenapa 404 diingat, dan kegagalan lain tidak ───────────────────────────
 * 404 berarti endpoint-nya memang tidak ada di akun ini. Itu tidak akan berubah
 * dalam satu masa hidup proses, jadi ditandai mati dan tidak ditembak lagi.
 * Kegagalan lain (500, timeout) sesaat dan tidak menandai apa pun.
 *
 * Kalau SEMUA endpoint tertandai mati, tandanya dihapus dan semuanya dicoba lagi
 * dari awal. Tanpa jalan keluar itu, satu kesalahan penandaan akan mematikan
 * ongkir sampai proses di-restart.
 */
const ESTIMATE_ENDPOINTS: Array<{ label: string; path: (q: string) => string }> = [
  // Yang ini yang terbukti jalan pada percobaan manual Angga 30 Juli 2026.
  { label: 'estimate?courier=all', path: q => `/order/estimate?${q}&courier=all` },
  // Disimpan karena ada di dokumentasi dan bisa saja aktif di akun lain.
  { label: 'allEstimatePublic', path: q => `/order/allEstimatePublic?${q}` },
];

/** Label endpoint yang terbukti berhasil — dicoba pertama pada permintaan berikutnya. */
let endpointTerbukti: string | null = null;
/** Label endpoint yang menjawab 404 — tidak ditembak lagi. */
const endpointMati = new Set<string>();

async function ambilEstimasi(q: string): Promise<Record<string, CourierEstimate> | null> {
  if (endpointMati.size >= ESTIMATE_ENDPOINTS.length) {
    logger.info('[Mengantar] Semua endpoint tarif pernah 404 — tanda mati dihapus, dicoba ulang dari awal');
    endpointMati.clear();
    endpointTerbukti = null;
  }

  // Yang terbukti berhasil didahulukan; yang mati dilewati sama sekali.
  const urut = [...ESTIMATE_ENDPOINTS]
    .filter(e => !endpointMati.has(e.label))
    .sort((a, b) => {
      if (a.label === endpointTerbukti) return -1;
      if (b.label === endpointTerbukti) return 1;
      return 0;
    });

  for (const ep of urut) {
    // Galat didiamkan di sini karena percobaan endpoint itu PENJAJAKAN, bukan
    // kegagalan. Yang layak masuk log kesimpulannya, bukan tiap langkahnya.
    const { data: raw, status } = await callWithStatus<any>(ep.path(q), `estimasi ongkir (${ep.label})`, true);
    const data = unwrap<any>(raw);

    if (data && typeof data === 'object') {
      if (endpointTerbukti !== ep.label) {
        logger.info(`[Mengantar] Endpoint tarif yang dipakai: ${ep.label}`);
        endpointTerbukti = ep.label;
      }
      return data as Record<string, CourierEstimate>;
    }

    if (status === 404) {
      endpointMati.add(ep.label);
      logger.info(`[Mengantar] Endpoint tarif "${ep.label}" tidak ada di akun ini (404) — tidak dicoba lagi`);
    } else if (status !== null) {
      logger.warn(`[Mengantar] Endpoint tarif "${ep.label}" gagal (HTTP ${status})`);
    } else {
      logger.warn(`[Mengantar] Endpoint tarif "${ep.label}" tidak bisa dihubungi`);
    }
  }

  logger.warn('[Mengantar] Tidak ada endpoint tarif yang berhasil — ongkir dijawab tanpa angka');
  return null;
}

async function fetchEstimates(
  originId: string,
  destId: string,
  weight: number,
): Promise<Record<string, CourierEstimate> | null> {
  const cacheKey = `${CACHE_PREFIX}:est:${originId}:${destId}:${weight}`;
  try {
    const cached = await redisCache.get(cacheKey);
    if (cached) {
      const parsed = JSON.parse(cached);
      // Alasannya sama seperti pada cache lokasi, dan akibatnya di sini lebih
      // mahal: bentuk yang tidak terduga di sini berarti tarif yang salah
      // dikutip ke pelanggan, bukan cuma "tidak ketemu".
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, CourierEstimate>;
      }
      logger.warn('[Mengantar] Cache tarif bentuknya tidak dikenali — diabaikan, ambil ulang dari API');
    }
  } catch { /* diabaikan */ }

  const q =
    `origin_id=${encodeURIComponent(originId)}` +
    `&destination_id=${encodeURIComponent(destId)}` +
    `&weight=${weight}`;

  const data = await ambilEstimasi(q);
  if (!data) return null;

  const raw = data as Record<string, CourierEstimate>;
  try {
    await redisCache.set(cacheKey, JSON.stringify(raw), 'EX', ESTIMATE_TTL_SEC);
  } catch { /* diabaikan */ }
  return raw;
}

/**
 * Ubah hasil jadi potongan pengetahuan berbahasa manusia.
 *
 * Ditulis sebagai kalimat, bukan JSON: yang membacanya nanti adalah model bahasa
 * saat menyusun jawaban, DAN Supervisor saat memeriksa apakah angka di jawaban
 * itu punya dasar. Dua-duanya bekerja jauh lebih baik dengan kalimat biasa.
 */
export function quotesToKnowledgeChunk(result: ShippingResult): string {
  const lines = result.quotes.map(q => {
    // Keterangan COD ditulis di baris yang SAMA dengan harganya, bukan di daftar
    // terpisah. Sekitar 90 persen pesanan toko ini COD, jadi "bisa COD atau
    // tidak" sama menentukannya dengan harganya sendiri — dan keterangan yang
    // berjarak dari angkanya mudah tertinggal saat model menyusun jawaban.
    const cod =
      q.cod === 'bisa' ? ' — bisa COD'
      : q.cod === 'tidak' ? ' — TIDAK bisa COD'
      : ' — status COD belum diketahui';
    return `${q.courier}: Rp ${q.price.toLocaleString('id-ID')}` +
      (q.eta ? ` (estimasi ${q.eta})` : '') + cod;
  });

  const bisaCod = result.quotes.filter(q => q.cod === 'bisa');
  const tidakCod = result.quotes.filter(q => q.cod === 'tidak');
  const belumJelas = result.quotes.filter(q => q.cod === 'belum diketahui');

  const catatanCod: string[] = [];
  if (tidakCod.length > 0 || belumJelas.length > 0) {
    catatanCod.push('');
    if (bisaCod.length > 0) {
      catatanCod.push(
        `Kalau pelanggan mau COD, tawarkan HANYA yang bisa COD: ` +
        `${bisaCod.map(q => q.courier).join(', ')}.`,
      );
    } else {
      catatanCod.push(
        'TIDAK ADA ekspedisi yang jelas bisa COD ke tujuan ini. Jangan menjanjikan COD; ' +
        'sampaikan bahwa untuk daerah ini akan dipastikan dulu.',
      );
    }
    if (tidakCod.length > 0) {
      catatanCod.push(
        `Jangan tawarkan untuk COD: ${tidakCod.map(q => q.courier).join(', ')} — ` +
        `pesanan COD lewat ekspedisi ini akan gagal.`,
      );
    }
    if (belumJelas.length > 0) {
      catatanCod.push(
        `Belum diketahui bisa COD atau tidak: ${belumJelas.map(q => q.courier).join(', ')}. ` +
        `Jangan menyatakan bisa maupun tidak bisa untuk yang ini.`,
      );
    }
  }

  return [
    `Ongkos kirim ke ${result.destinationLabel} untuk paket ${result.weightKg} kg`,
    '',
    ...lines,
    ...catatanCod,
    '',
    // Menyebut tujuan yang terbaca itu WAJIB, bukan basa-basi. Kalau sistem salah
    // menafsirkan kotanya, satu-satunya yang bisa menangkap kesalahan itu adalah
    // pelanggannya sendiri — dan dia hanya bisa menangkapnya kalau disebutkan.
    `WAJIB sebutkan tujuannya (${result.destinationLabel}) saat menjawab, supaya`,
    'pelanggan bisa mengoreksi kalau kotanya keliru. Sebutkan juga bahwa tarif',
    'berlaku saat ini dan bisa berubah.',
  ].join('\n');
}

/**
 * Perintah bertanya untuk model bahasa.
 *
 * ── Kenapa ini BUKAN potongan pengetahuan lagi ──────────────────────────────
 * Versi sebelumnya menyelundupkan perintah ini ke dalam daftar "Pengetahuan
 * Bisnis Tambahan", yang di prompt ditutup dengan "gunakan informasi di atas
 * jika relevan". Itu SARAN. Sementara prompt sistem punya ATURAN: "kalau ada
 * yang belum kamu ketahui, bilang akan dicek dulu."
 *
 * Terpantau 30 Juli 2026 pukul 11:03 — pertanyaannya sudah benar di log:
 *
 *     [AI] bot bertanya: Surabayanya yang di Jawa Timur atau yang di Lampung ya Kak?
 *
 * tapi yang sampai ke pelanggan: "ongkir ke Surabaya saya masih perlu cek dulu.
 * Saya akan minta informasi ke tim logistik kami." Aturan mengalahkan saran,
 * dan itu memang seharusnya — yang salah menaruh perintah di tempat saran.
 *
 * Sekarang dikirim sebagai pesan sistem tersendiri, dan hasilnya diperiksa.
 */
export function askInstruction(dest: AmbiguousDestination): string {
  return [
    'PERINTAH YANG MENGALAHKAN ATURAN LAIN DI ATAS.',
    '',
    `Tujuan pengiriman "${dest.keyword}" ada lebih dari satu tempat, dan selisih`,
    'tarifnya besar. Kamu TIDAK BOLEH menyebut angka ongkir apa pun sekarang, dan',
    'TIDAK BOLEH bilang "akan dicek dulu" atau "akan dikabari" — kamu tidak sedang',
    'kekurangan informasi, kamu cuma perlu menanyakan satu hal.',
    '',
    'Tanyakan ini, boleh disesuaikan gayanya tapi pilihannya harus tetap disebut:',
    '',
    dest.question,
  ].join('\n');
}

/**
 * Potongan untuk kasus yang sudah ditanya tapi tetap belum jelas.
 *
 * Sengaja TIDAK menyuruh bertanya lagi. Pelanggan sudah menjawab sekali; kalau
 * jawabannya belum menyelesaikan, yang dia butuhkan orang — bukan pertanyaan
 * kedua tentang hal yang sama.
 */
export function unresolvedToKnowledgeChunk(dest: UnresolvedDestination): string {
  return [
    `Tujuan "${dest.keyword}" masih belum bisa dipastikan walau sudah ditanya.`,
    '',
    'JANGAN menyebut angka ongkir apa pun, dan JANGAN bertanya lagi soal lokasi.',
    'Bilang saja ongkirnya akan dicek dulu lalu dikabari — dengan santai, tanpa',
    'menyebut sistem, data, atau alasan teknis apa pun.',
  ].join('\n');
}

// ─── Mengantar Receiver Score (2-Layer Anti-RTS Firewall) ──────────────────────

export interface CourierScoreDetail {
  total: number;
  value: number;
  delivered: number;
  rts: number;
  rate: number;
}

export interface MengantarReceiverScoreResult {
  phone: string;
  totalOrders: number;
  totalDelivered: number;
  totalRts: number;
  overallDeliveryRate: number; // 0 - 100%
  recommendedCourier: string | null;
  courierBreakdown: Record<string, CourierScoreDetail>;
  isHighRisk: boolean;
  riskReasons: string[];
}

export class MengantarService {
  private static normalizePhone(phone: string): string {
    let clean = phone.replace(/\D/g, '');
    if (clean.startsWith('62')) {
      clean = clean.slice(2);
    } else if (clean.startsWith('0')) {
      clean = clean.slice(1);
    }
    return clean;
  }

  /**
   * Mengambil skor reputasi penerima COD dari Mengantar API.
   * Endpoint: GET https://app.mengantar.com/api/public/{API_KEY}/getReceiverScoreByNumberUser?search={phone}
   */
  public static async getReceiverScore(
    rawPhone: string,
    customApiKey?: string | null,
  ): Promise<MengantarReceiverScoreResult | null> {
    const apiKey = customApiKey || env.MENGANTAR_API_KEY;
    if (!apiKey) {
      return null;
    }

    const phone = this.normalizePhone(rawPhone);
    if (!phone || phone.length < 8) {
      return null;
    }

    const cacheKey = `mengantar:receiver_score:${phone}`;
    try {
      const cached = await redisCache.get(cacheKey);
      if (cached) {
        return JSON.parse(cached);
      }
    } catch {
      // Redis error ignore
    }

    try {
      const url = `https://app.mengantar.com/api/public/${apiKey}/getReceiverScoreByNumberUser?search=${phone}`;
      const res = await fetch(url, {
        method: 'GET',
        headers: { 'Accept': 'application/json' },
        signal: AbortSignal.timeout(6000),
      });

      if (!res.ok) {
        logger.warn(`[Mengantar] getReceiverScore failed HTTP ${res.status} for ${phone}`);
        return null;
      }

      const json = await res.json() as any;
      if (!json || json.status === false || !json.data) {
        return null;
      }

      const data = json.data;
      let totalOrders = 0;
      let totalDelivered = 0;
      let totalRts = 0;
      const courierBreakdown: Record<string, CourierScoreDetail> = {};
      let bestCourier: string | null = null;
      let bestScore = -1;

      const couriers = ['JNE', 'SiCepat', 'JT', 'SAP', 'Ninja', 'iDexpress'];
      for (const c of couriers) {
        if (data[c] && typeof data[c] === 'object') {
          const detail: CourierScoreDetail = {
            total: Number(data[c].total || 0),
            value: Number(data[c].value || 0),
            delivered: Number(data[c].delivered || 0),
            rts: Number(data[c].rts || 0),
            rate: Number(data[c].rate || 0),
          };
          courierBreakdown[c] = detail;
          totalOrders += detail.total;
          totalDelivered += detail.delivered;
          totalRts += detail.rts;

          const courierScore = detail.delivered * 2 + detail.rate * 10 - detail.rts * 15;
          if (courierScore > bestScore && detail.delivered > 0) {
            bestScore = courierScore;
            bestCourier = `${c} (${detail.delivered}x Sukses, Rate ${detail.rate})`;
          }
        }
      }

      if (totalOrders === 0) {
        return null;
      }

      const overallDeliveryRate = totalOrders > 0 
        ? Math.round((totalDelivered / (totalDelivered + totalRts || 1)) * 100) 
        : 100;

      const riskReasons: string[] = [];
      let isHighRisk = false;

      if (totalRts >= 2) {
        isHighRisk = true;
        riskReasons.push(`Pernah RTS ${totalRts} kali di riwayat logistik Mengantar`);
      }
      if (overallDeliveryRate < 60 && totalOrders >= 2) {
        isHighRisk = true;
        riskReasons.push(`Tingkat pengiriman sukses hanya ${overallDeliveryRate}% (${totalRts} RTS dari ${totalOrders} order)`);
      }

      const result: MengantarReceiverScoreResult = {
        phone,
        totalOrders,
        totalDelivered,
        totalRts,
        overallDeliveryRate,
        recommendedCourier: bestCourier,
        courierBreakdown,
        isHighRisk,
        riskReasons,
      };

      try {
        await redisCache.set(cacheKey, JSON.stringify(result), 'EX', 86400); // 24 hours TTL
      } catch {
        // Cache write error ignore
      }

      return result;
    } catch (err: any) {
      logger.error(`[Mengantar] getReceiverScore error: ${err.message}`);
      return null;
    }
  }

  /**
   * Tes koneksi Mengantar API dengan dummy request.
   */
  public static async testConnection(apiKey: string): Promise<{ success: boolean; message: string }> {
    try {
      const url = `https://app.mengantar.com/api/public/${apiKey}/getReceiverScoreByNumberUser?search=8123456789`;
      const res = await fetch(url, {
        method: 'GET',
        headers: { 'Accept': 'application/json' },
      });

      if (res.status === 200) {
        return { success: true, message: 'Koneksi ke API Mengantar berhasil terhubung!' };
      } else if (res.status === 401 || res.status === 403) {
        return { success: false, message: 'API Key Mengantar tidak valid atau tidak memiliki izin akses.' };
      } else {
        return { success: false, message: `Mengantar API merespon dengan kode status HTTP ${res.status}` };
      }
    } catch (err: any) {
      return { success: false, message: `Gagal menghubungi API Mengantar: ${err.message}` };
    }
  }
}

