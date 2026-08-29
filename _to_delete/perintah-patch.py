import io, re

# ─────────────────────────────────────────────────────────────────────────────
# 1. mengantar.service.ts — ikut bawa kata pembeda; potongan pengetahuan dibuang
# ─────────────────────────────────────────────────────────────────────────────
SRC = 'src/services/mengantar.service.ts'
s = io.open(SRC, encoding='utf-8').read()

def once(old, new):
    global s
    assert s.count(old) == 1, 'jangkar tidak unik/tidak ketemu: %r' % old[:80]
    s = s.replace(old, new)

once(
    """  collectCandidates,
  buildQuestion,""",
    """  collectCandidates,
  buildQuestion,
  questionMustMention,""",
)

once(
    """export interface AmbiguousDestination {
  ambiguous: true;
  /** Mis. "Surabayanya yang di Lampung atau yang di Jawa Timur ya Kak?" */
  question: string;
  keyword: string;
}""",
    """export interface AmbiguousDestination {
  ambiguous: true;
  /** Mis. "Surabayanya yang di Jawa Timur atau yang di Lampung ya Kak?" */
  question: string;
  keyword: string;
  /**
   * Kata pembeda yang WAJIB muncul di balasan yang dikirim ke pelanggan.
   *
   * Dipakai memeriksa hasil model bahasa. Kalau tidak satu pun muncul, berarti
   * pertanyaannya tidak tersampaikan dan `question` di atas yang dikirim apa
   * adanya. Lihat catatan di `questionMustMention`.
   */
  mustMention: string[];
}""",
)

once(
    """function bertanya(candidates: Candidate[], keyword: string): AmbiguousDestination {
  return { ambiguous: true, question: buildQuestion(keyword, candidates), keyword };
}""",
    """function bertanya(candidates: Candidate[], keyword: string): AmbiguousDestination {
  return {
    ambiguous: true,
    question: buildQuestion(keyword, candidates),
    keyword,
    mustMention: questionMustMention(candidates),
  };
}""",
)

# Potongan pengetahuan untuk kasus ambigu tidak dipakai lagi — diganti perintah.
old_chunk = re.search(
    r"/\*\*\n \* Potongan untuk kasus kota tujuan yang ambigu\.\n.*?\nexport function ambiguousToKnowledgeChunk\(dest: AmbiguousDestination\): string \{.*?\n\}\n",
    s, re.DOTALL,
)
assert old_chunk, 'ambiguousToKnowledgeChunk tidak ketemu'
s = s[:old_chunk.start()] + '''/**
 * Perintah bertanya untuk model bahasa.
 *
 * ── Kenapa ini BUKAN potongan pengetahuan lagi ──────────────────────────────
 * Versi sebelumnya menyelundupkan perintah ini ke dalam daftar "Pengetahuan
 * Bisnis Tambahan", yang di prompt ditutup dengan "gunakan informasi di atas
 * jika relevan". Itu SARAN. Sementara prompt sistem punya ATURAN: "kalau ada
 * yang belum kamu ketahui, bilang akan dicek dulu."
 *
 * Terpantau 30 Juli 2026 pukul 11:03 — pertanyaannya sudah benar di log:
 *
 *     [AI] bot bertanya: Surabayanya yang di Jawa Timur atau yang di Lampung ya Kak?
 *
 * tapi yang sampai ke pelanggan: "ongkir ke Surabaya saya masih perlu cek dulu.
 * Saya akan minta informasi ke tim logistik kami." Aturan mengalahkan saran,
 * dan itu memang seharusnya — yang salah menaruh perintah di tempat saran.
 *
 * Sekarang dikirim sebagai pesan sistem tersendiri, dan hasilnya diperiksa.
 */
export function askInstruction(dest: AmbiguousDestination): string {
  return [
    'PERINTAH YANG MENGALAHKAN ATURAN LAIN DI ATAS.',
    '',
    `Tujuan pengiriman "${dest.keyword}" ada lebih dari satu tempat, dan selisih`,
    'tarifnya besar. Kamu TIDAK BOLEH menyebut angka ongkir apa pun sekarang, dan',
    'TIDAK BOLEH bilang "akan dicek dulu" atau "akan dikabari" — kamu tidak sedang',
    'kekurangan informasi, kamu cuma perlu menanyakan satu hal.',
    '',
    'Tanyakan ini, boleh disesuaikan gayanya tapi pilihannya harus tetap disebut:',
    '',
    dest.question,
  ].join('\\n');
}
''' + s[old_chunk.end():]

io.open(SRC, 'w', encoding='utf-8').write(s)
print('OK   mengantar.service.ts')

# ─────────────────────────────────────────────────────────────────────────────
# 2. ai.service.ts — perintah jadi pesan sistem, hasilnya diperiksa
# ─────────────────────────────────────────────────────────────────────────────
SRC = 'src/services/ai.service.ts'
s = io.open(SRC, encoding='utf-8').read()

once(
    """  ambiguousToKnowledgeChunk,
  unresolvedToKnowledgeChunk,""",
    """  askInstruction,
  unresolvedToKnowledgeChunk,""",
)

once(
    """    let shippingKeyword: string | null = null;
    let shippingWeight: number | null = null;
    let giliranSusulan = false;""",
    """    let shippingKeyword: string | null = null;
    let shippingWeight: number | null = null;
    let giliranSusulan = false;
    /**
     * Perintah bertanya, kalau tujuannya ambigu.
     *
     * Ditaruh di pesan sistem TERSENDIRI, bukan diselundupkan ke daftar
     * pengetahuan — lihat catatan panjang di `askInstruction`.
     */
    let perintahTanya: string | null = null;
    let wajibSebut: string[] = [];""",
)

once(
    """        if (lookup && 'ambiguous' in lookup && lookup.ambiguous) {
          // Yang disuntikkan BUKAN tarif, melainkan pertanyaan yang sudah jadi.
          // Bot tidak boleh menyebut angka apa pun sebelum tahu kota mana.
          retrievedDocs = [ambiguousToKnowledgeChunk(lookup), ...retrievedDocs];
          await rememberQuestion(leadId, {""",
    """        if (lookup && 'ambiguous' in lookup && lookup.ambiguous) {
          // Bukan tarif, melainkan perintah bertanya. Dan bukan sebagai
          // pengetahuan — sebagai perintah, di pesan sistemnya sendiri.
          perintahTanya = askInstruction(lookup);
          wajibSebut = lookup.mustMention;
          pertanyaanSiap = lookup.question;
          await rememberQuestion(leadId, {""",
)

once(
    """    const intent = detectShippingIntent(messageText);""",
    """    const intent = detectShippingIntent(messageText);
    /** Pertanyaan yang sudah jadi, dipakai kalau balasan model tidak menyampaikannya. */
    let pertanyaanSiap: string | null = null;""",
)

# Pesan sistem tambahan + pemeriksaan hasil
once(
    """    const completion = await groq.chat.completions.create({
      messages: [
        { role: 'system', content: getSystemPrompt(businessName) + knowledgeContext },
        { role: 'system', content: `Konteks percakapan:\\n${contextMessages}` },
        { role: 'user', content: `${userName}: ${messageText}` },
      ],""",
    """    const completion = await groq.chat.completions.create({
      messages: [
        { role: 'system', content: getSystemPrompt(businessName) + knowledgeContext },
        { role: 'system', content: `Konteks percakapan:\\n${contextMessages}` },
        // Ditaruh PALING AKHIR di antara pesan sistem, sesudah aturan umum,
        // supaya ia terbaca sebagai pengecualian atas aturan itu — bukan sebagai
        // catatan tambahan yang boleh diabaikan.
        ...(perintahTanya ? [{ role: 'system' as const, content: perintahTanya }] : []),
        { role: 'user', content: `${userName}: ${messageText}` },
      ],""",
)

once(
    """    const reply = completion.choices[0]?.message?.content;
    if (!reply || reply.trim().length === 0) {
      return { ok: true, reply: fallbackReply(), knowledgeDocs: retrievedDocs };
    }""",
    """    let reply = completion.choices[0]?.message?.content;
    if (!reply || reply.trim().length === 0) {
      // Kalau tujuannya ambigu, pertanyaan yang sudah jadi jauh lebih berguna
      // daripada balasan cadangan yang tidak menanyakan apa pun.
      if (pertanyaanSiap) {
        await markReplied(leadId);
        await incrementConsecutive(leadId);
        return { ok: true, reply: pertanyaanSiap, knowledgeDocs: retrievedDocs };
      }
      return { ok: true, reply: fallbackReply(), knowledgeDocs: retrievedDocs };
    }

    // ── Periksa: pertanyaannya benar-benar tersampaikan? ─────────────────────
    // Perintah di pesan sistem membuat kepatuhan JAUH lebih mungkin, tapi tetap
    // tidak pasti — dan kegagalannya di sini tidak sepele. Pelanggan yang
    // ditinggal dengan "nanti dikabari" umumnya tidak menunggu; dia pergi.
    //
    // Kecocokan persis TIDAK diharuskan: model boleh menyusun kalimatnya sendiri,
    // asalkan pilihannya benar-benar disebut. Yang diperiksa cuma itu.
    if (pertanyaanSiap && wajibSebut.length > 0) {
      const r = reply.toLowerCase();
      const menyebutPilihan = wajibSebut.some(k => r.includes(k.toLowerCase()));
      const bertanya = reply.includes('?');
      if (!menyebutPilihan || !bertanya) {
        logger.warn(
          `[AI] Balasan model tidak menyampaikan pertanyaan tujuan ` +
          `(menyebut pilihan: ${menyebutPilihan}, ada tanda tanya: ${bertanya}) — ` +
          `diganti pertanyaan yang sudah disusun`,
        );
        reply = pertanyaanSiap;
      }
    }""",
)

io.open(SRC, 'w', encoding='utf-8').write(s)
print('OK   ai.service.ts')
