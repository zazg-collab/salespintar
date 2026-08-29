// Migrasi dari @xenova/transformers (sudah tidak dikembangkan) ke penerus
// resminya, @huggingface/transformers. Alasan utamanya keamanan: rantai
// dependensi lama membawa protobufjs dengan kerentanan CRITICAL lewat
// onnx-proto → onnxruntime-web versi usang. API-nya identik — sudah diuji
// langsung: pemanggilan sama, opsi sama, dimensi tetap 384, keluaran tetap
// Float32Array. Model Xenova/* tetap didukung, tidak perlu ganti model.
import { pipeline } from '@huggingface/transformers';
import { prisma } from '../config/prisma';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import { toJakartaDateStr } from '../utils/timezone';
import fs from 'fs/promises';
import path from 'path';

class KnowledgeService {
  private extractor: any = null;
  // Fix audit B8: dulu pakai flag boolean `isInitializing`. Dua pemanggil
  // konkuren bisa sama-sama lolos pengecekan sebelum flag sempat di-set, lalu
  // memuat model embedding dua kali (boros memori & CPU). Sekarang kita simpan
  // PROMISE-nya: pemanggil kedua menunggu promise yang sama, bukan memulai init
  // baru. Promise dibuang kalau gagal supaya percobaan berikutnya tetap bisa jalan.
  private initPromise: Promise<void> | null = null;

  async init(): Promise<void> {
    if (this.extractor) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      // Model diambil dari env supaya bisa diganti tanpa menyentuh kode.
      // Bawaannya kini varian multibahasa: all-MiniLM-L6-v2 dilatih dominan
      // berbahasa Inggris, sehingga mencocokkan pertanyaan bahasa Indonesia
      // dengan dokumen bahasa Indonesia hasilnya pas-pasan. Kalau pencarian
      // mengambil dokumen yang salah, secanggih apa pun model chat-nya jawaban
      // tetap meleset — itu titik terlemah RAG di sistem ini.
      logger.info(`Initializing embedding model: ${env.EMBEDDING_MODEL}...`);
      const { pipeline: getPipeline } = await import('@huggingface/transformers');
      this.extractor = await getPipeline('feature-extraction', env.EMBEDDING_MODEL);
      logger.info('Embedding model initialized successfully');
    })().catch((err) => {
      logger.error('Failed to initialize embedding model', err);
      // Reset supaya init bisa dicoba lagi nanti, bukan gagal permanen.
      this.initPromise = null;
      this.extractor = null;
    });

    return this.initPromise;
  }

  /**
   * Ubah teks jadi vektor.
   *
   * `kind` WAJIB diisi karena model E5 memperlakukan pertanyaan dan dokumen
   * secara berbeda — pertanyaan diberi awalan "query: ", dokumen "passage: ".
   * Ini bukan hiasan: tanpa awalan yang tepat, kualitas pencarian E5 justru
   * jatuh di bawah model biasa. Karena mudah terlupa, parameternya sengaja
   * dibuat wajib supaya setiap pemanggil harus menyatakan maksudnya.
   */
  async getEmbedding(text: string, kind: 'query' | 'passage'): Promise<number[]> {
    if (!this.extractor) await this.init();
    if (!this.extractor) throw new Error('Embedding model not available');

    const input = env.EMBEDDING_USE_E5_PREFIX ? `${kind}: ${text}` : text;
    const output = await this.extractor(input, { pooling: 'mean', normalize: true });
    const vector = Array.from(output.data) as number[];

    // Penjaga: kolom di database bertipe vector(384). Kalau model diganti ke
    // yang dimensinya lain, kegagalannya akan muncul jauh di hilir sebagai
    // error SQL yang membingungkan. Lebih baik berhenti di sini dengan pesan
    // yang menyebut angkanya.
    if (vector.length !== 384) {
      throw new Error(
        `Model embedding "${env.EMBEDDING_MODEL}" menghasilkan ${vector.length} dimensi, ` +
        `sedangkan kolom database bertipe vector(384). Ganti modelnya, atau ubah schema ` +
        `Prisma + buat migrasi untuk dimensi baru lalu embed ulang seluruh vault.`,
      );
    }
    return vector;
  }

  /**
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
    const dateStr = toJakartaDateStr().replace(/-/g, '');
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
    ].join('\n');

    const absPath = path.join(vaultRoot, category, filename);
    await fs.mkdir(path.dirname(absPath), { recursive: true });
    await fs.writeFile(absPath, frontmatter + content, 'utf-8');

    logger.info(`Knowledge ditulis ke vault: ${category}/${filename} (business ${businessId})`);
    return { vaultPath: `${category}/${filename}` };
  }

  async searchRelevantKnowledge(businessId: string, query: string, limit: number = 3): Promise<string[]> {
    try {
      // Pertanyaan pelanggan → "query"
      const embedding = await this.getEmbedding(query, 'query');
      const vectorString = `[${embedding.join(',')}]`;

      // Use cosine distance (<=>) for search
      // Return top matching chunks
      const results = await prisma.$queryRawUnsafe<any[]>(`
        SELECT content, 1 - (embedding <=> $2::vector) as similarity
        FROM knowledge
        WHERE business_id = $1::uuid
        ORDER BY embedding <=> $2::vector
        LIMIT $3
      `, businessId, vectorString, limit);

      // Filter by reasonable similarity threshold (e.g. > 0.3)
      return results
        .filter(r => r.similarity > 0.3)
        .map(r => r.content);
    } catch (err) {
      logger.error(`Error searching knowledge: ${err}`);
      return [];
    }
  }

  async listKnowledge(businessId: string) {
    return prisma.knowledge.findMany({
      where: { businessId },
      select: { id: true, title: true, createdAt: true, updatedAt: true },
      orderBy: { createdAt: 'desc' }
    });
  }

  /**
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
  }
}

export const knowledgeService = new KnowledgeService();
