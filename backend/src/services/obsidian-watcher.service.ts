import chokidar, { FSWatcher } from 'chokidar';
import fs from 'fs/promises';
import path from 'path';
import matter from 'gray-matter';
import { prisma } from '../config/prisma';
import { knowledgeService } from './knowledge.service';
import { chunkDocument, buangTranskripSumber } from '../utils/text-chunker';
import { forgetAllAnswers } from './answer-cache.service';
import { logger } from '../utils/logger';
import { env } from '../config/env';

// ──────────────────────────────────────────────────────────────────────────────
// Tipe helper internal
// ──────────────────────────────────────────────────────────────────────────────
interface SyncStats {
  totalSynced: number;
  totalDeleted: number;
  lastSyncAt: Date | null;
  isWatching: boolean;
  vaultPath: string;
}

// ──────────────────────────────────────────────────────────────────────────────
// ObsidianWatcherService
// Memantau folder SalesPintar-CS-Brain 24/7.
// Setiap file .md baru/diubah → embed → upsert ke tabel knowledge.
// File .md dihapus → hapus record dari DB (berdasarkan sourceFile).
// ──────────────────────────────────────────────────────────────────────────────
class ObsidianWatcherService {
  private watcher: FSWatcher | null = null;
  private debounceMap: Map<string, NodeJS.Timeout> = new Map();
  private stats: SyncStats = {
    totalSynced: 0,
    totalDeleted: 0,
    lastSyncAt: null,
    isWatching: false,
    vaultPath: '',
  };

  // ─── Public API ─────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    const vaultPath = env.OBSIDIAN_CS_PATH;
    if (!vaultPath) {
      logger.warn('[ObsidianWatcher] OBSIDIAN_CS_PATH tidak diset di .env — watcher tidak diaktifkan');
      return;
    }

    this.stats.vaultPath = vaultPath;

    // Pastikan folder vault ada
    try {
      await fs.access(vaultPath);
    } catch {
      logger.warn(`[ObsidianWatcher] Folder vault tidak ditemukan: ${vaultPath} — watcher tidak diaktifkan`);
      return;
    }

    logger.info(`[ObsidianWatcher] Memantau vault: ${vaultPath}`);

    // ── Folder, BUKAN pola glob — Fase 76 ────────────────────────────────────
    // Dulu di sini `chokidar.watch(path.join(vaultPath, '**/*.md'))`. **Chokidar
    // membuang dukungan glob di v4**, dan project ini memakai v5. Akibatnya
    // chokidar memperlakukan `/vault/cs-brain/**/*.md` sebagai NAMA BERKAS
    // harfiah, tidak menemukannya, lalu memancarkan `ready` seketika — nol
    // peristiwa, tanpa satu pun galat.
    //
    // Jadi pengawas ini **tidak pernah bekerja sekali pun** sejak chokidar naik
    // ke v4+. Yang menyesatkan: log tetap menulis "Memantau vault" lalu "Initial
    // scan selesai", dan layar Pengetahuan tetap menyala "Live" — persis bentuk
    // kegagalan yang paling mahal di project ini, **keadaan rusak dan keadaan
    // sehat memberi sinyal yang sama**. Yang menutupinya selama ini: tombol Sync
    // memakai `globMarkdownFiles()` buatan sendiri, bukan chokidar, jadi
    // pengetahuan tetap masuk — dan tidak ada yang sadar jalur otomatisnya mati.
    //
    // Dibuktikan di dalam container:
    //   watch('/vault/cs-brain/**/*.md') → 0 peristiwa add
    //   watch('/vault/cs-brain')         → 31 peristiwa add
    //
    // `ignored` juga wajib berupa FUNGSI di v4+; string pola seperti
    // `'**/Draft_AI/**'` dicocokkan harfiah dan tidak akan pernah cocok.
    this.watcher = chokidar.watch(vaultPath, {
      ignored: (uji: string) => {
        const nama = path.basename(uji);
        if (nama.startsWith('.')) return true;              // berkas/folder tersembunyi
        if (uji.split(path.sep).includes('Draft_AI')) return true; // draft belum disetujui
        return false;
      },
      persistent: true,
      ignoreInitial: false, // sync semua file saat server pertama kali start
      awaitWriteFinish: {
        stabilityThreshold: 500,
        pollInterval: 100,
      },
    });

    // Penyaringan `.md` pindah ke sini, sebab yang diawasi sekarang seluruh
    // folder. Folder ikut dilaporkan chokidar, jadi tanpa saringan ini setiap
    // gambar atau berkas lampiran di vault akan ikut diantre untuk di-embed.
    const berkasMd = (p: string) => p.endsWith('.md');

    this.watcher
      .on('add', (filePath) => { if (berkasMd(filePath)) this.scheduleSync(filePath, 'add'); })
      .on('change', (filePath) => { if (berkasMd(filePath)) this.scheduleSync(filePath, 'change'); })
      .on('unlink', (filePath) => { if (berkasMd(filePath)) this.scheduleDelete(filePath); })
      .on('error', (err) => logger.error('[ObsidianWatcher] Watcher error', err))
      .on('ready', () => {
        this.stats.isWatching = true;
        // Jumlahnya DISEBUT. "Initial scan selesai" tanpa angka tidak bisa
        // membedakan "vault kosong" dari "pengawasnya tidak melihat apa pun" —
        // dan ketidakmampuan membedakan itulah yang menyembunyikan cacat ini
        // berbulan-bulan.
        const diawasi = Object.values(this.watcher?.getWatched() ?? {})
          .flat()
          .filter((n) => typeof n === 'string' && n.endsWith('.md')).length;
        logger.info(`[ObsidianWatcher] Initial scan selesai — ${diawasi} berkas .md diawasi`);
        if (diawasi === 0) {
          logger.warn('[ObsidianWatcher] NOL berkas .md diawasi. Vault memang kosong, atau pengawasnya tidak melihat apa pun — periksa OBSIDIAN_CS_PATH.');
        }
      });
  }

  async stop(): Promise<void> {
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
      this.stats.isWatching = false;
      logger.info('[ObsidianWatcher] Watcher dihentikan');
    }
  }

  getStats(): SyncStats {
    return { ...this.stats };
  }

  /**
   * Full resync: scan semua file .md di vault dan upsert ke DB.
   * Dipanggil via POST /api/sync/obsidian untuk manual trigger.
   */
  async fullResync(businessId: string): Promise<{ synced: number; skipped: number; errors: number }> {
    const vaultPath = env.OBSIDIAN_CS_PATH;
    if (!vaultPath) return { synced: 0, skipped: 0, errors: 0 };

    const result = { synced: 0, skipped: 0, errors: 0 };
    const files = await this.globMarkdownFiles(vaultPath);

    for (const filePath of files) {
      // Skip Draft_AI folder
      if (filePath.includes('Draft_AI')) { result.skipped++; continue; }

      try {
        await this.syncFile(filePath, businessId);
        result.synced++;
      } catch (err) {
        logger.error(`[ObsidianWatcher] Error resync file ${filePath}`, err);
        result.errors++;
      }
    }

    // ── Buang baris yatim ────────────────────────────────────────────────────
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
    // PENJAGANYA DULU MENGHITUNG BERKAS YANG SALAH — Fase 76.
    // `files` memuat SELURUH hasil glob termasuk `Draft_AI/`, padahal berkas
    // Draft_AI justru dilewati sync. Di server sesudah pindahan, vault sempat
    // berisi TEPAT SATU berkas dan berkas itu ada di `Draft_AI/`: penjaganya
    // tidak menyala (1 ≠ 0), `alive` cuma berisi satu jalur draft, dan seluruh
    // 10 baris pengetahuan akan dianggap yatim lalu dihapus — hanya karena ada
    // satu draft nyasar. Yang benar dihitung adalah berkas yang MEMANG akan
    // disinkronkan.
    // Predikatnya SENGAJA identik dengan yang dipakai loop di atas
    // (`filePath.includes('Draft_AI')`). Kalau keduanya berbeda sedikit saja,
    // ada berkas yang dilewati sync TAPI dianggap hidup — atau sebaliknya, dan
    // beda kecil itulah bentuk cacat yang sedang diperbaiki di sini.
    const dilewatiSync = (f: string) => f.includes('Draft_AI');
    const layakSync = files.filter((f) => !dilewatiSync(f));
    if (layakSync.length === 0) {
      logger.warn('[ObsidianWatcher] Tidak ada file .md yang layak sync — pembersihan baris yatim DILEWATI demi keamanan');
    } else {
      const alive = new Set(layakSync);
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

    await forgetAllAnswers(businessId);

    this.stats.lastSyncAt = new Date();
    logger.info(`[ObsidianWatcher] Full resync selesai: ${result.synced} synced, ${result.skipped} skipped, ${result.errors} errors`);
    return result;
  }

  // ─── Private Helpers ────────────────────────────────────────────────────────

  /** Debounce sync — hindari proses berulang jika file ditulis cepat */
  private scheduleSync(filePath: string, event: 'add' | 'change'): void {
    const debouncems = env.OBSIDIAN_WATCHER_DEBOUNCE_MS ?? 2000;

    if (this.debounceMap.has(filePath)) {
      clearTimeout(this.debounceMap.get(filePath)!);
    }

    const timer = setTimeout(async () => {
      this.debounceMap.delete(filePath);

      // Draft_AI: skip auto-sync
      if (filePath.includes('Draft_AI')) return;

      try {
        // Untuk watcher global, gunakan semua business — cari defaultnya
        await this.syncFileForAllBusinesses(filePath, event);
      } catch (err) {
        logger.error(`[ObsidianWatcher] Gagal sync file ${filePath}`, err);
      }
    }, debouncems);

    this.debounceMap.set(filePath, timer);
  }

  private scheduleDelete(filePath: string): void {
    const debouncems = env.OBSIDIAN_WATCHER_DEBOUNCE_MS ?? 2000;
    const timer = setTimeout(async () => {
      this.debounceMap.delete(filePath);
      try {
        const deleted = await prisma.knowledge.deleteMany({
          where: { sourceFile: filePath },
        });
        if (deleted.count > 0) {
          this.stats.totalDeleted += deleted.count;
          logger.info(`[ObsidianWatcher] File dihapus dari DB: ${path.basename(filePath)} (${deleted.count} record)`);
        }
      } catch (err) {
        logger.error(`[ObsidianWatcher] Gagal hapus record untuk ${filePath}`, err);
      }
    }, debouncems);
    this.debounceMap.set(`del:${filePath}`, timer);
  }

  /**
   * Sync satu file .md ke semua Business yang aktif.
   * Untuk multi-tenant: tiap business punya knowledge-nya sendiri di vault yang sama.
   * Jika vault dikunci 1:1 dengan business, semua business akan punya copy yang sama.
   */
  private async syncFileForAllBusinesses(filePath: string, event: string): Promise<void> {
    const businesses = await prisma.business.findMany({
      where: { isActive: true },
      select: { id: true },
    });

    if (businesses.length === 0) {
      logger.warn('[ObsidianWatcher] Tidak ada business aktif — skip sync');
      return;
    }

    for (const biz of businesses) {
      await this.syncFile(filePath, biz.id);
    }

    this.stats.totalSynced++;
    this.stats.lastSyncAt = new Date();
    logger.info(`[ObsidianWatcher] [${event}] Synced: ${path.basename(filePath)} → ${businesses.length} business(es)`);
  }

  /**
   * Core sync logic: baca file .md → parse frontmatter → generate embedding → upsert DB
   */
  private async syncFile(filePath: string, businessId: string): Promise<void> {
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
    // ── Transkrip mentah dibuang SEBELUM diindeks ────────────────────────────
    // Dokumen hasil Shadow Mining membawa cuplikan obrolan asli untuk
    // ketertelusuran. Cuplikan itu memuat harga, ongkir, dan estimasi hari apa
    // adanya — persis fakta volatil yang Lapis 2 sudah susah payah TIDAK tulis di
    // ringkasannya. Tanpa pembuangan ini, pengamannya tidak dilanggar tapi
    // DILEWATI: dibuang di pintu depan, masuk lagi lewat pintu belakang.
    // Blok itu tetap ada di berkasnya untuk dibaca manusia.
    const { teks: isiTerindeks, dibuang } = buangTranskripSumber(bodyContent.trim());
    if (dibuang) {
      logger.debug(`[ObsidianWatcher] ${path.basename(filePath)} — blok transkrip sumber tidak diindeks`);
    }

    const chunks = chunkDocument(title, isiTerindeks);
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

  }

  /** Glob semua file .md secara rekursif di dalam folder vault */
  private async globMarkdownFiles(dir: string): Promise<string[]> {
    const results: string[] = [];
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const sub = await this.globMarkdownFiles(fullPath);
        results.push(...sub);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        results.push(fullPath);
      }
    }
    return results;
  }
}

export const obsidianWatcher = new ObsidianWatcherService();
