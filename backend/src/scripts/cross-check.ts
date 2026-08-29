import * as fs from 'fs';
import { prisma } from '../config/prisma';

function sanitizeWaNumber(phone: string): string | null {
  if (!phone) return null;
  let s = phone.replace(/\D/g, '');
  if (s.startsWith('08')) s = '628' + s.substring(2);
  else if (s.startsWith('8')) s = '628' + s.substring(1);
  return s.length >= 10 ? s : null;
}

function parseCsv(filepath: string): string[] {
  if (!fs.existsSync(filepath)) return [];
  const text = fs.readFileSync(filepath, 'utf8');
  const lines = text.split('\n');
  const phones = new Set<string>();
  
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    let inQuotes = false;
    let field = '';
    const fields = [];
    for (let c = 0; c < line.length; c++) {
      const char = line[c];
      if (char === '"') inQuotes = !inQuotes;
      else if (char === ',' && !inQuotes) {
        fields.push(field);
        field = '';
      } else {
        field += char;
      }
    }
    fields.push(field);
    
    // Asumsi nomor HP ada di kolom index 2 seperti skrip sebelumnya
    const rawPhone = fields[2];
    const cleanPhone = sanitizeWaNumber(rawPhone);
    if (cleanPhone) phones.add(cleanPhone);
  }
  return Array.from(phones);
}

async function main() {
  const csv9 = parseCsv('/Users/anggafatih/Downloads/data-9.csv');
  const csv10 = parseCsv('/Users/anggafatih/Downloads/data-10.csv');
  const csvPhones = new Set([...csv9, ...csv10]);
  
  console.log(`\n--- HASIL PARSING CSV (Ground Truth) ---`);
  console.log(`Total kontak unik di CSV (Forms.id): ${csvPhones.size}`);

  const startDate = new Date('2026-08-18T00:00:00Z');
  const endDate = new Date('2026-08-20T23:59:59Z');

  const leads = await prisma.lead.findMany({
    where: {
      createdAt: { gte: startDate, lte: endDate }
    }
  });

  let truePositives = 0; // Tebak Iklan & Ada di CSV
  let falsePositives = 0; // Tebak Iklan & TIDAK ada di CSV (Ghosting/Bypass)
  let falseNegatives = 0; // Ditebak Organik, TAPI ternyata ada di CSV (AI Gagal deteksi)
  
  let missedCsvPhones = new Set(csvPhones);

  for (const lead of leads) {
    const isGuessedAd = lead.leadCategory === 'PROSPEK_IKLAN';
    const isInCsv = csvPhones.has(lead.waNumber);
    
    if (isInCsv) missedCsvPhones.delete(lead.waNumber);

    if (isGuessedAd && isInCsv) truePositives++;
    if (isGuessedAd && !isInCsv) falsePositives++;
    if (!isGuessedAd && isInCsv) falseNegatives++;
  }

  console.log(`\n--- UJI AKURASI AI & REGEX VS FORMS.ID ---`);
  console.log(`True Positives (AI Tepat)   : ${truePositives}`);
  console.log(`False Positives (AI Halu/Bypass) : ${falsePositives} (Bisa jadi direct WA klik tanpa form)`);
  console.log(`False Negatives (AI Gagal)  : ${falseNegatives} (Murni dari form, tapi AI tak mendeteksi)`);
  console.log(`\nKontak CSV yang belum masuk DB sama sekali: ${missedCsvPhones.size}`);
}

main().catch(console.error).finally(async () => {
  await prisma.$disconnect();
});
