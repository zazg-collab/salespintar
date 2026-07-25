import { Boom } from '@hapi/boom';
import {
  makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  WASocket,
  AnyMessageContent,
  proto,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import * as QRCode from 'qrcode';
import path from 'path';
import fs from 'fs';
import { prisma } from '../config/prisma';
import { logger } from '../utils/logger';
import { env } from '../config/env';

interface BaileysInstance {
  sock: WASocket;
  businessId: string;
  waCredentialId: string;
}

class BaileysManager {
  private instances: Map<string, BaileysInstance> = new Map();
  private messageHandler: ((businessId: string, msg: proto.IWebMessageInfo) => Promise<void>) | null = null;
  private qrResolvers: Map<string, { resolve: (qr: string) => void; reject: (err: Error) => void }> = new Map();
  private reconnectCount: Map<string, number> = new Map();
  private maxReconnects = 5;

  setMessageHandler(handler: (businessId: string, msg: proto.IWebMessageInfo) => Promise<void>) {
    this.messageHandler = handler;
  }

  getSessionDir(businessId: string): string {
    const dir = path.resolve(env.WA_SESSIONS_DIR, businessId);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    return dir;
  }

  async connect(businessId: string, waitForQR: boolean = false): Promise<string | void> {
    if (this.instances.has(businessId)) {
      const existing = this.instances.get(businessId)!;
      const waId = existing.sock.user?.id;
      if (waitForQR) {
        if (waId) {
          const cred = await prisma.waCredential.findFirst({ where: { businessId } });
          if (cred?.qrCode) return cred.qrCode;
        }
        await this.disconnect(businessId);
      } else {
        if (waId) return;
        await this.disconnect(businessId);
      }
    }

    if (this.instances.size >= env.WA_MAX_CONNECTIONS) {
      throw new Error('Server at capacity: max WA connections reached');
    }

    const cred = await prisma.waCredential.findFirst({
      where: { businessId, status: { not: 'BANNED' } },
    });

    if (!cred) {
      throw new Error('No WhatsApp credential found for this business');
    }

    const sessionDir = this.getSessionDir(businessId);
    if (cred.sessionData) {
      const credsPath = path.join(sessionDir, 'creds.json');
      const sessionData = cred.sessionData as any;
      if (sessionData.creds) {
        fs.writeFileSync(credsPath, JSON.stringify(sessionData.creds, null, 2));
      }
    }

    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

    const sock = makeWASocket({
      auth: state,
      printQRInTerminal: false,
      syncFullHistory: false,
      emitOwnEvents: false,
      browser: ['SalesPintar', 'Chrome', '120.0'],
      logger: pino({ level: 'warn' }),
    });

    const instance: BaileysInstance = { sock, businessId, waCredentialId: cred.id };
    this.instances.set(businessId, instance);

    sock.ev.on('creds.update', async () => {
      await saveCreds();
      try {
        const credsPath = path.join(sessionDir, 'creds.json');
        if (fs.existsSync(credsPath)) {
          const credsData = JSON.parse(fs.readFileSync(credsPath, 'utf-8'));
          await prisma.waCredential.update({
            where: { id: cred.id },
            data: { sessionData: { creds: credsData } },
          });
        }
      } catch (err) {
        logger.error(`Failed to save creds for business ${businessId}`);
      }
    });

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        const qrBase64 = await QRCode.toDataURL(qr);
        await prisma.waCredential.update({
          where: { id: cred.id },
          data: {
            qrCode: qrBase64,
            qrExpiresAt: new Date(Date.now() + 60000),
            status: 'DISCONNECTED',
          },
        });
        const entry = this.qrResolvers.get(businessId);
        if (entry) {
          entry.resolve(qrBase64);
          this.qrResolvers.delete(businessId);
        }
        logger.info(`QR generated for business ${businessId}`);
      }

      if (connection === 'open') {
        const waId = sock.user?.id;
        if (!waId) return;
        const waNumber = waId?.split(':')[0]?.replace('@s.whatsapp.net', '') || '';
        await prisma.waCredential.update({
          where: { id: cred.id },
          data: {
            status: 'CONNECTED',
            waId,
            waNumber,
            qrCode: null,
            qrExpiresAt: null,
            lastConnectedAt: new Date(),
          },
        });
        logger.info(`WhatsApp connected for business ${businessId}`);
      }

      if (connection === 'close') {
        const err = lastDisconnect?.error as Boom;
        const statusCode = err?.output?.statusCode;
        const reason = err?.message || 'unknown';
        logger.warn(`WhatsApp closed for business ${businessId}: ${reason} (statusCode: ${statusCode})`);
        const shouldReconnect =
          statusCode === DisconnectReason.connectionLost ||
          statusCode === DisconnectReason.connectionClosed ||
          statusCode === DisconnectReason.restartRequired ||
          statusCode === DisconnectReason.timedOut;

        await prisma.waCredential.update({
          where: { id: cred.id },
          data: { status: 'DISCONNECTED' },
        });

        this.instances.delete(businessId);
        logger.info(`WhatsApp disconnected for business ${businessId}`);

        const entry = this.qrResolvers.get(businessId);
        if (entry) {
          entry.reject(new Error(`QR gagal: ${reason} (statusCode: ${statusCode})`));
          this.qrResolvers.delete(businessId);
        }

        if (shouldReconnect) {
          const attempts = this.reconnectCount.get(businessId) || 0;
          if (attempts < this.maxReconnects) {
            this.reconnectCount.set(businessId, attempts + 1);
            const delay = Math.min(5000 * Math.pow(2, attempts), 60000);
            logger.info(`Reconnecting WhatsApp for business ${businessId} (attempt ${attempts + 1}/${this.maxReconnects})...`);
            setTimeout(() => this.connect(businessId), delay);
          } else {
            logger.warn(`Max reconnection attempts reached for business ${businessId}`);
            this.reconnectCount.delete(businessId);
          }
        }
      }
    });

    sock.ev.on('messages.upsert', async (msg) => {
      for (const message of msg.messages) {
        if (message.key.fromMe) continue;
        const remoteJid = message.key.remoteJid || '';
        if (remoteJid.endsWith('@g.us')) continue;
        if (this.messageHandler) {
          await this.messageHandler(businessId, message);
        }
      }
    });

    if (waitForQR) {
      return this.waitForQR(businessId);
    }
  }

  private waitForQR(businessId: string): Promise<string> {
    return new Promise((resolve, reject) => {
      this.qrResolvers.set(businessId, { resolve, reject });
      setTimeout(() => {
        const entry = this.qrResolvers.get(businessId);
        if (entry) {
          this.qrResolvers.delete(businessId);
          reject(new Error('QR timeout'));
        }
      }, 60000);
    });
  }

  async disconnect(businessId: string): Promise<void> {
    const instance = this.instances.get(businessId);
    if (instance) {
      instance.sock.end(new Error('Disconnected by user'));
      this.instances.delete(businessId);
    }

    await prisma.waCredential.updateMany({
      where: { businessId },
      data: { status: 'DISCONNECTED', qrCode: null, qrExpiresAt: null },
    });
  }

  getStatus(businessId: string): string {
    const instance = this.instances.get(businessId);
    if (!instance) return 'DISCONNECTED';
    try {
      const ws = (instance.sock as any).ws;
      const readyState = ws?.readyState ?? ws?.socket?.readyState;
      return readyState === 1 ? 'CONNECTED' : 'DISCONNECTING';
    } catch {
      return 'DISCONNECTED';
    }
  }

  async sendMessage(businessId: string, jid: string, content: AnyMessageContent): Promise<any> {
    const instance = this.instances.get(businessId);
    if (!instance) throw new Error(`WhatsApp not connected for business ${businessId}`);
    return instance.sock.sendMessage(jid, content);
  }

  async sendTyping(businessId: string, jid: string): Promise<void> {
    const instance = this.instances.get(businessId);
    if (!instance) return;
    await instance.sock.sendPresenceUpdate('composing', jid);
  }

  getTotalConnections(): number {
    return this.instances.size;
  }

  isConnected(businessId: string): boolean {
    return this.instances.has(businessId) && this.getStatus(businessId) === 'CONNECTED';
  }

  async disconnectAll(): Promise<void> {
    for (const [businessId] of this.instances) {
      await this.disconnect(businessId);
    }
  }

  async connectAllActive(): Promise<void> {
    const activeCreds = await prisma.waCredential.findMany({
      where: { status: 'CONNECTED', business: { isActive: true } },
      include: { business: true },
    });

    for (const cred of activeCreds) {
      try {
        await this.connect(cred.businessId);
      } catch (err) {
        logger.error(`Failed to reconnect business ${cred.businessId}: ${err}`);
      }
    }
  }
}

export const baileysManager = new BaileysManager();
