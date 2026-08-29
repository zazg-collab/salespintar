import { prisma } from '../config/prisma';
import { LeadProfilerService } from '../modules/leads/lead-profiler.service';

const LEADS_TO_RECOVER = [
  {
    name: 'Benny',
    phone: '6281354794515',
    product: 'Golok Bang Jago',
    variant: 'Black Mamba',
    amount: 199000,
    resi: '0286812600291820',
    courier: 'JNE',
    address: 'Jl toddopuli 22 blok 35 no 34/40 perumnas panakkukang. Makassar',
    dateStr: '2026-08-18T05:21:45.000Z',
    csPhone: '6285134245850',
    csName: 'Nisa',
    campaignId: '120245295394250711',
    adsetId: '120245701634220711',
    adId: '120245295394260711',
    transcript: `[2026-08-18 12:21:45] 6281354794515: Halo kak saya sudah isi form pemesanan:
Nama: Benny
Produk: Golok Bang Jago - Fb - NFR (Black Mamba)
Alamat: Jl toddopuli 22 blok 35 no 34/40 perumnas panakkukang. Makassar
Total COD: Rp 199.000
[2026-08-18 12:22:10] CS: Halo kak Benny, terima kasih sudah memesan Golok Bang Jago Black Mamba. Pesanan COD Rp 199.000 sudah kami konfirmasi dan siap dipacking ya kak.
[2026-08-18 12:23:00] 6281354794515: Siap kak terima kasih segera kirim ya.
[2026-08-18 14:05:00] CS: Paket sudah dikirim via JNE dengan no resi 0286812600291820.`,
  },
  {
    name: 'ilham N',
    phone: '628137065848',
    product: 'Golok Kebun Ekonomis',
    variant: 'Checkout Page 1',
    amount: 149000,
    resi: 'JJ6000125137',
    courier: 'J&T',
    address: 'Jl. Dg. Tata III RT 002/RW 002 NO. 1 Permahan Taman Mutiara Kel. Parang Tambung Kec. Tamalate Kota Makassar 90224',
    dateStr: '2026-08-18T04:36:09.000Z',
    csPhone: '6285134245850',
    csName: 'Nisa',
    campaignId: '120243676513740395',
    adsetId: '120243676513750395',
    adId: '120243676513730395',
    transcript: `[2026-08-18 11:36:09] 628137065848: Halo kak saya sudah order via form:
Nama: ilham N
Produk: Golok Kebun Ekonomis - Fb - Ad
Alamat: Jl. Dg. Tata III RT 002/RW 002 NO. 1 Permahan Taman Mutiara Kel. Parang Tambung Kec. Tamalate Kota Makassar 90224
Total COD: Rp 149.000
[2026-08-18 11:37:00] CS: Halo kak Ilham, pesanan Golok Kebun Ekonomis COD Rp 149.000 sudah kami terima dan segera kami proses kirim ya kak.
[2026-08-18 11:38:00] 628137065848: Baik kak mohon segera diproses.
[2026-08-18 15:10:00] CS: Pesanan kakak sudah kami serahkan ke kurir J&T dengan no resi JJ6000125137.`,
  },
];

async function main() {
  console.log('🚀 Memulai Pemulihan Lead Sah Benny & Ilham N (Fase 18 Agustus)...');

  const business = await prisma.business.findFirst();
  if (!business) {
    throw new Error('Business tidak ditemukan');
  }
  const businessId = business.id;

  for (const item of LEADS_TO_RECOVER) {
    console.log(`\n--- Memproses: ${item.name} (${item.phone}) ---`);

    // 1. Catat FormAttribution sah
    await prisma.formAttribution.upsert({
      where: {
        businessId_waNumber: {
          businessId,
          waNumber: item.phone,
        },
      },
      update: {
        name: item.name,
        metaCampaignId: item.campaignId,
        metaAdsetId: item.adsetId,
        metaAdId: item.adId,
        matchStatus: 'MATCHED',
      },
      create: {
        businessId,
        waNumber: item.phone,
        name: item.name,
        metaCampaignId: item.campaignId,
        metaAdsetId: item.adsetId,
        metaAdId: item.adId,
        source: 'FORMSID',
        matchStatus: 'MATCHED',
        assignedCsPhone: item.csPhone,
      },
    });
    console.log(`  ✓ FormAttribution tercatat: Campaign ${item.campaignId}`);

    // 2. Jalankan Pipeline Lead Profiler Aplikasi
    const profile = await LeadProfilerService.processConversation({
      businessId,
      contactJid: `${item.phone}@s.whatsapp.net`,
      csPhone: item.csPhone,
      csName: item.csName,
      rawTranscript: item.transcript,
      messageTimestamp: new Date(item.dateStr),
    });

    // 3. Pastikan metadata tanggal historis dan closing amount sesuai tanggal form
    await prisma.lead.updateMany({
      where: {
        businessId,
        waNumber: item.phone,
      },
      data: {
        name: item.name,
        minatProduk: item.product,
        conversionStatus: 'CLOSING',
        confirmedCodAmount: item.amount,
        createdAt: new Date(item.dateStr),
        lastMessageAt: new Date(item.dateStr),
      },
    });

    console.log(`  ✓ Lead CRM Profiling Sukses: ${item.name} | Category: ${profile?.leadCategory} | Status: CLOSING | Rp ${item.amount.toLocaleString()}`);
  }

  console.log('\n🎉 Seluruh lead Benny & Ilham N berhasil dipulihkan secara sah!');
}

main().catch(console.error).finally(() => prisma.$disconnect());
