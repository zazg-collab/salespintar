/**
 * Fase 44 (2026-08-21) — Integration-lite test: hook enqueueCapiIfNeeded di
 * leads.repository.ts::upsertLeadProfile()
 *
 * Strategi test: mock leads.repository.ts tidak feasible untuk test hook internal-nya,
 * jadi test ini berdiri sendiri: memanggil enqueueCapiIfNeeded() langsung dengan
 * params yang merepresentasikan apa yang dikirim leads.repository.ts di berbagai skenario.
 *
 * Kasus yang dicakup:
 * - Existing lead WARM→HOT → AddToCart dienqueue, ViewContent (sudah ada) tidak
 * - Existing lead PENDING→CLOSING → Purchase dienqueue dengan closingTimestamp
 * - Lead baru (isNewLead=true) VERY_HOT → Lead + ViewContent + AddToCart
 * - REPEAT_ORDER (pembelian kedua) → Purchase lagi, tidak terblokir
 * - Business dengan CAPI disabled → tidak ada job
 * - finalLeadCategory bukan PROSPEK_IKLAN → tidak ada job
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockPrismaBusinessFindUnique,
  mockPrismaLeadUpdate,
  mockCapiQueueAdd,
  mockLogger,
} = vi.hoisted(() => ({
  mockPrismaBusinessFindUnique: vi.fn(),
  mockPrismaLeadUpdate: vi.fn(),
  mockCapiQueueAdd: vi.fn(),
  mockLogger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../../../config/prisma', () => ({
  prisma: {
    business: { findUnique: mockPrismaBusinessFindUnique },
    lead: { update: mockPrismaLeadUpdate },
  },
}));

vi.mock('../../../queues/capi.queue', () => ({
  capiQueue: { add: mockCapiQueueAdd },
  STAGE_RANK: { COLD: 0, WARM: 1, HOT: 2, VERY_HOT: 3 },
}));

vi.mock('../../../services/crypto.service', () => ({
  decrypt: vi.fn().mockReturnValue('real-token'),
}));

vi.mock('../../../utils/logger', () => ({
  logger: mockLogger,
}));

vi.stubGlobal('fetch', vi.fn());

import { enqueueCapiIfNeeded, type CapiHookParams } from '../../../services/capi.service';

// ── Helpers ──
const BIZA = 'biz-cordova';
const LEAD = 'lead-123';

function makeBusiness(overrides = {}) {
  return {
    metaCapiEnabled: true,
    metaCapiPixelId: 'PIX_TEST',
    metaCapiAccessToken: 'enc:tok:abc',
    metaCapiTestEventCode: null,
    metaCapiWabaId: null,
    metaCapiCurrency: 'IDR',
    ...overrides,
  };
}

function params(overrides: Partial<CapiHookParams>): CapiHookParams {
  return {
    businessId: BIZA,
    leadId: LEAD,
    waNumber: '6285693309931',
    name: 'Hendra Jaya',
    ctwaClid: null,
    finalLeadCategory: 'PROSPEK_IKLAN',
    finalStage: 'COLD',
    prevStage: 'COLD',
    atomicConversion: 'PENDING',
    prevConversion: 'PENDING',
    capiEventsSent: [],
    confirmedCodAmount: null,
    isNewLead: false,
    ...overrides,
  };
}

function enqueuedEvents() {
  return mockCapiQueueAdd.mock.calls.map(([, data]) => data.eventName as string);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPrismaBusinessFindUnique.mockResolvedValue(makeBusiness());
  mockPrismaLeadUpdate.mockResolvedValue({});
  mockCapiQueueAdd.mockResolvedValue({ id: 'j-1' });
});

// ════════════════════════════════════════════════════════════════════════════════
// Skenario: existing lead update (isNewLead = false)
// ════════════════════════════════════════════════════════════════════════════════

describe('Fase 44 — skenario existing lead update', () => {
  it('WARM→HOT: hanya AddToCart (ViewContent sudah di capiEventsSent)', async () => {
    await enqueueCapiIfNeeded(params({
      finalStage: 'HOT',
      prevStage: 'WARM',
      capiEventsSent: ['Lead', 'ViewContent'],
    }));

    expect(enqueuedEvents()).toEqual(['AddToCart']);
  });

  it('COLD→WARM: hanya ViewContent (Lead sudah di capiEventsSent)', async () => {
    await enqueueCapiIfNeeded(params({
      finalStage: 'WARM',
      prevStage: 'COLD',
      capiEventsSent: ['Lead'],
    }));

    expect(enqueuedEvents()).toEqual(['ViewContent']);
  });

  it('PENDING→CLOSING: hanya Purchase + closingTimestamp di-set', async () => {
    await enqueueCapiIfNeeded(params({
      finalStage: 'HOT',
      prevStage: 'HOT',
      atomicConversion: 'CLOSING',
      prevConversion: 'PENDING',
      capiEventsSent: ['Lead', 'ViewContent', 'AddToCart'],
      confirmedCodAmount: 165000,
    }));

    const events = enqueuedEvents();
    expect(events).toEqual(['Purchase']);
    const [, purchaseData] = mockCapiQueueAdd.mock.calls[0];
    expect(purchaseData.value).toBe(165000);
    expect(purchaseData.closingTimestamp).toBeDefined();
    // event_id Purchase harus unik (berisi closingTimestamp)
    expect(purchaseData.closingTimestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('CLOSING→REPEAT_ORDER: Purchase lagi (tidak terblokir)', async () => {
    await enqueueCapiIfNeeded(params({
      finalStage: 'HOT',
      prevStage: 'HOT',
      atomicConversion: 'REPEAT_ORDER',
      prevConversion: 'CLOSING',
      capiEventsSent: ['Lead', 'ViewContent', 'AddToCart'],
    }));

    expect(enqueuedEvents()).toEqual(['Purchase']);
  });

  it('atomicConversion tidak berubah (CLOSING→CLOSING): tidak ada Purchase baru', async () => {
    await enqueueCapiIfNeeded(params({
      atomicConversion: 'CLOSING',
      prevConversion: 'CLOSING',
      capiEventsSent: ['Lead', 'ViewContent', 'AddToCart'],
    }));

    expect(mockCapiQueueAdd).not.toHaveBeenCalled();
  });

  it('ctwaClid ada: diteruskan ke job data', async () => {
    await enqueueCapiIfNeeded(params({
      finalStage: 'WARM',
      prevStage: 'COLD',
      ctwaClid: 'ARABxyz_ctwa_abc',
      capiEventsSent: ['Lead'],
    }));

    const [, data] = mockCapiQueueAdd.mock.calls[0];
    expect(data.ctwaClid).toBe('ARABxyz_ctwa_abc');
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// Skenario: lead baru (isNewLead = true)
// ════════════════════════════════════════════════════════════════════════════════

describe('Fase 44 — skenario lead baru', () => {
  it('lead baru COLD: hanya Lead', async () => {
    await enqueueCapiIfNeeded(params({ isNewLead: true, finalStage: 'COLD', prevStage: 'COLD' }));
    expect(enqueuedEvents()).toEqual(['Lead']);
  });

  it('lead baru WARM: Lead + ViewContent', async () => {
    await enqueueCapiIfNeeded(params({ isNewLead: true, finalStage: 'WARM', prevStage: 'COLD' }));
    expect(enqueuedEvents()).toContain('Lead');
    expect(enqueuedEvents()).toContain('ViewContent');
    expect(enqueuedEvents()).not.toContain('AddToCart');
  });

  it('lead baru VERY_HOT: Lead + ViewContent + AddToCart (3 event)', async () => {
    await enqueueCapiIfNeeded(params({ isNewLead: true, finalStage: 'VERY_HOT', prevStage: 'COLD' }));
    expect(enqueuedEvents().sort()).toEqual(['AddToCart', 'Lead', 'ViewContent']);
    expect(mockCapiQueueAdd).toHaveBeenCalledTimes(3);
  });

  it('capiEventsSent diupdate di DB setelah Lead dikirim', async () => {
    await enqueueCapiIfNeeded(params({ isNewLead: true, finalStage: 'COLD' }));

    expect(mockPrismaLeadUpdate).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: LEAD },
      data: expect.objectContaining({
        capiEventsSent: expect.arrayContaining(['Lead']),
      }),
    }));
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// Gerbang & robustness
// ════════════════════════════════════════════════════════════════════════════════

describe('Fase 44 — gerbang & robustness', () => {
  it('CAPI disabled: tidak ada job, tidak crash', async () => {
    mockPrismaBusinessFindUnique.mockResolvedValueOnce(makeBusiness({ metaCapiEnabled: false }));
    await enqueueCapiIfNeeded(params({ isNewLead: true }));
    expect(mockCapiQueueAdd).not.toHaveBeenCalled();
  });

  it('NEW_INBOUND lead: tidak ada job sama sekali', async () => {
    await enqueueCapiIfNeeded(params({ finalLeadCategory: 'NEW_INBOUND', isNewLead: true }));
    expect(mockCapiQueueAdd).not.toHaveBeenCalled();
    expect(mockPrismaBusinessFindUnique).not.toHaveBeenCalled();
  });

  it('error prisma business lookup: resolve (tidak throw), log error', async () => {
    mockPrismaBusinessFindUnique.mockRejectedValueOnce(new Error('connection reset'));
    await expect(enqueueCapiIfNeeded(params({ isNewLead: true }))).resolves.toBeUndefined();
    expect(mockLogger.error).toHaveBeenCalled();
  });

  it('testEventCode diteruskan ke job', async () => {
    mockPrismaBusinessFindUnique.mockResolvedValueOnce(makeBusiness({ metaCapiTestEventCode: 'TEST00001' }));
    await enqueueCapiIfNeeded(params({ isNewLead: true }));
    const [, data] = mockCapiQueueAdd.mock.calls[0];
    expect(data.testEventCode).toBe('TEST00001');
  });

  it('pixelId diteruskan ke job', async () => {
    await enqueueCapiIfNeeded(params({ isNewLead: true }));
    const [, data] = mockCapiQueueAdd.mock.calls[0];
    expect(data.pixelId).toBe('PIX_TEST');
  });

  it('encryptedAccessToken (terenkripsi) diteruskan ke job — TIDAK pernah didekripsi di sini', async () => {
    await enqueueCapiIfNeeded(params({ isNewLead: true }));
    const [, data] = mockCapiQueueAdd.mock.calls[0];
    // Yang dikirim ke job adalah ciphertext, bukan plaintext
    expect(data.encryptedAccessToken).toBe('enc:tok:abc');
  });
});
