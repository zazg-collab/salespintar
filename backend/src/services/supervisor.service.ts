/**
 * Supervisor Layer — Anti-Halusinasi SalesPintar v2.0
 *
 * Arsitektur: berdasarkan konsep Hermes AI (MreRes) + Umikha repo
 *
 * Alur:
 * 1. AI generateReply() menghasilkan draft jawaban
 * 2. supervisor.validate(draft, context) → risk score
 * 3. Jika risk RENDAH → kirim langsung
 * 4. Jika risk TINGGI → ganti dengan safe fallback + trigger handover admin
 *
 * Yang divalidasi:
 * - Klaim harga spesifik (angka Rp / nominal)
 * - Klaim stok ("ready", "tersedia", "ada")
 * - Klaim timeline ("besok", "2 hari", "hari ini")
 * - Janji komitmen ("kami jamin", "pasti", "garansi X")
 * - Hallucination pattern (jawaban bertentangan dengan knowledge base)
 */

import { env } from '../config/env';
import { logger } from '../utils/logger';
import { prisma } from '../config/prisma';
import { knowledgeService } from './knowledge.service';
import { complete } from './llm';

// ─── Risk Level ───────────────────────────────────────────────────────────────
export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH';

export interface SupervisorResult {
  approved: boolean;
  riskLevel: RiskLevel;
  riskScore: number;        // 0–100
  riskReasons: string[];
  finalReply: string;       // reply yang aman dikirim
  triggeredHandover: boolean;
}

// ─── Pattern detectors (cepat, tanpa LLM) ────────────────────────────────────
export const PRICE_PATTERN = /Rp\.?\s*[\d,.]+|[\d,.]+\s*ribu|[\d,.]+\s*juta/i;

/**
 * STOCK_PATTERN — dua versi sengaja, perbedaannya penting.
 *
 * STRICT (default) — untuk memvalidasi BALASAN BOT ke pelanggan.
 *   Tangkap kata-kata ambigu seperti "ready", "tersedia", "masih ada" karena
 *   dalam konteks balasan bot itu hampir selalu klaim ketersediaan stok.
 *   Lebih baik false-positive (ditahan) daripada bot mengirim klaim palsu.
 *
 * LENIENT — untuk menilai dokumen pengetahuan dari Human Learning (chat CS manusia).
 *   Chat CS sangat sering memakai "ready", "tersedia", "masih ada" dalam konteks
 *   NON-stok: "pesanan sudah ready dikemas", "CS lagi nggak ready sekarang",
 *   "masih ada yang bisa dibantu?", "layanan tersedia setiap hari".
 *   Hanya tangkap frasa majemuk yang JELAS merujuk stok — hindari false-positive
 *   yang menyebabkan knowledge CS manusia yang valid masuk karantina sia-sia.
 *
 * JANGAN SATUKAN — kalau digabung jadi satu pola, salah satu arah pasti kalah:
 *   - Terlalu ketat → knowledge HL banyak yang salah ditahan.
 *   - Terlalu longgar → bot bisa mengklaim stok tanpa dasar.
 */
const STOCK_PATTERN_STRICT = /\b(ready|ready[\s-]?stok|ada[\s-]?stok|tersedia|masih[\s-]ada|masih[\s-]ready|in[\s-]stock)\b/i;
const STOCK_PATTERN_LENIENT = /\b(ready[\s-]?stok|ada[\s-]?stok|stok[\s-]?(?:ready|tersedia|ada|masih[\s-]ada)|masih[\s-]ada[\s-]stok|in[\s-]stock)\b/i;

const TIMELINE_PATTERN = /\b(hari ini|besok|lusa|2 hari|3 hari|minggu ini|langsung kirim|same day)\b/i;
const COMMITMENT_PATTERN = /\b(kami jamin|pasti|dijamin|100%|garansi sampai|bisa sampai|dijanjikan)\b/i;

/**
 * JANJI TINDAKAN — bot menjanjikan akan MELAKUKAN sesuatu untuk pelanggan.
 *
 * Ditambahkan 30 Juli 2026 sesudah kebocoran nyata: pada "kok mahal ya", bot
 * menjawab *"saya bisa lihat apakah ada opsi lain yang lebih murah"*. Tidak satu
 * pun pola lama kena — bukan harga (tidak menyebut nominal), bukan stok, bukan
 * waktu, dan `COMMITMENT_PATTERN` isinya "kami jamin|pasti|dijamin|100%|garansi
 * sampai|bisa sampai|dijanjikan", tak ada yang cocok. `baseScore` = 0, validator
 * LLM juga lolos karena rubriknya cuma soal harga/stok/waktu/kontradiksi.
 * Balasan itu terkirim ke pelanggan.
 *
 * Bahayanya bukan angkanya — tidak ada angka. Bahayanya bot MENGIKAT toko pada
 * pekerjaan yang tidak akan ada yang mengerjakan. Pelanggan menunggu tawaran
 * yang tidak akan datang, lalu merasa dibohongi.
 *
 * ⚠️ Sengaja TIDAK menangkap "saya cek dulu" / "akan saya cek". Sejak Fase 113
 * prompt sistem `reply` justru MELARANG bot berjanji akan memeriksa (janji itu
 * mengendap di riwayat dan tidak pernah ditepati) — tapi larangan itu urusan
 * gaya penulisan `reply`, bukan urusan pola bahaya di sini, dan `SAFE_FALLBACKS`
 * di bawah masih sengaja memakai kalimat itu untuk pesan alih-CS. Yang dilarang
 * pola ini tetap menjanjikan HASIL — harga lebih murah, diskon, negosiasi —
 * bukan menjanjikan memeriksa.
 */
const JANJI_TINDAKAN_PATTERN = new RegExp(
  [
    // "saya bisa/akan/coba cari|carikan|lihat|usahakan|minta|negosiasi…"
    String.raw`\b(?:saya|kami)\s+(?:bisa|akan|coba|nanti)\s+(?:cari|carikan|lihat|liat|usahakan|mintakan|minta|nego\w*|tawar\w*)\b`,
    // "opsi/pilihan lain yang lebih murah"
    String.raw`\b(?:opsi|pilihan|alternatif)\s+\w*\s*(?:yang\s+)?lebih\s+(?:murah|hemat)\b`,
    // "carikan yang lebih murah"
    String.raw`\bcarikan\s+(?:yang\s+)?(?:lebih\s+)?murah\b`,
    // negosiasi ke pihak lain
    String.raw`\bnego\w*\s+(?:ke|dengan|sama)\s+(?:kurir|ekspedisi|admin|atasan|pimpinan|owner|bos)\b`,
    // menjanjikan diskon/potongan
    String.raw`\b(?:minta|mintakan|usahakan|bantu)\w*\s+(?:diskon|potongan|keringanan)\b`,
    String.raw`\b(?:bisa|akan)\s+(?:saya|kami)\s+(?:bantu\s+)?turunkan\b`,
  ].join('|'),
  'i',
);

/**
 * KLAIM MUTU — pujian atas mutu/reputasi yang tidak berdasar dokumen.
 *
 * Dari kebocoran yang sama: *"kami menggunakan ekspedisi yang terpercaya dan
 * memiliki reputasi baik"*. Tidak ada satu pun dokumen di pustaka yang
 * mengatakan itu. Pujian terasa tidak berbahaya karena tidak berupa angka —
 * padahal ia klaim tentang pihak ketiga yang tidak bisa ditepati toko, dan ia
 * memberi pelanggan alasan palsu untuk menerima ongkir yang dia keluhkan.
 *
 * BERBEDA dari komitmen: pujian BOLEH dimaafkan kalau dokumen memang
 * mengatakannya. Kalau SOP menulis "kami memakai ekspedisi terpercaya", bot
 * mengulanginya itu wajar.
 */
const KLAIM_MUTU_PATTERN = /\b(terpercaya|reputasi\s+baik|paling\s+(?:murah|cepat|bagus|baik)|ter(?:baik|murah|cepat|jamin)|berkualitas\s+tinggi|sudah\s+terbukti|aman\s+dan\s+terjamin)\b/i;

/**
 * Satu-satunya definisi "fakta yang bisa basi" di seluruh sistem.
 *
 * Dipakai dua arah, dan itu disengaja:
 *  - ke LUAR — menahan balasan bot yang mengklaim harga/stok/waktu tanpa dasar;
 *    Gunakan mode: 'strict' (default).
 *  - ke DALAM — mengarantina dokumen hasil Shadow Mining yang membawa klaim
 *    serupa, supaya chat lama tidak diam-diam meloloskan justru hal yang dijaga
 *    di sisi keluar. Gunakan mode: 'strict' untuk import biasa, 'lenient' untuk
 *    Human Learning (chat CS manusia real-time).
 *
 * Kalau daftar polanya disetel, kedua arah ikut membaik sekaligus. Menyalin
 * daftar ini ke tempat lain akan membuat keduanya melenceng diam-diam.
 *
 * @param mode - 'strict' (default): untuk validasi reply bot — tangkap semua
 *   pola ambigu. 'lenient': untuk knowledge dari Human Learning — hanya tangkap
 *   frasa majemuk yang jelas merujuk stok, hindari false-positive dari percakapan
 *   CS sehari-hari.
 */
/**
 * Semua nominal di sebuah teks, dinormalkan jadi angka saja.
 *
 * "Rp 8.000" dan "Rp8000" harus dianggap nominal yang SAMA, karena model bahasa
 * dan dokumen menulisnya berbeda-beda. Yang dibandingkan angkanya, bukan
 * tulisannya.
 *
 * Token di bawah tiga angka dibuang: "Rp 50" hampir pasti bagian dari kalimat
 * lain, dan mencocokkannya akan gampang kebetulan.
 */
function nilaiNominal(token: string): number | null {
  const mentah = token.trim().toLowerCase();
  const angka = mentah.replace(/[^\d,.]/g, '');
  if (angka === '') return null;

  let n: number;
  if (/ribu|juta/.test(mentah)) {
    // Di sini titik pemisah ribuan dan koma pemisah desimal: "1,5 juta".
    n = parseFloat(angka.replace(/\./g, '').replace(',', '.'));
    if (!Number.isFinite(n)) return null;
    n *= /juta/.test(mentah) ? 1_000_000 : 1_000;
  } else {
    n = parseInt(angka.replace(/[.,]/g, ''), 10);
  }
  return Number.isFinite(n) ? Math.round(n) : null;
}

function nominalDalam(text: string): number[] {
  const found = String(text ?? '').match(/Rp\.?\s*[\d,.]+|[\d,.]+\s*ribu|[\d,.]+\s*juta/gi) ?? [];
  const nilai = found.map(nilaiNominal).filter((n): n is number => n !== null && n >= 100);
  return [...new Set(nilai)];
}

/**
 * Apakah `target` bisa disusun dari penjumlahan beberapa nominal yang berdasar?
 *
 * ── Kenapa ini harus ada, dan kenapa baru sekarang ─────────────────────────
 * Selama "nominal tanpa dasar" cuma bernilai 30 (MEDIUM, tetap dikirim),
 * pertanyaan ini tidak penting. Begitu ia dinaikkan jadi HIGH, ia jadi penentu:
 * TOTAL yang benar pun tidak akan pernah muncul apa adanya di dokumen mana pun.
 * Harga produk ada di satu potongan, ongkir datang dari API Mengantar di
 * potongan lain, dan jumlahnya cuma ada di kepala — persis pekerjaan yang CS
 * manusia lakukan tiap hari ("Harga 142.000 + ongkir 20.000 = TOTAL COD
 * 162.000").
 *
 * Tanpa aturan ini, menaikkan bobotnya akan membuat bot MUSTAHIL menyebut total,
 * dan setiap pertanyaan "totalnya berapa?" berakhir di CS manusia. Itu bukan
 * pengaman, itu mematikan fiturnya.
 *
 * Yang tetap dijaga: angka yang tidak bisa disusun dari apa pun yang ada di
 * pengetahuan tetap dianggap karangan. Menjumlahkan fakta itu menghitung;
 * memunculkan angka dari udara itu mengarang.
 *
 * Batasnya sengaja sempit — paling banyak 12 nominal sumber dan 4 suku. Bukan
 * demi kecepatan, tapi supaya "kebetulan cocok" tetap kecil: makin banyak
 * kombinasi yang diizinkan, makin besar peluang angka karangan menabrak salah
 * satunya dan lolos sebagai "hasil hitungan".
 */
function bisaDihitungDari(target: number, sumber: number[]): boolean {
  const pakai = sumber.slice(0, 12);
  const telusur = (mulai: number, sisa: number, suku: number): boolean => {
    if (sisa === 0 && suku >= 2) return true;
    if (sisa <= 0 || suku >= 4) return false;
    for (let i = mulai; i < pakai.length; i++) {
      if (telusur(i + 1, sisa - pakai[i]!, suku + 1)) return true;
    }
    return false;
  };
  return telusur(0, target, 0);
}

/**
 * Apakah SELURUH nominal di balasan ada juga di pengetahuan yang diberikan?
 *
 * Sengaja "seluruh", bukan "sebagian". Balasan yang menyebut satu harga benar dan
 * satu harga karangan tetap berbahaya — dan justru bentuk itu yang paling menipu,
 * karena angka yang benar membuat yang salah terasa ikut benar.
 */
/** Bentuk UUID — `conversationId` bisa juga berisi label seperti "audit". */
const POLA_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Angka yang SUDAH pernah dikirim ke pelanggan ini dan lolos pemeriksaan.
 *
 * ── Kenapa dasar kedua ini harus ada (Fase 110) ─────────────────────────────
 * Supervisor cuma membandingkan balasan dengan potongan pengetahuan yang
 * terambil UNTUK PESAN ITU. Padahal percakapan nyata tidak bekerja begitu:
 * pelanggan bertanya "Bedog Betekok berapa?", bot menjawab Rp139.000 dari
 * dokumennya, lalu pelanggan menulis "berapa harganya kak?" — dan pada giliran
 * kedua ini dokumen produknya bisa saja tidak ikut terambil. Angka yang sama,
 * yang satu menit lalu terbukti benar, mendadak dinilai karangan dan ditahan.
 * Terjadi di produksi 2 Agustus 2026 pukul 08:09 WIB.
 *
 * Yang dipakai sebagai dasar SENGAJA hanya pesan yang benar-benar TERKIRIM:
 * balasan bot yang lolos Supervisor, dan pesan yang diketik CS manusia. Draft
 * yang ditahan tidak pernah masuk tabel ini. Jadi satu karangan tidak bisa
 * menjadi dasar bagi karangan berikutnya — yang justru bahaya terbesar kalau
 * riwayat mentah dipakai apa adanya.
 */
async function angkaYangSudahDisetujui(businessId: string, conversationId: string): Promise<string> {
  if (!POLA_UUID.test(conversationId)) return '';
  try {
    const rows = await prisma.message.findMany({
      where: { businessId, conversationId, fromRole: { in: ['AI', 'HUMAN'] } },
      orderBy: { createdAt: 'desc' },
      take: 12,
      select: { message: true },
    });
    return rows.map(r => r.message).join('\n');
  } catch (err) {
    // Gagal membaca riwayat TIDAK BOLEH melonggarkan pengaman: yang terjadi cuma
    // kembali ke perilaku lama (dasar hanya dari potongan pengetahuan).
    logger.warn(`[Supervisor] Riwayat balasan yang sudah disetujui tidak terbaca: ${err}`);
    return '';
  }
}

type DasarNominal = 'tidak-ada-nominal' | 'berdasar' | 'hasil-hitung' | 'tak-berdasar';

function dasarNominal(reply: string, knowledge: string): DasarNominal {
  const diBalasan = nominalDalam(reply);

  // Pola harga menyala tapi tidak ada nominal yang bisa diukur — misalnya
  // "Rp 50" atau nomor rekening yang kepotong. Dulu keadaan ini diam-diam
  // dihitung sebagai "tidak berdasar", padahal ia "tidak ada yang bisa
  // diperiksa". Bedanya tidak penting saat bobotnya 30; saat bobotnya 60 ia
  // menjadi selisih antara terkirim dan dialihkan ke manusia.
  // Validator LLM tetap memeriksa balasan ini — jadi bukan tanpa penjaga.
  if (diBalasan.length === 0) return 'tidak-ada-nominal';

  const diPengetahuan = nominalDalam(knowledge);
  const set = new Set(diPengetahuan);
  if (diBalasan.every(n => set.has(n))) return 'berdasar';

  const sisa = diBalasan.filter(n => !set.has(n));
  if (sisa.every(n => bisaDihitungDari(n, diPengetahuan))) return 'hasil-hitung';

  return 'tak-berdasar';
}

/**
 * Apakah setiap frasa yang tertangkap pola ini muncul juga di pengetahuan?
 *
 * Dipakai untuk pola berbasis frasa (waktu, stok). Perbandingannya apa adanya —
 * kalau dokumen menulis "estimasi 2 hari" dan bot menulis "2 hari", frasa "2 hari"
 * ada di dua-duanya dan itu cukup.
 */
function frasaPunyaDasar(reply: string, knowledge: string, pattern: RegExp): boolean {
  const flags = pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g';
  const found = String(reply ?? '').match(new RegExp(pattern.source, flags)) ?? [];
  if (found.length === 0) return false;
  const k = String(knowledge ?? '').toLowerCase();
  return found.every(m => k.includes(m.toLowerCase()));
}

export function hasRiskyPattern(
  text: string,
  mode: 'strict' | 'lenient' = 'strict',
  /**
   * Pengetahuan yang dipakai menyusun balasan ini.
   *
   * ── Kenapa parameter ini ditambahkan ─────────────────────────────────────
   * Sampai 30 Juli 2026 fungsi ini regex murni atas teks balasan: ia tidak pernah
   * tahu apakah angka yang disebut bot punya dasar. Jadi "Rp 8.000" yang datang
   * langsung dari API Mengantar dihukum sama beratnya dengan angka yang dikarang.
   *
   * Sekarang itu bukan cuma kebisingan, karena ada kombinasi yang bisa memblokir
   * jawaban yang benar sepenuhnya:
   *
   *     "JNE Rp 8.000, estimasi 2 hari. Ekspedisi yang tersedia: JNE, J&T."
   *       klaim_harga    +30   ← angkanya dari API
   *       klaim_timeline +20   ← "2 hari", dari API
   *       klaim_stok     +25   ← kata "tersedia", padahal soal ekspedisi bukan stok
   *       = 75 → HIGH → diblokir → diganti pesan cadangan → dialihkan ke manusia
   *
   * Ketiga polanya menyala, semuanya berdasar, dan jawaban yang benar dibuang.
   * Di audit 30 Juli dua dari tiga sudah menyala bersamaan berkali-kali, dan yang
   * ketiga menyala sendiri di pertanyaan lain — tinggal ketemu di satu kalimat.
   *
   * Prinsipnya satu: pola yang teksnya ADA di pengetahuan yang diberikan itu
   * berdasar, dan yang berdasar bukan risiko. Itu justru maksud seluruh
   * rancangannya — potongan tarif disuntikkan supaya Supervisor menemukan
   * angkanya di sana.
   *
   * KALAU KOSONG ATAU TIDAK DIISI, perilakunya IDENTIK dengan sebelumnya. Tidak
   * ada satu pun pengaman yang dilonggarkan; yang berubah cuma bahwa klaim yang
   * bisa dibuktikan berhenti dihitung sebagai klaim tanpa dasar.
   */
  knowledgeContext?: string,
): { patterns: string[]; baseScore: number; grounded: string[] } {
  const found: string[] = [];
  const grounded: string[] = [];
  let score = 0;
  const stockPattern = mode === 'lenient' ? STOCK_PATTERN_LENIENT : STOCK_PATTERN_STRICT;
  const k = String(knowledgeContext ?? '');
  const adaDasar = k.trim().length > 0;

  // ── Harga: satu-satunya pola yang sendirian sudah cukup untuk HIGH ────────
  //
  // Sampai 31 Juli 2026 bobotnya 30 — tepat di ambang MEDIUM, artinya
  // "tercatat, tetap dikirim". Malam itu bot menjawab pelanggan dengan
  // *"ongkir ke Purwokerto untuk paket 1 kg sekarang Rp 8.000 dengan SiCepat"*.
  // Pelanggan tidak pernah menyebut kota; "Purwokerto" dipungut dari daftar
  // CONTOH nama ambigu di `02-ongkos-kirim.md`; "SiCepat" dan "8.000" tidak ada
  // di mana pun di pustaka. Supervisor MENANGKAPNYA — log berbunyi persis
  // "nominal ongkir spesifik (Rp 8.000) yang tidak tercantum dalam pengetahuan"
  // — lalu meloloskannya dengan skor 30/MEDIUM/approved:true.
  //
  // Empat puluh detik kemudian pelanggan bertanya "totalnya berapa", bot
  // mengulang angka karangannya sendiri, dan BARU di situ ia ditahan di 80.
  // Jadi seluruh kerusakan sudah terjadi satu giliran sebelumnya: yang ditahan
  // bukan kebohongannya, melainkan gemanya.
  //
  // Angka harga yang tidak punya dasar berbeda kelas dari pola lain di daftar
  // ini. Ia MENGIKAT: pelanggan menghitung uang yang dia siapkan, dan untuk 90%
  // orderan yang COD, angka itu yang dibawa kurir ke depan pintu. Salah satu
  // digit berarti kurir ditolak, paket kembali, ongkir dua arah ditanggung toko.
  // Pola lain menyesatkan; yang ini menagih.
  //
  // 60 = ambang HIGH persis. Sendirian ia menahan balasan dan mengalihkan ke
  // manusia — tidak perlu menunggu cacat kedua menemaninya.
  //
  // ⚠️ Konsekuensi yang disengaja: selama harga produk BELUM ada di pustaka,
  // bot akan lebih sering mengalihkan ke manusia, bukan lebih jarang. Itu bukan
  // efek samping yang harus diredam dengan menurunkan bobotnya lagi — itu
  // tagihan yang selama ini dibayar diam-diam oleh pelanggan.
  if (PRICE_PATTERN.test(text)) {
    const dasar = adaDasar ? dasarNominal(text, k) : 'tak-berdasar';
    if (dasar === 'berdasar') grounded.push('klaim_harga');
    else if (dasar === 'hasil-hitung') grounded.push('klaim_harga(hitungan)');
    else if (dasar === 'tidak-ada-nominal') grounded.push('klaim_harga(tanpa nominal)');
    else { found.push('klaim_harga'); score += 60; }
  }
  if (stockPattern.test(text)) {
    if (adaDasar && frasaPunyaDasar(text, k, stockPattern)) grounded.push('klaim_stok');
    else { found.push('klaim_stok'); score += 25; }
  }
  if (TIMELINE_PATTERN.test(text)) {
    if (adaDasar && frasaPunyaDasar(text, k, TIMELINE_PATTERN)) grounded.push('klaim_timeline');
    else { found.push('klaim_timeline'); score += 20; }
  }
  // ── Komitmen SENGAJA tidak pernah dimaafkan oleh dasar ────────────────────
  // Harga, waktu, dan stok itu FAKTA: kalau tertulis di dokumen, mengulangnya
  // aman. Janji berbeda sifatnya. "Kami jamin sampai 3 hari" tidak jadi aman
  // hanya karena pernah ditulis di suatu dokumen — ia tetap mengikat toko pada
  // percakapan ini, dengan pelanggan ini, pada pengiriman ini. Yang menanggung
  // akibatnya pemilik toko, bukan dokumennya.
  if (COMMITMENT_PATTERN.test(text)) { found.push('klaim_komitmen'); score += 25; }

  // ── Janji tindakan: sama tidak termaafkannya dengan komitmen ───────────
  // Bobotnya 35, bukan 25, dan itu disengaja: dengan ambang MEDIUM di 30, janji
  // tindakan yang berdiri sendiri sudah cukup untuk MEDIUM (tercatat, masih
  // dikirim). Bergabung dengan cacat lain apa pun ia melewati 60 → HIGH →
  // ditahan dan dialihkan ke manusia. Balasan yang membocorkan pola ini pada
  // 30 Juli 2026 mengandung DUA cacat sekaligus (janji + pujian mutu), jadi
  // dengan aturan ini ia akan tertahan — bukan cuma tercatat.
  if (JANJI_TINDAKAN_PATTERN.test(text)) { found.push('janji_tindakan'); score += 35; }

  // ── Klaim mutu: BOLEH dimaafkan kalau dokumen memang mengatakannya ─────
  if (KLAIM_MUTU_PATTERN.test(text)) {
    if (adaDasar && frasaPunyaDasar(text, k, KLAIM_MUTU_PATTERN)) grounded.push('klaim_mutu');
    else { found.push('klaim_mutu'); score += 30; }
  }

  return { patterns: found, baseScore: Math.min(score, 100), grounded };
}

// ─── LLM Validator (hanya jika pattern score > 0) ────────────────────────────
/**
 * Bersihkan salinan pengetahuan yang dilihat Supervisor — Fase 93.
 *
 * Kejadian yang memaksa ini ada: 1 Agustus 2026, pelanggan menjawab "boleh" atas
 * tawaran foto. Supervisor memberi skor 80/HIGH dengan alasan *"Jawaban tidak
 * menggunakan format penanda yang benar sesuai SOP"* — percakapan diserahkan ke CS
 * padahal tidak ada satu pun klaim berisiko.
 *
 * Sebabnya tabrakan dua keputusan yang masing-masing benar:
 *   1. Fase 88 membuang penanda SEBELUM Supervisor melihat jawaban, supaya
 *      Supervisor menilai apa yang benar-benar dibaca pelanggan.
 *   2. SOP kirim-gambar ikut masuk pengetahuan, supaya penulis balasan tahu aturannya.
 *
 * Hasilnya aturan yang SECARA KONSTRUKSI tidak mungkin dipenuhi di teks yang
 * diperiksa: Supervisor membaca "wajib pakai penanda", melihat teks tanpa penanda,
 * lalu menyimpulkan pelanggaran. Dan ini bukan cuma soal jalur cadangan — di jalur
 * normal pun penandanya sudah dibuang, jadi tanpa perbaikan ini SETIAP permintaan
 * foto berpotensi diblokir.
 *
 * Aturan 8 di rubrik sudah menyatakan format bukan urusan Supervisor. Fungsi ini
 * lapis kedua: menghilangkan contoh sintaksnya sekalian, supaya tidak ada bentuk
 * konkret yang bisa dijadikan patokan. Fakta produknya (harga, ukuran, bahan) TIDAK
 * disentuh — dokumen `Produk/` tetap dibutuhkan Supervisor untuk memeriksa klaim.
 */
function pengetahuanUntukSupervisor(teks: string): string {
  return teks
    // sintaks penanda -> keterangan netral
    .replace(/\{\{\s*kirim-gambar\s*:\s*[^}\n]*\}\}/gi, '(lampiran foto)')
    // kalimat instruksi penulisan yang menyebut penanda
    .split('\n')
    .filter((baris) => !/penanda|kurung kurawal/i.test(baris))
    .join('\n');
}

async function validateWithLLM(
  draftReply: string,
  userMessage: string,
  knowledgeContext: string,
  /**
   * ⚠️ WAJIB, dan sebelum Fase 85 tidak pernah dikirim.
   *
   * `complete()` mencari override model per-business lewat `businessId`. Tanpa
   * parameter ini, pilihan "Supervisor" di halaman Pengaturan Model **tidak
   * pernah berlaku** — Angga bisa memilih model apa pun di layar dan tidak ada
   * yang berubah. Layar yang menawarkan pilihan yang tidak berpengaruh lebih
   * buruk daripada layar yang tidak menawarkan apa-apa.
   *
   * Ketahuan 31 Juli 2026 saat mencoba memindahkan `supervisor` ke kolam jatah
   * Groq yang lain: override sudah tertulis di DB, cache sudah dikosongkan, dan
   * panggilannya TETAP ke `llama-3.3-70b-versatile`.
   *
   * Akibat kedua yang ikut terbawa: baris `llm_calls` untuk `supervisor` selalu
   * `business_id = NULL`, jadi biaya per business tidak pernah lengkap.
   */
  businessId: string,
): Promise<{ score: number; reasons: string[] }> {
  try {
    // Model, batas token (200), suhu (0), dan response_format JSON kini
    // ditentukan oleh JobConfig 'supervisor' di llm.ts. Dulu komentar di sini
    // berbunyi "model cepat cukup untuk validasi" — dan itu memang benar, tapi
    // tombolnya `GROQ_MODEL` yang dibagi bersama balasan pelanggan, jadi
    // kenyataannya validator ini ikut jalan di model besar. Sekarang bisa
    // dipisah tanpa menyentuh kode.
    const resp = await complete('supervisor', {
      businessId,
      messages: [
        {
          role: 'system',
          content: `Kamu adalah supervisor AI Customer Service. Tugasmu: validasi apakah jawaban AI berikut AMAN untuk dikirim ke pelanggan.

PENGETAHUAN RESMI BISNIS:
${pengetahuanUntukSupervisor(knowledgeContext) || '(tidak ada knowledge yang relevan ditemukan)'}

ATURAN VALIDASI:
1. Jika jawaban menyebut harga/nominal spesifik yang TIDAK ADA di pengetahuan bisnis → BERISIKO
2. Jika jawaban mengklaim stok tersedia tanpa konfirmasi di pengetahuan → BERISIKO
2b. Jika jawaban mengklaim stok KOSONG / habis / tidak tersedia → BERISIKO TINGGI.
   Toko ini tidak punya data stok di sistem, jadi klaim itu tidak punya dasar apa pun.
   Arah ini justru yang paling merugikan: pelanggan yang siap membeli diberi tahu
   barangnya habis. Aturan 2 dulu hanya melarang arah sebaliknya, dan pada 1 Agustus
   2026 klaim "stoknya sedang kosong" lolos dengan skor 20 lalu terkirim ke pelanggan.
3. Jika jawaban memberi janji waktu pengiriman yang tidak tercantum → BERISIKO
4. Jika jawaban bertentangan dengan informasi di pengetahuan bisnis → BERISIKO
5. Jika jawaban MENJANJIKAN TINDAKAN yang tidak bisa ditepati → BERISIKO
   Contoh: "saya carikan yang lebih murah", "saya usahakan diskon", "nanti saya
   negosiasikan ke kurir". Bot sekarang DILARANG oleh prompt sistemnya sendiri
   menjanjikan akan memeriksa ("saya cek dulu") — itu aturan penulisan, bukan
   aturan keamananmu, jadi JANGAN naikkan risk_score hanya karena kalimat itu
   masih muncul (mis. terbawa riwayat, atau pesan alih-CS yang memang sengaja
   ditulis seperti itu). Yang tetap BERISIKO menurut aturan ini hanya
   menjanjikan HASIL — diskon, harga lebih murah, negosiasi — bukan menjanjikan
   memeriksa.
6. Jika jawaban MEMUJI MUTU atau REPUTASI yang tidak ada di pengetahuan → BERISIKO
   Contoh: "ekspedisi terpercaya", "reputasi baik", "paling cepat".
6b. Jika jawaban MENJELASKAN ATAU MENJANJIKAN FITUR, LAYANAN, SISTEM, atau ALUR TRANSAKSI
   (mis. aplikasi, website checkout, sistem poin/membership, metode pembayaran, kebijakan
   retur/tukar, tahapan proses) yang TIDAK DISEBUTKAN di pengetahuan bisnis → BERISIKO TINGGI.
   Beda dari aturan 1-6: bukan soal angka atau janji tindakan, tapi soal MENGARANG KEBERADAAN
   sesuatu yang tidak pernah didokumentasikan. Contoh: menyebut ada "aplikasi" atau "checkout
   di website" padahal pelanggan cuma pesan lewat WhatsApp; menyebut ada "sistem poin";
   menjelaskan prosedur retur/tukar yang detailnya tidak tercantum di pengetahuan. Kalau
   pengetahuan bisnis tidak menyebutkan sesuatu ADA, anggap TIDAK ADA — jangan biarkan jawaban
   yang percaya diri soal fitur fiktif dianggap aman hanya karena tidak menyebut angka.
7. Jika jawaban hanya menjelaskan secara umum tanpa klaim spesifik → AMAN
8. BUKAN URUSANMU: cara penulisan, format, tata letak, atau penanda teknis.
   Kamu HANYA menilai kebenaran klaim dan janji yang dibaca pelanggan.
   Sebagian dokumen di PENGETAHUAN RESMI BISNIS di atas berisi INSTRUKSI UNTUK
   PENULIS BALASAN (mis. cara melampirkan foto, penanda katalog, urutan bagian).
   Instruksi semacam itu BUKAN fakta bisnis dan BUKAN kriteria validasi.
   Khususnya: penanda lampiran gambar SUDAH DIBUANG oleh sistem sebelum jawaban
   ini sampai ke kamu. Jadi jawaban yang tidak memuat penanda apa pun adalah
   NORMAL — bukan pelanggaran, dan risk_score-nya TIDAK boleh naik karena itu.
   Jangan pernah memberi alasan yang menyebut penanda, format, atau SOP penulisan.

Output JSON: {"risk_score": 0-100, "reasons": ["alasan1", "alasan2"]}
risk_score 0 = sangat aman, 100 = sangat berisiko`,
        },
        {
          role: 'user',
          content: `Pesan pelanggan: "${userMessage}"\n\nJawaban AI yang akan dikirim: "${draftReply}"`,
        },
      ],
    });

    const raw = resp.text || '{}';
    const parsed = JSON.parse(raw);
    return {
      score: Math.min(100, Math.max(0, Number(parsed.risk_score) || 0)),
      reasons: Array.isArray(parsed.reasons) ? parsed.reasons : [],
    };
  } catch (err) {
    // ── GAGAL-TERTUTUP, bukan gagal-terbuka (Fase 112) ──────────────────────
    // Sampai hari ini baris ini mengembalikan skor 0 — artinya waktu pemeriksa
    // TIDAK BISA memeriksa, balasan justru dinyatakan paling aman lalu dikirim.
    // Terjadi di produksi 2 Agustus 2026 pukul 07:26 WIB: jatah Gemini habis,
    // Supervisor 429 di setiap panggilan, dan jawaban ngarang dari model cadangan
    // lolos ke pelanggan tanpa satu pun pemeriksaan. Pengaman yang mati diam-diam
    // lebih berbahaya daripada tidak ada pengaman, karena semua orang mengira ia
    // masih bekerja.
    //
    // Skor 100 = ditahan dan dialihkan ke CS manusia. Konsekuensinya disadari dan
    // disengaja: kalau penyedia model tumbang, bot berhenti menjawab sendiri dan
    // manusia mengambil alih — BUKAN bot terus menjawab tanpa diperiksa.
    // Empat percobaan ulang sudah dilakukan sebelum galat ini muncul.
    logger.error(`[Supervisor] TIDAK BISA memeriksa — balasan DITAHAN (gagal-tertutup): ${err}`);
    return { score: 100, reasons: ['supervisor_tidak_bisa_memeriksa'] };
  }
}

// ─── Safe Fallback Messages ───────────────────────────────────────────────────
// Pesan yang dikirim menggantikan jawaban AI yang diblokir.
//
// Sengaja ditulis seperti CS yang sedang mengecek sesuatu — bukan seperti sistem
// yang sedang mengalihkan tiket. Tidak menyebut "tim", "sistem", "dialihkan",
// dan tidak lagi mengarahkan ke "ketik 0" (opsi itu sudah dihapus). Dari sisi
// pelanggan, percakapan terasa berlanjut dengan orang yang sama; padahal di
// belakang layar percakapan sudah berpindah ke CS sungguhan.
const SAFE_FALLBACKS = [
  'Sebentar ya Kak, saya cek dulu biar infonya pasti 🙏',
  'Bentar Kak, saya pastikan dulu ya biar nggak salah kasih info 😊',
  'Saya cek dulu sebentar ya Kak, biar yang saya kasih benar-benar akurat.',
];

function getSafeFallback(): string {
  return SAFE_FALLBACKS[Math.floor(Math.random() * SAFE_FALLBACKS.length)]!;
}

// ─── Main Supervisor Validate ─────────────────────────────────────────────────
export async function supervisorValidate(
  businessId: string,
  draftReply: string,
  userMessage: string,
  conversationId: string,
  /**
   * Knowledge yang sudah diambil pemanggil (ai.service saat menyusun balasan).
   * Kalau diisi, supervisor tidak mencari ulang — menghemat satu perhitungan
   * embedding + satu query pgvector per balasan. Kalau `undefined`, supervisor
   * mencari sendiri agar tetap bisa dipakai berdiri sendiri.
   */
  knowledgeDocs?: string[],
): Promise<SupervisorResult> {
  // ── Step 1: siapkan pengetahuan LEBIH DULU ────────────────────────────────
  // Urutannya sengaja diubah. Dulu pemeriksaan pola jalan pertama, tanpa
  // pengetahuan — jadi ia tidak mungkin tahu apakah angka yang disebut bot punya
  // dasar. Sekarang pengetahuannya disiapkan dulu supaya bisa dipakai keduanya:
  // pemeriksaan pola DAN validator LLM.
  let knowledgeContext = '';
  if (knowledgeDocs !== undefined) {
    knowledgeContext = knowledgeDocs.join('\n---\n');
  } else {
    try {
      const docs = await knowledgeService.searchRelevantKnowledge(businessId, userMessage, 3);
      knowledgeContext = docs.join('\n---\n');
    } catch { /* knowledge tidak tersedia */ }
  }

  // ── Dasar KEDUA: angka yang sudah pernah terkirim ke pelanggan ini ────────
  // Ditambahkan ke `knowledgeContext`, bukan diperiksa terpisah, supaya SATU
  // definisi "berdasar" tetap berlaku — baik untuk pemeriksaan pola maupun untuk
  // validator LLM. Diberi judul sendiri supaya validator LLM tahu asal-usulnya.
  const sudahDisetujui = await angkaYangSudahDisetujui(businessId, conversationId);
  if (sudahDisetujui) {
    knowledgeContext = knowledgeContext
      ? `${knowledgeContext}\n---\nSudah disampaikan ke pelanggan ini sebelumnya (boleh diulang):\n${sudahDisetujui}`
      : `Sudah disampaikan ke pelanggan ini sebelumnya (boleh diulang):\n${sudahDisetujui}`;
  }

  // Step 2: pattern check (cepat, tanpa LLM) — kini sadar dasar
  const { patterns, baseScore, grounded } = hasRiskyPattern(draftReply, 'strict', knowledgeContext);

  // ── Step 3: LLM validation — Fix audit B3 ─────────────────────────────────
  // Dulu dibungkus `if (baseScore > 0)`, artinya validator LLM HANYA jalan
  // kalau regex sudah menemukan sesuatu. Padahal justru halusinasi yang paling
  // berbahaya adalah yang tidak terlihat seperti pola berisiko: AI mengarang
  // nama produk, salah menyebut kebijakan retur, atau membuat klaim yang
  // bertentangan dengan knowledge base tanpa menyebut angka sama sekali. Semua
  // itu lolos tanpa pernah diperiksa. Sekarang LLM selalu dijalankan.
  //
  // Biayanya satu panggilan model 8B (max 200 token) per balasan — murah, dan
  // pencarian knowledge-nya pun dioper dari ai.service jadi tidak dihitung dua kali.
  const { score: llmScore, reasons: llmReasons } = await validateWithLLM(
    draftReply, userMessage, knowledgeContext, businessId,
  );

  // ── Skoring: ambil sinyal TERTINGGI, bukan rata-rata ──────────────────────
  // Rumus lama `max(baseScore, (baseScore + llmScore) / 2)` meredam sinyal LLM
  // secara fatal saat regex diam. Contoh: regex 0, LLM 100 (yakin halusinasi)
  // → (0+100)/2 = 50 → hanya MEDIUM → tetap dikirim ke pelanggan. Artinya
  // membuka gerbang di atas saja tidak cukup; rumusnya ikut harus diperbaiki,
  // kalau tidak lubang B3 cuma berpindah tempat.
  const finalScore = Math.max(baseScore, llmScore);
  const allReasons = [...new Set([...patterns, ...llmReasons])];

  // Step 3: tentukan risk level & keputusan
  const riskLevel: RiskLevel = finalScore >= 60 ? 'HIGH' : finalScore >= 30 ? 'MEDIUM' : 'LOW';
  const approved = riskLevel !== 'HIGH';
  const triggeredHandover = riskLevel === 'HIGH';
  const finalReply = approved ? draftReply : getSafeFallback();

  // `grounded` ikut dicatat supaya pemaafan ini KELIHATAN. Pengaman yang
  // melonggarkan diri tanpa jejak adalah pengaman yang tidak bisa dipercaya —
  // kalau suatu hari ia memaafkan yang seharusnya tidak, log inilah yang
  // memberitahu.
  logger.info(
    `[Supervisor] conv:${conversationId} | score:${finalScore} | level:${riskLevel} | approved:${approved}` +
    (allReasons.length ? ` | reasons:[${allReasons.join(', ')}]` : '') +
    (grounded.length ? ` | berdasar:[${grounded.join(', ')}]` : ''),
  );

  return {
    approved,
    riskLevel,
    riskScore: finalScore,
    riskReasons: allReasons,
    finalReply,
    triggeredHandover,
  };
}
