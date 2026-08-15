/**
 * Re-scoring Migration Script — Bersihkan False Positive RTS pada Existing CLOSING Leads
 *
 * KONTEKS:
 * Perbaikan rts-risk.engine.ts (skip Dimensi A & E untuk CLOSING leads) hanya berlaku
 * untuk percakapan BARU. Existing leads di database masih menyimpan rtsRiskLevel lama
 * yang dihitung dengan engine buggy. Script ini membersihkan data tersebut satu kali.
 *
 * LOGIKA:
 * FALSE_FLAG_REASONS = alasan yang seharusnya tidak pernah diterapkan ke CLOSING leads:
 *   - "Pembeli tidak memberikan persetujuan eksplisit..." (Dimensi A)
 *   - "CS terlalu terburu-buru menutup pesanan..." (Dimensi A)
 *   - "Pembeli sempat ragu/menolak halus..." (Dimensi E)
 *
 * Untuk setiap CLOSING lead:
 * 1. Hapus false-flag reasons dari rtsReasons
 * 2. Recalculate rtsRiskScore dari sisa reasons yang valid
 * 3. Recalculate rtsRiskLevel: LOW ≤15, MEDIUM ≤45, HIGH >45
 * 4. Update database
 *
 * RUN: npx ts-node src/scripts/rescore-closing-leads.ts
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// Reason strings yang merupakan false positive untuk CLOSING leads (Dimensi A & E)
const FALSE_FLAG_PATTERNS = [
  'Pembeli tidak memberikan persetujuan eksplisit',
  'CS terlalu terburu-buru menutup pesanan',
  'Pembeli sempat ragu/menolak halus namun tetap diproses kirim',
];

// Penalty yang dikurangi per false-flag reason (sesuai rts-risk.engine.ts lama)
// Ini digunakan untuk mengestimasi adjustment ke rtsRiskScore
const PENALTY_MAP: Record<string, number> = {
  'Pembeli tidak memberikan persetujuan eksplisit': 30, // qualityScore -30 → chatRisk +30
  'CS terlalu terburu-buru menutup pesanan': 20,         // qualityScore -20 → chatRisk +20
  'Pembeli sempat ragu/menolak halus namun tetap diproses kirim': 20, // qualityScore -20 → chatRisk +20
};

function recalculateRtsLevel(score: number): 'LOW' | 'MEDIUM' | 'HIGH' {
  if (score <= 15) return 'LOW';
  if (score <= 45) return 'MEDIUM';
  return 'HIGH';
}

async function rescoreClosingLeads() {
  console.log('🔄 Re-scoring Migration: Membersihkan false positive RTS pada CLOSING leads...\n');

  // Ambil semua CLOSING leads yang rtsRiskLevel-nya MEDIUM atau HIGH
  const candidates = await prisma.lead.findMany({
    where: {
      conversionStatus: 'CLOSING',
      rtsRiskLevel: { in: ['MEDIUM', 'HIGH'] },
    },
    select: {
      id: true,
      waNumber: true,
      assignedCsName: true,
      rtsRiskScore: true,
      rtsRiskLevel: true,
      rtsReasons: true,
    },
  });

  console.log(`📊 Ditemukan ${candidates.length} CLOSING lead dengan rtsRiskLevel MEDIUM/HIGH\n`);

  let updatedCount = 0;
  let skippedCount = 0;

  for (const lead of candidates) {
    const originalReasons: string[] = (lead.rtsReasons as string[]) || [];
    const originalScore = lead.rtsRiskScore || 0;

    // Filter out false-flag reasons
    const cleanedReasons = originalReasons.filter(
      (reason) => !FALSE_FLAG_PATTERNS.some((pattern) => reason.includes(pattern))
    );

    // Cek apakah ada false-flag yang dihapus
    const removedReasons = originalReasons.filter(
      (reason) => FALSE_FLAG_PATTERNS.some((pattern) => reason.includes(pattern))
    );

    if (removedReasons.length === 0) {
      // Tidak ada false flag → ini memang berisiko nyata, skip
      console.log(`  ⏭️  Skip ${lead.waNumber} (${lead.assignedCsName}): Semua alasan valid, tidak ada false flag`);
      skippedCount++;
      continue;
    }

    // Estimasi adjustment: hitung berapa total chatRisk penalty yang perlu dikembalikan
    // Formula: penalty dari qualityScore → chatRiskScore = 100 - qualityScore
    // Bobot chatRisk di blend: 60% (jika ada Mengantar data) atau 100%
    // Kita gunakan asumsi konservatif: koreksi 100% dari chatRisk penalty (worst case)
    let penaltyToRestore = 0;
    for (const removed of removedReasons) {
      const matchedPenalty = Object.entries(PENALTY_MAP).find(([key]) => removed.includes(key));
      if (matchedPenalty) {
        penaltyToRestore += matchedPenalty[1];
      }
    }

    // Kurangi rtsRiskScore sebesar estimasi penalty yang dikembalikan (max: turun ke 0)
    const adjustedScore = Math.max(0, originalScore - penaltyToRestore);
    const newLevel = recalculateRtsLevel(adjustedScore);

    console.log(`  ✅ Update ${lead.waNumber} (${lead.assignedCsName}):`);
    console.log(`     Dihapus: ${removedReasons.length} false-flag reason(s)`);
    console.log(`     Score: ${originalScore} → ${adjustedScore}`);
    console.log(`     Level: ${lead.rtsRiskLevel} → ${newLevel}`);
    console.log(`     Sisa reasons valid: [${cleanedReasons.join(' | ') || 'Tidak ada — SOP CS terpenuhi'}]`);

    await prisma.lead.update({
      where: { id: lead.id },
      data: {
        rtsRiskScore: adjustedScore,
        rtsRiskLevel: newLevel,
        rtsReasons: cleanedReasons.length > 0
          ? cleanedReasons
          : ['SOP percakapan CS terpenuhi & komitmen pembeli terpantau baik'],
      },
    });

    updatedCount++;
    console.log('');
  }

  console.log('\n========================================');
  console.log(`✅ Selesai! ${updatedCount} lead diperbarui, ${skippedCount} lead di-skip (risiko nyata)`);
  console.log('========================================\n');

  await prisma.$disconnect();
}

rescoreClosingLeads().catch((err) => {
  console.error('❌ Migration gagal:', err);
  prisma.$disconnect();
  process.exit(1);
});
