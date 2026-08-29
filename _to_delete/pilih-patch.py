import io

# ─────────────────────────────────────────────────────────────────────────────
# 1. mengantar.service.ts — kandidat ikut dikembalikan + tarif langsung per pilihan
# ─────────────────────────────────────────────────────────────────────────────
SRC = 'src/services/mengantar.service.ts'
s = io.open(SRC, encoding='utf-8').read()

def once(old, new):
    global s
    assert s.count(old) == 1, 'jangkar tidak unik/tidak ketemu: %r' % old[:80]
    s = s.replace(old, new)

once(
    """  mustMention: string[];
}""",
    """  mustMention: string[];
  /**
   * Pilihan yang ditawarkan, lengkap dengan id alamatnya.
   *
   * Disertakan supaya giliran berikutnya tidak perlu mencari ulang: jawaban
   * pelanggan cukup DICOCOKKAN ke daftar ini, lalu tarifnya diambil langsung.
   * Lihat catatan panjang di `PendingShippingQuestion.choices`.
   */
  choices: Array<{ addressId: string; cityLabel: string; province: string }>;
}""",
)

once(
    """function bertanya(candidates: Candidate[], keyword: string): AmbiguousDestination {
  return {
    ambiguous: true,
    question: buildQuestion(keyword, candidates),
    keyword,
    mustMention: questionMustMention(candidates),
  };
}""",
    """function bertanya(candidates: Candidate[], keyword: string): AmbiguousDestination {
  return {
    ambiguous: true,
    question: buildQuestion(keyword, candidates),
    keyword,
    mustMention: questionMustMention(candidates),
    choices: candidates
      .map(c => ({
        addressId: rowAddressId(c.row) ?? '',
        cityLabel: prettyPlace(c.cityLabel),
        province: prettyPlace(c.province),
      }))
      .filter(c => c.addressId),
  };
}

/**
 * Ambil tarif untuk satu pilihan yang SUDAH dipastikan.
 *
 * Dipakai pada giliran susulan, sesudah jawaban pelanggan dicocokkan ke daftar
 * pilihan. Tidak ada pencarian lokasi lagi di sini — id alamatnya sudah ada,
 * jadi tidak ada lagi kesempatan bagi kata kunci yang salah susun untuk
 * menggagalkan seluruh percakapan.
 */
export async function getShippingQuotesForChoice(params: {
  addressId: string;
  cityLabel: string;
  province: string;
  weightKg?: number | null;
}): Promise<ShippingResult | null> {
  if (!isMengantarEnabled()) return null;

  const originId = await resolveOriginId();
  if (!originId) return null;

  const weight = params.weightKg && params.weightKg > 0
    ? params.weightKg
    : env.MENGANTAR_DEFAULT_WEIGHT_KG;

  const cand: Candidate = {
    row: { _id: params.addressId },
    cityLabel: params.cityLabel,
    province: params.province,
    weight: 1,
    primary: true,
  };
  return quoteFor(cand, originId, weight, undefined);
}""",
)

io.open(SRC, 'w', encoding='utf-8').write(s)
print('OK   mengantar.service.ts')

# ─────────────────────────────────────────────────────────────────────────────
# 2. ai.service.ts — jawaban dicocokkan ke pilihan lebih dulu
# ─────────────────────────────────────────────────────────────────────────────
SRC = 'src/services/ai.service.ts'
s = io.open(SRC, encoding='utf-8').read()

once(
    """import {
  askInstruction,
  unresolvedToKnowledgeChunk,""",
    """import {
  askInstruction,
  getShippingQuotesForChoice,
  unresolvedToKnowledgeChunk,""",
)

once(
    """import {
  rememberQuestion,
  getPendingQuestion,
  forgetQuestion,
  looksLikePlaceAnswer,
  combineAnswer,
} from './shipping-dialog.service';""",
    """import {
  rememberQuestion,
  getPendingQuestion,
  forgetQuestion,
  looksLikePlaceAnswer,
  matchAnswerToChoice,
  combineAnswer,
} from './shipping-dialog.service';""",
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
        shippingWeight = pending.weightKg;
      } else {
        // Tidak menunjuk tepat satu pilihan (mis. pelanggan menyebut kecamatan
        // yang belum pernah kita tawarkan). Cadangannya: susun kata kunci seperti
        // dulu, tapi kini dengan penyaring kata sapaan yang sama.
        shippingKeyword = combineAnswer(pending.keyword, messageText);
        shippingWeight = pending.weightKg;
        logger.info(
          `[AI] "${messageText}" tidak menunjuk satu pilihan — dicari sebagai "${shippingKeyword}"`,
        );
      }
    }""",
)

once(
    """    let perintahTanya: string | null = null;
    let wajibSebut: string[] = [];""",
    """    let perintahTanya: string | null = null;
    let wajibSebut: string[] = [];
    /** Pilihan yang sudah dipastikan dari jawaban pelanggan, kalau ada. */
    let pilihanTerpilih: { addressId: string; cityLabel: string; province: string } | null = null;""",
)

# Cabang tarif langsung dari pilihan, sebelum cabang pencarian biasa.
once(
    """    if (shippingKeyword) {
      try {
        const lookup = await getShippingQuotes({""",
    """    // ── Tarif untuk pilihan yang sudah dipastikan ───────────────────────────
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

io.open(SRC, 'w', encoding='utf-8').write(s)
print('OK   ai.service.ts')
