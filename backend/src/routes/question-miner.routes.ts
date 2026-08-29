import { Router, Request, Response, NextFunction } from 'express';
import multer from 'multer';
import AdmZip from 'adm-zip';
import fs from 'fs/promises';
import path from 'path';
import { authenticate, authorize } from '../middleware/auth';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import { parseWhatsAppExport } from '../services/wa-export-parser';
import { questionMiningQueue, removeSessionJobs } from '../queues/question-mining.queue';
import { complete } from '../services/llm';
import { toJakartaDateStr } from '../utils/timezone';
import {
  createSession, listSessions, listQuestions, updateQuestion, markPublished, cancelSession,
  type MinedQuestionRow,
} from '../services/question-miner.repo';

const router = Router();

// ──────────────────────────────────────────────────────────────────────────────
// QUESTION MINER
//
// Menambang PERTANYAAN pelanggan dari ekspor chat, lalu pemilik bisnis yang
// mengisi jawabannya. Jawaban CS dari chat lama sengaja dibuang di sini — bukan
// karena tidak berguna, tapi karena tidak ada yang tahu mana yang masih berlaku.
//
// Langkah analisis (bongkar zip + tebak siapa CS) TIDAK diduplikasi di sini;
// UI memakai ulang `POST /chat-import/analyze` yang sudah ada. Menyalinnya cuma
// akan bikin dua parser yang lama-lama beda perilaku.
// ──────────────────────────────────────────────────────────────────────────────

const MAX_ZIP_BYTES = 50 * 1024 * 1024; // 50 MB — sama dengan impor Shadow Mining

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_ZIP_BYTES },
});

function extractChatFiles(zipBuffer: Buffer): { filename: string; content: string }[] {
  const zip = new AdmZip(zipBuffer);
  return zip
    .getEntries()
    .filter(e => {
      if (e.isDirectory) return false;
      const name = e.entryName.toLowerCase();
      if (!name.endsWith('.txt')) return false;
      if (name.includes('__macosx/') || name.endsWith('.ds_store')) return false;
      return true;
    })
    .map(e => ({ filename: e.entryName, content: e.getData().toString('utf-8') }));
}

// ──────────────────────────────────────────────────────────────────────────────
// POST /api/v1/question-miner/start
// Bongkar zip → buang ucapan CS → antrekan penambangan pertanyaan.
// ──────────────────────────────────────────────────────────────────────────────
router.post(
  '/start',
  authenticate,
  authorize('ADMIN', 'SALES'),
  upload.single('file'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { businessId } = req.user!;
      if (!req.file) {
        res.status(400).json({ error: { message: 'File zip belum dilampirkan (field: file)' } });
        return;
      }

      let csNames: string[];
      try {
        csNames = JSON.parse(String(req.body.csNames || '[]'));
        if (!Array.isArray(csNames) || csNames.some(n => typeof n !== 'string')) throw new Error();
      } catch {
        res.status(400).json({ error: { message: 'csNames harus berupa JSON array berisi nama (string)' } });
        return;
      }
      if (csNames.length === 0) {
        res.status(400).json({
          error: { message: 'Pilih minimal satu nama sebagai CS, supaya sistem tahu mana ucapan tim dan mana pelanggan.' },
        });
        return;
      }

      let files: { filename: string; content: string }[];
      try {
        files = extractChatFiles(req.file.buffer);
      } catch (err) {
        res.status(400).json({ error: { message: `Gagal membaca zip: ${err}` } });
        return;
      }
      if (files.length === 0) {
        res.status(400).json({
          error: { message: 'Tidak ada file .txt di dalam zip. Ekspor chat WhatsApp dengan opsi "Tanpa Media".' },
        });
        return;
      }

      const csSet = new Set(csNames.map(n => n.trim().toLowerCase()));

      // Di sinilah jawaban CS dibuang — sebelum apa pun dikirim ke model mana pun.
      // Bukan disaring belakangan: teks jawaban CS memang tidak pernah meninggalkan
      // proses ini sama sekali.
      const jobs: { filename: string; customerLines: string[] }[] = [];
      let totalMessages = 0;

      for (const f of files) {
        const chat = parseWhatsAppExport(f.content);
        totalMessages += chat.messages.length;
        const customerLines = chat.messages
          .filter(m => !csSet.has(m.sender.trim().toLowerCase()))
          .map(m => m.text)
          .filter(t => t.trim().length > 0);
        if (customerLines.length > 0) {
          jobs.push({ filename: f.filename, customerLines });
        }
      }

      if (jobs.length === 0) {
        res.status(400).json({
          error: { message: 'Semua nama ditandai sebagai CS — tidak ada ucapan pelanggan yang bisa ditambang.' },
        });
        return;
      }

      const label = (req.file.originalname || 'ekspor-chat').replace(/\.zip$/i, '');
      const sessionId = await createSession(businessId, label, csNames, jobs.length, totalMessages);

      for (let i = 0; i < jobs.length; i++) {
        await questionMiningQueue.add(
          'mine-questions',
          {
            sessionId,
            businessId,
            filename: jobs[i]!.filename,
            customerLines: jobs[i]!.customerLines,
          },
          // Jeda bertingkat, alasan sama dengan impor Shadow Mining: jangan
          // membanjiri Groq sekaligus saat ratusan file diunggah.
          { delay: i * 1200 },
        );
      }

      logger.info(`[QuestionMiner] Sesi ${sessionId}: ${jobs.length} file diantrekan (CS: ${csNames.join(', ')})`);
      res.json({
        success: true,
        message: `${jobs.length} file diantrekan untuk ditambang pertanyaannya.`,
        data: { sessionId, queued: jobs.length, totalMessages },
      });
    } catch (err) { next(err); }
  },
);

// ── Daftar sesi ───────────────────────────────────────────────────────────────
router.get('/sessions', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sessions = await listSessions(req.user!.businessId);
    res.json({ success: true, data: { sessions } });
  } catch (err) { next(err); }
});

// ──────────────────────────────────────────────────────────────────────────────
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

// ── Daftar pertanyaan ─────────────────────────────────────────────────────────
router.get('/questions', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const questions = await listQuestions(req.user!.businessId, {
      sessionId: typeof req.query.sessionId === 'string' ? req.query.sessionId : undefined,
      status: typeof req.query.status === 'string' ? req.query.status : undefined,
    });
    res.json({ success: true, data: { questions, total: questions.length } });
  } catch (err) { next(err); }
});

// ── Simpan jawaban / ubah kategori / abaikan ─────────────────────────────────
router.patch(
  '/questions/:id',
  authenticate,
  authorize('ADMIN', 'SALES'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { answer, category, status } = req.body ?? {};
      if (category !== undefined && !['Produk', 'SOP', 'FAQ'].includes(category)) {
        res.status(400).json({ error: { message: 'category harus Produk, SOP, atau FAQ' } });
        return;
      }
      if (status !== undefined && !['open', 'answered', 'dismissed', 'published'].includes(status)) {
        res.status(400).json({ error: { message: 'status tidak dikenal' } });
        return;
      }
      const ok = await updateQuestion(req.user!.businessId, req.params.id as string, {
        answer, category, status,
      });
      if (!ok) {
        res.status(404).json({ error: { message: 'Pertanyaan tidak ditemukan' } });
        return;
      }
      res.json({ success: true });
    } catch (err) { next(err); }
  },
);

// ──────────────────────────────────────────────────────────────────────────────
// POST /api/v1/question-miner/publish
// Susun dokumen dari pertanyaan yang SUDAH DIJAWAB, lalu tulis ke vault.
//
// Model di sini hanya merapikan bentuk. Fakta seluruhnya berasal dari jawaban
// yang diketik pemilik bisnis — itulah sebabnya hasil fitur ini boleh dipercaya
// sedangkan hasil Shadow Mining perlu dicek.
// ──────────────────────────────────────────────────────────────────────────────
router.post(
  '/publish',
  authenticate,
  authorize('ADMIN', 'SALES'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { businessId } = req.user!;
      const sessionId = typeof req.body?.sessionId === 'string' ? req.body.sessionId : undefined;

      const all = await listQuestions(businessId, { sessionId, status: 'answered' });
      const answered = all.filter(q => q.answer && q.answer.trim().length > 0);

      if (answered.length === 0) {
        res.status(400).json({
          error: { message: 'Belum ada pertanyaan yang dijawab. Isi dulu minimal satu jawaban.' },
        });
        return;
      }

      const byCategory = new Map<string, MinedQuestionRow[]>();
      for (const q of answered) {
        const list = byCategory.get(q.category) ?? [];
        list.push(q);
        byCategory.set(q.category, list);
      }

      const written: { category: string; vaultPath: string; questionCount: number }[] = [];
      const dateStr = toJakartaDateStr().replace(/-/g, '');

      for (const [category, items] of byCategory) {
        const pairs = items
          .map(q => `PERTANYAAN: ${q.question}\nJAWABAN PEMILIK: ${q.answer}`)
          .join('\n\n');

        // Job 'publish'. Satu panggilan PER KATEGORI di dalam satu request HTTP,
        // dan dulu tanpa jeda antar iterasi — dengan sepuluh kategori itu sepuluh
        // panggilan beruntun yang bertabrakan dengan balasan pelanggan yang
        // sedang jalan. Sejak lapisan llm.ts, jeda itu bisa dipasang lewat
        // `LLM_MIN_GAP_MS_PUBLISH` tanpa menyentuh kode ini (bawaan 0 = perilaku
        // seperti sebelumnya).
        const resp = await complete('publish', {
          businessId,
          messages: [
            {
              role: 'system',
              content: `Kamu adalah penyunting dokumen. Kamu menerima daftar pertanyaan pelanggan
beserta jawaban yang DITULIS SENDIRI oleh pemilik bisnis.

TUGASMU HANYA MERAPIKAN BENTUK. Susun jadi dokumen Markdown yang enak dibaca.

LARANGAN MUTLAK:
- DILARANG menambah fakta, angka, harga, atau keterangan yang tidak ada di jawaban pemilik.
- DILARANG mengubah angka apa pun yang ditulis pemilik.
- DILARANG melengkapi jawaban yang terasa kurang. Kalau jawabannya pendek, biarkan pendek.
- DILARANG menambahkan kalimat pembuka atau penutup berisi klaim ("kami jamin", "pasti", dll).

Kamu boleh: memperbaiki ejaan, menyusun ulang urutan, memberi judul bagian, dan
menyeragamkan gaya bahasa jadi sopan dan ramah.

Keluarkan HANYA isi Markdown, tanpa frontmatter, tanpa penjelasan tambahan.
Mulai dengan judul level 1.`,
            },
            { role: 'user', content: `KATEGORI: ${category}\n\n${pairs}` },
          ],
        });

        const body = (resp.text || '').trim();
        if (!body) {
          logger.warn(`[QuestionMiner] Penyusunan dokumen kategori ${category} menghasilkan kosong — dilewati`);
          continue;
        }

        const frontmatter = [
          '---',
          `title: "Jawaban Resmi — ${category}"`,
          `category: ${category}`,
          // Penanda asal-usul. Berbeda dari `shadow-mining`: isi dokumen ini
          // berasal dari pemilik bisnis, bukan dari tebakan atas chat lama.
          'source: question-miner',
          `business_id: ${businessId}`,
          `authored_by: owner`,
          `created: ${new Date().toISOString()}`,
          'status: active',
          '---',
          '',
        ].join('\n');

        const filename = `${dateStr}-jawaban-resmi-${category.toLowerCase()}.md`;
        const absPath = path.join(env.OBSIDIAN_CS_PATH, category, filename);
        await fs.mkdir(path.dirname(absPath), { recursive: true });
        await fs.writeFile(absPath, frontmatter + body, 'utf-8');

        const vaultPath = `${category}/${filename}`;
        await markPublished(items.map(q => q.id), vaultPath);
        written.push({ category, vaultPath, questionCount: items.length });
        logger.info(`[QuestionMiner] Dokumen ditulis: ${vaultPath} (${items.length} pertanyaan)`);
      }

      if (written.length === 0) {
        res.status(500).json({ error: { message: 'Tidak ada dokumen yang berhasil disusun. Coba lagi.' } });
        return;
      }

      res.json({
        success: true,
        message: `${written.length} dokumen ditulis ke vault. Watcher akan menyerapnya dalam beberapa detik.`,
        data: { written },
      });
    } catch (err) { next(err); }
  },
);

export default router;
