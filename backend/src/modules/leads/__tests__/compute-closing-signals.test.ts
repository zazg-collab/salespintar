/**
 * Fase 22 (Tahap 5, 2026-08-18): Regresi utk `LeadProfilerService.computeClosingAndAfterSalesSignals()`
 * — hasil ekstraksi murni (tanpa DB/LLM/Redis) dari blok LLM GATEKEEPER yang dipindah dari
 * `processConversation()` supaya bisa dipanggil ulang persis sama oleh skrip validasi forensik
 * Tahap 5 (`src/scripts/tahap5-validasi-forensik-17agustus.ts`). Test ini murni memastikan
 * relokasi kode TIDAK mengubah perilaku (bukan pengujian bug baru).
 */
import { describe, it, expect, vi } from 'vitest';

// computeClosingAndAfterSalesSignals() sendiri murni (tanpa I/O), tapi lead-profiler.service.ts
// meng-import config/redis.ts & config/prisma.ts di level modul (side-effecting: validasi env,
// buka koneksi). Mock supaya import file ini tidak butuh env/DB/Redis riil — sama seperti pola di
// lead-profiler.service.test.ts.
vi.mock('../../../config/redis', () => ({ redisCache: { get: vi.fn(), set: vi.fn() } }));
vi.mock('../../../config/prisma', () => ({
  prisma: {
    csHumanLearningSession: { findFirst: vi.fn() },
    lead: { findFirst: vi.fn(), deleteMany: vi.fn() },
    business: { findUnique: vi.fn() },
  },
}));
vi.mock('../../../services/llm', () => ({ complete: vi.fn() }));
vi.mock('../../../services/mengantar.service', () => ({ MengantarService: { getReceiverScore: vi.fn() } }));
vi.mock('../../../utils/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { LeadProfilerService } from '../lead-profiler.service';

describe('LeadProfilerService.computeClosingAndAfterSalesSignals (Fase 22, relokasi murni)', () => {
  it('mendeteksi sinyal closing deterministik pada transkrip konfirmasi order genuine', () => {
    const transcript = [
      '[CS] Baik kak, ini RINCIAN BIAYA nya: Golok Situmang 2 - Rp245.000. Total COD: Rp245.000. Apakah sudah sesuai kak?',
      '[BUYER] iya kak sudah sesuai, bungkus kak',
    ].join('\n');
    const buyerOnlyText = 'iya kak sudah sesuai, bungkus kak';

    const signals = LeadProfilerService.computeClosingAndAfterSalesSignals(transcript, buyerOnlyText);

    expect(signals.isDeterministicClosing).toBe(true);
    expect(signals.isAfterSales).toBe(false);
  });

  it('mendeteksi sinyal after-sales delivery ("sudah sampai") tanpa salah menandai closing', () => {
    const transcript = '[BUYER] kak barangnya sudah sampai, makasih ya';
    const buyerOnlyText = 'kak barangnya sudah sampai, makasih ya';

    const signals = LeadProfilerService.computeClosingAndAfterSalesSignals(transcript, buyerOnlyText);

    expect(signals.isAfterSalesDelivery).toBe(true);
    expect(signals.isAfterSales).toBe(true);
    expect(signals.isDeterministicClosing).toBe(false);
  });

  it('mendeteksi sinyal after-sales warranty (klaim garansi) tanpa salah menandai closing', () => {
    const transcript = '[BUYER] kak barang saya rusak gagangnya, mau klaim garansi';
    const buyerOnlyText = 'kak barang saya rusak gagangnya, mau klaim garansi';

    const signals = LeadProfilerService.computeClosingAndAfterSalesSignals(transcript, buyerOnlyText);

    expect(signals.isAfterSalesWarranty).toBe(true);
    expect(signals.isAfterSales).toBe(true);
    expect(signals.isDeterministicClosing).toBe(false);
  });

  it('chat netral tanpa closing maupun after-sales: semua sinyal false', () => {
    const transcript = '[BUYER] halo kak mau tanya-tanya dulu boleh?';
    const buyerOnlyText = 'halo kak mau tanya-tanya dulu boleh?';

    const signals = LeadProfilerService.computeClosingAndAfterSalesSignals(transcript, buyerOnlyText);

    expect(signals.isDeterministicClosing).toBe(false);
    expect(signals.isAfterSales).toBe(false);
  });
});
