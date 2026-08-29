"use strict";
/**
 * Session Boundary & Role Normalizer Parser.
 * Membagi aliran chat mentah WhatsApp menjadi sesi-sesi transaksi terisolasi
 * dan menormalisasi peran pengirim (CS vs Pembeli).
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.SessionBoundaryParser = void 0;
var SessionBoundaryParser = /** @class */ (function () {
    function SessionBoundaryParser() {
    }
    /**
     * Langkah C Kelompok 2 (Dual-View, 2026-08-18): format SATU baris buffer live Baileys,
     * dipakai bareng oleh sisi TULIS (`human-learning.service.ts::appendToBuffer`) dan sisi BACA
     * (`parseLines()` di bawah) supaya kedua sisi tidak pernah drift satu sama lain.
     *
     * `timestampMs` opsional & SENGAJA taruh di dalam kurung siku setelah role (mis. "[CS
     * 1755500000000]") -- kalau tidak disediakan, hasilnya identik dengan format lama "[CS] teks"
     * supaya baris lama yang sudah kadung ada di Redis (TTL s/d 72 jam) tetap valid dibaca selama
     * masa transisi, tidak mendadak rusak begitu kode baru di-deploy.
     */
    SessionBoundaryParser.formatBufferLine = function (role, text, timestampMs) {
        var cleanText = (text || '').replace(/\n/g, ' ');
        return timestampMs ? "[".concat(role, " ").concat(timestampMs, "] ").concat(cleanText) : "[".concat(role, "] ").concat(cleanText);
    };
    /**
     * Cek apakah transkrip memiliki tanda formulir landing page resmi (inbound form).
     * Hanya mencocokkan format pesan pengisian formulir pembeli, BUKAN rincian biaya/total COD dari CS.
     */
    SessionBoundaryParser.isTrueFormInbound = function (transcript) {
        if (!transcript)
            return false;
        return (/-\s*(?:Fb|Goo[A-Za-z0-9]*|TT|Ad|NPM|NFR)\s*-?/i.test(transcript) ||
            /Halo,\s*saya\s*sudah\s*melakukan\s*pemesanan/i.test(transcript) ||
            /saya\s+sudah\s+melakukan\s+pemesanan|atas\s+nama\s*[\w\s]+,|mohon\s+segera\s+diproses\s+ya/i.test(transcript) ||
            /Terima\s+kasih\s+sudah\s+mengisi\s+form\s+pemesanan/i.test(transcript) ||
            /form\s+pemesanan\s+([^\n\r!]+?)\s+di\s+toko\s+kami/i.test(transcript) ||
            /Formulir\s+Pemesanan/i.test(transcript) ||
            /cdv\.form\.id|app\.formulir\.com|orderonline/i.test(transcript));
    };
    /**
     * Cek apakah teks BUYER (buyerOnlyText, atau seluruh transcript kalau tidak disediakan)
     * menunjukkan sinyal NEGATIF yang harus memblokir closing deterministik -- keraguan/pembatalan
     * (recency-aware, hanya 3 pesan buyer TERAKHIR) ATAU sinyal purna jual/komplain (scan seluruh
     * teks). Diekstrak jadi method PUBLIK terpisah dari `isDeterministicClosing()` (Tahap 5
     * lanjutan, 2026-08-18, blind-test 80 chat admin) supaya bisa dipakai ULANG oleh fallback
     * cross-session closing di `lead-profiler.service.ts::computeClosingAndAfterSalesSignals()`
     * tanpa duplikasi regex manual (duplikasi = resiko drift dua tempat kalau salah satu diubah).
     * Perilaku IDENTIK dgn logika lama, cuma direlokasi.
     */
    SessionBoundaryParser.hasNegativeClosingSignal = function (exclusionText) {
        if (!exclusionText)
            return false;
        return this.hasHesitationSignal(exclusionText) || this.hasHardBlockClosingSignal(exclusionText);
    };
    /**
     * Sinyal keraguan/pembatalan dari PEMBELI (recency-aware, 3 pesan buyer TERAKHIR saja).
     * Diekstrak jadi method TERPISAH dari sinyal hard-block (Fase 30-lanjutan, 2026-08-18,
     * fix "GSM - Rohuan Shopee") supaya `isDeterministicClosing()` bisa membedakan: sinyal ini
     * (hesitation) BOLEH di-override kalau transkrip belakangan mencapai template penutup genuine
     * (artinya keraguan itu SUDAH dibujuk-balik/diselesaikan CS), sedangkan sinyal hard-block
     * (garansi/komplain/pindah-kanal, lihat `hasHardBlockClosingSignal`) TIDAK BOLEH di-override
     * apapun yang terjadi belakangan -- itu representasi kegagalan/keluar-cakupan yang permanen.
     */
    SessionBoundaryParser.hasHesitationSignal = function (exclusionText) {
        if (!exclusionText)
            return false;
        // Tahap 5 (2026-08-18, temuan investigasi manual 11 closing-miss dataset forensik 17
        // Agustus, wa 6282372455445): exclusion "hasHesitation" sebelumnya nyisir SELURUH pesan
        // buyer dlm satu sesi -- kalau buyer sempat ragu ("cancel dulu") di AWAL sesi lalu BERUBAH
        // PIKIRAN dan closing beneran belakangan di sesi yang SAMA, closing itu PERMANEN gagal
        // terkunci deterministik krn kata "cancel" tetap ketemu di scan seluruh sesi. Sekarang
        // hesitation HANYA dicek dari 3 pesan buyer TERAKHIR (recency-aware) -- keraguan yang sudah
        // dilewati/dibujuk-balik CS tidak lagi menghantui closing yang genuine terjadi belakangan.
        var recentBuyerLines = exclusionText
            .split('\n')
            .map(function (l) { return l.trim(); })
            .filter(Boolean)
            .slice(-3)
            .join('\n');
        // Jangan tandai closing jika ada sinyal keraguan/penolakan kuat dari PEMBELI (recency-aware)
        return /(tanya\s+(?:mama|ibu|istri|suami|bapak|ortu|orang\s*tua)|minta\s+izin|izin\s+dulu|pikir\s+dulu|nanti\s+dulu|belum\s+ada\s+uang|belum\s+gajian|kemahalan|gak\s+jadi|nggak\s+jadi|batal|cancel)/i.test(recentBuyerLines);
    };
    /**
     * Sinyal HARD-BLOCK yang TIDAK BOLEH di-override apapun yang terjadi belakangan di transkrip
     * (beda dgn `hasHesitationSignal` di atas yang overridable) -- purna jual/komplain eksplisit
     * ATAU pindah kanal ke marketplace lain. "isAfterSalesChat" di bawah SENGAJA TIDAK diubah
     * scope-nya dari versi lama -- bukan bagian dari temuan Fase 30-lanjutan, ubah tanpa bukti =
     * resiko regresi percuma.
     */
    SessionBoundaryParser.hasHardBlockClosingSignal = function (exclusionText) {
        if (!exclusionText)
            return false;
        // Jangan tandai closing jika PEMBELI mengirim sinyal purna jual (komplain / klaim garansi
        // eksplisit). CATATAN: "terima kasih banyak atas kepercayaannya" SENGAJA dihapus dari sini
        // — frasa itu adalah template CS DEAL_CONFIRMED (item 10), bukan sinyal purna jual pembeli.
        //
        // Ronde Penyanggal Langkah A (2026-08-18, TERBUKTI TAPI DILEBIH-LEBIHKAN — celah nyata
        // tapi lebih sempit dari klaim awal): sebelumnya exclusion ini cuma mengenali kata seputar
        // resi/status pengiriman, TIDAK mengenali klaim garansi/defect yang EKSPLISIT & tidak
        // ambigu ("komplain", "klaim garansi", "mau retur", "proses retur", "tukar baru").
        // SENGAJA TIDAK memakai kata lepas seperti "rusak"/"cacat"/"pecah" saja (beda dengan
        // isAfterSalesWarrantyStr di lead-profiler.service.ts yang dipakai utk klasifikasi, bukan
        // exclusion) — kata lepas itu juga muncul di obrolan nostalgia yang TIDAK actionable (mis.
        // "punya saya yang lama sempet rusak dikit tapi ga masalah, tetep saya pake terus") dan
        // kalau dipakai di sini malah mematahkan closing asli yang jadi target utama Temuan 3.1.
        //
        // Tahap 5 lanjutan (2026-08-18, blind-test 80 chat admin: wa Muhammad Fauzi & GSM - Yudi
        // Tf, 2/10 sisa miss): kata "resi"/"status pengiriman"/"kapan sampai"/"belum sampai"/
        // "sudah diterima" DIHAPUS dari exclusion ini -- kata-kata itu cuma INFORMASIONAL (nanya
        // nomor resi, forward notifikasi kurir, atau bilang paket sudah nyampe) dan tidak berarti
        // deal batal/gagal. Bukti nyata: (1) Yudi Tf minta "tolong kirim resinya" SETELAH bukti
        // transfer terkirim -- closing tetap sah cuma diblokir gara² kata "resi" lepas; (2)
        // Muhammad Fauzi forward notifikasi J&T Express (mengandung "nomor resi") ke chat CS
        // setelah closing sesi sebelumnya -- exclusion ini ikut memblokir fallback cross-session
        // (lihat computeClosingAndAfterSalesSignals di lead-profiler.service.ts). Exclusion INI
        // (dipakai utk membatalkan sinyal closing POSITIF yang SUDAH ketemu) beda tujuan dgn
        // isAfterSalesResi di lead-profiler.service.ts (dipakai utk KLASIFIKASI/routing jika TIDAK
        // ada sinyal closing positif sama sekali) -- resi/status kirim TETAP jadi sinyal
        // AFTER_SALES_RESI yang sah di sana, cuma TIDAK LAGI membatalkan closing yang sudah solid.
        // Kata purna jual yang TERSISA di sini semua eksplisit soal KOMPLAIN/GARANSI (bukan
        // netral/informasional), jadi resiko regresi rendah -- diverifikasi lewat 46 test regresi +
        // uji blind 80 chat admin.
        var isAfterSalesChat = /(komplain|klaim\s+garansi|mau\s+retur|proses\s+retur|tukar\s+baru)/i.test(exclusionText);
        // Problem B audit (2026-08-18, wa 6281263480110, admin konfirmasi FALSE POSITIF): buyer
        // sempat setuju COD (memicu sinyal positif "sesuai rincian diatas...cod" di bawah), TAPI
        // belakangan eksplisit bilang mau pesan/pindah lewat marketplace lain ("Tiktok Shopee boleh
        // nggak kak?"), lalu CS sendiri membalas "kalau dari shopee bapak pesan sendiri pak" --
        // artinya deal WA-native ini SENDIRI tidak pernah selesai (closing-nya, kalaupun terjadi,
        // pindah ke platform lain di luar cakupan sistem ini). Pola SAMA jg jadi akar 1 miss yg
        // SUDAH diketahui & sengaja tidak dipaksa-fix dari blind-test 80 chat admin ("GSM - Rohuan
        // Shopee"). Diverifikasi AMAN thd 4 chat CLOSING lain di dataset yang kontak/link-nya
        // kebetulan menyinggung kata "Shopee" (nama kontak asal tag iklan "... Shopee", atau CS
        // sendiri menawarkan link toko Shopee resmi mereka) -- keempatnya TIDAK match pattern ini krn
        // kata "shopee"/"tiktok shop" di sana muncul di NAMA KONTAK atau TEKS CS, bukan di
        // `exclusionText` (= buyerOnlyText, teks BUYER sendiri saja).
        var hasChannelPivotSignal = /shopee|tiktok\s*shop/i.test(exclusionText);
        return isAfterSalesChat || hasChannelPivotSignal;
    };
    /**
     * Cek apakah transkrip (CS+buyer, bukan buyer-only) SUDAH mencapai template penutup CS yang
     * genuine di titik MANAPUN -- dipakai sbg bukti order beneran selesai/diproses, dipakai ULANG
     * (Fase 30-lanjutan, 2026-08-18, fix "GSM - Rohuan Shopee") oleh 2 tempat: (a)
     * `hasUnansweredLogisticsStall` (order stall alamat TAPI akhirnya sampai penutup = bukan stall),
     * dan (b) `isDeterministicClosing` (keraguan buyer di awal/tengah TAPI akhirnya sampai penutup
     * genuine = keraguan itu sudah dibujuk-balik/diselesaikan, bukan pembatalan permanen).
     */
    SessionBoundaryParser.reachedTerminalWrapupTemplate = function (transcript) {
        if (!transcript)
            return false;
        return (/CATATAN[\s\S]*?Pastikan\s+hp\s*\*?\s*Selalu\s+Aktif/i.test(transcript) ||
            /PERATURAN\s+CHECKOUT[\s\S]*?COD\s*=\s*bayar\s*cash/i.test(transcript) ||
            /akan\s+langsung\s+kami\s+proses|pesanan\s+(?:kakak|bapak|ibu|anda)?\s*segera\s+kami\s+proses/i.test(transcript));
    };
    /**
     * Cek apakah sinyal hesitation (buyer sempat bilang "batal"/"cancel"/dst) SUDAH diselesaikan
     * oleh template penutup genuine yang muncul BELAKANGAN -- posisi-aware, bukan cuma cek
     * keberadaan template penutup di MANAPUN di transkrip. Ini penting: kalau template penutup
     * (mis. "CATATAN...Pastikan hp Selalu Aktif") muncul SEBELUM keraguan/pembatalan buyer, itu
     * bukan bukti keraguannya sudah diselesaikan -- itu buyer yang BATAL SETELAH closing sempat mau
     * diproses (deal genuine gagal). Override CUMA berlaku kalau template penutup ketemu SETELAH
     * baris hesitation buyer yang paling baru. Fail-safe: kalau baris hesitation tidak ketemu
     * posisinya di transkrip (harusnya tidak pernah terjadi kalau dipanggil setelah
     * `hasHesitationSignal` true), override TIDAK berlaku (closing tetap diblokir) -- lebih aman
     * salah nge-block drpd salah nge-loloskan.
     */
    SessionBoundaryParser.hesitationResolvedByLaterWrapup = function (transcript, exclusionText) {
        if (!transcript || !exclusionText)
            return false;
        var recentBuyerLines = exclusionText
            .split('\n')
            .map(function (l) { return l.trim(); })
            .filter(Boolean)
            .slice(-3);
        var hesitationRegex = /(tanya\s+(?:mama|ibu|istri|suami|bapak|ortu|orang\s*tua)|minta\s+izin|izin\s+dulu|pikir\s+dulu|nanti\s+dulu|belum\s+ada\s+uang|belum\s+gajian|kemahalan|gak\s+jadi|nggak\s+jadi|batal|cancel)/i;
        // Cari baris hesitation PALING BARU (dari belakang) di antara 3 baris buyer terakhir --
        // itulah "titik keraguan" yang perlu dibuktikan sudah diselesaikan belakangan.
        var anchorLine = null;
        for (var i = recentBuyerLines.length - 1; i >= 0; i--) {
            if (hesitationRegex.test(recentBuyerLines[i])) {
                anchorLine = recentBuyerLines[i];
                break;
            }
        }
        if (!anchorLine)
            return false;
        var anchorIndex = transcript.lastIndexOf(anchorLine);
        if (anchorIndex === -1)
            return false;
        var afterAnchor = transcript.slice(anchorIndex + anchorLine.length);
        return this.reachedTerminalWrapupTemplate(afterAnchor);
    };
    SessionBoundaryParser.hasUnansweredLogisticsStall = function (transcript) {
        if (!transcript)
            return false;
        var askPattern = new RegExp(this.REPEATED_UNANSWERED_ADDRESS_ASK_PATTERN.source, 'gi');
        var asks = transcript.match(askPattern) || [];
        if (asks.length < 2)
            return false; // CS nanya SEKALI itu wajar (bagian pola transfer yg sah).
        // Kalau transkrip SUDAH sampai template penutup di titik manapun, order-nya SELESAI walau
        // sempat nanya alamat berulang di tengah (mis. buyer sempat lambat jawab tapi akhirnya jawab
        // & closing beneran terjadi) -- jangan diblokir, itu bukan stall.
        return !this.reachedTerminalWrapupTemplate(transcript);
    };
    /**
     * Cek apakah transkrip memiliki konfirmasi closing transaksi sah.
     *
     * @param transcript   - Teks penuh sesi aktif (CS + Buyer), dipakai untuk deteksi sinyal closing positif.
     * @param buyerOnlyText - Teks pesan BUYER saja (opsional). Jika disediakan, dipakai untuk cek
     *                        exclusion (ragu-ragu / purna jual) agar template CS tidak memblokir closing.
     */
    SessionBoundaryParser.isDeterministicClosing = function (transcript, buyerOnlyText) {
        if (!transcript)
            return false;
        // Gunakan buyer-only text untuk exclusion agar template CS tidak memicu false-block.
        // Contoh: "resi akan segera kami informasikan" dari CS TIDAK boleh memblokir closing.
        var exclusionText = buyerOnlyText !== null && buyerOnlyText !== void 0 ? buyerOnlyText : transcript;
        // Fase 37 (2026-08-19, temuan lanjutan audit gap dashboard, wa 6285841546264 -- dikonfirmasi
        // Bossfren via export chat WhatsApp ASLI dari awal sampai akhir sesi): kalau buyer TIDAK PERNAH
        // kirim SATU PESAN PUN di sesi aktif ini, closing TIDAK BOLEH terkunci deterministik apa pun
        // sinyal positif lain yang ketemu di bawah -- sebagian sinyal positif itu murni template CS
        // (mis. "RINCIAN BIAYA...sesuai rincian diatas...yaa", "CATATAN...Pastikan hp Selalu Aktif",
        // "PERATURAN CHECKOUT...COD=bayar cash") yang bisa terkirim CS secara proaktif/berurutan tanpa
        // pernah menunggu balasan buyer sama sekali. Bukti nyata wa 6285841546264: CS kirim salam+form
        // konfirmasi, gambar produk, rincian biaya, lalu kalimat penutup "Baik pak, sesuai rincian
        // diatas cod/bayar ditempat 191.000 yaa" -- SEMUA monolog CS, nol balasan buyer di seluruh
        // riwayat chat -- sebelum fix ini closing tetap salah terkunci (score 95, DEAL_CONFIRMED).
        // Gerbang ini SENGAJA ditaruh di awal (sebelum exclusion/sinyal lain manapun) supaya berlaku
        // ke SEMUA jalur closing deterministik tanpa kecuali, dan TIDAK menyentuh regex sinyal positif
        // yang sudah di-tuning ketat lewat blind-test 80 chat admin (risiko regresi presisi existing
        // rendah -- setiap closing genuine di dataset itu pasti punya minimal 1 balasan buyer).
        if (!exclusionText || !exclusionText.trim())
            return false;
        // Fase 30-lanjutan (2026-08-18, blind-test 80 chat admin, 1 miss sisa: "GSM - Rohuan
        // Shopee"): sinyal HARD-BLOCK (garansi/komplain/pindah-kanal) tetap memblokir closing TANPA
        // SYARAT, persis perilaku lama -- kegagalan/keluar-cakupan yang direpresentasikannya bersifat
        // permanen, tidak relevan apapun yang terjadi belakangan di transkrip.
        if (this.hasHardBlockClosingSignal(exclusionText))
            return false;
        // Sinyal HESITATION (buyer sempat bilang "batal"/"cancel"/dst di 3 pesan TERAKHIRnya) BEDA
        // perlakuan -- dicek TAPI belum langsung mem-block di sini. Bukti nyata wa "GSM - Rohuan
        // Shopee": buyer bilang "kami batal ya beli sampean" (nyalakan hasHesitation), TAPI CS
        // membalas "Baik pak, jadinya di shopee ya" -> buyer "iya" -> CS kirim template penutup
        // genuine ("...akan langsung kami proses untuk paketan nyaa") -- toko sendiri menganggap
        // order ini SELESAI (dipindah-proses via kanal lain yang tetap dihitung closing oleh admin),
        // bukan pembatalan murni. Override HANYA berlaku kalau transkrip belakangan benar-benar
        // mencapai template penutup genuine (`reachedTerminalWrapupTemplate`) -- kalau TIDAK PERNAH
        // sampai penutup, hesitation ini tetap memblokir closing spt biasa (lihat guard di bawah,
        // setelah sinyal positif dicek). Diverifikasi AMAN thd seluruh dataset blind-test 80 chat
        // admin: 0/40 chat TIDAK CLOSING punya kata keraguan + template penutup co-occur sekaligus;
        // dari 40 chat CLOSING cuma 2 yang punya kata keraguan sama sekali (Rohuan = target fix ini;
        // "GKe - cucup supriyadi" = kata "cancel"-nya cuma muncul di teks CS, bukan buyerOnlyText,
        // jadi tidak kena exclusion ini sama sekali baik sebelum maupun sesudah fix).
        var hasHesitation = this.hasHesitationSignal(exclusionText);
        var hasPositiveClosingSignal = (/akan\s+langsung\s+kami\s+proses|pesanan\s+(?:kakak|bapak|ibu|anda)?\s*segera\s+kami\s+proses/i.test(transcript) ||
            // Tahap 5 lanjutan (2026-08-18, blind-test 80 chat admin: 5/10 sisa miss -- Masrifai
            // A.Rifa'i, BB - Ahmad Sapuan, Damaskus - Hendra Sidik, Damaskus - Mama Ayuk, Damaskus -
            // I Made Lantika, semua admin ITA): regex lama WAJIB whitespace polos antara "hp" dan
            // "Selalu Aktif" ("Pastikan\s+hp\s+Selalu\s+Aktif"), padahal template admin ITA/Cs Adisa
            // Tiaa menebalkan hurufnya via markdown WA persis di titik itu -- "Pastikan hp *Selalu
            // Aktif* selama..." -- karakter "*" (bukan whitespace) nyempil antara "hp" dan "Selalu"
            // sehingga regex GAGAL total (24 file dataset mengandung "Pastikan hp", 6/24 pakai
            // varian bertanda-bintang ini, SEMUANYA gagal cocok dgn regex lama). Fix: sisipkan
            // `\s*\*?\s*` (asterisk opsional) di titik itu -- tetap cocok dgn varian lama (tanpa
            // asterisk) krn `\*?` opsional, TIDAK memperlonggar syarat lain.
            /CATATAN[\s\S]*?Pastikan\s+hp\s*\*?\s*Selalu\s+Aktif/i.test(transcript) ||
            // Tahap 5 lanjutan (2026-08-18, blind-test 80 chat admin: wa MUHAMMAD FAUZI & widi
            // setyawan, admin ANNISA): template alternatif "PERATURAN CHECKOUT" (persis sekali
            // dipakai konsisten di 9 file CLOSING admin ANNISA, 0 kecocokan di 40 file TIDAK
            // CLOSING) -- fungsinya SAMA dgn template "CATATAN...Pastikan hp Selalu Aktif" di atas:
            // pesan CS penutup berisi aturan pengiriman, dikirim HANYA setelah buyer eksplisit
            // setuju COD/transfer. "COD = bayar cash langsung ke kurir" dipakai sbg jangkar supaya
            // tidak match template CS lain yang kebetulan mengandung kata "PERATURAN" tanpa konteks
            // checkout COD yang sama.
            /PERATURAN\s+CHECKOUT[\s\S]*?COD\s*=\s*bayar\s*cash/i.test(transcript) ||
            // Tahap 5 (2026-08-18, temuan wa 6283856233276): tambah "sesuai rincian di(atas)" -- variasi
            // frasa konfirmasi CS yang umum dipakai ("Baik pak, sesuai rincian diatas cod/bayar
            // ditempat 249.000 yaa") tapi sebelumnya tidak tercakup regex lama (butuh "sudah sesuai"
            // persis, bukan "sesuai ... diatas").
            /(?:TOTAL\s+COD|RINCIAN\s+BIAYA)[\s\S]*?(?:sudah\s+benar|sudah\s+sesuai|sesuai\s+rincian\s+di\s*atas|fix\s+kirim|bungkus\s+kak|bungkus\s+mas|proses\s+sekarang|kirim\s+sekarang)/i.test(transcript) ||
            // Tahap 5 lanjutan (2026-08-18, blind-test 80 chat admin: wa dgn Gunawan 110826 & Muhammad
            // Irfan Zidny -- 2/23 closing-miss): closing via TRANSFER (bukan COD) TIDAK PERNAH
            // mengucap ulang "sesuai rincian" -- CS cuma kirim daftar rekening bank (pola baku "No
            // rek." / "a.n") lalu LANGSUNG lanjut minta alamat pengiriman ("patokan rumah"/"nama
            // jalan"/RT RW). CS baru minta alamat detail kalau order SUDAH dianggap fix, jadi
            // kombinasi ini setara sinyal closing utk jalur transfer.
            /(?:No\s*rek\.?|a\.n\b)[\s\S]*?(?:patokan\s+rumah|nama\s+jalan|alamat\s+lengkap|rt\s*\/?\s*rw)/i.test(transcript) ||
            // Tahap 5 lanjutan (2026-08-18, blind-test 80 chat admin: wa dgn Kartini -- repeat order):
            // varian TRANSFER lain -- BUYER sendiri yang eksplisit bilang sudah kirim uangnya ("Sudah sy
            // transfer 🙏"), bukan CS yang minta alamat. Konfirmasi pembayaran dari mulut buyer sendiri
            // adalah sinyal closing yang KUAT, setara keluarga "sudah sesuai/bungkus kak" utk COD.
            /(?:sudah|sdh|udah)\s+(?:sy|saya)?\s*(?:di\s*)?transfer/i.test(transcript));
        if (!hasPositiveClosingSignal)
            return false;
        // Fase 30-lanjutan (2026-08-18, fix "GSM - Rohuan Shopee"): kalau tadi ada hesitation TAPI
        // transkrip TIDAK PERNAH mencapai template penutup genuine SETELAH baris keraguan itu
        // (posisi-aware -- lihat `hesitationResolvedByLaterWrapup`), keraguan itu TIDAK pernah
        // beneran diselesaikan -- tetap blokir closing (perilaku identik dgn versi lama utk kasus
        // ini, TIDAK ada perubahan). Override cuma berlaku kalau penutup genuine benar-benar ketemu
        // SETELAH baris hesitation (lihat komentar di deklarasi `hasHesitation` di atas utk bukti
        // empirisnya) -- kalau template penutup malah muncul SEBELUM keraguan lalu buyer batal
        // SETELAHNYA, itu bukti deal genuine gagal, bukan diselesaikan.
        if (hasHesitation && !this.hesitationResolvedByLaterWrapup(transcript, exclusionText))
            return false;
        // Problem B audit (2026-08-18, wa 6281319844862): guard TERAKHIR -- sinyal positif SUDAH
        // ketemu, tapi kalau CS sampai harus mengulang tanya alamat >=2x TANPA PERNAH mencapai
        // template penutup manapun, itu bukti nyata deal STALL (buyer diam), bukan closing sah. Guard
        // ini otomatis TIDAK berlaku kalau template penutup SUDAH ketemu di transkrip yang sama
        // (lihat `hasUnansweredLogisticsStall` -- itu artinya order-nya beneran selesai, terlepas
        // sempat nanya alamat berulang di tengah jalan).
        if (this.hasUnansweredLogisticsStall(transcript))
            return false;
        return true;
    };
    /**
     * Parse baris chat mentah menjadi daftar ParsedChatMessage terstruktur.
     */
    SessionBoundaryParser.parseLines = function (transcript) {
        if (!transcript || !transcript.trim())
            return [];
        var lines = transcript.split(/\r?\n/);
        var parsed = [];
        // Regex standar WhatsApp export (Android, iOS, WA Web):
        // e.g. "19/06/26 07.24 - Cordova Store Aluna: Hai kak Zamri"
        // e.g. "14/08/26, 22:28 - H. MHD ZAMRI: Halo..."
        // e.g. "[14/08/26 22.28.15] Cordova Store: ..."
        //
        // Blind-test 80 chat admin (2026-08-18, Tahap 5 lanjutan): prefix tanggal/jam sebelumnya
        // OPSIONAL (dibungkus `(?:...)?`), sehingga baris LANJUTAN dari satu pesan CS multi-paragraf
        // (mis. "Nama: JUBER S H", "1. Harga  : 199.000", "* Kode : 031" -- baris² form/rincian tanpa
        // jam/tanggal ulang, wajar krn WA export cuma nulis timestamp SEKALI per bubble pesan) yang
        // kebetulan mengandung tanda titik dua ":" salah kebaca sbg PESAN BARU dari "pengirim" palsu
        // (teks sebelum titik dua, mis. "Nama"/"1. Harga"/"PERATURAN CHECKOUT") -- krn nama itu jelas
        // bukan nama CS, otomatis jatuh ke role BUYER (default), mengotori `buyerOnlyText` dgn teks CS
        // sendiri (termasuk kalimat baku "...untuk klaim garansi apabila ada kerusakan barang" yg lalu
        // salah memicu exclusion `isAfterSalesChat` dan memblokir closing yg sah -- 13/23 closing-miss
        // di blind-test 80 chat admin persis pola ini). Fix: wajibkan prefix tanggal/jam (hapus `?`
        // pembungkus) -- baris TANPA tanggal/jam valid otomatis jatuh ke cabang "lanjutan pesan
        // sebelumnya" di bawah (perilaku yg SEHARUSNYA utk lanjutan bubble WA asli). Aman: format
        // "[CS]"/"[BUYER]" tagged-buffer sudah ditangani cabang TERPISAH (tagMatch) SEBELUM regex ini
        // dicoba, dan tidak ada test existing yg bergantung pada baris "Pengirim: teks" tanpa tanggal.
        var waLineRegex = /^\[?(\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4})[,\s]+(\d{1,2}[\.:]\d{1,2}(?:[\.:]\d{1,2})?(?:\s*[AaPp][Mm])?)\]?\s*[-–]?\s*([^:]+?):\s*([\s\S]*)$/;
        var currentMsg = null;
        var _loop_1 = function (rawLine) {
            var trimmed = rawLine.trim();
            if (!trimmed)
                return "continue";
            // Abaikan baris sistem enkripsi / timer WA
            if (trimmed.includes('Pesan dan telepon terenkripsi') ||
                trimmed.includes('timer default untuk pesan sementara') ||
                trimmed.includes('kini menjadi kontak') ||
                trimmed.includes('layanan yang aman dari Meta') ||
                trimmed.includes('mengaktifkan tanggapan AI') ||
                trimmed.includes('menonaktifkan pesan sementara')) {
                return "continue";
            }
            // 1. Cek format Tagged Buffer (e.g. [CS] text atau [BUYER] text dari live Baileys stream).
            // Langkah C Kelompok 2 (Dual-View): grup timestamp EPOCH-MS opsional ditambahkan setelah
            // role (mis. "[CS 1755500000000] text") -- dipakai `formatBufferLine()` di atas. Sengaja
            // dibuat opsional (bukan wajib) supaya baris format LAMA "[CS] text" (tanpa timestamp,
            // masih ada di Redis selama masa transisi TTL 72 jam) tetap ke-parse benar dgn
            // `timestamp: null` seperti perilaku lama -- lihat isDeterministicClosing/segmentSessions
            // di bawah, keduanya sudah didesain toleran terhadap timestamp null (dianggap "tidak ada
            // jeda" alih-alih error).
            var tagMatch = rawLine.match(/^\[(CS|SELLER|ADMIN|BUYER|CUSTOMER|PEMBELI)(?:\s+(\d+))?\]:?\s*([\s\S]*)$/i);
            if (tagMatch) {
                var tag = tagMatch[1].toUpperCase();
                var tsRaw = tagMatch[2];
                var textContent = (tagMatch[3] || '').trim();
                var isCs = ['CS', 'SELLER', 'ADMIN'].includes(tag);
                var timestamp = null;
                if (tsRaw) {
                    var parsedTs = new Date(parseInt(tsRaw, 10));
                    if (!isNaN(parsedTs.getTime()))
                        timestamp = parsedTs;
                }
                currentMsg = {
                    timestamp: timestamp,
                    senderRole: isCs ? 'CS' : 'BUYER',
                    senderName: isCs ? 'CS Store' : 'Pembeli',
                    text: textContent,
                };
                parsed.push(currentMsg);
                return "continue";
            }
            var match = rawLine.match(waLineRegex);
            if (match) {
                var dateStr = match[1];
                var timeStr = match[2];
                var senderRaw_1 = (match[3] || '').trim();
                var textContent = (match[4] || '').trim();
                // Tentukan apakah pengirim adalah CS atau Pembeli
                var isCs = this_1.CS_INDICATORS.some(function (pattern) { return pattern.test(senderRaw_1); });
                var senderRole = isCs ? 'CS' : 'BUYER';
                var timestamp = null;
                if (dateStr && timeStr) {
                    timestamp = this_1.parseDate(dateStr, timeStr);
                }
                currentMsg = {
                    timestamp: timestamp,
                    senderRole: senderRole,
                    senderName: senderRaw_1,
                    text: textContent,
                };
                parsed.push(currentMsg);
            }
            else if (currentMsg) {
                // Multi-line continuation of previous message
                currentMsg.text += "\n".concat(rawLine);
            }
            else {
                // Baris pembuka tanpa header pengirim
                parsed.push({
                    timestamp: null,
                    senderRole: 'BUYER',
                    senderName: 'Pembeli',
                    text: rawLine,
                });
            }
        };
        var this_1 = this;
        for (var _i = 0, lines_1 = lines; _i < lines_1.length; _i++) {
            var rawLine = lines_1[_i];
            _loop_1(rawLine);
        }
        return parsed;
    };
    /**
     * Segmentasi percakapan menjadi beberapa sesi berdasarkan terminal status dan pemicu iklan baru.
     */
    SessionBoundaryParser.segmentSessions = function (transcript) {
        var messages = this.parseLines(transcript);
        if (messages.length === 0) {
            var emptySession = {
                sessionIndex: 0,
                startTime: null,
                endTime: null,
                messages: [],
                rawTranscript: transcript,
                isInboundAdTrigger: false,
                inboundProductCandidate: null,
            };
            return {
                totalSessions: 1,
                isRepeatOrder: false,
                activeSession: emptySession,
                allSessions: [emptySession],
            };
        }
        var sessions = [];
        var currentSessionMsgs = [];
        var prevMsg = null;
        var hadTerminalInCurrent = false;
        var _loop_2 = function (i) {
            var msg = messages[i];
            var isNewSessionTrigger = false;
            var inboundProd = null;
            // Cek apakah pesan pembeli merupakan pemicu klik iklan baru
            if (msg.senderRole === 'BUYER') {
                for (var _i = 0, _a = this_2.INBOUND_AD_PATTERNS; _i < _a.length; _i++) {
                    var pattern = _a[_i];
                    var m = msg.text.match(pattern);
                    if (m && m[1]) {
                        inboundProd = m[1].replace(/-(?:Fb|Goo\d*|Google|Tiktok|Ig|Ads|NPM|NFR|Ad)\b.*/i, '').trim();
                        break;
                    }
                }
            }
            // Evaluasi jeda waktu (Inactivity Gap > 48 jam)
            var hasLongTimeGap = false;
            if (prevMsg && prevMsg.timestamp && msg.timestamp) {
                var diffHours = (msg.timestamp.getTime() - prevMsg.timestamp.getTime()) / (1000 * 60 * 60);
                if (diffHours >= 48) {
                    hasLongTimeGap = true;
                }
            }
            // Kondisi pemotongan sesi baru:
            // 1. Ditemukan Inbound Ad Trigger baru dari pembeli, DAN sudah ada pesan di sesi sebelumnya
            // 2. ATAU ada jeda waktu lama (>48 jam) SETELAH sesi sebelumnya mencapai status terminal (selesai/closing/lost)
            if (currentSessionMsgs.length >= 3) {
                if (inboundProd && msg.senderRole === 'BUYER') {
                    isNewSessionTrigger = true;
                }
                else if (hasLongTimeGap && hadTerminalInCurrent) {
                    isNewSessionTrigger = true;
                }
            }
            if (isNewSessionTrigger) {
                // Tutup sesi sebelumnya
                sessions.push(this_2.buildSessionObject(sessions.length, currentSessionMsgs));
                currentSessionMsgs = [];
                hadTerminalInCurrent = false;
            }
            currentSessionMsgs.push(msg);
            // Cek apakah pesan ini menandai status terminal
            if (this_2.TERMINAL_CLOSING_PATTERNS.some(function (pat) { return pat.test(msg.text); })) {
                hadTerminalInCurrent = true;
            }
            prevMsg = msg;
        };
        var this_2 = this;
        for (var i = 0; i < messages.length; i++) {
            _loop_2(i);
        }
        if (currentSessionMsgs.length > 0) {
            sessions.push(this.buildSessionObject(sessions.length, currentSessionMsgs));
        }
        var activeSession = sessions[sessions.length - 1];
        var isRepeatOrder = sessions.length > 1;
        return {
            totalSessions: sessions.length,
            isRepeatOrder: isRepeatOrder,
            activeSession: activeSession,
            allSessions: sessions,
        };
    };
    SessionBoundaryParser.buildSessionObject = function (index, msgs) {
        var _a, _b;
        var startTime = null;
        var endTime = null;
        var isInboundAdTrigger = false;
        var inboundProductCandidate = null;
        if (msgs.length > 0) {
            startTime = ((_a = msgs[0]) === null || _a === void 0 ? void 0 : _a.timestamp) || null;
            endTime = ((_b = msgs[msgs.length - 1]) === null || _b === void 0 ? void 0 : _b.timestamp) || null;
            // Cari pesan pemicu iklan pertama pembeli atau CS
            for (var _i = 0, msgs_1 = msgs; _i < msgs_1.length; _i++) {
                var m = msgs_1[_i];
                for (var _c = 0, _d = this.INBOUND_AD_PATTERNS; _c < _d.length; _c++) {
                    var pattern = _d[_c];
                    var match = m.text.match(pattern);
                    if (match && match[1]) {
                        isInboundAdTrigger = true;
                        inboundProductCandidate = match[1]
                            .replace(/-(?:Fb|Goo\d*|Google|Tiktok|Ig|Ads|NPM|NFR|Ad)\b.*/i, '')
                            .trim();
                        break;
                    }
                }
                if (isInboundAdTrigger && inboundProductCandidate)
                    break;
            }
        }
        var rawTranscript = msgs
            .map(function (m) {
            var timePrefix = m.timestamp
                ? "".concat(m.timestamp.toLocaleDateString('id-ID'), " ").concat(m.timestamp.toLocaleTimeString('id-ID'), " - ")
                : '';
            return "".concat(timePrefix).concat(m.senderName, ": ").concat(m.text);
        })
            .join('\n');
        return {
            sessionIndex: index,
            startTime: startTime,
            endTime: endTime,
            messages: msgs,
            rawTranscript: rawTranscript,
            isInboundAdTrigger: isInboundAdTrigger,
            inboundProductCandidate: inboundProductCandidate,
        };
    };
    SessionBoundaryParser.parseDate = function (dateStr, timeStr) {
        try {
            // Normalisasi 19/06/26 atau 19/06/2026
            var parts = dateStr.split(/[\/\-\.]/);
            if (parts.length < 3)
                return null;
            var d = parseInt(parts[0], 10);
            var m = parseInt(parts[1], 10);
            var y = parseInt(parts[2], 10);
            if (y < 100)
                y += 2000;
            // Normalisasi waktu 07.24 atau 22:28:15
            var timeParts = timeStr.replace(/[^\d:]/g, ':').split(':').filter(Boolean);
            var hour = parseInt(timeParts[0] || '0', 10);
            var minute = parseInt(timeParts[1] || '0', 10);
            var sec = parseInt(timeParts[2] || '0', 10);
            // WhatsApp export waktu di Indonesia menggunakan zona waktu WIB (UTC+7 / Asia/Jakarta).
            // Konstruksi ISO-8601 dengan offset eksplisit +07:00 agar waktu UTC tersimpan tepat dan konsisten.
            var mmStr = String(m).padStart(2, '0');
            var ddStr = String(d).padStart(2, '0');
            var hhStr = String(hour).padStart(2, '0');
            var minStr = String(minute).padStart(2, '0');
            var secStr = String(sec).padStart(2, '0');
            var isoWib = "".concat(y, "-").concat(mmStr, "-").concat(ddStr, "T").concat(hhStr, ":").concat(minStr, ":").concat(secStr, "+07:00");
            var date = new Date(isoWib);
            return isNaN(date.getTime()) ? null : date;
        }
        catch (_a) {
            return null;
        }
    };
    SessionBoundaryParser.CS_INDICATORS = [
        /\bcordova\b/i,
        /\bcs\b/i,
        /\badmin\b/i,
        /\btoko\b/i,
        /\bjuragan\b/i,
        /\baluna\b/i,
        /\bdeva\b/i,
        /\bcici\b/i,
        /\badisa\b/i,
        /\bannisa\b/i,
        /\bputri\b/i,
        /\bita\b/i,
    ];
    SessionBoundaryParser.INBOUND_AD_PATTERNS = [
        /Halo,\s*saya\s*sudah\s*melakukan\s*pemesanan\s*([^\n\r,]+?)\s*,\s*atas\s*nama/i,
        /saya\s*mau\s*(?:pesan|order|beli)\s*([^\n\r,]+)/i,
        /form\s+pemesanan\s+([^\n\r!]+?)\s+di\s+toko\s+kami/i,
        /Terima\s+kasih\s+sudah\s+mengisi\s+form\s+pemesanan\s+([^\n\r!]+)/i,
        /(?:📦\s*)?Produk\s*:\s*([^\n\r💰]+)/i,
        // Fase 31 (2026-08-19, temuan sampingan saat backfill 16-18 Agustus, wa 6281263270375 &
        // 6285261707692): 2 pola di bawah ("pesanan ...") awalnya TIDAK punya pagar utk menolak buyer
        // yang cuma NGACU ke pesanan-nya SENDIRI ("pesanan saya", "pesanan nya", dst) tanpa menyebut
        // produk baru sama sekali -- mis. penutup basa-basi "Saya tunggu ya Teteh pesanan saya. 🙏" atau
        // "sesuai dengan pesanan Saya ya.... Warna Kayu Jati". Regex lama menangkap "saya."/"Saya ya...."
        // itu APA ADANYA sbg nama produk, DAN (lebih parah) `isInboundAdTrigger` ikut menyala --
        // memicu segmentasi sesi BARU tepat di pesan penutup itu, membuat sesi aktif kehilangan konteks
        // template CS awal yg justru sudah menyebut produk dengan benar. Negative lookahead di bawah
        // menolak match kalau kata SETELAH "pesanan" adalah kata ganti/filler yg jelas BUKAN nama
        // produk baru -- best-effort, bukan daftar lengkap, tapi menutup 2 kasus riil yg ditemukan.
        /pesanan\s+(?!saya\b|sy\b|nya\b|ku\b|kami\b|kita\b|ini\b|itu\b|tersebut\b)([^\n\r,]+?)\s+warna/i,
        /pesanan\s+(?!saya\b|sy\b|nya\b|ku\b|kami\b|kita\b|ini\b|itu\b|tersebut\b)([^\n\r,]+)/i,
    ];
    SessionBoundaryParser.TERMINAL_CLOSING_PATTERNS = [
        /CATATAN[\s\S]*?Pastikan\s+hp\s+Selalu\s+Aktif/i,
        /paketnya\s+udah\s+di\s+kirim/i,
        /hari\s+ini\s+barangnya\s+sampe/i,
        /akan\s+langsung\s+kami\s+proses/i,
        /pesanan\s+(?:kakak|bapak|ibu|anda)?\s*segera\s+kami\s+proses/i,
        /terimakasih\s+untuk\s+orderan/i,
        /tidak\s+jadi\s+order/i,
        /g\s+jadilah/i,
    ];
    // Problem B audit (2026-08-18, wa 6281319844862, admin konfirmasi FALSE POSITIF): CS menanyakan
    // "patokan rumah" (detail alamat) 4x berturut-turut lintas beberapa hari, buyer TIDAK PERNAH
    // balas lagi setelah sempat setuju COD & pilih warna sarung -- order tidak pernah nyampe ke
    // template penutup (CATATAN/PERATURAN CHECKOUT/dst). Sinyal positif "sesuai rincian diatas...cod"
    // (Temuan B) menandai closing di TITIK TENGAH percakapan, bukan di penutup -- perlu korroborasi
    // tambahan: kalau CS sampai harus MENGULANG pertanyaan alamat >=2x DAN transkrip TIDAK PERNAH
    // sampai ke template penutup manapun, itu bukti nyata deal STALL (buyer diam), bukan closing sah.
    // Ambang ">=2x" dipilih krn 0/40 chat CLOSING di dataset blind-test 80 admin punya "patokan
    // rumah" disebut >=2x (CS normalnya nanya SEKALI, dijawab, lanjut proses) -- diverifikasi
    // langsung thd seluruh dataset sebelum threshold ini dipakai, resiko regresi RENDAH.
    SessionBoundaryParser.REPEATED_UNANSWERED_ADDRESS_ASK_PATTERN = /patokan\s+rumah|dibantu\s+(?:untuk\s+)?alamat/i;
    return SessionBoundaryParser;
}());
exports.SessionBoundaryParser = SessionBoundaryParser;
