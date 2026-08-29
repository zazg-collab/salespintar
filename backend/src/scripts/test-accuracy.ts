import { prisma } from '../config/prisma';
import { redisCache } from '../config/redis';
import { LeadProfilerService } from '../modules/leads/lead-profiler.service';

async function main() {
  console.log('--- UJI VALIDASI SISTEM SALES PINTAR (18-20 AGUSTUS) ---');
  
  // 1. Ambil lead tanggal 18-20
  const startDate = new Date('2026-08-18T00:00:00Z');
  const endDate = new Date('2026-08-20T23:59:59Z');
  
  const targetLeads = await prisma.lead.findMany({
    where: {
      createdAt: { gte: startDate, lte: endDate }
    }
  });
  console.log(`Ditemukan ${targetLeads.length} leads pada 18-20 Agustus.`);

  let prospekIklanCount = 0;
  let newInboundCount = 0;
  let othersCount = 0;

  for (let i = 0; i < targetLeads.length; i++) {
    const lead = targetLeads[i];
    
    // Cari history di redis
    const keys = await redisCache.keys(`hl:full_history:${lead.businessId}:*:${lead.waNumber}@s.whatsapp.net`);
    if (keys.length === 0) continue;
    
    const history = await redisCache.lrange(keys[0], 0, -1);
    if (!history || history.length === 0) continue;

    const transcriptStr = history.join('\n');
    const csPhoneMatch = keys[0].split(':')[3];

    // Hapus hash agar tidak skip
    const hashKeys = await redisCache.keys(`hl:last_profile_hash:${lead.businessId}:${csPhoneMatch}:${lead.waNumber}`);
    for (const hk of hashKeys) {
      await redisCache.del(hk);
    }

    try {
      const analysis = await LeadProfilerService.processConversation({
        businessId: lead.businessId,
        contactJid: `${lead.waNumber}@s.whatsapp.net`,
        csPhone: csPhoneMatch,
        csName: lead.assignedCsName || 'CS',
        rawTranscript: transcriptStr,
        messageTimestamp: lead.createdAt
      });

      if (analysis) {
        if (analysis.leadCategory === 'PROSPEK_IKLAN') prospekIklanCount++;
        else if (analysis.leadCategory === 'NEW_INBOUND') newInboundCount++;
        else othersCount++;

        await prisma.lead.update({
          where: { id: lead.id },
          data: { leadCategory: analysis.leadCategory }
        });
        
        console.log(`[${i+1}/${targetLeads.length}] ${lead.waNumber} -> ${analysis.leadCategory}`);
      }
    } catch (e) {
      console.log(`[${i+1}] Error:`, e);
    }
  }

  console.log('\n--- HASIL ANALISIS NATIVE SISTEM SALES PINTAR ---');
  console.log(`PROSPEK_IKLAN : ${prospekIklanCount}`);
  console.log(`NEW_INBOUND   : ${newInboundCount}`);
  console.log(`OTHERS        : ${othersCount}`);
  console.log('Silakan berikan file Forms.id untuk dicocokkan!');
}

main().catch(console.error).finally(async () => {
  await prisma.$disconnect();
  process.exit(0);
});
