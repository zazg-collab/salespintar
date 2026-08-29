import { Router, Request, Response, NextFunction } from 'express';
import fs from 'fs';
import { authenticate } from '../middleware/auth';
import { daftarKatalog } from '../services/katalog-gambar.service';
import { NotFoundError } from '../utils/errors';

const router = Router();

/**
 * Penyaji gambar katalog untuk dashboard CS — Fase 89.
 *
 * ── Kenapa tidak `express.static` ─────────────────────────────────────────────
 * `express.static('uploads/katalog')` akan menyajikan folder itu ke SIAPA SAJA di
 * internet tanpa login. Foto produk memang tidak rahasia, tapi foldernya bukan
 * hanya diisi foto produk — di sana juga bisa ada tangkapan layar rekening, harga
 * khusus reseller, atau apa pun yang besok ditaruh orang tanpa memikirkan bahwa
 * folder itu publik. Sekali sebuah folder jadi publik, yang menentukan isinya
 * bukan lagi keputusan, tapi kebiasaan.
 *
 * ── Kenapa lewat `daftarKatalog()`, bukan `path.join` langsung ────────────────
 * Menyusun path dari masukan pengguna adalah cara klasik kebobolan
 * (`../../etc/passwd`). Di sini nama yang diminta dicocokkan dengan Map berisi
 * berkas yang SUDAH dipindai — jadi path yang dibuka selalu berasal dari
 * `readdir`, tidak pernah dari string yang dikirim peramban. Daftar-putih yang
 * sama dengan yang dipakai saat mengirim ke pelanggan; satu sumber kebenaran,
 * bukan dua yang harus dijaga tetap sama.
 */
router.get('/gambar/:nama', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const katalog = await daftarKatalog();

    // Cocokkan lewat nama berkas apa adanya MAUPUN kunci ternormalisasi, supaya
    // `mediaUrl` yang tersimpan di baris pesan lama tetap bisa dibuka walau
    // aturan normalisasi berubah suatu hari.
    // `String(...)`: tipe Express membolehkan array untuk param, dan path yang
    // disusun dari array akan meledak dengan cara yang membingungkan.
    const diminta = String(req.params.nama ?? '');
    const cocok =
      [...katalog.values()].find((g) => g.namaBerkas === diminta) ??
      katalog.get(diminta) ??
      null;

    if (!cocok) {
      // NotFoundError menambahkan " not found" sendiri; jangan ditulis dua kali.
      throw new NotFoundError(`Gambar katalog "${diminta}"`);
    }

    res.setHeader('Content-Type', cocok.mime);
    res.setHeader('Content-Length', String(cocok.ukuranByte));
    // Privat: gambarnya di belakang login, jadi jangan sampai di-cache proxy
    // bersama. Peramban tetap boleh menyimpannya sebentar supaya menggulir
    // riwayat chat tidak mengunduh ulang tiap kali.
    res.setHeader('Cache-Control', 'private, max-age=3600');

    const aliran = fs.createReadStream(cocok.path);
    aliran.on('error', (err) => next(err));
    aliran.pipe(res);
  } catch (err) { next(err); }
});

/**
 * Daftar gambar yang tersedia — supaya CS bisa memeriksa apa yang sebenarnya ada
 * di folder tanpa perlu SSH. Ini juga yang menjawab "kok fotonya tidak terkirim":
 * kalau namanya tidak muncul di sini, berkasnya memang tidak ada.
 */
router.get('/gambar', authenticate, async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const katalog = await daftarKatalog();
    res.json({
      total: katalog.size,
      gambar: [...katalog.entries()].map(([kunci, g]) => ({
        penanda: kunci,
        namaBerkas: g.namaBerkas,
        ukuranByte: g.ukuranByte,
        mime: g.mime,
      })),
    });
  } catch (err) { next(err); }
});

export default router;
