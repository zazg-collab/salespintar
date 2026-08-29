import io

SRC = 'src/services/supervisor.service.ts'
s = io.open(SRC, encoding='utf-8').read()

def once(old, new):
    global s
    assert s.count(old) == 1, 'jangkar tidak unik/tidak ketemu: %r' % old[:90]
    s = s.replace(old, new)

# ── 1. Penolong: apakah klaimnya punya dasar di pengetahuan? ─────────────────
once(
    """export function hasRiskyPattern(""",
    '''/**
 * Semua nominal di sebuah teks, dinormalkan jadi angka saja.
 *
 * "Rp 8.000" dan "Rp8000" harus dianggap nominal yang SAMA, karena model bahasa
 * dan dokumen menulisnya berbeda-beda. Yang dibandingkan angkanya, bukan
 * tulisannya.
 *
 * Token di bawah tiga angka dibuang: "Rp 50" hampir pasti bagian dari kalimat
 * lain, dan mencocokkannya akan gampang kebetulan.
 */
function nominalDalam(text: string): string[] {
  const found = String(text ?? '').match(/Rp\\.?\\s*[\\d,.]+|[\\d,.]+\\s*ribu|[\\d,.]+\\s*juta/gi) ?? [];
  return found.map(m => m.replace(/[^\\d]/g, '')).filter(d => d.length >= 3);
}

/**
 * Apakah SELURUH nominal di balasan ada juga di pengetahuan yang diberikan?
 *
 * Sengaja "seluruh", bukan "sebagian". Balasan yang menyebut satu harga benar dan
 * satu harga karangan tetap berbahaya — dan justru bentuk itu yang paling menipu,
 * karena angka yang benar membuat yang salah terasa ikut benar.
 */
function nominalPunyaDasar(reply: string, knowledge: string): boolean {
  const diBalasan = nominalDalam(reply);
  if (diBalasan.length === 0) return false;
  const diPengetahuan = new Set(nominalDalam(knowledge));
  return diBalasan.every(n => diPengetahuan.has(n));
}

/**
 * Apakah setiap frasa yang tertangkap pola ini muncul juga di pengetahuan?
 *
 * Dipakai untuk pola berbasis frasa (waktu, stok). Perbandingannya apa adanya —
 * kalau dokumen menulis "estimasi 2 hari" dan bot menulis "2 hari", frasa "2 hari"
 * ada di dua-duanya dan itu cukup.
 */
function frasaPunyaDasar(reply: string, knowledge: string, pattern: RegExp): boolean {
  const flags = pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g';
  const found = String(reply ?? '').match(new RegExp(pattern.source, flags)) ?? [];
  if (found.length === 0) return false;
  const k = String(knowledge ?? '').toLowerCase();
  return found.every(m => k.includes(m.toLowerCase()));
}

export function hasRiskyPattern('''
)

# ── 2. Tanda tangan + skoring yang sadar dasar ───────────────────────────────
once(
    """export function hasRiskyPattern(
  text: string,
  mode: 'strict' | 'lenient' = 'strict',
): { patterns: string[]; baseScore: number } {
  const found: string[] = [];
  let score = 0;
  const stockPattern = mode === 'lenient' ? STOCK_PATTERN_LENIENT : STOCK_PATTERN_STRICT;
  if (PRICE_PATTERN.test(text)) { found.push('klaim_harga'); score += 30; }
  if (stockPattern.test(text)) { found.push('klaim_stok'); score += 25; }
  if (TIMELINE_PATTERN.test(text)) { found.push('klaim_timeline'); score += 20; }
  if (COMMITMENT_PATTERN.test(text)) { found.push('klaim_komitmen'); score += 25; }
  return { patterns: found, baseScore: Math.min(score, 100) };
}""",
    """export function hasRiskyPattern(
  text: string,
  mode: 'strict' | 'lenient' = 'strict',
  /**
   * Pengetahuan yang dipakai menyusun balasan ini.
   *
   * ── Kenapa parameter ini ditambahkan ─────────────────────────────────────
   * Sampai 30 Juli 2026 fungsi ini regex murni atas teks balasan: ia tidak pernah
   * tahu apakah angka yang disebut bot punya dasar. Jadi "Rp 8.000" yang datang
   * langsung dari API Mengantar dihukum sama beratnya dengan angka yang dikarang.
   *
   * Sekarang itu bukan cuma kebisingan, karena ada kombinasi yang bisa memblokir
   * jawaban yang benar sepenuhnya:
   *
   *     "JNE Rp 8.000, estimasi 2 hari. Ekspedisi yang tersedia: JNE, J&T."
   *       klaim_harga    +30   ← angkanya dari API
   *       klaim_timeline +20   ← "2 hari", dari API
   *       klaim_stok     +25   ← kata "tersedia", padahal soal ekspedisi bukan stok
   *       = 75 → HIGH → diblokir → diganti pesan cadangan → dialihkan ke manusia
   *
   * Ketiga polanya menyala, semuanya berdasar, dan jawaban yang benar dibuang.
   * Di audit 30 Juli dua dari tiga sudah menyala bersamaan berkali-kali, dan yang
   * ketiga menyala sendiri di pertanyaan lain — tinggal ketemu di satu kalimat.
   *
   * Prinsipnya satu: pola yang teksnya ADA di pengetahuan yang diberikan itu
   * berdasar, dan yang berdasar bukan risiko. Itu justru maksud seluruh
   * rancangannya — potongan tarif disuntikkan supaya Supervisor menemukan
   * angkanya di sana.
   *
   * KALAU KOSONG ATAU TIDAK DIISI, perilakunya IDENTIK dengan sebelumnya. Tidak
   * ada satu pun pengaman yang dilonggarkan; yang berubah cuma bahwa klaim yang
   * bisa dibuktikan berhenti dihitung sebagai klaim tanpa dasar.
   */
  knowledgeContext?: string,
): { patterns: string[]; baseScore: number; grounded: string[] } {
  const found: string[] = [];
  const grounded: string[] = [];
  let score = 0;
  const stockPattern = mode === 'lenient' ? STOCK_PATTERN_LENIENT : STOCK_PATTERN_STRICT;
  const k = String(knowledgeContext ?? '');
  const adaDasar = k.trim().length > 0;

  if (PRICE_PATTERN.test(text)) {
    if (adaDasar && nominalPunyaDasar(text, k)) grounded.push('klaim_harga');
    else { found.push('klaim_harga'); score += 30; }
  }
  if (stockPattern.test(text)) {
    if (adaDasar && frasaPunyaDasar(text, k, stockPattern)) grounded.push('klaim_stok');
    else { found.push('klaim_stok'); score += 25; }
  }
  if (TIMELINE_PATTERN.test(text)) {
    if (adaDasar && frasaPunyaDasar(text, k, TIMELINE_PATTERN)) grounded.push('klaim_timeline');
    else { found.push('klaim_timeline'); score += 20; }
  }
  // ── Komitmen SENGAJA tidak pernah dimaafkan oleh dasar ────────────────────
  // Harga, waktu, dan stok itu FAKTA: kalau tertulis di dokumen, mengulangnya
  // aman. Janji berbeda sifatnya. "Kami jamin sampai 3 hari" tidak jadi aman
  // hanya karena pernah ditulis di suatu dokumen — ia tetap mengikat toko pada
  // percakapan ini, dengan pelanggan ini, pada pengiriman ini. Yang menanggung
  // akibatnya pemilik toko, bukan dokumennya.
  if (COMMITMENT_PATTERN.test(text)) { found.push('klaim_komitmen'); score += 25; }

  return { patterns: found, baseScore: Math.min(score, 100), grounded };
}"""
)

# ── 3. supervisorValidate: pengetahuan disiapkan SEBELUM pemeriksaan pola ────
once(
    """  // Step 1: pattern check (cepat, tanpa LLM)
  const { patterns, baseScore } = hasRiskyPattern(draftReply);

  // ── Step 2: LLM validation — Fix audit B3 ─────────────────────────────────""",
    """  // ── Step 1: siapkan pengetahuan LEBIH DULU ────────────────────────────────
  // Urutannya sengaja diubah. Dulu pemeriksaan pola jalan pertama, tanpa
  // pengetahuan — jadi ia tidak mungkin tahu apakah angka yang disebut bot punya
  // dasar. Sekarang pengetahuannya disiapkan dulu supaya bisa dipakai keduanya:
  // pemeriksaan pola DAN validator LLM.
  let knowledgeContext = '';
  if (knowledgeDocs !== undefined) {
    knowledgeContext = knowledgeDocs.join('\\n---\\n');
  } else {
    try {
      const docs = await knowledgeService.searchRelevantKnowledge(businessId, userMessage, 3);
      knowledgeContext = docs.join('\\n---\\n');
    } catch { /* knowledge tidak tersedia */ }
  }

  // Step 2: pattern check (cepat, tanpa LLM) — kini sadar dasar
  const { patterns, baseScore, grounded } = hasRiskyPattern(draftReply, 'strict', knowledgeContext);

  // ── Step 3: LLM validation — Fix audit B3 ─────────────────────────────────"""
)

# ── 4. Buang blok knowledgeContext yang lama (sudah dipindah ke atas) ───────
once(
    """  let knowledgeContext = '';
  if (knowledgeDocs !== undefined) {
    knowledgeContext = knowledgeDocs.join('\\n---\\n');
  } else {
    try {
      const docs = await knowledgeService.searchRelevantKnowledge(businessId, userMessage, 3);
      knowledgeContext = docs.join('\\n---\\n');
    } catch { /* knowledge tidak tersedia */ }
  }

  const { score: llmScore, reasons: llmReasons } = await validateWithLLM(""",
    """  const { score: llmScore, reasons: llmReasons } = await validateWithLLM("""
)

# ── 5. Log: yang dimaafkan ikut terlihat ────────────────────────────────────
once(
    """  logger.info(
    `[Supervisor] conv:${conversationId} | score:${finalScore} | level:${riskLevel} | approved:${approved}` +
    (allReasons.length ? ` | reasons:[${allReasons.join(', ')}]` : ''),
  );""",
    """  // `grounded` ikut dicatat supaya pemaafan ini KELIHATAN. Pengaman yang
  // melonggarkan diri tanpa jejak adalah pengaman yang tidak bisa dipercaya —
  // kalau suatu hari ia memaafkan yang seharusnya tidak, log inilah yang
  // memberitahu.
  logger.info(
    `[Supervisor] conv:${conversationId} | score:${finalScore} | level:${riskLevel} | approved:${approved}` +
    (allReasons.length ? ` | reasons:[${allReasons.join(', ')}]` : '') +
    (grounded.length ? ` | berdasar:[${grounded.join(', ')}]` : ''),
  );"""
)

io.open(SRC, 'w', encoding='utf-8').write(s)
print('OK   supervisor.service.ts')
