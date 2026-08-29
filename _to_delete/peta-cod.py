import io

SRC = 'src/services/mengantar.service.ts'
s = io.open(SRC, encoding='utf-8').read()

def once(old, new):
    global s
    assert s.count(old) == 1, 'jangkar tidak unik/tidak ketemu: %r' % old[:90]
    s = s.replace(old, new)

# ── 1. Nama ekspedisi: varian Cargo dari dokumentasi resmi ──────────────────
once(
    """  idexpress: 'ID Express',
  ide: 'ID Express',""",
    """  idexpress: 'ID Express',
  ide: 'ID Express',
  // Varian kargo, disebut eksplisit di dokumentasi Mengantar. Tanpa entri ini
  // "JNECargo" lolos ke pelanggan apa adanya — perapi otomatis tidak bisa
  // memecahnya karena tidak ada batas huruf-kecil-ke-besar di "JNEC".
  jnecargo: 'JNE Cargo',
  sapcargo: 'SAP Express Cargo',
  idexpresscargo: 'ID Express Cargo',"""
)

# SAPLite bukan SAP Express biasa — bedanya perlu dipertahankan.
once(
    """  sap: 'SAP Express',
  saplite: 'SAP Express',
  sapexpress: 'SAP Express',""",
    """  sap: 'SAP Express',
  sapexpress: 'SAP Express',
  // SAPLite layanan yang BERBEDA, bukan sekadar penulisan lain dari SAP Express.
  // Sempat saya samakan; itu keliru — pelanggan yang memilih "SAP Express" lalu
  // menerima layanan Lite tidak mendapat yang ia kira.
  saplite: 'SAP Express Lite',"""
)

# ── 2. Peta COD: dicocokkan ke daftar kode kurir RESMI ──────────────────────
once(
    """ * ── Peta ini HASIL PENAFSIRAN, dan itu perlu diketahui ──────────────────────
 * Akhiran nama field dicocokkan ke ekspedisi berdasarkan pola yang terlihat di
 * data: `unsupportedCodSi` bersanding dengan `DESTINATION_CODE_SI` dan
 * `unsupportedSi`, jadi "Si" = SiCepat. Begitu juga `Sap`, `JT`, `Lion`,
 * `Ninja`, `Anteraja`, `Id`, `Paxel`.
 *
 * Penafsiran itu BELUM dikonfirmasi ke Mengantar. Karena itu ekspedisi yang
 * tidak punya padanan di peta ini dilaporkan "belum diketahui", BUKAN "bisa" —
 * pilihan yang disengaja, sebab menjanjikan COD yang ternyata tidak ada berarti
 * pesanan batal di langkah terakhir, sesudah pelanggan menunggu.
 */""",
    """ * ── Sekarang dicocokkan ke daftar kode kurir RESMI ─────────────────────────
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
 */"""
)

once(
    """const FIELD_TIDAK_BISA_COD: Record<string, string[]> = {
  'SiCepat': ['unsupportedCodSi'],
  'SiCepat Cargo': ['unsupportedCodSi'],
  'SAP Express': ['unsupportedCodSap', 'unsupportedCodCheckFirstSap'],
  'J&T': ['unsupportedCodJT'],
  'J&T Cargo': ['unsupportedCodJT'],
  'Lion Parcel': ['unsupportedCodLion'],
  'Ninja Xpress': ['unsupportedCodNinja'],
  'AnterAja': ['unsupportedCodAnteraja'],
  'ID Express': ['unsupportedCodId'],
  'Paxel': ['unsupportedCodPaxel'],
};""",
    """const FIELD_TIDAK_BISA_COD: Record<string, string[]> = {
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
export { namaEkspedisi as __namaEkspedisi, statusCod as __statusCod };"""
)

io.open(SRC, 'w', encoding='utf-8').write(s)
print('OK   mengantar.service.ts')
