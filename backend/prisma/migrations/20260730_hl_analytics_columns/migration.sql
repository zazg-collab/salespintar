-- Kolom analitik Human Learning: fakta disimpan/dibuang, closing/lost, statistik intent.
--
-- ── Kenapa migrasi ini ditulis BELAKANGAN ────────────────────────────────────
-- Kelima kolom ini sudah lama ada di `schema.prisma` (ditambahkan Antigravity
-- bersama fitur Human Learning) dan sudah dibaca `human-learning.routes.ts` —
-- dashboard menampilkan angkanya, jadi kolomnya memang ADA di database. Tapi
-- tidak ada satu pun berkas migrasi yang membuatnya: kemungkinan besar masuk
-- lewat `prisma db push` atau ALTER manual.
--
-- Itu masalah walau sekarang "jalan": basis data yang dibangun ulang dari nol
-- dengan `migrate deploy` (mesin baru, VPS, CI) akan KEHILANGAN kelima kolom ini,
-- dan yang gagal bukan cuma statistiknya — `human-learning.routes.ts` melakukan
-- SELECT atas kolom-kolom itu, jadi seluruh halaman Human Learning akan 500.
-- Kegagalan itu akan muncul justru saat pindah server, saat paling tidak enak.
--
-- `IF NOT EXISTS` membuat migrasi ini aman dijalankan di database yang sudah
-- punya kolomnya (mesin Angga sekarang): tidak melakukan apa-apa. Di database
-- yang belum, ia membuatnya. Dua-duanya berakhir di keadaan yang sama — itulah
-- yang seharusnya dijamin sebuah migrasi.
ALTER TABLE "cs_human_learning_sessions"
  ADD COLUMN IF NOT EXISTS "total_facts_saved" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "cs_human_learning_sessions"
  ADD COLUMN IF NOT EXISTS "total_facts_discarded" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "cs_human_learning_sessions"
  ADD COLUMN IF NOT EXISTS "total_closing_detected" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "cs_human_learning_sessions"
  ADD COLUMN IF NOT EXISTS "total_lost_detected" INTEGER NOT NULL DEFAULT 0;

-- Nullable, mengikuti `intentStats Json?` di schema.prisma. Raw SQL di
-- shadow-mining.worker.ts sudah memakai COALESCE(..., '{}'::jsonb) sehingga NULL
-- awal tidak menghanguskan penambahan pertama.
ALTER TABLE "cs_human_learning_sessions"
  ADD COLUMN IF NOT EXISTS "intent_stats" JSONB;
