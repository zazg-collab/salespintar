import { Router, Request, Response, NextFunction } from 'express';
import multer from 'multer';
import AdmZip from 'adm-zip';
import { authenticate, authorize } from '../middleware/auth';
import { shadowMiningQueue } from '../queues/shadow-mining.queue';
import { logger } from '../utils/logger';
import { parseWhatsAppExport, toTranscript, guessCsNames, type ParsedChat } from '../services/wa-export-parser';

const router = Router();

// ──────────────────────────────────────────────────────────────────────────────
// IMPOR MASSAL CHAT WHATSAPP → SHADOW MINING
//
// Alurnya sengaja DUA LANGKAH, bukan satu:
//
//   1. POST /analyze  — bongkar zip, parse, tebak siapa CS, kembalikan ringkasan.
//                       BELUM ada satu pun token Groq yang terpakai.
//   2. POST /process  — setelah pengguna mengonfirmasi siapa CS, barulah
//                       transkrip dilempar ke antrean Shadow Mining.
//
// Pemisahan ini penting: menebak peran secara otomatis lalu langsung menambang
// berarti kesalahan tebakan baru ketahuan setelah ratusan panggilan Groq
// terbakar. Dengan dua langkah, pengguna mengoreksi dulu, biayanya belakangan.
// ──────────────────────────────────────────────────────────────────────────────

const MAX_ZIP_BYTES = 50 * 1024 * 1024; // 50 MB (keputusan Angga)

// Catatan keamanan: adm-zip dipatok minimal 0.6.0. Versi di bawahnya punya
// kerentanan HIGH (GHSA-xcpc-8h2w-3j85) — zip yang dirancang jahat memicu
// alokasi memori 4 GB dan menjatuhkan server. Endpoint ini menerima zip dari
// pengguna, jadi itu tepat berada di jalur serangan. Jangan turunkan versinya.

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_ZIP_BYTES },
});

/** Isi satu file chat yang sudah di-parse, siap ditampilkan ke pengguna. */
interface AnalyzedFile {
  filename: string;
  participants: string[];
  messageCount: number;
  skipped: ParsedChat['skipped'];
}

function extractChatFiles(zipBuffer: Buffer): { filename: string; content: string }[] {
  const zip = new AdmZip(zipBuffer);
  return zip
    .getEntries()
    .filter(e => {
      if (e.isDirectory) return false;
      const name = e.entryName.toLowerCase();
      // Hanya .txt. Media di dalam zip sengaja diabaikan — tidak dipakai, dan
      // memuatnya ke memori cuma memboroskan RAM.
      if (!name.endsWith('.txt')) return false;
      // Sampah bawaan macOS/Windows.
      if (name.includes('__macosx/') || name.endsWith('.ds_store')) return false;
      return true;
    })
    .map(e => ({ filename: e.entryName, content: e.getData().toString('utf-8') }));
}

// ──────────────────────────────────────────────────────────────────────────────
// POST /api/v1/chat-import/analyze
// Bongkar zip → parse → tebak CS. Tidak menyentuh Groq, tidak menyentuh database.
// ──────────────────────────────────────────────────────────────────────────────
router.post(
  '/analyze',
  authenticate,
  authorize('ADMIN', 'SALES'),
  upload.single('file'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.file) {
        res.status(400).json({ error: { message: 'File zip belum dilampirkan (field: file)' } });
        return;
      }

      let chatFiles: { filename: string; content: string }[];
      try {
        chatFiles = extractChatFiles(req.file.buffer);
      } catch (err) {
        res.status(400).json({ error: { message: `Gagal membaca zip: ${err}` } });
        return;
      }

      if (chatFiles.length === 0) {
        res.status(400).json({
          error: {
            message: 'Tidak ada file .txt di dalam zip. Pastikan mengekspor chat WhatsApp dengan opsi "Tanpa Media".',
          },
        });
        return;
      }

      const parsed = chatFiles.map(f => ({ file: f, chat: parseWhatsAppExport(f.content) }));
      const usable = parsed.filter(p => p.chat.messages.length > 0);

      if (usable.length === 0) {
        res.status(422).json({
          error: {
            message:
              'File berhasil dibaca tapi tidak ada pesan yang bisa dikenali. ' +
              'Kemungkinan format ekspornya belum didukung — kirim contoh 5 baris pertama file-nya untuk ditambahkan.',
          },
        });
        return;
      }

      const files: AnalyzedFile[] = usable.map(p => ({
        filename: p.file.filename,
        participants: p.chat.participants,
        messageCount: p.chat.messages.length,
        skipped: p.chat.skipped,
      }));

      // Semua nama unik lintas file, terurut dari yang paling sering hadir —
      // pengguna memilih dari daftar ini lewat dropdown.
      const nameFrequency = new Map<string, number>();
      for (const p of usable) {
        for (const name of new Set(p.chat.participants)) {
          nameFrequency.set(name, (nameFrequency.get(name) ?? 0) + 1);
        }
      }
      const allNames = [...nameFrequency.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([name, filesSeen]) => ({ name, filesSeen }));

      res.json({
        success: true,
        data: {
          totalFiles: chatFiles.length,
          usableFiles: usable.length,
          totalMessages: usable.reduce((n, p) => n + p.chat.messages.length, 0),
          // Tebakan awal untuk dikonfirmasi — bukan keputusan final.
          suggestedCsNames: guessCsNames(usable.map(p => p.chat)),
          allNames,
          files,
        },
      });
    } catch (err) { next(err); }
  },
);

// ──────────────────────────────────────────────────────────────────────────────
// POST /api/v1/chat-import/process
// Setelah CS dikonfirmasi: susun transkrip & lempar ke antrean Shadow Mining.
// Body (multipart): file = zip yang sama, csNames = JSON array nama CS
// ──────────────────────────────────────────────────────────────────────────────
router.post(
  '/process',
  authenticate,
  authorize('ADMIN', 'SALES'),
  upload.single('file'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.file) {
        res.status(400).json({ error: { message: 'File zip belum dilampirkan (field: file)' } });
        return;
      }

      let csNames: string[];
      try {
        const raw = JSON.parse((req.body.csNames as string) || '[]');
        if (!Array.isArray(raw) || raw.some(n => typeof n !== 'string')) throw new Error();
        csNames = raw;
      } catch {
        res.status(400).json({ error: { message: 'csNames harus berupa JSON array berisi nama (string)' } });
        return;
      }

      if (csNames.length === 0) {
        res.status(400).json({
          error: { message: 'Pilih minimal satu nama sebagai CS, supaya sistem tahu mana ucapan tim dan mana pelanggan.' },
        });
        return;
      }

      const businessId = req.user!.businessId;
      const chatFiles = extractChatFiles(req.file.buffer);

      let queued = 0;
      let skippedTooShort = 0;

      for (const f of chatFiles) {
        const chat = parseWhatsAppExport(f.content);
        if (chat.messages.length === 0) continue;

        // Lewati chat yang seluruhnya monolog CS — tidak ada pelanggan, tidak ada
        // pengetahuan yang bisa dipanen dari sana.
        const csSet = new Set(csNames.map(n => n.trim().toLowerCase()));
        const hasLead = chat.messages.some(m => !csSet.has(m.sender.trim().toLowerCase()));
        if (!hasLead) { skippedTooShort++; continue; }

        const transcript = toTranscript(chat, csNames);

        await shadowMiningQueue.add(
          'mine-import',
          {
            kind: 'import',
            rawTranscript: transcript,
            sourceLabel: f.filename.replace(/\.txt$/i, '').slice(0, 80),
            businessId,
            triggeredBy: 'import',
          },
          {
            // Jeda bertingkat supaya ratusan file tidak membanjiri Groq sekaligus.
            // Worker Shadow Mining sendiri sudah dibatasi 5 job/menit, ini lapis kedua.
            delay: queued * 1500,
          },
        );
        queued++;
      }

      logger.info(`[ChatImport] ${queued} transkrip diantrekan untuk business ${businessId} (CS: ${csNames.join(', ')})`);

      res.json({
        success: true,
        message: `${queued} percakapan diantrekan untuk ditambang. Pantau progresnya di halaman Auto-Learning.`,
        data: { queued, skippedNoLead: skippedTooShort, csNames },
      });
    } catch (err) { next(err); }
  },
);

export default router;
