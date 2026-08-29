/**
 * Regresi Audit Tahap 2 — Langkah A (2026-08-18)
 *
 * Temuan 2.1: Guard anti-downgrade CLOSING hanya menahan transisi ke PENDING,
 * TIDAK menahan transisi ke LOST — dan `isLost` yang dikirim ke
 * LeadScoringEngine.resolveNextStage() dihitung SEBELUM guard tsb sempat
 * melindungi, sehingga skor/stage lead yang sudah CLOSING ikut dipaksa
 * turun ke COLD walau statusnya sendiri berhasil "diselamatkan".
 *
 * Temuan 1.1/1.2: `findFirst` lalu `create` (bukan upsert atomik) untuk lead
 * baru membuka celah race Opsi A vs Opsi B menghasilkan DUA baris `leads`
 * untuk kontak yang sama.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockFindFirst, mockTransaction, mockTxFindUnique, mockTxUpdate, mockUpsert, mockCreate } = vi.hoisted(() => ({
  mockFindFirst: vi.fn(),
  mockTransaction: vi.fn(),
  mockTxFindUnique: vi.fn(),
  mockTxUpdate: vi.fn(),
  mockUpsert: vi.fn(),
  mockCreate: vi.fn(),
}));

vi.mock('../../../config/prisma', () => ({
  prisma: {
    lead: {
      findFirst: mockFindFirst,
      upsert: mockUpsert,
      create: mockCreate,
    },
    $transaction: mockTransaction,
  },
}));

vi.mock('../../../utils/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { LeadsRepository } from '../leads.repository';

describe('LeadsRepository.upsertLeadProfile — anti-downgrade CLOSING (Temuan 2.1)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTransaction.mockImplementation(async (cb: any) =>
      cb({
        lead: {
          findUnique: mockTxFindUnique,
          update: mockTxUpdate,
        },
      }),
    );
  });

  it('TIDAK menimpa lead CLOSING jadi LOST, dan TIDAK memaksa skor/stage turun ke COLD', async () => {
    mockFindFirst.mockResolvedValue({
      id: 'lead-1',
      name: 'Budi',
      createdAt: new Date('2026-08-15T10:00:00+07:00'),
      lastMessageAt: new Date('2026-08-15T10:05:00+07:00'),
      score: 90,
      leadCategory: 'NEW_INBOUND',
      leadStage: 'VERY_HOT',
      conversionStatus: 'CLOSING',
      totalMessages: 5,
      minatProduk: 'Golok Situmang 2',
      lastInsight: 'Sudah closing kemarin, COD dikonfirmasi.',
    });
    mockTxFindUnique.mockResolvedValue({ conversionStatus: 'CLOSING', name: 'Budi' });
    mockTxUpdate.mockImplementation(async ({ data }: any) => ({ id: 'lead-1', ...data }));

    await LeadsRepository.upsertLeadProfile({
      businessId: 'biz-1',
      rawJid: '6281234567890@s.whatsapp.net',
      csPhone: '628999999999',
      leadCategory: 'OTHERS',
      minatProduk: null,
      lastInsight: 'Sweeper salah membaca sesi lama sebagai batal.',
      conversion: 'LOST',
      score: 5,
      stage: 'COLD',
    });

    expect(mockTxUpdate).toHaveBeenCalledTimes(1);
    const dataArg = mockTxUpdate.mock.calls[0][0].data;
    expect(dataArg.conversionStatus).toBe('CLOSING');
    expect(dataArg.leadStage).toBe('VERY_HOT');
    expect(dataArg.score).toBe(90);
  });

  it('tetap mempertahankan proteksi lama: CLOSING tidak ditimpa PENDING', async () => {
    mockFindFirst.mockResolvedValue({
      id: 'lead-2',
      name: 'Sari',
      createdAt: new Date(),
      lastMessageAt: new Date(),
      score: 88,
      leadCategory: 'NEW_INBOUND',
      leadStage: 'VERY_HOT',
      conversionStatus: 'CLOSING',
      totalMessages: 3,
      minatProduk: 'Bedog Betekok',
      lastInsight: 'Sudah closing.',
    });
    mockTxFindUnique.mockResolvedValue({ conversionStatus: 'CLOSING', name: 'Sari' });
    mockTxUpdate.mockImplementation(async ({ data }: any) => ({ id: 'lead-2', ...data }));

    await LeadsRepository.upsertLeadProfile({
      businessId: 'biz-1',
      rawJid: '6281111111111@s.whatsapp.net',
      csPhone: '628999999999',
      leadCategory: 'OTHERS',
      minatProduk: null,
      lastInsight: 'CS-turn bypass salah baca ulang sebagai pending.',
      conversion: 'PENDING',
      score: 10,
      stage: 'COLD',
    });

    const dataArg = mockTxUpdate.mock.calls[0][0].data;
    expect(dataArg.conversionStatus).toBe('CLOSING');
  });

  it('lead yang MEMANG belum pernah closing tetap boleh berubah jadi LOST apa adanya', async () => {
    mockFindFirst.mockResolvedValue({
      id: 'lead-3',
      name: null,
      createdAt: new Date(),
      lastMessageAt: new Date(),
      score: 20,
      leadCategory: 'OTHERS',
      leadStage: 'WARM',
      conversionStatus: 'PENDING',
      totalMessages: 4,
      minatProduk: null,
      lastInsight: 'Masih tanya-tanya.',
    });
    mockTxFindUnique.mockResolvedValue({ conversionStatus: 'PENDING', name: null });
    mockTxUpdate.mockImplementation(async ({ data }: any) => ({ id: 'lead-3', ...data }));

    await LeadsRepository.upsertLeadProfile({
      businessId: 'biz-1',
      rawJid: '6282222222222@s.whatsapp.net',
      csPhone: '628999999999',
      leadCategory: 'OTHERS',
      minatProduk: null,
      lastInsight: 'Pembeli batal, tidak jadi beli.',
      conversion: 'LOST',
      score: 0,
      stage: 'COLD',
    });

    const dataArg = mockTxUpdate.mock.calls[0][0].data;
    expect(dataArg.conversionStatus).toBe('LOST');
    expect(dataArg.leadStage).toBe('COLD');
  });

  // Ronde Penyanggal Langkah A (2026-08-18): 3 finder independen + 1 penyanggal sepakat
  // TERBUKTI — guard anti-downgrade di atas cuma cek 'CLOSING', tidak 'REPEAT_ORDER',
  // padahal lead-profiler.service.ts memperlakukan keduanya setara sbg status terproteksi.
  it('TIDAK menimpa lead REPEAT_ORDER jadi PENDING/LOST, dan TIDAK memaksa skor/stage turun ke COLD', async () => {
    mockFindFirst.mockResolvedValue({
      id: 'lead-4',
      name: 'Joko',
      createdAt: new Date(),
      lastMessageAt: new Date(),
      score: 85,
      leadCategory: 'PROSPEK_IKLAN',
      leadStage: 'VERY_HOT',
      conversionStatus: 'REPEAT_ORDER',
      totalMessages: 12,
      minatProduk: 'Golok Naga Tarung',
      lastInsight: 'Repeat order sudah closing sebelumnya.',
    });
    mockTxFindUnique.mockResolvedValue({ conversionStatus: 'REPEAT_ORDER', name: 'Joko' });
    mockTxUpdate.mockImplementation(async ({ data }: any) => ({ id: 'lead-4', ...data }));

    await LeadsRepository.upsertLeadProfile({
      businessId: 'biz-1',
      rawJid: '6284444444444@s.whatsapp.net',
      csPhone: '628999999999',
      leadCategory: 'OTHERS',
      minatProduk: null,
      lastInsight: 'Basa-basi lanjutan salah dibaca sbg batal.',
      conversion: 'LOST',
      score: 5,
      stage: 'COLD',
    });

    const dataArg = mockTxUpdate.mock.calls[0][0].data;
    expect(dataArg.conversionStatus).toBe('REPEAT_ORDER');
    expect(dataArg.leadStage).toBe('VERY_HOT');
    expect(dataArg.score).toBe(85);
  });
});

describe('LeadsRepository.upsertLeadProfile — pembuatan lead baru (Temuan 1.1/1.2)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('memakai prisma.lead.upsert (bukan plain create) supaya race Opsi A vs Opsi B tidak menghasilkan baris duplikat', async () => {
    mockFindFirst.mockResolvedValue(null);
    mockUpsert.mockResolvedValue({ id: 'lead-new' });

    await LeadsRepository.upsertLeadProfile({
      businessId: 'biz-1',
      rawJid: '6283333333333@s.whatsapp.net',
      csPhone: '628999999999',
      leadCategory: 'NEW_INBOUND',
      minatProduk: 'Golok Naga',
      lastInsight: 'Prospek baru dari iklan.',
      conversion: 'PENDING',
      score: 30,
      stage: 'WARM',
    });

    expect(mockUpsert).toHaveBeenCalledTimes(1);
    expect(mockCreate).not.toHaveBeenCalled();
    const arg = mockUpsert.mock.calls[0][0];
    expect(arg.where).toEqual({
      businessId_waNumber: { businessId: 'biz-1', waNumber: '6283333333333' },
    });
  });
});
