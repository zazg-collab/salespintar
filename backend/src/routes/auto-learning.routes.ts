import { Router, Request, Response, NextFunction } from 'express';
import { authenticate, authorize } from '../middleware/auth';
import { shadowMiningQueue } from '../queues/shadow-mining.queue';
import { prisma } from '../config/prisma';
import { env } from '../config/env';
import { resolveShadowMiningMode, isAutoMiningEnabled } from '../queues/shadow-mining.worker';
import fs from 'fs/promises';
import path from 'path';
import { resolveModelBerlaku } from '../services/llm';

const router = Router();

// ── Util: safe path resolver ──────────────────────────────────────────────────
function safeDraftPath(filename: string): string | null {
  const draftDir = path.join(env.OBSIDIAN_CS_PATH, 'Draft_AI');
  const resolved = path.resolve(draftDir, path.basename(filename));
  return resolved.startsWith(draftDir) ? resolved : null;
}

function safeActivePath(filename: string, category: string): string | null {
  const allowed = ['Produk', 'SOP', 'FAQ'];
  if (!allowed.includes(category)) return null;
  const activeDir = path.join(env.OBSIDIAN_CS_PATH, category);
  const resolved = path.resolve(activeDir, path.basename(filename));
  return resolved.startsWith(path.join(env.OBSIDIAN_CS_PATH)) ? resolved : null;
}

// ──────────────────────────────────────────────────────────────────────────────
// GET /api/v1/auto-learning/drafts
// List semua file di folder Draft_AI dengan metadata frontmatter
// ──────────────────────────────────────────────────────────────────────────────
router.get(
  '/drafts',
  authenticate,
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const draftDir = path.join(env.OBSIDIAN_CS_PATH, 'Draft_AI');
      let entries: string[] = [];
      try {
        entries = await fs.readdir(draftDir);
      } catch {
        // Draft_AI folder belum ada / kosong
        res.json({ success: true, data: { drafts: [], total: 0 } });
        return;
      }

      const mdFiles = entries.filter(f => f.endsWith('.md'));
      const drafts = await Promise.all(
        mdFiles.map(async (filename) => {
          const filePath = path.join(draftDir, filename);
          const raw = await fs.readFile(filePath, 'utf-8');
          const stat = await fs.stat(filePath);

          // Parse frontmatter manual (hindari dependency gray-matter di route)
          const fmMatch = raw.match(/^---\n([\s\S]*?)\n---/);
          const fm: Record<string, string> = {};
          if (fmMatch) {
            fmMatch[1].split('\n').forEach(line => {
              const [k, ...v] = line.split(': ');
              if (k && v.length) fm[k.trim()] = v.join(': ').replace(/^"|"$/g, '').trim();
            });
          }

          // Ambil preview konten (100 char pertama setelah frontmatter)
          const body = raw.replace(/^---[\s\S]*?---\n?/, '').trim();
          const preview = body.slice(0, 150).replace(/#+\s/g, '').replace(/\n/g, ' ');

          return {
            filename,
            title: fm.title || filename.replace('.md', ''),
            category: fm.category || 'FAQ',
            minedAt: fm.mined_at || null,
            conversationId: fm.conversation_id || null,
            sizeBytes: stat.size,
            // Kenapa dokumen ini wajib diperiksa manusia (lihat Lapis 2.5 di
            // shadow-mining.worker.ts). Kosong = masuk draft karena setelan mode,
            // bukan karena ada yang mencurigakan di isinya.
            reviewReason: fm.review_reason || null,
            preview,
          };
        }),
      );

      // Sort terbaru dulu
      drafts.sort((a, b) => (b.minedAt || '').localeCompare(a.minedAt || ''));

      res.json({ success: true, data: { drafts, total: drafts.length } });
    } catch (err) { next(err); }
  },
);

// ──────────────────────────────────────────────────────────────────────────────
// GET /api/v1/auto-learning/drafts/:filename
// Baca konten lengkap satu file draft
// ──────────────────────────────────────────────────────────────────────────────
router.get(
  '/drafts/:filename',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const safePath = safeDraftPath(req.params.filename as string);
      if (!safePath) {
        res.status(400).json({ error: { message: 'Invalid filename' } });
        return;
      }
      const content = await fs.readFile(safePath, 'utf-8');
      res.json({ success: true, data: { filename: req.params.filename, content } });
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        res.status(404).json({ error: { message: 'File tidak ditemukan' } });
        return;
      }
      next(err);
    }
  },
);

// ──────────────────────────────────────────────────────────────────────────────
// POST /api/v1/auto-learning/drafts/:filename/approve
// Approve: pindah file dari Draft_AI → folder aktif (Produk/SOP/FAQ)
// Body: { category: "Produk" | "SOP" | "FAQ" }
// ──────────────────────────────────────────────────────────────────────────────
router.post(
  '/drafts/:filename/approve',
  authenticate,
  authorize('ADMIN'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const filename = req.params.filename as string;
      const { category } = req.body as { category: string };

      const srcPath = safeDraftPath(filename);
      if (!srcPath) {
        res.status(400).json({ error: { message: 'Invalid filename' } });
        return;
      }

      const destPath = safeActivePath(filename, category);
      if (!destPath) {
        res.status(400).json({ error: { message: 'Category tidak valid. Gunakan: Produk, SOP, atau FAQ' } });
        return;
      }

      // Baca, update frontmatter status → active, tulis ke tujuan
      const raw = await fs.readFile(srcPath, 'utf-8');
      const updated = raw
        .replace(/^status: draft$/m, 'status: active')
        .replace(/^category: .+$/m, `category: ${category}`);

      await fs.mkdir(path.dirname(destPath), { recursive: true });
      await fs.writeFile(destPath, updated, 'utf-8');
      await fs.unlink(srcPath); // hapus dari Draft_AI

      // Watcher Obsidian akan otomatis re-embed file baru ke DB

      res.json({
        success: true,
        message: `Draft "${filename}" disetujui dan dipindahkan ke ${category}/`,
        data: { filename, category, activePath: `${category}/${filename}` },
      });
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        res.status(404).json({ error: { message: 'File draft tidak ditemukan' } });
        return;
      }
      next(err);
    }
  },
);

// ──────────────────────────────────────────────────────────────────────────────
// DELETE /api/v1/auto-learning/drafts/:filename
// Reject: hapus file draft dari Draft_AI
// ──────────────────────────────────────────────────────────────────────────────
router.delete(
  '/drafts/:filename',
  authenticate,
  authorize('ADMIN'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const safePath = safeDraftPath(req.params.filename as string);
      if (!safePath) {
        res.status(400).json({ error: { message: 'Invalid filename' } });
        return;
      }
      await fs.unlink(safePath);
      res.json({
        success: true,
        message: `Draft "${req.params.filename}" dihapus`,
        data: { filename: req.params.filename },
      });
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        res.status(404).json({ error: { message: 'File tidak ditemukan' } });
        return;
      }
      next(err);
    }
  },
);

// ──────────────────────────────────────────────────────────────────────────────
// GET /api/v1/auto-learning/status
// Status lengkap: mode, queue stats, draft count
// ──────────────────────────────────────────────────────────────────────────────
router.get(
  '/status',
  authenticate,
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      // `delayed` wajib ikut dihitung. Impor massal mengantrekan job dengan jeda
      // bertingkat (`delay: n * 1500` di chat-import.routes.ts), dan BullMQ menaruh
      // job berjeda di set `delayed` — BUKAN `waiting`. Tanpa angka ini, ratusan
      // percakapan yang sedang mengantre terbaca sebagai antrean kosong di dashboard,
      // sehingga pengguna mengira impornya gagal padahal sedang berjalan.
      const [waiting, active, delayed, completed, failed] = await Promise.all([
        shadowMiningQueue.getWaitingCount(),
        shadowMiningQueue.getActiveCount(),
        shadowMiningQueue.getDelayedCount(),
        shadowMiningQueue.getCompletedCount(),
        shadowMiningQueue.getFailedCount(),
      ]);

      let draftCount = 0;
      try {
        const draftDir = path.join(env.OBSIDIAN_CS_PATH, 'Draft_AI');
        const files = await fs.readdir(draftDir);
        draftCount = files.filter(f => f.endsWith('.md')).length;
      } catch { /* folder kosong */ }

      res.json({
        success: true,
        data: {
          // Fix C9: mode dibaca dari DB per business, bukan dari env global
          mode: await resolveShadowMiningMode(_req.user!.businessId),
          // Rem penambangan otomatis — terpisah dari `mode`, yang hanya mengatur
          // hasil mining mau langsung aktif atau masuk Draft_AI.
          autoTrigger: await isAutoMiningEnabled(_req.user!.businessId),
          draftCount,
          queue: { waiting, active, delayed, completed, failed },
          config: {
            minMessages: env.SHADOW_MINING_MIN_MESSAGES,
            similarityThreshold: env.SHADOW_MINING_SIMILARITY_THRESHOLD,
            // ⚠️ `resolveModelBerlaku('extract', …)`, BUKAN `env.GROQ_EXTRACTOR_MODEL`.
            // Baris ini dulu membaca env mentah, dan sejak Fase 59 itu berarti
            // MELAPORKAN YANG SALAH: `LLM_MODEL_EXTRACT` (dan pilihan di halaman
            // Pengaturan Model) mengalahkan `GROQ_EXTRACTOR_MODEL`, jadi dashboard
            // akan menyebut satu model sementara yang benar-benar menambang model
            // lain. Persis keluhan Angga 30 Juli: "nanti tau2 milihnya apa di
            // dashboard ternyata aslinya apa". Sumber yang menang harus jadi sumber
            // yang DILAPORKAN.
            extractorModel: (await resolveModelBerlaku('extract', _req.user!.businessId)).spec,
          },
        },
      });
    } catch (err) { next(err); }
  },
);

// ──────────────────────────────────────────────────────────────────────────────
// PATCH /api/v1/auto-learning/mode
// Toggle mode auto/draft — Fix audit C9
//
// Dulu: `(env as any).SHADOW_MINING_MODE = mode` — memutasi objek konfigurasi
// saat runtime. Tiga masalahnya: (1) hilang saat server restart, (2) hanya
// berlaku di satu instance sehingga instance lain tetap pakai mode lama, dan
// (3) bocor lintas tenant — satu business mengubah mode, semua business ikut.
// Sekarang disimpan per business di kolom Business.shadowMiningMode.
// Body: { mode: "auto" | "draft" }
// ──────────────────────────────────────────────────────────────────────────────
router.patch(
  '/mode',
  authenticate,
  authorize('ADMIN'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { mode } = req.body as { mode: string };
      if (mode !== 'auto' && mode !== 'draft') {
        res.status(400).json({ error: { message: 'mode harus "auto" atau "draft"' } });
        return;
      }

      await prisma.business.update({
        where: { id: req.user!.businessId },
        data: { shadowMiningMode: mode },
      });

      res.json({
        success: true,
        message: `Auto-Learning mode diubah ke "${mode}"`,
        data: {
          mode,
          description: mode === 'auto'
            ? 'Hasil mining langsung aktif — masuk ke vault sebagai knowledge bot'
            : 'Hasil mining masuk Draft_AI — menunggu persetujuan manual di dashboard',
        },
      });
    } catch (err) { next(err); }
  },
);

// ──────────────────────────────────────────────────────────────────────────────
// PATCH /api/v1/auto-learning/auto-trigger
// Nyalakan/matikan penambangan otomatis saat percakapan ditandai Selesai.
//
// Beda dengan /mode: `mode` mengatur hasil mining mau langsung aktif (auto) atau
// menunggu persetujuan (draft). Yang ini mengatur apakah penambangannya
// DIJALANKAN sama sekali — remnya, supaya token Groq tidak terpakai tanpa
// kendali di setiap percakapan yang selesai.
// Body: { enabled: boolean }
// ──────────────────────────────────────────────────────────────────────────────
router.patch(
  '/auto-trigger',
  authenticate,
  authorize('ADMIN'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { enabled } = req.body as { enabled: unknown };
      if (typeof enabled !== 'boolean') {
        res.status(400).json({ error: { message: 'enabled harus true atau false' } });
        return;
      }

      await prisma.business.update({
        where: { id: req.user!.businessId },
        data: { shadowMiningAutoTrigger: enabled },
      });

      res.json({
        success: true,
        message: enabled
          ? 'Penambangan otomatis DINYALAKAN — percakapan yang ditandai Selesai akan ditambang'
          : 'Penambangan otomatis DIMATIKAN — tidak ada token Groq terpakai untuk mining sampai dinyalakan lagi',
        data: { autoTrigger: enabled },
      });
    } catch (err) { next(err); }
  },
);

export default router;
