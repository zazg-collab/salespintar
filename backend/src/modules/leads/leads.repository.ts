import { prisma } from '../../config/prisma';
import {
  LeadFilterParams,
  LeadStage,
  LeadSummaryStats,
  ConversionStatus,
} from './dto/lead-profile.dto';
import { LeadScoringEngine } from './lead-scoring.engine';

function parseWibDateFilter(startDate?: string, endDate?: string): { gte?: Date; lte?: Date } | null {
  if (!startDate && !endDate) return null;
  const filter: { gte?: Date; lte?: Date } = {};
  if (startDate) {
    // Treat startDate as YYYY-MM-DD in Asia/Jakarta (UTC+7)
    filter.gte = new Date(`${startDate}T00:00:00.000+07:00`);
  }
  if (endDate) {
    // Treat endDate as YYYY-MM-DD in Asia/Jakarta (UTC+7)
    filter.lte = new Date(`${endDate}T23:59:59.999+07:00`);
  }
  return filter;
}

export class LeadsRepository {
  /**
   * Sanitasi JID Baileys ke format nomor telepon bersih E.164 (mis: "6281234567890")
   */
  static sanitizeWaNumber(jid: string): string {
    if (!jid) return '';
    // Buang status story, broadcast, group JID
    if (jid.includes('status@broadcast') || jid.includes('@g.us') || jid.includes('@newsletter')) {
      return '';
    }
    // Buang @s.whatsapp.net, @c.us, @lid, dan suffix device :12
    const clean = jid.split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
    return clean.length >= 7 ? clean : '';
  }

  /**
   * Upsert Lead Record dengan High-Water Mark Anti-Downgrade & Idempotensi.
   */
  static async upsertLeadProfile(data: {
    businessId: string;
    rawJid: string;
    csPhone: string;
    csName?: string;
    leadCategory?: 'NEW_INBOUND' | 'AFTER_SALES';
    minatProduk?: string | null;
    lastInsight: string;
    conversion: ConversionStatus;
    score: number;
    stage: LeadStage;
    messageTimestamp?: Date;
    rtsRiskScore?: number;
    rtsRiskLevel?: string;
    rtsReasons?: string[];
    courierRecommendation?: string | null;
    mengantarData?: any;
  }) {
    const waNumber = this.sanitizeWaNumber(data.rawJid);
    if (!waNumber || !data.businessId) return null;

    const now = data.messageTimestamp || new Date();

    // 1. Cari record yang sudah ada
    const existing = await prisma.lead.findUnique({
      where: {
        businessId_waNumber: {
          businessId: data.businessId,
          waNumber,
        },
      },
      select: {
        id: true,
        score: true,
        leadCategory: true,
        leadStage: true,
        conversionStatus: true,
        totalMessages: true,
        minatProduk: true,
        lastInsight: true,
      },
    });

    if (existing) {
      // 2. Hitung Stage & Score dengan Anti-Downgrade
      const isLost = data.conversion === 'LOST';
      const { finalStage, finalScore } = LeadScoringEngine.resolveNextStage(
        (existing.leadStage as LeadStage) || 'COLD',
        existing.score || 0,
        data.stage,
        data.score,
        isLost,
      );

      // Status closing: jika sudah CLOSING sebelumnya, jangan ditimpa PENDING
      let finalConversion = data.conversion;
      if (existing.conversionStatus === 'CLOSING' && data.conversion === 'PENDING') {
        finalConversion = 'CLOSING';
      }

      // Kategori carry-over: Jika sudah NEW_INBOUND sebelumnya, pertahankan NEW_INBOUND agar chat lanjutan tanya resi tidak menurunkan status lead iklan
      let finalLeadCategory = data.leadCategory || existing.leadCategory;
      if (existing.leadCategory === 'NEW_INBOUND' && data.leadCategory === 'AFTER_SALES') {
        finalLeadCategory = 'NEW_INBOUND';
      }

      // Produk carry-over: Jika produk lama sudah spesifik, jangan ditimpa nilai "Umum"
      let finalMinatProduk = data.minatProduk;
      const isNewGeneric = !data.minatProduk || 
        data.minatProduk.toLowerCase().includes('umum') || 
        data.minatProduk.toLowerCase().includes('belum spesifik');
      const isOldSpecific = existing.minatProduk && 
        !existing.minatProduk.toLowerCase().includes('umum') && 
        !existing.minatProduk.toLowerCase().includes('belum spesifik');

      if (isNewGeneric && isOldSpecific) {
        finalMinatProduk = existing.minatProduk || data.minatProduk;
      }

      // Atomic anti-downgrade guard menggunakan $transaction.
      // Tujuan: Mencegah race condition di mana dua request concurrent sama-sama membaca
      // status PENDING, lalu request A berhasil set CLOSING, tapi request B (dengan status
      // lama) menimpa balik ke PENDING karena pengecekan in-memory sudah terlambat.
      // Dengan $transaction, re-read status terjadi di dalam transaksi yang sama dengan update —
      // Postgres menjamin tidak ada request lain yang bisa mengubah baris tersebut di antaranya.
      return prisma.$transaction(async (tx) => {
        // Re-read status konversi terkini di dalam transaksi (atomic read)
        const freshStatus = await tx.lead.findUnique({
          where: { id: existing.id },
          select: { conversionStatus: true },
        });

        // Anti-downgrade: jika DB saat ini CLOSING dan request baru mau turunkan ke PENDING, tolak
        let atomicConversion = finalConversion;
        if (freshStatus?.conversionStatus === 'CLOSING' && data.conversion === 'PENDING') {
          atomicConversion = 'CLOSING';
        }

        return tx.lead.update({
          where: { id: existing.id },
          data: {
            score: finalScore,
            leadCategory: finalLeadCategory as any,
            leadStage: finalStage,
            conversionStatus: atomicConversion,
            minatProduk: (finalMinatProduk || undefined) as string | undefined,
            lastInsight: data.lastInsight || undefined,
            assignedCsName: data.csName || undefined,
            assignedCsPhone: data.csPhone || undefined,
            rtsRiskScore: data.rtsRiskScore !== undefined ? data.rtsRiskScore : undefined,
            rtsRiskLevel: data.rtsRiskLevel || undefined,
            rtsReasons: data.rtsReasons || undefined,
            courierRecommendation: data.courierRecommendation !== undefined ? data.courierRecommendation : undefined,
            mengantarData: data.mengantarData !== undefined ? data.mengantarData : undefined,
            lastMessageAt: now,
            totalMessages: { increment: 1 },
          },
        });
      });
    }

    // 3. Buat baru jika belum ada
    return prisma.lead.create({
      data: {
        businessId: data.businessId,
        waNumber,
        leadCategory: data.leadCategory || 'NEW_INBOUND',
        score: data.score,
        leadStage: data.stage,
        conversionStatus: data.conversion,
        minatProduk: data.minatProduk || null,
        lastInsight: data.lastInsight || 'Baru masuk via WhatsApp CS',
        assignedCsName: data.csName,
        assignedCsPhone: data.csPhone,
        rtsRiskScore: data.rtsRiskScore ?? 0,
        rtsRiskLevel: data.rtsRiskLevel || 'LOW',
        rtsReasons: data.rtsReasons || [],
        courierRecommendation: data.courierRecommendation || null,
        mengantarData: data.mengantarData || undefined,
        lastMessageAt: now,
        totalMessages: 1,
      },
    });
  }

  /**
   * Ambil daftar lead dengan pagination dan filter.
   */
  static async listLeads(params: LeadFilterParams) {
    const page = Math.max(1, params.page || 1);
    const limit = Math.min(100, Math.max(1, params.limit || 20));
    const skip = (page - 1) * limit;

    const where: any = {
      businessId: params.businessId,
    };

    if (params.leadCategory && params.leadCategory !== 'ALL') {
      where.leadCategory = params.leadCategory;
    }
    if (params.stage && params.stage !== 'ALL') {
      where.leadStage = params.stage;
    }
    if (params.conversion && params.conversion !== 'ALL') {
      where.conversionStatus = params.conversion;
    }
    if (params.rtsLevel && params.rtsLevel !== 'ALL') {
      where.rtsRiskLevel = params.rtsLevel;
    }
    if (params.csPhone) {
      where.assignedCsPhone = params.csPhone;
    }
    if (params.csName && params.csName !== 'ALL') {
      where.assignedCsName = params.csName;
    }
    if (params.search) {
      const q = params.search.trim();
      where.OR = [
        { waNumber: { contains: q, mode: 'insensitive' } },
        { minatProduk: { contains: q, mode: 'insensitive' } },
        { lastInsight: { contains: q, mode: 'insensitive' } },
        { assignedCsName: { contains: q, mode: 'insensitive' } },
      ];
    }

    const dateFilter = parseWibDateFilter(params.startDate, params.endDate);
    if (dateFilter) {
      where.lastMessageAt = dateFilter;
    }

    const [total, items] = await Promise.all([
      prisma.lead.count({ where }),
      prisma.lead.findMany({
        where,
        orderBy: { lastMessageAt: 'desc' },
        skip,
        take: limit,
      }),
    ]);

    return {
      items,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  /**
   * Ambil semua lead untuk Export CSV / Excel tanpa pagination limit.
   */
  static async getAllForExport(params: LeadFilterParams) {
    const where: any = {
      businessId: params.businessId,
    };

    if (params.leadCategory && params.leadCategory !== 'ALL') {
      where.leadCategory = params.leadCategory;
    }
    if (params.stage && params.stage !== 'ALL') {
      where.leadStage = params.stage;
    }
    if (params.conversion && params.conversion !== 'ALL') {
      where.conversionStatus = params.conversion;
    }
    if (params.rtsLevel && params.rtsLevel !== 'ALL') {
      where.rtsRiskLevel = params.rtsLevel;
    }
    if (params.csPhone) {
      where.assignedCsPhone = params.csPhone;
    }
    if (params.csName && params.csName !== 'ALL') {
      where.assignedCsName = params.csName;
    }
    if (params.search) {
      const q = params.search.trim();
      where.OR = [
        { waNumber: { contains: q, mode: 'insensitive' } },
        { minatProduk: { contains: q, mode: 'insensitive' } },
        { lastInsight: { contains: q, mode: 'insensitive' } },
        { assignedCsName: { contains: q, mode: 'insensitive' } },
      ];
    }
    const dateFilter = parseWibDateFilter(params.startDate, params.endDate);
    if (dateFilter) {
      where.lastMessageAt = dateFilter;
    }

    return prisma.lead.findMany({
      where,
      orderBy: { lastMessageAt: 'desc' },
      take: 10000, // safety cap
    });
  }

  /**
   * Hitung agregat ringkas untuk Summary Cards (opsional dengan filter tanggal & CS).
   */
  static async getStats(
    businessId: string,
    startDate?: string,
    endDate?: string,
    csPhone?: string,
    csName?: string,
    leadCategory?: string,
  ): Promise<LeadSummaryStats> {
    const where: any = { businessId };

    if (leadCategory && leadCategory !== 'ALL') {
      where.leadCategory = leadCategory;
    }
    if (csPhone) {
      where.assignedCsPhone = csPhone;
    }
    if (csName && csName !== 'ALL') {
      where.assignedCsName = csName;
    }

    const dateFilter = parseWibDateFilter(startDate, endDate);
    if (dateFilter) {
      where.lastMessageAt = dateFilter;
    }

    const [total, hot, warm, cold, closing, pending, lost, highRiskRts, rtsAggregate] = await Promise.all([
      prisma.lead.count({ where }),
      prisma.lead.count({ where: { ...where, leadStage: { in: ['HOT', 'VERY_HOT'] } } }),
      prisma.lead.count({ where: { ...where, leadStage: 'WARM' } }),
      prisma.lead.count({ where: { ...where, leadStage: 'COLD' } }),
      prisma.lead.count({ where: { ...where, conversionStatus: 'CLOSING' } }),
      prisma.lead.count({ where: { ...where, conversionStatus: 'PENDING' } }),
      prisma.lead.count({ where: { ...where, conversionStatus: 'LOST' } }),
      prisma.lead.count({ where: { ...where, rtsRiskLevel: 'HIGH' } }),
      prisma.lead.aggregate({
        where: { ...where, rtsRiskScore: { not: null } },
        _avg: { rtsRiskScore: true },
      }),
    ]);

    return {
      totalLeads: total,
      hotLeads: hot,
      warmLeads: warm,
      coldLeads: cold,
      closingLeads: closing,
      pendingLeads: pending,
      lostLeads: lost,
      avgRtsRisk: Math.round(rtsAggregate._avg.rtsRiskScore || 0),
      highRiskRtsLeads: highRiskRts,
    };
  }

  /**
   * Ambil daftar nama CS unik yang ada di database untuk dropdown filter.
   */
  static async getCsList(businessId: string): Promise<{ name: string; phone: string | null }[]> {
    const leads = await prisma.lead.findMany({
      where: {
        businessId,
        assignedCsName: { not: null },
      },
      select: {
        assignedCsName: true,
        assignedCsPhone: true,
      },
      distinct: ['assignedCsName'],
      orderBy: { assignedCsName: 'asc' },
    });

    return leads
      .filter((l) => l.assignedCsName && l.assignedCsName.trim().length > 0)
      .map((l) => ({
        name: l.assignedCsName!,
        phone: l.assignedCsPhone || null,
      }));
  }
}
