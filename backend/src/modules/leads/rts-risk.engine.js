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
exports.RtsRiskEngine = void 0;
var session_parser_1 = require("./session-parser");
var RtsRiskEngine = /** @class */ (function () {
    function RtsRiskEngine() {
    }
    /**
     * Evaluasi kualitas chat percakapan berdasarkan 5 Dimensi Kritis Anti-RTS.
     *
     * @param sessionOrTranscript - Sesi aktif atau string transkrip penuh
     * @param conversion - Status konversi lead saat ini
     * @param isConfirmedClosing - Jika TRUE, skip evaluasi Dimensi A (Consent) & E (Keberatan).
     *   Alasan: Jika lead sudah berstatus CLOSING secara deterministik, persetujuan pembeli
     *   sudah terbukti dari fakta closing-nya itu sendiri. Mengevaluasi ulang consent via
     *   regex pada lead CLOSING hanya akan menghasilkan false positive (misal: pembeli jawab
     *   "Y" atau "Sudah" yang tidak tertangkap regex, atau sesi terpotong session parser).
     *   Dimensi yang tetap dievaluasi: B (Alamat), C (Total Biaya COD), D (Kesiapan Dana).
     */
    RtsRiskEngine.evaluateChatQuality = function (sessionOrTranscript, conversion, isConfirmedClosing) {
        if (isConfirmedClosing === void 0) { isConfirmedClosing = false; }
        var buyerLines = [];
        var csLines = [];
        var fullTranscriptText = '';
        if (typeof sessionOrTranscript === 'object' && sessionOrTranscript.messages) {
            fullTranscriptText = sessionOrTranscript.rawTranscript || '';
            for (var _i = 0, _a = sessionOrTranscript.messages; _i < _a.length; _i++) {
                var msg = _a[_i];
                if (msg.senderRole === 'BUYER') {
                    buyerLines.push(msg.text.toLowerCase());
                }
                else if (msg.senderRole === 'CS') {
                    csLines.push(msg.text.toLowerCase());
                }
            }
        }
        else {
            fullTranscriptText = typeof sessionOrTranscript === 'string' ? sessionOrTranscript : '';
            var parsedLines = session_parser_1.SessionBoundaryParser.parseLines(fullTranscriptText);
            if (parsedLines.length > 0) {
                for (var _b = 0, parsedLines_1 = parsedLines; _b < parsedLines_1.length; _b++) {
                    var msg = parsedLines_1[_b];
                    if (msg.senderRole === 'BUYER') {
                        buyerLines.push(msg.text.toLowerCase());
                    }
                    else if (msg.senderRole === 'CS') {
                        csLines.push(msg.text.toLowerCase());
                    }
                }
            }
            else {
                var lines = fullTranscriptText.split('\n');
                for (var _c = 0, lines_1 = lines; _c < lines_1.length; _c++) {
                    var l = lines_1[_c];
                    if (l.startsWith('[BUYER]') || l.startsWith('[CUSTOMER]')) {
                        buyerLines.push(l.replace(/^\[(BUYER|CUSTOMER)\]\s*/, '').toLowerCase());
                    }
                    else if (l.startsWith('[CS]') || l.startsWith('[SELLER]')) {
                        csLines.push(l.replace(/^\[(CS|SELLER)\]\s*/, '').toLowerCase());
                    }
                }
            }
        }
        if (buyerLines.length === 0 && csLines.length === 0) {
            return {
                chatQualityScore: 0,
                chatReasons: ['Transkrip percakapan belum tersinkronisasi (Audit SOP CS belum dapat dievaluasi)']
            };
        }
        var allBuyerText = buyerLines.join(' ');
        var allCsText = csLines.join(' ');
        var chatReasons = [];
        var qualityScore = 100; // Mulai dari skor sempurna, kurangi penalti
        // 1. DIMENSI A: Explicit Buyer Consent (Persetujuan Nyata Pembeli / Konfirmasi Alamat)
        // DILEWATI jika isConfirmedClosing = true.
        // Alasan: Lead CLOSING sudah terbukti setuju secara deterministik (misal: CS kirim template
        // konfirmasi SOP "Baik kami proses.."). Evaluasi ulang consent via regex hanya menghasilkan
        // false positive — pembeli bisa jawab "Y", "Sudah", bahasa daerah, dll yang tidak tertangkap.
        if (!isConfirmedClosing) {
            var positiveConsent = /(iya|deal|setuju|kirim|bungkus|proses|ambil|order|pesan|minat|transfer|cod|siap|jadi mas|jadi kak|oke kak|ok kak|oke mas|ok mas|\by\b|\bok\b|\bya\b|sudah benar|sdh benar|betul|bener|lakukan pemesanan|secepatnya|nama\s*[,:]|alamat\s*[,:]|no\s*hp\s*[,:]|kecamatan|kabupaten|desa|kelurahan|jalan|hitam|coklat)/i;
            var buyerConsented = positiveConsent.test(allBuyerText);
            var csForced = /(langsung kami bungkus ya|langsung kami buatkan resi|saya catat ya kak)/i.test(allCsText);
            if (!buyerConsented && conversion === 'CLOSING') {
                qualityScore -= 30;
                chatReasons.push('Pembeli tidak memberikan persetujuan eksplisit (Closing terindikasi dipaksa CS)');
            }
            else if (csForced && buyerLines.length < 2 && conversion === 'CLOSING') {
                qualityScore -= 20;
                chatReasons.push('CS terlalu terburu-buru menutup pesanan sebelum pembeli yakin');
            }
        }
        // 2. DIMENSI B: Kelengkapan Alamat & Patokan (Address Granularity)
        var hasRtRw = /\b(rt\b|rw\b|rt\/rw|rtrw|nomor\b|no\.\s*\d+|no\s*\d+|jl\b|jalan\b|gang\b|gg\b|blok\b|dusun\b)|\d+\/\d+/i.test(fullTranscriptText);
        var hasDusunDesa = /\b(desa\b|kelurahan\b|kel\b|dusun\b|kampung\b|kp\b|ds\b|kecamatan\b|kec\b|kabupaten\b|kab\b|kota\b)/i.test(fullTranscriptText);
        var hasPatokan = /\b(patokan\b|ancer|dekat\b|sebelah\b|depan\b|belakang\b|samping\b|seberang\b|pos\s*ronda|pos\s*satpam|masjid\b|mesjid\b|mushola\b|musholla\b|surau\b|sekolah\b|sd\b|smp\b|sma\b|warung\b|toko\b|pagar\b|komplek\b|perum\b|perumahan\b|lapangan\b|kantor\s*desa|balai\s*desa|pasar\b|jembatan\b)/i.test(fullTranscriptText);
        if (conversion === 'CLOSING') {
            if (!hasRtRw && !hasDusunDesa) {
                qualityScore -= 40;
                chatReasons.push('Alamat pembeli sangat minim (tidak ada RT/RW atau Dusun/Kecamatan)');
            }
            else if (!hasPatokan && !hasRtRw) {
                qualityScore -= 25;
                chatReasons.push('Alamat belum dilengkapi patokan rumah atau nomor RT/RW spesifik (berisiko kurir gagal antar)');
            }
        }
        // 3. DIMENSI C: Transparansi Biaya & COD (Price Transparency)
        var mentionsTotal = /(total|rp|ribu|\.000|,000|ongkir|biaya|harga|bayar)/i.test(allCsText);
        if (conversion === 'CLOSING' && !mentionsTotal) {
            qualityScore -= 15;
            chatReasons.push('CS tidak merinci total nominal biaya COD yang harus dibayar');
        }
        // 4. DIMENSI D: Kesiapan Dana & Orang di Rumah (Commitment Anchor)
        var mentionsReadiness = /(siapkan uang|uang pas|ada orang|orang dirumah|orang di rumah|titip uang|jangan kemana-mana|kurir hubungi|siapkan dana|pastikan hp|hp selalu aktif|bayar cod)/i.test(allCsText);
        if (conversion === 'CLOSING' && !mentionsReadiness) {
            qualityScore -= 5;
            chatReasons.push('CS belum mengingatkan kesiapan uang tunai atau keberadaan penerima saat kurir tiba');
        }
        // 5. DIMENSI E: Keberatan / Keraguan yang Diabaikan (Unresolved Hesitation)
        // DILEWATI jika isConfirmedClosing = true.
        // Alasan: Pembeli bisa saja pernah ragu di sesi awal, lalu di sesi lanjutan sudah mantap
        // dan setuju. Karena session parser memotong percakapan, pesan keraguan lama bisa ikut
        // terbaca di sesi yang berbeda dari closing — menghasilkan false flag padahal CS sudah
        // berhasil meyakinkan pembeli di sesi berikutnya.
        if (!isConfirmedClosing) {
            var buyerHesitation = /(tanya suami|tanya istri|kemahalan|nanti dulu|pikir dulu|belum gajian|lagi gak ada uang|mahal)/i.test(allBuyerText);
            if (buyerHesitation && conversion === 'CLOSING') {
                qualityScore -= 20;
                chatReasons.push('Pembeli sempat ragu/menolak halus namun tetap diproses kirim');
            }
        }
        // Normalisasi skor kualitas ke rentang 0 - 100
        var finalQualityScore = Math.max(10, Math.min(100, qualityScore));
        return { chatQualityScore: finalQualityScore, chatReasons: chatReasons };
    };
    /**
     * Gabungkan Analisis Chat AI dengan Data Logistik Mengantar (2-Layer Anti-RTS Firewall)
     */
    RtsRiskEngine.blendRtsRisk = function (chatQualityScore, chatReasons, mengantarData, conversion) {
        var reasons = __spreadArray([], chatReasons, true);
        var courierRecommendation = null;
        // Jika statusnya LOST (Batal), tidak ada pengiriman paket
        if (conversion === 'LOST') {
            return {
                rtsRiskScore: 0,
                rtsRiskLevel: 'LOW',
                chatQualityScore: chatQualityScore,
                reasons: ['Percakapan batal / tidak terjadi pengiriman'],
                courierRecommendation: null,
                mengantarData: mengantarData || undefined,
            };
        }
        var isTranscriptMissing = chatReasons.some(function (r) { return r.includes('belum tersinkronisasi'); });
        // 1. Hitung Risiko Kualitas Chat CS (Invers Kualitas Chat 0 - 100%)
        var chatRiskScore = isTranscriptMissing ? 0 : Math.max(0, 100 - chatQualityScore);
        // 2. Evaluasi Data Logistik Mengantar
        var mengantarRiskScore = 0;
        if (mengantarData && mengantarData.totalOrders > 0) {
            courierRecommendation = mengantarData.recommendedCourier;
            // Rasio kegagalan kirim + penalti kejadian retur masa lalu (+10% per RTS)
            var deliveryFailureRate = Math.max(0, 100 - mengantarData.overallDeliveryRate);
            var rtsPenalty = (mengantarData.totalRts || 0) * 10;
            mengantarRiskScore = Math.min(100, deliveryFailureRate + rtsPenalty);
            if (mengantarData.riskReasons && mengantarData.riskReasons.length > 0) {
                reasons.push.apply(reasons, mengantarData.riskReasons);
            }
        }
        // 3. Pembobotan Real
        var rtsRiskScore = 0;
        if (conversion === 'PENDING') {
            // Pada tahap follow up (belum deal), risiko kirim murni dari reputasi logistik pembeli
            rtsRiskScore = mengantarData && mengantarData.totalOrders > 0 ? mengantarRiskScore : 0;
        }
        else {
            // Pada tahap CLOSING (sudah deal)
            if (mengantarData && mengantarData.totalOrders > 0) {
                if (isTranscriptMissing) {
                    rtsRiskScore = mengantarRiskScore;
                }
                else {
                    rtsRiskScore = Math.round((chatRiskScore * 0.60) + (mengantarRiskScore * 0.40));
                }
            }
            else {
                rtsRiskScore = chatRiskScore;
            }
        }
        // 4. Tentukan Level Risiko RTS & Susun Rincian Alasan
        var rtsRiskLevel = 'LOW';
        if (rtsRiskScore <= 15) {
            rtsRiskLevel = 'LOW';
        }
        else if (rtsRiskScore <= 45) {
            rtsRiskLevel = 'MEDIUM';
        }
        else {
            rtsRiskLevel = 'HIGH';
        }
        var finalReasons = [];
        if (chatReasons.length > 0) {
            finalReasons.push.apply(finalReasons, chatReasons);
        }
        if (finalReasons.length === 0) {
            finalReasons.push('SOP percakapan CS terpenuhi & komitmen pembeli terpantau baik');
        }
        return {
            rtsRiskScore: rtsRiskScore,
            rtsRiskLevel: rtsRiskLevel,
            chatQualityScore: chatQualityScore,
            reasons: finalReasons,
            courierRecommendation: courierRecommendation,
            mengantarData: mengantarData || undefined,
        };
    };
    return RtsRiskEngine;
}());
exports.RtsRiskEngine = RtsRiskEngine;
