import { Job } from 'bullmq';
import { prisma } from '../config/prisma';
import { logger } from '../utils/logger';
import type { CapiJobData } from './capi.queue';

// ────────────────────────────────────────────────────────────────────────────────
// CAPI WORKER — Fase 43 (2026-08-21)
//
// Executor sederhana: ambil job dari antrian "meta-capi", lalu panggil
// capi.service.sendCapiEvent(). Error di-throw supaya BullMQ bisa retry
// sampai attempts habis (setelah itu job masuk "failed").
//
// Import dinamis ke capi.service (lihat di handleCapiEvent) memutus potensi
// lingkaran import dengan modul lain yang mungkin mengimport dari queues/index.ts.
//
// Catatan khusus untuk event Lead:
// ctwaClid disetel oleh message.service.ts SETELAH leads.repository.ts membuat
// baris lead baru. Karena BullMQ memproses job secara async (bukan langsung),
// ada window aman: saat worker ini jalan, ctwaClid biasanya sudah tersimpan di DB.
// Worker ini membacanya ulang dari DB khusus untuk event Lead supaya
// action_source yang dipilih (business_messaging vs chat) tepat.
//
// Fix Fase 48 (2026-08-21): worker sekarang re-validasi state lead sebelum
// mengirim Purchase ke Meta. Ini lapisan ke-2 dari fix ghost Purchase:
//   Lapisan 1 (enqueueCapiIfNeeded): LOST lead tidak dienqueue
//   Lapisan 2 (worker ini): kalau lead sudah LOST saat job dieksekusi
//   (race condition window antara enqueue dan execute), job diabaikan.
// ────────────────────────────────────────────────────────────────────────────────

export async function handleCapiEvent(job: Job<CapiJobData>): Promise<void> {
  const { eventName, leadId } = job.data;
  logger.info(`[CAPI/worker] Job ${job.id}: event=${eventName} leadId=${leadId}`);

  let jobData = job.data;

  // Khusus event Lead: baca ulang ctwaClid dari DB kalau tidak ada di job data.
  // Ini mengatasi timing gap antara create lead di leads.repository.ts dan
  // save ctwaClid oleh message.service.ts (keduanya async, urut).
  if (eventName === 'Lead' && !jobData.ctwaClid) {
    const lead = await prisma.lead.findUnique({
      where: { id: leadId },
      select: { ctwaClid: true },
    });
    if (lead?.ctwaClid) {
      jobData = { ...jobData, ctwaClid: lead.ctwaClid };
      logger.debug(`[CAPI/worker] ctwaClid re-read dari DB untuk leadId=${leadId}: ${lead.ctwaClid}`);
    }
  }

  // Fix Fase 48: re-validasi state lead sebelum kirim Purchase ke Meta.
  // Gap antara enqueue dan eksekusi worker bisa memakan waktu beberapa detik sampai menit
  // (tergantung load BullMQ). Dalam window itu, lead bisa berubah dari CLOSING → LOST.
  // Tanpa guard ini, Purchase terkirim ke Meta walau deal sudah batal.
  if (eventName === 'Purchase') {
    const currentLead = await prisma.lead.findUnique({
      where: { id: leadId },
      select: { conversionStatus: true },
    });
    if (!currentLead || currentLead.conversionStatus === 'LOST') {
      logger.warn(
        `[CAPI/worker] Job ${job.id} diabaikan: Purchase untuk leadId=${leadId} ` +
        `tapi conversionStatus=${currentLead?.conversionStatus ?? 'NOT_FOUND'} (bukan CLOSING/REPEAT_ORDER). ` +
        `Lead mungkin sudah dikoreksi ke LOST setelah Purchase dienqueue.`
      );
      return; // jangan throw — biarkan job selesai sebagai "completed" bukan "failed"
    }
  }

  // Import dinamis untuk memutus lingkaran import (pola yang sama dengan debounce.worker.ts)
  const { sendCapiEvent } = await import('../services/capi.service');
  await sendCapiEvent(jobData);
}

