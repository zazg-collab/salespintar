/**
 * Fase 34 (2026-08-19) — fix regresi dari Fase 33, ditemukan via dry-run test atas permintaan
 * Bossfren thd wa 6287833219167 "Haris Santo" & 6283846463146 "Ustdz. Endang" (di luar 2 nomor
 * asal investigasi Latif/Sumaji, dipakai Bossfren utk validasi silang perbaikan Fase 32/33).
 *
 * Diagnosis awal (SALAH, dicabut sebelum deploy): dikira cabang bypass `isAfterSalesStr` yang
 * jadi biang keladi. Verifikasi ulang via dry-run BER-INSTRUMENTASI (monkey-patch `complete()`
 * di container produksi, bukan cuma `upsertLeadProfile`) MEMBUKTIKAN itu SALAH -- `complete()`
 * (LLM ASLI, openrouter/llama-3.3-70b) benar-benar dipanggil (bypassLlm TETAP false) utk pesan
 * CS-only "paketnya udah di kirim" milik Haris/Endang (kedua wa itu TIDAK PERNAH membalas sama
 * sekali di sesi itu -- `buyerOnlyText` kosong total, dikonfirmasi dari AOF Redis produksi).
 *
 * Root cause sebenarnya: `structuredContext` yang dikirim ke LLM sbg konteks berisi baris
 * "STATUS TRANSAKSI TERAKHIR: ${conversion}" -- tapi `conversion` di titik itu adalah variabel
 * lokal yang BARU diinisialisasi 'PENDING', BUKAN `existingLeadData.conversionStatus` yang
 * sebenarnya. LLM jadi SAMA SEKALI TIDAK TAHU deal ini sudah CLOSING sah, dan menganalisis sesi
 * yang cuma berisi 1 baris CS tanpa balasan pembeli -- keluar conversion:'PENDING', score:0.
 * Genuine (bukan bypass), TAPI tetap bukan bukti apa pun krn TIDAK ADA pembeli yang bicara di
 * sesi aktif itu sama sekali.
 *
 * Fix: `allowTerminalDowngrade: existingIsTerminalStatus && !bypassLlm && buyerOnlyText.trim().length > 0`
 * -- downgrade status terminal cuma diizinkan kalau BUKAN hasil bypass/deterministik (melindungi
 * skenario `isAfterSalesStr` versi buyer yang benar2 bicara) DAN sesi aktif punya minimal 1
 * pesan dari PEMBELI (melindungi skenario CS-only informatif spt Haris/Endang di atas).
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

const CLOSING_LEAD_HARIS = {
  conversionStatus: 'CLOSING',
  objectionType: 'DEAL_CONFIRMED',
  score: 95,
  leadStage: 'VERY_HOT',
  lastInsight: 'Pelanggan setuju pemesanan Bedog Betekok dan mengonfirmasi COD Rp177.000.',
  leadCategory: 'PROSPEK_IKLAN',
  taktikCS: null,
  draftWA: null,
  minatProduk: 'Bedog Betekok',
  rtsRiskScore: 10,
  rtsRiskLevel: 'LOW',
  rtsReasons: [],
  courierRecommendation: null,
  confirmedCodAmount: 177000,
};

describe('Fase 34 — genuine LLM call TANPA bukti pembeli & bypass isAfterSalesStr TIDAK boleh menimpa deal yang sudah closing sah', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRedisGet.mockResolvedValue(null);
    mockRedisSet.mockResolvedValue('OK');
    mockRedisDel.mockResolvedValue(1);
    mockCsHumanLearningFindFirst.mockResolvedValue(null);
    mockLeadDeleteMany.mockResolvedValue({ count: 0 });
    mockBusinessFindUnique.mockResolvedValue({ mengantarApiKey: null });
    mockGetReceiverScore.mockResolvedValue(null);
    mockUpsertLeadProfile.mockResolvedValue({ id: 'lead-x' });
  });

  it('kasus Haris Santo NYATA (reproduksi persis pesan produksi, mockComplete diisi persis respons LLM asli hasil dry-run OpenRouter): CS-only "paket sudah dikirim" ke deal yg SUDAH CLOSING sah, pembeli TIDAK membalas apa pun -- allowTerminalDowngrade HARUS false', async () => {
    mockLeadFindFirst.mockResolvedValue(CLOSING_LEAD_HARIS);
    // Respons ini BUKAN dikarang -- persis apa yang benar-benar dikembalikan LLM produksi
    // (provider openrouter, model meta-llama/llama-3.3-70b-instruct) saat pesan ini di-dry-run
    // langsung ke container produksi (lihat ledger Fase 34): LLM ASLI dipanggil (bukan bypass),
    // tapi karena tidak tahu status existing lead, ia keluarkan PENDING/score 0 murni dari sudut
    // pandang "sesi ini cuma 1 baris CS tanpa balasan pembeli".
    mockComplete.mockResolvedValue({
      text: JSON.stringify({
        isInternalTeam: false,
        leadCategory: 'OTHERS',
        minatProduk: '',
        lastInsight: 'Pelanggan baru menanyakan status pengiriman paketnya',
        conversion: 'PENDING',
        score: 0,
        reasons: [],
        objectionType: 'AFTER_SALES_RESI',
        taktikCS: 'Segera koordinasikan dengan tim gudang untuk cek resi dan tenangkan pembeli secara ramah',
        draftWA: 'Halo Pak! Untuk paket pesanannya sedang kami mintakan nomor resinya ke tim gudang ya pak. Mohon ditunggu sebentar ya pak 🙏',
      }),
    });

    const transcript = '[CS] Siang pak untuk paketnya udah di kirim yaa mohon di tunggu barangnya sampe😊';

    const result = await LeadProfilerService.processConversation({
      ...BASE_INPUT,
      rawTranscript: transcript,
    });

    expect(result).not.toBeNull();
    // Titik krusial hasil verifikasi ulang Fase 34: LLM ASLI TETAP dipanggil (bukan bypass) --
    // `buyerOnlyText` kosong (tidak ada tag [BUYER]/[LEAD] sama sekali) TIDAK memicu bypass
    // apa pun (isAfterSalesStr/isShortNonIntent/isLastMessageFromCS semua butuh sinyal dari
    // buyerOnlyText atau existingLeadData non-terminal). Assersi lama "mockComplete TIDAK
    // dipanggil" TERBUKTI SALAH saat divalidasi via dry-run ber-instrumentasi ke produksi.
    expect(mockComplete).toHaveBeenCalled();
    // Meski LLM genuine dipanggil & keluarkan conversion:'PENDING', flag yang dikirim ke
    // upsertLeadProfile WAJIB false -- krn tidak ada satu pun pesan dari PEMBELI di sesi aktif
    // ini (buyerOnlyText kosong), jadi "genuine LLM output" itu bukan bukti apa pun thd status
    // CLOSING yang sudah sah dari deal 15 Agustus.
    expect(mockUpsertLeadProfile).toHaveBeenCalledWith(
      expect.objectContaining({ conversion: 'PENDING', allowTerminalDowngrade: false }),
    );
  });

  it('varian isAfterSalesStr bypass BENERAN (pembeli sendiri yang bicara "kok belum sampai"): allowTerminalDowngrade tetap HARUS false meski via jalur bypass, bukan LLM', async () => {
    mockLeadFindFirst.mockResolvedValue(CLOSING_LEAD_HARIS);

    const transcript = [
      '[CS] Siang pak untuk paketnya udah di kirim yaa mohon di tunggu barangnya sampe😊',
      '[BUYER] Kok belum sampai ya paketnya pak, sudah 3 hari ini',
    ].join('\n');

    const result = await LeadProfilerService.processConversation({
      ...BASE_INPUT,
      rawTranscript: transcript,
    });

    expect(result).not.toBeNull();
    // Kali ini buyerOnlyText TIDAK kosong ("kok belum sampai" cocok AFTER_SALES_RESI_PATTERN),
    // jadi cabang bypass isAfterSalesStr betul-betul jalan -- LLM TIDAK dipanggil.
    expect(mockComplete).not.toHaveBeenCalled();
    // Meski ada bukti dari pembeli, ini tetap cabang bypass deterministik (bukan LLM asli) --
    // syarat `!bypassLlm` di Fase 34 tetap menahannya supaya guard Temuan 2.1 tidak tertembus
    // oleh bypass "belum sampai" rutin thd deal yang sudah closing sah.
    expect(mockUpsertLeadProfile).toHaveBeenCalledWith(
      expect.objectContaining({ allowTerminalDowngrade: false }),
    );
  });

  it('REGRESI WAJIB (Fase 32 tetap utuh): existingLeadData terminal + pesan BUKAN after-sales + LLM asli dipanggil -- allowTerminalDowngrade tetap true', async () => {
    mockLeadFindFirst.mockResolvedValue(CLOSING_LEAD_HARIS);
    mockComplete.mockResolvedValue({
      text: JSON.stringify({
        isInternalTeam: false,
        leadCategory: 'NEW_INBOUND',
        minatProduk: 'Bedog Betekok',
        lastInsight: 'Pelanggan baru mengisi form pemesanan, belum ada konfirmasi lanjutan.',
        conversion: 'PENDING',
        score: 20,
        reasons: [],
        objectionType: null,
        taktikCS: null,
        draftWA: null,
      }),
    });

    const transcript = [
      '[BUYER] Halo, saya mau pesan lagi Bedog Betekok ya, atas nama Haris.',
      '[CS] Hai pak Haris, terima kasih sudah mengisi form pemesanan Bedog Betekok! Apakah data diatas sudah betul pak?',
    ].join('\n');

    const result = await LeadProfilerService.processConversation({
      ...BASE_INPUT,
      rawTranscript: transcript,
    });

    expect(result).not.toBeNull();
    expect(mockComplete).toHaveBeenCalled();
    expect(mockUpsertLeadProfile).toHaveBeenCalledWith(
      expect.objectContaining({ conversion: 'PENDING', allowTerminalDowngrade: true }),
    );
  });
});
