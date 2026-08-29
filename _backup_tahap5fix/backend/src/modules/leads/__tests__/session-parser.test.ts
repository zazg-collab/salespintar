/**
 * Regresi Audit Tahap 2 — Langkah A (2026-08-18), temuan Ronde Penyanggal.
 *
 * Edit A pada lead-profiler.service.ts (Temuan 3.1) menghapus syarat `!isAfterSalesStr`
 * total dari gatekeeper closing, sehingga sekarang isDeterministicClosing() sendirian jadi
 * satu-satunya garis pertahanan yang mencegah chat after-sales/garansi murni (tanpa order
 * baru) salah terbaca sbg closing. Ronde Penyanggal menemukan exclusion `isAfterSalesChat`
 * di dalam isDeterministicClosing() cuma mengenali kata seputar resi/pengiriman — TIDAK
 * mengenali klaim garansi/defect eksplisit ("komplain", "klaim garansi", "mau retur",
 * "tukar baru"). Celahnya: chat retur/garansi murni yang CS balas dengan frasa umum
 * "akan langsung kami proses" bisa salah lolos jadi closing baru.
 *
 * CATATAN DESAIN: fix-nya SENGAJA tidak memakai kata lepas seperti "rusak"/"cacat"/"pecah"
 * (beda dengan isAfterSalesWarrantyStr di lead-profiler.service.ts yang dipakai utk
 * klasifikasi domain, bukan exclusion closing) — kata lepas itu juga muncul di obrolan
 * nostalgia yang tidak actionable dan kalau dipakai di sini malah mematahkan closing asli
 * (lihat test kedua di bawah, dan skenario "campur" di lead-profiler.service.test.ts).
 */
import { describe, it, expect } from 'vitest';
import { SessionBoundaryParser } from '../session-parser';

describe('SessionBoundaryParser.isDeterministicClosing — exclusion after-sales/garansi (Ronde Penyanggal Langkah A)', () => {
  it('TIDAK menandai closing untuk klaim garansi/defect murni walau CS balas frasa umum "akan langsung kami proses"', () => {
    const transcript = [
      '[BUYER] kak punya saya yang kemarin dateng kondisinya rusak, gagangnya retak, saya mau klaim garansi',
      '[CS] Baik kak mohon maaf atas ketidaknyamanannya, akan langsung kami proses ya kak keluhannya',
    ].join('\n');
    const buyerOnlyText =
      'kak punya saya yang kemarin dateng kondisinya rusak, gagangnya retak, saya mau klaim garansi';

    expect(SessionBoundaryParser.isDeterministicClosing(transcript, buyerOnlyText)).toBe(false);
  });

  it('tetap menandai closing untuk order baru yang genuine (regresi: jangan sampai fix ini mematikan closing asli)', () => {
    const transcript = [
      '[CS] Baik kak, ini RINCIAN BIAYA nya: Golok Situmang 2 - Rp245.000. Total COD: Rp245.000. Apakah sudah sesuai kak?',
      '[BUYER] iya kak sudah sesuai, bungkus kak',
    ].join('\n');
    const buyerOnlyText = 'iya kak sudah sesuai, bungkus kak';

    expect(SessionBoundaryParser.isDeterministicClosing(transcript, buyerOnlyText)).toBe(true);
  });
});
