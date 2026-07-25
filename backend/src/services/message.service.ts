import { proto } from '@whiskeysockets/baileys';
import { prisma } from '../config/prisma';
import { aiReplyQueue } from '../queues';
import { logger } from '../utils/logger';
import { baileysManager } from './baileys.service';
import { getIO } from '../websocket/handler';

export async function handleIncomingMessage(businessId: string, msg: proto.IWebMessageInfo) {
  try {
    const key = msg.key;
    const remoteJid = key?.remoteJid;
    const messageText = msg.message?.conversation
      || msg.message?.extendedTextMessage?.text
      || '';

    if (!remoteJid || !messageText) return;
    if (remoteJid.endsWith('@g.us')) return;

    const waNumber = remoteJid.split('@')[0];
    const waId = remoteJid;

    let lead = await prisma.lead.findUnique({
      where: { businessId_waNumber: { businessId, waNumber } },
    });

    if (!lead) {
      const pushName = msg.pushName || null;
      lead = await prisma.lead.create({
        data: {
          businessId,
          name: pushName,
          waNumber,
          waId,
          status: 'ACTIVE',
        },
      });
      logger.info(`New lead created for business ${businessId}: ${waNumber}`);
    }

    let conversation = await prisma.conversation.findFirst({
      where: {
        businessId,
        leadId: lead.id,
        status: { in: ['AI', 'HUMAN'] },
      },
    });

    if (!conversation) {
      conversation = await prisma.conversation.create({
        data: {
          businessId,
          leadId: lead.id,
          status: 'AI',
        },
      });
    }

    const savedMessage = await prisma.message.create({
      data: {
        businessId,
        conversationId: conversation.id,
        message: messageText,
        messageType: 'text',
        fromRole: 'LEAD',
      },
    });

    await prisma.lead.update({
      where: { id: lead.id },
      data: { lastMessageAt: new Date(), totalMessages: { increment: 1 } },
    });

    const io = getIO();
    if (io) {
      io.to(`business:${businessId}`).emit('chat:new', {
        conversationId: conversation.id,
        message: { ...savedMessage, fromRole: 'LEAD' },
        lead: { id: lead.id, name: lead.name, waNumber: lead.waNumber },
      });
    }

    if (conversation.status === 'AI') {
      await aiReplyQueue.add('generate-reply', {
        businessId,
        conversationId: conversation.id,
        leadId: lead.id,
        messageText,
        leadName: lead.name,
        waJid: waId,
      }, {
        priority: 1,
        jobId: `ai-reply-${conversation.id}-${Date.now()}`,
      });
    }
  } catch (error: any) {
    logger.error(`Error handling incoming message for business ${businessId}: ${error.message}`);
  }
}
