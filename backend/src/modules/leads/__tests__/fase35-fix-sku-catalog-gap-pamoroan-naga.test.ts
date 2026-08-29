/**
 * Fase 35 (2026-08-19) — fix gap katalog SKU utk "Golok Pamoroan Naga" polos (tanpa "merah"),
 * ditemukan sbg temuan sampingan investigasi Fase 34, diminta Bossfren "cari tau dl masalahnya apa"
 * lalu dikonfirmasi "oke fix".
 *
 * Root cause: `KNOWN_SKUS` sebelumnya cuma punya pattern utk "pamoroan naga merah", "pamoroan
 * sonokeling duralium", dan "pamoroan ukir" -- tidak ada utk "naga" polos. Teks "Golok Pamoroan
 * Naga" (nama produk RESMI dari admin/iklan, dikonfirmasi langsung dari `CLOSING 16 & 17.xlsx`
 * milik Bossfren -- 2 baris literal "Golok Pamoroan Naga - Fb - NPM") jatuh ke catch-all generik
 * `/pamoroan/i` dan SALAH dilabeli "Golok Pamoroan Sonokeling Duralium".
 *
 * Fix: pattern baru `/pamoroan\s+naga\b/i` -> "Golok Pamoroan Naga", diletakkan SETELAH "pamoroan
 * naga merah" (supaya varian "merah" tetap menang tie-break array-order) tapi SEBELUM catch-all
 * generik `/pamoroan/i` (supaya "naga" polos menang tie-break ketimbang catch-all).
 */
import { describe, it, expect } from 'vitest';
import { LeadProfilerService } from '../lead-profiler.service';

describe('Fase 35 — matchKnownSku gap katalog "Golok Pamoroan Naga"', () => {
  it('teks "Golok Pamoroan Naga" polos (tanpa merah) harus dilabeli "Golok Pamoroan Naga", BUKAN jatuh ke catch-all "Sonokeling Duralium"', () => {
    expect(LeadProfilerService.matchKnownSku('Golok Pamoroan Naga')).toBe('Golok Pamoroan Naga');
    expect(LeadProfilerService.matchKnownSku('mau pesan golok pamoroan naga ya kak')).toBe('Golok Pamoroan Naga');
  });

  it('REGRESI WAJIB: varian "pamoroan naga merah" tetap dilabeli benar (tidak kebajak pattern baru)', () => {
    expect(LeadProfilerService.matchKnownSku('Golok Pamoroan Naga Merah')).toBe('Golok Pamoroan Naga Merah');
  });

  it('REGRESI WAJIB: varian "pamoroan sonokeling duralium" / "sanukeling" tetap dilabeli benar', () => {
    expect(LeadProfilerService.matchKnownSku('Golok Pamoroan Sonokeling Duralium')).toBe('Golok Pamoroan Sonokeling Duralium');
    expect(LeadProfilerService.matchKnownSku('pamoroan sanukeling brp kak')).toBe('Golok Pamoroan Sonokeling Duralium');
  });

  it('REGRESI WAJIB: varian "pamoroan ukir" tetap dilabeli benar', () => {
    expect(LeadProfilerService.matchKnownSku('Golok Pamoroan Ukir')).toBe('Golok Pamoroan Ukir');
  });

  it('REGRESI WAJIB: "pamoroan" tanpa kata pengikut apa pun tetap fallback ke catch-all lama (tidak ada perubahan perilaku di luar kasus "naga")', () => {
    expect(LeadProfilerService.matchKnownSku('ada golok pamoroan gak kak')).toBe('Golok Pamoroan Sonokeling Duralium');
  });
});
