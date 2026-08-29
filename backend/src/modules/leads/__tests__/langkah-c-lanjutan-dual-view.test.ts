/**
 * Langkah C-lanjutan / Kelompok 2 (2026-08-18) — Arsitektur "Dual-View", regresi utk Temuan T1
 * (Langkah C Fase 25, didokumentasikan sbg residual risk terpisah, sekarang diperbaiki):
 *
 * Akar masalah: kompresi Head-Tail (10 baris awal + 25 baris akhir) dulu dilakukan DI HULU, di
 * dua pemanggil produksi (human-learning.service.ts jalur realtime, reconciliation-sweeper.
 * worker.ts jalur sweeper) SEBELUM rawTranscript sampai ke LeadProfilerService.processConversation.
 * Akibatnya Rule Engine (segmentSessions, isDeterministicClosing, matchKnownSku) ikut buta
 * terhadap closing yang terjadi di baris tengah yang "disembunyikan".
 *
 * Fix: Rule Engine sekarang SELALU membaca riwayat penuh dari Redis (maks 100 baris, sudah
 * dibatasi LTRIM sejak Fase 24 -- jadi murah/instan). Kompresi head-tail dipindah HANYA ke titik
 * konstruksi payload LLM (`LeadProfilerService.compressForLlm`, dipanggil tepat sebelum prompt
 * OpenRouter dibangun) -- biaya token tetap hemat, Rule Engine tidak lagi buta.
 *
 * Bonus fix: format baris buffer sekarang menyertakan timestamp epoch-ms opsional
 * (`SessionBoundaryParser.formatBufferLine`) supaya logika jeda >48 jam di `segmentSessions()`
 * (sebelumnya dead code krn timestamp selalu null utk format Tagged Buffer) bisa hidup normal --
 * dibuat backward-compatible (opsional) supaya baris format lama di Redis tidak rusak dibaca.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SessionBoundaryParser } from '../session-parser';

describe('SessionBoundaryParser.formatBufferLine / parseLines — timestamp epoch-ms (Dual-View)', () => {
  it('formatBufferLine menyertakan timestamp epoch-ms di dalam kurung siku kalau disediakan', () => {
    expect(SessionBoundaryParser.formatBufferLine('CS', 'halo kak', 1755500000000)).toBe(
      '[CS 1755500000000] halo kak',
    );
  });

  it('formatBufferLine identik format lama "[role] text" kalau timestamp tidak disediakan (backward compat)', () => {
    expect(SessionBoundaryParser.formatBufferLine('BUYER', 'halo\ndunia')).toBe('[BUYER] halo dunia');
  });

  it('parseLines membaca timestamp dari format baru "[CS <epoch>] text"', () => {
    const parsed = SessionBoundaryParser.parseLines('[CS 1755500000000] RINCIAN BIAYA sudah kami kirim kak');
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.senderRole).toBe('CS');
    expect(parsed[0]!.text).toBe('RINCIAN BIAYA sudah kami kirim kak');
    expect(parsed[0]!.timestamp).toEqual(new Date(1755500000000));
  });

  it('parseLines TETAP menghasilkan timestamp null utk format lama "[CS] text" (baris lama di Redis selama masa transisi tidak rusak)', () => {
    const parsed = SessionBoundaryParser.parseLines('[CS] halo kak, ada yang bisa dibantu?');
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.senderRole).toBe('CS');
    expect(parsed[0]!.timestamp).toBeNull();
  });

  it('round-trip: formatBufferLine lalu parseLines menghasilkan role/text/timestamp yang konsisten', () => {
    const ts = 1755500123456;
    const line = SessionBoundaryParser.formatBufferLine('BUYER', 'oke kak siap', ts);
    const parsed = SessionBoundaryParser.parseLines(line);
    expect(parsed[0]!.senderRole).toBe('BUYER');
    expect(parsed[0]!.text).toBe('oke kak siap');
    expect(parsed[0]!.timestamp!.getTime()).toBe(ts);
  });
});

describe('SessionBoundaryParser.segmentSessions — jeda >48 jam menghidupkan kembali split sesi (Dual-View)', () => {
  it('MEMISAH jadi 2 sesi kalau ada jeda >48 jam SETELAH sesi sebelumnya mencapai status terminal, dgn timestamp epoch-ms baru', () => {
    const t0 = 1755000000000; // basis waktu sembarang
    const lines = [
      SessionBoundaryParser.formatBufferLine('BUYER', 'halo kak mau tanya golok kebun', t0),
      SessionBoundaryParser.formatBufferLine('CS', 'baik kak, paketnya udah di kirim ya kemarin', t0 + 60_000),
      SessionBoundaryParser.formatBufferLine('BUYER', 'oke makasih kak', t0 + 120_000),
      // Jeda > 48 jam (50 jam) SETELAH pesan terminal di atas -> harus jadi sesi baru
      SessionBoundaryParser.formatBufferLine('BUYER', 'halo kak mau order lagi nih', t0 + 120_000 + 50 * 3600_000),
    ].join('\n');

    const result = SessionBoundaryParser.segmentSessions(lines);

    expect(result.totalSessions).toBe(2);
    expect(result.activeSession.messages).toHaveLength(1);
    expect(result.activeSession.messages[0]!.text).toBe('halo kak mau order lagi nih');
  });

  it('TIDAK memisah sesi kalau timestamp tidak ada (format lama, perilaku lama dipertahankan -- dead code sebelum Dual-View)', () => {
    const lines = [
      SessionBoundaryParser.formatBufferLine('BUYER', 'halo kak mau tanya golok kebun'),
      SessionBoundaryParser.formatBufferLine('CS', 'baik kak, paketnya udah di kirim ya kemarin'),
      SessionBoundaryParser.formatBufferLine('BUYER', 'oke makasih kak'),
      SessionBoundaryParser.formatBufferLine('BUYER', 'halo kak mau order lagi nih'),
    ].join('\n');

    const result = SessionBoundaryParser.segmentSessions(lines);

    // Tanpa timestamp, hasLongTimeGap selalu false -> tetap 1 sesi (perilaku lama, TIDAK regresi).
    expect(result.totalSessions).toBe(1);
    expect(result.activeSession.messages).toHaveLength(4);
  });
});

// ── Regresi inti: Rule Engine tidak lagi buta thd closing di baris tengah (Temuan T1) ──
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

describe('LeadProfilerService.processConversation — Rule Engine baca riwayat PENUH, tidak lagi buta thd closing di baris tengah (Langkah C Kelompok 2, Temuan T1)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRedisGet.mockResolvedValue(null);
    mockRedisSet.mockResolvedValue('OK');
    mockRedisDel.mockResolvedValue(1);
    mockCsHumanLearningFindFirst.mockResolvedValue(null);
    mockLeadDeleteMany.mockResolvedValue({ count: 0 });
    mockBusinessFindUnique.mockResolvedValue({ mengantarApiKey: 'fake-key' });
    mockLeadFindFirst.mockResolvedValue(null);
    mockGetReceiverScore.mockResolvedValue(null);
  });

  it('mendeteksi CLOSING dari sinyal deterministik yang terkubur di baris ke-20an dari 60 baris (dulu masuk zona "disembunyikan" head(10)+tail(25) kalau caller masih memotong duluan)', async () => {
    const filler = (n: number, role: 'CS' | 'BUYER') =>
      role === 'CS' ? `[CS] baik kak nomor ${n}, ada yang bisa dibantu lagi?` : `[BUYER] oke kak makasih infonya ${n}`;

    const lines: string[] = [];
    for (let i = 1; i <= 10; i++) lines.push(filler(i, i % 2 === 0 ? 'CS' : 'BUYER')); // head (tetap terlihat di kedua versi)
    // Zona TENGAH (baris 11-35 dari 60) -- ini yg "disembunyikan" kalau caller MASIH memotong di
    // hulu (head 10 + tail 25 dari 60 baris = baris 11-35 hilang). Sinyal closing deterministik
    // sengaja ditaruh di sini.
    for (let i = 11; i <= 19; i++) lines.push(filler(i, i % 2 === 0 ? 'CS' : 'BUYER'));
    lines.push('[CS] RINCIAN BIAYA: Golok Situmang 2, Total COD: 245000'); // baris 20
    lines.push('[BUYER] oke sudah benar, kirim sekarang kak'); // baris 21 -- konfirmasi closing
    for (let i = 22; i <= 35; i++) lines.push(filler(i, i % 2 === 0 ? 'CS' : 'BUYER'));
    for (let i = 36; i <= 60; i++) lines.push(filler(i, i % 2 === 0 ? 'CS' : 'BUYER')); // tail (tetap terlihat di kedua versi)

    expect(lines).toHaveLength(60);

    await LeadProfilerService.processConversation({
      ...BASE_INPUT,
      rawTranscript: lines.join('\n'),
    });

    expect(mockUpsertLeadProfile).toHaveBeenCalledTimes(1);
    const callArg = mockUpsertLeadProfile.mock.calls[0][0];
    // Sebelum fix: caller sudah memotong baris 11-35 SEBELUM sampai sini -> isDeterministicClosing
    // tidak pernah melihat "RINCIAN BIAYA...sudah benar...kirim sekarang" -> conversion tetap PENDING.
    // Sesudah fix: processConversation menerima 60 baris UTUH -> Rule Engine mendeteksinya -> CLOSING.
    expect(callArg.conversion).toBe('CLOSING');
    // Deteksi ini lolos gerbang LLM (deterministik) -- LLM TIDAK PERNAH dipanggil utk kasus ini.
    expect(mockComplete).not.toHaveBeenCalled();
  });

  it('compressForLlm HANYA memadatkan payload ke LLM, TIDAK PERNAH memodifikasi apa yg dibaca Rule Engine -- LLM tetap dipanggil dgn versi head-tail kalau transkrip panjang & TIDAK ada sinyal closing deterministik', async () => {
    const canary = 'CANARY_BARIS_TENGAH_UNIK_998877';
    const headMarker = 'HEAD_BARIS_AWAL_UNIK_111';
    const tailMarker = 'TAIL_BARIS_AKHIR_UNIK_999';

    const lines: string[] = [];
    lines.push(`[BUYER] ${headMarker} kak mau tanya-tanya dulu boleh?`);
    for (let i = 2; i <= 9; i++) lines.push(`[CS] baik kak silakan tanya nomor ${i}`);
    for (let i = 10; i <= 34; i++) {
      lines.push(i === 20 ? `[BUYER] ${canary} ini pertanyaan di tengah` : `[CS] oke kak nomor ${i} noted ya`);
    }
    for (let i = 35; i <= 59; i++) lines.push(`[BUYER] pertanyaan lanjutan nomor ${i} kak`);
    lines.push(`[BUYER] ${tailMarker} ini pertanyaan terakhir kak, boleh dijelasin lagi?`);

    mockComplete.mockResolvedValue({
      text: JSON.stringify({
        isInternalTeam: false,
        leadCategory: 'NEW_INBOUND',
        minatProduk: 'Golok Situmang 2',
        lastInsight: 'Pembeli masih tanya-tanya, belum deal.',
        conversion: 'PENDING',
        score: 40,
        reasons: [],
        objectionType: 'PRODUCT_INQUIRY',
        taktikCS: null,
        draftWA: null,
      }),
    });

    await LeadProfilerService.processConversation({
      ...BASE_INPUT,
      rawTranscript: lines.join('\n'),
    });

    expect(mockComplete).toHaveBeenCalledTimes(1);
    const promptContent: string = mockComplete.mock.calls[0]![1].messages[1].content;

    // LLM harus tetap menerima versi TERPADATKAN (head+tail), bukan 60 baris mentah -- token tetap hemat.
    expect(promptContent).toContain('pesan disembunyikan');
    expect(promptContent).toContain(headMarker);
    expect(promptContent).toContain(tailMarker);
    // Baris tengah (canary) TIDAK boleh muncul di payload LLM -- itu yg dipadatkan.
    expect(promptContent).not.toContain(canary);
  });
});
