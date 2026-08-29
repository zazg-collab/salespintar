"""
metaguard_service/copywriting.py

Fase 2 blueprint (20260826-blueprint-videoguard-media-analysis-copywriting.md Bagian 5): fitur
"Copywriting Ads" -- Check Ads (audit copy iklan yang sudah ada) & Generate Ads (bikin varian baru).

Sengaja modul TERPISAH dari engine.py (bukan ditambahkan ke MetaAdGuardEngine) karena scope-nya murni
teks (headline+primary_text, atau keyword/produk) -- TIDAK butuh pipeline video/gambar (cv2, upload
file, agy CLI lewat api-bridge). Modul ini punya jalur LLM sendiri yang MINIMAL (langsung SDK provider
+ response_schema/response_format), bukan lewat AgyCliInvoker/GeminiSdkInvoker di engine.py -- kedua
invoker itu hardcode response_schema=ComplianceRawAssessment di titik pemanggilan (lihat
GeminiSdkInvoker.generate()), jadi tidak generik utk schema lain. Refactor invoker itu jadi generik
dianggap terlalu berisiko utk mengubah pipeline audit video yang sudah production-critical demi fitur
baru yang terpisah scope-nya -- lebih aman modul baru reuse SAFETY_SETTINGS & _call_gemini_with_retry
dari engine.py (biar konsisten retry/safety policy) tanpa menyentuh kelas invoker yang sudah ada.

[2026-08-26, Fase provider-agnostic] Sebelumnya modul ini HANYA lewat Google AI Studio (Gemini). Per
instruksi eksplisit Bossfren ("the provider-agnostic LLM abstraction (OpenAI/OpenRouter) for
Copywriting Ads specifically"), sekarang mendukung 3 provider: `google` (default, TIDAK berubah
perilakunya -- tetap genai.Client + response_schema Pydantic asli, paling reliable utk structured
output), `openai` (SDK resmi `openai`, Structured Outputs `response_format=json_schema` strict), dan
`openrouter` (SDK `openai` yang sama dgn base_url override -- OpenRouter OpenAI-compatible, TAPI tidak
semua model upstream di baliknya dukung json_schema strict mode, jadi ada fallback ke `json_object` +
instruksi schema di prompt kalau strict ditolak, tetap divalidasi Pydantic sesudahnya spt biasa).
Scope SENGAJA cuma Copywriting Ads -- pipeline audit video/image (engine.py, GeminiSdkInvoker/
AgyCliInvoker) TIDAK disentuh sama sekali, tetap Google-only spt sebelumnya.

Kalibrasi hukum Indonesia di KNOWLEDGE_INDONESIA_LAW di bawah adalah DRAF AWAL (per catatan eksplisit
blueprint Bagian 5.3: "jangan buru-buru dianggap final tanpa validasi ... idealnya dicek ulang sama
orang yang paham regulasi") -- BUKAN nasihat hukum, dan output fitur ini WAJIB selalu menyertakan
disclaimer non-legal-advice (lihat DISCLAIMER, dipaksa dari Python di kedua fungsi run_copywriting_*
di bawah -- TIDAK dipercaya dari output model, sama seperti skor akhir audit video yang selalu
dihitung Python murni di engine.py, bukan diklaim langsung dari model).

MVP LIMITATION (dicatat eksplisit, pola sama dgn AUDIT_STATUS in-memory dict di main.py): "Generate
Ads" TIDAK memakai live search grounding (Gemini google_search tool) di v1 -- kombinasi tool
google_search + response_schema terstruktur tidak selalu didukung bersamaan oleh Gemini API di semua
model/versi, dan menambah 1 pemanggilan API + kompleksitas two-pass di iterasi pertama ini dianggap
tidak sepadan dulu. Grounding SEKARANG hanya lewat 2 jalur: (a) scrape URL kompetitor kalau diisi
(reuse LandingPageAuditor yang sudah ada dari engine.py, dipakai jalur landing_page_url audit video
juga), (b) pengetahuan model sendiri kalau tidak ada URL/scrape gagal. Kalau nanti mau ditambah live
search sungguhan, lihat blueprint Bagian 5.2 (lib/serp.ts -- rencana semula, belum diimplementasikan).
"""

from __future__ import annotations

import json
import os
from typing import List, Literal, Optional

from pydantic import BaseModel, Field
from tenacity import retry, stop_after_attempt, wait_exponential, retry_if_exception

from engine import (
    SAFETY_SETTINGS,
    LandingPageAuditor,
    _call_gemini_with_retry,
    _is_transient_error,
    genai,
    types,
)

# ==========================================
# Knowledge modules (blueprint Bagian 5.2, pola "KnowledgeModule" -- port KONSEPnya dari
# serp-to-spend punya fayerman-source, bukan kode TS-nya persis, krn di sini murni teks statis yang
# disuntik ke prompt, bukan struktur data yang dipanggil terpisah).
# ==========================================
# Ditulis manual dari riset kebijakan resmi Meta/TikTok + UU/Peraturan Indonesia (riset 2026-08-26,
# lihat ledger anti-drift entry Batch D utk daftar sumber lengkap) -- BUKAN dari output AI, supaya
# konsisten & bisa diaudit sumbernya. Update manual kalau kebijakan platform/hukum berubah -- pola
# yang sama dengan CHANNEL_METHODOLOGY statis di frontend page.tsx.

KNOWLEDGE_META = """
=== Meta (Facebook/Instagram) Advertising Standards -- kategori paling relevan buat UMKM/e-commerce ===
- Unacceptable Business Practices: dilarang klaim harga palsu, diskon/urgency palsu ("hari ini saja"
  tanpa itikad baik, countdown timer palsu), dan klaim hasil "dijamin" (guaranteed income, guaranteed
  turun berat badan, skema cepat kaya).
- Health & Wellness: iklan kosmetik/penurunan berat badan/kebugaran dilarang menyiratkan persepsi diri
  negatif ("kenapa gak ada yang chat kamu?") atau body image tidak realistis; foto before/after yang
  menyiratkan transformasi tidak realistis sering ditolak; kategori ini sering butuh targeting 18+.
- Personal Attributes: dilarang menyatakan/menyiratkan kondisi kesehatan, status finansial, ras, agama,
  orientasi seksual audiens lewat copy/gambar ("Diabetes? Coba ini...").
- Financial & Insurance Products: pembatasan pengumpulan data finansial di ad unit + wajib disclosure
  akurat soal syarat produk; produk tertentu (pinjaman, kripto, investasi) kena review tambahan.
- Low Quality/Disruptive Content: dilarang konten shocking/sensational/clickbait yang sengaja memancing
  reaksi negatif kuat.
- Relevance/Landing Page: harga, promo, klaim produk di iklan HARUS sama persis dengan landing page --
  ketidaksesuaian ini sumber pelanggaran "misleading pricing"/"fake free offer" paling umum.
"""

KNOWLEDGE_TIKTOK = """
=== TikTok Ads -- kategori paling relevan buat UMKM/e-commerce (dari ads.tiktok.com/help resmi) ===
- Misleading and False Content: dilarang menjanjikan/melebih-lebihkan hasil produk -- contoh eksplisit
  dari TikTok sendiri: "Kaki langsing seketika", "Dapat uang dalam 10 detik". Klaim superlatif/absolut
  terkait waktu, wilayah, atau perbandingan brand juga dibatasi.
- Before/after comparison dibatasi khusus kalau bisa bikin penonton salah paham soal hasil produk
  (contoh TikTok: kerutan hilang seketika setelah pakai krim).
- Konsistensi iklan-ke-landing-page: promo/harga/diskon di iklan wajib sama dengan halaman tujuan.
- Healthcare & Pharmaceuticals: produk (termasuk suplemen/wellness, bukan cuma farmasi) dilarang klaim
  "mengobati/menyembuhkan/mencegah" kondisi medis/penyakit tertentu -- klaim perubahan permanen
  (menyembuhkan jerawat, menghilangkan kerutan, mengatasi rambut rontok) jadi contoh spesifik yang
  dilarang. Klaim medis butuh lisensi/sertifikasi resmi.
- Weight Management & Body Image: kebijakan terpisah & lebih ketat soal klaim penurunan berat badan
  dan framing body image negatif.
- Financial Services: kategori diawasi ketat, perlakukan sbg butuh scrutiny/sertifikasi ekstra, jangan
  asumsikan otomatis boleh.
"""

KNOWLEDGE_INDONESIA_LAW = """
=== Dasar hukum Indonesia -- DRAF AWAL, BUKAN nasihat hukum final (lihat disclaimer wajib) ===
- UU No. 8 Tahun 1999 tentang Perlindungan Konsumen:
  - Pasal 9: dilarang menawarkan/mempromosikan/mengiklankan barang/jasa secara TIDAK BENAR dan/atau
    SEOLAH-OLAH punya kualitas/manfaat/sponsor/kondisi yang sebenarnya tidak dimiliki -- termasuk kata
    superlatif berlebihan ("aman", "tidak berbahaya") tanpa informasi pendukung lengkap.
  - Pasal 10: dilarang pernyataan salah/menyesatkan soal harga/tarif, kegunaan barang/jasa, kondisi
    dan JAMINAN/garansi, serta bahaya penggunaan -- pasal paling relevan utk klaim "hasil dijamin" atau
    representasi harga yang salah.
  - Pasal 17: khusus pembuat iklan -- dilarang mengelabui konsumen soal kualitas/kuantitas/bahan/
    kegunaan/harga, atau memuat informasi keliru/salah/tidak tepat tanpa mengungkap risiko pemakaian.
- BPOM (kosmetik/obat tradisional/suplemen/pangan): dilarang klaim "menyembuhkan penyakit X" atau
  seolah-olah produk adalah obat -- berlaku utk kosmetik, suplemen, jamu, dan pangan olahan. Klaim
  promosi wajib objektif, lengkap, tidak menyesatkan, dan SESUAI dengan yang terdaftar di notifikasi/
  registrasi BPOM produk tsb (klaim di luar dokumen registrasi = pelanggaran walau klaimnya benar).
- OJK (produk keuangan/investasi/pinjaman): promosi wajib jelas, akurat, jujur, tidak menyesatkan.
  Red flag klasik yang dipakai OJK sendiri (program "Waspada Investasi"): menjanjikan keuntungan
  besar/pasti dalam waktu singkat, return "di atas kewajaran" tanpa disclosure risiko, dan tidak
  mencantumkan status berizin/diawasi OJK.
"""

KNOWLEDGE_PUFFERY_CALIBRATION = """
=== Kalibrasi puffery vs klaim butuh bukti (murni linguistik, bukan hukum) ===
Bahasa marketing SUBJEKTIF ("terbaik", "nomor 1", "kualitas premium", "top choice") BUKAN pelanggaran
-- ini "puffery", wajar dalam iklan dan tidak dianggap klaim faktual yang butuh pembuktian. SEBALIKNYA,
klaim TERUKUR/SPESIFIK ("turun 10kg dalam 2 minggu", "bersertifikat BPOM", "garansi uang kembali
100%", "cocok utk semua jenis kulit", "hasil terlihat dalam 3 hari") HARUS ditandai butuh bukti/
substantiasi -- kalau tidak ada bukti yang disebutkan, tandai sbg risiko, BUKAN otomatis dianggap
salah (mungkin saja benar tapi tidak terverifikasi dari teks copy saja).
"""

DISCLAIMER = (
    "Hasil ini dibuat otomatis oleh AI berdasarkan kebijakan publik platform (Meta/TikTok) dan draf "
    "awal pemetaan hukum Indonesia (UU Perlindungan Konsumen, BPOM, OJK) -- BUKAN nasihat hukum. "
    "Untuk keputusan berisiko tinggi (klaim kesehatan/keuangan, sengketa hukum), konsultasikan dengan "
    "konsultan/penasihat hukum yang kompeten sebelum publikasi."
)

# ==========================================
# Provider abstraction (Fase 2026-08-26) -- lihat docstring modul bagian "provider-agnostic".
# ==========================================

LlmProvider = Literal["google", "openai", "openrouter"]

_KNOWN_PROVIDERS = ("google", "openai", "openrouter")

# Default model per provider -- dipakai kalau Business.settings.copywritingLlmModel kosong. Provider
# `google` TIDAK berubah dari sebelumnya (gemini-2.5-flash). `openai`/`openrouter` sengaja pilih model
# cepat+murah sbg default MVP, gampang diubah lewat setting per-business tanpa redeploy kalau ternyata
# kurang pas -- bukan keputusan final yang dikonfirmasi Bossfren, cuma starting point yang wajar.
DEFAULT_MODELS: dict = {
    "google": "gemini-2.5-flash",
    "openai": "gpt-4o-mini",
    "openrouter": "openai/gpt-4o-mini",
}

OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"


def _normalize_provider(provider: Optional[str]) -> LlmProvider:
    p = (provider or "google").strip().lower()
    if p not in _KNOWN_PROVIDERS:
        raise ValueError(
            f"Provider LLM '{provider}' tidak dikenal -- pilihan yang didukung: {', '.join(_KNOWN_PROVIDERS)}."
        )
    return p  # type: ignore[return-value]


def _get_openai_client(provider: LlmProvider, api_key: str):
    # Import lazy -- supaya deployment yang cuma pakai provider `google` (default, tidak berubah dari
    # sebelumnya) tidak WAJIB punya paket `openai` terinstall kalau entah kenapa gagal di-pip-install.
    try:
        from openai import OpenAI
    except ImportError as e:
        raise ValueError(
            "Paket Python 'openai' belum terinstall di metaguard_service -- wajib utk provider "
            f"'{provider}'. Jalankan `pip install openai` di venv service ini (lihat requirements.txt)."
        ) from e
    kwargs: dict = {"api_key": api_key}
    if provider == "openrouter":
        kwargs["base_url"] = OPENROUTER_BASE_URL
    return OpenAI(**kwargs)


@retry(
    stop=stop_after_attempt(3),
    wait=wait_exponential(multiplier=2, min=2, max=20),
    retry=retry_if_exception(_is_transient_error),
    reraise=True,
)
def _call_openai_with_retry(client, **kwargs):
    """Retry generik utk provider OpenAI-compatible (openai & openrouter) -- pakai heuristik transient
    error yang SAMA PERSIS dgn _call_gemini_with_retry di engine.py (_is_transient_error, murni cek
    substring pesan exception: "429"/"resource_exhausted"/"503"/"unavailable"), supaya perilaku retry
    konsisten lintas provider tanpa perlu import kelas exception spesifik tiap SDK."""
    return client.chat.completions.create(**kwargs)


def _generate_structured(
    provider: LlmProvider,
    api_key: Optional[str],
    model_override: Optional[str],
    system_instruction: str,
    prompt: str,
    schema_cls: type,
    temperature: float,
):
    """Satu titik pemanggilan LLM utk fitur Copywriting Ads, provider-agnostic. Balikin instance
    `schema_cls` yang SUDAH divalidasi Pydantic -- caller (run_copywriting_check/generate) tidak perlu
    tahu-menahu provider mana yang dipakai di baliknya."""
    model = model_override or DEFAULT_MODELS[provider]

    if provider == "google":
        # Jalur ASLI, TIDAK berubah dari sebelum fitur multi-provider ini ada.
        client = _client(api_key)
        response = _call_gemini_with_retry(
            client,
            model=model,
            contents=[prompt],
            config=types.GenerateContentConfig(
                system_instruction=system_instruction,
                response_mime_type="application/json",
                response_schema=schema_cls,
                temperature=temperature,
                safety_settings=SAFETY_SETTINGS,
            ),
        )
        return schema_cls.model_validate_json(response.text)

    # provider in ("openai", "openrouter") -- OpenAI-compatible chat.completions API. Beda dari Google:
    # TIDAK ada fallback env generik (GEMINI_API_KEY) -- Bossfren wajib isi key sendiri di setting kalau
    # mau pakai provider ini, tidak ada key bersama/shared punya server MetaGuard utk OpenAI/OpenRouter.
    if not api_key:
        raise ValueError(
            f"API key wajib diisi utk provider '{provider}' (tidak ada fallback key generik spt Google)."
        )
    client = _get_openai_client(provider, api_key)
    schema_name = schema_cls.__name__
    json_schema = schema_cls.model_json_schema()
    messages = [
        {"role": "system", "content": system_instruction},
        {"role": "user", "content": prompt},
    ]
    try:
        completion = _call_openai_with_retry(
            client,
            model=model,
            messages=messages,
            temperature=temperature,
            response_format={
                "type": "json_schema",
                "json_schema": {"name": schema_name, "schema": json_schema, "strict": True},
            },
        )
    except Exception as e:
        # OpenRouter meneruskan response_format ke model upstream -- TIDAK semua model di baliknya
        # dukung json_schema strict mode (beda dgn OpenAI resmi yg konsisten dukung sejak
        # gpt-4o-2024-08-06). Fallback: kalau request ditolak, coba ulang dgn json_object longgar +
        # instruksi schema manual di prompt system -- hasilnya tetap divalidasi Pydantic sesudahnya,
        # SAMA PERSIS prinsipnya spt disclaimer/skor yg tidak pernah dipercaya mentah2 dari model.
        err_msg = str(e).lower()
        looks_like_schema_rejection = (
            "response_format" in err_msg
            or "json_schema" in err_msg
            or "not support" in err_msg
            or "400" in err_msg
        )
        if not looks_like_schema_rejection:
            raise
        fallback_system = (
            system_instruction
            + "\n\nWAJIB balas HANYA dengan JSON valid yang PERSIS mengikuti JSON Schema berikut "
            "(tanpa markdown/code fence, tanpa teks tambahan di luar JSON):\n"
            + json.dumps(json_schema)
        )
        fallback_messages = [
            {"role": "system", "content": fallback_system},
            {"role": "user", "content": prompt},
        ]
        completion = _call_openai_with_retry(
            client,
            model=model,
            messages=fallback_messages,
            temperature=temperature,
            response_format={"type": "json_object"},
        )
    content = completion.choices[0].message.content
    return schema_cls.model_validate_json(content)


# ==========================================
# Pydantic schemas
# ==========================================

Platform = Literal["Meta", "TikTok", "Umum"]
RiskLevel = Literal["LOW", "MEDIUM", "HIGH"]


class CopyFlag(BaseModel):
    quoted_phrase: str
    # ^ HARUS substring verbatim dari copy asli, bukan parafrase -- diinstruksikan eksplisit di
    #   system_instruction run_copywriting_check(), sama prinsipnya dgn evidence_text di engine.py.
    platform: Platform
    severity: RiskLevel
    reason: str
    reference: str
    # ^ mis. "Meta Unacceptable Business Practices" atau "UU 8/1999 Pasal 10" -- BUKAN nomor pasal
    #   yang dikarang bebas oleh model, model diarahkan ke daftar konkret di KNOWLEDGE_INDONESIA_LAW.
    safe_rewrite: str


class CopywritingCheckResult(BaseModel):
    overall_verdict: Literal["AMAN", "PERLU_REVISI", "BERISIKO_TINGGI"]
    summary: str
    flags: List[CopyFlag] = Field(default_factory=list)
    safe_rewrite_headline: Optional[str] = None
    safe_rewrite_primary_text: Optional[str] = None
    disclaimer: str = DISCLAIMER


class AdCopyVariant(BaseModel):
    angle: str
    platform: Literal["Meta", "TikTok"]
    headline: str
    primary_text: str
    cta_suggestion: str
    audience_idea: str
    disapproval_risk: RiskLevel
    risk_note: Optional[str] = None


class CopywritingGenerateResult(BaseModel):
    product_or_keyword: str
    variants: List[AdCopyVariant] = Field(default_factory=list)
    grounding_note: str
    disclaimer: str = DISCLAIMER


def _client(api_key_override: Optional[str]) -> "genai.Client":
    # fix v1.4.1 pattern (per-business GEMINI_API_KEY, sama dgn engine.py): override dipakai APA
    # ADANYA kalau diisi, fallback ke env generik kalau tidak. Cuma dipakai jalur provider `google`.
    api_key = api_key_override or os.environ.get("GEMINI_API_KEY")
    if not api_key:
        raise ValueError(
            "GEMINI_API_KEY (env atau override per-business) wajib ada utk provider 'google'."
        )
    return genai.Client(api_key=api_key)


async def run_copywriting_check(
    headline: Optional[str],
    primary_text: Optional[str],
    gemini_api_key_override: Optional[str] = None,
    provider: Optional[str] = "google",
    model_override: Optional[str] = None,
) -> CopywritingCheckResult:
    """Tab 'Check Ads' -- audit copy iklan yang SUDAH ADA (headline/primary_text), bukan bikin baru.
    Satu panggilan LLM synchronous (bukan background job spt /v1/audit) -- teks doang, jauh lebih
    cepat dari audit video, blueprint Bagian 5.4 eksplisit bilang "skip semua pipeline video/media".
    `provider`/`model_override` -- lihat docstring modul bagian "provider-agnostic" (2026-08-26)."""
    if not (headline and headline.strip()) and not (primary_text and primary_text.strip()):
        raise ValueError("Minimal salah satu dari headline/primary_text wajib diisi.")

    provider_norm = _normalize_provider(provider)

    system_instruction = f"""
    Kamu adalah auditor compliance iklan utk bisnis Indonesia yang mengiklankan di Meta (Facebook/
    Instagram) dan TikTok. Tugasmu: baca copy iklan yang diberikan, tandai frasa yang berisiko
    ditolak platform ATAU berisiko secara hukum Indonesia, dan berikan rewrite yang aman.

    {KNOWLEDGE_META}
    {KNOWLEDGE_TIKTOK}
    {KNOWLEDGE_INDONESIA_LAW}
    {KNOWLEDGE_PUFFERY_CALIBRATION}

    ATURAN WAJIB:
    - `quoted_phrase` HARUS substring PERSIS (verbatim) dari copy yang diberikan -- bukan parafrase.
    - Puffery (lihat kalibrasi di atas) TIDAK ditandai sbg flag kecuali digabung dgn klaim terukur.
    - `overall_verdict` = BERISIKO_TINGGI hanya kalau ada flag severity HIGH; PERLU_REVISI kalau ada
      flag MEDIUM tanpa HIGH; AMAN kalau tidak ada flag sama sekali atau cuma LOW.
    - `safe_rewrite_headline`/`safe_rewrite_primary_text` diisi HANYA kalau field yang bersangkutan
      ada isinya di input DAN ada flag yang mempengaruhinya -- kalau tidak ada masalah, boleh null.
    - `disclaimer` isi bebas (akan ditimpa Python setelah ini, jangan terlalu dipikirkan).
    """

    prompt = f"""
    Headline: {headline or '(tidak diisi)'}
    Primary Text: {primary_text or '(tidak diisi)'}

    Audit copy di atas sesuai instruksi system.
    """

    result = _generate_structured(
        provider=provider_norm,
        api_key=gemini_api_key_override,
        model_override=model_override,
        system_instruction=system_instruction,
        prompt=prompt,
        schema_cls=CopywritingCheckResult,
        temperature=0.1,
    )
    # Invariant: disclaimer TIDAK PERNAH dipercaya dari output model, selalu dipaksa dari konstanta
    # Python -- sama prinsipnya dgn skor akhir audit video yg selalu dihitung Python murni.
    result.disclaimer = DISCLAIMER
    return result


async def run_copywriting_generate(
    product_or_keyword: str,
    competitor_url: Optional[str] = None,
    extra_context: Optional[str] = None,
    gemini_api_key_override: Optional[str] = None,
    provider: Optional[str] = "google",
    model_override: Optional[str] = None,
) -> CopywritingGenerateResult:
    """Tab 'Generate Ads' -- bikin 3 angle x platform (Meta/TikTok) dari keyword/produk (+ opsional
    URL kompetitor buat konteks pasar, DI-SCRAPE bukan diminta model fetch sendiri -- reuse
    LandingPageAuditor yang sama dgn jalur landing_page_url audit video, konsisten satu mekanisme
    scrape saja di seluruh service). Lihat MVP LIMITATION di docstring modul soal search grounding.
    `provider`/`model_override` -- lihat docstring modul bagian "provider-agnostic" (2026-08-26)."""
    if not product_or_keyword or not product_or_keyword.strip():
        raise ValueError("product_or_keyword wajib diisi.")

    provider_norm = _normalize_provider(provider)

    grounding_note = (
        "Tidak ada grounding eksternal -- murni pengetahuan model, verifikasi manual disarankan."
    )
    competitor_text = ""
    if competitor_url:
        try:
            scraped = await LandingPageAuditor().extract_page_text(competitor_url)
            if not scraped.startswith("[SCRAPE_FAILED]"):
                competitor_text = scraped
                grounding_note = f"Berdasarkan scrape halaman kompetitor: {competitor_url}"
            else:
                grounding_note = (
                    f"Scrape URL kompetitor gagal ({scraped}) -- lanjut tanpa grounding eksternal."
                )
        except Exception as e:
            grounding_note = f"Scrape URL kompetitor gagal ({e}) -- lanjut tanpa grounding eksternal."

    system_instruction = f"""
    Kamu adalah copywriter iklan utk bisnis Indonesia yang beriklan di Meta (Facebook/Instagram) dan
    TikTok. Tugasmu: bikin 3 varian angle berbeda (mis. testimoni sosial, urgensi/diskon, edukasi
    manfaat) x platform (Meta & TikTok) utk produk/keyword yang diberikan -- SETIAP varian SUDAH
    pre-scored risiko disapproval-nya dari awal, jangan bikin copy berisiko dulu baru dikasih tau
    risikonya belakangan.

    {KNOWLEDGE_META}
    {KNOWLEDGE_TIKTOK}
    {KNOWLEDGE_INDONESIA_LAW}
    {KNOWLEDGE_PUFFERY_CALIBRATION}

    ATURAN WAJIB:
    - Setiap varian WAJIB sudah diusahakan aman dari awal (bukan template lalu diberi warning) --
      pakai puffery yang diizinkan, hindari klaim superlatif tanpa bukti, sertakan
      pertimbangan disclaimer risiko/BPOM/OJK di `risk_note` kalau kategori produknya relevan
      (kesehatan/kecantikan/keuangan).
    - `disapproval_risk` tetap diisi jujur (LOW/MEDIUM/HIGH) walau sudah diusahakan aman -- beberapa
      kategori produk (kesehatan, keuangan) punya risiko dasar lebih tinggi apa pun framing-nya.
    - Kalau ada teks halaman kompetitor terlampir, gunakan HANYA sbg konteks pasar/positioning
      (BUKAN utk ditiru/plagiat) -- angle harus tetap orisinal dan relevan ke produk sendiri.
    - `grounding_note`/`disclaimer` isi bebas (akan ditimpa Python setelah ini).
    """

    prompt = f"""
    Produk/Keyword: {product_or_keyword}
    Konteks tambahan dari user: {extra_context or '(tidak ada)'}
    Teks halaman kompetitor (kalau ada, HANYA sbg konteks pasar): {competitor_text[:2500] or '(tidak ada)'}

    Generate 3 angle x platform sesuai instruksi system.
    """

    result = _generate_structured(
        provider=provider_norm,
        api_key=gemini_api_key_override,
        model_override=model_override,
        system_instruction=system_instruction,
        prompt=prompt,
        schema_cls=CopywritingGenerateResult,
        temperature=0.4,
    )
    # Sama spt disclaimer: grounding_note TIDAK PERNAH dipercaya dari output model (model tidak tahu
    # apakah scrape-nya benar2 sukses dari sisi Python), selalu dipaksa dari variabel di atas.
    result.grounding_note = grounding_note
    result.disclaimer = DISCLAIMER
    return result
