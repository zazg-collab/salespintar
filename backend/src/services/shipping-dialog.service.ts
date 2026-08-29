/**
 * Ingatan percakapan untuk satu pertanyaan susulan soal tujuan pengiriman.
 *
 * ── Masalah yang diselesaikan ───────────────────────────────────────────────
 * Pencarian ongkir bekerja dari nol tiap pesan, hanya membaca teks pesan itu.
 * Jadi begitu bot bertanya, jawaban pelanggan jatuh ke ruang kosong:
 *
 *     Pelanggan : "ongkir ke purwokerto berapa"
 *     Bot       : "Purwokertonya yang di Banyumas atau Kendal ya Kak?"
 *     Pelanggan : "banyumas"          ← tidak memuat kata "ongkir" sama sekali
 *
 * Tanpa ingatan, pesan terakhir itu tidak dikenali sebagai jawaban. Bot
 * bertanya, pelanggan menjawab, dan tidak ada yang menyambungkannya.
 *
 * ── Tiga pembatas, dan ketiganya perlu ──────────────────────────────────────
 *
 * 1. SATU pertanyaan saja. Kalau jawabannya masih tidak menyelesaikan, bot
 *    menyerah ke manusia. Bot yang menanyakan hal yang sama dua kali terasa
 *    lebih bodoh daripada bot yang mengaku tidak bisa.
 *
 * 2. Masa berlaku pendek. Pelanggan yang menjawab besok pagi tidak sedang
 *    menjawab pertanyaan ongkir — kalimatnya diperlakukan sebagai pesan biasa.
 *
 * 3. Dibuang saat percakapan diambil alih manusia. Kalau tidak, bot bisa
 *    nyeletuk di tengah pemilik toko sedang melayani pelanggannya sendiri.
 *    Ini datang gratis: begitu percakapan berstatus HUMAN, `generateReply` tidak
 *    dipanggil lagi sama sekali, dan kuncinya kedaluwarsa sendiri dalam 15 menit.
 *
 * Kuncinya `leadId`, bukan id percakapan — itu yang tersedia di `generateReply`,
 * dan memang per pelanggan-lah pertanyaan ini berlaku.
 */

import { redisCache } from '../config/redis';
import { logger } from '../utils/logger';

const PREFIX = 'salespintar:shipask';

/**
 * 15 menit. Cukup panjang untuk orang yang menaruh HP sebentar, cukup pendek
 * supaya percakapan besok tidak dianggap lanjutan.
 */
const TTL_SEC = 15 * 60;

/** Satu pilihan yang tadi ditawarkan ke pelanggan. */
export interface PendingChoice {
  /** `_id` alamat Mengantar — cukup untuk langsung mengambil tarif. */
  addressId: string;
  /** "Kota Surabaya", "Kab. Lampung Tengah". */
  cityLabel: string;
  /** "Jawa Timur", "Lampung". */
  province: string;
}

export interface PendingShippingQuestion {
  /** Tempat yang tadi disebut pelanggan, mis. "purwokerto". */
  keyword: string;
  /** Berat yang sudah diketahui, kalau ada. */
  weightKg: number | null;
  /** Selalu 1 untuk sekarang — dipakai menegakkan batas satu pertanyaan. */
  asked: number;
  /**
   * Pilihan yang tadi ditawarkan.
   *
   * ── Kenapa ini disimpan, bukan cuma kata kuncinya ─────────────────────────
   * Versi pertama menyusun ulang kata kunci pencarian dari kata kunci lama +
   * jawaban pelanggan, lalu mencarinya lagi ke API. Itu rapuh, dan langsung
   * terbukti rapuh: jawaban "jawa timur kak." menghasilkan pencarian
   * `"surabaya jawa timur kak"` — yang tentu saja tidak ketemu, karena "kak"
   * bukan nama tempat. Terpantau 30 Juli 2026 pukul 11:13.
   *
   * Membuang kata sapaan satu per satu cuma menambal satu contoh; besok muncul
   * "yg jatim aja bang", "oh jawa timur ya", "timur, jawa". Yang salah
   * pendekatannya: pada giliran ini kita SUDAH TAHU pilihannya cuma dua atau
   * tiga. Jawaban pelanggan tidak perlu diubah jadi kata kunci pencarian — ia
   * cuma perlu DICOCOKKAN ke daftar yang sudah ada. Pencocokan ke daftar pendek
   * jauh lebih mudah dibuat benar daripada penyusunan kata kunci yang bebas.
   */
  choices: PendingChoice[];
}

function key(leadId: string): string {
  return `${PREFIX}:${leadId}`;
}

export async function rememberQuestion(
  leadId: string,
  data: PendingShippingQuestion,
): Promise<void> {
  try {
    await redisCache.set(key(leadId), JSON.stringify(data), 'EX', TTL_SEC);
  } catch (err) {
    // Gagal mengingat berarti pertanyaan berikutnya tidak tersambung. Tidak
    // ideal, tapi jauh lebih baik daripada menggagalkan balasan.
    logger.warn(`[ShipAsk] Gagal menyimpan pertanyaan tertunda: ${err}`);
  }
}

export async function getPendingQuestion(
  leadId: string,
): Promise<PendingShippingQuestion | null> {
  try {
    const raw = await redisCache.get(key(leadId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PendingShippingQuestion;
    return typeof parsed?.keyword === 'string' ? parsed : null;
  } catch (err) {
    logger.warn(`[ShipAsk] Gagal membaca pertanyaan tertunda: ${err}`);
    return null;
  }
}

/**
 * Ingatan tarif yang TERAKHIR dikutip ke pelanggan ini.
 *
 * ── Kenapa perlu, terpisah dari ingatan pertanyaan ──────────────────────────
 * Sesudah bot menyebut daftar ongkir, pertanyaan berikutnya yang paling wajar
 * justru TIDAK menyebut nama kota lagi:
 *
 *     Bot       : "JNE Rp8.000, J&T Rp9.600, SiCepat Rp7.699..."
 *     Pelanggan : "pengen yang cepat dan murah"
 *
 * Pencarian ongkir tidak menyala (tidak ada nama kota, tidak ada kata "ongkir"),
 * jadi tarifnya tidak disuntikkan lagi — dan model menjawab "saya cek dulu ya
 * Kak" untuk angka yang baru saja ia sebutkan sendiri satu pesan sebelumnya.
 * Terpantau 30 Juli 2026 pukul 11:31.
 *
 * Yang disimpan potongan pengetahuannya yang sudah jadi, bukan hasil mentahnya —
 * jadi menyuntikkannya kembali cuma satu baris, dan Supervisor tetap punya dasar
 * yang sama untuk memeriksa angkanya.
 */
const KUTIPAN_PREFIX = 'salespintar:shiplast';
const KUTIPAN_TTL_SEC = 15 * 60;

function kutipanKey(leadId: string): string {
  return `${KUTIPAN_PREFIX}:${leadId}`;
}

export async function rememberQuotes(leadId: string, knowledgeChunk: string): Promise<void> {
  try {
    await redisCache.set(kutipanKey(leadId), knowledgeChunk, 'EX', KUTIPAN_TTL_SEC);
  } catch (err) {
    logger.warn(`[ShipAsk] Gagal menyimpan kutipan ongkir: ${err}`);
  }
}

export async function getRememberedQuotes(leadId: string): Promise<string | null> {
  try {
    return await redisCache.get(kutipanKey(leadId));
  } catch {
    return null;
  }
}

/**
 * Apakah pesan ini pertanyaan lanjutan soal ongkir yang baru dikutip?
 *
 * Sengaja TIDAK termasuk nama kota — kalau pelanggan menyebut kota baru,
 * `detectShippingIntent` yang menanganinya dan tarif lama tidak relevan lagi.
 * Yang ditangkap di sini cuma pertanyaan yang menunjuk ke daftar yang SUDAH
 * disebutkan: mana yang murah, mana yang cepat, pakai ekspedisi apa.
 */
const LANJUTAN_ONGKIR = /\b(murah|termurah|mahal|cepat|tercepat|paling cepat|lama|kilat|reguler|hemat|ekspedisi|kurir|jne|j&t|jnt|sicepat|si cepat|ninja|anteraja|lion|pos indonesia|yang mana|mana aja|pilih yang)\b/i;

export function looksLikeQuoteFollowUp(text: string): boolean {
  const t = String(text ?? '').trim();
  if (t.length < 3 || t.length > 120) return false;
  return LANJUTAN_ONGKIR.test(t);
}

export async function forgetQuotes(leadId: string): Promise<void> {
  try {
    await redisCache.del(kutipanKey(leadId));
  } catch { /* akan kedaluwarsa sendiri */ }
}

export async function forgetQuestion(leadId: string): Promise<void> {
  try {
    await redisCache.del(key(leadId));
  } catch { /* diabaikan — akan kedaluwarsa sendiri */ }
}

/**
 * Apakah pesan ini masuk akal sebagai jawaban atas pertanyaan tempat?
 *
 * Dijaga longgar tapi tidak sembarangan. Pelanggan yang ditanya "provinsi mana"
 * bisa menjawab "jateng", "jawa tengah", "banyumas", atau "yg banyumas".
 * Tapi kalau dia menjawab "besok aja deh" atau "oke makasih", itu BUKAN jawaban
 * dan tidak boleh dicoba jadi kata kunci pencarian — nanti bot mengejar tempat
 * bernama "besok".
 */
const BUKAN_JAWABAN = /^(ok|oke|oke?y|siap|baik|makasih|terima kasih|thanks|ya|iya|nggak|gak|tidak|besok|nanti|bentar|tunggu|halo|hai|p)\b/i;

/**
 * Kata tanya. Kalau ada salah satunya, pelanggan sedang MENANYAKAN sesuatu,
 * bukan menjawab.
 *
 * Perlu terpisah dari daftar di atas karena letaknya bisa di mana saja: "warna
 * hitam ada?" pendek, dua kata, tidak dimulai kata sanggahan — jadi tanpa
 * pemeriksaan ini ia akan dicari sebagai kota "surabaya warna hitam ada".
 */
const KATA_TANYA = /\b(berapa|brp|brapa|gimana|gmn|kapan|kenapa|knp|apakah|apa|ada|bisa|bs|boleh|dikirim|stok|warna|ukuran|harga|diskon|promo)\b/i;

export function looksLikePlaceAnswer(text: string): boolean {
  const t = text.trim();
  if (t.length < 3 || t.length > 60) return false;
  if (BUKAN_JAWABAN.test(t)) return false;
  if (KATA_TANYA.test(t)) return false;
  // Harus memuat huruf; "12345" itu kode pos, ditangani jalur lain.
  if (!/[a-zA-Z]{3}/.test(t)) return false;
  // Kalimat panjang berisi banyak kata biasanya bukan nama tempat.
  return t.split(/\s+/).length <= 6;
}

/**
 * Kata sapaan, partikel, dan penghubung. Tidak pernah menambah arti.
 *
 * Jawaban "jawa timur kak." tanpa penyaring ini menghasilkan pencarian
 * `"surabaya jawa timur kak"` — dan tidak ada tempat bernama itu.
 * Terpantau 30 Juli 2026 pukul 11:13.
 */
const KATA_SAPAAN = new Set([
  'kak', 'kakak', 'bang', 'bg', 'min', 'admin', 'gan', 'sis', 'bro', 'mas', 'mbak',
  'pak', 'bu', 'bunda', 'ya', 'yaa', 'yah', 'dong', 'deh', 'sih', 'nih', 'kok',
  'aja', 'saja', 'oh', 'ooh', 'eh', 'iya', 'nya', 'lah', 'kan',
  'yang', 'yg', 'itu', 'ini', 'di', 'ke', 'dari', 'untuk', 'buat',
]);

/**
 * Sebutan tingkat wilayah.
 *
 * ── Kenapa daftarnya TERPISAH dari kata sapaan ──────────────────────────────
 * Kata-kata ini kadang bising, kadang justru satu-satunya pembeda — jadi tidak
 * boleh dibuang tanpa pandang keadaan.
 *
 * Waktu pilihannya "Kota Surabaya" lawan "Kabupaten Lampung Tengah", kata
 * "kabupaten" tidak menambah apa pun. Tapi waktu pilihannya "Kota Bandung"
 * lawan "Kabupaten Bandung" — provinsinya sama, namanya sama — kata itulah
 * SATU-SATUNYA yang membedakan. Versi pertama membuangnya bersama kata sapaan,
 * dan akibatnya jawaban "kabupaten bandung" cocok ke dua pilihan sekaligus lalu
 * ditolak sebagai ambigu. Pelanggan sudah menjawab dengan benar dan tetap tidak
 * dilayani.
 *
 * Jadi: DIPERTAHANKAN saat mencocokkan ke daftar pilihan, DIBUANG saat menyusun
 * kata kunci pencarian (di sana ia memang cuma mempersempit hasil tanpa guna).
 */
const KATA_WILAYAH = new Set([
  'kota', 'kab', 'kabupaten', 'provinsi', 'prov', 'propinsi', 'daerah', 'wilayah',
  'kec', 'kecamatan', 'kel', 'kelurahan', 'desa',
]);

/** Samakan bentuk singkatan supaya "kab bandung" dan "kabupaten bandung" setara. */
const SAMAKAN: Record<string, string> = { kab: 'kabupaten', prov: 'provinsi', propinsi: 'provinsi' };

/**
 * Bersihkan teks jadi kata-kata yang berarti.
 *
 * `buangWilayah` menentukan apakah sebutan tingkat wilayah ikut dibuang —
 * lihat catatan di `KATA_WILAYAH` soal kenapa itu tidak bisa diputuskan sekali
 * untuk semua pemakaian.
 */
function kataBerarti(text: string, buangWilayah: boolean): string[] {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 0 && !KATA_SAPAAN.has(w))
    .map(w => SAMAKAN[w] ?? w)
    .filter(w => !(buangWilayah && KATA_WILAYAH.has(w)))
    .map(w => SINGKATAN_PROVINSI[w] ?? w)
    .flatMap(w => w.split(' '));
}

/**
 * Singkatan provinsi yang lazim dipakai orang di chat. Tanpa ini, "jateng"
 * tidak akan pernah ketemu — dan itu cara paling umum orang menyebutnya.
 */
const SINGKATAN_PROVINSI: Record<string, string> = {
  jateng: 'jawa tengah',
  jatim: 'jawa timur',
  jabar: 'jawa barat',
  jakut: 'jakarta utara',
  jaksel: 'jakarta selatan',
  jakbar: 'jakarta barat',
  jaktim: 'jakarta timur',
  jakpus: 'jakarta pusat',
  sumut: 'sumatera utara',
  sumsel: 'sumatera selatan',
  sumbar: 'sumatera barat',
  kalbar: 'kalimantan barat',
  kaltim: 'kalimantan timur',
  kalsel: 'kalimantan selatan',
  kalteng: 'kalimantan tengah',
  sulsel: 'sulawesi selatan',
  sulut: 'sulawesi utara',
  ntb: 'nusa tenggara barat',
  ntt: 'nusa tenggara timur',
  diy: 'yogyakarta',
  babel: 'bangka belitung',
};

/**
 * Cocokkan jawaban pelanggan ke salah satu pilihan yang tadi ditawarkan.
 *
 * Inilah jalur utamanya, dan alasannya ada di catatan `choices` di atas:
 * pada giliran ini pilihannya sudah diketahui, jadi tugasnya MEMILIH — bukan
 * menyusun ulang kata kunci pencarian.
 *
 * Mengembalikan `null` kalau jawabannya tidak menunjuk tepat satu pilihan.
 * "Tepat satu" itu disengaja: jawaban yang cocok ke dua pilihan sekaligus tidak
 * menyelesaikan apa pun, dan menebak salah satunya berarti mengambil risiko
 * yang justru mau dihindari seluruh fitur ini.
 */
export function matchAnswerToChoice(
  answer: string,
  choices: PendingChoice[],
): PendingChoice | null {
  if (!Array.isArray(choices) || choices.length === 0) return null;

  const teks = kataBerarti(answer, false).join(' ');
  if (!teks) return null;

  const bersih = (v: string) => kataBerarti(v, false).join(' ');

  // ── Nilai berjenjang, karena kecocokan tidak sama kuat ────────────────────
  // Nama lengkap ("kabupaten bandung") lebih menentukan daripada provinsi, dan
  // provinsi lebih menentukan daripada nama kota telanjang ("bandung") yang bisa
  // dimiliki dua pilihan sekaligus. Tanpa jenjang ini, "kabupaten bandung" cocok
  // ke Kota Bandung DAN Kabupaten Bandung lalu ditolak sebagai ambigu — padahal
  // pelanggan sudah menjawab dengan jelas.
  const nilai = choices.map(c => {
    const penuh = bersih(c.cityLabel);                                    // "kabupaten bandung"
    const provinsi = bersih(c.province);                                  // "jawa barat"
    const telanjang = kataBerarti(c.cityLabel, true).join(' ');           // "bandung"
    if (penuh && teks.includes(penuh)) return 3;
    if (provinsi && teks.includes(provinsi)) return 2;
    if (telanjang && teks.includes(telanjang)) return 1;
    return 0;
  });

  const tertinggi = Math.max(...nilai);
  if (tertinggi === 0) return null;

  // "Tepat satu" itu disengaja. Jawaban yang cocok ke dua pilihan sekaligus tidak
  // menyelesaikan apa pun, dan menebak salah satunya berarti mengambil risiko
  // yang justru mau dihindari seluruh fitur ini.
  const menang = choices.filter((_, i) => nilai[i] === tertinggi);
  return menang.length === 1 ? menang[0]! : null;
}

/**
 * Gabungkan tempat yang tadi disebut dengan jawaban pelanggan.
 *
 * Digabung, BUKAN diganti. Terbukti dari data: "sukamaju" sendirian menunjuk 33
 * kota, tapi "sukamaju bogor" menunjuk satu. Pencarian Mengantar menyempit
 * kalau diberi dua kata — jadi menyertakan keduanya justru yang membuat
 * hasilnya presisi.
 *
 * Kata penghubung dibuang: "yang banyumas" → "banyumas", supaya tidak ikut
 * dicocokkan sebagai nama tempat.
 */
export function combineAnswer(pendingKeyword: string, answer: string): string {
  // Memakai penyaring yang SAMA seperti pencocokan pilihan, supaya keduanya
  // tidak menyimpang. Dulu di sini ada daftar kata sendiri yang lebih pendek —
  // ia tidak memuat kata sapaan, dan itulah yang membuat "jawa timur kak."
  // menjadi pencarian "surabaya jawa timur kak".
  const jawab = kataBerarti(answer, true).join(' ').trim();

  if (!jawab) return pendingKeyword;

  // Kalau pelanggan sudah menyebut tempat yang sama, tidak perlu diulang.
  if (jawab.includes(pendingKeyword.toLowerCase())) return jawab;

  return `${pendingKeyword} ${jawab}`.trim();
}
