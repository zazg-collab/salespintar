"use strict";
/**
 * Memilih tujuan pengiriman dari hasil pencarian alamat — atau menyerah dan
 * menyuruh bot bertanya.
 *
 * ── Yang diukur dari data sungguhan (30 Juli 2026) ──────────────────────────
 *
 * 1. SATUAN HARGANYA Kota/Kabupaten, bukan kecamatan.
 *    Empat kecamatan berbeda di "BANDUNG", asal sama, 1 kg: sembilan dari
 *    sepuluh ekspedisi selisih NOL. Yang berbeda cuma J&T, dan garis
 *    pemisahnya Kota Bandung (10.500) versus Kab. Bandung (7.699).
 *    Sampai tingkat kelurahan pun (Cibaduyut / Wetan / Kidul): selisih nol
 *    di semua ekspedisi.
 *    → Cukup pastikan Kota/Kabupaten. Tidak perlu turun ke kecamatan.
 *
 * 2. `CITY_NAME` MENGGABUNGKAN Kota dan Kabupaten.
 *    Kota Bandung dan Kab. Bandung dua-duanya `CITY_NAME = "BANDUNG"`.
 *    Yang membedakan `CITY_NAME_SI`: "Kota Bandung" vs "Kab. Bandung".
 *    Versi sebelumnya mengelompokkan per `CITY_NAME`, jadi ia menganggap
 *    keduanya satu tempat lalu mengambil salah satu sembarang — tepat di garis
 *    di mana J&T berbeda 36%.
 *    → Pengelompokan WAJIB per `CITY_NAME_SI`.
 *
 * 3. SALAH TAFSIR LINTAS PROVINSI ITU FATAL.
 *    Kota Bandung → Kota Surabaya, JNE Rp 10.500.
 *    Kota Bandung → kecamatan Surabaya di Lampung Tengah, JNE Rp 23.800.
 *    Selisih +127%, dan pada SAP +186%. Kalau bot salah tafsir, penjualnya
 *    nombok lebih besar daripada seluruh ongkir yang dikutip.
 *    → Kalau kandidatnya beda tempat, JANGAN diasumsikan.
 *
 * 4. Baris pertama hasil pencarian TIDAK BOLEH dipercaya.
 *    Pencarian "bandung" mengembalikan baris pertama "SUMUR BANDUNG, Jayanti,
 *    Kab. Tangerang". Terbukti pada percobaan pertama, bukan dugaan.
 */
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
exports.addressId = addressId;
exports.prettyPlace = prettyPlace;
exports.describeCandidate = describeCandidate;
exports.shortLabel = shortLabel;
exports.collectCandidates = collectCandidates;
exports.questionMustMention = questionMustMention;
exports.questionDelivered = questionDelivered;
exports.buildQuestion = buildQuestion;
function norm(s) {
    return String(s !== null && s !== void 0 ? s : '').trim().toLowerCase();
}
function addressId(r) {
    return (r === null || r === void 0 ? void 0 : r._id) || (r === null || r === void 0 ? void 0 : r.id) || null;
}
/**
 * Singkatan yang justru salah kalau dijadikan Huruf Kapital Di Awal.
 * "DKI JAKARTA" tidak boleh jadi "Dki Jakarta" — itu terbaca seperti salah tulis.
 */
var TETAP_KAPITAL = new Set(['DKI', 'DI', 'NTB', 'NTT']);
/**
 * Rapikan nama supaya enak dibaca di WhatsApp.
 *
 * Data API memakai HURUF BESAR SEMUA ("JAWA BARAT") dan singkatan ("Kab."),
 * dan dua-duanya terbaca seperti keluaran mesin. Pelanggan sedang membaca chat,
 * bukan basis data.
 */
function prettyPlace(s) {
    return String(s !== null && s !== void 0 ? s : '')
        .trim()
        .replace(/^Kab\.\s*/i, 'Kabupaten ')
        .replace(/\s+/g, ' ')
        .split(' ')
        .map(function (w) { return (TETAP_KAPITAL.has(w.toUpperCase()) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()); })
        .join(' ');
}
/** Label untuk ditampilkan ke pelanggan, lengkap dengan provinsi. */
function describeCandidate(c) {
    return [c.row.DISTRICT_NAME, c.cityLabel, c.province]
        .map(function (v) { return prettyPlace(String(v !== null && v !== void 0 ? v : '')); })
        .filter(Boolean)
        .join(', ');
}
/** Label pendek untuk pertanyaan pilihan. */
function shortLabel(c) {
    return [c.cityLabel, c.province].map(function (v) { return prettyPlace(String(v !== null && v !== void 0 ? v : '')); }).filter(Boolean).join(', ');
}
function matchesAnyName(r, kw) {
    return [r.CITY_NAME, r.DISTRICT_NAME, r.SUBDISTRICT_NAME].some(function (v) { return norm(v).includes(kw); });
}
/**
 * Berapa baris minimum sebelum sebuah kandidat lintas provinsi dianggap serius.
 *
 * Diambil dari data sungguhan. Pencarian "bandung" memunculkan kelurahan
 * bernama Bandung di Tangerang dan Muaro Jambi — MASING-MASING SATU BARIS.
 * Itu tempat kecil yang nyaris tidak mungkin dimaksud orang yang bilang
 * "kirim ke Bandung", dan mempertanyakannya cuma bikin repot.
 *
 * Sebaliknya, pencarian "surabaya" memunculkan kecamatan Surabaya di Lampung
 * Tengah dengan 24 BARIS — lebih banyak daripada Kota Surabaya sendiri (16).
 * Itu daerah sungguhan berpenduduk, dan salah menebaknya berarti selisih tarif
 * sampai 186%.
 *
 * Ambangnya memisahkan dua hal itu.
 */
var RIVAL_MIN_WEIGHT = 5;
/**
 * Kumpulkan kandidat Kota/Kabupaten dari hasil pencarian.
 *
 * Penyaring berlapisnya penting, dan urutannya bukan kebetulan:
 *
 *   Lapis 1 — kalau ADA baris yang NAMA KOTANYA memuat kata kunci, hanya baris
 *   itu yang dipakai. Ini yang meruntuhkan "bandung" dari 25 kandidat jadi 2:
 *   23 di antaranya nyangkut karena ada KELURAHAN bernama Bandung di sana
 *   (Sumur Bandung di Tangerang, Rengas Bandung di Muaro Jambi), sementara yang
 *   nama KOTA-nya Bandung cuma Kota dan Kabupaten Bandung.
 *
 *   Lapis 2 — kalau tidak ada yang cocok di tingkat kota, baru terima kecocokan
 *   di tingkat kecamatan/kelurahan. Ini yang membuat "bojongsoang" dan
 *   "cibaduyut" tetap berhasil, karena keduanya memang nama kecamatan.
 *
 *   Lapis 3 — saingan lintas provinsi yang besar dimasukkan KEMBALI, supaya
 *   Lapis 1 tidak menyembunyikan bahaya yang paling mahal.
 */
function collectCandidates(rows, keyword, expectCityLabel) {
    var kw = norm(keyword);
    if (!kw || !Array.isArray(rows) || rows.length === 0)
        return [];
    var withId = rows.filter(function (r) { return addressId(r); });
    if (expectCityLabel) {
        // Datang dari tabel pemetaan: hanya Kota/Kab yang disebutkan yang sah.
        return group(withId.filter(function (r) { return norm(r.CITY_NAME_SI) === norm(expectCityLabel); }), true);
    }
    var cocokKota = withId.filter(function (r) { return norm(r.CITY_NAME).includes(kw); });
    var cocokApaPun = withId.filter(function (r) { return matchesAnyName(r, kw); });
    if (cocokKota.length === 0)
        return group(cocokApaPun, false);
    // ── Kandidat utama: yang NAMA KOTAnya cocok ─────────────────────────────
    // Ini yang meruntuhkan "bandung" dari 25 kandidat jadi 2 — 23 lainnya
    // nyangkut karena ada KELURAHAN bernama Bandung di sana.
    var utama = group(cocokKota, true);
    var provinsiUtama = new Set(utama.map(function (c) { return norm(c.province); }));
    // ── Tapi jangan buang saingan lintas provinsi yang besar ───────────────
    // Penyaring di atas, kalau dibiarkan sendiri, MENYEMBUNYIKAN bahaya yang
    // paling mahal. "surabaya" akan menyisakan Kota Surabaya saja dan kecamatan
    // Surabaya di Lampung hilang tanpa jejak — jadi bot tidak akan pernah
    // bertanya, lalu mengutip tarif yang salah 186% dengan penuh percaya diri.
    //
    // Saingan yang sungguhan (banyak baris, provinsi lain) dimasukkan kembali,
    // supaya ambiguitasnya muncul ke permukaan dan bot bertanya.
    var saingan = group(cocokApaPun, false)
        .filter(function (c) { return !provinsiUtama.has(norm(c.province)); })
        .filter(function (c) { return c.weight >= RIVAL_MIN_WEIGHT; });
    return __spreadArray(__spreadArray([], utama, true), saingan, true).sort(urutan);
}
/**
 * Urutan penyajian: yang nama kotanya cocok lebih dulu, baru jumlah baris.
 *
 * Dipakai untuk dua hal, dan dua-duanya penting: urutan pilihan di pertanyaan,
 * dan — kalau tarifnya ternyata nyaris sama — kandidat mana yang dipakai
 * menjawab tanpa bertanya.
 */
function urutan(a, b) {
    if (a.primary !== b.primary)
        return a.primary ? -1 : 1;
    return b.weight - a.weight;
}
function group(rowsIn, primary) {
    var _a, _b, _c;
    var byCity = new Map();
    for (var _i = 0, rowsIn_1 = rowsIn; _i < rowsIn_1.length; _i++) {
        var r = rowsIn_1[_i];
        // CITY_NAME_SI adalah satuan harga. CITY_NAME dipakai sebagai cadangan,
        // tapi itu berarti Kota dan Kabupaten bisa tergabung — dan tarif J&T-nya
        // berbeda 36%, jadi cadangan ini memang kurang tajam.
        var label = String((_b = (_a = r.CITY_NAME_SI) !== null && _a !== void 0 ? _a : r.CITY_NAME) !== null && _b !== void 0 ? _b : '').trim();
        if (!label)
            continue;
        var key = norm(label);
        var found = byCity.get(key);
        if (found) {
            found.weight += 1;
        }
        else {
            byCity.set(key, {
                row: r,
                cityLabel: label,
                province: String((_c = r.PROVINCE_NAME) !== null && _c !== void 0 ? _c : '').trim(),
                weight: 1,
                primary: primary,
            });
        }
    }
    return __spreadArray([], byCity.values(), true).sort(urutan);
}
/**
 * Susun pertanyaan untuk pelanggan.
 *
 * Dua bentuk, dan pemilihannya disengaja:
 *
 *   DUA kandidat → sebutkan keduanya. "Purwokertonya yang di Banyumas atau
 *   yang di Kendal ya Kak?" Pertanyaan tertutup, dijawab dalam satu kata.
 *
 *   TIGA ATAU LEBIH → JANGAN dienumerasi. Menyodorkan 25 pilihan ke WhatsApp
 *   lebih buruk daripada tidak menjawab. Yang ditanyakan provinsinya, karena:
 *   (a) semua orang tahu provinsinya tanpa berpikir, termasuk yang lanjut usia;
 *   (b) selisih tarif yang fatal itu memang selisih antar provinsi.
 *
 * Nama tempat yang disebut pelanggan diulang di dalam pertanyaan — supaya
 * terasa didengarkan, bukan diinterogasi.
 */
/**
 * Kata yang WAJIB muncul di balasan supaya pertanyaannya benar-benar tersampaikan.
 *
 * ── Kenapa ini perlu ada ────────────────────────────────────────────────────
 * Pertanyaan yang sudah disusun rapi tidak ada gunanya kalau model bahasa
 * memilih kalimatnya sendiri. Terpantau 30 Juli 2026: pertanyaan sudah benar di
 * log, tapi yang sampai ke pelanggan justru "ongkir ke Surabaya perlu saya cek
 * dulu" — sebab perintahnya diselundupkan sebagai POTONGAN PENGETAHUAN ("gunakan
 * jika relevan"), sementara prompt sistem punya ATURAN ("kalau belum tahu, bilang
 * akan dicek dulu"). Saran kalah melawan aturan.
 *
 * Daftar ini dipakai memeriksa hasilnya: kalau balasan model tidak memuat satu
 * pun kata pembeda ini, balasan itu dibuang dan pertanyaan aslinya yang dikirim.
 * Memeriksa kecocokan persis terlalu rapuh — model boleh saja menyusun kalimatnya
 * sendiri, asalkan pilihannya benar-benar disampaikan.
 */
function questionMustMention(candidates) {
    var provinsi = __spreadArray([], new Set(candidates.map(function (c) { return prettyPlace(c.province); }).filter(Boolean)), true);
    if (candidates.length === 2) {
        if (provinsi.length >= 2)
            return provinsi;
        return candidates.map(function (c) { return prettyPlace(c.cityLabel); }).filter(Boolean);
    }
    // Tiga atau lebih tidak dienumerasi, jadi yang bisa diperiksa cuma bahwa
    // pertanyaannya menyoal tingkat wilayah yang benar.
    return provinsi.length === 1 ? ['kabupaten'] : ['provinsi'];
}
/**
 * Apakah balasan yang akan dikirim benar-benar MENANYAKAN pilihan itu?
 *
 * Dipisah dari `ai.service` supaya bisa diuji sendiri — ini penjaga terakhir
 * sebelum pelanggan menerima jawaban yang salah arah, dan penjaga terakhir yang
 * tidak pernah diuji bukan penjaga.
 *
 * Kecocokan persis SENGAJA tidak diharuskan. Model bahasa boleh menyusun
 * kalimatnya sendiri — "Oh Surabaya, yang di Jawa Timur atau yang di Lampung
 * nih Kak?" itu bagus, mungkin lebih bagus daripada susunan kaku kita. Yang
 * wajib cuma dua: pilihannya benar-benar disebut, dan bentuknya pertanyaan.
 */
function questionDelivered(reply, mustMention) {
    if (mustMention.length === 0)
        return true;
    var r = String(reply !== null && reply !== void 0 ? reply : '').toLowerCase();
    if (!r.includes('?'))
        return false;
    return mustMention.some(function (k) { return r.includes(String(k).toLowerCase()); });
}
function buildQuestion(keyword, candidates) {
    var tempat = prettyPlace(keyword);
    var provinsi = __spreadArray([], new Set(candidates.map(function (c) { return norm(c.province); }).filter(Boolean)), true);
    if (candidates.length === 2) {
        var _a = candidates, a = _a[0], b = _a[1];
        // Yang disebut hanya hal yang SUNGGUH membedakan keduanya. Kalau
        // provinsinya sama, menyebutkannya dua kali cuma bikin kalimat panjang
        // tanpa menambah kejelasan: "Kota Bandung, Jawa Barat atau Kabupaten
        // Bandung, Jawa Barat" — pelanggan harus membaca dua kali untuk menemukan
        // satu kata yang berbeda.
        if (provinsi.length >= 2) {
            return "".concat(tempat, "nya yang di ").concat(prettyPlace(a.province), " atau yang di ").concat(prettyPlace(b.province), " ya Kak?");
        }
        return "".concat(tempat, "nya ").concat(prettyPlace(a.cityLabel), " atau ").concat(prettyPlace(b.cityLabel), " ya Kak?");
    }
    // Tiga atau lebih: JANGAN dienumerasi. Menyodorkan sepuluh pilihan ke
    // WhatsApp lebih buruk daripada tidak menjawab.
    if (provinsi.length === 1) {
        // Se-provinsi tapi beberapa kabupaten — provinsi tidak membedakan apa pun.
        return "".concat(tempat, "nya di kabupaten mana ya Kak?");
    }
    // Yang ditanyakan provinsinya: semua orang tahu provinsinya tanpa berpikir,
    // dan selisih tarif yang fatal itu memang selisih antar provinsi.
    return "".concat(tempat, "nya provinsi mana ya Kak?");
}
