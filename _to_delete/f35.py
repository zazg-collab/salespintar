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


# ══ 1. knowledge.service — tulis ke vault, bukan langsung ke DB ══════════════
patch('backend/src/services/knowledge.service.ts', [
(
"""  async addKnowledge(businessId: string, title: string, content: string) {
    // Generate embedding for the content
    // Dokumen yang disimpan → "passage"
    const embedding = await this.getEmbedding(content, 'passage');

    // Save to database with vector
    // Using parameterized query to safely inject the embedding
    const query = `
      INSERT INTO knowledge (id, business_id, title, content, embedding, created_at, updated_at)
      VALUES (gen_random_uuid(), $1::uuid, $2, $3, $4::vector, NOW(), NOW())
      RETURNING id
    `;

    // Format the array as a vector literal string e.g. '[0.1, 0.2, ...]'
    const vectorString = `[${embedding.join(',')}]`;

    await prisma.$executeRawUnsafe(
      query,
      businessId,
      title,
      content,
      vectorString
    );

    logger.info(`Knowledge added for business ${businessId}`);
  }""",
"""  /**
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
    const vaultPath = env.OBSIDIAN_CS_PATH;
    if (!vaultPath) {
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

    const absPath = path.join(vaultPath, category, filename);
    await fs.mkdir(path.dirname(absPath), { recursive: true });
    await fs.writeFile(absPath, frontmatter + content, 'utf-8');

    logger.info(`Knowledge ditulis ke vault: ${category}/${filename} (business ${businessId})`);
    return { vaultPath: `${category}/${filename}` };
  }"""
),
(
"""  async deleteKnowledge(id: string, businessId: string) {
    await prisma.knowledge.deleteMany({
      where: { id, businessId }
    });
  }""",
"""  /**
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
  }"""
),
])


# ══ 2. knowledge.routes — kategori + pesan yang jujur ════════════════════════
patch('backend/src/routes/knowledge.routes.ts', [
(
"""const createKnowledgeSchema = z.object({
  title: z.string().min(1),
  content: z.string().min(10),
});""",
"""const createKnowledgeSchema = z.object({
  title: z.string().min(1),
  content: z.string().min(10),
  category: z.enum(['Produk', 'SOP', 'FAQ']).default('FAQ'),
});"""
),
(
"""    await knowledgeService.addKnowledge(req.user!.businessId, result.data.title, result.data.content as string);
    res.status(201).json({ message: 'Knowledge added successfully' });""",
"""    const { vaultPath } = await knowledgeService.addKnowledge(
      req.user!.businessId,
      result.data.title,
      result.data.content as string,
      result.data.category,
    );
    res.status(201).json({
      message: 'Pengetahuan ditulis ke vault Obsidian. Bot mempelajarinya dalam beberapa detik.',
      data: { vaultPath },
    });"""
),
])


# ══ 3. fullResync — buang baris yatim ════════════════════════════════════════
patch('backend/src/services/obsidian-watcher.service.ts', [
(
"""    this.stats.lastSyncAt = new Date();
    logger.info(`[ObsidianWatcher] Full resync selesai: ${result.synced} synced, ${result.skipped} skipped, ${result.errors} errors`);
    return result;""",
"""    // ── Buang baris yatim ────────────────────────────────────────────────────
    // Sebelumnya resync hanya MENAMBAH dan MEMPERBARUI, tidak pernah membuang.
    // Akibatnya dua jenis sampah menumpuk selamanya: baris tanpa `source_file`
    // (pengetahuan yang dulu disisipkan langsung ke database), dan baris yang
    // file-nya sudah dihapus saat server kebetulan mati sehingga pengawas tidak
    // sempat melihatnya. Dua-duanya tetap ikut terambil saat bot mencari
    // jawaban — pengetahuan yang sudah "dihapus" masih dipakai menjawab
    // pelanggan, dan tidak ada satu pun layar yang menampilkannya.
    //
    // PENJAGA: kalau tidak ada satu pun file terbaca, JANGAN membuang apa pun.
    // Vault yang belum ter-mount atau path yang salah ketik akan terlihat persis
    // seperti "semua file sudah dihapus" — dan pembersihan buta di situ akan
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

    this.stats.lastSyncAt = new Date();
    logger.info(`[ObsidianWatcher] Full resync selesai: ${result.synced} synced, ${result.skipped} skipped, ${result.errors} errors`);
    return result;"""
),
])

print('SELESAI')
