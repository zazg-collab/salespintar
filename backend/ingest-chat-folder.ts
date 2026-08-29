import fs from 'fs/promises';
import path from 'path';

// Import dari dist jika ada (di container), atau src (di dev)
const isDist = require('fs').existsSync(path.join(__dirname, 'dist'));
const baseDir = isDist ? './dist' : './src';

const { prisma } = require(`${baseDir}/config/prisma`);
const { logger } = require(`${baseDir}/utils/logger`);
const { parseWhatsAppExport } = require(`${baseDir}/services/wa-export-parser`);
const { complete } = require(`${baseDir}/services/llm`);
const { knowledgeService } = require(`${baseDir}/services/knowledge.service`);
const { createSession, bumpProcessed, upsertQuestion } = require(`${baseDir}/services/question-miner.repo`);

interface ExtractedQ {
  question: string;
  sample: string;
  category: 'Produk' | 'SOP' | 'FAQ';
}

async function extractQuestionsFromText(buyerLines: string[], businessId: string): Promise<ExtractedQ[]> {
  const text = buyerLines.join('\n');
  if (text.trim().length < 15) return [];

  try {
    const resp = await complete('miner', {
      businessId,
      messages: [
        {
          role: 'system',
          content: `Kamu adalah alat penambang PERTANYAAN dari chat pelanggan ke CS toko pisau/golok/perkakas.
Tugasmu: kumpulkan pertanyaan yang pelanggan tanyakan, lalu tulis ulang tiap pertanyaan dalam bentuk baku bahasa Indonesia yang rapi (huruf kecil, tanpa tanda tanya).

ATURAN:
1. HANYA ambil yang benar-benar pertanyaan (ingin tahu harga, bahan, ukuran, cara order, ongkir, COD, garansi, transfer, komplain, dll).
2. Abaikan ucapan salam, terima kasih, konfirmasi ("oke", "siap", "sudah transfer"), dan curhat.
3. Buang data pribadi: nama orang, nomor HP, alamat jalan, no resi.
4. Jangan menjawab pertanyaannya, cukup ekstrak pertanyaannya saja.
5. Kategori: "Produk" (harga/bahan/stok/ukuran), "SOP" (ongkir/pengiriman/COD/garansi/retur), "FAQ" (lainnya).

Output format JSON:
{"questions": [{"question": "bentuk baku pertanyaan", "sample": "kutipan asli singkat", "category": "Produk"}]}`,
        },
        { role: 'user', content: `UCAPAN PELANGGAN:\n${text}` },
      ],
    });

    const parsed = JSON.parse(resp.text || '{}');
    if (!Array.isArray(parsed.questions)) return [];

    return parsed.questions
      .filter((q: any) => q && typeof q.question === 'string' && q.question.trim().length >= 4)
      .map((q: any) => ({
        question: String(q.question).trim().toLowerCase(),
        sample: String(q.sample || q.question).trim(),
        category: ['Produk', 'SOP', 'FAQ'].includes(q.category) ? q.category : 'FAQ',
      }));
  } catch (err) {
    logger.warn(`[Ingest] Error parsing LLM JSON: ${err}`);
    return [];
  }
}

async function findTxtFiles(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!entry.name.startsWith('.') && entry.name !== '_to_delete') {
        files.push(...(await findTxtFiles(fullPath)));
      }
    } else if (entry.isFile() && entry.name.endsWith('.txt') && !entry.name.startsWith('._')) {
      files.push(fullPath);
    }
  }
  return files;
}

async function main() {
  const targetDir = process.argv[2] || '/Users/anggafatih/Downloads/CHAT';
  console.log(`\n======================================================`);
  console.log(`🚀 MEMULAI BATCH INGEST CHAT DARI: ${targetDir}`);
  console.log(`======================================================\n`);

  await prisma.$connect();

  // Cari bisnis default
  const business = await prisma.business.findFirst({ select: { id: true, name: true } });
  if (!business) {
    console.error('❌ Bisnis tidak ditemukan di database!');
    process.exit(1);
  }
  const businessId = business.id;
  console.log(`Bisnis: ${business.name} (${businessId})\n`);

  const files = await findTxtFiles(targetDir);
  console.log(`📁 Ditemukan total: ${files.length} file chat .txt\n`);

  if (files.length === 0) {
    console.log('Tidak ada file .txt ditemukan.');
    process.exit(0);
  }

  // Buat Sesi Mining
  const sessionId = await createSession(
    businessId,
    `Batch Ingest 80 Chat (${new Date().toLocaleDateString('id-ID')})`,
    ['Annisa', 'Cici', 'Ita', 'Putri'],
    files.length,
    0,
  );
  console.log(`🆔 ID Sesi Mining: ${sessionId}\n`);

  let totalQuestionsExtracted = 0;
  let totalCreated = 0;
  let totalMerged = 0;
  let processedCount = 0;

  for (let i = 0; i < files.length; i++) {
    const file = files[i]!;
    const relPath = path.relative(targetDir, file);
    processedCount++;

    try {
      const rawContent = await fs.readFile(file, 'utf-8');
      const parsed = parseWhatsAppExport(rawContent);

      if (!parsed || parsed.messages.length === 0) {
        console.log(`[${processedCount}/${files.length}] ⚠️  Kosong / Tidak bisa di-parse: ${relPath}`);
        await bumpProcessed(sessionId);
        continue;
      }

      // Deteksi CS vs Buyer
      const csKeywords = ['annisa', 'cici', 'ita', 'putri', 'deva', 'cordova', 'admin', 'store', 'cs'];
      const buyerMessages: string[] = [];

      for (const m of parsed.messages) {
        const isCs = csKeywords.some(cs => m.sender.toLowerCase().includes(cs));
        if (!isCs) {
          buyerMessages.push(m.text);
        }
      }

      if (buyerMessages.length === 0) {
        // Jika tidak bisa membedakan pengirim, ambil pengirim ke-2
        const participant2 = parsed.participants[1] || parsed.participants[0];
        for (const m of parsed.messages) {
          if (m.sender === participant2) buyerMessages.push(m.text);
        }
      }

      // Ekstrak pertanyaan via LLM (pecah per 30 baris jika panjang)
      const chunkSize = 25;
      const questionsInFile: ExtractedQ[] = [];

      for (let j = 0; j < buyerMessages.length; j += chunkSize) {
        const slice = buyerMessages.slice(j, j + chunkSize);
        const qs = await extractQuestionsFromText(slice, businessId);
        questionsInFile.push(...qs);
      }

      // Simpan & Cluster pertanyaan ke database
      let fileCreated = 0;
      let fileMerged = 0;

      for (const q of questionsInFile) {
        try {
          const emb = await knowledgeService.getEmbedding(q.question, 'query');
          const res = await upsertQuestion({
            businessId,
            sessionId,
            question: q.question,
            sampleRaw: q.sample,
            category: q.category,
            embedding: emb,
          });

          if (res === 'created') {
            fileCreated++;
            totalCreated++;
          } else {
            fileMerged++;
            totalMerged++;
          }
          totalQuestionsExtracted++;
        } catch (embErr) {
          logger.warn(`[Ingest] Gagal embed & simpan pertanyaan "${q.question}": ${embErr}`);
        }
      }

      await bumpProcessed(sessionId);

      console.log(
        `[${processedCount}/${files.length}] ✅ ${relPath} ` +
        `(${parsed.messages.length} msgs) ➔ ${questionsInFile.length} pertanyaan ` +
        `(${fileCreated} baru, ${fileMerged} di-cluster 🔥)`
      );

    } catch (fileErr) {
      console.error(`[${processedCount}/${files.length}] ❌ Gagal file ${relPath}:`, fileErr);
    }
  }

  // Update status sesi jadi 'done'
  await prisma.$executeRawUnsafe(
    `UPDATE mining_sessions SET status = 'done', updated_at = NOW() WHERE id = $1::uuid`,
    sessionId,
  );

  console.log(`\n======================================================`);
  console.log(`🎉 BATCH INGEST SELESAI!`);
  console.log(`📊 Total File Diproses : ${processedCount} / ${files.length}`);
  console.log(`❓ Total Pertanyaan    : ${totalQuestionsExtracted}`);
  console.log(`✨ Pertanyaan Unik Baru : ${totalCreated}`);
  console.log(`🔥 Frekuensi Ter-Cluster: ${totalMerged}`);
  console.log(`======================================================\n`);

  await prisma.$disconnect();
}

main().catch(err => {
  console.error('Fatal error during ingest:', err);
  process.exit(1);
});
