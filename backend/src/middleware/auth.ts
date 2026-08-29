import { Request, Response, NextFunction } from 'express';
import { verifyAccessToken } from '../utils/crypto';
import { UnauthorizedError, ForbiddenError } from '../utils/errors';
import { prisma } from '../config/prisma';
import { redisCache } from '../config/redis';
import { env } from '../config/env';
import { logger } from '../utils/logger';

// ──────────────────────────────────────────────────────────────────────────────
// Fix audit B5 — cache identitas user di Redis
//
// Sebelumnya SETIAP request yang terautentikasi memicu query DB (user + business
// lewat include). Untuk dashboard yang polling beberapa endpoint sekaligus, itu
// berarti puluhan query per menit per user yang hasilnya selalu sama.
//
// Yang di-cache hanya identitas user yang AKTIF dan lolos semua pengecekan.
// Konsekuensinya harus disadari: menonaktifkan user atau business baru benar-
// benar berlaku setelah cache kedaluwarsa (default 60 detik, atur lewat
// AUTH_CACHE_TTL_SEC). Kalau butuh pencabutan akses seketika, panggil
// invalidateAuthCache() di tempat user/business dinonaktifkan.
// ──────────────────────────────────────────────────────────────────────────────

const AUTH_CACHE_PREFIX = 'salespintar:auth:user:';

interface CachedIdentity {
  userId: string;
  businessId: string;
  role: string;
}

/** Buang cache identitas satu user — panggil saat user/business dinonaktifkan. */
export async function invalidateAuthCache(userId: string): Promise<void> {
  try {
    await redisCache.del(AUTH_CACHE_PREFIX + userId);
  } catch (err) {
    logger.warn(`[Auth] Gagal invalidasi cache user ${userId}: ${err}`);
  }
}

export async function authenticate(req: Request, _res: Response, next: NextFunction) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      throw new UnauthorizedError('Missing or invalid authorization header');
    }

    const token = authHeader.split(' ')[1];
    const payload = verifyAccessToken(token);
    const cacheKey = AUTH_CACHE_PREFIX + payload.userId;

    // ── Jalur cepat: ambil dari Redis ──
    // Fail-soft: kalau Redis bermasalah kita diam-diam jatuh ke query DB.
    // Cache mati tidak boleh berarti tidak ada yang bisa login.
    let identity: CachedIdentity | null = null;
    try {
      const cached = await redisCache.get(cacheKey);
      if (cached) identity = JSON.parse(cached) as CachedIdentity;
    } catch (err) {
      logger.warn(`[Auth] Redis tidak terbaca, fallback ke DB: ${err}`);
    }

    // ── Jalur lambat: query DB, lalu isi cache ──
    if (!identity) {
      const user = await prisma.user.findUnique({
        where: { id: payload.userId },
        include: { business: true },
      });

      if (!user || !user.isActive) {
        throw new UnauthorizedError('User not found or inactive');
      }

      if (!user.business.isActive) {
        throw new ForbiddenError('Business account is inactive');
      }

      identity = {
        userId: user.id,
        businessId: user.businessId,
        role: user.role,
      };

      // Hanya identitas yang sudah lolos SEMUA pengecekan yang boleh masuk cache,
      // jadi cache hit tidak pernah melewati pemeriksaan yang belum pernah lulus.
      try {
        await redisCache.set(cacheKey, JSON.stringify(identity), 'EX', env.AUTH_CACHE_TTL_SEC);
      } catch (err) {
        logger.warn(`[Auth] Gagal menulis cache user ${payload.userId}: ${err}`);
      }
    }

    req.user = identity;
    next();
  } catch (error: any) {
    // Dua keadaan yang dulu diseragamkan jadi satu pesan — dan menyeragamkannya
    // membuat yang satu tenggelam di antara yang lain.
    //
    // TokenExpiredError : RUTIN. Access token hidup 15 menit; klien menerima 401
    //   ini, memanggil /auth/refresh, lalu mengulang permintaannya. Buktinya di
    //   log 30 Juli: 401 muncul TEPAT sekali per ~15 menit padahal dashboard
    //   memanggil endpoint tiap 5 detik. Kalau penyegarannya rusak, angkanya akan
    //   ratusan, bukan satu. Jadi ini bukan kerusakan — ini siklus normal.
    //
    // JsonWebTokenError : TIDAK RUTIN. Tanda tangan salah, token cacat bentuk,
    //   atau rahasia berbeda. Bisa berarti seseorang mengarang token. Ini yang
    //   layak `warn`.
    //
    // `code` dikirim ke klien supaya frontend bisa menyegarkan HANYA saat
    // kedaluwarsa, bukan setiap 401 apa pun sebabnya.
    if (error.name === 'TokenExpiredError') {
      next(new UnauthorizedError('Access token kedaluwarsa', 'TOKEN_EXPIRED', true));
    } else if (error.name === 'JsonWebTokenError') {
      next(new UnauthorizedError('Token tidak sah', 'TOKEN_INVALID'));
    } else {
      next(error);
    }
  }
}

export function authorize(...roles: string[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) {
      return next(new UnauthorizedError());
    }
    if (roles.length > 0 && !roles.includes(req.user.role)) {
      return next(new ForbiddenError('Insufficient permissions'));
    }
    next();
  };
}
