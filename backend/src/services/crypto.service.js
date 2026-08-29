"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.encrypt = encrypt;
exports.decrypt = decrypt;
exports.maskedPreview = maskedPreview;
var crypto_1 = require("crypto");
var env_1 = require("../config/env");
// ── Fase 40 (2026-08-20): utility enkripsi generik pertama di codebase ini ──
// Dicek dulu (grep `createCipheriv`/`aes-256` di seluruh src/) -- nol hasil sebelum fase ini.
// Dipakai pertama kali untuk `Business.metaCapiAccessToken` (access token Meta CAPI System User).
//
// Kenapa dienkripsi (beda dari `mengantarApiKey` yang disimpan polos)? Access token Meta System
// User punya cakupan jauh lebih luas (bisa kirim event/atur pixel/ads atas nama akun Meta Bossfren)
// -- kalau kolom DB ini bocor (backup dicuri, akses DB tidak sah, dll), token itu bisa disalahgunakan
// langsung. `mengantarApiKey` cuma API key kurir, risikonya jauh lebih kecil kalau bocor.
//
// AES-256-GCM dipilih karena authenticated encryption (authTag) -- kalau ciphertext diutak-atik,
// decrypt() akan GAGAL KERAS, bukan diam-diam menghasilkan sampah.
//
// Format string tersimpan: "<iv_hex>:<authTag_hex>:<ciphertext_hex>" -- satu kolom TEXT, gampang
// disimpan/dipindah tanpa perlu kolom terpisah utk iv/authTag.
var ALGORITHM = 'aes-256-gcm';
var IV_LENGTH_BYTES = 12; // rekomendasi NIST utk GCM (96-bit)
/**
 * Ambil & validasi ENCRYPTION_KEY dari env, HANYA saat benar-benar dipakai (bukan saat module
 * di-import) -- pola yang sama seperti `validateLlmConfig()` di Fase 82: env opsional divalidasi
 * lazily oleh kode yang benar-benar butuh, bukan zod di bootstrap, supaya server tetap bisa start
 * penuh sebelum Bossfren sempat isi kredensial CAPI.
 */
function getKey() {
    if (!env_1.env.ENCRYPTION_KEY) {
        throw new Error('[crypto.service] ENCRYPTION_KEY belum diset di .env -- wajib ada 64 karakter hex (32 byte) ' +
            'sebelum fitur apa pun yang menyimpan kredensial terenkripsi (mis. Meta CAPI) bisa dipakai.');
    }
    var key = Buffer.from(env_1.env.ENCRYPTION_KEY, 'hex');
    if (key.length !== 32) {
        throw new Error("[crypto.service] ENCRYPTION_KEY harus persis 32 byte (64 karakter hex) setelah didecode, " +
            "ketemu ".concat(key.length, " byte. Generate ulang dengan: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\""));
    }
    return key;
}
/** Enkripsi teks plain (mis. access token) jadi string tersimpan "<iv>:<authTag>:<ciphertext>" (hex). */
function encrypt(plaintext) {
    var key = getKey();
    var iv = crypto_1.default.randomBytes(IV_LENGTH_BYTES);
    var cipher = crypto_1.default.createCipheriv(ALGORITHM, key, iv);
    var encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    var authTag = cipher.getAuthTag();
    return "".concat(iv.toString('hex'), ":").concat(authTag.toString('hex'), ":").concat(encrypted.toString('hex'));
}
/** Kebalikan dari `encrypt()`. Melempar error kalau format tidak valid atau authTag tidak cocok
 *  (ciphertext rusak/diutak-atik) -- SENGAJA gagal keras, bukan mengembalikan sampah diam-diam. */
function decrypt(stored) {
    var key = getKey();
    var parts = stored.split(':');
    if (parts.length !== 3) {
        throw new Error('[crypto.service] Format ciphertext tidak valid (bukan hasil encrypt() fungsi ini).');
    }
    var ivHex = parts[0], authTagHex = parts[1], ciphertextHex = parts[2];
    var iv = Buffer.from(ivHex, 'hex');
    var authTag = Buffer.from(authTagHex, 'hex');
    var ciphertext = Buffer.from(ciphertextHex, 'hex');
    var decipher = crypto_1.default.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    var decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return decrypted.toString('utf8');
}
/**
 * Preview tersamar utk ditampilkan ke frontend TANPA PERNAH membocorkan nilai asli
 * (lihat audit Fase 39, temuan #1 -- endpoint API tidak boleh balikin token mentah/terenkripsi).
 * Contoh: "EAAbc1••••" (6 karakter awal token asli + penanda tersamar).
 */
function maskedPreview(plaintext) {
    var visible = plaintext.slice(0, 6);
    return "".concat(visible).concat('•'.repeat(4));
}
