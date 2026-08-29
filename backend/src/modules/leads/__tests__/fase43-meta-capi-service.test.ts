/**
 * Fase 43 (2026-08-21) — Unit test Meta CAPI service (capi.service.ts)
 *
 * Mencakup:
 * - hashPhone: normalisasi E.164 + hash SHA-256
 * - buildEventId: deterministik (Lead/ViewContent/AddToCart) vs unik (Purchase)
 * - sendCapiEvent: action_source selection, payload structure, fetch call
 * - enqueueCapiIfNeeded:
 *     • Gerbang PROSPEK_IKLAN (GERBANG 2)
 *     • Gerbang metaCapiEnabled + token + pixelId (GERBANG 1)
 *     • Deteksi lead baru → enqueue Lead event
 *     • Deteksi naik stage → ViewContent (WARM+) + AddToCart (HOT+)
 *     • Dedup via capiEventsSent[]
 *     • Deteksi CLOSING/REPEAT_ORDER → enqueue Purchase
 *     • REPEAT_ORDER kedua (pembelian ulang) → enqueue Purchase lagi (tidak diblokir)
 *     • Error tidak melempar (hanya log)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock module-level dependencies sebelum import ──

const {
  mockPrismaBusinessFindUnique,
  mockPrismaLeadUpdate,
  mockCapiQueueAdd,
  mockDecrypt,
  mockFetch,
  mockLogger,
} = vi.hoisted(() => ({
  mockPrismaBusinessFindUnique: vi.fn(),
  mockPrismaLeadUpdate: vi.fn(),
  mockCapiQueueAdd: vi.fn(),
  mockDecrypt: vi.fn(),
  mockFetch: vi.fn(),
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
  decrypt: mockDecrypt,
}));

vi.mock('../../../utils/logger', () => ({
  logger: mockLogger,
}));

// Patch global fetch
vi.stubGlobal('fetch', mockFetch);

import crypto from 'crypto';
import {
  hashPhone,
  hashName,
  buildEventId,
  sendCapiEvent,
  enqueueCapiIfNeeded,
  STAGE_RANK,
  type CapiHookParams,
} from '../../../services/capi.service';
import type { CapiJobData } from '../../../queues/capi.queue';

// ── Helper: business CAPI config lengkap ──
function mockBusiness(overrides: Partial<{
  metaCapiEnabled: boolean;
  metaCapiPixelId: string | null;
  metaCapiAccessToken: string | null;
  metaCapiTestEventCode: string | null;
  metaCapiWabaId: string | null;
  metaCapiCurrency: string;
}> = {}) {
  return {
    metaCapiEnabled: true,
    metaCapiPixelId: 'PIXEL123',
    metaCapiAccessToken: 'encrypted:token:here',
    metaCapiTestEventCode: null,
    metaCapiWabaId: null,
    metaCapiCurrency: 'IDR',
    ...overrides,
  };
}

// ── Helper: base hook params (PROSPEK_IKLAN, lead baru) ──
function baseParams(overrides: Partial<CapiHookParams> = {}): CapiHookParams {
  return {
    businessId: 'biz-001',
    leadId: 'lead-abc',
    waNumber: '6281234567890',
    name: 'Budi Santoso',
    ctwaClid: null,
    finalLeadCategory: 'PROSPEK_IKLAN',
    finalStage: 'COLD',
    prevStage: 'COLD',
    atomicConversion: 'PENDING',
    prevConversion: 'PENDING',
    capiEventsSent: [],
    confirmedCodAmount: null,
    isNewLead: true,
    ...overrides,
  };
}

// ── Helper: base sendCapiEvent job data ──
function baseJobData(overrides: Partial<CapiJobData> = {}): CapiJobData {
  return {
    businessId: 'biz-001',
    leadId: 'lead-abc',
    eventName: 'Lead',
    waNumber: '6281234567890',
    name: 'Budi Santoso',
    ctwaClid: null,
    pixelId: 'PIXEL123',
    encryptedAccessToken: 'encrypted:token:here',
    testEventCode: null,
    wabaId: null,
    currency: 'IDR',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDecrypt.mockReturnValue('real-access-token-abc');
  mockFetch.mockResolvedValue({
    ok: true,
    text: async () => JSON.stringify({ events_received: 1 }),
  } as Response);
  mockPrismaBusinessFindUnique.mockResolvedValue(mockBusiness());
  mockPrismaLeadUpdate.mockResolvedValue({});
  mockCapiQueueAdd.mockResolvedValue({ id: 'job-1' });
});

// ════════════════════════════════════════════════════════════════════════════════
// hashPhone
// ════════════════════════════════════════════════════════════════════════════════

describe('hashPhone — normalisasi + SHA-256', () => {
  it('nomor 62xxx menghasilkan hash SHA-256 dari versi apa adanya', () => {
    const hash = hashPhone('6281234567890');
    const expected = crypto.createHash('sha256').update('6281234567890').digest('hex');
    expect(hash).toBe(expected);
  });

  it('nomor tanpa prefix 62 otomatis ditambahkan 62', () => {
    const hash = hashPhone('81234567890');
    const expected = crypto.createHash('sha256').update('6281234567890').digest('hex');
    expect(hash).toBe(expected);
  });

  it('nomor dengan karakter non-digit dibersihkan dulu', () => {
    const hash = hashPhone('+62 812-3456-7890');
    const expected = crypto.createHash('sha256').update('6281234567890').digest('hex');
    expect(hash).toBe(expected);
  });

  it('REGRESI: dua nomor berbeda harus menghasilkan hash berbeda', () => {
    expect(hashPhone('6281234567890')).not.toBe(hashPhone('6289876543210'));
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// buildEventId
// ════════════════════════════════════════════════════════════════════════════════

describe('buildEventId — deterministik vs unik', () => {
  it('Lead: deterministik — hasil sama tiap panggilan', () => {
    expect(buildEventId('Lead', 'lead-abc')).toBe('lead-abc-Lead');
    expect(buildEventId('Lead', 'lead-abc')).toBe('lead-abc-Lead');
  });

  it('ViewContent: deterministik', () => {
    expect(buildEventId('ViewContent', 'lead-abc')).toBe('lead-abc-ViewContent');
  });

  it('AddToCart: deterministik', () => {
    expect(buildEventId('AddToCart', 'lead-abc')).toBe('lead-abc-AddToCart');
  });

  it('Purchase dengan closingTimestamp: format leadId-PURCHASE-timestamp', () => {
    const ts = '2026-08-21T10:00:00.000Z';
    expect(buildEventId('Purchase', 'lead-abc', ts)).toBe('lead-abc-PURCHASE-2026-08-21T10:00:00.000Z');
  });

  it('Purchase tanpa closingTimestamp: fallback deterministik', () => {
    expect(buildEventId('Purchase', 'lead-abc')).toBe('lead-abc-Purchase');
  });

  it('REGRESI: Purchase dengan timestamp berbeda menghasilkan event_id berbeda (untuk REPEAT_ORDER)', () => {
    const ts1 = '2026-08-20T08:00:00.000Z';
    const ts2 = '2026-08-21T10:00:00.000Z';
    expect(buildEventId('Purchase', 'lead-abc', ts1)).not.toBe(buildEventId('Purchase', 'lead-abc', ts2));
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// sendCapiEvent — payload dan action_source
// ════════════════════════════════════════════════════════════════════════════════

describe('sendCapiEvent — payload + action_source', () => {
  it('tanpa ctwaClid: action_source = chat (bukan business_messaging)', async () => {
    await sendCapiEvent(baseJobData({ ctwaClid: null }));

    const [url, init] = mockFetch.mock.calls[0];
    const body = JSON.parse(init.body as string);
    expect(body.data[0].action_source).toBe('chat');
    expect(body.data[0]).not.toHaveProperty('ctwa_clid');
    expect(body.data[0]).not.toHaveProperty('messaging_channel');
  });

  it('dengan ctwaClid: action_source = business_messaging + messaging_channel + ctwa_clid', async () => {
    await sendCapiEvent(baseJobData({ ctwaClid: 'ARABCdef_ctwa_12345' }));

    const [, init] = mockFetch.mock.calls[0];
    const body = JSON.parse(init.body as string);
    const event = body.data[0];
    expect(event.action_source).toBe('business_messaging');
    expect(event.messaging_channel).toBe('whatsapp');
    expect(event.ctwa_clid).toBe('ARABCdef_ctwa_12345');
  });

  it('ctwaClid + wabaId: whatsapp_business_account_id disertakan', async () => {
    await sendCapiEvent(baseJobData({ ctwaClid: 'CTWA123', wabaId: 'WABA456' }));

    const [, init] = mockFetch.mock.calls[0];
    const body = JSON.parse(init.body as string);
    expect(body.data[0].whatsapp_business_account_id).toBe('WABA456');
  });

  it('payload mengandung user_data.ph (hashed phone)', async () => {
    await sendCapiEvent(baseJobData({ waNumber: '6281234567890' }));

    const [, init] = mockFetch.mock.calls[0];
    const body = JSON.parse(init.body as string);
    const expectedPh = hashPhone('6281234567890');
    expect(body.data[0].user_data.ph).toBe(expectedPh);
  });

  it('payload mengandung user_data.fn + ln kalau nama ada', async () => {
    await sendCapiEvent(baseJobData({ name: 'Budi Santoso' }));

    const [, init] = mockFetch.mock.calls[0];
    const body = JSON.parse(init.body as string);
    const { fn, ln } = body.data[0].user_data;
    expect(fn).toBe(hashName('Budi'));
    expect(ln).toBe(hashName('Santoso'));
  });

  it('nama satu kata: hanya fn, tidak ada ln', async () => {
    await sendCapiEvent(baseJobData({ name: 'Budi' }));

    const [, init] = mockFetch.mock.calls[0];
    const body = JSON.parse(init.body as string);
    expect(body.data[0].user_data.fn).toBeDefined();
    expect(body.data[0].user_data.ln).toBeUndefined();
  });

  it('event Lead: tidak ada custom_data', async () => {
    await sendCapiEvent(baseJobData({ eventName: 'Lead' }));

    const [, init] = mockFetch.mock.calls[0];
    const body = JSON.parse(init.body as string);
    expect(body.data[0]).not.toHaveProperty('custom_data');
  });

  it('event Purchase: custom_data.currency + value disertakan', async () => {
    await sendCapiEvent(baseJobData({ eventName: 'Purchase', value: 250000, currency: 'IDR' }));

    const [, init] = mockFetch.mock.calls[0];
    const body = JSON.parse(init.body as string);
    expect(body.data[0].custom_data).toEqual({ currency: 'IDR', value: 250000 });
  });

  it('event Purchase value null: custom_data.value = 0 + warn log', async () => {
    await sendCapiEvent(baseJobData({ eventName: 'Purchase', value: null }));

    const [, init] = mockFetch.mock.calls[0];
    const body = JSON.parse(init.body as string);
    expect(body.data[0].custom_data.value).toBe(0);
    expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('value=0'));
  });

  it('test_event_code disertakan kalau ada', async () => {
    await sendCapiEvent(baseJobData({ testEventCode: 'TEST12345' }));

    const [, init] = mockFetch.mock.calls[0];
    const body = JSON.parse(init.body as string);
    expect(body.test_event_code).toBe('TEST12345');
  });

  it('fetch gagal (HTTP 400): throw error supaya BullMQ retry', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      text: async () => '{"error":{"message":"Invalid pixel"}}',
    } as unknown as Response);

    await expect(sendCapiEvent(baseJobData())).rejects.toThrow('HTTP 400');
  });

  it('access_token tidak pernah ada di URL — hanya di body', async () => {
    await sendCapiEvent(baseJobData());

    const [url] = mockFetch.mock.calls[0];
    expect(url).not.toContain('access_token');
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// enqueueCapiIfNeeded — gates + event detection
// ════════════════════════════════════════════════════════════════════════════════

describe('enqueueCapiIfNeeded — gerbang & deteksi event', () => {
  it('GERBANG 2: leadCategory bukan PROSPEK_IKLAN → tidak ada job', async () => {
    await enqueueCapiIfNeeded(baseParams({ finalLeadCategory: 'NEW_INBOUND' }));
    expect(mockCapiQueueAdd).not.toHaveBeenCalled();
    expect(mockPrismaBusinessFindUnique).not.toHaveBeenCalled();
  });

  it('GERBANG 2: leadCategory OTHERS → tidak ada job', async () => {
    await enqueueCapiIfNeeded(baseParams({ finalLeadCategory: 'OTHERS' }));
    expect(mockCapiQueueAdd).not.toHaveBeenCalled();
  });

  it('GERBANG 1: metaCapiEnabled = false → tidak ada job', async () => {
    mockPrismaBusinessFindUnique.mockResolvedValueOnce(mockBusiness({ metaCapiEnabled: false }));
    await enqueueCapiIfNeeded(baseParams());
    expect(mockCapiQueueAdd).not.toHaveBeenCalled();
  });

  it('GERBANG 1: metaCapiAccessToken null → tidak ada job', async () => {
    mockPrismaBusinessFindUnique.mockResolvedValueOnce(mockBusiness({ metaCapiAccessToken: null }));
    await enqueueCapiIfNeeded(baseParams());
    expect(mockCapiQueueAdd).not.toHaveBeenCalled();
  });

  it('GERBANG 1: metaCapiPixelId null → tidak ada job', async () => {
    mockPrismaBusinessFindUnique.mockResolvedValueOnce(mockBusiness({ metaCapiPixelId: null }));
    await enqueueCapiIfNeeded(baseParams());
    expect(mockCapiQueueAdd).not.toHaveBeenCalled();
  });

  it('Lead baru (isNewLead=true, COLD, capiEventsSent=[]) → enqueue Lead saja', async () => {
    await enqueueCapiIfNeeded(baseParams({
      finalStage: 'COLD',
      prevStage: 'COLD',
      isNewLead: true,
    }));

    expect(mockCapiQueueAdd).toHaveBeenCalledTimes(1);
    expect(mockCapiQueueAdd).toHaveBeenCalledWith('Lead-lead-abc', expect.objectContaining({
      eventName: 'Lead',
    }));
  });

  it('Lead baru langsung HOT → Lead + ViewContent + AddToCart', async () => {
    await enqueueCapiIfNeeded(baseParams({
      finalStage: 'HOT',
      prevStage: 'COLD',
      isNewLead: true,
    }));

    expect(mockCapiQueueAdd).toHaveBeenCalledTimes(3);
    const calls = mockCapiQueueAdd.mock.calls.map(([, data]) => data.eventName);
    expect(calls).toContain('Lead');
    expect(calls).toContain('ViewContent');
    expect(calls).toContain('AddToCart');
  });

  it('Lead baru langsung VERY_HOT → Lead + ViewContent + AddToCart', async () => {
    await enqueueCapiIfNeeded(baseParams({
      finalStage: 'VERY_HOT',
      prevStage: 'COLD',
      isNewLead: true,
    }));

    const calls = mockCapiQueueAdd.mock.calls.map(([, data]) => data.eventName);
    expect(calls).toContain('Lead');
    expect(calls).toContain('ViewContent');
    expect(calls).toContain('AddToCart');
    expect(mockCapiQueueAdd).toHaveBeenCalledTimes(3);
  });

  it('existing lead COLD→WARM → hanya ViewContent (bukan Lead)', async () => {
    await enqueueCapiIfNeeded(baseParams({
      finalStage: 'WARM',
      prevStage: 'COLD',
      isNewLead: false,
    }));

    expect(mockCapiQueueAdd).toHaveBeenCalledTimes(1);
    const [, data] = mockCapiQueueAdd.mock.calls[0];
    expect(data.eventName).toBe('ViewContent');
  });

  it('existing lead WARM→HOT → hanya AddToCart (ViewContent sudah di capiEventsSent)', async () => {
    await enqueueCapiIfNeeded(baseParams({
      finalStage: 'HOT',
      prevStage: 'WARM',
      isNewLead: false,
      capiEventsSent: ['Lead', 'ViewContent'],
    }));

    expect(mockCapiQueueAdd).toHaveBeenCalledTimes(1);
    const [, data] = mockCapiQueueAdd.mock.calls[0];
    expect(data.eventName).toBe('AddToCart');
  });

  it('stage tidak berubah (existing HOT, masih HOT) → tidak ada job', async () => {
    await enqueueCapiIfNeeded(baseParams({
      finalStage: 'HOT',
      prevStage: 'HOT',
      isNewLead: false,
      capiEventsSent: ['Lead', 'ViewContent', 'AddToCart'],
    }));

    expect(mockCapiQueueAdd).not.toHaveBeenCalled();
  });

  it('ViewContent sudah di capiEventsSent → tidak di-enqueue lagi', async () => {
    await enqueueCapiIfNeeded(baseParams({
      finalStage: 'WARM',
      prevStage: 'COLD',
      isNewLead: false,
      capiEventsSent: ['Lead', 'ViewContent'],
    }));

    expect(mockCapiQueueAdd).not.toHaveBeenCalled();
  });

  it('transisi ke CLOSING → enqueue Purchase', async () => {
    await enqueueCapiIfNeeded(baseParams({
      finalStage: 'HOT',
      prevStage: 'HOT',
      atomicConversion: 'CLOSING',
      prevConversion: 'PENDING',
      isNewLead: false,
      capiEventsSent: ['Lead', 'ViewContent', 'AddToCart'],
    }));

    expect(mockCapiQueueAdd).toHaveBeenCalledTimes(1);
    const [, data] = mockCapiQueueAdd.mock.calls[0];
    expect(data.eventName).toBe('Purchase');
    expect(data.closingTimestamp).toBeDefined();
  });

  it('Purchase: confirmedCodAmount diteruskan sebagai value', async () => {
    await enqueueCapiIfNeeded(baseParams({
      atomicConversion: 'CLOSING',
      prevConversion: 'PENDING',
      confirmedCodAmount: 375000,
      isNewLead: false,
      capiEventsSent: ['Lead', 'ViewContent', 'AddToCart'],
    }));

    const [, data] = mockCapiQueueAdd.mock.calls.find(([, d]) => d.eventName === 'Purchase')!;
    expect(data.value).toBe(375000);
  });

  it('REPEAT_ORDER (purchase kedua) → enqueue Purchase lagi (tidak diblokir capiEventsSent)', async () => {
    await enqueueCapiIfNeeded(baseParams({
      atomicConversion: 'REPEAT_ORDER',
      prevConversion: 'CLOSING',  // sudah pernah CLOSING
      isNewLead: false,
      capiEventsSent: ['Lead', 'ViewContent', 'AddToCart'],  // Purchase TIDAK ada di sini
    }));

    expect(mockCapiQueueAdd).toHaveBeenCalledTimes(1);
    const [, data] = mockCapiQueueAdd.mock.calls[0];
    expect(data.eventName).toBe('Purchase');
  });

  it('conversion sudah CLOSING dan tidak berubah → tidak enqueue Purchase lagi', async () => {
    await enqueueCapiIfNeeded(baseParams({
      atomicConversion: 'CLOSING',
      prevConversion: 'CLOSING',  // sudah CLOSING sebelumnya, tidak ada transisi baru
      isNewLead: false,
      capiEventsSent: ['Lead', 'ViewContent', 'AddToCart'],
    }));

    expect(mockCapiQueueAdd).not.toHaveBeenCalled();
  });

  it('capiEventsSent diupdate di DB setelah enqueue one-time events', async () => {
    await enqueueCapiIfNeeded(baseParams({
      finalStage: 'WARM',
      prevStage: 'COLD',
      isNewLead: true,
    }));

    expect(mockPrismaLeadUpdate).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'lead-abc' },
      data: expect.objectContaining({
        capiEventsSent: expect.arrayContaining(['Lead', 'ViewContent']),
      }),
    }));
  });

  it('Purchase tidak menambah capiEventsSent (supaya REPEAT_ORDER tidak terblokir)', async () => {
    await enqueueCapiIfNeeded(baseParams({
      atomicConversion: 'CLOSING',
      prevConversion: 'PENDING',
      isNewLead: false,
      capiEventsSent: ['Lead', 'ViewContent', 'AddToCart'],
    }));

    // Karena tidak ada one-time events baru, DB update tidak terpanggil
    expect(mockPrismaLeadUpdate).not.toHaveBeenCalled();
  });

  it('error di prisma.business.findUnique → tidak throw (hanya log error)', async () => {
    mockPrismaBusinessFindUnique.mockRejectedValueOnce(new Error('DB timeout'));

    await expect(enqueueCapiIfNeeded(baseParams())).resolves.toBeUndefined();
    expect(mockLogger.error).toHaveBeenCalledWith(expect.stringContaining('enqueueCapiIfNeeded gagal'));
  });

  it('error di capiQueue.add → tidak throw (hanya log error)', async () => {
    mockCapiQueueAdd.mockRejectedValueOnce(new Error('Redis connection refused'));

    await expect(enqueueCapiIfNeeded(baseParams())).resolves.toBeUndefined();
    expect(mockLogger.error).toHaveBeenCalledWith(expect.stringContaining('enqueueCapiIfNeeded gagal'));
  });
});
