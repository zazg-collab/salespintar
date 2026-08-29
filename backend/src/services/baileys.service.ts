import { Boom } from '@hapi/boom';
import {
  makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  extractMessageContent,
  WASocket,
  AnyMessageContent,
  downloadMediaMessage,
  proto,
} from '@whiskeysockets/baileys';
import type { WAVersion } from '@whiskeysockets/baileys';
import pino from 'pino';
import * as QRCode from 'qrcode';
import path from 'path';
import fs from 'fs';
import { Prisma } from '@prisma/client';
import { prisma } from '../config/prisma';
import { logger } from '../utils/logger';
import { rememberBotSentMessage, wasSentByBot } from './state.service';
import { env } from '../config/env';
import { resolveIncomingJid } from '../utils/wa-jid';

interface BaileysInstance {
  sock: WASocket;
  businessId: string;
  waCredentialId: string;
  /** Kapan socket ini berhasil terhubung — dipakai mengukur umur sesi saat putus. */
  connectedAt?: number;
  /**
   * Kapan socket ini DIBUAT (belum tentu tersambung).
   *
   * Dibutuhkan pemantau kesehatan: selama jabat tangan berlangsung,
   * `ws.isOpen` masih `false`. Tanpa masa tenggang berbasis waktu ini, pemantau
   * akan menganggap setiap socket yang baru lahir sebagai bangkai, membunuhnya,
   * lalu membuat yang baru — dan itu justru pabrik socket ganda.
   */
  createdAt: number;
}

// ──────────────────────────────────────────────────────────────────────────────
// Negosiasi versi WhatsApp Web — perbaikan "Connection Failure (statusCode: 405)"
//
// Baileys memakai nomor versi WA Web yang DI-HARDCODE di lib/Defaults (pada
// 7.0.0-rc12: [2, 3000, 1035194821]). Begitu WhatsApp berhenti menerima versi
// itu, handshake ditolak dengan 405 dan QR tidak pernah terbit — persis gejala
// yang muncul 2026-07-29. Karena angkanya beku di dalam paket, menunggu update
// paket bukan solusi yang bisa diandalkan.
//
// Solusinya menanyakan versi terkini ke Baileys sebelum membuka socket. Hasilnya
// disimpan di memori proses supaya tidak menembak jaringan setiap kali connect,
// dan kalau pengambilan gagal kita diam-diam memakai versi bawaan — koneksi WA
// tidak boleh mati total hanya karena pengecekan versi tidak bisa dijangkau.
// ──────────────────────────────────────────────────────────────────────────────
let cachedWaVersion: WAVersion | null = null;

async function resolveWaVersion(): Promise<WAVersion | undefined> {
  if (cachedWaVersion) return cachedWaVersion;
  try {
    const { version, isLatest } = await fetchLatestBaileysVersion();
    cachedWaVersion = version;
    logger.info(`WA Web version: ${version.join('.')} (isLatest: ${isLatest})`);
    return version;
  } catch (err) {
    logger.warn(`Gagal mengambil versi WA Web terkini, memakai bawaan Baileys: ${err}`);
    return undefined; // makeWASocket akan memakai default paket
  }
}

/** Seberapa sering socket mati diperiksa. */
const HEALTH_CHECK_INTERVAL_MS = 30_000;

class BaileysManager {
  private instances: Map<string, BaileysInstance> = new Map();
  /**
   * Business yang sedang dalam proses connect.
   *
   * Tanpa penjaga ini, dua pemanggilan connect() yang beririsan — misalnya
   * pemulihan otomatis saat bootstrap bertabrakan dengan klik Reconnect dari
   * dashboard — sama-sama lolos pengecekan `instances.has()` (yang saat itu
   * masih kosong) lalu membuat DUA socket untuk sesi yang sama. WhatsApp
   * kemudian menendang salah satunya dengan connectionReplaced, instance-nya
   * dihapus, dan siklusnya berulang: konek sebentar lalu putus terus-menerus.
   */
  private connecting: Set<string> = new Set();
  private healthTimer: ReturnType<typeof setInterval> | null = null;
  private messageHandler: ((businessId: string, msg: proto.IWebMessageInfo) => Promise<void>) | null = null;
  /** Dipanggil saat ada pesan KELUAR yang bukan kiriman bot — artinya manusia
   *  mengetik dari HP atau WhatsApp Web. Lihat auto-pause di message.service. */
  private outgoingHandler: ((businessId: string, msg: proto.IWebMessageInfo) => Promise<void>) | null = null;
  private qrResolvers: Map<string, { resolve: (qr: string) => void; reject: (err: Error) => void }> = new Map();
  private reconnectCount: Map<string, number> = new Map();
  private maxReconnects = 5;

  setOutgoingHandler(handler: (businessId: string, msg: proto.IWebMessageInfo) => Promise<void>) {
    this.outgoingHandler = handler;
  }

  setMessageHandler(handler: (businessId: string, msg: proto.IWebMessageInfo) => Promise<void>) {
    this.messageHandler = handler;
  }

  /**
   * Pemantau kesehatan socket.
   *
   * Baileys tidak selalu memancarkan event `close` saat koneksi mati diam-diam —
   * laptop tidur, WiFi berpindah, atau kabel dicabut bisa membuat socket jadi
   * mayat tanpa ada yang memberi tahu. Selama itu instance tetap duduk di Map,
   * status terlihat hijau, dan setiap pesan yang dikirim menguap. Pemantau ini
   * yang menyadarkannya: socket mati dibersihkan lalu disambungkan ulang.
   */
  startHealthCheck(): void {
    if (this.healthTimer) return;
    this.healthTimer = setInterval(() => {
      for (const [businessId, instance] of this.instances) {
        if (this.masihHidup(instance)) continue;
        logger.warn(`[Health] Socket WA business ${businessId} sudah mati tanpa event close — dibersihkan & disambungkan ulang`);
        this.instances.delete(businessId);
        // Socket lamanya WAJIB ditutup, bukan cuma dilepas dari daftar.
        // Melepasnya saja meninggalkan socket zombi yang masih memegang sesi:
        // ia bisa bangun lagi sebentar, lalu WhatsApp menutup socket BARU kita
        // dengan conflict 440 — persis perang rebutan yang mau dihindari.
        try {
          instance.sock.end(new Error('Ditutup pemantau kesehatan'));
        } catch (err) {
          logger.warn(`[Health] Gagal menutup socket lama business ${businessId}: ${err}`);
        }
        this.connect(businessId).catch(err =>
          logger.error(`[Health] Gagal menyambungkan ulang business ${businessId}: ${err}`),
        );
      }
    }, HEALTH_CHECK_INTERVAL_MS);
    logger.info(`Pemantau kesehatan socket WA aktif (tiap ${HEALTH_CHECK_INTERVAL_MS / 1000} detik)`);
  }

  stopHealthCheck(): void {
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
  }

  getSessionDir(businessId: string): string {
    const dir = path.resolve(env.WA_SESSIONS_DIR, businessId);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    return dir;
  }

  async connect(businessId: string, waitForQR: boolean = false): Promise<string | void> {
    // Satu proses connect per business pada satu waktu — lihat catatan di field
    // `connecting` soal socket ganda yang saling menendang.
    if (this.connecting.has(businessId)) {
      logger.warn(`Permintaan connect untuk business ${businessId} diabaikan: masih ada proses connect berjalan`);
      return;
    }
    this.connecting.add(businessId);
    try {
      return await this.doConnect(businessId, waitForQR);
    } finally {
      this.connecting.delete(businessId);
    }
  }

  /**
   * Berapa lama socket baru diberi waktu menyelesaikan jabat tangan sebelum
   * dianggap gagal. Selama tenggang ini `ws.isOpen` boleh saja masih `false`.
   */
  private static readonly HANDSHAKE_GRACE_MS = 20_000;

  /** Socket ini hidup, atau setidaknya masih pantas ditunggu? */
  private masihHidup(inst: BaileysInstance): boolean {
    if (inst.sock.ws?.isOpen) return true;
    return Date.now() - inst.createdAt < BaileysManager.HANDSHAKE_GRACE_MS;
  }

  private async doConnect(businessId: string, waitForQR: boolean = false): Promise<string | void> {
    const existing = this.instances.get(businessId);
    if (existing) {
      // ── Sudah ada socket yang hidup: JANGAN buat lagi ─────────────────────
      // Dulu syaratnya `sock.user?.id` — properti yang hanya terisi kalau
      // pairing sudah selesai. Socket yang sedang jabat tangan belum punya itu,
      // jadi ia dianggap tidak ada lalu socket kedua dibuat. WhatsApp menutup
      // salah satunya dengan conflict 440, dan siklusnya berulang.
      //
      // Yang benar ditanyakan: apakah socket-nya HIDUP (atau masih pantas
      // ditunggu), bukan apakah pairing-nya sudah selesai.
      if (this.masihHidup(existing)) {
        if (waitForQR) {
          const cred = await prisma.waCredential.findFirst({ where: { businessId } });
          if (cred?.qrCode) return cred.qrCode;
          // Socket hidup tapi belum ada QR: kemungkinan besar sesi lama masih
          // sah dan WhatsApp tidak akan menerbitkan QR sama sekali.
          if (existing.sock.user?.id) return '';
        } else {
          logger.info(`Permintaan connect business ${businessId} dilewati: socket yang ada masih hidup`);
          return;
        }
      }
      // Socket memang sudah mati/kedaluwarsa — bersihkan lalu bangun yang baru.
      await this.disconnect(businessId);
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
    const credsPath = path.join(sessionDir, 'creds.json');

    // ── Disk adalah sumber kebenaran; DB hanya cadangan untuk cold start ──────
    // Sebelumnya creds.json SELALU ditimpa dari salinan database setiap connect.
    // Itu berbahaya: yang tersimpan di DB HANYA creds.json, sementara sesi
    // Baileys yang hidup terdiri dari ratusan file lain (pre-key, identity-key,
    // session, app-state-sync) yang cuma ada di disk. Menimpa creds.json dengan
    // salinan DB yang lebih tua sementara file kunci lain sudah lebih baru
    // membuat sesi jadi tidak konsisten. Sekarang DB hanya dipakai kalau disk
    // memang kosong — misal folder sesi terhapus atau pindah mesin.
    if (!fs.existsSync(credsPath) && cred.sessionData) {
      const sessionData = cred.sessionData as any;
      if (sessionData.creds) {
        fs.writeFileSync(credsPath, JSON.stringify(sessionData.creds, null, 2));
        logger.info(`Sesi WA dipulihkan dari database untuk business ${businessId} (disk kosong)`);
      }
    }

    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

    // Wajib sebelum membuka socket — lihat catatan 405 di atas.
    const waVersion = await resolveWaVersion();

    const sock = makeWASocket({
      auth: state,
      ...(waVersion ? { version: waVersion } : {}),
      syncFullHistory: false,
      emitOwnEvents: false,
      browser: ['SalesPintar', 'Chrome', '120.0'],
      logger: pino({ level: 'warn' }),
    });

    const instance: BaileysInstance = { sock, businessId, waCredentialId: cred.id, createdAt: Date.now() };
    this.instances.set(businessId, instance);

    // ── Penjaga terpenting di seluruh berkas ini ─────────────────────────────
    //
    // Setiap penangan kejadian di bawah terikat pada SATU socket, tapi `instances`
    // berkunci businessId — jadi socket baru MENIMPA entri socket lama. Ketika
    // socket lama akhirnya menutup (dan WhatsApp memang menutupnya dengan
    // conflict/replaced begitu socket baru masuk), penangannya masih hidup dan
    // ikut menjalankan `instances.delete(businessId)` — yang dihapusnya entri
    // milik socket BARU yang sedang sehat.
    //
    // Akibatnya terlihat di log 30 Juli 2026 sebagai urutan yang mustahil:
    //
    //     10:18:22 info : WhatsApp connected for business 777779f9...
    //     10:18:22 error: Failed to send message ... WhatsApp not connected
    //
    // Socket hidup, tapi hilang dari daftar — jadi `getStatus()` melaporkan
    // DISCONNECTED dan `sendMessage()` menolak, padahal sambungannya baik-baik
    // saja. Lebih jauh: karena daftarnya kosong, penjaga "sudah ada socket" di
    // `doConnect` tidak pernah menahan apa pun, sehingga setiap klik Reconnect
    // membuat socket baru, tiap socket baru menendang yang lama dengan
    // conflict 440, dan penangan yang lama menghapus yang baru — perang yang
    // memberi makan dirinya sendiri.
    //
    // Sejak sekarang tiap penangan wajib memastikan dirinya masih yang berlaku
    // sebelum menyentuh keadaan bersama.
    const masihBerlaku = () => this.instances.get(businessId) === instance;

    sock.ev.on('creds.update', async () => {
      // Socket basi menulis kredensial yang lebih tua ke atas yang lebih baru.
      // Diamkan; yang berlaku akan menyimpan versinya sendiri.
      if (!masihBerlaku()) return;
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
        if (!masihBerlaku()) {
          logger.warn(`Socket WA lama untuk business ${businessId} melapor 'open' padahal sudah digantikan — diabaikan`);
          return;
        }
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
        // Percobaan reconnect dianggap lunas begitu sambungan berhasil.
        // Tanpa ini counter-nya kumulatif seumur hidup proses: lima kali putus
        // sepanjang hari — walau tiap sambungan berikutnya sukses — membuat
        // kode berhenti mencoba SELAMANYA.
        this.reconnectCount.delete(businessId);
        instance.connectedAt = Date.now();

        // Kalau sesi lama masih sah, WhatsApp langsung membuka koneksi tanpa
        // pernah menerbitkan QR. Permintaan /wa/qr yang sedang menunggu harus
        // dibebaskan di sini — kalau tidak, ia menggantung sampai timeout 60
        // detik lalu melapor "QR timeout" padahal sambungannya justru berhasil.
        const pendingQr = this.qrResolvers.get(businessId);
        if (pendingQr) {
          pendingQr.resolve(''); // string kosong = tersambung, QR tidak diperlukan
          this.qrResolvers.delete(businessId);
        }

        logger.info(`WhatsApp connected for business ${businessId} [PID ${process.pid}]`);
      }

      if (connection === 'close') {
        const err = lastDisconnect?.error as Boom;
        const statusCode = err?.output?.statusCode;
        const reason = err?.message || 'unknown';
        // Umur sesi adalah petunjuk paling menentukan. Putus dalam hitungan detik
        // menunjuk ke penolakan dari sisi WhatsApp atau socket ganda; putus setelah
        // belasan menit lebih menunjuk ke jaringan atau laptop tidur.
        const uptimeText = instance.connectedAt
          ? `${Math.round((Date.now() - instance.connectedAt) / 1000)} detik`
          : 'belum pernah tersambung';
        logger.warn(
          `WhatsApp closed for business ${businessId}: ${reason} (statusCode: ${statusCode}) ` +
          `| umur sesi: ${uptimeText} | PID ${process.pid}`,
        );

        // Socket yang sudah digantikan menutup diri: itu WAJAR dan bukan urusan
        // siapa pun. Ia tidak boleh menghapus daftar, tidak boleh menyetel status
        // DISCONNECTED, dan sama sekali tidak boleh menjadwalkan sambung ulang —
        // sambungan yang sekarang berjalan justru punya socket lain yang sehat.
        if (!masihBerlaku()) {
          logger.info(
            `Penutupan di atas milik socket WA lama business ${businessId} yang sudah digantikan — diabaikan, sambungan yang berlaku tidak disentuh`,
          );
          return;
        }

        this.instances.delete(businessId);
        logger.info(`WhatsApp disconnected for business ${businessId}`);

        const entry = this.qrResolvers.get(businessId);
        if (entry) {
          entry.reject(new Error(`QR gagal: ${reason} (statusCode: ${statusCode})`));
          this.qrResolvers.delete(businessId);
        }

        // ── loggedOut (401): sesi dicabut dari sisi WhatsApp ────────────────
        // Perangkat sudah dilepas dari daftar Linked Device. Mencoba menyambung
        // ulang dengan kredensial yang sama percuma dan justru bisa memancing
        // pembatasan. Bersihkan sesinya supaya scan berikutnya mulai dari bersih.
        if (statusCode === DisconnectReason.loggedOut) {
          logger.warn(`WhatsApp logged out untuk business ${businessId} — sesi dibersihkan, perlu scan ulang`);
          await this.clearSession(businessId, cred.id);
          return;
        }

        await prisma.waCredential.update({
          where: { id: cred.id },
          data: { status: 'DISCONNECTED' },
        });

        // ── connectionReplaced (440): sesi diambil alih koneksi lain ───────
        // Bisa karena WhatsApp Web dibuka di tempat lain, atau karena ada DUA
        // socket dari aplikasi ini sendiri. Menyambung ulang di sini justru
        // memulai perang rebutan: dua socket saling menendang tanpa henti,
        // gejalanya "konek sebentar lalu putus" berulang-ulang. Berhenti dan
        // laporkan; biarkan manusia yang memutuskan.
        if (statusCode === DisconnectReason.connectionReplaced) {
          logger.warn(`Sesi WA business ${businessId} diambil alih koneksi lain — TIDAK menyambung ulang otomatis. Pastikan hanya satu proses backend yang jalan, lalu Reconnect manual.`);
          return;
        }

        // ── restartRequired (515): langkah normal, bukan kegagalan ─────────
        // WhatsApp SELALU mengirim ini tepat setelah pairing QR berhasil — dia
        // memang meminta klien menyambung ulang. Kalau diperlakukan seperti
        // kegagalan biasa, ia menghabiskan satu jatah percobaan dan menunggu
        // backoff 5 detik, padahal seharusnya langsung saja.
        if (statusCode === DisconnectReason.restartRequired) {
          logger.info(`WhatsApp minta restart untuk business ${businessId} — menyambung ulang segera`);
          setTimeout(() => {
            this.connect(businessId).catch(err =>
              logger.error(`Gagal menyambung ulang setelah restartRequired (${businessId}): ${err}`),
            );
          }, 1000);
          return;
        }

        const shouldReconnect =
          statusCode === DisconnectReason.connectionLost ||
          statusCode === DisconnectReason.connectionClosed ||
          statusCode === DisconnectReason.timedOut;

        if (shouldReconnect) {
          const attempts = this.reconnectCount.get(businessId) || 0;
          if (attempts < this.maxReconnects) {
            this.reconnectCount.set(businessId, attempts + 1);
            const delay = Math.min(5000 * Math.pow(2, attempts), 60000);
            logger.info(`Reconnecting WhatsApp for business ${businessId} (attempt ${attempts + 1}/${this.maxReconnects})...`);
            setTimeout(() => {
              this.connect(businessId).catch(err =>
                logger.error(`Gagal menyambung ulang business ${businessId}: ${err}`),
              );
            }, delay);
          } else {
            logger.warn(`Max reconnection attempts reached for business ${businessId}`);
            this.reconnectCount.delete(businessId);
          }
        }
      }
    });

    sock.ev.on('messages.upsert', async (msg) => {
      for (const message of msg.messages) {
        // ── Pesan keluar ────────────────────────────────────────────────────
        // Dulu semua `fromMe` dibuang di sini, dan itulah sebabnya bot tidak
        // pernah tahu kalau admin membalas dari HP — bot ikut menjawab dan
        // pelanggan menerima dua jawaban berbeda dari nomor yang sama.
        //
        // Sekarang dipilah: kiriman bot sendiri tetap diabaikan, kiriman
        // manusia diteruskan supaya bot bisa menepi.
        if (message.key.fromMe) {
          if (!this.outgoingHandler) continue;

          // HANYA pesan yang benar-benar baru. Saat menyambung ulang, Baileys
          // menyiram ulang riwayat lewat kejadian yang sama dengan type
          // 'append' — tanpa penjaga ini, setiap kali WhatsApp reconnect semua
          // balasan lama akan dikira "admin baru saja membalas dari HP" dan bot
          // menepi serentak di banyak percakapan sekaligus.
          if (msg.type !== 'notify') continue;

          // Lapis kedua, murah: abaikan apa pun yang lebih tua dari 5 menit.
          // `type` sudah menyaring sebagian besar, tapi stempel waktu tidak
          // bergantung pada perilaku pustaka yang bisa berubah antar versi.
          const ts = Number(message.messageTimestamp ?? 0) * 1000;
          if (ts > 0 && Date.now() - ts > 5 * 60 * 1000) continue;

          if (!resolveIncomingJid(message.key)) continue;
          const id = message.key.id ?? '';
          if (await wasSentByBot(businessId, id)) continue;
          try {
            await this.outgoingHandler(businessId, message);
          } catch (err) {
            // Auto-pause gagal tidak boleh menjatuhkan penerimaan pesan lain
            // dalam batch yang sama.
            logger.error(`Gagal memproses pesan keluar dari manusia: ${err}`);
          }
          continue;
        }
        // Saring sedini mungkin supaya status/channel/grup tidak pernah
        // menyentuh pipeline pesan sama sekali.
        if (!resolveIncomingJid(message.key)) continue;
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

  /**
   * Buang sesi WhatsApp sepenuhnya — file kunci di disk maupun salinan di DB.
   * Dipakai saat WhatsApp mencabut sesi (loggedOut): kredensialnya sudah tidak
   * ada artinya, dan menyisakannya hanya akan membuat percobaan berikutnya
   * memakai kunci mati.
   */
  private async clearSession(businessId: string, credentialId: string): Promise<void> {
    try {
      const dir = path.resolve(env.WA_SESSIONS_DIR, businessId);
      if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    } catch (err) {
      logger.error(`Gagal menghapus folder sesi WA ${businessId}: ${err}`);
    }

    this.reconnectCount.delete(businessId);

    try {
      await prisma.waCredential.update({
        where: { id: credentialId },
        // Prisma.DbNull, BUKAN undefined. Untuk kolom Json, `undefined` berarti
        // "jangan sentuh field ini" — jadi kredensial mati justru akan tetap
        // tersimpan dan dipakai lagi saat cold start berikutnya. `Prisma.DbNull`
        // yang benar-benar menulis NULL ke database.
        data: { status: 'DISCONNECTED', sessionData: Prisma.DbNull, qrCode: null, qrExpiresAt: null },
      });
    } catch (err) {
      logger.error(`Gagal membersihkan kredensial WA ${businessId}: ${err}`);
    }
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

    // ── Wajib memeriksa DUA hal, bukan salah satunya ──────────────────────────
    // Versi lama hanya mengecek `sock.user?.id`. Masalahnya, properti itu diisi
    // SEKALI saat pairing berhasil dan tidak pernah dihapus lagi — ia menempel di
    // objek socket selamanya. Jadi selama instance masih ada di Map, status
    // dilaporkan CONNECTED walaupun WebSocket-nya sudah lama mati. Ini yang
    // membuat dashboard menampilkan hijau padahal pesan tidak bisa dikirim, dan
    // membuat pengecekan isConnected() di broadcast serta pengiriman pesan CS
    // lolos padahal seharusnya menolak.
    //
    // Komentar lama di sini berbunyi "readyState hanya menandakan koneksi
    // internet, kita harus cek autentikasi" — benar, tapi jawabannya bukan
    // membuang pengecekan socket, melainkan memeriksa keduanya: socket harus
    // HIDUP dan user harus SUDAH terotentikasi.
    if (!instance.sock.ws?.isOpen) return 'DISCONNECTED';
    if (instance.sock.user?.id) return 'CONNECTED';
    return 'PENDING';
  }

  async sendMessage(businessId: string, jid: string, content: AnyMessageContent): Promise<any> {
    const instance = this.instances.get(businessId);
    if (!instance) throw new Error(`WhatsApp not connected for business ${businessId}`);
    // Socket bisa saja mati tanpa event close sempat terpicu (laptop tidur,
    // ganti jaringan). Menolak di sini lebih baik daripada menggantung lama
    // lalu gagal diam-diam.
    if (!instance.sock.ws?.isOpen) {
      throw new Error(`WhatsApp socket tidak aktif untuk business ${businessId}`);
    }
    const sent = await instance.sock.sendMessage(jid, content);

    // Catat id-nya supaya echo `fromMe` yang sebentar lagi datang dari WhatsApp
    // tidak salah dikira ketikan manusia — kalau salah, bot menidurkan dirinya
    // sendiri sesudah balasan pertama.
    const sentId = sent?.key?.id;
    if (sentId) await rememberBotSentMessage(businessId, sentId);

    return sent;
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

  /**
   * Unduh media (gambar/video/dokumen) dari satu pesan WhatsApp jadi Buffer.
   *
   * Media WhatsApp TERENKRIPSI dan tidak punya URL publik: `mediaUrl` di dalam
   * pesan tidak bisa diberikan ke pihak lain, harus diunduh lalu didekripsi
   * dengan kunci di pesan itu. Itulah sebabnya jalur gambar mengirim base64 ke
   * model, bukan URL — bukan pilihan, memang tidak ada URL yang bisa dikirim.
   *
   * `reuploadRequest` diisi `sock.updateMediaMessage`: kalau media sudah
   * kedaluwarsa di server WhatsApp, Baileys meminta pengirim mengunggah ulang.
   * Tanpa itu, foto yang agak lama gagal diunduh tanpa alasan yang jelas.
   *
   * Mengembalikan `null` kalau socket tidak ada atau unduhan gagal — pemanggil
   * yang memutuskan apa artinya. Sengaja tidak melempar: gagal membaca satu foto
   * tidak boleh menjatuhkan penanganan pesan.
   */
  async downloadMedia(
    businessId: string,
    msg: proto.IWebMessageInfo,
  ): Promise<{ buffer: Buffer; mimetype: string } | null> {
    const inst = this.instances.get(businessId);
    if (!inst) {
      logger.warn(`[WA] Unduh media gagal: tidak ada socket untuk business ${businessId}`);
      return null;
    }

    const content = extractMessageContent(msg.message);
    const media =
      content?.imageMessage ??
      content?.videoMessage ??
      content?.documentMessage ??
      content?.stickerMessage;
    if (!media) return null;

    try {
      const buffer = await downloadMediaMessage(
        msg as Parameters<typeof downloadMediaMessage>[0],
        'buffer',
        {},
        {
          // Logger Baileys, bukan Winston — bentuk antarmukanya berbeda.
          logger: pino({ level: 'silent' }),
          reuploadRequest: inst.sock.updateMediaMessage,
        },
      );
      return { buffer, mimetype: media.mimetype ?? 'application/octet-stream' };
    } catch (err) {
      logger.warn(`[WA] Gagal mengunduh media dari ${msg.key?.remoteJid}: ${err}`);
      return null;
    }
  }

  async disconnectAll(): Promise<void> {
    for (const [businessId] of this.instances) {
      await this.disconnect(businessId);
    }
  }

  /**
   * Pulihkan sesi WhatsApp saat backend menyala.
   *
   * ── Kenapa syaratnya BUKAN status di database ─────────────────────────────
   * Versi sebelumnya hanya memulihkan kredensial yang statusnya `CONNECTED`.
   * Itu menjebak diri sendiri, karena saat backend dimatikan ia menjalankan
   * `disconnectAll()` yang menyetel status jadi `DISCONNECTED`. Jadi urutannya:
   *
   *     backend mati  → status jadi DISCONNECTED
   *     backend nyala → mencari yang CONNECTED → tidak ada
   *                   → socket tidak pernah dibangun lagi
   *
   * Hasilnya WhatsApp mati setiap kali backend restart — dan di masa
   * pengembangan `tsx watch` me-restart tiap kali satu berkas berubah. Yang
   * ditunggu manusia adalah "kok tidak nyambung sendiri", padahal
   * kredensialnya sehat dan perangkatnya masih terdaftar di HP.
   *
   * Sejak Fase 13 DISK adalah sumber kebenaran, dan status di database cuma
   * cerminan. Jadi yang ditanyakan sekarang: apakah `creds.json` ada di disk.
   * Status `BANNED` tetap dihormati, dan begitu juga bisnis yang dimatikan.
   */
  async connectAllActive(): Promise<void> {
    const creds = await prisma.waCredential.findMany({
      where: { status: { not: 'BANNED' }, business: { isActive: true } },
      include: { business: true },
    });

    for (const cred of creds) {
      const credsPath = path.join(this.getSessionDir(cred.businessId), 'creds.json');
      if (!fs.existsSync(credsPath)) {
        // Belum pernah scan, atau sesinya sudah dibersihkan. Menyambung di sini
        // hanya akan menerbitkan QR yang tidak ada yang melihat.
        logger.info(`Sesi WA business ${cred.businessId} dilewati saat bootstrap: creds.json belum ada (perlu scan QR)`);
        continue;
      }
      try {
        logger.info(`Memulihkan sesi WA business ${cred.businessId} dari disk...`);
        await this.connect(cred.businessId);
      } catch (err) {
        logger.error(`Failed to reconnect business ${cred.businessId}: ${err}`);
      }
    }
  }
}

export const baileysManager = new BaileysManager();
