/**
 * Langkah D-lanjutan (Fase 29, 2026-08-18) — akurasi nilai transaksi (Temuan T3 lama, Fase 26:
 * `ESTIMATED_PRICES` di `timeline.service.ts` cuma cover 17.6% SKU, sisanya jatuh ke default rata
 * Rp200rb utk SEMUA closing). Usulan Bossfren, divalidasi valid: pakai nominal "TOTAL COD: Rp xxx"
 * yang DIKETIK CS SENDIRI saat konfirmasi ke pembeli sbg acuan UTAMA, fallback ke katalog SKU statis
 * (lalu ke Rp200rb) HANYA kalau CS tidak sempat menyebut angka di transkrip.
 *
 * T4 (tabel AuditLog) SENGAJA TIDAK dikerjakan di fase ini (keputusan Bossfren: skema DB tetap
 * stabil, cukup dicatat sbg backlog) -- tidak ada test terkait di file ini.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../config/redis', () => ({ redisCache: { get: vi.fn(), set: vi.fn() } }));

const { mockLeadFindMany } = vi.hoisted(() => ({ mockLeadFindMany: vi.fn() }));
vi.mock('../../../config/prisma', () => ({
  prisma: {
    csHumanLearningSession: { findFirst: vi.fn() },
    lead: { findFirst: vi.fn(), findMany: mockLeadFindMany, deleteMany: vi.fn() },
    business: { findUnique: vi.fn() },
  },
}));
vi.mock('../../../services/llm', () => ({ complete: vi.fn() }));
vi.mock('../../../services/mengantar.service', () => ({ MengantarService: { getReceiverScore: vi.fn() } }));
vi.mock('../../../utils/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { LeadProfilerService } from '../lead-profiler.service';
import { SessionBoundaryParser } from '../session-parser';
import { TimelineService } from '../timeline.service';

describe('LeadProfilerService.extractRoleAwareProduct — confirmedCodAmount (Langkah D-lanjutan, Fase 29)', () => {
  it('mengekstrak nominal dari "TOTAL COD: xxx" yg diketik CS (format titik ribuan, tanpa prefiks Rp)', () => {
    const transcript = [
      '[CS] RINCIAN BIAYA, Harga: 235.000, TOTAL COD: 275.000',
      '[BUYER] oke kak, sudah benar, kirim sekarang',
    ].join('\n');

    const { activeSession } = SessionBoundaryParser.segmentSessions(transcript);
    const { confirmedCodAmount } = LeadProfilerService.extractRoleAwareProduct(activeSession);

    expect(confirmedCodAmount).toBe(275000);
  });

  it('mengekstrak nominal dari "TOTAL COD: Rp xxx" DENGAN prefiks "Rp" (format paling umum dipakai CS -- ditemukan 2 skeptic independen sbg bug blocking sebelum diperbaiki)', () => {
    const transcript = [
      '[CS] Baik kak, ini RINCIAN BIAYA nya: Golok Situmang 2 - Rp246.000. TOTAL COD: Rp246.000. Apakah sudah sesuai kak?',
      '[BUYER] oke sudah benar, kirim sekarang kak',
    ].join('\n');

    const { activeSession } = SessionBoundaryParser.segmentSessions(transcript);
    const { confirmedCodAmount } = LeadProfilerService.extractRoleAwareProduct(activeSession);

    expect(confirmedCodAmount).toBe(246000);
  });

  it('mengekstrak nominal dari "TOTAL COD: Rp xxx" dgn spasi setelah "Rp"', () => {
    const transcript = [
      '[CS] RINCIAN BIAYA, Harga: Rp 235.000, TOTAL COD: Rp 275.000',
      '[BUYER] oke kak, sudah benar, kirim sekarang',
    ].join('\n');

    const { activeSession } = SessionBoundaryParser.segmentSessions(transcript);
    const { confirmedCodAmount } = LeadProfilerService.extractRoleAwareProduct(activeSession);

    expect(confirmedCodAmount).toBe(275000);
  });

  it('mengekstrak nominal dari format akhiran "k" (mis. "245k")', () => {
    const transcript = [
      '[CS] RINCIAN BIAYA, Harga: 240k, TOTAL COD: 245k',
      '[BUYER] siap kak',
    ].join('\n');

    const { activeSession } = SessionBoundaryParser.segmentSessions(transcript);
    const { confirmedCodAmount } = LeadProfilerService.extractRoleAwareProduct(activeSession);

    expect(confirmedCodAmount).toBe(245000);
  });

  it('tetap null kalau CS tidak pernah mengetik "RINCIAN BIAYA"/"TOTAL COD" sama sekali', () => {
    const transcript = [
      '[BUYER] halo min, golok situmang 3 masih ada?',
      '[CS] ada kak, silakan diorder',
    ].join('\n');

    const { activeSession } = SessionBoundaryParser.segmentSessions(transcript);
    const { confirmedCodAmount } = LeadProfilerService.extractRoleAwareProduct(activeSession);

    expect(confirmedCodAmount).toBeNull();
  });

  it('kalau CS merevisi rincian (>1 baris "TOTAL COD" dlm sesi yg sama), ambil yg TERAKHIR', () => {
    const transcript = [
      '[CS] RINCIAN BIAYA, Harga: 235.000, TOTAL COD: 245.000',
      '[BUYER] eh mau nambah 1 lagi kak',
      '[CS] baik kak, RINCIAN BIAYA, Harga: 470.000, TOTAL COD: 490.000',
      '[BUYER] oke sudah benar, kirim sekarang',
    ].join('\n');

    const { activeSession } = SessionBoundaryParser.segmentSessions(transcript);
    const { confirmedCodAmount } = LeadProfilerService.extractRoleAwareProduct(activeSession);

    expect(confirmedCodAmount).toBe(490000);
  });
});

function baseFakeLead(overrides: Record<string, any> = {}) {
  const now = new Date('2026-08-18T10:00:00Z');
  return {
    id: 'lead-1',
    businessId: 'biz-1',
    waNumber: '6281234567890',
    name: 'Pelanggan Uji',
    minatProduk: 'Golok Situmang 3', // katalog: 235000
    conversionStatus: 'CLOSING',
    leadCategory: 'NEW_INBOUND',
    leadStage: 'HOT',
    score: 90,
    lastInsight: 'Closing normal',
    assignedCsName: 'CS Uji',
    assignedCsPhone: '628999',
    rtsRiskLevel: 'LOW',
    rtsReasons: [],
    courierRecommendation: null,
    confirmedCodAmount: null,
    createdAt: now,
    updatedAt: now,
    lastMessageAt: now,
    ...overrides,
  };
}

describe('TimelineService.getCustomerTimeline — estimatedValue pakai confirmedCodAmount (Langkah D-lanjutan, Fase 29)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('confirmedCodAmount TERSEDIA -> jadi acuan utama, MENANG atas harga katalog SKU', async () => {
    mockLeadFindMany.mockResolvedValue([baseFakeLead({ confirmedCodAmount: 275000 })]);

    const result = await TimelineService.getCustomerTimeline('biz-1', '6281234567890');

    expect(result?.orderGroups[0]?.estimatedValue).toBe(275000); // BUKAN 235000 (katalog Golok Situmang 3)
    expect(result?.totalLifetimeValue).toBe(275000);
  });

  it('confirmedCodAmount NULL -> fallback ke harga katalog SKU (perilaku lama dipertahankan)', async () => {
    mockLeadFindMany.mockResolvedValue([baseFakeLead({ confirmedCodAmount: null })]);

    const result = await TimelineService.getCustomerTimeline('biz-1', '6281234567890');

    expect(result?.orderGroups[0]?.estimatedValue).toBe(235000); // katalog Golok Situmang 3
  });

  it('confirmedCodAmount NULL & produk di luar katalog -> fallback terakhir Rp200rb (closing)', async () => {
    mockLeadFindMany.mockResolvedValue([
      baseFakeLead({ confirmedCodAmount: null, minatProduk: 'Produk Baru Di Luar Katalog' }),
    ]);

    const result = await TimelineService.getCustomerTimeline('biz-1', '6281234567890');

    expect(result?.orderGroups[0]?.estimatedValue).toBe(200000);
  });
});
