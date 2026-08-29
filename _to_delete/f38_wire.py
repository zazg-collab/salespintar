import sys, io, os, re

ROOT = None
for base in os.listdir('/sessions'):
    p = f'/sessions/{base}/mnt/projek-ceo/salespintar_repo'
    if os.path.isdir(p):
        ROOT = p
        break
assert ROOT, 'repo not found'

def patch(relpath, pairs):
    path = os.path.join(ROOT, relpath)
    with io.open(path, encoding='utf-8') as f:
        src = f.read()
    for old, new in pairs:
        n = src.count(old)
        if n != 1:
            print(f'FAIL {relpath}: pola ditemukan {n}x (harus 1):\n---\n{old[:220]}\n---')
            sys.exit(1)
        src = src.replace(old, new)
    with io.open(path, 'w', encoding='utf-8') as f:
        f.write(src)
    print(f'OK   {relpath} ({len(pairs)} substitusi)')


# ══ 1. env ═══════════════════════════════════════════════════════════════════
patch('backend/src/config/env.ts', [
(
"""  // Ingatan jawaban untuk pertanyaan berulang.""",
"""  // ── Mengantar: cek ongkir sungguhan ──────────────────────────────────────
  // Semuanya opsional. Tanpa MENGANTAR_API_KEY, fiturnya sekadar tidak aktif dan
  // bot kembali menjelaskan cara hitung ongkir tanpa menyebut angka.
  //
  // ⚠️ Kunci ini ikut masuk ke dalam ALAMAT URL (bukan header) — itu ketentuan
  // dari pihak Mengantar. Jangan pernah mencetak alamat lengkapnya ke log.
  MENGANTAR_BASE_URL: z.string().default('https://app.mengantar.com'),
  MENGANTAR_API_KEY: z.string().optional(),
  /** Kode lokasi gudang. Kalau kosong, dicari dari MENGANTAR_ORIGIN_KEYWORD. */
  MENGANTAR_ORIGIN_ID: z.string().optional(),
  /** Nama kota/kecamatan gudang, dipakai kalau ORIGIN_ID belum diketahui. */
  MENGANTAR_ORIGIN_KEYWORD: z.string().optional(),
  /** Berat yang diasumsikan kalau pelanggan tidak menyebutkannya. */
  MENGANTAR_DEFAULT_WEIGHT_KG: z.coerce.number().default(1),

  // Ingatan jawaban untuk pertanyaan berulang."""
),
])


# ══ 2. ai.service — suntikkan ongkir sebagai pengetahuan sementara ══════════
patch('backend/src/services/ai.service.ts', [
(
"""    knowledgeContext = retrievedDocs.length > 0
      ? `\\n\\nPengetahuan Bisnis Tambahan:\\n${retrievedDocs.join('\\n---\\n')}\\nGunakan informasi di atas untuk menjawab pertanyaan pelanggan jika relevan.`
      : '';""",
"""    // ── Ongkir sungguhan ─────────────────────────────────────────────────────
    // Hasil dari API Mengantar disuntikkan sebagai POTONGAN PENGETAHUAN, bukan
    // diberi izin khusus melewati Supervisor.
    //
    // Bedanya besar: dengan cara ini, waktu Supervisor memeriksa "apakah angka
    // di jawaban ini ada dasarnya di pengetahuan?", tarif dari Mengantar memang
    // sudah ada di sana — lolos dengan sendirinya. Tidak ada pengaman yang
    // dilonggarkan dan tidak ada daftar-putih angka yang harus dipelihara.
    // Kalau API-nya mati, yang terjadi cuma bot kembali tidak tahu ongkir, BUKAN
    // bot yang tiba-tiba boleh menyebut angka tanpa dasar.
    const intent = detectShippingIntent(messageText);
    if (intent?.destinationKeyword) {
      try {
        const quotes = await getShippingQuotes({
          destinationKeyword: intent.destinationKeyword,
          weightKg: intent.weightKg ?? undefined,
        });
        if (quotes) {
          retrievedDocs = [quotesToKnowledgeChunk(quotes), ...retrievedDocs];
          logger.info(
            `[AI] Ongkir ke ${quotes.destinationLabel} (${quotes.weightKg} kg): ` +
            `${quotes.quotes.length} ekspedisi disuntikkan ke konteks`,
          );
        } else {
          logger.info(`[AI] Ongkir ke "${intent.destinationKeyword}" tidak ketemu — dijawab tanpa angka`);
        }
      } catch (err) {
        // Ongkir itu pelengkap. Kegagalannya tidak boleh menghalangi pelanggan
        // mendapat jawaban.
        logger.warn(`[AI] Pencarian ongkir gagal, dilewati: ${err}`);
      }
    }

    knowledgeContext = retrievedDocs.length > 0
      ? `\\n\\nPengetahuan Bisnis Tambahan:\\n${retrievedDocs.join('\\n---\\n')}\\nGunakan informasi di atas untuk menjawab pertanyaan pelanggan jika relevan.`
      : '';"""
),
(
"""    const cached = await lookupCachedAnswer(businessId, messageText);
    if (cached) {""",
"""    // Pertanyaan ongkir TIDAK PERNAH dijawab dari ingatan. Tarifnya bergantung
    // pada kota tujuan yang berbeda tiap pelanggan, dan dua pertanyaan yang
    // kalimatnya nyaris sama ("ongkir ke Bandung" vs "ongkir ke Bandar Lampung")
    // bisa berjarak sangat dekat di ruang makna. Menyajikan tarif kota lain
    // adalah kesalahan yang langsung merugikan.
    const cached = intent ? null : await lookupCachedAnswer(businessId, messageText);
    if (cached) {"""
),
(
"""    await rememberAnswer({
      businessId,
      question: messageText,
      answer: reply.trim(),
      leadName,
    });""",
"""    // Jawaban yang memuat tarif ongkir tidak disimpan, dengan alasan yang sama.
    if (!intent) {
      await rememberAnswer({
        businessId,
        question: messageText,
        answer: reply.trim(),
        leadName,
      });
    }"""
),
])

# import
p = os.path.join(ROOT, 'backend/src/services/ai.service.ts')
s = io.open(p, encoding='utf-8').read()
a = "import { lookupCachedAnswer, rememberAnswer } from './answer-cache.service';"
assert s.count(a) == 1
if 'mengantar.service' not in s:
    s = s.replace(a, a +
        "\nimport { getShippingQuotes, quotesToKnowledgeChunk } from './mengantar.service';" +
        "\nimport { detectShippingIntent } from '../utils/shipping-intent';")
    io.open(p, 'w', encoding='utf-8').write(s)
    print('OK   ai.service.ts (import mengantar + shipping-intent)')


# ══ 3. server.ts — nyatakan status saat menyala ═════════════════════════════
patch('backend/src/server.ts', [
(
"""  if (isTelegramEnabled()) {""",
"""  if (isMengantarEnabled()) {
    logger.info('[Mengantar] Cek ongkir AKTIF');
  } else {
    logger.info('[Mengantar] Cek ongkir tidak aktif — MENGANTAR_API_KEY belum diisi (bot tetap jalan, cuma tidak menyebut angka ongkir)');
  }

  if (isTelegramEnabled()) {"""
),
])

p = os.path.join(ROOT, 'backend/src/server.ts')
s = io.open(p, encoding='utf-8').read()
a = "import { isTelegramEnabled } from './services/telegram.service';"
assert s.count(a) == 1
if 'mengantar.service' not in s:
    s = s.replace(a, a + "\nimport { isMengantarEnabled } from './services/mengantar.service';")
    io.open(p, 'w', encoding='utf-8').write(s)
    print('OK   server.ts (import isMengantarEnabled)')

print('SELESAI')
