import fs from 'fs';
import path from 'path';
import { prisma } from '../config/prisma';
import { LeadProfilerService } from '../modules/leads/lead-profiler.service';

interface VaultChatEntry {
  filePath: string;
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
          const convMatch = content.match(/conversation_id:\s*(?:cs:)?([0-9]+)?:?contact:([0-9a-zA-Z._-]+@[a-zA-Z0-9._-]+)/i);
          if (convMatch) {
            const csPhone = convMatch[1] || '';
            const contactJid = convMatch[2];
            const transcript = extractTranscriptFromMd(content);

            const minedAtMatch = content.match(/mined_at:\s*([^\n\r]+)/);
            const minedAt = minedAtMatch ? new Date(minedAtMatch[1].trim()) : undefined;

            const entryObj: VaultChatEntry = {
              filePath: fullPath,
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
          // ignore unreadable
        }
      }
    }
  }

  scanDir(vaultDir);
  return contactMap;
}

async function main() {
  console.log('🚀 Memulai RE-PROFILING MURNI (In-Place Update, 0 Duplikasi)...\n');

  const business = await prisma.business.findFirst();
  if (!business) {
    console.error('❌ Tidak ada business di database.');
    process.exit(1);
  }
  const businessId = business.id;

  const vaultPath = process.env.VAULT_PATH || '/vault/cs-brain';
  const contactVaultMap = parseVaultFiles(vaultPath);
  console.log(`📂 Vault terdeteksi: ${contactVaultMap.size} kontak memiliki transkrip riwayat.`);

  const allLeads = await prisma.lead.findMany({
    where: { businessId },
    orderBy: { createdAt: 'asc' },
  });
  console.log(`📋 Total lead yang akan di-reprofile: ${allLeads.length} leads (In-Place Update)\n`);

  console.log('------------------------------------------------------------------------------------------------------------------------');
  console.log(
    'NO'.padEnd(4) +
    'WHATSAPP'.padEnd(16) +
    'KATEGORI'.padEnd(18) +
    'STATUS'.padEnd(12) +
    'PRODUK'.padEnd(28) +
    'INSIGHT RINGKAS'
  );
  console.log('------------------------------------------------------------------------------------------------------------------------');

  let countIklan = 0;
  let countOrganik = 0;
  let countOthers = 0;

  let idx = 1;
  for (const lead of allLeads) {
    const jid = `${lead.waNumber}@s.whatsapp.net`;
    const vaultEntries = contactVaultMap.get(jid) || contactVaultMap.get(lead.waId || '') || [];

    let combinedTranscript = '';
    let csPhone = lead.assignedCsPhone || '';
    let csName = lead.assignedCsName || undefined;
    let latestTimestamp = lead.lastMessageAt || lead.createdAt;

    if (vaultEntries.length > 0) {
      vaultEntries.sort((a, b) => (a.minedAt?.getTime() || 0) - (b.minedAt?.getTime() || 0));
      combinedTranscript = vaultEntries.map((e) => e.transcript).join('\n---\n');
      if (vaultEntries[0].csPhone && !csPhone) {
        csPhone = vaultEntries[0].csPhone;
      }
    }

    if (!combinedTranscript.trim()) {
      combinedTranscript = `[LEAD] ${lead.name || 'Pelanggan'}: ${lead.minatProduk || ''}\n[CS] ${lead.assignedCsName || 'CS'}: ${lead.lastInsight || ''}`;
    }

    try {
      // 1. Jalankan profiling lengkap (Rules + LLM)
      const profile = await LeadProfilerService.processConversation({
        businessId,
        contactJid: jid,
        csPhone,
        csName,
        rawTranscript: combinedTranscript,
        messageTimestamp: latestTimestamp,
      });

      const finalCategory = profile?.leadCategory || 'NEW_INBOUND';
      const finalConversion = profile?.conversion || lead.conversionStatus || 'PENDING';
      const finalProduct = profile?.minatProduk || lead.minatProduk || null;
      const finalInsight = profile?.lastInsight || lead.lastInsight || null;
      const finalStage = profile?.stage || lead.leadStage || 'COLD';
      const finalScore = profile?.rawScore !== undefined ? profile.rawScore : lead.score;
      const finalRtsLevel = profile?.rtsRiskLevel || lead.rtsRiskLevel || 'LOW';
      const finalRtsScore = profile?.rtsRiskScore !== undefined ? profile.rtsRiskScore : lead.rtsRiskScore;
      const finalRtsReasons = profile?.rtsReasons || lead.rtsReasons || [];

      // 2. IN-PLACE UPDATE KE DATABASE (Kunci: WHERE id = lead.id) -> Tidak akan pernah bikin duplikat!
      await prisma.lead.update({
        where: { id: lead.id },
        data: {
          leadCategory: finalCategory as any,
          conversionStatus: finalConversion,
          minatProduk: finalProduct,
          lastInsight: finalInsight,
          leadStage: finalStage,
          score: finalScore,
          rtsRiskLevel: finalRtsLevel,
          rtsRiskScore: finalRtsScore,
          rtsReasons: finalRtsReasons,
          updatedAt: new Date(),
        },
      });

      if (finalCategory === 'PROSPEK_IKLAN') countIklan++;
      else if (finalCategory === 'NEW_INBOUND') countOrganik++;
      else countOthers++;

      console.log(
        `${idx.toString().padEnd(4)}` +
        `${lead.waNumber.padEnd(16)}` +
        `${finalCategory.padEnd(18)}` +
        `${finalConversion.padEnd(12)}` +
        `${(finalProduct || '-').substring(0, 26).padEnd(28)}` +
        `${(finalInsight || '-').substring(0, 45)}`
      );
    } catch (err) {
      console.error(`❌ Error lead ${lead.waNumber}:`, err);
    }

    // Jeda 4.2 detik per lead untuk mematuhi rate limit Google Gemini 15 RPM
    await new Promise((resolve) => setTimeout(resolve, 4200));
    idx++;
  }

  console.log('------------------------------------------------------------------------------------------------------------------------');
  console.log(`\n🎉 RE-PROFILING MURNI SELESAI 100%!`);
  console.log(`   🎯 PROSPEK_IKLAN : ${countIklan} leads`);
  console.log(`   🌱 NEW_INBOUND   : ${countOrganik} leads`);
  console.log(`   📦 OTHERS        : ${countOthers} leads`);
  console.log(`   Total Lead       : ${allLeads.length} leads (Tetap bersih & tanpa duplikat)\n`);

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error('Fatal error in reprofile script:', e);
  process.exit(1);
});
