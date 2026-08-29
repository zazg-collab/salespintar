import sys, io, os, re

ROOT = None
for base in os.listdir('/sessions'):
    p = f'/sessions/{base}/mnt/projek-ceo/salespintar_repo'
    if os.path.isdir(p):
        ROOT = p
        break
assert ROOT, 'repo not found'

KS = os.path.join(ROOT, 'backend/src/services/knowledge.service.ts')
src = io.open(KS, encoding='utf-8').read()

# ── addKnowledge: dari tanda tangan sampai penutupnya ────────────────────────
pat_add = re.compile(
    r'  async addKnowledge\(businessId: string, title: string, content: string\) \{.*?'
    r'logger\.info\(`Knowledge added for business \$\{businessId\}`\);\n  \}',
    re.DOTALL,
)
new_add = '''  /**
   * Tambah pengetahuan baru.
   *
   * ── Kenapa ini menulis FILE, bukan baris database ──────────────────────────
   * Versi sebelumnya menyisipkan langsung ke tabel `knowledge` tanpa membuat
   * file apa pun di vault, sehingga `source_file` kosong. Barisnya jadi hantu:
   * tidak terlihat di Obsidian, tidak pernah ikut ter-update saat resync, dan
   * tidak bisa disunting maupun dihapus lewat menu Pengetahuan — sebab seluruh
   * tampilan itu bekerja di atas file, bukan di atas baris database.
   *
   * Obsidian adalah sumber kebenaran; database cuma salinan cepat. Menulis
   * langsung ke salinan berarti membuat kebenaran versi kedua yang tidak ada
   * yang memeliharanya.
   *
   * Sekarang: tulis `.md` ke vault, lalu pengawas folder yang menyerapnya
   * (di bawah 5 detik). Jalurnya jadi sama persis dengan menu Pengetahuan.
   */
  async addKnowledge(
    businessId: string,
    title: string,
    content: string,
    category: 'Produk' | 'SOP' | 'FAQ' = 'FAQ',
  ): Promise<{ vaultPath: string }> {
    const vaultRoot = env.OBSIDIAN_CS_PATH;
    if (!vaultRoot) {
      throw new Error('OBSIDIAN_CS_PATH belum diatur — pengetahuan tidak bisa disimpan.');
    }

    const slug = title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 60) || 'pengetahuan';
    const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const filename = `${dateStr}-${slug}.md`;

    const frontmatter = [
      '---',
      `title: "${title.replace(/"/g, "'")}"`,
      `category: ${category}`,
      'source: manual',
      'authored_by: owner',
      `created: ${new Date().toISOString()}`,
      'status: active',
      '---',
      '',
    ].join('\\n');

    const absPath = path.join(vaultRoot, category, filename);
    await fs.mkdir(path.dirname(absPath), { recursive: true });
    await fs.writeFile(absPath, frontmatter + content, 'utf-8');

    logger.info(`Knowledge ditulis ke vault: ${category}/${filename} (business ${businessId})`);
    return { vaultPath: `${category}/${filename}` };
  }'''

n = len(pat_add.findall(src))
assert n == 1, f'addKnowledge ditemukan {n}x'
src = pat_add.sub(lambda m: new_add, src, count=1)
print('OK   addKnowledge')

# ── deleteKnowledge ─────────────────────────────────────────────────────────
pat_del = re.compile(
    r'  async deleteKnowledge\(id: string, businessId: string\) \{.*?\n  \}',
    re.DOTALL,
)
new_del = '''  /**
   * Hapus pengetahuan.
   *
   * Kalau barisnya berasal dari file vault, FILE-nya yang dihapus — bukan cuma
   * barisnya. Menghapus baris saja adalah kebohongan: file-nya masih ada, dan
   * pengawas folder akan memasukkannya kembali pada perubahan berikutnya. Dari
   * sisi pengguna, pengetahuan yang "sudah dihapus" hidup lagi tanpa sebab.
   */
  async deleteKnowledge(id: string, businessId: string) {
    const row = await prisma.knowledge.findFirst({
      where: { id, businessId },
      select: { id: true, sourceFile: true },
    });
    if (!row) return;

    if (row.sourceFile) {
      // Pastikan file-nya benar-benar di dalam vault sebelum disentuh.
      const vaultRoot = path.resolve(env.OBSIDIAN_CS_PATH || '');
      const target = path.resolve(row.sourceFile);
      if (vaultRoot && target.startsWith(vaultRoot + path.sep)) {
        await fs.unlink(target).catch(err => {
          logger.warn(`Gagal menghapus file vault ${target}: ${err}`);
        });
      }
    }

    await prisma.knowledge.deleteMany({ where: { id, businessId } });
  }'''
n = len(pat_del.findall(src))
assert n == 1, f'deleteKnowledge ditemukan {n}x'
src = pat_del.sub(lambda m: new_del, src, count=1)
print('OK   deleteKnowledge')

# ── import fs & path ────────────────────────────────────────────────────────
if "import fs from 'fs/promises';" not in src:
    a = "import { logger } from '../utils/logger';"
    assert src.count(a) == 1
    src = src.replace(a, a + "\nimport fs from 'fs/promises';\nimport path from 'path';")
    print('OK   import fs/path')

io.open(KS, 'w', encoding='utf-8').write(src)

# ══ routes ══════════════════════════════════════════════════════════════════
KR = os.path.join(ROOT, 'backend/src/routes/knowledge.routes.ts')
r = io.open(KR, encoding='utf-8').read()

old_schema = """const createKnowledgeSchema = z.object({
  title: z.string().min(1),
  content: z.string().min(10),
});"""
assert r.count(old_schema) == 1, 'schema tidak ketemu'
r = r.replace(old_schema, """const createKnowledgeSchema = z.object({
  title: z.string().min(1),
  content: z.string().min(10),
  category: z.enum(['Produk', 'SOP', 'FAQ']).default('FAQ'),
});""")

old_call = """    await knowledgeService.addKnowledge(req.user!.businessId, result.data.title, result.data.content as string);
    res.status(201).json({ message: 'Knowledge added successfully' });"""
assert r.count(old_call) == 1, 'pemanggilan addKnowledge tidak ketemu'
r = r.replace(old_call, """    const { vaultPath } = await knowledgeService.addKnowledge(
      req.user!.businessId,
      result.data.title,
      result.data.content as string,
      result.data.category,
    );
    res.status(201).json({
      message: 'Pengetahuan ditulis ke vault Obsidian. Bot mempelajarinya dalam beberapa detik.',
      data: { vaultPath },
    });""")
io.open(KR, 'w', encoding='utf-8').write(r)
print('OK   knowledge.routes.ts')

# ══ fullResync: buang baris yatim ═══════════════════════════════════════════
OW = os.path.join(ROOT, 'backend/src/services/obsidian-watcher.service.ts')
w = io.open(OW, encoding='utf-8').read()
anchor = """    this.stats.lastSyncAt = new Date();
    logger.info(`[ObsidianWatcher] Full resync selesai:"""
assert w.count(anchor) == 1, 'anchor resync tidak ketemu'
w = w.replace(anchor, """    // ── Buang baris yatim ────────────────────────────────────────────────────
    // Sebelumnya resync hanya MENAMBAH dan MEMPERBARUI, tidak pernah membuang.
    // Akibatnya dua jenis sampah menumpuk selamanya: baris tanpa `source_file`
    // (pengetahuan yang dulu disisipkan langsung ke database), dan baris yang
    // file-nya sudah dihapus saat server kebetulan mati sehingga pengawas tidak
    // sempat melihatnya. Dua-duanya tetap ikut terambil saat bot mencari
    // jawaban — pengetahuan yang sudah "dihapus" masih dipakai menjawab
    // pelanggan, dan tidak ada satu pun layar yang menampilkannya.
    //
    // PENJAGA: kalau tidak ada satu pun file terbaca, JANGAN membuang apa pun.
    // Vault yang belum ter-mount atau path salah ketik akan terlihat persis
    // seperti "semua file sudah dihapus" — pembersihan buta di situ akan
    // memusnahkan seluruh pustaka.
    if (files.length === 0) {
      logger.warn('[ObsidianWatcher] Tidak ada file .md terbaca — pembersihan baris yatim DILEWATI demi keamanan');
    } else {
      const alive = new Set(files);
      const rows = await prisma.knowledge.findMany({
        where: { businessId },
        select: { id: true, sourceFile: true, title: true },
      });
      const orphans = rows.filter(r => !r.sourceFile || !alive.has(r.sourceFile));
      if (orphans.length > 0) {
        await prisma.knowledge.deleteMany({ where: { id: { in: orphans.map(o => o.id) } } });
        logger.warn(
          `[ObsidianWatcher] ${orphans.length} baris yatim dibuang: ` +
          orphans.map(o => o.title || '(tanpa judul)').join(', '),
        );
      }
    }

""" + anchor)
io.open(OW, 'w', encoding='utf-8').write(w)
print('OK   obsidian-watcher.service.ts')
print('SELESAI')
