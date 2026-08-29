/**
 * Membaca isi berkas yang diunggah menjadi teks polos.
 *
 * Pembagian tugasnya sengaja tidak seragam, dan alasannya keamanan proses:
 *
 *   .txt / .md  → dibaca langsung. Tidak ada yang bisa meledak.
 *   .docx       → mammoth, JavaScript murni. Aman di dalam proses server.
 *   .pdf, gambar→ PROSES TERPISAH. Keduanya menyentuh modul native (Skia untuk
 *                 merender halaman, WASM untuk OCR). Kerusakan memori di sana
 *                 mematikan seluruh proses Node tanpa bisa ditangkap try/catch —
 *                 dan itu bukan kekhawatiran teoretis, melainkan hal yang benar-
 *                 benar terjadi saat fitur ini diuji (`free(): invalid pointer`).
 *                 Kalau itu terjadi di dalam server, sesi WhatsApp dan seluruh
 *                 antrean ikut mati.
 *
 * Lihat `ocr-child.mjs` di akar folder backend untuk detail proses terpisahnya.
 */

import { spawn } from 'child_process';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import { logger } from '../utils/logger';

export interface ExtractedDocument {
  text: string;
  /** Berapa halaman terbaca (PDF). 1 untuk format lain. */
  pages: number;
  /** true kalau isinya didapat lewat pengenalan tulisan, bukan teks asli. */
  usedOcr: boolean;
  /** Keyakinan OCR 0–100. Hanya terisi kalau `usedOcr`. */
  confidence?: number;
  /** Halaman yang TIDAK ikut dibaca karena batas. Selalu dilaporkan. */
  truncatedPages: number;
}

/** Berkas yang bisa dibaca. Ditolak di luar ini supaya galatnya jelas di muka. */
export const SUPPORTED_EXTENSIONS = [
  '.txt', '.md', '.markdown', '.csv',
  '.docx', '.xlsx',
  '.pdf',
  '.png', '.jpg', '.jpeg', '.webp',
] as const;

/** OCR halaman banyak bisa lama; batas ini mencegah proses menggantung selamanya. */
const CHILD_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Cari `ocr-child.mjs`.
 *
 * Dicoba beberapa kemungkinan karena posisi __dirname berbeda antara mode
 * pengembangan (`src/services`) dan hasil kompilasi (`dist/services` atau
 * `dist/src/services`, tergantung bagaimana tsc menyimpulkan rootDir). Menebak
 * satu jalur saja berarti fiturnya mati diam-diam sesudah di-build.
 */
async function resolveChildScript(): Promise<string> {
  const candidates = [
    path.resolve(__dirname, '../../ocr-child.mjs'),
    path.resolve(__dirname, '../../../ocr-child.mjs'),
    path.resolve(process.cwd(), 'ocr-child.mjs'),
  ];
  for (const c of candidates) {
    try {
      await fs.access(c);
      return c;
    } catch { /* coba berikutnya */ }
  }
  throw new Error(
    'ocr-child.mjs tidak ditemukan. File itu harus ada di akar folder backend, ' +
    'sejajar dengan package.json.',
  );
}

interface ChildJob {
  mode: 'pdf' | 'image';
  path: string;
  allowOcr?: boolean;
  langs?: string[];
}

function runChild(script: string, job: ChildJob): Promise<ExtractedDocument> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], {
      stdio: ['pipe', 'pipe', 'pipe'],
      // execArgv sengaja TIDAK diwariskan: anak ini JavaScript polos dan tidak
      // butuh pemuat TypeScript. Mewariskannya justru bikin gagal jalan saat
      // server dijalankan lewat tsx.
    });

    let out = '';
    let err = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new Error('Pembacaan berkas kelamaan (lebih dari 5 menit) dan dihentikan.'));
    }, CHILD_TIMEOUT_MS);

    child.stdout.on('data', d => { out += d.toString(); });
    child.stderr.on('data', d => { err += d.toString(); });

    child.on('error', e => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(e);
    });

    child.on('close', code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      // Kode keluar tidak nol TANPA keluaran JSON = proses anaknya mati mendadak,
      // biasanya karena kerusakan memori di modul native. Inilah kejadian yang
      // membuat pemisahan proses ini ada: di sini ia cuma jadi satu unggahan
      // gagal, bukan server tumbang.
      if (!out.trim()) {
        logger.error(`[DocExtract] Proses pembaca mati (kode ${code}): ${err.slice(0, 400)}`);
        reject(new Error('Berkas gagal dibaca. Coba ekspor ulang atau unggah versi lain.'));
        return;
      }

      try {
        const parsed = JSON.parse(out.trim().split('\n').pop() || '{}');
        if (!parsed.ok) {
          reject(new Error(parsed.error || 'Berkas gagal dibaca'));
          return;
        }
        resolve({
          text: parsed.text || '',
          pages: parsed.pages || 1,
          usedOcr: Boolean(parsed.usedOcr),
          confidence: parsed.confidence,
          truncatedPages: parsed.truncatedPages || 0,
        });
      } catch (e) {
        reject(new Error(`Jawaban pembaca berkas tidak terbaca: ${e}`));
      }
    });

    child.stdin.write(JSON.stringify(job));
    child.stdin.end();
  });
}

/**
 * Ubah tabel jadi kalimat "Kolom: nilai", satu baris tabel per baris teks.
 *
 * Bukan dipertahankan sebagai tabel, dan ini disengaja. Yang mencari nanti
 * adalah pencocokan MAKNA, bukan mata manusia: baris berbunyi
 * `Produk: Pisau daging | Harga: 185000` bisa ditemukan oleh pertanyaan
 * "berapa harga pisau daging", sedangkan potongan tabel mentah berisi angka
 * berjejer tanpa nama kolom praktis tidak punya makna yang bisa dicocokkan.
 *
 * Baris pertama diperlakukan sebagai nama kolom. Kalau ternyata bukan, hasilnya
 * tetap terbaca — cuma label kolomnya jadi aneh, tidak sampai merusak.
 */
function tableToReadableLines(rows: string[][]): string {
  if (rows.length === 0) return '';
  const header = rows[0]!;
  const looksLikeHeader = header.every(h => h !== '' && !/^-?[\d.,]+$/.test(h));

  if (!looksLikeHeader || rows.length === 1) {
    return rows.map(r => r.filter(Boolean).join(' | ')).join('\n');
  }

  return rows.slice(1).map(row =>
    header
      .map((h, i) => (row[i] ? `${h}: ${row[i]}` : ''))
      .filter(Boolean)
      .join(' | '),
  ).filter(Boolean).join('\n');
}

/** Pembaca CSV sederhana yang menghormati tanda kutip dan koma di dalamnya. */
function csvToReadableLines(raw: string): string {
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (inQuotes) {
      if (ch === '"') {
        if (raw[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') { inQuotes = true; continue; }
    if (ch === ',' || ch === ';') { row.push(field.trim()); field = ''; continue; }
    if (ch === '\n') {
      row.push(field.trim()); field = '';
      if (row.some(c => c !== '')) rows.push(row);
      row = [];
      continue;
    }
    if (ch === '\r') continue;
    field += ch;
  }
  row.push(field.trim());
  if (row.some(c => c !== '')) rows.push(row);

  return tableToReadableLines(rows);
}

export async function extractDocument(
  buffer: Buffer,
  originalName: string,
): Promise<ExtractedDocument> {
  const ext = path.extname(originalName).toLowerCase();

  if (!SUPPORTED_EXTENSIONS.includes(ext as typeof SUPPORTED_EXTENSIONS[number])) {
    throw new Error(
      `Format ${ext || '(tanpa ekstensi)'} belum didukung. ` +
      `Yang bisa: ${SUPPORTED_EXTENSIONS.join(', ')}`,
    );
  }

  // ── Teks polos ────────────────────────────────────────────────────────────
  if (ext === '.txt' || ext === '.md' || ext === '.markdown') {
    return { text: buffer.toString('utf-8').trim(), pages: 1, usedOcr: false, truncatedPages: 0 };
  }

  // ── CSV ───────────────────────────────────────────────────────────────────
  if (ext === '.csv') {
    return {
      text: csvToReadableLines(buffer.toString('utf-8')),
      pages: 1, usedOcr: false, truncatedPages: 0,
    };
  }

  // ── Excel ─────────────────────────────────────────────────────────────────
  if (ext === '.xlsx') {
    const ExcelJS = await import('exceljs');
    const wb = new ExcelJS.default.Workbook();
    await wb.xlsx.load(buffer as any);

    const parts: string[] = [];
    wb.eachSheet(sheet => {
      const rows: string[][] = [];
      sheet.eachRow(row => {
        const values = (row.values as any[]).slice(1)
          .map(v => (v === null || v === undefined ? '' : String(typeof v === 'object' && 'text' in v ? v.text : v).trim()));
        if (values.some(v => v !== '')) rows.push(values);
      });
      if (rows.length === 0) return;
      parts.push(`## ${sheet.name}\n\n${tableToReadableLines(rows)}`);
    });

    return { text: parts.join('\n\n').trim(), pages: 1, usedOcr: false, truncatedPages: 0 };
  }

  // ── DOCX ──────────────────────────────────────────────────────────────────
  if (ext === '.docx') {
    // Impor di dalam fungsi supaya pustaka ini tidak ikut dimuat saat server
    // menyala — ia cuma dipakai kalau benar-benar ada unggahan .docx.
    const mammoth = await import('mammoth');
    const result = await mammoth.extractRawText({ buffer });
    return { text: (result.value || '').trim(), pages: 1, usedOcr: false, truncatedPages: 0 };
  }

  // ── PDF & gambar: lewat proses terpisah ──────────────────────────────────
  const script = await resolveChildScript();
  const tmpPath = path.join(os.tmpdir(), `salespintar-${randomUUID()}${ext}`);
  await fs.writeFile(tmpPath, buffer);

  try {
    const mode: ChildJob['mode'] = ext === '.pdf' ? 'pdf' : 'image';
    const result = await runChild(script, { mode, path: tmpPath, allowOcr: true });

    if (result.usedOcr) {
      logger.info(
        `[DocExtract] ${originalName} dibaca lewat OCR ` +
        `(keyakinan ${result.confidence?.toFixed(0) ?? '?'}%, ${result.pages} halaman)`,
      );
    }
    if (result.truncatedPages > 0) {
      // Aturan rumah: pembatasan cakupan tidak boleh diam-diam.
      logger.warn(
        `[DocExtract] ${originalName}: ${result.truncatedPages} halaman TIDAK ikut dibaca ` +
        `karena batas OCR.`,
      );
    }
    return result;
  } finally {
    // Berkas sementara selalu dibersihkan, termasuk saat gagal — kalau tidak,
    // /tmp pelan-pelan penuh oleh unggahan yang bermasalah.
    await fs.unlink(tmpPath).catch(() => undefined);
  }
}
