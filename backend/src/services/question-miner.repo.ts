/**
 * Akses data Question Miner.
 *
 * Sengaja memakai SQL mentah, bukan Prisma Client, dengan dua alasan:
 *   1. Kolom `embedding` bertipe `vector(384)` yang oleh Prisma ditandai
 *      `Unsupported` — operasi kemiripan memang tidak bisa lewat client. Tabel
 *      `knowledge` yang sudah ada pun ditangani dengan cara yang sama.
 *   2. Menjaga modul ini tetap bisa dikompilasi sebelum `prisma generate`
 *      dijalankan ulang di mesin pemilik.
 *
 * Semua query DIWAJIBKAN membawa `business_id` sebagai parameter — bukan karena
 * gaya, tapi karena ini basis data multi-tenant dan satu query yang lupa
 * menyaring tenant akan membocorkan pertanyaan pelanggan bisnis lain.
 */

import { randomUUID } from 'crypto';
import { prisma } from '../config/prisma';
import { logger } from '../utils/logger';

export type MiningSessionStatus = 'pending' | 'running' | 'done' | 'failed' | 'cancelled';
export type MinedQuestionStatus = 'open' | 'answered' | 'dismissed' | 'published';

export interface MiningSessionRow {
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
}

export interface MinedQuestionRow {
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
export const PARTIAL_THRESHOLD = 0.55;

/**
 * Ambang penggabungan pertanyaan yang dianggap semakna.
 *
 * Sengaja TINGGI. Kegagalan yang perlu ditakuti di sini bukan "terlalu banyak
 * baris", tapi **penggabungan yang salah**: "berapa harga pisau daging" dan
 * "berapa harga pisau roti" secara vektor sangat mirip padahal produknya beda.
 * Kalau keduanya digabung, satu jawaban akan dipakai untuk dua produk berbeda —
 * persis jenis kesalahan yang bikin bot terdengar meyakinkan tapi salah.
 *
 * Daftar terlalu panjang cuma melelahkan; penggabungan salah menyesatkan. Kolom
 * `sample_raw` ada justru supaya salah gabung bisa terlihat mata manusia.
 */
export const QUESTION_MERGE_THRESHOLD = 0.88;

// ─── Sesi ─────────────────────────────────────────────────────────────────────

export async function createSession(
  businessId: string,
  label: string,
  csNames: string[],
  totalFiles: number,
  totalMessages: number,
): Promise<string> {
  const id = randomUUID();
  await prisma.$executeRawUnsafe(
    `INSERT INTO mining_sessions
       (id, business_id, label, status, total_files, processed_files, total_messages, cs_names, updated_at)
     VALUES ($1::uuid, $2::uuid, $3, 'running', $4, 0, $5, $6::jsonb, NOW())`,
    id, businessId, label.slice(0, 200), totalFiles, totalMessages, JSON.stringify(csNames),
  );
  return id;
}

export async function bumpProcessed(sessionId: string): Promise<void> {
  await prisma.$executeRawUnsafe(
    `UPDATE mining_sessions
        SET processed_files = processed_files + 1,
            updated_at = NOW(),
            status = CASE WHEN processed_files + 1 >= total_files THEN 'done' ELSE status END
      WHERE id = $1::uuid
        -- Sesi yang sudah dibatalkan tidak boleh dihidupkan lagi oleh job yang
        -- kebetulan masih berjalan saat tombol Batal ditekan.
        AND status NOT IN ('cancelled', 'done')`,
    sessionId,
  );
}

/** Status satu sesi, dibaca worker sebelum bekerja. */
export async function getSessionStatus(sessionId: string): Promise<MiningSessionStatus | null> {
  const rows = await prisma.$queryRawUnsafe<{ status: MiningSessionStatus }[]>(
    `SELECT status FROM mining_sessions WHERE id = $1::uuid`,
    sessionId,
  );
  return rows[0]?.status ?? null;
}

export async function cancelSession(businessId: string, sessionId: string): Promise<boolean> {
  const affected = await prisma.$executeRawUnsafe(
    `UPDATE mining_sessions SET status = 'cancelled', updated_at = NOW()
      WHERE id = $1::uuid AND business_id = $2::uuid AND status IN ('pending', 'running')`,
    sessionId, businessId,
  );
  return affected > 0;
}

/** Sesi yang menurut database masih berjalan. Dipakai saat pembersihan awal. */
export async function listUnfinishedSessionIds(): Promise<{ id: string; label: string }[]> {
  return prisma.$queryRawUnsafe<{ id: string; label: string }[]>(
    `SELECT id, label FROM mining_sessions WHERE status IN ('pending', 'running')`,
  );
}

/**
 * Tutup paksa sesi yang pekerjaannya sudah tidak ada lagi.
 *
 * File yang belum sempat diproses dihitung sebagai gagal, BUKAN didiamkan.
 * Menandainya 'done' dengan angka progres yang tetap timpang akan berbohong —
 * layar akan bilang selesai padahal separuh chat tidak pernah ditambang.
 */
export async function closeOutSession(sessionId: string): Promise<void> {
  await prisma.$executeRawUnsafe(
    `UPDATE mining_sessions
        SET failed_files = failed_files + GREATEST(total_files - processed_files, 0),
            processed_files = total_files,
            status = 'done',
            updated_at = NOW()
      WHERE id = $1::uuid`,
    sessionId,
  );
}

/**
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
}

export async function listSessions(businessId: string): Promise<MiningSessionRow[]> {
  const rows = await prisma.$queryRawUnsafe<any[]>(
    `SELECT s.id, s.label, s.status, s.total_files, s.processed_files, s.failed_files,
            s.total_messages, s.cs_names, s.created_at,
            COUNT(q.id)::int AS question_count,
            COUNT(q.id) FILTER (WHERE q.answer IS NOT NULL AND q.answer <> '')::int AS answered_count
       FROM mining_sessions s
       LEFT JOIN mined_questions q ON q.session_id = s.id
      WHERE s.business_id = $1::uuid
      GROUP BY s.id
      ORDER BY s.created_at DESC
      LIMIT 50`,
    businessId,
  );
  return rows.map(r => ({
    id: r.id,
    label: r.label,
    status: r.status,
    totalFiles: r.total_files,
    processedFiles: r.processed_files,
    failedFiles: r.failed_files,
    totalMessages: r.total_messages,
    csNames: Array.isArray(r.cs_names) ? r.cs_names : [],
    createdAt: r.created_at,
    questionCount: r.question_count,
    answeredCount: r.answered_count,
  }));
}

// ─── Pertanyaan ───────────────────────────────────────────────────────────────

/**
 * Simpan satu pertanyaan, atau gabungkan ke yang sudah ada kalau maknanya sama.
 *
 * Pencarian tetangga terdekat dibatasi ke `business_id` yang sama, dan sengaja
 * TIDAK dibatasi ke satu sesi: kalau Angga mengunggah ekspor baru bulan depan,
 * pertanyaan yang sama akan menambah hitungan pada baris lama, bukan bikin baris
 * kembar. Itu yang membuat tabelnya jadi pemantau tren, bukan sekadar hasil
 * sekali pakai (keputusan Angga: pertanyaan disimpan permanen).
 */
export async function upsertQuestion(params: {
  businessId: string;
  sessionId: string;
  question: string;
  sampleRaw: string;
  category: string;
  embedding: number[];
}): Promise<'merged' | 'created'> {
  const { businessId, sessionId, question, sampleRaw, category, embedding } = params;
  const vector = `[${embedding.join(',')}]`;

  const near = await prisma.$queryRawUnsafe<{ id: string; similarity: number }[]>(
    `SELECT id, 1 - (embedding <=> $2::vector) AS similarity
       FROM mined_questions
      WHERE business_id = $1::uuid AND embedding IS NOT NULL
      ORDER BY embedding <=> $2::vector
      LIMIT 1`,
    businessId, vector,
  );

  if (near.length > 0 && Number(near[0]!.similarity) >= QUESTION_MERGE_THRESHOLD) {
    await prisma.$executeRawUnsafe(
      `UPDATE mined_questions SET occurrences = occurrences + 1, updated_at = NOW()
        WHERE id = $1::uuid`,
      near[0]!.id,
    );
    return 'merged';
  }

  await prisma.$executeRawUnsafe(
    `INSERT INTO mined_questions
       (id, business_id, session_id, question, sample_raw, occurrences, embedding, category, status, updated_at)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, 1, $6::vector, $7, 'open', NOW())`,
    randomUUID(), businessId, sessionId, question.slice(0, 500), sampleRaw.slice(0, 500),
    vector, category,
  );
  return 'created';
}

export async function listQuestions(
  businessId: string,
  opts: { sessionId?: string; status?: string } = {},
): Promise<MinedQuestionRow[]> {
  // Prefiks `q.` dipasang sejak awal, bukan ditambal belakangan. Query di bawah
  // memakai LATERAL JOIN sehingga nama kolom polos jadi rancu antara dua tabel.
  const params: any[] = [businessId];
  let where = 'q.business_id = $1::uuid';
  if (opts.sessionId) { params.push(opts.sessionId); where += ` AND q.session_id = $${params.length}::uuid`; }
  if (opts.status) { params.push(opts.status); where += ` AND q.status = $${params.length}`; }

  // Tiap pertanyaan dicocokkan ke dokumen pustaka yang paling mirip.
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
      WHERE ${where}
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
  }));
}

export async function updateQuestion(
  businessId: string,
  id: string,
  patch: { answer?: string | null; category?: string; status?: MinedQuestionStatus },
): Promise<boolean> {
  const sets: string[] = [];
  const params: any[] = [businessId, id];

  if (patch.answer !== undefined) {
    params.push(patch.answer);
    sets.push(`answer = $${params.length}`);
    // Status ikut bergerak sendiri mengikuti isi jawaban, supaya tidak ada baris
    // berjawab yang tertinggal berstatus "open" cuma karena UI lupa mengirim
    // field status.
    //
    // Dilewati kalau pemanggil menyebut `status` secara eksplisit — dua penugasan
    // ke kolom yang sama dalam satu UPDATE ditolak Postgres ("multiple assignments
    // to same column"), dan niat eksplisit pemanggil yang harus menang.
    if (patch.status === undefined) {
      sets.push(`status = CASE WHEN $${params.length} IS NULL OR $${params.length} = ''
                               THEN 'open' ELSE 'answered' END`);
    }
  }
  if (patch.category !== undefined) { params.push(patch.category); sets.push(`category = $${params.length}`); }
  if (patch.status !== undefined) { params.push(patch.status); sets.push(`status = $${params.length}`); }
  if (sets.length === 0) return false;

  const affected = await prisma.$executeRawUnsafe(
    `UPDATE mined_questions SET ${sets.join(', ')}, updated_at = NOW()
      WHERE business_id = $1::uuid AND id = $2::uuid`,
    ...params,
  );
  return affected > 0;
}

export async function markPublished(ids: string[], vaultPath: string): Promise<void> {
  if (ids.length === 0) return;
  const placeholders = ids.map((_, i) => `$${i + 2}::uuid`).join(', ');
  await prisma.$executeRawUnsafe(
    `UPDATE mined_questions SET status = 'published', vault_path = $1, updated_at = NOW()
      WHERE id IN (${placeholders})`,
    vaultPath, ...ids,
  );
  logger.info(`[QuestionMiner] ${ids.length} pertanyaan ditandai published → ${vaultPath}`);
}
