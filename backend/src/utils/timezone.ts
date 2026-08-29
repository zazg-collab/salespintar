/**
 * Utilitas Sentral Konversi Zona Waktu Indonesia (WIB / Asia/Jakarta / UTC+7).
 * Menjamin seluruh perhitungan tanggal, Redis daily key, parsing chat WhatsApp,
 * query database, dan rentang laporan 100% konsisten di zona waktu WIB
 * terlepas dari zona waktu host/container server.
 */

export const JAKARTA_TZ = 'Asia/Jakarta';

/**
 * Format Date atau timestamp ke string 'YYYY-MM-DD' dalam zona waktu Asia/Jakarta (WIB).
 */
export function toJakartaDateStr(date: Date | number = new Date()): string {
  const d = typeof date === 'number' ? new Date(date) : date;
  if (!(d instanceof Date) || isNaN(d.getTime())) return toJakartaDateStr(new Date());
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: JAKARTA_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return formatter.format(d);
}

/**
 * Format Date atau timestamp ke string 'YYYY-MM-DD HH:mm:ss' dalam zona waktu Asia/Jakarta (WIB).
 */
export function toJakartaDateTimeStr(date: Date | number = new Date()): string {
  const d = typeof date === 'number' ? new Date(date) : date;
  if (!(d instanceof Date) || isNaN(d.getTime())) return toJakartaDateTimeStr(new Date());
  
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: JAKARTA_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });

  // en-CA format menghasilkan: "YYYY-MM-DD, HH:mm:ss" atau "YYYY-MM-DD HH:mm:ss"
  const formatted = formatter.format(d);
  return formatted.replace(',', '').trim();
}

/**
 * Dapatkan string 'YYYY-MM-DD' untuk hari kemarin (H-1) dalam zona waktu Asia/Jakarta (WIB).
 */
export function getYesterdayJakartaDateStr(baseDate: Date = new Date()): string {
  const todayStr = toJakartaDateStr(baseDate);
  const [year, month, day] = todayStr.split('-').map(Number);
  // Geser 1 hari ke belakang dalam UTC noon agar aman dari edge cases DST/leap
  const d = new Date(Date.UTC(year!, month! - 1, day! - 1, 12, 0, 0));
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
export function parseWibDateTime(input?: string | number | Date | null): Date {
  if (!input) return new Date();
  if (input instanceof Date) {
    return isNaN(input.getTime()) ? new Date() : input;
  }

  // Jika input berupa number (epoch ms atau seconds)
  if (typeof input === 'number') {
    if (isNaN(input) || input <= 0) return new Date();
    const ms = input < 100000000000 ? input * 1000 : input;
    return new Date(ms);
  }

  const str = String(input).trim();
  if (!str) return new Date();

  // 1. Cek apakah sudah berformat ISO dengan offset timezone (Z atau +07:00, dll)
  if (/T\d{2}:\d{2}/i.test(str) && (str.endsWith('Z') || /[+-]\d{2}:?\d{2}$/.test(str))) {
    const d = new Date(str);
    if (!isNaN(d.getTime())) return d;
  }

  // 2. Format: "YYYY-MM-DD HH:mm:ss" atau "YYYY-MM-DD HH:mm"
  const isoMatch = str.match(/^(\d{4})-(\d{2})-(\d{2})[T\s](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (isoMatch) {
    const [, year, month, day, hour, min, sec] = isoMatch;
    return new Date(`${year}-${month}-${day}T${hour}:${min}:${sec || '00'}.000+07:00`);
  }

  // 3. Format WhatsApp Indonesia: "DD/MM/YYYY, HH.mm.ss" atau "DD/MM/YYYY HH:mm:ss"
  const indoMatch = str.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})[,\s]+(\d{1,2})[\.:](\d{2})(?:[\.:](\d{2}))?/);
  if (indoMatch) {
    const [, day, month, year, hour, min, sec] = indoMatch;
    const padDay = day!.padStart(2, '0');
    const padMonth = month!.padStart(2, '0');
    const padHour = hour!.padStart(2, '0');
    return new Date(`${year}-${padMonth}-${padDay}T${padHour}:${min}:${sec || '00'}.000+07:00`);
  }

  // 4. Format Tanggal saja: "YYYY-MM-DD"
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) {
    return new Date(`${str}T00:00:00.000+07:00`);
  }

  // Fallback standar
  const fallback = new Date(str);
  return isNaN(fallback.getTime()) ? new Date() : fallback;
}

/**
 * Konversi timestamp pesan Baileys (bisa berupa detik / ms / Long) ke Date objek.
 */
export function parseBaileysTimestamp(ts?: number | string | null): Date {
  return parseWibDateTime(ts);
}

/**
 * Hitung rentang { gte, lte } dalam UTC Date objek untuk filter query SQL / Prisma
 * berdasarkan tanggal string 'YYYY-MM-DD' di zona waktu Asia/Jakarta (WIB).
 */
export function getWibDateRange(startDate?: string, endDate?: string): { gte?: Date; lte?: Date } | null {
  if (!startDate && !endDate) return null;
  const filter: { gte?: Date; lte?: Date } = {};
  
  if (startDate) {
    const cleanStart = startDate.trim().split('T')[0];
    filter.gte = new Date(`${cleanStart}T00:00:00.000+07:00`);
  }
  if (endDate) {
    const cleanEnd = endDate.trim().split('T')[0];
    filter.lte = new Date(`${cleanEnd}T23:59:59.999+07:00`);
  }
  return filter;
}

/**
 * Dapatkan rentang tanggal 'YYYY-MM-DD' untuk N hari terakhir di zona waktu WIB.
 */
export function getRecentJakartaDateList(days: number): string[] {
  const dates: string[] = [];
  const now = new Date();
  const todayStr = toJakartaDateStr(now);
  const [year, month, day] = todayStr.split('-').map(Number);

  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(year!, month! - 1, day! - i, 12, 0, 0));
    dates.push(toJakartaDateStr(d));
  }
  return dates;
}
