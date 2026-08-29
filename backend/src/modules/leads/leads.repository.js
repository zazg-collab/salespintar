"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.LeadsRepository = void 0;
var prisma_1 = require("../../config/prisma");
var lead_profile_dto_1 = require("./dto/lead-profile.dto");
var lead_scoring_engine_1 = require("./lead-scoring.engine");
var timezone_1 = require("../../utils/timezone");
var logger_1 = require("../../utils/logger");
// Fase 44: import dinamis di dalam body fungsi untuk hindari lingkaran import
// (leads.repository → capi.service → capi.queue → bullmq)
var LeadsRepository = /** @class */ (function () {
    function LeadsRepository() {
    }
    /**
     * Sanitasi JID Baileys ke format nomor telepon bersih E.164 (mis: "6281234567890")
     */
    LeadsRepository.sanitizeWaNumber = function (jid) {
        if (!jid)
            return '';
        // Buang status story, broadcast, group JID
        if (jid.includes('status@broadcast') || jid.includes('@g.us') || jid.includes('@newsletter')) {
            return '';
        }
        // Buang @s.whatsapp.net, @c.us, @lid, dan suffix device :12
        var clean = jid.split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
        return clean.length >= 7 ? clean : '';
    };
    /**
     * Upsert Lead Record dengan High-Water Mark Anti-Downgrade & Idempotensi.
     */
    LeadsRepository.upsertLeadProfile = function (data) {
        return __awaiter(this, void 0, void 0, function () {
            var waNumber, now, existing, finalConversion_1, isLost, _a, finalStage_1, finalScore_1, finalLeadCategory_1, cleanMinat, finalMinatProduk_1, isNewGeneric, isOldSpecific, isRepeatOrder, atomicConversionOuter_1, updatedLead, initialConversion, initialLabels, upserted;
            var _this = this;
            var _b, _c;
            return __generator(this, function (_d) {
                switch (_d.label) {
                    case 0:
                        waNumber = this.sanitizeWaNumber(data.rawJid);
                        if (!waNumber || !data.businessId)
                            return [2 /*return*/, null];
                        now = data.messageTimestamp ? (0, timezone_1.parseWibDateTime)(data.messageTimestamp) : new Date();
                        return [4 /*yield*/, prisma_1.prisma.lead.findFirst({
                                where: {
                                    businessId: data.businessId,
                                    waNumber: waNumber,
                                },
                                orderBy: {
                                    createdAt: 'desc',
                                },
                                select: {
                                    id: true,
                                    name: true,
                                    createdAt: true,
                                    lastMessageAt: true,
                                    score: true,
                                    leadCategory: true,
                                    leadStage: true,
                                    conversionStatus: true,
                                    totalMessages: true,
                                    minatProduk: true,
                                    lastInsight: true,
                                    ctwaClid: true, // Fase 44: dipakai untuk action_source CAPI (CTWA vs form)
                                    capiEventsSent: true, // Fase 44: dedup — event apa saja yang sudah dikirim
                                },
                            })];
                    case 1:
                        existing = _d.sent();
                        if (!existing) return [3 /*break*/, 4];
                        finalConversion_1 = data.conversion;
                        if ((existing.conversionStatus === 'CLOSING' || existing.conversionStatus === 'REPEAT_ORDER') &&
                            (data.conversion === 'PENDING' || data.conversion === 'LOST') &&
                            !data.allowTerminalDowngrade) {
                            finalConversion_1 = existing.conversionStatus;
                        }
                        isLost = finalConversion_1 === 'LOST';
                        _a = lead_scoring_engine_1.LeadScoringEngine.resolveNextStage(existing.leadStage || 'COLD', existing.score || 0, data.stage, data.score, isLost), finalStage_1 = _a.finalStage, finalScore_1 = _a.finalScore;
                        finalLeadCategory_1 = data.leadCategory || existing.leadCategory;
                        if (existing.leadCategory === 'PROSPEK_IKLAN' && (data.leadCategory === 'OTHERS' || data.leadCategory === 'NEW_INBOUND')) {
                            finalLeadCategory_1 = 'PROSPEK_IKLAN';
                        }
                        else if (existing.leadCategory === 'NEW_INBOUND' && data.leadCategory === 'OTHERS') {
                            finalLeadCategory_1 = 'NEW_INBOUND';
                        }
                        cleanMinat = data.minatProduk;
                        if (cleanMinat === 'null' || cleanMinat === 'undefined' || cleanMinat === 'none' || cleanMinat === 'n/a') {
                            cleanMinat = null;
                        }
                        finalMinatProduk_1 = cleanMinat;
                        isNewGeneric = !(0, lead_profile_dto_1.isValidSpecificProductName)(cleanMinat);
                        isOldSpecific = (0, lead_profile_dto_1.isValidSpecificProductName)(existing.minatProduk);
                        if (isNewGeneric && isOldSpecific) {
                            finalMinatProduk_1 = existing.minatProduk;
                        }
                        else if (!isNewGeneric) {
                            finalMinatProduk_1 = cleanMinat;
                        }
                        else {
                            finalMinatProduk_1 = null;
                        }
                        isRepeatOrder = false;
                        if (!!isRepeatOrder) return [3 /*break*/, 4];
                        atomicConversionOuter_1 = finalConversion_1;
                        return [4 /*yield*/, prisma_1.prisma.$transaction(function (tx) { return __awaiter(_this, void 0, void 0, function () {
                                var freshStatus, atomicConversion, finalName;
                                return __generator(this, function (_a) {
                                    switch (_a.label) {
                                        case 0: return [4 /*yield*/, tx.lead.findUnique({
                                                where: { id: existing.id },
                                                select: { conversionStatus: true, name: true },
                                            })];
                                        case 1:
                                            freshStatus = _a.sent();
                                            atomicConversion = finalConversion_1;
                                            if (((freshStatus === null || freshStatus === void 0 ? void 0 : freshStatus.conversionStatus) === 'CLOSING' || (freshStatus === null || freshStatus === void 0 ? void 0 : freshStatus.conversionStatus) === 'REPEAT_ORDER') &&
                                                (data.conversion === 'PENDING' || data.conversion === 'LOST') &&
                                                !data.allowTerminalDowngrade) {
                                                atomicConversion = freshStatus.conversionStatus;
                                            }
                                            atomicConversionOuter_1 = atomicConversion; // expose ke outer scope
                                            finalName = data.name || (freshStatus === null || freshStatus === void 0 ? void 0 : freshStatus.name) || existing.name || undefined;
                                            return [2 /*return*/, tx.lead.update({
                                                    where: { id: existing.id },
                                                    data: {
                                                        name: finalName,
                                                        score: finalScore_1,
                                                        leadCategory: finalLeadCategory_1,
                                                        leadStage: finalStage_1,
                                                        conversionStatus: atomicConversion,
                                                        minatProduk: (finalMinatProduk_1 || undefined),
                                                        lastInsight: data.lastInsight || undefined,
                                                        objectionType: data.objectionType || undefined,
                                                        taktikCS: data.taktikCS || undefined,
                                                        draftWA: data.draftWA || undefined,
                                                        assignedCsName: data.csName || undefined,
                                                        assignedCsPhone: data.csPhone || undefined,
                                                        rtsRiskScore: data.rtsRiskScore !== undefined ? data.rtsRiskScore : undefined,
                                                        rtsRiskLevel: data.rtsRiskLevel || undefined,
                                                        rtsReasons: data.rtsReasons || undefined,
                                                        courierRecommendation: data.courierRecommendation !== undefined ? data.courierRecommendation : undefined,
                                                        mengantarData: data.mengantarData !== undefined ? data.mengantarData : undefined,
                                                        confirmedCodAmount: data.confirmedCodAmount !== undefined ? data.confirmedCodAmount : undefined,
                                                        lastMessageAt: now,
                                                        totalMessages: { increment: 1 },
                                                    },
                                                })];
                                    }
                                });
                            }); })];
                    case 2:
                        updatedLead = _d.sent();
                        // Eksekusi Auto-Match jika form tersubmit SEBELUM chat WA masuk (Skenario Repeat Order / Chat Ulang)
                        // MUST RUN BEFORE CAPI HOOK TO ENSURE LEAD HAS FBP/FBC
                        return [4 /*yield*/, this.matchFormAttribution(data.businessId, waNumber, updatedLead.id)];
                    case 3:
                        // Eksekusi Auto-Match jika form tersubmit SEBELUM chat WA masuk (Skenario Repeat Order / Chat Ulang)
                        // MUST RUN BEFORE CAPI HOOK TO ENSURE LEAD HAS FBP/FBC
                        _d.sent();
                        // ── Fase 44: CAPI hook (fire-and-forget, error ditangkap di dalam enqueueCapiIfNeeded) ──
                        void (function () { return __awaiter(_this, void 0, void 0, function () {
                            var enqueueCapiIfNeeded, capiErr_1;
                            var _a, _b, _c;
                            return __generator(this, function (_d) {
                                switch (_d.label) {
                                    case 0:
                                        _d.trys.push([0, 3, , 4]);
                                        return [4 /*yield*/, Promise.resolve().then(function () { return require('../../services/capi.service'); })];
                                    case 1:
                                        enqueueCapiIfNeeded = (_d.sent()).enqueueCapiIfNeeded;
                                        return [4 /*yield*/, enqueueCapiIfNeeded({
                                                businessId: data.businessId,
                                                leadId: existing.id,
                                                waNumber: waNumber,
                                                name: ((_a = data.name) !== null && _a !== void 0 ? _a : existing.name) || null,
                                                ctwaClid: (_b = existing.ctwaClid) !== null && _b !== void 0 ? _b : null,
                                                finalLeadCategory: finalLeadCategory_1,
                                                finalStage: finalStage_1,
                                                prevStage: existing.leadStage,
                                                atomicConversion: atomicConversionOuter_1,
                                                prevConversion: existing.conversionStatus,
                                                capiEventsSent: (_c = existing.capiEventsSent) !== null && _c !== void 0 ? _c : [],
                                                confirmedCodAmount: data.confirmedCodAmount,
                                                isNewLead: false,
                                            })];
                                    case 2:
                                        _d.sent();
                                        return [3 /*break*/, 4];
                                    case 3:
                                        capiErr_1 = _d.sent();
                                        logger_1.logger.error("[LeadsRepository/CAPI] Hook gagal untuk lead ".concat(existing.id, ": ").concat(capiErr_1));
                                        return [3 /*break*/, 4];
                                    case 4: return [2 /*return*/];
                                }
                            });
                        }); })();
                        return [2 /*return*/, updatedLead];
                    case 4:
                        initialConversion = data.conversion;
                        initialLabels = [];
                        if (existing && (existing.conversionStatus === 'CLOSING' || existing.conversionStatus === 'REPEAT_ORDER')) {
                            if (data.conversion === 'CLOSING' || data.conversion === 'REPEAT_ORDER') {
                                initialConversion = 'REPEAT_ORDER';
                                initialLabels.push('REPEAT_ORDER');
                            }
                        }
                        return [4 /*yield*/, prisma_1.prisma.lead.upsert({
                                where: {
                                    businessId_waNumber: {
                                        businessId: data.businessId,
                                        waNumber: waNumber,
                                    },
                                },
                                create: {
                                    businessId: data.businessId,
                                    waNumber: waNumber,
                                    labels: initialLabels,
                                    leadCategory: data.leadCategory || 'NEW_INBOUND',
                                    score: data.score,
                                    leadStage: data.stage,
                                    conversionStatus: initialConversion,
                                    minatProduk: (data.minatProduk && data.minatProduk !== 'null' && data.minatProduk !== 'undefined' && data.minatProduk !== 'none') ? data.minatProduk : null,
                                    lastInsight: data.lastInsight || 'Baru masuk via WhatsApp CS',
                                    objectionType: data.objectionType || null,
                                    taktikCS: data.taktikCS || null,
                                    draftWA: data.draftWA || null,
                                    assignedCsName: data.csName,
                                    assignedCsPhone: data.csPhone,
                                    rtsRiskScore: (_b = data.rtsRiskScore) !== null && _b !== void 0 ? _b : 0,
                                    rtsRiskLevel: data.rtsRiskLevel || 'LOW',
                                    rtsReasons: data.rtsReasons || [],
                                    courierRecommendation: data.courierRecommendation || null,
                                    mengantarData: data.mengantarData || undefined,
                                    confirmedCodAmount: (_c = data.confirmedCodAmount) !== null && _c !== void 0 ? _c : null,
                                    createdAt: now,
                                    lastMessageAt: now,
                                    totalMessages: 1,
                                },
                                update: {
                                    // Race Opsi A vs Opsi B: baris untuk kontak ini ternyata SUDAH dibuat oleh proses
                                    // lain tepat di antara findFirst di langkah 1 dan upsert ini. Constraint unik
                                    // menjamin tidak ada baris duplikat — tapi kita SENGAJA TIDAK menimpa hasil analisis
                                    // proses lain di sini (race window sempit & jarang; kita tidak punya state
                                    // pre-image proses lain untuk dibandingkan secara aman seperti di jalur update
                                    // transaksional di atas). Cukup catat bahwa ada follow-up message masuk.
                                    lastMessageAt: now,
                                    totalMessages: { increment: 1 },
                                },
                            })];
                    case 5:
                        upserted = _d.sent();
                        // Ronde Penyanggal Langkah A (TERBUKTI TAPI DILEBIH-LEBIHKAN — window race lebih sempit
                        // dari klaim awal karena sweeper terbukti skip kontak baru, tapi tetap mungkin lewat
                        // retry/duplicate webhook): cabang `update` di atas SENGAJA tidak menimpa hasil analisis
                        // pesan ini. Supaya kejadian ini tidak diam-diam hilang dari observability, catat log
                        // kalau ternyata upsert jatuh ke cabang update (createdAt tidak sama dengan `now` berarti
                        // baris ini sudah ada sebelumnya, bukan baru dibuat oleh panggilan ini).
                        if (upserted && upserted.createdAt && upserted.createdAt.getTime() !== now.getTime()) {
                            logger_1.logger.warn("[LeadsRepository] upsertLeadProfile race: lead ".concat(data.businessId, "/").concat(waNumber, " ternyata sudah ada saat coba dibuat baru. Analisis pesan ini (score/stage/conversion/lastInsight) TIDAK diterapkan, hanya totalMessages & lastMessageAt yang diperbarui."));
                        }
                        else if (upserted) {
                        }
                        // Eksekusi Auto-Match jika form tersubmit SEBELUM chat WA masuk
                        return [4 /*yield*/, this.matchFormAttribution(data.businessId, waNumber, upserted.id)];
                    case 6:
                        // Eksekusi Auto-Match jika form tersubmit SEBELUM chat WA masuk
                        _d.sent();
                        if (upserted && !(upserted.createdAt && upserted.createdAt.getTime() !== now.getTime())) {
                            // ── Fase 44: CAPI Lead event untuk lead baru (fire-and-forget) ──
                            void (function () { return __awaiter(_this, void 0, void 0, function () {
                                var enqueueCapiIfNeeded, capiErr_2;
                                return __generator(this, function (_a) {
                                    switch (_a.label) {
                                        case 0:
                                            _a.trys.push([0, 3, , 4]);
                                            return [4 /*yield*/, Promise.resolve().then(function () { return require('../../services/capi.service'); })];
                                        case 1:
                                            enqueueCapiIfNeeded = (_a.sent()).enqueueCapiIfNeeded;
                                            return [4 /*yield*/, enqueueCapiIfNeeded({
                                                    businessId: data.businessId,
                                                    leadId: upserted.id,
                                                    waNumber: waNumber,
                                                    name: data.name || null,
                                                    ctwaClid: null, // dibaca ulang oleh worker saat job diproses
                                                    finalLeadCategory: data.leadCategory || 'NEW_INBOUND',
                                                    finalStage: data.stage,
                                                    prevStage: 'COLD',
                                                    atomicConversion: upserted.conversionStatus,
                                                    prevConversion: 'PENDING',
                                                    capiEventsSent: [],
                                                    confirmedCodAmount: data.confirmedCodAmount,
                                                    isNewLead: true,
                                                })];
                                        case 2:
                                            _a.sent();
                                            return [3 /*break*/, 4];
                                        case 3:
                                            capiErr_2 = _a.sent();
                                            logger_1.logger.error("[LeadsRepository/CAPI] Hook new-lead gagal untuk lead ".concat(upserted.id, ": ").concat(capiErr_2));
                                            return [3 /*break*/, 4];
                                        case 4: return [2 /*return*/];
                                    }
                                });
                            }); })();
                        }
                        return [2 /*return*/, upserted];
                }
            });
        });
    };
    /**
     * Ambil daftar lead dengan pagination dan filter.
     */
    LeadsRepository.listLeads = function (params) {
        return __awaiter(this, void 0, void 0, function () {
            var page, limit, skip, where, q, dateFilter, sortField, sortDir, _a, total, items;
            var _b;
            return __generator(this, function (_c) {
                switch (_c.label) {
                    case 0:
                        page = Math.max(1, params.page || 1);
                        limit = Math.min(100, Math.max(1, params.limit || 50));
                        skip = (page - 1) * limit;
                        where = {
                            businessId: params.businessId,
                        };
                        if (params.leadCategory && params.leadCategory !== 'ALL') {
                            where.leadCategory = params.leadCategory;
                        }
                        if (params.stage && params.stage !== 'ALL') {
                            where.leadStage = params.stage;
                        }
                        if (params.conversion === 'REPEAT_ORDER') {
                            where.OR = [
                                { conversionStatus: 'REPEAT_ORDER' },
                                { labels: { has: 'REPEAT_ORDER' } },
                            ];
                        }
                        else if (params.conversion && params.conversion !== 'ALL') {
                            where.conversionStatus = params.conversion;
                        }
                        if (params.rtsLevel && params.rtsLevel !== 'ALL') {
                            where.rtsRiskLevel = params.rtsLevel;
                        }
                        if (params.csPhone) {
                            where.assignedCsPhone = params.csPhone;
                        }
                        if (params.csName && params.csName !== 'ALL') {
                            where.assignedCsName = params.csName;
                        }
                        if (params.search) {
                            q = params.search.trim();
                            where.OR = [
                                { waNumber: { contains: q, mode: 'insensitive' } },
                                { minatProduk: { contains: q, mode: 'insensitive' } },
                                { lastInsight: { contains: q, mode: 'insensitive' } },
                                { assignedCsName: { contains: q, mode: 'insensitive' } },
                            ];
                        }
                        dateFilter = (0, timezone_1.getWibDateRange)(params.startDate, params.endDate);
                        if (dateFilter) {
                            // Default: filter berdasarkan createdAt (Waktu Lahir Lead) — angka historis stabil, konsisten dg Dashboard CS.
                            // Jika filterBy=lastMessageAt (mode "⚡ Update Terbaru"), gunakan lastMessageAt untuk monitoring percakapan aktif.
                            if (params.filterBy === 'lastMessageAt') {
                                where.lastMessageAt = dateFilter;
                            }
                            else {
                                where.createdAt = dateFilter;
                            }
                        }
                        sortField = params.sortBy === 'createdAt' ? 'createdAt' : 'lastMessageAt';
                        sortDir = params.sortOrder === 'asc' ? 'asc' : 'desc';
                        return [4 /*yield*/, Promise.all([
                                prisma_1.prisma.lead.count({ where: where }),
                                prisma_1.prisma.lead.findMany({
                                    where: where,
                                    orderBy: (_b = {}, _b[sortField] = sortDir, _b),
                                    skip: skip,
                                    take: limit,
                                }),
                            ])];
                    case 1:
                        _a = _c.sent(), total = _a[0], items = _a[1];
                        return [2 /*return*/, {
                                items: items,
                                meta: {
                                    total: total,
                                    page: page,
                                    limit: limit,
                                    totalPages: Math.ceil(total / limit),
                                },
                            }];
                }
            });
        });
    };
    /**
     * Ambil semua lead untuk Export CSV / Excel tanpa pagination limit.
     */
    LeadsRepository.getAllForExport = function (params) {
        return __awaiter(this, void 0, void 0, function () {
            var where, q, dateFilter;
            return __generator(this, function (_a) {
                where = {
                    businessId: params.businessId,
                };
                if (params.leadCategory && params.leadCategory !== 'ALL') {
                    where.leadCategory = params.leadCategory;
                }
                if (params.stage && params.stage !== 'ALL') {
                    where.leadStage = params.stage;
                }
                if (params.conversion === 'REPEAT_ORDER') {
                    where.OR = [
                        { conversionStatus: 'REPEAT_ORDER' },
                        { labels: { has: 'REPEAT_ORDER' } },
                    ];
                }
                else if (params.conversion && params.conversion !== 'ALL') {
                    where.conversionStatus = params.conversion;
                }
                if (params.rtsLevel && params.rtsLevel !== 'ALL') {
                    where.rtsRiskLevel = params.rtsLevel;
                }
                if (params.csPhone) {
                    where.assignedCsPhone = params.csPhone;
                }
                if (params.csName && params.csName !== 'ALL') {
                    where.assignedCsName = params.csName;
                }
                if (params.search) {
                    q = params.search.trim();
                    where.OR = [
                        { waNumber: { contains: q, mode: 'insensitive' } },
                        { minatProduk: { contains: q, mode: 'insensitive' } },
                        { lastInsight: { contains: q, mode: 'insensitive' } },
                        { assignedCsName: { contains: q, mode: 'insensitive' } },
                    ];
                }
                dateFilter = (0, timezone_1.getWibDateRange)(params.startDate, params.endDate);
                if (dateFilter) {
                    if (params.filterBy === 'lastMessageAt') {
                        where.lastMessageAt = dateFilter;
                    }
                    else {
                        where.createdAt = dateFilter;
                    }
                }
                return [2 /*return*/, prisma_1.prisma.lead.findMany({
                        where: where,
                        orderBy: { lastMessageAt: 'desc' },
                        take: 10000, // safety cap
                    })];
            });
        });
    };
    /**
     * Hitung agregat ringkas untuk Summary Cards (opsional dengan filter tanggal & CS).
     */
    LeadsRepository.getStats = function (businessId, startDate, endDate, csPhone, csName, leadCategory, filterBy) {
        return __awaiter(this, void 0, void 0, function () {
            var where, dateFilter, _a, total, hot, warm, cold, closing, pending, lost, highRiskRts, rtsAggregate;
            return __generator(this, function (_b) {
                switch (_b.label) {
                    case 0:
                        where = { businessId: businessId };
                        if (leadCategory && leadCategory !== 'ALL') {
                            where.leadCategory = leadCategory;
                        }
                        if (csPhone) {
                            where.assignedCsPhone = csPhone;
                        }
                        if (csName && csName !== 'ALL') {
                            where.assignedCsName = csName;
                        }
                        dateFilter = (0, timezone_1.getWibDateRange)(startDate, endDate);
                        if (dateFilter) {
                            // Default: createdAt (stabil, konsisten dg Dashboard CS).
                            // lastMessageAt hanya untuk mode "⚡ Update Terbaru".
                            if (filterBy === 'lastMessageAt') {
                                where.lastMessageAt = dateFilter;
                            }
                            else {
                                where.createdAt = dateFilter;
                            }
                        }
                        return [4 /*yield*/, Promise.all([
                                prisma_1.prisma.lead.count({ where: where }),
                                prisma_1.prisma.lead.count({ where: __assign(__assign({}, where), { leadStage: { in: ['HOT', 'VERY_HOT'] } }) }),
                                prisma_1.prisma.lead.count({ where: __assign(__assign({}, where), { leadStage: 'WARM' }) }),
                                prisma_1.prisma.lead.count({ where: __assign(__assign({}, where), { leadStage: 'COLD' }) }),
                                // Langkah E Fase 27 (Temuan KPI): "Closing Deal" harus menghitung CLOSING +
                                // REPEAT_ORDER -- sebelumnya cuma 'CLOSING' persis, jadi pelanggan berulang
                                // (kalau/ketika conversionStatus REPEAT_ORDER benar-benar tersimpan) hilang dari KPI.
                                prisma_1.prisma.lead.count({ where: __assign(__assign({}, where), { conversionStatus: { in: ['CLOSING', 'REPEAT_ORDER'] } }) }),
                                prisma_1.prisma.lead.count({ where: __assign(__assign({}, where), { conversionStatus: 'PENDING' }) }),
                                prisma_1.prisma.lead.count({ where: __assign(__assign({}, where), { conversionStatus: 'LOST' }) }),
                                prisma_1.prisma.lead.count({ where: __assign(__assign({}, where), { rtsRiskLevel: 'HIGH' }) }),
                                prisma_1.prisma.lead.aggregate({
                                    where: __assign(__assign({}, where), { rtsRiskScore: { not: null } }),
                                    _avg: { rtsRiskScore: true },
                                }),
                            ])];
                    case 1:
                        _a = _b.sent(), total = _a[0], hot = _a[1], warm = _a[2], cold = _a[3], closing = _a[4], pending = _a[5], lost = _a[6], highRiskRts = _a[7], rtsAggregate = _a[8];
                        return [2 /*return*/, {
                                totalLeads: total,
                                hotLeads: hot,
                                warmLeads: warm,
                                coldLeads: cold,
                                closingLeads: closing,
                                pendingLeads: pending,
                                lostLeads: lost,
                                avgRtsRisk: Math.round(rtsAggregate._avg.rtsRiskScore || 0),
                                highRiskRtsLeads: highRiskRts,
                            }];
                }
            });
        });
    };
    /**
     * Ambil daftar nama CS unik yang ada di database untuk dropdown filter.
     */
    LeadsRepository.getCsList = function (businessId) {
        return __awaiter(this, void 0, void 0, function () {
            var leads;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0: return [4 /*yield*/, prisma_1.prisma.lead.findMany({
                            where: {
                                businessId: businessId,
                                assignedCsName: { not: null },
                            },
                            select: {
                                assignedCsName: true,
                                assignedCsPhone: true,
                            },
                            distinct: ['assignedCsName'],
                            orderBy: { assignedCsName: 'asc' },
                        })];
                    case 1:
                        leads = _a.sent();
                        return [2 /*return*/, leads
                                .filter(function (l) { return l.assignedCsName && l.assignedCsName.trim().length > 0; })
                                .map(function (l) { return ({
                                name: l.assignedCsName,
                                phone: l.assignedCsPhone || null,
                            }); })];
                }
            });
        });
    };
    // --- FASE 1: Auto-Matching CAPI Attribution ---
    // Audit Fase 46 (2026-08-21): updateMany sekarang memakai filter tanggal yang SAMA
    // dengan findFirst, supaya scope keduanya konsisten. Sebelumnya updateMany tanpa
    // filter tanggal bisa mark record lama (>7 hari) sebagai MATCHED ke leadId yang
    // tidak berkaitan.
    // Fix #5 (Fase 47): tambah warn log ketika attribution tidak ditemukan — sebelumnya
    // ini silent failure, lead jalan tanpa fbp/fbc/eventSourceUrl tanpa ada tanda apapun.
    LeadsRepository.matchFormAttribution = function (businessId, waNumber, leadId) {
        return __awaiter(this, void 0, void 0, function () {
            var windowStart, recentAttribution, err_1;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        windowStart = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
                        _a.label = 1;
                    case 1:
                        _a.trys.push([1, 6, , 7]);
                        return [4 /*yield*/, prisma_1.prisma.formAttribution.findFirst({
                                where: {
                                    businessId: businessId,
                                    waNumber: waNumber,
                                    status: 'PENDING_MATCH',
                                    createdAt: { gte: windowStart }
                                },
                                orderBy: { createdAt: 'desc' }
                            })];
                    case 2:
                        recentAttribution = _a.sent();
                        if (!recentAttribution) return [3 /*break*/, 4];
                        return [4 /*yield*/, prisma_1.prisma.$transaction([
                                prisma_1.prisma.lead.update({
                                    where: { id: leadId },
                                    data: {
                                        fbp: recentAttribution.fbp || undefined,
                                        fbc: recentAttribution.fbc || undefined,
                                        clientUserAgent: recentAttribution.clientUserAgent || undefined,
                                        clientIp: recentAttribution.clientIp || undefined,
                                        eventSourceUrl: recentAttribution.eventSourceUrl || undefined,
                                    }
                                }),
                                prisma_1.prisma.formAttribution.updateMany({
                                    where: {
                                        businessId: businessId,
                                        waNumber: waNumber,
                                        status: 'PENDING_MATCH',
                                        createdAt: { gte: windowStart }, // selaraskan dengan scope findFirst
                                    },
                                    data: {
                                        status: 'MATCHED',
                                        matchedLeadId: leadId,
                                        matchedAt: new Date()
                                    }
                                })
                            ])];
                    case 3:
                        _a.sent();
                        logger_1.logger.info("[Attribution] Match sukses: formAttribution ".concat(recentAttribution.id, " \u2192 leadId=").concat(leadId, " ") +
                            "(fbp=".concat(!!recentAttribution.fbp, " fbc=").concat(!!recentAttribution.fbc, " url=").concat(!!recentAttribution.eventSourceUrl, ")"));
                        return [3 /*break*/, 5];
                    case 4:
                        // Fix #5: log eksplisit ketika tidak ada attribution — ini bukan error fatal,
                        // tapi penting untuk debugging: lead ini tidak akan punya fbp/fbc/eventSourceUrl
                        // sehingga CAPI routing mungkin fallback ke default pixel dan data atribusi kurang akurat.
                        logger_1.logger.warn("[Attribution] Tidak ada PENDING_MATCH attribution untuk waNumber=".concat(waNumber, " leadId=").concat(leadId, " ") +
                            "dalam 7 hari terakhir. Lead akan jalan tanpa tracking data.");
                        _a.label = 5;
                    case 5: return [3 /*break*/, 7];
                    case 6:
                        err_1 = _a.sent();
                        logger_1.logger.error("[Attribution] Auto-match gagal untuk leadId=".concat(leadId, ": ").concat(err_1));
                        return [3 /*break*/, 7];
                    case 7: return [2 /*return*/];
                }
            });
        });
    };
    return LeadsRepository;
}());
exports.LeadsRepository = LeadsRepository;
