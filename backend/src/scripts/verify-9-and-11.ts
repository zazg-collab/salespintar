import * as fs from 'fs';
import { prisma } from '../config/prisma';

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
      results.push({ phone: s, name: fields[4], date: fields[36] }); // index 4 = name, index 36 = created_at
    }
  }
  return results;
}

async function main() {
  const csv9 = parseCsvFull('/Users/anggafatih/Downloads/data-9.csv');
  const csv10 = parseCsvFull('/Users/anggafatih/Downloads/data-10.csv');
  const recentCsv = [...csv9, ...csv10];
  const recentCsvPhones = new Set(recentCsv.map(r => r.phone));

  const startDate = new Date('2026-08-18T00:00:00Z');
  const endDate = new Date('2026-08-20T23:59:59Z');
  const leads = await prisma.lead.findMany({ where: { createdAt: { gte: startDate, lte: endDate } } });
  
  const dbPhones = new Set(leads.map(l => l.waNumber));

  console.log('--- 11 ORANG YANG ADA DI CSV (18-20) TAPI TIDAK ADA DI WA ---');
  let missingCount = 0;
  for (const r of recentCsv) {
    if (!dbPhones.has(r.phone)) {
      missingCount++;
      console.log(`${missingCount}. Nama: ${r.name} | No: ${r.phone} | Tgl Form: ${r.date}`);
    }
  }

  // Cari tau nasib 9 orang False Positives (AI nebak iklan, tapi ga ada di CSV 18-20)
  const falsePositives = [];
  for (const lead of leads) {
    const isAd = lead.leadCategory === 'PROSPEK_IKLAN';
    const isInCsv = recentCsvPhones.has(lead.waNumber);
    if (isAd && !isInCsv) falsePositives.push(lead.waNumber);
  }

  const csv11 = parseCsvFull('/Users/anggafatih/Downloads/data-11.csv');
  const csv12 = parseCsvFull('/Users/anggafatih/Downloads/data-12.csv');
  const oldCsv = [...csv11, ...csv12];
  const oldCsvPhones = new Set(oldCsv.map(r => r.phone));

  console.log('\n--- MELACAK 9 "FALSE POSITIVES" DI DATA LAMA (13-18) ---');
  let foundInOld = 0;
  for (const fp of falsePositives) {
    const found = oldCsv.find(o => o.phone === fp);
    if (found) {
      foundInOld++;
      console.log(`KETEMU: ${fp} -> Nama: ${found.name} | Tgl Form: ${found.date}`);
    } else {
      console.log(`GAIB  : ${fp} -> Tetap tidak ditemukan di form 13-18`);
    }
  }
}
main().catch(console.error).finally(() => prisma.$disconnect());
