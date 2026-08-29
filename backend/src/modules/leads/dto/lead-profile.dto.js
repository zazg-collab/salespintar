"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isValidSpecificProductName = isValidSpecificProductName;
/**
 * Saringan Integritas Nama Produk (Anti-Corrupted Carry-Over).
 * Memastikan string di DB bukan nilai hampa/placeholder/potongan chat obrolan sebelum di-carry-forward.
 */
function isValidSpecificProductName(name) {
    if (!name)
        return false;
    var trimmed = name.trim();
    var lower = trimmed.toLowerCase();
    if ([
        '',
        'null',
        'undefined',
        'none',
        'n/a',
        '-',
        'umum',
        'tidak ada',
        'tidak ada informasi produk',
        'tidak diketahui',
        'belum spesifik',
        'umum (internal cs)',
    ].includes(lower)) {
        return false;
    }
    if (lower.includes('belum spesifik') ||
        lower.includes('lanjut di proses') ||
        lower.includes('total ') ||
        lower.includes('?')) {
        return false;
    }
    if (/^(?:saya|sy|kak|kakak|mas|pak|bapak|ibu|gan|min|admin)\b/i.test(lower)) {
        return false;
    }
    return trimmed.length >= 3;
}
