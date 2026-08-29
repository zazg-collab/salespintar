import { prisma } from '../config/prisma';
import { LeadProfilerService } from '../modules/leads/lead-profiler.service';

const NISA_NEW_LEADS = [
  {
    name: 'Abdullah',
    phone: '6281350324478',
    product: 'Golok Kebun Ekonomis 30',
    tag: 'Golok Kebun Ekonomis 30 - Fb - NFR - 2',
    dateStr: '2026-08-15 21:41:00',
  },
  {
    name: 'Bapak dedi',
    phone: '6281263480110',
    product: 'Golok Black Mamba',
    tag: 'Golok Black Mamba - Fb - NFR',
    dateStr: '2026-08-15 21:49:00',
  },
  {
    name: 'Kocap',
    phone: '6281285363856',
    product: 'GKE 40 Perak Duralium 2',
    tag: 'GKE 40 Perak Duralium 2 - Fb - NFR',
    dateStr: '2026-08-15 21:55:00',
  },
];

async function main() {
  console.log('🚀 Memulihkan 3 Lead Iklan CS Nisa ke Database CRM...');

  const business = await prisma.business.findFirst();
  if (!business) {
    console.error('❌ Tidak ada business');
    process.exit(1);
  }
  const businessId = business.id;

  for (const item of NISA_NEW_LEADS) {
    const rawTranscript = `[${item.dateStr}] ${item.phone}: Halo kak saya sudah melakukan pemesanan via form:\nNama: ${item.name}\nProduk: ${item.tag}\nMohon diproses ya kak.`;

    const profile = await LeadProfilerService.processConversation({
      businessId,
      contactJid: `${item.phone}@s.whatsapp.net`,
      csPhone: '6285134245850',
      csName: 'Nisa',
      rawTranscript,
      messageTimestamp: new Date(item.dateStr),
    });

    console.log(`✅ Sukses memulihkan lead: ${item.name} (${item.phone}) -> ${profile?.leadCategory} [${profile?.conversion}]`);
  }

  console.log('🎉 Pemulihan selesai!');
  await prisma.$disconnect();
}

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
