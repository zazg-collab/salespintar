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

/**
 * Tahap 5 (2026-08-18) — Uji Validasi Output pada Data Riil, dataset forensik 17 Agustus.
 * 2 celah nyata ditemukan lewat investigasi manual 11 closing-miss (bukan Ronde
 * Penyanggal/Temuan formal, permintaan langsung Bossfren stlh melihat laporan Tahap 5).
 *
 * Temuan A (wa 6282372455445): exclusion `hasHesitation` sebelumnya nyisir SELURUH pesan
 * buyer dalam satu sesi — kalau buyer sempat ragu ("cancel dulu") di AWAL sesi lalu BERUBAH
 * PIKIRAN dan closing beneran belakangan di sesi yang SAMA, closing itu PERMANEN gagal
 * terkunci deterministik krn kata "cancel" tetap ketemu di scan. Fix: `hasHesitation` sekarang
 * cuma menyisir 3 pesan buyer TERAKHIR (recency-aware) — `isAfterSalesChat` SENGAJA TIDAK
 * diubah scope-nya (bukan bagian dari temuan ini, ubah tanpa bukti = resiko regresi percuma).
 *
 * Temuan B (wa 6283856233276): variasi frasa konfirmasi CS "sesuai rincian diatas ... yaa"
 * (bukan "sudah sesuai") tidak tercakup regex closing walau buyer sudah eksplisit pilih COD.
 */
describe('SessionBoundaryParser.isDeterministicClosing — Tahap 5 (recency-aware hesitation + variasi frasa konfirmasi CS)', () => {
  it('Temuan A: closing TETAP terkunci walau buyer sempat bilang "cancel dulu" di AWAL sesi, asal sudah dilewati & closing genuine terjadi belakangan', () => {
    // Diringkas dari transkrip riil wa 6282372455445 (dataset forensik 17 Agustus).
    const transcript = [
      '[BUYER] warna hitam ya boss',
      '[BUYER] ma,af boss di cancel dlu,mau ganti varian yg laen',
      '[CS] Jangan di cancel pak, bisa ko langsung whatsapp ini kalo mau ganti varian',
      '[BUYER] pamoroan sanukeling brp',
      '[CS] *RINCIAN BIAYA* 1. Harga : 199.000 2. Ongkir : 24.000 *TOTAL COD : 223.000*',
      '[BUYER] ongkir ke lampung brp',
      '[BUYER] COD sja',
      '[CS] Baik pak untuk total codnya jadi *223.000* sudah termasuk ongkos kirim yaa',
      '[CS] CATATAN 1. Pastikan hp Selalu Aktif selama masa pengiriman 2. Jika ada kurir menghubungi, tolong Dibalas',
      '[BUYER] Aamiin,siap',
    ].join('\n');
    const buyerOnlyText = [
      'warna hitam ya boss',
      'ma,af boss di cancel dlu,mau ganti varian yg laen',
      'pamoroan sanukeling brp',
      'ongkir ke lampung brp',
      'COD sja',
      'Aamiin,siap',
    ].join('\n');

    expect(SessionBoundaryParser.isDeterministicClosing(transcript, buyerOnlyText)).toBe(true);
  });

  it('Temuan A (regresi WAJIB): closing TETAP TIDAK terkunci kalau pembatalan/keraguan ADA di pesan buyer TERBARU (bukan cuma masa lalu yg sudah dilewati)', () => {
    const transcript = [
      '[CS] *RINCIAN BIAYA* 1. Harga : 199.000 2. Ongkir : 24.000 *TOTAL COD : 223.000*',
      '[CS] Baik pak untuk total codnya jadi *223.000* sudah termasuk ongkos kirim yaa',
      '[CS] CATATAN 1. Pastikan hp Selalu Aktif selama masa pengiriman',
      '[BUYER] eh maaf kak gak jadi deh, batal aja',
    ].join('\n');
    const buyerOnlyText = 'eh maaf kak gak jadi deh, batal aja';

    expect(SessionBoundaryParser.isDeterministicClosing(transcript, buyerOnlyText)).toBe(false);
  });

  it('Temuan B: closing terkunci utk variasi frasa konfirmasi CS "sesuai rincian diatas ... yaa" (bukan hanya "sudah sesuai")', () => {
    // Diringkas dari transkrip riil wa 6283856233276 (dataset forensik 17 Agustus).
    const transcript = [
      '[CS] *RINCIAN BIAYA* 1. Harga : 199.000 2. Ongkir : 50.000 *TOTAL COD : 249.000*',
      '[CS] Baik bapak mau lanjut proses cod atau transfer saja yaa?',
      '[BUYER] cod ja kk',
      '[CS] Baik pak, sesuai rincian diatas cod /bayar ditempat 249.000 yaa',
    ].join('\n');
    const buyerOnlyText = 'cod ja kk';

    expect(SessionBoundaryParser.isDeterministicClosing(transcript, buyerOnlyText)).toBe(true);
  });
});

/**
 * Fase 37 (2026-08-19) — Audit lanjutan gap dashboard, temuan admin: wa 6285841546264 & pola serupa
 * nyangkut CLOSING (score 95, DEAL_CONFIRMED) padahal buyer TIDAK PERNAH membalas SATU PESAN PUN di
 * sesi aktif -- dikonfirmasi via export chat WhatsApp ASLI dari Bossfren (bukan tebakan/Redis
 * terpotong -- ini export lengkap dari baris pertama "Pesan dan telepon terenkripsi..." sampai akhir
 * sesi). Akar masalah: beberapa sinyal positif closing (RINCIAN BIAYA...sesuai rincian diatas...yaa,
 * CATATAN...Pastikan hp Selalu Aktif, PERATURAN CHECKOUT...COD=bayar cash) murni template CS yang
 * bisa terkirim proaktif tanpa syarat balasan buyer sama sekali. Fix: gerbang buyer-silence di awal
 * isDeterministicClosing() -- exclusionText kosong/blank = closing TIDAK PERNAH terkunci, apa pun
 * sinyal lain yang ketemu.
 */
describe('SessionBoundaryParser.isDeterministicClosing — Fase 37 (gerbang buyer-silence)', () => {
  it('TIDAK menandai closing kalau buyer TIDAK PERNAH membalas sama sekali, walau CS sudah kirim rincian biaya + kalimat penutup "sesuai rincian diatas" (pola persis wa 6285841546264)', () => {
    // Diringkas dari export chat WhatsApp ASLI wa 6285841546264 (lengkap dari awal sesi).
    const transcript = [
      '[CS] Hai pak Irawanpenyandingan dusun 1 depan polindes kecamatan teluk gelam oki sumsel  👋  Terima kasih sudah mengisi form pemesanan Golok Kebun Ekonomis 30 - Fb - NFR - 2 di toko kami!',
      '[CS] *RINCIAN BIAYA*   1. Harga  : 149.000  2. Ongkir : ~52.000~ diskon jadi 42.000 *TOTAL COD : 191.000 Memastikan kembali untuk pembayaran nya mau langsung saya proses COD atau mau transfer?',
      '[CS] Baik pak, sesuai rincian diatas cod /bayar ditempat 191.000 yaa',
    ].join('\n');
    const buyerOnlyText = '';

    expect(SessionBoundaryParser.isDeterministicClosing(transcript, buyerOnlyText)).toBe(false);
  });

  it('TIDAK menandai closing kalau buyer diam total, walau CS sampai kirim template penutup penuh "CATATAN...Pastikan hp Selalu Aktif" dan "PERATURAN CHECKOUT...COD=bayar cash"', () => {
    const transcript = [
      '[CS] *RINCIAN BIAYA* 1. Harga : 199.000 2. Ongkir : 50.000 *TOTAL COD : 249.000*',
      '[CS] CATATAN 1. Pastikan hp Selalu Aktif selama masa pengiriman 2. Jika ada kurir menghubungi, tolong Dibalas',
      '[CS] Nama toko pengirim : CORDOVA STORE  PERATURAN CHECKOUT :  - HP wajib aktif  - COD = bayar cash langsung ke kurir.',
    ].join('\n');
    const buyerOnlyText = '';

    expect(SessionBoundaryParser.isDeterministicClosing(transcript, buyerOnlyText)).toBe(false);
  });

  it('buyerOnlyText undefined (fallback ke transcript penuh) TIDAK ikut kena gerbang baru ini kalau transcript-nya sendiri genuinely berisi teks (regresi: jangan sampai fix ini mematikan jalur lama)', () => {
    const transcript = [
      '[CS] *RINCIAN BIAYA* 1. Harga : 199.000 2. Ongkir : 24.000 *TOTAL COD : 223.000*',
      '[BUYER] iya kak sudah sesuai, bungkus kak',
    ].join('\n');

    expect(SessionBoundaryParser.isDeterministicClosing(transcript)).toBe(true);
  });

  it('regresi WAJIB: closing genuine dgn balasan buyer asli TETAP terkunci (fix ini tidak mematikan jalur lama)', () => {
    const transcript = [
      '[CS] *RINCIAN BIAYA* 1. Harga : 199.000 2. Ongkir : 50.000 *TOTAL COD : 249.000*',
      '[CS] Baik bapak mau lanjut proses cod atau transfer saja yaa?',
      '[BUYER] cod ja kk',
      '[CS] Baik pak, sesuai rincian diatas cod /bayar ditempat 249.000 yaa',
    ].join('\n');
    const buyerOnlyText = 'cod ja kk';

    expect(SessionBoundaryParser.isDeterministicClosing(transcript, buyerOnlyText)).toBe(true);
  });
});

/**
 * Fitur Hashtag Closing #clsg (2026-08-26) — Human Ground Truth Trigger dari CS.
 * Skenario 1: CS lupa hashtag -> deteksi existing tetap jalan.
 * Skenario 2: CS beri hashtag -> deterministik closing 100% terkunci.
 * Skenario 3: Chat minim / meragukan + hashtag -> tetap disapu bersih jadi closing.
 * Guard: Pembatalan eksplisit setelah hashtag tetap dihormati (hesitation/cancel guard).
 */
describe('SessionBoundaryParser.isDeterministicClosing — #clsg Closing Hashtag (Human Ground Truth)', () => {
  it('Skenario 2: closing terkunci pasti saat CS menyertakan #clsg di akhir pesan closing', () => {
    const transcript = [
      '[CS] Halo kak, mau pesan Pisau Jagal 031?',
      '[BUYER] Iya mau COD ke Cirebon ya',
      '[CS] Baik kak, langsung kami proses kirim hari ini yaa. Terima kasih! #clsg',
    ].join('\n');
    const buyerOnlyText = 'Iya mau COD ke Cirebon ya';

    expect(SessionBoundaryParser.isDeterministicClosing(transcript, buyerOnlyText)).toBe(true);
  });

  it('Skenario 2: case-insensitive (#CLSG, #Clsg, #clsg) semuanya tertangkap', () => {
    const transcriptUpper = [
      '[BUYER] Alamat jl mawar no 12 bandung',
      '[CS] Siap diproses kak #CLSG',
    ].join('\n');
    const transcriptMixed = [
      '[BUYER] Alamat jl mawar no 12 bandung',
      '[CS] Siap diproses kak #Clsg',
    ].join('\n');

    expect(SessionBoundaryParser.isDeterministicClosing(transcriptUpper, 'Alamat jl mawar no 12 bandung')).toBe(true);
    expect(SessionBoundaryParser.isDeterministicClosing(transcriptMixed, 'Alamat jl mawar no 12 bandung')).toBe(true);
  });

  it('Skenario 3: Chat minim/singkat (buyer cuma kirim alamat/shareloc) + #clsg disapu bersih jadi CLOSING', () => {
    const transcript = [
      '[BUYER] Desa Sukamaju RT 02 RW 01',
      '[CS] Oke kak kami siapkan barangnya #clsg',
    ].join('\n');
    const buyerOnlyText = 'Desa Sukamaju RT 02 RW 01';

    expect(SessionBoundaryParser.isDeterministicClosing(transcript, buyerOnlyText)).toBe(true);
  });

  it('Guard: Jika buyer batal setelah hashtag #clsg (di pesan terbaru), closing TETAP dibatalkan/tidak lolos', () => {
    const transcript = [
      '[BUYER] Desa Sukamaju RT 02 RW 01',
      '[CS] Oke kak kami siapkan barangnya #clsg',
      '[BUYER] maaf mas batal dulu ya istri saya gak setuju',
    ].join('\n');
    const buyerOnlyText = [
      'Desa Sukamaju RT 02 RW 01',
      'maaf mas batal dulu ya istri saya gak setuju',
    ].join('\n');

    expect(SessionBoundaryParser.isDeterministicClosing(transcript, buyerOnlyText)).toBe(false);
  });
});

