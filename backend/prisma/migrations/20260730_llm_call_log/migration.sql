-- Catatan pemakaian model bahasa, satu baris per panggilan.
--
-- Kenapa tabel baru dan bukan kolom di `messages`: dari sembilan titik panggil
-- LLM di backend, hanya SATU (balasan pelanggan) yang punya baris `messages`.
-- Shadow Mining Layer 1 & 2, detectIntent, penyusunan dokumen question-miner,
-- dan validator Supervisor semuanya memanggil model tanpa pernah membuat baris
-- pesan — jadi menaruh angka token di `messages.metadata` akan meninggalkan
-- lima dari sembilan pekerjaan tetap gelap.
--
-- Kolom `job` memakai kunci yang SAMA dengan nama pekerjaan di
-- `src/services/llm.ts`, supaya tabel ini menjawab langsung pertanyaan yang
-- memicu pembuatannya: pekerjaan mana yang layak dapat model mahal.
--
-- `business_id` sengaja NULLABLE dan TANPA foreign key: alat audit CLI
-- (`audit-ai.ts`) memanggil model tanpa konteks bisnis, dan tabel pengukuran
-- tidak boleh punya kuasa menggagalkan penghapusan baris bisnis.
CREATE TABLE IF NOT EXISTS llm_calls (
  id                UUID         NOT NULL DEFAULT gen_random_uuid(),
  business_id       UUID,
  job               VARCHAR(32)  NOT NULL,
  provider          VARCHAR(16)  NOT NULL,
  model             VARCHAR(100) NOT NULL,
  prompt_tokens     INTEGER      NOT NULL DEFAULT 0,
  completion_tokens INTEGER      NOT NULL DEFAULT 0,
  cached_tokens     INTEGER,
  latency_ms        INTEGER      NOT NULL DEFAULT 0,
  attempts          INTEGER      NOT NULL DEFAULT 1,
  ok                BOOLEAN      NOT NULL DEFAULT true,
  error_kind        VARCHAR(32),
  correlation_id    VARCHAR(64),
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),

  CONSTRAINT llm_calls_pkey PRIMARY KEY (id)
);

-- Nama index SENGAJA memakai konvensi Prisma (`<tabel>_<kolom>_<kolom>_idx`),
-- bukan nama yang lebih pendek. Kalau namanya beda, `prisma migrate diff` di
-- masa depan akan melaporkan drift palsu dan menyuruh membuat migrasi yang
-- sebenarnya tidak mengubah apa pun.
--
-- Untuk agregasi per bisnis per rentang waktu.
CREATE INDEX IF NOT EXISTS "llm_calls_business_id_created_at_idx" ON llm_calls (business_id, created_at);
-- Untuk pertanyaan utamanya: biaya per PEKERJAAN.
CREATE INDEX IF NOT EXISTS "llm_calls_job_created_at_idx" ON llm_calls (job, created_at);
