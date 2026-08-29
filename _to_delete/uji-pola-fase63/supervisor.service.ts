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
const PRICE_PATTERN = /Rp\.?\s*[\d,.]+|[\d,.]+\s*ribu|[\d,.]+\s*juta/i;

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
 * ⚠️ Sengaja TIDAK menangkap "saya cek dulu" / "akan saya cek". Kalimat itu
 * justru DIWAJIBKAN prompt sistem ("kalau belum tahu, bilang akan dicek dulu")
 * dan sudah dijaga `questionDelivered()`. Yang dilarang adalah menjanjikan
 * HASIL — harga lebih murah, diskon, negosiasi — bukan menjanjikan memeriksa.
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
function nominalDalam(text: string): string[] {
  const found = String(text ?? '').match(/Rp\.?\s*[\d,.]+|[\d,.]+\s*ribu|[\d,.]+\s*juta/gi) ?? [];
  return found.map(m => m.replace(/[^\d]/g, '')).filter(d => d.length >= 3);
}

/**
 * Apakah SELURUH nominal di balasan ada juga di pengetahuan yang diberikan?
 *
 * Sengaja "seluruh", bukan "sebagian". Balasan yang menyebut satu harga benar dan
 * satu harga karangan tetap berbahaya — dan justru bentuk itu yang paling menipu,
 * karena angka yang benar membuat yang salah terasa ikut benar.
 */
function nominalPunyaDasar(reply: string, knowledge: string): boolean {
  const diBalasan = nominalDalam(reply);
  if (diBalasan.length === 0) return false;
  const diPengetahuan = new Set(nominalDalam(knowledge));
  return diBalasan.every(n => diPengetahuan.has(n));
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

  if (PRICE_PATTERN.test(text)) {
    if (adaDasar && nominalPunyaDasar(text, k)) grounded.push('klaim_harga');
    else { found.push('klaim_harga'); score += 30; }
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
async function validateWithLLM(
  draftReply: string,
  userMessage: string,
  knowledgeContext: string,
): Promise<{ score: number; reasons: string[] }> {
  try {
    // Model, batas token (200), suhu (0), dan response_format JSON kini
    // ditentukan oleh JobConfig 'supervisor' di llm.ts. Dulu komentar di sini
    // berbunyi "model cepat cukup untuk validasi" — dan itu memang benar, tapi
    // tombolnya `GROQ_MODEL` yang dibagi bersama balasan pelanggan, jadi
    // kenyataannya validator ini ikut jalan di model besar. Sekarang bisa
    // dipisah tanpa menyentuh kode.
    const resp = await complete('supervisor', {
      messages: [
        {
          role: 'system',
          content: `Kamu adalah supervisor AI Customer Service. Tugasmu: validasi apakah jawaban AI berikut AMAN untuk dikirim ke pelanggan.

PENGETAHUAN RESMI BISNIS:
${knowledgeContext || '(tidak ada knowledge yang relevan ditemukan)'}

ATURAN VALIDASI:
1. Jika jawaban menyebut harga/nominal spesifik yang TIDAK ADA di pengetahuan bisnis → BERISIKO
2. Jika jawaban mengklaim stok tersedia tanpa konfirmasi di pengetahuan → BERISIKO
3. Jika jawaban memberi janji waktu pengiriman yang tidak tercantum → BERISIKO
4. Jika jawaban bertentangan dengan informasi di pengetahuan bisnis → BERISIKO
5. Jika jawaban MENJANJIKAN TINDAKAN yang tidak bisa ditepati → BERISIKO
   Contoh: "saya carikan yang lebih murah", "saya usahakan diskon", "nanti saya
   negosiasikan ke kurir". Menjanjikan akan MEMERIKSA sesuatu itu boleh
   ("saya cek dulu"); menjanjikan HASIL tidak boleh.
6. Jika jawaban MEMUJI MUTU atau REPUTASI yang tidak ada di pengetahuan → BERISIKO
   Contoh: "ekspedisi terpercaya", "reputasi baik", "paling cepat".
7. Jika jawaban hanya menjelaskan secara umum tanpa klaim spesifik → AMAN

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
    logger.warn(`[Supervisor] LLM validation failed, skipping: ${err}`);
    return { score: 0, reasons: [] };
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
    draftReply, userMessage, knowledgeContext,
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
