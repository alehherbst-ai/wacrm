-- ============================================================
-- 037_uazapi_provider.sql — UAZAPI (unofficial WhatsApp API,
-- QR-code based) as a second provider, connectable alongside Meta.
--
-- Why this exists:
--   whatsapp_config was 100% Meta-shaped: one row per account
--   (UNIQUE(account_id), migration 017), phone_number_id/access_token
--   NOT NULL, auth via an OAuth-style bearer token. UAZAPI
--   authenticates with a per-instance token instead, connects via QR
--   code, and has no equivalent of phone_number_id/waba_id. An
--   account can now hold BOTH a Meta row and a UAZAPI row at once
--   (two different WhatsApp numbers), so the constraint moves from
--   "one config per account" to "one config per (account, provider)".
--
-- What this migration does:
--   1. Adds `provider` (default 'meta' — every existing row is Meta).
--   2. Adds uazapi_* columns, all nullable (irrelevant on Meta rows).
--   3. Relaxes phone_number_id / access_token off column-level
--      NOT NULL, replaced by a provider-conditional CHECK, since a
--      uazapi row has neither.
--   4. Swaps UNIQUE(account_id) for UNIQUE(account_id, provider).
--   5. Adds conversations.whatsapp_config_id — which connection a
--      thread is currently routed through — and backfills every
--      existing conversation to its account's (only) config, since
--      today every account has at most one.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

-- ---- whatsapp_config: provider + uazapi columns -------------------
ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'meta',
  ADD COLUMN IF NOT EXISTS uazapi_instance_id TEXT,
  ADD COLUMN IF NOT EXISTS uazapi_instance_token TEXT,
  ADD COLUMN IF NOT EXISTS uazapi_instance_name TEXT,
  ADD COLUMN IF NOT EXISTS uazapi_webhook_secret TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'whatsapp_config_provider_check'
  ) THEN
    ALTER TABLE whatsapp_config
      ADD CONSTRAINT whatsapp_config_provider_check
      CHECK (provider IN ('meta', 'uazapi'));
  END IF;
END $$;

-- ---- relax Meta-only columns off column-level NOT NULL ------------
-- phone_number_id/access_token were NOT NULL since migration 001 —
-- correct back when every row was Meta. A uazapi row has neither.
-- Drop the column-level constraint; the provider-conditional CHECK
-- below keeps the same guarantee for Meta rows.
ALTER TABLE whatsapp_config ALTER COLUMN phone_number_id DROP NOT NULL;
ALTER TABLE whatsapp_config ALTER COLUMN access_token DROP NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'whatsapp_config_provider_fields_check'
  ) THEN
    ALTER TABLE whatsapp_config
      ADD CONSTRAINT whatsapp_config_provider_fields_check
      CHECK (
        (provider = 'meta' AND phone_number_id IS NOT NULL AND access_token IS NOT NULL)
        OR
        (provider = 'uazapi' AND uazapi_instance_id IS NOT NULL AND uazapi_instance_token IS NOT NULL)
      );
  END IF;
END $$;

-- ---- one config per (account, provider) ----------------------------
-- Was UNIQUE(account_id) — one number per account, full stop. Now an
-- account may hold one Meta connection AND one UAZAPI connection
-- simultaneously, but still at most one of each.
ALTER TABLE whatsapp_config DROP CONSTRAINT IF EXISTS whatsapp_config_account_id_key;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'whatsapp_config_account_id_provider_key'
  ) THEN
    ALTER TABLE whatsapp_config
      ADD CONSTRAINT whatsapp_config_account_id_provider_key
      UNIQUE (account_id, provider);
  END IF;
END $$;

-- ============================================================
-- conversations: which connection this thread is routed through
--
-- With only one whatsapp_config per account this was implicit; with
-- two simultaneous connections, outbound sends need to know which
-- one a given conversation belongs to. Nullable + ON DELETE SET NULL
-- so removing a connection doesn't take the conversation history with
-- it — the thread just falls back to account-level resolution (see
-- resolveOutboundConnection in src/lib/whatsapp/providers/resolve.ts).
-- ============================================================
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS whatsapp_config_id UUID REFERENCES whatsapp_config(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_conversations_whatsapp_config
  ON conversations(whatsapp_config_id);

-- Backfill: at the time this migration runs, every account has at
-- most one whatsapp_config row (the constraint above has just widened
-- to allow a second), so every existing conversation unambiguously
-- belongs to its account's single config.
UPDATE conversations c
SET whatsapp_config_id = wc.id
FROM whatsapp_config wc
WHERE c.account_id = wc.account_id
  AND c.whatsapp_config_id IS NULL;
