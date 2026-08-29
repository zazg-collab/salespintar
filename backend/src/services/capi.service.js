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
exports.DEFAULT_EVENT_MAP = exports.STAGE_RANK = void 0;
exports.hashPhone = hashPhone;
exports.hashName = hashName;
exports.buildEventId = buildEventId;
exports.normalizeUrl = normalizeUrl;
exports.sendCapiEvent = sendCapiEvent;
exports.enqueueCapiIfNeeded = enqueueCapiIfNeeded;
exports.reconcileCapiEvents = reconcileCapiEvents;
exports.reconcilePurchaseEvents = reconcilePurchaseEvents;
var crypto_1 = require("crypto");
var prisma_1 = require("../config/prisma");
var logger_1 = require("../utils/logger");
var crypto_service_1 = require("./crypto.service");
var capi_queue_1 = require("../queues/capi.queue");
// ────────────────────────────────────────────────────────────────────────────────
// CAPI SERVICE — Fase 43 (2026-08-21)
//
// Dua tanggung jawab utama:
//
// 1. sendCapiEvent(jobData) — dipanggil oleh capi.worker.ts:
//    Bangun payload Meta CAPI dan kirim ke Graph API via fetch() native.
//    Lempar error kalau gagal supaya BullMQ bisa retry.
//
// 2. enqueueCapiIfNeeded(params) — dipanggil oleh leads.repository.ts
//    setelah upsertLeadProfile() commit:
//    Tentukan event apa yang perlu dikirim, hindari duplikat via capiEventsSent[],
//    enqueue ke BullMQ, update DB. TIDAK pernah throw — semua error hanya di-log.
//
// Kenapa dipisah dari queue/worker? Service ini punya logika bisnis (gerbang,
// deteksi transisi stage/konversi, dedup) yang perlu di-unit-test tanpa infrastruktur
// Redis/BullMQ. Worker hanya sebagai executor; service adalah "otak"-nya.
// ────────────────────────────────────────────────────────────────────────────────
var GRAPH_API_VERSION = 'v21.0';
// ── Ranking stage untuk deteksi "naik stage" ──
exports.STAGE_RANK = {
    COLD: 0,
    WARM: 1,
    HOT: 2,
    VERY_HOT: 3,
};
// ── Normalisasi nomor HP ke format E.164 (62xxx) lalu hash SHA-256 ──
// Di-export untuk keperluan unit test.
function hashPhone(waNumber) {
    // waNumber sudah dalam format "6281234567890" dari sanitizeWaNumber()
    // tapi untuk safety: buang non-digit, pastikan prefix 62
    var digits = waNumber.replace(/\D/g, '');
    var normalized = digits.startsWith('62') ? digits : "62".concat(digits);
    return crypto_1.default.createHash('sha256').update(normalized).digest('hex');
}
// ── Hash nama (fn/ln) — lowercase + trim sesuai standar Meta ──
function hashName(name) {
    return crypto_1.default.createHash('sha256').update(name.toLowerCase().trim()).digest('hex');
}
// ── Bangun event_id ──
// Lead/ViewContent/AddToCart: deterministik per (leadId, eventName) — aman dikirim ulang,
//   Meta akan dedupe otomatis kalau event_id sama.
// Purchase: unik per instance closing via closingTimestamp — supaya REPEAT_ORDER
//   tidak di-dedupe dengan Purchase pertama.
function buildEventId(eventName, leadId, closingTimestamp) {
    if (closingTimestamp) {
        return "".concat(leadId, "-").concat(eventName, "-").concat(closingTimestamp);
    }
    return "".concat(leadId, "-").concat(eventName);
}
// ── Normalisasi URL untuk pencocokan multi-pixel yang kebal spoofing/variasi format ──
//
// Audit Fase 46 (2026-08-21): fallback path sebelumnya tidak strip ?query dan #hash —
// URL yang gagal parsing lewat new URL() (misal ada karakter aneh dari redirect chain)
// menghasilkan string berbeda dari path normal, sehingga tidak pernah match ke pixel.
function normalizeUrl(rawUrl) {
    try {
        var url = rawUrl.trim();
        var hasProto = url.startsWith('http://') || url.startsWith('https://');
        var parsed = new URL(hasProto ? url : "https://".concat(url));
        // new URL() otomatis strip query string dan hash karena hanya pathname yang diambil
        return (parsed.hostname + parsed.pathname).toLowerCase().replace(/\/+$/, '');
    }
    catch (_a) {
        // Fallback untuk URL malformed: strip protocol, query string, hash, dan trailing slash
        // WAJIB konsisten dengan path normal di atas agar hasilnya bisa dibandingkan
        return rawUrl.trim()
            .toLowerCase()
            .replace(/^https?:\/\//, '')
            .replace(/[?#].*$/, '') // strip ?query dan #hash
            .replace(/\/+$/, '');
    }
}
/**
 * Kirim satu event ke Meta Conversions API Graph API.
 * Dipanggil oleh capi.worker.ts — throw error supaya BullMQ bisa retry.
 */
function sendCapiEvent(jobData) {
    return __awaiter(this, void 0, void 0, function () {
        var eventName, waNumber, name, ctwaClid, pixelId, encryptedAccessToken, testEventCode, wabaId, currency, value, closingTimestamp, leadId, fbp, fbc, clientUserAgent, clientIp, eventSourceUrl, accessToken, userData, parts, isCtwa, actionSource, customData, eventPayload, url, body, res, responseText;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    eventName = jobData.eventName, waNumber = jobData.waNumber, name = jobData.name, ctwaClid = jobData.ctwaClid, pixelId = jobData.pixelId, encryptedAccessToken = jobData.encryptedAccessToken, testEventCode = jobData.testEventCode, wabaId = jobData.wabaId, currency = jobData.currency, value = jobData.value, closingTimestamp = jobData.closingTimestamp, leadId = jobData.leadId, fbp = jobData.fbp, fbc = jobData.fbc, clientUserAgent = jobData.clientUserAgent, clientIp = jobData.clientIp, eventSourceUrl = jobData.eventSourceUrl;
                    accessToken = (0, crypto_service_1.decrypt)(encryptedAccessToken);
                    userData = {
                        ph: hashPhone(waNumber),
                    };
                    if (fbp)
                        userData.fbp = fbp;
                    if (fbc)
                        userData.fbc = fbc;
                    if (clientUserAgent)
                        userData.client_user_agent = clientUserAgent;
                    if (clientIp)
                        userData.client_ip_address = clientIp;
                    // fn/ln opsional — pecah nama kalau ada spasi
                    if (name && name.trim()) {
                        parts = name.trim().split(/\s+/);
                        userData.fn = hashName(parts[0]);
                        if (parts.length > 1) {
                            userData.ln = hashName(parts.slice(1).join(' '));
                        }
                    }
                    isCtwa = Boolean(ctwaClid && ctwaClid.trim());
                    actionSource = isCtwa ? 'business_messaging' : 'chat';
                    customData = {};
                    if (eventName === 'Purchase') {
                        customData.currency = currency || 'IDR';
                        if (value != null && value > 0) {
                            customData.value = value;
                        }
                        else {
                            customData.value = 0;
                            logger_1.logger.warn("[CAPI] Purchase event leadId=".concat(leadId, " dikirim dengan value=0 ") +
                                "(confirmedCodAmount null/0 \u2014 tidak optimal untuk optimasi ROAS)");
                        }
                    }
                    eventPayload = {
                        event_name: eventName,
                        event_time: Math.floor(Date.now() / 1000),
                        event_id: buildEventId(eventName, leadId, closingTimestamp),
                        action_source: actionSource,
                        user_data: userData,
                    };
                    if (eventSourceUrl) {
                        eventPayload.event_source_url = eventSourceUrl;
                    }
                    if (isCtwa) {
                        // business_messaging butuh messaging_channel + ctwa_clid; wabaId opsional
                        eventPayload.messaging_channel = 'whatsapp';
                        if (ctwaClid)
                            eventPayload.ctwa_clid = ctwaClid;
                        if (wabaId && wabaId.trim()) {
                            eventPayload.whatsapp_business_account_id = wabaId;
                        }
                    }
                    if (Object.keys(customData).length > 0) {
                        eventPayload.custom_data = customData;
                    }
                    url = "https://graph.facebook.com/".concat(GRAPH_API_VERSION, "/").concat(encodeURIComponent(pixelId), "/events");
                    body = {
                        data: [eventPayload],
                        access_token: accessToken,
                    };
                    if (testEventCode && testEventCode.trim()) {
                        body.test_event_code = testEventCode.trim();
                    }
                    return [4 /*yield*/, fetch(url, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify(body),
                        })];
                case 1:
                    res = _a.sent();
                    return [4 /*yield*/, res.text()];
                case 2:
                    responseText = _a.sent();
                    if (!res.ok) {
                        // Throw supaya BullMQ bisa retry dengan backoff eksponensial
                        throw new Error("[CAPI] Graph API HTTP ".concat(res.status, " untuk event ").concat(eventName, " leadId=").concat(leadId, ": ").concat(responseText));
                    }
                    logger_1.logger.info("[CAPI] Event ".concat(eventName, " terkirim \u2014 leadId=").concat(leadId, " pixel=").concat(pixelId, " ") +
                        "action_source=".concat(actionSource).concat(testEventCode ? ' [TEST]' : ''));
                    return [2 /*return*/];
            }
        });
    });
}
exports.DEFAULT_EVENT_MAP = {
    NEW_LEAD: 'ViewContent',
    WARM: 'Lead',
    HOT: 'AddToCart',
    CLOSING: 'Purchase'
};
/**
 * Tentukan event CAPI yang perlu dikirim, lalu enqueue ke BullMQ.
 * Dipanggil oleh leads.repository.ts::upsertLeadProfile() SETELAH transaksi commit.
 *
 * TIDAK PERNAH throw — semua kegagalan hanya di-log supaya tidak pernah
 * memblokir atau membuat gagal pipeline leads.
 */
function enqueueCapiIfNeeded(params) {
    return __awaiter(this, void 0, void 0, function () {
        var businessId, leadId, waNumber, name_1, ctwaClid, finalLeadCategory, finalStage, prevStage, atomicConversion, prevConversion, capiEventsSent, confirmedCodAmount, isNewLead, business, leadRecord, targetPixelId, targetEncryptedAccessToken, cleanIncomingUrl, PIXEL_CACHE_KEY, PIXEL_CACHE_TTL, customPixels, redisCache, cached, redisErr_1, bestMatchedPixel, longestMatchLength, _i, customPixels_1, pixel, urls, _a, urls_1, rawConfigUrl, cleanConfigUrl, err_1, baseJobData, eventMap, evNewLead, evWarm, evHot, evClosing, eventsToSend, newOneTimeEvents, finalRank, isNewClosing, closingTimestamp, _b, eventsToSend_1, eventName, isClosingEvent, updatedSent, err_2;
        var _c;
        return __generator(this, function (_d) {
            switch (_d.label) {
                case 0:
                    _d.trys.push([0, 21, , 22]);
                    businessId = params.businessId, leadId = params.leadId, waNumber = params.waNumber, name_1 = params.name, ctwaClid = params.ctwaClid, finalLeadCategory = params.finalLeadCategory, finalStage = params.finalStage, prevStage = params.prevStage, atomicConversion = params.atomicConversion, prevConversion = params.prevConversion, capiEventsSent = params.capiEventsSent, confirmedCodAmount = params.confirmedCodAmount, isNewLead = params.isNewLead;
                    // ── GERBANG 2: Cek kategori lead — hanya PROSPEK_IKLAN yang dikirim ──
                    if (finalLeadCategory !== 'PROSPEK_IKLAN')
                        return [2 /*return*/];
                    return [4 /*yield*/, prisma_1.prisma.business.findUnique({
                            where: { id: businessId },
                            select: {
                                metaCapiEnabled: true,
                                metaCapiPixelId: true,
                                metaCapiAccessToken: true,
                                metaCapiTestEventCode: true,
                                metaCapiWabaId: true,
                                metaCapiCurrency: true,
                                metaCapiEventMap: true,
                            },
                        })];
                case 1:
                    business = _d.sent();
                    if (!(business === null || business === void 0 ? void 0 : business.metaCapiEnabled) ||
                        !business.metaCapiAccessToken ||
                        !business.metaCapiPixelId) {
                        return [2 /*return*/];
                    }
                    return [4 /*yield*/, prisma_1.prisma.lead.findUnique({
                            where: { id: leadId },
                            select: { fbp: true, fbc: true, clientUserAgent: true, clientIp: true, eventSourceUrl: true }
                        })];
                case 2:
                    leadRecord = _d.sent();
                    targetPixelId = business.metaCapiPixelId;
                    targetEncryptedAccessToken = business.metaCapiAccessToken;
                    if (!(leadRecord === null || leadRecord === void 0 ? void 0 : leadRecord.eventSourceUrl)) return [3 /*break*/, 14];
                    _d.label = 3;
                case 3:
                    _d.trys.push([3, 13, , 14]);
                    cleanIncomingUrl = normalizeUrl(leadRecord.eventSourceUrl);
                    PIXEL_CACHE_KEY = "salespintar:capi:pixels:".concat(businessId);
                    PIXEL_CACHE_TTL = 60;
                    customPixels = null;
                    _d.label = 4;
                case 4:
                    _d.trys.push([4, 10, , 12]);
                    return [4 /*yield*/, Promise.resolve().then(function () { return require('../config/redis'); })];
                case 5:
                    redisCache = (_d.sent()).redisCache;
                    return [4 /*yield*/, redisCache.get(PIXEL_CACHE_KEY)];
                case 6:
                    cached = _d.sent();
                    if (!cached) return [3 /*break*/, 7];
                    customPixels = JSON.parse(cached);
                    return [3 /*break*/, 9];
                case 7: return [4 /*yield*/, prisma_1.prisma.metaPixelConfig.findMany({
                        where: { businessId: businessId, isActive: true },
                        select: { id: true, pixelId: true, accessToken: true, landingPageUrls: true },
                    })];
                case 8:
                    // Fix #6: hapus (prisma as any) — MetaPixelConfig sudah confirmed ada di schema
                    customPixels = _d.sent();
                    // Best-effort cache set — kalau gagal, tidak apa-apa (next request hit DB lagi)
                    redisCache.set(PIXEL_CACHE_KEY, JSON.stringify(customPixels), 'EX', PIXEL_CACHE_TTL).catch(function (e) { return logger_1.logger.warn("[CAPI] Gagal set pixel cache: ".concat(e)); });
                    _d.label = 9;
                case 9: return [3 /*break*/, 12];
                case 10:
                    redisErr_1 = _d.sent();
                    // Redis down atau parse error — fallback ke DB query langsung
                    logger_1.logger.warn("[CAPI] Redis pixel cache error, fallback ke DB: ".concat(redisErr_1));
                    return [4 /*yield*/, prisma_1.prisma.metaPixelConfig.findMany({
                            where: { businessId: businessId, isActive: true },
                            select: { id: true, pixelId: true, accessToken: true, landingPageUrls: true },
                        })];
                case 11:
                    customPixels = _d.sent();
                    return [3 /*break*/, 12];
                case 12:
                    // customPixels bisa null hanya kalau SEMUA path (Redis + DB fallback) gagal — tidak mungkin
                    // dalam praktik, tapi TypeScript perlu guard eksplisit karena tipe nullable
                    if (!customPixels) {
                        logger_1.logger.warn('[CAPI] Tidak bisa ambil pixel config dari Redis maupun DB, skip routing');
                    }
                    else {
                        bestMatchedPixel = null;
                        longestMatchLength = -1;
                        for (_i = 0, customPixels_1 = customPixels; _i < customPixels_1.length; _i++) {
                            pixel = customPixels_1[_i];
                            urls = Array.isArray(pixel.landingPageUrls) ? pixel.landingPageUrls : [];
                            for (_a = 0, urls_1 = urls; _a < urls_1.length; _a++) {
                                rawConfigUrl = urls_1[_a];
                                cleanConfigUrl = normalizeUrl(rawConfigUrl);
                                // Audit Fase 46: hapus cleanIncomingUrl.includes(cleanConfigUrl) karena menyebabkan
                                // false-positive lintas domain (misal config 'toko.com' bisa match lead dari 'tokobagus.com')
                                // dan false-positive lintas path (config '/sepatu' match URL '/sepatu-anak').
                                // Hanya 2 kondisi yang aman:
                                //   1. Exact match: URL persis sama
                                //   2. Prefix path: incoming adalah sub-path dari config (diawali configUrl + '/')
                                if (cleanConfigUrl && (cleanIncomingUrl === cleanConfigUrl ||
                                    cleanIncomingUrl.startsWith(cleanConfigUrl + '/'))) {
                                    if (cleanConfigUrl.length > longestMatchLength) {
                                        longestMatchLength = cleanConfigUrl.length;
                                        bestMatchedPixel = pixel;
                                    }
                                }
                            }
                        }
                        if (bestMatchedPixel && bestMatchedPixel.pixelId && bestMatchedPixel.accessToken) {
                            targetPixelId = bestMatchedPixel.pixelId;
                            targetEncryptedAccessToken = bestMatchedPixel.accessToken;
                            // Rekam jejak pixel ID ke Lead — Fix #6: hapus (prisma as any)
                            prisma_1.prisma.lead.update({
                                where: { id: leadId },
                                data: { metaCapiPixelId: targetPixelId },
                            }).catch(function (e) { return logger_1.logger.warn("[CAPI] Gagal update lead.metaCapiPixelId: ".concat(e)); });
                        }
                    }
                    return [3 /*break*/, 14];
                case 13:
                    err_1 = _d.sent();
                    logger_1.logger.warn("[CAPI] Gagal multi-pixel lookup, fallback ke default: ".concat(err_1));
                    return [3 /*break*/, 14];
                case 14:
                    baseJobData = {
                        businessId: businessId,
                        leadId: leadId,
                        waNumber: waNumber,
                        name: name_1,
                        ctwaClid: ctwaClid,
                        pixelId: targetPixelId,
                        encryptedAccessToken: targetEncryptedAccessToken,
                        testEventCode: business.metaCapiTestEventCode,
                        wabaId: business.metaCapiWabaId,
                        currency: business.metaCapiCurrency || 'IDR',
                        fbp: leadRecord === null || leadRecord === void 0 ? void 0 : leadRecord.fbp,
                        fbc: leadRecord === null || leadRecord === void 0 ? void 0 : leadRecord.fbc,
                        clientUserAgent: leadRecord === null || leadRecord === void 0 ? void 0 : leadRecord.clientUserAgent,
                        clientIp: leadRecord === null || leadRecord === void 0 ? void 0 : leadRecord.clientIp,
                        eventSourceUrl: leadRecord === null || leadRecord === void 0 ? void 0 : leadRecord.eventSourceUrl,
                    };
                    eventMap = (business.metaCapiEventMap && typeof business.metaCapiEventMap === 'object')
                        ? business.metaCapiEventMap
                        : exports.DEFAULT_EVENT_MAP;
                    evNewLead = eventMap.NEW_LEAD || exports.DEFAULT_EVENT_MAP.NEW_LEAD;
                    evWarm = eventMap.WARM || exports.DEFAULT_EVENT_MAP.WARM;
                    evHot = eventMap.HOT || exports.DEFAULT_EVENT_MAP.HOT;
                    evClosing = eventMap.CLOSING || exports.DEFAULT_EVENT_MAP.CLOSING;
                    eventsToSend = [];
                    newOneTimeEvents = [];
                    // ── Fase 45 (2026-08-21): State-based approach — capiEventsSent adalah satu-satunya
                    // sumber kebenaran untuk deduplication, bukan isNewLead.
                    //
                    // Masalah sebelumnya (transition-based):
                    //   ViewContent hanya dikirim kalau isNewLead=true. Jika saat pesan pertama masuk
                    //   leadCategory belum PROSPEK_IKLAN (masih NEW_INBOUND), gerbang GERBANG 2 di atas
                    //   sudah return sebelum ViewContent dikirim. Begitu kategori di-upgrade ke PROSPEK_IKLAN
                    //   pada pesan berikutnya, isNewLead sudah false → ViewContent tidak pernah dikirim selamanya.
                    //   Sama berlaku untuk stage events (Lead/AddToCart): gate stageNaik || isNewLead
                    //   melewatkan catch-up untuk lead yang stage-nya sudah layak tapi event belum terkirim.
                    //
                    // Solusi: kirim event APAPUN yang:
                    //   1. Secara state sudah layak (stage cukup, kategori sudah benar — sudah lolos gerbang atas)
                    //   2. Belum pernah dikirim (tidak ada di capiEventsSent)
                    // Meta CAPI auto-dedupe via event_id deterministik jadi aman kalau ada race.
                    // Purchase tetap transition-based supaya REPEAT_ORDER bisa dikirim berulang. ──
                    // ViewContent: kirim kalau belum pernah, apapun kondisi isNewLead
                    if (!capiEventsSent.includes(evNewLead)) {
                        eventsToSend.push(evNewLead);
                        newOneTimeEvents.push(evNewLead);
                    }
                    finalRank = (_c = exports.STAGE_RANK[finalStage]) !== null && _c !== void 0 ? _c : 0;
                    // WARM ke atas, belum pernah dikirim
                    if (finalRank >= exports.STAGE_RANK['WARM'] &&
                        !capiEventsSent.includes(evWarm) &&
                        !newOneTimeEvents.includes(evWarm)) {
                        eventsToSend.push(evWarm);
                        newOneTimeEvents.push(evWarm);
                    }
                    // HOT ke atas, belum pernah dikirim
                    if (finalRank >= exports.STAGE_RANK['HOT'] &&
                        !capiEventsSent.includes(evHot) &&
                        !newOneTimeEvents.includes(evHot)) {
                        eventsToSend.push(evHot);
                        newOneTimeEvents.push(evHot);
                    }
                    isNewClosing = atomicConversion !== 'LOST' && // guard: jangan pernah kirim Purchase kalau sedang di-set ke LOST
                        (atomicConversion === 'CLOSING' || atomicConversion === 'REPEAT_ORDER') &&
                        atomicConversion !== prevConversion;
                    closingTimestamp = void 0;
                    if (isNewClosing) {
                        closingTimestamp = new Date().toISOString();
                        eventsToSend.push(evClosing);
                        newOneTimeEvents.push(evClosing);
                    }
                    if (eventsToSend.length === 0)
                        return [2 /*return*/];
                    _b = 0, eventsToSend_1 = eventsToSend;
                    _d.label = 15;
                case 15:
                    if (!(_b < eventsToSend_1.length)) return [3 /*break*/, 18];
                    eventName = eventsToSend_1[_b];
                    isClosingEvent = eventName === evClosing;
                    return [4 /*yield*/, capi_queue_1.capiQueue.add("".concat(eventName, "-").concat(leadId), __assign(__assign({}, baseJobData), { eventName: eventName, value: isClosingEvent ? (confirmedCodAmount !== null && confirmedCodAmount !== void 0 ? confirmedCodAmount : null) : undefined, closingTimestamp: isClosingEvent ? closingTimestamp : undefined }))];
                case 16:
                    _d.sent();
                    logger_1.logger.debug("[CAPI] Enqueued event ".concat(eventName, " untuk leadId=").concat(leadId));
                    _d.label = 17;
                case 17:
                    _b++;
                    return [3 /*break*/, 15];
                case 18:
                    if (!(newOneTimeEvents.length > 0)) return [3 /*break*/, 20];
                    updatedSent = Array.from(new Set(__spreadArray(__spreadArray([], capiEventsSent, true), newOneTimeEvents, true)));
                    return [4 /*yield*/, prisma_1.prisma.lead.update({
                            where: { id: leadId },
                            data: { capiEventsSent: updatedSent },
                        })];
                case 19:
                    _d.sent();
                    _d.label = 20;
                case 20: return [3 /*break*/, 22];
                case 21:
                    err_2 = _d.sent();
                    // SENGAJA tidak re-throw — kegagalan CAPI tidak boleh merusak pipeline leads
                    logger_1.logger.error("[CAPI] enqueueCapiIfNeeded gagal untuk leadId=".concat(params.leadId, ": ").concat(err_2));
                    return [3 /*break*/, 22];
                case 22: return [2 /*return*/];
            }
        });
    });
}
/**
 * Rekonsiliasi event CAPI yang terlewat untuk semua PROSPEK_IKLAN di satu bisnis.
 *
 * Dipanggil via POST /business/meta-capi/reconcile.
 * Menggunakan path yang SAMA dengan alur normal (enqueueCapiIfNeeded yang sudah difix),
 * sehingga sekaligus menjadi bukti bahwa perbaikan state-based benar.
 *
 * Idempoten: capiEventsSent di DB dan event_id deterministik di Meta mencegah duplikat.
 * TIDAK pernah throw — error per-lead hanya di-log.
 */
function reconcileCapiEvents(businessId) {
    return __awaiter(this, void 0, void 0, function () {
        var leads, processed, skipped, errors, _i, leads_1, lead, eventsSent, finalRank, needsViewContent, needsWarm, needsHot, err_3;
        var _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    logger_1.logger.info("[CAPI/reconcile] Mulai rekonsiliasi untuk businessId=".concat(businessId));
                    return [4 /*yield*/, prisma_1.prisma.lead.findMany({
                            where: {
                                businessId: businessId,
                                leadCategory: 'PROSPEK_IKLAN',
                            },
                            select: {
                                id: true,
                                waNumber: true,
                                name: true,
                                leadStage: true,
                                conversionStatus: true,
                                capiEventsSent: true,
                            },
                        })];
                case 1:
                    leads = _b.sent();
                    processed = 0;
                    skipped = 0;
                    errors = 0;
                    _i = 0, leads_1 = leads;
                    _b.label = 2;
                case 2:
                    if (!(_i < leads_1.length)) return [3 /*break*/, 7];
                    lead = leads_1[_i];
                    _b.label = 3;
                case 3:
                    _b.trys.push([3, 5, , 6]);
                    eventsSent = Array.isArray(lead.capiEventsSent) ? lead.capiEventsSent : [];
                    finalRank = (_a = exports.STAGE_RANK[lead.leadStage]) !== null && _a !== void 0 ? _a : 0;
                    needsViewContent = !eventsSent.includes('ViewContent');
                    needsWarm = finalRank >= exports.STAGE_RANK['WARM'] && !eventsSent.includes('Lead');
                    needsHot = finalRank >= exports.STAGE_RANK['HOT'] && !eventsSent.includes('AddToCart');
                    if (!needsViewContent && !needsWarm && !needsHot) {
                        skipped++;
                        return [3 /*break*/, 6];
                    }
                    logger_1.logger.info("[CAPI/reconcile] leadId=".concat(lead.id, " stage=").concat(lead.leadStage, " ") +
                        "missing=[".concat([needsViewContent && 'ViewContent', needsWarm && 'Lead', needsHot && 'AddToCart'].filter(Boolean).join(','), "]"));
                    // Panggil enqueueCapiIfNeeded dengan state saat ini — logika state-based akan
                    // mendeteksi event yang kurang dan mengirimkannya lewat queue yang sama
                    return [4 /*yield*/, enqueueCapiIfNeeded({
                            businessId: businessId,
                            leadId: lead.id,
                            waNumber: lead.waNumber,
                            name: lead.name || null,
                            ctwaClid: null,
                            finalLeadCategory: 'PROSPEK_IKLAN',
                            finalStage: lead.leadStage,
                            prevStage: lead.leadStage, // same — biar tidak trigger Purchase via transisi
                            atomicConversion: lead.conversionStatus,
                            prevConversion: lead.conversionStatus, // same — biar Purchase tidak double-trigger
                            capiEventsSent: eventsSent,
                            confirmedCodAmount: null,
                            isNewLead: false,
                        })];
                case 4:
                    // Panggil enqueueCapiIfNeeded dengan state saat ini — logika state-based akan
                    // mendeteksi event yang kurang dan mengirimkannya lewat queue yang sama
                    _b.sent();
                    processed++;
                    return [3 /*break*/, 6];
                case 5:
                    err_3 = _b.sent();
                    logger_1.logger.error("[CAPI/reconcile] Error untuk leadId=".concat(lead.id, ": ").concat(err_3));
                    errors++;
                    return [3 /*break*/, 6];
                case 6:
                    _i++;
                    return [3 /*break*/, 2];
                case 7:
                    logger_1.logger.info("[CAPI/reconcile] Selesai businessId=".concat(businessId, ": ") +
                        "processed=".concat(processed, " skipped=").concat(skipped, " errors=").concat(errors));
                    return [2 /*return*/, { processed: processed, skipped: skipped, errors: errors }];
            }
        });
    });
}
/**
 * Rekonsiliasi retroaktif event Purchase untuk lead CLOSING yang terlewat.
 *
 * Kasus penggunaan: lead yang sudah CLOSING sebelum CAPI dipasang tidak pernah
 * mendapat Purchase karena tidak ada transisi baru yang memicu isNewClosing=true.
 * Reconcile biasa (reconcileCapiEvents) sengaja tidak mengirim Purchase.
 *
 * Fungsi ini spesifik mengirim Purchase ke:
 * - Lead dengan leadCategory = 'PROSPEK_IKLAN'
 * - conversionStatus = 'CLOSING'
 * - 'Purchase' belum ada di capiEventsSent
 *
 * Idempoten: Meta CAPI auto-dedupe via event_id = '${leadId}-Purchase'.
 * Aman dipanggil berulang.
 */
function reconcilePurchaseEvents(businessId) {
    return __awaiter(this, void 0, void 0, function () {
        var leads, processed, skipped, errors, _i, leads_2, lead, eventsSent, err_4;
        var _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    logger_1.logger.info("[CAPI/reconcile-purchase] Mulai untuk businessId=".concat(businessId));
                    return [4 /*yield*/, prisma_1.prisma.lead.findMany({
                            where: {
                                businessId: businessId,
                                leadCategory: 'PROSPEK_IKLAN',
                                conversionStatus: 'CLOSING',
                                NOT: { capiEventsSent: { has: 'Purchase' } },
                            },
                            select: {
                                id: true,
                                waNumber: true,
                                name: true,
                                leadStage: true,
                                conversionStatus: true,
                                capiEventsSent: true,
                                confirmedCodAmount: true,
                                ctwaClid: true,
                            },
                        })];
                case 1:
                    leads = _b.sent();
                    logger_1.logger.info("[CAPI/reconcile-purchase] Ditemukan ".concat(leads.length, " CLOSING leads tanpa Purchase"));
                    processed = 0;
                    skipped = 0;
                    errors = 0;
                    _i = 0, leads_2 = leads;
                    _b.label = 2;
                case 2:
                    if (!(_i < leads_2.length)) return [3 /*break*/, 7];
                    lead = leads_2[_i];
                    _b.label = 3;
                case 3:
                    _b.trys.push([3, 5, , 6]);
                    eventsSent = Array.isArray(lead.capiEventsSent) ? lead.capiEventsSent : [];
                    // Double-check: skip kalau somehow sudah ada Purchase (race condition guard)
                    if (eventsSent.includes('Purchase')) {
                        skipped++;
                        return [3 /*break*/, 6];
                    }
                    logger_1.logger.info("[CAPI/reconcile-purchase] leadId=".concat(lead.id, " waNumber=").concat(lead.waNumber, " ") +
                        "confirmedCodAmount=".concat(lead.confirmedCodAmount));
                    // Kirim via enqueueCapiIfNeeded — prevConversion='PENDING' memastikan
                    // isNewClosing=true sehingga Purchase dienqueue. Stage events di-skip
                    // karena capiEventsSent sudah punya VC/Lead/ATC (sudah dikirim reconcile sebelumnya).
                    return [4 /*yield*/, enqueueCapiIfNeeded({
                            businessId: businessId,
                            leadId: lead.id,
                            waNumber: lead.waNumber,
                            name: lead.name || null,
                            ctwaClid: lead.ctwaClid || null,
                            finalLeadCategory: 'PROSPEK_IKLAN',
                            finalStage: lead.leadStage,
                            prevStage: lead.leadStage, // sama — stage events tidak double-trigger
                            atomicConversion: 'CLOSING', // trigger isNewClosing=true
                            prevConversion: 'PENDING', // beda dari CLOSING agar transisi terdeteksi
                            capiEventsSent: eventsSent,
                            confirmedCodAmount: (_a = lead.confirmedCodAmount) !== null && _a !== void 0 ? _a : null,
                            isNewLead: false,
                        })];
                case 4:
                    // Kirim via enqueueCapiIfNeeded — prevConversion='PENDING' memastikan
                    // isNewClosing=true sehingga Purchase dienqueue. Stage events di-skip
                    // karena capiEventsSent sudah punya VC/Lead/ATC (sudah dikirim reconcile sebelumnya).
                    _b.sent();
                    processed++;
                    return [3 /*break*/, 6];
                case 5:
                    err_4 = _b.sent();
                    logger_1.logger.error("[CAPI/reconcile-purchase] Error untuk leadId=".concat(lead.id, ": ").concat(err_4));
                    errors++;
                    return [3 /*break*/, 6];
                case 6:
                    _i++;
                    return [3 /*break*/, 2];
                case 7:
                    logger_1.logger.info("[CAPI/reconcile-purchase] Selesai businessId=".concat(businessId, ": ") +
                        "processed=".concat(processed, " skipped=").concat(skipped, " errors=").concat(errors));
                    return [2 /*return*/, { processed: processed, skipped: skipped, errors: errors }];
            }
        });
    });
}
