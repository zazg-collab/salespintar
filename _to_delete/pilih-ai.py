import io

SRC = 'src/services/ai.service.ts'
s = io.open(SRC, encoding='utf-8').read()

def once(old, new):
    global s
    assert s.count(old) == 1, 'jangkar tidak unik/tidak ketemu: %r' % old[:90]
    s = s.replace(old, new)

once(
    "  askInstruction,\n  unresolvedToKnowledgeChunk,",
    "  askInstruction,\n  getShippingQuotesForChoice,\n  unresolvedToKnowledgeChunk,",
)

once(
    "  looksLikePlaceAnswer,\n  combineAnswer,\n} from './shipping-dialog.service';",
    "  looksLikePlaceAnswer,\n  matchAnswerToChoice,\n  combineAnswer,\n} from './shipping-dialog.service';",
)

once(
    """    let perintahTanya: string | null = null;
    let wajibSebut: string[] = [];""",
    """    let perintahTanya: string | null = null;
    let wajibSebut: string[] = [];
    /** Pilihan yang sudah dipastikan dari jawaban pelanggan, kalau ada. */
    let pilihanTerpilih: { addressId: string; cityLabel: string; province: string } | null = null;""",
)

once(
    """    } else if (pending && looksLikePlaceAnswer(messageText)) {
      shippingKeyword = combineAnswer(pending.keyword, messageText);
      shippingWeight = pending.weightKg;
      giliranSusulan = true;
      logger.info(`[AI] "${messageText}" dibaca sebagai jawaban atas pertanyaan "${pending.keyword}" → cari "${shippingKeyword}"`);
    }""",
    """    } else if (pending && looksLikePlaceAnswer(messageText)) {
      giliranSusulan = true;
      shippingWeight = pending.weightKg;

      // ── Jalur utama: COCOKKAN ke pilihan yang tadi ditawarkan ─────────────
      // Bukan menyusun ulang kata kunci pencarian. Pada giliran ini pilihannya
      // sudah diketahui, jadi tugasnya memilih — dan memilih dari daftar pendek
      // jauh lebih mudah dibuat benar. Versi sebelumnya menyusun kata kunci dan
      // langsung terbukti rapuh: "jawa timur kak." jadi pencarian
      // "surabaya jawa timur kak", yang tentu saja tidak ketemu.
      pilihanTerpilih = matchAnswerToChoice(messageText, pending.choices ?? []);
      if (pilihanTerpilih) {
        logger.info(
          `[AI] "${messageText}" cocok ke pilihan ${pilihanTerpilih.cityLabel}, ` +
          `${pilihanTerpilih.province} — tarif diambil langsung, tanpa cari ulang`,
        );
      } else {
        // Tidak menunjuk tepat satu pilihan (mis. pelanggan menyebut kecamatan
        // yang belum pernah kita tawarkan). Cadangannya: susun kata kunci seperti
        // dulu, tapi kini dengan penyaring kata sapaan yang sama.
        shippingKeyword = combineAnswer(pending.keyword, messageText);
        logger.info(
          `[AI] "${messageText}" tidak menunjuk satu pilihan — dicari sebagai "${shippingKeyword}"`,
        );
      }
    }""",
)

once(
    """    if (shippingKeyword) {
      try {
        const lookup = await getShippingQuotes({""",
    """    // ── Tarif untuk pilihan yang sudah dipastikan ───────────────────────────
    // Tidak ada pencarian lokasi di jalur ini: id alamatnya sudah ada, jadi tidak
    // ada lagi kesempatan bagi kata kunci yang salah susun untuk menggagalkan
    // seluruh percakapan.
    if (pilihanTerpilih) {
      try {
        const hasil = await getShippingQuotesForChoice({
          addressId: pilihanTerpilih.addressId,
          cityLabel: pilihanTerpilih.cityLabel,
          province: pilihanTerpilih.province,
          weightKg: shippingWeight,
        });
        await forgetQuestion(leadId);
        if (hasil) {
          retrievedDocs = [quotesToKnowledgeChunk(hasil), ...retrievedDocs];
          logger.info(
            `[AI] Ongkir ke ${hasil.destinationLabel} (${hasil.weightKg} kg): ` +
            `${hasil.quotes.length} ekspedisi disuntikkan ke konteks`,
          );
        } else {
          logger.warn(`[AI] Tarif untuk pilihan ${pilihanTerpilih.cityLabel} tidak bisa diambil`);
        }
      } catch (err) {
        logger.warn(`[AI] Pengambilan tarif pilihan gagal, dilewati: ${err}`);
      }
    }

    if (shippingKeyword) {
      try {
        const lookup = await getShippingQuotes({""",
)

# Simpan pilihan saat bertanya, supaya giliran berikutnya bisa mencocokkannya.
once(
    """          await rememberQuestion(leadId, {
            keyword: shippingKeyword,
            weightKg: shippingWeight,
            asked: 1,
          });""",
    """          await rememberQuestion(leadId, {
            keyword: shippingKeyword,
            weightKg: shippingWeight,
            asked: 1,
            choices: lookup.choices,
          });""",
)

io.open(SRC, 'w', encoding='utf-8').write(s)
print('OK   ai.service.ts')
