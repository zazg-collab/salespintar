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
            print(f'FAIL {relpath}: pola ditemukan {n}x (harus 1):\n---\n{old[:200]}\n---')
            sys.exit(1)
        src = src.replace(old, new)
    with io.open(path, 'w', encoding='utf-8') as f:
        f.write(src)
    print(f'OK   {relpath} ({len(pairs)} substitusi)')


patch('backend/src/queues/question-mining.worker.ts', [

# ── 1. Konstanta + pengatur laju + pemecah potongan ─────────────────────────
(
"""/** Batas aman satu panggilan — ekspor chat bisa sangat panjang. */
const MAX_CHARS_PER_CALL = 12000;

async function extractQuestions(customerLines: string[]): Promise<ExtractedQuestion[]> {
  const joined = customerLines.join('\\n').slice(0, MAX_CHARS_PER_CALL);
  if (joined.trim().length < 20) return [];

  const resp = await groq.chat.completions.create({
    model: env.GROQ_MODEL, // 8B sudah cukup: tugasnya memungut & merapikan, bukan menalar
    max_tokens: 1500,""",
"""// ──────────────────────────────────────────────────────────────────────────────
// PEMBATASAN LAJU GROQ
//
// Groq tier gratis membatasi 6.000 token PER MENIT untuk llama-3.1-8b-instant —
// dan itu batas gabungan input + output untuk seluruh organisasi, bukan per
// permintaan. Versi pertama fitur ini mengirim satu file utuh (12.000 karakter)
// dalam sekali panggil dan langsung ditolak 413: satu permintaan saja sudah
// melebihi jatah semenit penuh.
//
// Dua hal yang memperbaikinya, dan keduanya perlu:
//   1. Potongan diperkecil, supaya satu permintaan muat.
//   2. Jarak antar-permintaan dijaga, supaya sepuluh potongan kecil tidak
//      menghabiskan jatah semenit dalam lima detik.
//
// Kalau Angga naik ke tier berbayar, cukup kecilkan MIN_GAP_MS — sisanya ikut.
// ──────────────────────────────────────────────────────────────────────────────

/** ~700 token untuk teks Indonesia. Ditambah prompt sistem (~450) dan keluaran
 *  (maks 800), satu panggilan berada di sekitar 2.000 token — muat di jatah. */
const MAX_CHARS_PER_CALL = 2500;

/** Keluaran dibatasi karena ikut dihitung ke jatah token per menit. */
const MAX_OUTPUT_TOKENS = 800;

/** Jarak minimum antar-panggilan Groq: ~3 panggilan per menit. */
const MIN_GAP_MS = 21_000;

/** Pengaman supaya satu file raksasa tidak menyandera antrean berjam-jam. */
const MAX_CHUNKS_PER_FILE = 20;

/** Kapan panggilan Groq terakhir dilakukan. Berada di lingkup modul, jadi berlaku
 *  untuk seluruh job di proses ini — sah karena worker ini concurrency 1. */
let lastGroqCallAt = 0;

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

async function waitForSlot(): Promise<void> {
  const elapsed = Date.now() - lastGroqCallAt;
  if (elapsed < MIN_GAP_MS) {
    const wait = MIN_GAP_MS - elapsed;
    logger.debug(`[QuestionMiner] Menunggu ${Math.round(wait / 1000)} detik demi jatah token Groq`);
    await sleep(wait);
  }
  lastGroqCallAt = Date.now();
}

function isRateLimit(err: unknown): boolean {
  const anyErr = err as { status?: number; message?: string };
  if (anyErr?.status === 429 || anyErr?.status === 413) return true;
  return /rate_limit|too large|tokens per minute/i.test(anyErr?.message ?? '');
}

/** Pecah baris pelanggan jadi potongan yang muat di satu panggilan. Baris tunggal
 *  yang kelewat panjang dipotong keras — lebih baik kehilangan ekornya daripada
 *  seluruh potongan ditolak. */
function chunkLines(lines: string[], maxChars: number): string[][] {
  const chunks: string[][] = [];
  let current: string[] = [];
  let size = 0;
  for (const raw of lines) {
    const line = raw.length > maxChars ? raw.slice(0, maxChars) : raw;
    if (size + line.length + 1 > maxChars && current.length > 0) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(line);
    size += line.length + 1;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

async function extractQuestionsFromChunk(lines: string[]): Promise<ExtractedQuestion[]> {
  const joined = lines.join('\\n');
  if (joined.trim().length < 20) return [];

  await waitForSlot();

  const resp = await groq.chat.completions.create({
    model: env.GROQ_MODEL, // 8B sudah cukup: tugasnya memungut & merapikan, bukan menalar
    max_tokens: MAX_OUTPUT_TOKENS,"""
),

# ── 2. Tutup fungsi chunk + fungsi pembungkus dengan percobaan ulang ────────
(
"""  } catch (err) {
    logger.warn(`[QuestionMiner] JSON parse error: ${err}`);
    return [];
  }
}""",
"""  } catch (err) {
    logger.warn(`[QuestionMiner] JSON parse error: ${err}`);
    return [];
  }
}

/**
 * Tambang seluruh file, potongan demi potongan.
 *
 * Kena batas laju TIDAK dianggap kegagalan — cuma disuruh menunggu lalu diulang.
 * Membiarkannya jadi galat akan menandai seluruh sesi gagal padahal yang terjadi
 * cuma antre.
 */
async function extractQuestions(customerLines: string[], filename: string): Promise<ExtractedQuestion[]> {
  let chunks = chunkLines(customerLines, MAX_CHARS_PER_CALL);

  if (chunks.length > MAX_CHUNKS_PER_FILE) {
    // Aturan rumah: pembatasan cakupan tidak boleh diam-diam.
    logger.warn(
      `[QuestionMiner] ${filename} terlalu panjang: ${chunks.length} potongan, ` +
      `dipangkas ke ${MAX_CHUNKS_PER_FILE}. Sisa percakapan tidak ditambang.`,
    );
    chunks = chunks.slice(0, MAX_CHUNKS_PER_FILE);
  }

  const seen = new Set<string>();
  const all: ExtractedQuestion[] = [];

  for (let i = 0; i < chunks.length; i++) {
    let attempt = 0;
    while (true) {
      try {
        const found = await extractQuestionsFromChunk(chunks[i]!);
        for (const q of found) {
          // Dedup murah di dalam satu file, supaya tidak menghitung embedding
          // untuk pertanyaan yang sama berulang kali.
          if (seen.has(q.question)) continue;
          seen.add(q.question);
          all.push(q);
        }
        break;
      } catch (err) {
        if (isRateLimit(err) && attempt < 4) {
          attempt++;
          const wait = MIN_GAP_MS * attempt;
          logger.warn(
            `[QuestionMiner] ${filename} potongan ${i + 1}/${chunks.length}: jatah token Groq habis, ` +
            `menunggu ${Math.round(wait / 1000)} detik (percobaan ${attempt}/4)`,
          );
          await sleep(wait);
          continue;
        }
        throw err;
      }
    }
    logger.info(`[QuestionMiner] ${filename}: potongan ${i + 1}/${chunks.length} selesai (${all.length} pertanyaan sejauh ini)`);
  }

  return all;
}"""
),

# ── 3. Pemanggilan di handler ──────────────────────────────────────────────
(
"    const questions = await extractQuestions(customerLines);",
"    const questions = await extractQuestions(customerLines, filename);"
),

# ── 4. Pesan galat yang bisa dibaca orang ──────────────────────────────────
(
"""    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`[QuestionMiner] ${filename} GAGAL: ${msg}`);
    if (job.attemptsMade >= 1) {
      await bumpProcessed(sessionId);
      await failSession(sessionId, `File ${filename}: ${msg}`);
    }
    throw err;""",
"""    const raw = err instanceof Error ? err.message : String(err);
    logger.error(`[QuestionMiner] ${filename} GAGAL: ${raw}`);

    // Pesan mentah dari Groq berupa JSON panjang yang tidak berarti apa-apa bagi
    // pemilik toko. Diterjemahkan dulu sebelum ditampilkan di layar.
    const friendly = isRateLimit(err)
      ? `File "${filename}": jatah token Groq per menit habis dan tetap habis setelah beberapa kali menunggu. ` +
        `Coba lagi beberapa menit lagi, atau naikkan paket Groq kalau chat-nya banyak.`
      : `File "${filename}": ${raw.slice(0, 300)}`;

    if (job.attemptsMade >= 2) {
      await bumpProcessed(sessionId);
      await failSession(sessionId, friendly);
    }
    throw err;"""
),
])


# ── 5. Antrean: percobaan lebih banyak, jeda lebih panjang ──────────────────
patch('backend/src/queues/question-mining.queue.ts', [
(
"""  defaultJobOptions: {
    attempts: 2,
    backoff: { type: 'fixed', delay: 5000 },""",
"""  defaultJobOptions: {
    // Tiga percobaan dengan jeda menaik: kegagalan paling lazim di sini adalah
    // jatah token Groq yang habis sesaat, dan itu sembuh sendiri kalau ditunggu.
    attempts: 3,
    backoff: { type: 'exponential', delay: 30000 },"""
),
])


# ── 6. Worker: concurrency 1, laju diatur di dalam worker ───────────────────
patch('backend/src/queues/index.ts', [
(
"""  // Question Miner: satu job = satu file chat. Concurrency 2 dan dibatasi laju
  // karena tiap job memanggil Groq sekali lalu menghitung embedding sebanyak
  // pertanyaan yang ditemukan — lebih ringan dari Shadow Mining, tapi tetap
  // tidak boleh membanjiri Groq saat ratusan file diunggah sekaligus.
  new Worker('question-mining', handleQuestionMining, {
    connection: redisBull,
    concurrency: 2,
    limiter: { max: 20, duration: 60000 },
  });""",
"""  // Question Miner: satu job = satu file chat, dan satu file bisa berisi banyak
  // potongan. CONCURRENCY WAJIB 1 — pengatur jarak antar-panggilan Groq ada di
  // dalam worker dan bersandar pada satu penghitung waktu bersama; dua job
  // paralel akan saling melewati penghitung itu dan langsung kena batas laju.
  //
  // Tidak ada `limiter` di sini karena pengaturan lajunya sudah di dalam worker,
  // per panggilan Groq — jauh lebih tepat daripada membatasi per job, sebab
  // jumlah panggilan tiap job berbeda-beda tergantung panjang chat-nya.
  new Worker('question-mining', handleQuestionMining, {
    connection: redisBull,
    concurrency: 1,
    // Satu job bisa berjalan lama karena menunggu jatah token; kunci job perlu
    // diperpanjang supaya tidak dianggap mandek lalu dijalankan ulang.
    lockDuration: 120_000,
  });"""
),
])

print('SELESAI')
