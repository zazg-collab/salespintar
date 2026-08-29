/**
 * Langkah C Kelompok 2 (Dual-View, 2026-08-18) — regresi CALLER-LEVEL untuk jalur REALTIME
 * ("Realtime CRM Profiler" di `human-learning.service.ts`, dipanggil per pesan WA masuk lewat
 * `processIncomingMessages` / "Opsi A").
 *
 * Latar: dua skeptic independen pada Ronde Penyanggal fase ini mencatat bahwa test regresi yang
 * sudah ada (`modules/leads/__tests__/langkah-c-lanjutan-dual-view.test.ts`) memanggil
 * `LeadProfilerService.processConversation()` LANGSUNG — jadi hanya membuktikan Rule Engine di
 * dalamnya sudah benar (yang memang tidak pernah cacat), BUKAN membuktikan bahwa caller realtime
 * ini sungguh mengirim transkrip UTUH. Test simetris untuk caller sweeper ("Opsi B") sudah ada di
 * `queues/__tests__/reconciliation-sweeper.worker.test.ts` — test ini melengkapi sisi realtime-nya
 * supaya klaim "kedua caller diperbaiki" benar-benar dibuktikan lewat test, bukan cuma tinjauan
 * kode manual.
 *
 * Sebelum fix: baris di `processIncomingMessages` yang memanggil `LeadProfilerService
 * .processConversation()` memotong riwayat jadi head(10)+tail(25) SEBELUM diteruskan (variabel
 * `totalLen <= 35 ? full : head/tail`), sehingga baris tengah (mis. sinyal closing) hilang.
 * Sesudah fix: baca penuh dari `hl:full_history:*` (sudah dibatasi 100 baris via LTRIM sejak Fase
 * 24) lewat `redisClient.lrange(fKey, 0, -1)`, kompresi head-tail dipindah HANYA ke
 * `lead-profiler.service.ts::compressForLlm` (titik pembuatan payload LLM).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockRedisGet,
  mockRedisSet,
  mockRedisSadd,
  mockRedisExpire,
  mockRedisRpush,
  mockRedisLtrim,
  mockRedisLlen,
  mockRedisLrange,
  mockRedisIncr,
  mockRedisIncrby,
  mockRedisGetdel,
  mockProcessConversation,
} = vi.hoisted(() => ({
  mockRedisGet: vi.fn(),
  mockRedisSet: vi.fn(),
  mockRedisSadd: vi.fn(),
  mockRedisExpire: vi.fn(),
  mockRedisRpush: vi.fn(),
  mockRedisLtrim: vi.fn(),
  mockRedisLlen: vi.fn(),
  mockRedisLrange: vi.fn(),
  mockRedisIncr: vi.fn(),
  mockRedisIncrby: vi.fn(),
  mockRedisGetdel: vi.fn(),
  mockProcessConversation: vi.fn(),
}));

vi.mock('../../config/env', () => ({
  env: {
    HL_BUFFER_MIN_MESSAGES: 2,
    HL_BUFFER_FLUSH_AT_LINES: 9999, // tinggi sekali -- jangan sampai memicu flushBuffer di test ini
    HL_BUFFER_IDLE_SEC: 600,
    WA_SESSIONS_DIR: './wa_sessions',
  },
}));

vi.mock('../../config/redis', () => ({
  redisCache: {
    get: mockRedisGet,
    set: mockRedisSet,
    sadd: mockRedisSadd,
    expire: mockRedisExpire,
    rpush: mockRedisRpush,
    ltrim: mockRedisLtrim,
    llen: mockRedisLlen,
    lrange: mockRedisLrange,
    incr: mockRedisIncr,
    incrby: mockRedisIncrby,
    getdel: mockRedisGetdel,
  },
}));

vi.mock('../../config/prisma', () => ({
  prisma: {
    business: { findFirst: vi.fn().mockResolvedValue(null) },
    csHumanLearningSession: { update: vi.fn() },
  },
}));

vi.mock('../../queues/shadow-mining.queue', () => ({
  shadowMiningQueue: { add: vi.fn() },
}));

vi.mock('../../modules/leads/lead-profiler.service', () => ({
  LeadProfilerService: { processConversation: mockProcessConversation },
}));

vi.mock('../../utils/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@whiskeysockets/baileys', () => ({
  makeWASocket: vi.fn(),
  DisconnectReason: {},
  useMultiFileAuthState: vi.fn(),
  fetchLatestBaileysVersion: vi.fn(),
}));

import { humanLearningManager } from '../human-learning.service';

const BUSINESS_ID = 'biz-1';
const CS_PHONE = '628999';
const CS_NAME = 'CS Toko';
const SESSION_ID = `${BUSINESS_ID}:${CS_PHONE}`;
const BUYER_JID = '6281234567890@s.whatsapp.net'; // bentuk nomor -- lolos isPhoneForm, tidak
                                                    // menyentuh sock.signalRepository sama sekali

function fakeMessage(id: string, text: string, fromMe = false) {
  return {
    key: { remoteJid: BUYER_JID, id, fromMe },
    message: { conversation: text },
    messageTimestamp: Math.floor(Date.now() / 1000),
  } as any;
}

describe('HumanLearningManager.processIncomingMessages — Realtime CRM Profiler kirim riwayat PENUH (Langkah C Kelompok 2, Temuan T1)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // hlSedangDijeda() & crmSedangDijeda() baca KUNCI_JEDA_HL / KUNCI_JEDA_CRM dari Redis --
    // kembalikan '0' (tidak dijeda) supaya jalur Realtime CRM Profiler benar-benar dieksekusi.
    mockRedisGet.mockResolvedValue('0');
    mockRedisSadd.mockResolvedValue(1); // pesan dianggap baru (anti-dobel)
    mockRedisSet.mockResolvedValue('OK');
    mockRedisExpire.mockResolvedValue(1);
    mockRedisRpush.mockResolvedValue(1);
    mockRedisLtrim.mockResolvedValue('OK');
    mockRedisIncr.mockResolvedValue(1);
    mockRedisIncrby.mockResolvedValue(1);
    mockRedisGetdel.mockResolvedValue(null);
    mockRedisLlen.mockResolvedValue(1); // jauh di bawah HL_BUFFER_FLUSH_AT_LINES -- flushBuffer tidak terpicu
    mockProcessConversation.mockResolvedValue({ conversion: 'PENDING' });

    // Lewati throttle commitPendingCounts (di-test terpisah di human-learning-hl-pend-ttl.test.ts)
    // supaya test ini fokus murni ke perilaku Realtime CRM Profiler, tanpa perlu memalsukan
    // seluruh alur titip-ke-Postgres yang tidak relevan dengan Temuan T1.
    (humanLearningManager as any)._lastSeenUpdate.set(SESSION_ID, Date.now());
  });

  it('mengirim riwayat PENUH (bukan head(10)+tail(25)) ke LeadProfilerService -- baris tengah dari hl:full_history:* yang panjang harus tetap utuh sampai ke rawTranscript', async () => {
    const canary = 'CANARY_TENGAH_REALTIME_UNIK_77';
    const lines: string[] = [];
    for (let i = 1; i <= 10; i++) lines.push(`[CS] baris awal ${i}`);
    for (let i = 11; i <= 35; i++) lines.push(i === 20 ? `[BUYER] ${canary}` : `[CS] baris tengah ${i}`);
    for (let i = 36; i <= 60; i++) lines.push(`[BUYER] baris akhir ${i}`);
    expect(lines).toHaveLength(60);

    // hl:full_history:* -- ini yang dibaca `redisClient.lrange(fKey, 0, -1)` di Realtime CRM
    // Profiler. Isinya SUDAH termasuk pesan yang sedang diproses (append terjadi lebih dulu di
    // appendToBuffer(), sebelum blok Realtime CRM Profiler dieksekusi).
    mockRedisLrange.mockResolvedValue(lines);

    const fakeSock = {} as any; // tidak pernah didereferensi -- BUYER_JID sudah bentuk nomor
    await (humanLearningManager as any).processIncomingMessages(
      fakeSock,
      SESSION_ID,
      CS_PHONE,
      CS_NAME,
      BUSINESS_ID,
      [fakeMessage('wamid-1', 'pesan buyer terbaru, tidak relevan dengan canary')],
    );

    expect(mockProcessConversation).toHaveBeenCalledTimes(1);
    const callArg = mockProcessConversation.mock.calls[0]![0];
    // Sebelum fix: rawTranscript di sini SUDAH head(10)+tail(25) -- baris tengah (canary) hilang,
    // diganti marker "... N pesan disembunyikan ...". Sesudah fix: seluruh isi hl:full_history:*
    // (60 baris) diteruskan utuh, canary tetap ada, tidak ada marker kompresi.
    expect(callArg.rawTranscript).toContain(canary);
    expect(callArg.rawTranscript).not.toContain('disembunyikan');
    expect(callArg.rawTranscript.split('\n')).toHaveLength(60);
  });

  it('TIDAK memanggil LeadProfilerService sama sekali kalau AI CRM Lead Profiling (Pilar 3) sedang DIJEDA', async () => {
    mockRedisGet.mockImplementation((key: string) =>
      Promise.resolve(key === 'crm:jeda' ? '1' : '0'),
    );
    mockRedisLrange.mockResolvedValue(['[CS] baris 1', '[BUYER] baris 2']);

    const fakeSock = {} as any;
    await (humanLearningManager as any).processIncomingMessages(
      fakeSock,
      SESSION_ID,
      CS_PHONE,
      CS_NAME,
      BUSINESS_ID,
      [fakeMessage('wamid-2', 'halo')],
    );

    expect(mockProcessConversation).not.toHaveBeenCalled();
  });
});
