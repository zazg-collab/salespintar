import { MengantarReceiverScoreResult } from '../../services/mengantar.service';
import { ConversionStatus } from './dto/lead-profile.dto';
import { SegmentedSession, SessionBoundaryParser } from './session-parser';

// Langkah D Fase 26 (Temuan T2): tambah 'EVALUATION_FAILED' -- sentinel eksplisit dipakai
// lead-profiler.service.ts saat evaluasi RTS gagal total (exception) dan lead ini belum pernah
// punya hasil evaluasi sah sebelumnya. WAJIB dirender beda dari 'LOW' oleh semua consumer
// (timeline.service.ts, dashboard.routes.ts) -- jangan pernah diperlakukan sbg "aman".
export type RtsRiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'EVALUATION_FAILED';

export interface RtsAnalysisResult {
  rtsRiskScore: number; // 0 - 100% (makin tinggi makin berisiko retur)
  rtsRiskLevel: RtsRiskLevel;
  chatQualityScore: number; // 0 - 100 (kualitas penanganan CS)
  reasons: string[];
  courierRecommendation: string | null;
  mengantarData?: MengantarReceiverScoreResult | null;
}

export class RtsRiskEngine {
  /**
   * Evaluasi kualitas chat percakapan berdasarkan 5 Dimensi Kritis Anti-RTS.
   *
   * @param sessionOrTranscript - Sesi aktif atau string transkrip penuh
   * @param conversion - Status konversi lead saat ini
   * @param isConfirmedClosing - Jika TRUE, skip evaluasi Dimensi A (Consent) & E (Keberatan).
   *   Alasan: Jika lead sudah berstatus CLOSING secara deterministik, persetujuan pembeli
   *   sudah terbukti dari fakta closing-nya itu sendiri. Mengevaluasi ulang consent via
   *   regex pada lead CLOSING hanya akan menghasilkan false positive (misal: pembeli jawab
   *   "Y" atau "Sudah" yang tidak tertangkap regex, atau sesi terpotong session parser).
   *   Dimensi yang tetap dievaluasi: B (Alamat), C (Total Biaya COD), D (Kesiapan Dana).
   */
  static evaluateChatQuality(
    sessionOrTranscript: SegmentedSession | string,
    conversion: ConversionStatus,
    isConfirmedClosing: boolean = false,
  ): { chatQualityScore: number; chatReasons: string[] } {
    let buyerLines: string[] = [];
    let csLines: string[] = [];
    let fullTranscriptText = '';

    if (typeof sessionOrTranscript === 'object' && sessionOrTranscript.messages) {
      fullTranscriptText = sessionOrTranscript.rawTranscript || '';
      for (const msg of sessionOrTranscript.messages) {
        if (msg.senderRole === 'BUYER') {
          buyerLines.push(msg.text.toLowerCase());
        } else if (msg.senderRole === 'CS') {
          csLines.push(msg.text.toLowerCase());
        }
      }
    } else {
      fullTranscriptText = typeof sessionOrTranscript === 'string' ? sessionOrTranscript : '';
      const parsedLines = SessionBoundaryParser.parseLines(fullTranscriptText);
      if (parsedLines.length > 0) {
        for (const msg of parsedLines) {
          if (msg.senderRole === 'BUYER') {
            buyerLines.push(msg.text.toLowerCase());
          } else if (msg.senderRole === 'CS') {
            csLines.push(msg.text.toLowerCase());
          }
        }
      } else {
        const lines = fullTranscriptText.split('\n');
        for (const l of lines) {
          if (l.startsWith('[BUYER]') || l.startsWith('[CUSTOMER]')) {
            buyerLines.push(l.replace(/^\[(BUYER|CUSTOMER)\]\s*/, '').toLowerCase());
          } else if (l.startsWith('[CS]') || l.startsWith('[SELLER]')) {
            csLines.push(l.replace(/^\[(CS|SELLER)\]\s*/, '').toLowerCase());
          }
        }
      }
    }

    if (buyerLines.length === 0 && csLines.length === 0) {
      return { 
        chatQualityScore: 0, 
        chatReasons: ['Transkrip percakapan belum tersinkronisasi (Audit SOP CS belum dapat dievaluasi)'] 
      };
    }

    const allBuyerText = buyerLines.join(' ');
    const allCsText = csLines.join(' ');
    const chatReasons: string[] = [];
    let qualityScore = 100; // Mulai dari skor sempurna, kurangi penalti

    // 1. DIMENSI A: Explicit Buyer Consent (Persetujuan Nyata Pembeli / Konfirmasi Alamat)
    // DILEWATI jika isConfirmedClosing = true.
    // Alasan: Lead CLOSING sudah terbukti setuju secara deterministik (misal: CS kirim template
    // konfirmasi SOP "Baik kami proses.."). Evaluasi ulang consent via regex hanya menghasilkan
    // false positive — pembeli bisa jawab "Y", "Sudah", bahasa daerah, dll yang tidak tertangkap.
    if (!isConfirmedClosing) {
      const positiveConsent = /(iya|deal|setuju|kirim|bungkus|proses|ambil|order|pesan|minat|transfer|cod|siap|jadi mas|jadi kak|oke kak|ok kak|oke mas|ok mas|\by\b|\bok\b|\bya\b|sudah benar|sdh benar|betul|bener|lakukan pemesanan|secepatnya|nama\s*[,:]|alamat\s*[,:]|no\s*hp\s*[,:]|kecamatan|kabupaten|desa|kelurahan|jalan|hitam|coklat)/i;
      const buyerConsented = positiveConsent.test(allBuyerText);
      const csForced = /(langsung kami bungkus ya|langsung kami buatkan resi|saya catat ya kak)/i.test(allCsText);

      if (!buyerConsented && conversion === 'CLOSING') {
        qualityScore -= 30;
        chatReasons.push('Pembeli tidak memberikan persetujuan eksplisit (Closing terindikasi dipaksa CS)');
      } else if (csForced && buyerLines.length < 2 && conversion === 'CLOSING') {
        qualityScore -= 20;
        chatReasons.push('CS terlalu terburu-buru menutup pesanan sebelum pembeli yakin');
      }
    }

    // 2. DIMENSI B: Kelengkapan Alamat & Patokan (Address Granularity)
    const hasRtRw = /\b(rt\b|rw\b|rt\/rw|rtrw|nomor\b|no\.\s*\d+|no\s*\d+|jl\b|jalan\b|gang\b|gg\b|blok\b|dusun\b)|\d+\/\d+/i.test(fullTranscriptText);
    const hasDusunDesa = /\b(desa\b|kelurahan\b|kel\b|dusun\b|kampung\b|kp\b|ds\b|kecamatan\b|kec\b|kabupaten\b|kab\b|kota\b)/i.test(fullTranscriptText);
    const hasPatokan = /\b(patokan\b|ancer|dekat\b|sebelah\b|depan\b|belakang\b|samping\b|seberang\b|pos\s*ronda|pos\s*satpam|masjid\b|mesjid\b|mushola\b|musholla\b|surau\b|sekolah\b|sd\b|smp\b|sma\b|warung\b|toko\b|pagar\b|komplek\b|perum\b|perumahan\b|lapangan\b|kantor\s*desa|balai\s*desa|pasar\b|jembatan\b)/i.test(fullTranscriptText);

    if (conversion === 'CLOSING') {
      if (!hasRtRw && !hasDusunDesa) {
        qualityScore -= 40;
        chatReasons.push('Alamat pembeli sangat minim (tidak ada RT/RW atau Dusun/Kecamatan)');
      } else if (!hasPatokan && !hasRtRw) {
        qualityScore -= 25;
        chatReasons.push('Alamat belum dilengkapi patokan rumah atau nomor RT/RW spesifik (berisiko kurir gagal antar)');
      }
    }

    // 3. DIMENSI C: Transparansi Biaya & COD (Price Transparency)
    const mentionsTotal = /(total|rp|ribu|\.000|,000|ongkir|biaya|harga|bayar)/i.test(allCsText);
    if (conversion === 'CLOSING' && !mentionsTotal) {
      qualityScore -= 15;
      chatReasons.push('CS tidak merinci total nominal biaya COD yang harus dibayar');
    }

    // 4. DIMENSI D: Kesiapan Dana & Orang di Rumah (Commitment Anchor)
    const mentionsReadiness = /(siapkan uang|uang pas|ada orang|orang dirumah|orang di rumah|titip uang|jangan kemana-mana|kurir hubungi|siapkan dana|pastikan hp|hp selalu aktif|bayar cod)/i.test(allCsText);
    if (conversion === 'CLOSING' && !mentionsReadiness) {
      qualityScore -= 5;
      chatReasons.push('CS belum mengingatkan kesiapan uang tunai atau keberadaan penerima saat kurir tiba');
    }

    // 5. DIMENSI E: Keberatan / Keraguan yang Diabaikan (Unresolved Hesitation)
    // DILEWATI jika isConfirmedClosing = true.
    // Alasan: Pembeli bisa saja pernah ragu di sesi awal, lalu di sesi lanjutan sudah mantap
    // dan setuju. Karena session parser memotong percakapan, pesan keraguan lama bisa ikut
    // terbaca di sesi yang berbeda dari closing — menghasilkan false flag padahal CS sudah
    // berhasil meyakinkan pembeli di sesi berikutnya.
    if (!isConfirmedClosing) {
      const buyerHesitation = /(tanya suami|tanya istri|kemahalan|nanti dulu|pikir dulu|belum gajian|lagi gak ada uang|mahal)/i.test(allBuyerText);
      if (buyerHesitation && conversion === 'CLOSING') {
        qualityScore -= 20;
        chatReasons.push('Pembeli sempat ragu/menolak halus namun tetap diproses kirim');
      }
    }

    // Normalisasi skor kualitas ke rentang 0 - 100
    const finalQualityScore = Math.max(10, Math.min(100, qualityScore));
    return { chatQualityScore: finalQualityScore, chatReasons };
  }

  /**
   * Gabungkan Analisis Chat AI dengan Data Logistik Mengantar (2-Layer Anti-RTS Firewall)
   */
  static blendRtsRisk(
    chatQualityScore: number,
    chatReasons: string[],
    mengantarData?: MengantarReceiverScoreResult | null,
    conversion?: ConversionStatus,
  ): RtsAnalysisResult {
    const reasons = [...chatReasons];
    let courierRecommendation: string | null = null;

    // Jika statusnya LOST (Batal), tidak ada pengiriman paket
    if (conversion === 'LOST') {
      return {
        rtsRiskScore: 0,
        rtsRiskLevel: 'LOW',
        chatQualityScore,
        reasons: ['Percakapan batal / tidak terjadi pengiriman'],
        courierRecommendation: null,
        mengantarData: mengantarData || undefined,
      };
    }

    const isTranscriptMissing = chatReasons.some(r => r.includes('belum tersinkronisasi'));

    // 1. Hitung Risiko Kualitas Chat CS (Invers Kualitas Chat 0 - 100%)
    const chatRiskScore = isTranscriptMissing ? 0 : Math.max(0, 100 - chatQualityScore);

    // 2. Evaluasi Data Logistik Mengantar
    let mengantarRiskScore = 0;
    if (mengantarData && mengantarData.totalOrders > 0) {
      courierRecommendation = mengantarData.recommendedCourier;

      // Rasio kegagalan kirim + penalti kejadian retur masa lalu (+10% per RTS)
      const deliveryFailureRate = Math.max(0, 100 - mengantarData.overallDeliveryRate);
      const rtsPenalty = (mengantarData.totalRts || 0) * 10;
      mengantarRiskScore = Math.min(100, deliveryFailureRate + rtsPenalty);

      if (mengantarData.riskReasons && mengantarData.riskReasons.length > 0) {
        reasons.push(...mengantarData.riskReasons);
      }
    }

    // 3. Pembobotan Real
    let rtsRiskScore = 0;
    if (conversion === 'PENDING') {
      // Pada tahap follow up (belum deal), risiko kirim murni dari reputasi logistik pembeli
      rtsRiskScore = mengantarData && mengantarData.totalOrders > 0 ? mengantarRiskScore : 0;
    } else {
      // Pada tahap CLOSING (sudah deal)
      if (mengantarData && mengantarData.totalOrders > 0) {
        if (isTranscriptMissing) {
          rtsRiskScore = mengantarRiskScore;
        } else {
          rtsRiskScore = Math.round((chatRiskScore * 0.60) + (mengantarRiskScore * 0.40));
        }
      } else {
        rtsRiskScore = chatRiskScore;
      }
    }

    // 4. Tentukan Level Risiko RTS & Susun Rincian Alasan
    let rtsRiskLevel: RtsRiskLevel = 'LOW';
    if (rtsRiskScore <= 15) {
      rtsRiskLevel = 'LOW';
    } else if (rtsRiskScore <= 45) {
      rtsRiskLevel = 'MEDIUM';
    } else {
      rtsRiskLevel = 'HIGH';
    }

    const finalReasons: string[] = [];
    if (chatReasons.length > 0) {
      finalReasons.push(...chatReasons);
    }
    if (finalReasons.length === 0) {
      finalReasons.push('SOP percakapan CS terpenuhi & komitmen pembeli terpantau baik');
    }

    return {
      rtsRiskScore,
      rtsRiskLevel,
      chatQualityScore,
      reasons: finalReasons,
      courierRecommendation,
      mengantarData: mengantarData || undefined,
    };
  }
}
