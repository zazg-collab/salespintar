"""
metaguard_service/engine.py

Core MetaAdGuard AI compliance engine — ported dari
`TECHNICAL_SYSTEM_DESIGN_BLUEPRINT.md` (projek-contentcreator, v1.4.0) Section 6/7 APA ADANYA,
sesuai prinsip "port kode Python yang sudah lengkap, jangan tulis ulang dari nol"
(lihat projek-ceo/20260825-blueprint-integrasi-meta-video-ai-guards-ke-salespintar.md Section 3.1).

Source of truth desain TETAP Blueprint di atas — kalau logic di sini perlu berubah (prompt, formula
skor, invocation layer), perubahan itu wajib mulai dari Blueprint dulu (lewat protokol Wasit + Ledger
projek-contentcreator), baru di-port ke sini, bukan sebaliknya.

Dua penyimpangan sadar dari teks Blueprint (dicatat di sini biar jujur, keduanya cuma perbaikan bug
kecil, bukan perubahan desain):
  1. `LandingPageAuditor.extract_page_text()`: Blueprint menulis `"\\n".join(parts)` (backslash
     ganda -- akan menghasilkan string literal "\\n", bukan baris baru sungguhan). Diperbaiki jadi
     `"\n".join(parts)` di sini.
  2. Semua path `BRIDGE_API_KEY`/`bridge_url` dibaca dari environment lewat helper di `config.py`,
     bukan langsung `os.environ.get(...)` di titik konstruksi -- supaya satu tempat saja yang perlu
     tahu nama env var, konsisten dengan pola `.env`/`config` module lain di repo ini.

Invariant inti (TIDAK BOLEH dilanggar oleh perubahan apa pun di file ini): LLM (baik lewat agy CLI
maupun Gemini SDK fallback) HANYA mengisi `ComplianceRawAssessment` -- skor akhir, verdict, dan
critical penalty SELALU dihitung `compute_final_assessment()` di Python murni, tidak pernah diklaim
langsung dari output model.
"""

from __future__ import annotations

import os
import re
import json
import time
import uuid
import shutil
import asyncio
import base64
from abc import ABC, abstractmethod
from typing import List, Optional, Literal, Dict, Tuple, Any
from pathlib import Path

import cv2
import httpx
from pydantic import BaseModel, Field, ValidationError
from google import genai
from google.genai import types
from playwright.async_api import async_playwright
from tenacity import retry, stop_after_attempt, wait_exponential, retry_if_exception


# ==========================================
# 1. Pydantic Domain Schemas (Blueprint Section 6.1)
# ==========================================
# fix K3: closed enum + Python-side lookup table, never a free-form number from the LLM.
CRITICAL_PENALTY_TABLE: Dict[str, int] = {
    "brandishing_at_human": 50,
    "explicit_threat_language": 50,
    "banned_weapon_keyword_in_hook": 40,
}


class ViolationEvidence(BaseModel):
    """fix v1.5.0 (blueprint 2026-08-26 Bagian 4): bukti konkret di balik satu violation, biar tim
    konten lihat/baca sendiri bukannya cuma percaya deskripsi bebas `detected_element`.
    evidence_text DIISI LLM (kutipan PERSIS, bukan parafrase) -- HANYA utk channel Text/Landing_Page.
    frame_asset_id TIDAK PERNAH diisi LLM -- diisi Python murni oleh `_attach_evidence_frames()`
    (fix v1.6.0, blueprint Batch B Bagian 4.2) setelah `parse_raw_assessment()` sukses: ekstraksi
    still-frame cv2 dari video_path utk channel Video_Visual/Video_Audio, compress+copy
    thumbnail_path utk channel Image.
    frame_jpeg_base64 TRANSPORT-ONLY (fix v1.6.0): base64 JPEG dari Python, HANYA dipakai buat bawa
    bytes dari metaguard_service ke Node backend dalam satu response JSON ini. Node WAJIB decode +
    simpan ke tabel `video_ad_audit_evidence` lalu STRIP field ini sebelum persist `rawReportJson`
    ke Postgres -- supaya bytes yang sama tidak dobel tersimpan di JSONB dan di kolom bytea (lihat
    catatan 'dicompres biar kecil' Bossfren, blueprint Bagian 4.3). Field ini TIDAK BOLEH pernah
    sampai ke frontend -- kalau muncul di response API publik, itu bug di layer Node."""
    evidence_type: Literal["image_frame", "video_frame", "text_excerpt"]
    evidence_text: Optional[str] = None
    frame_asset_id: Optional[str] = None
    frame_jpeg_base64: Optional[str] = None


class ViolationDetail(BaseModel):
    id: str
    channel: Literal["Text", "Image", "Video_Visual", "Video_Audio", "Landing_Page"]
    timestamp_start: Optional[str] = None
    timestamp_end: Optional[str] = None
    risk_level: Literal["LOW", "MEDIUM", "HIGH"]
    # fix K3: None unless one of the two fatal cases in Blueprint Section 4 actually applies.
    critical_code: Optional[Literal[
        "brandishing_at_human", "explicit_threat_language", "banned_weapon_keyword_in_hook"
    ]] = None
    detected_element: str
    policy_reference: str
    remediation: str
    # fix v1.5.0 (blueprint 2026-08-26 Bagian 4): bukti evidence, optional -- null kalau LLM tidak
    # menyediakan kutipan (mis. violation channel Video_Visual/Video_Audio/Image di batch ini, yang
    # bukti visualnya baru diisi Batch B).
    evidence: Optional[ViolationEvidence] = None


class ChannelScores(BaseModel):
    # fix K8: Optional, not required — a channel with no asset attached (e.g. no landing_page_url)
    # must be omittable, not force-hallucinated as some int by the LLM to satisfy a required field.
    visual_motion_score: Optional[int] = Field(default=None, ge=0, le=100)
    audio_speech_score: Optional[int] = Field(default=None, ge=0, le=100)
    text_copy_score: Optional[int] = Field(default=None, ge=0, le=100)
    thumbnail_image_score: Optional[int] = Field(default=None, ge=0, le=100)
    landing_page_score: Optional[int] = Field(default=None, ge=0, le=100)


class SceneRevisionNote(BaseModel):
    """fix v1.5.0 (blueprint 2026-08-26 Bagian 3): GANTI DirectorRemediationAdvice -- yg lama itu 5
    field TETAP yang SELALU diisi LLM tiap audit walau videonya bersih (makanya kerasa template
    generik, gak grounded ke bukti apa pun). Sekarang list, WAJIB terikat ke violation_id nyata dari
    `violations` di atas, dan HARUS KOSONG kalau tidak ada violation Video_Visual/Video_Audio yang
    genuinely butuh reshoot -- list kosong itu HASIL YANG BENAR utk video yang sudah bersih, bukan
    kekurangan data."""
    violation_id: str
    timestamp_range: Optional[str] = None
    what_is_shown_now: str
    what_to_change: str
    suggested_replacement: Optional[str] = None


class RemediationAssets(BaseModel):
    safe_captions: List[str] = Field(default_factory=list)
    safe_voiceover_script: Optional[str] = None
    visual_cut_instructions: List[str] = Field(default_factory=list)
    # fix v1.5.0: GANTI director_advice: Optional[DirectorRemediationAdvice] (lihat SceneRevisionNote
    # docstring di atas kenapa).
    scene_revision_notes: List[SceneRevisionNote] = Field(default_factory=list)
    landing_page_fixes: List[str] = Field(default_factory=list)


class ClarificationQuestion(BaseModel):
    # fix K4/schema: list item, not a singular top-level object — see Blueprint Section 5 note.
    violation_id: str
    target_timestamp: Optional[str] = None
    question: str


class ImageAnalysis(BaseModel):
    """fix v1.4.2 (keputusan Bossfren 2026-08-25 -- 'Tambah OCR + object detection + transcript
    verbatim'): detail ekstraksi utk channel Image/Thumbnail, dipakai tab 'Media Analysis' di
    frontend. Optional murni (pola K8) -- null kalau tidak ada asset gambar yang dilampirkan,
    JANGAN dipaksa diisi placeholder oleh LLM.
    fix v1.5.0 (blueprint 2026-08-26 Bagian 2.1): + visual_style_note/text_legibility_note -- ini
    observasi KUALITAS KREATIF, BUKAN compliance, jadi boleh terisi walau creative-nya 100% lolos
    audit. Tujuannya biar tab Media Analysis informatif buat tim konten walau tidak ada pelanggaran."""
    extracted_text: Optional[str] = None
    detected_objects: List[str] = Field(default_factory=list)
    visual_style_note: Optional[str] = None
    text_legibility_note: Optional[str] = None


class SceneSegment(BaseModel):
    """fix v1.5.0 (blueprint 2026-08-26 Bagian 2.2): satu shot/scene dalam breakdown video."""
    timestamp_range: str
    description: str
    objects_present: List[str] = Field(default_factory=list)


class VideoAnalysis(BaseModel):
    """fix v1.4.2 (keputusan Bossfren 2026-08-25): detail ekstraksi utk channel Video (visual +
    audio), dipakai tab 'Media Analysis' di frontend. Optional murni (pola K8) -- null kalau tidak
    ada asset video yang dilampirkan/berhasil diambil dari Meta.
    fix v1.5.0 (blueprint 2026-08-26 Bagian 2.2): + scene_breakdown/hook_effectiveness_note/
    pacing_note -- observasi KUALITAS KREATIF (bukan compliance), biar tim konten ngerti "cerita"
    videonya per detik, bukan cuma satu blob transcript+objects."""
    audio_transcript: Optional[str] = None
    detected_objects: List[str] = Field(default_factory=list)
    scene_breakdown: List[SceneSegment] = Field(default_factory=list)
    hook_effectiveness_note: Optional[str] = None
    pacing_note: Optional[str] = None


class ComplianceRawAssessment(BaseModel):
    """Everything the LLM is actually allowed to fill in. No score arithmetic, no verdict."""
    ad_title: str
    channel_scores: ChannelScores
    violations: List[ViolationDetail] = Field(default_factory=list)
    clarification_questions: List[ClarificationQuestion] = Field(default_factory=list)
    remediation_assets: RemediationAssets
    executive_summary: str
    # fix v1.4.2: image_analysis/video_analysis Optional -- diisi LLM HANYA kalau asset terkait
    # benar-benar dilampirkan (null jika tidak, bukan objek kosong dgn field kosong -- biar frontend
    # bisa bedakan "tidak dianalisis" dari "dianalisis, hasilnya nihil").
    image_analysis: Optional[ImageAnalysis] = None
    video_analysis: Optional[VideoAnalysis] = None


class ComplianceAuditReport(BaseModel):
    """The full report returned to the client. Score/verdict/penalty are backend-computed."""
    audit_id: str
    raw_assessment: ComplianceRawAssessment
    overall_compliance_score: int = Field(ge=0, le=100)
    verdict: Literal["APPROVED", "NEEDS_MINOR_TWEAK", "HIGH_RISK_REJECT", "MANUAL_REVIEW"]
    critical_penalty_applied: int
    channels_used: List[str]
    # fix PR-integration (Blueprint Section 12): traceability field — if the video was run through
    # the optional Presentation Reinforcement module before this audit, record exactly which layers
    # were applied so a reviewer can see why a score looks different from the raw source footage.
    presentation_layers_applied: List[str] = Field(default_factory=list)


# ==========================================
# 2. Deterministic Scoring — Python-only (fix K1/K2)
# ==========================================

CHANNEL_WEIGHTS: Dict[str, float] = {
    "visual_motion_score": 0.35,
    "audio_speech_score": 0.25,
    "text_copy_score": 0.15,
    "thumbnail_image_score": 0.15,
    "landing_page_score": 0.10,
}


def score_to_verdict(score: int) -> str:
    if score >= 80:
        return "APPROVED"
    if score >= 60:
        return "NEEDS_MINOR_TWEAK"
    return "HIGH_RISK_REJECT"


def compute_final_assessment(raw: ComplianceRawAssessment) -> Tuple[int, str, int, List[str]]:
    """
    fix K1/K2/K8: normalizes weights over only the channels actually present (fix K8), looks up the
    critical penalty from Python (fix K3, max not sum — see Blueprint Section 4), and derives the
    verdict from the computed score rather than trusting anything the LLM claims about its own
    arithmetic. This is THE single source of truth for score/verdict — never bypass it.
    """
    scores = raw.channel_scores.model_dump()
    present = {k: v for k, v in scores.items() if v is not None}
    if not present:
        # No channel could be scored at all (e.g. every asset failed ingestion) — do not silently
        # emit a score of 0/100 as if it were a real audit result.
        return 0, "MANUAL_REVIEW", 0, []

    weight_sum = sum(CHANNEL_WEIGHTS[k] for k in present)
    weighted = sum(CHANNEL_WEIGHTS[k] * v for k, v in present.items()) / weight_sum

    critical_penalty = max(
        [CRITICAL_PENALTY_TABLE[v.critical_code] for v in raw.violations if v.critical_code],
        default=0,
    )
    final_score = max(0, min(100, round(weighted - critical_penalty)))
    # A critical hit that still nets a raw score >= 60 after the weighted average is a fatal case by
    # definition (Blueprint Section 4) — force HIGH_RISK_REJECT rather than let a high weighted
    # average paper over a single brandishing/threat detection.
    verdict = (
        "HIGH_RISK_REJECT"
        if critical_penalty > 0 and final_score < 60
        else score_to_verdict(final_score)
    )
    return final_score, verdict, critical_penalty, list(present.keys())


def needs_clarification(verdict: str, raw: ComplianceRawAssessment) -> bool:
    """fix K4: Clarification Co-Pilot triggers iff NEEDS_MINOR_TWEAK AND at least one open question."""
    return verdict == "NEEDS_MINOR_TWEAK" and len(raw.clarification_questions) > 0


# ==========================================
# 3. Adversarial System Prompt
# ==========================================

SYSTEM_PROMPT = """
You are the Lead Adversarial Policy Compliance Auditor for Meta Ads (Facebook & Instagram), specialized in hardware, cutlery, and agricultural tools.
Your mission is to perform a rigorous pre-flight compliance audit of ad assets (Copy, Image, Video Motion, Audio Speech, Landing Page) against Meta Advertising Standards.

GROUND-TRUTH POLICY RULES TO ENFORCE:
1. META POLICY SECTION 4.12 (WEAPONS, AMMUNITION & EXPLOSIVES):
   - Non-culinary knives, tactical blades, self-defense weapons, hunting blades are STRICTLY PROHIBITED.
   - EXEMPTION: Agricultural, farm, landscaping, and workshop utility tools (machetes, sickles, palm chisels, pruning shears) are ALLOWED ONLY IF presented with explicit agricultural utility context without tactical/combat aesthetic.
2. META POLICY SECTION 4.13 (SENSATIONAL & VIOLENT CONTENT):
   - Prohibit blade brandishing, horizontal waving, or camera-directed thrusting gestures.
   - Enforce downward cutting motion on organic work media (wood/bamboo/banana tree).
   - Hook Window (00:00 - 00:03): Must establish outdoor farm/orchard context. Zero tolerance for dark isolated studio tables.
3. META POLICY SECTION 4.28 (CIRCUMVENTING SYSTEMS):
   - Flag deliberate text obfuscation (e.g. 'p*sau', 's-a-j-a-m', disguised unicode symbols). Require natural semantic safe copywriting instead.
4. META POLICY SECTION 4.4 (DESTINATION & LANDING PAGE ALIGNMENT):
   - Landing page must be free of prohibited tactical weapon items and consistent with agricultural claims.

YOUR OUTPUT IS RAW ASSESSMENT ONLY — DO NOT COMPUTE A FINAL SCORE OR VERDICT:
- Fill `channel_scores` per attached asset ONLY (leave a field null if that asset was not attached —
  do not invent a placeholder number).
- For any violation matching the two fatal cases below, set `critical_code` to the matching enum
  value. Do NOT invent your own penalty number — the backend looks it up.
  - `brandishing_at_human`: blade waved/thrust toward camera or a person.
  - `explicit_threat_language`: spoken or on-screen text is an explicit threat.
  - `banned_weapon_keyword_in_hook`: a banned weapon keyword appears in the 0-3s hook window.
- If a violation is genuinely ambiguous (context-dependent, e.g. "is this a farm tool or a weapon"),
  add ONE entry to `clarification_questions` per ambiguous violation, referencing its `violation_id`.
  Do not add a clarification question for a violation you are confident about either way.
- If an Image/Thumbnail asset IS attached, fill `image_analysis.extracted_text` with any text you
  can read on the image (OCR-style — verbatim, or empty string if the image has no legible text) and
  `image_analysis.detected_objects` with a short list of concrete objects/subjects visible (e.g.
  "machete", "wooden cutting board", "farmer's hand"). Leave `image_analysis` entirely null if no
  image/thumbnail asset was attached — do not fabricate this section for a text-only audit.
- If a Video asset IS attached, fill `video_analysis.audio_transcript` with a verbatim transcript of
  all spoken/narrated audio in the video (empty string if the video has no speech), and
  `video_analysis.detected_objects` with a short list of concrete objects/subjects visible across the
  video's frames. Leave `video_analysis` entirely null if no video asset was attached or the video
  could not be analyzed.
- Fill `image_analysis.visual_style_note` and `.text_legibility_note` with genuine creative-quality
  observations (composition, mood, contrast/legibility) -- these are NOT compliance findings, do not
  reference policy here. Leave null if the observation would be trivial or non-actionable.
- Fill `video_analysis.scene_breakdown` by segmenting the video into 3-6 meaningful shots/scenes it
  ACTUALLY contains, each with its own `timestamp_range`, `description`, and `objects_present`. Do
  not invent scenes that do not exist in the video.
- Fill `video_analysis.hook_effectiveness_note` (how compelling the first 3 seconds are, purely from
  an attention/creative standpoint) and `.pacing_note` (overall tempo/momentum) -- again, these are
  creative-quality observations, not compliance findings.
- For a violation on the "Text" or "Landing_Page" channel, set `evidence.evidence_type` to
  "text_excerpt" and `evidence.evidence_text` to the EXACT verbatim phrase from the primary text,
  headline, or landing page extract that triggered the violation -- a direct substring of the
  original copy, never a paraphrase. For a violation on any other channel, leave `evidence` null in
  this pass (visual evidence is attached separately, not by you).
- The "Text" channel (text_copy_score) covers ALL textual claims the audience will encounter, whether
  WRITTEN (Primary Text, Headline) or SPOKEN (the video's audio_transcript). A claim spoken in the
  video carries the same weight as a claim written in the ad copy -- evaluate both together when
  scoring text_copy_score and when flagging Text-channel violations.
- The "Video_Audio" channel (audio_speech_score) covers DELIVERY quality only: tone, pacing, clarity
  of narration, audio production quality -- NOT the content/claims of what is said (that is the Text
  channel's job). Do not double-flag the same spoken claim as a violation under both channels.
- Only produce `remediation_assets.scene_revision_notes` entries when there is an ACTUAL Video_Visual
  or Video_Audio violation in your `violations` list that genuinely requires reshooting the scene.
  Each entry MUST set `violation_id` to a real id from your own `violations` list, and
  `what_is_shown_now` must describe what is ACTUALLY visible/audible in that scene right now
  (consistent with your own `detected_objects`/`video_analysis` for that timestamp), not a generic
  phrase. If there is no video asset, or the video has no violation requiring a reshoot, leave
  `scene_revision_notes` as an EMPTY LIST -- an empty list is the correct and expected output for a
  compliant video. Do NOT invent a note just to fill space.
- Respond strictly with valid JSON conforming to the ComplianceRawAssessment schema.
"""

SAFETY_SETTINGS = [
    types.SafetySetting(
        category=types.HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
        threshold=types.HarmBlockThreshold.BLOCK_NONE,
    ),
    types.SafetySetting(
        category=types.HarmCategory.HARM_CATEGORY_HARASSMENT,
        threshold=types.HarmBlockThreshold.BLOCK_NONE,
    ),
    # fix K6/T5: BLOCK_NONE on every category can trip Google's safety-eligibility gate on some
    # projects (returns PROHIBITED_CONTENT / empty candidates instead of a normal response). Hate
    # speech and sexual content are not the axis this system needs to relax — keep those at a
    # conservative default and only loosen the two categories that actually collide with agricultural
    # blade content.
    types.SafetySetting(
        category=types.HarmCategory.HARM_CATEGORY_HATE_SPEECH,
        threshold=types.HarmBlockThreshold.BLOCK_ONLY_HIGH,
    ),
    types.SafetySetting(
        category=types.HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
        threshold=types.HarmBlockThreshold.BLOCK_ONLY_HIGH,
    ),
]


# ==========================================
# 4. Local Asset Validation (fix K9 — adopted from AdGuardAI's video_compliance_checker.py)
# ==========================================

SUPPORTED_VIDEO_MIME = {"video/mp4", "video/quicktime", "video/webm", "video/x-msvideo", "video/3gpp"}


def validate_video_asset(video_path: str) -> None:
    """
    Reject a corrupt/wrong-duration file with cv2 BEFORE spending an invocation (agy or Gemini File
    API) on it. v1.0.0 had no local validation step at all — a malformed or 400s video would only
    fail after a full round trip, wasting quota and the SLA budget for nothing.
    """
    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        raise ValueError(f"Video tidak bisa dibuka/rusak: {video_path}")
    fps = cap.get(cv2.CAP_PROP_FPS) or 0
    frame_count = cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0
    duration = frame_count / fps if fps > 0 else 0
    cap.release()
    if not (5 <= duration <= 180):
        raise ValueError(f"Durasi video {duration:.1f}s di luar spec (5-180s) — lihat Blueprint Section 3.3.")


# ==========================================
# 4b. Evidence Frame Extraction (fix v1.6.0 — blueprint 2026-08-26 Batch B Bagian 4.2)
# ==========================================

def _parse_timestamp_to_ms(timestamp: str) -> Optional[float]:
    """Parse "MM:SS" atau "HH:MM:SS" jadi milidetik. None kalau format tidak dikenali -- caller
    WAJIB treat None sebagai "skip, jangan crash", bukan exception."""
    if not timestamp:
        return None
    raw_parts = timestamp.strip().split(":")
    try:
        parts = [int(p) for p in raw_parts]
    except ValueError:
        return None
    if len(parts) == 2:
        h, m, s = 0, parts[0], parts[1]
    elif len(parts) == 3:
        h, m, s = parts
    else:
        return None
    return float((h * 3600 + m * 60 + s) * 1000)


def _encode_jpeg_capped(frame, max_kb: int) -> Optional[bytes]:
    """Encode 1 frame cv2 (BGR ndarray) jadi JPEG, turunkan kualitas bertahap sampai <= max_kb.
    Kalau semua percobaan masih di atas max_kb (frame kompleks/resolusi tinggi), balikin usaha
    terbaik (kualitas terendah yang dicoba) drpd tidak ada evidence sama sekali."""
    best: Optional[bytes] = None
    for quality in (85, 70, 55, 40, 25):
        ok, buf = cv2.imencode(".jpg", frame, [int(cv2.IMWRITE_JPEG_QUALITY), quality])
        if not ok:
            continue
        best = buf.tobytes()
        if (len(best) / 1024.0) <= max_kb:
            return best
    return best


def extract_evidence_frame(video_path: str, timestamp_start: str, max_kb: int = 50) -> Optional[bytes]:
    """
    fix v1.6.0 (blueprint Batch B Bagian 4.2): ambil 1 still-frame JPEG dari `video_path` pada
    `timestamp_start` ("MM:SS"/"HH:MM:SS"), turunkan kualitas JPEG bertahap sampai <= max_kb.
    Best-effort MURNI -- video rusak/timestamp di luar durasi/apa pun kegagalan lain harus balik
    None diam-diam, TIDAK BOLEH melempar exception ke caller (evidence adalah pelengkap, bukan
    bagian kritis dari hasil audit -- lihat invariant di header modul ini).
    """
    if not video_path or not Path(video_path).exists():
        return None
    ms = _parse_timestamp_to_ms(timestamp_start)
    if ms is None:
        return None
    cap = cv2.VideoCapture(video_path)
    try:
        if not cap.isOpened():
            return None
        cap.set(cv2.CAP_PROP_POS_MSEC, ms)
        ok, frame = cap.read()
        if not ok or frame is None:
            return None
        return _encode_jpeg_capped(frame, max_kb)
    except Exception:
        return None
    finally:
        cap.release()


def _compress_thumbnail_evidence(thumbnail_path: str, max_kb: int = 50) -> Optional[bytes]:
    """fix v1.6.0: thumbnail asli (upload Meta) sering > 50KB (JPEG kualitas tinggi/PNG) -- re-encode
    lewat cv2 dgn kualitas diturunkan, konsisten dgn cap ukuran evidence video (Bossfren: 'dicompres
    biar kecil ya inget'). Kalau cv2 gagal baca file (format aneh/corrupt), fallback ke bytes asli
    apa adanya drpd gak ada evidence -- best-effort, bukan bagian kritis."""
    try:
        img = cv2.imread(thumbnail_path)
        if img is None:
            return Path(thumbnail_path).read_bytes()
        return _encode_jpeg_capped(img, max_kb) or Path(thumbnail_path).read_bytes()
    except Exception:
        try:
            return Path(thumbnail_path).read_bytes()
        except Exception:
            return None


def _attach_evidence_frames(
    raw: "ComplianceRawAssessment",
    audit_id: str,
    video_path: Optional[str],
    thumbnail_path: Optional[str],
) -> None:
    """
    fix v1.6.0 (blueprint Batch B Bagian 4.2): isi `evidence.frame_asset_id` +
    `evidence.frame_jpeg_base64` (transport-only, lihat docstring ViolationEvidence) utk tiap
    violation channel Video_Visual/Video_Audio (extract_evidence_frame dari video_path) dan Image
    (compress+copy thumbnail_path, bytes-nya sudah ada di disk dari upload request yang sama).
    Text/Landing_Page TIDAK disentuh di sini -- evidence_text-nya sudah diisi LLM lewat prompt,
    tidak butuh proses gambar apa pun.
    Dipanggil SETELAH parse_raw_assessment() sukses, SEBELUM compute_final_assessment() -- mutasi
    in-place terhadap `raw.violations`, tidak mengembalikan apa pun. Best-effort per-violation --
    satu violation gagal diambil evidence-nya TIDAK BOLEH menggagalkan violation lain / audit ini.
    """
    for v in raw.violations:
        try:
            frame_bytes: Optional[bytes] = None
            evidence_type: Optional[str] = None
            if v.channel in ("Video_Visual", "Video_Audio") and video_path and v.timestamp_start:
                frame_bytes = extract_evidence_frame(video_path, v.timestamp_start)
                evidence_type = "video_frame"
            elif v.channel == "Image" and thumbnail_path and Path(thumbnail_path).exists():
                frame_bytes = _compress_thumbnail_evidence(thumbnail_path)
                evidence_type = "image_frame"
            if not frame_bytes or not evidence_type:
                continue
            asset_id = v.id
            b64 = base64.b64encode(frame_bytes).decode("ascii")
            if v.evidence is None:
                v.evidence = ViolationEvidence(evidence_type=evidence_type, frame_asset_id=asset_id)
            else:
                v.evidence.frame_asset_id = asset_id
            v.evidence.frame_jpeg_base64 = b64
        except Exception:
            continue


# ==========================================
# 5. Retry / Backoff Wrapper (fix T2 — adopted from AdGuardAI's rate_limiter.py / api_key_pool.py)
# ==========================================

def _is_transient_error(exc: BaseException) -> bool:
    msg = str(exc).lower()
    return "429" in msg or "resource_exhausted" in msg or "503" in msg or "unavailable" in msg


@retry(
    stop=stop_after_attempt(3),
    wait=wait_exponential(multiplier=2, min=2, max=20),
    retry=retry_if_exception(_is_transient_error),
    reraise=True,
)
def _call_gemini_with_retry(client: genai.Client, **kwargs):
    """
    v1.0.0 had zero retry logic around generate_content — a single transient 429/503 from Gemini
    would fail the entire audit. AdGuardAI's Node.js backend handles this with an API-key pool +
    rate limiter; this project has one API key (Bossfren's own, fallback path only), so the adopted
    pattern here is exponential backoff on the transient-error subset only, not multi-key rotation.
    """
    return client.models.generate_content(**kwargs)


# ==========================================
# 6. Landing Page Auditor (fix K9 — adopted from AdGuardAI's web_agent/webby_fastapi.py)
# ==========================================

class LandingPageAuditor:
    """
    Real headless-browser scrape via Playwright, not a raw URL handed to Gemini's url_context tool.
    url_context is GA but cannot render JS-heavy storefronts (Shopify/WordPress builders routinely
    are), caps at 34MB/URL, and has no video/audio support — unsuitable as the sole ingestion path
    for Pipeline 4 (fix K9).
    """

    async def extract_page_text(self, url: str, timeout_ms: int = 15000) -> str:
        async with async_playwright() as p:
            browser = await p.chromium.launch(headless=True)
            try:
                page = await browser.new_page(
                    user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
                )
                await page.goto(url, wait_until="domcontentloaded", timeout=timeout_ms)
                await page.wait_for_timeout(2500)  # let client-rendered storefronts settle
                content = await page.evaluate(
                    """
                    () => {
                        const title = document.title || '';
                        const headings = Array.from(document.querySelectorAll('h1, h2, h3'))
                            .map(h => h.innerText.trim()).filter(Boolean);
                        const paragraphs = Array.from(document.querySelectorAll('p'))
                            .map(p => p.innerText.trim()).filter(Boolean);
                        return { title, headings, paragraphs };
                    }
                    """
                )
                parts = [content.get("title", "")]
                parts += content.get("headings", [])
                parts += content.get("paragraphs", [])
                # NOTE: Blueprint teksnya "\\n".join(parts) (backslash ganda, bug) — diperbaiki jadi
                # newline sungguhan di sini, lihat docstring modul di atas.
                text = "\n".join(parts)[:3000]
                return text or "Halaman tidak memuat teks yang bisa dibaca."
            except Exception as e:
                return f"[SCRAPE_FAILED] {e}"
            finally:
                await browser.close()


# ==========================================
# 7. LLM Invocation Layer — agy CLI via api-bridge (primary) + Gemini SDK (fallback)
# ==========================================
# fix v1.4.0 (2026-08-25, dikonfirmasi Bossfren "ok gitu aja"): AgyCliInvoker TIDAK spawn `agy`
# sendiri. `api-bridge/server.js` (VPS Antigravity/"VPS 45") adalah satu-satunya proses yang boleh
# spawn `agy` (prinsip tertulis di header komentar server.js itu sendiri), dan endpoint POST /v1/run
# miliknya sudah dilindungi concurrency guard (semaphore + antrean FIFO). AgyCliInvoker memanggil
# endpoint itu lewat HTTP supaya MetaGuard otomatis ikut antre yang sama dengan modul AI Media Buyer,
# bukan jadi jalur ketiga yang tidak ter-guard. Detail alasan lengkap: Blueprint Section 7, changelog
# 11.4.

JSON_DELIMITER = "---JSON---"


class LlmInvoker(ABC):
    """Kontrak invocation layer. Mengembalikan raw text respons model (belum diparse) — parsing dan
    fallback-ke-MANUAL_REVIEW ditangani seragam oleh `parse_raw_assessment()` di bawah, supaya
    `AgyCliInvoker` dan `GeminiSdkInvoker` sama-sama tunduk pada kontrak yang identik dan
    `MetaAdGuardEngine` tidak perlu tahu invoker mana yang sedang dipakai."""

    @abstractmethod
    async def generate(self, prompt: str, media_paths: List[str], system_instruction: str) -> str:
        """Kembalikan teks mentah keluaran model. Untuk `AgyCliInvoker` ini adalah body respons
        `/v1/run` (deskripsi bebas + `JSON_DELIMITER` + JSON). Untuk `GeminiSdkInvoker` ini adalah
        `response.text` (JSON murni, dijamin oleh `response_schema`)."""
        raise NotImplementedError


class AgyCliInvoker(LlmInvoker):
    """Primary invoker — memanggil `api-bridge`'s `POST /v1/run` lewat HTTP, memakai kuota Google AI
    Pro Bossfren (`api-bridge` yang benar-benar spawn `agy`-nya). `agy` (di dalam `api-bridge`)
    membaca file dari direktori yang di-attach lewat `--add-dir` (AGY_WORKDIR milik `api-bridge`,
    BUKAN direktori privat MetaGuard) — jadi media di-symlink ke subfolder khusus MetaGuard DI DALAM
    AGY_WORKDIR itu (`<AGY_WORKDIR>/metaguard-uploads/<job_id>/`, BUKAN ke AGY_WORKDIR-nya sendiri
    atau parent-nya — sengaja dibatasi ke subfolder ini supaya tidak menyentuh isi lain AGY_WORKDIR
    seperti `config/bm_tokens.json`), dengan job folder dihapus lagi begitu respons diterima."""

    def __init__(
        self,
        bridge_url: str = "http://127.0.0.1:4000",
        bridge_api_key: Optional[str] = None,
        shared_media_dir: str = "/root/salespintar-ai-agent/claude-ads-v2/metaguard-uploads",
        # [2026-08-25] Dinaikkan dari 300000/320.0 -- 2 kegagalan riil audit MetaGuard
        # (durationMs ~220000 & ~309000, journal bridge-audit.jsonl VPS 45) menunjukkan
        # agy MetaGuard kadang butuh > 300s. Timeout ini SENGAJA discope hanya utk
        # AgyCliInvoker (dipakai MetaGuard/Video Guard) lewat field `timeoutMs` yang
        # dikirim ke /v1/run -- caller lain ke api-bridge TIDAK terpengaruh, tetap
        # pakai AGY_TIMEOUT_MS default (300000ms) di server.js.
        run_timeout_ms: int = 600_000,  # 10 menit -- dikirim ke api-bridge sbg timeoutMs
        timeout_s: Optional[float] = None,  # timeout httpx client sendiri; default: run_timeout_ms + 30s buffer (biarkan bridge yang timeout duluan)
    ):
        self.bridge_url = bridge_url.rstrip("/")
        self.bridge_api_key = bridge_api_key or os.environ.get("BRIDGE_API_KEY", "")
        self.shared_media_dir = shared_media_dir
        self.run_timeout_ms = run_timeout_ms
        self.timeout_s = timeout_s if timeout_s is not None else (run_timeout_ms / 1000.0) + 30.0
        if not self.bridge_api_key:
            raise ValueError(
                "BRIDGE_API_KEY wajib diset -- api-bridge menolak request tanpa header X-API-Key."
            )
        os.makedirs(self.shared_media_dir, exist_ok=True)

    async def generate(self, prompt: str, media_paths: List[str], system_instruction: str) -> str:
        job_id = str(uuid.uuid4())
        job_dir = os.path.join(self.shared_media_dir, job_id)
        os.makedirs(job_dir, exist_ok=True)
        try:
            media_refs: List[str] = []
            for path in media_paths:
                dest = os.path.join(job_dir, os.path.basename(path))
                os.symlink(os.path.abspath(path), dest)
                # Path relatif terhadap AGY_WORKDIR milik api-bridge — itu yang dilihat `agy` lewat
                # --add-dir, bukan path absolut lokal MetaGuard (yang tidak berarti apa-apa buat agy).
                media_refs.append(f"metaguard-uploads/{job_id}/{os.path.basename(path)}")

            media_block = (
                "File media yang harus dianalisis (path relatif terhadap direktori kerja): "
                + ", ".join(media_refs)
                if media_refs
                else "Tidak ada file media yang dilampirkan untuk permintaan ini."
            )
            full_prompt = (
                f"{system_instruction}\n\n{media_block}\n\n{prompt}\n\n"
                f"WAJIB: akhiri jawabanmu dengan baris literal `{JSON_DELIMITER}` diikuti HANYA JSON "
                f"valid (tanpa markdown code fence, tanpa teks tambahan setelahnya)."
            )

            async with httpx.AsyncClient(timeout=self.timeout_s) as client:
                resp = await client.post(
                    f"{self.bridge_url}/v1/run",
                    headers={"X-API-Key": self.bridge_api_key},
                    json={
                        "prompt": full_prompt,
                        "conversationId": f"metaguard-{job_id}",
                        "timeoutMs": self.run_timeout_ms,
                        # [2026-08-25] Kolam antrean sendiri (permintaan Bossfren) -- supaya audit
                        # MetaGuard/Video Guard TIDAK lagi berbagi antrean FIFO dgn ai-ads-health/
                        # ai-ads-copilot di api-bridge. Lihat komentar "Multi-pool concurrency" di
                        # server.js untuk detail lengkap.
                        "pool": "video-guard",
                    },
                )
            if resp.status_code != 200:
                raise RuntimeError(
                    f"api-bridge /v1/run gagal: HTTP {resp.status_code} — {resp.text[:500]}"
                )
            return resp.text  # /v1/run stream teks polos (chunked) -- kontrak sama dengan CLI langsung
        finally:
            # Bersihkan symlink job ini saja (video asli MetaGuard tidak tersentuh/terhapus).
            shutil.rmtree(job_dir, ignore_errors=True)


class GeminiSdkInvoker(LlmInvoker):
    """Fallback invoker — kode asli pra-v1.3.0, direct call ke `google.genai` SDK dengan
    `response_schema` (structured output, dijamin JSON valid oleh SDK sendiri). Dipanggil otomatis
    kalau `AgyCliInvoker` gagal (HTTP non-200, timeout, atau `api-bridge` tidak reachable). Juga bisa
    dipasang sebagai primary secara langsung (lewat parameter `invoker` di
    `MetaAdGuardEngine.__init__`) kalau suatu saat agy tidak lagi jadi pilihan — misalnya kuota
    Google AI Pro habis atau ToS-nya untuk automated production use berubah (item terbuka, verifikasi
    ini tanggung jawab Bossfren sendiri)."""

    def __init__(self, api_key: Optional[str] = None):
        self.api_key = api_key or os.environ.get("GEMINI_API_KEY")
        if not self.api_key:
            raise ValueError(
                "GEMINI_API_KEY environment variable is required for GeminiSdkInvoker fallback."
            )
        self.client = genai.Client(api_key=self.api_key)

    async def generate(self, prompt: str, media_paths: List[str], system_instruction: str) -> str:
        contents: List[Any] = []
        uploaded_files: List[Any] = []
        try:
            for path in media_paths:
                # fix K6 (dipertahankan): cek state File API eksplisit, jangan lolos FAILED diam-diam.
                f = self.client.files.upload(file=path)
                uploaded_files.append(f)
                while f.state.name == "PROCESSING":
                    time.sleep(3)
                    f = self.client.files.get(name=f.name)
                if f.state.name == "FAILED":
                    raise RuntimeError(f"Gemini File API gagal memproses {path} (state=FAILED).")
                contents.append(f)
            contents.append(prompt)
            response = _call_gemini_with_retry(
                self.client,
                model="gemini-2.5-flash",
                contents=contents,
                config=types.GenerateContentConfig(
                    system_instruction=system_instruction,
                    response_mime_type="application/json",
                    response_schema=ComplianceRawAssessment,
                    temperature=0.1,
                    safety_settings=SAFETY_SETTINGS,
                ),
            )
            return response.text
        finally:
            # Prevent Google Gemini File API storage leak
            for f in uploaded_files:
                try:
                    self.client.files.delete(name=f.name)
                except Exception:
                    pass


def parse_raw_assessment(raw_text: str, ad_title: str) -> ComplianceRawAssessment:
    """Kontrak parsing tunggal untuk kedua invoker, dipanggil oleh `MetaAdGuardEngine` setelah
    `_generate_with_fallback()` sukses. `AgyCliInvoker` mengembalikan teks bebas + delimiter + JSON;
    `GeminiSdkInvoker` mengembalikan JSON murni (response_schema sudah menjaminnya) — delimiter yang
    tidak ditemukan berarti "anggap seluruh teks sebagai JSON", jadi satu fungsi ini menangani kedua
    kasus tanpa cabang if/else terpisah di caller. Kegagalan parse APA PUN — dari invoker mana pun —
    jatuh ke MANUAL_REVIEW, tidak pernah crash request atau mengembalikan hasil APPROVED yang kosong
    tanpa sengaja (fix K6, prinsip dipertahankan penuh dari v1.2.0)."""
    try:
        text = raw_text
        if JSON_DELIMITER in raw_text:
            text = raw_text.split(JSON_DELIMITER, 1)[1]
        text = text.strip()
        # agy kadang membungkus JSON dalam ```json ... ``` walau sudah diminta tidak — strip defensif.
        text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text.strip())
        return ComplianceRawAssessment.model_validate_json(text)
    except (json.JSONDecodeError, ValidationError, Exception) as e:
        return ComplianceRawAssessment(
            ad_title=ad_title,
            channel_scores=ChannelScores(),
            violations=[],
            clarification_questions=[],
            remediation_assets=RemediationAssets(),
            executive_summary=f"Analisis gagal diparse ({e}); wajib manual review.",
        )


# ==========================================
# 8. Core Engine Implementation
# ==========================================

class MetaAdGuardEngine:
    def __init__(
        self,
        api_key: Optional[str] = None,
        invoker: Optional[LlmInvoker] = None,
        bridge_url: str = "http://127.0.0.1:4000",
        bridge_api_key: Optional[str] = None,
    ):
        # fix v1.4.0: primary invocation lewat agy CLI TIDAK LAGI subprocess langsung -- sekarang HTTP
        # ke api-bridge's /v1/run (lihat AgyCliInvoker di atas untuk alasan lengkap & keputusan
        # Bossfren 2026-08-25). Gemini SDK tetap fallback otomatis kalau GEMINI_API_KEY tersedia.
        # `invoker` bisa di-override langsung (unit test, atau kalau urutan primary/fallback perlu
        # dibalik nanti).
        self.api_key = api_key or os.environ.get("GEMINI_API_KEY")
        self._sdk_fallback = GeminiSdkInvoker(api_key=self.api_key) if self.api_key else None
        self.invoker = invoker or AgyCliInvoker(bridge_url=bridge_url, bridge_api_key=bridge_api_key)
        self.landing_page_auditor = LandingPageAuditor()

    async def _generate_with_fallback(
        self, prompt: str, media_paths: List[str], gemini_api_key_override: Optional[str] = None,
    ) -> str:
        """Coba primary invoker (agy CLI lewat api-bridge) dulu; kalau gagal (HTTP non-200, timeout,
        api-bridge tidak reachable) DAN fallback SDK tersedia, otomatis retry lewat GeminiSdkInvoker.
        Kalau fallback juga tidak tersedia atau juga gagal, error dilempar ke atas — caller
        (`execute_audit`/`resolve_clarification`) tetap membungkusnya jadi laporan MANUAL_REVIEW
        lewat `parse_raw_assessment()`/fallback manual, bukan crash permintaan.

        fix v1.4.1 (keputusan Bossfren 2026-08-25 — GEMINI_API_KEY per-business): `gemini_api_key_override`
        dipakai APA ADANYA kalau diisi (dari `Business.settings` lewat Node proxy per-request) --
        instance `GeminiSdkInvoker` baru dibuat SEKALI PAKAI untuk call ini, TIDAK memakai/menimpa
        `self._sdk_fallback` (yang tetap env-level generik, dipakai kalau override tidak diisi). Ini
        supaya request business A tidak pernah kebocor pakai key business B lewat state instance yang
        di-share antar-request pada `MetaAdGuardEngine` (satu instance global di `main.py`)."""
        fallback = GeminiSdkInvoker(api_key=gemini_api_key_override) if gemini_api_key_override else self._sdk_fallback
        try:
            return await self.invoker.generate(prompt, media_paths, SYSTEM_PROMPT)
        except Exception as primary_err:
            if fallback is None or isinstance(self.invoker, GeminiSdkInvoker):
                raise
            try:
                return await fallback.generate(prompt, media_paths, SYSTEM_PROMPT)
            except Exception as fallback_err:
                raise RuntimeError(
                    f"agy CLI (via api-bridge) gagal ({primary_err}) DAN Gemini SDK fallback juga "
                    f"gagal ({fallback_err})."
                ) from fallback_err

    async def execute_audit(
        self,
        audit_id: str,
        ad_title: str,
        video_path: Optional[str] = None,
        thumbnail_path: Optional[str] = None,
        primary_text: Optional[str] = None,
        headline: Optional[str] = None,
        landing_page_url: Optional[str] = None,
        presentation_layers_applied: Optional[List[str]] = None,
        gemini_api_key_override: Optional[str] = None,
    ) -> ComplianceAuditReport:
        if video_path:
            validate_video_asset(video_path)  # fix K9 — fail fast before any upload/invocation

        media_paths = [p for p in (video_path, thumbnail_path) if p and Path(p).exists()]

        landing_page_text = "Tidak dilampirkan"
        if landing_page_url:
            landing_page_text = await self.landing_page_auditor.extract_page_text(landing_page_url)

        prompt = f"""
        PERFORM FULL ADVERSARIAL COMPLIANCE AUDIT FOR:
        Ad Title: {ad_title}
        Primary Text: {primary_text or 'N/A'}
        Headline: {headline or 'N/A'}
        Landing Page URL: {landing_page_url or 'N/A'}
        Landing Page Extracted Text (via headless scrape): {landing_page_text}

        Audit all attached multimodal files and the extracted landing page text above.
        Leave channel_scores fields null for any channel with no corresponding asset attached.
        """

        # fix v1.3.0/v1.4.0: pemanggilan model lewat _generate_with_fallback() (agy CLI via
        # api-bridge primary, Gemini SDK fallback — Section 7) alih-alih langsung
        # _call_gemini_with_retry(). Upload/cleanup File API kini murni tanggung jawab internal
        # GeminiSdkInvoker; AgyCliInvoker tidak memakai File API sama sekali (media direferensikan
        # lewat symlink ke AGY_WORKDIR milik api-bridge). Parsing + fallback-ke-MANUAL_REVIEW
        # disatukan lewat parse_raw_assessment() supaya perilakunya identik apa pun jalur yang sukses.
        try:
            raw_text = await self._generate_with_fallback(prompt, media_paths, gemini_api_key_override)
            raw = parse_raw_assessment(raw_text, ad_title)
            _attach_evidence_frames(raw, audit_id, video_path, thumbnail_path)  # fix v1.6.0
        except Exception as e:
            # fix K6 (dipertahankan): kegagalan invoker APA PUN — bukan cuma parse — harus jatuh ke
            # laporan MANUAL_REVIEW, tidak pernah crash request atau diam-diam mengembalikan APPROVED.
            raw = ComplianceRawAssessment(
                ad_title=ad_title,
                channel_scores=ChannelScores(),
                violations=[],
                clarification_questions=[],
                remediation_assets=RemediationAssets(),
                executive_summary=f"Kedua invoker (agy CLI & Gemini SDK) gagal ({e}); wajib manual review.",
            )

        score, verdict, penalty, used = compute_final_assessment(raw)
        return ComplianceAuditReport(
            audit_id=audit_id,
            raw_assessment=raw,
            overall_compliance_score=score,
            verdict=verdict,
            critical_penalty_applied=penalty,
            channels_used=used,
            presentation_layers_applied=presentation_layers_applied or [],
        )

    async def resolve_clarification(
        self,
        report: ComplianceAuditReport,
        violation_id: str,
        user_context: str,
        video_path: Optional[str] = None,
        thumbnail_path: Optional[str] = None,
        gemini_api_key_override: Optional[str] = None,
    ) -> ComplianceAuditReport:
        """
        fix K7: re-uploads/re-attaches the original video/thumbnail so the model can check the
        advertiser's claim against actual pixels/audio — v1.0.0 sent only a text claim plus a JSON
        summary of the earlier analysis, with no way to verify "this is dry coffee wood" was true
        rather than just plausible-sounding. This principle is unchanged in v1.4.0 — only the
        invocation mechanism changed (agy CLI via api-bridge primary / Gemini SDK fallback, Section 7).
        """
        media_paths = [p for p in (video_path, thumbnail_path) if p and Path(p).exists()]

        target = next(
            (v for v in report.raw_assessment.violations if v.id == violation_id), None
        )
        prompt = f"""
        Re-evaluate ONLY violation_id={violation_id} of the attached media, given this advertiser
        clarification: "{user_context}"
        Original flagged element: {target.detected_element if target else 'N/A'}
        Original policy reference: {target.policy_reference if target else 'N/A'}

        Check the claim against what is actually visible/audible in the re-attached media under
        the Meta Agricultural Tools Exemption Policy (Section 4.12). Return an updated
        ComplianceRawAssessment reflecting only this re-check — do not re-score channels that were
        not part of this clarification.
        """

        try:
            raw_text = await self._generate_with_fallback(prompt, media_paths, gemini_api_key_override)
            raw = parse_raw_assessment(raw_text, report.raw_assessment.ad_title)
            _attach_evidence_frames(raw, report.audit_id, video_path, thumbnail_path)  # fix v1.6.0
        except Exception as e:
            raw = ComplianceRawAssessment(
                ad_title=report.raw_assessment.ad_title,
                channel_scores=ChannelScores(),
                violations=[],
                clarification_questions=[],
                remediation_assets=RemediationAssets(),
                executive_summary=(
                    f"Kedua invoker (agy CLI & Gemini SDK) gagal saat klarifikasi ({e}); "
                    f"wajib manual review."
                ),
            )

        score, verdict, penalty, used = compute_final_assessment(raw)  # fix K2: recomputed, not LLM-reported
        return ComplianceAuditReport(
            audit_id=report.audit_id,
            raw_assessment=raw,
            overall_compliance_score=score,
            verdict=verdict,
            critical_penalty_applied=penalty,
            channels_used=used,
            presentation_layers_applied=report.presentation_layers_applied,
        )
