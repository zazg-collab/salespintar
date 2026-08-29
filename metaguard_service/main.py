"""
metaguard_service/main.py

FastAPI entrypoint untuk MetaGuard AI compliance microservice. Deploy target: VPS Antigravity
("VPS 45"), co-located dengan `api-bridge` (lihat
projek-ceo/20260825-blueprint-integrasi-meta-video-ai-guards-ke-salespintar.md Section 3.1/3.1b) —
BUKAN VPS Upcloud tempat backend Node SalesPintar jalan.

Endpoint di sini mengikuti kontrak final dari note integrasi projek-ceo Section 3.1 (`/v1/audit`,
`/v1/audit/{audit_id}`, `/v1/audit/{audit_id}/clarify`, `/v1/presentation/reinforce`) — BUKAN path
`/api/v1/compliance/...` di draft awal Blueprint Section 5, yang ditulis sebelum integrasi
SalesPintar direncanakan. Field JSON di dalam masing-masing payload/response TETAP mengikuti skema
Pydantic asli (`engine.ComplianceAuditReport` dkk), cuma path URL-nya yang berbeda dari draft awal.

Node backend SalesPintar (route proxy tipis `video-guard.routes.ts`, lihat note projek-ceo Section
3.3) adalah SATU-SATUNYA caller yang dimaksud untuk service ini — endpoint di sini TIDAK pernah
diekspos langsung ke browser/publik (lihat firewall CSF/iptables, hanya izinkan IP VPS Upcloud).

=== Async job pattern (fix T1, Blueprint Section 8.1) ===
Adopsi pola minimum-viable dari Blueprint: `BackgroundTasks` + dict in-memory `AUDIT_STATUS` /
`PRESENTATION_STATUS`, BUKAN Celery/Redis. Ini SENGAJA placeholder murni untuk Milestone 1 — dicatat
eksplisit di Blueprint bahwa dict ini TIDAK survive restart proses dan TIDAK bekerja lintas multi-
worker Uvicorn. Wajib diganti Redis atau tabel `VideoAdAudit` (Prisma, lihat note projek-ceo Section
3.4) sebagai satu-satunya sumber status begitu deployment lebih dari 1 worker process.

=== Kebijakan simpan video (keputusan Bossfren 2026-08-25: "buang aja") ===
Video/thumbnail lokal DIBUANG setelah audit selesai — TAPI ada satu pengecualian sadar: kalau verdict
`NEEDS_MINOR_TWEAK` dengan clarification_questions terbuka, file DITAHAN sampai SATU ronde klarifikasi
selesai (lihat `_run_audit_job`/`clarify_audit` di bawah), supaya fix K7 (`resolve_clarification()`
di `engine.py` — re-cek klaim advertiser terhadap piksel/audio ASLI, bukan cuma teks) tetap bisa
jalan tanpa memaksa caller re-upload video yang baru saja dikirim. Ini keputusan desain saya (Claude),
bukan sesuatu yang eksplisit dikonfirmasi Bossfren kata per kata — kalau dianggap salah arah (mis.
Bossfren mau video dibuang instan TANPA pengecualian, dan klarifikasi wajib re-upload), gampang
diubah: hapus blok `if needs_clarification(...)` di `_run_audit_job` dan `clarify_audit` tinggal
menolak request yang filenya sudah tidak ada.
"""

from __future__ import annotations

import logging
import shutil
import uuid
from pathlib import Path
from typing import Dict, List, Optional

from fastapi import BackgroundTasks, Depends, FastAPI, File, Form, Header, HTTPException, UploadFile
from pydantic import BaseModel

from config import get_settings
from engine import (
    MetaAdGuardEngine,
    needs_clarification,
)
from reinforcement import (
    PresentationLayer,
    PresentationReinforcementRequest,
    reinforce_presentation,
)
from copywriting import (
    run_copywriting_check,
    run_copywriting_generate,
)

settings = get_settings()
logger = logging.getLogger("metaguard_service")

app = FastAPI(
    title="MetaGuard AI — Compliance Microservice",
    description=(
        "Audit kepatuhan iklan video Meta Ads (Jawara Pisau ecosystem). Source of truth desain: "
        "projek-contentcreator/TECHNICAL_SYSTEM_DESIGN_BLUEPRINT.md (v1.4.0)."
    ),
    version="1.4.0",
)

engine = MetaAdGuardEngine(bridge_url=settings.bridge_url, bridge_api_key=settings.bridge_api_key)

UPLOAD_DIR = Path(settings.upload_dir)
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

# --- Job status store — PLACEHOLDER in-memory, lihat catatan header modul di atas -----------------
AUDIT_STATUS: Dict[str, dict] = {}
PRESENTATION_STATUS: Dict[str, dict] = {}

# audit_id -> {"job_dir": Path, "video_path": str|None, "thumbnail_path": str|None} — HANYA terisi
# selama file masih ditahan menunggu klarifikasi (lihat kebijakan simpan video di header modul).
_PENDING_CLARIFICATION_FILES: Dict[str, dict] = {}


@app.get("/health")
async def health():
    return {"status": "ok"}


def _require_internal_key(x_internal_api_key: Optional[str] = Header(None)) -> None:
    """Auth minimal antar-layanan -- shared secret di header, PELENGKAP firewall CSF (bukan
    pengganti). Kalau METAGUARD_INTERNAL_API_KEY belum diset di env, endpoint TETAP terbuka
    (fail-open) supaya deployment awal tidak keblokir sebelum key sempat diisi -- begitu key diisi
    di kedua sisi (service ini + video-guard.routes.ts Node), jadi wajib. Ditambahkan 2026-08-25
    setelah sadar endpoint /v1/* sebelumnya HANYA dijaga firewall (IP-based), tidak ada lapis kedua
    di level aplikasi -- beda dari `api-bridge` yang sudah punya `X-API-Key` sejak awal."""
    expected = settings.internal_api_key
    if expected and x_internal_api_key != expected:
        raise HTTPException(401, "X-Internal-Api-Key tidak valid atau tidak dikirim.")


# ==========================================
# Helpers
# ==========================================

async def _save_upload(upload: Optional[UploadFile], dest_dir: Path) -> Optional[str]:
    if upload is None:
        return None
    dest_path = dest_dir / f"{uuid.uuid4().hex}_{upload.filename}"
    with dest_path.open("wb") as f:
        shutil.copyfileobj(upload.file, f)
    return str(dest_path)


def _discard_job_dir(job_dir: Path) -> None:
    shutil.rmtree(job_dir, ignore_errors=True)


# ==========================================
# POST /v1/audit — submit (async job, fix T1 pattern)
# ==========================================

async def _run_audit_job(
    audit_id: str,
    job_dir: Path,
    ad_title: str,
    video_path: Optional[str],
    thumbnail_path: Optional[str],
    primary_text: Optional[str],
    headline: Optional[str],
    landing_page_url: Optional[str],
    presentation_layers_applied: List[str],
    gemini_api_key_override: Optional[str] = None,
):
    AUDIT_STATUS[audit_id] = {"status": "processing"}
    try:
        report = await engine.execute_audit(
            audit_id=audit_id,
            ad_title=ad_title,
            video_path=video_path,
            thumbnail_path=thumbnail_path,
            primary_text=primary_text,
            headline=headline,
            landing_page_url=landing_page_url,
            presentation_layers_applied=presentation_layers_applied,
            gemini_api_key_override=gemini_api_key_override,
        )
        report_dict = report.model_dump()

        # fix Batch E (2026-08-26, permintaan eksplisit Bossfren post-Batch-D): Check Ads
        # dijalankan OTOMATIS sbg bagian dari tiap audit (bukan menu/tombol terpisah yg harus
        # diklik manual) kalau ada headline/primary_text -- hasilnya MENGGANTIKAN card lama "Saran
        # Caption Aman" (dulu murni dari raw_assessment.remediation_assets.safe_captions, LLM
        # output generik TANPA instruksi prompt khusus soal kebijakan platform/hukum Indonesia --
        # lihat investigasi ledger Batch E) dgn hasil engine Check Ads yang jauh lebih grounded
        # (KNOWLEDGE_META/TIKTOK/INDONESIA_LAW/PUFFERY_CALIBRATION, lihat copywriting.py). Best-
        # effort murni -- KEGAGALAN DI SINI TIDAK BOLEH menggagalkan audit utama, cukup di-log &
        # field baru ini absen dari report (frontend fallback ke safe_captions lama kalau begitu).
        if (headline and headline.strip()) or (primary_text and primary_text.strip()):
            try:
                copy_check = await run_copywriting_check(
                    headline, primary_text, gemini_api_key_override
                )
                report_dict["copywriting_check"] = copy_check.model_dump()

                # fix Batch E (permintaan eksplisit Bossfren: "harusnya jadi replacing ya bukan
                # adding, kl adding nanti dobel"): safe_captions lama (LLM output generik dari
                # SATU pemanggilan besar audit compliance, TANPA knowledge base khusus platform/
                # hukum -- lihat investigasi ledger) DIBERSIHKAN begitu Check Ads yang lebih
                # grounded berhasil, supaya user TIDAK PERNAH lihat 2 sumber saran caption
                # sekaligus. Prompt/skema LLM di engine.py TETAP TIDAK DISENTUH (masih boleh
                # ngisi field ini di respons mentahnya) -- ini murni pembersihan di lapisan
                # presentasi/output, jadi zero risiko ke kontrak schema audit video yang
                # production-critical.
                report_dict.setdefault("raw_assessment", {}).setdefault(
                    "remediation_assets", {}
                )["safe_captions"] = []

                # Generate Ads dipakai sbg rekomendasi remediasi OTOMATIS hanya kalau Check Ads
                # menemukan masalah (verdict != AMAN) -- bukan tombol manual (keputusan eksplisit
                # Bossfren: "Otomatis saat ada pelanggaran"). product_or_keyword pakai ad_title
                # krn Generate Ads butuh konteks produk; copy asli + temuan masuk extra_context.
                if copy_check.overall_verdict != "AMAN":
                    try:
                        copy_gen = await run_copywriting_generate(
                            product_or_keyword=ad_title,
                            competitor_url=None,
                            extra_context=(
                                f"Copy iklan yang sedang diaudit:\n"
                                f"Headline: {headline or '(tidak diisi)'}\n"
                                f"Primary Text: {primary_text or '(tidak diisi)'}\n\n"
                                f"Hasil audit compliance menemukan masalah berikut -- buatkan "
                                f"varian alternatif yang memperbaikinya: {copy_check.summary}"
                            ),
                            gemini_api_key_override=gemini_api_key_override,
                        )
                        report_dict["copywriting_recommendations"] = copy_gen.model_dump()
                    except Exception as e:
                        logger.warning(
                            f"[Batch E] Generate Ads rekomendasi otomatis gagal utk audit "
                            f"{audit_id}: {e}"
                        )
            except Exception as e:
                logger.warning(f"[Batch E] Check Ads otomatis gagal utk audit {audit_id}: {e}")

        AUDIT_STATUS[audit_id] = {"status": "done", "report": report_dict}

        if needs_clarification(report.verdict, report.raw_assessment):
            # Tahan file sampai 1 ronde klarifikasi selesai — lihat kebijakan di header modul.
            # gemini_api_key_override ikut ditahan supaya clarify_audit() pakai key per-business yang
            # SAMA dengan audit awal, bukan fallback env generik (fix v1.4.1).
            _PENDING_CLARIFICATION_FILES[audit_id] = {
                "job_dir": job_dir,
                "video_path": video_path,
                "thumbnail_path": thumbnail_path,
                "gemini_api_key_override": gemini_api_key_override,
            }
            return  # JANGAN discard job_dir dulu

    except Exception as e:
        AUDIT_STATUS[audit_id] = {"status": "error", "error": str(e)}

    _discard_job_dir(job_dir)


@app.post("/v1/audit", dependencies=[Depends(_require_internal_key)])
async def submit_audit(
    background_tasks: BackgroundTasks,
    ad_title: str = Form(...),
    primary_text: Optional[str] = Form(None),
    headline: Optional[str] = Form(None),
    landing_page_url: Optional[str] = Form(None),
    # Comma-separated layer keys (mis. "template_overlay,color_grade") kalau video_file yang dikirim
    # di sini SUDAH lewat POST /v1/presentation/reinforce lebih dulu — murni field pencatatan
    # (`presentation_layers_applied` di laporan), endpoint ini TIDAK menjalankan reinforcement sendiri.
    presentation_layers_applied: Optional[str] = Form(None),
    video_file: Optional[UploadFile] = File(None),
    thumbnail_file: Optional[UploadFile] = File(None),
    # fix v1.4.1 (GEMINI_API_KEY per-business, keputusan Bossfren 2026-08-25): Node proxy
    # (video-guard.routes.ts) meneruskan key per-business lewat header ini kalau business yang
    # bersangkutan sudah mengisinya di Business.settings. Kalau header tidak dikirim, fallback ke
    # GEMINI_API_KEY env generik (lihat config.py/engine.py `_generate_with_fallback`).
    x_gemini_api_key: Optional[str] = Header(None),
):
    if video_file is None and thumbnail_file is None and not landing_page_url:
        raise HTTPException(
            400, "Minimal satu dari video_file/thumbnail_file/landing_page_url wajib diisi."
        )

    audit_id = f"aud_{uuid.uuid4().hex}"
    job_dir = UPLOAD_DIR / audit_id
    job_dir.mkdir(parents=True, exist_ok=True)

    video_path = await _save_upload(video_file, job_dir)
    thumbnail_path = await _save_upload(thumbnail_file, job_dir)
    layers = [l for l in (presentation_layers_applied or "").split(",") if l]

    AUDIT_STATUS[audit_id] = {"status": "queued"}
    background_tasks.add_task(
        _run_audit_job,
        audit_id,
        job_dir,
        ad_title,
        video_path,
        thumbnail_path,
        primary_text,
        headline,
        landing_page_url,
        layers,
        x_gemini_api_key,
    )
    return {"audit_id": audit_id, "status": "queued"}


@app.get("/v1/audit/{audit_id}", dependencies=[Depends(_require_internal_key)])
async def get_audit(audit_id: str):
    state = AUDIT_STATUS.get(audit_id)
    if state is None:
        raise HTTPException(
            404,
            "audit_id tidak ditemukan (atau service baru saja restart -- status in-memory, "
            "lihat catatan header main.py soal Redis/tabel VideoAdAudit).",
        )
    return state


# ==========================================
# POST /v1/audit/{audit_id}/clarify — fix K7 (re-check against real pixels, not just text)
# ==========================================

class ClarifyRequest(BaseModel):
    violation_id: str
    user_context: str


@app.post("/v1/audit/{audit_id}/clarify", dependencies=[Depends(_require_internal_key)])
async def clarify_audit(audit_id: str, payload: ClarifyRequest):
    state = AUDIT_STATUS.get(audit_id)
    if state is None or state.get("status") != "done":
        raise HTTPException(404, "audit_id tidak ditemukan atau audit belum selesai.")

    pending = _PENDING_CLARIFICATION_FILES.get(audit_id)
    if pending is None:
        # File sudah dibuang (verdict awal tidak butuh klarifikasi, atau klarifikasi sebelumnya
        # sudah dipakai sekali dan filenya sudah dihapus — lihat catatan header modul soal batasan
        # "satu ronde klarifikasi" MVP ini).
        raise HTTPException(
            410,
            "Video/thumbnail untuk audit ini sudah dibuang (kebijakan retensi, lihat header "
            "main.py) — klarifikasi lanjutan butuh video dikirim ulang lewat /v1/audit baru.",
        )

    from engine import ComplianceAuditReport  # local import — hindari circular reference di module load

    report = ComplianceAuditReport.model_validate(state["report"])
    updated = await engine.resolve_clarification(
        report=report,
        violation_id=payload.violation_id,
        user_context=payload.user_context,
        video_path=pending["video_path"],
        thumbnail_path=pending["thumbnail_path"],
        gemini_api_key_override=pending.get("gemini_api_key_override"),
    )
    updated_dict = updated.model_dump()
    # fix Batch E: copywriting_check/copywriting_recommendations BUKAN field resmi
    # ComplianceAuditReport, jadi ikut hilang diam-diam saat ComplianceAuditReport.model_validate()
    # di atas (Pydantic buang extra field tak dikenal by default). Klarifikasi di sini soal
    # re-check violation video/visual dgn pixel asli (fix K7), BUKAN soal teks copy -- jadi aman &
    # benar utk carry-forward hasil Check/Generate Ads dari audit awal apa adanya, bukan re-run.
    for _key in ("copywriting_check", "copywriting_recommendations"):
        if _key in state["report"]:
            updated_dict[_key] = state["report"][_key]
    AUDIT_STATUS[audit_id] = {"status": "done", "report": updated_dict}

    # MVP: satu ronde klarifikasi per audit, lalu file dibuang — lihat catatan header modul kalau
    # ini perlu diperluas ke multi-ronde nanti (Redis/tabel VideoAdAudit + retensi lebih panjang).
    _discard_job_dir(pending["job_dir"])
    del _PENDING_CLARIFICATION_FILES[audit_id]

    return updated.model_dump()


# ==========================================
# POST /v1/presentation/reinforce — Blueprint Section 12.3 (async job, pola sama seperti /v1/audit)
# ==========================================

async def _run_reinforce_job(job_id: str, video_path: str, layers: List[PresentationLayer]):
    PRESENTATION_STATUS[job_id] = {"status": "processing"}
    try:
        result = await reinforce_presentation(
            PresentationReinforcementRequest(video_path=video_path, layers=layers)
        )
        PRESENTATION_STATUS[job_id] = {"status": "done", "result": result.model_dump()}
    except Exception as e:
        PRESENTATION_STATUS[job_id] = {"status": "error", "error": str(e)}


@app.post("/v1/presentation/reinforce", dependencies=[Depends(_require_internal_key)])
async def submit_reinforcement(
    background_tasks: BackgroundTasks,
    layers: str = Form(...),  # comma-separated PresentationLayer keys, mis. "template_overlay,color_grade"
    video_file: UploadFile = File(...),
):
    job_dir = UPLOAD_DIR / f"pr_{uuid.uuid4().hex}"
    job_dir.mkdir(parents=True, exist_ok=True)
    video_path = await _save_upload(video_file, job_dir)

    try:
        layer_list = [PresentationLayer(l) for l in layers.split(",") if l]
    except ValueError as e:
        raise HTTPException(400, f"Layer tidak dikenal: {e}")

    job_id = f"pr_{uuid.uuid4().hex}"
    PRESENTATION_STATUS[job_id] = {"status": "queued"}
    background_tasks.add_task(_run_reinforce_job, job_id, video_path, layer_list)
    return {"job_id": job_id, "status": "queued"}


@app.get("/v1/presentation/reinforce/{job_id}/status", dependencies=[Depends(_require_internal_key)])
async def get_reinforcement_status(job_id: str):
    state = PRESENTATION_STATUS.get(job_id)
    if state is None:
        raise HTTPException(404, "job_id tidak ditemukan (atau service baru saja restart).")
    return state


# ==========================================
# POST /v1/copywriting/check & /v1/copywriting/generate -- Fase 2 "Copywriting Ads"
# (blueprint 2026-08-26 Bagian 5). SENGAJA SYNCHRONOUS (bukan BackgroundTasks/AUDIT_STATUS spt
# /v1/audit) -- murni teks lewat Gemini, jauh lebih cepat dari audit video, blueprint Bagian 5.4
# eksplisit bilang "skip semua pipeline video/media". Logic sesungguhnya ada di copywriting.py
# (modul terpisah, lihat docstring di sana kenapa tidak lewat MetaAdGuardEngine/invoker classes).
# ==========================================

class CopywritingCheckRequest(BaseModel):
    headline: Optional[str] = None
    primary_text: Optional[str] = None


@app.post("/v1/copywriting/check", dependencies=[Depends(_require_internal_key)])
async def copywriting_check(
    payload: CopywritingCheckRequest,
    x_gemini_api_key: Optional[str] = Header(None),
):
    try:
        result = await run_copywriting_check(payload.headline, payload.primary_text, x_gemini_api_key)
    except ValueError as e:
        raise HTTPException(400, str(e))
    return result.model_dump()


class CopywritingGenerateRequest(BaseModel):
    product_or_keyword: str
    competitor_url: Optional[str] = None
    extra_context: Optional[str] = None


@app.post("/v1/copywriting/generate", dependencies=[Depends(_require_internal_key)])
async def copywriting_generate(
    payload: CopywritingGenerateRequest,
    x_gemini_api_key: Optional[str] = Header(None),
):
    try:
        result = await run_copywriting_generate(
            payload.product_or_keyword,
            payload.competitor_url,
            payload.extra_context,
            x_gemini_api_key,
        )
    except ValueError as e:
        raise HTTPException(400, str(e))
    return result.model_dump()
