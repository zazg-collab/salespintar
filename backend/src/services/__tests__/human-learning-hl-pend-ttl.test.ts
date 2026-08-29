/**
 * Langkah D Fase 26 (Kelompok 1, 2026-08-18) — regresi utk Temuan R3: kunci Redis
 * `hl:pend:{sessionId}:cs` / `hl:pend:{sessionId}:buyer` sebelumnya TIDAK PERNAH diberi
 * TTL/dihapus (dibuat via INCR auto-create, hanya di-DECRBY balik ke 0 di
 * `commitPendingCounts()`, tidak pernah DEL/EXPIRE) — kebocoran keyspace Redis lambat seiring
 * bertambahnya sesi CS baru. Dikonfirmasi 2 finder + 2 skeptic independen: TERBUKTI.
 *
 * Fix: EXPIRE 30 hari di titik INCR (diperpanjang tiap ada aktivitas), + DEL eksplisit di
 * `commitPendingCounts()` begitu kedua penghitung balik ke 0.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockRedisIncr,
  mockRedisExpire,
  mockRedisMget,
  mockRedisDecrby,
  mockRedisDel,
  mockPrismaSessionUpdate,
} = vi.hoisted(() => ({
  mockRedisIncr: vi.fn(),
  mockRedisExpire: vi.fn(),
  mockRedisMget: vi.fn(),
  mockRedisDecrby: vi.fn(),
  mockRedisDel: vi.fn(),
  mockPrismaSessionUpdate: vi.fn(),
}));

vi.mock('../../config/env', () => ({
  env: {
    HL_BUFFER_MIN_MESSAGES: 2,
    HL_BUFFER_FLUSH_AT_LINES: 10,
    HL_BUFFER_IDLE_SEC: 600,
    WA_SESSIONS_DIR: './wa_sessions',
  },
}));

vi.mock('../../config/redis', () => ({
  redisCache: {
    incr: mockRedisIncr,
    expire: mockRedisExpire,
    mget: mockRedisMget,
    decrby: mockRedisDecrby,
    del: mockRedisDel,
  },
}));

vi.mock('../../config/prisma', () => ({
  prisma: {
    csHumanLearningSession: { update: mockPrismaSessionUpdate },
  },
}));

vi.mock('../../queues/shadow-mining.queue', () => ({
  shadowMiningQueue: { add: vi.fn() },
}));

vi.mock('../../modules/leads/lead-profiler.service', () => ({
  LeadProfilerService: { processConversation: vi.fn() },
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

describe('HumanLearningManager.commitPendingCounts — TTL & DEL kunci hl:pend:* (Langkah D, Temuan R3)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('kunci hl:pend:* DIHAPUS (DEL) begitu kedua penghitung balik ke 0 setelah dititipkan ke DB', async () => {
    mockRedisMget
      .mockResolvedValueOnce(['3', '2']) // baca nilai sebelum commit (cs=3, buyer=2)
      .mockResolvedValueOnce(['0', '0']); // baca ulang setelah decrby -> sudah 0/0
    mockPrismaSessionUpdate.mockResolvedValue({});
    mockRedisDecrby.mockResolvedValue(0);
    mockRedisDel.mockResolvedValue(1);

    await (humanLearningManager as any).commitPendingCounts('session-1', {});

    expect(mockPrismaSessionUpdate).toHaveBeenCalledTimes(1);
    expect(mockRedisDecrby).toHaveBeenCalledWith('hl:pend:session-1:cs', 3);
    expect(mockRedisDecrby).toHaveBeenCalledWith('hl:pend:session-1:buyer', 2);
    // Sebelumnya: kunci TIDAK PERNAH di-DEL, tertinggal bernilai "0" selamanya.
    expect(mockRedisDel).toHaveBeenCalledWith('hl:pend:session-1:cs');
    expect(mockRedisDel).toHaveBeenCalledWith('hl:pend:session-1:buyer');
  });

  it('kunci hl:pend:* TIDAK dihapus kalau ada pesan baru masuk di tengah proses (nilai terkini masih > 0)', async () => {
    mockRedisMget
      .mockResolvedValueOnce(['3', '2']) // sebelum commit
      .mockResolvedValueOnce(['1', '0']); // setelah decrby: cs masih 1 (pesan baru masuk di tengah), buyer 0
    mockPrismaSessionUpdate.mockResolvedValue({});
    mockRedisDecrby.mockResolvedValue(1);
    mockRedisDel.mockResolvedValue(1);

    await (humanLearningManager as any).commitPendingCounts('session-2', {});

    // cs masih ada isi (1) -> JANGAN dihapus supaya pesan yang masuk di celah waktu tidak hilang.
    expect(mockRedisDel).not.toHaveBeenCalledWith('hl:pend:session-2:cs');
    // buyer sudah 0 -> aman dihapus.
    expect(mockRedisDel).toHaveBeenCalledWith('hl:pend:session-2:buyer');
  });
});
