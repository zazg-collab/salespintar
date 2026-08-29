import io

SRC = 'src/services/mengantar.service.ts'
s = io.open(SRC, encoding='utf-8').read()

def once(old, new):
    global s
    assert s.count(old) == 1, 'jangkar tidak unik/tidak ketemu: %r' % old[:90]
    s = s.replace(old, new)

# ── 1. Nama ekspedisi & estimasi yang layak dibaca pelanggan ─────────────────
once(
    """export interface ShippingQuote {""",
    '''/**
 * Nama ekspedisi sebagaimana pelanggan mengenalnya.
 *
 * ── Kenapa peta ini perlu ada ───────────────────────────────────────────────
 * Kunci yang dikembalikan API itu nama internal, dan bot mengutipnya apa adanya
 * ke pelanggan. Terpantau di audit 30 Juli 2026:
 *
 *     - SAPLite: Rp 7.245
 *     - SiCepatCargo: Rp 7.699
 *     - JT: Rp 4.900
 *     - iDexpress: Rp 23.000
 *
 * "JT" bukan cara siapa pun menulis J&T, dan "SAPLite" tidak ada di kepala
 * pelanggan mana pun. Pelanggan sedang memilih ekspedisi untuk paketnya — nama
 * yang tidak dia kenali membuatnya ragu, dan ragu di titik itu berarti pesanan
 * tidak jadi.
 *
 * Kuncinya huruf kecil supaya pencocokannya tidak bergantung pada cara API
 * menuliskan huruf besarnya, yang bisa berubah tanpa pemberitahuan.
 */
const NAMA_EKSPEDISI: Record<string, string> = {
  jne: 'JNE',
  jnt: 'J&T',
  jt: 'J&T',
  'j&t': 'J&T',
  jtcargo: 'J&T Cargo',
  sicepat: 'SiCepat',
  sicepatcargo: 'SiCepat Cargo',
  ninja: 'Ninja Xpress',
  ninjaxpress: 'Ninja Xpress',
  anteraja: 'AnterAja',
  sap: 'SAP Express',
  saplite: 'SAP Express',
  sapexpress: 'SAP Express',
  lion: 'Lion Parcel',
  lionparcel: 'Lion Parcel',
  pos: 'POS Indonesia',
  posindonesia: 'POS Indonesia',
  idexpress: 'ID Express',
  ide: 'ID Express',
  paxel: 'Paxel',
  wahana: 'Wahana',
  tiki: 'TIKI',
  rex: 'REX',
  sentral: 'Sentral Cargo',
};

/** Nama yang enak dibaca, atau bentuk rapi kalau kuncinya belum dikenali. */
function namaEkspedisi(kunci: string): string {
  const k = String(kunci ?? '').trim();
  const cocok = NAMA_EKSPEDISI[k.toLowerCase().replace(/[\\s_-]/g, '')];
  if (cocok) return cocok;
  // Belum dikenali: pisahkan gabungan kata ("SiCepatCargo" → "Si Cepat Cargo")
  // supaya setidaknya terbaca sebagai kata, bukan sebagai kode.
  return k.replace(/([a-z])([A-Z])/g, '$1 $2').trim() || k;
}

/**
 * Estimasi waktu yang layak dibaca pelanggan Indonesia.
 *
 * API mengembalikan teks apa adanya dari ekspedisi, dan bentuknya campur aduk:
 * "2 - 4 days", "2 - 3 Days", string kosong. Yang bocor ke audit:
 *
 *     - SAPLite: Rp 7.245 (estimasi 2 - 4 days)
 *     - Ninja: Rp 6.655 (estimasi)          ← kosong, tapi tanda kurungnya tetap muncul
 *
 * Bahasa Inggris di tengah kalimat Indonesia terasa seperti bocoran sistem, dan
 * "(estimasi)" tanpa isi lebih buruk daripada tidak ada tulisan sama sekali —
 * ia menjanjikan keterangan lalu tidak memberikannya.
 *
 * Mengembalikan `undefined` kalau tidak ada yang berguna, supaya pemanggilnya
 * bisa memilih tidak menulis apa pun.
 */
function rapikanEstimasi(mentah: string | undefined): string | undefined {
  let t = String(mentah ?? '').trim();
  if (!t) return undefined;
  t = t
    .replace(/\\bdays?\\b/gi, 'hari')
    .replace(/\\bhours?\\b/gi, 'jam')
    .replace(/\\bweeks?\\b/gi, 'minggu')
    .replace(/\\s*-\\s*/g, '-')
    .replace(/\\s+/g, ' ')
    .trim();
  // Harus memuat angka; "estimasi tidak tersedia" bukan estimasi.
  if (!/\\d/.test(t)) return undefined;
  // Kalau satuannya belum tersebut, tambahkan — "2-3" saja ambigu.
  if (!/\\b(hari|jam|minggu)\\b/i.test(t)) t = `${t} hari`;
  return t;
}

export interface ShippingQuote {'''
)

# ── 2. Pakai keduanya saat menyusun quote ───────────────────────────────────
once(
    """    const price = hargaDibayar(data);
    if (price === null) continue;
    quotes.push({ courier, price, eta: data.estimate_delivery });
  }
  if (quotes.length === 0) return null;""",
    """    const price = hargaDibayar(data);
    if (price === null) continue;
    quotes.push({
      courier: namaEkspedisi(courier),
      price,
      eta: rapikanEstimasi(data.estimate_delivery),
    });
  }
  if (quotes.length === 0) return null;"""
)

io.open(SRC, 'w', encoding='utf-8').write(s)
print('OK   mengantar.service.ts')
