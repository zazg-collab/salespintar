# Penerapan SalesPintar di `vps-upcloud`

Berkas di folder ini KHUSUS untuk server `95.111.196.170:2211`
(`server.dapurcordova.com`). Jangan dipakai di tempat lain tanpa membaca alasannya.

## Kenapa tidak memakai `docker-compose.yml` yang di akar

`docker-compose.yml` memakai jaringan **bridge** dan nama service (`api:3000`,
`postgres:5432`). Di server ini itu tidak bisa, dan alasannya berlapis:

1. Server menanggung **62 vhost + mail + DNS**, dijaga **CSF** dengan
   `INPUT/FORWARD/OUTPUT = DROP`.
2. CSF punya `DOCKER = "1"` bawaan, tapi keempat aturan yang dibuatnya
   di-hardcode ke `docker0` (`/usr/sbin/csf:1334-1337`). `docker compose` selalu
   membuat bridge sendiri (`br-xxxxxxxx`), jadi aturan itu tidak kena — container
   compose akan tanpa jaringan.
3. Menulis `/etc/csf/csfpost.sh` tangan sendiri berarti mengarang aturan iptables
   di mesin yang menanggung 62 situs klien. Risiko di tempat yang paling mahal.

Jalan yang dipilih: **Docker tidak diberi wewenang atas iptables sama sekali**
(`/etc/docker/daemon.json`: `"iptables": false`, `"ip-forward": false`), dan semua
container memakai `network_mode: host`. CSF tetap pemilik tunggal firewall;
`csf -r` tidak akan pernah mematikan jaringan container.

Terbukti: sebelum & sesudah Docker menyala, aturan iptables tetap **554**,
`ip_forward` tetap **0**, chain `DOCKER*` **nol**.

## Konsekuensi yang harus diikuti

| hal | aturan |
|---|---|
| jaringan | `network_mode: host` untuk SEMUA service; bridge tidak berfungsi |
| **build** | `build.network: host` juga WAJIB — `docker build` normalnya memakai bridge, dan tanpa ini `npm ci`/`apk add` gagal dengan `DNS: transient error` |
| alamat antar-service | `127.0.0.1`, bukan nama service (tidak ada DNS Docker di mode host) |
| pengikatan | semua ke `127.0.0.1`; di jaringan host, `0.0.0.0` berarti terbuka ke internet |
| port | api 3000 · web 3001 · postgres **5433** · redis **6380** (bukan bawaan, agar tidak bentrok kalau CWP memasang Postgres/Redis sendiri) |
| publik | hanya nginx HOST di :443 → `127.0.0.1:3001`. Tidak ada port baru dibuka di CSF |

## Hal yang mudah terlewat

- **`pgvector/pgvector:pg16`, bukan `postgres:16-alpine`.** Compose di akar
  memakai yang kedua, yang TIDAK punya pgvector — migrasi akan gagal di kolom
  vector. Laptop memakai image yang benar.
- **Redis `--maxmemory-policy noeviction`.** BullMQ menyimpan job di Redis; kalau
  Redis boleh membuang kunci saat penuh, job hilang diam-diam.
- **Vault di-mount RW, bukan RO.** Shadow Mining MENULIS ke `Draft_AI/`
  (`shadow-mining.worker.ts:285`).
- **`wa_sessions` bind mount, bukan named volume.** 23 MB kredensial WhatsApp;
  harus mudah dicadangkan. Hilang = keenam CS scan QR ulang.
- **Cache model embedding** (`hfcache`, ~130 MB) — tanpa volume ini, model
  diunduh ulang tiap container dibuat ulang.

## Vhost

`novybot.aydaza.my.id` diatur lewat panel CWP dengan template **`nodejs`**,
proxy port **3001**. Lewat panel, bukan menyunting berkas vhost langsung —
CWP menghasilkan ulang vhost saat perpanjang SSL atau ubah domain, dan suntingan
tangan akan tertimpa diam-diam.

Frontend berjalan sebagai **server Next.js** (`next start -H 127.0.0.1 -p 3001`),
BUKAN ekspor statis.

⚠️ `Dockerfile.frontend` semula memakai `BUILD_STATIC=true` (`output: 'export'`)
lalu menyajikannya dengan nginx. Itu peninggalan aplikasi Vite sebelum migrasi ke
App Router, dan sejak migrasi **tidak mungkin lagi berhasil**:

```
Error: Page "/app/chat/[id]" is missing "generateStaticParams()"
       so it cannot be used with "output: export" config.
```

`/app/chat/[id]` rute dinamis — id percakapan datang dari database. Tidak ada
tambalan untuk ini; ekspor statis memang bentuk yang salah.

Mode server justru lebih sederhana: `rewrites()` di `next.config.ts` ikut hidup
lagi (Next mematikannya saat `output: 'export'`), jadi `/api` dan `/socket.io`
diteruskan Next sendiri ke `127.0.0.1:3000`. **Tidak ada container nginx.**
`/uploads/` tidak perlu dirutekan — diperiksa, frontend tidak memakainya.

## Perintah harian

```bash
cd /opt/salespintar/deploy/upcloud
docker compose -f docker-compose.host.yml ps
docker compose -f docker-compose.host.yml logs -f api
docker compose -f docker-compose.host.yml up -d --build   # sesudah kode diperbarui
```

Kode diperbarui HANYA dengan mengirim ulang dari laptop (rsync/tar), lalu
diverifikasi lawan ledger anti-drift. **Jangan pernah menyunting kode langsung di
server** — ledger adalah wasit antara Cowork dan Antigravity, dan lokasi kedua
yang bisa disunting membuatnya tidak berarti apa-apa.


## Tiga kegagalan build yang sudah dibereskan (31 Juli 2026)

Build Docker proyek ini **belum pernah berhasil sekali pun** sebelum hari ini.
Ketiganya ketemu berurutan saat penerapan pertama:

1. `npm ci` gagal — `Dockerfile` menyalin `package.json` **tanpa
   `package-lock.json`**, padahal `npm ci` menolak jalan tanpa lockfile.
   Lockfile-nya ada (256 KB + 96 KB), cuma tidak ikut disalin.
2. `apk add tini` gagal `DNS: transient error` — `docker build` memakai jaringan
   **bridge**, yang mati karena `"iptables": false`. Diperbaiki dengan
   `build.network: host`. Runtime tidak kena karena sudah `network_mode: host`;
   yang terlupa cuma tahap build.
3. `next build` gagal — ekspor statis mustahil untuk rute dinamis (lihat bagian
   Vhost di atas).

Pelajaran yang sama dengan yang berulang di Fase 63-72: **berkas konfigurasi yang
tidak pernah dijalankan akan menyimpan asumsi yang sudah lama tidak benar.**
`Dockerfile.frontend` masih menyebut `postcss.config.js`, `tailwind.config.js`,
dan folder `public/` — ketiganya sudah tidak ada sejak migrasi Next.js 15.
