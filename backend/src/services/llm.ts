/**
 * llm.ts — SATU PINTU untuk semua panggilan model bahasa.
 *
 * ── Kenapa berkas ini ada ────────────────────────────────────────────────────
 * Sebelum ini ada SEMBILAN titik panggil `groq.chat.completions.create()` yang
 * tersebar di 6 berkas, masing-masing membuat kliennya sendiri
 * (`new Groq({...})` × 6), dan semuanya cuma punya DUA tombol model:
 * `GROQ_MODEL` dan `GROQ_EXTRACTOR_MODEL`. Akibat langsungnya:
 *
 *   1. Lima pekerjaan yang sifatnya sangat berbeda — balasan pelanggan,
 *      validasi Supervisor, penandaan intent, klasifikasi Shadow Mining, dan
 *      penambangan pertanyaan — berbagi SATU tombol. Menaikkan kualitas balasan
 *      otomatis menaikkan biaya klasifikasi spam. Tidak ada cara memisahkannya.
 *   2. Objek `usage` yang Groq kembalikan GRATIS di setiap respons dibuang di
 *      kesembilan titik. Jadi tidak ada satu pun angka token yang pernah
 *      tercatat, dan setiap pembicaraan soal biaya cuma bisa jadi taksiran.
 *   3. Model yang sebenarnya jalan tidak bisa dijawab dengan cepat. Ada dua
 *      berkas `.env` di repo ini — akar dan `backend/` — dan hanya
 *      `backend/.env` yang dimuat (lihat `config/env.ts:5`). Yang di akar berisi
 *      nilai lain dan tidak pernah terpakai. Itu sudah sekali menyesatkan
 *      analisis, 30 Juli 2026.
 *
 * ── Yang berkas ini TIDAK lakukan ────────────────────────────────────────────
 * Ia TIDAK mengubah perilaku. Setiap `JobConfig` di bawah menyalin PERSIS nilai
 * yang tadinya hardcode di titik panggilnya (max_tokens, temperature,
 * response_format), dan resolusi modelnya mewarisi `GROQ_MODEL` /
 * `GROQ_EXTRACTOR_MODEL` kalau tombol per-pekerjaan dibiarkan kosong. Dengan
 * env baru kosong, hasilnya identik dengan sebelum berkas ini ada. Penggeseran
 * model dilakukan lewat env SETELAH ada angka token nyata — bukan sekarang.
 *
 * Semantik kegagalan di tiap pemanggil juga TIDAK diubah: Supervisor tetap
 * fail-open, `detectIntent` tetap mengembalikan `unknown`, balasan tetap turun
 * ke jalur cadangan. Yang berubah hanya satu hal: kegagalan itu sekarang
 * meninggalkan baris di tabel `llm_calls`, bukan cuma beberapa baris log.
 */

import Groq from 'groq-sdk';
import OpenAI from 'openai';
import { env } from '../config/env';
import { prisma } from '../config/prisma';
import { redisCache } from '../config/redis';
import { logger } from '../utils/logger';

// ── Klien: SATU-SATUNYA di seluruh repo ──────────────────────────────────────
//
// Groq tetap memakai SDK-nya sendiri — TIDAK dipindah ke SDK `openai` walau
// keduanya sebentuk. Alasannya bukan selera: memindahkannya berarti mengubah
// jalur yang sedang melayani pelanggan demi kerapian, dan itu risiko tanpa
// imbalan. Layanan baru memakai SDK `openai` karena Google dan OpenRouter
// dua-duanya menyediakan endpoint yang kompatibel dengannya.
const groq = new Groq({ apiKey: env.GROQ_API_KEY });

const BASE_URL: Partial<Record<Provider, string>> = {
  google: 'https://generativelanguage.googleapis.com/v1beta/openai/',
  openrouter: 'https://openrouter.ai/api/v1',
  gutstore: 'https://api.gutstore.my.id/v1',
};

function apiKeyFor(provider: Provider): string | undefined {
  if (provider === 'groq') return env.GROQ_API_KEY;
  if (provider === 'google') return env.GOOGLE_API_KEY;
  if (provider === 'openrouter') return env.OPENROUTER_API_KEY;
  if (provider === 'gutstore') return env.GUTSTORE_API_KEY;
  return undefined;
}

// Klien dibuat SEKALI per layanan lalu dipakai ulang. Membuatnya per panggilan
// berarti membuang kumpulan koneksi HTTP-nya tiap kali — itu yang dulu terjadi
// waktu `new Groq({...})` tersebar di enam berkas.
const klienOpenAI = new Map<Provider, OpenAI>();
function klienUntuk(provider: Provider): OpenAI {
  const ada = klienOpenAI.get(provider);
  if (ada) return ada;
  const apiKey = apiKeyFor(provider);
  if (!apiKey) {
    throw new Error(
      `[LLM] Kunci API untuk layanan "${provider}" belum diisi. ` +
      `Setel ${NAMA_ENV_KUNCI[provider]} di backend/.env.`,
    );
  }
  const klien = new OpenAI({ apiKey, baseURL: BASE_URL[provider] });
  klienOpenAI.set(provider, klien);
  return klien;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pekerjaan
//
// Satu job per titik panggil — sengaja sembilan, bukan tujuh. Dengan begitu
// satu baris di `llm_calls` menunjuk tepat ke satu tempat di kode, dan
// pertanyaan "pekerjaan mana yang layak model mahal" bisa dijawab dengan
// GROUP BY, bukan dengan tebakan.
// ─────────────────────────────────────────────────────────────────────────────
export type LlmJob =
  | 'classify'    // lead-profiler.service — AI Lead Profiler & Audit SOP CS (Pilar 1)
  | 'gatekeeper'  // shadow-mining.worker (Lapis 1) — Penyaring Kelayakan Obrolan (Pilar 2)
  | 'extract'     // shadow-mining.worker (Lapis 2) — Ekstraksi Dokumen Pengetahuan / SOP Toko
  | 'miner'       // question-mining.worker — Penambang Pertanyaan Pelanggan (FAQ)
  | 'publish'     // question-miner.routes — Penyusun Dokumen Pustaka SOP
  // ── Legacy jobs (hanya dipertahankan di type agar tidak break fungsi lama) ──
  | 'reply'
  | 'fallback'
  | 'intent'
  | 'supervisor'
  | 'audit'
  | 'vision';

export const ALL_LLM_JOBS: LlmJob[] = [
  'classify',
  'gatekeeper',
  'extract',
  'miner',
  'publish',
];

/**
 * Keterangan tiap pekerjaan untuk halaman Pengaturan Model (Knowledge Base AI & Performa CS).
 */
export const JOB_INFO: Record<LlmJob, {
  label: string;
  pilar?: 'cs' | 'knowledge';
  keterangan: string;
  beratnya: 'ringan' | 'sedang' | 'berat';
  terlihatPelanggan: boolean;
}> = {
  classify: {
    label: 'AI Lead Profiler & Audit SOP CS',
    pilar: 'cs',
    keterangan: 'Membaca percakapan chat CS vs Pembeli untuk menentukan produk yang diminati, skor minat beli, status closing, diagnosa kendala prospek, dan evaluasi kepatuhan SOP closing CS.',
    beratnya: 'ringan', terlihatPelanggan: false,
  },
  gatekeeper: {
    label: 'Penyaring Kelayakan Obrolan (Lapis 1 Auto-Learning)',
    pilar: 'knowledge',
    keterangan: 'Menyaring dan mendeteksi apakah percakapan CS memiliki nilai pengetahuan baru/SOP toko yang layak sebelum diteruskan ke mesin ekstraksi dokumen (Lapis 2).',
    beratnya: 'ringan', terlihatPelanggan: false,
  },
  extract: {
    label: 'Ekstraksi Dokumen SOP (Auto-Learning)',
    pilar: 'knowledge',
    keterangan: 'Mengubah percakapan CS yang sukses closing menjadi draf Dokumen Pengetahuan / SOP Toko. Membutuhkan penalaran mendalam dan batas output panjang.',
    beratnya: 'berat', terlihatPelanggan: false,
  },
  miner: {
    label: 'Penambang Pertanyaan Pelanggan (FAQ)',
    pilar: 'knowledge',
    keterangan: 'Menambang dan memungut pertanyaan-pertanyaan berulang dari pembeli di histori chat untuk dijadikan bahan knowledge base baru.',
    beratnya: 'ringan', terlihatPelanggan: false,
  },
  publish: {
    label: 'Penyusun Dokumen Pustaka SOP',
    pilar: 'knowledge',
    keterangan: 'Merapikan jawaban yang ditulis owner/CS di Human Learning menjadi artikel SOP Pustaka Pengetahuan resmi yang terstruktur.',
    beratnya: 'sedang', terlihatPelanggan: false,
  },
  // Legacy / Standby stubs
  reply: { label: 'Balasan pelanggan (Legacy)', keterangan: 'Legacy bot reply', beratnya: 'berat', terlihatPelanggan: true },
  fallback: { label: 'Balasan cadangan (Legacy)', keterangan: 'Legacy fallback', beratnya: 'sedang', terlihatPelanggan: true },
  intent: { label: 'Penanda intent (Legacy)', keterangan: 'Legacy intent', beratnya: 'ringan', terlihatPelanggan: false },
  supervisor: { label: 'Supervisor (Legacy)', keterangan: 'Legacy supervisor', beratnya: 'sedang', terlihatPelanggan: false },
  vision: { label: 'Pembaca gambar (Legacy)', keterangan: 'Legacy vision', beratnya: 'berat', terlihatPelanggan: false },
  audit: { label: 'Alat audit (Internal)', keterangan: 'Internal audit', beratnya: 'sedang', terlihatPelanggan: false },
};

/**
 * Satu bagian isi pesan. Dipakai HANYA oleh job 'vision'; delapan job lainnya
 * tetap mengirim `content` berupa string biasa dan tidak tersentuh perubahan ini.
 */
export type LlmContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant';
  /**
   * String untuk hampir semua pekerjaan.
   *
   * Array bagian HANYA sah pada peran 'user' — itu batas API-nya, bukan pilihan
   * gaya, dan `complete()` melemparkan galat kalau dilanggar. Melempar di sini
   * lebih baik daripada meneruskannya ke Groq: galat dari kita menyebut peran
   * mana yang salah, galat 400 dari Groq tidak.
   */
  content: string | LlmContentPart[];
}

export interface LlmUsage {
  promptTokens: number;
  completionTokens: number;
  /** Token masukan yang kena cache. Hanya keluarga `gpt-oss` yang melaporkannya. */
  cachedTokens?: number;
  /**
   * Token "berpikir" yang DITAGIH tapi tidak muncul di `completion_tokens`.
   *
   * Ditambahkan Fase 82 sesudah Fase 81 membuktikan Gemini menyembunyikannya:
   *   prompt 30 · completion 23 · total 251  → 198 token tak terhitung
   * Tanpa kolom ini, biaya Gemini terlihat ~10× lebih murah dari kenyataan, dan
   * seluruh dasar keputusan "model mana yang layak" jadi bohong. Dihitung dari
   * `total_tokens − prompt − completion`, jadi ia menangkap token tersembunyi
   * APA PUN — bukan cuma thinking, dan bukan cuma Gemini.
   */
  reasoningTokens?: number;
}

export interface LlmResult {
  text: string;
  provider: string;
  model: string;
  usage: LlmUsage;
  latencyMs: number;
  attempts: number;
}

interface JobConfig {
  maxTokens: number;
  temperature: number;
  /** Paksa keluaran JSON (`response_format: { type: 'json_object' }`). */
  json: boolean;
  /** Jarak minimal antar panggilan untuk job ini, dalam ms. 0 = tanpa gerbang. */
  minGapMs: number;
}

/**
 * Nilai per pekerjaan — SALINAN PERSIS dari yang tadinya hardcode di titik
 * panggilnya. Jangan "dirapikan" tanpa alasan: angka-angka ini punya sejarah.
 * Misalnya `extract` bertemperatur 0.2 dan bermaks 2048 karena keluarannya
 * dokumen Markdown panjang yang harus menuruti delapan aturan; `supervisor`
 * bertemperatur 0 karena tugasnya menghakimi, bukan mengarang.
 */
const JOB_CONFIG: Record<LlmJob, JobConfig> = {
  reply:      { maxTokens: env.GROQ_MAX_TOKENS, temperature: env.GROQ_TEMPERATURE, json: false, minGapMs: 0 },
  fallback:   { maxTokens: env.GROQ_MAX_TOKENS, temperature: env.GROQ_TEMPERATURE, json: false, minGapMs: 0 },
  intent:     { maxTokens: 100,  temperature: 0.3, json: true,  minGapMs: 0 },
  // 700, bukan 200, sejak Fase 110. Supervisor pindah ke `openai/gpt-oss-120b`
  // lewat OpenRouter, dan endpoint itu MENOLAK permintaan mematikan penalaran
  // ("Reasoning is mandatory for this endpoint"). Penalarannya memakai jatah
  // token keluaran yang sama — dengan 200 token, JSON-nya tidak pernah selesai
  // ditulis dan hasilnya `content: null`. Biayanya tetap kecil: model ini 16x
  // lebih murah daripada llama-70b.
  supervisor: { maxTokens: 700,  temperature: 0,   json: true,  minGapMs: 0 },
  classify:   { maxTokens: 1500, temperature: 0,   json: true,  minGapMs: 0 },
  gatekeeper: { maxTokens: 1500, temperature: 0,   json: true,  minGapMs: 0 },
  extract:    { maxTokens: 2048, temperature: 0.2, json: true,  minGapMs: 0 },
  // Satu-satunya job yang tadinya punya pembatas laju sendiri: `waitForSlot()`
  // di question-mining.worker.ts. Nilainya (21 detik ≈ 3 panggilan/menit)
  // ditentukan oleh jatah token per menit Groq, bukan oleh sifat tugasnya.
  miner:      { maxTokens: 800,  temperature: 0,   json: true,  minGapMs: env.LLM_MIN_GAP_MS_MINER },
  publish:    { maxTokens: 3000, temperature: 0.1, json: false, minGapMs: env.LLM_MIN_GAP_MS_PUBLISH },
  audit:      { maxTokens: env.GROQ_MAX_TOKENS, temperature: env.GROQ_TEMPERATURE, json: false, minGapMs: 0 },
  // Keluarannya deskripsi pendek untuk disuntikkan ke jalur balasan, bukan
  // karangan — 600 token cukup untuk bukti transfer terpanjang. Suhu 0,1: yang
  // diminta MEMBACA, dan model yang "kreatif" saat membaca nominal transfer
  // adalah model yang mengarang nominal transfer.
  vision:     { maxTokens: 600,  temperature: 0.1, json: false, minGapMs: 0 },
};

// ─────────────────────────────────────────────────────────────────────────────
// Resolusi model
//
// Bentuk string: "<provider>:<model>", mis. "groq:openai/gpt-oss-120b".
// Tanpa awalan → dianggap `groq:` supaya nilai `.env` lama tetap sah.
//
// Warisannya SENGAJA: kalau tombol per-pekerjaan kosong, ia mengambil
// `GROQ_EXTRACTOR_MODEL` untuk pekerjaan "berat" dan `GROQ_MODEL` untuk sisanya
// — yaitu tepat pembagian yang berlaku sebelum berkas ini ada. Itu yang membuat
// pemasangan lapisan ini netral terhadap perilaku.
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Harga per 1 JUTA token, dalam USD. Diambil dari groq.com/pricing, Juli 2026.
 *
 * SENGAJA sebagian, bukan lengkap: daftar model diambil live dari API Groq
 * (`listAvailableModels()`), dan tabel ini cuma menempelkan harga untuk model
 * yang harganya saya tahu. Model yang tidak ada di sini tetap tampil di dropdown,
 * hanya tanpa label harga — lebih baik begitu daripada menyembunyikan model yang
 * sah atau, lebih buruk, menampilkan harga karangan.
 *
 * ⚠️ Harga BERUBAH. Kalau angka di sini tidak lagi cocok dengan groq.com/pricing,
 * yang salah adalah tabel ini, bukan tagihannya.
 */
/**
 * ⚠️ KUNCINYA SPEC PENUH (`layanan:model`), bukan nama model saja — Fase 82.
 *
 * Sejak ada lebih dari satu layanan, nama model tidak lagi unik: model yang
 * sama bisa ditawarkan Groq dan OpenRouter dengan harga berbeda, dan tabel
 * ber-kunci nama akan diam-diam memakai harga yang salah. Itu bukan galat yang
 * kelihatan — ia cuma membuat angka biaya berbohong.
 */
export const HARGA_MODEL: Record<string, { masuk: number; keluar: number; masukCached?: number }> = {
  'groq:llama-3.1-8b-instant':     { masuk: 0.05,  keluar: 0.08 },
  'groq:openai/gpt-oss-20b':       { masuk: 0.075, keluar: 0.30, masukCached: 0.0375 },
  'groq:openai/gpt-oss-120b':      { masuk: 0.15,  keluar: 0.60, masukCached: 0.075 },
  'groq:openai/gpt-oss-safeguard-20b': { masuk: 0.075, keluar: 0.30, masukCached: 0.0375 },
  'groq:llama-3.3-70b-versatile':  { masuk: 0.59,  keluar: 0.79 },
  'groq:qwen/qwen3.6-27b':         { masuk: 0.60,  keluar: 3.00 },

  // Google AI Studio, tier berbayar (ai.google.dev/pricing, Juli 2026).
  // ⚠️ Angka KELUAR untuk model yang berpikir sudah termasuk token thinking —
  // dan token thinking bisa 10× lebih banyak dari jawabannya (lihat Fase 81).
  // Karena itu `reasoning_effort: 'none'` dipaksa untuk semua panggilan Google
  // di bawah; tanpa itu, biaya nyata jauh di atas taksiran tabel ini.
  'google:gemini-2.5-flash':       { masuk: 0.30,  keluar: 2.50 },
  'google:gemini-3.1-flash-lite':  { masuk: 0.10,  keluar: 0.40 },
  'google:gemini-flash-lite-latest': { masuk: 0.10, keluar: 0.40 },

  // ── OpenRouter (openrouter.ai) — perantara ke belasan penyedia ────────────
  // Harga diambil dari `GET /api/v1/models` 1 Agustus 2026. OpenRouter memilih
  // penyedia hulu sendiri dan mengalihkan otomatis kalau salah satu tumbang,
  // jadi kecepatan bisa berbeda antar panggilan untuk model yang sama.
  //
  // `meta-llama/llama-3.3-70b-instruct` adalah MODEL YANG SAMA PERSIS dengan
  // `groq:llama-3.3-70b-versatile` — "versatile" itu nama layanan Groq untuk
  // Llama 3.3 70B Instruct, bukan varian model yang berbeda. Jadi memindahkan
  // pekerjaan ke sini mengganti PINTUNYA, bukan otaknya: tidak ada risiko mutu
  // yang perlu diukur ulang, dan tidak ada batas token harian.
  'openrouter:meta-llama/llama-3.3-70b-instruct': { masuk: 0.13,  keluar: 0.40 },
  'openrouter:openai/gpt-oss-120b':               { masuk: 0.037, keluar: 0.17 },
  'openrouter:qwen/qwen3-235b-a22b-2507':         { masuk: 0.09,  keluar: 0.55 },
  'openrouter:deepseek/deepseek-v4-flash-0731':   { masuk: 0.14,  keluar: 0.28 },
  'openrouter:deepseek/deepseek-chat':            { masuk: 0.14,  keluar: 0.28 },
  'openrouter:deepseek/deepseek-r1':              { masuk: 0.55,  keluar: 2.19 },

  // ── gutstore (api.gutstore.my.id) — penjual ulang, tarif FLAT per token ────
  // Tarifnya dipasang dalam RUPIAH per 1 juta token GABUNGAN (masuk + keluar),
  // jadi `masuk` dan `keluar` sengaja diisi angka yang SAMA. Dikonversi ke USD
  // memakai kurs Rp18.085/USD (1 Agustus 2026) supaya sebanding dengan baris
  // lain di tabel ini — kalau kursnya bergeser jauh, angka di sini ikut geser.
  //
  // ⚠️ DIUKUR 1 Agustus 2026, dan angka tabel ini MENGECILKAN biaya sebenarnya:
  // layanan itu menambahkan ~2.000 token ke SETIAP permintaan, sekecil apa pun
  // isinya (prompt 28 karakter dilaporkan `prompt_tokens: 2010`). Untuk pekerjaan
  // kecil seperti `intent` (~150 token) itu berarti tagihannya belasan kali lipat
  // dari yang diperkirakan. Tabel ini tidak bisa menyatakan biaya tetap per
  // panggilan, jadi selisih itu HARUS diingat saat membaca angka biaya.
  'gutstore:claude-haiku-4.5':     { masuk: 0.0166, keluar: 0.0166 },
  'gutstore:claude-sonnet-4.5':    { masuk: 0.0194, keluar: 0.0194 },
  'gutstore:deepseek-3.2':         { masuk: 0.0166, keluar: 0.0166 },
  'gutstore:gemini-3.5-flash':     { masuk: 0.0221, keluar: 0.0221 },
  'gutstore:minimax-m2.5':         { masuk: 0.0194, keluar: 0.0194 },
  'gutstore:gpt-5.5':              { masuk: 0.0332, keluar: 0.0332 },
};

export const SUPPORTED_PROVIDERS = ['groq', 'google', 'openrouter', 'gutstore'] as const;
export type Provider = (typeof SUPPORTED_PROVIDERS)[number];

/**
 * Nama variabel env untuk tiap layanan — SATU definisi, dipakai oleh pesan galat
 * `klienUntuk()` DAN oleh `validateLlmConfig()`.
 *
 * Sebelumnya dua tempat itu punya daftarnya sendiri, dan yang di `klienUntuk()`
 * berupa ternary dua cabang: layanan apa pun selain `google` disuruh menyetel
 * `OPENROUTER_API_KEY`. Begitu ada layanan ketiga, pesan galatnya menyesatkan —
 * menyuruh mengisi kunci yang salah. `Record<Provider, string>` membuat TypeScript
 * menolak kompilasi kalau ada layanan baru yang lupa didaftarkan di sini.
 */
/**
 * Layanan yang harus dikirimi `reasoning_effort: 'none'`.
 *
 * Bukan daftar "model yang berpikir" melainkan daftar LAYANAN yang menyajikan
 * model berpikir lewat endpoint OpenAI-compat — karena di titik ini yang
 * diketahui pasti cuma nama layanannya, dan menebak dari nama model berarti
 * memelihara daftar nama model selamanya.
 */
const PROVIDER_TANPA_BERPIKIR = new Set<Provider>(['google', 'gutstore']);

const NAMA_ENV_KUNCI: Record<Provider, string> = {
  groq: 'GROQ_API_KEY',
  google: 'GOOGLE_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  gutstore: 'GUTSTORE_API_KEY',
};

/**
 * Bawaan job 'vision'. TIDAK mewarisi `GROQ_MODEL` seperti job lain.
 *
 * Warisan itu benar untuk pekerjaan teks — itulah yang membuat Fase 59 netral
 * terhadap perilaku. Untuk gambar ia justru jebakan: `GROQ_MODEL` sekarang
 * `llama-3.3-70b-versatile`, yang TIDAK BISA melihat gambar, dan kegagalannya
 * baru muncul saat pelanggan sungguhan mengirim foto — bukan saat menyala.
 * Bawaan yang salah lebih buruk daripada tidak ada bawaan.
 */
const BAWAAN_VISION = 'groq:qwen/qwen3.6-27b';

/**
 * Model yang diketahui bisa menerima gambar (dokumentasi Groq, Juli 2026:
 * `qwen/qwen3.6-27b` satu-satunya).
 *
 * Dipakai untuk MEMPERINGATKAN, bukan MENOLAK. Daftar ini pasti akan basi —
 * Groq menambah model tanpa memberi tahu berkas ini — dan menolak berdasarkan
 * daftar basi berarti memblokir model baru yang lebih baik pada hari ia terbit.
 * Peringatan yang salah cuma berisik; penolakan yang salah mematikan fitur.
 */
export const MODEL_BISA_GAMBAR: ReadonlySet<string> = new Set([
  'groq:qwen/qwen3.6-27b',
  // Diverifikasi sungguhan di Fase 81 (PNG 1×1 merah dikenali "Merah"), bukan
  // dibaca dari dokumentasi.
  'google:gemini-2.5-flash',
  'google:gemini-3.1-flash-lite',
  'google:gemini-flash-lite-latest',
  'google:gemini-3.5-flash',
]);

export function modelMungkinBisaGambar(spec: string): boolean {
  // Kuncinya spec penuh sejak Fase 82. Spec tanpa awalan layanan dianggap groq,
  // sama seperti aturan `parseSpec()` — supaya nilai `.env` lama tetap terbaca.
  return MODEL_BISA_GAMBAR.has(spec.includes(':') ? spec : `groq:${spec}`);
}

/** Pekerjaan yang sebelum ini memakai `GROQ_EXTRACTOR_MODEL`. */
const INHERITS_EXTRACTOR: ReadonlySet<LlmJob> = new Set<LlmJob>(['extract', 'publish']);

function envKnob(job: LlmJob): string | undefined {
  const map: Record<LlmJob, string | undefined> = {
    reply:      env.LLM_MODEL_REPLY,
    fallback:   env.LLM_MODEL_FALLBACK,
    intent:     env.LLM_MODEL_INTENT,
    supervisor: env.LLM_MODEL_SUPERVISOR,
    classify:   env.LLM_MODEL_CLASSIFY,
    gatekeeper: env.LLM_MODEL_GATEKEEPER || env.LLM_MODEL_MINER || 'groq:llama-3.1-8b-instant',
    extract:    env.LLM_MODEL_EXTRACT,
    miner:      env.LLM_MODEL_MINER,
    publish:    env.LLM_MODEL_PUBLISH,
    audit:      env.LLM_MODEL_AUDIT,
    vision:     env.LLM_MODEL_VISION,
  };
  const v = map[job]?.trim();
  return v ? v : undefined;
}

export function resolveModelSpec(job: LlmJob): string {
  const explicit = envKnob(job);
  if (explicit) return explicit.includes(':') ? explicit : `groq:${explicit}`;

  // Warisan. `fallback` punya tombol lamanya sendiri.
  if (job === 'vision') return BAWAAN_VISION;   // sengaja TIDAK mewarisi GROQ_MODEL
  if (job === 'fallback') return `groq:${env.GROQ_FALLBACK_MODEL}`;
  if (INHERITS_EXTRACTOR.has(job)) return `groq:${env.GROQ_EXTRACTOR_MODEL}`;
  return `groq:${env.GROQ_MODEL}`;
}

function parseSpec(spec: string): { provider: Provider; model: string } {
  const idx = spec.indexOf(':');
  const provider = idx === -1 ? 'groq' : spec.slice(0, idx).trim();
  const model = idx === -1 ? spec.trim() : spec.slice(idx + 1).trim();
  if (!model) throw new Error(`Nama model kosong pada "${spec}"`);
  if (!(SUPPORTED_PROVIDERS as readonly string[]).includes(provider)) {
    throw new Error(
      `Provider "${provider}" belum didukung (spec: "${spec}"). ` +
      `Yang tersedia: ${SUPPORTED_PROVIDERS.join(', ')}.`,
    );
  }
  return { provider: provider as Provider, model };
}

// ─────────────────────────────────────────────────────────────────────────────
// Override per-business (halaman Pengaturan Model)
//
// Disimpan di `Business.aiConfig.llmModels` — kolom Json yang SUDAH ADA dan
// sebelum ini cuma diisi `{}` saat pendaftaran, jadi tidak perlu migrasi.
// Polanya mengikuti `Business.shadowMiningMode`: pengaturan per-tenant di baris
// bisnis, bukan di env dan bukan di variabel proses.
//
// Catatan yang penting untuk ditalar: alasan `shadowMiningMode` dulu dipindah ke
// DB (lihat auto-learning.routes.ts) adalah karena memutasi objek `env` saat
// runtime itu hilang saat restart, cuma berlaku di satu instance, DAN bocor
// lintas tenant. Tiga masalah yang sama akan muncul kalau override model
// disimpan di memori proses. Jadi: DB, dengan cache pendek.
// ─────────────────────────────────────────────────────────────────────────────
const TTL_CACHE_OVERRIDE_SEC = 60;
const KUNCI_CACHE_OVERRIDE = (businessId: string) => `llm:models:${businessId}`;

export type OverrideModel = Partial<Record<LlmJob, string>>;

function bersihkanOverride(mentah: unknown): OverrideModel {
  const hasil: OverrideModel = {};
  if (!mentah || typeof mentah !== 'object') return hasil;
  for (const job of ALL_LLM_JOBS) {
    const v = (mentah as Record<string, unknown>)[job];
    if (typeof v === 'string' && v.trim()) hasil[job] = v.trim();
  }
  return hasil;
}

/**
 * Override model untuk satu bisnis. Dibaca dari cache Redis kalau ada.
 *
 * Ini duduk di JALUR PANAS — tiap balasan pelanggan melewatinya. Karena itu
 * kegagalan apa pun (Redis mati, Postgres tersendat, `aiConfig` bentuknya aneh)
 * mengembalikan objek kosong dan membiarkan warisan env yang berlaku. Pengaturan
 * yang tidak terbaca TIDAK BOLEH menghentikan bot melayani pelanggan.
 */
export async function bacaOverrideBisnis(businessId: string): Promise<OverrideModel> {
  try {
    const cached = await redisCache.get(KUNCI_CACHE_OVERRIDE(businessId));
    if (cached !== null) return bersihkanOverride(JSON.parse(cached));
  } catch { /* cache tidak terbaca — lanjut ke DB */ }

  try {
    const b = await prisma.business.findUnique({
      where: { id: businessId },
      select: { aiConfig: true },
    });
    const cfg = (b?.aiConfig ?? {}) as Record<string, unknown>;
    const override = bersihkanOverride(cfg['llmModels']);
    try {
      await redisCache.set(
        KUNCI_CACHE_OVERRIDE(businessId),
        JSON.stringify(override),
        'EX', TTL_CACHE_OVERRIDE_SEC,
      );
    } catch { /* gagal menyimpan cache bukan alasan gagal melayani */ }
    return override;
  } catch (err) {
    logger.warn(`[LLM] Override model bisnis ${businessId} tidak terbaca, pakai env: ${err}`);
    return {};
  }
}

/** Kosongkan cache override — dipanggil segera setelah Simpan di UI. */
export async function lupakanOverrideBisnis(businessId: string): Promise<void> {
  try { await redisCache.del(KUNCI_CACHE_OVERRIDE(businessId)); } catch { /* tidak fatal */ }
}

/** Dari mana nilai yang berlaku itu datang — dipakai UI untuk menandai barisnya. */
export type SumberModel = 'bisnis' | 'env' | 'warisan';

/**
 * Model yang BERLAKU untuk satu pekerjaan, lengkap dengan asalnya.
 * Urutan menang: override bisnis → env per-pekerjaan → warisan GROQ_*.
 */
export async function resolveModelBerlaku(
  job: LlmJob,
  businessId?: string | null,
): Promise<{ spec: string; sumber: SumberModel }> {
  if (businessId) {
    const override = await bacaOverrideBisnis(businessId);
    const dariBisnis = override[job];
    if (dariBisnis) {
      return { spec: dariBisnis.includes(':') ? dariBisnis : `groq:${dariBisnis}`, sumber: 'bisnis' };
    }
  }
  const dariEnv = envKnob(job);
  if (dariEnv) {
    return { spec: dariEnv.includes(':') ? dariEnv : `groq:${dariEnv}`, sumber: 'env' };
  }
  return { spec: resolveModelSpec(job), sumber: 'warisan' };
}

// ─────────────────────────────────────────────────────────────────────────────
// Daftar model yang tersedia (untuk dropdown)
// ─────────────────────────────────────────────────────────────────────────────
export interface ModelTersedia {
  /** Nilai untuk disimpan, mis. "groq:openai/gpt-oss-120b". */
  spec: string;
  provider: string;
  id: string;
  /** USD per 1 juta token. `undefined` = harganya tidak ada di tabel. */
  harga?: { masuk: number; keluar: number; masukCached?: number };
  /**
   * Bisa menerima GAMBAR? Ikut dikirim ke halaman Pengaturan supaya dropdown
   * "Pembaca gambar" bisa memperingatkan SAAT MEMILIH, bukan saat pelanggan
   * pertama mengirim foto. Prinsip yang sama dengan perbandingan biaya di
   * Fase 62: pilihan yang punya konsekuensi harus menampilkan konsekuensinya
   * di titik pengambilan keputusan.
   */
  bisaGambar: boolean;
}

const KUNCI_CACHE_DAFTAR = 'llm:daftar-model:groq';
const TTL_CACHE_DAFTAR_SEC = 3600;

/**
 * Daftar model yang benar-benar tersedia, diambil dari API Groq.
 *
 * Diambil live, bukan dikurasi di kode, karena daftar model berubah tanpa
 * pemberitahuan: `mixtral-8x7b-32768` yang masih tertulis di `.env` repo ini
 * sudah dipensiunkan, dan `Gemini 1.5` hilang dalam hitungan bulan. Daftar
 * kurasi akan salah, cuma soal kapan.
 *
 * Harga ditempelkan dari `HARGA_MODEL` untuk yang diketahui. Model yang tidak ada
 * di tabel harga tetap muncul — tanpa label harga. Lebih baik begitu daripada
 * menyembunyikan model yang sah, atau menampilkan harga karangan.
 */
/**
 * Ambil daftar id model dari satu layanan.
 *
 * ⚠️ Untuk Google, daftar dari API TIDAK BISA dipercaya apa adanya. Fase 81
 * membuktikannya: `/models` mengembalikan 42 model, tapi `gemini-2.5-flash-lite`
 * menjawab **404 "no longer available to new users"** dan seluruh keluarga `pro`
 * menjawab **429** karena tier gratis tidak punya jatah untuknya. Menyalin
 * daftar itu ke dropdown berarti Angga bisa memilih model yang pasti gagal —
 * dan gagalnya baru terlihat saat pelanggan sudah menunggu jawaban.
 *
 * Jadi Google disaring ke yang SUDAH DIUJI hidup. Daftar ini akan basi, dan itu
 * disengaja: lebih baik ketinggalan model baru (yang bisa ditambahkan lewat
 * `LLM_MODEL_*` di `.env` kapan pun) daripada menawarkan model yang mati.
 */
const MODEL_GOOGLE_TERUJI: readonly string[] = [
  'gemini-3.5-flash',
  'gemini-3.1-flash-lite',
  'gemini-3-flash-preview',
  'gemini-2.5-flash',
  'gemini-flash-latest',
  'gemini-flash-lite-latest',
];

async function ambilIdModel(provider: Provider): Promise<string[]> {
  if (provider === 'groq') {
    const resp = await groq.models.list();
    return (resp.data ?? [])
      .map((m) => (m as { id?: string }).id)
      .filter((id): id is string => !!id)
      // Model non-teks (transkripsi/TTS) tidak berguna untuk pekerjaan mana pun
      // di sistem ini — disaring supaya dropdown tidak menyesatkan.
      .filter((id) => !/whisper|tts|guard|playai/i.test(id));
  }

  if (provider === 'google') {
    const resp = await klienUntuk('google').models.list();
    const adaDiAPI = new Set(
      (resp.data ?? [])
        .map((m) => String((m as { id?: string }).id ?? '').replace(/^models\//, ''))
        .filter(Boolean),
    );
    // Perpotongan: harus ada di API DAN sudah diuji hidup.
    return MODEL_GOOGLE_TERUJI.filter((id) => adaDiAPI.has(id));
  }

  if (provider === 'openrouter' || provider === 'gutstore') {
    // Tidak diambil live. OpenRouter mengembalikan ratusan model dari puluhan
    // penyedia — sebagian besar TIDAK dilayani lewat `OPENROUTER_PROVIDER_ORDER`
    // yang dipatok ke Groq (lihat Fase 102/103), jadi menuangkannya mentah ke
    // dropdown akan menawarkan model yang pasti gagal. `gutstore` malah tidak
    // punya endpoint daftar model sama sekali.
    //
    // Sumbernya `HARGA_MODEL`: tiap entri di situ sudah pernah dipakai/diuji
    // (harganya diketahui karena sudah ditagih atau diukur), jadi memakainya
    // sebagai daftar dropdown berarti hanya menawarkan model yang terbukti
    // bisa dipanggil lewat layanan ini — sama seperti `MODEL_GOOGLE_TERUJI`,
    // cuma sumbernya tabel harga, bukan array terpisah yang gampang basi.
    const awalan = `${provider}:`;
    return Object.keys(HARGA_MODEL)
      .filter((spec) => spec.startsWith(awalan))
      .map((spec) => spec.slice(awalan.length));
  }

  return [];
}

export async function listAvailableModels(): Promise<ModelTersedia[]> {
  try {
    const cached = await redisCache.get(KUNCI_CACHE_DAFTAR);
    if (cached) return JSON.parse(cached) as ModelTersedia[];
  } catch { /* lanjut ambil dari API */ }

  const daftar: ModelTersedia[] = [];
  try {
    // ── Satu pengambil per layanan — Fase 82 ─────────────────────────────────
    // Dulu badan fungsi ini memanggil `groq.models.list()` langsung, jadi
    // menambah layanan berarti membongkarnya. Sekarang tiap layanan punya
    // pengambilnya sendiri, dan layanan yang KUNCINYA BELUM DIISI dilewati —
    // bukan menggagalkan seluruh daftar.
    for (const provider of SUPPORTED_PROVIDERS) {
      if (!apiKeyFor(provider)) continue;
      try {
        for (const id of await ambilIdModel(provider)) {
          const spec = `${provider}:${id}`;
          const harga = HARGA_MODEL[spec];
          daftar.push({
            spec, provider, id,
            bisaGambar: MODEL_BISA_GAMBAR.has(spec),
            ...(harga ? { harga } : {}),
          });
        }
      } catch (err) {
        logger.warn(`[LLM] Daftar model layanan "${provider}" tidak bisa diambil: ${err}`);
      }
    }
    // Yang harganya diketahui ditaruh dulu, diurut dari termurah — supaya pilihan
    // hemat berada di atas, bukan tenggelam di antara model tanpa keterangan.
    daftar.sort((a, b) => {
      if (a.harga && b.harga) return a.harga.masuk - b.harga.masuk || a.harga.keluar - b.harga.keluar;
      if (a.harga) return -1;
      if (b.harga) return 1;
      return a.id.localeCompare(b.id);
    });
    try {
      await redisCache.set(KUNCI_CACHE_DAFTAR, JSON.stringify(daftar), 'EX', TTL_CACHE_DAFTAR_SEC);
    } catch { /* tidak fatal */ }
  } catch (err) {
    logger.warn(`[LLM] Daftar model tidak bisa diambil dari Groq: ${err}`);
    // Cadangan: model yang harganya kita tahu. Dropdown tetap bisa dipakai walau
    // API Groq sedang tidak bisa dihubungi.
    // Kunci HARGA_MODEL sudah berupa spec penuh sejak Fase 82, jadi jangan
    // ditambahi awalan lagi — itu akan menghasilkan `groq:groq:…`.
    for (const [spec, harga] of Object.entries(HARGA_MODEL)) {
      const idx = spec.indexOf(':');
      const provider = spec.slice(0, idx) as Provider;
      if (!apiKeyFor(provider)) continue;
      daftar.push({
        spec, provider, id: spec.slice(idx + 1), harga,
        bisaGambar: MODEL_BISA_GAMBAR.has(spec),
      });
    }
  }
  return daftar;
}

/**
 * Periksa seluruh konfigurasi model SEKALI saat proses menyala, lalu cetak
 * tabel job→model ke log.
 *
 * Dua alasan ini dipanggil di bootstrap dan bukan dibiarkan gagal saat dipakai:
 * (a) salah tulis nama provider harus meledak sebelum ada pelanggan yang
 *     menunggu jawaban, bukan pada pesan pertama yang masuk;
 * (b) baris log itu menjawab "model apa yang SEBENARNYA jalan" secara permanen.
 *     Pertanyaan itu terdengar sepele sampai ternyata ada dua berkas `.env` di
 *     repo yang sama dan cuma satu yang dimuat.
 */
export function validateLlmConfig(): void {
  const baris: string[] = [];
  const layananDipakai = new Set<Provider>();
  for (const job of ALL_LLM_JOBS) {
    const spec = resolveModelSpec(job);
    const { provider, model } = parseSpec(spec); // melempar kalau tidak sah
    layananDipakai.add(provider);
    const cfg = JOB_CONFIG[job];
    baris.push(
      `  ${job.padEnd(11)} ${provider}:${model}` +
      `  (maks ${cfg.maxTokens} tok, suhu ${cfg.temperature}` +
      `${cfg.json ? ', JSON' : ''}${cfg.minGapMs ? `, jeda ${cfg.minGapMs}ms` : ''})`,
    );
  }
  logger.info(`[LLM] Peta model per pekerjaan:\n${baris.join('\n')}`);

  // ── Kunci API untuk layanan yang BENAR-BENAR dipakai — Fase 82 ─────────────
  // Zod tidak bisa memeriksa ini: ia tahu kuncinya kosong, tapi tidak tahu
  // pekerjaan mana yang dipetakan ke layanan mana. Diperiksa di sini, saat
  // menyala — sebab kunci yang hilang harus meledak sekarang, bukan pada pesan
  // pelanggan pertama yang kebetulan lewat pekerjaan itu. Ini alasan yang sama
  // dengan pemeriksaan 'vision' di bawah.
  const kurangKunci = [...layananDipakai].filter((p) => !apiKeyFor(p));
  if (kurangKunci.length > 0) {
    throw new Error(
      `[LLM] Ada pekerjaan yang dipetakan ke layanan tanpa kunci API: ` +
      kurangKunci.map((p) => `${p} (butuh ${NAMA_ENV_KUNCI[p]})`).join(', ') + '. ' +
      `Isi kuncinya di backend/.env, atau kembalikan pekerjaan itu ke layanan yang kuncinya ada.`,
    );
  }

  const takAktif = SUPPORTED_PROVIDERS.filter((p) => !apiKeyFor(p));
  if (takAktif.length > 0) {
    logger.info(
      `[LLM] Layanan tanpa kunci API (tidak muncul di dropdown): ${takAktif.join(', ')}`,
    );
  }

  // Satu-satunya pemetaan yang bisa SALAH SECARA JENIS, bukan cuma mahal atau
  // lambat: 'vision' ke model yang tidak bisa melihat. Kalau itu terjadi, yang
  // muncul bukan balasan buruk tapi galat 400 saat pelanggan mengirim foto.
  // Diperiksa saat menyala supaya ketahuan sekarang, bukan nanti.
  const specVision = resolveModelSpec('vision');
  if (!modelMungkinBisaGambar(specVision)) {
    logger.warn(
      `[LLM] job 'vision' dipetakan ke "${specVision}", yang TIDAK ADA di daftar model ` +
      `bisa-gambar (${[...MODEL_BISA_GAMBAR].join(', ')}). Kalau model itu memang belum ` +
      `mendukung gambar, setiap foto dari pelanggan akan gagal. Periksa LLM_MODEL_VISION ` +
      `di .env atau pilihan "Pembaca gambar" di halaman Pengaturan Model.`,
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Pembatas laju: gerbang jeda per pekerjaan, di Redis
//
// Menggantikan `waitForSlot()` di question-mining.worker.ts yang memakai
// variabel modul `lastGroqCallAt`. Itu hanya benar karena worker-nya
// `concurrency: 1` — begitu ada dua proses yang memanggil Groq (server Express,
// worker, dan CLI audit semuanya berbagi SATU jatah organisasi), penghitung
// per-proses tidak lagi mewakili apa pun.
//
// Polanya sama dengan kunci ber-TTL di state.service.ts: `SET … PX … NX` sebagai
// gerbang, `PTTL` untuk tahu berapa lama lagi harus menunggu.
// ─────────────────────────────────────────────────────────────────────────────
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Gerbangnya diberi dimensi LAYANAN sejak Fase 82.
 *
 * Jatah dihitung per organisasi PER LAYANAN — kuota Groq dan kuota Google tidak
 * saling memakan. Dengan kunci lama (`llm:gap:{job}`), pekerjaan yang pindah ke
 * Google akan tetap menunggu jeda yang dipasang demi Groq, dan sebaliknya dua
 * pekerjaan di layanan berbeda akan saling menahan tanpa alasan.
 */
async function waitForGap(provider: Provider, job: LlmJob, minGapMs: number): Promise<void> {
  if (minGapMs <= 0) return;
  const key = `llm:gap:${provider}:${job}`;
  // Batas putaran: kalau Redis bermasalah, jangan sampai menunggu selamanya.
  for (let putaran = 0; putaran < 60; putaran++) {
    try {
      const ok = await redisCache.set(key, '1', 'PX', minGapMs, 'NX');
      if (ok === 'OK') return;
      const sisa = await redisCache.pttl(key);
      // -1 = tanpa TTL, -2 = kunci hilang; dua-duanya berarti coba lagi segera.
      const tunggu = sisa > 0 ? Math.min(sisa, minGapMs) : 50;
      logger.debug(`[LLM] job=${job} menunggu ${tunggu}ms demi jatah token`);
      await sleep(tunggu);
    } catch (err) {
      // Redis mati bukan alasan menolak melayani pelanggan. Lewati gerbangnya
      // dan biarkan penanganan 429 di bawah yang menahan lajunya.
      logger.warn(`[LLM] Gerbang laju job=${job} dilewati (Redis bermasalah): ${err}`);
      return;
    }
  }
  logger.warn(`[LLM] Gerbang laju job=${job} menyerah setelah 60 putaran — lanjut tanpa jeda`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Klasifikasi galat
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Apakah galat ini soal jatah/ukuran, bukan soal isi permintaan?
 *
 * Dipindah utuh dari question-mining.worker.ts. `413` diperlakukan sama dengan
 * `429` bukan karena teorinya begitu, tapi karena pengalaman: satu permintaan
 * yang utuh bisa sendirian melebihi jatah semenit, dan Groq menjawabnya dengan
 * "request too large" — yang obatnya sama, yaitu menunggu.
 */
export function isRateLimit(err: unknown): boolean {
  const anyErr = err as { status?: number; message?: string } | null;
  if (anyErr?.status === 429 || anyErr?.status === 413) return true;
  return /rate_limit|too large|tokens per minute/i.test(anyErr?.message ?? '');
}

function errorKind(err: unknown): string {
  const anyErr = err as { status?: number; code?: string } | null;
  if (isRateLimit(err)) return `rate_limit_${anyErr?.status ?? '?'}`;
  if (typeof anyErr?.status === 'number') return `http_${anyErr.status}`;
  if (anyErr?.code) return String(anyErr.code).slice(0, 32);
  return 'unknown';
}

// ─────────────────────────────────────────────────────────────────────────────
// Pencatatan pemakaian
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Tulis satu baris ke `llm_calls`. SENGAJA fire-and-forget: pencatatan tidak
 * boleh menggagalkan atau memperlambat panggilan yang sedang melayani
 * pelanggan. Kalau Postgres bermasalah, yang hilang cuma barisnya.
 */
function catatPemakaian(row: {
  businessId?: string | null;
  job: LlmJob;
  provider: string;
  model: string;
  usage: LlmUsage;
  latencyMs: number;
  attempts: number;
  ok: boolean;
  errorKind?: string | null;
  correlationId?: string | null;
}): void {
  if (!env.LLM_LOG_CALLS) return;
  prisma.llmCall
    .create({
      data: {
        businessId: row.businessId ?? null,
        job: row.job,
        provider: row.provider,
        model: row.model.slice(0, 100),
        promptTokens: row.usage.promptTokens,
        completionTokens: row.usage.completionTokens,
        cachedTokens: row.usage.cachedTokens ?? null,
        reasoningTokens: row.usage.reasoningTokens ?? null,
        latencyMs: row.latencyMs,
        attempts: row.attempts,
        ok: row.ok,
        errorKind: row.errorKind ? row.errorKind.slice(0, 32) : null,
        correlationId: row.correlationId ? row.correlationId.slice(0, 64) : null,
      },
    })
    .catch((e: unknown) => logger.warn(`[LLM] Gagal mencatat pemakaian job=${row.job}: ${e}`));
}

/** Buang baris `llm_calls` yang sudah lewat masa simpan. Dipanggil saat bootstrap. */
export async function bersihkanLlmCallLama(): Promise<number> {
  const hari = env.LLM_CALL_RETENTION_DAYS;
  if (hari <= 0) return 0;
  const batas = new Date(Date.now() - hari * 24 * 60 * 60 * 1000);
  try {
    const { count } = await prisma.llmCall.deleteMany({ where: { createdAt: { lt: batas } } });
    if (count > 0) logger.info(`[LLM] ${count} baris llm_calls lebih tua dari ${hari} hari dibuang`);
    return count;
  } catch (err) {
    logger.warn(`[LLM] Pembersihan llm_calls dilewati: ${err}`);
    return 0;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Panggilan
// ─────────────────────────────────────────────────────────────────────────────
export interface LlmRequest {
  messages: LlmMessage[];
  /** Untuk baris `llm_calls`. CLI audit mengirim undefined — memang tidak punya. */
  businessId?: string | null;
  correlationId?: string | null;
  /** Timpa model untuk panggilan ini saja. Dipakai sapuan kandidat di audit-ai.ts. */
  model?: string;
  maxTokens?: number;
  temperature?: number;
}

/**
 * Panggil model untuk satu pekerjaan.
 *
 * Retry hanya untuk galat jatah/ukuran, dengan backoff LINIER — dipindah apa
 * adanya dari question-mining.worker.ts. Galat lain dilempar langsung, supaya
 * penanganan di tiap pemanggil (yang punya semantik gagal berbeda-beda dan
 * sengaja demikian) tetap berlaku seperti sebelumnya.
 */
export async function complete(job: LlmJob, req: LlmRequest): Promise<LlmResult> {
  const cfg = JOB_CONFIG[job];
  // Urutan menang: timpaan per-panggilan (sapuan audit) → override bisnis dari
  // halaman Pengaturan → env per-pekerjaan → warisan GROQ_*.
  const spec = req.model
    ? (req.model.includes(':') ? req.model : `groq:${req.model}`)
    : (await resolveModelBerlaku(job, req.businessId)).spec;
  const { provider, model } = parseSpec(spec);

  const maxTokens = req.maxTokens ?? cfg.maxTokens;
  const temperature = req.temperature ?? cfg.temperature;
  const maxAttempts = Math.max(1, env.LLM_MAX_ATTEMPTS);

  // Jeda untuk backoff: pakai jeda job kalau ada, kalau tidak pakai nilai
  // netral. Tanpa ini, job tanpa gerbang akan mengulang seketika dan justru
  // memperparah galat jatah yang sedang terjadi.
  const jedaBackoff = cfg.minGapMs > 0 ? cfg.minGapMs : 2_000;

  let attempt = 0;
  const mulaiTotal = Date.now();

  for (;;) {
    attempt++;
    await waitForGap(provider, job, cfg.minGapMs);
    const mulai = Date.now();
    try {
      // Isi pesan bisa berupa string (delapan job teks) atau array bagian
      // (job 'vision'). Batas peran ditegakkan di sini, bukan diserahkan ke Groq.
      const pesan = req.messages.map((m) => {
        if (typeof m.content === 'string') return { role: m.role, content: m.content };
        if (m.role !== 'user') {
          throw new Error(
            `[LLM] job=${job}: isi pesan berupa bagian (gambar/teks) hanya sah pada ` +
            `peran 'user', bukan '${m.role}'.`,
          );
        }
        return { role: 'user' as const, content: m.content };
      });

      const badan = {
        model,
        max_tokens: maxTokens,
        temperature,
        ...(cfg.json ? { response_format: { type: 'json_object' as const } } : {}),
        messages: pesan,
        // ── `reasoning_effort: 'none'` WAJIB untuk Google — Fase 82 ──────────
        // Model Gemini 2.5+ berpikir secara bawaan, dan token berpikirnya
        // MEMAKAN JATAH `max_tokens`. Fase 81 mengukurnya: dengan `max_tokens`
        // 150, model habis jatah saat berpikir lalu jawabannya terpotong jadi
        // prosa — dan `JSON.parse` gagal. Enam dari sembilan pekerjaan di sini
        // minta JSON dengan jatah 100–800 token; tanpa baris ini semuanya
        // patah, satu per satu, tanpa satu pun galat yang kelihatan.
        //
        // HANYA `'none'` yang bekerja. `'minimal'` dan `'low'` diuji dan
        // TETAP menghabiskan ~136 token berpikir — berlawanan dengan namanya.
        // Jalur asli Google (`extra_body.google.thinking_config`) ditolak 400
        // lewat endpoint OpenAI-compat, jadi ini bukan pilihan, ini satu-satunya.
        //
        // Aman dikirim ke model yang memang tidak berpikir (diuji: tetap 200).
        //
        // Ditambah `gutstore` (1 Agustus 2026): penjual ulang itu menyajikan
        // Gemini, Claude, dan GPT lewat endpoint OpenAI-compat yang sama, jadi
        // ia mewarisi persis masalah yang sama. Diukur: `gutstore:gemini-3.5-flash`
        // dengan `max_tokens` 1024 mengembalikan `finish_reason=length` dan
        // jawaban KOSONG pada 4 dari 20 pertanyaan pertama sapuan audit — bukan
        // jawaban yang buruk, melainkan tidak ada jawaban sama sekali. Skor audit
        // yang dihitung dari itu akan menyalahkan pustaka untuk kegagalan yang
        // sebenarnya milik jatah token.
        ...(PROVIDER_TANPA_BERPIKIR.has(provider) ? { reasoning_effort: 'none' as const } : {}),
        // OpenRouter tidak mengizinkan penalaran dimatikan untuk keluarga
        // gpt-oss (dijawab 400 "Reasoning is mandatory for this endpoint"),
        // sedangkan TANPA parameter ini seluruh jatah token habis dipakai
        // menalar dan `content` kembali null. 'low' yang paling hemat di
        // antara yang diterima. Diuji langsung ke API 2 Agustus 2026.
        ...(provider === 'openrouter' && /gpt-oss/i.test(model)
          ? { reasoning: { effort: 'low' as const } }
          : {}),
        // ── OpenRouter: penyedia hulu DIKUNCI, bukan dipilihkan ──────────────
        // OpenRouter memilih sendiri satu dari 13 penyedia yang menjual model
        // yang sama, dan mereka TIDAK setara. Diukur 1 Agustus 2026: panggilan
        // pertama ke `meta-llama/llama-3.3-70b-instruct` dirutekan ke AkashML
        // (kuantisasi fp8) dan mengembalikan 64 detik sampah karakter escape
        // yang terpotong di `max_tokens` — model yang sama, prompt yang sama,
        // yang berbeda cuma mesin yang melayaninya.
        //
        // Karena itu urutannya ditentukan di sini dan `allow_fallbacks: false`.
        // Bawaannya `Groq` — mesin yang PERSIS SAMA dengan yang sudah dipakai
        // produksi selama ini, jadi memindahkan pekerjaan ke OpenRouter tidak
        // mengubah perilaku bot sedikit pun; yang berubah cuma siapa yang
        // menagih dan hilangnya batas token harian.
        //
        // `allow_fallbacks: false` disengaja: lebih baik permintaan GAGAL dan
        // terlihat daripada diam-diam dilayani mesin lain yang mutunya berbeda.
        // Audit yang jawabannya datang dari mesin yang tidak kita ketahui tidak
        // mengukur apa pun.
        ...(provider === 'openrouter' && env.OPENROUTER_PROVIDER_ORDER && !model.includes('deepseek')
          ? {
              provider: {
                order: env.OPENROUTER_PROVIDER_ORDER.split(',').map(x => x.trim()).filter(Boolean),
                allow_fallbacks: false,
              },
            }
          : {}),
      };

      const resp = provider === 'groq'
        ? await groq.chat.completions.create(badan as Parameters<typeof groq.chat.completions.create>[0])
        : await klienUntuk(provider).chat.completions.create(
            badan as Parameters<ReturnType<typeof klienUntuk>['chat']['completions']['create']>[0],
          );

      const u = (resp as { usage?: unknown }).usage as
        | { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number;
            prompt_tokens_details?: { cached_tokens?: number } }
        | undefined;
      // Token tersembunyi = total − masuk − keluar. Bentuk ini SENGAJA tidak
      // menyebut "thinking": ia menangkap selisih apa pun yang ditagih tapi
      // tidak dilaporkan, dari layanan mana pun, sekarang atau nanti.
      const tersembunyi = Math.max(
        0,
        (u?.total_tokens ?? 0) - (u?.prompt_tokens ?? 0) - (u?.completion_tokens ?? 0),
      );
      const usage: LlmUsage = {
        promptTokens: u?.prompt_tokens ?? 0,
        completionTokens: u?.completion_tokens ?? 0,
        ...(typeof u?.prompt_tokens_details?.cached_tokens === 'number'
          ? { cachedTokens: u.prompt_tokens_details.cached_tokens }
          : {}),
        ...(tersembunyi > 0 ? { reasoningTokens: tersembunyi } : {}),
      };

      // Jawaban yang terpotong karena kehabisan jatah adalah kegagalan yang
      // TIDAK melempar galat — ia mengembalikan teks separuh yang lolos ke
      // pemanggil. Untuk pekerjaan JSON itu berarti parse gagal di tempat lain,
      // jauh dari sebabnya. Dicatat di sini supaya sebabnya terbaca.
      const finish = (resp as { choices?: Array<{ finish_reason?: string }> })
        .choices?.[0]?.finish_reason;
      if (finish === 'length') {
        logger.warn(
          `[LLM] job=${job} ${provider}:${model} TERPOTONG (finish_reason=length, ` +
          `max_tokens=${maxTokens}${tersembunyi > 0 ? `, ${tersembunyi} token tersembunyi` : ''}). ` +
          `${cfg.json ? 'Pekerjaan ini butuh JSON — parse kemungkinan besar akan gagal. ' : ''}` +
          `Naikkan maxTokens atau pilih model yang tidak berpikir.`,
        );
      }
      const latencyMs = Date.now() - mulai;

      catatPemakaian({
        businessId: req.businessId, job, provider, model, usage,
        latencyMs, attempts: attempt, ok: true, correlationId: req.correlationId,
      });

      return {
        text: (resp as { choices?: Array<{ message?: { content?: string | null } }> })
          .choices?.[0]?.message?.content ?? '',
        provider, model, usage, latencyMs, attempts: attempt,
      };
    } catch (err) {
      const latencyMs = Date.now() - mulai;
      const kind = errorKind(err);

      if (isRateLimit(err) && attempt < maxAttempts) {
        const tunggu = jedaBackoff * attempt;
        logger.warn(
          `[LLM] job=${job} model=${model} kena batas jatah (${kind}), ` +
          `percobaan ${attempt}/${maxAttempts} — tunggu ${Math.round(tunggu / 1000)} detik`,
        );
        await sleep(tunggu);
        continue;
      }

      catatPemakaian({
        businessId: req.businessId, job, provider, model,
        usage: { promptTokens: 0, completionTokens: 0 },
        latencyMs, attempts: attempt, ok: false, errorKind: kind,
        correlationId: req.correlationId,
      });
      logger.error(
        `[LLM] job=${job} model=${model} GAGAL setelah ${attempt} percobaan ` +
        `(${Math.round((Date.now() - mulaiTotal) / 1000)} detik, ${kind}): ` +
        `${(err as Error)?.message ?? err}`,
      );
      throw err;
    }
  }
}

/** Nama model tanpa awalan provider & tanpa awalan vendor — untuk log & kolom sempit. */
export function modelPendek(model: string): string {
  return model.split(':').pop()!.split('/').pop()!;
}
