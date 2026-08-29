import { prisma } from '../../config/prisma';
import { toJakartaDateTimeStr, toJakartaDateStr } from '../../utils/timezone';
import { LeadsRepository } from './leads.repository';

export interface TimelineMilestoneEvent {
  id: string;
  type: 'FIRST_INBOUND' | 'CS_RESPONSE' | 'DEAL_CONVERSION' | 'RTS_VALIDATION' | 'AFTER_SALES' | 'NOTE';
  title: string;
  timestamp: string; // ISO String
  timestampWib: string; // "15 Agu 2026, 07:23:00 WIB"
  description: string;
  badge?: {
    text: string;
    color: 'indigo' | 'emerald' | 'amber' | 'rose' | 'blue' | 'gray';
  };
  details?: Record<string, any>;
}

export interface CustomerOrderGroup {
  orderNumber: number;
  leadId: string;
  product: string;
  category: 'PROSPEK_IKLAN' | 'NEW_INBOUND' | 'AFTER_SALES';
  categoryLabel: string;
  conversionStatus: 'CLOSING' | 'PENDING' | 'LOST';
  // Langkah D Fase 26 (Temuan T2): tambah 'EVALUATION_FAILED' -- lihat RtsRiskLevel di
  // rts-risk.engine.ts utk rasionalisasi lengkap.
  rtsRiskLevel?: 'LOW' | 'MEDIUM' | 'HIGH' | 'EVALUATION_FAILED' | null;
  rtsReasons?: string[];
  courierRecommendation?: string | null;
  estimatedValue: number;
  csName: string;
  csPhone: string;
  startDate: string; // ISO
  startDateWib: string;
  endDate: string; // ISO
  endDateWib: string;
  gapDaysFromPrevious?: number;
  events: TimelineMilestoneEvent[];
}

export interface CustomerTimelineResult {
  waNumber: string;
  name: string;
  totalOrders: number;
  totalClosings: number;
  totalLifetimeValue: number;
  isRepeatBuyer: boolean;
  firstContactAt: string;
  firstContactAtWib: string;
  latestContactAt: string;
  latestContactAtWib: string;
  salesCycleDays: number;
  currentStage: string;
  currentConversion: string;
  assignedCsName: string;
  assignedCsPhone: string;
  orderGroups: CustomerOrderGroup[];
}

export class TimelineService {
  /**
   * Menghasilkan Timeline Perjalanan Pembeli Customer 360° Lintas Sesi & Multi-Order.
   */
  static async getCustomerTimeline(businessId: string, rawPhone: string): Promise<CustomerTimelineResult | null> {
    const waNumber = LeadsRepository.sanitizeWaNumber(rawPhone);
    if (!waNumber || !businessId) return null;

    // 1. Ambil semua lead records terkait nomor ini
    const leads = await prisma.lead.findMany({
      where: {
        businessId,
        waNumber,
      },
      orderBy: {
        createdAt: 'asc',
      },
    });

    if (!leads || leads.length === 0) {
      return null;
    }

    const firstLead = leads[0]!;
    const latestLead = leads[leads.length - 1]!;
    const customerName = latestLead.name || firstLead.name || 'Pelanggan';

    let totalLifetimeValue = 0;
    let totalClosings = 0;

    const orderGroups: CustomerOrderGroup[] = [];
    let prevOrderEndTime: Date | null = null;

    // Estimasi harga per produk untuk kalkulasi LTV
    const ESTIMATED_PRICES: Record<string, number> = {
      'Golok Situmang 3': 235000,
      'Golok Situmang 2': 246000,
      'Golok Black Mamba': 252000,
      'Bedog Betekok': 195000,
      'Golok Kebun Ekonomis 30': 180000,
      'GKE 40 Perak Duralium': 265000,
      'GKE 40 Perak Duralium 2': 285000,
      'Golok Sembelih Multifungsi': 190000,
      'Golok Tarisi': 210000,
      'Pisau Sembelih': 175000,
      'Pisau Seset': 150000,
      'Batu Asahan': 85000,
    };

    for (let idx = 0; idx < leads.length; idx++) {
      const lead = leads[idx]!;
      const prodName = lead.minatProduk || 'Produk Cordova';
      const isClosing = lead.conversionStatus === 'CLOSING';
      const estPrice = ESTIMATED_PRICES[prodName] || (isClosing ? 200000 : 0);

      if (isClosing) {
        totalClosings++;
        totalLifetimeValue += estPrice;
      }

      const orderStartTime = lead.createdAt;
      const orderEndTime = lead.lastMessageAt || lead.updatedAt || lead.createdAt;

      let gapDaysFromPrevious: number | undefined = undefined;
      if (prevOrderEndTime) {
        const diffMs = orderStartTime.getTime() - prevOrderEndTime.getTime();
        const diffDays = Math.round(diffMs / (1000 * 60 * 60 * 24));
        if (diffDays >= 1) {
          gapDaysFromPrevious = diffDays;
        }
      }
      prevOrderEndTime = orderEndTime;

      // Susun Milestone Events untuk Order Group ini
      const events: TimelineMilestoneEvent[] = [];

      // Event 1: First Inbound
      const isAdForm = lead.leadCategory === 'PROSPEK_IKLAN';
      events.push({
        id: `ev-inbound-${lead.id}`,
        type: 'FIRST_INBOUND',
        title: isAdForm ? 'Mengisi Formulir Iklan Landing Page' : 'Kontak Pertama Masuk (Chat WhatsApp)',
        timestamp: orderStartTime.toISOString(),
        timestampWib: toJakartaDateTimeStr(orderStartTime) + ' WIB',
        description: isAdForm
          ? `Membawa data pesanan formulir iklan: ${prodName} ke CS ${lead.assignedCsName || 'CS'}`
          : `Menghubungi CS ${lead.assignedCsName || 'CS'} menanyakan informasi produk: ${prodName}`,
        badge: {
          text: isAdForm ? 'Form Iklan' : 'Inbound Organik',
          color: isAdForm ? 'indigo' : 'blue',
        },
      });

      // Event 2: Konsultasi & Negosiasi CS
      // Langkah D Fase 26 (Temuan T1): sebelumnya timestamp SELALU "+5 menit tepat" dari kontak
      // pertama (bukan waktu asli respon CS -- data itu memang tidak tersimpan di mana pun, model
      // Lead tidak punya kolom timestamp per-pesan), dan deskripsi template statis yg SELALU sama
      // asal `assignedCsName` terisi, TANPA verifikasi CS benar2 melakukan hal2 itu di percakapan
      // nyata. Kalau ditampilkan sbg jam:menit:detik presisi, ops/Bossfren bisa salah menyimpulkan
      // ini log SLA respon CS sungguhan. Fix: jujur -- label "estimasi", tanpa jam presisi palsu.
      if (lead.assignedCsName) {
        events.push({
          id: `ev-cs-${lead.id}`,
          type: 'CS_RESPONSE',
          title: `Konsultasi & Penanganan oleh CS ${lead.assignedCsName} (estimasi)`,
          timestamp: new Date(orderStartTime.getTime() + 5 * 60 * 1000).toISOString(),
          timestampWib: 'Estimasi, bukan waktu tercatat sebenarnya',
          description: `CS yang menangani: ${lead.assignedCsName}. Rincian biaya, ongkir, dan opsi pembayaran COD/Transfer BIASANYA disampaikan pada tahap ini -- deskripsi ini estimasi alur umum, bukan hasil pembacaan transkrip percakapan aktual sesi ini.`,
          badge: {
            text: `CS: ${lead.assignedCsName}`,
            color: 'blue',
          },
        });
      }

      // Event 3: Deal Conversion
      let convTitle = 'Proses Follow-Up Berjalan';
      let convDesc = lead.lastInsight || 'Prospek sedang dalam tahap pertimbangan dan konsultasi.';
      let convColor: 'emerald' | 'amber' | 'rose' = 'amber';

      if (lead.conversionStatus === 'CLOSING') {
        convTitle = 'Kesepakatan Deal (CLOSING)';
        convDesc = `Pesanan ${prodName} disetujui kirim via COD (Estimasi Total: Rp ${estPrice.toLocaleString('id-ID')}). Catatan 6 SOP COD telah dikirim.`;
        convColor = 'emerald';
      } else if (lead.conversionStatus === 'LOST') {
        convTitle = 'Prospek Batal (LOST)';
        convDesc = lead.lastInsight || 'Pelanggan membatalkan pesanan atau tidak melanjutkan komunikasi.';
        convColor = 'rose';
      }

      events.push({
        id: `ev-deal-${lead.id}`,
        type: 'DEAL_CONVERSION',
        title: convTitle,
        timestamp: orderEndTime.toISOString(),
        timestampWib: toJakartaDateTimeStr(orderEndTime) + ' WIB',
        description: convDesc,
        badge: {
          text: lead.conversionStatus,
          color: convColor,
        },
        details: {
          score: lead.score,
          stage: lead.leadStage,
        },
      });

      // Event 4: Validasi Logistik & RTS (Jika Closing)
      // Langkah D Fase 26 (Temuan T2, PALING SERIUS): sebelumnya kalau evaluasi RTS gagal total
      // (exception di lead-profiler.service.ts, mis. API Mengantar down), sistem diam2 menyimpan
      // default {rtsRiskLevel:'LOW', reasons:[]} -- yg di sini TIDAK BISA DIBEDAKAN dari hasil
      // evaluasi yg benar2 sukses & aman. Badge hijau "AMAN" bisa muncul padahal alamat TIDAK
      // PERNAH divalidasi -- CS bisa kirim COD tanpa validasi sungguhan. Fix: `lead-profiler.
      // service.ts` sekarang menulis sentinel eksplisit 'EVALUATION_FAILED' (bukan diam2 'LOW')
      // kalau lead ini belum pernah punya evaluasi sah sebelumnya -- di sini dirender BEDA dari
      // "aman" (warna amber peringatan, bukan hijau, teks jujur "belum divalidasi").
      if (lead.conversionStatus === 'CLOSING') {
        const isEvaluationFailed = lead.rtsRiskLevel === 'EVALUATION_FAILED';
        const isLowRisk = lead.rtsRiskLevel === 'LOW';
        let title: string;
        let badgeColor: 'emerald' | 'amber' | 'rose' | 'blue' | 'gray';
        let badgeText: string;
        let description: string;

        if (isEvaluationFailed) {
          title = 'Audit Kepatuhan Alamat: BELUM TERVALIDASI (evaluasi gagal)';
          badgeColor = 'amber';
          badgeText = 'RTS: Perlu Verifikasi Manual';
          description = (lead.rtsReasons && lead.rtsReasons.length > 0)
            ? lead.rtsReasons.join(' • ')
            : 'Evaluasi kepatuhan alamat gagal dijalankan karena error teknis -- BUKAN berarti alamat sudah aman, perlu pengecekan manual sebelum resi dicetak.';
        } else {
          title = isLowRisk ? 'Audit Kepatuhan Alamat: AMAN (Low Risk)' : 'Audit Kepatuhan Alamat: PERLU PERHATIAN';
          badgeColor = isLowRisk ? 'emerald' : 'amber';
          badgeText = isLowRisk ? 'RTS Aman (0%)' : `RTS Risk: ${lead.rtsRiskScore || 25}%`;
          description = (lead.rtsReasons && lead.rtsReasons.length > 0)
            ? lead.rtsReasons.join(' • ')
            : 'Data alamat lengkap dan SOP percakapan CS terpenuhi.';
        }

        events.push({
          id: `ev-rts-${lead.id}`,
          type: 'RTS_VALIDATION',
          title,
          timestamp: new Date(orderEndTime.getTime() + 2 * 60 * 1000).toISOString(),
          timestampWib: toJakartaDateTimeStr(new Date(orderEndTime.getTime() + 2 * 60 * 1000)) + ' WIB',
          description,
          badge: {
            text: badgeText,
            color: badgeColor,
          },
          details: {
            courier: lead.courierRecommendation || 'J&T / JNE',
          },
        });
      }

      orderGroups.push({
        orderNumber: idx + 1,
        leadId: lead.id,
        product: prodName,
        category: (lead.leadCategory as any) || 'NEW_INBOUND',
        categoryLabel: lead.leadCategory === 'PROSPEK_IKLAN' ? 'Prospek Iklan' : (lead.leadCategory === 'AFTER_SALES' ? 'Layanan Purna Jual' : 'Prospek Organik'),
        conversionStatus: lead.conversionStatus as any,
        rtsRiskLevel: lead.rtsRiskLevel as any,
        rtsReasons: lead.rtsReasons || [],
        courierRecommendation: lead.courierRecommendation,
        estimatedValue: estPrice,
        csName: lead.assignedCsName || 'CS',
        csPhone: lead.assignedCsPhone || '-',
        startDate: orderStartTime.toISOString(),
        startDateWib: toJakartaDateTimeStr(orderStartTime) + ' WIB',
        endDate: orderEndTime.toISOString(),
        endDateWib: toJakartaDateTimeStr(orderEndTime) + ' WIB',
        gapDaysFromPrevious,
        events,
      });
    }

    const firstContactAt = firstLead.createdAt;
    const latestContactAt = latestLead.lastMessageAt || latestLead.updatedAt || latestLead.createdAt;
    const salesCycleDiffMs = latestContactAt.getTime() - firstContactAt.getTime();
    const salesCycleDays = Math.max(0, Math.round(salesCycleDiffMs / (1000 * 60 * 60 * 24)));

    const isRepeatBuyer = totalClosings > 1 || leads.length > 1;

    return {
      waNumber,
      name: customerName,
      totalOrders: leads.length,
      totalClosings,
      totalLifetimeValue,
      isRepeatBuyer,
      firstContactAt: firstContactAt.toISOString(),
      firstContactAtWib: toJakartaDateTimeStr(firstContactAt) + ' WIB',
      latestContactAt: latestContactAt.toISOString(),
      latestContactAtWib: toJakartaDateTimeStr(latestContactAt) + ' WIB',
      salesCycleDays,
      currentStage: latestLead.leadStage,
      currentConversion: latestLead.conversionStatus,
      assignedCsName: latestLead.assignedCsName || 'CS',
      assignedCsPhone: latestLead.assignedCsPhone || '-',
      orderGroups,
    };
  }
}
