/**
 * Tahap 5 — Uji Validasi Output pada Data Riil 16 Agustus 2026.
 *
 * Menjalankan `LeadProfilerService.processConversation()` PENUH
 * terhadap 37 percakapan riil dataset forensik 16 Agustus 2026.
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
  ts: number;
  full_text: string;
}

describe('Tahap 5 — Validasi Output Riil Dataset Forensik 16 Agustus 2026', () => {
  it(
    'menjalankan processConversation() penuh utk 37 lead 16 Agustus & menulis hasil ke /tmp/tahap5_results_aug16.json',
    async () => {
      mockRedisGet.mockResolvedValue(null);
      mockRedisSet.mockResolvedValue('OK');
      mockRedisDel.mockResolvedValue(1);
      mockCsHumanLearningFindFirst.mockResolvedValue(null);
      mockLeadFindFirst.mockResolvedValue(null);
      mockLeadDeleteMany.mockResolvedValue({ count: 0 });
      mockLeadUpsert.mockResolvedValue({});
      mockBusinessFindUnique.mockResolvedValue({ mengantarApiKey: null, aiConfig: null });
      mockGetReceiverScore.mockResolvedValue(null);
      mockUpsertLeadProfile.mockResolvedValue({ id: 'lead-tahap5-aug16' });
      mockLlmCallCreate.mockReturnValue(Promise.resolve({}));
      mockLlmCallDeleteMany.mockResolvedValue({ count: 0 });

      const forensicPath = '/Users/anggafatih/.gemini/antigravity/brain/5c2f28d1-9ba8-428e-83dc-5e9c1f545567/scratch/forensic_aug16_detailed.json';
      const forensic: ForensicEntry[] = JSON.parse(fs.readFileSync(forensicPath, 'utf-8'));

      const results: any[] = [];
      let i = 0;
      for (const entry of forensic) {
        i++;
        let after: any = null;
        let error: string | null = null;
        try {
          after = await LeadProfilerService.processConversation({
            businessId: 'biz-tahap5-aug16',
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
          cs: entry.cs,
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
        console.log(`[${i}/${forensic.length}] ${entry.wa} after=${after?.conversion}/${after?.leadCategory} err=${error}`);
      }

      fs.writeFileSync('/tmp/tahap5_results_aug16.json', JSON.stringify(results, null, 2), 'utf-8');
      expect(results.length).toBe(forensic.length);
      expect(results.filter((r) => r.error).length).toBe(0);
    },
    300000,
  );
});
