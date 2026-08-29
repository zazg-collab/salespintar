/**
 * Memecah dokumen jadi potongan sebelum diubah menjadi vektor.
 *
 * ── Kenapa ini perlu ────────────────────────────────────────────────────────
 * Sebelumnya SATU file = SATU vektor, sepanjang apa pun isinya. Untuk catatan
 * pendek itu tidak masalah. Tapi begitu ada katalog 30 halaman, seluruh isinya
 * diperas jadi satu titik di ruang makna — dan satu titik tidak mungkin mewakili
 * 30 halaman sekaligus. Yang terjadi: rata-rata maknanya kabur ke mana-mana,
 * dan pencarian jadi paling tumpul justru pada dokumen yang paling banyak isinya.
 * Pelanggan bertanya "harga pisau roti", katalog yang memuat jawabannya malah
 * tidak muncul.
 *
 * Dengan pemecahan, tiap bagian punya vektornya sendiri. Bagian yang membahas
 * pisau roti bisa ditemukan tanpa terganggu 29 halaman lain di file yang sama.
 *
 * ── Dua keputusan yang perlu dijelaskan ─────────────────────────────────────
 *
 * 1. DIPOTONG DI BATAS ALAMI, bukan di hitungan kata yang kaku. Potongan yang
 *    terbelah di tengah kalimat menghasilkan vektor yang maknanya rusak — dua
 *    keping yang sama-sama tidak bisa dipahami. Jadi pemisahnya diutamakan pada
 *    judul bagian, lalu paragraf, baru terakhir kalimat.
 *
 * 2. JUDUL DOKUMEN DITEMPELKAN KE SETIAP POTONGAN. Potongan yang berbunyi
 *    "Ukuran 8 inci, Rp 185.000" tidak berarti apa-apa berdiri sendiri — bahkan
 *    mesinnya tidak tahu itu tentang pisau. Menempelkan judul membuat tiap
 *    potongan tetap bisa dipahami sendirian, dan itu justru inti dari memecah.
 */

/**
 * Penanda awal blok transkrip mentah di dokumen hasil Shadow Mining.
 *
 * SATU definisi, dipakai dua arah: `shadow-mining.worker.ts` menuliskannya ke
 * dalam prompt (supaya model menghasilkan bentuk ini), dan
 * `obsidian-watcher.service.ts` memakainya untuk MEMBUANG blok itu sebelum
 * diindeks. Kalau dua tempat itu memegang string sendiri-sendiri, cukup satu
 * pihak mengubah kata dan penyaringnya berhenti bekerja tanpa satu galat pun —
 * kelas drift yang sama dengan nama kolom di raw SQL (Fase 64).
 */
export const PENANDA_TRANSKRIP = '**Sumber Obrolan Asli:**';

/**
 * Buang blok transkrip mentah dari isi dokumen sebelum diindeks.
 *
 * ── Kenapa ini ada ───────────────────────────────────────────────────────────
 * Dokumen hasil tambang menyertakan cuplikan obrolan asli di bawah pemisah
 * `---`, dan itu BERGUNA — Angga bisa memeriksa apakah ringkasannya jujur
 * terhadap percakapan yang jadi sumbernya. Yang tidak boleh adalah cuplikan itu
 * ikut jadi PENGETAHUAN BOT.
 *
 * Sebabnya konkret. Lapis 2 sudah bekerja dengan benar: ringkasan yang ia tulis
 * SENGAJA tidak menyebut angka — "CS menjelaskan rincian biaya, termasuk harga
 * produk dan ongkir", bukan "harga 199.000, ongkir 53.000". Itu memang aturan
 * anti-fakta-volatil dari Fase 28/45. Tapi transkripnya, beberapa baris di
 * bawah, memuat semuanya apa adanya:
 *
 *     > [CS] *RINCIAN BIAYA* 1. Harga : 199.000  2. Ongkir : ~60.000~ diskon
 *            jadi 53.000  *TOTAL COD : 252.000*
 *     > [CS] Estimasi 6-8 harian
 *
 * `syncFile()` memberikan SELURUH badan dokumen ke `chunkDocument()`, jadi
 * angka-angka itu punya vektornya sendiri dan bisa ditemukan pencarian. Harga
 * yang berubah, dan ONGKIR yang seharusnya selalu dihitung hidup dari API
 * Mengantar (Fase 38/52), masuk kembali sebagai pengetahuan mati.
 *
 * Jadi pengamannya tidak dilanggar — ia DILEWATI. Fakta volatil dibuang di pintu
 * depan lalu dibawa masuk lewat pintu belakang oleh fitur ketertelusuran.
 *
 * Blok ini TIDAK dihapus dari berkasnya. Ia tetap ada untuk dibaca manusia; yang
 * berubah cuma: ia tidak lagi ikut diubah menjadi vektor.
 */
export function buangTranskripSumber(body: string): { teks: string; dibuang: boolean } {
  const idx = body.indexOf(PENANDA_TRANSKRIP);
  if (idx === -1) return { teks: body, dibuang: false };

  // Ikut buang pemisah `---` yang mendahuluinya, kalau ada — kalau tidak,
  // potongan terakhir berakhir dengan garis menggantung yang tidak berarti apa-apa.
  let potong = idx;
  const sebelum = body.slice(0, idx);
  const pemisah = sebelum.lastIndexOf('---');
  if (pemisah !== -1 && sebelum.slice(pemisah + 3).trim() === '') potong = pemisah;

  return { teks: body.slice(0, potong).trimEnd(), dibuang: true };
}

/** Target ukuran satu potongan, dalam kata. */
export const CHUNK_TARGET_WORDS = 400;

/**
 * Tumpang tindih antar potongan, dalam kata.
 *
 * Ada supaya kalimat yang kebetulan jatuh tepat di garis potong tidak kehilangan
 * konteksnya. Tanpa ini, jawaban yang tertulis di akhir satu potongan dan awal
 * potongan berikutnya bisa hilang dari dua-duanya.
 */
export const CHUNK_OVERLAP_WORDS = 60;

/** Di bawah ini tidak dipecah sama sekali — memecahnya cuma bikin serpihan. */
export const CHUNK_MIN_WORDS = 120;

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function lastWords(text: string, n: number): string {
  const words = text.trim().split(/\s+/).filter(Boolean);
  return words.slice(Math.max(0, words.length - n)).join(' ');
}

/**
 * Pecah teks jadi blok-blok kecil di batas yang paling alami.
 * Urutan prioritas: judul markdown → paragraf → kalimat.
 */
function splitIntoBlocks(text: string): string[] {
  // Judul markdown memulai bagian baru. Dipertahankan menempel pada isinya
  // supaya potongan tidak pernah berupa judul telanjang tanpa penjelasan.
  const bySection = text.split(/\n(?=#{1,6}\s)/);

  const blocks: string[] = [];
  for (const section of bySection) {
    const rawParagraphs = section.split(/\n\s*\n/);

    // Judul yang berdiri sendiri digabung dengan paragraf sesudahnya. Kalau
    // dibiarkan, judul bisa tersangkut di ekor potongan sebelumnya — terpisah
    // dari isi yang dijudulinya. Potongan yang berakhir dengan "## Ongkir" lalu
    // tidak menjelaskan apa-apa cuma jadi derau, dan isinya kehilangan penanda.
    const paragraphs: string[] = [];
    for (const p of rawParagraphs) {
      const t = p.trim();
      if (!t) continue;
      const isHeadingOnly = /^#{1,6}\s+\S.*$/.test(t) && !t.includes('\n');
      if (isHeadingOnly && paragraphs.length >= 0) {
        paragraphs.push(t);
        continue;
      }
      const prev = paragraphs[paragraphs.length - 1];
      if (prev && /^#{1,6}\s+\S.*$/.test(prev) && !prev.includes('\n')) {
        paragraphs[paragraphs.length - 1] = `${prev}\n\n${t}`;
      } else {
        paragraphs.push(t);
      }
    }

    for (const para of paragraphs) {
      const trimmed = para.trim();
      if (!trimmed) continue;

      if (countWords(trimmed) <= CHUNK_TARGET_WORDS) {
        blocks.push(trimmed);
        continue;
      }

      // Paragraf raksasa (lazim pada hasil OCR yang tanpa baris kosong):
      // dipecah per kalimat supaya tidak ada potongan yang terbelah di
      // tengah-tengah pengertian.
      const sentences = trimmed.split(/(?<=[.!?])\s+/);
      let buf = '';
      for (const s of sentences) {
        if (buf && countWords(buf) + countWords(s) > CHUNK_TARGET_WORDS) {
          blocks.push(buf.trim());
          buf = '';
        }
        buf += (buf ? ' ' : '') + s;
      }
      if (buf.trim()) blocks.push(buf.trim());
    }
  }
  return blocks;
}

export interface Chunk {
  /** Isi potongan, SUDAH termasuk judul dokumen di barisnya sendiri. */
  text: string;
  index: number;
  total: number;
}

/**
 * Pecah satu dokumen jadi potongan siap-embed.
 *
 * Dokumen pendek tetap menghasilkan satu potongan — jadi perilaku untuk catatan
 * kecil persis sama seperti sebelum ada pemecahan, tidak ada yang berubah.
 */
export function chunkDocument(title: string, body: string): Chunk[] {
  const clean = body.trim();
  const head = title.trim();

  const withTitle = (piece: string) => (head ? `${head}\n\n${piece}` : piece);

  if (!clean) return [];
  if (countWords(clean) <= CHUNK_MIN_WORDS) {
    return [{ text: withTitle(clean), index: 0, total: 1 }];
  }

  const blocks = splitIntoBlocks(clean);
  const pieces: string[] = [];
  let buf = '';

  for (const block of blocks) {
    const wouldBe = countWords(buf) + countWords(block);
    if (buf && wouldBe > CHUNK_TARGET_WORDS) {
      pieces.push(buf.trim());
      // Ekor potongan sebelumnya dibawa ke potongan berikutnya.
      buf = CHUNK_OVERLAP_WORDS > 0 ? lastWords(buf, CHUNK_OVERLAP_WORDS) : '';
    }
    buf += (buf ? '\n\n' : '') + block;
  }
  if (buf.trim()) pieces.push(buf.trim());

  // Potongan terakhir yang terlalu kerdil digabung ke sebelumnya. Serpihan
  // sependek itu nyaris selalu jadi derau di hasil pencarian.
  if (pieces.length > 1) {
    const last = pieces[pieces.length - 1]!;
    if (countWords(last) < CHUNK_MIN_WORDS / 2) {
      pieces[pieces.length - 2] += '\n\n' + last;
      pieces.pop();
    }
  }

  return pieces.map((p, i) => ({
    text: withTitle(p),
    index: i,
    total: pieces.length,
  }));
}

// ──────────────────────────────────────────────────────────────────────────────
// SATU CARA MENGHITUNG BARIS — Fase 79
//
// Ambang `HL_BUFFER_MIN_MESSAGES` diperiksa di DUA tempat: `flushBuffer()` di
// `human-learning.service.ts` sebelum buffer dikirim, dan lagi di
// `shadow-mining.worker.ts` sesudah buffer diterima. Sampai fase ini keduanya
// memakai NILAI AMBANG yang sama tapi CARA MENGHITUNG yang berbeda:
//
//   flushBuffer : lines.length                                  ← panjang array Redis
//   worker      : teks.split('\n').filter(l => l.trim()).length ← baris berisi saja
//
// Selama tiap baris buffer selalu berawalan `[CS] `/`[BUYER] `, keduanya kebetulan
// sama. "Kebetulan sama" bukan jaminan — cukup satu pesan yang isinya spasi, atau
// satu perubahan format awalan, dan kedua sisi mulai berselisih. Arah selisihnya
// yang berbahaya: pengirim melihat CUKUP, penerima melihat KURANG, lalu menolak —
// padahal `flushBuffer` sudah menghapus buffernya dari Redis. Percakapannya lenyap.
//
// Itu BUKAN hipotesis. Bentuk persis ini sudah terjadi (Fase 69→71), waktu itu
// karena nilai ambangnya yang beda, bukan cara hitungnya. Log 30 Juli
// merekamnya: 6 buffer di-flush lalu ditolak worker dengan `(min: 4)` — hilang
// semua. Fase 71 menyamakan NILAI-nya; fase ini menyamakan CARA-nya, supaya
// tidak ada versi ketiga dari kesalahan yang sama.
//
// Dipakai bersama oleh pengirim dan penerima. Kalau suatu hari aturannya berubah,
// yang berubah satu tempat — dan dua sisi tidak mungkin lagi berselisih.
// ──────────────────────────────────────────────────────────────────────────────

/** Jumlah baris yang benar-benar berisi (baris kosong & spasi tidak dihitung). */
export function hitungBarisBerisi(teks: string): number {
  return teks.split('\n').filter((l) => l.trim()).length;
}
