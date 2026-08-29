import { Queue } from 'bullmq';
import { redisBull } from '../config/redis';

// ────────────────────────────────────────────────────────────────────────────────
// CAPI QUEUE — Fase 43 (2026-08-21)
//
// Antrian async untuk pengiriman event ke Meta Conversions API (CAPI).
// Pengiriman TIDAK sinkron di dalam transaksi leads.repository.ts — cuma
// di-enqueue di sini supaya lambat/gagalnya panggilan ke Meta tidak pernah
// memblokir atau membuat gagal write data lead itu sendiri.
//
// Worker terpisah (capi.worker.ts) yang memanggil Graph API, dengan retry +
// backoff eksponensial bawaan BullMQ.
// ────────────────────────────────────────────────────────────────────────────────

export type CapiEventName = string;

export interface CapiJobData {
  businessId: string;
  leadId: string;
  eventName: CapiEventName;

  /** Nomor WA E.164 (mis. "6281234567890") — di-hash SHA-256 di worker, TIDAK pernah disimpan polos */
  waNumber: string;

  /** Nama lead — opsional, dipakai untuk fn/ln di user_data kalau ada */
  name?: string | null;

  /** ctwa_clid dari klik iklan Click-to-WhatsApp — null untuk lead form-order */
  ctwaClid?: string | null;

  /** Data atribusi CAPI (fbp, fbc, dll) dari FormAttribution */
  fbp?: string | null;
  fbc?: string | null;
  clientUserAgent?: string | null;
  clientIp?: string | null;
  eventSourceUrl?: string | null;


  /** Pixel ID dari Business.metaCapiPixelId */
  pixelId: string;

  /** Access token TERENKRIPSI (AES-256-GCM, lihat crypto.service.ts) — didekripsi di worker */
  encryptedAccessToken: string;

  /** Test event code untuk tab Test Events di Meta Events Manager — null saat live */
  testEventCode?: string | null;

  /** WABA ID — dipakai untuk skenario CTWA (business_messaging) */
  wabaId?: string | null;

  /** Kode mata uang (default "IDR") */
  currency: string;

  /** Nilai transaksi dalam IDR — hanya untuk event Purchase */
  value?: number | null;

  /**
   * Timestamp closing dalam ISO string — dipakai sebagai suffix event_id Purchase
   * supaya REPEAT_ORDER (pembelian kedua) tidak di-dedupe dengan Purchase pertama
   * oleh Meta. Untuk Lead/ViewContent/AddToCart: tidak dipakai.
   */
  closingTimestamp?: string;
}

export const capiQueue = new Queue<CapiJobData>('meta-capi', {
  connection: redisBull,
  defaultJobOptions: {
    // 3 percobaan: backoff eksponensial 5s → 25s → 125s
    // Setelah 3 gagal, job masuk "failed" dan tidak mengganggu lead lain.
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: 200,
    removeOnFail: 100,
  },
});
