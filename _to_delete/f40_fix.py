import sys, io, os, re

ROOT = None
for base in os.listdir('/sessions'):
    p = f'/sessions/{base}/mnt/projek-ceo/salespintar_repo'
    if os.path.isdir(p):
        ROOT = p
        break
assert ROOT, 'repo not found'

P = os.path.join(ROOT, 'backend/src/services/mengantar.service.ts')
s = io.open(P, encoding='utf-8').read()

# ── 1. Tipe lokasi: yang dipakai ternyata _id ──────────────────────────────
old = """export interface MengantarLocation {
  DESTINATION_CODE?: string;
  ORIGIN_CODE?: string;
  CITY_NAME?: string;
  PROVINCE_NAME?: string;
  SUBDISTRICT_NAME?: string;
  DISTRICT_NAME?: string;
  ZIP_CODE?: string;
}"""
new = """export interface MengantarLocation {
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

/** ID rekaman alamat, apa pun nama fieldnya. */
function addressId(loc: MengantarLocation | null | undefined): string | null {
  return loc?._id || loc?.id || null;
}"""
assert s.count(old) == 1
s = s.replace(old, new)
print('OK   tipe lokasi + addressId()')

# ── 2. resolveOriginId memakai _id ─────────────────────────────────────────
old2 = """  const loc = await searchLocation(env.MENGANTAR_ORIGIN_KEYWORD);
  const id = loc?.ORIGIN_CODE || null;"""
new2 = """  const loc = await searchLocation(env.MENGANTAR_ORIGIN_KEYWORD);
  const id = addressId(loc);"""
assert s.count(old2) == 1
s = s.replace(old2, new2)
print('OK   resolveOriginId')

# ── 3. Tipe estimasi: tambah field harga yang sesungguhnya ────────────────
old3 = """interface CourierEstimate {
  unsupported?: boolean;
  price?: number;
  estimate_delivery?: string;
  estimatedPrice?: number;
  estimatedSpecialPrice?: number;
}"""
new3 = """interface CourierEstimate {
  unsupported?: boolean;
  /** Tarif SEBELUM diskon. BUKAN yang dibayar. */
  price?: number;
  estimate_delivery?: string;
  /** price + biaya COD, masih sebelum diskon. */
  estimatedPrice?: number;
  /** Yang BENAR-BENAR dibayar, sesudah seluruh diskon akun. */
  estimatedSpecialPrice?: number;
  discount?: number;
  discountExtra?: number;
}

/**
 * Harga mana yang dikutip ke pelanggan.
 *
 * ── Kesalahan yang nyaris lolos ──────────────────────────────────────────────
 * Versi pertama mengutip `price` lebih dulu. Dari balasan sungguhan:
 *
 *     price                 : 26.000
 *     discount (30%)        :  7.800
 *     discountExtra (5%)    :  1.300
 *     estimatedSpecialPrice : 16.904   ← yang benar-benar dibayar
 *
 * Mengutip `price` berarti menagih pelanggan Rp 26.000 untuk pengiriman yang
 * biayanya Rp 16.904 — kemahalan 54% di SETIAP paket, tanpa satu pun galat yang
 * muncul di layar. Kesalahan diam seperti ini yang paling lama tidak ketahuan.
 *
 * Urutannya sekarang: harga sesudah diskon dulu, baru cadangan.
 */
function hargaDibayar(d: CourierEstimate): number | null {
  const kandidat = [d.estimatedSpecialPrice, d.estimatedPrice, d.price];
  for (const n of kandidat) {
    if (typeof n === 'number' && n > 0) return n;
  }
  return null;
}"""
assert s.count(old3) == 1
s = s.replace(old3, new3)
print('OK   hargaDibayar()')

# ── 4. getShippingQuotes: pakai _id, coba dua endpoint, dua bentuk balasan ─
old4 = re.search(
    r"  const \[originId, dest\] = await Promise\.all\(\[.*?\n  return \{ destinationLabel: label, weightKg: weight, quotes: quotes\.slice\(0, 4\) \};",
    s, re.DOTALL,
)
assert old4, 'blok getShippingQuotes tidak ketemu'

new4 = '''  const [originId, dest] = await Promise.all([
    resolveOriginId(),
    searchLocation(params.destinationKeyword),
  ]);
  const destId = addressId(dest);
  if (!originId || !destId) return null;

  const cacheKey = `${CACHE_PREFIX}:est:${originId}:${destId}:${weight}`;
  let raw: Record<string, CourierEstimate> | null = null;
  try {
    const cached = await redisCache.get(cacheKey);
    if (cached) raw = JSON.parse(cached) as Record<string, CourierEstimate>;
  } catch { /* diabaikan */ }

  if (!raw) {
    const q =
      `origin_id=${encodeURIComponent(originId)}` +
      `&destination_id=${encodeURIComponent(destId)}` +
      `&weight=${weight}`;

    // Dua endpoint dicoba berurutan. `allEstimatePublic` mengembalikan semua
    // ekspedisi sekaligus dan itu yang paling hemat; `estimate?courier=all`
    // dipakai sebagai cadangan karena bentuk itulah yang sudah terbukti jalan
    // saat diuji manual. Yang mana pun berhasil, hasilnya diseragamkan di bawah.
    let res = await call<any>(`/order/allEstimatePublic?${q}`, 'estimasi ongkir');
    let data = unwrap<any>(res);
    if (!data || typeof data !== 'object') {
      res = await call<any>(`/order/estimate?${q}&courier=all`, 'estimasi ongkir (cadangan)');
      data = unwrap<any>(res);
    }
    if (!data || typeof data !== 'object') return null;

    raw = data as Record<string, CourierEstimate>;
    try {
      await redisCache.set(cacheKey, JSON.stringify(raw), 'EX', ESTIMATE_TTL_SEC);
    } catch { /* diabaikan */ }
  }

  const quotes: ShippingQuote[] = [];
  for (const [courier, data] of Object.entries(raw)) {
    // Kunci pembungkus yang mungkin ikut terbawa kalau bentuk balasannya
    // berbeda. Tanpa penyaring ini, "success" bisa terbaca sebagai ekspedisi.
    if (['success', 'message', 'status', 'data', 'result'].includes(courier)) continue;
    if (!data || typeof data !== 'object') continue;
    if (data.unsupported) continue;
    const price = hargaDibayar(data);
    if (price === null) continue;
    quotes.push({ courier, price, eta: data.estimate_delivery });
  }

  if (quotes.length === 0) return null;
  quotes.sort((a, b) => a.price - b.price);

  const label = [dest?.SUBDISTRICT_NAME, dest?.DISTRICT_NAME, dest?.CITY_NAME]
    .filter(Boolean)
    .join(', ') || params.destinationKeyword;

  return { destinationLabel: label, weightKg: weight, quotes: quotes.slice(0, 4) };'''

s = s[:old4.start()] + new4 + s[old4.end():]
print('OK   getShippingQuotes (pakai _id, dua endpoint, harga sesudah diskon)')

io.open(P, 'w', encoding='utf-8').write(s)
print('SELESAI')
