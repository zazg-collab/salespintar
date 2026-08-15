import { prisma } from '../../config/prisma';
import { complete } from '../../services/llm';
import { logger } from '../../utils/logger';
import { MengantarService } from '../../services/mengantar.service';
import {
  ProcessConversationInput,
  LeadProfileAnalysis,
  ConversionStatus,
  LeadStage,
} from './dto/lead-profile.dto';
import { LeadScoringEngine } from './lead-scoring.engine';
import { LeadsRepository } from './leads.repository';
import { RtsRiskEngine, RtsAnalysisResult } from './rts-risk.engine';
import { SessionBoundaryParser, SegmentedSession, ParsedChatMessage } from './session-parser';

export class LeadProfilerService {
  /**
   * Ekstrak pesan-pesan pembeli dari transkrip terformat [CS]/[LEAD]/[BUYER] atau ParsedChatMessage
   */
  private static extractBuyerMessages(transcript: string, messages?: ParsedChatMessage[]): string[] {
    if (messages && messages.length > 0) {
      return messages.filter((m) => m.senderRole === 'BUYER').map((m) => m.text);
    }
    const lines = transcript.split('\n');
    return lines
      .filter((line) => line.startsWith('[LEAD]') || line.startsWith('[BUYER]'))
      .map((line) => line.replace(/^\[(LEAD|BUYER)\]\s*/, '').trim());
  }

  /**
   * Pembersih nama produk dari tag iklan (Fb/Google/Tiktok), prefix toko, atau emoji
   */
  public static cleanProductName(raw: string): string {
    if (!raw) return '';
    let cleaned = raw
      // Buang emoji Unicode
      .replace(/[\u{1F300}-\u{1FAFF}]/gu, '')
      // Buang prefix ARF | / ARF -
      .replace(/^\s*ARF\s*[/|\-]?\s*/i, '')
      // Buang tag iklan seperti - Fb - NPM, - Goo2 - NPM, - Fb - Ad, - Fb, - Tiktok, dll
      .replace(/\s*-\s*(Fb|Goo\d*|Google|Tiktok|Ig|Ads|NPM|NFR|Ad)\b.*/i, '')
      // Buang tanda strip sisa di ujung
      .replace(/\s*-\s*$/, '')
      // Buang label 'Produk:' di awal
      .replace(/^(?:📦\s*)?Produk\s*:\s*/i, '')
      // Buang nama brand toko Cordova
    return cleaned;
  }

  private static readonly KNOWN_SKUS = [
    { pattern: /golok\s+situmang\s+3|situmang\s+3/i, name: 'Golok Situmang 3' },
    { pattern: /golok\s+situmang\s+2|situmang\s+2/i, name: 'Golok Situmang 2' },
    { pattern: /golok\s+situmang|situmang/i, name: 'Golok Situmang 2' },
    { pattern: /gke\s+40\s+perak\s+duralium\s+2|perak\s+duralium\s+2/i, name: 'GKE 40 Perak Duralium 2' },
    { pattern: /gke\s+40\s+perak\s+duralium|perak\s+duralium/i, name: 'GKE 40 Perak Duralium' },
    { pattern: /golok\s+kebun\s+ekonomis\s+30|gke\s+30/i, name: 'Golok Kebun Ekonomis 30' },
    { pattern: /golok\s+kebun\s+ekonomis|gke\b/i, name: 'Golok Kebun Ekonomis 30' },
    { pattern: /black\s+mamba/i, name: 'Golok Black Mamba' },
    { pattern: /bedog\s+betekok|betekok/i, name: 'Bedog Betekok' },
    { pattern: /sembelih\s+multifungsi/i, name: 'Golok Sembelih Multifungsi' },
    { pattern: /tarisi/i, name: 'Golok Tarisi' },
    { pattern: /pisau\s+sembelih/i, name: 'Pisau Sembelih' },
    { pattern: /pisau\s+seset|skinning/i, name: 'Pisau Seset' },
    { pattern: /batu\s+asahan|asahan/i, name: 'Batu Asahan' },
  ];

  public static matchKnownSku(text: string): string | null {
    if (!text) return null;
    for (const sku of this.KNOWN_SKUS) {
      if (sku.pattern.test(text)) {
        return sku.name;
      }
    }
    return null;
  }

  /**
   * Ekstraksi Deterministik Berbasis Peran (Role-Aware Extractor).
   * Mengambil template form resmi '📦 Produk:' yang dikirim oleh CS di sesi aktif atau pencocokan SKU katalog.
   */
  public static extractRoleAwareProduct(session: SegmentedSession): {
    csProduct: string | null;
    inboundProduct: string | null;
    rincianSummary: string | null;
  } {
    let csProduct: string | null = null;
    let rincianSummary: string | null = null;
    const inboundProduct = session.inboundProductCandidate
      ? this.cleanProductName(session.inboundProductCandidate)
      : null;

    // Scan seluruh pesan di sesi aktif
    for (const msg of session.messages) {
      // Pola Form CS 1: 📦 Produk: <nama>
      const m1 = msg.text.match(/(?:📦\s*)?Produk\s*:\s*([^\n\r💰]+)/i);
      if (m1 && m1[1]) {
        const cleaned = this.cleanProductName(m1[1]);
        if (cleaned && cleaned.length >= 2) {
          csProduct = cleaned;
        }
      }

      // Pola Form CS 2: form pemesanan <nama> di toko kami
      const m2 = msg.text.match(/form\s+pemesanan\s+([^\n\r!]+?)\s+di\s+toko\s+kami/i);
      if (m2 && m2[1]) {
        const cleaned = this.cleanProductName(m2[1]);
        if (cleaned && cleaned.length >= 2) {
          csProduct = cleaned;
        }
      }

      // Pola Form CS 3: Terima kasih sudah mengisi form pemesanan <nama>
      const m3 = msg.text.match(/Terima\s+kasih\s+sudah\s+mengisi\s+form\s+pemesanan\s+([^\n\r!]+)/i);
      if (m3 && m3[1]) {
        const cleaned = this.cleanProductName(m3[1]);
        if (cleaned && cleaned.length >= 2) {
          csProduct = cleaned;
        }
      }

      // Cek Rincian Biaya
      if (/RINCIAN\s+BIAYA|TOTAL\s+COD/i.test(msg.text)) {
        const totalMatch = msg.text.match(/TOTAL\s+COD\s*:\s*([\d\.\,kK]+)/i);
        const hargaMatch = msg.text.match(/Harga\s*:\s*([\d\.\,kK]+)/i);
        rincianSummary = `Harga: ${hargaMatch ? hargaMatch[1] : '-'}, Total COD: ${totalMatch ? totalMatch[1] : '-'}`;
      }
    }

    // Jika belum ketemu dari form, scan known SKU dari teks percakapan
    if (!csProduct) {
      csProduct = this.matchKnownSku(session.rawTranscript);
    }

    return { csProduct, inboundProduct, rincianSummary };
  }

  /**
   * Ekstraksi Deterministik Nama Produk fallback jika tidak melalui SegmentedSession.
   */
  public static extractDeterministicProduct(transcript: string): string | null {
    if (!transcript) return null;
    const sessionRes = SessionBoundaryParser.segmentSessions(transcript);
    const extracted = this.extractRoleAwareProduct(sessionRes.activeSession);
    return extracted.csProduct || extracted.inboundProduct || this.matchKnownSku(transcript) || null;
  }

  /**
   * Proses percakapan WhatsApp untuk membentuk profil & insight prospek.
   * Menggunakan 4-Stage Lead Profiler & CRM Intelligence Pipeline.
   */
  static async processConversation(input: ProcessConversationInput): Promise<LeadProfileAnalysis | null> {
    const { businessId, contactJid, csPhone, csName, rawTranscript } = input;

    if (!rawTranscript || !rawTranscript.trim()) {
      return null;
    }

    const sanitizedContactPhone = LeadsRepository.sanitizeWaNumber(contactJid);

    // ── STAGE 0: Internal CS / Registered CS Exclusion Filter ──────────────────
    try {
      const isRegisteredCs = await prisma.csHumanLearningSession.findFirst({
        where: {
          businessId,
          csPhone: sanitizedContactPhone,
        },
      });
      if (isRegisteredCs) {
        logger.info(`[LeadProfiler] Kontak ${contactJid} adalah nomor CS terdaftar. Melewati riwayat CRM.`);
        await prisma.lead.deleteMany({
          where: { businessId, waNumber: sanitizedContactPhone },
        });
        return null;
      }
    } catch (csCheckErr) {
      logger.warn(`[LeadProfiler] Gagal verifikasi registered CS: ${csCheckErr}`);
    }

    // ── STAGE 1: Session Boundary & Role Normalizer ───────────────────────────
    const sessionResult = SessionBoundaryParser.segmentSessions(rawTranscript);
    const activeSession = sessionResult.activeSession;
    const isRepeatOrder = sessionResult.isRepeatOrder;

    // ── STAGE 2: Role-Aware Template & Entity Extractor ───────────────────────
    const { csProduct, inboundProduct, rincianSummary } = this.extractRoleAwareProduct(activeSession);
    const buyerMessages = this.extractBuyerMessages(activeSession.rawTranscript, activeSession.messages);
    const buyingSignals = LeadScoringEngine.detectBuyingSignals(buyerMessages);

    // Ambil data lead yang sudah tercatat sebelumnya di database (jika ada)
    let existingValidProduct: string | null = null;
    try {
      const existingLead = await prisma.lead.findFirst({
        where: {
          businessId,
          waNumber: sanitizedContactPhone,
        },
        select: { minatProduk: true },
      });
      if (
        existingLead?.minatProduk &&
        !['umum', 'tidak ada', 'tidak ada informasi produk', 'tidak diketahui', 'belum spesifik', 'umum (internal cs)'].includes(
          existingLead.minatProduk.toLowerCase().trim(),
        )
      ) {
        existingValidProduct = existingLead.minatProduk;
      }
    } catch (dbReadErr) {
      logger.warn(`[LeadProfiler] Gagal membaca existing lead product: ${dbReadErr}`);
    }

    // Fallback harga ke SKU
    let priceInferredProduct: string | null = null;
    if (rincianSummary) {
      if (/24[0-9]\.?000|25[0-9]\.?000/i.test(rincianSummary)) priceInferredProduct = 'Golok Situmang 2';
      else if (/16[0-9]\.?000|17[0-9]\.?000/i.test(rincianSummary)) priceInferredProduct = 'Bedog Betekok';
      else if (/18[0-9]\.?000|19[0-9]\.?000/i.test(rincianSummary)) priceInferredProduct = 'Golok Kebun Ekonomis 30';
    }

    // Fallback awal produk
    const anchorProduct =
      csProduct ||
      inboundProduct ||
      existingValidProduct ||
      priceInferredProduct ||
      this.matchKnownSku(rawTranscript) ||
      null;

    // ── STAGE 2.5: Klasifikasi Kategori Lead (NEW_INBOUND vs AFTER_SALES) ─────
    const fullTranscriptText = activeSession.rawTranscript;
    
    // Pola Formulir Landing Page Resmi (cdv.form.id / app.formulir.com / OrderOnline)
    const hasOrderFormSignature =
      /Terima kasih sudah mengisi form pemesanan|Formulir Pemesanan|form pemesanan|Halo,\s*saya\s*sudah\s*melakukan\s*pemesanan|saya sudah melakukan pemesanan|📦\s*Produk:|💰\s*Harga:|Total\s*COD|RINCIAN\s+BIAYA/i.test(
        fullTranscriptText,
      );

    const hasExplicitBuyingInquiry =
      /mau\s+(?:pesan|order|beli)|harga\s+berapa|bisa\s+cod|ongkir\s+ke\s+[a-z]+|ready\s+(?:gak|kak)|cara\s+pesan/i.test(
        fullTranscriptText,
      );

    const isAfterSalesOrGeneralQuery =
      /dah\s+yampek|sampai\s+mana|mana\s+paket|resi\b|no\s+resi|nomor\s+resi|status\s+pengiriman|kapan\s+dikirim|kok\s+belum\s+sampai|komplain|barang\s+rusak|retur\b|garansi/i.test(
        fullTranscriptText,
      );

    let leadCategory: 'NEW_INBOUND' | 'AFTER_SALES' = 'AFTER_SALES';
    
    // HANYA beri status NEW_INBOUND jika benar-benar ada tanda form landing page atau tanya beli produk nyata
    if (hasOrderFormSignature || (hasExplicitBuyingInquiry && !isAfterSalesOrGeneralQuery)) {
      leadCategory = 'NEW_INBOUND';
    } else {
      leadCategory = 'AFTER_SALES';
    }

    // ── STAGE 3: Deal State Machine & Semantic LLM Reasoner ───────────────────
    let minatProduk = anchorProduct;
    let lastInsight = isRepeatOrder
      ? `Pelanggan lama (Repeat Order) memulai transaksi baru.`
      : 'Percakapan baru dimulai.';
    let conversion: ConversionStatus = 'PENDING';
    let llmScore = 0;
    let llmReasons: string[] = [];

    const structuredContext = [
      `PRODUK RESMI DARI FORM CS: "${csProduct || 'Tidak ada template form CS'}"`,
      `PRODUK DARI LINK IKLAN PEMBELI: "${inboundProduct || 'Bukan via link form iklan'}"`,
      `PRODUK TERCATAT SEBELUMNYA DI CRM: "${existingValidProduct || 'Belum ada'}"`,
      `RINCIAN BIAYA RESMI CS: "${rincianSummary || 'Belum ada rincian biaya'}"`,
      `PRODUK HASIL DEDUKSI SISTEM: "${anchorProduct}"`,
      `STATUS PELANGGAN: ${isRepeatOrder ? `Repeat Buyer (${sessionResult.totalSessions} sesi transaksi tercatat)` : 'Pelanggan Baru'}`,
    ].join('\n');

    let isInternalTeamChat = false;

    try {
      const resp = await complete('classify', {
        businessId,
        messages: [
          {
            role: 'system',
            content: `Kamu adalah Lead Profiler & CRM AI Specialist untuk toko Jawara Pisau / Cordova Store (spesialis pisau sembelih, golok tebas, bedog, dan alat bilah baja).
Tugasmu: Analisa percakapan WhatsApp sesi aktif berikut secara presisi, lalu ekstrak profil transaksi dalam format JSON murni.

INFORMASI TERVALIDASI SISTEM:
${structuredContext}

KATALOG PRODUK TOKO:
- Golok Situmang 2 (atau Golok Situmang 3 / Golok Situmang)
- Golok Kebun Ekonomis 30 (GKE 30 / Golok Kebun Ekonomis)
- GKE 40 Perak Duralium 2 (atau GKE 40 Perak Duralium)
- Golok Black Mamba
- Bedog Betekok
- Golok Sembelih Multifungsi
- Pisau Sembelih / Pisau Jagal / Pisau Seset
- Batu Asahan

ATURAN EKSTRAKSI NAMA PRODUK:
1. "minatProduk":
   - WAJIB gunakan salah satu nama model/SKU produk dari katalog di atas.
   - DILARANG KERAS mengembalikan string "Umum", "Tidak ada", "Tidak diketahui", "Hitam", atau "Coklat".
   - Jika pembeli hanya memilih varian warna saat CS bertanya varian atau langsung konfirmasi alamat, WAJIB gunakan nama model dari Form CS atau "${anchorProduct}".
   - Buang tag iklan seperti "- Fb - NPM", "- Goo2 - NPM", "- Fb - Ad".

2. "leadCategory": "NEW_INBOUND" | "AFTER_SALES"
   - "NEW_INBOUND": Calon pembeli yang mengisi form pemesanan, menanyakan produk/harga/ongkir/COD, atau memesan.
   - "AFTER_SALES": Pelanggan lama yang HANYA menanyakan nomor resi, tracking paket ("Dah yampek mana", "Minta resi"), atau komplain barang rusak.

3. "isInternalTeam": boolean
   - true JIKA percakapan ini murni obrolan internal tim CS (misal: "otw karawang", kirim link rekapan internal).

4. "lastInsight": Ringkasan situasi terkini pembeli dalam 1-2 KALIMAT TAJAM.
   - Jelaskan: repeat/baru, produk yang dipilih, metode bayar (COD/Transfer/Shopee), nominal COD jika ada, lokasi tujuan, dan status terkini.
   - CONTOH: "Pelanggan baru setuju COD Golok Situmang 2 warna hitam total Rp245.000 ke Bengkalis, Riau."

5. "conversion":
   - "CLOSING": Deal disepakati (pembeli sudah transfer, checkout Shopee, atau setuju kirim COD + konfirmasi data alamat).
   - "LOST": Penolakan tegas (batal beli, terlalu mahal, tidak jadi order, dibatalkan).
   - "PENDING": Masih tanya-jawab, belum ada keputusan akhir.

6. "score": Nilai probabilitas beli (0-100).
   - 0-30: Sapaan awal/batal beli (COLD)
   - 31-60: Tanya harga/varian/keberatan ongkir (WARM)
   - 61-80: Tanya rekening/COD/isi form alamat (HOT)
   - 81-100: Deal COD lengkap / transfer sukses (VERY HOT)

7. "reasons": Array 1-3 kata kunci alasan (misal: ["deal COD 245rb", "konfirmasi alamat"]).

FORMAT OUTPUT WAJIB JSON MURNI:
{"isInternalTeam": boolean, "leadCategory": "NEW_INBOUND"|"AFTER_SALES", "minatProduk": string, "lastInsight": string, "conversion": "CLOSING"|"PENDING"|"LOST", "score": number, "reasons": string[]}`,
          },
          {
            role: 'user',
            content: `PERCAKAPAN SESI AKTIF:\n${activeSession.rawTranscript}`,
          },
        ],
      });

      const parsed = JSON.parse(resp.text || '{}');
      if (parsed.isInternalTeam === true) {
        isInternalTeamChat = true;
      }
      if (parsed.leadCategory === 'AFTER_SALES' || parsed.leadCategory === 'NEW_INBOUND') {
        leadCategory = parsed.leadCategory;
      }

      const invalidProductNames = [
        'umum',
        'tidak ada',
        'tidak ada informasi',
        'tidak ada informasi produk',
        'tidak diketahui',
        'tidak disebutkan',
        'belum spesifik',
        'belum ada',
        'hitam',
        'coklat',
        'golok hitam',
        'golok coklat',
      ];

      if (parsed.minatProduk) {
        const cleanedLlm = this.cleanProductName(String(parsed.minatProduk));
        const isInvalidOrColorOnly =
          !cleanedLlm ||
          invalidProductNames.includes(cleanedLlm.toLowerCase().trim()) ||
          cleanedLlm.toLowerCase().startsWith('tidak ada') ||
          cleanedLlm.toLowerCase().startsWith('belum');

        if (!isInvalidOrColorOnly) {
          minatProduk = cleanedLlm;
        } else {
          minatProduk = anchorProduct;
        }
      } else {
        minatProduk = anchorProduct;
      }

      if (parsed.lastInsight) lastInsight = String(parsed.lastInsight).trim();
      if (['CLOSING', 'PENDING', 'LOST'].includes(parsed.conversion)) {
        conversion = parsed.conversion as ConversionStatus;
      }
      llmScore = Number(parsed.score) || 0;
      llmReasons = Array.isArray(parsed.reasons) ? parsed.reasons.map(String) : [];
    } catch (err) {
      logger.warn(`[LeadProfiler] LLM analysis parsing error, using heuristic fallback: ${err}`);
      minatProduk = anchorProduct;
      if (buyingSignals.score >= 60) {
        lastInsight = `Pembeli menunjukkan minat kuat pada ${minatProduk} (${buyingSignals.reasons.join(', ')}).`;
      }
    }

    // ── STAGE 3.5: Deterministic Closing & Category Enforcement ───────────────
    const isDeterministicClosingSignal = SessionBoundaryParser.isDeterministicClosing(activeSession.rawTranscript);
    if (isDeterministicClosingSignal) {
      conversion = 'CLOSING';
      llmScore = Math.max(llmScore, 95);
      leadCategory = 'NEW_INBOUND';
    } else if (conversion === 'CLOSING') {
      leadCategory = 'NEW_INBOUND';
    }

    // Jika terdeteksi sebagai obrolan internal / koordinasi tim CS, jangan masukkan ke CRM Leads
    const isExplicitlyInternalInsight =
      lastInsight.toLowerCase().includes('percakapan internal') ||
      lastInsight.toLowerCase().includes('antar tim cs') ||
      lastInsight.toLowerCase().includes('tidak ada transaksi pembelian');

    if (isInternalTeamChat || isExplicitlyInternalInsight) {
      logger.info(`[LeadProfiler] Kontak ${contactJid} teridentifikasi sebagai obrolan internal tim CS. Melewati penyimpanan CRM Leads.`);
      try {
        await prisma.lead.deleteMany({
          where: { businessId, waNumber: sanitizedContactPhone },
        });
      } catch (delErr) {
        logger.warn(`[LeadProfiler] Gagal menghapus lead internal: ${delErr}`);
      }
      return null;
    }

    // ── STAGE 4: CRM Data Model & SOP Audit Dispatcher ─────────────────────────
    const blended = LeadScoringEngine.blendScore(llmScore, llmReasons, buyingSignals);

    let mengantarScore = null;
    let rtsAnalysis: RtsAnalysisResult = {
      rtsRiskScore: 0,
      rtsRiskLevel: 'LOW',
      chatQualityScore: 100,
      reasons: [],
      courierRecommendation: null,
      mengantarData: undefined,
    };

    try {
      const biz = await prisma.business.findUnique({
        where: { id: businessId },
        select: { mengantarApiKey: true },
      });
      const rawPhone = LeadsRepository.sanitizeWaNumber(contactJid);
      mengantarScore = rawPhone ? await MengantarService.getReceiverScore(rawPhone, biz?.mengantarApiKey) : null;
      
      // Evaluasi Kualitas Chat CS & Gabungkan dengan Data Logistik
      //
      // Solusi permanen anti-false-positive RTS:
      // 1. isConfirmedClosing: Jika lead sudah CLOSING (deterministik atau dari LLM),
      //    Dimensi A (Consent) & E (Keberatan) di-skip di RTS engine \u2014 consent sudah terbukti.
      // 2. transcriptToEvaluate: Untuk CLOSING lead, kirim FULL rawTranscript (bukan hanya
      //    activeSession) agar Dimensi B/C/D dievaluasi dari seluruh riwayat percakapan,
      //    bukan hanya sesi terakhir yang mungkin terpotong session parser.
      //    Contoh: Bambang (jeda 4.5 jam) \u2014 sesi ke-2 tidak punya konteks rincian biaya dari sesi ke-1,
      //    sehingga tanpa full transcript, Dimensi C akan false flag meski CS sudah benar.
      const isConfirmedClosing = isDeterministicClosingSignal || conversion === 'CLOSING';
      const transcriptToEvaluate: SegmentedSession | string = isConfirmedClosing
        ? rawTranscript    // Full history \u2014 menembus batas session parser
        : activeSession;   // Hanya sesi aktif \u2014 untuk PENDING/prospek biasa
      const { chatQualityScore, chatReasons } = RtsRiskEngine.evaluateChatQuality(
        transcriptToEvaluate,
        conversion,
        isConfirmedClosing,
      );
      rtsAnalysis = RtsRiskEngine.blendRtsRisk(chatQualityScore, chatReasons, mengantarScore, conversion);
    } catch (rtsErr) {
      logger.warn(`[LeadProfiler] Gagal evaluasi RTS risk: ${rtsErr}`);
    }

    // Simpan Lead Profile ke Postgres
    try {
      await LeadsRepository.upsertLeadProfile({
        businessId,
        rawJid: contactJid,
        csPhone,
        csName,
        leadCategory,
        minatProduk,
        lastInsight,
        conversion,
        score: blended.score,
        stage: blended.stage,
        messageTimestamp: input.messageTimestamp || activeSession.endTime || new Date(),
        rtsRiskScore: rtsAnalysis.rtsRiskScore,
        rtsRiskLevel: rtsAnalysis.rtsRiskLevel,
        rtsReasons: rtsAnalysis.reasons,
        courierRecommendation: rtsAnalysis.courierRecommendation,
        mengantarData: rtsAnalysis.mengantarData || undefined,
      });
    } catch (dbErr) {
      logger.error(`[LeadProfiler] Failed to persist lead profile for ${contactJid}: ${dbErr}`);
    }

    return {
      leadCategory,
      minatProduk,
      lastInsight,
      conversion,
      rawScore: blended.score,
      stage: blended.stage,
      reasons: blended.reasons,
      rtsRiskScore: rtsAnalysis.rtsRiskScore,
      rtsRiskLevel: rtsAnalysis.rtsRiskLevel,
      rtsReasons: rtsAnalysis.reasons,
      courierRecommendation: rtsAnalysis.courierRecommendation,
      mengantarData: rtsAnalysis.mengantarData,
    };
  }
}

