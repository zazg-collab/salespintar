/**
 * Regresi Audit Tahap 2 — Langkah A (2026-08-18)
 *
 * Temuan 2.2: Dua titik `prisma.lead.deleteMany` di LeadProfilerService
 * (STAGE 0 "registered CS filter" & STAGE "internal team chat filter")
 * TIDAK memeriksa dulu apakah lead yang mau dihapus sudah CLOSING /
 * REPEAT_ORDER sebelum menghapusnya — bisa menghapus riwayat closing sah
 * hanya karena nomor yang sama belakangan terdeteksi sbg CS/obrolan internal.
 *
 * Temuan 3.1: Sinyal closing deterministik (`isDeterministicClosingSignalStr`)
 * bisa "dikalahkan" oleh domain after-sales (`isAfterSalesDomain`) di STAGE 3.3
 * / 3.5, dan `lastInsight` valid dari LLM DIBUANG total setiap kali
 * `isAfterSalesDomain` true (line 639 lama) — akar penyebab utama bug
 * "20/60 lead nyangkut di 'Percakapan baru dimulai.'" pada dataset forensik.
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
  // PENTING: static methods pada class TIDAK enumerable, jadi `{...actual.LeadsRepository}`
  // diam-diam kehilangan method lain (mis. sanitizeWaNumber). Pakai Proxy supaya semua
  // static method asli tetap tembus KECUALI upsertLeadProfile yang sengaja di-stub.
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

describe('LeadProfilerService.processConversation — guard deleteMany (Temuan 2.2)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRedisGet.mockResolvedValue(null);
    mockRedisSet.mockResolvedValue('OK');
    mockRedisDel.mockResolvedValue(1);
    mockLeadDeleteMany.mockResolvedValue({ count: 1 });
    mockBusinessFindUnique.mockResolvedValue({ mengantarApiKey: null });
    mockGetReceiverScore.mockResolvedValue(null);
    mockUpsertLeadProfile.mockResolvedValue({ id: 'lead-x' });
  });

  it('STAGE 0: TIDAK menghapus lead yang statusnya sudah CLOSING walau nomornya belakangan terdaftar sbg CS', async () => {
    mockCsHumanLearningFindFirst.mockResolvedValue({ id: 'cs-session-1' });
    mockLeadFindFirst.mockResolvedValue({ conversionStatus: 'CLOSING' });

    const result = await LeadProfilerService.processConversation({
      ...BASE_INPUT,
      rawTranscript: '[CS] halo kak\n[BUYER] halo juga kak',
    });

    expect(mockLeadDeleteMany).not.toHaveBeenCalled();
    expect(result).toBeNull();
  });

  it('STAGE 0: TETAP menghapus lead yang bukan CLOSING/REPEAT_ORDER saat nomornya terdaftar sbg CS (perilaku lama dipertahankan)', async () => {
    mockCsHumanLearningFindFirst.mockResolvedValue({ id: 'cs-session-2' });
    mockLeadFindFirst.mockResolvedValue({ conversionStatus: 'PENDING' });

    const result = await LeadProfilerService.processConversation({
      ...BASE_INPUT,
      rawTranscript: '[CS] halo kak\n[BUYER] halo juga kak',
    });

    expect(mockLeadDeleteMany).toHaveBeenCalledTimes(1);
    expect(result).toBeNull();
  });

  it('Obrolan internal tim CS: TIDAK menghapus lead yang statusnya sudah CLOSING', async () => {
    mockCsHumanLearningFindFirst.mockResolvedValue(null);
    mockLeadFindFirst.mockResolvedValue({
      conversionStatus: 'CLOSING',
      minatProduk: 'Golok Situmang 2',
      lastInsight: 'Sudah closing.',
      score: 90,
      leadStage: 'VERY_HOT',
      objectionType: 'DEAL_CONFIRMED',
      taktikCS: null,
      draftWA: null,
      leadCategory: 'NEW_INBOUND',
    });
    mockComplete.mockResolvedValue({
      text: JSON.stringify({
        isInternalTeam: true,
        leadCategory: 'OTHERS',
        minatProduk: null,
        lastInsight: 'Diskusi jadwal training CS internal, bukan transaksi pembeli.',
        conversion: 'PENDING',
        score: 0,
        reasons: [],
        objectionType: null,
        taktikCS: null,
        draftWA: null,
      }),
    });

    const result = await LeadProfilerService.processConversation({
      ...BASE_INPUT,
      rawTranscript:
        '[CS] eh ntar kita rapat internal ya soal jadwal training CS baru\n' +
        '[BUYER] oke siap, nanti japri aja ya soal jadwal training CS besok, ini bukan pesanan produk',
    });

    expect(mockLeadDeleteMany).not.toHaveBeenCalled();
    expect(result).toBeNull();
  });

  it('Obrolan internal tim CS: TETAP menghapus lead yang bukan CLOSING/REPEAT_ORDER (perilaku lama dipertahankan)', async () => {
    mockCsHumanLearningFindFirst.mockResolvedValue(null);
    mockLeadFindFirst.mockResolvedValue({
      conversionStatus: 'PENDING',
      minatProduk: null,
      lastInsight: 'Masih tanya-tanya.',
      score: 10,
      leadStage: 'COLD',
      objectionType: null,
      taktikCS: null,
      draftWA: null,
      leadCategory: 'OTHERS',
    });
    mockComplete.mockResolvedValue({
      text: JSON.stringify({
        isInternalTeam: true,
        leadCategory: 'OTHERS',
        minatProduk: null,
        lastInsight: 'Diskusi jadwal training CS internal, bukan transaksi pembeli.',
        conversion: 'PENDING',
        score: 0,
        reasons: [],
        objectionType: null,
        taktikCS: null,
        draftWA: null,
      }),
    });

    const result = await LeadProfilerService.processConversation({
      ...BASE_INPUT,
      rawTranscript:
        '[CS] eh ntar kita rapat internal ya soal jadwal training CS baru\n' +
        '[BUYER] oke siap, nanti japri aja ya soal jadwal training CS besok, ini bukan pesanan produk',
    });

    expect(mockLeadDeleteMany).toHaveBeenCalledTimes(1);
    expect(result).toBeNull();
  });

  // Ronde Penyanggal Langkah A (2026-08-18): 2 finder + 1 penyanggal sepakat TERBUKTI —
  // guard internal-chat pakai `existingLeadData` yang diambil jauh di STAGE 2, BUKAN
  // di-refetch tepat sebelum deleteMany. Kalau status berubah jadi CLOSING di antara STAGE 2
  // dan titik guard ini (mis. pesan follow-up cepat yang lewat jalur bypass-LLM lebih dulu
  // selesai), guard versi lama tidak mendeteksinya. Simulasikan dg findFirst STAGE 2 return
  // PENDING (stale) tapi status "riil" saat guard dicek ulang sudah CLOSING.
  it('Obrolan internal tim CS: pakai status TERBARU (bukan snapshot basi STAGE 2) saat memutuskan hapus atau tidak', async () => {
    mockCsHumanLearningFindFirst.mockResolvedValue(null);
    mockLeadFindFirst
      .mockResolvedValueOnce({
        // Snapshot STAGE 2 — basi, belum tahu lead ini baru saja CLOSING.
        conversionStatus: 'PENDING',
        minatProduk: null,
        lastInsight: 'Masih tanya-tanya.',
        score: 10,
        leadStage: 'COLD',
        objectionType: null,
        taktikCS: null,
        draftWA: null,
        leadCategory: 'OTHERS',
      })
      .mockResolvedValueOnce({
        // Re-check tepat sebelum delete — status riil terkini sudah CLOSING.
        conversionStatus: 'CLOSING',
      });
    mockComplete.mockResolvedValue({
      text: JSON.stringify({
        isInternalTeam: true,
        leadCategory: 'OTHERS',
        minatProduk: null,
        lastInsight: 'Diskusi jadwal training CS internal, bukan transaksi pembeli.',
        conversion: 'PENDING',
        score: 0,
        reasons: [],
        objectionType: null,
        taktikCS: null,
        draftWA: null,
      }),
    });

    const result = await LeadProfilerService.processConversation({
      ...BASE_INPUT,
      rawTranscript:
        '[CS] eh ntar kita rapat internal ya soal jadwal training CS baru\n' +
        '[BUYER] oke siap, nanti japri aja ya soal jadwal training CS besok, ini bukan pesanan produk',
    });

    expect(mockLeadDeleteMany).not.toHaveBeenCalled();
    expect(result).toBeNull();
  });
});

describe('LeadProfilerService.processConversation — prioritas closing vs after-sales (Temuan 3.1)', () => {
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

  it('Sinyal closing deterministik TIDAK dikalahkan oleh kata "rusak" yang cuma nostalgia after-sales (skenario campur)', async () => {
    const transcript = [
      '[CS] Baik kak, ini RINCIAN BIAYA nya:',
      'Golok Situmang 2 - Rp245.000',
      'Total COD: Rp245.000',
      'Apakah sudah sesuai kak?',
      '[BUYER] iya kak sudah sesuai, bungkus kak',
      '[BUYER] eh iya kak, punya saya yang lama sempet rusak dikit di gagangnya tapi ga masalah kak tetep saya pake terus',
    ].join('\n');

    const result = await LeadProfilerService.processConversation({
      ...BASE_INPUT,
      rawTranscript: transcript,
    });

    expect(result).not.toBeNull();
    expect(result?.conversion).toBe('CLOSING');
    expect(result?.objectionType).toBe('DEAL_CONFIRMED');
    expect(result?.lastInsight).not.toContain('Percakapan baru dimulai');
    expect(result?.rawScore).toBeGreaterThanOrEqual(90);
  });

  it('lastInsight valid dari LLM TIDAK dibuang total hanya karena domain after-sales murni (skenario after-sales tanpa closing)', async () => {
    mockComplete.mockResolvedValue({
      text: JSON.stringify({
        isInternalTeam: false,
        leadCategory: 'OTHERS',
        minatProduk: null,
        lastInsight:
          'Pelanggan lama menanyakan status pengiriman pesanan sebelumnya, belum ada update terbaru dari kurir.',
        conversion: 'PENDING',
        score: 20,
        reasons: [],
        objectionType: 'AFTER_SALES_RESI',
        taktikCS: null,
        draftWA: null,
      }),
    });

    const result = await LeadProfilerService.processConversation({
      ...BASE_INPUT,
      rawTranscript: '[BUYER] halo kak, gimana kabarnya pesanan saya yang waktu itu?',
    });

    expect(result).not.toBeNull();
    expect(result?.lastInsight).toBe(
      'Pelanggan lama menanyakan status pengiriman pesanan sebelumnya, belum ada update terbaru dari kurir.',
    );
    expect(result?.conversion).toBe('PENDING');
    expect(result?.objectionType).toBe('AFTER_SALES_RESI');
  });
});

describe('LeadProfilerService.processConversation — kunci per-kontak (Langkah B Fase 24, Temuan A)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRedisGet.mockResolvedValue(null);
    mockRedisDel.mockResolvedValue(1);
    mockCsHumanLearningFindFirst.mockResolvedValue(null);
    mockLeadFindFirst.mockResolvedValue(null);
    mockLeadDeleteMany.mockResolvedValue({ count: 0 });
    mockBusinessFindUnique.mockResolvedValue({ mengantarApiKey: null });
    mockGetReceiverScore.mockResolvedValue(null);
    mockUpsertLeadProfile.mockResolvedValue({ id: 'lead-x' });
  });

  it('mengambil lock per-(businessId, waNumber) via SET NX PX sebelum memproses, dan melepasnya via DEL sesudah selesai', async () => {
    mockRedisSet.mockResolvedValue('OK');

    const result = await LeadProfilerService.processConversation({
      ...BASE_INPUT,
      rawTranscript: '[BUYER] halo kak mau tanya-tanya dulu boleh?',
    });

    expect(result).not.toBeNull();
    // Panggilan set() pertama harus lock (NX+PX), BUKAN hash STAGE 0.5 (yang pakai EX tanpa NX).
    const lockSetCall = mockRedisSet.mock.calls.find((args) => args[0] === 'hl:lp_lock:biz-1:6281234567890');
    expect(lockSetCall).toBeDefined();
    expect(lockSetCall?.[2]).toBe('PX');
    expect(lockSetCall?.[4]).toBe('NX');
    expect(mockRedisDel).toHaveBeenCalledWith('hl:lp_lock:biz-1:6281234567890');
  });

  it('kalau lock sedang dipegang panggilan lain, MENUNGGU (poll) sampai bebas — bukan langsung menyerah', async () => {
    // Set pertama gagal (lock masih dipegang "panggilan lain"), set kedua berhasil (lock bebas).
    mockRedisSet
      .mockResolvedValueOnce(null) // percobaan 1: masih terkunci
      .mockResolvedValue('OK'); // percobaan berikutnya (poll) + set hash STAGE 0.5: berhasil

    const result = await LeadProfilerService.processConversation({
      ...BASE_INPUT,
      rawTranscript: '[BUYER] halo kak mau tanya-tanya dulu boleh?',
    });

    expect(result).not.toBeNull();
    // Setidaknya 2 percobaan SET utk lock key yg sama (percobaan 1 gagal, percobaan 2 berhasil).
    const lockAttempts = mockRedisSet.mock.calls.filter((args) => args[0] === 'hl:lp_lock:biz-1:6281234567890');
    expect(lockAttempts.length).toBeGreaterThanOrEqual(2);
    expect(mockRedisDel).toHaveBeenCalledWith('hl:lp_lock:biz-1:6281234567890');
  }, 10000);

  it('fail-open: kalau Redis error saat SET lock, tetap lanjut memproses (bukan macet/gagal total)', async () => {
    mockRedisSet.mockRejectedValue(new Error('ECONNREFUSED redis down'));

    const result = await LeadProfilerService.processConversation({
      ...BASE_INPUT,
      rawTranscript: '[BUYER] halo kak mau tanya-tanya dulu boleh?',
    });

    // Tetap menghasilkan analisis walau lock gagal diperiksa — fail-open, bukan fail-closed.
    expect(result).not.toBeNull();
  });
});
