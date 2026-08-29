ALTER TABLE "mining_sessions" ADD COLUMN IF NOT EXISTS "failed_files" INTEGER NOT NULL DEFAULT 0;

-- Bereskan sesi lama yang berstatus 'failed'. Baris-baris ini menempel di layar
-- sebagai spanduk merah yang tidak bisa ditutup, padahal masalahnya (batas token
-- Groq) sudah diperbaiki. Diubah jadi 'done' — BUKAN dihapus, karena menghapus
-- baris sesi akan ikut menghapus pertanyaan yang sudah berhasil ditambang di
-- dalamnya (relasi ON DELETE CASCADE).
UPDATE "mining_sessions"
   SET "status" = 'done',
       "failed_files" = GREATEST("total_files" - "processed_files", 1),
       "error_message" = NULL
 WHERE "status" = 'failed';
