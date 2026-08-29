"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.TimelineService = void 0;
var prisma_1 = require("../../config/prisma");
var timezone_1 = require("../../utils/timezone");
var leads_repository_1 = require("./leads.repository");
var TimelineService = /** @class */ (function () {
    function TimelineService() {
    }
    /**
     * Menghasilkan Timeline Perjalanan Pembeli Customer 360° Lintas Sesi & Multi-Order.
     */
    TimelineService.getCustomerTimeline = function (businessId, rawPhone) {
        return __awaiter(this, void 0, void 0, function () {
            var waNumber, leads, firstLead, latestLead, customerName, totalLifetimeValue, totalClosings, orderGroups, prevOrderEndTime, ESTIMATED_PRICES, idx, lead, prodName, isClosing, estPrice, orderStartTime, orderEndTime, gapDaysFromPrevious, diffMs, diffDays, events, isAdForm, convTitle, convDesc, convColor, isEvaluationFailed, isLowRisk, title, badgeColor, badgeText, description, firstContactAt, latestContactAt, salesCycleDiffMs, salesCycleDays, isRepeatBuyer;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        waNumber = leads_repository_1.LeadsRepository.sanitizeWaNumber(rawPhone);
                        if (!waNumber || !businessId)
                            return [2 /*return*/, null];
                        return [4 /*yield*/, prisma_1.prisma.lead.findMany({
                                where: {
                                    businessId: businessId,
                                    waNumber: waNumber,
                                },
                                orderBy: {
                                    createdAt: 'asc',
                                },
                            })];
                    case 1:
                        leads = _a.sent();
                        if (!leads || leads.length === 0) {
                            return [2 /*return*/, null];
                        }
                        firstLead = leads[0];
                        latestLead = leads[leads.length - 1];
                        customerName = latestLead.name || firstLead.name || 'Pelanggan';
                        totalLifetimeValue = 0;
                        totalClosings = 0;
                        orderGroups = [];
                        prevOrderEndTime = null;
                        ESTIMATED_PRICES = {
                            'Golok Situmang 3': 235000,
                            'Golok Situmang 2': 246000,
                            'Golok Black Mamba': 252000,
                            'Bedog Betekok': 195000,
                            'Golok Kebun Ekonomis 30': 180000,
                            'GKE 40 Perak Duralium': 265000,
                            'GKE 40 Perak Duralium 2': 285000,
                            'Golok Sembelih Multifungsi': 190000,
                            'Golok Tarisi': 210000,
                            'Pisau Sembelih': 175000,
                            'Pisau Seset': 150000,
                            'Batu Asahan': 85000,
                        };
                        for (idx = 0; idx < leads.length; idx++) {
                            lead = leads[idx];
                            prodName = lead.minatProduk || 'Produk Cordova';
                            isClosing = lead.conversionStatus === 'CLOSING';
                            estPrice = lead.confirmedCodAmount || ESTIMATED_PRICES[prodName] || (isClosing ? 200000 : 0);
                            if (isClosing) {
                                totalClosings++;
                                totalLifetimeValue += estPrice;
                            }
                            orderStartTime = lead.createdAt;
                            orderEndTime = lead.lastMessageAt || lead.updatedAt || lead.createdAt;
                            gapDaysFromPrevious = undefined;
                            if (prevOrderEndTime) {
                                diffMs = orderStartTime.getTime() - prevOrderEndTime.getTime();
                                diffDays = Math.round(diffMs / (1000 * 60 * 60 * 24));
                                if (diffDays >= 1) {
                                    gapDaysFromPrevious = diffDays;
                                }
                            }
                            prevOrderEndTime = orderEndTime;
                            events = [];
                            isAdForm = lead.leadCategory === 'PROSPEK_IKLAN';
                            events.push({
                                id: "ev-inbound-".concat(lead.id),
                                type: 'FIRST_INBOUND',
                                title: isAdForm ? 'Mengisi Formulir Iklan Landing Page' : 'Kontak Pertama Masuk (Chat WhatsApp)',
                                timestamp: orderStartTime.toISOString(),
                                timestampWib: (0, timezone_1.toJakartaDateTimeStr)(orderStartTime) + ' WIB',
                                description: isAdForm
                                    ? "Membawa data pesanan formulir iklan: ".concat(prodName, " ke CS ").concat(lead.assignedCsName || 'CS')
                                    : "Menghubungi CS ".concat(lead.assignedCsName || 'CS', " menanyakan informasi produk: ").concat(prodName),
                                badge: {
                                    text: isAdForm ? 'Form Iklan' : 'Inbound Organik',
                                    color: isAdForm ? 'indigo' : 'blue',
                                },
                            });
                            // Event 2: Konsultasi & Negosiasi CS
                            // Langkah D Fase 26 (Temuan T1): sebelumnya timestamp SELALU "+5 menit tepat" dari kontak
                            // pertama (bukan waktu asli respon CS -- data itu memang tidak tersimpan di mana pun, model
                            // Lead tidak punya kolom timestamp per-pesan), dan deskripsi template statis yg SELALU sama
                            // asal `assignedCsName` terisi, TANPA verifikasi CS benar2 melakukan hal2 itu di percakapan
                            // nyata. Kalau ditampilkan sbg jam:menit:detik presisi, ops/Bossfren bisa salah menyimpulkan
                            // ini log SLA respon CS sungguhan. Fix: jujur -- label "estimasi", tanpa jam presisi palsu.
                            if (lead.assignedCsName) {
                                events.push({
                                    id: "ev-cs-".concat(lead.id),
                                    type: 'CS_RESPONSE',
                                    title: "Konsultasi & Penanganan oleh CS ".concat(lead.assignedCsName, " (estimasi)"),
                                    timestamp: new Date(orderStartTime.getTime() + 5 * 60 * 1000).toISOString(),
                                    timestampWib: 'Estimasi, bukan waktu tercatat sebenarnya',
                                    description: "CS yang menangani: ".concat(lead.assignedCsName, ". Rincian biaya, ongkir, dan opsi pembayaran COD/Transfer BIASANYA disampaikan pada tahap ini -- deskripsi ini estimasi alur umum, bukan hasil pembacaan transkrip percakapan aktual sesi ini."),
                                    badge: {
                                        text: "CS: ".concat(lead.assignedCsName),
                                        color: 'blue',
                                    },
                                });
                            }
                            convTitle = 'Proses Follow-Up Berjalan';
                            convDesc = lead.lastInsight || 'Prospek sedang dalam tahap pertimbangan dan konsultasi.';
                            convColor = 'amber';
                            if (lead.conversionStatus === 'CLOSING') {
                                convTitle = 'Kesepakatan Deal (CLOSING)';
                                convDesc = "Pesanan ".concat(prodName, " disetujui kirim via COD (Estimasi Total: Rp ").concat(estPrice.toLocaleString('id-ID'), "). Catatan 6 SOP COD telah dikirim.");
                                convColor = 'emerald';
                            }
                            else if (lead.conversionStatus === 'LOST') {
                                convTitle = 'Prospek Batal (LOST)';
                                convDesc = lead.lastInsight || 'Pelanggan membatalkan pesanan atau tidak melanjutkan komunikasi.';
                                convColor = 'rose';
                            }
                            events.push({
                                id: "ev-deal-".concat(lead.id),
                                type: 'DEAL_CONVERSION',
                                title: convTitle,
                                timestamp: orderEndTime.toISOString(),
                                timestampWib: (0, timezone_1.toJakartaDateTimeStr)(orderEndTime) + ' WIB',
                                description: convDesc,
                                badge: {
                                    text: lead.conversionStatus,
                                    color: convColor,
                                },
                                details: {
                                    score: lead.score,
                                    stage: lead.leadStage,
                                },
                            });
                            // Event 4: Validasi Logistik & RTS (Jika Closing)
                            // Langkah D Fase 26 (Temuan T2, PALING SERIUS): sebelumnya kalau evaluasi RTS gagal total
                            // (exception di lead-profiler.service.ts, mis. API Mengantar down), sistem diam2 menyimpan
                            // default {rtsRiskLevel:'LOW', reasons:[]} -- yg di sini TIDAK BISA DIBEDAKAN dari hasil
                            // evaluasi yg benar2 sukses & aman. Badge hijau "AMAN" bisa muncul padahal alamat TIDAK
                            // PERNAH divalidasi -- CS bisa kirim COD tanpa validasi sungguhan. Fix: `lead-profiler.
                            // service.ts` sekarang menulis sentinel eksplisit 'EVALUATION_FAILED' (bukan diam2 'LOW')
                            // kalau lead ini belum pernah punya evaluasi sah sebelumnya -- di sini dirender BEDA dari
                            // "aman" (warna amber peringatan, bukan hijau, teks jujur "belum divalidasi").
                            if (lead.conversionStatus === 'CLOSING') {
                                isEvaluationFailed = lead.rtsRiskLevel === 'EVALUATION_FAILED';
                                isLowRisk = lead.rtsRiskLevel === 'LOW';
                                title = void 0;
                                badgeColor = void 0;
                                badgeText = void 0;
                                description = void 0;
                                if (isEvaluationFailed) {
                                    title = 'Audit Kepatuhan Alamat: BELUM TERVALIDASI (evaluasi gagal)';
                                    badgeColor = 'amber';
                                    badgeText = 'RTS: Perlu Verifikasi Manual';
                                    description = (lead.rtsReasons && lead.rtsReasons.length > 0)
                                        ? lead.rtsReasons.join(' • ')
                                        : 'Evaluasi kepatuhan alamat gagal dijalankan karena error teknis -- BUKAN berarti alamat sudah aman, perlu pengecekan manual sebelum resi dicetak.';
                                }
                                else {
                                    title = isLowRisk ? 'Audit Kepatuhan Alamat: AMAN (Low Risk)' : 'Audit Kepatuhan Alamat: PERLU PERHATIAN';
                                    badgeColor = isLowRisk ? 'emerald' : 'amber';
                                    badgeText = isLowRisk ? 'RTS Aman (0%)' : "RTS Risk: ".concat(lead.rtsRiskScore || 25, "%");
                                    description = (lead.rtsReasons && lead.rtsReasons.length > 0)
                                        ? lead.rtsReasons.join(' • ')
                                        : 'Data alamat lengkap dan SOP percakapan CS terpenuhi.';
                                }
                                events.push({
                                    id: "ev-rts-".concat(lead.id),
                                    type: 'RTS_VALIDATION',
                                    title: title,
                                    timestamp: new Date(orderEndTime.getTime() + 2 * 60 * 1000).toISOString(),
                                    timestampWib: (0, timezone_1.toJakartaDateTimeStr)(new Date(orderEndTime.getTime() + 2 * 60 * 1000)) + ' WIB',
                                    description: description,
                                    badge: {
                                        text: badgeText,
                                        color: badgeColor,
                                    },
                                    details: {
                                        courier: lead.courierRecommendation || 'J&T / JNE',
                                    },
                                });
                            }
                            orderGroups.push({
                                orderNumber: idx + 1,
                                leadId: lead.id,
                                product: prodName,
                                category: lead.leadCategory || 'NEW_INBOUND',
                                categoryLabel: lead.leadCategory === 'PROSPEK_IKLAN' ? 'Prospek Iklan' : (lead.leadCategory === 'AFTER_SALES' ? 'Layanan Purna Jual' : 'Prospek Organik'),
                                conversionStatus: lead.conversionStatus,
                                rtsRiskLevel: lead.rtsRiskLevel,
                                rtsReasons: lead.rtsReasons || [],
                                courierRecommendation: lead.courierRecommendation,
                                estimatedValue: estPrice,
                                csName: lead.assignedCsName || 'CS',
                                csPhone: lead.assignedCsPhone || '-',
                                startDate: orderStartTime.toISOString(),
                                startDateWib: (0, timezone_1.toJakartaDateTimeStr)(orderStartTime) + ' WIB',
                                endDate: orderEndTime.toISOString(),
                                endDateWib: (0, timezone_1.toJakartaDateTimeStr)(orderEndTime) + ' WIB',
                                gapDaysFromPrevious: gapDaysFromPrevious,
                                events: events,
                            });
                        }
                        firstContactAt = firstLead.createdAt;
                        latestContactAt = latestLead.lastMessageAt || latestLead.updatedAt || latestLead.createdAt;
                        salesCycleDiffMs = latestContactAt.getTime() - firstContactAt.getTime();
                        salesCycleDays = Math.max(0, Math.round(salesCycleDiffMs / (1000 * 60 * 60 * 24)));
                        isRepeatBuyer = totalClosings > 1 || leads.length > 1;
                        return [2 /*return*/, {
                                waNumber: waNumber,
                                name: customerName,
                                totalOrders: leads.length,
                                totalClosings: totalClosings,
                                totalLifetimeValue: totalLifetimeValue,
                                isRepeatBuyer: isRepeatBuyer,
                                firstContactAt: firstContactAt.toISOString(),
                                firstContactAtWib: (0, timezone_1.toJakartaDateTimeStr)(firstContactAt) + ' WIB',
                                latestContactAt: latestContactAt.toISOString(),
                                latestContactAtWib: (0, timezone_1.toJakartaDateTimeStr)(latestContactAt) + ' WIB',
                                salesCycleDays: salesCycleDays,
                                currentStage: latestLead.leadStage,
                                currentConversion: latestLead.conversionStatus,
                                assignedCsName: latestLead.assignedCsName || 'CS',
                                assignedCsPhone: latestLead.assignedCsPhone || '-',
                                orderGroups: orderGroups,
                            }];
                }
            });
        });
    };
    return TimelineService;
}());
exports.TimelineService = TimelineService;
