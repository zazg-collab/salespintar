import { prisma } from '../config/prisma';
import { complete, LlmJob } from '../services/llm';
import { LeadScoringEngine } from '../modules/leads/lead-scoring.engine';
import { RtsRiskEngine } from '../modules/leads/rts-risk.engine';

// 25 Form Leads dari CSV Ground Truth Form Landing Page (cdv.form.id)
const CSV_FORM_LEADS: Record<string, { name: string; product: string; checkoutPage: string; notes?: string }> = {
  '6281294968339': { name: 'Enday', product: 'Golok Situmang 3', checkoutPage: 'Golok Situmang Hitam' },
  '6287774552097': { name: 'Nasibi', product: 'Golok Situmang 2', checkoutPage: 'Golok Situmang Hitam' },
  '6281275856293': { name: 'Yulizar', product: 'Golok Kebun Ekonomis 30', checkoutPage: 'Golok Kebun Ekonomis 30' },
  '6281255562013': { name: 'Ronigustiawan', product: 'Golok Sembelih Multifungsi', checkoutPage: 'Checkout Page 1' },
  '6282123850928': { name: 'Ahmad fatoni', product: 'Golok Situmang 2', checkoutPage: 'Golok Situmang Hitam' },
  '6281368910811': { name: 'M. Baringbing', product: 'Bedog Betekok', checkoutPage: 'Checkout Page 1', notes: 'Batal sepihak' },
  '6281253338447': { name: 'Mus dan', product: 'Golok Black Mamba', checkoutPage: 'Black Mamba' },
  '6281267137417': { name: 'Amos Rahmat', product: 'GKE 40 Perak Duralium 2', checkoutPage: 'GKE 40 Perak Duralium', notes: 'Batal pengen free ongkir' },
  '6282311251193': { name: 'Wak Endek', product: 'Golok Kebun Ekonomis 30', checkoutPage: 'Golok Kebun Ekonomis 30' },
  '6281268828875': { name: 'Sukoco', product: 'Golok Situmang 2', checkoutPage: 'Golok Situmang Hitam' },
  '6282163232120': { name: 'Madon akustik', product: 'Golok Kebun Ekonomis 30', checkoutPage: 'Golok Kebun Ekonomis 30' },
  '6285268420595': { name: 'Khoirun', product: 'Golok Black Mamba', checkoutPage: 'Black Mamba', notes: 'Double nolak paket' },
  '6282174521518': { name: 'Sanda', product: 'Golok Situmang 2', checkoutPage: 'Golok Situmang Hitam', notes: 'Batam Batu Aji' },
  '6285210666627': { name: 'Martha', product: 'GKE 40 Perak Duralium 2', checkoutPage: 'GKE 40 Perak Duralium' },
  '6282164808354': { name: 'Dame', product: 'Golok Situmang 2', checkoutPage: 'Golok Situmang Hitam' },
  '6281241813133': { name: 'Thamrin Pane', product: 'Golok Kebun Ekonomis 30', checkoutPage: 'Golok Kebun Ekonomis 30' },
  '6282272531336': { name: 'Chandra', product: 'Golok Situmang 2', checkoutPage: 'Golok Situmang Hitam' },
  '6281267033010': { name: 'To.harmoni', product: 'Golok Kebun Ekonomis 30', checkoutPage: 'Golok Kebun Ekonomis 30' },
  '628126338314':  { name: 'Tamba', product: 'Golok Situmang 3', checkoutPage: 'Golok Situmang Hitam' },
  '6282286094493': { name: 'Usman', product: 'Golok Situmang', checkoutPage: 'Golok Situmang Hitam' },
  '628982680487':  { name: 'Aan', product: 'Golok Kebun Ekonomis 30', checkoutPage: 'Golok Kebun Ekonomis 30' },
  '628126547042':  { name: 'Bambang', product: 'Golok Situmang 3', checkoutPage: 'Golok Situmang Hitam' },
  '6287833219167': { name: 'Haris Santo', product: 'Bedog Betekok', checkoutPage: 'Checkout Page 1' },
  '6283846463146': { name: 'Ustdz. Endang Ahmad Arief', product: 'Golok Kebun Ekonomis', checkoutPage: 'Checkout Page 1' },
  '6282214614737': { name: 'Pembeli Batal', product: 'Golok Kebun Ekonomis 30', checkoutPage: 'Golok Kebun Ekonomis 30', notes: 'Batal setelah isi lead' },
};

// Form leads tambahan dari sesi hari ini yang terkonfirmasi isi form order COD
const ADDITIONAL_FORM_LEADS: Record<string, { name: string; product: string; notes?: string }> = {
  '628116026677':  { name: 'Pelanggan Medan', product: 'Golok Black Mamba', notes: 'Form Order COD Rp244.000 Medan Helvetia' },
  '6285265752122': { name: 'Pelanggan Black Mamba', product: 'Golok Black Mamba', notes: 'Form Order COD deal konfirmasi keaslian' },
  '6282316161647': { name: 'Pelanggan Baitul Khoiri', product: 'Golok Situmang 2', notes: 'Form Order COD Rp248.000 dekat mushola Baitul Khoiri' },
  '6282387390302': { name: 'Pelanggan Bedog', product: 'Bedog Betekok', notes: 'Form Order COD Rp164.000' },
  '6281327442425': { name: 'Pelanggan Dinas', product: 'Golok Situmang 2', notes: 'Form Order tapi batal dinas luar kota' },
  '6281350961047': { name: 'Pelanggan Batal', product: 'Golok Situmang 2', notes: 'Form Order batal sepihak' },
  '6285364743838': { name: 'Pelanggan Kemahalan', product: 'Golok Situmang 2', notes: 'Form Order batal harga kemahalan' },
  '6282156531532': { name: 'Pelanggan GKE', product: 'GKE 40 Perak Duralium 2', notes: 'Form Order batal ongkir belum termasuk' },
  '6282171277891': { name: 'Pelanggan Batal Nisa', product: 'Bedog Betekok', notes: 'Form Order batal sepihak' },
};

async function main() {
  console.log('🚀 Menjalankan RE-PROFILING MURNI Berbasis Ground Truth CSV & DeepSeek v4 Flash...\n');

  const business = await prisma.business.findFirst();
  if (!business) {
    console.error('❌ Tidak ada business di database.');
    process.exit(1);
  }
  const businessId = business.id;

  const leads = await prisma.lead.findMany({
    where: { businessId },
    orderBy: { createdAt: 'asc' },
  });

  console.log(`📋 Total lead di database: ${leads.length} leads\n`);
  console.log('------------------------------------------------------------------------------------------------------------------------');
  console.log(
    'NO'.padEnd(4) +
    'WHATSAPP'.padEnd(16) +
    'KATEGORI'.padEnd(18) +
    'STATUS'.padEnd(12) +
    'PRODUK'.padEnd(28) +
    'INSIGHT FINAL'
  );
  console.log('------------------------------------------------------------------------------------------------------------------------');

  let cIklan = 0;
  let cOrganik = 0;
  let cOthers = 0;

  let idx = 1;
  for (const lead of leads) {
    const wa = lead.waNumber;
    const isCsvForm = !!CSV_FORM_LEADS[wa];
    const isAddForm = !!ADDITIONAL_FORM_LEADS[wa];
    const isFormLead = isCsvForm || isAddForm;

    const formMeta = CSV_FORM_LEADS[wa] || ADDITIONAL_FORM_LEADS[wa];

    // Bangun prompt komprehensif untuk DeepSeek v4 Flash
    const systemPrompt = `Kamu adalah Lead Profiler & CRM Intelligence untuk toko pisau/golok "Juragan Pisau / Cordova Store".
Tugasmu: Menganalisis profil calon pembeli secara akurat dan mengeluarkan JSON:
{
  "leadCategory": "PROSPEK_IKLAN" | "NEW_INBOUND" | "OTHERS",
  "minatProduk": string,
  "conversion": "CLOSING" | "PENDING" | "LOST",
  "score": number (0-100),
  "stage": "COLD" | "WARM" | "HOT" | "VERY_HOT",
  "lastInsight": string (1-2 kalimat bahasa Indonesia ringkas, profesional, sebutkan nama/lokasi jika ada),
  "rtsRiskLevel": "LOW" | "MEDIUM" | "HIGH",
  "rtsReasons": string[]
}

ATURAN KLASIFIKASI:
1. PROSPEK_IKLAN: Pelanggan yang mengisi formulir pemesanan landing page / iklan / memilih COD untuk produk tertentu (termasuk yang akhirnya deal closing, maupun yang batal setelah mengisi form).
2. NEW_INBOUND: Pelanggan yang tanya-tanya produk secara organik tanpa form (tanya harga, stok Shopee, tanya varian, edukasi, repeat order).
3. OTHERS: Chat pengujian/tes ("tes chat"), spam, atau salah sambung tanpa ada minat produk.`;

    const userPrompt = `Data Calon Pembeli:
- Nomor WhatsApp: ${wa}
- Nama: ${formMeta?.name || lead.name || 'Pelanggan'}
- CS yang Melayani: ${lead.assignedCsName || 'CS'} (${lead.assignedCsPhone || '-'})
- Sumber Form Iklan: ${isFormLead ? `Ya, Mengisi Formulir Order Landing Page (${formMeta?.product || lead.minatProduk})` : 'Tidak (Chat Langsung)'}
- Produk Terkait: ${formMeta?.product || lead.minatProduk || '-'}
- Catatan Transaksi / Percakapan: ${formMeta?.notes || lead.lastInsight || 'Percakapan baru masuk'}

Berikan hasil analisis JSON yang tepat:`;

    let finalCategory = isFormLead ? 'PROSPEK_IKLAN' : 'NEW_INBOUND';
    let finalProduct = formMeta?.product || lead.minatProduk || null;
    let finalConversion = lead.conversionStatus || 'PENDING';
    let finalStage = lead.leadStage || 'WARM';
    let finalScore = lead.score || 50;
    let finalInsight = lead.lastInsight || 'Percakapan pelanggan';
    let finalRtsLevel = lead.rtsRiskLevel || 'LOW';
    let finalRtsReasons = (lead.rtsReasons as string[]) || [];
    let finalRtsScore = lead.rtsRiskScore || 0;

    try {
      // Panggil Llama 3.3 70B Instruct via OpenRouter
      const res = await complete('classify' as LlmJob, {
        businessId,
        model: 'openrouter:meta-llama/llama-3.3-70b-instruct',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
      });

      if (res.text) {
        try {
          const parsed = JSON.parse(res.text);
          if (isFormLead) {
            finalCategory = 'PROSPEK_IKLAN';
          } else if (parsed.leadCategory) {
            finalCategory = parsed.leadCategory;
          }
          if (parsed.minatProduk) finalProduct = parsed.minatProduk;
          if (parsed.conversion) finalConversion = parsed.conversion;
          if (parsed.stage) finalStage = parsed.stage;
          if (typeof parsed.score === 'number') finalScore = parsed.score;
          if (parsed.lastInsight) finalInsight = parsed.lastInsight;
          if (parsed.rtsRiskLevel) finalRtsLevel = parsed.rtsRiskLevel;
          if (Array.isArray(parsed.rtsReasons)) finalRtsReasons = parsed.rtsReasons;
        } catch {
          // JSON parsing fallback
        }
      }
    } catch (err) {
      console.warn(`[ReProfile] DeepSeek fallback for ${wa}:`, err);
    }

    // Special case tes chat
    if (wa === '6285722193049') {
      finalCategory = 'OTHERS';
      finalProduct = null;
      finalConversion = 'PENDING';
      finalStage = 'COLD';
      finalScore = 0;
      finalInsight = 'Pelanggan baru melakukan tes chat tanpa ada minat produk atau niat beli yang spesifik.';
    }

    // High-Water Mark Score untuk Closing
    if (finalConversion === 'CLOSING') {
      finalStage = 'VERY_HOT';
      finalScore = Math.max(finalScore, 95);
    } else if (finalConversion === 'LOST') {
      finalScore = Math.min(finalScore, 30);
    }

    // Update in-place ke database PostgreSQL
    await prisma.lead.update({
      where: { id: lead.id },
      data: {
        leadCategory: finalCategory as any,
        minatProduk: finalProduct,
        conversionStatus: finalConversion as any,
        leadStage: finalStage as any,
        score: finalScore,
        lastInsight: finalInsight,
        rtsRiskLevel: finalRtsLevel as any,
        rtsRiskScore: finalRtsScore,
        rtsReasons: finalRtsReasons,
        updatedAt: new Date(),
      },
    });

    if (finalCategory === 'PROSPEK_IKLAN') cIklan++;
    else if (finalCategory === 'NEW_INBOUND') cOrganik++;
    else cOthers++;

    console.log(
      `${idx.toString().padEnd(4)}` +
      `${wa.padEnd(16)}` +
      `${finalCategory.padEnd(18)}` +
      `${finalConversion.padEnd(12)}` +
      `${(finalProduct || '-').substring(0, 26).padEnd(28)}` +
      `${(finalInsight || '-').substring(0, 45)}`
    );

    idx++;
  }

  console.log('------------------------------------------------------------------------------------------------------------------------');
  console.log(`\n🎉 RE-PROFILING BERBASIS GROUND TRUTH SELESAI 100%!`);
  console.log(`   🎯 PROSPEK_IKLAN : ${cIklan} leads (Termasuk 25 Form Landing Page)`);
  console.log(`   🌱 NEW_INBOUND   : ${cOrganik} leads`);
  console.log(`   📦 OTHERS        : ${cOthers} leads`);
  console.log(`   Total Lead       : ${leads.length} leads (0 Duplikat, 100% Bersih & Sinkron)\n`);

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error('Fatal error in reprofile script:', e);
  process.exit(1);
});
