-- Fase 78 — penghitung dokumen yang BENAR-BENAR ditulis ke vault.
--
-- `total_facts_saved` selama ini dipakai sebagai "Fakta disimpan" di dashboard,
-- padahal ia bertambah dari vonis Lapis 1 (`hasValue`) — sebelum Lapis 2
-- mengekstrak, sebelum Lapis 3 menyaring duplikat, dan sebelum berkasnya ditulis.
-- Selisihnya nyata: 20 vonis "bernilai" vs 18 berkas di Draft_AI (31 Juli 2026).
--
-- IF NOT EXISTS supaya migrasi ini aman dijalankan ulang di lingkungan yang
-- kolomnya sudah terlanjur ada, mengikuti gaya 20260730_mining_failed_files.
ALTER TABLE cs_human_learning_sessions
  ADD COLUMN IF NOT EXISTS total_docs_written INTEGER NOT NULL DEFAULT 0;
