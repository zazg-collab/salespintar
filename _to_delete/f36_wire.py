import sys, io, os, json, re

ROOT = None
for base in os.listdir('/sessions'):
    p = f'/sessions/{base}/mnt/projek-ceo/salespintar_repo'
    if os.path.isdir(p):
        ROOT = p
        break
assert ROOT, 'repo not found'

# ══ 1. package.json — dependensi baru ════════════════════════════════════════
pkg_path = os.path.join(ROOT, 'backend/package.json')
pkg = json.load(io.open(pkg_path, encoding='utf-8'))
deps = pkg['dependencies']
added = []
for name, ver in [('pdfjs-dist', '^4.10.38'), ('mammoth', '^1.12.0'), ('tesseract.js', '^7.0.0')]:
    if name not in deps:
        deps[name] = ver
        added.append(f'{name}@{ver}')
# CATATAN: @napi-rs/canvas SENGAJA TIDAK dipasang terpisah. pdfjs-dist sudah
# membawanya sendiri, dan memuat dua salinan modul native yang sama menyebabkan
# kerusakan memori (`free(): invalid pointer`) yang mematikan seluruh proses.
pkg['dependencies'] = dict(sorted(deps.items()))
io.open(pkg_path, 'w', encoding='utf-8').write(json.dumps(pkg, indent=2, ensure_ascii=False) + '\n')
print('OK   package.json  +' + ' +'.join(added) if added else 'OK   package.json (sudah lengkap)')


# ══ 2. sync.routes.ts — endpoint unggah berkas ══════════════════════════════
sr = os.path.join(ROOT, 'backend/src/routes/sync.routes.ts')
s = io.open(sr, encoding='utf-8').read()

assert 'upload-file' not in s, 'endpoint sudah ada'

# import
anchor_imports = "import { Router, Request, Response, NextFunction } from 'express';"
assert s.count(anchor_imports) == 1, 'anchor import express tidak unik'
s = s.replace(anchor_imports, anchor_imports +
    "\nimport multer from 'multer';" +
    "\nimport { extractDocument, SUPPORTED_EXTENSIONS } from '../services/document-extract.service';")

endpoint = '''
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
      const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
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
      ].join('\\n');

      const body = `# ${title}\\n\\n${extracted.text}\\n`;
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

export default router;'''

assert s.count('export default router;') == 1, 'export default tidak unik'
s = s.replace('export default router;', endpoint.lstrip('\n'))
io.open(sr, 'w', encoding='utf-8').write(s)
print('OK   sync.routes.ts (+POST /vault/upload-file)')
print('SELESAI')
