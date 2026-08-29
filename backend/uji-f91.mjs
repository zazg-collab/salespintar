// Uji Fase 91 — dijalankan atas src/services/answer-cache.service.ts YANG SEBENARNYA.
// Berkasnya di-transpile utuh lalu require-nya distub, jadi yang diuji bukan salinan
// pola yang gampang melenceng dari aslinya.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const req = createRequire(import.meta.url);
const ts = req(path.resolve('node_modules/typescript'));
const SRC = 'src/services/answer-cache.service.ts';
const js = ts.transpileModule(fs.readFileSync(SRC, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

// PRICE_PATTERN asli, disalin persis dari supervisor.service.ts supaya stub-nya
// bukan tebakan kita sendiri.
const supSrc = fs.readFileSync('src/services/supervisor.service.ts', 'utf8');
const m = supSrc.match(/export const PRICE_PATTERN = (\/.*\/i);/);
if (!m) throw new Error('PRICE_PATTERN tidak ditemukan di supervisor.service.ts — tesnya jadi tidak sah');
const PRICE_PATTERN = eval(m[1]); // eslint-disable-line no-eval -- regex literal dari source asli

let insertCalls = [];
const stubPrisma = {
  $queryRawUnsafe: async () => [],
  $executeRawUnsafe: async (sql, ...params) => {
    if (/INSERT INTO answer_cache/.test(sql)) insertCalls.push(params);
    return 1;
  },
};
const stubEnv = { ANSWER_CACHE_ENABLED: true, ANSWER_CACHE_TTL_SEC: 3600 };
const stubLogger = { info() {}, warn() {}, debug() {} };
const stubKnowledge = { getEmbedding: async () => new Array(8).fill(0.01) };

const stubs = {
  '../config/prisma': { prisma: stubPrisma },
  '../config/env': { env: stubEnv },
  '../utils/logger': { logger: stubLogger },
  './knowledge.service': { knowledgeService: stubKnowledge },
  './supervisor.service': { PRICE_PATTERN },
};
const fakeRequire = (id) => {
  if (stubs[id]) return stubs[id];
  throw new Error(`modul tak distub diminta: ${id}`);
};

const mod = { exports: {} };
new Function('exports', 'require', 'module', js)(mod.exports, fakeRequire, mod);
const { rememberAnswer } = mod.exports;

let lulus = 0, gagal = 0;
function uji(nama, kondisi, detail = '') {
  if (kondisi) { lulus++; console.log(`  ✅ ${nama}`); }
  else { gagal++; console.log(`  ❌ ${nama}${detail ? '  → ' + detail : ''}`); }
}

async function coba(jawaban, nama) {
  insertCalls = [];
  await rememberAnswer({
    businessId: '00000000-0000-0000-0000-000000000000',
    question: 'pertanyaan uji ' + nama,
    answer: jawaban,
    leadName: null,
  });
  return insertCalls.length > 0;
}

console.log('\n1. Jawaban umum biasa (tanpa harga, tanpa nama) — HARUS tersimpan');
{
  const tersimpan = await coba(
    'Untuk pemesanan, Kakak bisa transfer atau COD sesuai preferensi. Alamat lengkap nanti kami minta ya.',
    'umum',
  );
  uji('tersimpan ke answer_cache', tersimpan === true);
}

console.log('\n2. Jawaban berisi klaim harga (kasus Purwokerto) — TIDAK BOLEH tersimpan (Fase 91)');
{
  const tersimpan = await coba(
    'Ongkir ke Purwokerto, Jawa Tengah untuk paket 1 kg sekarang adalah Rp 8.000 dengan SiCepat, jadi totalnya Rp 147.000 ya Kak.',
    'purwokerto',
  );
  uji('TIDAK tersimpan', tersimpan === false, tersimpan ? 'malah tersimpan!' : '');
}

console.log('\n3. Jawaban berisi angka "ribu"/"juta" (bentuk lain nominal) — TIDAK BOLEH tersimpan');
{
  const tersimpan = await coba(
    'Harganya 142 ribu saja Kak, sudah termasuk kemasan rapi dan siap kirim ke alamat Kakak.',
    'ribu',
  );
  uji('TIDAK tersimpan', tersimpan === false, tersimpan ? 'malah tersimpan!' : '');
}

console.log('\n4. Jawaban berisi nama pelanggan (pengaman lama, Fase <91) — tetap TIDAK tersimpan');
{
  insertCalls = [];
  await rememberAnswer({
    businessId: '00000000-0000-0000-0000-000000000000',
    question: 'siapa nama saya',
    answer: 'Halo Kak Fatih, untuk pemesanan silakan kirim alamat lengkap dan metode pembayaran yang diinginkan ya.',
    leadName: 'Fatih Ramadhan',
  });
  uji('TIDAK tersimpan', insertCalls.length === 0, insertCalls.length ? 'malah tersimpan!' : '');
}

console.log('\n5. Jawaban terlalu pendek (pengaman lama) — tetap TIDAK tersimpan');
{
  const tersimpan = await coba('Baik Kak.', 'pendek');
  uji('TIDAK tersimpan', tersimpan === false, tersimpan ? 'malah tersimpan!' : '');
}

console.log(`\n${lulus} lulus, ${gagal} gagal dari ${lulus + gagal} pemeriksaan.`);
process.exit(gagal > 0 ? 1 : 0);
