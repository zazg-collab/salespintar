-- Rem untuk penambangan otomatis Shadow Mining, per business.
--
-- Sebelumnya auto-trigger (saat percakapan ditandai Selesai) menyala permanen
-- tanpa cara mematikannya, sehingga setiap percakapan yang selesai langsung
-- memakan token Groq. Toggle Auto/Draft yang sudah ada hanya mengatur hasilnya
-- mau ke mana, bukan apakah penambangannya berjalan.
--
-- Default TRUE supaya perilaku bisnis yang sudah berjalan tidak berubah.
ALTER TABLE "businesses"
  ADD COLUMN IF NOT EXISTS "shadow_mining_auto_trigger" BOOLEAN NOT NULL DEFAULT true;
