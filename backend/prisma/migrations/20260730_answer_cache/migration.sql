-- Ingatan jawaban. Tanpa relasi ke businesses karena isinya sekali-buang dan
-- selalu dibersihkan per business secara eksplisit.
CREATE TABLE IF NOT EXISTS "answer_cache" (
  "id"          UUID PRIMARY KEY,
  "business_id" UUID NOT NULL,
  "question"    TEXT NOT NULL,
  "answer"      TEXT NOT NULL,
  "embedding"   vector(384),
  "created_at"  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS "answer_cache_business_id_created_at_idx"
  ON "answer_cache" ("business_id", "created_at");
