import sys, io, os

ROOT = None
for base in os.listdir('/sessions'):
    p = f'/sessions/{base}/mnt/projek-ceo/salespintar_repo'
    if os.path.isdir(p):
        ROOT = p
        break
assert ROOT, 'repo not found'

def patch(relpath, pairs):
    path = os.path.join(ROOT, relpath)
    with io.open(path, encoding='utf-8') as f:
        src = f.read()
    for old, new in pairs:
        n = src.count(old)
        if n != 1:
            print(f'FAIL {relpath}: pola ditemukan {n}x (harus 1):\n---\n{old[:220]}\n---')
            sys.exit(1)
        src = src.replace(old, new)
    with io.open(path, 'w', encoding='utf-8') as f:
        f.write(src)
    print(f'OK   {relpath} ({len(pairs)} substitusi)')


# ══ 1. env.ts ═════════════════════════════════════════════════════════════════
patch('backend/src/config/env.ts', [
(
"""  LOG_LEVEL: z.string().default('info'),""",
"""  // Notifikasi admin lewat Telegram. Keduanya opsional — kalau kosong, fitur
  // notifikasinya sekadar tidak aktif, tidak bikin server gagal start.
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_CHAT_ID: z.string().optional(),

  LOG_LEVEL: z.string().default('info'),"""
),
])


# ══ 2. schema.prisma ══════════════════════════════════════════════════════════
patch('backend/prisma/schema.prisma', [
(
"""  dailyAiCount   Int       @default(0) @map("daily_ai_count")""",
"""  dailyAiCount   Int       @default(0) @map("daily_ai_count")
  /** Tanggal (jam Indonesia) milik `dailyAiCount`. Kalau bukan hari ini,
   *  hitungannya dianggap nol — inilah "reset harian" yang dulu tidak pernah
   *  terjadi karena tidak ada cron yang menjalankannya. */
  dailyCountDate DateTime? @map("daily_count_date") @db.Date"""
),
])

mig_dir = os.path.join(ROOT, 'backend/prisma/migrations/20260729_daily_cap_reset')
os.makedirs(mig_dir, exist_ok=True)
io.open(os.path.join(mig_dir, 'migration.sql'), 'w', encoding='utf-8').write(
'''-- Kuota balasan AI harian: simpan TANGGAL hitungan supaya bisa dibandingkan
-- saat dipakai, bukan direset oleh cron yang bisa terlewat.
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "daily_count_date" DATE;

-- Baris lama tidak punya tanggal, jadi hitungannya otomatis dianggap nol pada
-- pemakaian berikutnya. Itu justru yang diinginkan: pelanggan yang selama ini
-- terblokir permanen langsung bebas begitu migrasi ini jalan.
''')
print('OK   migration 20260729_daily_cap_reset')


# ══ 3. state.service.ts — daftar pesan kiriman bot ════════════════════════════
patch('backend/src/services/state.service.ts', [
(
"""const PREFIX = 'salespintar:state';""",
"""const PREFIX = 'salespintar:state';

// ──────────────────────────────────────────────────────────────────────────────
// DAFTAR PESAN KIRIMAN BOT SENDIRI
//
// Dipakai fitur auto-pause. Persoalannya: WhatsApp mengirimkan balik SETIAP
// pesan keluar dari nomor ini sebagai kejadian `fromMe: true` — termasuk pesan
// yang baru saja dikirim bot sendiri. Kalau setiap `fromMe` dianggap "manusia
// mengambil alih", bot akan menidurkan dirinya sendiri tepat sesudah balasan
// pertamanya, dan seluruh fitur bot mati tanpa satu pun pesan galat.
//
// Karena itu tiap pesan yang dikirim bot dicatat id-nya sebentar. Saat kejadian
// `fromMe` datang, id-nya dicocokkan: ada di daftar berarti kiriman bot sendiri
// (abaikan), tidak ada berarti manusia yang mengetik dari HP (tidurkan bot).
//
// Disimpan di Redis, bukan di memori proses — supaya tetap benar sesudah restart
// dan tetap benar kalau nanti di VPS ada lebih dari satu instance yang jalan.
// Instance A bisa mengirim pesan sementara kejadian `fromMe`-nya diterima
// instance B; daftar di memori akan salah menuduh manusia.
// ──────────────────────────────────────────────────────────────────────────────

/** Cukup panjang untuk menampung keterlambatan echo WhatsApp, cukup pendek
 *  supaya daftarnya tidak menumpuk selamanya. */
const OUTGOING_ID_TTL_SEC = 60 * 30;

function outgoingKey(businessId: string, messageId: string): string {
  return `${PREFIX}:sent:${businessId}:${messageId}`;
}

/** Catat bahwa pesan ini dikirim oleh bot, bukan manusia. */
export async function rememberBotSentMessage(businessId: string, messageId: string): Promise<void> {
  if (!messageId) return;
  try {
    await redisCache.set(outgoingKey(businessId, messageId), '1', 'EX', OUTGOING_ID_TTL_SEC);
  } catch (err) {
    logger.warn(`[State] Gagal mencatat id pesan keluar ${messageId}: ${err}`);
  }
}

/**
 * Apakah pesan ini kiriman bot sendiri?
 *
 * Saat Redis bermasalah, jawabannya `true` — DISENGAJA. Salah menebak "ini
 * kiriman bot" cuma membuat auto-pause tidak jalan sekali itu. Salah menebak
 * "ini manusia" akan menidurkan bot untuk pelanggan yang sedang dilayaninya,
 * dan tidak ada yang akan membangunkannya. Dari dua kesalahan, pilih yang bisa
 * dipulihkan sendiri.
 */
export async function wasSentByBot(businessId: string, messageId: string): Promise<boolean> {
  if (!messageId) return true;
  try {
    return (await redisCache.exists(outgoingKey(businessId, messageId))) === 1;
  } catch (err) {
    logger.warn(`[State] Gagal memeriksa id pesan keluar ${messageId}, dianggap kiriman bot: ${err}`);
    return true;
  }
}"""
),
])


# ══ 4. baileys.service.ts ═════════════════════════════════════════════════════
patch('backend/src/services/baileys.service.ts', [
(
"""  private messageHandler: ((businessId: string, msg: proto.IWebMessageInfo) => Promise<void>) | null = null;""",
"""  private messageHandler: ((businessId: string, msg: proto.IWebMessageInfo) => Promise<void>) | null = null;
  /** Dipanggil saat ada pesan KELUAR yang bukan kiriman bot — artinya manusia
   *  mengetik dari HP atau WhatsApp Web. Lihat auto-pause di message.service. */
  private outgoingHandler: ((businessId: string, msg: proto.IWebMessageInfo) => Promise<void>) | null = null;"""
),
(
"""  setMessageHandler(handler: (businessId: string, msg: proto.IWebMessageInfo) => Promise<void>) {
    this.messageHandler = handler;""",
"""  setOutgoingHandler(handler: (businessId: string, msg: proto.IWebMessageInfo) => Promise<void>) {
    this.outgoingHandler = handler;
  }

  setMessageHandler(handler: (businessId: string, msg: proto.IWebMessageInfo) => Promise<void>) {
    this.messageHandler = handler;"""
),
(
"""      for (const message of msg.messages) {
        if (message.key.fromMe) continue;""",
"""      for (const message of msg.messages) {
        // ── Pesan keluar ────────────────────────────────────────────────────
        // Dulu semua `fromMe` dibuang di sini, dan itulah sebabnya bot tidak
        // pernah tahu kalau admin membalas dari HP — bot ikut menjawab dan
        // pelanggan menerima dua jawaban berbeda dari nomor yang sama.
        //
        // Sekarang dipilah: kiriman bot sendiri tetap diabaikan, kiriman
        // manusia diteruskan supaya bot bisa menepi.
        if (message.key.fromMe) {
          if (!this.outgoingHandler) continue;
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
        }"""
),
(
"""    return instance.sock.sendMessage(jid, content);""",
"""    const sent = await instance.sock.sendMessage(jid, content);

    // Catat id-nya supaya echo `fromMe` yang sebentar lagi datang dari WhatsApp
    // tidak salah dikira ketikan manusia — kalau salah, bot menidurkan dirinya
    // sendiri sesudah balasan pertama.
    const sentId = sent?.key?.id;
    if (sentId) await rememberBotSentMessage(businessId, sentId);

    return sent;"""
),
])

# import di baileys.service.ts
p = os.path.join(ROOT, 'backend/src/services/baileys.service.ts')
s = io.open(p, encoding='utf-8').read()
anchor = "import { logger } from '../utils/logger';"
assert s.count(anchor) == 1, 'anchor import logger di baileys tidak unik'
s = s.replace(anchor, anchor + "\nimport { rememberBotSentMessage, wasSentByBot } from './state.service';")
io.open(p, 'w', encoding='utf-8').write(s)
print('OK   baileys.service.ts (import state.service)')


# ══ 5. ai.service.ts — kuota harian sadar tanggal ═════════════════════════════
patch('backend/src/services/ai.service.ts', [
(
"""  const lead = await prisma.lead.findUnique({ where: { id: leadId } });
  if (!lead) return { ok: false, reason: 'lead_not_found' };
  if (lead.dailyAiCount >= DAILY_CAP) {
    logger.warn(`Daily AI cap reached for lead ${leadId}`);
    return { ok: false, reason: 'daily_cap' };
  }""",
"""  const lead = await prisma.lead.findUnique({ where: { id: leadId } });
  if (!lead) return { ok: false, reason: 'lead_not_found' };

  // Dulu di sini membaca `lead.dailyAiCount` mentah-mentah, tanpa peduli
  // hitungan itu dari hari kapan — sehingga batas "harian" berlaku seumur hidup.
  // Sekarang lewat helper yang membandingkan tanggalnya dengan hari ini.
  const usedToday = await getTodayAiCount(leadId);
  if (usedToday >= DAILY_CAP) {
    logger.warn(`Daily AI cap reached for lead ${leadId} (${usedToday}/${DAILY_CAP} hari ini)`);
    return { ok: false, reason: 'daily_cap' };
  }"""
),
])

p = os.path.join(ROOT, 'backend/src/services/ai.service.ts')
s = io.open(p, encoding='utf-8').read()
anchor = "import { logger } from '../utils/logger';"
assert s.count(anchor) == 1, 'anchor import logger di ai.service tidak unik'
s = s.replace(anchor, anchor + "\nimport { getTodayAiCount } from './rate-limit.service';")
io.open(p, 'w', encoding='utf-8').write(s)
print('OK   ai.service.ts (import rate-limit.service)')


# ══ 6. message.service.ts ═════════════════════════════════════════════════════
patch('backend/src/services/message.service.ts', [
(
"""// ── 4. Rate Limiting per Lead ─────────────────────────────────────────────────
// Cek daily_ai_count vs cap dari env (GROQ_DAILY_CAP_PER_LEAD)
// daily_ai_count direset setiap hari via cron (belum ada, nanti Fase 6 atau manual)
async function isRateLimited(leadId: string): Promise<boolean> {
  const lead = await prisma.lead.findUnique({
    where: { id: leadId },
    select: { dailyAiCount: true },
  });
  return (lead?.dailyAiCount ?? 0) >= env.GROQ_DAILY_CAP_PER_LEAD;
}""",
"""// ── 4. Rate Limiting per Lead ─────────────────────────────────────────────────
// Kuota balasan AI per pelanggan per hari. Logika tanggalnya ada di
// rate-limit.service.ts; komentar lama di sini ("direset setiap hari via cron,
// belum ada") sudah tidak berlaku — resetnya sekarang terjadi sendiri karena
// hitungan dari hari kemarin dianggap nol tanpa perlu ada yang menjalankannya."""
),
(
"""  const limited = await isRateLimited(leadId);
  if (limited) {""",
"""  const limited = await isDailyCapReached(leadId);
  if (limited) {"""
),
(
"""  // Increment daily AI count
  // Catatan (fix audit A1): increment HANYA di sini, tidak di ai.service.ts.
  await prisma.lead.update({
    where: { id: leadId },
    data: { dailyAiCount: { increment: 1 } },
  });""",
"""  // Increment daily AI count
  // Catatan (fix audit A1): increment HANYA di sini, tidak di ai.service.ts.
  // Kalau catatan terakhir dari hari lain, hitungannya dimulai ulang dari 1.
  await incrementTodayAiCount(leadId);"""
),
(
"""      if (io) {
        io.to(`business:${businessId}`).emit('lead:hot', {
          leadId: lead.id,
          leadName: lead.name,
          waNumber,
          conversationId: conversation.id,
          trigger: messageText.slice(0, 80),
          timestamp: new Date().toISOString(),
        });
      }""",
"""      if (io) {
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
      });"""
),
])

# import di message.service.ts
p = os.path.join(ROOT, 'backend/src/services/message.service.ts')
s = io.open(p, encoding='utf-8').read()
anchor = "import { logger } from '../utils/logger';"
assert s.count(anchor) == 1, 'anchor import logger di message.service tidak unik'
s = s.replace(anchor, anchor +
    "\nimport { isDailyCapReached, incrementTodayAiCount } from './rate-limit.service';" +
    "\nimport { notifyHotLead, notifyHandover } from './telegram.service';")
io.open(p, 'w', encoding='utf-8').write(s)
print('OK   message.service.ts (import)')


# ══ 7. ai-reply.worker.ts — Telegram ══════════════════════════════════════════
patch('backend/src/queues/ai-reply.worker.ts', [
(
"""      ioBlocked.to(`business:${businessId}`).emit('chat:handover', {
        conversationId,
        leadId,
        reason: `ai_blocked:${generated.reason}`,
      });
    }
    return;""",
"""      ioBlocked.to(`business:${businessId}`).emit('chat:handover', {
        conversationId,
        leadId,
        reason: `ai_blocked:${generated.reason}`,
      });
    }

    const blockedLead = await prisma.lead.findUnique({
      where: { id: leadId },
      select: { name: true, waNumber: true },
    });
    notifyHandover({
      leadName: blockedLead?.name ?? null,
      waNumber: blockedLead?.waNumber ?? null,
      reason: `ai_blocked:${generated.reason}`,
    });
    return;"""
),
(
"""    if (!supervisorResult.approved) {
      io.to(`business:${businessId}`).emit('supervisor:alert', {
        conversationId,
        leadId,
        riskLevel,
        riskScore,
        riskReasons,
        blockedReply: draftReply.slice(0, 120) + '...', // preview saja, tidak kirim ke lead
        timestamp: new Date().toISOString(),
      });
    }""",
"""    if (!supervisorResult.approved) {
      io.to(`business:${businessId}`).emit('supervisor:alert', {
        conversationId,
        leadId,
        riskLevel,
        riskScore,
        riskReasons,
        blockedReply: draftReply.slice(0, 120) + '...', // preview saja, tidak kirim ke lead
        timestamp: new Date().toISOString(),
      });

      const blockedFor = await prisma.lead.findUnique({
        where: { id: leadId },
        select: { name: true, waNumber: true },
      });
      notifySupervisorBlock({
        leadName: blockedFor?.name ?? null,
        waNumber: blockedFor?.waNumber ?? null,
        riskScore,
        riskReasons,
        blockedReply: draftReply.slice(0, 200),
      });
    }"""
),
(
"""      io.to(`business:${businessId}`).emit('chat:status', {
        conversationId,
        status: 'HUMAN',
      });
    }
  }

  // ── Step 7: Tag lead (background) ────────────────────────────────────────""",
"""      io.to(`business:${businessId}`).emit('chat:status', {
        conversationId,
        status: 'HUMAN',
      });
    }

    const handoverLead = await prisma.lead.findUnique({
      where: { id: leadId },
      select: { name: true, waNumber: true },
    });
    notifyHandover({
      leadName: handoverLead?.name ?? null,
      waNumber: handoverLead?.waNumber ?? null,
      reason: 'supervisor_high_risk',
      detail: `Skor risiko ${riskScore}: ${riskReasons.join(', ')}`,
    });
  }

  // ── Step 7: Tag lead (background) ────────────────────────────────────────"""
),
])

p = os.path.join(ROOT, 'backend/src/queues/ai-reply.worker.ts')
s = io.open(p, encoding='utf-8').read()
anchor = "import { logger } from '../utils/logger';"
assert s.count(anchor) == 1, 'anchor import logger di ai-reply.worker tidak unik'
s = s.replace(anchor, anchor + "\nimport { notifyHandover, notifySupervisorBlock } from '../services/telegram.service';")
io.open(p, 'w', encoding='utf-8').write(s)
print('OK   ai-reply.worker.ts (import telegram)')


# ══ 8. server.ts — daftarkan handler pesan keluar ═════════════════════════════
patch('backend/src/server.ts', [
(
"  baileysManager.setMessageHandler(handleIncomingMessage);",
"""  baileysManager.setMessageHandler(handleIncomingMessage);
  // Auto-pause: kalau admin membalas langsung dari HP atau WhatsApp Web, bot
  // menepi untuk nomor itu supaya tidak berebut menjawab.
  baileysManager.setOutgoingHandler(handleAdminTakeover);"""
),
])

p = os.path.join(ROOT, 'backend/src/server.ts')
s = io.open(p, encoding='utf-8').read()
assert s.count('handleIncomingMessage') >= 2
import re
m = re.search(r"import \{([^}]*)\} from '\./services/message\.service';", s)
assert m, 'import message.service di server.ts tidak ketemu'
inner = m.group(1)
if 'handleAdminTakeover' not in inner:
    s = s[:m.start(1)] + inner.rstrip().rstrip(',') + ', handleAdminTakeover' + s[m.end(1):]
    io.open(p, 'w', encoding='utf-8').write(s)
    print('OK   server.ts (import handleAdminTakeover)')

print('SELESAI')
