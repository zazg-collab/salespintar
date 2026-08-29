import * as fs from 'fs';
import { prisma } from '../config/prisma';
import { FormsidWebhookService } from '../modules/integrations/formsid/formsid.webhook.service';
import { redisCache } from '../config/redis';
import { LeadProfilerService } from '../modules/leads/lead-profiler.service';

function parseCsvFull(filepath: string) {
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
  console.log('--- SINKRONISASI DATA FORMS.ID & REPROFILING (18-20 AGUSTUS) ---');
  
  // 1. Ambil CSV dan masukkan ke Webhook Service
  const csv9 = parseCsvFull('/app/dist/data-9.csv');
  const csv10 = parseCsvFull('/app/dist/data-10.csv');
  const allCsv = [...csv9, ...csv10];
  
  const businessId = '1e37039c-76e9-4171-aa3b-82542e7de4df';

  console.log(`\nMenyuntikkan ${allCsv.length} data CSV ke Webhook...`);
  for (const row of allCsv) {
    const fields = row.fields;
    try {
      await FormsidWebhookService.handleOrderWebhook(businessId, {
        order_id: fields[0],
        device_id: fields[2],
        product: fields[3],
        name: fields[4],
        phone: fields[6],
        address: fields[7],
        province: fields[8],
        city: fields[9],
        subdistrict: fields[11],
        gross_revenue: fields[34],
        utm_campaign: fields[43],
        utm_source: fields[45],
        tags: fields[48]
      });
    } catch (e) {
      // ignore dupes
    }
  }

  // 2. Reprofiling untuk 54 orang yang Match (53 TP + 1 FN)
  const csvPhones = new Set(allCsv.map(r => r.phone));
  
  const startDate = new Date('2026-08-18T00:00:00Z');
  const endDate = new Date('2026-08-20T23:59:59Z');
  const leads = await prisma.lead.findMany({ 
    where: { 
      createdAt: { gte: startDate, lte: endDate },
      waNumber: { in: Array.from(csvPhones) }
    } 
  });

  console.log(`\nMemproses ${leads.length} leads untuk update Nama, Produk, Status & Insight...`);

  let count = 0;
  for (const lead of leads) {
    count++;
    // Cari history di redis
    const keys = await redisCache.keys(`hl:full_history:${lead.businessId}:*:${lead.waNumber}@s.whatsapp.net`);
    if (keys.length === 0) continue;
    
    const history = await redisCache.lrange(keys[0], 0, -1);
    if (!history || history.length === 0) continue;

    const transcriptStr = history.join('\n');
    const csPhoneMatch = keys[0].split(':')[3];

    // Buka gembok hash
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
        await prisma.lead.update({
          where: { id: lead.id },
          data: { 
            leadCategory: analysis.leadCategory,
            lastInsight: analysis.shortInsight
          }
        });
        console.log(`[${count}/${leads.length}] ${lead.waNumber} -> Updated as ${analysis.leadCategory} + AI Insight`);
      }
    } catch (e) {
      console.log(`[${count}] Error:`, e);
    }
  }

  console.log('\n--- PROSES SELESAI ---');
}

main().catch(console.error).finally(() => prisma.$disconnect());
