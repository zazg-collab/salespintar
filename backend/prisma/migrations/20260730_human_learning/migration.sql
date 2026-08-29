-- Human Learning Session table
-- Menyimpan state sesi Baileys shadow per CS staff.
-- Sesi ini terpisah dari wa_credentials (yang dipakai bot utama).

CREATE TABLE cs_human_learning_sessions (
  id                   UUID         NOT NULL DEFAULT gen_random_uuid(),
  business_id          UUID         NOT NULL,
  cs_phone             VARCHAR(20)  NOT NULL,
  cs_name              VARCHAR(100) NOT NULL,
  status               VARCHAR(20)  NOT NULL DEFAULT 'DISCONNECTED',
  qr_code              TEXT,
  qr_expires_at        TIMESTAMPTZ,
  linked_at            TIMESTAMPTZ,
  last_seen_at         TIMESTAMPTZ,
  total_pairs_captured INTEGER      NOT NULL DEFAULT 0,
  created_at           TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ  NOT NULL DEFAULT now(),

  CONSTRAINT cs_human_learning_sessions_pkey PRIMARY KEY (id),
  CONSTRAINT cs_human_learning_sessions_business_fk
    FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE,
  CONSTRAINT cs_human_learning_sessions_business_phone_unique
    UNIQUE (business_id, cs_phone)
);

CREATE INDEX cs_hl_sessions_business_idx   ON cs_human_learning_sessions(business_id);
CREATE INDEX cs_hl_sessions_status_idx     ON cs_human_learning_sessions(business_id, status);
