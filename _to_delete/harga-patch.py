import io, re

SRC = 'src/services/mengantar.service.ts'
s = io.open(SRC, encoding='utf-8').read()

def once(old, new):
    global s
    assert s.count(old) == 1, 'jangkar tidak unik/tidak ketemu: %r' % old[:90]
    s = s.replace(old, new)

# ── 1. Perbaiki keterangan field yang salah saya tulis ───────────────────────
once(
    """interface CourierEstimate {
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
}""",
    """interface CourierEstimate {
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
}"""
)

# ── 2. Urutan harga dibalik: yang dikutip estimatedPrice ─────────────────────
old = re.search(
    r"/\*\*\n \* Harga mana yang dikutip ke pelanggan\.\n.*?\nfunction hargaDibayar\(d: CourierEstimate\): number \| null \{.*?\n\}",
    s, re.DOTALL,
)
assert old, 'hargaDibayar tidak ketemu'

new = '''/**
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
}'''

s = s[:old.start()] + new + s[old.end():]

# ── 3. ShippingQuote: simpan biaya toko terpisah, untuk log saja ─────────────
once(
    """export interface ShippingQuote {
  courier: string;
  price: number;
  eta?: string;
}""",
    """export interface ShippingQuote {
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
}"""
)

# ── 4. Pemakaian di quoteFor ─────────────────────────────────────────────────
once(
    """    const price = hargaDibayar(data);
    if (price === null) continue;
    quotes.push({
      courier: namaEkspedisi(courier),
      price,
      eta: rapikanEstimasi(data.estimate_delivery),
    });
  }
  if (quotes.length === 0) return null;
  quotes.sort((a, b) => a.price - b.price);""",
    """    const price = hargaKePelanggan(data);
    if (price === null) continue;
    quotes.push({
      courier: namaEkspedisi(courier),
      price,
      eta: rapikanEstimasi(data.estimate_delivery),
      cost: biayaToko(data) ?? undefined,
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
  }"""
)

io.open(SRC, 'w', encoding='utf-8').write(s)
print('OK   mengantar.service.ts')

# ── 5. cek-cod.ts: bagian 2 & 3 diarahkan ke margin, bukan biaya COD ────────
SRC2 = 'cek-cod.ts'
t = io.open(SRC2, encoding='utf-8').read()

awal = t.index(' * ── Risiko 1: tarif yang dikutip mungkin BELUM termasuk biaya COD ───────────')
akhir = t.index(' * ── Risiko 2:')
t = t[:awal] + ''' * ── Yang diperiksa 1: margin ongkir per ekspedisi ───────────────────────────
 * Pelanggan dikutip `estimatedPrice`; toko membayar `estimatedSpecialPrice` ke
 * Mengantar. Selisihnya margin pemilik toko.
 *
 * Skrip ini menampilkan keduanya berdampingan supaya marginnya kelihatan sebagai
 * angka, dan supaya kalau suatu hari diskon akun berubah, itu terlihat di sini
 * lebih dulu — bukan nanti waktu penghasilan terasa menyusut tanpa sebab.
 *
 * CATATAN: Mengantar TIDAK memberitahukan biaya layanan COD lewat API ini. Jadi
 * selisih `estimatedPrice` dengan `estimatedSpecialPrice` BUKAN biaya COD —
 * itu diskon akun. (Anotasi saya sebelumnya menyebut itu biaya COD; salah, dan
 * dikoreksi Angga 30 Juli 2026.)
 *
''' + t[akhir:]

t = t.replace(
    "  judul('2. Apakah harga yang bot kutip sudah termasuk biaya COD');",
    "  judul('2. Margin ongkir: yang dikutip ke pelanggan vs yang dibayar toko');"
)
t = t.replace(
    "    console.log('Angka mentah per ekspedisi. Yang dikutip bot kolom terakhir.\\n');\n"
    "    console.log('  ekspedisi        price   estimatedPrice   diskon  diskonEkstra   DIKUTIP BOT');",
    "    console.log('estimatedPrice = dikutip ke pelanggan. estimatedSpecialPrice = biaya toko.\\n');\n"
    "    console.log('  ekspedisi        price   DIKUTIP  biayaToko   MARGIN   diskon+ekstra');"
)

old_loop = t[t.index('    const bedaAda: string[] = [];'):t.index("    console.log('');\n    if (bedaAda.length > 0) {")]
t = t.replace(old_loop, '''    let totalMargin = 0;
    let tanpaMargin: string[] = [];
    for (const [nama, d] of Object.entries(est) as Array<[string, any]>) {
      if (['success', 'message', 'status', 'data', 'result'].includes(nama)) continue;
      if (!d || typeof d !== 'object' || d.unsupported) continue;
      const p = d.price ?? 0;
      const kutip = d.estimatedPrice ?? d.price ?? 0;
      const biaya = d.estimatedSpecialPrice ?? 0;
      const margin = biaya > 0 ? kutip - biaya : 0;
      const dis = (d.discount ?? 0) + (d.discountExtra ?? 0);
      if (biaya > 0) totalMargin += margin;
      if (biaya > 0 && margin <= 0) tanpaMargin.push(nama);
      console.log(
        `  ${nama.padEnd(16)} ${String(p).padStart(6)} ${String(kutip).padStart(8)} ` +
        `${String(biaya).padStart(10)} ${String(margin).padStart(8)} ${String(dis).padStart(14)}`,
      );
    }
''')

old_kesimpulan = t[t.index("    console.log('');\n    if (bedaAda.length > 0) {"):t.index('    // Aritmetika yang bisa diperiksa sendiri')]
t = t.replace(old_kesimpulan, '''    console.log('');
    if (tanpaMargin.length > 0) {
      console.log(`⚠️  ${tanpaMargin.length} ekspedisi TIDAK memberi margin: ${tanpaMargin.join(', ')}`);
      console.log(`    Untuk ekspedisi itu, harga kutipan sama dengan biaya toko — tidak ada`);
      console.log(`    selisih diskon yang bisa diambil. Bukan kerusakan, tapi perlu diketahui`);
      console.log(`    kalau salah satunya jadi yang termurah dan paling sering dipilih.`);
    } else {
      console.log(`Semua ekspedisi memberi margin. Total selisih pada berat & tujuan ini:`);
      console.log(`Rp ${totalMargin.toLocaleString('id-ID')} tersebar di seluruh pilihan.`);
    }

''')

t = t.replace(
    "    judul('3. Uji aritmetika: dari mana angka yang dikutip bot berasal');",
    "    judul('3. Uji aritmetika: memastikan angkanya memang berpasangan seperti dugaan');"
)

io.open(SRC2, 'w', encoding='utf-8').write(t)
print('OK   cek-cod.ts')
