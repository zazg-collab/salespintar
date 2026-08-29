-- ═══════════════════════════════════════════════════════════════════════════════
-- Migrasi gabungan: utang migrasi Fase 1-7 + backlog audit (B4, C5, C9)
--
-- Konteks: sejak migrasi 20260722094245_widen_lead_columns, schema.prisma sudah
-- berubah beberapa kali (Fase 1 Obsidian Watcher, fix audit C4) TANPA pernah
-- dibuatkan file migrasi. Akibatnya schema.prisma dan folder migrations/ sudah
-- tidak sinkron. Migrasi ini menutup seluruh selisih itu sekaligus menambahkan
-- perubahan dari backlog audit yang dikerjakan 2026-07-29.
--
-- Semua statement ditulis idempoten (IF NOT EXISTS / DO $$ ... $$) karena
-- sebagian objek kemungkinan sudah dibuat manual atau lewat `prisma db push`
-- di database dev. Aman dijalankan pada database yang sudah maupun belum punya
-- objek-objek ini.
--
-- Cara pakai: npx prisma migrate deploy
-- ═══════════════════════════════════════════════════════════════════════════════

-- ── Prasyarat: ekstensi pgvector untuk kolom embedding ────────────────────────
CREATE EXTENSION IF NOT EXISTS vector;

-- ═══════════════════════════════════════════════════════════════════════════════
-- BAGIAN 1 — Utang Fase 1: tabel knowledge + kolom sinkronisasi Obsidian
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS "knowledge" (
    "id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "content" TEXT NOT NULL,
    "embedding" vector(384),
    "source_file" VARCHAR(500),
    "synced_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "knowledge_pkey" PRIMARY KEY ("id")
);

-- Kalau tabel sudah ada dari db push tapi belum punya kolom Fase 1
ALTER TABLE "knowledge" ADD COLUMN IF NOT EXISTS "embedding" vector(384);
ALTER TABLE "knowledge" ADD COLUMN IF NOT EXISTS "source_file" VARCHAR(500);
ALTER TABLE "knowledge" ADD COLUMN IF NOT EXISTS "synced_at" TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS "knowledge_business_id_idx" ON "knowledge"("business_id");
CREATE INDEX IF NOT EXISTS "knowledge_business_id_source_file_idx" ON "knowledge"("business_id", "source_file");

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'knowledge_business_id_fkey'
    ) THEN
        ALTER TABLE "knowledge"
            ADD CONSTRAINT "knowledge_business_id_fkey"
            FOREIGN KEY ("business_id") REFERENCES "businesses"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════════
-- BAGIAN 2 — Utang fix audit C4: composite index percakapan
-- Mempercepat findFirst({ businessId, leadId, status: { in: [...] } }) yang
-- dipanggil pada SETIAP pesan masuk.
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE INDEX IF NOT EXISTS "conversations_business_id_lead_id_status_idx"
    ON "conversations"("business_id", "lead_id", "status");

-- ═══════════════════════════════════════════════════════════════════════════════
-- BAGIAN 3 — Fix audit B4: idempotency shadow mining
-- Menandai percakapan yang sudah pernah menghasilkan dokumen knowledge, supaya
-- job mining berulang (auto-trigger + manual + retry) tidak memproses ulang.
-- ═══════════════════════════════════════════════════════════════════════════════

ALTER TABLE "conversations" ADD COLUMN IF NOT EXISTS "mined_at" TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS "conversations_business_id_mined_at_idx"
    ON "conversations"("business_id", "mined_at");

-- ═══════════════════════════════════════════════════════════════════════════════
-- BAGIAN 4 — Fix audit C5: denormalisasi lead_id ke tabel messages
-- Query konteks AI mengambil 20 pesan terakhir milik satu lead lintas
-- percakapan. Sebelumnya wajib JOIN ke conversations; dengan kolom ini cukup
-- satu index scan.
--
-- Kolom dibuat NULLABLE dengan sengaja: baris lama di-backfill di bawah, tapi
-- membuatnya NOT NULL akan mengunci tabel lebih lama dan tidak memberi manfaat
-- tambahan (kode aplikasi selalu mengisinya untuk baris baru).
-- ═══════════════════════════════════════════════════════════════════════════════

ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "lead_id" UUID;

-- Backfill baris lama dari percakapan induknya.
UPDATE "messages" m
SET "lead_id" = c."lead_id"
FROM "conversations" c
WHERE m."conversation_id" = c."id"
  AND m."lead_id" IS NULL;

CREATE INDEX IF NOT EXISTS "messages_business_id_lead_id_created_at_idx"
    ON "messages"("business_id", "lead_id", "created_at" DESC);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'messages_lead_id_fkey'
    ) THEN
        ALTER TABLE "messages"
            ADD CONSTRAINT "messages_lead_id_fkey"
            FOREIGN KEY ("lead_id") REFERENCES "leads"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════════
-- BAGIAN 5 — Fix audit C9: persistensi mode Shadow Mining
-- Menggantikan mutasi runtime `(env as any).SHADOW_MINING_MODE = mode` yang
-- hilang saat restart, hanya berlaku di satu instance, dan bocor lintas tenant.
-- NULL berarti business belum pernah mengubah setelan → pakai default env.
-- ═══════════════════════════════════════════════════════════════════════════════

ALTER TABLE "businesses" ADD COLUMN IF NOT EXISTS "shadow_mining_mode" VARCHAR(10);
