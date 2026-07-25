import { Job } from 'bullmq';
import { prisma } from '../config/prisma';
import { baileysManager } from '../services/baileys.service';
import { logger } from '../utils/logger';
import { getIO } from '../websocket/handler';
import { env } from '../config/env';

interface BroadcastJob {
  broadcastId: string;
  businessId: string;
}

export async function handleBroadcast(job: Job<BroadcastJob>) {
  const { broadcastId, businessId } = job.data;

  const broadcast = await prisma.broadcast.findUnique({
    where: { id: broadcastId },
    include: { business: true },
  });

  if (!broadcast || broadcast.status === 'CANCELLED') {
    logger.info(`Broadcast ${broadcastId} skipped or cancelled`);
    return;
  }

  await prisma.broadcast.update({
    where: { id: broadcastId },
    data: { status: 'SENDING' },
  });

  const leads = await prisma.lead.findMany({
    where: {
      businessId,
      status: 'ACTIVE',
      ...(broadcast.filter as any || {}),
    },
  });

  await prisma.broadcast.update({
    where: { id: broadcastId },
    data: { totalTarget: leads.length },
  });

  const io = getIO();
  let sent = 0;
  let failed = 0;

  for (let i = 0; i < leads.length; i += env.BROADCAST_BATCH_SIZE) {
    const batch = leads.slice(i, i + env.BROADCAST_BATCH_SIZE);

    for (const lead of batch) {
      try {
        if (!lead.waId) continue;

        const personalizedMessage = broadcast.templateVars.length > 0
          ? replaceVariables(broadcast.message, lead, broadcast.templateVars)
          : broadcast.message;

        const waId = lead.waId.includes('@s.whatsapp.net')
          ? lead.waId
          : `${lead.waId}@s.whatsapp.net`;

        const result = await baileysManager.sendMessage(businessId, waId, {
          text: personalizedMessage,
        });

        await prisma.broadcastLog.create({
          data: {
            businessId,
            broadcastId,
            leadId: lead.id,
            waMessageId: result?.key?.id || null,
            status: 'SENT',
            sentAt: new Date(),
          },
        });
        sent++;
      } catch (error: any) {
        failed++;
        await prisma.broadcastLog.create({
          data: {
            businessId,
            broadcastId,
            leadId: lead.id,
            status: 'FAILED',
            errorMessage: error.message,
          },
        });
      }
    }

    await prisma.broadcast.update({
      where: { id: broadcastId },
      data: { totalSent: sent, totalFailed: failed },
    });

    if (io) {
      io.to(`business:${businessId}`).emit('broadcast:progress', {
        broadcastId,
        sent,
        failed,
        total: leads.length,
      });
    }

    if (i + env.BROADCAST_BATCH_SIZE < leads.length) {
      await new Promise(resolve => setTimeout(resolve, env.BROADCAST_THROTTLE_MS));
    }
  }

  const finalStatus = failed === 0 ? 'SENT' : failed === leads.length ? 'FAILED' : 'PARTIAL';

  await prisma.broadcast.update({
    where: { id: broadcastId },
    data: { status: finalStatus, totalSent: sent, totalFailed: failed },
  });

  if (io) {
    io.to(`business:${businessId}`).emit('broadcast:progress', {
      broadcastId,
      sent,
      failed,
      total: leads.length,
      status: finalStatus,
    });
  }

  logger.info(`Broadcast ${broadcastId} completed: ${sent} sent, ${failed} failed`);
}

function replaceVariables(template: string, lead: any, vars: string[]): string {
  let result = template;
  for (const v of vars) {
    const key = v.toLowerCase();
    const value = String(lead[key] || lead[key === 'nama' ? 'name' : key] || '');
    result = result.replace(new RegExp(`\\{\\{\\s*${v}\\s*\\}\\}`, 'gi'), value);
  }
  return result;
}
