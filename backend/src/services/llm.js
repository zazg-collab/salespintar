"use strict";
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
var __assign = (this && this.__assign) || function () {
    __assign = Object.assign || function(t) {
        for (var s, i = 1, n = arguments.length; i < n; i++) {
            s = arguments[i];
            for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p))
                t[p] = s[p];
        }
        return t;
    };
    return __assign.apply(this, arguments);
};
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __generator = (this && this.__generator) || function (thisArg, body) {
    var _ = { label: 0, sent: function() { if (t[0] & 1) throw t[1]; return t[1]; }, trys: [], ops: [] }, f, y, t, g = Object.create((typeof Iterator === "function" ? Iterator : Object).prototype);
    return g.next = verb(0), g["throw"] = verb(1), g["return"] = verb(2), typeof Symbol === "function" && (g[Symbol.iterator] = function() { return this; }), g;
    function verb(n) { return function (v) { return step([n, v]); }; }
    function step(op) {
        if (f) throw new TypeError("Generator is already executing.");
        while (g && (g = 0, op[0] && (_ = 0)), _) try {
            if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
            if (y = 0, t) op = [op[0] & 2, t.value];
            switch (op[0]) {
                case 0: case 1: t = op; break;
                case 4: _.label++; return { value: op[1], done: false };
                case 5: _.label++; y = op[1]; op = [0]; continue;
                case 7: op = _.ops.pop(); _.trys.pop(); continue;
                default:
                    if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) { _ = 0; continue; }
                    if (op[0] === 3 && (!t || (op[1] > t[0] && op[1] < t[3]))) { _.label = op[1]; break; }
                    if (op[0] === 6 && _.label < t[1]) { _.label = t[1]; t = op; break; }
                    if (t && _.label < t[2]) { _.label = t[2]; _.ops.push(op); break; }
                    if (t[2]) _.ops.pop();
                    _.trys.pop(); continue;
            }
            op = body.call(thisArg, _);
        } catch (e) { op = [6, e]; y = 0; } finally { f = t = 0; }
        if (op[0] & 5) throw op[1]; return { value: op[0] ? op[1] : void 0, done: true };
    }
};
var __spreadArray = (this && this.__spreadArray) || function (to, from, pack) {
    if (pack || arguments.length === 2) for (var i = 0, l = from.length, ar; i < l; i++) {
        if (ar || !(i in from)) {
            if (!ar) ar = Array.prototype.slice.call(from, 0, i);
            ar[i] = from[i];
        }
    }
    return to.concat(ar || Array.prototype.slice.call(from));
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.MODEL_BISA_GAMBAR = exports.SUPPORTED_PROVIDERS = exports.HARGA_MODEL = exports.JOB_INFO = exports.ALL_LLM_JOBS = void 0;
exports.modelMungkinBisaGambar = modelMungkinBisaGambar;
exports.resolveModelSpec = resolveModelSpec;
exports.bacaOverrideBisnis = bacaOverrideBisnis;
exports.lupakanOverrideBisnis = lupakanOverrideBisnis;
exports.resolveModelBerlaku = resolveModelBerlaku;
exports.listAvailableModels = listAvailableModels;
exports.validateLlmConfig = validateLlmConfig;
exports.isRateLimit = isRateLimit;
exports.bersihkanLlmCallLama = bersihkanLlmCallLama;
exports.complete = complete;
exports.modelPendek = modelPendek;
var groq_sdk_1 = require("groq-sdk");
var openai_1 = require("openai");
var env_1 = require("../config/env");
var prisma_1 = require("../config/prisma");
var redis_1 = require("../config/redis");
var logger_1 = require("../utils/logger");
// ── Klien: SATU-SATUNYA di seluruh repo ──────────────────────────────────────
//
// Groq tetap memakai SDK-nya sendiri — TIDAK dipindah ke SDK `openai` walau
// keduanya sebentuk. Alasannya bukan selera: memindahkannya berarti mengubah
// jalur yang sedang melayani pelanggan demi kerapian, dan itu risiko tanpa
// imbalan. Layanan baru memakai SDK `openai` karena Google dan OpenRouter
// dua-duanya menyediakan endpoint yang kompatibel dengannya.
var groq = new groq_sdk_1.default({ apiKey: env_1.env.GROQ_API_KEY });
var BASE_URL = {
    google: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    openrouter: 'https://openrouter.ai/api/v1',
    gutstore: 'https://api.gutstore.my.id/v1',
};
function apiKeyFor(provider) {
    if (provider === 'groq')
        return env_1.env.GROQ_API_KEY;
    if (provider === 'google')
        return env_1.env.GOOGLE_API_KEY;
    if (provider === 'openrouter')
        return env_1.env.OPENROUTER_API_KEY;
    if (provider === 'gutstore')
        return env_1.env.GUTSTORE_API_KEY;
    return undefined;
}
// Klien dibuat SEKALI per layanan lalu dipakai ulang. Membuatnya per panggilan
// berarti membuang kumpulan koneksi HTTP-nya tiap kali — itu yang dulu terjadi
// waktu `new Groq({...})` tersebar di enam berkas.
var klienOpenAI = new Map();
function klienUntuk(provider) {
    var ada = klienOpenAI.get(provider);
    if (ada)
        return ada;
    var apiKey = apiKeyFor(provider);
    if (!apiKey) {
        throw new Error("[LLM] Kunci API untuk layanan \"".concat(provider, "\" belum diisi. ") +
            "Setel ".concat(NAMA_ENV_KUNCI[provider], " di backend/.env."));
    }
    var klien = new openai_1.default({ apiKey: apiKey, baseURL: BASE_URL[provider] });
    klienOpenAI.set(provider, klien);
    return klien;
}
exports.ALL_LLM_JOBS = [
    'classify',
    'gatekeeper',
    'extract',
    'miner',
    'publish',
];
/**
 * Keterangan tiap pekerjaan untuk halaman Pengaturan Model (Knowledge Base AI & Performa CS).
 */
exports.JOB_INFO = {
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
 * Nilai per pekerjaan — SALINAN PERSIS dari yang tadinya hardcode di titik
 * panggilnya. Jangan "dirapikan" tanpa alasan: angka-angka ini punya sejarah.
 * Misalnya `extract` bertemperatur 0.2 dan bermaks 2048 karena keluarannya
 * dokumen Markdown panjang yang harus menuruti delapan aturan; `supervisor`
 * bertemperatur 0 karena tugasnya menghakimi, bukan mengarang.
 */
var JOB_CONFIG = {
    reply: { maxTokens: env_1.env.GROQ_MAX_TOKENS, temperature: env_1.env.GROQ_TEMPERATURE, json: false, minGapMs: 0 },
    fallback: { maxTokens: env_1.env.GROQ_MAX_TOKENS, temperature: env_1.env.GROQ_TEMPERATURE, json: false, minGapMs: 0 },
    intent: { maxTokens: 100, temperature: 0.3, json: true, minGapMs: 0 },
    // 700, bukan 200, sejak Fase 110. Supervisor pindah ke `openai/gpt-oss-120b`
    // lewat OpenRouter, dan endpoint itu MENOLAK permintaan mematikan penalaran
    // ("Reasoning is mandatory for this endpoint"). Penalarannya memakai jatah
    // token keluaran yang sama — dengan 200 token, JSON-nya tidak pernah selesai
    // ditulis dan hasilnya `content: null`. Biayanya tetap kecil: model ini 16x
    // lebih murah daripada llama-70b.
    supervisor: { maxTokens: 700, temperature: 0, json: true, minGapMs: 0 },
    classify: { maxTokens: 1500, temperature: 0, json: true, minGapMs: 0 },
    gatekeeper: { maxTokens: 1500, temperature: 0, json: true, minGapMs: 0 },
    extract: { maxTokens: 2048, temperature: 0.2, json: true, minGapMs: 0 },
    // Satu-satunya job yang tadinya punya pembatas laju sendiri: `waitForSlot()`
    // di question-mining.worker.ts. Nilainya (21 detik ≈ 3 panggilan/menit)
    // ditentukan oleh jatah token per menit Groq, bukan oleh sifat tugasnya.
    miner: { maxTokens: 800, temperature: 0, json: true, minGapMs: env_1.env.LLM_MIN_GAP_MS_MINER },
    publish: { maxTokens: 3000, temperature: 0.1, json: false, minGapMs: env_1.env.LLM_MIN_GAP_MS_PUBLISH },
    audit: { maxTokens: env_1.env.GROQ_MAX_TOKENS, temperature: env_1.env.GROQ_TEMPERATURE, json: false, minGapMs: 0 },
    // Keluarannya deskripsi pendek untuk disuntikkan ke jalur balasan, bukan
    // karangan — 600 token cukup untuk bukti transfer terpanjang. Suhu 0,1: yang
    // diminta MEMBACA, dan model yang "kreatif" saat membaca nominal transfer
    // adalah model yang mengarang nominal transfer.
    vision: { maxTokens: 600, temperature: 0.1, json: false, minGapMs: 0 },
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
exports.HARGA_MODEL = {
    'groq:llama-3.1-8b-instant': { masuk: 0.05, keluar: 0.08 },
    'groq:openai/gpt-oss-20b': { masuk: 0.075, keluar: 0.30, masukCached: 0.0375 },
    'groq:openai/gpt-oss-120b': { masuk: 0.15, keluar: 0.60, masukCached: 0.075 },
    'groq:openai/gpt-oss-safeguard-20b': { masuk: 0.075, keluar: 0.30, masukCached: 0.0375 },
    'groq:llama-3.3-70b-versatile': { masuk: 0.59, keluar: 0.79 },
    'groq:qwen/qwen3.6-27b': { masuk: 0.60, keluar: 3.00 },
    // Google AI Studio, tier berbayar (ai.google.dev/pricing, Juli 2026).
    // ⚠️ Angka KELUAR untuk model yang berpikir sudah termasuk token thinking —
    // dan token thinking bisa 10× lebih banyak dari jawabannya (lihat Fase 81).
    // Karena itu `reasoning_effort: 'none'` dipaksa untuk semua panggilan Google
    // di bawah; tanpa itu, biaya nyata jauh di atas taksiran tabel ini.
    'google:gemini-2.5-flash': { masuk: 0.30, keluar: 2.50 },
    'google:gemini-3.1-flash-lite': { masuk: 0.10, keluar: 0.40 },
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
    'openrouter:meta-llama/llama-3.3-70b-instruct': { masuk: 0.13, keluar: 0.40 },
    'openrouter:openai/gpt-oss-120b': { masuk: 0.037, keluar: 0.17 },
    'openrouter:qwen/qwen3-235b-a22b-2507': { masuk: 0.09, keluar: 0.55 },
    'openrouter:deepseek/deepseek-v4-flash-0731': { masuk: 0.14, keluar: 0.28 },
    'openrouter:deepseek/deepseek-chat': { masuk: 0.14, keluar: 0.28 },
    'openrouter:deepseek/deepseek-r1': { masuk: 0.55, keluar: 2.19 },
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
    'gutstore:claude-haiku-4.5': { masuk: 0.0166, keluar: 0.0166 },
    'gutstore:claude-sonnet-4.5': { masuk: 0.0194, keluar: 0.0194 },
    'gutstore:deepseek-3.2': { masuk: 0.0166, keluar: 0.0166 },
    'gutstore:gemini-3.5-flash': { masuk: 0.0221, keluar: 0.0221 },
    'gutstore:minimax-m2.5': { masuk: 0.0194, keluar: 0.0194 },
    'gutstore:gpt-5.5': { masuk: 0.0332, keluar: 0.0332 },
};
exports.SUPPORTED_PROVIDERS = ['groq', 'google', 'openrouter', 'gutstore'];
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
var PROVIDER_TANPA_BERPIKIR = new Set(['google', 'gutstore']);
var NAMA_ENV_KUNCI = {
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
var BAWAAN_VISION = 'groq:qwen/qwen3.6-27b';
/**
 * Model yang diketahui bisa menerima gambar (dokumentasi Groq, Juli 2026:
 * `qwen/qwen3.6-27b` satu-satunya).
 *
 * Dipakai untuk MEMPERINGATKAN, bukan MENOLAK. Daftar ini pasti akan basi —
 * Groq menambah model tanpa memberi tahu berkas ini — dan menolak berdasarkan
 * daftar basi berarti memblokir model baru yang lebih baik pada hari ia terbit.
 * Peringatan yang salah cuma berisik; penolakan yang salah mematikan fitur.
 */
exports.MODEL_BISA_GAMBAR = new Set([
    'groq:qwen/qwen3.6-27b',
    // Diverifikasi sungguhan di Fase 81 (PNG 1×1 merah dikenali "Merah"), bukan
    // dibaca dari dokumentasi.
    'google:gemini-2.5-flash',
    'google:gemini-3.1-flash-lite',
    'google:gemini-flash-lite-latest',
    'google:gemini-3.5-flash',
]);
function modelMungkinBisaGambar(spec) {
    // Kuncinya spec penuh sejak Fase 82. Spec tanpa awalan layanan dianggap groq,
    // sama seperti aturan `parseSpec()` — supaya nilai `.env` lama tetap terbaca.
    return exports.MODEL_BISA_GAMBAR.has(spec.includes(':') ? spec : "groq:".concat(spec));
}
/** Pekerjaan yang sebelum ini memakai `GROQ_EXTRACTOR_MODEL`. */
var INHERITS_EXTRACTOR = new Set(['extract', 'publish']);
function envKnob(job) {
    var _a;
    var map = {
        reply: env_1.env.LLM_MODEL_REPLY,
        fallback: env_1.env.LLM_MODEL_FALLBACK,
        intent: env_1.env.LLM_MODEL_INTENT,
        supervisor: env_1.env.LLM_MODEL_SUPERVISOR,
        classify: env_1.env.LLM_MODEL_CLASSIFY,
        gatekeeper: env_1.env.LLM_MODEL_GATEKEEPER || env_1.env.LLM_MODEL_MINER || 'groq:llama-3.1-8b-instant',
        extract: env_1.env.LLM_MODEL_EXTRACT,
        miner: env_1.env.LLM_MODEL_MINER,
        publish: env_1.env.LLM_MODEL_PUBLISH,
        audit: env_1.env.LLM_MODEL_AUDIT,
        vision: env_1.env.LLM_MODEL_VISION,
    };
    var v = (_a = map[job]) === null || _a === void 0 ? void 0 : _a.trim();
    return v ? v : undefined;
}
function resolveModelSpec(job) {
    var explicit = envKnob(job);
    if (explicit)
        return explicit.includes(':') ? explicit : "groq:".concat(explicit);
    // Warisan. `fallback` punya tombol lamanya sendiri.
    if (job === 'vision')
        return BAWAAN_VISION; // sengaja TIDAK mewarisi GROQ_MODEL
    if (job === 'fallback')
        return "groq:".concat(env_1.env.GROQ_FALLBACK_MODEL);
    if (INHERITS_EXTRACTOR.has(job))
        return "groq:".concat(env_1.env.GROQ_EXTRACTOR_MODEL);
    return "groq:".concat(env_1.env.GROQ_MODEL);
}
function parseSpec(spec) {
    var idx = spec.indexOf(':');
    var provider = idx === -1 ? 'groq' : spec.slice(0, idx).trim();
    var model = idx === -1 ? spec.trim() : spec.slice(idx + 1).trim();
    if (!model)
        throw new Error("Nama model kosong pada \"".concat(spec, "\""));
    if (!exports.SUPPORTED_PROVIDERS.includes(provider)) {
        throw new Error("Provider \"".concat(provider, "\" belum didukung (spec: \"").concat(spec, "\"). ") +
            "Yang tersedia: ".concat(exports.SUPPORTED_PROVIDERS.join(', '), "."));
    }
    return { provider: provider, model: model };
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
var TTL_CACHE_OVERRIDE_SEC = 60;
var KUNCI_CACHE_OVERRIDE = function (businessId) { return "llm:models:".concat(businessId); };
function bersihkanOverride(mentah) {
    var hasil = {};
    if (!mentah || typeof mentah !== 'object')
        return hasil;
    for (var _i = 0, ALL_LLM_JOBS_1 = exports.ALL_LLM_JOBS; _i < ALL_LLM_JOBS_1.length; _i++) {
        var job = ALL_LLM_JOBS_1[_i];
        var v = mentah[job];
        if (typeof v === 'string' && v.trim())
            hasil[job] = v.trim();
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
function bacaOverrideBisnis(businessId) {
    return __awaiter(this, void 0, void 0, function () {
        var cached, _a, b, cfg, override, _b, err_1;
        var _c;
        return __generator(this, function (_d) {
            switch (_d.label) {
                case 0:
                    _d.trys.push([0, 2, , 3]);
                    return [4 /*yield*/, redis_1.redisCache.get(KUNCI_CACHE_OVERRIDE(businessId))];
                case 1:
                    cached = _d.sent();
                    if (cached !== null)
                        return [2 /*return*/, bersihkanOverride(JSON.parse(cached))];
                    return [3 /*break*/, 3];
                case 2:
                    _a = _d.sent();
                    return [3 /*break*/, 3];
                case 3:
                    _d.trys.push([3, 9, , 10]);
                    return [4 /*yield*/, prisma_1.prisma.business.findUnique({
                            where: { id: businessId },
                            select: { aiConfig: true },
                        })];
                case 4:
                    b = _d.sent();
                    cfg = ((_c = b === null || b === void 0 ? void 0 : b.aiConfig) !== null && _c !== void 0 ? _c : {});
                    override = bersihkanOverride(cfg['llmModels']);
                    _d.label = 5;
                case 5:
                    _d.trys.push([5, 7, , 8]);
                    return [4 /*yield*/, redis_1.redisCache.set(KUNCI_CACHE_OVERRIDE(businessId), JSON.stringify(override), 'EX', TTL_CACHE_OVERRIDE_SEC)];
                case 6:
                    _d.sent();
                    return [3 /*break*/, 8];
                case 7:
                    _b = _d.sent();
                    return [3 /*break*/, 8];
                case 8: return [2 /*return*/, override];
                case 9:
                    err_1 = _d.sent();
                    logger_1.logger.warn("[LLM] Override model bisnis ".concat(businessId, " tidak terbaca, pakai env: ").concat(err_1));
                    return [2 /*return*/, {}];
                case 10: return [2 /*return*/];
            }
        });
    });
}
/** Kosongkan cache override — dipanggil segera setelah Simpan di UI. */
function lupakanOverrideBisnis(businessId) {
    return __awaiter(this, void 0, void 0, function () {
        var _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    _b.trys.push([0, 2, , 3]);
                    return [4 /*yield*/, redis_1.redisCache.del(KUNCI_CACHE_OVERRIDE(businessId))];
                case 1:
                    _b.sent();
                    return [3 /*break*/, 3];
                case 2:
                    _a = _b.sent();
                    return [3 /*break*/, 3];
                case 3: return [2 /*return*/];
            }
        });
    });
}
/**
 * Model yang BERLAKU untuk satu pekerjaan, lengkap dengan asalnya.
 * Urutan menang: override bisnis → env per-pekerjaan → warisan GROQ_*.
 */
function resolveModelBerlaku(job, businessId) {
    return __awaiter(this, void 0, void 0, function () {
        var override, dariBisnis, dariEnv;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    if (!businessId) return [3 /*break*/, 2];
                    return [4 /*yield*/, bacaOverrideBisnis(businessId)];
                case 1:
                    override = _a.sent();
                    dariBisnis = override[job];
                    if (dariBisnis) {
                        return [2 /*return*/, { spec: dariBisnis.includes(':') ? dariBisnis : "groq:".concat(dariBisnis), sumber: 'bisnis' }];
                    }
                    _a.label = 2;
                case 2:
                    dariEnv = envKnob(job);
                    if (dariEnv) {
                        return [2 /*return*/, { spec: dariEnv.includes(':') ? dariEnv : "groq:".concat(dariEnv), sumber: 'env' }];
                    }
                    return [2 /*return*/, { spec: resolveModelSpec(job), sumber: 'warisan' }];
            }
        });
    });
}
var KUNCI_CACHE_DAFTAR = 'llm:daftar-model:groq';
var TTL_CACHE_DAFTAR_SEC = 3600;
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
var MODEL_GOOGLE_TERUJI = [
    'gemini-3.5-flash',
    'gemini-3.1-flash-lite',
    'gemini-3-flash-preview',
    'gemini-2.5-flash',
    'gemini-flash-latest',
    'gemini-flash-lite-latest',
];
function ambilIdModel(provider) {
    return __awaiter(this, void 0, void 0, function () {
        var resp, resp, adaDiAPI_1, awalan_1;
        var _a, _b;
        return __generator(this, function (_c) {
            switch (_c.label) {
                case 0:
                    if (!(provider === 'groq')) return [3 /*break*/, 2];
                    return [4 /*yield*/, groq.models.list()];
                case 1:
                    resp = _c.sent();
                    return [2 /*return*/, ((_a = resp.data) !== null && _a !== void 0 ? _a : [])
                            .map(function (m) { return m.id; })
                            .filter(function (id) { return !!id; })
                            // Model non-teks (transkripsi/TTS) tidak berguna untuk pekerjaan mana pun
                            // di sistem ini — disaring supaya dropdown tidak menyesatkan.
                            .filter(function (id) { return !/whisper|tts|guard|playai/i.test(id); })];
                case 2:
                    if (!(provider === 'google')) return [3 /*break*/, 4];
                    return [4 /*yield*/, klienUntuk('google').models.list()];
                case 3:
                    resp = _c.sent();
                    adaDiAPI_1 = new Set(((_b = resp.data) !== null && _b !== void 0 ? _b : [])
                        .map(function (m) { var _a; return String((_a = m.id) !== null && _a !== void 0 ? _a : '').replace(/^models\//, ''); })
                        .filter(Boolean));
                    // Perpotongan: harus ada di API DAN sudah diuji hidup.
                    return [2 /*return*/, MODEL_GOOGLE_TERUJI.filter(function (id) { return adaDiAPI_1.has(id); })];
                case 4:
                    if (provider === 'openrouter' || provider === 'gutstore') {
                        awalan_1 = "".concat(provider, ":");
                        return [2 /*return*/, Object.keys(exports.HARGA_MODEL)
                                .filter(function (spec) { return spec.startsWith(awalan_1); })
                                .map(function (spec) { return spec.slice(awalan_1.length); })];
                    }
                    return [2 /*return*/, []];
            }
        });
    });
}
function listAvailableModels() {
    return __awaiter(this, void 0, void 0, function () {
        var cached, _a, daftar, _i, SUPPORTED_PROVIDERS_1, provider, _b, _c, id, spec, harga, err_2, _d, err_3, _e, _f, _g, spec, harga, idx, provider;
        return __generator(this, function (_h) {
            switch (_h.label) {
                case 0:
                    _h.trys.push([0, 2, , 3]);
                    return [4 /*yield*/, redis_1.redisCache.get(KUNCI_CACHE_DAFTAR)];
                case 1:
                    cached = _h.sent();
                    if (cached)
                        return [2 /*return*/, JSON.parse(cached)];
                    return [3 /*break*/, 3];
                case 2:
                    _a = _h.sent();
                    return [3 /*break*/, 3];
                case 3:
                    daftar = [];
                    _h.label = 4;
                case 4:
                    _h.trys.push([4, 18, , 19]);
                    _i = 0, SUPPORTED_PROVIDERS_1 = exports.SUPPORTED_PROVIDERS;
                    _h.label = 5;
                case 5:
                    if (!(_i < SUPPORTED_PROVIDERS_1.length)) return [3 /*break*/, 13];
                    provider = SUPPORTED_PROVIDERS_1[_i];
                    if (!apiKeyFor(provider))
                        return [3 /*break*/, 12];
                    _h.label = 6;
                case 6:
                    _h.trys.push([6, 11, , 12]);
                    _b = 0;
                    return [4 /*yield*/, ambilIdModel(provider)];
                case 7:
                    _c = _h.sent();
                    _h.label = 8;
                case 8:
                    if (!(_b < _c.length)) return [3 /*break*/, 10];
                    id = _c[_b];
                    spec = "".concat(provider, ":").concat(id);
                    harga = exports.HARGA_MODEL[spec];
                    daftar.push(__assign({ spec: spec, provider: provider, id: id, bisaGambar: exports.MODEL_BISA_GAMBAR.has(spec) }, (harga ? { harga: harga } : {})));
                    _h.label = 9;
                case 9:
                    _b++;
                    return [3 /*break*/, 8];
                case 10: return [3 /*break*/, 12];
                case 11:
                    err_2 = _h.sent();
                    logger_1.logger.warn("[LLM] Daftar model layanan \"".concat(provider, "\" tidak bisa diambil: ").concat(err_2));
                    return [3 /*break*/, 12];
                case 12:
                    _i++;
                    return [3 /*break*/, 5];
                case 13:
                    // Yang harganya diketahui ditaruh dulu, diurut dari termurah — supaya pilihan
                    // hemat berada di atas, bukan tenggelam di antara model tanpa keterangan.
                    daftar.sort(function (a, b) {
                        if (a.harga && b.harga)
                            return a.harga.masuk - b.harga.masuk || a.harga.keluar - b.harga.keluar;
                        if (a.harga)
                            return -1;
                        if (b.harga)
                            return 1;
                        return a.id.localeCompare(b.id);
                    });
                    _h.label = 14;
                case 14:
                    _h.trys.push([14, 16, , 17]);
                    return [4 /*yield*/, redis_1.redisCache.set(KUNCI_CACHE_DAFTAR, JSON.stringify(daftar), 'EX', TTL_CACHE_DAFTAR_SEC)];
                case 15:
                    _h.sent();
                    return [3 /*break*/, 17];
                case 16:
                    _d = _h.sent();
                    return [3 /*break*/, 17];
                case 17: return [3 /*break*/, 19];
                case 18:
                    err_3 = _h.sent();
                    logger_1.logger.warn("[LLM] Daftar model tidak bisa diambil dari Groq: ".concat(err_3));
                    // Cadangan: model yang harganya kita tahu. Dropdown tetap bisa dipakai walau
                    // API Groq sedang tidak bisa dihubungi.
                    // Kunci HARGA_MODEL sudah berupa spec penuh sejak Fase 82, jadi jangan
                    // ditambahi awalan lagi — itu akan menghasilkan `groq:groq:…`.
                    for (_e = 0, _f = Object.entries(exports.HARGA_MODEL); _e < _f.length; _e++) {
                        _g = _f[_e], spec = _g[0], harga = _g[1];
                        idx = spec.indexOf(':');
                        provider = spec.slice(0, idx);
                        if (!apiKeyFor(provider))
                            continue;
                        daftar.push({
                            spec: spec,
                            provider: provider,
                            id: spec.slice(idx + 1),
                            harga: harga,
                            bisaGambar: exports.MODEL_BISA_GAMBAR.has(spec),
                        });
                    }
                    return [3 /*break*/, 19];
                case 19: return [2 /*return*/, daftar];
            }
        });
    });
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
function validateLlmConfig() {
    var baris = [];
    var layananDipakai = new Set();
    for (var _i = 0, ALL_LLM_JOBS_2 = exports.ALL_LLM_JOBS; _i < ALL_LLM_JOBS_2.length; _i++) {
        var job = ALL_LLM_JOBS_2[_i];
        var spec = resolveModelSpec(job);
        var _a = parseSpec(spec), provider = _a.provider, model = _a.model; // melempar kalau tidak sah
        layananDipakai.add(provider);
        var cfg = JOB_CONFIG[job];
        baris.push("  ".concat(job.padEnd(11), " ").concat(provider, ":").concat(model) +
            "  (maks ".concat(cfg.maxTokens, " tok, suhu ").concat(cfg.temperature) +
            "".concat(cfg.json ? ', JSON' : '').concat(cfg.minGapMs ? ", jeda ".concat(cfg.minGapMs, "ms") : '', ")"));
    }
    logger_1.logger.info("[LLM] Peta model per pekerjaan:\n".concat(baris.join('\n')));
    // ── Kunci API untuk layanan yang BENAR-BENAR dipakai — Fase 82 ─────────────
    // Zod tidak bisa memeriksa ini: ia tahu kuncinya kosong, tapi tidak tahu
    // pekerjaan mana yang dipetakan ke layanan mana. Diperiksa di sini, saat
    // menyala — sebab kunci yang hilang harus meledak sekarang, bukan pada pesan
    // pelanggan pertama yang kebetulan lewat pekerjaan itu. Ini alasan yang sama
    // dengan pemeriksaan 'vision' di bawah.
    var kurangKunci = __spreadArray([], layananDipakai, true).filter(function (p) { return !apiKeyFor(p); });
    if (kurangKunci.length > 0) {
        throw new Error("[LLM] Ada pekerjaan yang dipetakan ke layanan tanpa kunci API: " +
            kurangKunci.map(function (p) { return "".concat(p, " (butuh ").concat(NAMA_ENV_KUNCI[p], ")"); }).join(', ') + '. ' +
            "Isi kuncinya di backend/.env, atau kembalikan pekerjaan itu ke layanan yang kuncinya ada.");
    }
    var takAktif = exports.SUPPORTED_PROVIDERS.filter(function (p) { return !apiKeyFor(p); });
    if (takAktif.length > 0) {
        logger_1.logger.info("[LLM] Layanan tanpa kunci API (tidak muncul di dropdown): ".concat(takAktif.join(', ')));
    }
    // Satu-satunya pemetaan yang bisa SALAH SECARA JENIS, bukan cuma mahal atau
    // lambat: 'vision' ke model yang tidak bisa melihat. Kalau itu terjadi, yang
    // muncul bukan balasan buruk tapi galat 400 saat pelanggan mengirim foto.
    // Diperiksa saat menyala supaya ketahuan sekarang, bukan nanti.
    var specVision = resolveModelSpec('vision');
    if (!modelMungkinBisaGambar(specVision)) {
        logger_1.logger.warn("[LLM] job 'vision' dipetakan ke \"".concat(specVision, "\", yang TIDAK ADA di daftar model ") +
            "bisa-gambar (".concat(__spreadArray([], exports.MODEL_BISA_GAMBAR, true).join(', '), "). Kalau model itu memang belum ") +
            "mendukung gambar, setiap foto dari pelanggan akan gagal. Periksa LLM_MODEL_VISION " +
            "di .env atau pilihan \"Pembaca gambar\" di halaman Pengaturan Model.");
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
var sleep = function (ms) { return new Promise(function (r) { return setTimeout(r, ms); }); };
/**
 * Gerbangnya diberi dimensi LAYANAN sejak Fase 82.
 *
 * Jatah dihitung per organisasi PER LAYANAN — kuota Groq dan kuota Google tidak
 * saling memakan. Dengan kunci lama (`llm:gap:{job}`), pekerjaan yang pindah ke
 * Google akan tetap menunggu jeda yang dipasang demi Groq, dan sebaliknya dua
 * pekerjaan di layanan berbeda akan saling menahan tanpa alasan.
 */
function waitForGap(provider, job, minGapMs) {
    return __awaiter(this, void 0, void 0, function () {
        var key, putaran, ok, sisa, tunggu, err_4;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    if (minGapMs <= 0)
                        return [2 /*return*/];
                    key = "llm:gap:".concat(provider, ":").concat(job);
                    putaran = 0;
                    _a.label = 1;
                case 1:
                    if (!(putaran < 60)) return [3 /*break*/, 8];
                    _a.label = 2;
                case 2:
                    _a.trys.push([2, 6, , 7]);
                    return [4 /*yield*/, redis_1.redisCache.set(key, '1', 'PX', minGapMs, 'NX')];
                case 3:
                    ok = _a.sent();
                    if (ok === 'OK')
                        return [2 /*return*/];
                    return [4 /*yield*/, redis_1.redisCache.pttl(key)];
                case 4:
                    sisa = _a.sent();
                    tunggu = sisa > 0 ? Math.min(sisa, minGapMs) : 50;
                    logger_1.logger.debug("[LLM] job=".concat(job, " menunggu ").concat(tunggu, "ms demi jatah token"));
                    return [4 /*yield*/, sleep(tunggu)];
                case 5:
                    _a.sent();
                    return [3 /*break*/, 7];
                case 6:
                    err_4 = _a.sent();
                    // Redis mati bukan alasan menolak melayani pelanggan. Lewati gerbangnya
                    // dan biarkan penanganan 429 di bawah yang menahan lajunya.
                    logger_1.logger.warn("[LLM] Gerbang laju job=".concat(job, " dilewati (Redis bermasalah): ").concat(err_4));
                    return [2 /*return*/];
                case 7:
                    putaran++;
                    return [3 /*break*/, 1];
                case 8:
                    logger_1.logger.warn("[LLM] Gerbang laju job=".concat(job, " menyerah setelah 60 putaran \u2014 lanjut tanpa jeda"));
                    return [2 /*return*/];
            }
        });
    });
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
function isRateLimit(err) {
    var _a;
    var anyErr = err;
    if ((anyErr === null || anyErr === void 0 ? void 0 : anyErr.status) === 429 || (anyErr === null || anyErr === void 0 ? void 0 : anyErr.status) === 413)
        return true;
    return /rate_limit|too large|tokens per minute/i.test((_a = anyErr === null || anyErr === void 0 ? void 0 : anyErr.message) !== null && _a !== void 0 ? _a : '');
}
function errorKind(err) {
    var _a;
    var anyErr = err;
    if (isRateLimit(err))
        return "rate_limit_".concat((_a = anyErr === null || anyErr === void 0 ? void 0 : anyErr.status) !== null && _a !== void 0 ? _a : '?');
    if (typeof (anyErr === null || anyErr === void 0 ? void 0 : anyErr.status) === 'number')
        return "http_".concat(anyErr.status);
    if (anyErr === null || anyErr === void 0 ? void 0 : anyErr.code)
        return String(anyErr.code).slice(0, 32);
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
function catatPemakaian(row) {
    var _a, _b, _c;
    if (!env_1.env.LLM_LOG_CALLS)
        return;
    prisma_1.prisma.llmCall
        .create({
        data: {
            businessId: (_a = row.businessId) !== null && _a !== void 0 ? _a : null,
            job: row.job,
            provider: row.provider,
            model: row.model.slice(0, 100),
            promptTokens: row.usage.promptTokens,
            completionTokens: row.usage.completionTokens,
            cachedTokens: (_b = row.usage.cachedTokens) !== null && _b !== void 0 ? _b : null,
            reasoningTokens: (_c = row.usage.reasoningTokens) !== null && _c !== void 0 ? _c : null,
            latencyMs: row.latencyMs,
            attempts: row.attempts,
            ok: row.ok,
            errorKind: row.errorKind ? row.errorKind.slice(0, 32) : null,
            correlationId: row.correlationId ? row.correlationId.slice(0, 64) : null,
        },
    })
        .catch(function (e) { return logger_1.logger.warn("[LLM] Gagal mencatat pemakaian job=".concat(row.job, ": ").concat(e)); });
}
/** Buang baris `llm_calls` yang sudah lewat masa simpan. Dipanggil saat bootstrap. */
function bersihkanLlmCallLama() {
    return __awaiter(this, void 0, void 0, function () {
        var hari, batas, count, err_5;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    hari = env_1.env.LLM_CALL_RETENTION_DAYS;
                    if (hari <= 0)
                        return [2 /*return*/, 0];
                    batas = new Date(Date.now() - hari * 24 * 60 * 60 * 1000);
                    _a.label = 1;
                case 1:
                    _a.trys.push([1, 3, , 4]);
                    return [4 /*yield*/, prisma_1.prisma.llmCall.deleteMany({ where: { createdAt: { lt: batas } } })];
                case 2:
                    count = (_a.sent()).count;
                    if (count > 0)
                        logger_1.logger.info("[LLM] ".concat(count, " baris llm_calls lebih tua dari ").concat(hari, " hari dibuang"));
                    return [2 /*return*/, count];
                case 3:
                    err_5 = _a.sent();
                    logger_1.logger.warn("[LLM] Pembersihan llm_calls dilewati: ".concat(err_5));
                    return [2 /*return*/, 0];
                case 4: return [2 /*return*/];
            }
        });
    });
}
/**
 * Panggil model untuk satu pekerjaan.
 *
 * Retry hanya untuk galat jatah/ukuran, dengan backoff LINIER — dipindah apa
 * adanya dari question-mining.worker.ts. Galat lain dilempar langsung, supaya
 * penanganan di tiap pemanggil (yang punya semantik gagal berbeda-beda dan
 * sengaja demikian) tetap berlaku seperti sebelumnya.
 */
function complete(job, req) {
    return __awaiter(this, void 0, void 0, function () {
        var cfg, spec, _a, _b, provider, model, maxTokens, temperature, maxAttempts, jedaBackoff, attempt, mulaiTotal, mulai, pesan, badan, resp, _c, u, tersembunyi, usage, finish, latencyMs, err_6, latencyMs, kind, tunggu;
        var _d, _e, _f, _g, _h, _j, _k, _l, _m, _o, _p, _q, _r, _s, _t;
        return __generator(this, function (_u) {
            switch (_u.label) {
                case 0:
                    cfg = JOB_CONFIG[job];
                    if (!req.model) return [3 /*break*/, 1];
                    _a = (req.model.includes(':') ? req.model : "groq:".concat(req.model));
                    return [3 /*break*/, 3];
                case 1: return [4 /*yield*/, resolveModelBerlaku(job, req.businessId)];
                case 2:
                    _a = (_u.sent()).spec;
                    _u.label = 3;
                case 3:
                    spec = _a;
                    _b = parseSpec(spec), provider = _b.provider, model = _b.model;
                    maxTokens = (_d = req.maxTokens) !== null && _d !== void 0 ? _d : cfg.maxTokens;
                    temperature = (_e = req.temperature) !== null && _e !== void 0 ? _e : cfg.temperature;
                    maxAttempts = Math.max(1, env_1.env.LLM_MAX_ATTEMPTS);
                    jedaBackoff = cfg.minGapMs > 0 ? cfg.minGapMs : 2000;
                    attempt = 0;
                    mulaiTotal = Date.now();
                    _u.label = 4;
                case 4:
                    attempt++;
                    return [4 /*yield*/, waitForGap(provider, job, cfg.minGapMs)];
                case 5:
                    _u.sent();
                    mulai = Date.now();
                    _u.label = 6;
                case 6:
                    _u.trys.push([6, 11, , 14]);
                    pesan = req.messages.map(function (m) {
                        if (typeof m.content === 'string')
                            return { role: m.role, content: m.content };
                        if (m.role !== 'user') {
                            throw new Error("[LLM] job=".concat(job, ": isi pesan berupa bagian (gambar/teks) hanya sah pada ") +
                                "peran 'user', bukan '".concat(m.role, "'."));
                        }
                        return { role: 'user', content: m.content };
                    });
                    badan = __assign(__assign(__assign(__assign(__assign({ model: model, max_tokens: maxTokens, temperature: temperature }, (cfg.json ? { response_format: { type: 'json_object' } } : {})), { messages: pesan }), (PROVIDER_TANPA_BERPIKIR.has(provider) ? { reasoning_effort: 'none' } : {})), (provider === 'openrouter' && /gpt-oss/i.test(model)
                        ? { reasoning: { effort: 'low' } }
                        : {})), (provider === 'openrouter' && env_1.env.OPENROUTER_PROVIDER_ORDER && !model.includes('deepseek')
                        ? {
                            provider: {
                                order: env_1.env.OPENROUTER_PROVIDER_ORDER.split(',').map(function (x) { return x.trim(); }).filter(Boolean),
                                allow_fallbacks: false,
                            },
                        }
                        : {}));
                    if (!(provider === 'groq')) return [3 /*break*/, 8];
                    return [4 /*yield*/, groq.chat.completions.create(badan)];
                case 7:
                    _c = _u.sent();
                    return [3 /*break*/, 10];
                case 8: return [4 /*yield*/, klienUntuk(provider).chat.completions.create(badan)];
                case 9:
                    _c = _u.sent();
                    _u.label = 10;
                case 10:
                    resp = _c;
                    u = resp.usage;
                    tersembunyi = Math.max(0, ((_f = u === null || u === void 0 ? void 0 : u.total_tokens) !== null && _f !== void 0 ? _f : 0) - ((_g = u === null || u === void 0 ? void 0 : u.prompt_tokens) !== null && _g !== void 0 ? _g : 0) - ((_h = u === null || u === void 0 ? void 0 : u.completion_tokens) !== null && _h !== void 0 ? _h : 0));
                    usage = __assign(__assign({ promptTokens: (_j = u === null || u === void 0 ? void 0 : u.prompt_tokens) !== null && _j !== void 0 ? _j : 0, completionTokens: (_k = u === null || u === void 0 ? void 0 : u.completion_tokens) !== null && _k !== void 0 ? _k : 0 }, (typeof ((_l = u === null || u === void 0 ? void 0 : u.prompt_tokens_details) === null || _l === void 0 ? void 0 : _l.cached_tokens) === 'number'
                        ? { cachedTokens: u.prompt_tokens_details.cached_tokens }
                        : {})), (tersembunyi > 0 ? { reasoningTokens: tersembunyi } : {}));
                    finish = (_o = (_m = resp
                        .choices) === null || _m === void 0 ? void 0 : _m[0]) === null || _o === void 0 ? void 0 : _o.finish_reason;
                    if (finish === 'length') {
                        logger_1.logger.warn("[LLM] job=".concat(job, " ").concat(provider, ":").concat(model, " TERPOTONG (finish_reason=length, ") +
                            "max_tokens=".concat(maxTokens).concat(tersembunyi > 0 ? ", ".concat(tersembunyi, " token tersembunyi") : '', "). ") +
                            "".concat(cfg.json ? 'Pekerjaan ini butuh JSON — parse kemungkinan besar akan gagal. ' : '') +
                            "Naikkan maxTokens atau pilih model yang tidak berpikir.");
                    }
                    latencyMs = Date.now() - mulai;
                    catatPemakaian({
                        businessId: req.businessId,
                        job: job,
                        provider: provider,
                        model: model,
                        usage: usage,
                        latencyMs: latencyMs,
                        attempts: attempt, ok: true, correlationId: req.correlationId,
                    });
                    return [2 /*return*/, {
                            text: (_s = (_r = (_q = (_p = resp
                                .choices) === null || _p === void 0 ? void 0 : _p[0]) === null || _q === void 0 ? void 0 : _q.message) === null || _r === void 0 ? void 0 : _r.content) !== null && _s !== void 0 ? _s : '',
                            provider: provider,
                            model: model,
                            usage: usage,
                            latencyMs: latencyMs,
                            attempts: attempt,
                        }];
                case 11:
                    err_6 = _u.sent();
                    latencyMs = Date.now() - mulai;
                    kind = errorKind(err_6);
                    if (!(isRateLimit(err_6) && attempt < maxAttempts)) return [3 /*break*/, 13];
                    tunggu = jedaBackoff * attempt;
                    logger_1.logger.warn("[LLM] job=".concat(job, " model=").concat(model, " kena batas jatah (").concat(kind, "), ") +
                        "percobaan ".concat(attempt, "/").concat(maxAttempts, " \u2014 tunggu ").concat(Math.round(tunggu / 1000), " detik"));
                    return [4 /*yield*/, sleep(tunggu)];
                case 12:
                    _u.sent();
                    return [3 /*break*/, 14];
                case 13:
                    catatPemakaian({
                        businessId: req.businessId,
                        job: job,
                        provider: provider,
                        model: model,
                        usage: { promptTokens: 0, completionTokens: 0 },
                        latencyMs: latencyMs,
                        attempts: attempt, ok: false, errorKind: kind,
                        correlationId: req.correlationId,
                    });
                    logger_1.logger.error("[LLM] job=".concat(job, " model=").concat(model, " GAGAL setelah ").concat(attempt, " percobaan ") +
                        "(".concat(Math.round((Date.now() - mulaiTotal) / 1000), " detik, ").concat(kind, "): ") +
                        "".concat((_t = err_6 === null || err_6 === void 0 ? void 0 : err_6.message) !== null && _t !== void 0 ? _t : err_6));
                    throw err_6;
                case 14: return [3 /*break*/, 4];
                case 15: return [2 /*return*/];
            }
        });
    });
}
/** Nama model tanpa awalan provider & tanpa awalan vendor — untuk log & kolom sempit. */
function modelPendek(model) {
    return model.split(':').pop().split('/').pop();
}
