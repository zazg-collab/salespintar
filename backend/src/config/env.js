"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.env = void 0;
var zod_1 = require("zod");
var dotenv_1 = require("dotenv");
var path_1 = require("path");
dotenv_1.default.config({ path: path_1.default.resolve(__dirname, '../../.env') });
var envSchema = zod_1.z.object({
    NODE_ENV: zod_1.z.enum(['development', 'staging', 'production']).default('development'),
    PORT: zod_1.z.coerce.number().default(3000),
    API_PREFIX: zod_1.z.string().default('/api/v1'),
    DATABASE_URL: zod_1.z.string().min(1),
    REDIS_URL: zod_1.z.string().default('redis://localhost:6379'),
    REDIS_BULL_URL: zod_1.z.string().default('redis://localhost:6379/1'),
    JWT_ACCESS_SECRET: zod_1.z.string().min(32),
    JWT_REFRESH_SECRET: zod_1.z.string().min(32),
    JWT_ACCESS_EXPIRES: zod_1.z.string().default('15m'),
    JWT_REFRESH_EXPIRES: zod_1.z.string().default('7d'),
    GROQ_API_KEY: zod_1.z.string().min(1),
    // ── Kunci layanan LLM lain — Fase 82 ──────────────────────────────────────
    // `optional()` DISENGAJA: keduanya boleh kosong, dan sistem tetap jalan penuh
    // selama tidak ada pekerjaan yang diarahkan ke layanan itu. Yang memeriksa
    // "kunci ada untuk layanan yang BENAR-BENAR dipakai" adalah
    // `validateLlmConfig()` saat bootstrap — bukan zod, karena zod tidak tahu
    // pekerjaan mana yang dipetakan ke mana.
    /**
     * Alamat yang di-ikat `httpServer.listen()` — Fase 86.
     *
     * Bawaannya `127.0.0.1`, BUKAN `0.0.0.0`. Sebelum fase ini `listen()` dipanggil
     * tanpa alamat, jadi Node mengikat SELURUH antarmuka: di server produksi port
     * 3000 terbuka ke internet dan yang menahannya cuma aturan CSF. Terpantau
     * 31 Juli 2026: `LISTEN [::]:3000`. Pertahanan berlapisnya bekerja, tapi ia
     * satu-satunya lapis — dan lapis tunggal bukan lapisan.
     *
     * Bisa disetel, bukan dipaku, karena jawabannya bergantung cara menjalankan:
     * compose kita memakai `network_mode: host` sehingga nginx menjangkaunya lewat
     * localhost. Kalau suatu hari dipindah ke jaringan bridge, `127.0.0.1` akan
     * membuatnya TIDAK BISA dihubungi — dan itu harus bisa diperbaiki lewat env,
     * bukan lewat rilis kode.
     */
    SERVER_BIND_HOST: zod_1.z.string().default('127.0.0.1'),
    /**
     * ── Katalog gambar (Fase 88) ───────────────────────────────────────────────
     * Folder berisi gambar yang boleh dikirim ke pelanggan. Relatif dihitung dari
     * cwd proses (WORKDIR `/app`), jadi bawaannya menunjuk `/app/uploads/katalog`
     * yang di server sudah bind-mount ke `/opt/salespintar-data/uploads/katalog` —
     * artinya menambah gambar cukup taruh berkas, tidak perlu rilis apa pun.
     *
     * KATALOG_AKTIF sengaja ada dan bawaannya `true`: kalau suatu hari ada gambar
     * salah terkirim, harus ada satu saklar yang mematikan seluruh jalur ini tanpa
     * menunggu rilis kode. Mematikan fitur lewat menghapus folder itu bukan saklar,
     * itu kecelakaan yang menyerupai saklar.
     */
    // Bentuk transform, BUKAN z.coerce.boolean() — lihat peringatan di LLM_LOG_CALLS:
    // Boolean('false') === true, jadi saklar darurat yang diisi "false" justru menyala.
    KATALOG_AKTIF: zod_1.z.string().default('true')
        .transform(function (v) { return v !== 'false' && v !== '0' && v !== ''; }),
    KATALOG_DIR: zod_1.z.string().default('uploads/katalog'),
    KATALOG_MAKS_BYTE: zod_1.z.coerce.number().default(5 * 1024 * 1024),
    /** Jeda kirim-ulang gambar yang sama ke lead yang sama, dalam jam. 0 = tanpa jeda. */
    KATALOG_JEDA_ULANG_JAM: zod_1.z.coerce.number().default(6),
    /**
     * Kalau balasan memuat penanda gambar tapi berkasnya tidak ada, percakapan
     * diserahkan ke CS. Bawaannya `true`: janji yang tidak bisa ditepati lebih baik
     * ditangani manusia daripada dibiarkan menggantung tanpa ada yang tahu.
     */
    KATALOG_HANDOVER_SAAT_HILANG: zod_1.z.string().default('true')
        .transform(function (v) { return v !== 'false' && v !== '0' && v !== ''; }),
    GOOGLE_API_KEY: zod_1.z.string().optional(),
    OPENROUTER_API_KEY: zod_1.z.string().optional(),
    // Penjual ulang OpenAI-compatible (api.gutstore.my.id). Opsional: kalau tidak
    // diisi, layanan ini cuma tidak muncul sebagai pilihan — tidak ada yang rusak.
    GUTSTORE_API_KEY: zod_1.z.string().optional(),
    /**
     * Penyedia hulu OpenRouter yang boleh dipakai, urut prioritas, dipisah koma.
     *
     * Kosongkan untuk membiarkan OpenRouter memilih sendiri — TIDAK disarankan:
     * 13 penyedia menjual model yang sama dengan kuantisasi dan mutu berbeda, dan
     * salah satunya terbukti mengembalikan sampah (lihat komentar di `llm.ts`).
     */
    OPENROUTER_PROVIDER_ORDER: zod_1.z.string().default('Groq'),
    GROQ_MODEL: zod_1.z.string().default('llama-3.1-8b-instant'),
    GROQ_FALLBACK_MODEL: zod_1.z.string().default('mixtral-8x7b-32768'),
    GROQ_MAX_TOKENS: zod_1.z.coerce.number().default(1024),
    GROQ_TEMPERATURE: zod_1.z.coerce.number().default(0.7),
    GROQ_DAILY_CAP_PER_LEAD: zod_1.z.coerce.number().default(50),
    WA_SESSIONS_DIR: zod_1.z.string().default('./wa_sessions'),
    WA_MAX_CONNECTIONS: zod_1.z.coerce.number().default(50),
    CORS_ORIGIN: zod_1.z.string().default('http://localhost:5173'),
    RATE_LIMIT_WINDOW_MS: zod_1.z.coerce.number().default(60000),
    RATE_LIMIT_MAX: zod_1.z.coerce.number().default(100),
    // Fix B5: umur cache identitas user di Redis. Semakin besar semakin hemat
    // query DB, tapi semakin lama pula user yang dinonaktifkan masih bisa akses.
    AUTH_CACHE_TTL_SEC: zod_1.z.coerce.number().default(60),
    // Fix C10: pembatas laju khusus endpoint import lead (per business).
    IMPORT_RATE_LIMIT_WINDOW_MS: zod_1.z.coerce.number().default(15 * 60 * 1000),
    IMPORT_RATE_LIMIT_MAX: zod_1.z.coerce.number().default(5),
    // Berapa potongan pengetahuan yang ditempel ke perintah AI. Naik dari 3 ke 6
    // karena dokumen sekarang dipecah jadi potongan — 6 potongan kira-kira
    // sebanding dengan 3 dokumen utuh sebelumnya.
    KNOWLEDGE_TOP_K: zod_1.z.coerce.number().default(6),
    // Batas keras panjang konteks. Ini yang sebenarnya menjaga jatah token Groq;
    // menghitung jumlah dokumen saja tidak cukup karena panjang tiap potongan
    // berbeda-beda.
    KNOWLEDGE_CONTEXT_MAX_CHARS: zod_1.z.coerce.number().default(6000),
    // ── Mengantar: cek ongkir sungguhan ──────────────────────────────────────
    // Semuanya opsional. Tanpa MENGANTAR_API_KEY, fiturnya sekadar tidak aktif dan
    // bot kembali menjelaskan cara hitung ongkir tanpa menyebut angka.
    //
    // ⚠️ Kunci ini ikut masuk ke dalam ALAMAT URL (bukan header) — itu ketentuan
    // dari pihak Mengantar. Jangan pernah mencetak alamat lengkapnya ke log.
    MENGANTAR_BASE_URL: zod_1.z.string().default('https://app.mengantar.com'),
    MENGANTAR_API_KEY: zod_1.z.string().optional(),
    /** Kode lokasi gudang. Kalau kosong, dicari dari MENGANTAR_ORIGIN_KEYWORD. */
    MENGANTAR_ORIGIN_ID: zod_1.z.string().optional(),
    /** Nama kota/kecamatan gudang, dipakai kalau ORIGIN_ID belum diketahui. */
    MENGANTAR_ORIGIN_KEYWORD: zod_1.z.string().optional(),
    /** Berat yang diasumsikan kalau pelanggan tidak menyebutkannya. */
    MENGANTAR_DEFAULT_WEIGHT_KG: zod_1.z.coerce.number().default(1),
    /**
     * Selisih tarif (persen) di bawah mana kota tujuan yang ambigu TIDAK perlu
     * ditanyakan lagi ke pelanggan.
     *
     * Dari pengukuran 30 Juli 2026: empat kecamatan di Bandung memberi selisih NOL
     * pada sembilan dari sepuluh ekspedisi — ambiguitas semacam itu cuma bikin
     * pelanggan mengetik tanpa guna. Sebaliknya Kota Surabaya vs kecamatan Surabaya
     * di Lampung berselisih 127-186%, dan itu wajib ditanyakan.
     *
     * Dinaikkan = bot lebih jarang bertanya tapi lebih sering menanggung selisih.
     * Diturunkan = lebih aman, tapi pelanggan lebih sering ditanya.
     */
    MENGANTAR_SAFE_GAP_PERCENT: zod_1.z.coerce.number().default(10),
    // ── Fase 40 (2026-08-20): kunci enkripsi generik (crypto.service.ts) ──────
    // OPSIONAL, sama seperti MENGANTAR_API_KEY dkk: kalau kosong, server tetap start
    // penuh -- fitur yang butuh enkripsi (Meta CAPI access token) sekadar belum bisa
    // dipakai sampai ini diisi. Divalidasi LAZY oleh crypto.service.ts::getKey() saat
    // benar-benar dipanggil, bukan di sini, supaya boot tidak pernah gagal gara-gara
    // integrasi opsional yang belum dikonfigurasi.
    // WAJIB 64 karakter hex (32 byte). Generate dengan:
    //   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
    ENCRYPTION_KEY: zod_1.z.string().optional(),
    // Ingatan jawaban untuk pertanyaan berulang.
    // Diperbaiki Fase 65 (dulu `z.coerce.boolean()`): mematikan ingatan jawaban dengan
    // menulis "false" TIDAK BERFUNGSI, karena Boolean('false') === true.
    ANSWER_CACHE_ENABLED: zod_1.z.string().default('true')
        .transform(function (v) { return v !== 'false' && v !== '0' && v !== ''; }),
    ANSWER_CACHE_TTL_SEC: zod_1.z.coerce.number().default(6 * 60 * 60),
    // Notifikasi admin lewat Telegram. Keduanya opsional — kalau kosong, fitur
    // notifikasinya sekadar tidak aktif, tidak bikin server gagal start.
    TELEGRAM_BOT_TOKEN: zod_1.z.string().optional(),
    TELEGRAM_CHAT_ID: zod_1.z.string().optional(),
    LOG_LEVEL: zod_1.z.string().default('info'),
    LOG_DIR: zod_1.z.string().default('./logs'),
    /**
     * Tulis log ke BERKAS, bukan cuma ke terminal.
     *
     * ⚠️ Dulu berkas log hanya ditulis kalau `NODE_ENV === 'production'` (lihat
     * utils/logger.ts). Di development satu-satunya jejaknya ada di terminal yang
     * menjalankan `tsx watch` — dan itu berarti setiap pertanyaan "kok angkanya
     * masih 0?" hanya bisa dijawab dengan menebak, atau dengan meminta Angga
     * menyalin log secara manual. Pada 30 Juli 2026 itu terjadi EMPAT putaran
     * berturut-turut untuk satu gejala.
     *
     * Development justru saat log paling dibutuhkan. Bawaannya sekarang menyala di
     * lingkungan apa pun.
     */
    LOG_TO_FILE: zod_1.z.string().default('true')
        .transform(function (v) { return v !== 'false' && v !== '0' && v !== ''; }),
    // Diperbaiki Fase 65 (dulu `z.coerce.boolean()`): mematikan correlation id di log dengan
    // menulis "false" TIDAK BERFUNGSI, karena Boolean('false') === true.
    LOG_CORRELATION_ENABLED: zod_1.z.string().default('true')
        .transform(function (v) { return v !== 'false' && v !== '0' && v !== ''; }),
    SENTRY_DSN: zod_1.z.string().default(''),
    SENTRY_ENVIRONMENT: zod_1.z.string().default('development'),
    BROADCAST_BATCH_SIZE: zod_1.z.coerce.number().default(20),
    BROADCAST_THROTTLE_MS: zod_1.z.coerce.number().default(3000),
    BROADCAST_MAX_RETRIES: zod_1.z.coerce.number().default(3),
    // ── Obsidian CS Brain Watcher ─────────────────────────────────────────────
    OBSIDIAN_CS_PATH: zod_1.z.string().default('/Users/anggafatih/SalesPintar-CS-Brain'),
    OBSIDIAN_WATCHER_DEBOUNCE_MS: zod_1.z.coerce.number().default(2000),
    // ── Model embedding untuk RAG ─────────────────────────────────────────────
    // Default diganti dari all-MiniLM-L6-v2 (dominan Inggris) ke varian
    // multibahasa. Dimensinya sama-sama 384, jadi kolom vector(384) di schema
    // tidak berubah dan tidak perlu migrasi. WAJIB resync vault setelah ganti —
    // embedding lama dihitung dengan model lain dan tidak sebanding.
    // Keluarga E5 dilatih KHUSUS untuk pencarian dokumen, bukan sekadar kemiripan
    // kalimat — dan pencarian dokumen persis pekerjaan yang dibutuhkan RAG di sini.
    // Dimensinya tetap 384 (terverifikasi dari config.json HF), jadi kolom
    // vector(384) tidak berubah.
    //
    // ⚠️ Model E5 MEWAJIBKAN awalan: "query: " untuk pertanyaan dan "passage: "
    // untuk dokumen. Kalau awalannya lupa dipasang, kualitas pencariannya justru
    // TURUN di bawah model biasa. Penanganannya ada di knowledge.service.ts —
    // jangan panggil getEmbedding tanpa menyebut jenisnya.
    EMBEDDING_MODEL: zod_1.z.string().default('Xenova/multilingual-e5-small'),
    // Awalan bisa dimatikan kalau suatu saat pindah ke model non-E5.
    // Diperbaiki Fase 65 (dulu `z.coerce.boolean()`): mematikan awalan query:/passage: E5 dengan
    // menulis "false" TIDAK BERFUNGSI, karena Boolean('false') === true.
    EMBEDDING_USE_E5_PREFIX: zod_1.z.string().default('true')
        .transform(function (v) { return v !== 'false' && v !== '0' && v !== ''; }),
    // ── Shadow Mining (Fase 3) ────────────────────────────────────────────────
    GROQ_EXTRACTOR_MODEL: zod_1.z.string().default('llama-3.3-70b-versatile'),
    SHADOW_MINING_MODE: zod_1.z.enum(['auto', 'draft']).default('draft'),
    SHADOW_MINING_MIN_MESSAGES: zod_1.z.coerce.number().default(4),
    SHADOW_MINING_SIMILARITY_THRESHOLD: zod_1.z.coerce.number().default(0.9),
    // ── Human Learning: buffer & flush ────────────────────────────────────────
    // Dipindah ke sini dari konstanta di human-learning.service.ts, sekaligus
    // memperbaiki cacat: buffer yang tidak pernah mencapai ambang baris DULU
    // dihapus Redis lewat TTL, bukan dikirim ke Shadow Mining. Docstring servicenya
    // mengklaim ada "BullMQ delayed job" yang memeriksa idle — job itu tidak pernah
    // dibuat, dan akibatnya percakapan pendek (mayoritas chat CS) hilang tanpa
    // pernah ditambang. Ditemukan 30 Juli 2026 saat pemakaian nyata: 37 pesan
    // terbalas, 0 fakta disimpan.
    /**
     * Minimal baris supaya sebuah buffer layak dikirim.
     *
     * ⚠️ TURUN dari 4 ke 2 di Fase 69, dan alasannya penting.
     *
     * Dengan ambang 4, buffer berisi 1-3 baris tidak akan PERNAH dikirim: penyapu
     * melewatinya setiap putaran, lalu Redis membuangnya saat TTL habis. Terlihat
     * nyata di dashboard 30 Juli — satu sesi CS punya empat kontak berisi 1, 1, 1,
     * dan 3 baris; yang 3 baris sudah 55 menit idle dengan TTL 60 menit, jadi lima
     * menit lagi hilang. Sesi itu mencatat 40 balasan CS dan 0 fakta, dan **akan
     * tetap 0 selamanya** karena pola percakapannya tidak pernah mencapai 4 baris.
     *
     * Yang salah bukan angkanya, tapi ADANYA penilaian ini di sini. Menghakimi
     * "percakapan ini terlalu remeh untuk dipelajari" adalah tugas **Lapis 1**
     * (`classify`) — ia memang dibangun untuk itu, memakai model termurah, dan
     * hasilnya DILAPORKAN ke dashboard sebagai "basa-basi/dibuang". Hitungan baris
     * di Redis melakukan penilaian yang sama dengan aturan yang jauh lebih tumpul,
     * lebih awal, dan **tanpa meninggalkan jejak** — data hilang dan angkanya nol
     * tanpa keterangan.
     *
     * Dua penilaian untuk satu keputusan, dan yang lebih bodoh menang karena ia
     * lebih dulu. Jadi ambangnya diturunkan ke batas yang benar-benar berarti: 2 =
     * minimal satu tukar-kata (pertanyaan pembeli + jawaban CS). Itu atom terkecil
     * yang masih bisa dipelajari. Sisanya diserahkan ke Lapis 1, yang murah dan
     * jujur.
     *
     * Biayanya: satu panggilan `classify` (llama-3.1-8b-instant, ~150 token) per
     * buffer kecil. Dibandingkan kehilangan seluruh pembelajaran satu CS, itu tidak
     * sebanding untuk diperdebatkan.
     */
    HL_BUFFER_MIN_MESSAGES: zod_1.z.coerce.number().default(2),
    /** Kirim SEKETIKA begitu buffer mencapai jumlah baris ini. Dulu 20 (hardcode). */
    HL_BUFFER_FLUSH_AT_LINES: zod_1.z.coerce.number().default(10),
    /** Detik tanpa pesan baru sebelum buffer dikirim. Dulu 1800 (30 menit). */
    HL_BUFFER_IDLE_SEC: zod_1.z.coerce.number().default(600),
    /** Seberapa sering penyapu memeriksa buffer yang idle. */
    HL_IDLE_CHECK_INTERVAL_SEC: zod_1.z.coerce.number().default(300),
    // ── Routing model per PEKERJAAN (lihat src/services/llm.ts) ───────────────
    //
    // Sembilan tombol untuk sembilan pekerjaan yang sifatnya berbeda. Sebelum ini
    // lima di antaranya berbagi satu `GROQ_MODEL`, jadi menaikkan kualitas
    // balasan pelanggan otomatis menaikkan biaya klasifikasi spam.
    //
    // Semuanya OPSIONAL, dan itu disengaja: kalau dibiarkan kosong, `llm.ts`
    // mewarisi `GROQ_EXTRACTOR_MODEL` untuk `extract`/`publish`,
    // `GROQ_FALLBACK_MODEL` untuk `fallback`, dan `GROQ_MODEL` untuk sisanya —
    // yaitu tepat pembagian yang berlaku sebelum lapisan ini ada. Jadi memasang
    // lapisan ini TIDAK mengubah perilaku sampai ada yang mengisi tombolnya.
    //
    // Bentuk nilai: "<provider>:<model>", mis. "groq:openai/gpt-oss-120b".
    // Tanpa awalan dianggap "groq:". Provider selain `groq` belum diimplementasi
    // dan akan MELEDAK saat bootstrap (bukan saat pesan pertama masuk).
    LLM_MODEL_REPLY: zod_1.z.string().optional(),
    LLM_MODEL_FALLBACK: zod_1.z.string().optional(),
    LLM_MODEL_INTENT: zod_1.z.string().optional(),
    LLM_MODEL_SUPERVISOR: zod_1.z.string().optional(),
    LLM_MODEL_CLASSIFY: zod_1.z.string().optional(),
    LLM_MODEL_GATEKEEPER: zod_1.z.string().optional(),
    LLM_MODEL_EXTRACT: zod_1.z.string().optional(),
    LLM_MODEL_MINER: zod_1.z.string().optional(),
    LLM_MODEL_PUBLISH: zod_1.z.string().optional(),
    LLM_MODEL_AUDIT: zod_1.z.string().optional(),
    // ── Model penglihatan (gambar dari pelanggan) — Fase 65 ─────────────────────
    // SENGAJA tidak mewarisi GROQ_MODEL seperti delapan tombol lainnya. Warisan itu
    // masuk akal untuk pekerjaan teks; di sini justru berbahaya, sebab
    // `llama-3.3-70b-versatile` TIDAK BISA melihat gambar dan kegagalannya baru
    // muncul saat pelanggan sungguhan mengirim foto. Bawaan kerasnya ada di
    // services/llm.ts (`BAWAAN_VISION`).
    LLM_MODEL_VISION: zod_1.z.string().optional(),
    /**
     * Matikan seluruh pembacaan gambar tanpa mengubah kode. Caption tetap dibaca.
     * Bentuk `z.string().transform`, bukan `z.coerce.boolean()` — alasannya di
     * catatan LLM_LOG_CALLS di bawah.
     */
    VISION_ENABLED: zod_1.z.string().default('true')
        .transform(function (v) { return v !== 'false' && v !== '0' && v !== ''; }),
    /**
     * Batas ukuran gambar yang dikirim ke model, dalam byte.
     * Groq membatasi 4 MB untuk gambar base64 (20 MB hanya untuk URL). Repo ini
     * mengirim base64 karena media WhatsApp harus diunduh & didekripsi dulu —
     * tidak ada URL publik yang bisa diberikan.
     */
    VISION_MAX_IMAGE_BYTES: zod_1.z.coerce.number().default(4000000),
    /**
     * Batas gambar per pelanggan per hari. Gambar JAUH lebih mahal daripada teks
     * (`qwen/qwen3.6-27b` $3,00 per 1M token keluar, ~5x 70B) dan satu orang bisa
     * mengirim 30 foto dalam semenit tanpa niat jahat.
     */
    VISION_DAILY_CAP_PER_LEAD: zod_1.z.coerce.number().default(10),
    /**
     * Jeda minimal antar pesan "boleh diketik saja" ke satu pelanggan, dalam detik.
     * Tanpa ini, lima stiker berturut-turut dijawab lima kali — dan itu terlihat
     * lebih rusak daripada diam.
     */
    MEDIA_HINT_COOLDOWN_SEC: zod_1.z.coerce.number().default(600),
    // Jarak minimal antar panggilan per pekerjaan. Nilai `MINER` dipindah dari
    // konstanta `MIN_GAP_MS` yang tadinya hardcode di question-mining.worker.ts —
    // komentar di sana sendiri sudah mengakui "kalau naik ke tier berbayar cukup
    // kecilkan MIN_GAP_MS", yang artinya edit kode untuk hal yang seharusnya env.
    LLM_MIN_GAP_MS_MINER: zod_1.z.coerce.number().default(21000),
    LLM_MIN_GAP_MS_PUBLISH: zod_1.z.coerce.number().default(0),
    LLM_MAX_ATTEMPTS: zod_1.z.coerce.number().default(4),
    // Masa simpan baris `llm_calls`. ~9 baris per giliran pelanggan, jadi tanpa
    // batas ini tabelnya tumbuh tanpa henti. 0 = jangan pernah dibersihkan.
    LLM_CALL_RETENTION_DAYS: zod_1.z.coerce.number().default(30),
    // ⚠️ SENGAJA `z.string().transform`, BUKAN `z.coerce.boolean()`.
    // `z.coerce.boolean()` memakai Boolean(v), dan Boolean('false') === true —
    // jadi tombol yang diisi "false" justru menyala.
    //
    // Catatan sebelumnya di sini berbunyi cacat yang sama "masih ada di
    // EMBEDDING_USE_E5_PREFIX; tidak disentuh di fase ini". Sudah diperbaiki di
    // Fase 65, bersama ANSWER_CACHE_ENABLED dan LOG_CORRELATION_ENABLED. Tidak ada
    // lagi `z.coerce.boolean()` di berkas ini — kalau ada yang muncul lagi, itu
    // tombol yang tidak bisa dimatikan.
    LLM_LOG_CALLS: zod_1.z.string().default('true')
        .transform(function (v) { return v !== 'false' && v !== '0' && v !== ''; }),
});
var parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
    console.error('Invalid environment variables:', parsed.error.flatten());
    process.exit(1);
}
exports.env = parsed.data;
