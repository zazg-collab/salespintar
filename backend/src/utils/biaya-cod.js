"use strict";
/**
 * Biaya COD dihitung di KODE, bukan oleh model.
 *
 * ── Kenapa file ini ada ─────────────────────────────────────────────────────
 * Aturan tokonya sudah tertulis jelas di vault ("3% dari total, dibulatkan ke
 * bawah ke ribuan terdekat", lengkap dengan dua contoh). Modelnya tetap salah:
 * pada audit 1 Agustus 2026 ia menjawab 3% dari 139.000 = 4.170 — persennya
 * benar, pembulatannya tidak dikerjakan. Supervisor memblokirnya (skor 60),
 * jadi pelanggan menerima kalimat mengulur, bukan angka salah. Tapi mengulur
 * juga bukan jawaban.
 *
 * Menambah kalimat perintah di prompt tidak menyelesaikan ini. Model bahasa
 * memang lemah di aritmetika, dan pembulatan ke bawah ke ribuan adalah langkah
 * yang paling sering ia lewati. Selama angkanya dihitung oleh model, kesalahan
 * yang sama akan kembali dengan bentuk berbeda.
 *
 * Jadi angkanya dihitung di sini, lalu DISUNTIKKAN sebagai potongan pengetahuan
 * — cara yang sama persis dengan tarif ongkir dari Mengantar (lihat catatan di
 * `ai.service.ts`). Konsekuensinya bagus: Supervisor ikut melihat angka itu di
 * pengetahuan, jadi jawaban yang memakainya lolos dengan sendirinya, tanpa satu
 * pun pengaman dilonggarkan.
 *
 * Yang TIDAK dilakukan file ini: menulis ulang angka di balasan model. Menyunting
 * teks yang sudah jadi berarti menebak mana angka COD dan mana angka lain — dan
 * tebakan yang salah di sana merusak jawaban yang tadinya benar.
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
exports.hitungBiayaCod = hitungBiayaCod;
exports.adaNiatCod = adaNiatCod;
exports.kumpulkanNominal = kumpulkanNominal;
exports.nominalDariDokumen = nominalDariDokumen;
exports.potonganHitunganCod = potonganHitunganCod;
/** Persentase biaya COD. Kalau toko mengubahnya, ubah juga dokumen vault. */
var PERSEN_COD = 0.03;
/**
 * 3% dari total, dibulatkan KE BAWAH ke ribuan terdekat.
 *
 * Contoh dari dokumen vault: 213.000 → 6.000 (3% = 6.390); 375.000 → 11.000
 * (3% = 11.250). Keduanya dipakai sebagai uji di `uji-biaya-cod.ts`.
 */
function hitungBiayaCod(total) {
    if (!Number.isFinite(total) || total <= 0)
        return 0;
    return Math.floor((total * PERSEN_COD) / 1000) * 1000;
}
/**
 * Apakah percakapan ini sedang menyangkut COD.
 *
 * Sengaja longgar: pelanggan hampir tidak pernah menulis "COD" dengan lengkap.
 * "bayar dirumah", "bayar pas sampai", "bayar ditempat" semuanya COD.
 */
var NIAT_COD = /\b(c\.?o\.?d\.?|bayar\s*di\s*(tempat|rumah)|bayar\s*di(tempat|rumah)|bayar\s*(pas|saat|waktu|nanti)\s*(barang(nya)?\s*)?(sampai|datang|dat[ae]ng|terima|diterima))\b/i;
function adaNiatCod(teks) {
    return NIAT_COD.test(teks);
}
/**
 * Mengumpulkan nominal rupiah dari teks percakapan.
 *
 * Batas bawah 10.000 dan batas atas 100.000.000 bukan hiasan — itu yang memisahkan
 * harga dari angka lain yang berseliweran di obrolan CS: "3" (persen), "2x24"
 * (jam), tanggal, nomor resi, dan nomor HP. Nomor HP 12 digit lewat di atas batas
 * atas; angka polos di bawah 10.000 ditolak kecuali ia memakai akhiran rb/ribu/k.
 */
function kumpulkanNominal(teks) {
    var _a;
    var hasil = new Set();
    var pola = /(?:rp\.?\s*)?(\d{1,3}(?:[.,]\d{3})+|\d+)\s*(rb|ribu|k)?/gi;
    var cocok;
    while ((cocok = pola.exec(teks)) !== null) {
        // Angka yang langsung diikuti '%' itu persentase, bukan rupiah.
        if (teks.slice(pola.lastIndex, pola.lastIndex + 1) === '%')
            continue;
        var mentah = cocok[1];
        var akhiran = ((_a = cocok[2]) !== null && _a !== void 0 ? _a : '').toLowerCase();
        var adaPemisah = /[.,]/.test(mentah);
        var nilai = Number(mentah.replace(/[.,]/g, ''));
        if (!Number.isFinite(nilai))
            continue;
        if (akhiran) {
            // "139rb" → 139.000. "139.000rb" tidak masuk akal, jadi diabaikan.
            if (adaPemisah)
                continue;
            nilai *= 1000;
        }
        else if (!adaPemisah && nilai < 10000) {
            continue;
        }
        if (nilai < 10000 || nilai > 100000000)
            continue;
        hasil.add(nilai);
    }
    return __spreadArray([], hasil, true);
}
/**
 * Nominal dari POTONGAN PENGETAHUAN yang akan dibaca model.
 *
 * Perlu terpisah karena pertanyaan seperti "cod ke bandung total brp" tidak
 * memuat satu angka pun — harganya ada di dokumen produk, ongkirnya di potongan
 * dari Mengantar. Tanpa sumber kedua ini, hitungan COD tidak pernah bisa
 * disajikan untuk pertanyaan yang justru paling sering ditanyakan.
 *
 * Baris yang membicarakan biaya COD itu sendiri DIBUANG lebih dulu: dokumen
 * aturan COD memuat contoh "213.000 → 6.000" dan "375.000 → 11.000", dan angka
 * contoh itu bukan total belanja siapa pun. Kalau ikut terkumpul, daftar
 * hitungan akan memuat total yang tidak ada hubungannya dengan pesanan ini.
 */
function nominalDariDokumen(dokumen) {
    var baris = dokumen
        .join('\n')
        .split('\n')
        .filter(function (b) { return !/biaya\s*cod|\b3\s*%/i.test(b); });
    return kumpulkanNominal(baris.join('\n'));
}
/** "Rp139.000" — pemisah ribuan gaya Indonesia, tanpa bergantung pada ICU. */
function rupiah(n) {
    return 'Rp' + Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}
/** Batas jumlah baris supaya potongan ini tidak menenggelamkan pengetahuan lain. */
var MAKS_BARIS = 12;
/** Di atas angka ini dianggap harga produk; di bawahnya dianggap ongkir. */
var AMBANG_PRODUK = 50000;
/**
 * Menyusun potongan pengetahuan berisi hitungan yang SUDAH jadi.
 *
 * Selain tiap nominal apa adanya, dihitung juga penjumlahan harga produk +
 * ongkir — karena itulah bentuk pertanyaan yang sebenarnya ("kalau COD totalnya
 * berapa"), dan menjumlahkan lalu mempersen lalu membulatkan adalah tiga langkah
 * aritmetika berturut-turut, tempat model paling sering tergelincir.
 */
function potonganHitunganCod(nominal) {
    if (nominal.length === 0)
        return null;
    var produk = nominal.filter(function (n) { return n >= AMBANG_PRODUK; });
    var ongkir = nominal.filter(function (n) { return n < AMBANG_PRODUK; });
    var jumlah = [];
    for (var _i = 0, produk_1 = produk; _i < produk_1.length; _i++) {
        var p = produk_1[_i];
        for (var _a = 0, ongkir_1 = ongkir; _a < ongkir_1.length; _a++) {
            var o = ongkir_1[_a];
            jumlah.push(p + o);
        }
    }
    // Ongkir yang berdiri sendiri BUKAN total belanja. Kalau ada angka setingkat
    // harga produk, angka kecil dibuang dari daftar — kalau tidak, baris "Total
    // belanja Rp25.000 → biaya COD Rp0" ikut tersaji (terlihat di uji modul Fase
    // 109), dan dari situ model bisa menyimpulkan COD-nya gratis.
    var dasar = produk.length > 0 ? produk : nominal;
    var semua = __spreadArray([], new Set(__spreadArray(__spreadArray([], dasar, true), jumlah, true)), true).filter(function (n) { return hitungBiayaCod(n) > 0; })
        .sort(function (a, b) { return a - b; })
        .slice(-MAKS_BARIS);
    if (semua.length === 0)
        return null;
    var baris = semua.map(function (n) {
        var biaya = hitungBiayaCod(n);
        return "- Total belanja ".concat(rupiah(n), " \u2192 biaya COD ").concat(rupiah(biaya), " \u2192 yang dibayar ke kurir ").concat(rupiah(n + biaya));
    });
    return __spreadArray(__spreadArray([
        'HITUNGAN BIAYA COD — sudah dihitung sistem. Pakai angka di bawah ini apa adanya.',
        'JANGAN menghitung persennya sendiri dan jangan membulatkan sendiri.'
    ], baris, true), [
        'Kalau total belanja pelanggan tidak ada di daftar di atas, jangan mengarang angkanya:',
        'sebutkan saja bahwa biaya COD 3% dari total, lalu tanyakan/pastikan dulu totalnya.',
    ], false).join('\n');
}
