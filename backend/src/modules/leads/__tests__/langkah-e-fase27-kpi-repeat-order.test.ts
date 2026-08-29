/**
 * Langkah E Fase 27 (2026-08-18) — regresi utk Temuan KPI (Temuan #7 audit arsitektur):
 * KPI "Closing Deal" (kartu ringkasan leads page & dashboard) sebelumnya cuma menghitung
 * conversionStatus === 'CLOSING' persis, sehingga pelanggan REPEAT_ORDER (yang secara
 * bisnis juga closing) tidak pernah ikut terhitung. Dikonfirmasi 2 finder + 2 skeptic
 * independen: TERBUKTI.
 *
 * Fix: `LeadsRepository.getStats()` sekarang menghitung closingLeads dari
 * conversionStatus IN ('CLOSING', 'REPEAT_ORDER') -- bukan cuma 'CLOSING'.
 *
 * (dashboard.routes.ts & shadow-mining.worker.ts mendapat fix serupa tapi tidak diuji
 * di sini krn butuh mocking prisma+redis+bullmq penuh tanpa infra test route/worker yang
 * sudah ada di repo ini -- diverifikasi via tsc bersih + review manual, didokumentasikan
 * di Ledger Fase 27, sama seperti precedent server.ts di Fase 26.)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockCount, mockAggregate } = vi.hoisted(() => ({
  mockCount: vi.fn(),
  mockAggregate: vi.fn(),
}));

vi.mock('../../../config/prisma', () => ({
  prisma: {
    lead: {
      count: mockCount,
      aggregate: mockAggregate,
    },
  },
}));

vi.mock('../../../utils/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { LeadsRepository } from '../leads.repository';

describe('LeadsRepository.getStats — closingLeads harus menghitung CLOSING + REPEAT_ORDER (Langkah E, Temuan KPI)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAggregate.mockResolvedValue({ _avg: { rtsRiskScore: 12 } });
  });

  it('memanggil prisma.lead.count utk closingLeads dengan filter IN [CLOSING, REPEAT_ORDER], bukan cuma CLOSING', async () => {
    mockCount.mockResolvedValue(0);

    await LeadsRepository.getStats('biz-1');

    const closingCall = mockCount.mock.calls.find(
      (call: any[]) => call[0]?.where?.conversionStatus !== undefined,
    );
    expect(closingCall).toBeDefined();
    expect(closingCall![0].where.conversionStatus).toEqual({ in: ['CLOSING', 'REPEAT_ORDER'] });
  });

  it('closingLeads di hasil akhir mengikuti angka gabungan CLOSING+REPEAT_ORDER dari query', async () => {
    // Urutan Promise.all di getStats(): total, hot, warm, cold, closing, pending, lost, highRiskRts
    mockCount
      .mockResolvedValueOnce(50) // total
      .mockResolvedValueOnce(10) // hot
      .mockResolvedValueOnce(10) // warm
      .mockResolvedValueOnce(10) // cold
      .mockResolvedValueOnce(18) // closing (CLOSING + REPEAT_ORDER gabungan)
      .mockResolvedValueOnce(20) // pending
      .mockResolvedValueOnce(12) // lost
      .mockResolvedValueOnce(3); // highRiskRts

    const stats = await LeadsRepository.getStats('biz-1');

    expect(stats.closingLeads).toBe(18);
  });
});
