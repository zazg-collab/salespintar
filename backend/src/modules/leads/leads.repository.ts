import { prisma } from '../../config/prisma';
import {
  LeadFilterParams,
  LeadStage,
  LeadSummaryStats,
  ConversionStatus,
  isValidSpecificProductName,
} from './dto/lead-profile.dto';
import { LeadScoringEngine } from './lead-scoring.engine';
import { getWibDateRange, parseWibDateTime } from '../../utils/timezone';
import { logger } from '../../utils/logger';
// Fase 44: import dinamis di dalam body fungsi untuk hindari lingkaran import
// (leads.repository → capi.service → capi.queue → bullmq)

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
    confirmedCodAmount?: number | null;
    // Fase 33 (2026-08-19, kelanjutan Fase 32 -- ditemukan pas verifikasi DB Latif wa
    // 6282352029773): guard anti-downgrade CLOSING/REPEAT_ORDER di bawah (Temuan 2.1) punya
    // "buta" yang SAMA persis dgn bug Fase 32 -- tidak bisa bedain "CLOSING lama dari deal LAIN
    // yang sudah kelar" vs "CLOSING sah dari deal yang SAMA yang masih dipantau". Akibatnya
    // Fase 32 sudah benar hitung conversion='PENDING' utk pesanan baru Latif (16 Agustus),
    // tapi nilai itu ketimpa balik jadi 'CLOSING' persis di titik ini. Caller
    // (lead-profiler.service.ts) SUDAH tahu kalau existingLeadData-nya sendiri terminal SEBELUM
    // proses ini mulai (`existingIsTerminalStatus`) -- kalau begitu DAN hasil akhirnya bukan lagi
    // blind carry-forward (krn Fase 32 sudah matikan bypass utk kasus itu, jadi conversion yg
    // sampai kesini SELALU dari bukti genuine: LLM analisis sesi aktif, atau klasifikasi domain
    // after-sales/closing deterministik -- BUKAN noise), maka caller boleh set flag ini `true`
    // supaya guard di bawah tidak menahan penurunan status. Default `false`/`undefined` (flag
    // tidak dikirim) -- proteksi Temuan 2.1 yang lama (sweeper/CS-turn salah baca) TETAP berlaku
    // penuh seperti sebelumnya, TIDAK berubah, utk semua caller yang belum diperbarui.
    allowTerminalDowngrade?: boolean;
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
        ctwaClid: true,        // Fase 44: dipakai untuk action_source CAPI (CTWA vs form)
        capiEventsSent: true,  // Fase 44: dedup — event apa saja yang sudah dikirim
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
        (data.conversion === 'PENDING' || data.conversion === 'LOST') &&
        !data.allowTerminalDowngrade
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

      // Produk carry-over: Jika produk lama sudah spesifik & valid, jangan ditimpa nilai "Umum"
      let cleanMinat = data.minatProduk;
      if (cleanMinat === 'null' || cleanMinat === 'undefined' || cleanMinat === 'none' || cleanMinat === 'n/a') {
        cleanMinat = null;
      }
      let finalMinatProduk = cleanMinat;
      const isNewGeneric = !isValidSpecificProductName(cleanMinat);
      const isOldSpecific = isValidSpecificProductName(existing.minatProduk);

      if (isNewGeneric && isOldSpecific) {
        finalMinatProduk = existing.minatProduk;
      } else if (!isNewGeneric) {
        finalMinatProduk = cleanMinat;
      } else {
        finalMinatProduk = null;
      }


      // SKENARIO A: Lead lama masih dalam proses follow-up / baru chat lanjut -> UPDATE DATA
      const isRepeatOrder = false; // Single Customer Model
      if (!isRepeatOrder) {
        // Fase 44: expose atomicConversion ke outer scope untuk CAPI hook setelah commit
        let atomicConversionOuter: ConversionStatus = finalConversion;

        const updatedLead = await prisma.$transaction(async (tx) => {
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
            (data.conversion === 'PENDING' || data.conversion === 'LOST') &&
            !data.allowTerminalDowngrade
          ) {
            atomicConversion = freshStatus.conversionStatus as ConversionStatus;
          }
          atomicConversionOuter = atomicConversion; // expose ke outer scope

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
              confirmedCodAmount: data.confirmedCodAmount !== undefined ? data.confirmedCodAmount : undefined,
              lastMessageAt: now,
              totalMessages: { increment: 1 },
            },
          });
        });

        // Eksekusi Auto-Match jika form tersubmit SEBELUM chat WA masuk (Skenario Repeat Order / Chat Ulang)
        // MUST RUN BEFORE CAPI HOOK TO ENSURE LEAD HAS FBP/FBC
        await this.matchFormAttribution(data.businessId, waNumber, updatedLead.id);

        // ── Fase 44: CAPI hook (fire-and-forget, error ditangkap di dalam enqueueCapiIfNeeded) ──
        void (async () => {
          try {
            const { enqueueCapiIfNeeded } = await import('../../services/capi.service');
            await enqueueCapiIfNeeded({
              businessId: data.businessId,
              leadId: existing.id,
              waNumber,
              name: (data.name ?? existing.name) || null,
              ctwaClid: (existing as any).ctwaClid ?? null,
              finalLeadCategory: finalLeadCategory as string,
              finalStage,
              prevStage: existing.leadStage,
              atomicConversion: atomicConversionOuter,
              prevConversion: existing.conversionStatus,
              capiEventsSent: ((existing as any).capiEventsSent as string[]) ?? [],
              confirmedCodAmount: data.confirmedCodAmount,
              isNewLead: false,
            });
          } catch (capiErr) {
            logger.error(`[LeadsRepository/CAPI] Hook gagal untuk lead ${existing.id}: ${capiErr}`);
          }
        })();

        return updatedLead;
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
        confirmedCodAmount: data.confirmedCodAmount ?? null,
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
    } else if (upserted) {
    }

    // Eksekusi Auto-Match jika form tersubmit SEBELUM chat WA masuk
    await this.matchFormAttribution(data.businessId, waNumber, upserted.id);

    if (upserted && !(upserted.createdAt && upserted.createdAt.getTime() !== now.getTime())) {
      // ── Fase 44: CAPI Lead event untuk lead baru (fire-and-forget) ──
      void (async () => {
        try {
          const { enqueueCapiIfNeeded } = await import('../../services/capi.service');
          await enqueueCapiIfNeeded({
            businessId: data.businessId,
            leadId: upserted.id,
            waNumber,
            name: data.name || null,
            ctwaClid: null, // dibaca ulang oleh worker saat job diproses
            finalLeadCategory: data.leadCategory || 'NEW_INBOUND',
            finalStage: data.stage,
            prevStage: 'COLD',
            atomicConversion: upserted.conversionStatus,
            prevConversion: 'PENDING',
            capiEventsSent: [],
            confirmedCodAmount: data.confirmedCodAmount,
            isNewLead: true,
          });
        } catch (capiErr) {
          logger.error(`[LeadsRepository/CAPI] Hook new-lead gagal untuk lead ${upserted.id}: ${capiErr}`);
        }
      })();
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
      // Default: filter berdasarkan createdAt (Waktu Lahir Lead) — angka historis stabil, konsisten dg Dashboard CS.
      // Jika filterBy=lastMessageAt (mode "⚡ Update Terbaru"), gunakan lastMessageAt untuk monitoring percakapan aktif.
      if (params.filterBy === 'lastMessageAt') {
        where.lastMessageAt = dateFilter;
      } else {
        where.createdAt = dateFilter;
      }
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
      if (params.filterBy === 'lastMessageAt') {
        where.lastMessageAt = dateFilter;
      } else {
        where.createdAt = dateFilter;
      }
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
    filterBy?: 'createdAt' | 'lastMessageAt',
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
      // Default: createdAt (stabil, konsisten dg Dashboard CS).
      // lastMessageAt hanya untuk mode "⚡ Update Terbaru".
      if (filterBy === 'lastMessageAt') {
        where.lastMessageAt = dateFilter;
      } else {
        where.createdAt = dateFilter;
      }
    }

    const [total, hot, warm, cold, closing, pending, lost, highRiskRts, rtsAggregate] = await Promise.all([
      prisma.lead.count({ where }),
      prisma.lead.count({ where: { ...where, leadStage: { in: ['HOT', 'VERY_HOT'] } } }),
      prisma.lead.count({ where: { ...where, leadStage: 'WARM' } }),
      prisma.lead.count({ where: { ...where, leadStage: 'COLD' } }),
      // Langkah E Fase 27 (Temuan KPI): "Closing Deal" harus menghitung CLOSING +
      // REPEAT_ORDER -- sebelumnya cuma 'CLOSING' persis, jadi pelanggan berulang
      // (kalau/ketika conversionStatus REPEAT_ORDER benar-benar tersimpan) hilang dari KPI.
      prisma.lead.count({ where: { ...where, conversionStatus: { in: ['CLOSING', 'REPEAT_ORDER'] } } }),
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

  // --- FASE 1: Auto-Matching CAPI Attribution ---
  // Audit Fase 46 (2026-08-21): updateMany sekarang memakai filter tanggal yang SAMA
  // dengan findFirst, supaya scope keduanya konsisten. Sebelumnya updateMany tanpa
  // filter tanggal bisa mark record lama (>7 hari) sebagai MATCHED ke leadId yang
  // tidak berkaitan.
  // Fix #5 (Fase 47): tambah warn log ketika attribution tidak ditemukan — sebelumnya
  // ini silent failure, lead jalan tanpa fbp/fbc/eventSourceUrl tanpa ada tanda apapun.
  private static async matchFormAttribution(businessId: string, waNumber: string, leadId: string) {
    const windowStart = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    try {
      const recentAttribution = await prisma.formAttribution.findFirst({
        where: {
          businessId,
          waNumber,
          status: 'PENDING_MATCH',
          createdAt: { gte: windowStart }
        },
        orderBy: { createdAt: 'desc' }
      });

      if (recentAttribution) {
        let extractedCampaignId: string | undefined = undefined;
        let extractedAdId: string | undefined = undefined;
        if (recentAttribution.eventSourceUrl) {
          try {
            const urlObj = new URL(recentAttribution.eventSourceUrl);
            extractedCampaignId = urlObj.searchParams.get('utm_campaign') || undefined;
            // SalesPintar convention: utm_content usually stores the metaAdId
            extractedAdId = urlObj.searchParams.get('utm_content') || undefined;
          } catch (e) {
            // Abaikan jika URL tidak valid
          }
        }

        await prisma.$transaction([
          prisma.lead.update({
            where: { id: leadId },
            data: {
              fbp: recentAttribution.fbp || undefined,
              fbc: recentAttribution.fbc || undefined,
              clientUserAgent: recentAttribution.clientUserAgent || undefined,
              clientIp: recentAttribution.clientIp || undefined,
              eventSourceUrl: recentAttribution.eventSourceUrl || undefined,
              metaCampaignId: extractedCampaignId,
              metaAdId: extractedAdId,
            }
          }),
          prisma.formAttribution.updateMany({
            where: {
              businessId,
              waNumber,
              status: 'PENDING_MATCH',
              createdAt: { gte: windowStart }, // selaraskan dengan scope findFirst
            },
            data: {
              status: 'MATCHED',
              matchedLeadId: leadId,
              matchedAt: new Date()
            }
          })
        ]);
        logger.info(
          `[Attribution] Match sukses: formAttribution ${recentAttribution.id} → leadId=${leadId} ` +
          `(fbp=${!!recentAttribution.fbp} fbc=${!!recentAttribution.fbc} url=${!!recentAttribution.eventSourceUrl})`
        );
      } else {
        // Fix #5: log eksplisit ketika tidak ada attribution — ini bukan error fatal,
        // tapi penting untuk debugging: lead ini tidak akan punya fbp/fbc/eventSourceUrl
        // sehingga CAPI routing mungkin fallback ke default pixel dan data atribusi kurang akurat.
        logger.warn(
          `[Attribution] Tidak ada PENDING_MATCH attribution untuk waNumber=${waNumber} leadId=${leadId} ` +
          `dalam 7 hari terakhir. Lead akan jalan tanpa tracking data.`
        );
      }
    } catch (err) {
      logger.error(`[Attribution] Auto-match gagal untuk leadId=${leadId}: ${err}`);
    }
  }
}
