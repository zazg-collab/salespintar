import io

SRC = 'src/services/mengantar.service.ts'
s = io.open(SRC, encoding='utf-8').read()

def once(old, new):
    global s
    assert s.count(old) == 1, 'jangkar tidak unik/tidak ketemu: %r' % old[:80]
    s = s.replace(old, new)

# ── 1. Awalan cache diberi nomor bentuk ──────────────────────────────────────
once(
    """const CACHE_PREFIX = 'salespintar:mengantar';
/** Daftar lokasi praktis tidak pernah berubah. */
const ADDRESS_TTL_SEC = 30 * 24 * 60 * 60;
/** Tarif bisa berubah; sehari cukup untuk memangkas panggilan berulang. */
const ESTIMATE_TTL_SEC = 12 * 60 * 60;""",
    """/**
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
const ESTIMATE_TTL_SEC = 12 * 60 * 60;""",
)

# ── 2. Pembacaan cache diperiksa bentuknya ───────────────────────────────────
once(
    """  const key = `${CACHE_PREFIX}:loc:${clean}`;
  try {
    const cached = await redisCache.get(key);
    if (cached) return JSON.parse(cached) as MengantarLocation[];
  } catch { /* Redis bermasalah — lanjut tanpa cache */ }""",
    """  const key = `${CACHE_PREFIX}:loc:${clean}`;
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
  } catch { /* Redis bermasalah atau isinya bukan JSON — lanjut tanpa cache */ }""",
)

# ── 3. Hasil kosong disimpan sebentar saja ───────────────────────────────────
once(
    """  // Hasil kosong ikut disimpan. Tanpa ini, kota yang salah ketik memicu
  // panggilan API berulang tiap kali pelanggan mengirim ulang pesannya.
  try {
    await redisCache.set(key, JSON.stringify(list), 'EX', ADDRESS_TTL_SEC);
  } catch { /* diabaikan */ }""",
    """  // Hasil kosong ikut disimpan, tapi jauh lebih singkat — lihat catatan di
  // EMPTY_ADDRESS_TTL_SEC soal kenapa 30 hari untuk "tidak ketemu" itu keliru.
  try {
    const ttl = list.length > 0 ? ADDRESS_TTL_SEC : EMPTY_ADDRESS_TTL_SEC;
    await redisCache.set(key, JSON.stringify(list), 'EX', ttl);
  } catch { /* diabaikan */ }""",
)

# ── 4. Cache tarif juga diperiksa bentuknya ──────────────────────────────────
once(
    """  const cacheKey = `${CACHE_PREFIX}:est:${originId}:${destId}:${weight}`;
  try {
    const cached = await redisCache.get(cacheKey);
    if (cached) return JSON.parse(cached) as Record<string, CourierEstimate>;
  } catch { /* diabaikan */ }""",
    """  const cacheKey = `${CACHE_PREFIX}:est:${originId}:${destId}:${weight}`;
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
  } catch { /* diabaikan */ }""",
)

io.open(SRC, 'w', encoding='utf-8').write(s)
print('OK   mengantar.service.ts diperbarui')
