import io

SRC = 'src/services/mengantar.service.ts'
s = io.open(SRC, encoding='utf-8').read()

def once(old, new):
    global s
    assert s.count(old) == 1, 'jangkar tidak unik/tidak ketemu: %r' % old[:90]
    s = s.replace(old, new)

# ── 1. Peta liputan non-COD + model dua tingkat ──────────────────────────────
once(
    """/** Penanda menyeluruh: tujuan ini tidak bisa COD lewat ekspedisi mana pun. */
const FIELD_COD_MENYELURUH = 'unsupportedCod';""",
    """/**
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
}"""
)

# ── 2. statusCod: dua tingkat ────────────────────────────────────────────────
once(
    """function statusCod(row: LocationRow, namaTampilan: string): StatusCod {
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
}""",
    """function statusCod(row: LocationRow, namaTampilan: string): StatusCod {
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
}"""
)

# ── 3. quoteFor: kurir yang tidak melayani DIBUANG, bukan dikutip ───────────
once(
    """    const nama = namaEkspedisi(courier);
    quotes.push({""",
    """    const nama = namaEkspedisi(courier);

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

    quotes.push({"""
)

io.open(SRC, 'w', encoding='utf-8').write(s)
print('OK   mengantar.service.ts')
