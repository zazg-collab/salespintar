import { env } from '../config/env';
import { complete } from './llm';
import { prisma } from '../config/prisma';
import { logger } from '../utils/logger';
import { getTodayAiCount } from './rate-limit.service';
import { lookupCachedAnswer } from './answer-cache.service';
import {
  getShippingQuotes,
  quotesToKnowledgeChunk,
  askInstruction,
  getShippingQuotesForChoice,
  unresolvedToKnowledgeChunk,
} from './mengantar.service';
import { detectShippingIntent } from '../utils/shipping-intent';
import { adaNiatCod, kumpulkanNominal, nominalDariDokumen, potonganHitunganCod } from '../utils/biaya-cod';
import { daftarNamaProduk, namaProdukDisebut } from '../utils/konteks-produk';
import { questionDelivered } from '../utils/location-resolver';
import {
  rememberQuestion,
  getPendingQuestion,
  forgetQuestion,
  looksLikePlaceAnswer,
  matchAnswerToChoice,
  combineAnswer,
  rememberQuotes,
  getRememberedQuotes,
  looksLikeQuoteFollowUp,
} from './shipping-dialog.service';
import {
  CONSECUTIVE_LIMIT,
  getConsecutiveCount,
  incrementConsecutive,
  isReplyRateLimited,
  markReplied,
} from './state.service';

const CONTEXT_LIMIT = 20;
const DAILY_CAP = env.GROQ_DAILY_CAP_PER_LEAD;

// ── Fix audit A5: state rate limit & counter beruntun sudah pindah ke Redis ──
// Dulu dua Map in-memory (lastReplyTimestamps, consecutiveReplies) plus
// setInterval pembersih tiap 1 jam. Sekarang semuanya di state.service.ts:
// key Redis ber-TTL, jadi konsisten lintas instance dan tidak bocor memori.
// Perilaku "reset per jam" dari fix A7 dipertahankan lewat TTL fixed-window.

/**
 * Prompt sistem untuk balasan ke pelanggan.
 *
 * Di-export supaya alat audit (`audit-ai.ts`) memakai prompt yang SAMA, bukan
 * salinannya. Alat audit yang menyimpan salinan prompt akan menyimpang tanpa ada
 * yang sadar, lalu melaporkan bot yang tidak pernah ada.
 */
export function getSystemPrompt(businessName: string): string {
  // Nada dibuat sewajar CS toko sungguhan (keputusan Angga, 2026-07-29):
  // pelanggan tidak perlu merasa sedang bicara dengan mesin. Kalimat soal
  // "akan segera dialihkan" dihapus karena pengalihan kini terjadi diam-diam.
  //
  // Satu pagar sengaja DIPERTAHANKAN: kalau pelanggan bertanya LANGSUNG apakah
  // ini manusia atau mesin, bot menjawab jujur. Tidak pernah mengumumkan diri
  // sebagai AI itu wajar; berbohong saat ditanya terus terang itu hal berbeda —
  // risikonya kepercayaan pelanggan kalau ketahuan, dan di sebagian negara ada
  // kewajiban hukum untuk mengungkapkannya. Baris terakhir bisa diubah kalau
  // Angga memang menghendaki lain.
  //
  // ── DUA LARANGAN DI BAWAH ADA DI SINI, BUKAN DI DOKUMEN PENGETAHUAN ────────
  // `SOP/02-ongkos-kirim.md` sebenarnya SUDAH melarang menjanjikan potongan
  // ongkir (bagian "Kalau pelanggan menawar ongkir"). Larangan itu tetap
  // dilanggar pada 30 Juli 2026: pada "kok mahal ya" bot menjawab *"saya bisa
  // lihat apakah ada opsi lain yang lebih murah"* dan *"kami menggunakan
  // ekspedisi yang terpercaya dan memiliki reputasi baik"*.
  //
  // Sebabnya persis pelajaran Fase 45, yang saat itu ditulis untuk perintah
  // bertanya dan ternyata berlaku umum: potongan pengetahuan sampai ke model
  // dibungkus "gunakan informasi di atas ... jika relevan" — itu SARAN. Prompt
  // sistem adalah ATURAN. Kalau keduanya bertabrakan, aturan yang menang.
  // Ditambah lagi, pencarian pustaka bisa saja tidak mengambil potongan itu
  // untuk pertanyaan tiga kata seperti "kok mahal ya" — jadi saran itu bahkan
  // belum tentu sampai. Aturan yang tidak boleh dilanggar tidak boleh
  // dititipkan ke pustaka.
  return `Kamu customer service untuk ${businessName}.

CARA BICARA — ini yang dinilai pelanggan lebih dulu daripada isi jawabanmu:
Pakai bahasa Indonesia yang ramah, hangat, jelas, dan persuasif. Bicara seperti CS toko yang benar-benar melayani orang, bukan seperti mesin yang membacakan katalog.
Jawab singkat, langsung ke inti, dan mudah dipahami.
Panggil pelanggan "Kak" kalau konteksnya pas.
Boleh pakai emoji secukupnya — satu atau dua, di tempat yang wajar. Jangan berlebihan, jangan di tiap kalimat.
Jangan menekan, menakut-nakuti, atau membuat klaim palsu demi penjualan.

JANGAN MENYALIN MENTAH-MENTAH kalimat dari dokumen pengetahuan. Dokumen itu ditulis padat untuk mesin — berisi deretan spesifikasi dipisah koma. Kalau kamu menyalinnya apa adanya, pelanggan menerima kalimat seperti "Nama Produk, panjang bilah 19-20cm, tebal bilah 3-4 mm, lebar bilah 4-6cm, gagang Kayu Jati." Itu bunyinya seperti label gudang, bukan seperti orang. Ambil FAKTANYA, lalu tulis ulang dengan kalimatmu sendiri yang mengalir.
Sebutkan hanya spesifikasi yang benar-benar relevan dengan yang ditanyakan. Kalau pelanggan cuma bertanya harga, jangan sekalian membacakan tebal dan lebar bilahnya.

Jangan menyebut dirimu bot, sistem, asisten AI, atau alat — cukup jawab seperti orang yang sedang melayani.
Kalau ada yang belum kamu ketahui, JANGAN berjanji akan mengeceknya. Kamu tidak punya cara untuk kembali lagi nanti — kalimat seperti "saya cek dulu ya", "tunggu sebentar", "nanti saya kabari", atau "masih saya cek" adalah janji yang TIDAK AKAN PERNAH kamu tepati, dan pelanggan akan menunggu sampai bosan lalu pergi. Yang benar: TANYAKAN hal yang kamu butuhkan supaya bisa menjawab (misalnya kecamatan atau kode pos untuk ongkir), atau sampaikan terus terang bahwa informasinya akan dibantu tim. Kalau di riwayat percakapan kamu terlanjur pernah mengatakan akan mengecek sesuatu, JANGAN mengulanginya lagi — langsung tanyakan yang kamu butuhkan atau serahkan ke tim. Jangan pernah mengarang harga, stok, atau janji waktu.
Jangan pernah MENAWARKAN potongan harga atau potongan ongkir lebih dulu. Tunggu pelanggan yang memintanya. Kalau pelanggan menawar atau bilang mahal: pertama tawarkan pilihan ekspedisi yang lebih murah, bukan memotong harga. Kalau pelanggan masih keberatan, kamu boleh memberi potongan — TAPI hanya sebesar yang tertulis di dokumen aturan harga & diskon di pengetahuan yang diberikan, dan tidak pernah lebih dari itu. Kalau dokumen itu tidak ada di pengetahuan yang kamu terima, jangan memberi potongan apa pun. Jangan pernah mengarang besaran potongan sendiri, jangan mengklaim sudah memberi diskon sekian persen tanpa dasar, dan jangan menjanjikan akan menegosiasikan apa pun ke kurir, ekspedisi, atau atasan.
Kalau di pengetahuan yang kamu terima ada blok berjudul "HITUNGAN BIAYA COD", itu hasil hitungan sistem, bukan bahan mentah. Pakai angkanya apa adanya. Jangan menghitung persennya sendiri dan jangan membulatkan sendiri.
Jangan memuji mutu atau reputasi yang tidak tertulis di pengetahuan yang diberikan — misalnya "terpercaya", "reputasi baik", "terbaik", "paling cepat". Sebutkan fakta, bukan pujian.
Jangan pernah mengatakan stok kosong, habis, atau tidak tersedia. Toko ini TIDAK punya data stok di sistem, jadi kamu tidak punya dasar untuk itu. Anggap produk yang ada di pengetahuan itu tersedia. Kalau pelanggan menanyakan ketersediaan, jawab bahwa produknya ada dan tawarkan lanjut pesan. SATU-SATUNYA pengecualian: kalau dokumen produk itu sendiri di pengetahuan menyatakan stoknya kosong/habis, barulah sampaikan apa adanya. Riwayat obrolan BUKAN dasar untuk menyatakan stok kosong.
Kalau pelanggan minta melihat foto/gambar produk: dokumen produk di pengetahuan memuat SATU baris penanda lampiran foto (baris yang menyebut kirim-gambar). SALIN baris itu apa adanya ke akhir balasanmu, di baris sendiri. Itu yang membuat fotonya benar-benar terkirim — jadi JANGAN katakan fotonya tidak ada, dan jangan minta pelanggan menunggu, kalau dokumen produknya memuat baris itu.
Baris penanda itu hanya boleh kamu SALIN dari dokumen produk yang benar-benar ada di pengetahuan yang kamu terima. JANGAN PERNAH mengarangnya sendiri, jangan menuliskannya dengan bentuk lain, dan jangan sekali-kali mengisinya dengan alamat web/URL — penanda berisi URL tidak akan mengirim gambar apa pun, yang terjadi cuma pelanggan membaca tulisan aneh di layarnya. Kalau pelanggan tidak menanyakan foto dan tidak ada dokumen produk yang relevan, jangan menulis penanda sama sekali.
Hanya kalau dokumen produk yang diminta memang TIDAK memuat baris penanda itu, sampaikan apa adanya dan tawarkan dibantu tim — jangan menjanjikan foto yang tidak kamu punya.
Jangan menulis nama pembicara di awal balasan. Jangan pernah memulai balasan dengan "AI:", "Pelanggan:", atau nama siapa pun diikuti titik dua. Tulis langsung isi jawabannya.
Balas HANYA satu giliran bicara: jawabanmu sendiri untuk pesan yang baru saja masuk. Jangan mensimulasikan, menuliskan, atau menebak giliran bicara lain sesudahnya -- baik giliranmu sendiri berikutnya maupun giliran pelanggan. Berhenti sesudah satu jawaban selesai.
Jangan menyebutkan varian, ukuran, warna, atau pilihan produk yang tidak disebutkan secara eksplisit di pengetahuan yang diberikan. Kalau dokumen produk hanya menyebutkan satu versi, itu satu-satunya yang ada -- jangan menciptakan pilihan tambahan atau bertanya "mau varian yang mana" kalau tidak ada datanya.
Kalau pelanggan bertanya langsung apakah kamu manusia atau mesin, jawab jujur dengan santai — jangan berbohong.`;
}

/**
 * Hasil generateReply.
 *
 * `knowledgeDocs` ikut dikembalikan supaya Supervisor Layer tidak perlu
 * mengulang pencarian knowledge yang sama. Sejak fix B3, supervisor berjalan
 * pada SETIAP balasan — kalau dia mencari knowledge sendiri, tiap balasan akan
 * menghitung embedding dua kali untuk teks pertanyaan yang persis sama.
 */
export interface GeneratedReply {
  ok: true;
  reply: string;
  knowledgeDocs: string[];
  /**
   * Model yang BENAR-BENAR menghasilkan balasan ini, mis.
   * "llama-3.3-70b-versatile". Kosong kalau balasannya tidak berasal dari model
   * (diambil dari ingatan jawaban, atau pesan cadangan tetap).
   *
   * Dibawa di NILAI BALIK, bukan variabel modul: dua pelanggan bisa dilayani
   * berbarengan, dan variabel modul akan membuat pesan A dilabeli model yang
   * dipakai pesan B — kelas bug yang sama dengan perang socket Fase 43.
   */
  model?: string;
}

/** Kenapa AI memutuskan tidak menjawab. */
export type BlockedReason =
  | 'rate_limited'      // jeda 3 detik antar balasan belum lewat
  | 'consecutive_limit' // 3 balasan beruntun tanpa pelanggan menyahut
  | 'daily_cap'         // kuota harian lead habis
  | 'lead_not_found';

export interface BlockedReply {
  ok: false;
  reason: BlockedReason;
}

export type GenerateReplyResult = GeneratedReply | BlockedReply;

export async function generateReply(
  businessId: string,
  leadId: string,
  messageText: string,
  leadName: string | null,
  businessName: string
): Promise<GenerateReplyResult> {
  // Setiap penolakan di bawah dulu mengembalikan `null` polos, dan pemanggilnya
  // hanya `return` tanpa jejak — bot berhenti melayani pelanggan tanpa ada yang
  // tahu. Sekarang alasannya ikut dikembalikan supaya pemanggil bisa
  // memunculkannya di dashboard, bukan menelannya.
  if (await isReplyRateLimited(leadId)) {
    logger.warn(`Rate limit hit for lead ${leadId}`);
    return { ok: false, reason: 'rate_limited' };
  }

  const consCount = await getConsecutiveCount(leadId);
  if (consCount >= CONSECUTIVE_LIMIT) {
    logger.warn(`Consecutive reply limit hit for lead ${leadId}`);
    return { ok: false, reason: 'consecutive_limit' };
  }

  const lead = await prisma.lead.findUnique({ where: { id: leadId } });
  if (!lead) return { ok: false, reason: 'lead_not_found' };

  // Dulu di sini membaca `lead.dailyAiCount` mentah-mentah, tanpa peduli
  // hitungan itu dari hari kapan — sehingga batas "harian" berlaku seumur hidup.
  // Sekarang lewat helper yang membandingkan tanggalnya dengan hari ini.
  const usedToday = await getTodayAiCount(leadId);
  if (usedToday >= DAILY_CAP) {
    logger.warn(`Daily AI cap reached for lead ${leadId} (${usedToday}/${DAILY_CAP} hari ini)`);
    return { ok: false, reason: 'daily_cap' };
  }

  // Fix C5: leadId sudah didenormalisasi ke tabel messages, jadi konteks bisa
  // diambil tanpa JOIN ke conversations (pakai index [businessId, leadId, createdAt]).
  const recentMessages = await prisma.message.findMany({
    where: { businessId, leadId },
    orderBy: { createdAt: 'desc' },
    take: CONTEXT_LIMIT,
    select: { message: true, fromRole: true },
  });

  const contextMessages = recentMessages
    .reverse()
    .map(m => `${m.fromRole === 'LEAD' ? 'Pelanggan' : 'AI'}: ${m.message}`)
    .join('\n');

  const userName = leadName || 'Pelanggan';

  let knowledgeContext = '';
  let retrievedDocs: string[] = [];
  /**
   * Perintah bertanya, kalau tujuannya ambigu.
   *
   * Ditaruh di pesan sistem TERSENDIRI, bukan diselundupkan ke daftar
   * pengetahuan — lihat catatan panjang di `askInstruction`.
   *
   * ⚠️ Dideklarasikan DI LUAR `try` sejak Fase 85, supaya jalur cadangan di
   * `catch` bisa ikut memakainya. Sebelumnya ia hidup di dalam `try`, dan
   * itulah sebabnya prompt cadangan kehilangan perintah ini — bukan karena
   * ada yang memutuskan begitu, tapi karena ruang lingkupnya kebetulan tidak
   * sampai ke sana. Menyalin nilainya ke variabel kedua akan menghasilkan dua
   * tempat yang harus diubah bersamaan; satu deklarasi, satu tempat.
   */
  let perintahTanya: string | null = null;

  /**
   * ── Prompt balasan disusun SATU KALI, dipakai jalur utama DAN cadangan ──────
   *
   * Ini jawaban struktural atas pertanyaan "gimana supaya fallback ke model
   * MANAPUN tidak buta". Sebelumnya jalur cadangan MENYUSUN ULANG promptnya
   * sendiri, dan salinan kedua itulah sumber masalahnya: Fase 84 menemukan
   * salinan itu kehilangan `Konteks percakapan` dan `perintahTanya`, Fase 85
   * menambalnya dengan penjaga `typeof … !== 'undefined'`, dan penjaga semacam
   * itu adalah tanda bahwa yang menulis tidak yakin apa yang sudah terisi.
   *
   * Menambal salinan kedua tidak menghilangkan salinan keduanya. Selama ada dua
   * tempat yang menyusun prompt, keduanya bisa berbeda lagi di fase berikutnya —
   * dan bedanya cuma terlihat saat jalur utama gagal, yaitu saat paling tidak ada
   * yang memperhatikan. Dengan satu penyusun, "cadangan yang buta" bukan lagi
   * sesuatu yang harus diingat untuk dicegah: ia tidak bisa terjadi.
   *
   * Fungsi, bukan variabel: ia dipanggil SESUDAH `knowledgeContext` dan
   * `perintahTanya` terisi, jadi selalu membaca nilai terbaru — dan tetap benar
   * (cuma lebih ramping) kalau galat terjadi sebelum keduanya terisi.
   */
  const susunPesanBalasan = () => [
    { role: 'system' as const, content: getSystemPrompt(businessName) + knowledgeContext },
    {
      role: 'system' as const,
      // Fase 95 -- rincian di ledger, ringkas di sini: nama pelanggan dipindah
      // ke pesan sistem, dan pesan user TIDAK lagi berlabel "Nama: pesan" (lihat
      // bawah) -- format itu terbukti membuat Gemini melanjutkan transkrip alih-
      // alih menjawab satu giliran. Konteks kosong juga dinyatakan eksplisit,
      // bukan header kosong yang bisa dibaca sebagai ajakan mengisi.
      content: contextMessages
        ? `Nama pelanggan yang sedang kamu layani: ${userName}.\n\nKonteks percakapan sebelumnya:\n${contextMessages}`
        : `Nama pelanggan yang sedang kamu layani: ${userName}. Ini pesan PERTAMA dari pelanggan ini -- belum ada riwayat percakapan sama sekali. Balas pesannya secara langsung sebagai SATU giliran bicara; jangan mensimulasikan atau menuliskan giliran bicara lain (baik milikmu maupun milik pelanggan).`,
    },
    // Ditaruh PALING AKHIR di antara pesan sistem, sesudah aturan umum, supaya
    // terbaca sebagai pengecualian atas aturan itu -- bukan catatan tambahan yang
    // boleh diabaikan (Fase 45).
    ...(perintahTanya ? [{ role: 'system' as const, content: perintahTanya }] : []),
    // Fase 95 -- TIDAK lagi `${userName}: ${messageText}`.
    { role: 'user' as const, content: messageText },
  ];

  /**
   * Buang label pembicara yang bocor di awal balasan — Fase 94.
   *
   * Terpantau 1 Agustus 2026: balasan sampai ke pelanggan berbunyi
   * *"AI: Mohon maaf Kak Fatih…"*. Sebabnya `Konteks percakapan` memakai format
   * `Pelanggan: …` / `AI: …` dan pesan pengguna dikirim sebagai `Nama: pesan`,
   * jadi model melanjutkan pola itu dan melabeli barisnya sendiri.
   *
   * Aturan di prompt sistem sudah melarangnya, tapi larangan prompt itu tidak
   * pernah 100% — dan yang menanggung sisanya pelanggan. Groq 70B tidak pernah
   * melakukan ini; Gemini melakukannya di balasan pertama sesudah `reply` pindah.
   * Perilaku yang berbeda antar model adalah alasan pembersihan ini ada di KODE:
   * ia harus benar tanpa bergantung model mana yang sedang dipakai.
   */
  const bersihkanLabel = (teks: string) =>
    teks.replace(/^\s*(?:AI|Bot|Asisten|CS|Pelanggan|Customer|User)\s*:\s*/i, '').trimStart();

  /** Ukuran prompt, supaya "cadangan buta" jadi TERUKUR, bukan disimpulkan. */
  const ukuranPrompt = (pesan: Array<{ content: string }>) =>
    pesan.reduce((n, m) => n + m.content.length, 0);
  try {
    const { knowledgeService } = await import('./knowledge.service');
    // ── Kueri pencarian diperkaya nama produk yang sedang dibahas ───────────
    // Kueri lama = kalimat pesan apa adanya. Untuk pertanyaan susulan yang tidak
    // menyebut produknya ("berapa harganya kak?"), kueri itu tidak menunjuk apa
    // pun — dan enam potongan teratas dari 54 dokumen produk praktis diundi.
    // Terukur 2 Agustus 2026: dokumen produk yang SEDANG dibahas tidak ikut
    // terambil, lalu Supervisor menahan harga yang sebenarnya benar karena tidak
    // menemukan dasarnya. Alasannya di `utils/konteks-produk.ts`.
    //
    // Hanya riwayat TERAKHIR yang dilihat (bukan seluruh percakapan): pelanggan
    // yang berpindah produk harus mendapat dokumen produk barunya, bukan yang
    // pertama kali ia tanyakan.
    let kueriCari = messageText;
    try {
      const namaProduk = await daftarNamaProduk(businessId);
      if (namaProduk.length > 0 && namaProdukDisebut(messageText, namaProduk).length === 0) {
        const diRiwayat = namaProdukDisebut(contextMessages.slice(-1200), namaProduk);
        if (diRiwayat.length > 0) {
          const dipakai = diRiwayat.slice(0, 2);
          kueriCari = `${dipakai.join(' ')} ${messageText}`;
          logger.info(`[AI] Kueri diperkaya nama produk dari riwayat: ${dipakai.join(', ')}`);
        }
      }
    } catch (err) {
      logger.warn(`[AI] Pengayaan kueri produk dilewati: ${err}`);
    }

    retrievedDocs = await knowledgeService.searchRelevantKnowledge(
      businessId, kueriCari, env.KNOWLEDGE_TOP_K,
    );

    // Batas panjang konteks ditegakkan dalam KARAKTER, bukan jumlah dokumen.
    // Sejak dokumen dipecah jadi potongan, panjang tiap potongan berbeda-beda —
    // "ambil 6 teratas" bisa berarti 2.000 karakter atau 15.000, dan yang kedua
    // langsung menabrak jatah token per menit Groq. Potongan diambil berurutan
    // dari yang paling mirip sampai jatahnya habis.
    const kept: string[] = [];
    let usedChars = 0;
    for (const doc of retrievedDocs) {
      if (usedChars + doc.length > env.KNOWLEDGE_CONTEXT_MAX_CHARS) break;
      kept.push(doc);
      usedChars += doc.length;
    }
    if (kept.length < retrievedDocs.length) {
      logger.info(
        `[AI] Konteks dipangkas: ${kept.length}/${retrievedDocs.length} potongan dipakai ` +
        `(${usedChars} karakter, batas ${env.KNOWLEDGE_CONTEXT_MAX_CHARS})`,
      );
    }
    retrievedDocs = kept;

    // ── Ongkir sungguhan ─────────────────────────────────────────────────────
    // Hasil dari API Mengantar disuntikkan sebagai POTONGAN PENGETAHUAN, bukan
    // diberi izin khusus melewati Supervisor.
    //
    // Bedanya besar: dengan cara ini, waktu Supervisor memeriksa "apakah angka
    // di jawaban ini ada dasarnya di pengetahuan?", tarif dari Mengantar memang
    // sudah ada di sana — lolos dengan sendirinya. Tidak ada pengaman yang
    // dilonggarkan dan tidak ada daftar-putih angka yang harus dipelihara.
    // Kalau API-nya mati, yang terjadi cuma bot kembali tidak tahu ongkir, BUKAN
    // bot yang tiba-tiba boleh menyebut angka tanpa dasar.
    const intent = detectShippingIntent(messageText);
    /** Pertanyaan yang sudah jadi, dipakai kalau balasan model tidak menyampaikannya. */
    let pertanyaanSiap: string | null = null;

    // ── Menyambungkan jawaban pelanggan ke pertanyaan yang tadi diajukan ─────
    // Pencarian ongkir bekerja dari nol tiap pesan, hanya membaca teks pesan itu
    // sendiri. Jadi begitu bot bertanya "Surabayanya provinsi mana ya Kak?",
    // jawaban "lampung" jatuh ke ruang kosong — tidak memuat kata "ongkir" sama
    // sekali, jadi tidak ada yang mengenalinya sebagai jawaban.
    //
    // Ingatan pendek di Redis yang menyambungkannya. Kata yang tadi disebut
    // DIGABUNG dengan jawabannya, bukan diganti: terbukti dari data, "sukamaju"
    // sendirian menunjuk 33 kota sedangkan "sukamaju bogor" menunjuk satu.
    const pending = await getPendingQuestion(leadId);
    let shippingKeyword: string | null = null;
    let shippingWeight: number | null = null;
    let giliranSusulan = false;
    /**
     * Perintah bertanya, kalau tujuannya ambigu.
     *
     * Ditaruh di pesan sistem TERSENDIRI, bukan diselundupkan ke daftar
     * pengetahuan — lihat catatan panjang di `askInstruction`.
     */
    // (dideklarasikan di luar `try` — lihat catatan di sana, Fase 85)
    let wajibSebut: string[] = [];
    /** Pilihan yang sudah dipastikan dari jawaban pelanggan, kalau ada. */
    let pilihanTerpilih: { addressId: string; cityLabel: string; province: string } | null = null;

    if (intent?.destinationKeyword) {
      // Pelanggan menyebut tujuan baru. Pertanyaan lama dibuang — kalau tidak,
      // "ongkir ke medan" sesudah bot menanyakan Surabaya akan dicari sebagai
      // "surabaya medan".
      shippingKeyword = intent.destinationKeyword;
      shippingWeight = intent.weightKg;
      if (pending) await forgetQuestion(leadId);
    } else if (pending && looksLikePlaceAnswer(messageText)) {
      giliranSusulan = true;
      shippingWeight = pending.weightKg;

      // ── Jalur utama: COCOKKAN ke pilihan yang tadi ditawarkan ─────────────
      // Bukan menyusun ulang kata kunci pencarian. Pada giliran ini pilihannya
      // sudah diketahui, jadi tugasnya memilih — dan memilih dari daftar pendek
      // jauh lebih mudah dibuat benar. Versi sebelumnya menyusun kata kunci dan
      // langsung terbukti rapuh: "jawa timur kak." jadi pencarian
      // "surabaya jawa timur kak", yang tentu saja tidak ketemu.
      pilihanTerpilih = matchAnswerToChoice(messageText, pending.choices ?? []);
      if (pilihanTerpilih) {
        logger.info(
          `[AI] "${messageText}" cocok ke pilihan ${pilihanTerpilih.cityLabel}, ` +
          `${pilihanTerpilih.province} — tarif diambil langsung, tanpa cari ulang`,
        );
      } else {
        // Tidak menunjuk tepat satu pilihan (mis. pelanggan menyebut kecamatan
        // yang belum pernah kita tawarkan). Cadangannya: susun kata kunci seperti
        // dulu, tapi kini dengan penyaring kata sapaan yang sama.
        shippingKeyword = combineAnswer(pending.keyword, messageText);
        logger.info(
          `[AI] "${messageText}" tidak menunjuk satu pilihan — dicari sebagai "${shippingKeyword}"`,
        );
      }
    }

    // Pertanyaan ongkir, DALAM ARTI LUAS: termasuk giliran susulan yang kalimatnya
    // tidak menyebut ongkir sama sekali. Dipakai untuk mematikan ingatan jawaban
    // di bawah — "lampung" tidak boleh dijawab dari jawaban lama siapa pun.
    // `lanjutanTarif` belum diketahui di titik ini; ditambahkan di bawah.
    let giliranOngkir = Boolean(intent) || giliranSusulan;

    // ── Tarif untuk pilihan yang sudah dipastikan ───────────────────────────
    // Tidak ada pencarian lokasi di jalur ini: id alamatnya sudah ada, jadi tidak
    // ada lagi kesempatan bagi kata kunci yang salah susun untuk menggagalkan
    // seluruh percakapan.
    if (pilihanTerpilih) {
      try {
        const hasil = await getShippingQuotesForChoice({
          addressId: pilihanTerpilih.addressId,
          cityLabel: pilihanTerpilih.cityLabel,
          province: pilihanTerpilih.province,
          weightKg: shippingWeight,
        });
        await forgetQuestion(leadId);
        if (hasil) {
          const potongan = quotesToKnowledgeChunk(hasil);
          retrievedDocs = [potongan, ...retrievedDocs];
          // Diingat supaya pertanyaan lanjutan ("yang mana yang paling murah")
          // tidak kehilangan angkanya. Lihat catatan di `rememberQuotes`.
          await rememberQuotes(leadId, potongan);
          logger.info(
            `[AI] Ongkir ke ${hasil.destinationLabel} (${hasil.weightKg} kg): ` +
            `${hasil.quotes.length} ekspedisi disuntikkan ke konteks`,
          );
        } else {
          logger.warn(`[AI] Tarif untuk pilihan ${pilihanTerpilih.cityLabel} tidak bisa diambil`);
        }
      } catch (err) {
        logger.warn(`[AI] Pengambilan tarif pilihan gagal, dilewati: ${err}`);
      }
    }

    if (shippingKeyword) {
      try {
        const lookup = await getShippingQuotes({
          destinationKeyword: shippingKeyword,
          weightKg: shippingWeight ?? undefined,
          // Batas SATU pertanyaan. Kalau jawaban pelanggan masih belum
          // menyelesaikan, bot menyerah ke manusia — menanyakan hal yang sama
          // dua kali terasa lebih bodoh daripada mengaku perlu dibantu.
          allowAsk: !giliranSusulan,
        });

        if (lookup && 'ambiguous' in lookup && lookup.ambiguous) {
          // Bukan tarif, melainkan perintah bertanya. Dan bukan sebagai
          // pengetahuan — sebagai perintah, di pesan sistemnya sendiri.
          perintahTanya = askInstruction(lookup);
          wajibSebut = lookup.mustMention;
          pertanyaanSiap = lookup.question;
          await rememberQuestion(leadId, {
            keyword: shippingKeyword,
            weightKg: shippingWeight,
            asked: 1,
            choices: lookup.choices,
          });
          logger.info(`[AI] Tujuan "${shippingKeyword}" ambigu — bot bertanya: ${lookup.question}`);
        } else if (lookup && 'unresolved' in lookup && lookup.unresolved) {
          retrievedDocs = [unresolvedToKnowledgeChunk(lookup), ...retrievedDocs];
          await forgetQuestion(leadId);
          logger.warn(`[AI] Tujuan "${shippingKeyword}" tetap ambigu sesudah ditanya — diserahkan ke manusia`);
        } else if (lookup) {
          const potongan = quotesToKnowledgeChunk(lookup);
          retrievedDocs = [potongan, ...retrievedDocs];
          await rememberQuotes(leadId, potongan);
          await forgetQuestion(leadId);
          logger.info(
            `[AI] Ongkir ke ${lookup.destinationLabel} (${lookup.weightKg} kg): ` +
            `${lookup.quotes.length} ekspedisi disuntikkan ke konteks`,
          );
        } else {
          // Tidak ketemu. Ingatan dibuang supaya pesan berikutnya tidak terus
          // digabung dengan kata kunci yang memang tidak ada di daftar alamat.
          await forgetQuestion(leadId);
          logger.info(`[AI] Ongkir ke "${shippingKeyword}" tidak ketemu — dijawab tanpa angka`);
        }
      } catch (err) {
        // Ongkir itu pelengkap. Kegagalannya tidak boleh menghalangi pelanggan
        // mendapat jawaban.
        logger.warn(`[AI] Pencarian ongkir gagal, dilewati: ${err}`);
      }
    }

    // ── Pertanyaan lanjutan soal tarif yang baru dikutip ────────────────────
    // "pengen yang cepat dan murah" tidak menyebut kota dan tidak menyebut kata
    // "ongkir", jadi pencarian ongkir tidak menyala — dan tanpa bagian ini model
    // menjawab "saya cek dulu ya Kak" untuk angka yang baru saja ia sebutkan
    // sendiri satu pesan sebelumnya. Terpantau 30 Juli 2026 pukul 11:31.
    let lanjutanTarif = false;
    if (!shippingKeyword && !pilihanTerpilih && looksLikeQuoteFollowUp(messageText)) {
      const tersimpan = await getRememberedQuotes(leadId);
      if (tersimpan) {
        retrievedDocs = [tersimpan, ...retrievedDocs];
        lanjutanTarif = true;
        logger.info('[AI] Pertanyaan lanjutan soal ongkir — tarif yang tadi dikutip disuntikkan kembali');
      }
    }

    // ── Biaya COD dihitung di KODE, bukan oleh model ─────────────────────────
    // Alasan lengkapnya di `utils/biaya-cod.ts`. Ringkasnya: aturannya sudah ada
    // di vault lengkap dengan dua contoh, dan model tetap menjawab 3% dari
    // 139.000 = 4.170 — persennya benar, pembulatan ke bawah ke ribuan tidak
    // dikerjakan. Menambah kalimat perintah lagi di prompt tidak mengubah itu;
    // aritmetika memang bukan yang dikerjakan model bahasa dengan andal.
    //
    // Cara suntikannya SAMA PERSIS dengan tarif ongkir: sebagai potongan
    // pengetahuan biasa, bukan izin khusus melewati Supervisor. Jadi waktu
    // Supervisor memeriksa "apakah angka ini ada dasarnya di pengetahuan?",
    // angkanya memang sudah ada di sana.
    // Niat dibaca dari PERCAKAPAN saja — dokumen aturan COD hampir selalu ikut
    // terambil, jadi kalau niat dibaca dari dokumen, blok ini menyala terus.
    // Angkanya justru sebaliknya: sebagian besar ada di dokumen (harga produk,
    // tarif ongkir), bukan di kalimat pelanggan.
    const percakapanCod = `${contextMessages}\n${messageText}`;
    if (adaNiatCod(percakapanCod)) {
      const hitunganCod = potonganHitunganCod([
        ...kumpulkanNominal(percakapanCod),
        ...nominalDariDokumen(retrievedDocs),
      ]);
      if (hitunganCod) {
        retrievedDocs = [hitunganCod, ...retrievedDocs];
        logger.info('[AI] Hitungan biaya COD disuntikkan (dihitung di kode, bukan oleh model)');
      }
    }

    knowledgeContext = retrievedDocs.length > 0
      ? `\n\nPengetahuan Bisnis Tambahan:\n${retrievedDocs.join('\n---\n')}\nGunakan informasi di atas untuk menjawab pertanyaan pelanggan jika relevan.`
      : '';

    // ── Ingatan jawaban ──────────────────────────────────────────────────────
    // Diperiksa SESUDAH pengetahuan diambil, bukan sebelumnya. Dua alasan:
    // dokumen yang terambil tetap dibutuhkan Supervisor untuk memeriksa jawaban
    // yang dikirim, dan pencarian pgvector itu murah sedangkan panggilan Groq
    // yang mahal — jadi tidak ada yang terbuang dengan urutan ini.
    // Pertanyaan ongkir TIDAK PERNAH dijawab dari ingatan. Tarifnya bergantung
    // pada kota tujuan yang berbeda tiap pelanggan, dan dua pertanyaan yang
    // kalimatnya nyaris sama ("ongkir ke Bandung" vs "ongkir ke Bandar Lampung")
    // bisa berjarak sangat dekat di ruang makna. Menyajikan tarif kota lain
    // adalah kesalahan yang langsung merugikan.
    // Pertanyaan lanjutan tarif juga tidak boleh dijawab dari ingatan: "yang
    // paling murah" jawabannya bergantung pada kota tujuan pelanggan ini.
    giliranOngkir = giliranOngkir || lanjutanTarif;
    const cached = giliranOngkir ? null : await lookupCachedAnswer(businessId, messageText);
    if (cached) {
      await markReplied(leadId);
      await incrementConsecutive(leadId);
      return { ok: true, reply: cached, knowledgeDocs: retrievedDocs };
    }
    // Model, max_tokens, dan suhu kini ditentukan oleh job 'reply' di llm.ts.
    // Urutan pesan sistem TETAP di sini karena urutannya bermakna (lihat catatan
    // di bawah) — llm.ts meneruskan array pesan apa adanya, tidak menyusun ulang.
    let modelDipakai: string | undefined;
    const pesanBalasan = susunPesanBalasan();
    logger.info(`[AI] prompt balasan ${ukuranPrompt(pesanBalasan)} char (${pesanBalasan.length} pesan, pengetahuan ${knowledgeContext.length} char)`);
    const completion = await complete('reply', {
      businessId,
      correlationId: leadId,
      messages: pesanBalasan,
    });
    modelDipakai = completion.model;

    let reply: string | undefined = completion.text ? bersihkanLabel(completion.text) : completion.text;
    if (!reply || reply.trim().length === 0) {
      // Kalau tujuannya ambigu, pertanyaan yang sudah jadi jauh lebih berguna
      // daripada balasan cadangan yang tidak menanyakan apa pun.
      if (pertanyaanSiap) {
        await markReplied(leadId);
        await incrementConsecutive(leadId);
        return { ok: true, reply: pertanyaanSiap, knowledgeDocs: retrievedDocs };
      }
      return { ok: true, reply: fallbackReply(), knowledgeDocs: retrievedDocs };
    }

    // ── Periksa: pertanyaannya benar-benar tersampaikan? ─────────────────────
    // Perintah di pesan sistem membuat kepatuhan JAUH lebih mungkin, tapi tetap
    // tidak pasti — dan kegagalannya di sini tidak sepele. Pelanggan yang
    // ditinggal dengan "nanti dikabari" umumnya tidak menunggu; dia pergi.
    //
    // Kecocokan persis TIDAK diharuskan: model boleh menyusun kalimatnya sendiri,
    // asalkan pilihannya benar-benar disebut. Yang diperiksa cuma itu.
    if (pertanyaanSiap && !questionDelivered(reply, wajibSebut)) {
      logger.warn(
        `[AI] Balasan model TIDAK menyampaikan pertanyaan tujuan — diganti ` +
        `pertanyaan yang sudah disusun. Balasan yang dibuang: "${reply.slice(0, 120)}"`,
      );
      reply = pertanyaanSiap;
    }

    await markReplied(leadId);
    await incrementConsecutive(leadId);

    // Fase 91 — rememberAnswer() TIDAK lagi dipanggil di sini. Balasan ini baru
    // draft; Supervisor belum menilainya. Menyimpannya sekarang berarti balasan
    // yang HALUSINASI pun bisa terlanjur masuk ingatan sebelum sempat ditolak —
    // persis insiden "Purwokerto": jawaban lama tersimpan lolos ke pelanggan lain
    // tanpa pernah lewat Supervisor lagi. Penyimpanan dipindah ke
    // ai-reply.worker.ts, sesudah supervisorValidate() memberi keputusan, dan
    // digerbangi oleh approved (bukan lagi oleh dugaan intent `giliranOngkir` di
    // sini). Pengaman isi-jawaban (klaim harga/ongkir) sekarang ada di dalam
    // isReusable() sendiri — lihat answer-cache.service.ts.

    // ── NOTE (audit A1): dailyAiCount TIDAK di-increment di sini ──────────────
    // Sudah di-increment di message.service.ts:enqueueAiReply() sebelum job masuk
    // queue. Jika di-increment lagi di sini → double-count (+2 per reply).
    // Increment hanya di message.service.ts, bukan di sini.
    // ──────────────────────────────────────────────────────────────────────────

    return { ok: true, reply: reply.trim(), knowledgeDocs: retrievedDocs, model: modelDipakai };
  } catch (error: any) {
    logger.error(`Groq API error: ${error.message}`);

    try {
      // ── Prompt cadangan MEMAKAI PENYUSUN YANG SAMA — Fase 93 ───────────────
      // Fase 85 menambal salinan kedua; Fase 93 menghapus salinan keduanya.
      // Lihat catatan di `susunPesanBalasan` untuk alasannya.
      // Sampai Fase 84 jalur ini cuma mengirim prompt sistem + pesan pengguna:
      // `Konteks percakapan` dan `perintahTanya` HILANG. Jadi kalau jalur utama
      // gagal, pelanggan bukan cuma dijawab model lain — ia dijawab model yang
      // TIDAK TAHU apa yang sudah dibicarakan, dan tidak tahu bahwa ia
      // seharusnya balik bertanya kalau maksudnya ambigu.
      //
      // Dulu itu dicatat sebagai temuan dan sengaja dibiarkan karena jalur ini
      // praktis mati (`GROQ_FALLBACK_MODEL` menunjuk `mixtral-8x7b-32768` yang
      // sudah dipensiunkan Groq). Fase 84 mengubahnya: `fallback` kini di Gemini
      // dan **benar-benar dipakai** — terbukti 31 Juli, jatah harian 70B habis
      // lalu jalur ini yang menjawab pelanggan. Sesuatu yang dipakai tidak boleh
      // dibiarkan setengah jadi.
      //
      // Urutan pesannya SENGAJA identik dengan jalur utama, termasuk
      // `perintahTanya` di posisi PALING AKHIR di antara pesan sistem (alasannya
      // di catatan jalur utama, Fase 45): ia harus terbaca sebagai pengecualian
      // atas aturan di atasnya, bukan catatan tambahan yang boleh diabaikan.
      const pesanCadangan = susunPesanBalasan();
      logger.warn(
        `[AI] Jalur cadangan dipakai — prompt ${ukuranPrompt(pesanCadangan)} char ` +
          `(${pesanCadangan.length} pesan, pengetahuan ${knowledgeContext.length} char). ` +
          `Kalau angka pengetahuan 0 padahal pertanyaannya soal produk, itu masalah pencarian ` +
          `pengetahuan — BUKAN masalah jalur cadangan.`,
      );
      const fallbackCompletion = await complete('fallback', {
        businessId,
        correlationId: leadId,
        messages: pesanCadangan,
      });
      const reply: string | undefined = fallbackCompletion.text
        ? bersihkanLabel(fallbackCompletion.text)
        : fallbackCompletion.text;
      return {
        ok: true, reply: reply?.trim() || fallbackReply(),
        knowledgeDocs: retrievedDocs, model: fallbackCompletion.model,
      };
    } catch {
      return { ok: true, reply: fallbackReply(), knowledgeDocs: retrievedDocs };
    }
  }
}

function fallbackReply(): string {
  return 'Maaf sedang sibuk, akan dijawab sales kami segera.';
}

export async function detectIntent(_businessId: string, _leadId: string, messageText: string): Promise<{
  intent: string;
  score: number;
}> {
  try {
    // response_format json_object dipasang oleh JobConfig 'intent' di llm.ts
    // (Fix B2: paksa JSON agar JSON.parse tidak crash).
    const completion = await complete('intent', {
      businessId: _businessId,
      correlationId: _leadId,
      messages: [
        {
          role: 'system',
          content: `Klasifikasikan intent pesan customer berikut ke dalam satu kategori: minat, tanya_harga, komplain, spam, atau unknown. Berikan skor 0-100 berdasarkan engagement. Respon dalam format JSON: {"intent": "kategori", "score": angka}`,
        },
        { role: 'user', content: messageText },
      ],
    });

    const content = completion.text || '{}';
    let parsed: { intent?: string; score?: number } = {};
    try { parsed = JSON.parse(content); } catch { /* fallback ke default */ }

    return {
      intent: parsed.intent || 'unknown',
      score: Math.min(100, Math.max(0, Number(parsed.score) || 0)),
    };
  } catch {
    return { intent: 'unknown', score: 0 };
  }
}
