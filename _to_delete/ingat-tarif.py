import io

SRC = 'src/services/ai.service.ts'
s = io.open(SRC, encoding='utf-8').read()

def once(old, new):
    global s
    assert s.count(old) == 1, 'jangkar tidak unik/tidak ketemu: %r' % old[:90]
    s = s.replace(old, new)

once(
    "  looksLikePlaceAnswer,\n  matchAnswerToChoice,\n  combineAnswer,\n} from './shipping-dialog.service';",
    "  looksLikePlaceAnswer,\n  matchAnswerToChoice,\n  combineAnswer,\n"
    "  rememberQuotes,\n  getRememberedQuotes,\n  looksLikeQuoteFollowUp,\n} from './shipping-dialog.service';",
)

# Simpan potongan tarif setiap kali dikutip — dua tempat.
once(
    """        if (hasil) {
          retrievedDocs = [quotesToKnowledgeChunk(hasil), ...retrievedDocs];
          logger.info(
            `[AI] Ongkir ke ${hasil.destinationLabel} (${hasil.weightKg} kg): ` +
            `${hasil.quotes.length} ekspedisi disuntikkan ke konteks`,
          );""",
    """        if (hasil) {
          const potongan = quotesToKnowledgeChunk(hasil);
          retrievedDocs = [potongan, ...retrievedDocs];
          // Diingat supaya pertanyaan lanjutan ("yang mana yang paling murah")
          // tidak kehilangan angkanya. Lihat catatan di `rememberQuotes`.
          await rememberQuotes(leadId, potongan);
          logger.info(
            `[AI] Ongkir ke ${hasil.destinationLabel} (${hasil.weightKg} kg): ` +
            `${hasil.quotes.length} ekspedisi disuntikkan ke konteks`,
          );""",
)

once(
    """        } else if (lookup) {
          retrievedDocs = [quotesToKnowledgeChunk(lookup), ...retrievedDocs];
          await forgetQuestion(leadId);""",
    """        } else if (lookup) {
          const potongan = quotesToKnowledgeChunk(lookup);
          retrievedDocs = [potongan, ...retrievedDocs];
          await rememberQuotes(leadId, potongan);
          await forgetQuestion(leadId);""",
)

# Suntikkan kembali kalau pesannya pertanyaan lanjutan tanpa nama kota.
once(
    """    knowledgeContext = retrievedDocs.length > 0""",
    """    // ── Pertanyaan lanjutan soal tarif yang baru dikutip ────────────────────
    // "pengen yang cepat dan murah" tidak menyebut kota dan tidak menyebut kata
    // "ongkir", jadi pencarian ongkir tidak menyala — dan tanpa bagian ini model
    // menjawab "saya cek dulu ya Kak" untuk angka yang baru saja ia sebutkan
    // sendiri satu pesan sebelumnya. Terpantau 30 Juli 2026 pukul 11:31.
    let lanjutanTarif = false;
    if (!shippingKeyword && !pilihanTerpilih && looksLikeQuoteFollowUp(messageText)) {
      const tersimpan = await getRememberedQuotes(leadId);
      if (tersimpan) {
        retrievedDocs = [tersimpan, ...retrievedDocs];
        lanjutanTarif = true;
        logger.info('[AI] Pertanyaan lanjutan soal ongkir — tarif yang tadi dikutip disuntikkan kembali');
      }
    }

    knowledgeContext = retrievedDocs.length > 0""",
)

# Ingatan jawaban juga mati untuk pertanyaan lanjutan tarif.
once(
    "    const giliranOngkir = Boolean(intent) || giliranSusulan;",
    "    // `lanjutanTarif` belum diketahui di titik ini; ditambahkan di bawah.\n"
    "    let giliranOngkir = Boolean(intent) || giliranSusulan;",
)
once(
    "    const cached = giliranOngkir ? null : await lookupCachedAnswer(businessId, messageText);",
    "    // Pertanyaan lanjutan tarif juga tidak boleh dijawab dari ingatan: \"yang\n"
    "    // paling murah\" jawabannya bergantung pada kota tujuan pelanggan ini.\n"
    "    giliranOngkir = giliranOngkir || lanjutanTarif;\n"
    "    const cached = giliranOngkir ? null : await lookupCachedAnswer(businessId, messageText);",
)

io.open(SRC, 'w', encoding='utf-8').write(s)
print('OK   ai.service.ts')
