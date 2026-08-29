import { prisma } from '../config/prisma';
import { redisCache } from '../config/redis';
import { logger } from '../utils/logger';

/**
 * Nama produk yang sedang dibicarakan — dipakai untuk memperkaya kueri pencarian.
 *
 * ── Masalah yang diperbaiki (Fase 110) ──────────────────────────────────────
 * Pencarian pengetahuan memakai KALIMAT PESAN ITU SENDIRI sebagai kueri. Untuk
 * pertanyaan pertama ("harga bedog betekok berapa") itu cukup. Untuk pertanyaan
 * SUSULAN tidak: "berapa harganya kak?" tidak memuat satu pun kata yang menunjuk
 * produk, jadi enam potongan teratas diambil dari 54 dokumen produk secara
 * praktis acak — terukur 2 Agustus 2026, dokumen produk yang sedang dibahas
 * TIDAK ikut terambil, dan angka yang benar jadi tampak tak berdasar di mata
 * Supervisor.
 *
 * Perbaikannya sengaja tidak memakai LLM: nama produk toko ini terbatas dan
 * tertulis apa adanya di percakapan. Mencocokkan teks jauh lebih murah, lebih
 * cepat, dan tidak bisa berhalusinasi.
 */

const KUNCI_CACHE = (businessId: string) => `produk:nama:${businessId}`;
const TTL_CACHE_SEC = 600;
/** Nama sependek 3 huruf terlalu mudah menabrak kata biasa. */
const PANJANG_NAMA_MINIMAL = 4;

/** Nama produk milik satu bisnis, dari dokumen di folder `Produk/`. */
export async function daftarNamaProduk(businessId: string): Promise<string[]> {
  try {
    const cached = await redisCache.get(KUNCI_CACHE(businessId));
    if (cached !== null) return JSON.parse(cached) as string[];
  } catch { /* cache tidak terbaca — lanjut ke DB */ }

  try {
    const rows = await prisma.$queryRaw<Array<{ title: string }>>`
      SELECT DISTINCT title FROM knowledge
      WHERE business_id = ${businessId}::uuid AND source_file ILIKE '%/Produk/%'
    `;
    const nama = rows
      .map(r => String(r.title ?? '').trim())
      .filter(n => n.length >= PANJANG_NAMA_MINIMAL);
    try {
      await redisCache.set(KUNCI_CACHE(businessId), JSON.stringify(nama), 'EX', TTL_CACHE_SEC);
    } catch { /* gagal menyimpan cache bukan alasan gagal melayani */ }
    return nama;
  } catch (err) {
    // Pengayaan kueri itu penyempurnaan, bukan syarat. Kegagalannya mengembalikan
    // perilaku lama (kueri = pesan apa adanya), bukan menghentikan balasan.
    logger.warn(`[Produk] Daftar nama produk tidak terbaca: ${err}`);
    return [];
  }
}

/**
 * Nama produk yang muncul di sepotong teks.
 *
 * Diurut dari nama TERPANJANG supaya "GKE 40 Premium Damaskus Edition" menang
 * atas "GKE 40" — kalau tidak, nama yang lebih spesifik tidak pernah terpilih.
 */
export function namaProdukDisebut(teks: string, daftar: string[]): string[] {
  const t = String(teks ?? '').toLowerCase();
  if (!t) return [];
  const hasil: string[] = [];
  for (const nama of [...daftar].sort((a, b) => b.length - a.length)) {
    const n = nama.toLowerCase();
    if (n.length < PANJANG_NAMA_MINIMAL || !t.includes(n)) continue;
    // Nama yang sudah termuat di nama lain yang lebih panjang tidak ditambahkan lagi.
    if (hasil.some(s => s.toLowerCase().includes(n))) continue;
    hasil.push(nama);
  }
  return hasil;
}
