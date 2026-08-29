-- Penghitung pesan per sesi CS Human Learning.
--
-- Kenapa perlu kolom baru: satu-satunya angka yang ada sebelumnya adalah
-- `total_pairs_captured`, dan itu baru bertambah SETELAH buffer di-flush ke
-- Shadow Mining — butuh minimal 4 pesan atau 30 menit idle. Akibatnya tidak ada
-- cara melihat "sesi ini memang sedang mendengar" dalam hitungan detik, dan
-- "belum ada chat masuk" tidak bisa dibedakan dari "semua pesan dibuang filter"
-- (itu yang menyembunyikan bug LID Baileys v7 pada 2026-07-30, lihat Fase 57).
--
-- Dua kolom ini bertambah per PESAN, bukan per buffer.
ALTER TABLE "cs_human_learning_sessions"
  ADD COLUMN IF NOT EXISTS "total_cs_replies" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "cs_human_learning_sessions"
  ADD COLUMN IF NOT EXISTS "total_buyer_messages" INTEGER NOT NULL DEFAULT 0;
