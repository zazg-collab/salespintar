import fs from 'fs';
import path from 'path';
import { prisma } from '../config/prisma';
import { LeadProfilerService } from '../modules/leads/lead-profiler.service';
import { logger } from '../utils/logger';

interface VaultChatEntry {
  filePath: string;
  conversationId: string;
  contactJid: string;
  csPhone: string;
  minedAt?: Date;
  transcript: string;
}

function extractTranscriptFromMd(content: string): string {
  const marker = '**Sumber Obrolan Asli:**';
  const idx = content.indexOf(marker);
  if (idx !== -1) {
    return content.substring(idx + marker.length).trim();
  }
  // Fallback: strip frontmatter and return body
  return content.replace(/^---\n[\s\S]*?\n---\n/, '').trim();
}

function parseVaultFiles(vaultDir: string): Map<string, VaultChatEntry[]> {
  const contactMap = new Map<string, VaultChatEntry[]>();

  if (!fs.existsSync(vaultDir)) {
    console.warn(`[ReProfile] Vault directory not found: ${vaultDir}`);
    return contactMap;
  }

  function scanDir(dir: string) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        scanDir(fullPath);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        try {
          const content = fs.readFileSync(fullPath, 'utf-8');
          // Match conversation_id: cs:6285196037081:contact:6282174521518@s.whatsapp.net
          const convMatch = content.match(/conversation_id:\s*(?:cs:)?([0-9]+)?:?contact:([0-9a-zA-Z._-]+@[a-zA-Z0-9._-]+)/i);
          if (convMatch) {
            const csPhone = convMatch[1] || '';
            const contactJid = convMatch[2];
            const transcript = extractTranscriptFromMd(content);

            const minedAtMatch = content.match(/mined_at:\s*([^\n\r]+)/);
            const minedAt = minedAtMatch ? new Date(minedAtMatch[1].trim()) : undefined;

            const entryObj: VaultChatEntry = {
              filePath: fullPath,
              conversationId: convMatch[0],
              contactJid,
              csPhone,
              minedAt,
              transcript,
            };

            const existing = contactMap.get(contactJid) || [];
            existing.push(entryObj);
            contactMap.set(contactJid, existing);
          }
        } catch (err) {
          console.error(`Error reading ${fullPath}:`, err);
        }
      }
    }
  }

  scanDir(vaultDir);
  return contactMap;
}

async function main() {
  console.log('🚀 Memulai Migrasi & Klasifikasi Ulang Lead Berdasarkan Riwayat Chat Nyata di Database/Vault...\n');

  // Ambil business ID aktif
  const business = await prisma.business.findFirst();
  if (!business) {
    console.error('❌ Tidak ada business di database.');
    process.exit(1);
  }
  const businessId = business.id;

  // Scan folder vault
  const vaultPath = process.env.VAULT_PATH || '/vault/cs-brain';
  console.log(`📂 Membaca transkrip chat dari Vault: ${vaultPath}`);
  const contactVaultMap = parseVaultFiles(vaultPath);
  console.log(`✅ Ditemukan riwayat chat untuk ${contactVaultMap.size} kontak WhatsApp di Vault.\n`);

  // Ambil semua leads yang ada di database
  const allLeads = await prisma.lead.findMany({
    where: { businessId },
    orderBy: { createdAt: 'asc' },
  });
  console.log(`📋 Total lead terdaftar di database: ${allLeads.length}\n`);

  let countIklan = 0;
  let countOrganik = 0;
  let countOthers = 0;

  console.log('---------------------------------------------------------------------------------------------------------');
  console.log(
    'NO'.padEnd(4) +
    'WHATSAPP'.padEnd(16) +
    'KATEGORI LAMA'.padEnd(16) +
    'KATEGORI BARU'.padEnd(16) +
    'STATUS'.padEnd(12) +
    'MINAT PRODUK'
  );
  console.log('---------------------------------------------------------------------------------------------------------');

  let idx = 1;
  for (const lead of allLeads) {
    const jid = `${lead.waNumber}@s.whatsapp.net`;
    const vaultEntries = contactVaultMap.get(jid) || contactVaultMap.get(lead.waId || '') || [];

    let combinedTranscript = '';
    let csPhone = lead.assignedCsPhone || '';
    let csName = lead.assignedCsName || undefined;
    let latestTimestamp = lead.lastMessageAt || lead.createdAt;

    if (vaultEntries.length > 0) {
      // Sort by minedAt
      vaultEntries.sort((a, b) => (a.minedAt?.getTime() || 0) - (b.minedAt?.getTime() || 0));
      combinedTranscript = vaultEntries.map((e) => e.transcript).join('\n---\n');
      if (vaultEntries[0].csPhone && !csPhone) {
        csPhone = vaultEntries[0].csPhone;
      }
    }

    // Jika tidak ada transcript di vault, buat pseudo-transcript dari lastInsight / data yang ada
    if (!combinedTranscript.trim()) {
      combinedTranscript = `[LEAD] ${lead.name || 'Pelanggan'}: ${lead.minatProduk || ''}\n[CS] ${lead.assignedCsName || 'CS'}: ${lead.lastInsight || ''}`;
    }

    try {
      // Jalankan LeadProfilerService secara utuh
      const profile = await LeadProfilerService.processConversation({
        businessId,
        contactJid: jid,
        csPhone,
        csName,
        rawTranscript: combinedTranscript,
        messageTimestamp: latestTimestamp,
      });

      const newCategory = profile?.leadCategory || 'NEW_INBOUND';
      if (newCategory === 'PROSPEK_IKLAN') countIklan++;
      else if (newCategory === 'NEW_INBOUND') countOrganik++;
      else countOthers++;

      console.log(
        `${idx.toString().padEnd(4)}` +
        `${lead.waNumber.padEnd(16)}` +
        `${(lead.leadCategory || 'UNKNOWN').padEnd(16)}` +
        `${newCategory.padEnd(16)}` +
        `${(profile?.conversion || '-').padEnd(12)}` +
        `${profile?.minatProduk || '-'}`
      );
    } catch (err) {
      console.error(`❌ Gagal memproses profiling lead ${lead.waNumber}:`, err);
    }

    // Delay 2 detik antar lead untuk mematuhi rate limit LLM RPM
    await new Promise((resolve) => setTimeout(resolve, 2000));
    idx++;
  }

  console.log('---------------------------------------------------------------------------------------------------------');
  console.log(`\n📊 HASIL RE-PROFILING DETERMINISTIK AKHIR:`);
  console.log(`   🎯 PROSPEK_IKLAN : ${countIklan} leads`);
  console.log(`   🌱 NEW_INBOUND   : ${countOrganik} leads`);
  console.log(`   📦 OTHERS        : ${countOthers} leads`);
  console.log(`   Total Diproses   : ${allLeads.length} leads\n`);

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error('Fatal error in reprofile script:', e);
  process.exit(1);
});
