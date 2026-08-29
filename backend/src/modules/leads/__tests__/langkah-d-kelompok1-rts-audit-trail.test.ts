/**
 * Langkah D Fase 26 (Kelompok 1, 2026-08-18) — regresi utk 3 bug "audit trail + keandalan Redis"
 * yang dikonfirmasi TERBUKTI oleh 2 finder + 2 skeptic independen:
 *
 * - T2 (paling serius): evaluasi RTS ("Audit Kepatuhan Alamat") yang gagal total (exception
 *   ditelan) sebelumnya diam-diam disimpan sbg default {rtsRiskLevel:'LOW', reasons:[]} --
 *   TIDAK BISA DIBEDAKAN dari hasil evaluasi yang benar-benar sukses & aman. CS bisa kirim COD
 *   tanpa validasi alamat sungguhan. Fix: sentinel eksplisit 'EVALUATION_FAILED' (lead baru) atau
 *   fallback ke hasil evaluasi sah TERAKHIR (lead lama) -- tidak pernah diam-diam jadi 'LOW'.
 * - R2/R3 diuji lewat file terpisah (server.ts tidak mudah diunit-test krn efek samping proses;
 *   human-learning.service.ts TTL/DEL diverifikasi via test terpisah di bawah).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockRedisGet,
  mockRedisSet,
  mockRedisDel,
  mockCsHumanLearningFindFirst,
  mockLeadFindFirst,
  mockLeadDeleteMany,
  mockBusinessFindUnique,
  mockComplete,
  mockGetReceiverScore,
  mockUpsertLeadProfile,
} = vi.hoisted(() => ({
  mockRedisGet: vi.fn(),
  mockRedisSet: vi.fn(),
  mockRedisDel: vi.fn(),
  mockCsHumanLearningFindFirst: vi.fn(),
  mockLeadFindFirst: vi.fn(),
  mockLeadDeleteMany: vi.fn(),
  mockBusinessFindUnique: vi.fn(),
  mockComplete: vi.fn(),
  mockGetReceiverScore: vi.fn(),
  mockUpsertLeadProfile: vi.fn(),
}));

vi.mock('../../../config/redis', () => ({
  redisCache: { get: mockRedisGet, set: mockRedisSet, del: mockRedisDel },
}));

vi.mock('../../../config/prisma', () => ({
  prisma: {
    csHumanLearningSession: { findFirst: mockCsHumanLearningFindFirst },
    lead: { findFirst: mockLeadFindFirst, deleteMany: mockLeadDeleteMany },
    business: { findUnique: mockBusinessFindUnique },
  },
}));

vi.mock('../../../services/llm', () => ({
  complete: mockComplete,
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
import { TimelineService } from '../timeline.service';

const BASE_INPUT = {
  businessId: 'biz-1',
  contactJid: '6281234567890@s.whatsapp.net',
  csPhone: '628999999999',
  csName: 'CS Toko',
};

const NORMAL_LLM_RESPONSE = {
  text: JSON.stringify({
    isInternalTeam: false,
    leadCategory: 'NEW_INBOUND',
    minatProduk: 'Golok Situmang 2',
    lastInsight: 'Pembeli menyetujui pesanan, siap kirim COD.',
    conversion: 'CLOSING',
    score: 85,
    reasons: [],
    objectionType: null,
    taktikCS: null,
    draftWA: null,
  }),
};

describe('LeadProfilerService.processConversation — RTS "Audit Kepatuhan Alamat" (Langkah D, Temuan T2)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRedisGet.mockResolvedValue(null);
    mockRedisSet.mockResolvedValue('OK');
    mockRedisDel.mockResolvedValue(1);
    mockCsHumanLearningFindFirst.mockResolvedValue(null); // bukan CS terdaftar
    mockLeadDeleteMany.mockResolvedValue({ count: 0 });
    mockBusinessFindUnique.mockResolvedValue({ mengantarApiKey: 'fake-key' });
    mockComplete.mockResolvedValue(NORMAL_LLM_RESPONSE);
  });

  it('lead BARU (belum pernah punya hasil RTS): kalau evaluasi RTS gagal total, TIDAK diam-diam jadi LOW -- pakai sentinel EVALUATION_FAILED', async () => {
    mockLeadFindFirst.mockResolvedValue(null); // belum ada lead sebelumnya
    mockGetReceiverScore.mockRejectedValue(new Error('Mengantar API down (simulasi)'));

    await LeadProfilerService.processConversation({
      ...BASE_INPUT,
      rawTranscript: '[CS] baik kak, RINCIAN BIAYA: Golok Situmang 2, Total COD: 245000\n[BUYER] oke sudah benar, kirim sekarang kak',
    });

    expect(mockUpsertLeadProfile).toHaveBeenCalledTimes(1);
    const callArg = mockUpsertLeadProfile.mock.calls[0][0];
    expect(callArg.rtsRiskLevel).toBe('EVALUATION_FAILED');
    expect(callArg.rtsRiskLevel).not.toBe('LOW');
    expect(callArg.rtsReasons.join(' ')).toMatch(/gagal|belum tervalidasi/i);
  });

  it('lead LAMA (sudah punya hasil RTS sah HIGH sebelumnya): kalau evaluasi RTS gagal, PERTAHANKAN hasil lama -- jangan ditimpa LOW palsu', async () => {
    mockLeadFindFirst.mockResolvedValue({
      conversionStatus: 'PENDING',
      minatProduk: 'Golok Situmang 2',
      lastInsight: 'Masih nego.',
      score: 60,
      leadStage: 'WARM',
      objectionType: null,
      taktikCS: null,
      draftWA: null,
      leadCategory: 'NEW_INBOUND',
      rtsRiskScore: 80,
      rtsRiskLevel: 'HIGH',
      rtsReasons: ['Alamat tidak lengkap, tidak ada patokan'],
      courierRecommendation: 'J&T',
    });
    mockGetReceiverScore.mockRejectedValue(new Error('Mengantar API down (simulasi)'));

    await LeadProfilerService.processConversation({
      ...BASE_INPUT,
      rawTranscript: '[CS] baik kak, RINCIAN BIAYA: Golok Situmang 2, Total COD: 245000\n[BUYER] oke sudah benar, kirim sekarang kak',
    });

    expect(mockUpsertLeadProfile).toHaveBeenCalledTimes(1);
    const callArg = mockUpsertLeadProfile.mock.calls[0][0];
    expect(callArg.rtsRiskLevel).toBe('HIGH');
    expect(callArg.rtsReasons).toEqual(['Alamat tidak lengkap, tidak ada patokan']);
  });

  it('jalur normal (tanpa exception): rtsRiskLevel TETAP dihitung dari RtsRiskEngine seperti biasa (perilaku lama dipertahankan)', async () => {
    mockLeadFindFirst.mockResolvedValue(null);
    mockGetReceiverScore.mockResolvedValue(null);

    await LeadProfilerService.processConversation({
      ...BASE_INPUT,
      rawTranscript: '[CS] baik kak, RINCIAN BIAYA: Golok Situmang 2, Total COD: 245000\n[BUYER] oke sudah benar, kirim sekarang kak',
    });

    expect(mockUpsertLeadProfile).toHaveBeenCalledTimes(1);
    const callArg = mockUpsertLeadProfile.mock.calls[0][0];
    expect(callArg.rtsRiskLevel).not.toBe('EVALUATION_FAILED');
  });
});

describe('TimelineService.getCustomerTimeline — render sentinel EVALUATION_FAILED beda dari LOW (Langkah D, Temuan T2)', () => {
  it('rtsRiskLevel EVALUATION_FAILED dirender sbg "belum tervalidasi" (amber), BUKAN badge hijau "AMAN"', async () => {
    mockLeadFindFirst.mockReset();
    const now = new Date('2026-08-18T10:00:00+07:00');
    mockRedisGet.mockResolvedValue(null);

    // TimelineService pakai prisma.lead.findMany, bukan findFirst -- perlu mock terpisah.
    const { prisma } = await import('../../../config/prisma');
    (prisma.lead as any).findMany = vi.fn().mockResolvedValue([
      {
        id: 'lead-1',
        createdAt: now,
        updatedAt: now,
        lastMessageAt: now,
        name: 'Budi',
        minatProduk: 'Golok Situmang 2',
        leadCategory: 'NEW_INBOUND',
        conversionStatus: 'CLOSING',
        rtsRiskLevel: 'EVALUATION_FAILED',
        rtsRiskScore: 0,
        rtsReasons: ['Evaluasi RTS gagal dijalankan karena error teknis -- alamat/SOP BELUM tervalidasi, perlu pengecekan manual.'],
        courierRecommendation: null,
        assignedCsName: 'Nisa',
        assignedCsPhone: '628999999999',
        leadStage: 'HOT',
      },
    ]);

    const result = await TimelineService.getCustomerTimeline('biz-1', '6281234567890');
    const rtsEvent = result?.orderGroups[0]?.events.find((e) => e.type === 'RTS_VALIDATION');

    expect(rtsEvent).toBeDefined();
    expect(rtsEvent!.title).not.toMatch(/AMAN/);
    expect(rtsEvent!.title).toMatch(/BELUM TERVALIDASI|gagal/i);
    expect(rtsEvent!.badge?.color).not.toBe('emerald');
  });

  it('rtsRiskLevel LOW asli (evaluasi benar-benar sukses) TETAP dirender "AMAN" hijau (perilaku lama dipertahankan)', async () => {
    const now = new Date('2026-08-18T10:00:00+07:00');
    const { prisma } = await import('../../../config/prisma');
    (prisma.lead as any).findMany = vi.fn().mockResolvedValue([
      {
        id: 'lead-2',
        createdAt: now,
        updatedAt: now,
        lastMessageAt: now,
        name: 'Budi',
        minatProduk: 'Golok Situmang 2',
        leadCategory: 'NEW_INBOUND',
        conversionStatus: 'CLOSING',
        rtsRiskLevel: 'LOW',
        rtsRiskScore: 0,
        rtsReasons: [],
        courierRecommendation: null,
        assignedCsName: 'Nisa',
        assignedCsPhone: '628999999999',
        leadStage: 'HOT',
      },
    ]);

    const result = await TimelineService.getCustomerTimeline('biz-1', '6281234567890');
    const rtsEvent = result?.orderGroups[0]?.events.find((e) => e.type === 'RTS_VALIDATION');

    expect(rtsEvent).toBeDefined();
    expect(rtsEvent!.title).toMatch(/AMAN/);
    expect(rtsEvent!.badge?.color).toBe('emerald');
  });
});
