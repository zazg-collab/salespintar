import io, re, sys

SRC = 'src/services/ai.service.ts'
s = io.open(SRC, encoding='utf-8').read()

def once(old, new):
    global s
    assert s.count(old) == 1, 'jangkar tidak unik/tidak ketemu: %r' % old[:70]
    s = s.replace(old, new)

# ── 1. Import ─────────────────────────────────────────────────────────────────
once(
    "import { getShippingQuotes, quotesToKnowledgeChunk, ambiguousToKnowledgeChunk } from './mengantar.service';\n"
    "import { detectShippingIntent } from '../utils/shipping-intent';\n",
    "import {\n"
    "  getShippingQuotes,\n"
    "  quotesToKnowledgeChunk,\n"
    "  ambiguousToKnowledgeChunk,\n"
    "  unresolvedToKnowledgeChunk,\n"
    "} from './mengantar.service';\n"
    "import { detectShippingIntent } from '../utils/shipping-intent';\n"
    "import {\n"
    "  rememberQuestion,\n"
    "  getPendingQuestion,\n"
    "  forgetQuestion,\n"
    "  looksLikePlaceAnswer,\n"
    "  combineAnswer,\n"
    "} from './shipping-dialog.service';\n",
)

# ── 2. Blok ongkir ────────────────────────────────────────────────────────────
old_blok = re.search(
    r"    const intent = detectShippingIntent\(messageText\);\n"
    r"    if \(intent\?\.destinationKeyword\) \{.*?\n    \}\n\n"
    r"    knowledgeContext =",
    s, re.DOTALL,
)
assert old_blok, 'blok ongkir tidak ketemu'

new_blok = '''    const intent = detectShippingIntent(messageText);

    // ── Menyambungkan jawaban pelanggan ke pertanyaan yang tadi diajukan ─────
    // Pencarian ongkir bekerja dari nol tiap pesan, hanya membaca teks pesan itu
    // sendiri. Jadi begitu bot bertanya "Surabayanya provinsi mana ya Kak?",
    // jawaban "lampung" jatuh ke ruang kosong — tidak memuat kata "ongkir" sama
    // sekali, jadi tidak ada yang mengenalinya sebagai jawaban.
    //
    // Ingatan pendek di Redis yang menyambungkannya. Kata yang tadi disebut
    // DIGABUNG dengan jawabannya, bukan diganti: terbukti dari data, "sukamaju"
    // sendirian menunjuk 33 kota sedangkan "sukamaju bogor" menunjuk satu.
    const pending = await getPendingQuestion(leadId);
    let shippingKeyword: string | null = null;
    let shippingWeight: number | null = null;
    let giliranSusulan = false;

    if (intent?.destinationKeyword) {
      // Pelanggan menyebut tujuan baru. Pertanyaan lama dibuang — kalau tidak,
      // "ongkir ke medan" sesudah bot menanyakan Surabaya akan dicari sebagai
      // "surabaya medan".
      shippingKeyword = intent.destinationKeyword;
      shippingWeight = intent.weightKg;
      if (pending) await forgetQuestion(leadId);
    } else if (pending && looksLikePlaceAnswer(messageText)) {
      shippingKeyword = combineAnswer(pending.keyword, messageText);
      shippingWeight = pending.weightKg;
      giliranSusulan = true;
      logger.info(`[AI] "${messageText}" dibaca sebagai jawaban atas pertanyaan "${pending.keyword}" → cari "${shippingKeyword}"`);
    }

    // Pertanyaan ongkir, DALAM ARTI LUAS: termasuk giliran susulan yang kalimatnya
    // tidak menyebut ongkir sama sekali. Dipakai untuk mematikan ingatan jawaban
    // di bawah — "lampung" tidak boleh dijawab dari jawaban lama siapa pun.
    const giliranOngkir = Boolean(intent) || giliranSusulan;

    if (shippingKeyword) {
      try {
        const lookup = await getShippingQuotes({
          destinationKeyword: shippingKeyword,
          weightKg: shippingWeight ?? undefined,
          // Batas SATU pertanyaan. Kalau jawaban pelanggan masih belum
          // menyelesaikan, bot menyerah ke manusia — menanyakan hal yang sama
          // dua kali terasa lebih bodoh daripada mengaku perlu dibantu.
          allowAsk: !giliranSusulan,
        });

        if (lookup && 'ambiguous' in lookup && lookup.ambiguous) {
          // Yang disuntikkan BUKAN tarif, melainkan pertanyaan yang sudah jadi.
          // Bot tidak boleh menyebut angka apa pun sebelum tahu kota mana.
          retrievedDocs = [ambiguousToKnowledgeChunk(lookup), ...retrievedDocs];
          await rememberQuestion(leadId, {
            keyword: shippingKeyword,
            weightKg: shippingWeight,
            asked: 1,
          });
          logger.info(`[AI] Tujuan "${shippingKeyword}" ambigu — bot bertanya: ${lookup.question}`);
        } else if (lookup && 'unresolved' in lookup && lookup.unresolved) {
          retrievedDocs = [unresolvedToKnowledgeChunk(lookup), ...retrievedDocs];
          await forgetQuestion(leadId);
          logger.warn(`[AI] Tujuan "${shippingKeyword}" tetap ambigu sesudah ditanya — diserahkan ke manusia`);
        } else if (lookup) {
          retrievedDocs = [quotesToKnowledgeChunk(lookup), ...retrievedDocs];
          await forgetQuestion(leadId);
          logger.info(
            `[AI] Ongkir ke ${lookup.destinationLabel} (${lookup.weightKg} kg): ` +
            `${lookup.quotes.length} ekspedisi disuntikkan ke konteks`,
          );
        } else {
          // Tidak ketemu. Ingatan dibuang supaya pesan berikutnya tidak terus
          // digabung dengan kata kunci yang memang tidak ada di daftar alamat.
          await forgetQuestion(leadId);
          logger.info(`[AI] Ongkir ke "${shippingKeyword}" tidak ketemu — dijawab tanpa angka`);
        }
      } catch (err) {
        // Ongkir itu pelengkap. Kegagalannya tidak boleh menghalangi pelanggan
        // mendapat jawaban.
        logger.warn(`[AI] Pencarian ongkir gagal, dilewati: ${err}`);
      }
    }

    knowledgeContext ='''

s = s[:old_blok.start()] + new_blok + s[old_blok.end():]

# ── 3. Ingatan jawaban ikut mati pada giliran susulan ─────────────────────────
once(
    "    const cached = intent ? null : await lookupCachedAnswer(businessId, messageText);",
    "    const cached = giliranOngkir ? null : await lookupCachedAnswer(businessId, messageText);",
)
once(
    "    if (!intent) {\n      await rememberAnswer({",
    "    if (!giliranOngkir) {\n      await rememberAnswer({",
)

io.open(SRC, 'w', encoding='utf-8').write(s)
print('OK   ai.service.ts diperbarui')
