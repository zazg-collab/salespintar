"use strict";
/**
 * Utilitas Sentral Konversi Zona Waktu Indonesia (WIB / Asia/Jakarta / UTC+7).
 * Menjamin seluruh perhitungan tanggal, Redis daily key, parsing chat WhatsApp,
 * query database, dan rentang laporan 100% konsisten di zona waktu WIB
 * terlepas dari zona waktu host/container server.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.JAKARTA_TZ = void 0;
exports.toJakartaDateStr = toJakartaDateStr;
exports.toJakartaDateTimeStr = toJakartaDateTimeStr;
exports.getYesterdayJakartaDateStr = getYesterdayJakartaDateStr;
exports.parseWibDateTime = parseWibDateTime;
exports.parseBaileysTimestamp = parseBaileysTimestamp;
exports.getWibDateRange = getWibDateRange;
exports.getRecentJakartaDateList = getRecentJakartaDateList;
exports.JAKARTA_TZ = 'Asia/Jakarta';
/**
 * Format Date atau timestamp ke string 'YYYY-MM-DD' dalam zona waktu Asia/Jakarta (WIB).
 */
function toJakartaDateStr(date) {
    if (date === void 0) { date = new Date(); }
    var d = typeof date === 'number' ? new Date(date) : date;
    if (!(d instanceof Date) || isNaN(d.getTime()))
        return toJakartaDateStr(new Date());
    var formatter = new Intl.DateTimeFormat('en-CA', {
        timeZone: exports.JAKARTA_TZ,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    });
    return formatter.format(d);
}
/**
 * Format Date atau timestamp ke string 'YYYY-MM-DD HH:mm:ss' dalam zona waktu Asia/Jakarta (WIB).
 */
function toJakartaDateTimeStr(date) {
    if (date === void 0) { date = new Date(); }
    var d = typeof date === 'number' ? new Date(date) : date;
    if (!(d instanceof Date) || isNaN(d.getTime()))
        return toJakartaDateTimeStr(new Date());
    var formatter = new Intl.DateTimeFormat('en-CA', {
        timeZone: exports.JAKARTA_TZ,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
    });
    // en-CA format menghasilkan: "YYYY-MM-DD, HH:mm:ss" atau "YYYY-MM-DD HH:mm:ss"
    var formatted = formatter.format(d);
    return formatted.replace(',', '').trim();
}
/**
 * Dapatkan string 'YYYY-MM-DD' untuk hari kemarin (H-1) dalam zona waktu Asia/Jakarta (WIB).
 */
function getYesterdayJakartaDateStr(baseDate) {
    if (baseDate === void 0) { baseDate = new Date(); }
    var todayStr = toJakartaDateStr(baseDate);
    var _a = todayStr.split('-').map(Number), year = _a[0], month = _a[1], day = _a[2];
    // Geser 1 hari ke belakang dalam UTC noon agar aman dari edge cases DST/leap
    var d = new Date(Date.UTC(year, month - 1, day - 1, 12, 0, 0));
    return toJakartaDateStr(d);
}
/**
 * Parse string atau timestamp tanggal apapun menjadi Date object resmi
 * dengan mengasumsikan input tanpa timezone sebagai waktu lokal WIB (Asia/Jakarta / UTC+7).
 *
 * Mendukung format:
 * - "2026-08-15 21:41:00" -> 2026-08-15T21:41:00+07:00 (14:41:00 UTC)
 * - "15/08/2026 21:41:00" -> 2026-08-15T21:41:00+07:00
 * - "15/08/2026, 21.41.00" -> 2026-08-15T21:41:00+07:00
 * - "2026-08-15T14:41:00.000Z" (ISO) -> parsed as-is
 * - Epoch number (detik atau milidetik)
 */
function parseWibDateTime(input) {
    if (!input)
        return new Date();
    if (input instanceof Date) {
        return isNaN(input.getTime()) ? new Date() : input;
    }
    // Jika input berupa number (epoch ms atau seconds)
    if (typeof input === 'number') {
        if (isNaN(input) || input <= 0)
            return new Date();
        var ms = input < 100000000000 ? input * 1000 : input;
        return new Date(ms);
    }
    var str = String(input).trim();
    if (!str)
        return new Date();
    // 1. Cek apakah sudah berformat ISO dengan offset timezone (Z atau +07:00, dll)
    if (/T\d{2}:\d{2}/i.test(str) && (str.endsWith('Z') || /[+-]\d{2}:?\d{2}$/.test(str))) {
        var d = new Date(str);
        if (!isNaN(d.getTime()))
            return d;
    }
    // 2. Format: "YYYY-MM-DD HH:mm:ss" atau "YYYY-MM-DD HH:mm"
    var isoMatch = str.match(/^(\d{4})-(\d{2})-(\d{2})[T\s](\d{2}):(\d{2})(?::(\d{2}))?/);
    if (isoMatch) {
        var year = isoMatch[1], month = isoMatch[2], day = isoMatch[3], hour = isoMatch[4], min = isoMatch[5], sec = isoMatch[6];
        return new Date("".concat(year, "-").concat(month, "-").concat(day, "T").concat(hour, ":").concat(min, ":").concat(sec || '00', ".000+07:00"));
    }
    // 3. Format WhatsApp Indonesia: "DD/MM/YYYY, HH.mm.ss" atau "DD/MM/YYYY HH:mm:ss"
    var indoMatch = str.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})[,\s]+(\d{1,2})[\.:](\d{2})(?:[\.:](\d{2}))?/);
    if (indoMatch) {
        var day = indoMatch[1], month = indoMatch[2], year = indoMatch[3], hour = indoMatch[4], min = indoMatch[5], sec = indoMatch[6];
        var padDay = day.padStart(2, '0');
        var padMonth = month.padStart(2, '0');
        var padHour = hour.padStart(2, '0');
        return new Date("".concat(year, "-").concat(padMonth, "-").concat(padDay, "T").concat(padHour, ":").concat(min, ":").concat(sec || '00', ".000+07:00"));
    }
    // 4. Format Tanggal saja: "YYYY-MM-DD"
    if (/^\d{4}-\d{2}-\d{2}$/.test(str)) {
        return new Date("".concat(str, "T00:00:00.000+07:00"));
    }
    // Fallback standar
    var fallback = new Date(str);
    return isNaN(fallback.getTime()) ? new Date() : fallback;
}
/**
 * Konversi timestamp pesan Baileys (bisa berupa detik / ms / Long) ke Date objek.
 */
function parseBaileysTimestamp(ts) {
    return parseWibDateTime(ts);
}
/**
 * Hitung rentang { gte, lte } dalam UTC Date objek untuk filter query SQL / Prisma
 * berdasarkan tanggal string 'YYYY-MM-DD' di zona waktu Asia/Jakarta (WIB).
 */
function getWibDateRange(startDate, endDate) {
    if (!startDate && !endDate)
        return null;
    var filter = {};
    if (startDate) {
        var cleanStart = startDate.trim().split('T')[0];
        filter.gte = new Date("".concat(cleanStart, "T00:00:00.000+07:00"));
    }
    if (endDate) {
        var cleanEnd = endDate.trim().split('T')[0];
        filter.lte = new Date("".concat(cleanEnd, "T23:59:59.999+07:00"));
    }
    return filter;
}
/**
 * Dapatkan rentang tanggal 'YYYY-MM-DD' untuk N hari terakhir di zona waktu WIB.
 */
function getRecentJakartaDateList(days) {
    var dates = [];
    var now = new Date();
    var todayStr = toJakartaDateStr(now);
    var _a = todayStr.split('-').map(Number), year = _a[0], month = _a[1], day = _a[2];
    for (var i = days - 1; i >= 0; i--) {
        var d = new Date(Date.UTC(year, month - 1, day - i, 12, 0, 0));
        dates.push(toJakartaDateStr(d));
    }
    return dates;
}
