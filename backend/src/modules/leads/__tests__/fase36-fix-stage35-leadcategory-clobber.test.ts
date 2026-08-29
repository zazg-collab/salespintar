/**
 * Fase 36 (2026-08-19) — Audit gap dashboard "Lead Iklan Baru (Inbound)" 80-vs-73.
 *
 * Temuan: 4 lead dikonfirmasi Bossfren via chat WhatsApp ASLI (6281805511084, 6282216977605,
 * 6285693309931, 6281375357568) genuinely PROSPEK_IKLAN (form iklan) di STAGE 2.5, TAPI nyangkut
 * NEW_INBOUND di database. Dibuktikan via dry-run instrumented thd kode live + buffer Redis asli:
 * STAGE 2.5 menghitung `leadCategory = PROSPEK_IKLAN` dengan benar, dan nilai itu masih utuh
 * tepat sesudah guard STAGE 3 — tapi STAGE 3.5 "Deterministic Closing & Category Enforcement"
 * MENIMPA PAKSA `leadCategory = 'NEW_INBOUND'` tanpa syarat begitu closing deterministik
 * terdeteksi, tanpa cek dulu apakah kategori yang ada sudah PROSPEK_IKLAN.
 *
 * Cross-check produksi: 12 dari 55 lead berstatus CLOSING di seluruh bisnis nyangkut di
 * NEW_INBOUND dengan pola identik.
 *
 * Fix: baris `leadCategory = 'NEW_INBOUND'` di kedua cabang STAGE 3.5 sekarang jadi LANTAI MINIMUM
 * (upgrade OTHERS -> NEW_INBOUND kalau belum ada kategori), BUKAN timpa paksa — tidak pernah
 * menurunkan dari PROSPEK_IKLAN, sesuai urutan prioritas resmi STAGE 2.5
 * (PROSPEK_IKLAN > NEW_INBOUND > OTHERS).
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

const BASE_INPUT = {
  businessId: 'biz-1',
  contactJid: '6281234567890@s.whatsapp.net',
  csPhone: '628999999999',
  csName: 'CS Toko',
};

describe('LeadProfilerService.processConversation — STAGE 3.5 tidak boleh menurunkan PROSPEK_IKLAN saat closing (Fase 36)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRedisGet.mockResolvedValue(null);
    mockRedisSet.mockResolvedValue('OK');
    mockRedisDel.mockResolvedValue(1);
    mockCsHumanLearningFindFirst.mockResolvedValue(null);
    mockLeadFindFirst.mockResolvedValue(null);
    mockLeadDeleteMany.mockResolvedValue({ count: 0 });
    mockBusinessFindUnique.mockResolvedValue({ mengantarApiKey: null });
    mockGetReceiverScore.mockResolvedValue(null);
    mockUpsertLeadProfile.mockResolvedValue({ id: 'lead-x' });
  });

  it('lead genuinely PROSPEK_IKLAN (redirect form iklan) yang closing deterministik TETAP PROSPEK_IKLAN, bukan NEW_INBOUND (pola persis bug 6281805511084 "Situmang")', async () => {
    const transcript = [
      '[BUYER] Halo, saya sudah melakukan pemesanan ARF |Golok Situmang, atas nama Budi. Mohon segera diproses ya',
      '[CS] Terima kasih sudah mengisi form pemesanan ARF |Golok Situmang di toko kami!',
      '[CS] *RINCIAN BIAYA*',
      'Golok Situmang - Rp192.000',
      'Total COD: Rp224.000',
      'Apakah sudah sesuai kak?',
      '[BUYER] iya kak sudah sesuai, bungkus kak',
    ].join('\n');

    const result = await LeadProfilerService.processConversation({
      ...BASE_INPUT,
      rawTranscript: transcript,
    });

    expect(result).not.toBeNull();
    expect(result?.conversion).toBe('CLOSING');
    // Inti fix: closing TIDAK BOLEH menurunkan kategori yang sudah PROSPEK_IKLAN dari STAGE 2.5.
    expect(result?.leadCategory).toBe('PROSPEK_IKLAN');
    expect(mockUpsertLeadProfile).toHaveBeenCalledTimes(1);
    expect(mockUpsertLeadProfile.mock.calls[0][0]).toMatchObject({ leadCategory: 'PROSPEK_IKLAN' });
  });

  it('lead genuinely PROSPEK_IKLAN (tag tracking - Fb -) yang closing deterministik TETAP PROSPEK_IKLAN', async () => {
    const transcript = [
      '[BUYER] Saya sudah pesan Golok Black Mamba - Fb - NPM, atas nama Rina',
      '[CS] *RINCIAN BIAYA*',
      'Golok Black Mamba - Rp199.000',
      'Total COD: Rp271.000',
      'Apakah sudah sesuai kak?',
      '[BUYER] iya kak sudah sesuai, bungkus kak',
    ].join('\n');

    const result = await LeadProfilerService.processConversation({
      ...BASE_INPUT,
      rawTranscript: transcript,
    });

    expect(result).not.toBeNull();
    expect(result?.conversion).toBe('CLOSING');
    expect(result?.leadCategory).toBe('PROSPEK_IKLAN');
    expect(mockUpsertLeadProfile.mock.calls[0][0]).toMatchObject({ leadCategory: 'PROSPEK_IKLAN' });
  });

  it('lead TANPA sinyal iklan (organic inbound) yang closing deterministik tetap dapat lantai minimum NEW_INBOUND (perilaku lama dipertahankan, bukan regresi)', async () => {
    const transcript = [
      '[BUYER] kak ada Golok Situmang?',
      '[CS] ada kak, *RINCIAN BIAYA*',
      'Golok Situmang - Rp192.000',
      'Total COD: Rp224.000',
      'Apakah sudah sesuai kak?',
      '[BUYER] iya kak sudah sesuai, bungkus kak',
    ].join('\n');

    const result = await LeadProfilerService.processConversation({
      ...BASE_INPUT,
      rawTranscript: transcript,
    });

    expect(result).not.toBeNull();
    expect(result?.conversion).toBe('CLOSING');
    // STAGE 2.5 di sini TIDAK mendeteksi bukti iklan apa pun -> lantai minimum NEW_INBOUND
    // (bukan OTHERS) tetap harus berlaku persis seperti sebelum Fase 36.
    expect(result?.leadCategory).toBe('NEW_INBOUND');
    expect(mockUpsertLeadProfile.mock.calls[0][0]).toMatchObject({ leadCategory: 'NEW_INBOUND' });
  });

  it('cabang else-if (conversion sudah CLOSING dari LLM genuine, tanpa isDeterministicClosingSignal) juga tidak menurunkan PROSPEK_IKLAN', async () => {
    mockComplete.mockResolvedValue({
      text: JSON.stringify({
        isInternalTeam: false,
        leadCategory: 'PROSPEK_IKLAN',
        minatProduk: 'Golok Situmang',
        lastInsight: 'Pelanggan setuju closing.',
        conversion: 'CLOSING',
        score: 90,
        reasons: [],
        objectionType: 'DEAL_CONFIRMED',
        taktikCS: null,
        draftWA: null,
      }),
    });

    const transcript = [
      '[BUYER] Halo, saya sudah melakukan pemesanan Golok Situmang, atas nama Budi. Mohon segera diproses ya',
      '[CS] Terima kasih sudah mengisi form pemesanan Golok Situmang di toko kami!',
      '[BUYER] oke saya setuju kak',
    ].join('\n');

    const result = await LeadProfilerService.processConversation({
      ...BASE_INPUT,
      rawTranscript: transcript,
    });

    expect(result).not.toBeNull();
    expect(result?.conversion).toBe('CLOSING');
    expect(result?.leadCategory).toBe('PROSPEK_IKLAN');
  });
});
