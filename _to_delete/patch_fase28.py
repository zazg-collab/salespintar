import sys, io, os

ROOT = None
for base in os.listdir('/sessions'):
    p = f'/sessions/{base}/mnt/projek-ceo/salespintar_repo'
    if os.path.isdir(p):
        ROOT = p
        break
assert ROOT, 'repo not found'

def patch(relpath, pairs):
    path = os.path.join(ROOT, relpath)
    with io.open(path, encoding='utf-8') as f:
        src = f.read()
    for old, new in pairs:
        n = src.count(old)
        if n != 1:
            print(f'FAIL {relpath}: pola ditemukan {n}x (harus 1):\n---\n{old[:220]}\n---')
            sys.exit(1)
        src = src.replace(old, new)
    with io.open(path, 'w', encoding='utf-8') as f:
        f.write(src)
    print(f'OK   {relpath} ({len(pairs)} substitusi)')


# ── 1. Supervisor: definisi "fakta volatil" jadi milik bersama ────────────────
patch('backend/src/services/supervisor.service.ts', [
(
"function hasRiskyPattern(text: string): { patterns: string[]; baseScore: number } {",
"""/**
 * Satu-satunya definisi "fakta yang bisa basi" di seluruh sistem.
 *
 * Dipakai dua arah, dan itu disengaja:
 *  - ke LUAR — menahan balasan bot yang mengklaim harga/stok/waktu tanpa dasar;
 *  - ke DALAM — mengarantina dokumen hasil Shadow Mining yang membawa klaim
 *    serupa, supaya chat lama tidak diam-diam meloloskan justru hal yang dijaga
 *    di sisi keluar.
 *
 * Kalau daftar polanya disetel, kedua arah ikut membaik sekaligus. Menyalin
 * daftar ini ke tempat lain akan membuat keduanya melenceng diam-diam.
 */
export function hasRiskyPattern(text: string): { patterns: string[]; baseScore: number } {"""
),
])


# ── 2. Worker: lapis karantina ────────────────────────────────────────────────
patch('backend/src/queues/shadow-mining.worker.ts', [

# 2a. import
(
"import type { ShadowMiningJobData, ShadowMiningResult } from './shadow-mining.queue';",
"""import { hasRiskyPattern } from '../services/supervisor.service';
import type { ShadowMiningJobData, ShadowMiningResult } from './shadow-mining.queue';"""
),

# 2b. prompt Layer 2 — larang anjuran umum
(
"5. Jika konten tidak cukup untuk jadi knowledge → kembalikan null untuk semua field",
"""5. WAJIB memuat minimal SATU fakta spesifik yang benar-benar diucapkan di percakapan:
   nama produk, angka, kebijakan, atau langkah konkret.
6. DILARANG menghasilkan anjuran umum seperti "pertimbangkan kebutuhan Anda",
   "pastikan memeriksa kualitas", atau "sesuaikan dengan keperluan". Kalimat semacam
   itu terdengar rapi tapi tidak mengajarkan apa pun dan hanya mengotori pustaka.
7. Jika percakapan tidak memuat satu pun fakta spesifik, ATAU kontennya tidak cukup
   untuk jadi knowledge → kembalikan null untuk semua field"""
),

# 2c. fungsi penilai, disisipkan sebelum writeToVault
(
"""// ──────────────────────────────────────────────────────────────────────────────
// Write to Vault — tulis .md ke Obsidian CS Brain
// ──────────────────────────────────────────────────────────────────────────────
async function writeToVault(
  businessId: string,
  extracted: ExtractedKnowledge,
  mode: 'auto' | 'draft',
  conversationId: string,
): Promise<string> {""",
"""// ──────────────────────────────────────────────────────────────────────────────
// Lapis 2.5: karantina — fakta volatil & dokumen hampa
//
// Dua bahaya yang berbeda, dua-duanya berakhir sama: dokumennya TIDAK dihapus,
// cuma dipaksa lewat mata manusia.
//
// Menahan lebih baik daripada menghapus. Kalau angka 150rb dibuang diam-diam,
// tidak ada yang pernah tahu CS mengutip harga lama selama berbulan-bulan. Kalau
// angkanya ditahan dan ditandai, pemilik bisnis melihatnya dan bisa mengoreksi —
// itu temuan bisnis, bukan sekadar kebersihan data.
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Penanda anjuran umum: kalimat yang terdengar seperti pengetahuan tapi tidak
 * mengandung apa pun yang bisa diperiksa benar-salahnya.
 *
 * Ini JARING, bukan perbaikan utamanya. Perbaikan utamanya ada di prompt Layer 2
 * (aturan 5–7), yang melarang ekstraktor menghasilkan kalimat semacam ini sejak
 * awal. Daftar di bawah cuma menangkap yang tetap lolos.
 */
const GENERIC_ADVICE_PATTERNS: RegExp[] = [
  /pertimbangkan(?:\\s+\\w+){0,3}\\s+(?:faktor|kebutuhan|keperluan)/i,
  /pastikan untuk (?:memeriksa|mempertimbangkan|memilih|mengecek)/i,
  /faktor-faktor seperti/i,
  /sesuai (?:dengan )?(?:kebutuhan|keperluan|preferensi)/i,
  /(?:pada umumnya|secara umum)/i,
  /(?:dapat bervariasi|tergantung (?:pada )?kebutuhan)/i,
];

/** Jangkar konkret paling sederhana yang bisa diandalkan: adanya angka. */
const CONCRETE_ANCHOR = /\\d/;

export interface DocumentAssessment {
  /** true = tidak boleh auto-approve, sebagus apa pun setelan modenya. */
  forceReview: boolean;
  /** Kode alasan, ikut ditulis ke frontmatter supaya UI bisa menjelaskannya. */
  reasons: string[];
}

export function assessDocument(extracted: ExtractedKnowledge): DocumentAssessment {
  const text = `${extracted.title}\\n${extracted.content}`;
  const reasons: string[] = [];

  // (a) Fakta volatil — memakai definisi yang SAMA PERSIS dengan Supervisor,
  //     bukan salinannya. Harga, stok, janji waktu, jaminan.
  const { patterns } = hasRiskyPattern(text);
  reasons.push(...patterns);

  // (b) Dokumen hampa — tidak ada satu pun angka DAN padat anjuran umum.
  //     Syarat gandanya disengaja: dokumen prosedur yang sah sering tidak
  //     berangka, dan kalimat "sesuai kebutuhan" sesekali muncul di tulisan
  //     yang berisi. Yang berbahaya adalah gabungan keduanya.
  const hedgeHits = GENERIC_ADVICE_PATTERNS.filter(p => p.test(text)).length;
  if (!CONCRETE_ANCHOR.test(extracted.content) && hedgeHits >= 2) {
    reasons.push('minim_fakta');
  }

  return { forceReview: reasons.length > 0, reasons };
}

// ──────────────────────────────────────────────────────────────────────────────
// Write to Vault — tulis .md ke Obsidian CS Brain
// ──────────────────────────────────────────────────────────────────────────────
async function writeToVault(
  businessId: string,
  extracted: ExtractedKnowledge,
  mode: 'auto' | 'draft',
  conversationId: string,
  reviewReasons: string[] = [],
): Promise<string> {"""
),

# 2d. frontmatter bawa alasan
(
"""    `status: ${mode === 'auto' ? 'active' : 'draft'}`,
    '---',""",
"""    `status: ${mode === 'auto' ? 'active' : 'draft'}`,
    ...(reviewReasons.length ? [`review_reason: ${reviewReasons.join(', ')}`] : []),
    '---',"""
),

# 2e. handler: mode bisa ditahan
(
"""  const mode = await resolveShadowMiningMode(businessId);
  const vaultPath = await writeToVault(businessId, extracted, mode, sourceRef);
  logger.info(`[ShadowMining] Written to vault: ${vaultPath} (mode: ${mode})`);""",
"""  // ── Lapis 2.5: karantina ──
  // Setelan Otomatis berhenti jadi bypass menyeluruh dan berubah jadi bersyarat.
  // Dokumen prosedur murni tetap lewat sendiri; begitu ada klaim yang bisa basi
  // atau isinya ternyata hampa, dokumennya jatuh ke Draft_AI menunggu diperiksa.
  const assessment = assessDocument(extracted);
  const resolvedMode = await resolveShadowMiningMode(businessId);
  const mode: 'auto' | 'draft' = assessment.forceReview ? 'draft' : resolvedMode;

  if (assessment.forceReview && resolvedMode === 'auto') {
    logger.info(
      `[ShadowMining] Lapis 2.5 MENAHAN "${extracted.title}" dari mode Otomatis — ` +
      `alasan: ${assessment.reasons.join(', ')}`,
    );
  }

  const vaultPath = await writeToVault(businessId, extracted, mode, sourceRef, assessment.reasons);
  logger.info(`[ShadowMining] Written to vault: ${vaultPath} (mode: ${mode})`);"""
),
])


# ── 3. Route: bawa alasan ke UI ───────────────────────────────────────────────
patch('backend/src/routes/auto-learning.routes.ts', [
(
"""            sizeBytes: stat.size,
            preview,""",
"""            sizeBytes: stat.size,
            // Kenapa dokumen ini wajib diperiksa manusia (lihat Lapis 2.5 di
            // shadow-mining.worker.ts). Kosong = masuk draft karena setelan mode,
            // bukan karena ada yang mencurigakan di isinya.
            reviewReason: fm.review_reason || null,
            preview,"""
),
])


# ── 4. Frontend: badge alasan ─────────────────────────────────────────────────
patch('frontend/src/app/app/auto-learning/page.tsx', [
(
"""  sizeBytes: number;
  preview: string;
}""",
"""  sizeBytes: number;
  /** Diisi kalau dokumen ini ditahan Lapis 2.5, bukan sekadar ikut setelan mode. */
  reviewReason: string | null;
  preview: string;
}

/** Kode alasan dari backend → kalimat yang bisa dibaca orang. */
const REVIEW_REASON_LABELS: Record<string, string> = {
  klaim_harga: 'menyebut harga',
  klaim_stok: 'mengklaim stok',
  klaim_timeline: 'menjanjikan waktu',
  klaim_komitmen: 'memberi jaminan',
  minim_fakta: 'minim fakta spesifik',
};"""
),
(
"""                    ? 'Hasil mining langsung aktif sebagai knowledge bot — tanpa perlu approve manual.'""",
"""                    ? 'Hasil mining langsung aktif sebagai knowledge bot — kecuali dokumen yang menyebut harga, stok, janji waktu, atau yang isinya minim fakta: itu tetap ditahan untuk diperiksa.'"""
),
(
"""                      {draft.minedAt && (""",
"""                      {draft.reviewReason && (
                        <span className="text-xs px-2 py-0.5 rounded-full font-medium bg-rose-100 text-rose-700">
                          <AlertTriangle className="w-3 h-3 inline mr-1" />
                          Wajib dicek:{' '}
                          {draft.reviewReason
                            .split(',')
                            .map(r => REVIEW_REASON_LABELS[r.trim()] || r.trim())
                            .join(', ')}
                        </span>
                      )}
                      {draft.minedAt && ("""
),
])

print('SELESAI')
