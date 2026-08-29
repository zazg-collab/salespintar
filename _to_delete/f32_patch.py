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


# ══ 1. schema ═════════════════════════════════════════════════════════════════
patch('backend/prisma/schema.prisma', [
(
"""  totalMessages  Int @default(0) @map("total_messages")""",
"""  totalMessages  Int @default(0) @map("total_messages")
  /** Berapa file yang gagal ditambang. Sengaja dihitung terpisah, bukan bikin
   *  seluruh sesi berstatus "failed": satu file bermasalah tidak membatalkan
   *  puluhan file lain yang berhasil, dan menandai semuanya gagal cuma
   *  menakut-nakuti tanpa memberi informasi yang benar. */
  failedFiles    Int @default(0) @map("failed_files")"""
),
])

mig_dir = os.path.join(ROOT, 'backend/prisma/migrations/20260730_mining_failed_files')
os.makedirs(mig_dir, exist_ok=True)
io.open(os.path.join(mig_dir, 'migration.sql'), 'w', encoding='utf-8').write(
'''ALTER TABLE "mining_sessions" ADD COLUMN IF NOT EXISTS "failed_files" INTEGER NOT NULL DEFAULT 0;

-- Bereskan sesi lama yang berstatus 'failed'. Baris-baris ini menempel di layar
-- sebagai spanduk merah yang tidak bisa ditutup, padahal masalahnya (batas token
-- Groq) sudah diperbaiki. Diubah jadi 'done' — BUKAN dihapus, karena menghapus
-- baris sesi akan ikut menghapus pertanyaan yang sudah berhasil ditambang di
-- dalamnya (relasi ON DELETE CASCADE).
UPDATE "mining_sessions"
   SET "status" = 'done',
       "failed_files" = GREATEST("total_files" - "processed_files", 1),
       "error_message" = NULL
 WHERE "status" = 'failed';
''')
print('OK   migration 20260730_mining_failed_files')


# ══ 2. repo ═══════════════════════════════════════════════════════════════════
patch('backend/src/services/question-miner.repo.ts', [

# 2a. tipe
(
"""export interface MiningSessionRow {
  id: string;
  label: string;
  status: MiningSessionStatus;
  totalFiles: number;
  processedFiles: number;
  totalMessages: number;
  csNames: string[];
  errorMessage: string | null;
  createdAt: Date;
  questionCount?: number;
  answeredCount?: number;
}""",
"""export interface MiningSessionRow {
  id: string;
  label: string;
  status: MiningSessionStatus;
  totalFiles: number;
  processedFiles: number;
  failedFiles: number;
  totalMessages: number;
  csNames: string[];
  createdAt: Date;
  questionCount?: number;
  answeredCount?: number;
}"""
),
(
"""export interface MinedQuestionRow {
  id: string;
  question: string;
  sampleRaw: string;
  occurrences: number;
  answer: string | null;
  category: string;
  status: MinedQuestionStatus;
  vaultPath: string | null;
}""",
"""export interface MinedQuestionRow {
  id: string;
  question: string;
  sampleRaw: string;
  occurrences: number;
  answer: string | null;
  category: string;
  status: MinedQuestionStatus;
  vaultPath: string | null;
  /** Judul dokumen pustaka yang paling mirip dengan pertanyaan ini, kalau ada. */
  coveredTitle: string | null;
  /** Kemiripannya, 0–1. Ditampilkan apa adanya supaya penilaian mesin bisa
   *  diperiksa manusia, bukan dipercaya buta. */
  coveredScore: number | null;
}

/**
 * Ambang penilaian "pustaka sudah menjawab ini".
 *
 * SENGAJA jauh lebih tinggi daripada ambang pencarian yang dipakai bot saat
 * menjawab (0.3 di knowledge.service). Dua pertanyaan yang berbeda:
 *   - Bot bertanya "dokumen mana yang PANTAS DIBACA sebagai konteks?" → longgar.
 *   - Di sini kita bertanya "apakah pertanyaan ini SUDAH TERJAWAB?" → ketat.
 * Memakai 0.3 akan menandai hampir semua pertanyaan sebagai sudah terjawab dan
 * membuat seluruh daftar ini tidak ada gunanya.
 *
 * Angka di bawah masih tebakan awal dan perlu disetel setelah ada data nyata.
 * Karena itu judul dokumen pencocoknya ikut ditampilkan — kalau judulnya jelas
 * tidak nyambung, salah tebaknya kelihatan mata tanpa perlu percaya angkanya.
 */
export const COVERED_THRESHOLD = 0.78;
export const PARTIAL_THRESHOLD = 0.55;"""
),

# 2b. createSession & bumpProcessed & failSession
(
"""export async function failSession(sessionId: string, message: string): Promise<void> {
  await prisma.$executeRawUnsafe(
    `UPDATE mining_sessions SET status = 'failed', error_message = $2, updated_at = NOW()
      WHERE id = $1::uuid`,
    sessionId, message.slice(0, 2000),
  );
}""",
"""/**
 * Tandai satu file gagal ditambang.
 *
 * Menggantikan `failSession()` yang dulu menandai SELURUH sesi berstatus
 * 'failed' hanya karena satu file bermasalah. Akibatnya spanduk merah menempel
 * di layar selamanya walau 39 file lain berhasil — menakut-nakuti tanpa
 * memberi informasi yang benar, dan tidak ada cara menutupnya.
 */
export async function bumpFailed(sessionId: string): Promise<void> {
  await prisma.$executeRawUnsafe(
    `UPDATE mining_sessions SET failed_files = failed_files + 1, updated_at = NOW()
      WHERE id = $1::uuid`,
    sessionId,
  );
}"""
),

# 2c. listSessions
(
"""    `SELECT s.id, s.label, s.status, s.total_files, s.processed_files, s.total_messages,
            s.cs_names, s.error_message, s.created_at,""",
"""    `SELECT s.id, s.label, s.status, s.total_files, s.processed_files, s.failed_files,
            s.total_messages, s.cs_names, s.created_at,"""
),
(
"""    totalFiles: r.total_files,
    processedFiles: r.processed_files,
    totalMessages: r.total_messages,
    csNames: Array.isArray(r.cs_names) ? r.cs_names : [],
    errorMessage: r.error_message,
    createdAt: r.created_at,""",
"""    totalFiles: r.total_files,
    processedFiles: r.processed_files,
    failedFiles: r.failed_files,
    totalMessages: r.total_messages,
    csNames: Array.isArray(r.cs_names) ? r.cs_names : [],
    createdAt: r.created_at,"""
),

# 2d. listQuestions — cocokkan ke pustaka
(
"""  const rows = await prisma.$queryRawUnsafe<any[]>(
    `SELECT id, question, sample_raw, occurrences, answer, category, status, vault_path
       FROM mined_questions
      WHERE ${where}
      ORDER BY occurrences DESC, created_at ASC
      LIMIT 500`,
    ...params,
  );
  return rows.map(r => ({
    id: r.id,
    question: r.question,
    sampleRaw: r.sample_raw,
    occurrences: r.occurrences,
    answer: r.answer,
    category: r.category,
    status: r.status,
    vaultPath: r.vault_path,
  }));""",
"""  // Tiap pertanyaan dicocokkan ke dokumen pustaka yang paling mirip.
  //
  // Vektor pertanyaannya SUDAH tersimpan saat ditambang, jadi pencocokan ini
  // tidak menghitung embedding baru dan tidak menyentuh Groq sama sekali —
  // seluruhnya satu query pgvector. Karena dihitung saat dibaca (bukan disimpan
  // saat ditambang), penilaiannya selalu mengikuti keadaan pustaka TERKINI:
  // begitu Angga menulis dokumen baru, pertanyaan yang tadinya "belum terjawab"
  // langsung berubah sendiri tanpa perlu menambang ulang.
  const rows = await prisma.$queryRawUnsafe<any[]>(
    `SELECT q.id, q.question, q.sample_raw, q.occurrences, q.answer, q.category,
            q.status, q.vault_path,
            k.title AS covered_title,
            k.sim   AS covered_score
       FROM mined_questions q
       LEFT JOIN LATERAL (
         SELECT kn.title, 1 - (kn.embedding <=> q.embedding) AS sim
           FROM knowledge kn
          WHERE kn.business_id = q.business_id AND kn.embedding IS NOT NULL
          ORDER BY kn.embedding <=> q.embedding
          LIMIT 1
       ) k ON q.embedding IS NOT NULL
      WHERE ${where.replace(/business_id/g, 'q.business_id')
                   .replace(/session_id/g, 'q.session_id')
                   .replace(/ status =/g, ' q.status =')}
      -- Yang BELUM terjawab naik ke atas; di dalam tiap kelompok, yang paling
      -- sering ditanya duluan. Inilah yang membuat daftar ini jadi urutan kerja,
      -- bukan sekadar tumpukan.
      ORDER BY (COALESCE(k.sim, 0) >= ${COVERED_THRESHOLD}) ASC, q.occurrences DESC, q.created_at ASC
      LIMIT 500`,
    ...params,
  );
  return rows.map(r => ({
    id: r.id,
    question: r.question,
    sampleRaw: r.sample_raw,
    occurrences: r.occurrences,
    answer: r.answer,
    category: r.category,
    status: r.status,
    vaultPath: r.vault_path,
    coveredTitle: r.covered_title ?? null,
    coveredScore: r.covered_score === null || r.covered_score === undefined
      ? null
      : Number(r.covered_score),
  }));"""
),
])


# ══ 3. worker ═════════════════════════════════════════════════════════════════
patch('backend/src/queues/question-mining.worker.ts', [
(
"import { bumpProcessed, failSession, upsertQuestion } from '../services/question-miner.repo';",
"import { bumpProcessed, bumpFailed, upsertQuestion } from '../services/question-miner.repo';"
),
(
"""    // Satu file gagal tidak boleh menjatuhkan seluruh sesi. Hitungannya tetap
    // dinaikkan supaya progresnya tidak menggantung selamanya di angka yang sama,
    // dan pesan galatnya disimpan supaya kelihatan di UI.
    const raw = err instanceof Error ? err.message : String(err);
    logger.error(`[QuestionMiner] ${filename} GAGAL: ${raw}`);

    // Pesan mentah dari Groq berupa JSON panjang yang tidak berarti apa-apa bagi
    // pemilik toko. Diterjemahkan dulu sebelum ditampilkan di layar.
    const friendly = isRateLimit(err)
      ? `File "${filename}": jatah token Groq per menit habis dan tetap habis setelah beberapa kali menunggu. ` +
        `Coba lagi beberapa menit lagi, atau naikkan paket Groq kalau chat-nya banyak.`
      : `File "${filename}": ${raw.slice(0, 300)}`;

    if (job.attemptsMade >= 2) {
      await bumpProcessed(sessionId);
      await failSession(sessionId, friendly);
    }
    throw err;""",
"""    // Satu file gagal tidak menjatuhkan seluruh sesi. Hitungannya tetap dinaikkan
    // supaya progresnya tidak menggantung selamanya di angka yang sama.
    const raw = err instanceof Error ? err.message : String(err);
    logger.error(
      `[QuestionMiner] ${filename} GAGAL${isRateLimit(err) ? ' (batas token Groq)' : ''}: ${raw}`,
    );

    if (job.attemptsMade >= 2) {
      await bumpProcessed(sessionId);
      await bumpFailed(sessionId);
    }
    throw err;"""
),
])

print('SELESAI')
