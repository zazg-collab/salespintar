/**
 * Langkah C Fase 25 (Kelompok 1, 2026-08-18) — regresi utk 4 bug akurasi rule-engine yang
 * dikonfirmasi TERBUKTI oleh 2 finder + 2 skeptic independen (Ronde Temuan & Ronde Penyanggal):
 *
 * - T1-SKU: `cleanProductName()` tidak pernah membuang brand toko "Cordova" (comment tanpa
 *   implementasi).
 * - T2-SKU: `cleanProductName()` tidak `.trim()` hasil akhirnya.
 * - T3b-SKU: `matchKnownSku()` salah mengklasifikasikan teks pendek "GKE 40" sebagai
 *   "Golok Kebun Ekonomis 30" (bug urutan alias di array KNOWN_SKUS — entri GKE 40 tidak
 *   punya alias "gke 40" seperti sibling-nya GKE 30).
 * - T4-SKU: regex Pola Form CS 3 (`m3` di `extractRoleAwareProduct`) overmatch karena tidak
 *   punya stop-anchor, menangkap seluruh kalimat lanjutan sbg "nama produk".
 */
import { describe, it, expect, vi } from 'vitest';

// lead-profiler.service.ts meng-import config/redis.ts & config/prisma.ts di level modul
// (side-effecting: validasi env, buka koneksi) — mock supaya import file test ini tidak butuh
// env/DB/Redis riil, sama seperti pola di compute-closing-signals.test.ts.
vi.mock('../../../config/redis', () => ({ redisCache: { get: vi.fn(), set: vi.fn() } }));
vi.mock('../../../config/prisma', () => ({
  prisma: {
    csHumanLearningSession: { findFirst: vi.fn() },
    lead: { findFirst: vi.fn(), deleteMany: vi.fn() },
    business: { findUnique: vi.fn() },
  },
}));
vi.mock('../../../services/llm', () => ({ complete: vi.fn() }));
vi.mock('../../../services/mengantar.service', () => ({ MengantarService: { getReceiverScore: vi.fn() } }));
vi.mock('../../../utils/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { LeadProfilerService } from '../lead-profiler.service';
import { SessionBoundaryParser } from '../session-parser';

describe('LeadProfilerService.cleanProductName (Langkah C, Temuan T1-SKU & T2-SKU)', () => {
  it('membuang brand toko "Cordova" dari nama produk (T1-SKU)', () => {
    expect(LeadProfilerService.cleanProductName('Cordova Golok Situmang 2')).toBe('Golok Situmang 2');
    expect(LeadProfilerService.cleanProductName('Golok Situmang 2 Cordova Store')).toBe('Golok Situmang 2');
  });

  it('merapikan whitespace sisa dgn .trim() (T2-SKU)', () => {
    expect(LeadProfilerService.cleanProductName('  Golok Situmang 2   ')).toBe('Golok Situmang 2');
  });

  it('tidak merusak nama produk yang sudah bersih dari awal', () => {
    expect(LeadProfilerService.cleanProductName('Golok Situmang 2')).toBe('Golok Situmang 2');
    expect(LeadProfilerService.cleanProductName('Golok Kukri')).toBe('Golok Kukri');
  });
});

describe('LeadProfilerService.matchKnownSku — keluarga GKE (Langkah C, Temuan T3b-SKU)', () => {
  it('mengenali "GKE 40" polos sebagai varian 40, BUKAN salah jatuh ke varian 30', () => {
    expect(LeadProfilerService.matchKnownSku('Mau pesan GKE 40 ya')).toBe('Golok Kebun Ekonomis 40 Sonokeling');
    expect(LeadProfilerService.matchKnownSku('GKE 40')).toBe('Golok Kebun Ekonomis 40 Sonokeling');
  });

  it('tetap mengenali "GKE 30" polos sebagai varian 30 (perilaku lama dipertahankan)', () => {
    expect(LeadProfilerService.matchKnownSku('Mau pesan GKE 30 ya')).toBe('Golok Kebun Ekonomis 30');
  });

  it('varian spesifik (Perak Duralium, dll) tetap menang atas alias generik baru', () => {
    expect(LeadProfilerService.matchKnownSku('gke 40 perak duralium')).toBe('GKE 40 Perak Duralium');
    expect(LeadProfilerService.matchKnownSku('gke 40 perak duralium 2')).toBe('GKE 40 Perak Duralium 2');
  });

  it('frasa panjang "golok kebun ekonomis 40" tetap match seperti sebelumnya', () => {
    expect(LeadProfilerService.matchKnownSku('mau golok kebun ekonomis 40 ya')).toBe('Golok Kebun Ekonomis 40 Sonokeling');
  });
});

describe('LeadProfilerService.extractRoleAwareProduct — Pola Form CS 3 (Langkah C, Temuan T4-SKU)', () => {
  it('menangkap HANYA nama produk, tidak ikut menangkap kalimat penutup CS (template asli "...di toko kami")', () => {
    const transcript = [
      '[CS] Terima kasih sudah mengisi form pemesanan Golok Situmang 3 - Fb - NPM di toko kami !',
      '[BUYER] siap kak',
    ].join('\n');

    const { activeSession } = SessionBoundaryParser.segmentSessions(transcript);
    const { csProduct } = LeadProfilerService.extractRoleAwareProduct(activeSession);

    expect(csProduct).toBe('Golok Situmang 3');
  });

  it('fallback ke stop-di-koma kalau template tidak diakhiri "di toko kami"', () => {
    const transcript = [
      '[CS] Terima kasih sudah mengisi form pemesanan Golok Black Mamba, admin kami akan segera menghubungi anda',
      '[BUYER] oke kak',
    ].join('\n');

    const { activeSession } = SessionBoundaryParser.segmentSessions(transcript);
    const { csProduct } = LeadProfilerService.extractRoleAwareProduct(activeSession);

    expect(csProduct).toBe('Golok Black Mamba');
  });
});
