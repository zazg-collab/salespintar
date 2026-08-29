/**
 * Pembaca dokumen — dijalankan sebagai PROSES TERPISAH.
 *
 * ── Kenapa dipisah, dan ini bukan kehati-hatian berlebihan ───────────────────
 * Waktu fitur ini diuji, merender halaman PDF jadi gambar menghasilkan
 * `free(): invalid pointer` — kerusakan memori di lapisan native (Skia), bukan
 * galat JavaScript. Galat semacam itu TIDAK BISA ditangkap try/catch: seluruh
 * proses Node mati seketika. Kalau itu terjadi di dalam server, yang ikut mati
 * adalah sesi WhatsApp, seluruh antrean, dan semua percakapan yang sedang jalan
 * — persis kerapuhan yang seharian ini dibereskan.
 *
 * Penyebab yang ditemukan: DUA salinan modul native canvas termuat sekaligus
 * (satu milik pdfjs, satu dipasang terpisah). Itu sudah dihindari dengan tidak
 * memasang canvas sendiri. Tapi jumlah salinan ditentukan cara npm menata
 * folder, dan itu bisa berubah diam-diam pada instalasi berikutnya — di mesin
 * lain, atau di VPS. Kerapuhan yang bergantung pada tata letak node_modules
 * adalah kerapuhan yang akan muncul justru saat pindah server.
 *
 * Dengan proses terpisah, kerusakan terburuk cuma satu unggahan yang gagal.
 *
 * Bonus: memori tesseract (WASM, berat) ikut dilepas saat proses selesai, dan
 * OCR yang berjalan lama tidak membekukan server.
 *
 * ── Cara pakai ───────────────────────────────────────────────────────────────
 * Menerima satu baris JSON lewat stdin, membalas satu baris JSON lewat stdout.
 * Sengaja JavaScript polos (.mjs), bukan TypeScript: dengan begitu bisa
 * dijalankan `node` apa adanya, sama saja waktu pengembangan (tsx) maupun
 * setelah dikompilasi ke dist/.
 */

import fs from 'fs/promises';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

/** Ambang penentu "ini hasil pindaian". */
const MIN_CHARS_PER_PAGE = 80;
/** Batas halaman yang di-OCR. Pemangkasannya SELALU dilaporkan, tidak diam-diam. */
const MAX_OCR_PAGES = 30;

function reply(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

async function readPdf(filePath, allowOcr, langs) {
  const PDFJS = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const buf = await fs.readFile(filePath);
  const doc = await PDFJS.getDocument({
    data: new Uint8Array(buf),
    useSystemFonts: true,
    // Menonaktifkan pekerja bawaan pdfjs: di Node ia tidak memberi keuntungan
    // apa pun sementara menambah satu lapisan yang bisa gagal.
    disableFontFace: true,
  }).promise;

  const pages = doc.numPages;
  const chunks = [];
  for (let i = 1; i <= pages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    chunks.push(content.items.map(it => it.str).join(' '));
  }
  const text = chunks.join('\n').replace(/[ \t]+/g, ' ').trim();

  const perPage = pages > 0 ? text.length / pages : 0;
  if (perPage >= MIN_CHARS_PER_PAGE || !allowOcr) {
    return { text, pages, usedOcr: false, truncatedPages: 0 };
  }

  // ── Jalur pindaian: halaman dirender jadi gambar, lalu dibaca OCR ─────────
  // Canvas diambil lewat resolusi milik pdfjs SENDIRI, bukan paket terpisah.
  // Memuat dua salinan modul native yang sama adalah penyebab crash tadi.
  const { createCanvas } = require('pdfjs-dist/node_modules/@napi-rs/canvas');
  const { createWorker } = await import('tesseract.js');

  const limit = Math.min(pages, MAX_OCR_PAGES);
  const worker = await createWorker(langs);
  const ocrChunks = [];
  let confSum = 0;

  try {
    for (let i = 1; i <= limit; i++) {
      const page = await doc.getPage(i);
      // Skala 2 memberi ketajaman yang cukup untuk teks cetak tanpa membuat
      // gambarnya raksasa. Di bawah itu, angka kecil seperti "185.000" mulai
      // salah terbaca.
      const vp = page.getViewport({ scale: 2 });
      const canvas = createCanvas(Math.ceil(vp.width), Math.ceil(vp.height));
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, vp.width, vp.height);
      await page.render({ canvasContext: ctx, viewport: vp, canvas }).promise;

      const { data } = await worker.recognize(canvas.toBuffer('image/png'));
      ocrChunks.push(data.text.trim());
      confSum += data.confidence || 0;
    }
  } finally {
    await worker.terminate().catch(() => undefined);
  }

  return {
    text: ocrChunks.join('\n\n').trim(),
    pages,
    usedOcr: true,
    confidence: limit > 0 ? confSum / limit : 0,
    truncatedPages: Math.max(pages - limit, 0),
  };
}

async function readImage(filePath, langs) {
  const { createWorker } = await import('tesseract.js');
  const worker = await createWorker(langs);
  try {
    const { data } = await worker.recognize(filePath);
    return {
      text: data.text.trim(),
      pages: 1,
      usedOcr: true,
      confidence: data.confidence || 0,
      truncatedPages: 0,
    };
  } finally {
    await worker.terminate().catch(() => undefined);
  }
}

async function main() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;

  let job;
  try {
    job = JSON.parse(raw);
  } catch {
    reply({ ok: false, error: 'Perintah tidak terbaca' });
    return;
  }

  try {
    const langs = job.langs || ['ind', 'eng'];
    const result = job.mode === 'image'
      ? await readImage(job.path, langs)
      : await readPdf(job.path, job.allowOcr !== false, langs);
    reply({ ok: true, ...result });
  } catch (err) {
    reply({ ok: false, error: err?.message ? String(err.message) : String(err) });
  }
}

main();
