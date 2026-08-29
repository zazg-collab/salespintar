import http from 'http';
import app from './app';
import { env } from './config/env';
import { prisma } from './config/prisma';
import { redisCache, redisBull, waitForRedisReady } from './config/redis';
import { setupWorkers, closeQueues } from './queues';
import { setupWebSocket } from './websocket/handler';
import { baileysManager } from './services/baileys.service';
import { handleIncomingMessage, handleAdminTakeover} from './services/message.service';
import { obsidianWatcher } from './services/obsidian-watcher.service';
import { logger } from './utils/logger';
import { isTelegramEnabled } from './services/telegram.service';
import { isMengantarEnabled } from './services/mengantar.service';
import { humanLearningManager } from './services/human-learning.service';
import { validateLlmConfig, bersihkanLlmCallLama } from './services/llm';

async function bootstrap() {
  // PID dicetak sengaja: kalau angka ini BERUBAH, artinya proses mati dan
  // dijalankan ulang (crash atau tsx watch), bukan WhatsApp yang memutus koneksi.
  // Tanpa penanda ini, kedua kejadian terlihat sama persis di log.
  logger.info(`Starting SalesPintar API server... [PID ${process.pid}]`);

  try {
    await prisma.$connect();
    logger.info('Database connected');
  } catch (err) {
    logger.error('Failed to connect to database', err);
    process.exit(1);
  }

  try {
    // Tunggu socket siap DULU — lihat catatan balapan di config/redis.ts.
    // Tanpa ini, ping bisa gagal hanya karena Redis telat beberapa milidetik,
    // dan bootstrap membunuh proses yang sebenarnya sehat.
    await waitForRedisReady(redisCache, 'cache');
    await waitForRedisReady(redisBull, 'bull');
    await redisCache.ping();
    await redisBull.ping();
    logger.info('Redis connected');
  } catch (err) {
    logger.error('Failed to connect to Redis', err);
    process.exit(1);
  }

  await setupWorkers();

  // Mulai Obsidian CS Brain watcher
  await obsidianWatcher.start();

  // ── Bereskan sesi penambangan yang nyangkut ──────────────────────────────
  // Kalau server mati di tengah penambangan, baris sesinya tertinggal berstatus
  // "berjalan" selamanya: spanduk progres menempel di layar, angkanya tidak
  // pernah bertambah, dan tidak ada yang akan menyelesaikannya. Di sini sesi
  // yang di database masih berjalan dicocokkan dengan antrean sungguhan —
  // yang tidak punya satu pun job tersisa berarti pekerjaannya memang sudah
  // lenyap, dan ditutup dengan sisa filenya dihitung gagal.
  //
  // Dijalankan SESUDAH setupWorkers() supaya antreannya sudah tersambung ke
  // Redis; membacanya lebih awal akan mengembalikan daftar kosong dan
  // menutup paksa sesi yang sebenarnya sehat.
  try {
    const { listUnfinishedSessionIds, closeOutSession } = await import('./services/question-miner.repo');
    const { countLiveJobsBySession } = await import('./queues/question-mining.queue');
    const unfinished = await listUnfinishedSessionIds();
    if (unfinished.length > 0) {
      const alive = await countLiveJobsBySession();
      for (const s of unfinished) {
        if (alive.has(s.id)) continue;
        await closeOutSession(s.id);
        logger.warn(`[QuestionMiner] Sesi "${s.label}" nyangkut tanpa job tersisa — ditutup paksa`);
      }
    }
  } catch (err) {
    // Pembersihan gagal tidak boleh menghalangi server menyala.
    logger.warn(`[QuestionMiner] Pembersihan sesi nyangkut dilewati: ${err}`);
  }

  // Dinyatakan terang-terangan saat menyala, supaya "notifikasi tidak masuk"
  // bisa langsung dipersempit: masalah setelan, atau masalah deteksi.
  if (isMengantarEnabled()) {
    logger.info('[Mengantar] Cek ongkir AKTIF');
  } else {
    logger.info('[Mengantar] Cek ongkir tidak aktif — MENGANTAR_API_KEY belum diisi (bot tetap jalan, cuma tidak menyebut angka ongkir)');
  }

  if (isTelegramEnabled()) {
    logger.info('[Telegram] Pemberitahuan admin AKTIF');
  } else {
    logger.warn('[Telegram] Pemberitahuan admin TIDAK aktif — TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID belum diisi di .env');
  }

  baileysManager.setMessageHandler(handleIncomingMessage);
  // Auto-pause: kalau admin membalas langsung dari HP atau WhatsApp Web, bot
  // menepi untuk nomor itu supaya tidak berebut menjawab.
  baileysManager.setOutgoingHandler(handleAdminTakeover);

  // ── Pulihkan sesi WhatsApp setelah restart ────────────────────────────────
  // Sebelumnya bootstrap hanya menurunkan semua status CONNECTED jadi
  // DISCONNECTED lalu berhenti di situ. `connectAllActive()` yang seharusnya
  // menyambung ulang justru mencari `status: 'CONNECTED'` — status yang baru
  // saja dihapus baris di bawah — dan lagipula tidak pernah dipanggil dari mana
  // pun. Akibatnya SETIAP restart membuat sesi WhatsApp jadi yatim: file
  // kuncinya utuh di disk, tapi tidak ada yang membangunkannya. Di production
  // itu berarti satu kali deploy = bot berhenti menerima pesan sampai ada orang
  // yang scan QR ulang.
  //
  const httpServer = http.createServer(app);
  setupWebSocket(httpServer);

  // ══════════════════════════════════════════════════════════════════════════
  // PORT DIKUASAI DULU, BARU MENYENTUH WHATSAPP — JANGAN DIBALIK LAGI
  //
  // Sebelumnya urutannya terbalik: reset status di DB dan penyambungan WhatsApp
  // dijalankan di baris 54-77, sedangkan `listen()` baru di baris 83. Kelihatan
  // sepele, tapi akibatnya berat.
  //
  // Port adalah SATU-SATUNYA penjaga yang mencegah dua backend jalan bersamaan.
  // Dengan urutan lama, proses kedua yang tidak sengaja dijalankan akan:
  //   1. Menimpa status semua kredensial jadi DISCONNECTED di database —
  //      merusak catatan milik proses pertama yang sedang sehat.
  //   2. Menyambung ke WhatsApp dengan folder sesi YANG SAMA, sehingga
  //      WhatsApp menendang proses pertama lewat connectionReplaced.
  //   3. BARU kemudian gagal mengikat port 3000 (EADDRINUSE) dan mati.
  //
  // Hasil akhirnya: proses kedua mati, tapi proses pertama sudah terlanjur
  // ditendang dari WhatsApp. Tidak ada yang tersambung, dashboard merah, dan
  // dari luar terlihat seperti "WhatsApp konek lalu putus sendiri dalam
  // hitungan detik". Setiap `npm run dev` di tab kedua, setiap percobaan start
  // yang gagal, mencuri sesi WhatsApp lebih dulu sebelum mati.
  //
  // Dengan port diikat lebih dulu, proses kedua mati SEBELUM sempat menyentuh
  // WhatsApp maupun database. Proses pertama tidak terganggu sama sekali.
  // ══════════════════════════════════════════════════════════════════════════
  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        logger.error(
          `Port ${env.PORT} sudah dipakai proses lain. Backend ini berhenti TANPA menyentuh ` +
          `sesi WhatsApp. Cek dengan: lsof -ti:${env.PORT}`,
        );
      }
      reject(err);
    });
    // Alamat DISEBUT eksplisit — lihat catatan `SERVER_BIND_HOST` di env.ts.
    // Tanpa argumen ini Node mengikat seluruh antarmuka, dan di produksi itu
    // berarti port 3000 terbuka ke internet dengan CSF sebagai satu-satunya
    // penahan.
    httpServer.listen(env.PORT, env.SERVER_BIND_HOST, () => {
      logger.info(`Server running on ${env.SERVER_BIND_HOST}:${env.PORT} (${env.NODE_ENV}) [PID ${process.pid}]`);
      logger.info(`API prefix: ${env.API_PREFIX}`);
      logger.info(`CORS origin: ${env.CORS_ORIGIN}`);
      resolve();
    });
  });

  // ── Mulai dari sini, proses ini dipastikan satu-satunya pemegang port ──────
  // Daftar sesi dicatat DULU sebelum statusnya direset, karena `connectAllActive()`
  // bawaan memfilter `status: 'CONNECTED'` — status yang justru dihapus oleh
  // reset di bawah — dan lagipula tidak pernah dipanggil dari mana pun. Tanpa
  // pencatatan ini, setiap restart membuat sesi WhatsApp jadi yatim: file
  // kuncinya utuh di disk, tapi tidak ada yang membangunkannya.
  const previouslyConnected = await prisma.waCredential.findMany({
    where: { status: 'CONNECTED', business: { isActive: true } },
    select: { businessId: true },
  });

  await prisma.waCredential.updateMany({
    where: { status: 'CONNECTED' },
    data: { status: 'DISCONNECTED' },
  });
  logger.info('Reset stale WA connections');

  // Pemantau kesehatan socket: mendeteksi koneksi WA yang mati diam-diam
  // (laptop tidur, ganti jaringan) yang tidak memicu event close.
  baileysManager.startHealthCheck();

  if (previouslyConnected.length > 0) {
    logger.info(`Memulihkan ${previouslyConnected.length} sesi WhatsApp yang tersambung sebelum restart...`);
    // Sengaja tidak di-await: penyambungan WhatsApp bisa makan waktu puluhan
    // detik, dan tidak perlu menahan proses bootstrap.
    for (const c of previouslyConnected) {
      baileysManager.connect(c.businessId).catch(err =>
        logger.warn(`Gagal memulihkan sesi WA untuk business ${c.businessId}: ${err}`),
      );
    }
  }

  // ── Peta model per pekerjaan ──────────────────────────────────────────────
  // Dicetak SEKALI di sini, dan sengaja sebelum apa pun mulai melayani.
  // Dua alasannya: salah tulis nama provider harus meledak saat menyala, bukan
  // pada pesan pelanggan pertama; dan baris log ini menjawab "model apa yang
  // SEBENARNYA jalan" — pertanyaan yang terdengar sepele sampai ternyata ada dua
  // berkas `.env` di repo ini dan cuma `backend/.env` yang dimuat.
  validateLlmConfig();

  // Buang catatan pemakaian yang sudah lewat masa simpan (~9 baris per giliran
  // pelanggan, jadi tanpa ini tabelnya tumbuh tanpa henti).
  bersihkanLlmCallLama().catch(err =>
    logger.warn(`Pembersihan llm_calls dilewati: ${err}`),
  );

  // Pulihkan sesi Human Learning (CS shadow) yang aktif sebelum restart.
  // Fire-and-forget — kegagalan tidak boleh menghentikan proses utama.
  humanLearningManager.restoreActiveSessions().catch(err =>
    logger.warn(`Gagal memulihkan sesi Human Learning: ${err}`),
  );
  humanLearningManager.startHealthCheck();

  // Langkah D Fase 26 (Temuan R2): sebelumnya `closeQueues()` DIIMPOR tapi TIDAK PERNAH dipanggil
  // -- shutdown() langsung redisBull.disconnect() tanpa memberi kesempatan 5 Worker/Queue BullMQ
  // menutup diri dgn baik (lepas lock job aktif, drain koneksi duplikat Worker). Kalau SIGTERM
  // terjadi persis saat worker (mis. shadow-mining, concurrency 1) di tengah 1 job LLM, job itu
  // terpotong paksa -- bukan kehilangan data permanen (job tetap di Redis, pulih via stalled-job
  // recovery bawaan BullMQ di boot berikutnya), tapi pemrosesan tertunda & panggilan LLM yg sudah
  // separuh jalan terbuang percuma. Fix: `shutdown` jadi async, panggil `closeQueues()` dgn
  // timeout 5 detik (bounded -- tidak menggantung selamanya kalau ada queue yg macet menutup diri).
  const shutdown = async (signal: string) => {
    logger.info(`Received ${signal}, shutting down...`);
    try { httpServer.close(); } catch {}
    try { obsidianWatcher.stop(); } catch {}
    try { baileysManager.stopHealthCheck(); } catch {}
    try { baileysManager.disconnectAll(); } catch {}
    try { humanLearningManager.stopHealthCheck(); } catch {}
    try {
      await Promise.race([
        closeQueues(),
        new Promise((resolve) => setTimeout(resolve, 5000)),
      ]);
    } catch (err) {
      logger.warn(`Gagal menutup BullMQ queues dengan baik: ${err}`);
    }
    try { await prisma.$disconnect(); } catch {}
    try { redisCache.disconnect(); } catch {}
    try { redisBull.disconnect(); } catch {}
    process.exit(0);
  };

  process.on('SIGTERM', () => { shutdown('SIGTERM').catch(() => process.exit(1)); });
  process.on('SIGINT', () => { shutdown('SIGINT').catch(() => process.exit(1)); });
  process.on('SIGHUP', () => { shutdown('SIGHUP').catch(() => process.exit(1)); });

  process.on('unhandledRejection', (err: Error) => {
    logger.error('Unhandled rejection', { error: err.message, stack: err.stack });
  });

  process.on('uncaughtException', (err: Error) => {
    // ── Kenapa ada jeda sebelum exit ──────────────────────────────────────────
    // `process.exit()` menghentikan proses SEKETIKA, tanpa menunggu buffer
    // tulisan dikosongkan. Kalau transport log sedang menulis secara asinkron,
    // pesan error terakhir — justru yang paling dibutuhkan — bisa hilang
    // sebelum sempat sampai ke layar. Akibatnya proses mati tanpa jejak dan
    // gejalanya terlihat seperti "WhatsApp putus sendiri", padahal backend-nya
    // yang jatuh. Jeda 100 ms sudah cukup untuk memastikan log tertulis.
    logger.error(`💥 UNCAUGHT EXCEPTION — proses akan berhenti [PID ${process.pid}]`, {
      error: err.message,
      stack: err.stack,
    });
    console.error('💥 UNCAUGHT EXCEPTION:', err);
    setTimeout(() => process.exit(1), 100);
  });

  process.on('exit', (code) => {
    // Baris terakhir yang selalu tercetak, apa pun penyebabnya. Kalau baris ini
    // muncul tepat sebelum WhatsApp "putus", berarti penyebabnya proses mati —
    // bukan koneksi WhatsApp.
    console.error(`⏹  Proses backend berhenti [PID ${process.pid}] dengan kode ${code}`);
  });
}

bootstrap().catch((err) => {
  logger.error('Failed to bootstrap server', err);
  process.exit(1);
});
