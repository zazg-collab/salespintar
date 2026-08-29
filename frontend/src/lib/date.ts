/**
 * Central Date & Timezone Formatter untuk Seluruh Frontend SalesPintar.
 * Menjamin seluruh tampilan tanggal, jam chat, dan filter konsisten di zona waktu WIB (Asia/Jakarta).
 */

export const JAKARTA_TZ = 'Asia/Jakarta';

/**
 * Format string tanggal pendek (misal: "15 Agu 2026").
 */
export function formatWibDate(isoStr?: string | number | Date | null): string {
  if (!isoStr) return '-';
  const d = typeof isoStr === 'string' || typeof isoStr === 'number' ? new Date(isoStr) : isoStr;
  if (isNaN(d.getTime())) return '-';

  return d.toLocaleDateString('id-ID', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: JAKARTA_TZ,
  });
}

/**
 * Format string tanggal + jam lengkap (misal: "15 Agu 2026, 21:41 WIB").
 */
export function formatWibDateTime(isoStr?: string | number | Date | null): string {
  if (!isoStr) return '-';
  const d = typeof isoStr === 'string' || typeof isoStr === 'number' ? new Date(isoStr) : isoStr;
  if (isNaN(d.getTime())) return '-';

  const datePart = d.toLocaleDateString('id-ID', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: JAKARTA_TZ,
  });
  const timePart = d.toLocaleTimeString('id-ID', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: JAKARTA_TZ,
  }).replace('.', ':');

  return `${datePart}, ${timePart} WIB`;
}

/**
 * Format jam saja (misal: "21:41 WIB").
 */
export function formatWibTime(isoStr?: string | number | Date | null): string {
  if (!isoStr) return '-';
  const d = typeof isoStr === 'string' || typeof isoStr === 'number' ? new Date(isoStr) : isoStr;
  if (isNaN(d.getTime())) return '-';

  const timePart = d.toLocaleTimeString('id-ID', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: JAKARTA_TZ,
  }).replace('.', ':');

  return `${timePart} WIB`;
}

/**
 * Format tanggal ke 'YYYY-MM-DD' dalam zona waktu Asia/Jakarta (WIB).
 * Menghindari bug UTC split('T')[0] saat lewat tengah malam (00:00 - 07:00 WIB).
 */
export function getJakartaDateStr(date: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: JAKARTA_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

/**
 * Dapatkan string 'YYYY-MM-DD' hari ini dalam zona waktu Asia/Jakarta.
 */
export function getJakartaTodayStr(): string {
  return getJakartaDateStr(new Date());
}

/**
 * Dapatkan string 'YYYY-MM-DD' dengan pergeseran hari (misal -6 untuk 7 hari terakhir).
 */
export function getJakartaOffsetStr(daysOffset: number): string {
  const d = new Date();
  d.setDate(d.getDate() + daysOffset);
  return getJakartaDateStr(d);
}

/**
 * Dapatkan string 'YYYY-MM-01' hari pertama bulan ini dalam zona waktu Asia/Jakarta.
 */
export function getJakartaFirstDayOfMonthStr(): string {
  const todayStr = getJakartaTodayStr();
  const [year, month] = todayStr.split('-');
  return `${year}-${month}-01`;
}

