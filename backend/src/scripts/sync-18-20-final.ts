import fs from 'fs';
import { prisma } from '../config/prisma';
import { LeadProfilerService } from '../modules/leads/lead-profiler.service';
import { redisCache } from '../config/redis';

const businessId = '777779f9-6955-4b0d-95cd-84595bb34eb4';

function parseCsv(filepath: string) {
  if (!fs.existsSync(filepath)) return [];
  const text = fs.readFileSync(filepath, 'utf8');
  const lines = text.split('\n');
  const results = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    let inQuotes = false;
    let field = '';
    const fields = [];
    for (let c = 0; c < line.length; c++) {
      const char = line[c];
      if (char === '"') inQuotes = !inQuotes;
      else if (char === ',' && !inQuotes) { fields.push(field); field = ''; }
      else { field += char; }
    }
    fields.push(field);
    
    let s = fields[6] ? fields[6].replace(/\D/g, '') : '';
    if (s.startsWith('08')) s = '628' + s.substring(2);
    else if (s.startsWith('8')) s = '628' + s.substring(1);
    
    if (s.length >= 10) {
      results.push({ phone: s, fields });
    }
  }
  return results;
}

async function main() {
  console.log('--- FINAL SINKRONISASI 54 ORANG (18-20) KE LIVE DB ---');
  
  const csv9 = parseCsv('/app/dist/data-9.csv');
  const csv10 = parseCsv('/app/dist/data-10.csv');
  const allCsv = [...csv9, ...csv10];

  const startDate = new Date('2026-08-18T00:00:00Z');
  const endDate = new Date('2026-08-20T23:59:59Z');

  let successCount = 0;

  for (const row of allCsv) {
    const phone = row.phone;
    const fields = row.fields;
    
    const lead = await prisma.lead.findFirst({
      where: {
        waNumber: phone,
        createdAt: { gte: startDate, lte: endDate }
      }
    });

    if (!lead) continue;

    // Create FormAttribution
    await prisma.formAttribution.create({
      data: {
        businessId: lead.businessId,
        waNumber: phone,
        name: fields[4] || null,
        fbp: fields[43] || null,
        fbc: fields[45] || null,
        clientUserAgent: null,
        clientIp: null,
        eventSourceUrl: fields[50] || null,
        productName: fields[3] || null,
        status: 'MATCHED',
        matchedLeadId: lead.id,
        matchedAt: new Date()
      }
    });

    // Update Lead Data
    await prisma.lead.update({
      where: { id: lead.id },
      data: {
        minatProduk: fields[3] || undefined,
        name: fields[4] || undefined,
        leadCategory: 'PROSPEK_IKLAN'
      }
    });

    // Jalankan Reprofiling (AI)
    const keys = await redisCache.keys(`hl:full_history:${lead.businessId}:*:${lead.waNumber}@s.whatsapp.net`);
    if (keys.length > 0) {
      const csPhoneMatch = keys[0].split(':')[3];
      const history = await redisCache.lrange(keys[0], 0, -1);
      
      const hashKeys = await redisCache.keys(`hl:last_profile_hash:${lead.businessId}:${csPhoneMatch}:${lead.waNumber}`);
      for (const hk of hashKeys) await redisCache.del(hk);

      const transcriptStr = history.join('\n');
      const analysis: any = await LeadProfilerService.processConversation({
        businessId: lead.businessId,
        contactJid: `${lead.waNumber}@s.whatsapp.net`,
        csPhone: csPhoneMatch,
        csName: lead.assignedCsName || 'CS',
        rawTranscript: transcriptStr,
        messageTimestamp: lead.createdAt
      });

      if (analysis) {
        await prisma.lead.update({
          where: { id: lead.id },
          data: {
            leadCategory: 'PROSPEK_IKLAN',
            lastInsight: analysis.shortInsight || analysis.insight
          }
        });
      }
    }
    
    successCount++;
    console.log(`[OK] Disinkronisasi & Di-Profil Ulang: ${phone} -> ${fields[3]}`);
  }

  console.log(`\nSELESAI. Berhasil menyinkronkan ${successCount} Leads Valid ke Live DB!`);
}

main().catch(console.error).finally(async () => {
  await prisma.$disconnect();
  process.exit(0);
});
