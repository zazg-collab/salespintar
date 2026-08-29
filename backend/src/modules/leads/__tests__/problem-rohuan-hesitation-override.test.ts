/**
 * Fase 30-lanjutan (2026-08-18) — fix utk 1 miss sisa blind-test 80 chat admin:
 * "GSM - Rohuan Shopee". Root cause: buyer sempat bilang "kami batal ya beli sampean" (menyalakan
 * `hasHesitationSignal` krn recency-aware 3-pesan-terakhir), TAPI CS lalu membalas "Baik pak,
 * jadinya di shopee ya" -> buyer "iya" -> CS kirim template penutup genuine ("...akan langsung
 * kami proses untuk paketan nyaa") -- toko SENDIRI menganggap order ini closing (dipindah-proses
 * via kanal lain yang tetap dihitung closing oleh admin), bukan pembatalan murni. Transkrip di
 * bawah adalah replikasi PERSIS baris-baris kunci dari
 * `/mnt/user-data/uploads/CHAT/CLOSING/ITA/Chat WhatsApp dengan GSM - Rohuan Shopee/...txt`.
 *
 * Fix: `isDeterministicClosing()` sekarang membedakan 2 jenis sinyal negatif:
 * - Hard-block (`hasHardBlockClosingSignal`: garansi/komplain/pindah-kanal eksplisit di teks
 *   buyer) -- TETAP memblokir closing TANPA SYARAT, tidak berubah dari perilaku lama.
 * - Hesitation (`hasHesitationSignal`: kata ragu/batal di 3 pesan buyer terakhir) -- SEKARANG
 *   overridable, TAPI HANYA kalau transkrip belakangan benar-benar mencapai template penutup
 *   genuine (`reachedTerminalWrapupTemplate`, method privat baru, dipakai ulang jg oleh
 *   `hasUnansweredLogisticsStall`). Kalau penutup TIDAK PERNAH ketemu, hesitation tetap memblokir
 *   spt biasa -- lihat regresi wajib di bawah.
 *
 * Diverifikasi AMAN thd seluruh dataset blind-test 80 chat admin SEBELUM fix ini ditulis: 0/40
 * chat TIDAK CLOSING punya kata keraguan + template penutup co-occur; dari 40 chat CLOSING cuma
 * 2 yang punya kata keraguan sama sekali (Rohuan = target; "GKe - cucup supriyadi" = kata
 * "cancel"-nya cuma di teks CS, tidak pernah masuk buyerOnlyText, jadi tidak kena exclusion ini
 * baik sebelum maupun sesudah fix -- direplikasi di describe block terakhir di bawah).
 */
import { describe, it, expect } from 'vitest';
import { SessionBoundaryParser } from '../session-parser';

describe('SessionBoundaryParser.isDeterministicClosing — Fase 30-lanjutan: hesitation overridable via template penutup genuine', () => {
  it('replikasi PERSIS "GSM - Rohuan Shopee": buyer sempat bilang batal, TAPI CS lanjut proses via kanal lain + kirim template penutup -> closing SEKARANG terdeteksi (fix)', () => {
    const transcript = [
      '[CS] *RINCIAN BIAYA* 1. Harga : 149.000 2. Ongkir : 45.000 *TOTAL COD : 194.000*',
      '[BUYER] Baik kak, cod ya',
      '[CS] Baik pak, sesuai rincian diatas cod /bayar ditempat 194.000 yaa',
      '[BUYER] sdh aman,kami batal ya beli sampean🙏',
      '[CS] Baik pak, jadinya di shopee ya 🙏☺️',
      '[BUYER] iya',
      '[CS] Baik bapak , terimakasih untuk orderan nya :) semoga berkah dan bermanfaat, akan langsung kami proses untuk paketan nyaa 😊',
    ].join('\n');
    const buyerOnlyText = ['Baik kak, cod ya', 'sdh aman,kami batal ya beli sampean🙏', 'iya'].join('\n');

    // Sanity: hesitation memang nyala (kata "batal" ada di recency window 3 pesan terakhir buyer).
    expect(SessionBoundaryParser.hasHesitationSignal(buyerOnlyText)).toBe(true);
    // Sanity: bukan hard-block (tidak ada kata garansi/komplain/retur, dan "shopee" di sini cuma
    // muncul di teks CS, bukan di buyerOnlyText).
    expect(SessionBoundaryParser.hasHardBlockClosingSignal(buyerOnlyText)).toBe(false);

    expect(SessionBoundaryParser.isDeterministicClosing(transcript, buyerOnlyText)).toBe(true);
  });

  it('regresi WAJIB: hesitation TANPA template penutup belakangan (pembatalan GENUINE, deal beneran mati) -> closing TETAP diblokir', () => {
    const transcript = [
      '[CS] *RINCIAN BIAYA* 1. Harga : 149.000 2. Ongkir : 45.000 *TOTAL COD : 194.000*',
      '[BUYER] Baik kak, cod ya',
      '[CS] Baik pak, sesuai rincian diatas cod /bayar ditempat 194.000 yaa',
      '[BUYER] maaf kak batal ya, uangnya belum ada',
      '[CS] Baik pak, kalau begitu ditunggu kabar selanjutnya ya pak 🙏',
    ].join('\n');
    const buyerOnlyText = ['Baik kak, cod ya', 'maaf kak batal ya, uangnya belum ada'].join('\n');

    expect(SessionBoundaryParser.hasHesitationSignal(buyerOnlyText)).toBe(true);
    // Transkrip TIDAK PERNAH mencapai template penutup genuine manapun -> override TIDAK berlaku.
    expect(SessionBoundaryParser.isDeterministicClosing(transcript, buyerOnlyText)).toBe(false);
  });

  it('regresi WAJIB: sinyal hard-block (klaim garansi eksplisit) TETAP memblokir closing TANPA SYARAT walau template penutup muncul belakangan', () => {
    const transcript = [
      '[CS] *RINCIAN BIAYA* 1. Harga : 149.000 2. Ongkir : 45.000 *TOTAL COD : 194.000*',
      '[BUYER] Baik kak, cod ya',
      '[CS] Baik pak, sesuai rincian diatas cod /bayar ditempat 194.000 yaa',
      '[BUYER] eh kak barang kemarin saya mau klaim garansi ya, yang ini beda lagi',
      '[CS] Baik bapak , terimakasih untuk orderan nya :) semoga berkah dan bermanfaat, akan langsung kami proses untuk paketan nyaa 😊',
    ].join('\n');
    const buyerOnlyText = ['Baik kak, cod ya', 'eh kak barang kemarin saya mau klaim garansi ya, yang ini beda lagi'].join(
      '\n',
    );

    expect(SessionBoundaryParser.hasHardBlockClosingSignal(buyerOnlyText)).toBe(true);
    expect(SessionBoundaryParser.isDeterministicClosing(transcript, buyerOnlyText)).toBe(false);
  });

  it('regresi WAJIB: sinyal hard-block (pindah-kanal eksplisit dari buyer) TETAP memblokir closing TANPA SYARAT walau template penutup muncul belakangan', () => {
    const transcript = [
      '[CS] *RINCIAN BIAYA* 1. Harga : 149.000 2. Ongkir : 45.000 *TOTAL COD : 194.000*',
      '[BUYER] Baik kak, cod ya',
      '[CS] Baik pak, sesuai rincian diatas cod /bayar ditempat 194.000 yaa',
      '[BUYER] Tiktok Shopee boleh nggak kak?',
      '[CS] Baik bapak , terimakasih untuk orderan nya :) semoga berkah dan bermanfaat, akan langsung kami proses untuk paketan nyaa 😊',
    ].join('\n');
    const buyerOnlyText = ['Baik kak, cod ya', 'Tiktok Shopee boleh nggak kak?'].join('\n');

    expect(SessionBoundaryParser.hasHardBlockClosingSignal(buyerOnlyText)).toBe(true);
    expect(SessionBoundaryParser.isDeterministicClosing(transcript, buyerOnlyText)).toBe(false);
  });

  it('regresi WAJIB (replikasi "GKe - cucup supriyadi"): kata "cancel" cuma muncul di TEKS CS (bukan buyerOnlyText) -> hasHesitationSignal tidak pernah nyala, closing tetap terdeteksi spt sebelum fix', () => {
    const transcript = [
      '[CS] kalau kurirnya cancel/retur otomatis kami proses ulang kok pak, tenang aja',
      '[BUYER] oh oke siap kak',
      '[CS] *RINCIAN BIAYA* 1. Harga : 149.000 2. Ongkir : 45.000 *TOTAL COD : 194.000*',
      '[BUYER] Baik kak, cod ya',
      '[CS] Baik pak, sesuai rincian diatas cod /bayar ditempat 194.000 yaa',
      '[CS] CATATAN 1. Pastikan hp Selalu Aktif selama masa pengiriman 2. dst',
    ].join('\n');
    const buyerOnlyText = ['oh oke siap kak', 'Baik kak, cod ya'].join('\n');

    expect(SessionBoundaryParser.hasHesitationSignal(buyerOnlyText)).toBe(false);
    expect(SessionBoundaryParser.isDeterministicClosing(transcript, buyerOnlyText)).toBe(true);
  });

  it('sanity: hasNegativeClosingSignal (gabungan lama) tetap identik dgn hasHesitationSignal || hasHardBlockClosingSignal utk kedua kasus', () => {
    const hesitationOnly = 'maaf kak batal ya, uangnya belum ada';
    expect(SessionBoundaryParser.hasNegativeClosingSignal(hesitationOnly)).toBe(
      SessionBoundaryParser.hasHesitationSignal(hesitationOnly) ||
        SessionBoundaryParser.hasHardBlockClosingSignal(hesitationOnly),
    );

    const hardBlockOnly = 'saya mau klaim garansi ya';
    expect(SessionBoundaryParser.hasNegativeClosingSignal(hardBlockOnly)).toBe(
      SessionBoundaryParser.hasHesitationSignal(hardBlockOnly) ||
        SessionBoundaryParser.hasHardBlockClosingSignal(hardBlockOnly),
    );
  });
});
