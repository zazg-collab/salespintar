import io

SRC = 'src/services/ai.service.ts'
s = io.open(SRC, encoding='utf-8').read()

def once(old, new):
    global s
    assert s.count(old) == 1, 'jangkar tidak unik/tidak ketemu: %r' % old[:80]
    s = s.replace(old, new)

once(
    "import { detectShippingIntent } from '../utils/shipping-intent';",
    "import { detectShippingIntent } from '../utils/shipping-intent';\n"
    "import { questionDelivered } from '../utils/location-resolver';",
)

once(
    """    if (pertanyaanSiap && wajibSebut.length > 0) {
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
    """    if (pertanyaanSiap && !questionDelivered(reply, wajibSebut)) {
      logger.warn(
        `[AI] Balasan model TIDAK menyampaikan pertanyaan tujuan — diganti ` +
        `pertanyaan yang sudah disusun. Balasan yang dibuang: "${reply.slice(0, 120)}"`,
      );
      reply = pertanyaanSiap;
    }""",
)

io.open(SRC, 'w', encoding='utf-8').write(s)
print('OK   ai.service.ts memakai questionDelivered()')
