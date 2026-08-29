import { Router, Request, Response, NextFunction } from 'express';
import { authenticate } from '../middleware/auth';
import { prisma } from '../config/prisma';
import { redisCache } from '../config/redis';
import { env } from '../config/env';
import { toJakartaDateStr } from '../utils/timezone';
import fs from 'fs/promises';
import path from 'path';

const router = Router();

async function getCachedOrFetch<T>(key: string, fetch: () => Promise<T>, ttl = 30): Promise<T> {
  try {
    const cached = await redisCache.get(key);
    if (cached) return JSON.parse(cached);
  } catch {
    // Redis miss or error, continue to fetch
  }
  const data = await fetch();
  try {
    await redisCache.setex(key, ttl, JSON.stringify(data));
  } catch {
    // Ignore Redis cache write error
  }
  return data;
}

// ──────────────────────────────────────────────────────────────────────────────
// GET /api/v1/dashboard/stats
// Ringkasan metrik utama: CS aktif, pesan dipelajari, draft pending, gap, total KB
// ──────────────────────────────────────────────────────────────────────────────
router.get('/stats', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { businessId } = req.user!;
    const cacheKey = `business:${businessId}:dashboard:v2:stats`;

    const stats = await getCachedOrFetch(cacheKey, async () => {
      const todayStr = toJakartaDateStr();
      const today = new Date(`${todayStr}T00:00:00.000+07:00`);

      // 1. Sesi CS Human Learning
      const csSessions = await prisma.csHumanLearningSession.findMany({
        where: { businessId },
        select: {
          status: true,
          totalPairsCaptured: true,
          totalCsReplies: true,
          totalBuyerMessages: true,
          totalFactsSaved: true,
          totalClosingDetected: true,
          totalLostDetected: true,
        },
      });

      const totalCsCount = csSessions.length;
      const activeCsCount = csSessions.filter(s => s.status === 'CONNECTED').length;
      const totalBuyerMessages = csSessions.reduce((acc, s) => acc + (s.totalBuyerMessages || 0), 0);
      const totalCsReplies = csSessions.reduce((acc, s) => acc + (s.totalCsReplies || 0), 0);
      const totalPairsCaptured = csSessions.reduce((acc, s) => acc + (s.totalPairsCaptured || 0), 0);
      const totalClosingDetected = csSessions.reduce((acc, s) => acc + (s.totalClosingDetected || 0), 0);
      const totalLostDetected = csSessions.reduce((acc, s) => acc + (s.totalLostDetected || 0), 0);
      const totalPendingDetected = Math.max(0, totalPairsCaptured - totalClosingDetected - totalLostDetected);
      const totalFactsSaved = csSessions.reduce((acc, s) => acc + (s.totalFactsSaved || 0), 0);

      // 2. Draft AI pending di vault
      let pendingDraftsCount = 0;
      try {
        const draftDir = path.join(env.OBSIDIAN_CS_PATH || '', 'Draft_AI');
        const files = await fs.readdir(draftDir);
        pendingDraftsCount = files.filter(f => f.endsWith('.md')).length;
      } catch {
        pendingDraftsCount = 0;
      }

      // 3. Knowledge Gap (Pertanyaan open / belum terjawab di mined_questions)
      let knowledgeGapCount = 0;
      try {
        knowledgeGapCount = await prisma.minedQuestion.count({
          where: { businessId, status: 'open' },
        });
      } catch {
        knowledgeGapCount = 0;
      }

      // 4. Total Knowledge aktif di database
      let totalKnowledgeCount = 0;
      try {
        totalKnowledgeCount = await prisma.knowledge.count({
          where: { businessId },
        });
      } catch {
        totalKnowledgeCount = 0;
      }

      // 5. LLM Call stats hari ini
      let llmCallsToday = 0;
      let tokensUsedToday = 0;
      try {
        const calls = await prisma.llmCall.aggregate({
          where: {
            businessId,
            createdAt: { gte: today },
          },
          _count: { id: true },
          _sum: {
            promptTokens: true,
            completionTokens: true,
            reasoningTokens: true,
          },
        });
        llmCallsToday = calls._count.id || 0;
        tokensUsedToday = (calls._sum.promptTokens || 0) +
                          (calls._sum.completionTokens || 0) +
                          (calls._sum.reasoningTokens || 0);
      } catch {
        llmCallsToday = 0;
        tokensUsedToday = 0;
      }

      return {
        activeCsCount,
        totalCsCount,
        totalLearnedMessages: totalBuyerMessages + totalCsReplies,
        totalBuyerMessages,
        totalCsReplies,
        totalPairsCaptured,
        totalClosingDetected,
        totalLostDetected,
        totalPendingDetected,
        totalFactsSaved,
        pendingDraftsCount,
        knowledgeGapCount,
        totalKnowledgeCount,
        llmCallsToday,
        tokensUsedToday,
      };
    }, 15);

    res.json(stats);
  } catch (err) { next(err); }
});

// ──────────────────────────────────────────────────────────────────────────────
// GET /api/v1/dashboard/human-learning
// Detail performa tiap CS + grafik aktivitas belajar (mendukung filter tanggal)
// ──────────────────────────────────────────────────────────────────────────────
router.get('/human-learning', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { businessId } = req.user!;
    const rawStart = req.query.startDate as string;
    const rawEnd = req.query.endDate as string;

    let start = new Date();
    let end = new Date();

    if (rawStart && rawEnd) {
      start = new Date(rawStart);
      end = new Date(rawEnd);
      if (isNaN(start.getTime()) || isNaN(end.getTime())) {
        start = new Date();
        start.setDate(start.getDate() - 6);
        end = new Date();
      }
    } else {
      start.setDate(start.getDate() - 6);
    }
    start.setHours(0, 0, 0, 0);
    end.setHours(23, 59, 59, 999);

    const startStr = toJakartaDateStr(start);
    const endStr = toJakartaDateStr(end);
    const cacheKey = `business:${businessId}:dashboard:v2:hl:${startStr}:${endStr}`;

    const data = await getCachedOrFetch(cacheKey, async () => {
      const sessions = await prisma.csHumanLearningSession.findMany({
        where: { businessId },
        select: {
          id: true,
          csName: true,
          csPhone: true,
          status: true,
          totalBuyerMessages: true,
          totalCsReplies: true,
          totalPairsCaptured: true,
          totalClosingDetected: true,
          totalLostDetected: true,
          totalFactsSaved: true,
          totalDocsWritten: true,
          lastSeenAt: true,
          linkedAt: true,
        },
        orderBy: { totalPairsCaptured: 'desc' },
      });

      // Buat daftar tanggal dalam rentang start -> end berbasis WIB
      const dateList: string[] = [];
      const curr = new Date(start);
      while (toJakartaDateStr(curr) <= endStr) {
        dateList.push(toJakartaDateStr(curr));
        curr.setDate(curr.getDate() + 1);
      }

      const formattedSessions = await Promise.all(
        sessions.map(async (s) => {
          let pairs = 0;
          let closing = 0;
          let lost = 0;
          let pending = 0;
          let buyerMsgs = 0;
          let csReplies = 0;
          let factsSaved = 0;
          let respTimeSec = 0;
          let respCount = 0;
          let fastRespCount = 0;
          let uniqueBuyers = 0;
          let hasDailyData = false;

          for (const dateStr of dateList) {
            try {
              const [p, c, l, pend, b, cs, f, rSec, rCnt, fCnt, uniq, cSet, lSet, pSet] = await Promise.all([
                redisCache.get(`hl:cs_daily:${s.id}:${dateStr}:pairs`),
                redisCache.get(`hl:cs_daily:${s.id}:${dateStr}:closing`),
                redisCache.get(`hl:cs_daily:${s.id}:${dateStr}:lost`),
                redisCache.get(`hl:cs_daily:${s.id}:${dateStr}:pending`),
                redisCache.get(`hl:cs_daily:${s.id}:${dateStr}:buyer`),
                redisCache.get(`hl:cs_daily:${s.id}:${dateStr}:cs`),
                redisCache.get(`hl:cs_daily:${s.id}:${dateStr}:facts`),
                redisCache.get(`hl:cs_daily:${s.id}:${dateStr}:resp_time_sec`),
                redisCache.get(`hl:cs_daily:${s.id}:${dateStr}:resp_count`),
                redisCache.get(`hl:cs_daily:${s.id}:${dateStr}:fast_resp_count`),
                // SCARD: jumlah unique contactJid di SET hari ini
                redisCache.scard(`hl:cs_uniq:${s.id}:${dateStr}`),
                redisCache.scard(`hl:cs_daily:${s.id}:${dateStr}:set_closing`),
                redisCache.scard(`hl:cs_daily:${s.id}:${dateStr}:set_lost`),
                redisCache.scard(`hl:cs_daily:${s.id}:${dateStr}:set_pending`),
              ]);

              const dailyClosing = (typeof cSet === 'number' && cSet > 0) ? cSet : parseInt(c || '0', 10);
              const dailyLost    = (typeof lSet === 'number' && lSet > 0) ? lSet : parseInt(l || '0', 10);
              const dailyPending = (typeof pSet === 'number' && pSet > 0) ? pSet : parseInt(pend || '0', 10);

              if (p || c || l || pend || b || cs || f || rSec || rCnt || cSet || lSet || pSet) hasDailyData = true;
              pairs += parseInt(p || '0', 10);
              closing += dailyClosing;
              lost += dailyLost;
              pending += dailyPending;
              buyerMsgs += parseInt(b || '0', 10);
              csReplies += parseInt(cs || '0', 10);
              factsSaved += parseInt(f || '0', 10);
              respTimeSec += parseInt(rSec || '0', 10);
              respCount += parseInt(rCnt || '0', 10);
              fastRespCount += parseInt(fCnt || '0', 10);
              // SCARD returns number directly (ioredis), not string
              uniqueBuyers += typeof uniq === 'number' ? uniq : parseInt(String(uniq || '0'), 10);
            } catch {}
          }

          if (!hasDailyData) {
            pairs = 0;
            closing = 0;
            lost = 0;
            pending = 0;
            buyerMsgs = 0;
            csReplies = 0;
            factsSaved = 0;
          }

          // Fix #3: Ganti KEYS (blocking O(N)) ke SCAN iteratif.
          // KEYS memblokir seluruh event loop Redis selama scan — di production
          // dengan ribuan key, ini menyebabkan latency spike pada semua perintah
          // Redis lain yang sedang antri. SCAN membaca dalam potongan kecil tanpa
          // memblokir, tapi butuh beberapa round-trip. Trade-off ini masuk akal
          // untuk data yang di-cache 15 detik.
          let activeBuffers = 0;
          try {
            let cursor = '0';
            const pattern = `hl:buf:${businessId}:${s.csPhone}:*`;
            do {
              const [nextCursor, keys] = await redisCache.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
              activeBuffers += keys.length;
              cursor = nextCursor;
            } while (cursor !== '0');
          } catch {}

          // Ambil metrik SSOT langsung dari tabel PostgreSQL (prisma.lead)
          const startWib = new Date(`${startStr}T00:00:00.000+07:00`);
          const endWib = new Date(`${endStr}T23:59:59.999+07:00`);

          const csWhere: any = {
            businessId,
            OR: [
              { assignedCsPhone: s.csPhone },
              { assignedCsName: { contains: s.csName, mode: 'insensitive' } },
            ],
            lastMessageAt: { gte: startWib, lte: endWib },
          };

          let dbUniqueBuyers = 0;
          let cappedClosing = 0;
          let cappedLost = 0;
          let effectivePending = 0;
          let solidClosing = 0;
          let atRiskClosing = 0;
          let adLeadsCreated = 0;
          let cohortClosing = 0;
          let cohortClosingRate = 0;
          let sameDayClosing = 0;
          let followUpClosing = 0;

          // Reason strings yang merupakan false positive untuk CLOSING leads (Dimensi A & E).
          // Perbaikan engine (rts-risk.engine.ts) hanya berlaku untuk percakapan baru.
          // Helper ini memastikan data lama di DB juga terklasifikasi benar saat query,
          // tanpa perlu DB migration — cukup deploy ulang backend ke VPS.
          const FALSE_FLAG_REASON_PATTERNS = [
            'Pembeli tidak memberikan persetujuan eksplisit',
            'CS terlalu terburu-buru menutup pesanan',
            'Pembeli sempat ragu/menolak halus namun tetap diproses kirim',
          ];

          const isGenuinelyAtRisk = (lead: {
            conversionStatus: string;
            rtsRiskLevel: string | null;
            rtsReasons: string[];
          }): boolean => {
            if (lead.conversionStatus !== 'CLOSING') return false;
            if (lead.rtsRiskLevel === 'LOW' || !lead.rtsRiskLevel) return false;
            // MEDIUM/HIGH: cek apakah semua alasannya hanya false-flag lama
            const genuineReasons = (lead.rtsReasons || []).filter(
              (r) => !FALSE_FLAG_REASON_PATTERNS.some((fp) => r.includes(fp))
            );
            // Kalau setelah false-flag dihapus tidak ada sisa alasan nyata → ini solid, bukan at-risk
            return genuineReasons.length > 0;
          };

          try {
            const [csLeads, cohortLeads] = await Promise.all([
              prisma.lead.findMany({
                where: csWhere,
                select: {
                  id: true,
                  createdAt: true,
                  conversionStatus: true,
                  rtsRiskLevel: true,
                  rtsReasons: true,
                },
              }),
              prisma.lead.findMany({
                where: {
                  businessId,
                  OR: [
                    { assignedCsPhone: s.csPhone },
                    { assignedCsName: { contains: s.csName, mode: 'insensitive' } },
                  ],
                  createdAt: { gte: startWib, lte: endWib },
                  leadCategory: 'PROSPEK_IKLAN',
                },
                select: {
                  id: true,
                  conversionStatus: true,
                },
              }),
            ]);

            adLeadsCreated = cohortLeads.length;
            cohortClosing = cohortLeads.filter(l => l.conversionStatus === 'CLOSING').length;
            cohortClosingRate = adLeadsCreated > 0 ? Math.round((cohortClosing / adLeadsCreated) * 1000) / 10 : 0;

            if (csLeads.length > 0) {
              dbUniqueBuyers = csLeads.length;
              cappedClosing = csLeads.filter(l => l.conversionStatus === 'CLOSING').length;
              cappedLost = csLeads.filter(l => l.conversionStatus === 'LOST').length;
              effectivePending = csLeads.filter(l => l.conversionStatus === 'PENDING').length;

              sameDayClosing = csLeads.filter(l => l.conversionStatus === 'CLOSING' && l.createdAt >= startWib && l.createdAt <= endWib).length;
              followUpClosing = csLeads.filter(l => l.conversionStatus === 'CLOSING' && l.createdAt < startWib).length;

              // solidClosing: CLOSING yang LOW risk ATAU yang MEDIUM/HIGH tapi semua alasannya false-flag
              solidClosing = csLeads.filter(
                l => l.conversionStatus === 'CLOSING' && !isGenuinelyAtRisk(l as any)
              ).length;
              // atRiskClosing: CLOSING yang benar-benar punya alasan risiko nyata (bukan false-flag)
              atRiskClosing = csLeads.filter(l => isGenuinelyAtRisk(l as any)).length;
            } else {
              const effectiveTotal = hasDailyData ? (uniqueBuyers || pairs) : 0;
              dbUniqueBuyers = effectiveTotal;
              cappedClosing = Math.min(closing, effectiveTotal);
              cappedLost = Math.min(lost, Math.max(0, effectiveTotal - cappedClosing));
              effectivePending = Math.max(0, effectiveTotal - cappedClosing - cappedLost);
              solidClosing = cappedClosing;
              sameDayClosing = cappedClosing;
              followUpClosing = 0;
            }
          } catch {
            dbUniqueBuyers = hasDailyData ? (uniqueBuyers || pairs) : 0;
            cappedClosing = closing;
            cappedLost = lost;
            effectivePending = pending;
            solidClosing = closing;
            sameDayClosing = closing;
            followUpClosing = 0;
          }

          const totalActivity = buyerMsgs + csReplies;
          // 1. Rasio Closing Harian (Cashflow/Yield): Total Closing dibagi Prospek Iklan Masuk
          const adLeadBasis = adLeadsCreated > 0 ? adLeadsCreated : dbUniqueBuyers;
          const closingRate  = adLeadBasis > 0 ? Math.round((cappedClosing  / adLeadBasis) * 1000) / 10 : 0;
          const pendingRate  = dbUniqueBuyers > 0 ? Math.round((effectivePending  / dbUniqueBuyers) * 1000) / 10 : 0;
          const lostRate     = dbUniqueBuyers > 0 ? Math.round((cappedLost     / dbUniqueBuyers) * 1000) / 10 : 0;

          // Waktu Respon & Skor Balasan Realistis WhatsApp CS
          let avgRespMinutes = respCount > 0 ? Math.round((respTimeSec / respCount / 60) * 10) / 10 : 0;
          let avgRespFormatted = '-';
          let responseScore: number | null = null;
          let responseRating = '-';

          if (respCount > 0) {
            if (avgRespMinutes < 1) avgRespFormatted = '< 1 mnt';
            else if (avgRespMinutes < 60) avgRespFormatted = `${avgRespMinutes} mnt`;
            else avgRespFormatted = `${Math.round((avgRespMinutes / 60) * 10) / 10} jam`;

            // Formula Skor: Terbobot antara Kecepatan Rata-rata (60%) dan Rasio Fast Reply <=3 mnt (40%)
            const fastRatio = Math.min(1, Math.max(0, fastRespCount / respCount));
            let speedScore = 100;
            if (avgRespMinutes > 60) speedScore = 20;
            else if (avgRespMinutes > 30) speedScore = 40;
            else if (avgRespMinutes > 15) speedScore = 60;
            else if (avgRespMinutes > 7)  speedScore = 75;
            else if (avgRespMinutes > 3)  speedScore = 88;
            else if (avgRespMinutes > 1)  speedScore = 95;
            else speedScore = 100;

            responseScore = Math.min(100, Math.max(10, Math.round(speedScore * 0.6 + fastRatio * 100 * 0.4)));

            if (responseScore >= 90) responseRating = 'Sangat Cepat';
            else if (responseScore >= 75) responseRating = 'Cepat';
            else if (responseScore >= 60) responseRating = 'Cukup Cepat';
            else if (responseScore >= 40) responseRating = 'Perlu Ditingkatkan';
            else responseRating = 'Lambat';
          } else if (buyerMsgs > 0 || csReplies > 0) {
            // Fallback Respon Berbasis Aktivitas Chat Riil CS:
            // Jika data detil per detik belum sempat tersimpan di Redis (mis. histori chat atau restart),
            // hitung estimasi responsivitas CS dari rasio keaktifan membalas chat pembeli.
            const replyRatio = buyerMsgs > 0 ? Math.min(1.2, csReplies / buyerMsgs) : (csReplies > 0 ? 1 : 0);
            
            if (csReplies > 0) {
              if (replyRatio >= 0.8) {
                avgRespMinutes = 3.5;
                avgRespFormatted = '< 5 mnt';
                responseScore = Math.min(98, Math.max(82, Math.round(85 + (replyRatio - 0.8) * 30)));
                responseRating = responseScore >= 90 ? 'Sangat Cepat' : 'Cepat';
              } else if (replyRatio >= 0.4) {
                avgRespMinutes = 8.5;
                avgRespFormatted = '5-10 mnt';
                responseScore = Math.round(70 + (replyRatio - 0.4) * 25);
                responseRating = 'Cukup Cepat';
              } else {
                avgRespMinutes = 20;
                avgRespFormatted = '15-30 mnt';
                responseScore = Math.round(50 + replyRatio * 30);
                responseRating = 'Perlu Ditingkatkan';
              }
            } else if (buyerMsgs > 0) {
              avgRespMinutes = 65.0;
              avgRespFormatted = '> 1 jam';
              responseScore = 25;
              responseRating = 'Lambat';
            }
          }

          return {
            ...s,
            totalBuyerMessages: buyerMsgs,
            totalCsReplies: csReplies,
            totalPairsCaptured: pairs,
            totalClosingDetected: cappedClosing,
            totalLostDetected: cappedLost,
            totalPendingDetected: effectivePending,
            totalFactsSaved: factsSaved,
            totalActivity,
            activeBuffers,
            avgRespMinutes,
            avgRespFormatted,
            responseScore,
            responseRating,
            closingRate,
            cohortClosing,
            cohortClosingRate,
            pendingRate,
            lostRate,
            uniqueBuyers: dbUniqueBuyers,
            adLeadsCreated,
            sameDayClosing,
            followUpClosing,
            solidClosing,
            atRiskClosing,
          };
        }),
      );

      // Ambil riwayat LLM extraction / mining dalam rentang tanggal
      const llmLogs = await prisma.llmCall.findMany({
        where: {
          businessId,
          createdAt: { gte: start, lte: end },
        },
        select: {
          job: true,
          createdAt: true,
          promptTokens: true,
          completionTokens: true,
        },
      });

      let dailyMessages: { fromRole: string; createdAt: Date }[] = [];
      try {
        dailyMessages = await prisma.message.findMany({
          where: {
            businessId,
            createdAt: { gte: start, lte: end },
          },
          select: {
            fromRole: true,
            createdAt: true,
          },
        });
      } catch {
        dailyMessages = [];
      }

      const trendMap: Record<string, {
        date: string;
        extractions: number;
        minings: number;
        tokens: number;
        totalContacts: number;
        closing: number;
        pending: number;
        lost: number;
        buyerMessages: number;
        csReplies: number;
      }> = {};

      for (const dateStr of dateList) {
        trendMap[dateStr] = {
          date: dateStr,
          extractions: 0,
          minings: 0,
          tokens: 0,
          totalContacts: 0,
          closing: 0,
          pending: 0,
          lost: 0,
          buyerMessages: 0,
          csReplies: 0,
        };
      }

      for (const log of llmLogs) {
        const dateStr = toJakartaDateStr(log.createdAt);
        if (trendMap[dateStr]) {
          if (log.job === 'extract' || log.job === 'classify' || log.job === 'gatekeeper') trendMap[dateStr].extractions++;
          if (log.job === 'miner' || log.job === 'publish') trendMap[dateStr].minings++;
          trendMap[dateStr].tokens += (log.promptTokens + log.completionTokens);
        }
      }

      for (const msg of dailyMessages) {
        const dateStr = toJakartaDateStr(msg.createdAt);
        if (trendMap[dateStr]) {
          if (msg.fromRole === 'lead' || msg.fromRole === 'buyer' || msg.fromRole === 'user') {
            trendMap[dateStr].buyerMessages++;
          } else {
            trendMap[dateStr].csReplies++;
          }
        }
      }

      // Ambil metrik harian konversi (Total Kontak, Closing, Lost, Pending) dan pesan dari Redis
      for (const dateStr of Object.keys(trendMap)) {
        try {
          const [totalContacts, closing, lost, pending, buyerRedis, csRedis, cSet, lSet, pSet, bizUniq] = await Promise.all([
            redisCache.get(`hl:daily:${businessId}:${dateStr}:total_contacts`),
            redisCache.get(`hl:daily:${businessId}:${dateStr}:closing`),
            redisCache.get(`hl:daily:${businessId}:${dateStr}:lost`),
            redisCache.get(`hl:daily:${businessId}:${dateStr}:pending`),
            redisCache.get(`hl:daily:${businessId}:${dateStr}:buyer`),
            redisCache.get(`hl:daily:${businessId}:${dateStr}:cs`),
            redisCache.scard(`hl:daily:${businessId}:${dateStr}:set_closing`),
            redisCache.scard(`hl:daily:${businessId}:${dateStr}:set_lost`),
            redisCache.scard(`hl:daily:${businessId}:${dateStr}:set_pending`),
            redisCache.scard(`hl:biz_uniq:${businessId}:${dateStr}`),
          ]);

          const cCount = (typeof cSet === 'number' && cSet > 0) ? cSet : parseInt(closing || '0', 10);
          const lCount = (typeof lSet === 'number' && lSet > 0) ? lSet : parseInt(lost || '0', 10);
          const pCount = (typeof pSet === 'number' && pSet > 0) ? pSet : parseInt(pending || '0', 10);
          const tCount = (typeof bizUniq === 'number' && bizUniq > 0) ? bizUniq : (parseInt(totalContacts || '0', 10) || (cCount + lCount + pCount));

          trendMap[dateStr].totalContacts = tCount;
          trendMap[dateStr].closing = cCount;
          trendMap[dateStr].lost = lCount;
          trendMap[dateStr].pending = pCount || Math.max(0, tCount - cCount - lCount);

          if (buyerRedis) trendMap[dateStr].buyerMessages += parseInt(buyerRedis, 10);
          if (csRedis) trendMap[dateStr].csReplies += parseInt(csRedis, 10);
        } catch {
          // ignore redis error
        }
      }

      // Hitung ringkasan insight eksekutif untuk CEO & Skor Integritas Tim
      const executiveInsights: string[] = [];
      let totalSolidAll = 0;
      let totalClosingAll = 0;
      let totalAtRiskAll = 0;

      for (const s of formattedSessions) {
        totalSolidAll += s.solidClosing || 0;
        totalClosingAll += s.totalClosingDetected || 0;
        totalAtRiskAll += s.atRiskClosing || 0;

        const totalCSDeals = s.totalClosingDetected || 0;
        if (totalCSDeals > 0) {
          if (s.atRiskClosing > 0) {
            const riskPct = Math.round((s.atRiskClosing / totalCSDeals) * 100);
            executiveInsights.push(
              `CS ${s.csName} mencatat ${totalCSDeals}x closing (${s.closingRate}% konversi), dengan ${s.solidClosing}x Solid dan ${s.atRiskClosing}x Perlu Validasi (${riskPct}% terdeteksi memiliki rekam jejak retur logistik pembeli atau alamat minim patokan). Disarankan validasi kurir sebelum resi dicetak.`
            );
          } else {
            executiveInsights.push(
              `CS ${s.csName} mempertahankan 100% Integritas Closing (${s.solidClosing} transaksi terverifikasi aman dengan komitmen COD jelas).`
            );
          }
        }
      }

      const teamIntegrityScore = totalClosingAll > 0 
        ? Math.round((totalSolidAll / Math.max(1, totalSolidAll + totalAtRiskAll)) * 100) 
        : 100;

      return {
        startDate: startStr,
        endDate: endStr,
        sessions: formattedSessions,
        trends: Object.values(trendMap),
        executiveInsights,
        teamIntegrityScore,
      };
    }, 15);

    res.json(data);
  } catch (err) { next(err); }
});

// ──────────────────────────────────────────────────────────────────────────────
// GET /api/v1/dashboard/frequent-questions
// Daftar pertanyaan paling sering muncul beserta status coverage
// ──────────────────────────────────────────────────────────────────────────────
router.get('/frequent-questions', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { businessId } = req.user!;
    const limit = Math.min(parseInt(req.query.limit as string) || 15, 50);
    const cacheKey = `business:${businessId}:dashboard:v2:fq:${limit}`;

    const data = await getCachedOrFetch(cacheKey, async () => {
      const questions = await prisma.minedQuestion.findMany({
        where: { businessId, status: { in: ['open', 'answered', 'published'] } },
        orderBy: [
          { occurrences: 'desc' },
          { createdAt: 'desc' },
        ],
        take: limit,
        select: {
          id: true,
          question: true,
          sampleRaw: true,
          occurrences: true,
          category: true,
          status: true,
          answer: true,
          vaultPath: true,
          createdAt: true,
        },
      });

      const items = questions.map(q => ({
        id: q.id,
        question: q.question,
        sampleRaw: q.sampleRaw,
        occurrences: q.occurrences,
        category: q.category,
        status: q.status,
        isCovered: q.status === 'answered' || q.status === 'published' || (!!q.answer && q.answer.trim().length > 0) || !!q.vaultPath,
        vaultPath: q.vaultPath,
        createdAt: q.createdAt,
      }));

      const totalCount = await prisma.minedQuestion.count({
        where: { businessId, status: { in: ['open', 'answered', 'published'] } },
      });
      const coveredCount = await prisma.minedQuestion.count({
        where: {
          businessId,
          status: { in: ['open', 'answered', 'published'] },
          OR: [
            { status: { in: ['answered', 'published'] } },
            { answer: { not: null } },
            { vaultPath: { not: null } },
          ],
        },
      });
      const uncoveredCount = Math.max(0, totalCount - coveredCount);

      return {
        items,
        totalQuestions: totalCount,
        uncoveredCount,
        coveredCount,
      };
    }, 10);

    res.json(data);
  } catch (err) { next(err); }
});

// ──────────────────────────────────────────────────────────────────────────────
// GET /api/v1/dashboard/recent-drafts
// 5 Draf SOP/Fakta terbaru di Draft_AI
// ──────────────────────────────────────────────────────────────────────────────
router.get('/recent-drafts', authenticate, async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const draftDir = path.join(env.OBSIDIAN_CS_PATH || '', 'Draft_AI');
    let entries: string[] = [];
    try {
      entries = await fs.readdir(draftDir);
    } catch {
      res.json({ drafts: [] });
      return;
    }

    const mdFiles = entries.filter(f => f.endsWith('.md')).slice(0, 8);
    const drafts = await Promise.all(
      mdFiles.map(async (filename) => {
        const filePath = path.join(draftDir, filename);
        const raw = await fs.readFile(filePath, 'utf-8');
        const stat = await fs.stat(filePath);

        const fmMatch = raw.match(/^---\n([\s\S]*?)\n---/);
        const fm: Record<string, string> = {};
        if (fmMatch) {
          fmMatch[1].split('\n').forEach(line => {
            const [k, ...v] = line.split(': ');
            if (k && v.length) fm[k.trim()] = v.join(': ').replace(/^"|"$/g, '').trim();
          });
        }

        const bodyContent = raw.replace(/^---[\s\S]*?---\n*/, '').trim();

        return {
          filename,
          title: fm.title || filename.replace(/^\d{8}-/, '').replace(/\.md$/, '').replace(/-/g, ' '),
          category: fm.category || 'SOP',
          source: fm.source || 'human_learning',
          created: stat.mtime.toISOString(),
          preview: bodyContent.slice(0, 150),
        };
      }),
    );

    // Urutkan yang terbaru di atas
    drafts.sort((a, b) => new Date(b.created).getTime() - new Date(a.created).getTime());

    res.json({ drafts: drafts.slice(0, 5) });
  } catch (err) { next(err); }
});

// ──────────────────────────────────────────────────────────────────────────────
// GET /api/v1/dashboard/knowledge-distribution
// Distribusi jumlah berkas Produk, SOP, FAQ, dan Draft
// ──────────────────────────────────────────────────────────────────────────────
router.get('/knowledge-distribution', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { businessId } = req.user!;
    const cacheKey = `business:${businessId}:dashboard:v2:dist`;

    const dist = await getCachedOrFetch(cacheKey, async () => {
      const vaultRoot = env.OBSIDIAN_CS_PATH || '';

      const countFolder = async (sub: string) => {
        try {
          const files = await fs.readdir(path.join(vaultRoot, sub));
          return files.filter(f => f.endsWith('.md')).length;
        } catch {
          return 0;
        }
      };

      const [produk, sop, faq, draft] = await Promise.all([
        countFolder('Produk'),
        countFolder('SOP'),
        countFolder('FAQ'),
        countFolder('Draft_AI'),
      ]);

      const totalActive = produk + sop + faq;

      return {
        categories: [
          { name: 'Produk', count: produk, color: '#6366f1' },
          { name: 'SOP', count: sop, color: '#10b981' },
          { name: 'FAQ', count: faq, color: '#f59e0b' },
          { name: 'Draft AI', count: draft, color: '#ec4899' },
        ],
        totalActive,
        totalDraft: draft,
      };
    }, 60);

    res.json(dist);
  } catch (err) { next(err); }
});

export default router;
