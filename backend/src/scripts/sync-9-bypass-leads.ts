import { prisma } from '../config/prisma';

const LEADS_FIX = [
  {
    phone: '6285291735781',
    name: 'Mamat rahmat',
    product: 'Golok Black Mamba',
    category: 'PROSPEK_IKLAN',
    status: 'CLOSING',
    amount: 199000,
    csName: 'Nisa',
  },
  {
    phone: '6282176992022',
    name: 'Sigit',
    product: 'ARF | Golok Sembelih Multifungsi',
    category: 'PROSPEK_IKLAN',
    status: 'CLOSING',
    amount: 199000,
    csName: 'Nisa',
  },
  {
    phone: '6282177832183',
    name: 'Tegar pramudia',
    product: 'ARF | Golok Situmang',
    category: 'PROSPEK_IKLAN',
    status: 'CLOSING',
    amount: 192000,
    resi: '0286812600293685',
    csName: 'Nisa',
  },
  {
    phone: '6281356168900',
    name: 'Amriady Amir',
    product: 'Golok Patimura',
    category: 'PROSPEK_IKLAN',
    status: 'PENDING',
    amount: 199000,
    csName: 'Nisa',
  },
  {
    phone: '6281371767535',
    name: 'Derbi',
    product: 'Golok Situmang 3',
    category: 'PROSPEK_IKLAN',
    status: 'PENDING',
    csName: 'Nisa',
  },
  {
    phone: '6282165587189',
    name: 'Pembeli GKE P2',
    product: 'Golok Kebun Ekonomis P2',
    category: 'PROSPEK_IKLAN',
    status: 'PENDING',
    amount: 195000,
    csName: 'Nisa',
  },
  {
    phone: '6285821151845',
    name: 'Tatti',
    product: 'GKE 40 Perak Duralium 2',
    category: 'PROSPEK_IKLAN',
    status: 'PENDING',
    csName: 'Cordova Store Aluna',
  },
  {
    phone: '6285242555994',
    name: 'Nada',
    product: 'ARF | Golok Sembelih Multifungsi',
    category: 'PROSPEK_IKLAN',
    status: 'LOST',
    csName: 'Nisa',
  },
  {
    phone: '6282350409066',
    name: 'A.Siregar',
    product: 'Golok Situmang 3',
    category: 'PROSPEK_IKLAN',
    status: 'LOST',
    csName: 'Cordova Store Aluna',
  },
  {
    phone: '628137028100',
    name: 'Pembeli Golok',
    product: 'Golok Bang Jago',
    category: 'PROSPEK_IKLAN',
    status: 'CLOSING',
    amount: 243000,
    csName: 'Nisa',
  },
  {
    phone: '6285379374006',
    name: 'Pembeli Golok',
    product: 'Golok Black Mamba',
    category: 'PROSPEK_IKLAN',
    status: 'CLOSING',
    amount: 240000,
    csName: 'Nisa',
  }
];

async function main() {
  console.log('🚀 Memperbarui & Menyelaraskan Metadata 9 Lead Iklan di CRM...');

  const business = await prisma.business.findFirst();
  if (!business) throw new Error('Business not found');

  for (const item of LEADS_FIX) {
    const updateData: any = {
      name: item.name,
      minatProduk: item.product,
      leadCategory: item.category,
      conversionStatus: item.status,
    };
    if (item.amount) updateData.confirmedCodAmount = item.amount;
    if (item.resi) updateData.courierRecommendation = `JNE - ${item.resi}`;

    const res = await prisma.lead.updateMany({
      where: {
        businessId: business.id,
        waNumber: item.phone,
      },
      data: updateData,
    });

    console.log(`  ✓ Updated ${item.name} (${item.phone}): Cat=${item.category}, Status=${item.status}, Prod=${item.product} (affected: ${res.count})`);
  }

  console.log('🎉 Selesai memperbarui metadata lead!');
}

main().catch(console.error).finally(() => prisma.$disconnect());
