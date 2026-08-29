"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.redisBull = exports.redisCache = void 0;
exports.waitForRedisReady = waitForRedisReady;
var ioredis_1 = require("ioredis");
var env_1 = require("./env");
exports.redisCache = new ioredis_1.default(env_1.env.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableOfflineQueue: false,
});
exports.redisBull = new ioredis_1.default(env_1.env.REDIS_BULL_URL, {
    maxRetriesPerRequest: null,
    enableOfflineQueue: false,
});
/**
 * Tunggu sampai koneksi Redis benar-benar siap dipakai.
 *
 * ioredis menyambung secara ASINKRON setelah objeknya dibuat. Karena kedua klien
 * di atas memakai `enableOfflineQueue: false`, perintah apa pun yang dikirim
 * sebelum socket siap TIDAK diantre — ia langsung gagal dengan
 * "Stream isn't writeable and enableOfflineQueue options is false".
 *
 * Bootstrap memanggil `.ping()` beberapa milidetik setelah modul ini dimuat,
 * jadi ada balapan: kalau Redis sedikit lambat merespons, ping gagal, bootstrap
 * memanggil `process.exit(1)`, dan karena `tsx watch` menjalankan ulang proses
 * yang keluar — jadilah siklus mati-hidup yang dari luar terlihat seperti
 * "WhatsApp putus sendiri". Terpantau di log 2026-07-29 18:45:16.
 *
 * Menunggu event `ready` menghilangkan balapan itu tanpa perlu mengaktifkan
 * offline queue (yang justru menyembunyikan Redis mati di balik antrean).
 */
function waitForRedisReady(client, name, timeoutMs) {
    if (timeoutMs === void 0) { timeoutMs = 15000; }
    if (client.status === 'ready')
        return Promise.resolve();
    return new Promise(function (resolve, reject) {
        var timer = setTimeout(function () {
            cleanup();
            reject(new Error("Timeout ".concat(timeoutMs, "ms menunggu Redis \"").concat(name, "\" siap (status terakhir: ").concat(client.status, ")")));
        }, timeoutMs);
        var onReady = function () { cleanup(); resolve(); };
        var onError = function (err) { cleanup(); reject(err); };
        var cleanup = function () {
            clearTimeout(timer);
            client.off('ready', onReady);
            client.off('error', onError);
        };
        client.once('ready', onReady);
        client.once('error', onError);
    });
}
