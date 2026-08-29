import { Request, Response, NextFunction } from 'express';
import { AppError } from '../utils/errors';
import { logger } from '../utils/logger';
import { env } from '../config/env';

export function errorHandler(err: Error, req: Request, res: Response, _next: NextFunction) {
  const correlationId = req.correlationId;

  if (err instanceof AppError) {
    // Galat yang ditandai `rutin` dicatat di `info`, bukan `warn`.
    //
    // Alasannya bukan kerapian: `warn` yang muncul terjadwal tiap 15 menit
    // melatih orang MENGABAIKAN warn. Begitu terbiasa, warn yang benar-benar
    // penting ikut terlewat. Level log adalah janji tentang "ini perlu
    // diperhatikan"; janji yang dilanggar berkala jadi tidak berarti apa-apa.
    //
    // Satu-satunya yang rutin sekarang: access token kedaluwarsa (lihat
    // UnauthorizedError di utils/errors.ts).
    const rutin = (err as AppError & { rutin?: boolean }).rutin === true;
    const catat = rutin ? logger.info.bind(logger) : logger.warn.bind(logger);
    catat(`[${correlationId}] ${err.statusCode} ${err.message}`, {
      path: req.path,
      method: req.method,
      code: err.code,
    });
    return res.status(err.statusCode).json({
      error: {
        message: err.message,
        code: err.code,
        correlationId,
      },
    });
  }

  logger.error(`[${correlationId}] Unhandled error: ${err.message}`, {
    stack: err.stack,
    path: req.path,
    method: req.method,
  });

  // ── Transparansi error saat development ────────────────────────────────────
  // Error yang bukan AppError selalu diseragamkan jadi "Internal server error".
  // Di production itu memang benar: pesan error internal bisa membocorkan nama
  // tabel, jalur file, versi pustaka, sampai potongan query — bahan berharga
  // buat penyerang.
  //
  // Tapi di development, penyeragaman itu cuma memaksa developer bolak-balik ke
  // terminal untuk tahu apa yang sebenarnya rusak. Pengecekannya sengaja
  // `=== 'development'`, BUKAN `!== 'production'`, supaya staging yang biasanya
  // terekspos ke internet tetap ikut aturan production.
  const isDev = env.NODE_ENV === 'development';

  return res.status(500).json({
    error: {
      message: isDev ? err.message : 'Internal server error',
      correlationId,
      ...(isDev
        ? {
            name: err.name,
            // Beberapa baris teratas saja — cukup untuk menemukan sumbernya
            // tanpa membanjiri panel Network di browser.
            stack: err.stack?.split('\n').slice(0, 6).map(l => l.trim()),
          }
        : {}),
    },
  });
}
