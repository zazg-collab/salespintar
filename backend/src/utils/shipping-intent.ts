/**
 * Mengenali pertanyaan ongkir dan menebak kota tujuannya.
 *
 * Tugasnya sengaja sempit: memutuskan APAKAH perlu memanggil API ongkir, dan
 * kalau ya, kata mana yang dipakai sebagai kata kunci pencarian lokasi. Ia tidak
 * perlu benar seratus persen — kalau salah tebak kota, pencarian lokasi tidak
 * menemukan apa pun dan alurnya kembali seperti biasa (bot menanyakan tujuannya).
 *
 * Yang harus dihindari justru sebaliknya: menyangka pesan biasa sebagai
 * pertanyaan ongkir lalu memanggil API tanpa perlu.
 */

/** Kata yang menandakan pertanyaan ongkir. */
const SHIPPING_INTENT = /\b(ongkir|ongkos\s*kirim|biaya\s*kirim|kirim\s*ke|dikirim\s*ke|sampai\s*ke|cod\s*ke|ekspedisi|jne|j&t|jnt|sicepat|anteraja|ninja|lion\s*parcel)\b/i;

/**
 * Pertanyaan TOTAL yang menyebut tujuan tanpa menyebut kata "ongkir".
 *
 * Ditambahkan 2 Agustus 2026 dari temuan audit COD-02: pelanggan menulis
 * "golok sembelih multifungsi cod ke bandung total brp". Pola lama tidak
 * mengenalinya sebagai pertanyaan ongkir — tidak ada kata "ongkir" maupun
 * "kirim ke" — jadi tarif sungguhan TIDAK disuntikkan, dan model menjawab
 * dengan mengarang: *"ongkirnya sekitar Rp 20.000 - Rp 30.000"*.
 *
 * Ini kelas yang sama dengan bug "padang totalnya" di Fase 101: yang gagal
 * bukan modelnya, melainkan pengenalan niat yang terlalu sempit — dan
 * akibatnya selalu sama, yaitu angka karangan yang dibawa kurir ke pintu
 * pelanggan. Menanyakan "total berapa" sambil menyebut kota adalah salah satu
 * kalimat paling lazim di CS toko ini, jadi celah ini bukan kasus pinggiran.
 */
const TOTAL_INTENT = /\btotal(nya)?\s*(brp|berapa|berapaan)\b/i;

/**
 * Kata yang sering muncul sesudah "ke" tapi BUKAN nama tempat.
 * Tanpa daftar ini, "kirim ke rumah saya" akan dicari sebagai kota "rumah saya".
 */
const NOT_A_PLACE = new Set([
  'rumah', 'alamat', 'sini', 'situ', 'sana', 'saya', 'aku', 'kami', 'kita',
  'tempat', 'toko', 'kantor', 'kos', 'kosan', 'apartemen', 'gudang',
  'mana', 'manaa', 'berapa', 'brp', 'sini?', 'daerah',
]);

/** Kata sambung yang menandai akhir nama tempat. */
const STOP_WORDS = new Set([
  'berapa', 'brp', 'brapa', 'berpa', 'ya', 'yah', 'kak', 'bang', 'min', 'gan',
  'dong', 'ga', 'gak', 'nggak', 'kalo', 'kalau', 'untuk', 'buat', 'dgn', 'dengan',
  'pake', 'pakai', 'via', 'bisa', 'bs', 'kena', 'jadi', 'brapa?', 'aja', 'saja',
]);

export interface ShippingIntent {
  /** Kata kunci untuk dicari sebagai lokasi. Kosong = tujuan belum disebut. */
  destinationKeyword: string | null;
  /** Berat yang disebut pelanggan, dalam kg. Kosong = pakai bawaan. */
  weightKg: number | null;
}

/** Ambil berat kalau pelanggan menyebutkannya: "2kg", "500 gram", "1,5 kg". */
function parseWeight(text: string): number | null {
  const kg = text.match(/(\d+(?:[.,]\d+)?)\s*(?:kg|kilo|kilogram)\b/i);
  if (kg?.[1]) {
    const n = parseFloat(kg[1].replace(',', '.'));
    if (n > 0 && n < 1000) return n;
  }
  const gram = text.match(/(\d+(?:[.,]\d+)?)\s*(?:gr|gram)\b/i);
  if (gram?.[1]) {
    const n = parseFloat(gram[1].replace(',', '.')) / 1000;
    if (n > 0 && n < 1000) return n;
  }
  return null;
}

/**
 * Cari nama tempat sesudah kata "ke".
 *
 * Diambil maksimal tiga kata, berhenti begitu ketemu kata sambung. "ongkir ke
 * bandung berapa ya kak" → "bandung", bukan "bandung berapa ya".
 */
function extractDestination(text: string): string | null {
  const lower = text.toLowerCase();

  // "ke <tempat>" — pola paling lazim.
  const m = lower.match(/\bke\s+([a-z][a-z\s.'-]{2,40})/);
  if (!m?.[1]) return null;

  const words: string[] = [];
  for (const w of m[1].trim().split(/\s+/)) {
    const clean = w.replace(/[^a-z.'-]/g, '');
    if (!clean) break;
    if (STOP_WORDS.has(clean)) break;
    words.push(clean);
    if (words.length >= 3) break;
  }
  if (words.length === 0) return null;

  // Seluruh frasanya ternyata bukan nama tempat.
  if (words.every(w => NOT_A_PLACE.has(w))) return null;
  // Kata pertama saja yang bukan tempat pun sudah cukup untuk membatalkan:
  // "ke rumah saya di bandung" lebih baik ditanyakan ulang daripada salah tebak.
  if (NOT_A_PLACE.has(words[0]!)) return null;

  const keyword = words.join(' ').trim();
  return keyword.length >= 3 ? keyword : null;
}

export function detectShippingIntent(text: string): ShippingIntent | null {
  // Pertanyaan "total berapa" baru dianggap pertanyaan ongkir kalau tujuannya
  // memang tersebut — kalau tidak, `extractDestination()` mengembalikan null dan
  // kita cuma memanggil API tanpa guna.
  const niatTotal = TOTAL_INTENT.test(text) && /\bke\s+[a-z]/i.test(text);
  if (!SHIPPING_INTENT.test(text) && !niatTotal) return null;
  return {
    destinationKeyword: extractDestination(text),
    weightKg: parseWeight(text),
  };
}
