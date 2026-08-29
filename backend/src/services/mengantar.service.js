"use strict";
/**
 * Sambungan ke API Mengantar — cek ongkir sungguhan.
 *
 * ── Kenapa ongkir tidak bisa jadi dokumen ───────────────────────────────────
 * Ongkir adalah fungsi dari (kota asal, kota tujuan, berat). Kombinasinya ratusan
 * ribu dan berubah tiap kali ekspedisi menyesuaikan tarif. Tidak ada jumlah
 * dokumen Obsidian yang bisa menampungnya. Satu-satunya jawaban benar adalah
 * menanyakannya pada saat pelanggan bertanya.
 *
 * ── Keputusan rancangan yang paling penting ─────────────────────────────────
 * Hasil dari API ini TIDAK diberi izin khusus untuk melewati pengaman
 * anti-halusinasi. Sebagai gantinya, hasilnya disuntikkan sebagai POTONGAN
 * PENGETAHUAN SEMENTARA ke dalam konteks yang dipakai menyusun jawaban.
 *
 * Efeknya: waktu Supervisor memeriksa "apakah angka ini ada di pengetahuan?",
 * tarif dari Mengantar memang sudah ada di sana — jadi lolos dengan sendirinya.
 * Tidak ada satu pun pengaman yang dilonggarkan, dan tidak ada daftar-putih
 * angka yang perlu dipelihara. Kalau nanti API-nya mati, yang terjadi cuma bot
 * kembali tidak tahu ongkir — bukan bot yang tiba-tiba boleh mengarang angka.
 *
 * ── Catatan keamanan ────────────────────────────────────────────────────────
 * Mengantar menaruh kunci API DI DALAM ALAMAT URL, bukan di header. Artinya
 * kunci itu ikut tercatat di setiap log yang mencatat URL. Karena itu di modul
 * ini alamat lengkap TIDAK PERNAH masuk ke log — yang dicatat hanya nama
 * endpoint-nya. Jangan menambahkan `logger.info(url)` di mana pun di sini.
 */
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
exports.MengantarService = exports.__NAMA_EKSPEDISI = exports.__PETA_COD = void 0;
exports.isMengantarEnabled = isMengantarEnabled;
exports.searchLocations = searchLocations;
exports.resolveOriginId = resolveOriginId;
exports.__namaEkspedisi = namaEkspedisi;
exports.__statusCod = statusCod;
exports.getShippingQuotes = getShippingQuotes;
exports.getShippingQuotesForChoice = getShippingQuotesForChoice;
exports.quotesToKnowledgeChunk = quotesToKnowledgeChunk;
exports.askInstruction = askInstruction;
exports.unresolvedToKnowledgeChunk = unresolvedToKnowledgeChunk;
var env_1 = require("../config/env");
var logger_1 = require("../utils/logger");
var redis_1 = require("../config/redis");
var location_resolver_1 = require("../utils/location-resolver");
var place_aliases_1 = require("../utils/place-aliases");
/**
 * Awalan kunci cache, DENGAN nomor bentuk.
 *
 * ── Kejadian yang membuat nomor ini ada ─────────────────────────────────────
 * Versi modul ini sebelum Fase 38 menyimpan balasan API apa adanya — termasuk
 * pembungkus `{ success, data }`. Fase 38 memperbaiki pembacaannya, tapi entri
 * cache yang sudah tersimpan tetap berbentuk lama, dan masa berlakunya 30 HARI.
 *
 * Akibatnya, sebulan sesudah bug-nya diperbaiki, pencarian "surabaya" masih
 * mengembalikan objek (bukan array). `collectCandidates` memeriksa
 * `Array.isArray(rows)`, gagal, lalu melapor nol kandidat — dan bot menjawab
 * "ongkir ke Surabaya perlu saya cek dulu" persis seperti sebelum integrasi
 * Mengantar ada. Kodenya sudah benar; cache-nya yang masih menyajikan jawaban
 * dari kode yang rusak. Terpantau 30 Juli 2026.
 *
 * NAIKKAN nomor ini setiap kali bentuk yang disimpan berubah. Dengan begitu
 * entri lama ditinggalkan sendiri, tanpa perlu ada yang ingat membersihkan
 * Redis secara manual — dan "ingat membersihkan Redis" bukan hal yang boleh
 * diandalkan.
 */
var CACHE_PREFIX = 'salespintar:mengantar:v2';
/**
 * Daftar lokasi praktis tidak pernah berubah, jadi hasil yang BERISI boleh
 * disimpan lama.
 */
var ADDRESS_TTL_SEC = 30 * 24 * 60 * 60;
/**
 * Tapi hasil KOSONG hanya sebentar.
 *
 * Niat aslinya benar: tanpa menyimpan hasil kosong, pelanggan yang salah ketik
 * nama kota memicu panggilan API berulang tiap kali ia mengirim ulang pesannya.
 * Yang salah masa berlakunya. "Tidak ketemu" disimpan 30 hari berarti setiap
 * gangguan sesaat — API sedang bermasalah, kunci sempat salah, jaringan
 * terputus — ikut terkunci sebulan untuk kota itu.
 *
 * Sepuluh menit tetap menahan pengiriman berulang dalam satu percakapan, tanpa
 * mengubah kegagalan sesaat jadi kerusakan panjang.
 */
var EMPTY_ADDRESS_TTL_SEC = 10 * 60;
/** Tarif bisa berubah; sehari cukup untuk memangkas panggilan berulang. */
var ESTIMATE_TTL_SEC = 12 * 60 * 60;
var REQUEST_TIMEOUT_MS = 12000;
function isMengantarEnabled() {
    return Boolean(env_1.env.MENGANTAR_API_KEY && env_1.env.MENGANTAR_BASE_URL);
}
function endpoint(path) {
    var base = env_1.env.MENGANTAR_BASE_URL.replace(/\/+$/, '');
    return "".concat(base, "/api/public/").concat(env_1.env.MENGANTAR_API_KEY).concat(path);
}
/**
 * Pemanggil dasar. Semua galat berhenti di sini dan menghasilkan `null` —
 * ongkir adalah pelengkap, bukan syarat. Kalau layanannya sedang bermasalah,
 * pelanggan tetap harus mendapat jawaban, cuma tanpa angka.
 */
function call(path, label) {
    return __awaiter(this, void 0, void 0, function () {
        var data;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, callWithStatus(path, label)];
                case 1:
                    data = (_a.sent()).data;
                    return [2 /*return*/, data];
            }
        });
    });
}
/**
 * Versi yang ikut melaporkan kode status.
 *
 * Dibutuhkan karena 404 punya arti yang BERBEDA dari kegagalan lain: 404 berarti
 * endpoint-nya memang tidak ada, dan mencobanya lagi selamanya tidak akan pernah
 * berhasil. Kegagalan lain (500, timeout, jaringan) itu sesaat dan layak dicoba
 * ulang. Versi lama menyamakan keduanya sebagai `null`, sehingga endpoint yang
 * tidak pernah ada tetap ditembak pada SETIAP permintaan tarif.
 */
function callWithStatus(path_1, label_1) {
    return __awaiter(this, arguments, void 0, function (path, label, diamkanGalat) {
        var controller, timer, res, err_1, msg;
        var _a;
        if (diamkanGalat === void 0) { diamkanGalat = false; }
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    controller = new AbortController();
                    timer = setTimeout(function () { return controller.abort(); }, REQUEST_TIMEOUT_MS);
                    _b.label = 1;
                case 1:
                    _b.trys.push([1, 4, 5, 6]);
                    return [4 /*yield*/, fetch(endpoint(path), {
                            method: 'GET',
                            headers: { Accept: 'application/json' },
                            signal: controller.signal,
                        })];
                case 2:
                    res = _b.sent();
                    if (!res.ok) {
                        // Sengaja hanya label, BUKAN url — url memuat kunci API.
                        if (!diamkanGalat)
                            logger_1.logger.warn("[Mengantar] ".concat(label, " gagal (HTTP ").concat(res.status, ")"));
                        return [2 /*return*/, { data: null, status: res.status }];
                    }
                    _a = {};
                    return [4 /*yield*/, res.json()];
                case 3: return [2 /*return*/, (_a.data = (_b.sent()), _a.status = res.status, _a)];
                case 4:
                    err_1 = _b.sent();
                    msg = err_1 instanceof Error ? err_1.message : String(err_1);
                    if (!diamkanGalat)
                        logger_1.logger.warn("[Mengantar] ".concat(label, " gagal: ").concat(msg));
                    return [2 /*return*/, { data: null, status: null }];
                case 5:
                    clearTimeout(timer);
                    return [7 /*endfinally*/];
                case 6: return [2 /*return*/];
            }
        });
    });
}
/**
 * Buka bungkus balasan.
 *
 * Mengantar membungkus hasilnya di dalam `{ success, data }`, bukan
 * mengembalikan array atau objek telanjang. Versi pertama modul ini membaca
 * balasan apa adanya sehingga selalu menganggapnya kosong — pencarian lokasi
 * "berhasil" di alat uji tapi gagal total di aplikasi, padahal keduanya menembak
 * alamat yang sama.
 *
 * Ditulis menerima DUA bentuk sekaligus supaya tidak pecah lagi kalau nanti
 * bentuknya berubah, dan supaya endpoint yang kebetulan tidak membungkus tetap
 * terbaca.
 */
function unwrap(res) {
    if (res === null || res === undefined)
        return null;
    if (Array.isArray(res))
        return res;
    if (res.data !== undefined && res.data !== null)
        return res.data;
    if (res.result !== undefined && res.result !== null)
        return res.result;
    // `success: false` berarti API menjawab tapi menolak permintaannya.
    if (res.success === false)
        return null;
    return res;
}
/**
 * Cari lokasi. Mengembalikan SELURUH baris, bukan cuma yang pertama.
 *
 * Versi sebelumnya langsung mengambil baris pertama, dan itu sumber bahaya yang
 * paling halus di seluruh fitur ini: kalau baris pertama meleset, yang terjadi
 * bukan galat melainkan tarif yang benar untuk kota yang salah. Pemilihan
 * sekarang diserahkan ke `collectCandidates`, dan kalau kandidatnya lebih dari
 * satu, tarif tiap kandidat dibandingkan dulu sebelum ada yang dikutip.
 */
function searchLocations(keyword) {
    return __awaiter(this, void 0, void 0, function () {
        var clean, key, cached, parsed, _a, raw, rows, list, ttl, _b;
        return __generator(this, function (_c) {
            switch (_c.label) {
                case 0:
                    clean = keyword.trim().toLowerCase();
                    if (clean.length < 3)
                        return [2 /*return*/, []];
                    key = "".concat(CACHE_PREFIX, ":loc:").concat(clean);
                    _c.label = 1;
                case 1:
                    _c.trys.push([1, 3, , 4]);
                    return [4 /*yield*/, redis_1.redisCache.get(key)];
                case 2:
                    cached = _c.sent();
                    if (cached) {
                        parsed = JSON.parse(cached);
                        // ── Cache itu masukan dari luar, bukan nilai yang sudah pasti ─────────
                        // Dulu di sini langsung `JSON.parse(cached) as MengantarLocation[]`.
                        // Kata `as` itu janji kepada pemeriksa tipe, BUKAN pemeriksaan — dan
                        // isi Redis bisa saja ditulis oleh versi kode yang sudah tidak ada lagi.
                        // Ketika yang tersimpan ternyata objek `{success,data}` dari versi lama,
                        // ia mengalir jauh ke dalam sebagai "daftar alamat" dan baru terlihat
                        // sebagai "kota tidak ketemu" — gejala yang menunjuk ke arah yang salah.
                        if (Array.isArray(parsed))
                            return [2 /*return*/, parsed];
                        logger_1.logger.warn("[Mengantar] Cache \"".concat(clean, "\" bentuknya bukan daftar \u2014 diabaikan, ambil ulang dari API"));
                    }
                    return [3 /*break*/, 4];
                case 3:
                    _a = _c.sent();
                    return [3 /*break*/, 4];
                case 4: return [4 /*yield*/, call("/address/search?keyword=".concat(encodeURIComponent(clean)), 'pencarian lokasi')];
                case 5:
                    raw = _c.sent();
                    rows = unwrap(raw);
                    list = Array.isArray(rows) ? rows : [];
                    _c.label = 6;
                case 6:
                    _c.trys.push([6, 8, , 9]);
                    ttl = list.length > 0 ? ADDRESS_TTL_SEC : EMPTY_ADDRESS_TTL_SEC;
                    return [4 /*yield*/, redis_1.redisCache.set(key, JSON.stringify(list), 'EX', ttl)];
                case 7:
                    _c.sent();
                    return [3 /*break*/, 9];
                case 8:
                    _b = _c.sent();
                    return [3 /*break*/, 9];
                case 9: return [2 /*return*/, list];
            }
        });
    });
}
// CATATAN: dulu ada `searchLocation()` yang mengembalikan baris pertama saja.
// Sengaja DIHAPUS, bukan dibiarkan menganggur. Fungsi seperti itu terlihat wajar
// dan enak dipakai, lalu suatu hari dipanggil untuk tujuan pengiriman — dan hasil
// yang keluar bukan galat melainkan tarif yang benar untuk kota yang salah.
// Sudah terbukti: baris pertama untuk "bandung" ada di Kab. Tangerang.
/**
 * Kode lokasi gudang. Dicari sekali lalu diingat — asal kirim tidak berubah-ubah,
 * jadi mencarinya setiap kali pelanggan bertanya cuma pemborosan.
 */
var cachedOriginId = null;
function resolveOriginId() {
    return __awaiter(this, void 0, void 0, function () {
        var alias, query, rows, cands, id;
        var _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    if (env_1.env.MENGANTAR_ORIGIN_ID)
                        return [2 /*return*/, env_1.env.MENGANTAR_ORIGIN_ID];
                    if (cachedOriginId)
                        return [2 /*return*/, cachedOriginId];
                    if (!env_1.env.MENGANTAR_ORIGIN_KEYWORD) {
                        logger_1.logger.warn('[Mengantar] MENGANTAR_ORIGIN_ID dan MENGANTAR_ORIGIN_KEYWORD dua-duanya kosong — ongkir tidak bisa dihitung');
                        return [2 /*return*/, null];
                    }
                    alias = (0, place_aliases_1.lookupAlias)(env_1.env.MENGANTAR_ORIGIN_KEYWORD);
                    query = (_a = alias === null || alias === void 0 ? void 0 : alias.query) !== null && _a !== void 0 ? _a : env_1.env.MENGANTAR_ORIGIN_KEYWORD;
                    return [4 /*yield*/, searchLocations(query)];
                case 1:
                    rows = _b.sent();
                    cands = (0, location_resolver_1.collectCandidates)(rows, query, alias === null || alias === void 0 ? void 0 : alias.expect);
                    if (cands.length === 0) {
                        logger_1.logger.warn("[Mengantar] Kota asal \"".concat(env_1.env.MENGANTAR_ORIGIN_KEYWORD, "\" tidak ditemukan"));
                        return [2 /*return*/, null];
                    }
                    if (cands.length > 1) {
                        // Asal ditentukan pemilik toko, bukan pelanggan — jadi tidak ada siapa pun
                        // untuk ditanyai. Yang bisa dilakukan: ambil yang paling mungkin, lalu
                        // berteriak di log supaya bisa dipatok pasti lewat MENGANTAR_ORIGIN_ID.
                        logger_1.logger.warn("[Mengantar] Kota asal \"".concat(env_1.env.MENGANTAR_ORIGIN_KEYWORD, "\" AMBIGU ") +
                            "(".concat(cands.map(function (c) { return c.cityLabel; }).join(', '), "). Dipakai: ").concat(cands[0].cityLabel, ". ") +
                            "Isi MENGANTAR_ORIGIN_ID di .env supaya pasti.");
                    }
                    id = (0, location_resolver_1.addressId)(cands[0].row);
                    if (id) {
                        cachedOriginId = id;
                        logger_1.logger.info("[Mengantar] Kota asal \"".concat(env_1.env.MENGANTAR_ORIGIN_KEYWORD, "\" \u2192 ") +
                            "".concat((0, location_resolver_1.prettyPlace)(cands[0].cityLabel), ", ").concat((0, location_resolver_1.prettyPlace)(cands[0].province)));
                    }
                    return [2 /*return*/, id];
            }
        });
    });
}
/**
 * Harga mana yang dikutip ke pelanggan, dan mana yang cuma biaya toko.
 *
 * ── Keputusan bisnis Angga, 30 Juli 2026 ────────────────────────────────────
 * Yang dikutip ke pelanggan `estimatedPrice`. Yang dibayar toko ke Mengantar
 * `estimatedSpecialPrice`. Selisihnya margin pemilik toko, dan itu memang
 * haknya — diskon itu didapat dari akunnya sendiri, bukan dari ekspedisi.
 *
 * Kata Angga: "aku maunya pake estimatedPrice yg lebih mahal (karena selisih
 * diskonnya buat aku) kalau dikasi spesialprice aku gak dapat untung dari
 * selisih diskon ongkir."
 *
 * ── Kesalahan saya yang perlu dicatat, bukan dilupakan ──────────────────────
 * Pada Fase 38 saya MENGUBAH urutan ini ke arah yang berlawanan, dan menulis di
 * ledger bahwa itu memperbaiki "kutipan 54% terlalu mahal". Contoh yang saya
 * pakai: price 26.000 sementara estimatedSpecialPrice 16.904.
 *
 * Perhitungannya benar; kesimpulannya salah. Saya menganggap harga yang benar
 * adalah yang dibayar TOKO, tanpa pernah menanyakan apakah margin dari diskon
 * itu memang bagian dari model usahanya. Selama beberapa jam sesudah itu, setiap
 * kutipan ongkir menyerahkan seluruh margin ongkir Angga ke pelanggan — dan
 * karena angkanya "benar" secara teknis, tidak ada satu pun galat yang muncul.
 *
 * Pelajarannya: soal ANGKA MANA yang benar untuk dikutip bukan pertanyaan
 * teknis. Itu pertanyaan bisnis, dan jawabannya cuma ada di pemilik usaha.
 *
 * Urutannya sekarang: harga pelanggan dulu, lalu tarif dasar sebagai cadangan.
 * `estimatedSpecialPrice` dipakai HANYA kalau dua-duanya tidak ada — lebih baik
 * mengutip angka yang terlalu murah daripada tidak bisa menjawab sama sekali,
 * tapi itu keadaan yang seharusnya tidak pernah terjadi.
 */
function hargaKePelanggan(d) {
    var kandidat = [d.estimatedPrice, d.price, d.estimatedSpecialPrice];
    for (var _i = 0, kandidat_1 = kandidat; _i < kandidat_1.length; _i++) {
        var n = kandidat_1[_i];
        if (typeof n === 'number' && n > 0)
            return n;
    }
    return null;
}
/**
 * Biaya toko ke Mengantar. HANYA untuk log dan perhitungan margin.
 *
 * TIDAK BOLEH masuk ke potongan pengetahuan. Kalau angka ini sampai ke konteks
 * yang dibaca model saat menyusun jawaban, model bisa menyebutkannya ke
 * pelanggan — dan pelanggan yang tahu harga aslinya akan menawar ke situ.
 */
function biayaToko(d) {
    return typeof d.estimatedSpecialPrice === 'number' && d.estimatedSpecialPrice > 0
        ? d.estimatedSpecialPrice
        : null;
}
/**
 * Nama ekspedisi sebagaimana pelanggan mengenalnya.
 *
 * ── Kenapa peta ini perlu ada ───────────────────────────────────────────────
 * Kunci yang dikembalikan API itu nama internal, dan bot mengutipnya apa adanya
 * ke pelanggan. Terpantau di audit 30 Juli 2026:
 *
 *     - SAPLite: Rp 7.245
 *     - SiCepatCargo: Rp 7.699
 *     - JT: Rp 4.900
 *     - iDexpress: Rp 23.000
 *
 * "JT" bukan cara siapa pun menulis J&T, dan "SAPLite" tidak ada di kepala
 * pelanggan mana pun. Pelanggan sedang memilih ekspedisi untuk paketnya — nama
 * yang tidak dia kenali membuatnya ragu, dan ragu di titik itu berarti pesanan
 * tidak jadi.
 *
 * Kuncinya huruf kecil supaya pencocokannya tidak bergantung pada cara API
 * menuliskan huruf besarnya, yang bisa berubah tanpa pemberitahuan.
 */
var NAMA_EKSPEDISI = {
    jne: 'JNE',
    jnt: 'J&T',
    jt: 'J&T',
    'j&t': 'J&T',
    jtcargo: 'J&T Cargo',
    sicepat: 'SiCepat',
    sicepatcargo: 'SiCepat Cargo',
    ninja: 'Ninja Xpress',
    ninjaxpress: 'Ninja Xpress',
    anteraja: 'AnterAja',
    sap: 'SAP Express',
    sapexpress: 'SAP Express',
    // SAPLite layanan yang BERBEDA, bukan sekadar penulisan lain dari SAP Express.
    // Sempat saya samakan; itu keliru — pelanggan yang memilih "SAP Express" lalu
    // menerima layanan Lite tidak mendapat yang ia kira.
    saplite: 'SAP Express Lite',
    lion: 'Lion Parcel',
    lionparcel: 'Lion Parcel',
    pos: 'POS Indonesia',
    posindonesia: 'POS Indonesia',
    idexpress: 'ID Express',
    ide: 'ID Express',
    // Varian kargo, disebut eksplisit di dokumentasi Mengantar. Tanpa entri ini
    // "JNECargo" lolos ke pelanggan apa adanya — perapi otomatis tidak bisa
    // memecahnya karena tidak ada batas huruf-kecil-ke-besar di "JNEC".
    jnecargo: 'JNE Cargo',
    sapcargo: 'SAP Express Cargo',
    idexpresscargo: 'ID Express Cargo',
    paxel: 'Paxel',
    wahana: 'Wahana',
    tiki: 'TIKI',
    rex: 'REX',
    sentral: 'Sentral Cargo',
};
/** Nama yang enak dibaca, atau bentuk rapi kalau kuncinya belum dikenali. */
function namaEkspedisi(kunci) {
    var k = String(kunci !== null && kunci !== void 0 ? kunci : '').trim();
    var cocok = NAMA_EKSPEDISI[k.toLowerCase().replace(/[\s_-]/g, '')];
    if (cocok)
        return cocok;
    // Belum dikenali: pisahkan gabungan kata ("SiCepatCargo" → "Si Cepat Cargo")
    // supaya setidaknya terbaca sebagai kata, bukan sebagai kode.
    return k.replace(/([a-z])([A-Z])/g, '$1 $2').trim() || k;
}
/**
 * Estimasi waktu yang layak dibaca pelanggan Indonesia.
 *
 * API mengembalikan teks apa adanya dari ekspedisi, dan bentuknya campur aduk:
 * "2 - 4 days", "2 - 3 Days", string kosong. Yang bocor ke audit:
 *
 *     - SAPLite: Rp 7.245 (estimasi 2 - 4 days)
 *     - Ninja: Rp 6.655 (estimasi)          ← kosong, tapi tanda kurungnya tetap muncul
 *
 * Bahasa Inggris di tengah kalimat Indonesia terasa seperti bocoran sistem, dan
 * "(estimasi)" tanpa isi lebih buruk daripada tidak ada tulisan sama sekali —
 * ia menjanjikan keterangan lalu tidak memberikannya.
 *
 * Mengembalikan `undefined` kalau tidak ada yang berguna, supaya pemanggilnya
 * bisa memilih tidak menulis apa pun.
 */
function rapikanEstimasi(mentah) {
    var t = String(mentah !== null && mentah !== void 0 ? mentah : '').trim();
    if (!t)
        return undefined;
    t = t
        .replace(/\bdays?\b/gi, 'hari')
        .replace(/\bhours?\b/gi, 'jam')
        .replace(/\bweeks?\b/gi, 'minggu')
        .replace(/\s*-\s*/g, '-')
        .replace(/\s+/g, ' ')
        .trim();
    // Harus memuat angka; "estimasi tidak tersedia" bukan estimasi.
    if (!/\d/.test(t))
        return undefined;
    // Kalau satuannya belum tersebut, tambahkan — "2-3" saja ambigu.
    if (!/\b(hari|jam|minggu)\b/i.test(t))
        t = "".concat(t, " hari");
    return t;
}
/**
 * Penanda "TIDAK bisa COD" di baris alamat tujuan, per ekspedisi.
 *
 * ── Kenapa ini datang dari API, bukan dari dokumen ──────────────────────────
 * Dukungan COD berbeda per TUJUAN dan per EKSPEDISI sekaligus. Itu ribuan
 * kombinasi yang berubah sendiri saat ekspedisi mengubah jangkauannya.
 *
 * Dokumen `02-ongkos-kirim.md` versi pertama saya menyuruh pemilik toko mengisi
 * "daerah yang tidak bisa COD" dan "ekspedisi mana saja yang melayani COD"
 * secara manual. Angga mengoreksinya: itu ngaco, datanya banyak dan dinamis.
 * Dia benar, dan kesalahannya sejenis dengan menaruh tarif ongkir di dokumen —
 * dua-duanya fakta yang hanya benar pada satu saat, untuk satu tujuan.
 *
 * Mengantar sudah menyediakan jawabannya di baris alamat. Jadi ini dibaca, bukan
 * ditulis.
 *
 * ── Sekarang dicocokkan ke daftar kode kurir RESMI ─────────────────────────
 * Dokumentasi Mengantar (app.mengantar.com/docs) menyebutkan nilai sah untuk
 * parameter `courier` pada endpoint estimate:
 *
 *     'JNE' | 'SiCepat' | 'Sap' | 'iDexpress' | 'JT' | 'Ninja' | 'lion' | 'anteraja'
 *     ditambah varian kargo: SiCepatCargo, JNECargo, SapCargo, iDexpressCargo
 *
 * Dicocokkan dengan akhiran field COD yang ada di data alamat, tujuh dari
 * delapan kurir berpasangan langsung: Sap→Sap, JT→JT, lion→Lion, Ninja→Ninja,
 * anteraja→Anteraja, iDexpress→Id, SiCepat→Si.
 *
 * ── Dan satu temuan yang penting: JNE TIDAK PUNYA field COD ────────────────
 * Data alamat memuat `unsupportedJNE` (untuk pengiriman biasa) tapi TIDAK ada
 * `unsupportedCodJNE`. Jadi dukungan COD JNE memang tidak bisa diketahui dari
 * API ini — bukan karena petanya kurang lengkap.
 *
 * JNE sengaja TIDAK didaftarkan di bawah, supaya `statusCod()` melaporkannya
 * "belum diketahui". Jangan menambahkannya dengan tebakan: JNE kebetulan juga
 * ekspedisi yang disarankan toko ini kalau pelanggan tidak memilih, jadi
 * tebakan yang salah di sini akan mengenai jalur yang paling sering dipakai.
 *
 * Dokumentasi juga tidak menjelaskan arti field-field ini satu per satu — yang
 * dikonfirmasi baru daftar kurirnya. Karena itu ekspedisi tanpa padanan tetap
 * dilaporkan "belum diketahui", BUKAN "bisa": menjanjikan COD yang ternyata
 * tidak ada berarti pesanan batal di langkah terakhir, sesudah pelanggan
 * menunggu.
 */
var FIELD_TIDAK_BISA_COD = {
    'SiCepat': ['unsupportedCodSi'],
    'SiCepat Cargo': ['unsupportedCodSi'],
    'SAP Express': ['unsupportedCodSap', 'unsupportedCodCheckFirstSap'],
    'SAP Express Lite': ['unsupportedCodSap', 'unsupportedCodCheckFirstSap'],
    'SAP Express Cargo': ['unsupportedCodSap', 'unsupportedCodCheckFirstSap'],
    'J&T': ['unsupportedCodJT'],
    'J&T Cargo': ['unsupportedCodJT'],
    'Lion Parcel': ['unsupportedCodLion'],
    'Ninja Xpress': ['unsupportedCodNinja'],
    'AnterAja': ['unsupportedCodAnteraja'],
    'ID Express': ['unsupportedCodId'],
    'ID Express Cargo': ['unsupportedCodId'],
    'Paxel': ['unsupportedCodPaxel'],
    // JNE dan JNE Cargo SENGAJA tidak ada di sini — tidak ada
    // `unsupportedCodJNE` di data alamat. Lihat catatan di atas.
};
/** Dibuka untuk alat pemeriksa `cek-cod.ts`, supaya yang diaudit peta yang SAMA. */
exports.__PETA_COD = FIELD_TIDAK_BISA_COD;
exports.__NAMA_EKSPEDISI = NAMA_EKSPEDISI;
/**
 * Penanda "ekspedisi ini TIDAK MELAYANI tujuan ini sama sekali" — bukan soal COD.
 *
 * ── Dari antarmuka Mengantar sendiri, 30 Juli 2026 ─────────────────────────
 * Tampilan cek ongkir Mengantar memakai tiga lambang, dan legendanya menjelaskan
 * seluruh model datanya:
 *
 *     🟠  tidak melayani COD ke tujuan ini
 *     ❌  tidak melayani COD MAUPUN NON-COD ke tujuan ini
 *     🟪  tidak melayani alamat ASAL
 *
 * Jadi liputan itu BERTINGKAT, dan versi kode sebelumnya cuma membaca tingkat
 * pertama. Pada contoh Tangerang → Kota Deli Serdang, JNE bertanda ❌ — tidak
 * melayani sama sekali — TAPI TETAP MENAMPILKAN HARGA Rp 47.200.
 *
 * Artinya endpoint tarif memberi angka untuk kombinasi yang sebenarnya tidak
 * bisa dikirim. Tanpa pemeriksaan ini, bot mengutip harga itu ke pelanggan,
 * pelanggan memilihnya, dan pesanannya baru gagal waktu hendak dibuat.
 *
 * ── Dan inilah yang menjelaskan JNE ────────────────────────────────────────
 * Tidak ada `unsupportedCodJNE` di data BUKAN karena datanya kurang lengkap.
 * Untuk JNE memang tidak ada keadaan "melayani non-COD tapi tidak COD" — ia
 * melayani dua-duanya, atau tidak melayani sama sekali. Itu sebabnya Angga
 * bilang liputan COD JNE justru paling luas, dan itu cocok dengan datanya.
 *
 * Jadi `unsupportedJNE` bernilai false sekarang berarti **bisa COD**, bukan
 * "belum diketahui" seperti kesimpulan saya di Fase 54.
 */
var FIELD_TIDAK_MELAYANI = {
    'JNE': ['unsupportedJNE'],
    'JNE Cargo': ['unsupportedJNE'],
    'SiCepat': ['unsupportedSi'],
    'SiCepat Cargo': ['unsupportedSi'],
    'SAP Express': ['unsupportedSap'],
    'SAP Express Lite': ['unsupportedSap'],
    'SAP Express Cargo': ['unsupportedSap'],
    'J&T': ['unsupportedJT'],
    'J&T Cargo': ['unsupportedJT'],
    'Lion Parcel': ['unsupportedLion'],
    'Ninja Xpress': ['unsupportedNinja'],
    'ID Express': ['unsupportedId'],
    'ID Express Cargo': ['unsupportedId'],
    'Paxel': ['unsupportedPaxel'],
};
/** Penanda menyeluruh: tujuan ini tidak bisa COD lewat ekspedisi mana pun. */
var FIELD_COD_MENYELURUH = 'unsupportedCod';
/**
 * Apakah ekspedisi ini melayani tujuan tersebut sama sekali?
 *
 * Dipakai untuk MEMBUANG kurir dari daftar kutipan — bukan sekadar menandainya.
 * Mengutip harga untuk pengiriman yang tidak mungkin terjadi lebih buruk
 * daripada tidak menyebutkannya: pelanggan sudah memilih dan sudah menunggu
 * waktu kegagalannya ketahuan.
 */
function melayaniTujuan(row, namaTampilan) {
    var fields = FIELD_TIDAK_MELAYANI[namaTampilan];
    if (!fields || fields.length === 0)
        return true; // tidak dikenali → jangan dibuang
    var r = row;
    return !fields.some(function (f) { return benar(r[f]); });
}
function benar(v) {
    return v === true || v === 'true' || v === 1 || v === '1';
}
/**
 * Bisa COD atau tidak, untuk satu ekspedisi ke satu tujuan.
 *
 * Mengembalikan 'belum diketahui' kalau tidak ada penanda yang bisa dibaca.
 * Ketidaktahuan dilaporkan apa adanya, tidak dibulatkan jadi 'bisa' — karena
 * yang menanggung akibat tebakan yang salah pelanggan yang pesanannya batal.
 */
function statusCod(row, namaTampilan) {
    var _a, _b;
    var r = row;
    // Tingkat 0 — penanda menyeluruh untuk tujuan ini.
    if (benar(r[FIELD_COD_MENYELURUH]))
        return 'tidak';
    // Tingkat 1 — tidak melayani sama sekali berarti tidak melayani COD juga.
    // Urutannya penting: kurir yang tidak melayani tujuan tidak boleh dinilai
    // "bisa COD" hanya karena penanda COD-nya kebetulan kosong.
    if (!melayaniTujuan(row, namaTampilan))
        return 'tidak';
    // Tingkat 2 — melayani, tapi mungkin hanya untuk non-COD.
    var fieldsCod = (_a = FIELD_TIDAK_BISA_COD[namaTampilan]) !== null && _a !== void 0 ? _a : [];
    if (fieldsCod.some(function (f) { return benar(r[f]); }))
        return 'tidak';
    if (fieldsCod.some(function (f) { return f in r; }))
        return 'bisa';
    // Tidak punya penanda COD tersendiri. Untuk kurir seperti JNE itu BUKAN
    // ketidaktahuan: memang tidak ada keadaan "melayani non-COD tapi tidak COD".
    // Selama kita tahu ia melayani tujuan ini, berarti ia melayani COD juga.
    var fieldsLayan = (_b = FIELD_TIDAK_MELAYANI[namaTampilan]) !== null && _b !== void 0 ? _b : [];
    if (fieldsLayan.some(function (f) { return f in r; }))
        return 'bisa';
    // Benar-benar tidak ada penanda apa pun — kurir baru yang belum dikenali.
    return 'belum diketahui';
}
/**
 * Di bawah selisih ini, kandidat mana pun yang dipilih tidak mengubah apa yang
 * dibayar secara berarti — jadi lebih baik langsung menjawab daripada bertanya.
 *
 * Dari pengukuran: empat kecamatan di Bandung memberi selisih NOL pada sembilan
 * dari sepuluh ekspedisi. Ambiguitas semacam itu memang tidak perlu diributkan.
 * Sebaliknya Kota Surabaya vs kecamatan Surabaya di Lampung berselisih 127–186%,
 * dan itu yang wajib ditanyakan.
 */
function safeGapPercent() {
    return env_1.env.MENGANTAR_SAFE_GAP_PERCENT;
}
/**
 * Berapa kandidat yang tarifnya diperbandingkan.
 *
 * Dibatasi tiga karena tiap kandidat berarti satu panggilan tarif. Kalau
 * kandidatnya lebih banyak dari ini dan bot masih boleh bertanya, bertanya jauh
 * lebih murah daripada membandingkan semuanya.
 */
var MAX_COMPARE = 3;
/**
 * Ambil tarif semua ekspedisi sekaligus.
 *
 * Yang diambil harga Mengantar yang sudah termasuk markup dan diskon mereka —
 * itu yang benar untuk toko yang mengirim LEWAT Mengantar, sebab itulah yang
 * benar-benar dibayar. Endpoint `allEstimate3PL` memberi tarif mentah ekspedisi
 * dan akan membuat pelanggan dikutip lebih murah dari biaya sesungguhnya — rugi
 * di tiap transaksi.
 *
 * Endpoint mana yang dipakai ditentukan sendiri saat berjalan; lihat catatan di
 * `ESTIMATE_ENDPOINTS`.
 */
/**
 * Potongan kata kunci yang lebih pendek, dari yang paling panjang ke yang
 * paling pendek, dengan membuang kata dari BELAKANG.
 *
 * `"padang totalnya brp"` → `["padang totalnya", "padang"]`.
 *
 * Membuang dari belakang, bukan dari depan, karena nama tempat selalu berada
 * di awal frasa yang diambil sesudah kata "ke" — yang menempel di belakangnya
 * itulah sisa kalimat pelanggan ("totalnya", "harganya", "semuanya").
 *
 * Potongan sepanjang <3 huruf dibuang: terlalu pendek untuk dicari sebagai
 * nama tempat, dan hampir pasti mengembalikan kandidat yang tidak nyambung.
 */
/**
 * Kata yang TIDAK PERNAH boleh berdiri sendiri sebagai kata kunci alamat.
 *
 * ── Cacat yang ditutup di sini (Fase 111) ───────────────────────────────────
 * Pemenggalan di `potonganKataKunci()` membuang kata dari BELAKANG. Untuk nama
 * tempat Indonesia itu justru terbalik: yang di depan sering cuma penanda
 * administratif, dan NAMANYA ada di belakang. Akibatnya terukur 2 Agustus 2026:
 *
 *     "kabupaten pati" → tidak ketemu → dipendekkan jadi "kabupaten"
 *                      → 1 kandidat → dikutip tarif KABUPATEN KLATEN
 *
 * Pelanggan bertanya ongkir ke Pati dan menerima tarif Klaten — dengan yakin,
 * tanpa satu pun galat muncul. Itu bentuk kegagalan terburuk di sistem ini:
 * angka yang salah tapi terlihat sah.
 *
 * Menambah kata satu per satu ke daftar ini bukan obatnya; yang menghapus
 * KELASNYA adalah aturan bahwa sisa pemenggalan yang SELURUHNYA kata umum tidak
 * pernah boleh dipakai mencari alamat.
 */
var KATA_UMUM_ALAMAT = new Set([
    'kabupaten', 'kab', 'kota', 'kotamadya', 'kec', 'kecamatan', 'kel', 'kelurahan',
    'desa', 'dusun', 'provinsi', 'prov', 'daerah', 'wilayah', 'kepulauan', 'pulau',
    'jalan', 'jln', 'jl', 'alamat', 'tujuan', 'ke', 'di', 'dari',
]);
function potonganKataKunci(keyword) {
    var kata = keyword.trim().split(/\s+/).filter(Boolean);
    var hasil = [];
    for (var n = kata.length - 1; n >= 1; n--) {
        var potongan = kata.slice(0, n);
        // Sisa yang seluruhnya kata umum bukan nama tempat — lihat catatan di atas.
        if (potongan.every(function (w) { return KATA_UMUM_ALAMAT.has(w.toLowerCase()); }))
            continue;
        var kandidat = potongan.join(' ');
        if (kandidat.length >= 3)
            hasil.push(kandidat);
    }
    return hasil;
}
function getShippingQuotes(params) {
    return __awaiter(this, void 0, void 0, function () {
        var allowAsk, weight, alias, queryKeyword, cariKandidat, _a, originId, kandidatPertama, candidates, keywordDipakai, _i, _b, kwPendek, aliasPendek, kwCari, hasilPendek, dibandingkan, hasil, berhasil, termurah, min, max, selisihPersen, daftar, dominan;
        var _this = this;
        var _c, _d;
        return __generator(this, function (_e) {
            switch (_e.label) {
                case 0:
                    if (!isMengantarEnabled())
                        return [2 /*return*/, null];
                    allowAsk = params.allowAsk !== false;
                    weight = params.weightKg && params.weightKg > 0
                        ? params.weightKg
                        : env_1.env.MENGANTAR_DEFAULT_WEIGHT_KG;
                    alias = (0, place_aliases_1.lookupAlias)(params.destinationKeyword);
                    queryKeyword = (_c = alias === null || alias === void 0 ? void 0 : alias.query) !== null && _c !== void 0 ? _c : params.destinationKeyword;
                    cariKandidat = function (kw_1) {
                        var args_1 = [];
                        for (var _i = 1; _i < arguments.length; _i++) {
                            args_1[_i - 1] = arguments[_i];
                        }
                        return __awaiter(_this, __spreadArray([kw_1], args_1, true), void 0, function (kw, harap) {
                            var _a;
                            if (harap === void 0) { harap = alias === null || alias === void 0 ? void 0 : alias.expect; }
                            return __generator(this, function (_b) {
                                switch (_b.label) {
                                    case 0:
                                        _a = location_resolver_1.collectCandidates;
                                        return [4 /*yield*/, searchLocations(kw)];
                                    case 1: return [2 /*return*/, _a.apply(void 0, [(_b.sent()), kw, harap])];
                                }
                            });
                        });
                    };
                    return [4 /*yield*/, Promise.all([
                            resolveOriginId(),
                            cariKandidat(queryKeyword),
                        ])];
                case 1:
                    _a = _e.sent(), originId = _a[0], kandidatPertama = _a[1];
                    if (!originId)
                        return [2 /*return*/, null];
                    candidates = kandidatPertama;
                    keywordDipakai = queryKeyword;
                    if (!(candidates.length === 0)) return [3 /*break*/, 5];
                    _i = 0, _b = potonganKataKunci(queryKeyword);
                    _e.label = 2;
                case 2:
                    if (!(_i < _b.length)) return [3 /*break*/, 5];
                    kwPendek = _b[_i];
                    aliasPendek = (0, place_aliases_1.lookupAlias)(kwPendek);
                    kwCari = (_d = aliasPendek === null || aliasPendek === void 0 ? void 0 : aliasPendek.query) !== null && _d !== void 0 ? _d : kwPendek;
                    return [4 /*yield*/, cariKandidat(kwCari, aliasPendek === null || aliasPendek === void 0 ? void 0 : aliasPendek.expect)];
                case 3:
                    hasilPendek = _e.sent();
                    if (hasilPendek.length === 0)
                        return [3 /*break*/, 4];
                    candidates = hasilPendek;
                    keywordDipakai = kwPendek;
                    alias = aliasPendek;
                    logger_1.logger.info("[Mengantar] \"".concat(queryKeyword, "\" tidak ketemu; dicoba ulang sebagai ") +
                        "\"".concat(kwPendek, "\" \u2192 ").concat(hasilPendek.length, " kandidat"));
                    return [3 /*break*/, 5];
                case 4:
                    _i++;
                    return [3 /*break*/, 2];
                case 5:
                    if (candidates.length === 0) {
                        logger_1.logger.info("[Mengantar] \"".concat(params.destinationKeyword, "\" tidak ketemu di daftar alamat"));
                        return [2 /*return*/, null];
                    }
                    // ── Satu kandidat: tidak ada yang perlu ditanyakan ────────────────────────
                    if (candidates.length === 1) {
                        return [2 /*return*/, quoteFor(candidates[0], originId, weight, alias === null || alias === void 0 ? void 0 : alias.label)];
                    }
                    // ── Terlalu banyak kandidat dan masih boleh bertanya ──────────────────────
                    // Bertanya di sini lebih murah daripada memanggil tarif tiga kali, dan dengan
                    // kandidat sebanyak ini salah satunya hampir pasti di provinsi yang jauh.
                    if (candidates.length > MAX_COMPARE && allowAsk) {
                        return [2 /*return*/, bertanya(candidates, keywordDipakai)];
                    }
                    dibandingkan = candidates.slice(0, MAX_COMPARE);
                    return [4 /*yield*/, Promise.all(dibandingkan.map(function (c) { return quoteFor(c, originId, weight, undefined); }))];
                case 6:
                    hasil = _e.sent();
                    berhasil = hasil
                        .map(function (r, i) { return ({ r: r, c: dibandingkan[i] }); })
                        .filter(function (x) { return x.r !== null && x.r.quotes.length > 0; });
                    if (berhasil.length === 0)
                        return [2 /*return*/, null];
                    // Kalau cuma satu kandidat yang tarifnya bisa diambil, ambiguitasnya selesai
                    // dengan sendirinya — yang lain tidak dilayani ekspedisi mana pun.
                    if (berhasil.length === 1)
                        return [2 /*return*/, berhasil[0].r];
                    termurah = berhasil.map(function (x) { return x.r.quotes[0].price; });
                    min = Math.min.apply(Math, termurah);
                    max = Math.max.apply(Math, termurah);
                    selisihPersen = min > 0 ? ((max - min) / min) * 100 : 100;
                    daftar = berhasil
                        .map(function (x, i) { return "".concat(x.c.cityLabel, " Rp").concat(termurah[i].toLocaleString('id-ID')); })
                        .join(' | ');
                    if (selisihPersen <= safeGapPercent()) {
                        dominan = berhasil[0];
                        logger_1.logger.info("[Mengantar] \"".concat(keywordDipakai, "\" ambigu tapi selisih cuma ") +
                            "".concat(selisihPersen.toFixed(1), "% (").concat(daftar, ") \u2014 dijawab langsung pakai ").concat(dominan.c.cityLabel));
                        return [2 /*return*/, dominan.r];
                    }
                    if (allowAsk) {
                        logger_1.logger.info("[Mengantar] \"".concat(keywordDipakai, "\" ambigu, selisih ").concat(selisihPersen.toFixed(0), "% ") +
                            "(".concat(daftar, ") \u2014 tarif TIDAK dikutip, bot bertanya dulu"));
                        return [2 /*return*/, bertanya(berhasil.map(function (x) { return x.c; }), keywordDipakai)];
                    }
                    logger_1.logger.warn("[Mengantar] \"".concat(keywordDipakai, "\" masih ambigu SESUDAH ditanya, ") +
                        "selisih ".concat(selisihPersen.toFixed(0), "% (").concat(daftar, ") \u2014 diserahkan ke manusia"));
                    return [2 /*return*/, { unresolved: true, keyword: keywordDipakai }];
            }
        });
    });
}
function bertanya(candidates, keyword) {
    return {
        ambiguous: true,
        question: (0, location_resolver_1.buildQuestion)(keyword, candidates),
        keyword: keyword,
        mustMention: (0, location_resolver_1.questionMustMention)(candidates),
        choices: candidates
            .map(function (c) {
            var _a;
            return ({
                addressId: (_a = (0, location_resolver_1.addressId)(c.row)) !== null && _a !== void 0 ? _a : '',
                cityLabel: (0, location_resolver_1.prettyPlace)(c.cityLabel),
                province: (0, location_resolver_1.prettyPlace)(c.province),
            });
        })
            .filter(function (c) { return c.addressId; }),
    };
}
/**
 * Ambil tarif untuk satu pilihan yang SUDAH dipastikan.
 *
 * Dipakai pada giliran susulan, sesudah jawaban pelanggan dicocokkan ke daftar
 * pilihan. Tidak ada pencarian lokasi lagi di sini — id alamatnya sudah ada,
 * jadi tidak ada lagi kesempatan bagi kata kunci yang salah susun untuk
 * menggagalkan seluruh percakapan.
 */
function getShippingQuotesForChoice(params) {
    return __awaiter(this, void 0, void 0, function () {
        var originId, weight, row, rows, cocok, _a, cand;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    if (!isMengantarEnabled())
                        return [2 /*return*/, null];
                    return [4 /*yield*/, resolveOriginId()];
                case 1:
                    originId = _b.sent();
                    if (!originId)
                        return [2 /*return*/, null];
                    weight = params.weightKg && params.weightKg > 0
                        ? params.weightKg
                        : env_1.env.MENGANTAR_DEFAULT_WEIGHT_KG;
                    row = { _id: params.addressId };
                    _b.label = 2;
                case 2:
                    _b.trys.push([2, 4, , 5]);
                    return [4 /*yield*/, searchLocations(params.cityLabel.replace(/^(Kota|Kabupaten)\s+/i, ''))];
                case 3:
                    rows = _b.sent();
                    cocok = rows.find(function (r) { return (0, location_resolver_1.addressId)(r) === params.addressId; });
                    if (cocok)
                        row = cocok;
                    return [3 /*break*/, 5];
                case 4:
                    _a = _b.sent();
                    return [3 /*break*/, 5];
                case 5:
                    cand = {
                        row: row,
                        cityLabel: params.cityLabel,
                        province: params.province,
                        weight: 1,
                        primary: true,
                    };
                    return [2 /*return*/, quoteFor(cand, originId, weight, undefined)];
            }
        });
    });
}
/** Ambil tarif untuk satu kandidat. `null` kalau tidak ada yang bisa diambil. */
function quoteFor(cand, originId, weight, aliasLabel) {
    return __awaiter(this, void 0, void 0, function () {
        var destId, raw, quotes, _i, _a, _b, courier, data, price, nama, termurah, margin;
        var _c;
        return __generator(this, function (_d) {
            switch (_d.label) {
                case 0:
                    destId = (0, location_resolver_1.addressId)(cand.row);
                    if (!destId)
                        return [2 /*return*/, null];
                    return [4 /*yield*/, fetchEstimates(originId, destId, weight)];
                case 1:
                    raw = _d.sent();
                    if (!raw)
                        return [2 /*return*/, null];
                    quotes = [];
                    for (_i = 0, _a = Object.entries(raw); _i < _a.length; _i++) {
                        _b = _a[_i], courier = _b[0], data = _b[1];
                        // Kunci pembungkus yang mungkin ikut terbawa kalau bentuk balasannya
                        // berbeda. Tanpa penyaring ini, "success" bisa terbaca sebagai ekspedisi.
                        if (['success', 'message', 'status', 'data', 'result'].includes(courier))
                            continue;
                        if (!data || typeof data !== 'object')
                            continue;
                        if (data.unsupported)
                            continue;
                        price = hargaKePelanggan(data);
                        if (price === null)
                            continue;
                        nama = namaEkspedisi(courier);
                        // ── Buang yang tidak melayani tujuan ini ────────────────────────────────
                        // Endpoint tarif TETAP memberi angka untuk kombinasi yang tidak terlayani —
                        // terlihat langsung di antarmuka Mengantar: JNE bertanda "tidak melayani
                        // COD maupun non-COD" ke Kota Deli Serdang, tapi harganya tetap tampil.
                        // Jadi `data.unsupported` dari balasan tarif saja tidak cukup; liputan
                        // sesungguhnya ada di baris alamat.
                        if (!melayaniTujuan(cand.row, nama)) {
                            logger_1.logger.info("[Mengantar] ".concat(nama, " tidak melayani ").concat(cand.cityLabel, " \u2014 tidak dikutip"));
                            continue;
                        }
                        quotes.push({
                            courier: nama,
                            price: price,
                            eta: rapikanEstimasi(data.estimate_delivery),
                            cost: (_c = biayaToko(data)) !== null && _c !== void 0 ? _c : undefined,
                            cod: statusCod(cand.row, nama),
                        });
                    }
                    if (quotes.length === 0)
                        return [2 /*return*/, null];
                    quotes.sort(function (a, b) { return a.price - b.price; });
                    termurah = quotes[0];
                    if (termurah.cost !== undefined) {
                        margin = termurah.price - termurah.cost;
                        logger_1.logger.info("[Mengantar] ".concat(termurah.courier, ": dikutip Rp ").concat(termurah.price.toLocaleString('id-ID'), ", ") +
                            "biaya toko Rp ".concat(termurah.cost.toLocaleString('id-ID'), ", margin Rp ").concat(margin.toLocaleString('id-ID')));
                    }
                    return [2 /*return*/, {
                            // Label dari tabel padanan dipakai kalau ada, karena ditulis untuk dibaca
                            // orang ("Surakarta (Solo), Jawa Tengah"). Kalau tidak, data mentahnya
                            // dirapikan supaya tidak muncul sebagai "KAB. BANYUMAS, JAWA TENGAH".
                            destinationLabel: aliasLabel !== null && aliasLabel !== void 0 ? aliasLabel : [(0, location_resolver_1.prettyPlace)(cand.cityLabel), (0, location_resolver_1.prettyPlace)(cand.province)].filter(Boolean).join(', '),
                            weightKg: weight,
                            quotes: quotes.slice(0, 4),
                        }];
            }
        });
    });
}
/**
 * Endpoint tarif yang mungkin dipakai, beserta ingatan mana yang benar-benar ada.
 *
 * ── Kejadian yang membuat bagian ini ada ────────────────────────────────────
 * Versi sebelumnya selalu mencoba `allEstimatePublic` lebih dulu lalu jatuh ke
 * `estimate?courier=all`. Di akun ini `allEstimatePublic` SELALU menjawab 404 —
 * jadi setiap permintaan tarif membuang satu perjalanan penuh ke server dan
 * menulis satu peringatan palsu ke log. Saat audit berjalan, log-nya dipenuhi
 * `estimasi ongkir gagal (HTTP 404)` padahal ongkirnya berhasil diambil; Angga:
 * "ada yg ganggu pikiranku sering banget 404 ni".
 *
 * Yang menipu dari bug ini: hasil akhirnya BENAR, jadi tidak ada yang rusak dan
 * tidak ada yang menuntut perbaikan. Yang rusak cuma kecepatan dan kepercayaan
 * pada log — dan log yang penuh peringatan palsu adalah log yang berhenti dibaca.
 *
 * ── Kenapa 404 diingat, dan kegagalan lain tidak ───────────────────────────
 * 404 berarti endpoint-nya memang tidak ada di akun ini. Itu tidak akan berubah
 * dalam satu masa hidup proses, jadi ditandai mati dan tidak ditembak lagi.
 * Kegagalan lain (500, timeout) sesaat dan tidak menandai apa pun.
 *
 * Kalau SEMUA endpoint tertandai mati, tandanya dihapus dan semuanya dicoba lagi
 * dari awal. Tanpa jalan keluar itu, satu kesalahan penandaan akan mematikan
 * ongkir sampai proses di-restart.
 */
var ESTIMATE_ENDPOINTS = [
    // Yang ini yang terbukti jalan pada percobaan manual Angga 30 Juli 2026.
    { label: 'estimate?courier=all', path: function (q) { return "/order/estimate?".concat(q, "&courier=all"); } },
    // Disimpan karena ada di dokumentasi dan bisa saja aktif di akun lain.
    { label: 'allEstimatePublic', path: function (q) { return "/order/allEstimatePublic?".concat(q); } },
];
/** Label endpoint yang terbukti berhasil — dicoba pertama pada permintaan berikutnya. */
var endpointTerbukti = null;
/** Label endpoint yang menjawab 404 — tidak ditembak lagi. */
var endpointMati = new Set();
function ambilEstimasi(q) {
    return __awaiter(this, void 0, void 0, function () {
        var urut, _i, urut_1, ep, _a, raw, status_1, data;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    if (endpointMati.size >= ESTIMATE_ENDPOINTS.length) {
                        logger_1.logger.info('[Mengantar] Semua endpoint tarif pernah 404 — tanda mati dihapus, dicoba ulang dari awal');
                        endpointMati.clear();
                        endpointTerbukti = null;
                    }
                    urut = __spreadArray([], ESTIMATE_ENDPOINTS, true).filter(function (e) { return !endpointMati.has(e.label); })
                        .sort(function (a, b) {
                        if (a.label === endpointTerbukti)
                            return -1;
                        if (b.label === endpointTerbukti)
                            return 1;
                        return 0;
                    });
                    _i = 0, urut_1 = urut;
                    _b.label = 1;
                case 1:
                    if (!(_i < urut_1.length)) return [3 /*break*/, 4];
                    ep = urut_1[_i];
                    return [4 /*yield*/, callWithStatus(ep.path(q), "estimasi ongkir (".concat(ep.label, ")"), true)];
                case 2:
                    _a = _b.sent(), raw = _a.data, status_1 = _a.status;
                    data = unwrap(raw);
                    if (data && typeof data === 'object') {
                        if (endpointTerbukti !== ep.label) {
                            logger_1.logger.info("[Mengantar] Endpoint tarif yang dipakai: ".concat(ep.label));
                            endpointTerbukti = ep.label;
                        }
                        return [2 /*return*/, data];
                    }
                    if (status_1 === 404) {
                        endpointMati.add(ep.label);
                        logger_1.logger.info("[Mengantar] Endpoint tarif \"".concat(ep.label, "\" tidak ada di akun ini (404) \u2014 tidak dicoba lagi"));
                    }
                    else if (status_1 !== null) {
                        logger_1.logger.warn("[Mengantar] Endpoint tarif \"".concat(ep.label, "\" gagal (HTTP ").concat(status_1, ")"));
                    }
                    else {
                        logger_1.logger.warn("[Mengantar] Endpoint tarif \"".concat(ep.label, "\" tidak bisa dihubungi"));
                    }
                    _b.label = 3;
                case 3:
                    _i++;
                    return [3 /*break*/, 1];
                case 4:
                    logger_1.logger.warn('[Mengantar] Tidak ada endpoint tarif yang berhasil — ongkir dijawab tanpa angka');
                    return [2 /*return*/, null];
            }
        });
    });
}
function fetchEstimates(originId, destId, weight) {
    return __awaiter(this, void 0, void 0, function () {
        var cacheKey, cached, parsed, _a, q, data, raw, _b;
        return __generator(this, function (_c) {
            switch (_c.label) {
                case 0:
                    cacheKey = "".concat(CACHE_PREFIX, ":est:").concat(originId, ":").concat(destId, ":").concat(weight);
                    _c.label = 1;
                case 1:
                    _c.trys.push([1, 3, , 4]);
                    return [4 /*yield*/, redis_1.redisCache.get(cacheKey)];
                case 2:
                    cached = _c.sent();
                    if (cached) {
                        parsed = JSON.parse(cached);
                        // Alasannya sama seperti pada cache lokasi, dan akibatnya di sini lebih
                        // mahal: bentuk yang tidak terduga di sini berarti tarif yang salah
                        // dikutip ke pelanggan, bukan cuma "tidak ketemu".
                        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                            return [2 /*return*/, parsed];
                        }
                        logger_1.logger.warn('[Mengantar] Cache tarif bentuknya tidak dikenali — diabaikan, ambil ulang dari API');
                    }
                    return [3 /*break*/, 4];
                case 3:
                    _a = _c.sent();
                    return [3 /*break*/, 4];
                case 4:
                    q = "origin_id=".concat(encodeURIComponent(originId)) +
                        "&destination_id=".concat(encodeURIComponent(destId)) +
                        "&weight=".concat(weight);
                    return [4 /*yield*/, ambilEstimasi(q)];
                case 5:
                    data = _c.sent();
                    if (!data)
                        return [2 /*return*/, null];
                    raw = data;
                    _c.label = 6;
                case 6:
                    _c.trys.push([6, 8, , 9]);
                    return [4 /*yield*/, redis_1.redisCache.set(cacheKey, JSON.stringify(raw), 'EX', ESTIMATE_TTL_SEC)];
                case 7:
                    _c.sent();
                    return [3 /*break*/, 9];
                case 8:
                    _b = _c.sent();
                    return [3 /*break*/, 9];
                case 9: return [2 /*return*/, raw];
            }
        });
    });
}
/**
 * Ubah hasil jadi potongan pengetahuan berbahasa manusia.
 *
 * Ditulis sebagai kalimat, bukan JSON: yang membacanya nanti adalah model bahasa
 * saat menyusun jawaban, DAN Supervisor saat memeriksa apakah angka di jawaban
 * itu punya dasar. Dua-duanya bekerja jauh lebih baik dengan kalimat biasa.
 */
function quotesToKnowledgeChunk(result) {
    var lines = result.quotes.map(function (q) {
        // Keterangan COD ditulis di baris yang SAMA dengan harganya, bukan di daftar
        // terpisah. Sekitar 90 persen pesanan toko ini COD, jadi "bisa COD atau
        // tidak" sama menentukannya dengan harganya sendiri — dan keterangan yang
        // berjarak dari angkanya mudah tertinggal saat model menyusun jawaban.
        var cod = q.cod === 'bisa' ? ' — bisa COD'
            : q.cod === 'tidak' ? ' — TIDAK bisa COD'
                : ' — status COD belum diketahui';
        return "".concat(q.courier, ": Rp ").concat(q.price.toLocaleString('id-ID')) +
            (q.eta ? " (estimasi ".concat(q.eta, ")") : '') + cod;
    });
    var bisaCod = result.quotes.filter(function (q) { return q.cod === 'bisa'; });
    var tidakCod = result.quotes.filter(function (q) { return q.cod === 'tidak'; });
    var belumJelas = result.quotes.filter(function (q) { return q.cod === 'belum diketahui'; });
    var catatanCod = [];
    if (tidakCod.length > 0 || belumJelas.length > 0) {
        catatanCod.push('');
        if (bisaCod.length > 0) {
            catatanCod.push("Kalau pelanggan mau COD, tawarkan HANYA yang bisa COD: " +
                "".concat(bisaCod.map(function (q) { return q.courier; }).join(', '), "."));
        }
        else {
            catatanCod.push('TIDAK ADA ekspedisi yang jelas bisa COD ke tujuan ini. Jangan menjanjikan COD; ' +
                'sampaikan bahwa untuk daerah ini akan dipastikan dulu.');
        }
        if (tidakCod.length > 0) {
            catatanCod.push("Jangan tawarkan untuk COD: ".concat(tidakCod.map(function (q) { return q.courier; }).join(', '), " \u2014 ") +
                "pesanan COD lewat ekspedisi ini akan gagal.");
        }
        if (belumJelas.length > 0) {
            catatanCod.push("Belum diketahui bisa COD atau tidak: ".concat(belumJelas.map(function (q) { return q.courier; }).join(', '), ". ") +
                "Jangan menyatakan bisa maupun tidak bisa untuk yang ini.");
        }
    }
    return __spreadArray(__spreadArray(__spreadArray([
        "Ongkos kirim ke ".concat(result.destinationLabel, " untuk paket ").concat(result.weightKg, " kg"),
        ''
    ], lines, true), catatanCod, true), [
        '',
        // Menyebut tujuan yang terbaca itu WAJIB, bukan basa-basi. Kalau sistem salah
        // menafsirkan kotanya, satu-satunya yang bisa menangkap kesalahan itu adalah
        // pelanggannya sendiri — dan dia hanya bisa menangkapnya kalau disebutkan.
        "WAJIB sebutkan tujuannya (".concat(result.destinationLabel, ") saat menjawab, supaya"),
        'pelanggan bisa mengoreksi kalau kotanya keliru. Sebutkan juga bahwa tarif',
        'berlaku saat ini dan bisa berubah.',
    ], false).join('\n');
}
/**
 * Perintah bertanya untuk model bahasa.
 *
 * ── Kenapa ini BUKAN potongan pengetahuan lagi ──────────────────────────────
 * Versi sebelumnya menyelundupkan perintah ini ke dalam daftar "Pengetahuan
 * Bisnis Tambahan", yang di prompt ditutup dengan "gunakan informasi di atas
 * jika relevan". Itu SARAN. Sementara prompt sistem punya ATURAN: "kalau ada
 * yang belum kamu ketahui, bilang akan dicek dulu."
 *
 * Terpantau 30 Juli 2026 pukul 11:03 — pertanyaannya sudah benar di log:
 *
 *     [AI] bot bertanya: Surabayanya yang di Jawa Timur atau yang di Lampung ya Kak?
 *
 * tapi yang sampai ke pelanggan: "ongkir ke Surabaya saya masih perlu cek dulu.
 * Saya akan minta informasi ke tim logistik kami." Aturan mengalahkan saran,
 * dan itu memang seharusnya — yang salah menaruh perintah di tempat saran.
 *
 * Sekarang dikirim sebagai pesan sistem tersendiri, dan hasilnya diperiksa.
 */
function askInstruction(dest) {
    return [
        'PERINTAH YANG MENGALAHKAN ATURAN LAIN DI ATAS.',
        '',
        "Tujuan pengiriman \"".concat(dest.keyword, "\" ada lebih dari satu tempat, dan selisih"),
        'tarifnya besar. Kamu TIDAK BOLEH menyebut angka ongkir apa pun sekarang, dan',
        'TIDAK BOLEH bilang "akan dicek dulu" atau "akan dikabari" — kamu tidak sedang',
        'kekurangan informasi, kamu cuma perlu menanyakan satu hal.',
        '',
        'Tanyakan ini, boleh disesuaikan gayanya tapi pilihannya harus tetap disebut:',
        '',
        dest.question,
    ].join('\n');
}
/**
 * Potongan untuk kasus yang sudah ditanya tapi tetap belum jelas.
 *
 * Sengaja TIDAK menyuruh bertanya lagi. Pelanggan sudah menjawab sekali; kalau
 * jawabannya belum menyelesaikan, yang dia butuhkan orang — bukan pertanyaan
 * kedua tentang hal yang sama.
 */
function unresolvedToKnowledgeChunk(dest) {
    return [
        "Tujuan \"".concat(dest.keyword, "\" masih belum bisa dipastikan walau sudah ditanya."),
        '',
        'JANGAN menyebut angka ongkir apa pun, dan JANGAN bertanya lagi soal lokasi.',
        'Bilang saja ongkirnya akan dicek dulu lalu dikabari — dengan santai, tanpa',
        'menyebut sistem, data, atau alasan teknis apa pun.',
    ].join('\n');
}
var MengantarService = /** @class */ (function () {
    function MengantarService() {
    }
    MengantarService.normalizePhone = function (phone) {
        var clean = phone.replace(/\D/g, '');
        if (clean.startsWith('62')) {
            clean = clean.slice(2);
        }
        else if (clean.startsWith('0')) {
            clean = clean.slice(1);
        }
        return clean;
    };
    /**
     * Mengambil skor reputasi penerima COD dari Mengantar API.
     * Endpoint: GET https://app.mengantar.com/api/public/{API_KEY}/getReceiverScoreByNumberUser?search={phone}
     */
    MengantarService.getReceiverScore = function (rawPhone, customApiKey) {
        return __awaiter(this, void 0, void 0, function () {
            var apiKey, phone, cacheKey, cached, _a, url, res, json, data, totalOrders, totalDelivered, totalRts, courierBreakdown, bestCourier, bestScore, couriers, _i, couriers_1, c, detail, courierScore, overallDeliveryRate, riskReasons, isHighRisk, result, _b, err_2;
            return __generator(this, function (_c) {
                switch (_c.label) {
                    case 0:
                        apiKey = customApiKey || env_1.env.MENGANTAR_API_KEY;
                        if (!apiKey) {
                            return [2 /*return*/, null];
                        }
                        phone = this.normalizePhone(rawPhone);
                        if (!phone || phone.length < 8) {
                            return [2 /*return*/, null];
                        }
                        cacheKey = "mengantar:receiver_score:".concat(phone);
                        _c.label = 1;
                    case 1:
                        _c.trys.push([1, 3, , 4]);
                        return [4 /*yield*/, redis_1.redisCache.get(cacheKey)];
                    case 2:
                        cached = _c.sent();
                        if (cached) {
                            return [2 /*return*/, JSON.parse(cached)];
                        }
                        return [3 /*break*/, 4];
                    case 3:
                        _a = _c.sent();
                        return [3 /*break*/, 4];
                    case 4:
                        _c.trys.push([4, 11, , 12]);
                        url = "https://app.mengantar.com/api/public/".concat(apiKey, "/getReceiverScoreByNumberUser?search=").concat(phone);
                        return [4 /*yield*/, fetch(url, {
                                method: 'GET',
                                headers: { 'Accept': 'application/json' },
                                signal: AbortSignal.timeout(6000),
                            })];
                    case 5:
                        res = _c.sent();
                        if (!res.ok) {
                            logger_1.logger.warn("[Mengantar] getReceiverScore failed HTTP ".concat(res.status, " for ").concat(phone));
                            return [2 /*return*/, null];
                        }
                        return [4 /*yield*/, res.json()];
                    case 6:
                        json = _c.sent();
                        if (!json || json.status === false || !json.data) {
                            return [2 /*return*/, null];
                        }
                        data = json.data;
                        totalOrders = 0;
                        totalDelivered = 0;
                        totalRts = 0;
                        courierBreakdown = {};
                        bestCourier = null;
                        bestScore = -1;
                        couriers = ['JNE', 'SiCepat', 'JT', 'SAP', 'Ninja', 'iDexpress'];
                        for (_i = 0, couriers_1 = couriers; _i < couriers_1.length; _i++) {
                            c = couriers_1[_i];
                            if (data[c] && typeof data[c] === 'object') {
                                detail = {
                                    total: Number(data[c].total || 0),
                                    value: Number(data[c].value || 0),
                                    delivered: Number(data[c].delivered || 0),
                                    rts: Number(data[c].rts || 0),
                                    rate: Number(data[c].rate || 0),
                                };
                                courierBreakdown[c] = detail;
                                totalOrders += detail.total;
                                totalDelivered += detail.delivered;
                                totalRts += detail.rts;
                                courierScore = detail.delivered * 2 + detail.rate * 10 - detail.rts * 15;
                                if (courierScore > bestScore && detail.delivered > 0) {
                                    bestScore = courierScore;
                                    bestCourier = "".concat(c, " (").concat(detail.delivered, "x Sukses, Rate ").concat(detail.rate, ")");
                                }
                            }
                        }
                        if (totalOrders === 0) {
                            return [2 /*return*/, null];
                        }
                        overallDeliveryRate = totalOrders > 0
                            ? Math.round((totalDelivered / (totalDelivered + totalRts || 1)) * 100)
                            : 100;
                        riskReasons = [];
                        isHighRisk = false;
                        if (totalRts >= 2) {
                            isHighRisk = true;
                            riskReasons.push("Pernah RTS ".concat(totalRts, " kali di riwayat logistik Mengantar"));
                        }
                        if (overallDeliveryRate < 60 && totalOrders >= 2) {
                            isHighRisk = true;
                            riskReasons.push("Tingkat pengiriman sukses hanya ".concat(overallDeliveryRate, "% (").concat(totalRts, " RTS dari ").concat(totalOrders, " order)"));
                        }
                        result = {
                            phone: phone,
                            totalOrders: totalOrders,
                            totalDelivered: totalDelivered,
                            totalRts: totalRts,
                            overallDeliveryRate: overallDeliveryRate,
                            recommendedCourier: bestCourier,
                            courierBreakdown: courierBreakdown,
                            isHighRisk: isHighRisk,
                            riskReasons: riskReasons,
                        };
                        _c.label = 7;
                    case 7:
                        _c.trys.push([7, 9, , 10]);
                        return [4 /*yield*/, redis_1.redisCache.set(cacheKey, JSON.stringify(result), 'EX', 86400)];
                    case 8:
                        _c.sent(); // 24 hours TTL
                        return [3 /*break*/, 10];
                    case 9:
                        _b = _c.sent();
                        return [3 /*break*/, 10];
                    case 10: return [2 /*return*/, result];
                    case 11:
                        err_2 = _c.sent();
                        logger_1.logger.error("[Mengantar] getReceiverScore error: ".concat(err_2.message));
                        return [2 /*return*/, null];
                    case 12: return [2 /*return*/];
                }
            });
        });
    };
    /**
     * Tes koneksi Mengantar API dengan dummy request.
     */
    MengantarService.testConnection = function (apiKey) {
        return __awaiter(this, void 0, void 0, function () {
            var url, res, err_3;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        _a.trys.push([0, 2, , 3]);
                        url = "https://app.mengantar.com/api/public/".concat(apiKey, "/getReceiverScoreByNumberUser?search=8123456789");
                        return [4 /*yield*/, fetch(url, {
                                method: 'GET',
                                headers: { 'Accept': 'application/json' },
                            })];
                    case 1:
                        res = _a.sent();
                        if (res.status === 200) {
                            return [2 /*return*/, { success: true, message: 'Koneksi ke API Mengantar berhasil terhubung!' }];
                        }
                        else if (res.status === 401 || res.status === 403) {
                            return [2 /*return*/, { success: false, message: 'API Key Mengantar tidak valid atau tidak memiliki izin akses.' }];
                        }
                        else {
                            return [2 /*return*/, { success: false, message: "Mengantar API merespon dengan kode status HTTP ".concat(res.status) }];
                        }
                        return [3 /*break*/, 3];
                    case 2:
                        err_3 = _a.sent();
                        return [2 /*return*/, { success: false, message: "Gagal menghubungi API Mengantar: ".concat(err_3.message) }];
                    case 3: return [2 /*return*/];
                }
            });
        });
    };
    return MengantarService;
}());
exports.MengantarService = MengantarService;
