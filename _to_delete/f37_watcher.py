import sys, io, os, re

ROOT = None
for base in os.listdir('/sessions'):
    p = f'/sessions/{base}/mnt/projek-ceo/salespintar_repo'
    if os.path.isdir(p):
        ROOT = p
        break
assert ROOT, 'repo not found'

OW = os.path.join(ROOT, 'backend/src/services/obsidian-watcher.service.ts')
s = io.open(OW, encoding='utf-8').read()

# ── Ganti seluruh isi syncFile: satu file → banyak potongan ─────────────────
pat = re.compile(
    r'(  private async syncFile\(filePath: string, businessId: string\): Promise<void> \{).*?'
    r'(\n  \}\n)',
    re.DOTALL,
)
m = pat.search(s)
assert m, 'syncFile tidak ketemu'

new_body = '''
    const rawContent = await fs.readFile(filePath, 'utf-8');

    // Parse YAML frontmatter dengan gray-matter
    const { data: frontmatter, content: bodyContent } = matter(rawContent);

    // Tentukan judul: dari frontmatter.title, atau dari nama file
    const title =
      (typeof frontmatter.title === 'string' && frontmatter.title.trim()) ||
      path.basename(filePath, '.md').replace(/-/g, ' ');

    // ── Dipecah jadi potongan ────────────────────────────────────────────────
    // Sebelumnya satu file = SATU vektor, sepanjang apa pun isinya. Untuk
    // catatan pendek itu tidak masalah, tapi katalog 30 halaman jadi satu titik
    // di ruang makna — dan satu titik tidak mungkin mewakili 30 halaman. Yang
    // terjadi: pencarian paling tumpul justru pada dokumen paling berisi.
    //
    // Dokumen pendek tetap menghasilkan satu potongan, jadi tidak ada yang
    // berubah untuk catatan kecil.
    const chunks = chunkDocument(title, bodyContent.trim());
    if (chunks.length === 0) return; // file kosong

    // Baris lama dibuang dulu, baru potongan baru ditulis. Bukan diperbarui satu
    // per satu: jumlah potongan bisa BERKURANG saat file disunting jadi lebih
    // pendek, dan pembaruan per baris akan meninggalkan potongan basi yang tidak
    // ada padanannya lagi di file — pengetahuan hantu yang masih ikut terambil
    // saat bot mencari jawaban.
    await prisma.knowledge.deleteMany({ where: { businessId, sourceFile: filePath } });

    const now = new Date();
    for (const chunk of chunks) {
      // Isi file vault = dokumen yang akan dicari nanti → "passage"
      const embedding = await knowledgeService.getEmbedding(chunk.text, 'passage');
      const vectorString = `[${embedding.join(',')}]`;

      // Judul diberi nomor bagian supaya di daftar pengetahuan kelihatan bahwa
      // beberapa baris berasal dari satu dokumen yang sama.
      const rowTitle = chunk.total > 1 ? `${title} (bagian ${chunk.index + 1}/${chunk.total})` : title;

      await prisma.$executeRawUnsafe(
        `INSERT INTO knowledge (id, business_id, title, content, embedding, source_file, synced_at, created_at, updated_at)
         VALUES (gen_random_uuid(), $1::uuid, $2, $3, $4::vector, $5, $6, $6, $6)`,
        businessId, rowTitle, chunk.text, vectorString, filePath, now,
      );
    }

    // Pustaka berubah → ingatan jawaban tidak boleh dipakai lagi. Kalau tidak,
    // harga yang baru saja diperbarui akan kalah oleh jawaban lama yang
    // tersimpan, dan pengaman anti-ngarang tidak akan menangkapnya sebab yang
    // diperiksa hanya jawaban yang baru dibuat.
    await forgetAllAnswers(businessId);

    if (chunks.length > 1) {
      logger.info(`[ObsidianWatcher] ${path.basename(filePath)} → ${chunks.length} potongan`);
    }
'''

s = s[:m.start(1)] + m.group(1) + new_body + m.group(2) + s[m.end(2):]
print('OK   syncFile diganti (pemecahan potongan)')

# ── import chunker + forgetAllAnswers ──────────────────────────────────────
a = "import { knowledgeService } from './knowledge.service';"
assert s.count(a) == 1, 'anchor import knowledgeService tidak unik'
s = s.replace(a, a +
    "\nimport { chunkDocument } from '../utils/text-chunker';" +
    "\nimport { forgetAllAnswers } from './answer-cache.service';")
print('OK   import chunker + answer-cache')

# ── penghapusan file juga membuang ingatan jawaban ────────────────────────
old_del = "        logger.error(`[ObsidianWatcher] Gagal hapus record untuk ${filePath}`, err);"
assert s.count(old_del) == 1, 'anchor hapus record tidak unik'
s = s.replace(old_del, old_del)  # (tetap) — penambahan dilakukan di blok resync di bawah

io.open(OW, 'w', encoding='utf-8').write(s)

# ── resync penuh juga membuang ingatan ────────────────────────────────────
s = io.open(OW, encoding='utf-8').read()
anchor = "    this.stats.lastSyncAt = new Date();\n    logger.info(`[ObsidianWatcher] Full resync selesai:"
assert s.count(anchor) == 1
s = s.replace(anchor, "    await forgetAllAnswers(businessId);\n\n" + anchor)
io.open(OW, 'w', encoding='utf-8').write(s)
print('OK   resync membuang ingatan jawaban')
print('SELESAI')
