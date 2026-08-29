import { Job } from 'bullmq';
import { logger } from '../utils/logger';
import type { ReconciliationSweeperJobData, ReconciliationSweeperResult } from './reconciliation-sweeper.queue';
import { redisCache as redisClient } from '../config/redis';
import { prisma } from '../config/prisma';
import { LeadProfilerService } from '../modules/leads/lead-profiler.service';
import { pecahKunciBuffer, crmSedangDijeda } from '../services/human-learning.service';

export async function handleReconciliationSweeper(
  job: Job<ReconciliationSweeperJobData, ReconciliationSweeperResult>,
): Promise<ReconciliationSweeperResult> {
  // Langkah B Fase 24 (Temuan B): sebelumnya sweeper ini TIDAK PERNAH memeriksa jeda CRM sama
  // sekali — beda dg jalur realtime (human-learning.service.ts) yang menahan diri kalau
  // `crmSedangDijeda()`, dan beda juga dg sepupu-nya `sweepDailyBatch` yg SUDAH memeriksa
  // `hlSedangDijeda()`. Akibatnya menjeda "AI CRM Lead Profiling" tidak benar-benar berhenti —
  // sweeper 7x/hari tetap diam-diam mereklasifikasi lead PENDING di latar belakang. Pola cek
  // di sini disamakan dg `sweepDailyBatch` (cek sekali di awal run, bukan per-key — konsisten dg
  // asumsi single-tenant `crmSedangDijeda()` saat ini, lihat catatan di definisinya).
  if (await crmSedangDijeda()) {
    logger.info('[ReconciliationSweeper] Penyapuan dilewati — AI CRM Lead Profiling sedang DIJEDA');
    return { diperiksa: 0, diperbarui: 0, dilewati: 0 };
  }

  logger.info(`[ReconciliationSweeper] Memulai proses penyapuan riwayat lengkap (Full-Transcript)...`);

  // Cari semua kunci hl:full_history:*
  let cursor = '0';
  const keys: string[] = [];
  do {
    const [nextCursor, batch] = await redisClient.scan(cursor, 'MATCH', 'hl:full_history:*', 'COUNT', 100);
    cursor = nextCursor;
    keys.push(...batch);
  } while (cursor !== '0');

  let diperiksa = 0;
  let diperbarui = 0;
  let dilewati = 0;

  for (const key of keys) {
    diperiksa++;
    const parts = key.split(':');
    if (parts.length < 5) {
      dilewati++;
      continue;
    }
    // format: hl:full_history:{businessId}:{csPhone}:{contactJid}
    const businessId = parts[2]!;
    const csPhone = parts[3]!;
    const contactJid = parts.slice(4).join(':');
    const sanitizedContactPhone = contactJid.replace(/[^0-9]/g, '');

    // Cek di DB apakah lead ini berstatus PENDING.
    // Jika CLOSING atau LOST, kita LEWATI untuk menghindari "Zombie Closing" (status tertimpa mundur).
    try {
      const existingLead = await prisma.lead.findFirst({
        where: { businessId, waNumber: sanitizedContactPhone },
        select: { conversionStatus: true, id: true },
      });

      if (!existingLead || existingLead.conversionStatus !== 'PENDING') {
        dilewati++;
        continue;
      }

      // Ambil riwayat dengan strategi Head-Tail (10 baris awal + 25 baris akhir)
      const bufLen = await redisClient.llen(key);
      let fullTranscript = '';
      if (bufLen <= 35) {
        const lines = await redisClient.lrange(key, 0, -1);
        if (!lines || lines.length === 0) {
          dilewati++;
          continue;
        }
        fullTranscript = lines.join('\n');
      } else {
        const head = await redisClient.lrange(key, 0, 9);
        const tail = await redisClient.lrange(key, -25, -1);
        fullTranscript = head.join('\n') + `\n\n[... ${bufLen - 35} pesan disembunyikan ...]\n\n` + tail.join('\n');
      }
      
      // Kirim ke LeadProfilerService
      // Karena Gatekeeper sudah aktif, ini akan aman dari Token Explosion
      await LeadProfilerService.processConversation({
        businessId,
        contactJid,
        csPhone,
        rawTranscript: fullTranscript,
      });

      diperbarui++;
    } catch (err) {
      logger.error(`[ReconciliationSweeper] Gagal memproses ${key}: ${err}`);
      dilewati++;
    }
  }

  logger.info(`[ReconciliationSweeper] Selesai: ${diperiksa} diperiksa, ${diperbarui} diperbarui, ${dilewati} dilewati.`);
  return { diperiksa, diperbarui, dilewati };
}
