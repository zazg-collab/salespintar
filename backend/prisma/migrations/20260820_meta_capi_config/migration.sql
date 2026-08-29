-- Fase 40 (2026-08-20) -- Integrasi Meta Conversions API (CAPI) native, gantikan koneksiku.web.id.
-- Rencana lengkap: projek-ceo/20260820-rencana-integrasi-meta-capi.md (audit menyeluruh di §12,
-- ledger anti-drift Fase 39).
--
-- Semua kolom nullable/berdefault -- migrasi ADITIF murni, tidak menyentuh baris yang sudah ada.
-- metaCapiAccessToken disimpan TERENKRIPSI (AES-256-GCM, backend/src/services/crypto.service.ts) --
-- kolom TEXT karena ciphertext+iv+authTag lebih panjang dari token asli, TIDAK PERNAH plaintext.
-- IF NOT EXISTS mengikuti gaya migrasi sebelumnya (20260731_hl_docs_written,
-- 20260818_lead_confirmed_cod_amount) -- aman dijalankan ulang.

ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS meta_capi_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS meta_capi_pixel_id VARCHAR(50),
  ADD COLUMN IF NOT EXISTS meta_capi_access_token TEXT,
  ADD COLUMN IF NOT EXISTS meta_capi_test_event_code VARCHAR(50),
  ADD COLUMN IF NOT EXISTS meta_capi_waba_id VARCHAR(50),
  ADD COLUMN IF NOT EXISTS meta_capi_currency VARCHAR(10) NOT NULL DEFAULT 'IDR';

ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS ctwa_clid VARCHAR(255),
  ADD COLUMN IF NOT EXISTS capi_events_sent TEXT[] NOT NULL DEFAULT '{}';
