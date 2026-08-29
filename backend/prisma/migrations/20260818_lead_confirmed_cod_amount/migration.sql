-- Langkah D-lanjutan (Fase 29, 2026-08-18) -- akurasi nilai transaksi (Temuan T3 lama, Fase 26).
--
-- `timeline.service.ts` menghitung LTV/nilai transaksi lewat peta harga statis `ESTIMATED_PRICES`
-- yang cuma cover 17.6% SKU (12 dari ~68 produk) -- sisanya jatuh ke default rata Rp 200.000 utk
-- SEMUA closing, tidak peduli produknya apa. Padahal CS SUDAH mengetik nominal sebenarnya tiap kali
-- konfirmasi COD ke pembeli ("RINCIAN BIAYA ... TOTAL COD: Rp xxx") -- angka itu ada di transkrip,
-- cuma tidak pernah disimpan. Kolom ini menyimpannya begitu terdeteksi
-- (lead-profiler.service.ts::extractRoleAwareProduct), dipakai sbg acuan UTAMA nilai transaksi,
-- dgn fallback ke ESTIMATED_PRICES kalau CS tidak sempat menyebut angka.
--
-- Nullable, tanpa default -- lead lama (belum pernah re-profiled sejak fase ini) tetap NULL dan
-- otomatis fallback ke katalog SKU seperti sebelumnya, tidak ada migrasi data backfill yg perlu
-- ditebak2. IF NOT EXISTS mengikuti gaya 20260731_hl_docs_written (aman dijalankan ulang).
ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS confirmed_cod_amount INTEGER;
