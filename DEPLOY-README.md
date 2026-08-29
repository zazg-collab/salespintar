# CARA DEPLOY YANG BENAR -- BACA INI DULU

**Tanggal ditulis:** 2026-08-26 (Cowork/Claude)

## Pakai file ini, BUKAN yang lain:

```
docker compose -f deploy/upcloud/docker-compose.host.yml -p upcloud build <service>
docker compose -f deploy/upcloud/docker-compose.host.yml -p upcloud up -d --no-build --no-deps <service>
```

Project name **WAJIB** `-p upcloud` -- ini yang dipakai container yang aktif sekarang
(`salespintar-api`, `salespintar-web`, `salespintar-db`, `salespintar-redis`), jaringan Docker-nya
bridge biasa (bukan host), dan Postgres/Redis di-resolve lewat nama service (`postgres`, `redis`)
di jaringan compose itu.

## Kenapa ada file `docker-compose.yml.DEPRECATED-DO-NOT-USE` di folder ini?

Itu file compose LAMA (root, sebelum struktur deploy dipindah ke `deploy/upcloud/`). Isinya:
- `network_mode: host` utk service `api` -- TIDAK cocok dgn topologi sekarang (Postgres/Redis
  jalan di jaringan bridge project `upcloud`, BUKAN reachable via `127.0.0.1` dari host network).
- `CORS_ORIGIN=https://salespintar.com` -- domain lama, situs sekarang di
  `https://novybot.aydaza.my.id`.
- `container_name: salespintar-api` / `salespintar-web` / dst -- SAMA PERSIS dgn nama container yg
  dipakai project `upcloud` yang aktif -- kalau file ini dijalankan (`docker compose up`), container
  barunya REBUTAN NAMA dgn container yang benar, bikin salah satu gagal/ke-crash-loop (gak bisa
  connect Postgres/Redis krn network_mode-nya beda).

**Insiden nyata:** 2026-08-26 ~20:30 WIB, file ini kejalanin (bukan oleh Cowork/Claude) dan bikin
`salespintar-api` crash-loop (ENOTFOUND redis/postgres) selama beberapa menit sampai ditemukan &
diperbaiki. Root cause lengkap + kronologi ada di Obsidian vault, note
`projek-ceo/20260729-ledger-anti-drift-baseline.md` (cari "TABRAKAN DEPLOY" tanggal 2026-08-26).

File ini DIBIARKAN ADA (bukan dihapus) supaya siapapun/apapun yang biasa memakainya bisa lihat
catatan ini dulu, alih-alih file hilang tiba-tiba tanpa penjelasan. **Jangan dijalankan lagi.**
Kalau ada kebutuhan/skrip otomatis yang masih menunjuk ke path `/opt/salespintar/docker-compose.yml`
(bukan `deploy/upcloud/docker-compose.host.yml`), itu perlu diperbarui supaya menunjuk ke path yang
benar di atas.
