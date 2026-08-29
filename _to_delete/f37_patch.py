import sys, io, os, json, re

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
"""  // Notifikasi admin lewat Telegram.""",
"""  // Berapa potongan pengetahuan yang ditempel ke perintah AI. Naik dari 3 ke 6
  // karena dokumen sekarang dipecah jadi potongan — 6 potongan kira-kira
  // sebanding dengan 3 dokumen utuh sebelumnya.
  KNOWLEDGE_TOP_K: z.coerce.number().default(6),
  // Batas keras panjang konteks. Ini yang sebenarnya menjaga jatah token Groq;
  // menghitung jumlah dokumen saja tidak cukup karena panjang tiap potongan
  // berbeda-beda.
  KNOWLEDGE_CONTEXT_MAX_CHARS: z.coerce.number().default(6000),

  // Ingatan jawaban untuk pertanyaan berulang.
  ANSWER_CACHE_ENABLED: z.coerce.boolean().default(true),
  ANSWER_CACHE_TTL_SEC: z.coerce.number().default(6 * 60 * 60),

  // Notifikasi admin lewat Telegram."""
),
])


# ══ 2. schema + migrasi ══════════════════════════════════════════════════════
sp = os.path.join(ROOT, 'backend/prisma/schema.prisma')
s = io.open(sp, encoding='utf-8').read()
assert 'model AnswerCache' not in s
s = s.rstrip() + '''

/// Ingatan jawaban untuk pertanyaan yang berulang. Isinya sengaja dianggap
/// sekali-buang: dihapus seluruhnya setiap kali pustaka berubah, karena jawaban
/// lama yang menyebut harga lama tidak akan tertangkap pengaman anti-ngarang.
model AnswerCache {
  id         String   @id @default(uuid()) @db.Uuid
  businessId String   @map("business_id") @db.Uuid
  question   String   @db.Text
  answer     String   @db.Text
  embedding  Unsupported("vector(384)")?
  createdAt  DateTime @default(now()) @map("created_at") @db.Timestamptz()

  @@index([businessId, createdAt])
  @@map("answer_cache")
}
'''
io.open(sp, 'w', encoding='utf-8').write(s)
print('OK   schema.prisma (+AnswerCache)')

mig = os.path.join(ROOT, 'backend/prisma/migrations/20260730_answer_cache')
os.makedirs(mig, exist_ok=True)
io.open(os.path.join(mig, 'migration.sql'), 'w', encoding='utf-8').write(
'''-- Ingatan jawaban. Tanpa relasi ke businesses karena isinya sekali-buang dan
-- selalu dibersihkan per business secara eksplisit.
CREATE TABLE IF NOT EXISTS "answer_cache" (
  "id"          UUID PRIMARY KEY,
  "business_id" UUID NOT NULL,
  "question"    TEXT NOT NULL,
  "answer"      TEXT NOT NULL,
  "embedding"   vector(384),
  "created_at"  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS "answer_cache_business_id_created_at_idx"
  ON "answer_cache" ("business_id", "created_at");
''')
print('OK   migration 20260730_answer_cache')


# ══ 3. package.json — exceljs ════════════════════════════════════════════════
pkgp = os.path.join(ROOT, 'backend/package.json')
pkg = json.load(io.open(pkgp, encoding='utf-8'))
if 'exceljs' not in pkg['dependencies']:
    pkg['dependencies']['exceljs'] = '^4.4.0'
    pkg['dependencies'] = dict(sorted(pkg['dependencies'].items()))
    io.open(pkgp, 'w', encoding='utf-8').write(json.dumps(pkg, indent=2, ensure_ascii=False) + '\n')
print('OK   package.json (+exceljs)')


# ══ 4. document-extract — Excel & CSV ════════════════════════════════════════
patch('backend/src/services/document-extract.service.ts', [
(
"""export const SUPPORTED_EXTENSIONS = [
  '.txt', '.md', '.markdown',
  '.docx',
  '.pdf',
  '.png', '.jpg', '.jpeg', '.webp',
] as const;""",
"""export const SUPPORTED_EXTENSIONS = [
  '.txt', '.md', '.markdown', '.csv',
  '.docx', '.xlsx',
  '.pdf',
  '.png', '.jpg', '.jpeg', '.webp',
] as const;"""
),
(
"""  // ── Teks polos ────────────────────────────────────────────────────────────
  if (ext === '.txt' || ext === '.md' || ext === '.markdown') {
    return { text: buffer.toString('utf-8').trim(), pages: 1, usedOcr: false, truncatedPages: 0 };
  }""",
"""  // ── Teks polos ────────────────────────────────────────────────────────────
  if (ext === '.txt' || ext === '.md' || ext === '.markdown') {
    return { text: buffer.toString('utf-8').trim(), pages: 1, usedOcr: false, truncatedPages: 0 };
  }

  // ── CSV ───────────────────────────────────────────────────────────────────
  if (ext === '.csv') {
    return {
      text: csvToReadableLines(buffer.toString('utf-8')),
      pages: 1, usedOcr: false, truncatedPages: 0,
    };
  }

  // ── Excel ─────────────────────────────────────────────────────────────────
  if (ext === '.xlsx') {
    const ExcelJS = await import('exceljs');
    const wb = new ExcelJS.default.Workbook();
    await wb.xlsx.load(buffer as any);

    const parts: string[] = [];
    wb.eachSheet(sheet => {
      const rows: string[][] = [];
      sheet.eachRow(row => {
        const values = (row.values as any[]).slice(1)
          .map(v => (v === null || v === undefined ? '' : String(typeof v === 'object' && 'text' in v ? v.text : v).trim()));
        if (values.some(v => v !== '')) rows.push(values);
      });
      if (rows.length === 0) return;
      parts.push(`## ${sheet.name}\\n\\n${tableToReadableLines(rows)}`);
    });

    return { text: parts.join('\\n\\n').trim(), pages: 1, usedOcr: false, truncatedPages: 0 };
  }"""
),
(
"""export async function extractDocument(""",
"""/**
 * Ubah tabel jadi kalimat "Kolom: nilai", satu baris tabel per baris teks.
 *
 * Bukan dipertahankan sebagai tabel, dan ini disengaja. Yang mencari nanti
 * adalah pencocokan MAKNA, bukan mata manusia: baris berbunyi
 * `Produk: Pisau daging | Harga: 185000` bisa ditemukan oleh pertanyaan
 * "berapa harga pisau daging", sedangkan potongan tabel mentah berisi angka
 * berjejer tanpa nama kolom praktis tidak punya makna yang bisa dicocokkan.
 *
 * Baris pertama diperlakukan sebagai nama kolom. Kalau ternyata bukan, hasilnya
 * tetap terbaca — cuma label kolomnya jadi aneh, tidak sampai merusak.
 */
function tableToReadableLines(rows: string[][]): string {
  if (rows.length === 0) return '';
  const header = rows[0]!;
  const looksLikeHeader = header.every(h => h !== '' && !/^-?[\\d.,]+$/.test(h));

  if (!looksLikeHeader || rows.length === 1) {
    return rows.map(r => r.filter(Boolean).join(' | ')).join('\\n');
  }

  return rows.slice(1).map(row =>
    header
      .map((h, i) => (row[i] ? `${h}: ${row[i]}` : ''))
      .filter(Boolean)
      .join(' | '),
  ).filter(Boolean).join('\\n');
}

/** Pembaca CSV sederhana yang menghormati tanda kutip dan koma di dalamnya. */
function csvToReadableLines(raw: string): string {
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (inQuotes) {
      if (ch === '"') {
        if (raw[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') { inQuotes = true; continue; }
    if (ch === ',' || ch === ';') { row.push(field.trim()); field = ''; continue; }
    if (ch === '\\n') {
      row.push(field.trim()); field = '';
      if (row.some(c => c !== '')) rows.push(row);
      row = [];
      continue;
    }
    if (ch === '\\r') continue;
    field += ch;
  }
  row.push(field.trim());
  if (row.some(c => c !== '')) rows.push(row);

  return tableToReadableLines(rows);
}

export async function extractDocument("""
),
])


# ══ 5. ai.service — top-K, batas konteks, ingatan jawaban ═══════════════════
patch('backend/src/services/ai.service.ts', [
(
"""    const { knowledgeService } = await import('./knowledge.service');
    retrievedDocs = await knowledgeService.searchRelevantKnowledge(businessId, messageText, 3);
    knowledgeContext = retrievedDocs.length > 0
      ? `\\n\\nPengetahuan Bisnis Tambahan:\\n${retrievedDocs.join('\\n---\\n')}\\nGunakan informasi di atas untuk menjawab pertanyaan pelanggan jika relevan.`
      : '';
""",
"""    const { knowledgeService } = await import('./knowledge.service');
    retrievedDocs = await knowledgeService.searchRelevantKnowledge(
      businessId, messageText, env.KNOWLEDGE_TOP_K,
    );

    // Batas panjang konteks ditegakkan dalam KARAKTER, bukan jumlah dokumen.
    // Sejak dokumen dipecah jadi potongan, panjang tiap potongan berbeda-beda —
    // "ambil 6 teratas" bisa berarti 2.000 karakter atau 15.000, dan yang kedua
    // langsung menabrak jatah token per menit Groq. Potongan diambil dari yang
    // paling mirip sampai jatahnya habis.
    const kept: string[] = [];
    let used = 0;
    for (const doc of retrievedDocs) {
      if (used + doc.length > env.KNOWLEDGE_CONTEXT_MAX_CHARS) break;
      kept.push(doc);
      used += doc.length;
    }
    if (kept.length < retrievedDocs.length) {
      logger.info(
        `[AI] Konteks dipangkas: ${kept.length}/${retrievedDocs.length} potongan dipakai ` +
        `(${used} karakter, batas ${env.KNOWLEDGE_CONTEXT_MAX_CHARS})`,
      );
    }
    retrievedDocs = kept;

    knowledgeContext = retrievedDocs.length > 0
      ? `\\n\\nPengetahuan Bisnis Tambahan:\\n${retrievedDocs.join('\\n---\\n')}\\nGunakan informasi di atas untuk menjawab pertanyaan pelanggan jika relevan.`
      : '';

    // ── Ingatan jawaban ──────────────────────────────────────────────────────
    // Diperiksa SESUDAH pengetahuan diambil, bukan sebelumnya. Dua alasan:
    // dokumen yang terambil tetap dibutuhkan Supervisor untuk memeriksa jawaban,
    // dan pencarian pgvector itu murah sedangkan panggilan Groq yang mahal.
    const cached = await lookupCachedAnswer(businessId, messageText);
    if (cached) {
      await markReplied(leadId);
      await incrementConsecutive(leadId);
      return { ok: true, reply: cached, knowledgeDocs: retrievedDocs };
    }
"""
),
(
"""    await markReplied(leadId);
    await incrementConsecutive(leadId);

    // ── NOTE (audit A1): dailyAiCount TIDAK di-increment di sini ──────────────""",
"""    await markReplied(leadId);
    await incrementConsecutive(leadId);

    // Disimpan untuk pertanyaan serupa berikutnya. Fungsinya sendiri yang
    // memutuskan layak-tidaknya — jawaban yang menyebut nama penanya ditolak.
    await rememberAnswer({
      businessId,
      question: messageText,
      answer: reply.trim(),
      leadName,
    });

    // ── NOTE (audit A1): dailyAiCount TIDAK di-increment di sini ──────────────"""
),
])

# import di ai.service
p = os.path.join(ROOT, 'backend/src/services/ai.service.ts')
s = io.open(p, encoding='utf-8').read()
a = "import { getTodayAiCount } from './rate-limit.service';"
assert s.count(a) == 1
if 'answer-cache.service' not in s:
    s = s.replace(a, a + "\nimport { lookupCachedAnswer, rememberAnswer } from './answer-cache.service';")
    io.open(p, 'w', encoding='utf-8').write(s)
    print('OK   ai.service.ts (import answer-cache)')

print('SELESAI')
