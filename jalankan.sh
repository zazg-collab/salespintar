#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# jalankan.sh — nyalakan SalesPintar di laptop: infra + backend + frontend,
#               satu terminal.
#
# Sejak pindah ke vps-upcloud (Fase 73), laptop adalah CADANGAN & tempat
# ngoding — bukan yang melayani pelanggan. Bahayanya satu dan besar: backend
# tidak punya sakelar untuk mematikan WhatsApp, jadi begitu nyala ia langsung
# menyambar sesi WA yang sama dengan server → `conflict 440`, dan karena Fase 43
# sengaja mematikan auto-reconnect saat conflict, **server tidak bangun sendiri.**
#
# Karena itu bendera `--matikan-wa` ada di sini, bukan cuma di dokumen: satu
# perintah yang benar lebih kuat daripada satu paragraf yang harus diingat.
#
#   ./jalankan.sh --matikan-wa    ← ini yang dipakai sehari-hari selama server hidup
#   ./jalankan.sh                 ← WA apa adanya; hanya kalau server sedang mati
#   ./jalankan.sh --status        ← cuma lihat keadaan WA, tidak menyalakan apa pun
#   ./jalankan.sh --hidupkan-wa   ← kembalikan WA ke laptop (server harus mati dulu)
#   ./jalankan.sh --tanpa-infra   ← jangan sentuh docker (Postgres/Redis sudah jalan)
#
# Ctrl-C sekali mematikan backend dan frontend berdua.
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

AKAR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$AKAR"

M='\033[31m'; H='\033[32m'; K='\033[33m'; B='\033[1m'; R='\033[0m'

MATIKAN_WA=0; HIDUPKAN_WA=0; TANPA_INFRA=0; CUMA_STATUS=0
for a in "$@"; do
  case "$a" in
    --matikan-wa)  MATIKAN_WA=1 ;;
    --hidupkan-wa) HIDUPKAN_WA=1 ;;
    --tanpa-infra) TANPA_INFRA=1 ;;
    --status)      CUMA_STATUS=1 ;;
    -h|--help)     sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo -e "${M}Bendera tidak dikenal: $a${R}  (pakai --help)"; exit 2 ;;
  esac
done

if [ "$MATIKAN_WA" = 1 ] && [ "$HIDUPKAN_WA" = 1 ]; then
  echo -e "${M}Pilih salah satu: --matikan-wa atau --hidupkan-wa.${R}"; exit 2
fi

# ── 1. Infra ────────────────────────────────────────────────────────────────
# Postgres & Redis harus SIAP sebelum backend jalan, bukan cuma "sudah di-start".
# `npm run dev` bawaan cuma `sleep 2` — cukup di mesin cepat, dan diam-diam gagal
# di mesin yang sedang sibuk. Di sini ditunggu sampai `pg_isready` benar-benar OK.
if [ "$TANPA_INFRA" = 0 ]; then
  echo -e "${B}[1/3]${R} Menyalakan Postgres & Redis…"
  docker compose -f docker-compose.dev.yml up -d || {
    echo -e "${M}Docker gagal. Sudah jalan Docker Desktop-nya?${R}"; exit 1; }

  printf '      menunggu Postgres siap'
  for i in $(seq 1 60); do
    if docker exec salespintar-db pg_isready -U salespintar -h localhost >/dev/null 2>&1; then
      echo -e " ${H}siap${R}"; break
    fi
    printf '.'; sleep 1
    if [ "$i" = 60 ]; then echo -e " ${M}menyerah setelah 60 detik${R}"; exit 1; fi
  done
else
  echo -e "${B}[1/3]${R} Infra dilewati (--tanpa-infra)."
fi

# ── 2. Jalur WhatsApp ───────────────────────────────────────────────────────
echo -e "${B}[2/3]${R} Memeriksa jalur WhatsApp…"
# Dijalankan SEKALI dan hasilnya ditahan. Menjalankannya dua kali (sekali untuk
# ditampilkan, sekali untuk diperiksa) berarti dua koneksi database dan dua
# jawaban yang bisa berbeda di antaranya — persis kelas bug yang bikin repot.
LAPORAN_WA="$(mktemp)"
trap 'rm -f "$LAPORAN_WA"' EXIT
( cd backend
  if   [ "$MATIKAN_WA"  = 1 ]; then npx tsx mode-wa.ts --mati
  elif [ "$HIDUPKAN_WA" = 1 ]; then npx tsx mode-wa.ts --hidup
  else                              npx tsx mode-wa.ts
  fi ) | tee "$LAPORAN_WA"
if [ "${PIPESTATUS[0]}" != 0 ]; then exit 1; fi

if [ "$CUMA_STATUS" = 1 ]; then exit 0; fi

# Kalau WA masih hidup dan pengguna TIDAK memintanya, berhenti dan tanya. Diam
# lalu menyambar sesi server adalah kegagalan yang mahal dan tidak kelihatan
# sampai pelanggan tidak dibalas.
if [ "$MATIKAN_WA" = 0 ] && [ "$HIDUPKAN_WA" = 0 ]; then
  if grep -q 'WA HIDUP' "$LAPORAN_WA"; then
    echo ""
    echo -e "${M}${B}BERHENTI DULU.${R} WhatsApp masih HIDUP di database laptop."
    echo -e "Kalau vps-upcloud juga hidup, menyalakan backend sekarang akan"
    echo -e "menendang server dengan ${B}conflict 440${R} dan server tidak bangun sendiri."
    echo ""
    echo -e "  Aman  : ${B}./jalankan.sh --matikan-wa${R}"
    echo -e "  Sadar : ketik ${B}lanjut${R} di bawah kalau server memang sedang mati."
    echo ""
    printf 'Ketik "lanjut" untuk tetap menyalakan: '
    read -r jawab
    [ "$jawab" = "lanjut" ] || { echo "Dibatalkan."; exit 1; }
  fi
fi

# ── 3. Backend + frontend ───────────────────────────────────────────────────
# `concurrently` sudah jadi devDependency di akar repo, dan `--kill-others`
# memastikan Ctrl-C (atau salah satu mati) menjatuhkan keduanya — bukan
# meninggalkan satu proses yatim yang memegang port.
echo -e "${B}[3/3]${R} Menyalakan backend (:3000) & frontend (:3001)…"
echo -e "      dashboard: ${B}http://localhost:3001${R}   (Ctrl-C mematikan keduanya)"
echo ""
exec npx concurrently \
  --names "api,web" --prefix-colors "blue,green" \
  --kill-others --handle-input \
  "cd backend && npm run dev" \
  "cd frontend && npm run dev"
