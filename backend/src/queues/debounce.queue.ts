import { Queue } from 'bullmq';
import { redisBull } from '../config/redis';

// ──────────────────────────────────────────────────────────────────────────────
// DEBOUNCE QUEUE — Fix Audit A5
//
// Pengganti setTimeout in-memory di message.service.ts. Tiap pesan masuk
// menjadwalkan satu delayed job; hanya job dengan nomor generasi terbaru yang
// benar-benar mem-flush buffer (lihat state.service.ts). Karena job hidup di
// Redis, instance manapun bisa mengeksekusinya — buffer tidak lagi hilang kalau
// instance yang menerima pesan pertama mati duluan.
// ──────────────────────────────────────────────────────────────────────────────

export interface DebounceFlushJobData {
  businessId: string;
  waNumber: string;
  /** Generasi buffer saat job dijadwalkan; job basi akan no-op. */
  generation: number;
}

export const debounceQueue = new Queue<DebounceFlushJobData>('debounce-flush', {
  connection: redisBull,
  defaultJobOptions: {
    // Sekali coba saja: kalau gagal, pesan susulan berikutnya akan menjadwalkan
    // job baru. Retry malah berisiko mengirim balasan ganda.
    attempts: 1,
    removeOnComplete: 200,
    removeOnFail: 50,
  },
});
