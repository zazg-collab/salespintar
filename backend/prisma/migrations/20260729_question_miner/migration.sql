-- Question Miner: tabel sesi penambangan + pertanyaan hasil tambang.
-- Catatan: kolom `embedding` memakai tipe vector(384) dari pgvector, dimensi yang
-- sama dengan tabel `knowledge` karena memakai model embedding yang sama.
-- Prisma tidak bisa membuat kolom bertipe Unsupported, jadi ditambahkan manual.

CREATE TABLE IF NOT EXISTS "mining_sessions" (
  "id"              UUID PRIMARY KEY,
  "business_id"     UUID NOT NULL,
  "label"           VARCHAR(200) NOT NULL,
  "status"          VARCHAR(20) NOT NULL DEFAULT 'pending',
  "total_files"     INTEGER NOT NULL DEFAULT 0,
  "processed_files" INTEGER NOT NULL DEFAULT 0,
  "total_messages"  INTEGER NOT NULL DEFAULT 0,
  "cs_names"        JSONB NOT NULL DEFAULT '[]',
  "error_message"   TEXT,
  "created_at"      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at"      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "mining_sessions_business_id_fkey"
    FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "mining_sessions_business_id_created_at_idx"
  ON "mining_sessions" ("business_id", "created_at");

CREATE TABLE IF NOT EXISTS "mined_questions" (
  "id"          UUID PRIMARY KEY,
  "business_id" UUID NOT NULL,
  "session_id"  UUID NOT NULL,
  "question"    TEXT NOT NULL,
  "sample_raw"  TEXT NOT NULL,
  "occurrences" INTEGER NOT NULL DEFAULT 1,
  "embedding"   vector(384),
  "answer"      TEXT,
  "category"    VARCHAR(20) NOT NULL DEFAULT 'FAQ',
  "status"      VARCHAR(20) NOT NULL DEFAULT 'open',
  "vault_path"  VARCHAR(500),
  "created_at"  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at"  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "mined_questions_business_id_fkey"
    FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE,
  CONSTRAINT "mined_questions_session_id_fkey"
    FOREIGN KEY ("session_id") REFERENCES "mining_sessions"("id") ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "mined_questions_business_id_status_idx"
  ON "mined_questions" ("business_id", "status");
CREATE INDEX IF NOT EXISTS "mined_questions_session_id_idx"
  ON "mined_questions" ("session_id");
