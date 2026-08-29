import sys, io, os

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


# ══ 1. Deteksi hot lead ═══════════════════════════════════════════════════════
patch('backend/src/services/message.service.ts', [
(
"""const HOT_LEAD_KEYWORDS = [
  'mau beli', 'mau pesan', 'mau order', 'mau transfer',
  'bisa transfer', 'cara beli', 'cara order', 'cara pesan',
  'harga berapa', 'ada stok', 'ready ga', 'ready gak',
  'minat', 'tertarik', 'saya beli', 'saya order',
  'transfer ke mana', 'rekening', 'no rek',
];""",
"""// ──────────────────────────────────────────────────────────────────────────────
// Deteksi calon pembeli
//
// Versi pertama cuma punya kata "transfer" utuh dan mencocokkannya sebagai
// potongan teks. Akibatnya "mau trf skrg" — cara paling lazim orang Indonesia
// menyatakan niat bayar — TIDAK terdeteksi sama sekali. Pemberitahuan paling
// berharga di seluruh sistem ini diam justru saat pelanggan paling siap closing.
//
// Sekarang dipisah dua, dan pemisahannya penting:
//
//   FRASA  → dicocokkan sebagai potongan teks biasa. Aman karena panjang.
//   KATA   → WAJIB dicocokkan sebagai kata utuh.
//
// Kenapa kata pendek tidak boleh dicocokkan sebagai potongan: `includes('tf')`
// akan menyala untuk "outfit" dan "netflix"; `includes('rek')` menyala untuk
// "direktori". Pemberitahuan palsu lebih berbahaya daripada kelihatannya —
// begitu Angga belajar mengabaikan notifikasinya, yang sungguhan ikut terabaikan.
// ──────────────────────────────────────────────────────────────────────────────

const HOT_LEAD_PHRASES = [
  'mau beli', 'mau pesan', 'mau order', 'mau bayar', 'mau ambil',
  'bisa transfer', 'cara beli', 'cara order', 'cara pesan', 'cara bayar',
  'harga berapa', 'berapa harga', 'ada stok', 'ready ga', 'ready gak', 'ready kak',
  'saya beli', 'saya order', 'saya ambil', 'jadi beli', 'jadi ambil',
  'transfer ke mana', 'transfer kemana', 'kirim ke mana', 'kirim kemana',
  'no rek', 'nomor rekening', 'minta rekening', 'rekening mana',
  'pesan sekarang', 'order sekarang', 'beli sekarang',
];

const HOT_LEAD_WORDS = [
  // Singkatan bayar yang paling sering dipakai — inilah yang dulu terlewat.
  'tf', 'trf', 'transfer', 'tranfer', 'trnsfer', 'tranfser',
  'rekening', 'rek', 'norek', 'cod', 'dp', 'checkout',
  'bungkus', 'gaskeun', 'minat', 'tertarik', 'deal', 'sepakat',
];

/** Kata utuh: harus diapit awal/akhir teks atau karakter non-alfanumerik. */
const HOT_LEAD_WORD_RE = new RegExp(
  `(?:^|[^a-z0-9])(?:${HOT_LEAD_WORDS.join('|')})(?:[^a-z0-9]|$)`,
  'i',
);"""
),
(
"""function detectHotLead(text: string): boolean {
  const lower = text.toLowerCase();
  return HOT_LEAD_KEYWORDS.some(kw => lower.includes(kw));
}""",
"""export function detectHotLead(text: string): boolean {
  const lower = text.toLowerCase();
  return HOT_LEAD_PHRASES.some(kw => lower.includes(kw)) || HOT_LEAD_WORD_RE.test(lower);
}"""
),
])


# ══ 2. Telegram: log saat berhasil, biar bisa ditelusuri ═════════════════════
patch('backend/src/services/telegram.service.ts', [
(
"""    if (!res.ok) {
      const body = await res.text().catch(() => '');
      logger.warn(`[Telegram] Gagal kirim (${res.status}): ${body.slice(0, 200)}`);
    }""",
"""    if (res.ok) {
      // Sengaja dicatat walau berhasil. Waktu notifikasi tidak sampai, pertanyaan
      // pertamanya selalu "apakah pesannya memang pernah dikirim?" — tanpa baris
      // ini, tidak ada cara membedakan "tidak terdeteksi" dari "gagal kirim".
      logger.info(`[Telegram] Pemberitahuan terkirim`);
    } else {
      const body = await res.text().catch(() => '');
      logger.warn(`[Telegram] Gagal kirim (${res.status}): ${body.slice(0, 200)}`);
    }"""
),
])


# ══ 3. Log status Telegram saat server menyala ═══════════════════════════════
patch('backend/src/server.ts', [
(
"""  baileysManager.setMessageHandler(handleIncomingMessage);""",
"""  // Dinyatakan terang-terangan saat menyala, supaya "notifikasi tidak masuk"
  // bisa langsung dipersempit: masalah setelan, atau masalah deteksi.
  if (isTelegramEnabled()) {
    logger.info('[Telegram] Pemberitahuan admin AKTIF');
  } else {
    logger.warn('[Telegram] Pemberitahuan admin TIDAK aktif — TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID belum diisi di .env');
  }

  baileysManager.setMessageHandler(handleIncomingMessage);"""
),
])

p = os.path.join(ROOT, 'backend/src/server.ts')
s = io.open(p, encoding='utf-8').read()
if 'isTelegramEnabled' not in s.split('\n\n')[0] and "from './services/telegram.service'" not in s:
    anchor = "import { logger } from './utils/logger';"
    assert s.count(anchor) == 1, 'anchor import logger di server.ts tidak unik'
    s = s.replace(anchor, anchor + "\nimport { isTelegramEnabled } from './services/telegram.service';")
    io.open(p, 'w', encoding='utf-8').write(s)
    print('OK   server.ts (import isTelegramEnabled)')

print('SELESAI')
