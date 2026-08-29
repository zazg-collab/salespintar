import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const leads = await prisma.lead.findMany({
    select: { waNumber: true, rawTranscript: true },
    where: { rawTranscript: { not: null } },
  });

  const transferRegex = /(di transfer saja nomer rekening|kirim nomer rekening ya|berapa yg harus sy transfer|total transfer : rp|silakan untuk menyelesaikan pembayaran ke salah satu rekening)/i;
  const shopeeRegex = /(pesan melalui shopee aja|s\.shopee\.co\.id|sudah pesan melalui shopeenya)/i;

  const transfers = [];
  const shopees = [];

  for (const lead of leads) {
    if (transferRegex.test(lead.rawTranscript || '')) transfers.push(lead.waNumber);
    if (shopeeRegex.test(lead.rawTranscript || '')) shopees.push(lead.waNumber);
  }

  console.log("=== WA NUMBERS (TRANSFER) ===");
  transfers.forEach(n => console.log("- " + n));
  
  console.log("\n=== WA NUMBERS (SHOPEE) ===");
  shopees.forEach(n => console.log("- " + n));
}

main().catch(console.error).finally(() => prisma.$disconnect());
