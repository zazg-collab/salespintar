/**
 * Langkah B Fase 24 (Temuan B, 2026-08-18) — regresi: `reconciliation-sweeper.worker.ts` (jalur
 * "Opsi B" 7x/hari) sebelumnya TIDAK PERNAH memeriksa `crmSedangDijeda()` sama sekali, beda dg
 * jalur realtime (`human-learning.service.ts`) yang menahan diri saat CRM dijeda, dan beda dg
 * sepupu-nya `sweepDailyBatch` yang SUDAH memeriksa `hlSedangDijeda()`. Akibatnya menjeda "AI CRM
 * Lead Profiling" tidak benar-benar berhenti — sweeper tetap diam-diam mereklasifikasi lead PENDING
 * di latar belakang. Dikonfirmasi 2 finder + 2 skeptic independen: TERBUKTI.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockScan, mockLlen, mockLeadFindFirst, mockCrmSedangDijeda, mockProcessConversation } = vi.hoisted(() => ({
  mockScan: vi.fn(),
  mockLlen: vi.fn(),
  mockLeadFindFirst: vi.fn(),
  mockCrmSedangDijeda: vi.fn(),
  mockProcessConversation: vi.fn(),
}));

vi.mock('../../config/redis', () => ({
  redisCache: { scan: mockScan, llen: mockLlen, lrange: vi.fn() },
}));

vi.mock('../../config/prisma', () => ({
  prisma: { lead: { findFirst: mockLeadFindFirst } },
}));

vi.mock('../../modules/leads/lead-profiler.service', () => ({
  LeadProfilerService: { processConversation: mockProcessConversation },
}));

vi.mock('../../services/human-learning.service', () => ({
  pecahKunciBuffer: vi.fn(),
  crmSedangDijeda: mockCrmSedangDijeda,
}));

vi.mock('../../utils/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { handleReconciliationSweeper } from '../reconciliation-sweeper.worker';

const FAKE_JOB = {} as any;

describe('handleReconciliationSweeper — hormati jeda CRM (Langkah B, Temuan B)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockScan.mockResolvedValue(['0', ['hl:full_history:biz-1:628999:6281234567890']]);
    mockLeadFindFirst.mockResolvedValue({ id: 'lead-1', conversionStatus: 'PENDING' });
  });

  it('TIDAK memindai/memproses apapun kalau AI CRM Lead Profiling sedang DIJEDA', async () => {
    mockCrmSedangDijeda.mockResolvedValue(true);

    const result = await handleReconciliationSweeper(FAKE_JOB);

    expect(result).toEqual({ diperiksa: 0, diperbarui: 0, dilewati: 0 });
    // Sebelumnya fix: sweeper akan tetap men-scan Redis & memanggil processConversation di sini.
    expect(mockScan).not.toHaveBeenCalled();
    expect(mockProcessConversation).not.toHaveBeenCalled();
  });

  it('TETAP jalan seperti biasa kalau AI CRM Lead Profiling TIDAK sedang dijeda (perilaku lama dipertahankan)', async () => {
    mockCrmSedangDijeda.mockResolvedValue(false);
    mockLlen.mockResolvedValue(2);
    (await import('../../config/redis')).redisCache.lrange = vi
      .fn()
      .mockResolvedValue(['[BUYER] halo', '[CS] halo juga']);
    mockProcessConversation.mockResolvedValue({ conversion: 'PENDING' });

    const result = await handleReconciliationSweeper(FAKE_JOB);

    expect(mockScan).toHaveBeenCalled();
    expect(mockProcessConversation).toHaveBeenCalledTimes(1);
    expect(result.diperiksa).toBe(1);
    expect(result.diperbarui).toBe(1);
  });
});
