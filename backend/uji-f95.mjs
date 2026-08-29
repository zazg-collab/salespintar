// Uji Fase 95 — dijalankan atas src/services/ai.service.ts YANG SEBENARNYA.
// Fokus: bentuk pesan yang dikirim ke model (susunPesanBalasan), BUKAN isi
// jawaban model itu sendiri (itu di luar jangkauan uji statis).
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const req = createRequire(import.meta.url);
const ts = req(path.resolve('node_modules/typescript'));
const SRC = 'src/services/ai.service.ts';
const js = ts.transpileModule(fs.readFileSync(SRC, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

let capturedMessages = null;
const stubComplete = async (_job, opts) => {
  capturedMessages = opts.messages;
  return { text: 'Balasan uji.', model: 'uji-model' };
};

const stubs = {
  '../config/env': { env: { GROQ_DAILY_CAP_PER_LEAD: 999, KNOWLEDGE_TOP_K: 5, KNOWLEDGE_CONTEXT_MAX_CHARS: 6000, ANSWER_CACHE_ENABLED: false } },
  './llm': { complete: stubComplete },
  '../config/prisma': {
    prisma: {
      lead: { findUnique: async () => ({ id: 'lead-1', name: 'Fatih' }) },
      message: { findMany: async () => (globalThis.__uji_recentMessages || []) },
    },
  },
  '../utils/logger': { logger: { info() {}, warn() {}, error() {}, debug() {} } },
  './rate-limit.service': { getTodayAiCount: async () => 0 },
  './answer-cache.service': { lookupCachedAnswer: async () => null, rememberAnswer: async () => {} },
  './mengantar.service': {
    getShippingQuotes: async () => null,
    quotesToKnowledgeChunk: () => '',
    askInstruction: () => '',
    getShippingQuotesForChoice: async () => null,
    unresolvedToKnowledgeChunk: () => '',
  },
  '../utils/shipping-intent': { detectShippingIntent: () => null },
  '../utils/location-resolver': { questionDelivered: () => true },
  './shipping-dialog.service': {
    rememberQuestion: async () => {},
    getPendingQuestion: async () => null,
    forgetQuestion: async () => {},
    looksLikePlaceAnswer: () => false,
    matchAnswerToChoice: () => null,
    combineAnswer: (a) => a,
    rememberQuotes: async () => {},
    getRememberedQuotes: async () => null,
    looksLikeQuoteFollowUp: () => false,
  },
  './state.service': {
    CONSECUTIVE_LIMIT: 3,
    getConsecutiveCount: async () => 0,
    incrementConsecutive: async () => {},
    isReplyRateLimited: async () => false,
    markReplied: async () => {},
  },
  './knowledge.service': {
    knowledgeService: { searchRelevantKnowledge: async () => ['Bedog Betekok — harga Rp 139.000.'] },
  },
  './katalog-gambar.service': { pisahkanPenanda: (t) => ({ teksBersih: t, diminta: [] }) },
};
const fakeRequire = (id) => {
  if (stubs[id]) return stubs[id];
  throw new Error(`modul tak distub diminta: ${id}`);
};

const mod = { exports: {} };
new Function('exports', 'require', 'module', js)(mod.exports, fakeRequire, mod);
const { generateReply, getSystemPrompt } = mod.exports;

let lulus = 0, gagal = 0;
function uji(nama, kondisi, detail = '') {
  if (kondisi) { lulus++; console.log(`  ✅ ${nama}`); }
  else { gagal++; console.log(`  ❌ ${nama}${detail ? '  → ' + detail : ''}`); }
}

console.log('\n1. Pelanggan BARU, 0 riwayat — pesan user TIDAK berlabel nama');
{
  globalThis.__uji_recentMessages = [];
  capturedMessages = null;
  await generateReply('biz-1', 'lead-1', 'halo', 'Fatih', 'Toko Uji');
  const userMsg = capturedMessages.find(m => m.role === 'user');
  uji('content user PERSIS "halo" (tanpa "Fatih: ")', userMsg.content === 'halo', JSON.stringify(userMsg.content));
  const ctxMsg = capturedMessages[1];
  uji('sistem menyebut nama pelanggan', ctxMsg.content.includes('Fatih'));
  uji('sistem bilang ini pesan PERTAMA', /PERTAMA/.test(ctxMsg.content));
  uji('tidak ada header kosong "Konteks percakapan:\\n" tanpa isi', !/^Konteks percakapan:\s*$/.test(ctxMsg.content));
}

console.log('\n2. Pelanggan dengan riwayat — pesan user tetap TIDAK berlabel nama');
{
  globalThis.__uji_recentMessages = [
    { message: 'halo', fromRole: 'LEAD' },
    { message: 'Halo Kak, ada yang bisa dibantu?', fromRole: 'AI' },
  ];
  capturedMessages = null;
  await generateReply('biz-1', 'lead-1', 'aku mau pesan bedog betekok', 'Fatih', 'Toko Uji');
  const userMsg = capturedMessages.find(m => m.role === 'user');
  uji('content user PERSIS pesan asli (tanpa "Fatih: ")', userMsg.content === 'aku mau pesan bedog betekok', JSON.stringify(userMsg.content));
  const ctxMsg = capturedMessages[1];
  uji('sistem menyebut nama pelanggan', ctxMsg.content.includes('Fatih'));
  uji('riwayat transkrip tetap ada (Pelanggan:/AI:)', /Pelanggan: halo/.test(ctxMsg.content) && /AI: Halo Kak/.test(ctxMsg.content));
}

console.log('\n3. getSystemPrompt() memuat aturan baru');
{
  const prompt = getSystemPrompt('Toko Uji');
  uji('aturan "satu giliran bicara" ada', /satu giliran bicara/i.test(prompt));
  uji('aturan larangan varian karangan ada', /varian/i.test(prompt) && /pengetahuan yang diberikan/i.test(prompt));
}

console.log(`\n${lulus} lulus, ${gagal} gagal dari ${lulus + gagal} pemeriksaan.`);
process.exit(gagal > 0 ? 1 : 0);
