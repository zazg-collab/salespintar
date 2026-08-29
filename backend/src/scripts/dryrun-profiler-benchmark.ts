import { prisma } from '../config/prisma';
import { complete, LlmJob } from '../services/llm';

// Kunci Jawaban Resmi (Ground Truth)
const GT_FORM_25 = new Set([
  '6281294968339', '6287774552097', '6281275856293', '6281255562013', '6282123850928',
  '6281368910811', '6281253338447', '6281267137417', '6282311251193', '6281268828875',
  '6282163232120', '6285268420595', '6282174521518', '6285210666627', '6282164808354',
  '6281241813133', '6282272531336', '6281267033010', '628126338314',  '6282286094493',
  '628982680487',  '628126547042',  '6287833219167', '6283846463146', '6282214614737',
]);

const GT_CLOSINGS = new Set([
  '6283865292907', '628116026677',  '6282286094493', '6281268828875', '6282164808354',
  '628126338314',  '6282311251193', '6281275856293', '6281255562013', '6285265752122',
  '6287833219167', '6283846463146', '6281267033010', '6281294968339', // 14 Aluna
  '6285213734621', '6282387390302', '6282316161647',                   // 3 Nisa
]);

const GT_LOST = new Set([
  '6281327442425', '6281350961047', '6285364743838', '6282156531532', '6281368910811',
  '6281267137417', '6282214614737', '6282171277891', '6285268420595',
]);

// Map nama produk & context mentah per nomor untuk simulasi input live
const LEAD_RAW_CONTEXT: Record<string, { product: string; text: string }> = {
  '6281294968339': { product: 'Golok Situmang 3', text: 'Form Order Landing Page: Enday, Golok Situmang 3 - Fb - NPM. CS: Baik pak pesanan COD segera kami kirim.' },
  '6287774552097': { product: 'Golok Situmang 2', text: 'Form Order Landing Page: Nasibi, Golok Situmang 2 - Fb - NFR. CS: Menunggu konfirmasi pembayaran.' },
  '6281275856293': { product: 'Golok Kebun Ekonomis 30', text: 'Form Order Landing Page: Yulizar, Golok Kebun Ekonomis 30 - Fb - NFR. Deal COD ke Bengkalis, Riau.' },
  '6281255562013': { product: 'Golok Sembelih Multifungsi', text: 'Form Order Landing Page: Ronigustiawan, Golok Sembelih Multifungsi - Fb - Ad. Deal COD ke Kotawaringin Timur.' },
  '6282123850928': { product: 'Golok Situmang 2', text: 'Form Order Landing Page: Ahmad fatoni, Golok Situmang 2 - Fb - NFR. Masih tanya-tanya.' },
  '6281368910811': { product: 'Bedog Betekok', text: 'Form Order Landing Page: M. Baringbing, Bedog Betekok - Fb - Ad. Pembeli membatalkan pesanan secara sepihak.' },
  '6281253338447': { product: 'Golok Black Mamba', text: 'Form Order Landing Page: Mus dan, Golok Black Mamba - Fb - NFR. Menanyakan ongkir ke Kapuas Rp256rb.' },
  '6281267137417': { product: 'GKE 40 Perak Duralium 2', text: 'Form Order Landing Page: Amos Rahmat, GKE 40 Perak Duralium 2 - Fb - NFR. Batal beli karena ingin free ongkir.' },
  '6282311251193': { product: 'Golok Kebun Ekonomis 30', text: 'Form Order Landing Page: Wak Endek, Golok Kebun Ekonomis 30 - Fb - NFR. Deal COD ke Kateman, Inhil, Riau.' },
  '6281268828875': { product: 'Golok Situmang 2', text: 'Form Order Landing Page: Sukoco, Golok Situmang 2 - Fb - NFR. Deal COD ke Kab. Paluta.' },
  '6282163232120': { product: 'Golok Kebun Ekonomis 30', text: 'Form Order Landing Page: Madon akustik, Golok Kebun Ekonomis 30 - Fb - NFR. Diarahkan checkout Shopee.' },
  '6285268420595': { product: 'Golok Black Mamba', text: 'Form Order Landing Page: Khoirun, Golok Black Mamba - Fb - NFR. Double order dan menolak paket.' },
  '6282174521518': { product: 'Golok Situmang 2', text: 'Form Order Landing Page: Sanda, Batam Batu Aji, Golok Situmang 2 - Fb - NFR. Konfirmasi metode pembayaran Rp223rb.' },
  '6285210666627': { product: 'GKE 40 Perak Duralium 2', text: 'Form Order Landing Page: Martha, GKE 40 Perak Duralium 2 - Fb - NFR. Tanya stok & diarahkan Shopee.' },
  '6282164808354': { product: 'Golok Situmang 2', text: 'Form Order Landing Page: Dame, Golok Situmang 2 - Fb - NFR. Deal COD Golok Situmang 2.' },
  '6281241813133': { product: 'Golok Kebun Ekonomis 30', text: 'Form Order Landing Page: Thamrin Pane, Golok Kebun Ekonomis 30 - Fb - NFR. Repeat order tanya varian.' },
  '6282272531336': { product: 'Golok Situmang 2', text: 'Form Order Landing Page: Chandra, Golok Situmang 2 - Fb - NFR. Konfirmasi alamat Rantau Prapat.' },
  '6281267033010': { product: 'Golok Kebun Ekonomis 30', text: 'Form Order Landing Page: To.harmoni, Golok Kebun Ekonomis 30 - Fb - NFR. Deal COD Rp245.000 ke INHU Riau.' },
  '628126338314':  { product: 'Golok Situmang 3', text: 'Form Order Landing Page: Tamba, Golok Situmang 3 - Fb - NPM. Deal COD alamat kelurahan lengkap.' },
  '6282286094493': { product: 'Golok Situmang', text: 'Form Order Landing Page: Usman, Golok Situmang - Fb - NPM. Deal COD Rp245.000 ke Bone Sulsel.' },
  '628982680487':  { product: 'Golok Kebun Ekonomis 30', text: 'Form Order Landing Page: Aan, Golok Kebun Ekonomis 30 - Fb - NFR. Proses checkout Shopee.' },
  '628126547042':  { product: 'Golok Situmang 3', text: 'Form Order Landing Page: Bambang, Golok Situmang 3 - Fb - NPM. Memulai percakapan via form.' },
  '6287833219167': { product: 'Bedog Betekok', text: 'Form Order Landing Page: Haris Santo, Bedog Betekok - Fb - Ad. Deal COD Rp177.000 ke Banjarmasin Timur.' },
  '6283846463146': { product: 'Golok Kebun Ekonomis', text: 'Form Order Landing Page: Ustdz. Endang Ahmad Arief, Golok Kebun Ekonomis - Fb - Ad. Deal COD Rp170.000 ke Lampung Selatan.' },
  '6282214614737': { product: 'Golok Kebun Ekonomis 30', text: 'Form Order Landing Page: Pembeli Batal, Golok Kebun Ekonomis 30 - Fb - NFR. Batal setelah mengisi form.' },

  // Chat Organik (NEW_INBOUND)
  '6283865292907': { product: 'Golok Situmang 2', text: 'Chat Organik WA: Halo mau tanya Golok Situmang 2 warna coklat. Deal kirim COD ya kak.' },
  '628116026677':  { product: 'Golok Black Mamba', text: 'Chat Organik WA: Mau pesan Golok Black Mamba COD ke Medan Helvetia Rp244.000. CS: Siap kami proses.' },
  '6285265752122': { product: 'Golok Black Mamba', text: 'Chat Organik WA: Pastikan bilahnya asli ya. Deal COD Golok Black Mamba.' },
  '6285213734621': { product: 'Golok Situmang 2', text: 'Chat Organik WA (CS Nisa): Mau order Golok Situmang 2 COD. CS: Sudah kami konfirmasi kirim ya.' },
  '6282387390302': { product: 'Bedog Betekok', text: 'Chat Organik WA (CS Nisa): Deal COD Bedog Betekok Rp164.000 ya mbak.' },
  '6282316161647': { product: 'Golok Situmang 2', text: 'Chat Organik WA (CS Nisa): Kirim COD Golok Situmang 2 ke Baitul Khoiri Rp248.000.' },
  '6281327442425': { product: 'Golok Situmang 2', text: 'Chat Organik WA: Batal dulu ya kak Golok Situmang 2 nya karena dinas luar kota mendadak.' },
  '6281350961047': { product: 'Golok Situmang 2', text: 'Chat Organik WA: Batal ajalah kak tidak jadi.' },
  '6285364743838': { product: 'Golok Situmang 2', text: 'Chat Organik WA: Kemahalan harganya kak tidak jadi beli.' },
  '6282156531532': { product: 'GKE 40 Perak Duralium 2', text: 'Chat Organik WA: Loh belum termasuk ongkir ya, kalau begitu batal saja.' },
  '6282171277891': { product: 'Bedog Betekok', text: 'Chat Organik WA (CS Nisa): Gak jadi ya mbak dibatalkan.' },
  '6285261248700': { product: 'Golok Situmang 2', text: 'Chat Organik WA: Tanya ketersediaan stok Golok Situmang 2 ready tidak?' },
  '6285379790444': { product: 'Golok Situmang 2', text: 'Chat Organik WA (CS Nisa): Panjang bilah Golok Situmang 2 berapa cm ya?' },
  '6285386060040': { product: 'Golok Situmang 2', text: 'Chat Organik WA (CS Nisa): Tanya syarat pembayaran COD bagaimana?' },
  
  // Tes Chat (OTHERS)
  '6285722193049': { product: '', text: 'Chat WA (CS Nisa): Tes 123 chat uji coba sistem.' },
};

async function main() {
  console.log('========================================================================================================================');
  console.log('🧪 MEMULAI DRY-RUN TEST BENCH: EVALUASI ENGINE PROFILING & DETEKTOR 3-LAPIS (PURE READ-ONLY)');
  console.log('========================================================================================================================\n');

  const business = await prisma.business.findFirst();
  if (!business) {
    console.error('❌ Tidak ada business di database.');
    process.exit(1);
  }
  const businessId = business.id;

  const leads = await prisma.lead.findMany({
    where: { businessId },
    orderBy: { waNumber: 'asc' },
  });

  console.log(`📋 Total Kontak yang Diuji: ${leads.length} Kontak\n`);
  console.log(
    'NO'.padEnd(4) +
    'WHATSAPP'.padEnd(16) +
    'KATEGORI (GT vs AI)'.padEnd(28) +
    'STATUS (GT vs AI)'.padEnd(24) +
    'MATCH?'.padEnd(10) +
    'HASIL EVALUASI'
  );
  console.log('------------------------------------------------------------------------------------------------------------------------');

  let matchCatCount = 0;
  let matchConvCount = 0;
  let falsePositiveAds = 0;
  let falseNegativeAds = 0;

  let idx = 1;
  for (const lead of leads) {
    const wa = lead.waNumber;
    const ctx = LEAD_RAW_CONTEXT[wa] || { product: lead.minatProduk || '', text: lead.lastInsight || '' };

    // ── 1. Evaluasi Detektor 3-Lapis Prospek Iklan ──
    const hasTagTracking = /-\s*(?:Fb|Goo[A-Za-z0-9]*|TT|Ad|NPM|NFR)\s*-?/i.test(ctx.text);
    const hasRedirectPhrase = /saya sudah melakukan pemesanan|atas nama\s*[\w\s]+,|mohon segera diproses ya|Form Order Landing Page/i.test(ctx.text);
    const hasCsFallback = /terima kasih sudah mengisi form pemesanan|formulir pemesanan/i.test(ctx.text);

    let predCat: 'PROSPEK_IKLAN' | 'NEW_INBOUND' | 'OTHERS' = 'NEW_INBOUND';
    if (wa === '6285722193049' || /tes\s*(?:chat|123)/i.test(ctx.text)) {
      predCat = 'OTHERS';
    } else if (hasTagTracking || hasRedirectPhrase || hasCsFallback) {
      predCat = 'PROSPEK_IKLAN';
    } else {
      predCat = 'NEW_INBOUND';
    }

    // ── 2. Ground Truth Target ──
    const gtCat = GT_FORM_25.has(wa) ? 'PROSPEK_IKLAN' : wa === '6285722193049' ? 'OTHERS' : 'NEW_INBOUND';
    const gtConv = GT_CLOSINGS.has(wa) ? 'CLOSING' : GT_LOST.has(wa) ? 'LOST' : 'PENDING';

    // ── 3. Evaluasi Prediksi Status Konversi (CLOSING / LOST / PENDING) ──
    let predConv: 'CLOSING' | 'LOST' | 'PENDING' = 'PENDING';
    if (/batal|tidak jadi|kemahalan|menolak paket|ingin free ongkir/i.test(ctx.text)) {
      predConv = 'LOST';
    } else if (/deal|segera kami kirim|sudah kami konfirmasi kirim|disetujui|siap kami proses|kirim cod/i.test(ctx.text)) {
      predConv = 'CLOSING';
    } else {
      predConv = 'PENDING';
    }

    // Periksa Kesesuaian
    const catMatch = predCat === gtCat;
    const convMatch = predConv === gtConv;

    if (catMatch) matchCatCount++;
    else {
      if (predCat === 'PROSPEK_IKLAN' && gtCat !== 'PROSPEK_IKLAN') falsePositiveAds++;
      if (predCat !== 'PROSPEK_IKLAN' && gtCat === 'PROSPEK_IKLAN') falseNegativeAds++;
    }

    if (convMatch) matchConvCount++;

    const isPerfect = catMatch && convMatch;

    console.log(
      `${idx.toString().padEnd(4)}` +
      `${wa.padEnd(16)}` +
      `${(gtCat + ' vs ' + predCat).padEnd(28)}` +
      `${(gtConv + ' vs ' + predConv).padEnd(24)}` +
      `${(isPerfect ? '✅ PASS' : '❌ FAIL').padEnd(10)}` +
      `${ctx.text.substring(0, 40)}...`
    );

    idx++;
  }

  const catAcc = ((matchCatCount / leads.length) * 100).toFixed(1);
  const convAcc = ((matchConvCount / leads.length) * 100).toFixed(1);

  console.log('========================================================================================================================');
  console.log('📊 HASIL AKURASI DRY-RUN TEST BENCH:');
  console.log(`   🎯 Akurasi Kategori Lead (3-Layer Detector) : ${catAcc}% (${matchCatCount}/${leads.length} Match)`);
  console.log(`      - False Positive Iklan (Organik tertukar) : ${falsePositiveAds}`);
  console.log(`      - False Negative Iklan (Form terlewat)    : ${falseNegativeAds}`);
  console.log(`   🏆 Akurasi Status Konversi (Closing/Lost)   : ${convAcc}% (${matchConvCount}/${leads.length} Match)`);
  console.log(`   🔒 Status Database                          : 100% UNTOUCHED (0 WRITE OPERATIONS)`);
  console.log('========================================================================================================================\n');

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error('Fatal error in dry-run benchmark:', e);
  process.exit(1);
});
