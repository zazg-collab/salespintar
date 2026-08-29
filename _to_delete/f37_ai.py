import sys, io, os, re

ROOT = None
for base in os.listdir('/sessions'):
    p = f'/sessions/{base}/mnt/projek-ceo/salespintar_repo'
    if os.path.isdir(p):
        ROOT = p
        break
assert ROOT, 'repo not found'

P = os.path.join(ROOT, 'backend/src/services/ai.service.ts')
s = io.open(P, encoding='utf-8').read()

# ── 1. Pengambilan pengetahuan: top-K dari env, batas karakter, ingatan ─────
pat = re.compile(
    r"    retrievedDocs = await knowledgeService\.searchRelevantKnowledge\(businessId, messageText, 3\);\s*\n"
    r"    knowledgeContext = retrievedDocs\.length > 0\s*\n"
    r"\s*\? `[^`]*`\s*\n"
    r"\s*: '';\s*\n"
)
assert len(pat.findall(s)) == 1, f'pola pengambilan pengetahuan: {len(pat.findall(s))}x'

new = '''    retrievedDocs = await knowledgeService.searchRelevantKnowledge(
      businessId, messageText, env.KNOWLEDGE_TOP_K,
    );

    // Batas panjang konteks ditegakkan dalam KARAKTER, bukan jumlah dokumen.
    // Sejak dokumen dipecah jadi potongan, panjang tiap potongan berbeda-beda —
    // "ambil 6 teratas" bisa berarti 2.000 karakter atau 15.000, dan yang kedua
    // langsung menabrak jatah token per menit Groq. Potongan diambil berurutan
    // dari yang paling mirip sampai jatahnya habis.
    const kept: string[] = [];
    let usedChars = 0;
    for (const doc of retrievedDocs) {
      if (usedChars + doc.length > env.KNOWLEDGE_CONTEXT_MAX_CHARS) break;
      kept.push(doc);
      usedChars += doc.length;
    }
    if (kept.length < retrievedDocs.length) {
      logger.info(
        `[AI] Konteks dipangkas: ${kept.length}/${retrievedDocs.length} potongan dipakai ` +
        `(${usedChars} karakter, batas ${env.KNOWLEDGE_CONTEXT_MAX_CHARS})`,
      );
    }
    retrievedDocs = kept;

    knowledgeContext = retrievedDocs.length > 0
      ? `\\n\\nPengetahuan Bisnis Tambahan:\\n${retrievedDocs.join('\\n---\\n')}\\nGunakan informasi di atas untuk menjawab pertanyaan pelanggan jika relevan.`
      : '';

    // ── Ingatan jawaban ──────────────────────────────────────────────────────
    // Diperiksa SESUDAH pengetahuan diambil, bukan sebelumnya. Dua alasan:
    // dokumen yang terambil tetap dibutuhkan Supervisor untuk memeriksa jawaban
    // yang dikirim, dan pencarian pgvector itu murah sedangkan panggilan Groq
    // yang mahal — jadi tidak ada yang terbuang dengan urutan ini.
    const cached = await lookupCachedAnswer(businessId, messageText);
    if (cached) {
      await markReplied(leadId);
      await incrementConsecutive(leadId);
      return { ok: true, reply: cached, knowledgeDocs: retrievedDocs };
    }
'''
s = pat.sub(lambda m: new, s, count=1)
print('OK   pengambilan pengetahuan + ingatan')

# ── 2. Simpan jawaban sesudah berhasil ─────────────────────────────────────
old = """    await markReplied(leadId);
    await incrementConsecutive(leadId);

    // ── NOTE (audit A1): dailyAiCount TIDAK di-increment di sini ──────────────"""
assert s.count(old) == 1, 'anchor simpan jawaban tidak unik'
s = s.replace(old, """    await markReplied(leadId);
    await incrementConsecutive(leadId);

    // Disimpan untuk pertanyaan serupa berikutnya. Fungsinya sendiri yang
    // memutuskan layak-tidaknya — jawaban yang menyebut nama penanya ditolak,
    // sebab menyajikannya ulang berarti memanggil orang dengan nama orang lain.
    await rememberAnswer({
      businessId,
      question: messageText,
      answer: reply.trim(),
      leadName,
    });

    // ── NOTE (audit A1): dailyAiCount TIDAK di-increment di sini ──────────────""")
print('OK   simpan jawaban')

# ── 3. import ──────────────────────────────────────────────────────────────
a = "import { getTodayAiCount } from './rate-limit.service';"
assert s.count(a) == 1
if 'answer-cache.service' not in s:
    s = s.replace(a, a + "\nimport { lookupCachedAnswer, rememberAnswer } from './answer-cache.service';")
    print('OK   import answer-cache')

io.open(P, 'w', encoding='utf-8').write(s)
print('SELESAI')
