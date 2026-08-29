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


# ══ 1. repo ═══════════════════════════════════════════════════════════════════
patch('backend/src/services/question-miner.repo.ts', [
(
"export type MiningSessionStatus = 'pending' | 'running' | 'done' | 'failed';",
"export type MiningSessionStatus = 'pending' | 'running' | 'done' | 'failed' | 'cancelled';"
),
(
"""export async function bumpProcessed(sessionId: string): Promise<void> {
  await prisma.$executeRawUnsafe(
    `UPDATE mining_sessions
        SET processed_files = processed_files + 1,
            updated_at = NOW(),
            status = CASE WHEN processed_files + 1 >= total_files THEN 'done' ELSE status END
      WHERE id = $1::uuid`,
    sessionId,
  );
}""",
"""export async function bumpProcessed(sessionId: string): Promise<void> {
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
}"""
),
])


# ══ 2. queue — buang job milik satu sesi ═════════════════════════════════════
patch('backend/src/queues/question-mining.queue.ts', [
(
"""export const questionMiningQueue = new Queue<QuestionMiningJobData>('question-mining', {""",
"""/**
 * Buang seluruh job yang belum berjalan milik satu sesi.
 *
 * Job yang SEDANG berjalan tidak bisa dicabut dari luar — BullMQ tidak punya
 * mekanisme membunuh job aktif. Itu ditangani dari sisi lain: worker memeriksa
 * status sesi sebelum mulai bekerja, jadi job aktif terakhir akan berhenti
 * sendiri begitu gilirannya selesai.
 */
export async function removeSessionJobs(sessionId: string): Promise<number> {
  const jobs = await questionMiningQueue.getJobs(['waiting', 'delayed', 'paused']);
  let removed = 0;
  for (const job of jobs) {
    if (job.data?.sessionId !== sessionId) continue;
    // Job bisa saja sudah berpindah keadaan di antara pembacaan dan penghapusan;
    // kegagalan di sini tidak berarti pembatalannya gagal.
    await job.remove().catch(() => undefined);
    removed++;
  }
  return removed;
}

/**
 * Berapa job yang masih hidup untuk tiap sesi. Dipakai saat server menyala untuk
 * membedakan "masih jalan" dari "nyangkut": sesi yang di database berstatus
 * berjalan tapi tidak punya satu pun job tersisa berarti pekerjaannya memang
 * sudah lenyap — biasanya karena server mati di tengah proses.
 */
export async function countLiveJobsBySession(): Promise<Set<string>> {
  const jobs = await questionMiningQueue.getJobs(['waiting', 'delayed', 'active', 'paused']);
  const alive = new Set<string>();
  for (const job of jobs) {
    const id = job.data?.sessionId;
    if (id) alive.add(id);
  }
  return alive;
}

export const questionMiningQueue = new Queue<QuestionMiningJobData>('question-mining', {"""
),
])


# ══ 3. worker — hormati pembatalan ═══════════════════════════════════════════
patch('backend/src/queues/question-mining.worker.ts', [
(
"import { bumpProcessed, bumpFailed, upsertQuestion } from '../services/question-miner.repo';",
"import { bumpProcessed, bumpFailed, upsertQuestion, getSessionStatus } from '../services/question-miner.repo';"
),
(
"""  const { sessionId, businessId, filename, customerLines } = job.data;
  logger.info(`[QuestionMiner] Mulai ${filename} (${customerLines.length} baris pelanggan)`);""",
"""  const { sessionId, businessId, filename, customerLines } = job.data;

  // Diperiksa SEBELUM memanggil Groq, bukan sesudah. Job yang antre bisa saja
  // baru dapat giliran beberapa menit setelah tombol Batal ditekan; menambang
  // dulu baru memeriksa berarti tokennya sudah terbakar sia-sia.
  const status = await getSessionStatus(sessionId);
  if (status === 'cancelled') {
    logger.info(`[QuestionMiner] ${filename} dilewati — sesi dibatalkan`);
    return { created: 0, merged: 0, skipped: 'cancelled' };
  }

  logger.info(`[QuestionMiner] Mulai ${filename} (${customerLines.length} baris pelanggan)`);"""
),
])


# ══ 4. routes — endpoint batal ═══════════════════════════════════════════════
patch('backend/src/routes/question-miner.routes.ts', [
(
"import { questionMiningQueue } from '../queues/question-mining.queue';",
"import { questionMiningQueue, removeSessionJobs } from '../queues/question-mining.queue';"
),
(
"""import {
  createSession, listSessions, listQuestions, updateQuestion, markPublished,
  type MinedQuestionRow,
} from '../services/question-miner.repo';""",
"""import {
  createSession, listSessions, listQuestions, updateQuestion, markPublished, cancelSession,
  type MinedQuestionRow,
} from '../services/question-miner.repo';"""
),
(
"""// ── Daftar pertanyaan ─────────────────────────────────────────────────────────""",
"""// ──────────────────────────────────────────────────────────────────────────────
// POST /api/v1/question-miner/sessions/:id/cancel
//
// Job yang belum jalan dibuang dari antrean; job yang sedang jalan akan berhenti
// sendiri karena worker memeriksa status sesi sebelum bekerja. Pertanyaan yang
// SUDAH terkumpul sengaja dibiarkan — pembatalan menghentikan pekerjaan, bukan
// membuang hasil yang sudah didapat.
// ──────────────────────────────────────────────────────────────────────────────
router.post(
  '/sessions/:id/cancel',
  authenticate,
  authorize('ADMIN', 'SALES'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const sessionId = req.params.id as string;
      const ok = await cancelSession(req.user!.businessId, sessionId);
      if (!ok) {
        res.status(404).json({ error: { message: 'Sesi tidak ditemukan atau memang sudah selesai' } });
        return;
      }
      const removed = await removeSessionJobs(sessionId);
      logger.info(`[QuestionMiner] Sesi ${sessionId} dibatalkan, ${removed} job dibuang dari antrean`);
      res.json({
        success: true,
        message: `Penambangan dihentikan. ${removed} file batal diproses; pertanyaan yang sudah terkumpul tetap tersimpan.`,
      });
    } catch (err) { next(err); }
  },
);

// ── Daftar pertanyaan ─────────────────────────────────────────────────────────"""
),
])


# ══ 5. server.ts — bereskan sesi nyangkut saat menyala ═══════════════════════
patch('backend/src/server.ts', [
(
"""  // Dinyatakan terang-terangan saat menyala, supaya "notifikasi tidak masuk\"""",
"""  // ── Bereskan sesi penambangan yang nyangkut ──────────────────────────────
  // Kalau server mati di tengah penambangan, baris sesinya tertinggal berstatus
  // "berjalan" selamanya: spanduk progres menempel di layar, angkanya tidak
  // pernah bertambah, dan tidak ada yang akan menyelesaikannya. Di sini sesi
  // yang di database masih berjalan dicocokkan dengan antrean sungguhan —
  // yang tidak punya satu pun job tersisa berarti pekerjaannya memang sudah
  // lenyap, dan ditutup dengan sisa filenya dihitung gagal.
  //
  // Dijalankan SESUDAH setupWorkers() supaya antreannya sudah tersambung ke
  // Redis; membacanya lebih awal akan mengembalikan daftar kosong dan
  // menutup paksa sesi yang sebenarnya sehat.
  try {
    const { listUnfinishedSessionIds, closeOutSession } = await import('./services/question-miner.repo');
    const { countLiveJobsBySession } = await import('./queues/question-mining.queue');
    const unfinished = await listUnfinishedSessionIds();
    if (unfinished.length > 0) {
      const alive = await countLiveJobsBySession();
      for (const s of unfinished) {
        if (alive.has(s.id)) continue;
        await closeOutSession(s.id);
        logger.warn(`[QuestionMiner] Sesi "${s.label}" nyangkut tanpa job tersisa — ditutup paksa`);
      }
    }
  } catch (err) {
    // Pembersihan gagal tidak boleh menghalangi server menyala.
    logger.warn(`[QuestionMiner] Pembersihan sesi nyangkut dilewati: ${err}`);
  }

  // Dinyatakan terang-terangan saat menyala, supaya "notifikasi tidak masuk\""""
),
])

print('SELESAI')
