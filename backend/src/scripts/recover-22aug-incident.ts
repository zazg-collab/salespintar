import fs from 'fs';
import { prisma } from '../config/prisma';
import { LeadProfilerService } from '../modules/leads/lead-profiler.service';
import { redisCache, waitForRedisReady } from '../config/redis';

const businessId = '777779f9-6955-4b0d-95cd-84595bb34eb4';

function parseCsv(content: string) {
  const lines = content.split('\n').filter(line => line.trim().length > 0);
  if (lines.length < 2) return [];
  const headers = lines[0].split(',').map(h => h.trim());
  const results = [];
  
  for (let i = 1; i < lines.length; i++) {
    const regex = /(".*?"|[^",\s]+)(?=\s*,|\s*$)/g;
    const values = [];
    let match;
    while ((match = regex.exec(lines[i])) !== null) {
      values.push(match[1].replace(/^"|"$/g, ''));
    }
    let cols = values;
    if (values.length < headers.length - 2) {
       cols = lines[i].split(',');
    }
    if (cols.length < headers.length) continue;
    
    const obj: any = {};
    headers.forEach((h, idx) => {
      obj[h] = cols[idx];
    });
    results.push(obj);
  }
  return results;
}

async function processFormsIdCsv(filePath: string) {
  if (!fs.existsSync(filePath)) return;
  const content = fs.readFileSync(filePath, 'utf-8');
  const cleanContent = content.charCodeAt(0) === 0xFEFF ? content.slice(1) : content;
  
  const records = parseCsv(cleanContent);

  for (const row of records) {
    let phone = row.phone || '';
    if (phone.startsWith('0')) phone = '62' + phone.slice(1);
    phone = phone.replace(/\D/g, '');
    if (!phone) continue;

    const createdAt = new Date(row.created_at);
    
    const attribution = await prisma.formAttribution.create({
      data: {
        businessId,
        waNumber: phone,
        name: row.name || null,
        fbp: row.fbp || null,
        fbc: row.fbc || null,
        clientUserAgent: row.client_user_agent || null,
        clientIp: row.client_ip || null,
        eventSourceUrl: row.checkout_page_name || null,
        productName: row.product || null,
        status: 'PENDING_MATCH',
        createdAt: createdAt
      }
    });

    const existingLead = await prisma.lead.findFirst({
      where: { businessId, waNumber: phone }
    });

    if (existingLead) {
      await prisma.$transaction([
        prisma.lead.update({
          where: { id: existingLead.id },
          data: {
            fbp: attribution.fbp || undefined,
            fbc: attribution.fbc || undefined,
            clientUserAgent: attribution.clientUserAgent || undefined,
            clientIp: attribution.clientIp || undefined,
            eventSourceUrl: attribution.eventSourceUrl || undefined,
            minatProduk: row.product || undefined,
            leadCategory: 'PROSPEK_IKLAN'
          }
        }),
        prisma.formAttribution.update({
          where: { id: attribution.id },
          data: {
            status: 'MATCHED',
            matchedLeadId: existingLead.id,
            matchedAt: new Date(),
          }
        })
      ]);
      console.log(`[Webhook] Matched forms.id for ${phone}`);
    } else {
      console.log(`[Webhook] Saved forms.id for ${phone} (Pending Match)`);
    }
  }
}

async function runRecovery() {
  await waitForRedisReady(redisCache, 'cache');
  console.log("=== STEP 1: Injeksi Webhook CSV ===");
  await processFormsIdCsv('/opt/salespintar/backend/data-6.csv');
  await processFormsIdCsv('/opt/salespintar/backend/data-5.csv');

  console.log("\n=== STEP 2 & 3: Redis Forensics & Reprofiling ===");
  const keys = await redisCache.keys(`hl:full_history:${businessId}:*`);
  
  for (const key of keys) {
    const parts = key.split(':');
    if (parts.length < 5) continue;
    const csPhone = parts[3];
    const contactJid = parts[4];
    const waNumber = contactJid.split('@')[0];
    
    const history = await redisCache.lrange(key, 0, -1);
    if (history.length === 0) continue;
    
    const firstLine = history[0];
    const match = firstLine.match(/\[(BUYER|CS) (\d+)\]/);
    if (match) {
      const timestamp = parseInt(match[2], 10);
      const createdAt = new Date(timestamp);
      
      const lead = await prisma.lead.findFirst({ where: { businessId, waNumber } });
      if (lead) {
        await prisma.lead.update({
          where: { id: lead.id },
          data: { createdAt }
        });
        console.log(`[TimeFix] Koreksi Tgl Masuk ${waNumber} -> ${createdAt.toISOString()}`);
        
        console.log(`[Reprofiling] Menjalankan AI Profiler untuk ${waNumber}...`);
        const transcriptStr = history.join('\n');
        try {
          await LeadProfilerService.processConversation({
            businessId,
            contactJid,
            csPhone,
            csName: lead.assignedCsName || 'CS',
            rawTranscript: transcriptStr,
            messageTimestamp: createdAt
          });
          console.log(`[Reprofiling] Berhasil diproses AI: ${waNumber}`);
        } catch (err: any) {
          console.error(`[Reprofiling] Gagal untuk ${waNumber}:`, err.message);
        }
      }
    }
  }

  console.log("\n=== RECOVERY COMPLETE ===");
  process.exit(0);
}

runRecovery();
