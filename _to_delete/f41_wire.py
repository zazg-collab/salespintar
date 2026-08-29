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

# ── 1. searchLocation → searchLocations (kembalikan SEMUA baris) ───────────
old = re.search(
    r"export async function searchLocation\(keyword: string\): Promise<MengantarLocation \| null> \{.*?\n  return hit;\n\}",
    s, re.DOTALL,
)
assert old, 'searchLocation tidak ketemu'

new = '''/**
 * Cari lokasi. Mengembalikan SELURUH baris, bukan cuma yang pertama.
 *
 * Versi sebelumnya langsung mengambil baris pertama, dan itu sumber bahaya yang
 * paling halus di seluruh fitur ini: kalau baris pertama meleset, yang terjadi
 * bukan galat melainkan tarif yang benar untuk kota yang salah. Pemilihan
 * sekarang diserahkan ke `resolveDestination`, yang boleh MENYERAH dan meminta
 * bot bertanya alih-alih menebak.
 */
export async function searchLocations(keyword: string): Promise<MengantarLocation[]> {
  const clean = keyword.trim().toLowerCase();
  if (clean.length < 3) return [];

  const key = `${CACHE_PREFIX}:loc:${clean}`;
  try {
    const cached = await redisCache.get(key);
    if (cached) return JSON.parse(cached) as MengantarLocation[];
  } catch { /* Redis bermasalah — lanjut tanpa cache */ }

  const raw = await call<any>(
    `/address/search?keyword=${encodeURIComponent(clean)}`,
    'pencarian lokasi',
  );
  const rows = unwrap<MengantarLocation[]>(raw);
  const list = Array.isArray(rows) ? rows : [];

  // Hasil kosong ikut disimpan. Tanpa ini, kota yang salah ketik memicu
  // panggilan API berulang tiap kali pelanggan mengirim ulang pesannya.
  try {
    await redisCache.set(key, JSON.stringify(list), 'EX', ADDRESS_TTL_SEC);
  } catch { /* diabaikan */ }

  return list;
}

/** Baris pertama saja — hanya dipakai untuk kota asal, yang ditentukan sendiri. */
export async function searchLocation(keyword: string): Promise<MengantarLocation | null> {
  const rows = await searchLocations(keyword);
  return rows.length > 0 ? rows[0]! : null;
}'''

s = s[:old.start()] + new + s[old.end():]
print('OK   searchLocations()')

# ── 2. getShippingQuotes memakai resolver ─────────────────────────────────
old2 = """  const [originId, dest] = await Promise.all([
    resolveOriginId(),
    searchLocation(params.destinationKeyword),
  ]);
  const destId = addressId(dest);
  if (!originId || !destId) return null;"""

new2 = """  const [originId, rows] = await Promise.all([
    resolveOriginId(),
    searchLocations(params.destinationKeyword),
  ]);
  if (!originId) return null;

  // Menebak kota tujuan berarti mempertaruhkan uang tanpa ada yang tahu.
  // Kalau hasilnya tidak pasti, fungsi ini melapor apa adanya dan pemanggilnya
  // yang menyuruh bot bertanya.
  const resolved = resolveDestination(rows as LocationRow[], params.destinationKeyword);
  if (resolved.kind === 'ambiguous') {
    logger.info(
      `[Mengantar] "${params.destinationKeyword}" ambigu (${resolved.choices.join(', ')}) — ` +
      `tarif TIDAK dikutip, bot akan bertanya`,
    );
    return { ambiguous: true, choices: resolved.choices };
  }
  if (resolved.kind === 'not_found') return null;

  const dest = resolved.row as MengantarLocation;
  const destId = addressId(dest);
  if (!destId) return null;"""
assert s.count(old2) == 1
s = s.replace(old2, new2)
print('OK   getShippingQuotes memakai resolver')

# ── 3. Tipe hasil: bisa "ambigu" ──────────────────────────────────────────
old3 = """export interface ShippingResult {
  destinationLabel: string;
  weightKg: number;
  quotes: ShippingQuote[];
}"""
new3 = """export interface ShippingResult {
  ambiguous?: false;
  destinationLabel: string;
  weightKg: number;
  quotes: ShippingQuote[];
}

/** Kota tujuan tidak cukup pasti — bot harus bertanya, bukan menebak. */
export interface AmbiguousDestination {
  ambiguous: true;
  choices: string[];
}

export type ShippingLookup = ShippingResult | AmbiguousDestination;"""
assert s.count(old3) == 1
s = s.replace(old3, new3)
print('OK   tipe hasil')

s = s.replace(
    "}): Promise<ShippingResult | null> {",
    "}): Promise<ShippingLookup | null> {",
)

# label & nilai balik akhir
old4 = """  const label = [dest?.SUBDISTRICT_NAME, dest?.DISTRICT_NAME, dest?.CITY_NAME]
    .filter(Boolean)
    .join(', ') || params.destinationKeyword;

  return { destinationLabel: label, weightKg: weight, quotes: quotes.slice(0, 4) };"""
new4 = """  return {
    destinationLabel: resolved.label || params.destinationKeyword,
    weightKg: weight,
    quotes: quotes.slice(0, 4),
  };"""
assert s.count(old4) == 1
s = s.replace(old4, new4)
print('OK   label dari resolver')

# ── 4. Potongan pengetahuan: sebutkan tujuan & minta konfirmasi ───────────
old5 = re.search(
    r"export function quotesToKnowledgeChunk\(result: ShippingResult\): string \{.*?\n\}",
    s, re.DOTALL,
)
assert old5, 'quotesToKnowledgeChunk tidak ketemu'
new5 = '''export function quotesToKnowledgeChunk(result: ShippingResult): string {
  const lines = result.quotes.map(q =>
    `${q.courier}: Rp ${q.price.toLocaleString('id-ID')}` +
    (q.eta ? ` (estimasi ${q.eta})` : ''),
  );
  return [
    `Ongkos kirim ke ${result.destinationLabel} untuk paket ${result.weightKg} kg`,
    '',
    ...lines,
    '',
    // Menyebut tujuan yang terbaca itu WAJIB, bukan basa-basi. Kalau sistem salah
    // menafsirkan kotanya, satu-satunya yang bisa menangkap kesalahan itu adalah
    // pelanggannya sendiri — dan dia hanya bisa menangkapnya kalau disebutkan.
    `WAJIB sebutkan tujuannya (${result.destinationLabel}) saat menjawab, supaya`,
    'pelanggan bisa mengoreksi kalau kotanya keliru. Sebutkan juga bahwa tarif',
    'berlaku saat ini dan bisa berubah.',
  ].join('\\n');
}

/**
 * Potongan untuk kasus kota tujuan yang ambigu.
 *
 * Sengaja berbentuk perintah bertanya, BUKAN daftar tarif. Bot tidak boleh
 * menyebut angka apa pun sebelum tahu kota mana yang dimaksud.
 */
export function ambiguousToKnowledgeChunk(dest: AmbiguousDestination, keyword: string): string {
  return [
    `Kota tujuan "${keyword}" belum jelas — ada beberapa kemungkinan:`,
    dest.choices.join(', '),
    '',
    'JANGAN menyebut angka ongkir apa pun sekarang. Tanyakan dulu ke pelanggan',
    'yang mana yang dimaksud, sebutkan pilihannya, lalu tunggu jawabannya.',
  ].join('\\n');
}'''
s = s[:old5.start()] + new5 + s[old5.end():]
print('OK   potongan pengetahuan (pasti & ambigu)')

# ── 5. import resolver ────────────────────────────────────────────────────
a = "import { redisCache } from '../config/redis';"
assert s.count(a) == 1
s = s.replace(a, a + "\nimport { resolveDestination, type LocationRow } from '../utils/location-resolver';")
print('OK   import resolver')

io.open(P, 'w', encoding='utf-8').write(s)


# ══ ai.service: tangani hasil ambigu ════════════════════════════════════════
A = os.path.join(ROOT, 'backend/src/services/ai.service.ts')
s = io.open(A, encoding='utf-8').read()

old6 = """        if (quotes) {
          retrievedDocs = [quotesToKnowledgeChunk(quotes), ...retrievedDocs];
          logger.info(
            `[AI] Ongkir ke ${quotes.destinationLabel} (${quotes.weightKg} kg): ` +
            `${quotes.quotes.length} ekspedisi disuntikkan ke konteks`,
          );
        } else {"""
new6 = """        if (quotes && quotes.ambiguous) {
          // Kota tujuan tidak pasti. Yang disuntikkan BUKAN tarif, melainkan
          // perintah bertanya — bot tidak boleh menyebut angka apa pun sebelum
          // tahu kota mana yang dimaksud.
          retrievedDocs = [
            ambiguousToKnowledgeChunk(quotes, intent.destinationKeyword),
            ...retrievedDocs,
          ];
          logger.info(`[AI] Tujuan "${intent.destinationKeyword}" ambigu — bot diminta bertanya`);
        } else if (quotes) {
          retrievedDocs = [quotesToKnowledgeChunk(quotes), ...retrievedDocs];
          logger.info(
            `[AI] Ongkir ke ${quotes.destinationLabel} (${quotes.weightKg} kg): ` +
            `${quotes.quotes.length} ekspedisi disuntikkan ke konteks`,
          );
        } else {"""
assert s.count(old6) == 1
s = s.replace(old6, new6)

a2 = "import { getShippingQuotes, quotesToKnowledgeChunk } from './mengantar.service';"
assert s.count(a2) == 1
s = s.replace(a2, "import { getShippingQuotes, quotesToKnowledgeChunk, ambiguousToKnowledgeChunk } from './mengantar.service';")
io.open(A, 'w', encoding='utf-8').write(s)
print('OK   ai.service menangani ambigu')
print('SELESAI')
