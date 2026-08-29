import io

SRC = 'audit-ai.ts'
s = io.open(SRC, encoding='utf-8').read()

def once(old, new):
    global s
    assert s.count(old) == 1, 'jangkar tidak unik/tidak ketemu: %r' % old[:90]
    s = s.replace(old, new)

once(
    """ *   npx tsx audit-ai.ts --maks=10         # cuma 10 pertanyaan pertama
 */""",
    """ *   npx tsx audit-ai.ts --maks=10         # cuma 10 pertanyaan pertama
 *   npx tsx audit-ai.ts --tanpa-llm       # GRATIS & CEPAT: cuma cek liputan pustaka
 *
 * ── Kenapa ada mode --tanpa-llm ─────────────────────────────────────────────
 * Mode penuh memanggil Groq sekali per pertanyaan, dan karena tingkat gratis
 * membatasi ~6000 token per menit, 60 pertanyaan berarti setengah jam menunggu
 * plus jatah token yang habis. Angga: "males banget limit ku habis buat backtest
 * beginian."
 *
 * Padahal untuk menjawab pertanyaan yang paling berguna — DOKUMEN APA YANG BELUM
 * ADA — model bahasa tidak dibutuhkan sama sekali. Yang perlu diketahui cuma:
 * apakah pustaka punya sesuatu yang relevan untuk pertanyaan ini. Itu pencarian
 * pgvector dengan embedding lokal: gratis, dan 60 pertanyaan selesai dalam
 * hitungan detik.
 *
 * Jadi urutan pemakaian yang hemat: jalankan --tanpa-llm dulu untuk mendapat
 * daftar dokumen yang perlu ditulis, tulis dokumennya, baru sekali-sekali
 * jalankan mode penuh untuk memeriksa mutu jawabannya.
 */"""
)

once(
    """async function tanya(p: Pertanyaan, businessId: string, businessName: string): Promise<Hasil> {""",
    """/**
 * Mode hemat: cuma memeriksa liputan pustaka, tanpa memanggil model bahasa.
 *
 * Ambang kemiripannya 0.3, sama seperti yang dipakai `searchRelevantKnowledge`
 * saat melayani pelanggan sungguhan — jadi "nol potongan" di sini berarti nol
 * potongan juga di percakapan nyata. Bukan perkiraan.
 */
async function periksaLiputan(p: Pertanyaan, businessId: string): Promise<Hasil> {
  const h: Hasil = {
    kategori: p.kategori, pertanyaan: p.teks, jawaban: '(tidak dijawab — mode tanpa LLM)',
    jumlahDokumen: 0, cuplikanDokumen: [], risiko: '-', skorRisiko: 0,
    alasanRisiko: [], ongkir: null, temuan: [],
  };
  try {
    const docs = await knowledgeService.searchRelevantKnowledge(businessId, p.teks, env.KNOWLEDGE_TOP_K);
    h.jumlahDokumen = docs.length;
    h.cuplikanDokumen = docs.slice(0, 3).map(d => d.split('\\n')[0]!.slice(0, 90));
    if (docs.length === 0) {
      h.temuan.push('TANPA RUJUKAN — pustaka tidak punya apa pun yang relevan untuk pertanyaan ini');
    }
  } catch (err) {
    h.galat = err instanceof Error ? err.message : String(err);
    h.temuan.push(`GAGAL DIUJI — ${h.galat}`);
  }
  return h;
}

async function tanya(p: Pertanyaan, businessId: string, businessName: string): Promise<Hasil> {"""
)

once(
    """  const jeda = Number(arg('gap') ?? JEDA_BAWAAN_DETIK) * 1000;""",
    """  const tanpaLlm = process.argv.includes('--tanpa-llm');
  // Tanpa panggilan Groq tidak ada jatah token yang perlu dijaga, jadi tidak ada
  // alasan menunggu di antara pertanyaan.
  const jeda = tanpaLlm ? 0 : Number(arg('gap') ?? JEDA_BAWAAN_DETIK) * 1000;"""
)

once(
    """  const perkiraanMenit = Math.ceil((daftar.length * jeda) / 60000);
  console.log(`\\nAudit AI — ${business.name}`);
  console.log(`${daftar.length} pertanyaan, jeda ${jeda / 1000} detik → sekitar ${perkiraanMenit} menit.`);
  console.log(`Jeda itu ada karena Groq tingkat gratis membatasi ~6000 token per MENIT`);
  console.log(`untuk seluruh organisasi. Turunkan dengan --gap kalau akunmu berbayar.\\n`);""",
    """  console.log(`\\nAudit AI — ${business.name}`);
  if (tanpaLlm) {
    console.log(`${daftar.length} pertanyaan, MODE TANPA LLM — gratis, tanpa jeda.`);
    console.log(`Yang diperiksa cuma liputan pustaka: apakah ada dokumen relevan untuk`);
    console.log(`tiap pertanyaan. Mutu jawabannya TIDAK diperiksa di mode ini.\\n`);
  } else {
    const perkiraanMenit = Math.ceil((daftar.length * jeda) / 60000);
    console.log(`${daftar.length} pertanyaan, jeda ${jeda / 1000} detik → sekitar ${perkiraanMenit} menit.`);
    console.log(`Jeda itu ada karena Groq tingkat gratis membatasi ~6000 token per MENIT`);
    console.log(`untuk seluruh organisasi. Coba --tanpa-llm kalau cuma mau cari lubang pustaka.\\n`);
  }"""
)

once(
    """    process.stdout.write(`[${i + 1}/${daftar.length}] ${p.kategori} — "${p.teks}" ... `);
    const h = await tanya(p, business.id, business.name);
    hasil.push(h);
    console.log(h.temuan.length === 0 ? 'bersih' : `${h.temuan.length} catatan`);
    if (i < daftar.length - 1) await new Promise(r => setTimeout(r, jeda));""",
    """    process.stdout.write(`[${i + 1}/${daftar.length}] ${p.kategori} — "${p.teks}" ... `);
    const h = tanpaLlm
      ? await periksaLiputan(p, business.id)
      : await tanya(p, business.id, business.name);
    hasil.push(h);
    console.log(
      tanpaLlm
        ? (h.jumlahDokumen === 0 ? 'TIDAK ADA RUJUKAN' : `${h.jumlahDokumen} potongan`)
        : (h.temuan.length === 0 ? 'bersih' : `${h.temuan.length} catatan`),
    );
    if (jeda > 0 && i < daftar.length - 1) await new Promise(r => setTimeout(r, jeda));"""
)

once(
    """  const namaBerkas = `audit-ai-${waktu.slice(0, 10).replace(/-/g, '')}.md`;""",
    """  const namaBerkas = tanpaLlm
    ? `audit-liputan-${waktu.slice(0, 10).replace(/-/g, '')}.md`
    : `audit-ai-${waktu.slice(0, 10).replace(/-/g, '')}.md`;"""
)

once(
    """  const lubang = hasil.filter(h => h.temuan.some(t => t.startsWith('LUBANG PUSTAKA'))).length;
  const bersih = hasil.filter(h => h.temuan.length === 0).length;
  console.log(`\\nSelesai. ${bersih}/${hasil.length} bersih, ${lubang} lubang pustaka.`);
  console.log(`Laporan: ${namaBerkas}\\n`);""",
    """  if (tanpaLlm) {
    const kosong = hasil.filter(h => h.jumlahDokumen === 0);
    console.log(`\\nSelesai. ${hasil.length - kosong.length}/${hasil.length} pertanyaan punya rujukan pustaka.`);
    if (kosong.length > 0) {
      console.log(`\\n${kosong.length} pertanyaan TANPA rujukan sama sekali — ini daftar dokumen yang perlu ditulis:`);
      const perKat = new Map<string, string[]>();
      for (const h of kosong) {
        if (!perKat.has(h.kategori)) perKat.set(h.kategori, []);
        perKat.get(h.kategori)!.push(h.pertanyaan);
      }
      for (const [kat, qs] of [...perKat.entries()].sort((a, b) => b[1].length - a[1].length)) {
        console.log(`\\n  ${kat} (${qs.length}):`);
        for (const q of qs) console.log(`    - ${q}`);
      }
    }
    console.log(`\\nLaporan: ${namaBerkas}\\n`);
  } else {
    const lubang = hasil.filter(h => h.temuan.some(t => t.startsWith('LUBANG PUSTAKA'))).length;
    const bersih = hasil.filter(h => h.temuan.length === 0).length;
    console.log(`\\nSelesai. ${bersih}/${hasil.length} bersih, ${lubang} lubang pustaka.`);
    console.log(`Laporan: ${namaBerkas}\\n`);
  }"""
)

io.open(SRC, 'w', encoding='utf-8').write(s)
print('OK   audit-ai.ts — mode --tanpa-llm ditambahkan')
