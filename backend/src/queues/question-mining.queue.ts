import { Queue } from 'bullmq';
import { redisBull } from '../config/redis';

/**
 * Satu job = satu file chat.
 *
 * Dipecah per file, bukan satu job per sesi, supaya progresnya bisa dilaporkan
 * apa adanya ("7 dari 40 file") dan satu file rusak tidak menjatuhkan seluruh
 * unggahan. Transkrip ikut di payload karena zip-nya sudah dibongkar di endpoint
 * dan tidak disimpan ke disk di mana pun.
 */
export interface QuestionMiningJobData {
  sessionId: string;
  businessId: string;
  /** Nama file asal, dipakai untuk log kalau ada yang gagal. */
  filename: string;
  /** Hanya ucapan PELANGGAN. Ucapan CS sudah dibuang di endpoint — inti fitur ini. */
  customerLines: string[];
}

export interface QuestionMiningResult {
  created: number;
  merged: number;
  skipped?: string;
}

/**
 * Buang seluruh job yang belum berjalan milik satu sesi.
 *
 * Job yang SEDANG berjalan tidak bisa dicabut dari luar — BullMQ tidak punya
 * mekanisme membunuh job aktif. Itu ditangani dari sisi lain: worker memeriksa
 * status sesi sebelum mulai bekerja, jadi job aktif terakhir akan berhenti
 * sendiri begitu gilirannya selesai.
 */
export async function removeSessionJobs(sessionId: string): Promise<number> {
  const jobs = await questionMiningQueue.getJobs(['waiting', 'delayed', 'paused']);
  let removed = 0;
  for (const job of jobs) {
    if (job.data?.sessionId !== sessionId) continue;
    // Job bisa saja sudah berpindah keadaan di antara pembacaan dan penghapusan;
    // kegagalan di sini tidak berarti pembatalannya gagal.
    await job.remove().catch(() => undefined);
    removed++;
  }
  return removed;
}

/**
 * Berapa job yang masih hidup untuk tiap sesi. Dipakai saat server menyala untuk
 * membedakan "masih jalan" dari "nyangkut": sesi yang di database berstatus
 * berjalan tapi tidak punya satu pun job tersisa berarti pekerjaannya memang
 * sudah lenyap — biasanya karena server mati di tengah proses.
 */
export async function countLiveJobsBySession(): Promise<Set<string>> {
  const jobs = await questionMiningQueue.getJobs(['waiting', 'delayed', 'active', 'paused']);
  const alive = new Set<string>();
  for (const job of jobs) {
    const id = job.data?.sessionId;
    if (id) alive.add(id);
  }
  return alive;
}

export const questionMiningQueue = new Queue<QuestionMiningJobData>('question-mining', {
  connection: redisBull,
  defaultJobOptions: {
    // Tiga percobaan dengan jeda menaik: kegagalan paling lazim di sini adalah
    // jatah token Groq yang habis sesaat, dan itu sembuh sendiri kalau ditunggu.
    attempts: 3,
    backoff: { type: 'exponential', delay: 30000 },
    removeOnComplete: 200,
    removeOnFail: 50,
  },
});
