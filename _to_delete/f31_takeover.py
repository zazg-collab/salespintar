import io, os

ROOT = None
for base in os.listdir('/sessions'):
    p = f'/sessions/{base}/mnt/projek-ceo/salespintar_repo'
    if os.path.isdir(p):
        ROOT = p
        break
assert ROOT, 'repo not found'

path = os.path.join(ROOT, 'backend/src/services/message.service.ts')
src = io.open(path, encoding='utf-8').read()
assert 'handleAdminTakeover' not in src, 'sudah pernah ditambahkan'

src = src.rstrip() + '''


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

    const text =
      msg.message?.conversation ||
      msg.message?.extendedTextMessage?.text ||
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
'''

io.open(path, 'w', encoding='utf-8').write(src)
print('OK   message.service.ts (+handleAdminTakeover)')
