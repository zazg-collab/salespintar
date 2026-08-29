import { Router, Request, Response, NextFunction } from 'express';
import multer from 'multer';
import { extractDocument, SUPPORTED_EXTENSIONS } from '../services/document-extract.service';
import { authenticate, authorize } from '../middleware/auth';
import { obsidianWatcher } from '../services/obsidian-watcher.service';
import { env } from '../config/env';
import fs from 'fs/promises';
import path from 'path';
import matter from 'gray-matter';
import { logger } from '../utils/logger';
import { toJakartaDateStr } from '../utils/timezone';

const router = Router();

// ─── Helper: pastikan path ada di dalam vault (security: no path traversal) ──
function safeVaultPath(relativePath: string): string | null {
  const vault = env.OBSIDIAN_CS_PATH;
  const resolved = path.resolve(vault, relativePath);
  if (!resolved.startsWith(path.resolve(vault))) return null; // path traversal attempt
  return resolved;
}

// ─── Helper: rekursif build file tree ────────────────────────────────────────
interface FileNode {
  name: string;
  path: string;
  type: 'file' | 'folder';
  children?: FileNode[];
  size?: number;
  syncedAt?: string | null;
  extension?: string;
}

async function buildFileTree(dir: string, vaultRoot: string): Promise<FileNode[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const nodes: FileNode[] = [];

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue; // skip hidden
    const fullPath = path.join(dir, entry.name);
    const relativePath = path.relative(vaultRoot, fullPath);

    if (entry.isDirectory()) {
      const children = await buildFileTree(fullPath, vaultRoot);
      nodes.push({ name: entry.name, path: relativePath, type: 'folder', children });
    } else {
      const stat = await fs.stat(fullPath);
      const ext = path.extname(entry.name).toLowerCase();
      nodes.push({
        name: entry.name,
        path: relativePath,
        type: 'file',
        size: stat.size,
        extension: ext,
      });
    }
  }

  // Sort: folders first, then files; alphabetically
  return nodes.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

// ──────────────────────────────────────────────────────────────────────────────
// Manual Sync Endpoints
// ──────────────────────────────────────────────────────────────────────────────

/**
 * POST /api/v1/sync/obsidian
 * Trigger full resync semua file .md di vault ke DB.
 */
router.post('/obsidian', authenticate, authorize('ADMIN'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await obsidianWatcher.fullResync(req.user!.businessId);
    res.json({
      success: true,
      message: 'Resync selesai',
      data: result,
    });
  } catch (err) { next(err); }
});

/**
 * GET /api/v1/sync/status
 * Status watcher: aktif/tidak, total synced, last sync.
 */
router.get('/status', authenticate, async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const stats = obsidianWatcher.getStats();
    res.json({
      success: true,
      data: {
        isWatching: stats.isWatching,
        vaultPath: stats.vaultPath || env.OBSIDIAN_CS_PATH,
        totalSynced: stats.totalSynced,
        totalDeleted: stats.totalDeleted,
        lastSyncAt: stats.lastSyncAt,
      },
    });
  } catch (err) { next(err); }
});

// ──────────────────────────────────────────────────────────────────────────────
// Vault File Explorer Endpoints
// ──────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/v1/sync/vault/tree
 * Kembalikan tree struktur folder vault Obsidian CS Brain.
 */
router.get('/vault/tree', authenticate, async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const vault = env.OBSIDIAN_CS_PATH;
    await fs.access(vault); // pastikan vault ada
    const tree = await buildFileTree(vault, vault);
    res.json({ success: true, data: { tree, vaultPath: vault } });
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      res.json({ success: true, data: { tree: [], vaultPath: env.OBSIDIAN_CS_PATH } });
    } else { next(err); }
  }
});

/**
 * GET /api/v1/sync/vault/file?path=Produk/pisau.md
 * Baca isi satu file .md dari vault.
 */
router.get('/vault/file', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const relPath = req.query.path as string;
    if (!relPath) { res.status(400).json({ error: { message: 'Parameter path wajib diisi' } }); return; }

    const absPath = safeVaultPath(relPath);
    if (!absPath) { res.status(400).json({ error: { message: 'Path tidak valid' } }); return; }

    const raw = await fs.readFile(absPath, 'utf-8');
    const { data: frontmatter, content } = matter(raw);
    res.json({ success: true, data: { path: relPath, frontmatter, content, raw } });
  } catch (err: any) {
    if (err.code === 'ENOENT') { res.status(404).json({ error: { message: 'File tidak ditemukan' } }); }
    else { next(err); }
  }
});

/**
 * PUT /api/v1/sync/vault/file
 * Simpan/update isi file .md ke vault. Watcher akan otomatis re-embed.
 * Body: { path: "Produk/pisau.md", content: "# ..." }
 */
router.put('/vault/file', authenticate, authorize('ADMIN'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { path: relPath, content } = req.body as { path: string; content: string };
    if (!relPath || content === undefined) {
      res.status(400).json({ error: { message: 'path dan content wajib diisi' } }); return;
    }

    const absPath = safeVaultPath(relPath);
    if (!absPath) { res.status(400).json({ error: { message: 'Path tidak valid' } }); return; }

    // Buat folder parent jika belum ada
    await fs.mkdir(path.dirname(absPath), { recursive: true });
    await fs.writeFile(absPath, content, 'utf-8');

    res.json({ success: true, message: 'File disimpan. Watcher akan sync otomatis dalam beberapa detik.' });
  } catch (err) { next(err); }
});

/**
 * DELETE /api/v1/sync/vault/file?path=Produk/pisau.md
 * Hapus file .md dari vault. Watcher akan otomatis hapus dari DB.
 */
router.delete('/vault/file', authenticate, authorize('ADMIN'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const relPath = req.query.path as string;
    if (!relPath) { res.status(400).json({ error: { message: 'Parameter path wajib diisi' } }); return; }

    const absPath = safeVaultPath(relPath);
    if (!absPath) { res.status(400).json({ error: { message: 'Path tidak valid' } }); return; }

    await fs.unlink(absPath);
    res.json({ success: true, message: 'File dihapus dari vault.' });
  } catch (err: any) {
    if (err.code === 'ENOENT') { res.status(404).json({ error: { message: 'File tidak ditemukan' } }); }
    else { next(err); }
  }
});

/**
 * POST /api/v1/sync/vault/upload
 * Upload file .md langsung sebagai teks ke folder vault.
 * Body: { folder: "Produk", filename: "pisau.md", content: "# ..." }
 */
router.post('/vault/upload', authenticate, authorize('ADMIN'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { folder, filename, content } = req.body as { folder: string; filename: string; content: string };
    if (!folder || !filename || content === undefined) {
      res.status(400).json({ error: { message: 'folder, filename, dan content wajib diisi' } }); return;
    }

    // Validasi extension
    const ext = path.extname(filename).toLowerCase();
    if (ext !== '.md') {
      res.status(400).json({ error: { message: 'Hanya file .md yang diizinkan untuk upload langsung' } }); return;
    }

    const relPath = path.join(folder, filename);
    const absPath = safeVaultPath(relPath);
    if (!absPath) { res.status(400).json({ error: { message: 'Path tidak valid' } }); return; }

    await fs.mkdir(path.dirname(absPath), { recursive: true });
    await fs.writeFile(absPath, content, 'utf-8');

    res.status(201).json({
      success: true,
      message: 'File berhasil diupload ke vault. Bot akan belajar dari file ini secara otomatis.',
      data: { path: relPath },
    });
  } catch (err) { next(err); }
});

// ──────────────────────────────────────────────────────────────────────────────
// POST /api/v1/sync/vault/upload-file  (multipart)
//
// Unggah PDF / DOCX / TXT / gambar → dibaca jadi teks → ditulis sebagai .md ke
// vault → pengawas folder menyerapnya seperti file lain.
//
// Perhatikan bahwa yang disimpan adalah TEKSNYA, bukan berkas aslinya. Bot
// mencari berdasarkan makna kalimat; menyimpan PDF mentah di vault tidak ada
// gunanya karena pengawas hanya membaca .md. Berkas asli tidak ikut disimpan —
// kalau nanti perlu, simpan sendiri di tempat lain.
// ──────────────────────────────────────────────────────────────────────────────

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024; // 25 MB

const fileUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES },
});

router.post(
  '/vault/upload-file',
  authenticate,
  authorize('ADMIN'),
  fileUpload.single('file'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.file) {
        res.status(400).json({ error: { message: 'Berkas belum dilampirkan (field: file)' } });
        return;
      }

      const folder = String(req.body.folder || 'FAQ');
      if (!['Produk', 'SOP', 'FAQ'].includes(folder)) {
        res.status(400).json({ error: { message: 'folder harus Produk, SOP, atau FAQ' } });
        return;
      }

      const originalName = req.file.originalname || 'dokumen';
      let extracted;
      try {
        extracted = await extractDocument(req.file.buffer, originalName);
      } catch (err: any) {
        // Galat pembacaan adalah salah berkas, bukan salah server — 400, bukan 500.
        res.status(400).json({ error: { message: err?.message || 'Berkas gagal dibaca' } });
        return;
      }

      if (!extracted.text || extracted.text.length < 20) {
        res.status(400).json({
          error: {
            message: extracted.usedOcr
              ? 'Tulisan di berkas ini tidak terbaca. Kalau ini hasil foto, coba potret ulang lebih terang dan lurus.'
              : 'Berkas ini tidak memuat teks yang bisa dibaca. Kalau ini PDF hasil pindaian, unggah sebagai gambar agar bisa di-OCR.',
          },
        });
        return;
      }

      const baseName = path.basename(originalName, path.extname(originalName));
      const title = String(req.body.title || baseName).slice(0, 120);
      const slug = baseName
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 60) || 'dokumen';
      const dateStr = toJakartaDateStr().replace(/-/g, '');
      const filename = `${dateStr}-${slug}.md`;

      const relPath = path.join(folder, filename);
      const absPath = safeVaultPath(relPath);
      if (!absPath) { res.status(400).json({ error: { message: 'Path tidak valid' } }); return; }

      const frontmatter = [
        '---',
        `title: "${title.replace(/"/g, "'")}"`,
        `category: ${folder}`,
        'source: upload',
        `original_file: "${originalName.replace(/"/g, "'")}"`,
        // Ditulis apa adanya supaya siapa pun yang membaca dokumen ini tahu
        // isinya hasil pengenalan tulisan — yang bisa salah baca angka.
        `extraction: ${extracted.usedOcr ? 'ocr' : 'teks'}`,
        ...(extracted.usedOcr ? [`ocr_confidence: ${Math.round(extracted.confidence ?? 0)}`] : []),
        `created: ${new Date().toISOString()}`,
        'status: active',
        '---',
        '',
      ].join('\n');

      const body = `# ${title}\n\n${extracted.text}\n`;
      await fs.mkdir(path.dirname(absPath), { recursive: true });
      await fs.writeFile(absPath, frontmatter + body, 'utf-8');

      logger.info(`[Upload] ${originalName} → ${relPath} (${extracted.text.length} karakter, ${extracted.usedOcr ? 'OCR' : 'teks'})`);

      const notes: string[] = [];
      if (extracted.usedOcr) {
        notes.push(
          `Berkas ini dibaca lewat pengenalan tulisan (keyakinan ${Math.round(extracted.confidence ?? 0)}%). ` +
          `Mohon periksa angkanya — OCR kadang salah baca digit.`,
        );
      }
      if (extracted.truncatedPages > 0) {
        notes.push(`${extracted.truncatedPages} halaman terakhir tidak ikut dibaca karena batas ukuran.`);
      }

      res.status(201).json({
        success: true,
        message: `"${originalName}" berhasil dibaca dan disimpan. Bot mempelajarinya dalam beberapa detik.`,
        data: {
          path: relPath,
          characters: extracted.text.length,
          pages: extracted.pages,
          usedOcr: extracted.usedOcr,
          confidence: extracted.confidence,
          supported: SUPPORTED_EXTENSIONS,
          notes,
        },
      });
    } catch (err) { next(err); }
  },
);

export default router;
