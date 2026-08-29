import { Queue } from 'bullmq';
import { redisBull } from '../config/redis';

export const SHADOW_MINING_QUEUE_NAME = 'shadow-mining';

/**
 * Tiga sumber bahan tambang.
 *
 * `conversation` — percakapan yang hidup di database SalesPintar (jalur asli).
 * `import` — transkrip lepas hasil impor ekspor chat WhatsApp. Sengaja TIDAK
 *   membuat baris Lead/Conversation/Message di database (keputusan Angga):
 *   tujuannya memanen pengetahuan, bukan mengisi CRM dengan ribuan kontak lama.
 * `human_learning` — chat pair yang sudah di-buffer dari sesi Baileys CS shadow.
 *   Penambangannya memakai mode penilaian 'lenient' (STOCK_PATTERN lebih longgar)
 *   karena chat CS manusia sering memakai kata "ready"/"tersedia"/"masih ada"
 *   dalam konteks non-stok. Dibedakan dari 'import' supaya perbedaan ini bisa
 *   dibaca jelas di log dan di frontmatter vault.
 *
 * `kind` dibuat opsional pada varian pertama supaya seluruh pemanggil yang sudah
 * ada tetap sah tanpa diubah.
 */
export type ShadowMiningJobData =
  | {
      kind?: 'conversation';
      conversationId: string;
      businessId: string;
      triggeredBy: 'auto' | 'manual';
    }
  | {
      kind: 'import';
      /** Transkrip siap pakai, sudah ditandai [CS]/[LEAD] oleh parser. */
      rawTranscript: string;
      /** Nama file asal — dipakai sebagai jejak di frontmatter dokumen hasil. */
      sourceLabel: string;
      businessId: string;
      triggeredBy: 'import';
    }
  | {
      kind: 'human_learning';
      /** Buffer chat pair yang sudah diakumulasi per kontak, sudah ditandai [CS]/[LEAD]. */
      rawTranscript: string;
      /** Label identifikasi: "cs:{csPhone}:contact:{contactJid}" */
      sourceLabel: string;
      businessId: string;
      triggeredBy: 'human_learning';
      /** Nama CS (untuk catatan frontmatter). */
      csName?: string;
      /** ID Sesi Human Learning untuk update analitik progres CS */
      csSessionId?: string;
      /** Stempel waktu pesan WhatsApp terakhir (epoch ms) */
      lastMessageTimestamp?: number;
    };

export type ShadowMiningResult =
  | { skipped: true; reason: 'too_few_messages' | 'no_knowledge_value' | 'extraction_failed' | 'duplicate_content' | 'already_mined' | 'conversation_not_found'; jobId: string }
  | { skipped: false; vaultPath: string; title: string; category: string; mode: string; jobId: string };

export const shadowMiningQueue = new Queue<ShadowMiningJobData>(SHADOW_MINING_QUEUE_NAME, {
  connection: redisBull,
  defaultJobOptions: {
    attempts: 2,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: { count: 200 },
    removeOnFail: { count: 100 },
  },
});
