import { Queue } from 'bullmq';
import { redisBull } from '../config/redis';
import { env } from '../config/env';

// ──────────────────────────────────────────────────────────────────────────────
// PENYAPU BUFFER IDLE HUMAN LEARNING — Fase 63
//
// Antrean ini menutup lubang yang membuat "Fakta disimpan: 0" bertahan berhari-hari
// walau Human Learning jelas mendengar banyak pesan.
//
// Docstring di `human-learning.service.ts` mengklaim buffer dikirim ke Shadow
// Mining kalau "tidak ada pesan baru > 30 menit, diperiksa via BullMQ delayed
// job". **Job itu tidak pernah dibuat.** Yang benar-benar ada cuma satu jalur:
// buffer mencapai ambang jumlah baris. Buffer yang tidak pernah sampai ambang
// tidak pernah dikirim — dan lebih buruk, TTL Redis-nya dulu disetel SAMA dengan
// ambang idle-nya, jadi Redis MENGHAPUS buffer itu persis di saat ia seharusnya
// dikirim. Satu-satunya jalan lain adalah tombol Flush manual, yang tidak ada
// orang tahu harus ditekan.
//
// Kenapa job BERULANG dan bukan delayed job per buffer (seperti `debounce-flush`):
// debounce punya satu kunci per (business, waNumber) dengan nomor generasi, jadi
// satu job per pesan masih terkendali. Di sini kuncinya per (business, csPhone,
// kontak) dan pesan CS bisa datang beruntun puluhan kali per menit per kontak —
// satu delayed job per pesan berarti membanjiri Redis dengan job yang 99%-nya
// akan basi. Satu penyapu tiap beberapa menit yang memindai keadaan sekarang
// jauh lebih murah dan tidak bisa "kehilangan" buffer kalau satu job hilang.
//
// Payloadnya sengaja kosong: penyapu memeriksa SEMUA sesi lintas business, sebab
// buffer hidup di Redis dan tidak bergantung pada socket mana pun yang sedang
// tersambung. Itu juga yang membuatnya masih bekerja untuk sesi CS yang kebetulan
// sedang terputus — buffernya tetap terkirim, bukan menguap.
// ──────────────────────────────────────────────────────────────────────────────

/** ID penjadwal tetap — `upsertJobScheduler` memakainya supaya restart tidak menumpuk jadwal. */
export const HL_IDLE_FLUSH_SCHEDULER_ID = 'hl-daily-batch-berkala';

export type HlIdleFlushJobData = {
  targetDate?: string;
};

export interface HlIdleFlushResult {
  diperiksa: number;
  dikirim: number;
  belumWaktunya: number;
}

export const hlIdleFlushQueue = new Queue<HlIdleFlushJobData, HlIdleFlushResult>('hl-idle-flush', {
  connection: redisBull,
  defaultJobOptions: {
    attempts: 2,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: 50,
    removeOnFail: 20,
  },
});

/**
 * Pasang jadwal batch harian & checkpoint (Jam 00:01, 09:00, 12:00, 15:00, 18:00, 21:00 WIB - Asia/Jakarta).
 * Idempoten: `upsertJobScheduler` dengan ID tetap menimpa jadwal lama.
 */
export async function pasangJadwalBatchHarian(): Promise<void> {
  await hlIdleFlushQueue.upsertJobScheduler(
    HL_IDLE_FLUSH_SCHEDULER_ID,
    { pattern: '1 0,9,12,15,18,21 * * *', tz: 'Asia/Jakarta' },
    { name: 'daily-checkpoint-batch-flush' },
  );
}

// Alias backward compatibility
export const pasangJadwalPenyapuIdle = pasangJadwalBatchHarian;
