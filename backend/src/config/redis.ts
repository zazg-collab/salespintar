import Redis from 'ioredis';
import { env } from './env';

export const redisCache = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: null,
  enableOfflineQueue: false,
});

export const redisBull = new Redis(env.REDIS_BULL_URL, {
  maxRetriesPerRequest: null,
  enableOfflineQueue: false,
});

/**
 * Tunggu sampai koneksi Redis benar-benar siap dipakai.
 *
 * ioredis menyambung secara ASINKRON setelah objeknya dibuat. Karena kedua klien
 * di atas memakai `enableOfflineQueue: false`, perintah apa pun yang dikirim
 * sebelum socket siap TIDAK diantre — ia langsung gagal dengan
 * "Stream isn't writeable and enableOfflineQueue options is false".
 *
 * Bootstrap memanggil `.ping()` beberapa milidetik setelah modul ini dimuat,
 * jadi ada balapan: kalau Redis sedikit lambat merespons, ping gagal, bootstrap
 * memanggil `process.exit(1)`, dan karena `tsx watch` menjalankan ulang proses
 * yang keluar — jadilah siklus mati-hidup yang dari luar terlihat seperti
 * "WhatsApp putus sendiri". Terpantau di log 2026-07-29 18:45:16.
 *
 * Menunggu event `ready` menghilangkan balapan itu tanpa perlu mengaktifkan
 * offline queue (yang justru menyembunyikan Redis mati di balik antrean).
 */
export function waitForRedisReady(client: Redis, name: string, timeoutMs = 15_000): Promise<void> {
  if (client.status === 'ready') return Promise.resolve();

  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timeout ${timeoutMs}ms menunggu Redis "${name}" siap (status terakhir: ${client.status})`));
    }, timeoutMs);

    const onReady = () => { cleanup(); resolve(); };
    const onError = (err: Error) => { cleanup(); reject(err); };
    const cleanup = () => {
      clearTimeout(timer);
      client.off('ready', onReady);
      client.off('error', onError);
    };

    client.once('ready', onReady);
    client.once('error', onError);
  });
}

/**
 * [2026-08-27] Hapus semua cache key yang cocok pola (mis. "salespintar:meta-perf:<businessId>:*")
 * pakai SCAN (bukan KEYS, supaya tidak memblokir Redis di production walau key-nya banyak).
 *
 * Dipakai saat 1 aksi (mis. edit budget manual campaign) bikin cache lama utk BANYAK kombinasi
 * query jadi stale sekaligus (tiap date-range punya cache key sendiri via template literal
 * `${businessId}:${startDate}:${endDate}`), jadi kita gak bisa tau persis suffix key yang harus
 * dihapus dgn `del()` biasa -- ketemu dari bug nyata: tabel campaign dashboard tetap nunjukkin
 * budget lama sampai 20 menit (TTL cache) walau budget-nya sudah beneran berubah di Meta, kecuali
 * user pencet tombol Refresh manual (yang kirim forceRefresh=true, bypass cache sepenuhnya).
 */
export async function delCachePattern(client: Redis, pattern: string): Promise<number> {
  let cursor = '0';
  let deleted = 0;
  do {
    const [nextCursor, keys] = await client.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
    cursor = nextCursor;
    if (keys.length > 0) {
      deleted += await client.del(...keys);
    }
  } while (cursor !== '0');
  return deleted;
}
