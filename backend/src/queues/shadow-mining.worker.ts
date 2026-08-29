import { Job } from 'bullmq';
import fs from 'fs/promises';
import path from 'path';
import { prisma } from '../config/prisma';
import { redisCache } from '../config/redis';
import { logger } from '../utils/logger';
import { env } from '../config/env';
import { knowledgeService } from '../services/knowledge.service';
import { hasRiskyPattern } from '../services/supervisor.service';
import { complete } from '../services/llm';
import { LeadProfilerService } from '../modules/leads/lead-profiler.service';
import { toJakartaDateStr } from '../utils/timezone';
import type { ShadowMiningJobData, ShadowMiningResult } from './shadow-mining.queue';
// Penanda blok transkrip — SATU definisi, dipakai juga oleh obsidian-watcher untuk
// membuang blok ini sebelum diindeks (lihat text-chunker.ts).
import { PENANDA_TRANSKRIP, hitungBarisBerisi } from '../utils/text-chunker';

// ──────────────────────────────────────────────────────────────────────────────
// Layer 1: Spam/Value Detector — job 'classify' di llm.ts
// (Judul lama menyebut "Llama 8B"; modelnya sekarang ditentukan env, bukan kode.)
// Output: true = ada knowledge, false = buang
// ──────────────────────────────────────────────────────────────────────────────
/**
 * Buang klaim ketersediaan/stok dari dokumen hasil tambang — Fase 95.
 *
 * Keputusan Angga 1 Agustus 2026: **satu-satunya patokan stok adalah dokumen
 * produk di `Produk/`.** Obrolan tidak pernah jadi dasar.
 *
 * Tanpa saringan ini aturan itu bocor lewat pintu belakang: penambang mengubah
 * obrolan jadi dokumen vault, dan begitu dokumennya disetujui ia BERUBAH STATUS
 * dari "obrolan" menjadi "pengetahuan resmi" — lalu bot mempercayainya, persis
 * seperti yang diperintahkan. Kejadian nyatanya sudah ada:
 * `Draft_AI/20260731-ketersediaannagatarung.md` berbunyi "udah gaada" padahal
 * dokumen produknya aktif Rp199.000.
 *
 * Disaring di KODE, bukan cuma lewat instruksi prompt, karena instruksi prompt
 * tidak pernah 100% — pelajaran yang sama dengan prefiks "AI:" yang baru benar-
 * benar hilang sesudah dibersihkan di kode (Fase 94). Yang ini lebih penting lagi:
 * kegagalannya tidak terlihat saat terjadi, baru muncul berhari-hari kemudian
 * lewat mulut bot ke pelanggan.
 *
 * Sengaja membuang BARISNYA, bukan menolak seluruh dokumen: satu kalimat soal
 * stok tidak membuat sisa dokumennya (harga, ukuran, prosedur) jadi tidak berguna.
 */
const POLA_KLAIM_STOK =
  /(stok|stock|barang|produk|item)?\s*(nya)?\s*(sedang\s+)?(kosong|habis|abis|gada|ga\s*ada|nggak\s*ada|tidak\s*ada|belum\s*ada|ga\s*ready|nggak\s*ready|tidak\s*ready|sold\s*out|out\s+of\s+stock|indent|pre\s*-?\s*order)/i;

export function buangKlaimStok(isi: string): string {
  const baris = isi.split('\n');
  const sisa = baris.filter((b) => !(b.trim() && POLA_KLAIM_STOK.test(b)));
  const dibuang = baris.length - sisa.length;
  if (dibuang > 0) {
    logger.warn(
      `[ShadowMining] ${dibuang} baris klaim stok dibuang dari dokumen hasil tambang — ` +
        `patokan stok hanya dokumen Produk/, bukan obrolan.`,
    );
  }
  return sisa.join('\n').replace(/\n{3,}/g, '\n\n');
}

export interface Layer1Result {
  hasValue: boolean;
  intent: 'GREETING' | 'TANYA_PRODUK' | 'TANYA_HARGA' | 'TANYA_ONGKIR' | 'KOMPLAIN' | 'LAINNYA';
  conversion: 'CLOSING' | 'PENDING' | 'LOST';
}

async function detectKnowledgeValue(
  conversationText: string,
  businessId?: string,
): Promise<Layer1Result> {
  const resp = await complete('gatekeeper', {
    businessId,
    messages: [
      {
        role: 'system',
        content: `Kamu adalah analis percakapan CS penjualan WhatsApp untuk sistem AI.
Tugasmu adalah menganalisis obrolan dan mengembalikan JSON dengan 3 properti:

1. "hasValue": boolean (true/false)
   - true JIKA mengandung info berharga: harga, promo, kebijakan (retur/garansi), spesifikasi, SOP, cara CS bernegosiasi/menangani komplain/keberatan pembeli.
   - false JIKA hanya basa-basi, keluhan tanpa solusi, obrolan tracking resi murni, atau obrolan terpotong tanpa konteks.

2. "intent": string
   - Pilih SATU dari: "GREETING", "TANYA_PRODUK", "TANYA_HARGA", "TANYA_ONGKIR", "KOMPLAIN", "LAINNYA".

3. "conversion": string
   - Pilih SATU dari:
     - "CLOSING" -> HANYA JIKA ada kesepakatan transaksi baru yang jelas:
       * Pembeli menyetujui opsi pembayaran ("COD ya", "Proses COD", "Kirim ke alamat saya", "Oke proses").
       * Pembeli melakukan transfer bank dan/atau melampirkan bukti transfer.
       * CS memberikan konfirmasi bahwa pesanan segera diproses/dikemas.
       * CATATAN: Pelanggan yang HANYA bertanya nomor resi/tracking barang dari pesanan lama BUKAN CLOSING.
     - "LOST" -> Terjadi penolakan, pembatalan, atau drop-off:
       * Pembatalan eksplisit ("Batal", "Gak jadi", "Ngga jadi maaf ya", "Gak usah").
       * Keberatan ongkir/harga yang tidak terselesaikan ("Kemahalan", "Berat di ongkir", "Mahal amat").
       * Penolakan halus / soft-rejection yang mengakhiri chat ("Nanti saya kabari lagi", "Tanya istri/suami dulu ya", "Nanti kalau ada dana/gajian", "Pending dulu ya karena ongkir").
       * CS sudah mengucapkan penutupan/salam perpisahan ("Baik jika berminat hubungi kami lagi ya", "Semoga dimudahkan rezekinya").
     - "PENDING" -> HANYA obrolan eksplorasi produk yang masih aktif berjalan:
       * Pembeli masih aktif bertanya spesifikasi/bahan/katalog.
       * Pembeli baru memberikan nama lokasi dan belum ada penolakan/keberatan mentok.

JANGAN PERNAH menuliskan ketersediaan atau stok (kosong, habis, ready, sold out, indent) ke dalam hasil. Stok bukan pengetahuan yang boleh diambil dari obrolan.

OUTPUT WAJIB JSON murni tanpa markdown: {"hasValue": boolean, "intent": string, "conversion": "CLOSING"|"PENDING"|"LOST"}`,
      },
      { role: 'user', content: `PERCAKAPAN:\n${conversationText}` },
    ],
  });

  try {
    const raw = resp.text || '{}';
    const parsed = JSON.parse(raw) as Layer1Result;
    return {
      hasValue: !!parsed.hasValue,
      intent: parsed.intent || 'LAINNYA',
      conversion: parsed.conversion || 'PENDING',
    };
  } catch (err) {
    logger.warn(`[ShadowMining] Layer 1 parse error: ${err}`);
    return { hasValue: false, intent: 'LAINNYA', conversion: 'PENDING' };
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Layer 2: Knowledge Extractor — model cerdas (Llama 70B)
// Output: dokumen terstruktur siap masuk vault
// ──────────────────────────────────────────────────────────────────────────────
export interface ExtractedKnowledge {
  title: string;
  category: 'Produk' | 'SOP' | 'FAQ';
  type: 'behavior' | 'fact';
  filename: string;
  content: string;
  /**
   * Penanda model yang mengerjakan ekstraksi ini, format `provider:model`
   * (mis. `groq:llama-3.3-70b-versatile`, `google:gemini-3.1-flash-lite`).
   * Diisi dari `LlmResult.provider`/`LlmResult.model` yang dikembalikan
   * `complete('extract', ...)` — BUKAN dari keluaran LLM itu sendiri, supaya
   * tidak bisa dikarang/salah tulis oleh model. Ditulis ke frontmatter vault
   * sebagai `model:` supaya kualitas Groq vs Gemini bisa dibandingkan nanti
   * tanpa perlu rekonstruksi manual lewat `llm_calls` + `mined_at` lagi.
   */
  extractionModel?: string;
}

async function extractKnowledge(
  conversationText: string,
  businessId?: string,
): Promise<ExtractedKnowledge | null> {
  // Job 'extract' — mewarisi GROQ_EXTRACTOR_MODEL kalau LLM_MODEL_EXTRACT kosong,
  // jadi perilakunya sama dengan sebelum lapisan llm.ts ada. Keluarannya panjang
  // (maks 2048 token), jadi di pekerjaan INILAH harga output paling menentukan.
  const resp = await complete('extract', {
    businessId,
    messages: [
      {
        role: 'system',
        content: `Kamu adalah asisten ekstraksi pengetahuan untuk sistem AI Customer Service.
Tugasmu: ubah percakapan CS menjadi dokumen pengetahuan terstruktur dalam format JSON.

ATURAN WAJIB:
1. HAPUS SEMUA DATA PRIBADI: nama pelanggan spesifik, nomor HP, alamat, nomor resi/pesanan
2. Ganti data pribadi dengan placeholder: [NAMA_PELANGGAN], [NO_RESI], [ALAMAT], [NO_HP]
3. Fokus pada informasi UMUM yang bisa dipakai ulang untuk pelanggan lain

ATURAN PALING PENTING — DILARANG MENCANTUMKAN FAKTA YANG BISA BERUBAH:
   Chat ini bisa jadi berumur berbulan-bulan. Apa pun yang diketik CS waktu itu
   BELUM TENTU masih berlaku hari ini. Karena itu, JANGAN PERNAH menuliskan:
   - Harga, nominal, total, ongkir, diskon, atau angka rupiah apa pun
   - Klaim ketersediaan stok ("ready", "tersedia", "masih ada")
   - Janji waktu pengiriman ("besok sampai", "2 hari", "same day")
   - Jaminan atau janji pasti ("kami jamin", "dijamin", "pasti")

4. EKSTRAKSI PERILAKU (BEHAVIOR):
   Jika CS memberikan diskon, negosiasi, atau teknik penawaran, JANGAN ekstrak nominal angkanya. 
   Ekstrak STRATEGI NEGOSIASINYA. (contoh: "CS memberikan urgensi dengan menukar potongan harga menjadi gratis ongkir dengan syarat transfer hari ini").

5. Tulis dalam Bahasa Indonesia profesional dan ramah.
6. WAJIB memuat minimal SATU fakta spesifik ATAU strategi yang benar-benar diucapkan di percakapan.
7. DILARANG menghasilkan anjuran umum seperti "pertimbangkan kebutuhan Anda".
8. TRACEABILITY: Di bagian paling bawah konten Markdown, WAJIB sertakan cuplikan percakapan mentah aslinya di dalam blok quote (> ).

FORMAT JSON OUTPUT WAJIB:
{
  "title": "Judul singkat deskriptif (maks 60 karakter)",
  "category": "FAQ" | "Produk" | "SOP",
  "type": "behavior" | "fact",
  "filename": "nama-file-lowercase-tanpa-spasi",
  "content": "Konten lengkap Markdown di sini..."
}

FORMAT KONTEN MARKDOWN yang diharapkan:
# [Judul]

## Situasi / Pertanyaan
[Deskripsi situasi umum, TANPA data pribadi]

## Jawaban / Solusi / Strategi
[Jawaban atau strategi negosiasi yang diberikan CS]

## Catatan Penting
[Info tambahan yang relevan, jika ada]

---
${PENANDA_TRANSKRIP}
> [Cuplikan percakapan asli CS dan Pembeli]

Panduan category:
- FAQ: Pertanyaan yang sering muncul
- Produk: Info spesifik tentang produk
- SOP: Prosedur operasional, komplain, negosiasi`,
      },
      { role: 'user', content: `PERCAKAPAN CS:\n${conversationText}` },
    ],
  });

  try {
    const raw = resp.text || '{}';
    const parsed = JSON.parse(raw) as ExtractedKnowledge;
    if (!parsed.title || !parsed.content || !parsed.category) return null;

    // Sanitize filename: huruf kecil, hanya alfanumerik dan dash
    parsed.filename = parsed.filename
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
    if (!parsed.filename) parsed.filename = 'pengetahuan-baru';

    parsed.extractionModel = `${resp.provider}:${resp.model}`;

    return parsed;
  } catch (err) {
    logger.warn(`[ShadowMining] Layer 2 JSON parse error: ${err}`);
    return null;
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Layer 3: Anti-Duplikat — cek vector similarity
// Output: true = duplikat (skip), false = baru (lanjut)
// ──────────────────────────────────────────────────────────────────────────────
async function isDuplicate(businessId: string, content: string): Promise<boolean> {
  try {
    // Membandingkan calon dokumen baru dengan dokumen yang sudah tersimpan —
    // dua-duanya "passage", bukan pertanyaan.
    const embedding = await knowledgeService.getEmbedding(content.slice(0, 1000), 'passage'); // truncate for speed
    const vectorString = `[${embedding.join(',')}]`;
    const threshold = env.SHADOW_MINING_SIMILARITY_THRESHOLD;

    const results = await prisma.$queryRawUnsafe<{ similarity: number }[]>(`
      SELECT 1 - (embedding <=> $2::vector) AS similarity
      FROM knowledge
      WHERE business_id = $1::uuid AND embedding IS NOT NULL
      ORDER BY embedding <=> $2::vector
      LIMIT 1
    `, businessId, vectorString);

    if (results.length === 0) return false;
    const sim = Number(results[0].similarity);
    if (sim >= threshold) {
      logger.info(`[ShadowMining] Layer 3: duplicate found (similarity=${sim.toFixed(3)}, threshold=${threshold})`);
    }
    return sim >= threshold;
  } catch (err) {
    logger.warn(`[ShadowMining] Layer 3 similarity check failed (allowing creation): ${err}`);
    return false; // Jika gagal cek, tetap izinkan buat file baru
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Lapis 2.5: karantina — fakta volatil & dokumen hampa
//
// Dua bahaya yang berbeda, dua-duanya berakhir sama: dokumennya TIDAK dihapus,
// cuma dipaksa lewat mata manusia.
//
// Menahan lebih baik daripada menghapus. Kalau angka 150rb dibuang diam-diam,
// tidak ada yang pernah tahu CS mengutip harga lama selama berbulan-bulan. Kalau
// angkanya ditahan dan ditandai, pemilik bisnis melihatnya dan bisa mengoreksi —
// itu temuan bisnis, bukan sekadar kebersihan data.
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Penanda anjuran umum: kalimat yang terdengar seperti pengetahuan tapi tidak
 * mengandung apa pun yang bisa diperiksa benar-salahnya.
 *
 * Ini JARING, bukan perbaikan utamanya. Perbaikan utamanya ada di prompt Layer 2
 * (aturan 5–7), yang melarang ekstraktor menghasilkan kalimat semacam ini sejak
 * awal. Daftar di bawah cuma menangkap yang tetap lolos.
 */
const GENERIC_ADVICE_PATTERNS: RegExp[] = [
  /pertimbangkan(?:\s+\w+){0,3}\s+(?:faktor|kebutuhan|keperluan)/i,
  /pastikan untuk (?:memeriksa|mempertimbangkan|memilih|mengecek)/i,
  /faktor-faktor seperti/i,
  /sesuai (?:dengan )?(?:kebutuhan|keperluan|preferensi)/i,
  /(?:pada umumnya|secara umum)/i,
  /(?:dapat bervariasi|tergantung (?:pada )?kebutuhan)/i,
];

/** Jangkar konkret paling sederhana yang bisa diandalkan: adanya angka. */
const CONCRETE_ANCHOR = /\d/;

export interface DocumentAssessment {
  /** true = tidak boleh auto-approve, sebagus apa pun setelan modenya. */
  forceReview: boolean;
  /** Kode alasan, ikut ditulis ke frontmatter supaya UI bisa menjelaskannya. */
  reasons: string[];
}

export function assessDocument(
  extracted: ExtractedKnowledge,
  mode: 'strict' | 'lenient' = 'strict',
): DocumentAssessment {
  const text = `${extracted.title}\n${extracted.content}`;
  const reasons: string[] = [];

  // (a) Fakta volatil — memakai definisi yang SAMA PERSIS dengan Supervisor,
  //     dengan mode yang sesuai konteks:
  //     - 'strict': untuk knowledge dari percakapan DB / import file WA lama.
  //     - 'lenient': untuk knowledge dari Human Learning (chat CS real-time);
  //       mengurangi false-positive pada kata seperti "ready", "tersedia",
  //       "masih ada" yang lazim dipakai CS dalam konteks non-stok.
  const { patterns } = hasRiskyPattern(text, mode);
  reasons.push(...patterns);

  // (b) Dokumen hampa — tidak ada satu pun angka DAN padat anjuran umum.
  //     Syarat gandanya disengaja: dokumen prosedur yang sah sering tidak
  //     berangka, dan kalimat "sesuai kebutuhan" sesekali muncul di tulisan
  //     yang berisi. Yang berbahaya adalah gabungan keduanya.
  const hedgeHits = GENERIC_ADVICE_PATTERNS.filter(p => p.test(text)).length;
  if (!CONCRETE_ANCHOR.test(extracted.content) && hedgeHits >= 2) {
    reasons.push('minim_fakta');
  }

  return { forceReview: reasons.length > 0, reasons };
}

// ──────────────────────────────────────────────────────────────────────────────
// Write to Vault — tulis .md ke Obsidian CS Brain
// ──────────────────────────────────────────────────────────────────────────────
async function writeToVault(
  businessId: string,
  extracted: ExtractedKnowledge,
  mode: 'auto' | 'draft',
  conversationId: string,
  reviewReasons: string[] = [],
  sourceTag: 'shadow-mining' | 'import' | 'human-learning' = 'shadow-mining',
): Promise<string> {
  const dateStr = toJakartaDateStr().replace(/-/g, '');
  const folder = mode === 'auto' ? extracted.category : 'Draft_AI';
  const dir = path.join(env.OBSIDIAN_CS_PATH, folder);

  await fs.mkdir(dir, { recursive: true });

  // ── Nama yang bentrok TIDAK BOLEH menimpa — Fase 78 ──────────────────────
  // Dulu di sini `${dateStr}-${extracted.filename}.md` langsung di-`writeFile`,
  // tanpa memeriksa apakah berkasnya sudah ada. Namanya diturunkan dari JUDUL,
  // dan judul lahir dari topik — jadi **dua percakapan berbeda tentang topik yang
  // sama di hari yang sama menghasilkan nama yang sama**, dan yang kedua
  // MENGHAPUS yang pertama. Tanpa galat, tanpa log, tanpa satu pun angka yang
  // bergerak: percakapan yang sudah dibayar dengan token Lapis 1 + Lapis 2
  // lenyap begitu saja.
  //
  // Ketahuan 31 Juli 2026 saat mencocokkan "30 buffer terkirim" dengan isi
  // Draft_AI: 20 ekstraksi Lapis 2, cuma 18 berkas.
  //
  // Sekarang: kalau namanya terpakai, tambahkan `-2`, `-3`, … dan CATAT di log.
  // Batas 50 bukan karena 50 itu angka istimewa, tapi supaya kalau suatu hari
  // ada lingkaran yang menghasilkan nama sama terus-menerus, ia berhenti dan
  // berteriak, bukan memenuhi disk dalam diam.
  const dasar = `${dateStr}-${extracted.filename}`;
  const sudahAda = async (p: string) => {
    try { await fs.access(p); return true; } catch { return false; }
  };

  let filename = `${dasar}.md`;
  let absPath = path.join(dir, filename);
  let tabrakan = 0;
  while (await sudahAda(absPath)) {
    tabrakan++;
    if (tabrakan > 50) {
      logger.error(`[ShadowMining] 50 nama bentrok untuk "${dasar}" — dokumen TIDAK ditulis. Ada yang tidak beres di penamaan.`);
      throw new Error(`Terlalu banyak nama bentrok untuk ${dasar}`);
    }
    filename = `${dasar}-${tabrakan + 1}.md`;
    absPath = path.join(dir, filename);
  }
  // Dicatat SEKALI dengan nama final. Memberitahu di tiap putaran akan menyebut
  // nama yang ternyata juga dipakai — log yang berbohong lebih buruk dari diam.
  if (tabrakan > 0) {
    logger.warn(
      `[ShadowMining] "${dasar}.md" sudah terpakai — dokumen ini disimpan sebagai "${filename}" ` +
      `supaya yang lama tidak terhapus (${tabrakan} nama bentrok).`,
    );
  }

  const frontmatter = [
    '---',
    `title: "${extracted.title}"`,
    `category: ${extracted.category}`,
    `type: ${extracted.type || 'fact'}`,
    `source: ${sourceTag}`,
    `business_id: ${businessId}`,
    `conversation_id: ${conversationId}`,
    `mined_at: ${new Date().toISOString()}`,
    ...(extracted.extractionModel ? [`model: ${extracted.extractionModel}`] : []),
    `status: ${mode === 'auto' ? 'active' : 'draft'}`,
    ...(reviewReasons.length ? [`review_reason: ${reviewReasons.join(', ')}`] : []),
    '---',
    '',
  ].join('\n');

  await fs.writeFile(absPath, frontmatter + buangKlaimStok(extracted.content), 'utf-8');
  return `${folder}/${filename}`;
}

// ──────────────────────────────────────────────────────────────────────────────
// Resolusi mode Shadow Mining — Fix C9
// Sumber kebenaran ada di kolom Business.shadowMiningMode. Nilai null berarti
// business itu belum pernah mengubah setelan, jadi kita pakai default dari env.
// ──────────────────────────────────────────────────────────────────────────────
/**
 * Apakah penambangan otomatis (saat percakapan ditandai Selesai) diizinkan.
 *
 * Sebelumnya auto-trigger menyala permanen tanpa cara mematikannya: setiap
 * percakapan yang selesai langsung memakan token Groq. Toggle Auto/Draft yang
 * sudah ada hanya mengatur hasilnya mau ke mana, bukan apakah penambangannya
 * jalan. Kolom ini yang memberi remnya.
 */
export async function isAutoMiningEnabled(businessId: string): Promise<boolean> {
  const business = await prisma.business.findUnique({
    where: { id: businessId },
    select: { shadowMiningAutoTrigger: true },
  });
  return business?.shadowMiningAutoTrigger ?? true;
}

export async function resolveShadowMiningMode(businessId: string): Promise<'auto' | 'draft'> {
  const business = await prisma.business.findUnique({
    where: { id: businessId },
    select: { shadowMiningMode: true },
  });
  const mode = business?.shadowMiningMode ?? env.SHADOW_MINING_MODE;
  return mode === 'auto' ? 'auto' : 'draft';
}

// ──────────────────────────────────────────────────────────────────────────────
// Main Worker Handler
// ──────────────────────────────────────────────────────────────────────────────
export async function handleShadowMining(job: Job<ShadowMiningJobData>): Promise<ShadowMiningResult> {
  const { businessId, triggeredBy } = job.data;

  // ── Tiga sumber bahan tambang ──────────────────────────────────────────
  // Percakapan dari database, transkrip impor ekspor WA, atau buffer chat CS
  // real-time dari Human Learning. Setelah `conversationText` dan `sourceRef`
  // terbentuk, SELURUH pipeline di bawah identik — tiga lapis filter tidak
  // perlu tahu asal bahannya (kecuali mode Lapis 2.5 yang bisa 'lenient').
  let conversationText: string;
  let sourceRef: string;
  let conversationIdForMark: string | null = null;
  // Mode penilaian Lapis 2.5: 'strict' untuk semua sumber kecuali human_learning.
  let assessmentMode: 'strict' | 'lenient' = 'strict';
  // Source tag untuk frontmatter vault.
  let sourceTag: 'shadow-mining' | 'import' | 'human-learning' = 'shadow-mining';

  if (job.data.kind === 'human_learning') {
    // ── Human Learning: chat CS real-time yang sudah di-buffer ──────────────
    // Asal-usul: buffer akumulasi per kontak dari sesi Baileys CS shadow.
    // Tidak punya baris Conversation di DB — perlindungan duplikat via Layer 3.
    sourceRef = job.data.sourceLabel;
    conversationText = job.data.rawTranscript;
    assessmentMode = 'lenient'; // mode STOCK_PATTERN yang lebih longgar
    sourceTag = 'human-learning';
    logger.info(`[ShadowMining] Start job ${job.id} — hl:${sourceRef} (by: ${triggeredBy})`);

    // ── Resilient Standalone Lead Profiling (CRM Module) ────────────
    // Dijalankan untuk SEMUA obrolan (termasuk 1 baris form iklan masuk)
    // agar data CRM tersimpan di Postgres secara andal dan tidak hilang.
    const contactJid = job.data.sourceLabel.split(':contact:')[1] ?? '';
    const bId = job.data.businessId;
    if (contactJid && bId) {
      const csPhone = job.data.sourceLabel.split(':')[1] ?? '';
      LeadProfilerService.processConversation({
        businessId: bId,
        contactJid,
        csPhone,
        csName: job.data.csName,
        rawTranscript: conversationText,
        messageTimestamp: job.data.lastMessageTimestamp ? new Date(job.data.lastMessageTimestamp) : undefined,
      }).catch(err => {
        logger.warn(`[ShadowMining] LeadProfiler persistent fallback warning: ${err.message}`);
      });
    }

    const lineCount = hitungBarisBerisi(conversationText);
    if (lineCount < env.HL_BUFFER_MIN_MESSAGES) {
      logger.info(
        `[ShadowMining] SKIP HL Knowledge Base ${sourceRef}: cuma ${lineCount} baris (min HL: ${env.HL_BUFFER_MIN_MESSAGES}). CRM Leads sudah diamankan.`,
      );
      return { skipped: true, reason: 'too_few_messages', jobId: job.id! };
    }
  } else if (job.data.kind === 'import') {
    sourceRef = job.data.sourceLabel;
    conversationText = job.data.rawTranscript;
    sourceTag = 'import';
    logger.info(`[ShadowMining] Start job ${job.id} — impor:${sourceRef} (by: ${triggeredBy})`);

    // Idempotency lewat `minedAt` tidak berlaku di sini: tidak ada baris
    // Conversation yang bisa ditandai. Perlindungan terhadap duplikat bersandar
    // pada Layer 3 (kemiripan vektor), yang memang dirancang untuk itu.
    const lineCount = conversationText.split('\n').filter(l => l.trim()).length;
    if (lineCount < env.SHADOW_MINING_MIN_MESSAGES) {
      logger.info(`[ShadowMining] SKIP impor ${sourceRef}: cuma ${lineCount} baris (min: ${env.SHADOW_MINING_MIN_MESSAGES})`);
      return { skipped: true, reason: 'too_few_messages', jobId: job.id! };
    }
  } else {
    const conversationId = job.data.conversationId;
    sourceRef = conversationId;
    conversationIdForMark = conversationId;
    logger.info(`[ShadowMining] Start job ${job.id} — conv:${conversationId} (by: ${triggeredBy})`);

    // ── Fix B4: Idempotency check ────────────────────────────────────────────
    // Satu percakapan bisa masuk antrian lebih dari sekali (auto-trigger saat
    // status DONE + trigger manual + trigger batch, plus retry BullMQ). Tanpa
    // penjaga ini, percakapan yang sama diproses berulang: boros token Groq dan
    // berpotensi menumpuk file duplikat di vault. `minedAt` diisi hanya kalau
    // mining benar-benar menghasilkan dokumen.
    const conversation = await prisma.conversation.findFirst({
      where: { id: conversationId, businessId },
      select: { id: true, minedAt: true },
    });

    if (!conversation) {
      logger.warn(`[ShadowMining] SKIP: conversation ${conversationId} tidak ditemukan untuk business ${businessId}`);
      return { skipped: true, reason: 'conversation_not_found', jobId: job.id! };
    }

    if (conversation.minedAt) {
      logger.info(`[ShadowMining] SKIP: conv ${conversationId} sudah pernah di-mine pada ${conversation.minedAt.toISOString()}`);
      return { skipped: true, reason: 'already_mined', jobId: job.id! };
    }

    const messages = await prisma.message.findMany({
      where: { conversationId, businessId },
      orderBy: { createdAt: 'asc' },
      select: { fromRole: true, message: true },
    });

    if (messages.length < env.SHADOW_MINING_MIN_MESSAGES) {
      logger.info(`[ShadowMining] SKIP: only ${messages.length} msgs (min: ${env.SHADOW_MINING_MIN_MESSAGES})`);
      return { skipped: true, reason: 'too_few_messages', jobId: job.id! };
    }

    conversationText = messages
      .map(m => `[${m.fromRole === 'AI' ? 'BOT' : m.fromRole}] ${m.message}`)
      .join('\n');
  }

  await job.updateProgress(15);

  // ── Layer 1: Deteksi nilai ──
  const l1 = await detectKnowledgeValue(conversationText, businessId);
  
  // ── Analitik Human Learning ────────────────────────────────────────────────
  // Raw SQL memang dipilih dengan alasan yang benar: penambahan atomik, aman dari
  // race condition kalau dua buffer diproses beruntun. Yang salah cuma NAMA-nya.
  //
  // ⚠️ DUA CACAT yang diperbaiki 30 Juli 2026 (Fase 64), dan keduanya bisu:
  //
  // 1. Nama tabel & kolom ditulis camelCase ber-tanda-kutip: `"CsHumanLearningSession"`,
  //    `"totalFactsSaved"`. Di Postgres, pengenal DALAM TANDA KUTIP dicocokkan
  //    huruf-per-huruf. Nama sebenarnya `cs_human_learning_sessions` dengan kolom
  //    `total_facts_saved` (lihat @map/@@map di schema.prisma). Jadi statement ini
  //    SELALU melempar `relation ... does not exist` — 100% panggilan, sejak hari
  //    pertama. Prisma memetakan nama HANYA untuk query yang ia bangun sendiri;
  //    raw SQL melewati pemetaan itu sepenuhnya. Itu justru gunanya "raw".
  //
  // 2. Tanpa try/catch, dan ia berada di ANTARA Lapis 1 dan Lapis 2. Jadi setiap
  //    buffer Human Learning yang berhasil sampai ke sini MATI di baris ini —
  //    sebelum Lapis 2 pernah mengekstraksi apa pun. Job gagal, diulang 3x, gagal
  //    lagi. Inilah dinding KEDUA di balik "Fakta disimpan: 0"; dinding pertama
  //    (buffer tidak pernah dikirim) diperbaiki di Fase 63.
  //
  // Sekarang dibungkus try/catch dan SENGAJA fire-and-forget: ini penghitung untuk
  // dashboard, bukan pengetahuan. Angka statistik yang gagal naik tidak pernah
  // boleh menghanguskan penambangan fakta yang sudah dibayar dengan token.
  if (job.data.kind === 'human_learning' && job.data.csSessionId) {
    const sId = job.data.csSessionId;
    const intentKey = l1.intent;
    const todayDateStr = toJakartaDateStr();
    const bId = job.data.businessId;
    const HL_DAILY_TTL = 7 * 24 * 3600;
    const contactJid = job.data.sourceLabel.split(':contact:')[1] ?? '';

    // ── Standalone Lead Profiling (Hermes CRM Module) ────────────
    // Dijalankan lebih awal agar hasil profiling (conversion status, minat produk, scoring)
    // menjadi Single Source of Truth yang sinkron antara CRM Leads & Dashboard CS.
    let effectiveConversion: 'CLOSING' | 'REPEAT_ORDER' | 'PENDING' | 'LOST' = l1.conversion;
    if (contactJid && bId) {
      const csPhone = job.data.sourceLabel.split(':')[1] ?? '';
      try {
        const profile = await LeadProfilerService.processConversation({
          businessId: bId,
          contactJid,
          csPhone,
          csName: job.data.csName,
          rawTranscript: conversationText,
          messageTimestamp: job.data.lastMessageTimestamp ? new Date(job.data.lastMessageTimestamp) : undefined,
        });
        if (profile?.conversion) {
          effectiveConversion = profile.conversion;
        }
      } catch (err) {
        logger.warn(`[ShadowMining] LeadProfiler failed (non-blocking fallback to L1): ${err}`);
      }
    }

    try {
      await prisma.$executeRawUnsafe(
        `UPDATE cs_human_learning_sessions
         SET
           total_facts_saved       = total_facts_saved + $1,
           total_facts_discarded   = total_facts_discarded + $2,
           total_closing_detected  = total_closing_detected + $3,
           total_lost_detected     = total_lost_detected + $4,
           intent_stats = COALESCE(intent_stats, '{}'::jsonb) || jsonb_build_object(
             $5::text, COALESCE((intent_stats->>$5)::int, 0) + 1
           )
         WHERE id = $6::uuid`,
        l1.hasValue ? 1 : 0,                    // $1
        l1.hasValue ? 0 : 1,                    // $2
        (effectiveConversion === 'CLOSING' || effectiveConversion === 'REPEAT_ORDER') ? 1 : 0,    // $3
        effectiveConversion === 'LOST' ? 1 : 0,       // $4
        intentKey,                              // $5
        sId,                                    // $6
      );

      // Catat tren konversi harian (Total Kontak, Closing, Lost, Pending)
      const pairsKey = `hl:cs_daily:${sId}:${todayDateStr}:pairs`;
      await redisCache.incr(pairsKey);
      await redisCache.expire(pairsKey, HL_DAILY_TTL);

      if (l1.hasValue) {
        const k = `hl:cs_daily:${sId}:${todayDateStr}:facts`;
        await redisCache.incr(k);
        await redisCache.expire(k, HL_DAILY_TTL);
      }

      if (bId) {
        const tcKey = `hl:daily:${bId}:${todayDateStr}:total_contacts`;
        await redisCache.incr(tcKey);
        await redisCache.expire(tcKey, HL_DAILY_TTL);
      }

      // ── Status Konversi Idempoten Berbasis Redis SET (Zero Double Counting) ──
      if (contactJid) {
        // Unique buyers (SET)
        const csUniqKey = `hl:cs_uniq:${sId}:${todayDateStr}`;
        await redisCache.sadd(csUniqKey, contactJid);
        await redisCache.expire(csUniqKey, HL_DAILY_TTL);

        if (bId) {
          const bizUniqKey = `hl:biz_uniq:${bId}:${todayDateStr}`;
          await redisCache.sadd(bizUniqKey, contactJid);
          await redisCache.expire(bizUniqKey, HL_DAILY_TTL);
        }

        // Idempotent Status SETs per-CS
        const csClosingSet = `hl:cs_daily:${sId}:${todayDateStr}:set_closing`;
        const csLostSet    = `hl:cs_daily:${sId}:${todayDateStr}:set_lost`;
        const csPendingSet = `hl:cs_daily:${sId}:${todayDateStr}:set_pending`;

        // Idempotent Status SETs Business-wide
        const bizClosingSet = bId ? `hl:daily:${bId}:${todayDateStr}:set_closing` : null;
        const bizLostSet    = bId ? `hl:daily:${bId}:${todayDateStr}:set_lost` : null;
        const bizPendingSet = bId ? `hl:daily:${bId}:${todayDateStr}:set_pending` : null;

        if (effectiveConversion === 'CLOSING' || effectiveConversion === 'REPEAT_ORDER') {
          // Langkah E Fase 27 (Temuan KPI): REPEAT_ORDER sebelumnya jatuh ke cabang
          // "else" (PENDING) di bawah -- salah kategori aktif (bukan cuma tak terhitung),
          // Redis SET closing/pending jadi tidak sinkron dengan status closing sebenarnya.
          // Pindahkan dari Pending/Lost ke Closing
          await Promise.all([
            redisCache.srem(csPendingSet, contactJid),
            redisCache.srem(csLostSet, contactJid),
            redisCache.sadd(csClosingSet, contactJid),
            redisCache.expire(csClosingSet, HL_DAILY_TTL),
            bizClosingSet ? redisCache.srem(bizPendingSet!, contactJid) : null,
            bizClosingSet ? redisCache.srem(bizLostSet!, contactJid) : null,
            bizClosingSet ? redisCache.sadd(bizClosingSet, contactJid) : null,
            bizClosingSet ? redisCache.expire(bizClosingSet, HL_DAILY_TTL) : null,
          ]);
        } else if (effectiveConversion === 'LOST') {
          // Pindahkan dari Pending/Closing ke Lost
          await Promise.all([
            redisCache.srem(csPendingSet, contactJid),
            redisCache.srem(csClosingSet, contactJid),
            redisCache.sadd(csLostSet, contactJid),
            redisCache.expire(csLostSet, HL_DAILY_TTL),
            bizLostSet ? redisCache.srem(bizPendingSet!, contactJid) : null,
            bizLostSet ? redisCache.srem(bizClosingSet!, contactJid) : null,
            bizLostSet ? redisCache.sadd(bizLostSet, contactJid) : null,
            bizLostSet ? redisCache.expire(bizLostSet, HL_DAILY_TTL) : null,
          ]);
        } else {
          // PENDING: Pindahkan dari Lost/Closing ke Pending jika status downgraded/masih follow-up
          await Promise.all([
            redisCache.srem(csClosingSet, contactJid),
            redisCache.srem(csLostSet, contactJid),
            redisCache.sadd(csPendingSet, contactJid),
            redisCache.expire(csPendingSet, HL_DAILY_TTL),
            bizPendingSet ? redisCache.srem(bizClosingSet!, contactJid) : null,
            bizPendingSet ? redisCache.srem(bizLostSet!, contactJid) : null,
            bizPendingSet ? redisCache.sadd(bizPendingSet, contactJid) : null,
            bizPendingSet ? redisCache.expire(bizPendingSet, HL_DAILY_TTL) : null,
          ]);
        }
      }
    } catch (err) {
      // Dicatat WARN, bukan ditelan diam-diam
      logger.warn(`[ShadowMining] Gagal memperbarui analitik sesi HL ${sId}: ${err}`);
    }
  }

  if (!l1.hasValue) {
    logger.info(`[ShadowMining] Layer 1 REJECTED — no knowledge value (Intent: ${l1.intent}, Conv: ${l1.conversion})`);
    return { skipped: true, reason: 'no_knowledge_value', jobId: job.id! };
  }
  logger.info(`[ShadowMining] Layer 1 PASSED (Intent: ${l1.intent}, Conv: ${l1.conversion})`);
  await job.updateProgress(40);

  // ── Layer 2: Ekstraksi ──
  const extracted = await extractKnowledge(conversationText, businessId);
  if (!extracted) {
    logger.warn(`[ShadowMining] Layer 2 FAILED — extraction returned null`);
    return { skipped: true, reason: 'extraction_failed', jobId: job.id! };
  }
  logger.info(`[ShadowMining] Layer 2 PASSED — "${extracted.title}" [${extracted.category}]`);
  await job.updateProgress(70);

  // ── Layer 3: Anti-duplikat ──
  const duplicate = await isDuplicate(businessId, extracted.content);
  if (duplicate) {
    logger.info(`[ShadowMining] Layer 3 REJECTED — duplicate content`);
    return { skipped: true, reason: 'duplicate_content', jobId: job.id! };
  }
  logger.info(`[ShadowMining] Layer 3 PASSED — no duplicate`);
  await job.updateProgress(85);

  // ── Tulis ke Vault ──
  // Fix C9: mode dibaca dari DB (per business), bukan dari objek env yang dulu
  // dimutasi saat runtime. env sekarang hanya jadi default kalau business belum
  // pernah menyetel modenya.
  // ── Lapis 2.5: jaring pengaman ──
  // Sesudah prompt Layer 2 dilarang keras menulis fakta volatil, lapis ini
  // seharusnya JARANG sekali menyala. Dia bukan lagi beban review harian,
  // melainkan penangkap kalau model membandel. Kalau lapis ini sering menyala,
  // itu sinyal prompt-nya yang perlu diperbaiki, bukan Angga yang perlu rajin.
  const assessment = assessDocument(extracted, assessmentMode);
  const resolvedMode = await resolveShadowMiningMode(businessId);
  const mode: 'auto' | 'draft' = assessment.forceReview ? 'draft' : resolvedMode;

  if (assessment.forceReview && resolvedMode === 'auto') {
    logger.info(
      `[ShadowMining] Lapis 2.5 MENAHAN "${extracted.title}" dari mode Otomatis (mode-penilaian: ${assessmentMode}) — ` +
      `alasan: ${assessment.reasons.join(', ')}`,
    );
  }

  const vaultPath = await writeToVault(businessId, extracted, mode, sourceRef, assessment.reasons, sourceTag);
  logger.info(`[ShadowMining] Written to vault: ${vaultPath} (mode: ${mode})`);

  // ── Penghitung dokumen — Fase 78 ─────────────────────────────────────────
  // SENGAJA di sini, sesudah berkasnya ADA di disk. `total_facts_saved` naik jauh
  // di atas (dari vonis Lapis 1), jadi ia ikut menghitung percakapan yang gugur
  // di Lapis 2 atau ditolak Lapis 3 sebagai duplikat. Selisih kedua angka inilah
  // yang dulu tidak terlihat oleh siapa pun: 20 "fakta disimpan" tapi 18 berkas.
  // Fire-and-forget dengan alasan yang sama seperti penghitung di atas: angka
  // dashboard tidak boleh menghanguskan dokumen yang sudah jadi.
  if (job.data.kind === 'human_learning' && job.data.csSessionId) {
    prisma.$executeRawUnsafe(
      `UPDATE cs_human_learning_sessions SET total_docs_written = total_docs_written + 1 WHERE id = $1::uuid`,
      job.data.csSessionId,
    ).catch((e) => logger.warn(`[ShadowMining] Penghitung dokumen gagal naik: ${e?.message ?? e}`));
  }

  // Fix B4: tandai sudah di-mine supaya job berikutnya untuk percakapan ini di-skip.
  // Hanya berlaku untuk percakapan database — transkrip impor tidak punya baris
  // Conversation, dan perlindungan duplikatnya sudah dipegang Layer 3.
  if (conversationIdForMark) {
    await prisma.conversation.update({
      where: { id: conversationIdForMark },
      data: { minedAt: new Date() },
    });
  }

  await job.updateProgress(100);

  return {
    skipped: false,
    vaultPath,
    title: extracted.title,
    category: extracted.category,
    mode,
    jobId: job.id!,
  };
}
