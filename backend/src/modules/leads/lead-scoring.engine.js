"use strict";
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
exports.LeadScoringEngine = void 0;
/**
 * Deterministic Buying Triggers (Diadopsi 1:1 dari hermes_repo / Sentinel Pattern).
 * Rule engine ini memberikan skor lantai (floor score) objektif sehingga model LLM
 * yang tidak konsisten tidak bisa mengecilkan skor lead yang nyata-nyata ingin beli.
 */
var BUYING_TRIGGERS = [
    { points: 45, label: 'booking/DP/deal', pattern: /\b(dp|booking|book|pesan|order|deposit|uang muka|tanda jadi|mau beli|ambil|bungkus)\b/i },
    { points: 35, label: 'metode bayar/rekening', pattern: /\b(bayar|pembayaran|transfer|rekening|norek|no rek|bca|mandiri|bri|bni|cod|bayar di tempat|payment|qris)\b/i },
    { points: 30, label: 'tanya harga/promo/diskon', pattern: /\b(harga|berapa|brp|price|cost|diskon|promo|potongan|nego|total|ongkir|ongkos kirim)\b/i },
    { points: 25, label: 'kirim data diri/alamat', pattern: /\b(alamat|kirim ke|kecamatan|kelurahan|kabupaten|kota|provinsi|kode pos|nama lengkap|nomor hp|no hp|penerima)\b/i },
    { points: 20, label: 'cek spesifikasi/stok/varian', pattern: /\b(stok|stock|ready|tersedia|available|sisa|ukuran|warna|tipe|model|paket|varian|bahan|dimensi|panjang)\b/i },
];
var LeadScoringEngine = /** @class */ (function () {
    function LeadScoringEngine() {
    }
    /**
     * Deteksi sinyal pembelian deterministik dari teks pesan pembeli.
     */
    LeadScoringEngine.detectBuyingSignals = function (buyerMessages) {
        var text = (buyerMessages !== null && buyerMessages !== void 0 ? buyerMessages : []).join('\n');
        var score = 0;
        var reasons = [];
        for (var _i = 0, BUYING_TRIGGERS_1 = BUYING_TRIGGERS; _i < BUYING_TRIGGERS_1.length; _i++) {
            var trig = BUYING_TRIGGERS_1[_i];
            if (trig.pattern.test(text)) {
                score += trig.points;
                reasons.push(trig.label);
            }
        }
        return { score: Math.min(100, score), reasons: reasons };
    };
    /**
     * Konversi skor numerik (0-100) menjadi LeadStage.
     */
    LeadScoringEngine.stageFromScore = function (score) {
        if (score >= 81)
            return 'VERY_HOT';
        if (score >= 61)
            return 'HOT';
        if (score >= 31)
            return 'WARM';
        return 'COLD';
    };
    /**
     * Gabungkan skor LLM dengan deterministic rule engine (Hermes Blend).
     * Nilai final adalah yang tertinggi antara LLM vs Heuristic.
     */
    LeadScoringEngine.blendScore = function (llmScore, llmReasons, signals) {
        var score = Math.max(0, Math.min(100, Math.max(llmScore, signals.score)));
        var reasons = Array.from(new Set(__spreadArray(__spreadArray([], signals.reasons, true), (llmReasons || []), true)));
        return {
            score: score,
            stage: this.stageFromScore(score),
            reasons: reasons,
        };
    };
    /**
     * Resolusi State Machine Anti-Downgrade.
     * Lead yang sudah HOT / VERY_HOT tidak boleh tiba-tiba jatuh ke COLD hanya karena
     * buffer chat berikutnya sangat pendek ("makasih", "ok"), kecuali obrolan baru
     * eksplisit terdeteksi LOST / batal.
     */
    LeadScoringEngine.resolveNextStage = function (currentStage, currentScore, newStage, newScore, isLost) {
        if (isLost) {
            return { finalStage: 'COLD', finalScore: Math.min(currentScore, 10) };
        }
        // High-water mark ranking
        var rank = {
            COLD: 1,
            WARM: 2,
            HOT: 3,
            VERY_HOT: 4,
        };
        if (rank[newStage] >= rank[currentStage]) {
            return { finalStage: newStage, finalScore: Math.max(currentScore, newScore) };
        }
        // Pertahankan stage lama jika chat baru tidak downgrade secara tegas
        return { finalStage: currentStage, finalScore: Math.max(currentScore, newScore) };
    };
    return LeadScoringEngine;
}());
exports.LeadScoringEngine = LeadScoringEngine;
