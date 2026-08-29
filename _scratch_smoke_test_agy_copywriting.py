"""
Smoke test: panggil endpoint /v1/copywriting/check TANPA header X-Llm-Provider sama sekali,
untuk memastikan default sekarang benar-benar 'agy' (bukan 'google') dan request berhasil
tanpa API key apapun, lewat pool 'copywriting-ads' di api-bridge.

Dijalankan di VPS45 sendiri (bukan di-relay), pakai key dari .env service ini langsung --
tidak pernah dicetak/dikirim ke tempat lain.
"""
import os
import sys
import time

sys.path.insert(0, "/root/salespintar-ai-agent/metaguard_service")

from dotenv import dotenv_values  # type: ignore

env = dotenv_values("/root/salespintar-ai-agent/metaguard_service/.env")
internal_key = env.get("METAGUARD_INTERNAL_API_KEY", "")

import httpx

payload = {
    "headline": "Diskon spesial hari ini, buruan sebelum kehabisan!",
    "primary_text": "Produk kami membantu Anda tampil lebih percaya diri setiap hari.",
}
headers = {"Content-Type": "application/json"}
if internal_key:
    headers["X-Internal-Api-Key"] = internal_key

t0 = time.time()
try:
    resp = httpx.post(
        "http://127.0.0.1:4010/v1/copywriting/check",
        json=payload,
        headers=headers,
        timeout=180.0,
    )
    dt = time.time() - t0
    print(f"STATUS={resp.status_code} elapsed={dt:.1f}s")
    print("BODY_HEAD:", resp.text[:800])
except Exception as e:
    dt = time.time() - t0
    print(f"EXCEPTION after {dt:.1f}s: {type(e).__name__}: {e}")
