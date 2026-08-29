/**
 * Menyuling 1000 ekspor chat WhatsApp jadi satu ringkasan yang cukup kecil untuk
 * ditambang Gemini.
 *
 * ── Kenapa 1000 berkas tidak boleh langsung dikirim ke Gemini ───────────────
 * Tiga alasan, dan ketiganya menghalangi:
 *
 * 1. Aplikasi Gemini tidak membuka zip, dan tidak menerima seribu lampiran.
 * 2. Seribu ekspor kira-kira tiga juta token. Konteks Gemini besar, tapi tidak
 *    sebesar itu — dan mendekati batas konteks, ketelitiannya turun justru pada
 *    bagian tengah, yang tidak akan kelihatan sebagai galat.
 * 3. Yang lebih menentukan: seribu chat TIDAK memuat seribu pertanyaan berbeda.
 *    Isinya beberapa ratus pertanyaan yang sama, diulang dengan kalimat berbeda.
 *    Mengirim semuanya berarti membayar Gemini untuk membaca hal yang sama
 *    ratusan kali, lalu berharap dia menghitungnya dengan benar.
 *
 * ── Jadi yang dikirim bukan chatnya, melainkan tabel frekuensinya ───────────
 * Alat ini membaca semua ekspor secara lokal, mengambil HANYA pertanyaan
 * pelanggan, membuang data pribadi, lalu mengelompokkan pertanyaan yang maknanya
 * sama memakai model embedding yang SUDAH ada di aplikasi ini
 * (multilingual-e5-small, berjalan di mesin sendiri, tanpa biaya).
 *
 * Hasilnya: "pertanyaan ini muncul 47 kali, begini contoh CS menjawabnya" —
 * beberapa ratus baris, masuk satu prompt dengan lapang. Tugas Gemini berubah
 * dari membaca kebisingan jadi menulis dokumen, dan itu yang memang ia kuasai.
 *
 * ── Yang dipakai dari kode produksi, bukan disalin ──────────────────────────
 * Pembaca ekspor (`parseWhatsAppExport`), penebak nama CS (`guessCsNames`), dan
 * model embedding (`knowledgeService.getEmbedding`) semuanya diimpor. Alat yang
 * menyalin logika pembacaan akan menyimpang dari aplikasinya tanpa ada yang
 * sadar, lalu melaporkan chat yang tidak pernah ada.
 *
 * Pakai:
 *   npx tsx siapkan-tambang.ts                       # baca ./chat-exports
 *   npx tsx siapkan-tambang.ts --dir=~/Downloads/wa  # folder lain
 *   npx tsx siapkan-tambang.ts --mirip=0.88          # ambang kemiripan
 *   npx tsx siapkan-tambang.ts --min=3               # hanya yang muncul >= 3x
 */

import fs from 'fs';
import path from 'path';
import AdmZip from 'adm-zip';
import { parseWhatsAppExport, guessCsNames, type ParsedChat } from './src/services/wa-export-parser';
import { knowledgeService } from './src/services/knowledge.service';
import { redisCache, redisBull } from './src/config/redis';
import { prisma } from './src/config/prisma';

// ─── Argumen ──────────────────────────────────────────────────────────────────

function arg(nama: string, bawaan: string): string {
  const a = process.argv.find(x => x.startsWith(`--${nama}=`));
  return a ? a.split('=').slice(1).join('=') : bawaan;
}

const DIR = arg('dir', './chat-exports').replace(/^~/, process.env.HOME ?? '~');
/**
 * Ambang kemiripan untuk menganggap dua pertanyaan "sama".
 *
 * 0,88 dipilih supaya "ongkir ke jakarta berapa" dan "brp ongkir ke jkt"
 * menyatu, tapi "ongkir ke jakarta" dan "ongkir ke surabaya" TIDAK — dua kota
 * berbeda itu pertanyaan berbeda walau kalimatnya nyaris identik.
 *
 * Terlalu tinggi: satu pertanyaan terpecah jadi sepuluh kelompok dan tabel
 * frekuensinya jadi tidak berarti. Terlalu rendah: pertanyaan yang berbeda
 * tergabung dan Gemini menulis satu dokumen untuk dua hal.
 */
const AMBANG_MIRIP = Number(arg('mirip', '0.88'));
const MIN_MUNCUL = Number(arg('min', '2'));

// ─── Membuang data pribadi ────────────────────────────────────────────────────

/**
 * Data pribadi dibuang SEBELUM apa pun keluar dari mesin ini.
 *
 * Bukan kehati-hatian berlebihan: hasil alat ini akan ditempel ke Gemini, lalu
 * jadi dokumen yang dibaca bot saat melayani pelanggan LAIN. Nomor telepon yang
 * lolos ke pustaka bisa muncul di jawaban ke orang yang salah, dan itu kebocoran
 * yang tidak bisa ditarik kembali.
 *
 * Urutannya disengaja: nomor telepon dulu (paling panjang), baru angka lain,
 * supaya nomor tidak tersobek jadi potongan yang lolos pemeriksaan berikutnya.
 */
function buangDataPribadi(teks: string): string {
  return teks
    // Nomor telepon Indonesia dalam berbagai bentuk.
    .replace(/(\+?62|0)8\d{2}[\s.-]?\d{3,4}[\s.-]?\d{3,5}/g, '[NOMOR]')
    // Nomor resi: campuran huruf-angka panjang.
    .replace(/\b[A-Z]{2,4}\d{8,}\b/gi, '[RESI]')
    // Deretan angka panjang: rekening, nomor pesanan.
    .replace(/\b\d{9,}\b/g, '[ANGKA]')
    // Nominal rupiah. Harga di chat lama bisa sudah tidak berlaku, dan angka
    // basi yang tampak resmi lebih berbahaya daripada tidak ada angka.
    .replace(/rp\.?\s*\d[\d.,]*\s*(?:rb|ribu|k|jt|juta)?/gi, '[NOMINAL]')
    .replace(/\b\d[\d.,]*\s*(?:rb|ribu|jt|juta)\b/gi, '[NOMINAL]')
    // Email.
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '[EMAIL]')
    .trim();
}

// ─── Mengenali pertanyaan pelanggan ───────────────────────────────────────────

/**
 * Apakah kalimat ini pertanyaan yang layak jadi dokumen?
 *
 * Yang dibuang: sapaan, ucapan terima kasih, konfirmasi satu kata. Itu bukan
 * pengetahuan, dan kalau ikut masuk ia akan mendominasi tabel frekuensi —
 * "oke kak" pasti jadi juara di chat mana pun, dan itu tidak memberi tahu apa
 * pun soal apa yang pelanggan perlu tahu.
 */
const BUKAN_PERTANYAAN = /^(ok|oke|okey|siap|baik|iya|ya|makasih|terima kasih|thanks|thx|sip|mantap|halo|hai|hi|assalam|p|test|😀|👍|🙏)[\s.,!?]*$/i;

const TANDA_TANYA = /\?|^(apa|apakah|berapa|brp|brapa|gimana|gmn|bagaimana|kapan|dimana|dmn|di mana|kenapa|knp|bisa|bs|boleh|ada|adakah|minta|mau tanya|tanya|mohon info|info)\b/i;

function layakDikumpulkan(teks: string): boolean {
  const t = teks.trim();
  if (t.length < 8 || t.length > 300) return false;
  if (BUKAN_PERTANYAAN.test(t)) return false;
  if (!TANDA_TANYA.test(t)) return false;
  // Harus memuat huruf yang cukup; pesan yang isinya hampir semua penanda
  // pengganti tidak bisa dibaca lagi maknanya.
  const huruf = (t.match(/[a-zA-Z]/g) ?? []).length;
  return huruf >= t.length * 0.4;
}

// ─── Pembacaan berkas ─────────────────────────────────────────────────────────

interface Sumber { nama: string; isi: string; }

function kumpulkanBerkas(dir: string): Sumber[] {
  if (!fs.existsSync(dir)) {
    console.error(`\nFolder "${dir}" tidak ada.`);
    console.error(`Buat foldernya, taruh ekspor chat (.txt atau .zip) di dalamnya, lalu jalankan lagi.`);
    console.error(`Atau tunjuk folder lain: npx tsx siapkan-tambang.ts --dir=~/Downloads/wa\n`);
    process.exit(1);
  }

  const out: Sumber[] = [];
  const antre: string[] = [dir];

  while (antre.length > 0) {
    const sekarang = antre.pop()!;
    for (const entri of fs.readdirSync(sekarang, { withFileTypes: true })) {
      const p = path.join(sekarang, entri.name);
      if (entri.isDirectory()) { antre.push(p); continue; }

      if (entri.name.toLowerCase().endsWith('.txt')) {
        out.push({ nama: entri.name, isi: fs.readFileSync(p, 'utf-8') });
      } else if (entri.name.toLowerCase().endsWith('.zip')) {
        // Ekspor WhatsApp sering berupa zip berisi _chat.txt. Dibuka di sini
        // supaya Angga tidak perlu membongkar seribu zip satu per satu.
        try {
          for (const e of new AdmZip(p).getEntries()) {
            if (e.isDirectory || !e.entryName.toLowerCase().endsWith('.txt')) continue;
            out.push({ nama: `${entri.name}/${e.entryName}`, isi: e.getData().toString('utf-8') });
          }
        } catch (err) {
          console.log(`  ! ${entri.name} gagal dibuka: ${err instanceof Error ? err.message : err}`);
        }
      }
    }
  }
  return out;
}

// ─── Pengelompokan berdasarkan makna ──────────────────────────────────────────

interface Kelompok {
  /** Bentuk kalimat yang dipakai mewakili — yang paling sering muncul. */
  wakil: string;
  pusat: number[];
  /** Semua bentuk kalimat di kelompok ini beserta hitungannya. */
  bentuk: Map<string, number>;
  total: number;
  /** Contoh jawaban CS untuk pertanyaan ini. */
  jawaban: string[];
}

function kosinus(a: number[], b: number[]): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i]! * b[i]!;
  return dot;   // e5 menghasilkan vektor ternormalisasi, jadi dot = kosinus
}

// ─── Utama ────────────────────────────────────────────────────────────────────

async function tutup() {
  await Promise.allSettled([redisCache.quit(), redisBull.quit(), prisma.$disconnect()]);
}

async function main() {
  console.log(`\nMenyuling ekspor chat dari: ${DIR}`);

  const berkas = kumpulkanBerkas(DIR);
  if (berkas.length === 0) {
    console.error(`Tidak ada .txt atau .zip di folder itu.\n`);
    await tutup();
    process.exit(1);
  }
  console.log(`${berkas.length} berkas ditemukan. Membaca...`);

  const chats: ParsedChat[] = [];
  const asal: string[] = [];
  for (const b of berkas) {
    try {
      const c = parseWhatsAppExport(b.isi);
      if (c.messages.length > 0) { chats.push(c); asal.push(b.nama); }
    } catch { /* berkas tidak terbaca — dilewati, dihitung di bawah */ }
  }
  console.log(`${chats.length} berkas terbaca sebagai chat WhatsApp.`);

  // Nama CS ditebak dari SELURUH kumpulan: nama yang muncul di banyak berkas
  // hampir pasti orang toko, bukan pelanggan. Ini yang memisahkan pertanyaan
  // dari jawaban tanpa perlu Angga memberi tahu siapa CS-nya.
  const csNames = guessCsNames(chats);
  console.log(`Nama yang dianggap pihak toko: ${csNames.length > 0 ? csNames.join(', ') : '(tidak ada yang cukup sering muncul)'}`);
  if (csNames.length === 0) {
    console.log(`  ! Tanpa ini, jawaban CS bisa ikut terhitung sebagai pertanyaan pelanggan.`);
    console.log(`    Kalau hasilnya terasa aneh, pastikan ekspornya dari beberapa chat berbeda.`);
  }

  // ── Kumpulkan pertanyaan pelanggan + jawaban CS sesudahnya ─────────────────
  const csSet = new Set(csNames.map(n => n.toLowerCase()));
  const mentah: Array<{ tanya: string; jawab: string | null }> = [];
  let totalPesan = 0;

  for (const chat of chats) {
    for (let i = 0; i < chat.messages.length; i++) {
      const m = chat.messages[i]!;
      totalPesan += 1;
      if (csSet.has(m.sender.toLowerCase())) continue;      // ini pihak toko

      const bersih = buangDataPribadi(m.text);
      if (!layakDikumpulkan(bersih)) continue;

      // Jawaban CS = pesan berikutnya dari pihak toko, kalau ada.
      let jawab: string | null = null;
      for (let j = i + 1; j < Math.min(i + 4, chat.messages.length); j++) {
        const n = chat.messages[j]!;
        if (csSet.has(n.sender.toLowerCase())) {
          const jb = buangDataPribadi(n.text);
          if (jb.length >= 10) jawab = jb.slice(0, 400);
          break;
        }
      }
      mentah.push({ tanya: bersih, jawab });
    }
  }

  console.log(`\n${totalPesan} pesan dibaca → ${mentah.length} pertanyaan pelanggan dikumpulkan.`);
  if (mentah.length === 0) {
    console.error('Tidak ada yang bisa disuling.\n');
    await tutup();
    process.exit(1);
  }

  // ── Gabungkan yang persis sama lebih dulu (murah) ──────────────────────────
  // Ini memangkas pekerjaan embedding secara besar-besaran sebelum model
  // dijalankan: chat sungguhan penuh kalimat yang identik huruf per huruf.
  const persisSama = new Map<string, { hitung: number; jawaban: string[] }>();
  for (const r of mentah) {
    const kunci = r.tanya.toLowerCase().replace(/\s+/g, ' ').trim();
    const e = persisSama.get(kunci) ?? { hitung: 0, jawaban: [] };
    e.hitung += 1;
    if (r.jawab && e.jawaban.length < 3) e.jawaban.push(r.jawab);
    persisSama.set(kunci, e);
  }
  console.log(`${persisSama.size} bentuk kalimat unik (sesudah menggabungkan yang identik).`);

  // ── Kelompokkan berdasarkan MAKNA ─────────────────────────────────────────
  console.log(`\nMenghitung embedding lokal (gratis, tanpa API)...`);
  const kelompok: Kelompok[] = [];
  let ke = 0;
  const urut = [...persisSama.entries()].sort((a, b) => b[1].hitung - a[1].hitung);

  for (const [kalimat, data] of urut) {
    ke += 1;
    if (ke % 50 === 0) process.stdout.write(`\r  ${ke}/${urut.length}...`);

    let vec: number[];
    try {
      vec = await knowledgeService.getEmbedding(kalimat, 'query');
    } catch {
      continue;   // satu kalimat gagal tidak boleh menggagalkan seluruh proses
    }

    // Pencocokan bertahap ke pusat kelompok yang sudah ada — bukan
    // perbandingan semua-lawan-semua, yang untuk sepuluh ribu kalimat berarti
    // seratus juta perbandingan dan memori yang tidak masuk akal.
    let terbaik: Kelompok | null = null;
    let nilaiTerbaik = 0;
    for (const k of kelompok) {
      const s = kosinus(vec, k.pusat);
      if (s > nilaiTerbaik) { nilaiTerbaik = s; terbaik = k; }
    }

    if (terbaik && nilaiTerbaik >= AMBANG_MIRIP) {
      terbaik.bentuk.set(kalimat, data.hitung);
      terbaik.total += data.hitung;
      for (const j of data.jawaban) if (terbaik.jawaban.length < 4) terbaik.jawaban.push(j);
      // Wakil selalu bentuk yang paling sering — itu yang paling wajar dibaca.
      const terbanyak = [...terbaik.bentuk.entries()].sort((a, b) => b[1] - a[1])[0]!;
      terbaik.wakil = terbanyak[0];
    } else {
      kelompok.push({
        wakil: kalimat,
        pusat: vec,
        bentuk: new Map([[kalimat, data.hitung]]),
        total: data.hitung,
        jawaban: data.jawaban.slice(0, 4),
      });
    }
  }
  process.stdout.write(`\r  ${urut.length}/${urut.length} selesai.\n`);

  kelompok.sort((a, b) => b.total - a.total);
  const sering = kelompok.filter(k => k.total >= MIN_MUNCUL);
  const jarang = kelompok.filter(k => k.total < MIN_MUNCUL);

  console.log(`\n${kelompok.length} kelompok makna.`);
  console.log(`  ${sering.length} muncul >= ${MIN_MUNCUL}x  → masuk laporan`);
  console.log(`  ${jarang.length} muncul < ${MIN_MUNCUL}x   → diringkas saja, TIDAK dibuang diam-diam`);

  // ── Tulis laporan ─────────────────────────────────────────────────────────
  const tanggal = new Date().toISOString().slice(0, 10);
  const L: string[] = [];

  L.push(`# Tambang Chat — Tabel Frekuensi Pertanyaan Pelanggan`);
  L.push('');
  L.push(`Disuling ${tanggal} dari **${chats.length} ekspor chat** (${totalPesan} pesan).`);
  L.push(`${mentah.length} pertanyaan pelanggan → ${persisSama.size} kalimat unik → **${kelompok.length} kelompok makna**.`);
  L.push('');
  L.push(`Data pribadi sudah dibuang di mesin lokal sebelum berkas ini dibuat: nomor`);
  L.push(`telepon, nomor resi, rekening, email, dan **semua nominal rupiah**. Nominal`);
  L.push(`dibuang karena harga di chat lama bisa sudah tidak berlaku, dan angka basi yang`);
  L.push(`tampak resmi lebih berbahaya daripada tidak ada angka.`);
  L.push('');
  L.push(`Ambang kemiripan ${AMBANG_MIRIP}. Kalau ada kelompok yang terasa mencampur dua`);
  L.push(`pertanyaan berbeda, naikkan dengan \`--mirip=0.92\` lalu jalankan lagi.`);
  L.push('');
  L.push('---');
  L.push('');
  L.push(`## Pertanyaan yang muncul >= ${MIN_MUNCUL} kali`);
  L.push('');

  for (const [i, k] of sering.entries()) {
    L.push(`### ${i + 1}. "${k.wakil}" — ${k.total}x`);
    L.push('');
    const varian = [...k.bentuk.entries()].sort((a, b) => b[1] - a[1]).slice(1, 6);
    if (varian.length > 0) {
      L.push(`Cara lain pelanggan menuliskannya: ${varian.map(([v, c]) => `"${v}" (${c}x)`).join(', ')}`);
      L.push('');
    }
    if (k.jawaban.length > 0) {
      L.push(`Contoh cara CS menjawab:`);
      L.push('');
      for (const j of k.jawaban) L.push(`> ${j.split('\n').join(' ')}`);
      L.push('');
    } else {
      L.push(`_Tidak ada jawaban CS yang tertangkap — mungkin dijawab lewat telepon, atau tidak dijawab._`);
      L.push('');
    }
  }

  if (jarang.length > 0) {
    L.push('---');
    L.push('');
    L.push(`## ${jarang.length} pertanyaan yang cuma muncul sekali`);
    L.push('');
    L.push(`Dicantumkan sebagai daftar saja, bukan dibuang. Pertanyaan langka biasanya`);
    L.push(`tidak layak jadi dokumen sendiri — tapi kalau ada yang membuatmu berpikir`);
    L.push(`"lho, ini penting", itu justru temuan.`);
    L.push('');
    for (const k of jarang.slice(0, 200)) L.push(`- ${k.wakil}`);
    if (jarang.length > 200) {
      L.push('');
      L.push(`_...dan ${jarang.length - 200} lainnya tidak dicantumkan supaya berkas ini tetap muat di satu prompt._`);
    }
    L.push('');
  }

  const namaBerkas = `tambang-siap-${tanggal.replace(/-/g, '')}.md`;
  fs.writeFileSync(namaBerkas, L.join('\n'), 'utf-8');

  const kb = Math.round(fs.statSync(namaBerkas).size / 1024);
  console.log(`\nLaporan: ${namaBerkas} (${kb} KB)`);
  console.log(`\nLangkah berikutnya: buka Gemini, unggah berkas itu, tempel isi`);
  console.log(`PROMPT-2-tambang-chat-gemini.md sebagai pesannya.\n`);

  await tutup();
}

main().catch(async err => {
  console.error('\nGagal:', err);
  await tutup();
  process.exit(1);
});
