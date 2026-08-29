/**
 * Tahap 5 — Validasi Langkah A (Fase 21+22) terhadap dataset forensik 17 Agustus 2026.
 *
 * Dataset: 61 percakapan riil (ground truth `cls` hasil review manual Bossfren) yang jadi dasar
 * temuan audit Tahap 2 ("hanya 3/19 (16%) lead ground-truth CLOSING yang tercatat benar CLOSING").
 *
 * Skrip ini SENGAJA tidak memanggil `LeadProfilerService.processConversation()` penuh — method itu
 * butuh DB (Prisma), Redis, dan LLM live (network), yang berarti harus jalan dg akses produksi utk
 * jadi valid, dan berisiko menulis ulang data lead asli. Sebagai gantinya, skrip ini memanggil
 * LANGSUNG dua fungsi murni (tanpa I/O apapun) yang jadi sasaran fix Langkah A:
 *   - `SessionBoundaryParser.segmentSessions()` + `.isDeterministicClosing()` (Fase 21: exclusion
 *     after-sales diperluas, session-parser.ts)
 *   - `LeadProfilerService.computeClosingAndAfterSalesSignals()` (Fase 22: hasil ekstraksi murni
 *     dari LLM GATEKEEPER di `processConversation()` — Temuan 3.1, lead-profiler.service.ts)
 * Kedua fungsi ini PERSIS yang menentukan apakah sinyal closing deterministik menang mutlak atas
 * domain after-sales — akar penyebab utama bug "20/60 nyangkut lastInsight default" dan "3/19
 * CLOSING". Tidak ada duplikasi logika: skrip ini memanggil kode produksi asli, bukan kode tiruan.
 *
 * Batasan yang JUJUR dilaporkan (bukan disembunyikan): kategori FOLLOW_UP/FOLLOW_UP_HOT/LOST di
 * ground truth bergantung pada LLM live (`complete('classify', ...)`) yang TIDAK disentuh Langkah A
 * sama sekali — skrip ini TIDAK mengklaim memvalidasi akurasi LLM, HANYA lapisan deterministik yang
 * benar-benar diubah Langkah A. Untuk kategori itu, cek yang dilakukan cuma regresi: pastikan sinyal
 * closing deterministik TIDAK salah menyala (false positive) utk chat yang bukan closing.
 *
 * Cara pakai: npx tsx src/scripts/tahap5-validasi-forensik-17agustus.ts <path-ke-forensic_aug17_detailed.json>
 */
import * as fs from 'fs';
import { SessionBoundaryParser } from '../modules/leads/session-parser';
import { LeadProfilerService } from '../modules/leads/lead-profiler.service';

interface ForensicEntry {
  wa: string;
  cs: string;
  time: string;
  cls: string; // ground truth: CLOSING | FOLLOW_UP | FOLLOW_UP_HOT | AFTER_SALES_DELIVERY | LOST
  full_text: string;
}

type Predicted = 'CLOSING' | 'AFTER_SALES_DELIVERY' | 'AFTER_SALES_OTHER' | 'NOT_DETERMINISTIC';

function predict(fullText: string): { predicted: Predicted; buyerOnlyText: string } {
  const sessionResult = SessionBoundaryParser.segmentSessions(fullText);
  const activeSession = sessionResult.activeSession;
  const buyerMessages = LeadProfilerService.extractBuyerMessages(activeSession.rawTranscript, activeSession.messages);
  const buyerOnlyText = buyerMessages.join('\n');
  const signals = LeadProfilerService.computeClosingAndAfterSalesSignals(activeSession.rawTranscript, buyerOnlyText);

  let predicted: Predicted;
  if (signals.isDeterministicClosing) {
    predicted = 'CLOSING';
  } else if (signals.isAfterSalesDelivery) {
    predicted = 'AFTER_SALES_DELIVERY';
  } else if (signals.isAfterSalesWarranty || signals.isAfterSalesResi) {
    predicted = 'AFTER_SALES_OTHER';
  } else {
    predicted = 'NOT_DETERMINISTIC';
  }
  return { predicted, buyerOnlyText };
}

function main() {
  const datasetPath = process.argv[2];
  if (!datasetPath) {
    console.error('Usage: npx tsx src/scripts/tahap5-validasi-forensik-17agustus.ts <path-ke-forensic_aug17_detailed.json>');
    process.exit(1);
  }
  const raw = fs.readFileSync(datasetPath, 'utf-8');
  const data: ForensicEntry[] = JSON.parse(raw);

  console.log('='.repeat(120));
  console.log('TAHAP 5 — VALIDASI LANGKAH A (Fase 21+22) vs dataset forensik 17 Agustus 2026 (murni, tanpa DB/LLM/Redis)');
  console.log('='.repeat(120));
  console.log(
    'NO'.padEnd(4) + 'WA'.padEnd(16) + 'GT'.padEnd(22) + 'PREDIKSI'.padEnd(22) + 'VERDICT'.padEnd(10),
  );
  console.log('-'.repeat(120));

  let closingTP = 0; // gt=CLOSING, predicted=CLOSING
  let closingFN = 0; // gt=CLOSING, predicted!=CLOSING
  let closingTotal = 0;
  let falsePositiveClosing: ForensicEntry[] = []; // gt!=CLOSING tapi predicted=CLOSING (regresi paling berbahaya)
  let afterSalesDeliveryTotal = 0;
  let afterSalesDeliveryCorrectFlavor = 0; // predicted mengenali sbg after-sales (bentuk apapun) & bukan CLOSING

  let idx = 1;
  for (const entry of data) {
    const { predicted } = predict(entry.full_text);
    const gt = entry.cls;

    let verdict: string;
    if (gt === 'CLOSING') {
      closingTotal++;
      if (predicted === 'CLOSING') {
        closingTP++;
        verdict = '✅ PASS';
      } else {
        closingFN++;
        verdict = '❌ FAIL (miss)';
      }
    } else {
      // Regresi: chat BUKAN closing tidak boleh salah dipicu jadi CLOSING
      if (predicted === 'CLOSING') {
        falsePositiveClosing.push(entry);
        verdict = '❌ FAIL (false-positive closing!)';
      } else {
        verdict = '✅ PASS (no false-positive)';
      }
      if (gt === 'AFTER_SALES_DELIVERY') {
        afterSalesDeliveryTotal++;
        if (predicted === 'AFTER_SALES_DELIVERY' || predicted === 'AFTER_SALES_OTHER') {
          afterSalesDeliveryCorrectFlavor++;
        }
      }
    }

    console.log(
      `${idx.toString().padEnd(4)}${entry.wa.padEnd(16)}${gt.padEnd(22)}${predicted.padEnd(22)}${verdict}`,
    );
    idx++;
  }

  console.log('='.repeat(120));
  console.log('RINGKASAN');
  console.log('='.repeat(120));
  console.log(
    `1) CLOSING recall (metrik utama Temuan 3.1): ${closingTP}/${closingTotal} (${((closingTP / closingTotal) * 100).toFixed(1)}%) ` +
      `— baseline SEBELUM Langkah A (dicatat di audit Tahap 2): 3/19 (16%).`,
  );
  console.log(`   Miss (masih tidak terdeteksi closing): ${closingFN}`);
  console.log(
    `2) False-positive closing (chat BUKAN closing tapi salah dipicu jadi CLOSING): ${falsePositiveClosing.length} ` +
      `— HARUS 0, ini cek regresi utk memastikan fix Temuan 3.1 tidak over-correct.`,
  );
  if (falsePositiveClosing.length > 0) {
    console.log('   Daftar false-positive:');
    for (const fp of falsePositiveClosing) {
      console.log(`   - ${fp.wa} (gt=${fp.cls})`);
    }
  }
  console.log(
    `3) AFTER_SALES_DELIVERY dikenali sbg after-sales (bentuk apapun, bukan CLOSING): ` +
      `${afterSalesDeliveryCorrectFlavor}/${afterSalesDeliveryTotal}`,
  );
  console.log(
    `4) Kategori LOST/FOLLOW_UP/FOLLOW_UP_HOT: TIDAK divalidasi akurasinya di sini (bergantung LLM live, ` +
      `di luar cakupan Langkah A) — hanya diikutkan dalam cek false-positive closing (poin 2).`,
  );
  console.log('='.repeat(120));

  // Skrip ini murni (tidak pernah memanggil redisCache/prisma), tapi mengimpor
  // lead-profiler.service.ts yang secara transitif meng-import config/redis.ts — modul itu
  // membuka koneksi ioredis di level import dengan auto-reconnect tanpa batas. Paksa keluar di sini
  // supaya proses tidak menggantung menunggu retry koneksi yang memang tidak akan pernah dipakai.
  process.exit(0);
}

main();
