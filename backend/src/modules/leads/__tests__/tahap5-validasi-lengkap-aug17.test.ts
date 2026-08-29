/**
 * Tahap 5 — Uji Validasi Output pada Data Riil (2026-08-18).
 *
 * Menjalankan `LeadProfilerService.processConversation()` PENUH (bukan cuma fungsi murni parsial)
 * terhadap 61 percakapan riil dataset forensik 17 Agustus 2026, membandingkan hasilnya dengan
 * state "Before" (snapshot produksi asli, sebelum Langkah A-E dikerjakan) yang sudah dibekukan di
 * `leads-aug17-transcripts.json`.
 *
 * KEAMANAN — TIDAK menyentuh DB/Redis produksi:
 *   - `config/prisma` & `config/redis` di-mock persis seperti pola yang sudah dipakai di
 *     `lead-profiler.service.test.ts` (lead.findFirst -> null, artinya diproses murni dari
 *     transkrip TANPA bergantung pada riwayat DB yang mungkin sudah lebih dulu "sembuh" krn
 *     sweeper 7x/hari sudah jalan sejak Fase 21-29 dideploy hari ini).
 *   - `LeadsRepository.upsertLeadProfile` di-stub (Proxy, sama seperti test lain) -- TIDAK ADA
 *     baris ditulis ke tabel `leads` manapun (sandbox maupun produksi).
 *   - `services/llm` SENGAJA TIDAK di-mock -- panggilan `complete('classify', ...)` beneran ke
 *     Groq API (pakai GROQ_API_KEY yg sama persis dgn produksi, sudah ada di .env sandbox) supaya
 *     field `lastInsight`/`taktikCS`/`draftWA` yang dihasilkan adalah OUTPUT ASLI ENGINE, bukan
 *     simulasi/reimplementasi manual yang berisiko drift dari logika produksi.
 *   - `prisma.llmCall.create` (audit log pemakaian LLM) di-mock jadi no-op -- tidak menulis baris
 *     apapun ke DB manapun.
 *
 * Hasil ditulis ke /tmp/tahap5_results.json untuk disusun jadi laporan tabel Before/After.
 */
import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';

const {
  mockRedisGet,
  mockRedisSet,
  mockRedisDel,
  mockCsHumanLearningFindFirst,
  mockLeadFindFirst,
  mockLeadDeleteMany,
  mockLeadUpsert,
  mockBusinessFindUnique,
  mockGetReceiverScore,
  mockUpsertLeadProfile,
  mockLlmCallCreate,
  mockLlmCallDeleteMany,
} = vi.hoisted(() => ({
  mockRedisGet: vi.fn(),
  mockRedisSet: vi.fn(),
  mockRedisDel: vi.fn(),
  mockCsHumanLearningFindFirst: vi.fn(),
  mockLeadFindFirst: vi.fn(),
  mockLeadDeleteMany: vi.fn(),
  mockLeadUpsert: vi.fn(),
  mockBusinessFindUnique: vi.fn(),
  mockGetReceiverScore: vi.fn(),
  mockUpsertLeadProfile: vi.fn(),
  mockLlmCallCreate: vi.fn(),
  mockLlmCallDeleteMany: vi.fn(),
}));

vi.mock('../../../config/redis', () => ({
  redisCache: { get: mockRedisGet, set: mockRedisSet, del: mockRedisDel },
}));

vi.mock('../../../config/prisma', () => ({
  prisma: {
    csHumanLearningSession: { findFirst: mockCsHumanLearningFindFirst },
    lead: { findFirst: mockLeadFindFirst, deleteMany: mockLeadDeleteMany, upsert: mockLeadUpsert },
    business: { findUnique: mockBusinessFindUnique },
    llmCall: { create: mockLlmCallCreate, deleteMany: mockLlmCallDeleteMany },
  },
}));

// SENGAJA TIDAK di-mock: '../../../services/llm' -- ingin panggilan complete() beneran ke Groq.

vi.mock('../../../services/mengantar.service', () => ({
  MengantarService: { getReceiverScore: mockGetReceiverScore },
}));

vi.mock('../../../utils/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../leads.repository', async (importOriginal) => {
  const actual: any = await importOriginal();
  const RealLeadsRepository = actual.LeadsRepository;
  const LeadsRepository = new Proxy(RealLeadsRepository, {
    get(target, prop, receiver) {
      if (prop === 'upsertLeadProfile') return mockUpsertLeadProfile;
      return Reflect.get(target, prop, receiver);
    },
  });
  return { ...actual, LeadsRepository };
});

import { LeadProfilerService } from '../lead-profiler.service';

interface ForensicEntry {
  wa: string;
  cs: string;
  time: string;
  cls: string;
  name: string;
  product: string;
  total_cod: string;
  full_text: string;
}

interface BeforeEntry {
  wa: string;
  name: string | null;
  current_status: string;
  current_category: string;
  produk: string | null;
  insight: string | null;
}

describe('Tahap 5 — Validasi Output Riil (Before vs After) dataset forensik 17 Agustus 2026', () => {
  it(
    'menjalankan processConversation() penuh utk 61 lead & menulis hasil ke /tmp/tahap5_results.json',
    async () => {
      mockRedisGet.mockResolvedValue(null);
      mockRedisSet.mockResolvedValue('OK');
      mockRedisDel.mockResolvedValue(1);
      mockCsHumanLearningFindFirst.mockResolvedValue(null);
      mockLeadFindFirst.mockResolvedValue(null); // baseline murni dari transkrip, tanpa riwayat DB
      mockLeadDeleteMany.mockResolvedValue({ count: 0 });
      mockLeadUpsert.mockResolvedValue({});
      mockBusinessFindUnique.mockResolvedValue({ mengantarApiKey: null, aiConfig: null });
      mockGetReceiverScore.mockResolvedValue(null);
      mockUpsertLeadProfile.mockResolvedValue({ id: 'lead-tahap5' });
      mockLlmCallCreate.mockReturnValue(Promise.resolve({}));
      mockLlmCallDeleteMany.mockResolvedValue({ count: 0 });

      const forensic: ForensicEntry[] = JSON.parse(
        fs.readFileSync('/Users/anggafatih/.gemini/antigravity/brain/5c2f28d1-9ba8-428e-83dc-5e9c1f545567/scratch/forensic_aug17_detailed.json', 'utf-8'),
      );
      const beforeList: BeforeEntry[] = JSON.parse(
        fs.readFileSync('/Users/anggafatih/.gemini/antigravity/brain/5c2f28d1-9ba8-428e-83dc-5e9c1f545567/scratch/leads-aug17-transcripts.json', 'utf-8'),
      );
      const beforeByWa = new Map(beforeList.map((b) => [b.wa, b]));

      const results: any[] = [];
      let i = 0;
      for (const entry of forensic) {
        i++;
        const before = beforeByWa.get(entry.wa) || null;
        let after: any = null;
        let error: string | null = null;
        try {
          after = await LeadProfilerService.processConversation({
            businessId: 'biz-tahap5-validasi',
            contactJid: `${entry.wa}@s.whatsapp.net`,
            csPhone: '628999999999',
            csName: entry.cs,
            rawTranscript: entry.full_text,
          });
        } catch (err: any) {
          error = String(err?.message || err);
        }
        results.push({
          idx: i,
          wa: entry.wa,
          groundTruthCls: entry.cls,
          before: before
            ? {
                status: before.current_status,
                category: before.current_category,
                produk: before.produk,
                insight: before.insight,
              }
            : null,
          after: after
            ? {
                status: after.conversion,
                category: after.leadCategory,
                produk: after.minatProduk,
                insight: after.lastInsight,
                objectionType: after.objectionType,
                taktikCS: after.taktikCS,
                draftWA: after.draftWA,
                confirmedCodAmount: after.confirmedCodAmount,
              }
            : null,
          error,
        });
        // eslint-disable-next-line no-console
        console.log(`[${i}/${forensic.length}] ${entry.wa} gt=${entry.cls} after=${after?.conversion}/${after?.leadCategory} err=${error}`);
      }

      fs.writeFileSync('/tmp/tahap5_results.json', JSON.stringify(results, null, 2), 'utf-8');
      expect(results.length).toBe(forensic.length);
      expect(results.filter((r) => r.error).length).toBe(0);
    },
    180000,
  );
});
