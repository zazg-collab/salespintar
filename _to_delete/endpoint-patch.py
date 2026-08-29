import io, re

SRC = 'src/services/mengantar.service.ts'
s = io.open(SRC, encoding='utf-8').read()

def once(old, new):
    global s
    assert s.count(old) == 1, 'jangkar tidak unik/tidak ketemu: %r' % old[:90]
    s = s.replace(old, new)

# ── 1. call() melaporkan kode status, bukan cuma null ────────────────────────
once(
    """async function call<T>(path: string, label: string): Promise<T | null> {
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
      logger.warn(`[Mengantar] ${label} gagal (HTTP ${res.status})`);
      return null;
    }
    return (await res.json()) as T;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`[Mengantar] ${label} gagal: ${msg}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}""",
    """async function call<T>(path: string, label: string): Promise<T | null> {
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
}"""
)

# ── 2. Pemilihan endpoint tarif yang belajar sendiri ────────────────────────
old = re.search(
    r"  // Dua endpoint dicoba berurutan\..*?\n  if \(!data \|\| typeof data !== 'object'\) return null;\n",
    s, re.DOTALL,
)
assert old, 'blok endpoint tidak ketemu'

new = """  const data = await ambilEstimasi(q);
  if (!data) return null;
"""
s = s[:old.start()] + new + s[old.end():]

# ── 3. Fungsi pemilih endpoint, disisipkan sebelum fetchEstimates ───────────
once(
    """async function fetchEstimates(""",
    '''/**
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

async function fetchEstimates('''
)

# ── 4. Komentar getShippingQuotes yang menyebut allEstimatePublic dirapikan ──
once(
    """ * Memakai `allEstimatePublic` — harga Mengantar yang sudah termasuk markup dan
 * diskon mereka. Itu yang benar untuk toko yang mengirim LEWAT Mengantar, sebab
 * itulah yang benar-benar dibayar. Endpoint `allEstimate3PL` memberi tarif mentah
 * ekspedisi dan akan membuat pelanggan dikutip lebih murah dari biaya
 * sesungguhnya — rugi di tiap transaksi.""",
    """ * Yang diambil harga Mengantar yang sudah termasuk markup dan diskon mereka —
 * itu yang benar untuk toko yang mengirim LEWAT Mengantar, sebab itulah yang
 * benar-benar dibayar. Endpoint `allEstimate3PL` memberi tarif mentah ekspedisi
 * dan akan membuat pelanggan dikutip lebih murah dari biaya sesungguhnya — rugi
 * di tiap transaksi.
 *
 * Endpoint mana yang dipakai ditentukan sendiri saat berjalan; lihat catatan di
 * `ESTIMATE_ENDPOINTS`."""
)

io.open(SRC, 'w', encoding='utf-8').write(s)
print('OK   mengantar.service.ts')
