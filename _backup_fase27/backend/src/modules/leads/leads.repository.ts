import { prisma } from '../../config/prisma';
import {
  LeadFilterParams,
  LeadStage,
  LeadSummaryStats,
  ConversionStatus,
} from './dto/lead-profile.dto';
import { LeadScoringEngine } from './lead-scoring.engine';
import { getWibDateRange, parseWibDateTime } from '../../utils/timezone';
import { logger } from '../../utils/logger';

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
    name?: string | null;
    csPhone: string;
    csName?: string;
    leadCategory?: 'PROSPEK_IKLAN' | 'NEW_INBOUND' | 'OTHERS';
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
    objectionType?: string | null;
    taktikCS?: string | null;
    draftWA?: string | null;
  }) {
    const waNumber = this.sanitizeWaNumber(data.rawJid);
    if (!waNumber || !data.businessId) return null;

    const now = data.messageTimestamp ? parseWibDateTime(data.messageTimestamp) : new Date();

    // 1. Cari record yang sudah ada (Ambil yang PALING BARU)
    const existing = await prisma.lead.findFirst({
      where: {
        businessId: data.businessId,
        waNumber,
      },
      orderBy: {
        createdAt: 'desc',
      },
      select: {
        id: true,
        name: true,
        createdAt: true,
        lastMessageAt: true,
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
      // Status closing/repeat-order: jangan ditimpa PENDING ataupun LOST (Temuan 2.1 —
      // sebelumnya guard ini cuma menahan PENDING & cuma untuk CLOSING; Ronde Penyanggal
      // Langkah A menemukan REPEAT_ORDER TIDAK ikut terlindungi padahal di tempat lain
      // (lead-profiler.service.ts) CLOSING & REPEAT_ORDER selalu diperlakukan setara).
      // PENTING: guard ini dihitung DULU, SEBELUM isLost — supaya skor/stage lead yang
      // statusnya berhasil "diselamatkan" tidak ikut dipaksa turun ke COLD (sebelumnya
      // isLost dihitung dari data.conversion mentah sebelum guard sempat berlaku).
      let finalConversion = data.conversion;
      if (
        (existing.conversionStatus === 'CLOSING' || existing.conversionStatus === 'REPEAT_ORDER') &&
        (data.conversion === 'PENDING' || data.conversion === 'LOST')
      ) {
        finalConversion = existing.conversionStatus as ConversionStatus;
      }

      // 2. Hitung Stage & Score dengan Anti-Downgrade (Temuan 2.1: pakai finalConversion, bukan data.conversion mentah)
      const isLost = finalConversion === 'LOST';
      const { finalStage, finalScore } = LeadScoringEngine.resolveNextStage(
        (existing.leadStage as LeadStage) || 'COLD',
        existing.score || 0,
        data.stage,
        data.score,
        isLost,
      );

      // Kategori carry-over: Jika sudah ada kategori yang lebih tinggi (PROSPEK_IKLAN > NEW_INBOUND > OTHERS), pertahankan agar chat lanjutan tidak menurunkan status lead
      let finalLeadCategory = data.leadCategory || existing.leadCategory;
      if (existing.leadCategory === 'PROSPEK_IKLAN' && (data.leadCategory === 'OTHERS' || data.leadCategory === 'NEW_INBOUND')) {
        finalLeadCategory = 'PROSPEK_IKLAN';
      } else if (existing.leadCategory === 'NEW_INBOUND' && data.leadCategory === 'OTHERS') {
        finalLeadCategory = 'NEW_INBOUND';
      }

      // Produk carry-over: Jika produk lama sudah spesifik, jangan ditimpa nilai "Umum"
      let cleanMinat = data.minatProduk;
      if (cleanMinat === 'null' || cleanMinat === 'undefined' || cleanMinat === 'none' || cleanMinat === 'n/a') {
        cleanMinat = null;
      }
      let finalMinatProduk = cleanMinat;
      const isNewGeneric = !cleanMinat || 
        cleanMinat.toLowerCase().includes('umum') || 
        cleanMinat.toLowerCase().includes('belum spesifik');
      const isOldSpecific = existing.minatProduk && 
        existing.minatProduk !== 'null' &&
        existing.minatProduk !== 'undefined' &&
        !existing.minatProduk.toLowerCase().includes('umum') && 
        !existing.minatProduk.toLowerCase().includes('belum spesifik');

      if (isNewGeneric && isOldSpecific) {
        finalMinatProduk = existing.minatProduk;
      }

      // SKENARIO A: Lead lama masih dalam proses follow-up / baru chat lanjut -> UPDATE DATA
      const isRepeatOrder = false; // Single Customer Model
      if (!isRepeatOrder) {
        return prisma.$transaction(async (tx) => {
          // Re-read status konversi terkini di dalam transaksi (atomic read)
          const freshStatus = await tx.lead.findUnique({
            where: { id: existing.id },
            select: { conversionStatus: true, name: true },
          });

          // Anti-downgrade: jika DB saat ini CLOSING/REPEAT_ORDER dan request baru mau
          // turunkan ke PENDING ataupun LOST, tolak (Temuan 2.1 — re-check atomik di dalam
          // transaksi ini juga sebelumnya cuma menahan PENDING & cuma untuk CLOSING).
          let atomicConversion = finalConversion;
          if (
            (freshStatus?.conversionStatus === 'CLOSING' || freshStatus?.conversionStatus === 'REPEAT_ORDER') &&
            (data.conversion === 'PENDING' || data.conversion === 'LOST')
          ) {
            atomicConversion = freshStatus.conversionStatus as ConversionStatus;
          }

          const finalName = data.name || freshStatus?.name || existing.name || undefined;

          return tx.lead.update({
            where: { id: existing.id },
            data: {
              name: finalName,
              score: finalScore,
              leadCategory: finalLeadCategory as any,
              leadStage: finalStage,
              conversionStatus: atomicConversion,
              minatProduk: (finalMinatProduk || undefined) as string | undefined,
              lastInsight: data.lastInsight || undefined,
              objectionType: data.objectionType || undefined,
              taktikCS: data.taktikCS || undefined,
              draftWA: data.draftWA || undefined,
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
    }

    // 3. Buat baru jika belum ada (atau jika Skenario B/C memicu pembuatan baris baru)
    let initialConversion = data.conversion;
    const initialLabels: string[] = [];
    if (existing && (existing.conversionStatus === 'CLOSING' || existing.conversionStatus === 'REPEAT_ORDER')) {
      if (data.conversion === 'CLOSING' || data.conversion === 'REPEAT_ORDER') {
        initialConversion = 'REPEAT_ORDER';
        initialLabels.push('REPEAT_ORDER');
      }
    }

    // Temuan 1.1/1.2: `findFirst` di langkah 1 lalu `create` di sini (bukan upsert atomik)
    // membuka celah race — Opsi A (real-time) dan Opsi B (sweeper 7x/hari) bisa sama-sama
    // lolos findFirst dengan hasil "belum ada lead" lalu SAMA-SAMA create, menghasilkan DUA
    // baris `leads` untuk kontak yang sama. `upsert` di atas constraint unik
    // (businessId, waNumber) — lihat schema.prisma & migrasi terkait — menutup celah ini
    // di level database, bukan cuma di level aplikasi.
    const upserted = await prisma.lead.upsert({
      where: {
        businessId_waNumber: {
          businessId: data.businessId,
          waNumber,
        },
      },
      create: {
        businessId: data.businessId,
        waNumber,
        labels: initialLabels,
        leadCategory: data.leadCategory || 'NEW_INBOUND',
        score: data.score,
        leadStage: data.stage,
        conversionStatus: initialConversion,
        minatProduk: (data.minatProduk && data.minatProduk !== 'null' && data.minatProduk !== 'undefined' && data.minatProduk !== 'none') ? data.minatProduk : null,
        lastInsight: data.lastInsight || 'Baru masuk via WhatsApp CS',
        objectionType: data.objectionType || null,
        taktikCS: data.taktikCS || null,
        draftWA: data.draftWA || null,
        assignedCsName: data.csName,
        assignedCsPhone: data.csPhone,
        rtsRiskScore: data.rtsRiskScore ?? 0,
        rtsRiskLevel: data.rtsRiskLevel || 'LOW',
        rtsReasons: data.rtsReasons || [],
        courierRecommendation: data.courierRecommendation || null,
        mengantarData: data.mengantarData || undefined,
        createdAt: now,
        lastMessageAt: now,
        totalMessages: 1,
      },
      update: {
        // Race Opsi A vs Opsi B: baris untuk kontak ini ternyata SUDAH dibuat oleh proses
        // lain tepat di antara findFirst di langkah 1 dan upsert ini. Constraint unik
        // menjamin tidak ada baris duplikat — tapi kita SENGAJA TIDAK menimpa hasil analisis
        // proses lain di sini (race window sempit & jarang; kita tidak punya state
        // pre-image proses lain untuk dibandingkan secara aman seperti di jalur update
        // transaksional di atas). Cukup catat bahwa ada follow-up message masuk.
        lastMessageAt: now,
        totalMessages: { increment: 1 },
      },
    });

    // Ronde Penyanggal Langkah A (TERBUKTI TAPI DILEBIH-LEBIHKAN — window race lebih sempit
    // dari klaim awal karena sweeper terbukti skip kontak baru, tapi tetap mungkin lewat
    // retry/duplicate webhook): cabang `update` di atas SENGAJA tidak menimpa hasil analisis
    // pesan ini. Supaya kejadian ini tidak diam-diam hilang dari observability, catat log
    // kalau ternyata upsert jatuh ke cabang update (createdAt tidak sama dengan `now` berarti
    // baris ini sudah ada sebelumnya, bukan baru dibuat oleh panggilan ini).
    if (upserted && upserted.createdAt && upserted.createdAt.getTime() !== now.getTime()) {
      logger.warn(
        `[LeadsRepository] upsertLeadProfile race: lead ${data.businessId}/${waNumber} ternyata sudah ada saat coba dibuat baru. Analisis pesan ini (score/stage/conversion/lastInsight) TIDAK diterapkan, hanya totalMessages & lastMessageAt yang diperbarui.`,
      );
    }

    return upserted;
  }

  /**
   * Ambil daftar lead dengan pagination dan filter.
   */
  static async listLeads(params: LeadFilterParams) {
    const page = Math.max(1, params.page || 1);
    const limit = Math.min(100, Math.max(1, params.limit || 50));
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
    if (params.conversion === 'REPEAT_ORDER') {
      where.OR = [
        { conversionStatus: 'REPEAT_ORDER' },
        { labels: { has: 'REPEAT_ORDER' } },
      ];
    } else if (params.conversion && params.conversion !== 'ALL') {
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

    const dateFilter = getWibDateRange(params.startDate, params.endDate);
    if (dateFilter) {
      where.lastMessageAt = dateFilter;
    }

    const sortField = params.sortBy === 'createdAt' ? 'createdAt' : 'lastMessageAt';
    const sortDir = params.sortOrder === 'asc' ? 'asc' : 'desc';

    const [total, items] = await Promise.all([
      prisma.lead.count({ where }),
      prisma.lead.findMany({
        where,
        orderBy: { [sortField]: sortDir },
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
    if (params.conversion === 'REPEAT_ORDER') {
      where.OR = [
        { conversionStatus: 'REPEAT_ORDER' },
        { labels: { has: 'REPEAT_ORDER' } },
      ];
    } else if (params.conversion && params.conversion !== 'ALL') {
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
    const dateFilter = getWibDateRange(params.startDate, params.endDate);
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

    const dateFilter = getWibDateRange(startDate, endDate);
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
