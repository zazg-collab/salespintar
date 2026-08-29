import sys

PATH = "/root/salespintar-ai-agent/metaguard_service/main.py"

OLD = '''    # [2026-08-26] Header baru X-Llm-Provider/X-Llm-Api-Key/X-Llm-Model (provider-agnostic: google/
    # openai/openrouter) -- X-Gemini-Api-Key LAMA tetap didukung sbg fallback kalau X-Llm-Api-Key
    # tidak dikirim (backward compat, provider default tetap 'google' kalau X-Llm-Provider kosong).
    provider = x_llm_provider or "google"
    api_key = x_llm_api_key or x_gemini_api_key
    try:
        result = await run_copywriting_check(
            payload.headline, payload.primary_text, api_key, provider, x_llm_model
        )'''

NEW = '''    # [2026-08-26] Header X-Llm-Provider/X-Llm-Api-Key/X-Llm-Model (provider-agnostic: agy/google/
    # openai/openrouter) -- X-Gemini-Api-Key LAMA tetap didukung sbg fallback kalau X-Llm-Api-Key
    # tidak dikirim. [Koreksi 2026-08-26 lanjutan] Default provider diganti ke 'agy' (BUKAN 'google'
    # lagi) -- lihat docstring copywriting.py: Batch E auto-Check/Generate-Ads tiap audio diam-diam
    # menghabiskan kuota API key Gemini 20/hari, provider 'agy' pakai kuota Google AI Pro subscription
    # terpisah (sama spt audit video sendiri), pool "copywriting-ads" sendiri biar tidak antre.
    provider = x_llm_provider or "agy"
    api_key = x_llm_api_key or x_gemini_api_key
    try:
        result = await run_copywriting_check(
            payload.headline, payload.primary_text, api_key, provider, x_llm_model
        )'''

OLD2 = '''    provider = x_llm_provider or "google"
    api_key = x_llm_api_key or x_gemini_api_key
    try:
        result = await run_copywriting_generate('''

NEW2 = '''    provider = x_llm_provider or "agy"  # [2026-08-26] lihat komentar di copywriting_check() di atas.
    api_key = x_llm_api_key or x_gemini_api_key
    try:
        result = await run_copywriting_generate('''


def patch_one(content, old, new, label):
    count = content.count(old)
    if count != 1:
        print(f"ABORT: block '{label}' found {count} times (expected exactly 1). No changes written.")
        sys.exit(1)
    return content.replace(old, new)


def main():
    with open(PATH, "r", encoding="utf-8") as f:
        content = f.read()

    content = patch_one(content, OLD, NEW, "copywriting_check default")
    content = patch_one(content, OLD2, NEW2, "copywriting_generate default")

    with open(PATH, "w", encoding="utf-8") as f:
        f.write(content)

    print("PATCHED_OK")


if __name__ == "__main__":
    main()
