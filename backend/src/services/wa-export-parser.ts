// ──────────────────────────────────────────────────────────────────────────────
// Parser ekspor chat WhatsApp
//
// WhatsApp menghasilkan format yang BERBEDA-BEDA tergantung platform dan bahasa
// HP. Empat bentuk yang umum ditemui:
//
//   [29/07/2026, 14.32.10] Angga: halo kak      ← iPhone, Indonesia
//   [7/29/26, 2:32:10 PM] Angga: halo kak       ← iPhone, English/US
//   29/07/2026 14.32 - Angga: halo kak          ← Android, Indonesia
//   7/29/26, 2:32 PM - Angga: halo kak          ← Android, English/US
//
// Karena itu parser ini tidak mencoba memahami tanggalnya secara presisi — yang
// penting adalah MENGENALI bahwa sebuah baris memulai pesan baru, lalu memisahkan
// pengirim dari isinya. Tanggal disimpan mentah; untuk keperluan menambang
// pengetahuan, urutan jauh lebih penting daripada stempel waktu yang akurat.
// ──────────────────────────────────────────────────────────────────────────────

export interface ParsedMessage {
  sender: string;
  text: string;
  /** Stempel waktu mentah apa adanya dari file — sengaja tidak di-parse. */
  rawTimestamp: string;
}

export interface ParsedChat {
  /** Nama unik yang muncul sebagai pengirim, terurut dari yang paling banyak bicara. */
  participants: string[];
  messages: ParsedMessage[];
  /** Baris yang dilewati beserta alasannya — berguna untuk menjelaskan hasil ke pengguna. */
  skipped: { systemMessages: number; mediaPlaceholders: number; unparsable: number };
}

// Baris pesan berformat kurung siku: [tanggal waktu] sisa
const BRACKET_LINE = /^\[([^\]]+)\]\s*(.+)$/;
// Baris pesan berformat strip: tanggal waktu - sisa
// Harus diawali angka supaya tidak salah menangkap kalimat biasa yang memuat " - ".
const DASH_LINE = /^(\d[^-]{5,40}?)\s-\s(.+)$/;

// Penanda media yang isinya memang tidak ada — tidak berguna untuk pengetahuan.
const MEDIA_PLACEHOLDERS = [
  '<media tidak disertakan>',
  '<media omitted>',
  'image omitted',
  'video omitted',
  'audio omitted',
  'sticker omitted',
  'document omitted',
  'gif omitted',
  'this message was deleted',
  'pesan ini telah dihapus',
  'you deleted this message',
];

/** Buang karakter arah teks tak terlihat yang disisipkan WhatsApp (U+200E, U+200F). */
function stripInvisible(s: string): string {
  return s.replace(/[‎‏‪-‮﻿]/g, '');
}

function isMediaPlaceholder(text: string): boolean {
  const lower = text.trim().toLowerCase();
  return MEDIA_PLACEHOLDERS.some(p => lower === p || lower.startsWith(p));
}

/**
 * Pisahkan "Nama: isi pesan" menjadi pengirim dan isi.
 *
 * Mengembalikan null kalau tidak ada pemisah — itu berarti pesan sistem
 * ("Angga membuat grup ini", "Pesan dan panggilan terenkripsi secara
 * end-to-end"), bukan ucapan siapa pun.
 *
 * Pemisahnya dicari pada kemunculan PERTAMA saja, karena isi pesan sendiri
 * sering memuat titik dua — "harga: 150rb" harus tetap utuh sebagai isi.
 */
function splitSenderAndText(rest: string): { sender: string; text: string } | null {
  const idx = rest.indexOf(': ');
  if (idx <= 0) return null;

  const sender = rest.slice(0, idx).trim();
  const text = rest.slice(idx + 2).trim();

  // Nama pengirim yang masuk akal: tidak kosong dan tidak sepanjang kalimat.
  // Pesan sistem panjang yang kebetulan memuat ": " tersaring di sini.
  if (!sender || sender.length > 60) return null;

  return { sender, text };
}

export function parseWhatsAppExport(raw: string): ParsedChat {
  const lines = stripInvisible(raw).split(/\r?\n/);

  const messages: ParsedMessage[] = [];
  const skipped = { systemMessages: 0, mediaPlaceholders: 0, unparsable: 0 };
  const senderCounts = new Map<string, number>();

  for (const line of lines) {
    if (!line.trim()) continue;

    let timestamp: string | null = null;
    let rest: string | null = null;

    const bracket = BRACKET_LINE.exec(line);
    if (bracket) {
      timestamp = bracket[1]!.trim();
      rest = bracket[2]!;
    } else {
      const dash = DASH_LINE.exec(line);
      if (dash) {
        timestamp = dash[1]!.trim();
        rest = dash[2]!;
      }
    }

    // Tidak diawali stempel waktu → ini lanjutan pesan sebelumnya yang multi-baris.
    if (rest === null) {
      const last = messages[messages.length - 1];
      if (last) {
        last.text += '\n' + line.trim();
      } else {
        skipped.unparsable++;
      }
      continue;
    }

    const parts = splitSenderAndText(rest);
    if (!parts) {
      // Pesan sistem. Penting: JANGAN diperlakukan sebagai lanjutan, karena
      // isinya bukan ucapan siapa pun dan akan mengotori pesan sebelumnya.
      skipped.systemMessages++;
      continue;
    }

    if (!parts.text || isMediaPlaceholder(parts.text)) {
      skipped.mediaPlaceholders++;
      continue;
    }

    messages.push({ sender: parts.sender, text: parts.text, rawTimestamp: timestamp! });
    senderCounts.set(parts.sender, (senderCounts.get(parts.sender) ?? 0) + 1);
  }

  const participants = [...senderCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name]) => name);

  return { participants, messages, skipped };
}

/**
 * Susun transkrip siap-tambang, dengan peran yang sudah ditandai.
 *
 * Shadow Mining mengharapkan bentuk `[CS] ...` / `[LEAD] ...` — sama seperti yang
 * dihasilkan jalur percakapan dari database, supaya prompt tiga lapisnya tidak
 * perlu diubah sama sekali.
 */
export function toTranscript(chat: ParsedChat, csNames: string[]): string {
  const csSet = new Set(csNames.map(n => n.trim().toLowerCase()));
  return chat.messages
    .map(m => {
      const role = csSet.has(m.sender.trim().toLowerCase()) ? 'CS' : 'LEAD';
      return `[${role}] ${m.text}`;
    })
    .join('\n');
}

/**
 * Tebak siapa CS-nya: nama yang muncul di HAMPIR SEMUA file.
 *
 * Dalam ekspor chat satu-lawan-satu, pelanggan berbeda di tiap file sementara
 * CS-nya orang yang sama. Jadi nama yang hadir di sebagian besar file hampir
 * pasti tim sendiri. Ini cuma tebakan awal untuk dikonfirmasi pengguna — bukan
 * keputusan final — supaya tidak perlu memilih satu per satu untuk 200 file.
 */
export function guessCsNames(chats: ParsedChat[], threshold = 0.6): string[] {
  if (chats.length === 0) return [];

  const appearsIn = new Map<string, number>();
  for (const chat of chats) {
    for (const name of new Set(chat.participants)) {
      appearsIn.set(name, (appearsIn.get(name) ?? 0) + 1);
    }
  }

  const minFiles = Math.max(2, Math.ceil(chats.length * threshold));
  return [...appearsIn.entries()]
    .filter(([, count]) => count >= minFiles)
    .sort((a, b) => b[1] - a[1])
    .map(([name]) => name);
}
