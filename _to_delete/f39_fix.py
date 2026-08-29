import sys, io, os

ROOT = None
for base in os.listdir('/sessions'):
    p = f'/sessions/{base}/mnt/projek-ceo/salespintar_repo'
    if os.path.isdir(p):
        ROOT = p
        break
assert ROOT, 'repo not found'

P = os.path.join(ROOT, 'backend/src/services/mengantar.service.ts')
s = io.open(P, encoding='utf-8').read()

# ── 1. Pembuka bungkus ──────────────────────────────────────────────────────
old = """// ─── Pencarian lokasi ─────────────────────────────────────────────────────────"""
new = """/**
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

// ─── Pencarian lokasi ─────────────────────────────────────────────────────────"""
assert s.count(old) == 1
s = s.replace(old, new)
print('OK   +unwrap()')

# ── 2. searchLocation memakai unwrap ───────────────────────────────────────
old2 = """  const rows = await call<MengantarLocation[]>(
    `/address/search?keyword=${encodeURIComponent(clean)}`,
    'pencarian lokasi',
  );
  const hit = Array.isArray(rows) && rows.length > 0 ? rows[0]! : null;"""
new2 = """  const raw = await call<any>(
    `/address/search?keyword=${encodeURIComponent(clean)}`,
    'pencarian lokasi',
  );
  const rows = unwrap<MengantarLocation[]>(raw);
  const hit = Array.isArray(rows) && rows.length > 0 ? rows[0]! : null;"""
assert s.count(old2) == 1
s = s.replace(old2, new2)
print('OK   searchLocation membuka bungkus')

# ── 3. estimasi memakai unwrap ─────────────────────────────────────────────
old3 = """  if (!raw) {
    raw = await call<Record<string, CourierEstimate>>(
      `/order/allEstimatePublic?origin_id=${encodeURIComponent(originId)}` +
      `&destination_id=${encodeURIComponent(dest.DESTINATION_CODE)}` +
      `&weight=${weight}`,
      'estimasi ongkir',
    );
    if (!raw) return null;"""
new3 = """  if (!raw) {
    const rawRes = await call<any>(
      `/order/allEstimatePublic?origin_id=${encodeURIComponent(originId)}` +
      `&destination_id=${encodeURIComponent(dest.DESTINATION_CODE)}` +
      `&weight=${weight}`,
      'estimasi ongkir',
    );
    raw = unwrap<Record<string, CourierEstimate>>(rawRes);
    if (!raw) return null;"""
assert s.count(old3) == 1
s = s.replace(old3, new3)
print('OK   estimasi membuka bungkus')

# ── 4. Penyaring kunci yang bukan nama kurir ───────────────────────────────
old4 = """  const quotes: ShippingQuote[] = [];
  for (const [courier, data] of Object.entries(raw)) {
    if (!data || typeof data !== 'object') continue;"""
new4 = """  const quotes: ShippingQuote[] = [];
  for (const [courier, data] of Object.entries(raw)) {
    // Kunci pembungkus yang mungkin ikut terbawa kalau bentuk balasannya
    // ternyata berbeda lagi. Tanpa penyaring ini, "success" bisa terbaca
    // sebagai nama ekspedisi.
    if (['success', 'message', 'status', 'data', 'result'].includes(courier)) continue;
    if (!data || typeof data !== 'object') continue;"""
assert s.count(old4) == 1
s = s.replace(old4, new4)
print('OK   penyaring kunci pembungkus')

io.open(P, 'w', encoding='utf-8').write(s)
print('SELESAI')
