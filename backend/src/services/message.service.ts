import { proto, extractMessageContent } from '@whiskeysockets/baileys';
import { prisma } from '../config/prisma';
import { debounceQueue } from '../queues/debounce.queue';
import { logger } from '../utils/logger';
import { isDailyCapReached, incrementTodayAiCount } from './rate-limit.service';
import { notifyHotLead, notifyHandover } from './telegram.service';
import { env } from '../config/env';
import { baileysManager } from './baileys.service';
import { getIO } from '../websocket/handler';
import { DEBOUNCE_MS, DEBOUNCE_MAX_CHUNKS, pushDebounceChunk, resetConsecutive } from './state.service';
import { resolveIncomingJid } from '../utils/wa-jid';
import {
  periksaMedia, bacaGambar, gabungTeksDenganBacaan,
  bolehKirimAjakanKetik, AJAKAN_KETIK,
} from './wa-vision.service';

// ──────────────────────────────────────────────────────────────────────────────
// FITUR OPERASIONAL — Fase 5
// ──────────────────────────────────────────────────────────────────────────────

// ── 1. Anti-Spam Debounce ─────────────────────────────────────────────────────
// Kumpulkan pesan beruntun dalam 4 detik → gabung jadi 1 sebelum ke AI.
//
// Fix audit A5: buffer-nya tidak lagi Map in-memory + setTimeout. Chunk disimpan
// di Redis dan flush-nya dijadwalkan lewat BullMQ delayed job, jadi aman untuk
// multi-instance dan tidak bocor memori. Batas 10 chunk (fix B7) sekarang
// ditegakkan secara atomik di dalam script Lua di state.service.ts.
// Lihat: state.service.ts, queues/debounce.queue.ts, queues/debounce.worker.ts

// ── 2. Menu Hardcoded Bypass AI ───────────────────────────────────────────────
// Angka 1/2/3 → balasan statis instan, 0 token Groq
// Konfigurasi bisa diambil dari business.settings, ini default fallback
const DEFAULT_MENU: Record<string, string> = {
  '1': '📦 *Cara Order:*\n1. Pilih produk\n2. Chat kami dengan format: PESAN [Nama Produk] [Jumlah]\n3. Kami konfirmasi & kirim invoice\n4. Transfer sesuai invoice\n5. Barang dikirim! 🚀',
  '2': '💳 *Cara Pembayaran:*\nKami menerima:\n• Transfer Bank (BCA/Mandiri/BRI)\n• QRIS (semua e-wallet)\n• COD area tertentu\n\nSetelah transfer, kirim bukti ke chat ini ya Kak 😊',
  '3': '📞 *Jam Operasional:*\nSenin-Sabtu, 08.00-17.00 WIB\nDi luar jam itu pesan tetap masuk kok Kak, nanti dibalas begitu kami mulai 😊',
};

// Catatan: opsi "ketik 0 untuk bicara dengan CS manusia" SENGAJA DIHAPUS
// (keputusan Angga, 2026-07-29). Alasannya pengalaman pelanggan: menu angka
// untuk "minta manusia" membongkar bahwa lawan bicaranya mesin. Pengalihan ke
// CS kini terjadi DIAM-DIAM — dipicu Supervisor saat balasan berisiko, atau
// diambil CS sendiri dari dashboard — tanpa pelanggan pernah tahu ada
// pergantian. Konsekuensinya: pelanggan tidak lagi punya cara eksplisit
// memanggil manusia, jadi dashboard WAJIB dipantau.

// ── 3. Hot Lead Detection ─────────────────────────────────────────────────────
// Deteksi sinyal beli → notif rahasia ke Admin via WebSocket
// ──────────────────────────────────────────────────────────────────────────────
// Deteksi calon pembeli
//
// Versi pertama cuma punya kata "transfer" utuh dan mencocokkannya sebagai
// potongan teks. Akibatnya "mau trf skrg" — cara paling lazim orang Indonesia
// menyatakan niat bayar — TIDAK terdeteksi sama sekali. Pemberitahuan paling
// berharga di seluruh sistem ini diam justru saat pelanggan paling siap closing.
//
// Sekarang dipisah dua, dan pemisahannya penting:
//
//   FRASA  → dicocokkan sebagai potongan teks biasa. Aman karena panjang.
//   KATA   → WAJIB dicocokkan sebagai kata utuh.
//
// Kenapa kata pendek tidak boleh dicocokkan sebagai potongan: `includes('tf')`
// akan menyala untuk "outfit" dan "netflix"; `includes('rek')` menyala untuk
// "direktori". Pemberitahuan palsu lebih berbahaya daripada kelihatannya —
// begitu Angga belajar mengabaikan notifikasinya, yang sungguhan ikut terabaikan.
// ──────────────────────────────────────────────────────────────────────────────

const HOT_LEAD_PHRASES = [
  'mau beli', 'mau pesan', 'mau order', 'mau bayar', 'mau ambil',
  'bisa transfer', 'cara beli', 'cara order', 'cara pesan', 'cara bayar',
  'harga berapa', 'berapa harga', 'ada stok', 'ready ga', 'ready gak', 'ready kak',
  'saya beli', 'saya order', 'saya ambil', 'jadi beli', 'jadi ambil',
  'transfer ke mana', 'transfer kemana', 'kirim ke mana', 'kirim kemana',
  'no rek', 'nomor rekening', 'minta rekening', 'rekening mana',
  'pesan sekarang', 'order sekarang', 'beli sekarang',
];

const HOT_LEAD_WORDS = [
  // Singkatan bayar yang paling sering dipakai — inilah yang dulu terlewat.
  'tf', 'trf', 'transfer', 'tranfer', 'trnsfer', 'tranfser',
  'rekening', 'rek', 'norek', 'cod', 'dp', 'checkout',
  'bungkus', 'gaskeun', 'minat', 'tertarik', 'deal', 'sepakat',
];

/** Kata utuh: harus diapit awal/akhir teks atau karakter non-alfanumerik. */
const HOT_LEAD_WORD_RE = new RegExp(
  `(?:^|[^a-z0-9])(?:${HOT_LEAD_WORDS.join('|')})(?:[^a-z0-9]|$)`,
  'i',
);

export function detectHotLead(text: string): boolean {
  const lower = text.toLowerCase();
  return HOT_LEAD_PHRASES.some(kw => lower.includes(kw)) || HOT_LEAD_WORD_RE.test(lower);
}

// ── 4. Rate Limiting per Lead ─────────────────────────────────────────────────
// Kuota balasan AI per pelanggan per hari. Logika tanggalnya ada di
// rate-limit.service.ts; komentar lama di sini ("direset setiap hari via cron,
// belum ada") sudah tidak berlaku — resetnya sekarang terjadi sendiri karena
// hitungan dari hari kemarin dianggap nol tanpa perlu ada yang menjalankannya.

// ── Helper: respond dengan pesan hardcoded ────────────────────────────────────
async function sendHardcodedReply(
  businessId: string,
  conversationId: string,
  leadId: string,
  waJid: string,
  replyText: string,
): Promise<void> {
  await prisma.message.create({
    data: {
      businessId,
      conversationId,
      leadId, // Fix C5: denormalisasi — query konteks AI tak perlu JOIN ke conversations
      message: replyText,
      messageType: 'text',
      fromRole: 'AI',
      aiModel: 'hardcoded',
    },
  });

  // Kirim via Baileys langsung (bypass queue untuk kecepatan)
  try {
    await baileysManager.sendMessage(businessId, waJid, { text: replyText });
  } catch (err) {
    logger.warn(`[Hardcoded] Failed to send WA message: ${err}`);
  }

  const io = getIO();
  if (io) {
    io.to(`business:${businessId}`).emit('chat:new', {
      conversationId,
      message: { fromRole: 'AI', message: replyText, createdAt: new Date() },
    });
  }
}

// ── Helper: enqueue AI reply (Mode Pasif: Learning & Mining Only) ────────────
export async function enqueueAiReply(
  _businessId: string,
  _conversationId: string,
  _leadId: string,
  _messageText: string,
  _leadName: string | null,
  _waJid: string,
): Promise<void> {
  // SalesPintar beroperasi dalam mode Pasif (Knowledge & Human Learning Engine).
  // Balasan otomatis ke customer ditangani oleh Sentinel (Hermes).
  logger.debug('[MessageService] Mode pasif: auto-reply dilewati');
}

// ──────────────────────────────────────────────────────────────────────────────
// MAIN HANDLER — handleIncomingMessage
// Pipeline: filter → debounce → hardcoded menu check → hot lead → AI queue
// ──────────────────────────────────────────────────────────────────────────────
export async function handleIncomingMessage(businessId: string, msg: proto.IWebMessageInfo) {
  try {
    const key = msg.key;

    // ── Filter 1: hanya chat pribadi ──────────────────────────────────────────
    // Dulu di sini cuma ada `endsWith('@g.us')` — daftar-larangan berisi satu
    // entri, sehingga status@broadcast, channel, dan LID semuanya lolos jadi
    // "pelanggan". Lihat catatan lengkapnya di utils/wa-jid.ts.
    const remoteJid = resolveIncomingJid(key as { remoteJid?: string | null; remoteJidAlt?: string | null });
    if (!remoteJid) {
      logger.debug(`[MessageSvc] Bukan chat pribadi (${key?.remoteJid}) — dilewati`);
      return;
    }

    // ── Filter 2: teks, caption, atau media ───────────────────────────────────
    //
    // ⚠️ Blok ini dulu berbunyi "Hanya pesan teks" dan diakhiri
    // `// Abaikan gambar, video, dokumen, stiker secara silent` + `return`.
    // Akibatnya pelanggan yang mengirim FOTO — bukti transfer, tangkapan layar
    // harga, foto produk yang dia mau — dijawab dengan KESUNYIAN TOTAL. Bahkan
    // CAPTION-nya tidak dibaca, padahal caption itu teks biasa yang sudah ada di
    // payload dan tidak butuh model apa pun.
    //
    // Diam lebih buruk daripada jawaban yang kurang tepat: pelanggan tidak tahu
    // pesannya sampai atau tidak, dan satu-satunya jejaknya `logger.debug` —
    // jadi Angga pun tidak bisa tahu itu pernah terjadi. Sejak Fase 65, tidak ada
    // lagi jalan keluar yang tanpa jawaban: kalau isinya tidak bisa dibaca,
    // pelanggan diberi ajakan mengetik (pesan tetap, bukan dari model).
    const content = extractMessageContent(msg.message);
    const teksLangsung = (
      content?.conversation ||
      content?.extendedTextMessage?.text ||
      ''
    ).trim();

    const media = periksaMedia(msg);

    // Urutan sengaja: caption dipakai sebagai teks pesan, dan pembacaan gambar
    // (yang berbayar) baru dijalankan NANTI — setelah diketahui percakapan ini
    // memang ditangani AI, bukan sedang dipegang CS manusia.
    let messageText = teksLangsung || media.caption;

    if (!messageText && !media.adaMedia) {
      // Bukan teks, bukan media — mis. reaksi, pembaruan pol, pesan sistem.
      logger.debug(`[MessageSvc] Pesan tanpa teks & tanpa media dari ${remoteJid} — dilewati`);
      return;
    }

    const waNumber = remoteJid.split('@')[0]!;
    const waId = remoteJid;

    // ── Upsert Lead ───────────────────────────────────────────────────────────
    let lead = await prisma.lead.findFirst({
      where: { businessId, waNumber },
      orderBy: { createdAt: 'desc' },
    });
    if (!lead) {
      lead = await prisma.lead.create({
        data: {
          businessId,
          name: msg.pushName || null,
          waNumber,
          waId,
          status: 'ACTIVE',
        },
      });
      logger.info(`[MessageSvc] New lead: ${waNumber} (business: ${businessId})`);

      // ── Fase 41 (2026-08-20) — tangkap ctwaClid PERMANEN ────────────────────
      // Upgrade dari blok diagnostik TEMPORER Fase 38 (dulu cuma logger.warn) jadi
      // penyimpanan permanen: kalau pesan pertama dari lead baru ini membawa
      // ctwaClid (Click ID iklan Click-to-WhatsApp) di contextInfo.externalAdReply,
      // simpan ke kolom Lead.ctwaClid -- dipakai Tahap 3 (capi.service.ts) utk
      // menentukan action_source ("business_messaging"+ctwa_clid vs "chat", lihat
      // §3 rencana-integrasi-meta-capi.md). Tidak mengubah `lead` yang sudah
      // dibuat di atas -- cuma tambahan UPDATE kolom kalau memang ada nilainya.
      // Tetap dibungkus try/catch sendiri, gagal baca contextInfo tidak boleh
      // menggagalkan proses pesan masuk (lihat ledger Fase 41 utk detail).
      try {
        const anyMsg: any = extractMessageContent(msg.message) || msg.message;
        let ctxInfo: any;
        if (anyMsg && typeof anyMsg === 'object') {
          for (const k of Object.keys(anyMsg)) {
            const v = anyMsg[k];
            if (v && typeof v === 'object' && v.contextInfo) {
              ctxInfo = v.contextInfo;
              break;
            }
          }
        }
        const ctwaClid: string | undefined = ctxInfo?.externalAdReply?.ctwaClid;
        if (ctwaClid) {
          await prisma.lead.update({
            where: { id: lead.id },
            data: { ctwaClid },
          });
          lead.ctwaClid = ctwaClid; // biar objek `lead` di memori konsisten dgn DB
          logger.info(
            `[MessageSvc] ctwaClid tersimpan utk lead baru ${waNumber} (biz ${businessId}): ` +
            `${ctwaClid.slice(0, 12)}... (lead dari iklan Click-to-WhatsApp)`,
          );
        }
      } catch (ctwaErr) {
        logger.warn(`[MessageSvc] Gagal baca/simpan ctwaClid: ${ctwaErr}`);
      }
    }

    // ── Upsert Conversation ───────────────────────────────────────────────────
    let conversation = await prisma.conversation.findFirst({
      where: { businessId, leadId: lead.id, status: { in: ['AI', 'HUMAN'] } },
    });
    if (!conversation) {
      conversation = await prisma.conversation.create({
        data: { businessId, leadId: lead.id, status: 'AI' },
      });
    }

    // ── Save pesan masuk ke DB ────────────────────────────────────────────────
    const savedMessage = await prisma.message.create({
      data: {
        businessId,
        conversationId: conversation.id,
        leadId: lead.id, // Fix C5: denormalisasi leadId
        // Placeholder kalau media datang tanpa caption, supaya baris pesannya tidak
        // kosong di dashboard. Diperbarui di bawah kalau gambarnya berhasil dibaca —
        // Angga harus bisa melihat APA yang dilihat bot saat mengaudit balasan.
        message: messageText || `[${media.jenis}]`,
        messageType: media.adaMedia ? media.jenis : 'text',
        fromRole: 'LEAD',
      },
    });

    await prisma.lead.update({
      where: { id: lead.id },
      data: { lastMessageAt: new Date(), totalMessages: { increment: 1 } },
    });

    // ── Pelanggan bersuara → penghitung "beruntun" direset ────────────────────
    // Arti "consecutive" yang benar adalah balasan AI yang menumpuk TANPA
    // pelanggan menyahut — pengaman kalau bot kesurupan bicara sendiri.
    // Sebelumnya penghitungnya menghitung SEMUA balasan AI dalam satu jam,
    // tak peduli pelanggan menjawab di antaranya. Akibatnya percakapan jualan
    // yang sehat — tanya harga, stok, ongkir, cara bayar — menabrak batas 3 di
    // pertanyaan keempat, lalu pelanggan itu dibisukan sampai satu jam ke depan.
    // Justru pelanggan paling serius yang paling cepat kena.
    await resetConsecutive(lead.id);

    // Emit chat baru ke dashboard
    const io = getIO();
    if (io) {
      io.to(`business:${businessId}`).emit('chat:new', {
        conversationId: conversation.id,
        message: { ...savedMessage, fromRole: 'LEAD' },
        lead: { id: lead.id, name: lead.name, waNumber: lead.waNumber },
      });
    }

    // ── Jika HUMAN mode: stop di sini, CS manusia yang balas ─────────────────
    // Pesannya SUDAH disimpan & dipancarkan di atas, jadi CS tetap melihat
    // fotonya. Yang dilewati cuma pembacaan model — tidak ada gunanya membayar
    // untuk membaca gambar yang akan dijawab manusia.
    if (conversation.status === 'HUMAN') return;

    // ── Media: baca gambarnya, atau ajak pelanggan mengetik ───────────────────
    if (media.adaMedia) {
      let bacaan = '';

      if (media.adaGambar) {
        const hasil = await bacaGambar(businessId, lead.id, msg, conversation.id);
        if (hasil.ok) {
          bacaan = hasil.bacaan;
          messageText = gabungTeksDenganBacaan(media.caption, bacaan);
          // Simpan APA YANG DILIHAT BOT ke baris pesannya. Tanpa ini, saat balasan
          // terasa aneh tidak ada cara tahu apakah salahnya di pembacaan gambar
          // atau di penyusunan jawaban — dua sebab yang butuh perbaikan berbeda.
          await prisma.message.update({
            where: { id: savedMessage.id },
            data: { message: `${media.caption || '[gambar]'}\n\n[dibaca AI] ${bacaan}` },
          }).catch((err) => logger.warn(`[MessageSvc] Gagal menyimpan bacaan gambar: ${err}`));
        } else {
          logger.info(`[MessageSvc] Gambar dari ${waNumber} tidak terbaca (${hasil.alasan})`);
        }
      }

      // Tidak ada teks, tidak ada caption, tidak ada bacaan → tanpa ajakan ini
      // pelanggan menerima KESUNYIAN, dan itu keadaan yang dibereskan Fase 65.
      // Pesannya TETAP (bukan dari model) supaya bunyinya tidak pernah berubah,
      // dan ber-jeda supaya lima stiker tidak dijawab lima kali.
      if (!messageText) {
        if (await bolehKirimAjakanKetik(lead.id)) {
          const ajakan = AJAKAN_KETIK[media.jenis] ?? AJAKAN_KETIK['image']!;
          await sendHardcodedReply(businessId, conversation.id, lead.id, waId, ajakan);
        } else {
          logger.debug(`[MessageSvc] Ajakan ketik untuk ${waNumber} masih dalam jeda — tidak dikirim`);
        }
        return;
      }
    }

    // ── Hardcoded Menu Check: "1"/"2"/"3" = balasan statis ───────────────────
    if (messageText in DEFAULT_MENU && DEFAULT_MENU[messageText]) {
      await sendHardcodedReply(
        businessId, conversation.id, lead.id, waId,
        DEFAULT_MENU[messageText],
      );
      return;
    }

    // ── Hot Lead Detection ────────────────────────────────────────────────────
    if (detectHotLead(messageText)) {
      logger.info(`[HotLead] 🔥 Lead ${lead.id} (${waNumber}) detected as HOT`);
      await prisma.lead.update({
        where: { id: lead.id },
        data: { score: { increment: 10 }, intent: 'BUYING' },
      });
      if (io) {
        io.to(`business:${businessId}`).emit('lead:hot', {
          leadId: lead.id,
          leadName: lead.name,
          waNumber,
          conversationId: conversation.id,
          trigger: messageText.slice(0, 80),
          timestamp: new Date().toISOString(),
        });
      }
      // Sinyal ini dulu cuma dipancarkan ke dashboard yang tidak ada
      // pendengarnya — fitur "tangkap ikan besar" menghasilkan pemberitahuan ke
      // ruang kosong. Sekarang sampai ke HP lewat Telegram.
      notifyHotLead({
        leadName: lead.name,
        waNumber,
        trigger: messageText.slice(0, 80),
      });
    }

    // ── Anti-Spam Debounce (4 detik) — Fix A5: Redis + BullMQ delayed job ─────
    // Tiap pesan menaikkan nomor generasi buffer dan menjadwalkan job flush
    // baru. Job generasi lama otomatis jadi basi dan no-op saat fired, jadi
    // efeknya sama seperti clearTimeout() versi lama — tapi tanpa state lokal.
    const pushed = await pushDebounceChunk(businessId, waNumber, messageText, {
      conversationId: conversation.id,
      leadId: lead.id,
      leadName: lead.name,
      waJid: waId,
    });

    if (!pushed) {
      // Redis bermasalah — jangan sampai pesan pelanggan hilang diam-diam.
      // Lewati debounce, langsung antre balasan untuk pesan ini saja.
      logger.warn(`[Debounce] Buffer Redis gagal untuk ${waNumber} — fallback enqueue langsung`);
      await enqueueAiReply(businessId, conversation.id, lead.id, messageText, lead.name, waId);
      return;
    }

    if (pushed.dropped) {
      logger.warn(`[Debounce] Lead ${waNumber} hit ${DEBOUNCE_MAX_CHUNKS}-chunk limit -- excess message dropped`);
    }

    // Sengaja TIDAK memakai jobId kustom. jobId deterministik seperti
    // `debounce-<business>-<wa>-<generasi>` terlihat rapi tapi berbahaya di sini:
    // nomor generasi kembali ke 1 setiap buffer selesai di-flush, sementara
    // BullMQ masih menyimpan job lama yang sudah completed (removeOnComplete:
    // 200). Menambahkan job dengan jobId yang sudah ada TIDAK menjadwalkan job
    // baru — ia mengembalikan job lama diam-diam, sehingga buffer tidak pernah
    // di-flush dan pesan pelanggan menggantung sampai TTL habis.
    // Pengaman terhadap flush ganda sudah dipegang oleh pengecekan generasi di
    // state.service.ts, jadi id otomatis dari BullMQ sudah cukup dan lebih aman.
    await debounceQueue.add(
      'flush',
      { businessId, waNumber, generation: pushed.generation },
      { delay: DEBOUNCE_MS },
    );
  } catch (error: any) {
    logger.error(`[MessageSvc] Error handling message: ${error.message}`, { stack: error.stack });
  }
}


// ──────────────────────────────────────────────────────────────────────────────
// AUTO-PAUSE — admin membalas langsung dari HP atau WhatsApp Web
//
// ── Masalah yang diselesaikan ───────────────────────────────────────────────
// Kalau pemilik membalas pelanggan dari HP-nya sendiri, bot tidak tahu apa-apa
// dan tetap ikut menjawab. Pelanggan menerima dua jawaban berbeda dari satu
// nomor, kadang saling bertentangan. Takeover lewat dashboard sudah benar sejak
// awal; yang tidak pernah ada cuma deteksi dari HP.
//
// ── Jebakan yang harus dihindari ────────────────────────────────────────────
// WhatsApp mengirimkan balik SETIAP pesan keluar sebagai kejadian `fromMe`,
// termasuk pesan yang baru saja dikirim bot sendiri. Menganggap semua `fromMe`
// sebagai "manusia mengambil alih" akan membuat bot menidurkan dirinya sendiri
// tepat sesudah balasan pertamanya — bot berhenti bekerja tanpa satu pun pesan
// galat, dan penyebabnya nyaris mustahil ditebak dari log.
//
// Penyaringnya ada di baileys.service.ts: tiap pesan yang dikirim bot dicatat
// id-nya di Redis, dan echo dengan id yang sama diabaikan. Fungsi ini hanya
// dipanggil untuk pesan keluar yang TIDAK dikenali sebagai kiriman bot.
// ──────────────────────────────────────────────────────────────────────────────

export async function handleAdminTakeover(
  businessId: string,
  msg: proto.IWebMessageInfo,
): Promise<void> {
  try {
    const remoteJid = resolveIncomingJid(msg.key as { remoteJid?: string | null; remoteJidAlt?: string | null });
    if (!remoteJid) return;

    const content = extractMessageContent(msg.message);
    const text =
      content?.conversation ||
      content?.extendedTextMessage?.text ||
      '';

    const waNumber = remoteJid.split('@')[0] ?? '';
    if (!waNumber) return;

    const lead = await prisma.lead.findFirst({
      where: { businessId, waNumber },
      select: { id: true, name: true },
    });
    // Tidak ada lead berarti pemilik memulai percakapan baru dari HP ke nomor
    // yang belum pernah masuk sistem. Tidak ada yang perlu dijeda — bot memang
    // belum pernah terlibat di percakapan itu.
    if (!lead) return;

    const conversation = await prisma.conversation.findFirst({
      where: { businessId, leadId: lead.id, status: { in: ['AI', 'HUMAN'] } },
      select: { id: true, status: true },
    });
    if (!conversation) return;

    // Pesan tetap disimpan walau percakapannya sudah HUMAN, supaya riwayat di
    // dashboard tidak berlubang: tanpa ini, balasan yang diketik dari HP tidak
    // pernah muncul di layar dan percakapannya terlihat menggantung.
    if (text.trim()) {
      await prisma.message.create({
        data: {
          businessId,
          conversationId: conversation.id,
          leadId: lead.id,
          message: text,
          messageType: 'text',
          fromRole: 'HUMAN',
        },
      });
    }

    const io = getIO();

    if (conversation.status === 'AI') {
      // humanId sengaja kosong: pesannya datang dari HP, jadi tidak ada akun
      // dashboard yang bisa diklaim sebagai pemiliknya. Percakapan tanpa pemilik
      // sudah bisa ditangani UI sejak perbaikan percakapan-terkunci.
      await prisma.conversation.update({
        where: { id: conversation.id },
        data: { status: 'HUMAN' },
      });

      logger.info(`[AutoPause] Admin membalas dari HP — bot menepi untuk conv ${conversation.id} (${waNumber})`);

      if (io) {
        io.to(`business:${businessId}`).emit('chat:status', {
          conversationId: conversation.id,
          status: 'HUMAN',
        });
        io.to(`business:${businessId}`).emit('chat:handover', {
          conversationId: conversation.id,
          leadId: lead.id,
          reason: 'admin_takeover_phone',
        });
      }

      notifyHandover({
        leadName: lead.name,
        waNumber,
        reason: 'admin_takeover_phone',
        detail: 'Bot berhenti menjawab pelanggan ini sampai Anda kembalikan ke AI dari dashboard.',
      });
    }

    if (io && text.trim()) {
      io.to(`business:${businessId}`).emit('chat:new', {
        conversationId: conversation.id,
        message: { fromRole: 'HUMAN', message: text, createdAt: new Date() },
      });
    }
  } catch (error: any) {
    logger.error(`[AutoPause] Gagal memproses balasan dari HP: ${error?.message}`, { stack: error?.stack });
  }
}
