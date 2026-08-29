import sys

PATH = "/root/salespintar-ai-agent/metaguard_service/main.py"

OLD = '''class CopywritingCheckRequest(BaseModel):
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
'''

NEW = '''class CopywritingCheckRequest(BaseModel):
    headline: Optional[str] = None
    primary_text: Optional[str] = None


@app.post("/v1/copywriting/check", dependencies=[Depends(_require_internal_key)])
async def copywriting_check(
    payload: CopywritingCheckRequest,
    x_gemini_api_key: Optional[str] = Header(None),
    x_llm_provider: Optional[str] = Header(None),
    x_llm_api_key: Optional[str] = Header(None),
    x_llm_model: Optional[str] = Header(None),
):
    # [2026-08-26] Header baru X-Llm-Provider/X-Llm-Api-Key/X-Llm-Model (provider-agnostic: google/
    # openai/openrouter) -- X-Gemini-Api-Key LAMA tetap didukung sbg fallback kalau X-Llm-Api-Key
    # tidak dikirim (backward compat, provider default tetap 'google' kalau X-Llm-Provider kosong).
    provider = x_llm_provider or "google"
    api_key = x_llm_api_key or x_gemini_api_key
    try:
        result = await run_copywriting_check(
            payload.headline, payload.primary_text, api_key, provider, x_llm_model
        )
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
    x_llm_provider: Optional[str] = Header(None),
    x_llm_api_key: Optional[str] = Header(None),
    x_llm_model: Optional[str] = Header(None),
):
    provider = x_llm_provider or "google"
    api_key = x_llm_api_key or x_gemini_api_key
    try:
        result = await run_copywriting_generate(
            payload.product_or_keyword,
            payload.competitor_url,
            payload.extra_context,
            api_key,
            provider,
            x_llm_model,
        )
    except ValueError as e:
        raise HTTPException(400, str(e))
    return result.model_dump()
'''


def main():
    with open(PATH, "r", encoding="utf-8") as f:
        content = f.read()

    count = content.count(OLD)
    if count != 1:
        print(f"ABORT: OLD block found {count} times (expected exactly 1). No changes written.")
        sys.exit(1)

    new_content = content.replace(OLD, NEW)
    with open(PATH, "w", encoding="utf-8") as f:
        f.write(new_content)

    print(f"PATCHED_OK bytes_before={len(content)} bytes_after={len(new_content)}")


if __name__ == "__main__":
    main()
