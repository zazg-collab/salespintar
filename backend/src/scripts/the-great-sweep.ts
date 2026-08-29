import fs from 'fs';
import { prisma } from '../config/prisma';
import { LeadProfilerService } from '../modules/leads/lead-profiler.service';
import { redisCache, waitForRedisReady } from '../config/redis';

const businessId = '777779f9-6955-4b0d-95cd-84595bb34eb4';

function parseCsv(content: string) {
  const lines = content.split('\n').filter(line => line.trim().length > 0);
  if (lines.length < 2) return [];
  const headers = lines[0].split(',').map(h => h.trim());
  const results: any[] = [];
  
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    const cols: string[] = [];
    let curr = '';
    let inQuotes = false;
    for (let j = 0; j < line.length; j++) {
      if (line[j] === '"') {
        inQuotes = !inQuotes;
      } else if (line[j] === ',' && !inQuotes) {
        cols.push(curr.trim());
        curr = '';
      } else {
        curr += line[j];
      }
    }
    cols.push(curr.trim());
    
    // Ignore lines that are totally malformed, but if it has enough columns, proceed
    const obj: any = {};
    headers.forEach((h, idx) => {
      obj[h] = cols[idx] || '';
    });
    results.push(obj);
  }
  return results;
}

async function processFormsIdCsv(filePath: string) {
  if (!fs.existsSync(filePath)) {
    console.log("[CSV] File tidak ada: " + filePath);
    return;
  }
  const content = fs.readFileSync(filePath, 'utf-8');
  const cleanContent = content.charCodeAt(0) === 0xFEFF ? content.slice(1) : content;
  
  const records = parseCsv(cleanContent);
  let count = 0;
  for (const row of records) {
    let phone = row.phone || '';
    if (phone.startsWith('0')) phone = '62' + phone.slice(1);
    phone = phone.replace(/\D/g, '');
    if (!phone) continue;

    let createdAt = new Date(row.created_at);
    if (isNaN(createdAt.getTime())) {
      createdAt = new Date();
    }
    
    await prisma.formAttribution.create({
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
    count++;
  }
  console.log(`[CSV] Disimpan ${count} baris dari ${filePath}`);
}

async function runRecovery() {
  await waitForRedisReady(redisCache, 'cache');
  
  console.log("=== STEP 0: Wiping Slate Clean ===");
  await prisma.formAttribution.deleteMany({});
  await prisma.lead.deleteMany({});
  console.log("[Wipe] leads dan form_attributions dibersihkan total.");

  console.log("\n=== STEP 1: Injeksi Webhook CSV (21 & 22 Agustus) ===");
  await processFormsIdCsv('/app/dist/data-8.csv'); // Tgl 21
  await processFormsIdCsv('/app/dist/data-7.csv'); // Tgl 21
  await processFormsIdCsv('/app/dist/data-6.csv'); // Tgl 22
  await processFormsIdCsv('/app/dist/data-5.csv'); // Tgl 22

  console.log("\n=== STEP 2 & 3: The Great Sweep (Redis Forensics & Reprofiling) ===");
  const keys = await redisCache.keys(`hl:full_history:${businessId}:*`);
  console.log(`Menemukan ${keys.length} transkrip di Redis. Akan diproses sekuensial (anti-rate limit)...`);
  
  let i = 1;
  for (const key of keys) {
    const parts = key.split(':');
    if (parts.length < 5) continue;
    const csPhone = parts[3];
    const contactJid = parts[4];
    const waNumber = contactJid.split('@')[0];
    
    const history = await redisCache.lrange(key, 0, -1);
    if (history.length === 0) continue;
    
    let createdAt = new Date();
    const firstLine = history[0];
    const matchFirst = firstLine.match(/\[(BUYER|CS) (\d+)\]/);
    if (matchFirst) createdAt = new Date(parseInt(matchFirst[2], 10));

    let lastMessageAt = new Date();
    const lastLine = history[history.length - 1];
    const matchLast = lastLine.match(/\[(BUYER|CS) (\d+)\]/);
    if (matchLast) lastMessageAt = new Date(parseInt(matchLast[2], 10));

    const lead = await prisma.lead.upsert({
      where: { businessId_waNumber: { businessId, waNumber } },
      create: {
        businessId,
        waNumber,
        assignedCsPhone: csPhone,
        assignedCsName: 'CS',
        leadCategory: 'NEW_INBOUND',
        conversionStatus: 'PENDING',
        score: 0,
        leadStage: 'COLD',
        createdAt,
        lastMessageAt,
        totalMessages: history.length,
        minatProduk: null,
      },
      update: {} 
    });

    const attribution = await prisma.formAttribution.findFirst({
      where: { businessId, waNumber, status: 'PENDING_MATCH' }
    });

    let cat = 'NEW_INBOUND';
    let prod = null;
    if (attribution) {
      await prisma.$transaction([
        prisma.lead.update({
          where: { id: lead.id },
          data: {
            fbp: attribution.fbp || undefined,
            fbc: attribution.fbc || undefined,
            clientUserAgent: attribution.clientUserAgent || undefined,
            clientIp: attribution.clientIp || undefined,
            eventSourceUrl: attribution.eventSourceUrl || undefined,
            minatProduk: attribution.productName || undefined,
            leadCategory: 'PROSPEK_IKLAN'
          }
        }),
        prisma.formAttribution.update({
          where: { id: attribution.id },
          data: {
            status: 'MATCHED',
            matchedLeadId: lead.id,
            matchedAt: new Date(),
          }
        })
      ]);
      cat = 'PROSPEK_IKLAN';
      prod = attribution.productName;
      console.log(`[${i}/${keys.length}] ${waNumber} -> MATCHED as PROSPEK_IKLAN (${prod})`);
    } else {
      console.log(`[${i}/${keys.length}] ${waNumber} -> ORGANIC (${cat})`);
    }

    const transcriptStr = history.join('\n');
    try {
      const analysis = await LeadProfilerService.processConversation({
        businessId,
        contactJid,
        csPhone,
        csName: 'CS',
        rawTranscript: transcriptStr,
        messageTimestamp: createdAt
      });

      if (analysis) {
        await prisma.lead.update({
          where: { id: lead.id },
          data: {
            conversionStatus: analysis.conversion || 'PENDING',
            score: analysis.rawScore || 0,
            leadStage: analysis.stage || 'COLD',
            lastInsight: analysis.lastInsight || '',
            rtsRiskScore: analysis.rtsRiskScore || 0,
            rtsRiskLevel: analysis.rtsRiskLevel || 'LOW',
            rtsReasons: analysis.rtsReasons || [],
            courierRecommendation: analysis.courierRecommendation || null,
            objectionType: analysis.objectionType || null,
            taktikCS: analysis.taktikCS || null,
            draftWA: analysis.draftWA || null,
            confirmedCodAmount: analysis.confirmedCodAmount || null
          }
        });
        console.log(`   └─> Reprofile Sukses: Status [${analysis.conversion}]`);
      }
    } catch (err: any) {
      console.error(`   └─> Gagal Reprofile:`, err.message);
    }
    i++;
  }

  console.log("\n=== THE GREAT SWEEP COMPLETE ===");
  process.exit(0);
}

runRecovery();
