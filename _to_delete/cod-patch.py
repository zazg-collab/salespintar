import io

# ── location-resolver.ts: baris alamat perlu memuat field COD ────────────────
SRC0 = 'src/utils/location-resolver.ts'
s0 = io.open(SRC0, encoding='utf-8').read()
old0 = """export interface LocationRow {
  _id?: string;
  id?: string;
  CITY_NAME?: string;
  CITY_NAME_SI?: string;
  DISTRICT_NAME?: string;
  SUBDISTRICT_NAME?: string;
  PROVINCE_NAME?: string;
  ZIP_CODE?: string;
}"""
assert s0.count(old0) == 1
s0 = s0.replace(old0, """export interface LocationRow {
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
}""")
io.open(SRC0, 'w', encoding='utf-8').write(s0)
print('OK   location-resolver.ts')

# ── mengantar.service.ts ─────────────────────────────────────────────────────
SRC = 'src/services/mengantar.service.ts'
s = io.open(SRC, encoding='utf-8').read()

def once(old, new):
    global s
    assert s.count(old) == 1, 'jangkar tidak unik/tidak ketemu: %r' % old[:90]
    s = s.replace(old, new)

# 1. Peta penanda COD + pembaca statusnya
once(
    """export interface ShippingQuote {""",
    '''/**
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
 * ── Peta ini HASIL PENAFSIRAN, dan itu perlu diketahui ──────────────────────
 * Akhiran nama field dicocokkan ke ekspedisi berdasarkan pola yang terlihat di
 * data: `unsupportedCodSi` bersanding dengan `DESTINATION_CODE_SI` dan
 * `unsupportedSi`, jadi "Si" = SiCepat. Begitu juga `Sap`, `JT`, `Lion`,
 * `Ninja`, `Anteraja`, `Id`, `Paxel`.
 *
 * Penafsiran itu BELUM dikonfirmasi ke Mengantar. Karena itu ekspedisi yang
 * tidak punya padanan di peta ini dilaporkan "belum diketahui", BUKAN "bisa" —
 * pilihan yang disengaja, sebab menjanjikan COD yang ternyata tidak ada berarti
 * pesanan batal di langkah terakhir, sesudah pelanggan menunggu.
 */
const FIELD_TIDAK_BISA_COD: Record<string, string[]> = {
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
};

/** Penanda menyeluruh: tujuan ini tidak bisa COD lewat ekspedisi mana pun. */
const FIELD_COD_MENYELURUH = 'unsupportedCod';

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
  if (benar((row as Record<string, unknown>)[FIELD_COD_MENYELURUH])) return 'tidak';

  const fields = FIELD_TIDAK_BISA_COD[namaTampilan];
  if (!fields || fields.length === 0) return 'belum diketahui';

  const r = row as Record<string, unknown>;
  // Kalau SATU pun penandanya menyala, anggap tidak bisa. Untuk SAP ada dua
  // penanda, dan salah satunya ("CheckFirst") menyiratkan perlu pemeriksaan
  // lebih dulu — itu bukan "bisa", jadi diperlakukan sebagai tidak bisa.
  if (fields.some(f => benar(r[f]))) return 'tidak';
  // Penandanya ada di data dan tidak menyala → benar-benar bisa.
  if (fields.some(f => f in r)) return 'bisa';
  return 'belum diketahui';
}

export interface ShippingQuote {'''
)

# 2. ShippingQuote menyimpan status COD
once(
    """  /**
   * Biaya toko ke Mengantar. Dipakai HANYA untuk menghitung margin di log.
   *
   * Sengaja tidak ikut ke `quotesToKnowledgeChunk` — lihat catatan di
   * `biayaToko()` soal kenapa angka ini tidak boleh sampai ke model.
   */
  cost?: number;
}""",
    """  /**
   * Biaya toko ke Mengantar. Dipakai HANYA untuk menghitung margin di log.
   *
   * Sengaja tidak ikut ke `quotesToKnowledgeChunk` — lihat catatan di
   * `biayaToko()` soal kenapa angka ini tidak boleh sampai ke model.
   */
  cost?: number;
  /** Bisa COD atau tidak untuk tujuan ini. Dibaca dari data alamat. */
  cod: StatusCod;
}"""
)

# 3. quoteFor mengisi status COD
once(
    """    quotes.push({
      courier: namaEkspedisi(courier),
      price,
      eta: rapikanEstimasi(data.estimate_delivery),
      cost: biayaToko(data) ?? undefined,
    });""",
    """    const nama = namaEkspedisi(courier);
    quotes.push({
      courier: nama,
      price,
      eta: rapikanEstimasi(data.estimate_delivery),
      cost: biayaToko(data) ?? undefined,
      cod: statusCod(cand.row, nama),
    });"""
)

# 4. Potongan pengetahuan menyebut status COD — inti perbaikan ini
once(
    """export function quotesToKnowledgeChunk(result: ShippingResult): string {
  const lines = result.quotes.map(q =>
    `${q.courier}: Rp ${q.price.toLocaleString('id-ID')}` +
    (q.eta ? ` (estimasi ${q.eta})` : ''),
  );
  return [
    `Ongkos kirim ke ${result.destinationLabel} untuk paket ${result.weightKg} kg`,
    '',
    ...lines,
    '',""",
    """export function quotesToKnowledgeChunk(result: ShippingResult): string {
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
    '',"""
)

# 5. Jalur pilihan susulan: baris alamatnya cuma _id, jadi status COD tidak diketahui.
once(
    """  const cand: Candidate = {
    row: { _id: params.addressId },
    cityLabel: params.cityLabel,
    province: params.province,
    weight: 1,
    primary: true,
  };
  return quoteFor(cand, originId, weight, undefined);""",
    """  // ── Kenapa alamatnya dicari ulang di sini ─────────────────────────────────
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
    const rows = await searchLocations(params.cityLabel.replace(/^(Kota|Kabupaten)\\s+/i, ''));
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
  return quoteFor(cand, originId, weight, undefined);"""
)

# 6. Alias pembantu supaya nama impor tidak bentrok
once(
    """  addressId as rowAddressId,""",
    """  addressId as rowAddressId,
  addressId as addressIdDari,"""
)

io.open(SRC, 'w', encoding='utf-8').write(s)
print('OK   mengantar.service.ts')
