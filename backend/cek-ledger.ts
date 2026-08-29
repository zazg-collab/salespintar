/**
 * cek-ledger.ts — cari drift antara berkas di disk dan hash di ledger anti-drift.
 *
 * ── Kenapa alat ini ada ──────────────────────────────────────────────────────
 * Project ini tidak memakai git sebagai wasit antara Claude/Cowork dan
 * Antigravity (kebijakan 22 Juli 2026). Penggantinya: setiap perubahan berkas
 * kerja dicatat hash sha256-nya di
 * `projek-ceo/20260729-ledger-anti-drift-baseline.md`, dan siapa pun yang mau
 * mengedit wajib mencocokkan hash disk dengan entri terakhirnya lebih dulu.
 *
 * Masalahnya: pencocokan itu dilakukan MANUAL, per berkas, hanya untuk berkas
 * yang sedang mau disentuh. Kalau ada perubahan yang lupa dicatat, ia tidak
 * ketemu sampai ada orang yang kebetulan mau mengedit berkas itu — dan itu bisa
 * sepuluh fase kemudian. Sudah terjadi TIGA KALI:
 *
 *   - Fase 7    — section ledger tidak pernah ditulis walau handover mengklaim
 *                 sudah; 4 berkas melenceng.
 *   - Fase 46-AG — 5 berkas hasil kerja Antigravity tidak pernah tercatat.
 *                 Ketemu karena Cowork kebetulan memeriksa `supervisor.service.ts`.
 *   - Fase 59   — `ai.service.ts` melenceng sejak Fase 47 (kelalaian Cowork
 *                 sendiri, bukan Antigravity), `server.ts` sejak Fase 46-AG, dan
 *                 `audit-ai.ts` tidak pernah masuk ledger sama sekali.
 *
 * Ketiganya ketemu secara kebetulan. Alat ini membuatnya tidak lagi kebetulan:
 * satu perintah, beberapa detik, seluruh repo.
 *
 * ── Pakai ────────────────────────────────────────────────────────────────────
 *   npx tsx cek-ledger.ts
 *   npx tsx cek-ledger.ts --ledger=/path/ke/20260729-ledger-anti-drift-baseline.md
 *   LEDGER_PATH=/path/ke/ledger.md npx tsx cek-ledger.ts
 *
 * Keluar dengan kode 1 kalau ada drift — jadi bisa dipakai di pre-commit hook
 * atau dijalankan di awal sesi.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import os from 'os';

const NAMA_LEDGER = '20260729-ledger-anti-drift-baseline.md';

/** Akar repo: berkas ini ada di `backend/`, jadi naik satu tingkat. */
const AKAR_REPO = path.resolve(__dirname, '..');
/** Path di ledger ditulis relatif terhadap folder INDUK repo. */
const PREFIX_LEDGER = path.basename(AKAR_REPO) + '/';

function arg(nama: string): string | null {
  const a = process.argv.find((x) => x.startsWith(`--${nama}=`));
  return a ? a.split('=').slice(1).join('=') : null;
}

/**
 * Temukan ledger. Urutan: flag → env → tetangga repo → pencarian bertahap di
 * $HOME. Pencariannya dibatasi kedalaman 5 supaya tidak menyapu seluruh disk.
 */
function cariLedger(): string | null {
  const eksplisit = arg('ledger') ?? process.env['LEDGER_PATH'];
  if (eksplisit) {
    const p = path.resolve(eksplisit);
    return fs.existsSync(p) ? p : null;
  }

  // Tetangga repo: vault sering berada di folder induk yang sama.
  const dekat = [
    path.join(AKAR_REPO, '..', NAMA_LEDGER),
    path.join(AKAR_REPO, '..', 'projek-ceo', NAMA_LEDGER),
  ];
  for (const p of dekat) if (fs.existsSync(p)) return path.resolve(p);

  // Pencarian bertahap di $HOME.
  const antre: Array<{ dir: string; dalam: number }> = [{ dir: os.homedir(), dalam: 0 }];
  const lewati = new Set(['node_modules', '.git', 'Library', '.Trash', '.cache', 'dist', '.npm']);
  while (antre.length > 0) {
    const { dir, dalam } = antre.shift()!;
    if (dalam > 5) continue;
    let isi: fs.Dirent[];
    try { isi = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of isi) {
      if (e.isFile() && e.name === NAMA_LEDGER) return path.join(dir, e.name);
      if (e.isDirectory() && !e.name.startsWith('.') && !lewati.has(e.name)) {
        antre.push({ dir: path.join(dir, e.name), dalam: dalam + 1 });
      }
    }
  }
  return null;
}

/**
 * Kumpulkan hash TERAKHIR per berkas dari ledger.
 *
 * Bentuk baris yang dicari: `<64 hex><dua spasi><path>[  # keterangan]`.
 * Entri yang lebih baru menimpa yang lebih tua — itu memang maunya, ledgernya
 * kronologis dan yang paling bawah adalah keadaan terkini.
 */
function bacaLedger(isi: string): Map<string, { hash: string; baris: number; catatan: string }> {
  const peta = new Map<string, { hash: string; baris: number; catatan: string }>();
  const baris = isi.split('\n');
  const pola = /^([0-9a-f]{64})\s\s+(\S+)(?:\s+#\s*(.*))?$/;
  for (let i = 0; i < baris.length; i++) {
    const m = pola.exec(baris[i]!.trim());
    if (!m) continue;
    const [, hash, jalur, catatan] = m;
    peta.set(jalur!, { hash: hash!, baris: i + 1, catatan: (catatan ?? '').trim() });
  }
  return peta;
}

function hashBerkas(p: string): string | null {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
  } catch {
    return null;
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// CAKUPAN — diperluas di Fase 74
//
// Sebelum fase ini daftar di bawah cuma menyapu `backend/src`, `frontend/src`,
// plus TIGA berkas tunggal. Akibatnya empat berkas hidup berfase-fase tanpa satu
// baris pun di ledger, dan keempatnya ketemu KEBETULAN — karena ada fase yang
// kebetulan menyentuhnya:
//
//   `backend/audit-ai.ts`        ketemu Fase 59
//   `backend/src/utils/logger.ts` ketemu Fase 70
//   `backend/src/utils/errors.ts` ketemu Fase 72
//   `Dockerfile.backend` + `Dockerfile.frontend`  ketemu Fase 73
//
// Pola bersamanya jelas: **berkas yang jarang disentuh adalah yang paling sering
// luput**, dan justru berkas itulah yang paling berbahaya kalau berubah diam-diam,
// sebab tidak ada yang membacanya lagi untuk mengecek.
//
// Menambahkan satu nama ke daftar tiap kali kebetulan itu terjadi tidak
// menyelesaikan apa pun — daftarnya akan selalu ketinggalan satu kejadian.
// Jadi aturannya dibalik di sini: **sapu berdasarkan POLA, dan yang dikecualikan
// harus disebut satu per satu berikut alasannya.** Kalau nanti ada berkas baru
// yang lolos juga, yang salah adalah pengecualiannya — dan itu terbaca di kode,
// bukan tersembunyi di ketiadaan.
// ──────────────────────────────────────────────────────────────────────────────

/** Direktori yang tidak pernah dijelajah, di mana pun letaknya. */
const DIR_DILEWATI = new Set([
  'node_modules',            // bukan kode kita
  'dist', '.next', 'build',  // hasil build, dihasilkan ulang dari sumber
  '.git',                    // bukan wasit di project ini, dan isinya berubah sendiri
  '_to_delete',              // ruang tunggu penghapusan (VM device tidak bisa `rm`)
  'logs', 'uploads', 'wa_sessions', // data runtime; berubah tiap detik, bukan sumber
]);

/**
 * Berkas yang sengaja TIDAK dilacak walau letak & ekstensinya cocok.
 * Tiap baris wajib punya alasan — pengecualian tanpa alasan adalah cara lubang
 * Fase 59/70/72/73 lahir kembali dengan nama lain.
 */
function dikecualikan(nama: string): boolean {
  // Puluhan ribu baris yang berubah tiap `npm install` tanpa satu pun keputusan
  // manusia di dalamnya. Yang menentukan perilaku adalah `package.json`.
  if (nama === 'package-lock.json') return true;
  // Dihasilkan mesin, bukan ditulis orang.
  if (nama === 'next-env.d.ts' || nama.endsWith('.tsbuildinfo')) return true;
  // Berisi rahasia, DAN memang sengaja berbeda antara laptop dan server —
  // melacaknya berarti alarm drift yang menyala permanen dan akhirnya diabaikan.
  // Bentuk kuncinya sudah diwakili `env-tambahan-llm.txt` yang dilacak.
  if (nama.startsWith('.env')) return true;
  // Laporan/keluaran alat (audit-ai-*.md, audit-liputan-*.md, …), bukan sumber.
  if (nama.endsWith('.md') && nama !== 'AGENTS.md' && nama !== 'README.md') return true;
  if (nama === '.DS_Store') return true;
  return false;
}

/** Semua berkas yang layak dilacak, relatif terhadap induk repo. */
function berkasSumber(): string[] {
  const hasil: string[] = [];

  const ambil = (abs: string) => {
    if (!dikecualikan(path.basename(abs))) hasil.push(PREFIX_LEDGER + path.relative(AKAR_REPO, abs));
  };

  /** Sapu satu folder. `rekursif=false` berarti hanya isi langsungnya. */
  const sapu = (dir: string, cocok: (nama: string) => boolean, rekursif = true) => {
    let isi: fs.Dirent[];
    try { isi = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of isi) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!rekursif || DIR_DILEWATI.has(e.name) || e.name.startsWith('.')) continue;
        sapu(full, cocok, true);
      } else if (!dikecualikan(e.name) && cocok(e.name)) {
        hasil.push(PREFIX_LEDGER + path.relative(AKAR_REPO, full));
      }
    }
  };

  const KODE = new Set(['.ts', '.tsx', '.prisma', '.mjs', '.js']);
  const berekstensi = (set: Set<string>) => (n: string) => set.has(path.extname(n));

  // 1. Kode aplikasi.
  sapu(path.join(AKAR_REPO, 'backend', 'src'), berekstensi(KODE));
  sapu(path.join(AKAR_REPO, 'frontend', 'src'), berekstensi(KODE));

  // 2. Skema + SELURUH migrasi. Migrasi itu sekali-jalan dan tidak pernah
  //    disentuh lagi sesudah `migrate deploy` — kelas paling rawan luput, dan
  //    perubahan diam-diam di sini berarti skema server beda dari skema laptop.
  sapu(path.join(AKAR_REPO, 'backend', 'prisma'), berekstensi(new Set(['.prisma', '.sql'])));

  // 3. Alat & skrip sekali-jalan di akar `backend/` — di sinilah `audit-ai.ts`
  //    dan berkas ini sendiri hidup. Tidak rekursif: `src/` dan `prisma/` sudah
  //    disapu di atas.
  sapu(path.join(AKAR_REPO, 'backend'), berekstensi(KODE), false);

  // 4. Berkas yang menentukan bentuk BUILD dan PENERAPAN. Berubahnya berkas di
  //    sini tidak mengubah satu baris pun kode, tapi mengubah apa yang benar-benar
  //    jalan di server — persis kelas cacat Fase 73.
  //    `*.sh` di akar ikut: `jalankan.sh` menentukan apakah laptop menyentuh
  //    WhatsApp atau tidak — berubahnya diam-diam bisa berarti conflict 440.
  sapu(AKAR_REPO, (n) => /^Dockerfile/.test(n) || /^docker-compose[\w.-]*\.ya?ml$/.test(n) || n.endsWith('.sh'), false);
  sapu(path.join(AKAR_REPO, 'nginx'), (n) => n.endsWith('.conf'));
  sapu(path.join(AKAR_REPO, 'deploy'), () => true);   // semuanya: compose, README, skrip

  // 5. Berkas tunggal di luar pola mana pun.
  //    `package.json` masuk karena skrip `dev`/`build`/`start` dan versi
  //    dependensi ditentukan di situ; `next.config.ts` karena `rewrites()`-nya
  //    yang membuat frontend server bisa meneruskan `/api` (Fase 73).
  //    `PRD.md` sengaja TIDAK dilacak: itu dokumen niat, bukan berkas yang
  //    perilakunya dieksekusi.
  for (const p of [
    'package.json',
    'backend/package.json',
    'backend/tsconfig.json',
    'frontend/package.json',
    'frontend/tsconfig.json',
    'frontend/next.config.ts',
    'frontend/postcss.config.mjs',
    'frontend/tailwind.config.ts',
    'env-tambahan-llm.txt',
    'AGENTS.md',
  ]) {
    const abs = path.join(AKAR_REPO, p);
    if (fs.existsSync(abs)) ambil(abs);
  }

  return [...new Set(hasil)].sort();
}

// ──────────────────────────────────────────────────────────────────────────────
// PEMERIKSA PENOMORAN FASE — Fase 75
//
// Ledger ini kronologis: section paling bawah adalah keadaan terkini, dan nomor
// fase dipakai di mana-mana sebagai rujukan silang ("Riwayat: 017e6207… (F46)").
// Supaya rujukan itu berarti, penomorannya harus SATU DERET, siapa pun yang
// mengerjakan — Cowork maupun Antigravity.
//
// Yang paling mahal dari daftar di bawah bukan kerapiannya, tapi **nomor yang
// lompat**. Nomor hilang artinya ada fase yang sectionnya tidak pernah ditulis —
// dan itu persis bentuk kegagalan Fase 7 dan Fase 47: pekerjaannya nyata, hash-nya
// tidak pernah masuk, dan baru ketahuan belasan fase kemudian waktu ada yang
// kebetulan menyentuh berkasnya. Lompatan nomor adalah gejala yang muncul HARI ITU
// JUGA, jauh sebelum drift-nya menggigit.
//
// Anomali lama SENGAJA didaftar di `ANOMALI_WARISAN` dan tidak diributkan lagi.
// Menomori ulang section lama akan membuat puluhan rujukan silang jadi bohong,
// jadi keputusannya: sejarah dibiarkan, aturannya berlaku ke depan. Alat yang
// selalu merah akan berhenti dibaca — dan alat yang tidak dibaca sama saja dengan
// tidak ada.
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Anomali yang sudah ada sebelum aturan ini dibuat. Jangan tambah baris ke sini
 * untuk membungkam temuan baru — kalau ada yang baru, yang salah penomorannya,
 * bukan daftarnya.
 */
const ANOMALI_WARISAN = new Set([
  'lompat:5',      // pekerjaan Antigravity, hash-nya nebeng di section lain
  'lompat:40',     // sama; cuma disebut di prosa & komentar hash fase lain
  'lompat:49',     // tidak ada jejaknya sama sekali — nomor terlewat begitu saja
  'mundur:4',      // Fase 6 ditulis sebelum Fase 4
  'akhiran:46-AG', // Antigravity dulu pakai akhiran; sekarang tidak lagi
  'mundur:20',     // deret Antigravity sendiri, nyempil di antara Fase 53 & 54
  'dobel:20',      // akibat yang sama
]);

interface MasalahFase { kunci: string; pesan: string; }

/**
 * Baca semua heading `## Fase N` dari ledger dan laporkan penomoran yang cacat.
 * Sengaja TIDAK menggagalkan proses — ini peringatan, bukan drift.
 */
function periksaPenomoranFase(isi: string): MasalahFase[] {
  const heading = [...isi.matchAll(/^##\s+Fase\s+(\d+)(-[A-Za-z]+)?\b/gm)].map((m) => ({
    no: Number(m[1]),
    akhiran: m[2] ?? '',
  }));
  if (heading.length === 0) return [];

  const masalah: MasalahFase[] = [];
  const tambah = (kunci: string, pesan: string) => {
    if (!ANOMALI_WARISAN.has(kunci)) masalah.push({ kunci, pesan });
  };

  // 1. Akhiran seperti `-AG`. Siapa yang mengerjakan sudah tertulis di badan
  //    section; menaruhnya di nomor membuat deretnya bercabang.
  for (const h of heading) {
    if (h.akhiran) {
      tambah(`akhiran:${h.no}${h.akhiran}`,
        `Fase ${h.no}${h.akhiran} — pakai akhiran. Satu deret untuk semua; tulis pelakunya di badan section.`);
    }
  }

  // Deret utama hanya dari heading tanpa akhiran.
  const polos = heading.filter((h) => !h.akhiran).map((h) => h.no);

  // 2. Nomor dobel.
  const hitung = new Map<number, number>();
  for (const n of polos) hitung.set(n, (hitung.get(n) ?? 0) + 1);
  for (const [n, c] of [...hitung].sort((a, b) => a[0] - b[0])) {
    if (c > 1) tambah(`dobel:${n}`, `Fase ${n} muncul ${c}× sebagai heading.`);
  }

  // 3. Urutan mundur — section baru harus ditulis di bawah, bernomor lebih besar.
  for (let i = 1; i < polos.length; i++) {
    if (polos[i]! <= polos[i - 1]!) {
      tambah(`mundur:${polos[i]}`,
        `Fase ${polos[i]} ditulis sesudah Fase ${polos[i - 1]} — ledger ini kronologis, nomornya harus naik.`);
    }
  }

  // 4. Nomor lompat — yang paling penting. Lihat catatan di kepala bagian ini.
  const ada = new Set(polos);
  const maks = Math.max(...polos);
  for (let n = 1; n <= maks; n++) {
    if (!ada.has(n)) {
      tambah(`lompat:${n}`,
        `Fase ${n} tidak punya section. Kalau pekerjaannya ada tapi sectionnya tidak — itu bentuk kegagalan Fase 7 & 47: hash tidak pernah ditulis.`);
    }
  }

  return masalah;
}

function main(): void {
  const jalurLedger = cariLedger();
  if (!jalurLedger) {
    console.error(
      `Ledger "${NAMA_LEDGER}" tidak ditemukan.\n` +
      `Sebutkan lokasinya: npx tsx cek-ledger.ts --ledger=/path/ke/${NAMA_LEDGER}\n` +
      `atau setel LEDGER_PATH di lingkungan.`,
    );
    process.exit(2);
  }

  const isiLedger = fs.readFileSync(jalurLedger, 'utf-8');
  const peta = bacaLedger(isiLedger);
  const masalahFase = periksaPenomoranFase(isiLedger);
  console.log(`Ledger : ${jalurLedger}`);
  console.log(`Repo   : ${AKAR_REPO}`);
  console.log(`Tercatat: ${peta.size} berkas\n`);

  const melenceng: string[] = [];
  const hilang: string[] = [];
  const takTercatat: string[] = [];
  let cocok = 0;

  // 1. Berkas yang ADA di ledger — cocokkan hash-nya.
  for (const [jalur, entri] of [...peta.entries()].sort()) {
    const abs = path.join(path.dirname(AKAR_REPO), jalur);
    const h = hashBerkas(abs);
    if (h === null) {
      hilang.push(`${jalur}  (ledger baris ${entri.baris})`);
    } else if (h !== entri.hash) {
      melenceng.push(
        `${jalur}\n      ledger ${entri.hash.slice(0, 16)}…  (baris ${entri.baris})\n` +
        `      disk   ${h.slice(0, 16)}…\n` +
        (entri.catatan ? `      catatan terakhir: ${entri.catatan.slice(0, 110)}\n` : ''),
      );
    } else {
      cocok++;
    }
  }

  // 2. Berkas sumber yang TIDAK PERNAH masuk ledger.
  //    Inilah kelas yang paling mudah lolos: berkas BARU. `audit-ai.ts` hidup
  //    sepuluh fase tanpa satu baris pun di ledger.
  for (const jalur of berkasSumber()) {
    if (!peta.has(jalur)) takTercatat.push(jalur);
  }

  console.log(`✓ cocok        : ${cocok}`);
  console.log(`✗ MELENCENG    : ${melenceng.length}`);
  console.log(`? hilang di disk: ${hilang.length}`);
  console.log(`+ belum tercatat: ${takTercatat.length}`);
  console.log(`# penomoran fase: ${masalahFase.length === 0 ? 'rapi' : masalahFase.length + ' masalah'}`);

  if (melenceng.length > 0) {
    console.log(`\n──── MELENCENG (berubah sejak entri ledger terakhirnya) ────`);
    console.log(`Aturan rumah: JANGAN langsung timpa. Laporkan ke Angga dulu.\n`);
    for (const m of melenceng) console.log(`  ✗ ${m}`);
  }

  if (hilang.length > 0) {
    console.log(`\n──── TERCATAT TAPI TIDAK ADA DI DISK ────`);
    console.log(`Biasanya berkas yang dihapus/dipindah tanpa ledgernya diperbarui.\n`);
    for (const m of hilang) console.log(`  ? ${m}`);
  }

  if (takTercatat.length > 0) {
    console.log(`\n──── BELUM PERNAH MASUK LEDGER ────`);
    console.log(`Boleh diedit, tapi WAJIB ditambahkan barisnya sesudahnya.\n`);
    for (const m of takTercatat) console.log(`  + ${m}`);
  }

  if (masalahFase.length > 0) {
    console.log(`\n──── PENOMORAN FASE ────`);
    console.log(`Satu deret untuk semua yang mengerjakan. Anomali lama sudah dikecualikan,`);
    console.log(`jadi yang muncul di sini BARU — perbaiki sekarang selagi masih satu fase.\n`);
    for (const m of masalahFase) console.log(`  # ${m.pesan}`);
  }

  if (melenceng.length === 0 && hilang.length === 0) {
    console.log(`\nTidak ada drift.${takTercatat.length ? ' (Masih ada berkas yang belum tercatat — lihat di atas.)' : ''}`);
  }

  // Hanya drift sungguhan yang menggagalkan. Berkas belum-tercatat itu
  // peringatan, bukan penghalang — aturannya memang membolehkan.
  process.exit(melenceng.length > 0 || hilang.length > 0 ? 1 : 0);
}

main();
