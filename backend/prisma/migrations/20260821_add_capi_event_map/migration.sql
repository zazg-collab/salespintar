ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS meta_capi_event_map JSONB;
