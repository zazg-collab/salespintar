-- Fase 82 — token yang DITAGIH tapi tidak dilaporkan sebagai completion.
--
-- Fase 81 mengukurnya di Gemini: prompt 30 · completion 23 · total 251 — 198
-- token "thinking" tidak muncul di mana pun. Tanpa kolom ini, biaya Gemini di
-- `llm_calls` terlihat ~10x lebih murah dari kenyataan, dan seluruh dasar
-- keputusan "model mana yang layak" jadi bohong.
--
-- Nullable: layanan yang tidak menyembunyikan token apa pun tidak mengisinya,
-- dan itu berbeda artinya dari "nol token tersembunyi yang terukur".
ALTER TABLE llm_calls
  ADD COLUMN IF NOT EXISTS reasoning_tokens INTEGER;
