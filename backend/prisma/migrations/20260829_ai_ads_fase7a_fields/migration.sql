-- Fase 7A: Extend tabel ai_ads_recommendations untuk mendukung multi-layer
-- findings, content_review routing, dan urgency flag.
--
-- Ditulis oleh: Antigravity (Gemini), 2026-08-29
-- Claude trackback: sesi 26b52cab

-- 1. Jadikan shift_type nullable (sebelumnya NOT NULL di schema awal)
--    Layer baru (layer_mutation, content_review) tidak punya shiftType.
--    SAFE: ALTER COLUMN dengan NULL default tidak drop data yang sudah ada.
ALTER TABLE "ai_ads_recommendations"
  ALTER COLUMN "shift_type" DROP NOT NULL;

-- 2. Tambah layerKey — generik identifier layer (format: "layer01_scale_up")
ALTER TABLE "ai_ads_recommendations"
  ADD COLUMN IF NOT EXISTS "layer_key" VARCHAR(100);

-- 3. Tambah routingType — "mutation" | "content_review" | "report_only" | "emergency_auto"
ALTER TABLE "ai_ads_recommendations"
  ADD COLUMN IF NOT EXISTS "routing_type" VARCHAR(30);

-- 4. Tambah isUrgent — true untuk Layer 7/8/12 (badge darurat di antrian)
ALTER TABLE "ai_ads_recommendations"
  ADD COLUMN IF NOT EXISTS "is_urgent" BOOLEAN NOT NULL DEFAULT FALSE;

-- 5. Tambah contentData — JSON preview konten AI untuk content_review
ALTER TABLE "ai_ads_recommendations"
  ADD COLUMN IF NOT EXISTS "content_data" JSONB;

-- 6. Index baru untuk query efisien di GET /approval-queue dan GET /modules/status
CREATE INDEX IF NOT EXISTS "ai_ads_recommendations_layer_key_idx"
  ON "ai_ads_recommendations"("layer_key");

CREATE INDEX IF NOT EXISTS "ai_ads_recommendations_routing_type_idx"
  ON "ai_ads_recommendations"("routing_type");
