import fs from 'fs/promises';
import path from 'path';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import { redisCache } from '../config/redis';

/**
 * Pengiriman gambar katalog — penandanya EKSPLISIT, dan yang memutuskan KODE.
 *
 * Aturan yang membentuk seluruh berkas ini: **model tidak pernah memilih berkas.**
 * Model paling jauh hanya boleh MENYALIN penanda yang sudah tertulis di dokumen
 * SOP/pengetahuan buatan manusia. Setiap nama yang keluar dari model dicocokkan
 * ulang dengan berkas yang benar-benar ada di folder katalog; nama yang tidak
 * cocok DIBUANG, bukan dikira-kira. Alasannya sederhana: mengirim gambar yang
 * salah ke pelanggan lebih buruk daripada tidak mengirim gambar sama sekali —
 * pelanggan bisa memesan barang yang tidak pernah kita jual.
 *
 * Bentuk penanda: `{{kirim-gambar: nama-berkas}}`
 *
 * Sengaja `{{...}}` dan BUKAN `[[...]]`: dokumen pengetahuan hidup di dalam vault
 * Obsidian, dan `[[...]]` di sana akan ditafsirkan sebagai tautan wiki — Obsidian
 * akan menampilkannya sebagai "tautan mati" dan menawarkan membuat note baru
 * bernama `kirim-gambar: ...`. Penanda yang mengotori catatan tempatnya tinggal
 * adalah penanda yang cepat atau lambat dihapus orang.
 */

const EKSTENSI_DIIZINKAN = ['.jpg', '.jpeg', '.png', '.webp'] as const;

const MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

/**
 * Global, jadi WAJIB di-reset `lastIndex`-nya atau dibuat baru tiap pakai.
 * Dibuat lewat fungsi supaya tidak ada keadaan yang terbawa antar pemanggilan —
 * regex global yang dibagikan antar request adalah sumber bug yang hanya muncul
 * pada panggilan kedua, dan itu kelas bug yang paling mahal untuk dilacak.
 */
function polaPenanda(): RegExp {
  // Dua bentuk, sengaja:
  //
  // 1. `{{kirim-gambar: nama}}` — bentuk resmi yang ditulis manusia di dokumen.
  // 2. `kirim-gambar: nama` sendirian di satu baris — bentuk SALAH yang ternyata
  //    dipancarkan model secara berkala.
  //
  // Bentuk kedua ditambahkan 2 Agustus 2026 sesudah audit menangkapnya di
  // lapangan: pada "ada foto golok naga emas ga kak" model menjawab benar lalu
  // menutup dengan baris `kirim-gambar:golok-naga` TANPA kurung kurawal. Dulu
  // baris itu tidak cocok pola mana pun, jadi dua hal buruk terjadi sekaligus:
  // pelanggan MEMBACA teks mentah "kirim-gambar:golok-naga" di WhatsApp-nya,
  // DAN fotonya tidak pernah terkirim. Intermiten — muncul di 1–3 dari 7
  // pertanyaan foto per sapuan audit.
  //
  // Diperbaiki di KODE, bukan dengan mempertegas prompt, karena prompt sudah
  // memerintahkan bentuk yang benar sejak Fase 94 dan model tetap sesekali
  // meleset. Pengaman yang bergantung pada kepatuhan model bukan pengaman.
  //
  // Bentuk kedua sengaja dibatasi pada baris yang HANYA berisi penanda (`^…$`
  // dengan flag `m`), supaya kalimat biasa yang kebetulan memuat "kirim-gambar"
  // di tengahnya tidak ikut termakan. Nama yang didapat tetap dicocokkan ulang
  // dengan berkas nyata di `pilihGambar()`, jadi longgarnya pengenalan di sini
  // tidak menambah risiko mengirim gambar yang salah.
  //
  // Bentuk KETIGA ditambahkan beberapa jam kemudian, dari sapuan audit
  // berikutnya: model menutup jawabannya dengan baris berisi kata
  // `kirim-gambar` SAJA — tanpa titik dua, tanpa nama. Tidak ada gambar yang
  // bisa dikirim dari baris itu, tapi pelanggan tetap membacanya. Jadi bagian
  // `: nama` dibuat OPSIONAL: barisnya selalu dibuang, dan nama hanya dicatat
  // kalau memang ada.
  //
  // Tiga bentuk salah dalam dua sapuan, semuanya dari model yang sama dengan
  // prompt yang sama. Itu bukan kebetulan yang bisa ditutup dengan menambah
  // satu kalimat lagi di prompt — bentuk salahnya tidak terbatas, jadi yang
  // dijaga di sini bukan "model harus benar" melainkan "pelanggan tidak boleh
  // pernah membaca kata kirim-gambar".
  //
  // Bentuk KEEMPAT, ditemukan Angga di percakapan sungguhan 2 Agustus 2026 dan
  // yang paling merusak: penanda karangan berisi URL, MENEMPEL DI TENGAH BARIS
  // pada pesan sapaan — "Ada yang bisa saya bantu? Kirim-gambar:
  // https://salespintar.id/foto-produk/12345.jpg". Tidak ada dokumen produk
  // yang diminta, tidak ada gambar yang mungkin dikirim; model mengarangnya
  // dari udara pada sapaan pertama, dan karena posisinya di tengah baris,
  // aturan "hanya baris sendiri" tidak menangkapnya.
  //
  // Jadi batas "harus satu baris sendiri" dicabut. Yang menggantikannya sebagai
  // pengaman adalah TANDA HUBUNGnya: `kirim-gambar` berhubung bukan bahasa
  // Indonesia yang wajar — orang menulis "kirim gambar" dengan spasi. Jadi
  // kemunculan bentuk berhubung, di mana pun, hampir pasti penanda dan aman
  // dibuang. Bentuk berspasi sengaja TIDAK disentuh.
  //
  // Nilainya diambil sebagai SATU token tanpa spasi (`[^\s}]+`), bukan sampai
  // akhir baris, supaya kalimat yang menyusul di belakangnya tidak ikut
  // terhapus. Nama bergasa spasi tetap tertangani lewat bentuk resmi berkurung.
  // Titik dua ikut di dalam kelompok opsional dan nilainya boleh KOSONG
  // (`[^\s}]*`, bukan `+`) — kalau tidak, `kirim-gambar:` tanpa nama akan
  // menyisakan titik dua menggantung yang tetap terbaca pelanggan.
  return /\{\{\s*kirim-gambar\s*:\s*([^}\n]+?)\s*\}\}|kirim-gambar[ \t]*(?::[ \t]*([^\s}]*))?/gi;
}

export interface GambarTerpilih {
  /** Path absolut di dalam container, siap dibaca Baileys. */
  path: string;
  namaBerkas: string;
  mime: string;
  ukuranByte: number;
}

export interface HasilPisah {
  /** Teks yang boleh dibaca pelanggan — sudah bersih dari penanda apa pun. */
  teksBersih: string;
  /** Nama mentah yang diminta penanda, urut kemunculan, belum divalidasi. */
  diminta: string[];
}

/**
 * Buang SEMUA penanda dari teks, valid maupun tidak.
 *
 * Ini dijalankan tanpa syarat: penanda yang tidak dikenali pun harus hilang.
 * Kalau penandanya dibiarkan lewat saat tidak dikenali, pelanggan akan membaca
 * `{{kirim-gambar: pisau-emas}}` di tengah balasan — dua keadaan berbeda (gambar
 * terkirim / gambar tidak ada) tidak boleh menghasilkan sinyal yang sama-sama
 * bocor ke pelanggan.
 */
export function pisahkanPenanda(teks: string): HasilPisah {
  const diminta: string[] = [];
  const teksBersih = teks
    // Dua kelompok tangkap karena polanya dua bentuk (lihat `polaPenanda()`);
    // yang tidak cocok bernilai undefined, jadi diambil yang ada.
    .replace(polaPenanda(), (_cocok, berkurung?: string, tanpaKurung?: string) => {
      const nama = (berkurung ?? tanpaKurung ?? '').trim();
      // Nilai berupa URL dibuang DIAM-DIAM, tidak dicatat sebagai permintaan.
      // Kalau dicatat, `pilihGambar()` akan melaporkannya sebagai `tidakDikenal`
      // dan Step 6b menyerahkan percakapan ke CS — hukuman untuk manusia karena
      // model mengarang sesuatu yang tidak pernah diminta pelanggan.
      const sepertiUrl = /^(https?:\/\/|www\.)/i.test(nama) || /\.(jpg|jpeg|png|webp)$/i.test(nama) && nama.includes('/');
      if (nama && !sepertiUrl) diminta.push(nama);
      return '';
    })
    // Penanda yang dibuang dari TENGAH kalimat meninggalkan spasi ganda, dan
    // yang berdiri di barisnya sendiri meninggalkan baris kosong ganda. Dua-duanya
    // dirapikan di sini — pelanggan tidak boleh bisa menebak ada sesuatu yang
    // dihapus dari pesannya.
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return { teksBersih, diminta };
}

/** Folder katalog, absolut. Relatif dihitung dari cwd proses (WORKDIR /app). */
function dirKatalog(): string {
  return path.isAbsolute(env.KATALOG_DIR)
    ? env.KATALOG_DIR
    : path.resolve(process.cwd(), env.KATALOG_DIR);
}

/**
 * Normalisasi nama supaya penulis SOP tidak perlu hafal nama berkas persis:
 * "Golok Kebun.JPG" · "golok_kebun" · "golok-kebun" → `golok-kebun`.
 */
export function normalkan(nama: string): string {
  return nama
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\.(jpg|jpeg|png|webp)$/i, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Daftar berkas katalog yang benar-benar ada. Inilah daftar-putihnya — tidak ada
 * tabel di database yang bisa menyatakan sebuah gambar "ada" kalau berkasnya
 * tidak ada. Satu sumber kebenaran, dan sumbernya adalah disk.
 */
export async function daftarKatalog(): Promise<Map<string, GambarTerpilih>> {
  const dir = dirKatalog();
  const peta = new Map<string, GambarTerpilih>();

  let isi: string[];
  try {
    isi = await fs.readdir(dir);
  } catch (err: any) {
    if (err?.code === 'ENOENT') {
      logger.debug(`[Katalog] Folder ${dir} belum ada — fitur kirim gambar diam.`);
    } else {
      logger.warn(`[Katalog] Gagal membaca ${dir}: ${err?.message || err}`);
    }
    return peta;
  }

  for (const nama of isi) {
    const ext = path.extname(nama).toLowerCase();
    if (!EKSTENSI_DIIZINKAN.includes(ext as typeof EKSTENSI_DIIZINKAN[number])) continue;

    const penuh = path.join(dir, nama);
    let stat;
    try {
      stat = await fs.stat(penuh);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;

    if (stat.size > env.KATALOG_MAKS_BYTE) {
      logger.warn(
        `[Katalog] "${nama}" dilewati: ${stat.size} byte > batas ${env.KATALOG_MAKS_BYTE}. ` +
          `Kompres dulu, atau naikkan KATALOG_MAKS_BYTE.`,
      );
      continue;
    }

    const kunci = normalkan(nama);
    const sudah = peta.get(kunci);
    if (sudah) {
      // Dua berkas bernormalisasi sama (mis. "golok-kebun.jpg" dan "Golok Kebun.png").
      // Bukan galat, tapi harus terdengar: yang mana yang dikirim jadi bergantung
      // urutan readdir, dan itu bukan perilaku yang boleh diam-diam.
      logger.warn(
        `[Katalog] Nama bentrok sesudah normalisasi: "${nama}" dan "${sudah.namaBerkas}" ` +
          `keduanya jadi "${kunci}". Yang dipakai: "${sudah.namaBerkas}". Ganti nama salah satu.`,
      );
      continue;
    }

    peta.set(kunci, {
      path: penuh,
      namaBerkas: nama,
      mime: MIME[ext] ?? 'application/octet-stream',
      ukuranByte: stat.size,
    });
  }

  return peta;
}

export interface HasilPilih {
  gambar: GambarTerpilih | null;
  /** Nama yang diminta tapi tidak ada berkasnya — untuk log & penjaga CS. */
  tidakDikenal: string[];
  /** Nama valid yang tidak dikirim karena batas satu gambar per balasan. */
  ditahanBatas: string[];
  /** Nama valid yang tidak dikirim karena baru saja dikirim ke lead yang sama. */
  ditahanJeda: string[];
  /**
   * Folder katalog kosong sama sekali (atau belum ada).
   *
   * Dibedakan dari `tidakDikenal` yang berisi sesuatu, dan pembedaan ini penting:
   * "berkas yang dijanjikan hilang" itu janji gagal yang pantas diserahkan ke CS,
   * sedangkan "fitur ini belum dipakai sama sekali" cuma berarti model menyalin
   * contoh dari dokumen SOP. Kalau keduanya diperlakukan sama, satu contoh di SOP
   * bisa memicu hujan handover ke CS untuk masalah yang tidak ada.
   */
  katalogKosong: boolean;
}

/**
 * Ubah daftar nama mentah jadi PALING SATU gambar yang benar-benar dikirim.
 *
 * Batas satu gambar per balasan itu sengaja. Balasan yang memuntahkan lima
 * gambar terasa seperti spam di WhatsApp, dan satu penanda yang salah tulis bisa
 * berlipat jadi lima kiriman salah. Kalau nanti perlu lebih, naikkan lewat env
 * setelah ada kejadian nyata yang menuntutnya — bukan sekarang.
 */
export async function pilihGambar(
  diminta: string[],
  opsi: { businessId: string; leadId: string },
): Promise<HasilPilih> {
  const hasil: HasilPilih = {
    gambar: null,
    tidakDikenal: [],
    ditahanBatas: [],
    ditahanJeda: [],
    katalogKosong: false,
  };
  if (diminta.length === 0) return hasil;
  if (!env.KATALOG_AKTIF) {
    logger.info(`[Katalog] ${diminta.length} penanda diabaikan: KATALOG_AKTIF=false.`);
    return hasil;
  }

  const katalog = await daftarKatalog();
  hasil.katalogKosong = katalog.size === 0;

  for (const mentah of diminta) {
    const kunci = normalkan(mentah);
    const cocok = katalog.get(kunci);

    if (!cocok) {
      hasil.tidakDikenal.push(mentah);
      continue;
    }
    if (hasil.gambar) {
      hasil.ditahanBatas.push(cocok.namaBerkas);
      continue;
    }
    if (await baruSajaDikirim(opsi.businessId, opsi.leadId, cocok.namaBerkas)) {
      hasil.ditahanJeda.push(cocok.namaBerkas);
      continue;
    }
    hasil.gambar = cocok;
  }

  if (hasil.tidakDikenal.length > 0) {
    logger.warn(
      `[Katalog] Penanda tanpa berkas: ${hasil.tidakDikenal.map((n) => `"${n}"`).join(', ')}. ` +
        `Tidak ada gambar dikirim untuk nama itu. Yang tersedia (${katalog.size}): ` +
        `${[...katalog.keys()].slice(0, 20).join(', ')}${katalog.size > 20 ? ', …' : ''}`,
    );
  }

  return hasil;
}

/**
 * Jeda kirim-ulang, per lead per berkas.
 *
 * Pelanggan yang menanyakan hal yang sama dua kali dalam satu percakapan tidak
 * perlu menerima foto yang sama dua kali. Dijaga di Redis, bukan di memori, karena
 * balasan bisa diproses worker mana saja (concurrency 3) dan bisa lintas proses.
 */
async function baruSajaDikirim(businessId: string, leadId: string, namaBerkas: string): Promise<boolean> {
  const jam = env.KATALOG_JEDA_ULANG_JAM;
  if (jam <= 0) return false;
  const kunci = `katalog:kirim:${businessId}:${leadId}:${normalkan(namaBerkas)}`;
  try {
    const ok = await redisCache.set(kunci, '1', 'EX', Math.round(jam * 3600), 'NX');
    return ok !== 'OK';
  } catch (err) {
    // Redis mati bukan alasan menolak mengirim katalog yang diminta pelanggan.
    // Risiko terburuknya satu gambar terkirim dua kali; itu jauh lebih ringan
    // daripada bot yang bisu karena cache-nya sakit.
    logger.warn(`[Katalog] Jeda kirim-ulang dilewati (Redis bermasalah): ${err}`);
    return false;
  }
}

/**
 * Batas panjang caption WhatsApp. Baileys tidak menolak caption panjang — ia
 * mengirimnya dan WhatsApp yang memotong, jadi pemotongan harus terjadi di sini
 * kalau kita mau tahu apa yang benar-benar dibaca pelanggan.
 */
export const CAPTION_MAKS = 1000;
