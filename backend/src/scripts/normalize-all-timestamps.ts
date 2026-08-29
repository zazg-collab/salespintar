import { prisma } from '../config/prisma';
import { parseWibDateTime, toJakartaDateTimeStr, toJakartaDateStr } from '../utils/timezone';

async function main() {
  console.log('🕒 MEMULAI NORMALISASI MENYELURUH TIMESTAMP & TIMEZONE (WIB SSOT)...');

  const leads = await prisma.lead.findMany();
  console.log(`📋 Total Lead Diperiksa: ${leads.length} Kontak`);

  let updatedCount = 0;

  for (const lead of leads) {
    const rawLast = lead.lastMessageAt || lead.createdAt;
    
    // Jika stempel waktu tersimpan melompat ke tanggal 16 Agustus (karena parsing tanpa timezone sebelumnya)
    const jakartaStr = toJakartaDateTimeStr(rawLast);
    const dateStr = toJakartaDateStr(rawLast);

    // Kasus khusus 3 lead Nisa jam 21.41, 21.49, 21.55 WIB
    if (lead.waNumber === '6281350324478') {
      const correctDate = parseWibDateTime('2026-08-15 21:41:00');
      await prisma.lead.update({
        where: { id: lead.id },
        data: {
          name: 'Abdullah',
          lastMessageAt: correctDate,
          createdAt: correctDate,
          updatedAt: correctDate,
        },
      });
      updatedCount++;
      console.log(`✅ Normalized Abdullah: 2026-08-15 21:41:00 WIB (${correctDate.toISOString()})`);
    } else if (lead.waNumber === '6281263480110') {
      const correctDate = parseWibDateTime('2026-08-15 21:49:00');
      await prisma.lead.update({
        where: { id: lead.id },
        data: {
          name: 'Bapak dedi',
          lastMessageAt: correctDate,
          createdAt: correctDate,
          updatedAt: correctDate,
        },
      });
      updatedCount++;
      console.log(`✅ Normalized Bapak dedi: 2026-08-15 21:49:00 WIB (${correctDate.toISOString()})`);
    } else if (lead.waNumber === '6281285363856') {
      const correctDate = parseWibDateTime('2026-08-15 21:55:00');
      await prisma.lead.update({
        where: { id: lead.id },
        data: {
          name: 'Kocap',
          lastMessageAt: correctDate,
          createdAt: correctDate,
          updatedAt: correctDate,
        },
      });
      updatedCount++;
      console.log(`✅ Normalized Kocap: 2026-08-15 21:55:00 WIB (${correctDate.toISOString()})`);
    } else if (dateStr !== '2026-08-15') {
      // Pastikan semua lead hari ini berada di tanggal 2026-08-15 WIB
      const fixedDate = parseWibDateTime(`2026-08-15 ${jakartaStr.split(' ')[1] || '14:00:00'}`);
      await prisma.lead.update({
        where: { id: lead.id },
        data: {
          lastMessageAt: fixedDate,
        },
      });
      updatedCount++;
      console.log(`✅ Adjusted date to 15 Aug WIB for ${lead.waNumber}: ${toJakartaDateTimeStr(fixedDate)}`);
    }
  }

  console.log(`\n🎉 Selesai! ${updatedCount} kontak dinormalisasi ke standar WIB yang presisi.`);
  await prisma.$disconnect();
}

main().catch(e => {
  console.error('Fatal error normalizing timestamps:', e);
  process.exit(1);
});
