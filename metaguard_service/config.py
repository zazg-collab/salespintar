"""
metaguard_service/config.py

Satu tempat baca environment variable untuk service ini — pola sama seperti `backend/src/config`
di repo Node (satu module config, bukan `os.environ.get(...)` tersebar di banyak file).
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from functools import lru_cache


@dataclass(frozen=True)
class Settings:
    # api-bridge (VPS 45) -- lihat engine.AgyCliInvoker. Default localhost karena metaguard_service
    # co-located di VPS 45 bersama api-bridge (lihat projek-ceo integration note Section 3.1/3.1b).
    bridge_url: str = os.environ.get("BRIDGE_URL", "http://127.0.0.1:4000")
    bridge_api_key: str = os.environ.get("BRIDGE_API_KEY", "")

    # Fallback SDK -- per-business di level Node backend (Business.settings JSON), TAPI kalau service
    # ini dipanggil tanpa override eksplisit per-request, GEMINI_API_KEY di env ini jadi fallback
    # generik (dipakai kalau Node proxy belum kirim key per-business, mis. saat testing lokal).
    gemini_api_key_default: str = os.environ.get("GEMINI_API_KEY", "")

    # Video sementara -- WAJIB dibuang setelah audit selesai (keputusan Bossfren 2026-08-25, lihat
    # projek-ceo integration note Section 5: "histori video ... dibuang, hanya simpan laporan JSON +
    # skor"). Lihat main.py `_run_audit_job` untuk detail kapan tepatnya dibuang (ada 1 pengecualian
    # disengaja: video ditahan sampai 1 ronde klarifikasi selesai, supaya fix K7 -- re-cek klaim
    # advertiser terhadap piksel asli, bukan cuma teks -- tetap jalan).
    upload_dir: str = os.environ.get("METAGUARD_UPLOAD_DIR", "/app/metaguard-uploads")

    port: int = int(os.environ.get("PORT", "4010"))

    # ffmpeg binary -- default asumsi ada di PATH (kasus umum: apt-get install ffmpeg di
    # Dockerfile.metaguard). Di VPS 45 (CentOS 8, tidak ada paket ffmpeg resmi di repo yang
    # terpasang) sengaja di-override ke static build lokal lewat env FFMPEG_BIN -- lihat
    # metaguard.env di VPS 45 & catatan deploy 2026-08-25.
    ffmpeg_bin: str = os.environ.get("FFMPEG_BIN", "ffmpeg")

    # Auth minimal antar-layanan (header X-Internal-Api-Key), PELENGKAP firewall CSF (bukan
    # pengganti) -- ditambahkan 2026-08-25 setelah sadar endpoint /v1/* sebelumnya HANYA dijaga
    # firewall IP-based, beda dari api-bridge yang sudah punya X-API-Key sejak awal. Kalau kosong,
    # endpoint tetap terbuka (fail-open) supaya bring-up awal tidak keblokir -- lihat main.py
    # `_require_internal_key`.
    internal_api_key: str = os.environ.get("METAGUARD_INTERNAL_API_KEY", "")


@lru_cache
def get_settings() -> Settings:
    return Settings()
