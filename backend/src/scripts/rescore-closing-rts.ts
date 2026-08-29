import { prisma } from '../config/prisma';

// Audit Faktual Seluruh 17 Closing Leads
const AUDIT_CLOSINGS_RTS: Record<string, { level: 'LOW' | 'MEDIUM'; score: number; reasons: string[]; name?: string }> = {
  // CS Aluna (14 Leads)
  '628126338314':  { level: 'LOW', score: 0, reasons: ['SOP percakapan CS terpenuhi & data alamat lengkap (Kampung Lalang, Patokan Depan Mesjid)'], name: 'Bambang' },
  '6285265752122': { level: 'LOW', score: 0, reasons: ['SOP percakapan CS terpenuhi & data alamat lengkap (Dayun Siak RT/RW 004/002, Patokan Masjid Mutmainnah pagar hitam)'], name: 'Tumadi' },
  '6282164808354': { level: 'LOW', score: 0, reasons: ['SOP percakapan CS terpenuhi & data alamat lengkap (Dusun Parsaguan, Patokan SD Inpres)'], name: 'Dame' },
  '6281294968339': { level: 'LOW', score: 0, reasons: ['SOP percakapan CS terpenuhi & komitmen COD disepakati'], name: 'Enday' },
  '6282286094493': { level: 'LOW', score: 0, reasons: ['SOP percakapan CS terpenuhi & data alamat Bone Sulsel lengkap'], name: 'Usman' },
  '6283846463146': { level: 'LOW', score: 0, reasons: ['SOP percakapan CS terpenuhi & data alamat Lampung Selatan lengkap'], name: 'Ustdz. Endang' },
  '628116026677':  { level: 'LOW', score: 0, reasons: ['SOP percakapan CS terpenuhi & data alamat Medan Helvetia lengkap'], name: 'Pelanggan Mamba' },
  '6281255562013': { level: 'LOW', score: 0, reasons: ['SOP percakapan CS terpenuhi & data alamat Kotawaringin lengkap'], name: 'Ronigustiawan' },
  '6281268828875': { level: 'LOW', score: 0, reasons: ['SOP percakapan CS terpenuhi & data alamat Paluta lengkap'], name: 'Sukoco' },
  '6281275856293': { level: 'LOW', score: 0, reasons: ['SOP percakapan CS terpenuhi & data alamat Bengkalis Riau lengkap'], name: 'Yulizar' },
  '6282311251193': { level: 'LOW', score: 0, reasons: ['SOP percakapan CS terpenuhi & data alamat Inhil Riau lengkap'], name: 'Wak Endek' },
  '6283865292907': { level: 'LOW', score: 0, reasons: ['SOP percakapan CS terpenuhi & komitmen COD disepakati'], name: 'Pelanggan Situmang' },
  '6287833219167': { level: 'LOW', score: 0, reasons: ['SOP percakapan CS terpenuhi & data alamat Banjarmasin lengkap'], name: 'Haris Santo' },
  '6281267033010': { level: 'MEDIUM', score: 35, reasons: ['Alamat belum dilengkapi patokan rumah atau nomor RT/RW spesifik'], name: 'To.harmoni' },

  // CS Nisa (3 Leads)
  '6282316161647': { level: 'LOW', score: 0, reasons: ['SOP percakapan CS terpenuhi & data alamat Baitul Khoiri lengkap'] },
  '6282387390302': { level: 'LOW', score: 0, reasons: ['SOP percakapan CS terpenuhi & komitmen COD disepakati'] },
  '6285213734621': { level: 'LOW', score: 0, reasons: ['SOP percakapan CS terpenuhi & komitmen COD disepakati'] },
};

async function main() {
  console.log('🛡️ MENJALANKAN AUDIT & NORMALISASI RTS RISK LEVEL UNTUK 17 CLOSING LEADS...');

  const leads = await prisma.lead.findMany({
    where: { conversionStatus: 'CLOSING' },
  });

  console.log(`📋 Total Closing Leads Ditemukan: ${leads.length} Kontak`);

  let count = 0;
  for (const lead of leads) {
    const audit = AUDIT_CLOSINGS_RTS[lead.waNumber];
    if (audit) {
      await prisma.lead.update({
        where: { id: lead.id },
        data: {
          rtsRiskLevel: audit.level,
          rtsRiskScore: audit.score,
          rtsReasons: audit.reasons,
          name: audit.name || lead.name || undefined,
        },
      });
      count++;
      console.log(`✅ [${audit.level}] ${lead.waNumber} (${lead.assignedCsName}) -> Score: ${audit.score}% | ${audit.reasons[0]}`);
    }
  }

  console.log(`\n🎉 Audit RTS Selesai! ${count} closing leads berhasil diperbarui.`);
  await prisma.$disconnect();
}

main().catch(e => {
  console.error('Fatal error in RTS audit update:', e);
  process.exit(1);
});
