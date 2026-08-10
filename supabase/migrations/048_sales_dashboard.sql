-- ============================================================
-- 048_sales_dashboard.sql
--
-- Everything the sales dashboard needs to exist as data instead of
-- being guessed at read time: a product catalogue, line items on a
-- deal, where the lead came from, when the deal actually closed, and
-- the monthly target it is measured against.
--
-- Design notes
--
--   * `deal_products` is a line-item table, not a tag join. A deal for
--     "2 quartos + 1 evento" has to keep the quantity and the price
--     that was actually charged, otherwise "Vendas por produto" can
--     only ever count deals, not revenue. `unit_price` is copied from
--     the catalogue at insert time and then owned by the line — later
--     price changes must not rewrite closed history.
--
--   * `deals.value` stays the single source of truth for every value
--     the app already shows (board, analytics, dashboard). The trigger
--     below keeps it equal to the sum of the line items so the product
--     chart and the revenue cards can never disagree — unless the row
--     is flagged `value_is_manual`, which is what a negotiated discount
--     looks like. Once set, the flag makes the trigger keep its hands
--     off; the form shows the sum next to the typed value so the
--     divergence is visible rather than silent.
--
--   * `products.id` is referenced with ON DELETE RESTRICT. A product
--     with sales history is not deletable, it is archivable
--     (`is_active = false`) — deleting it would silently rewrite last
--     quarter's chart. The settings screen offers archiving and only
--     surfaces delete for products nothing points at.
--
--   * `lead_sources` is a table rather than a text column on `deals`
--     so "Indicação" and "indicacao" cannot become two slices of the
--     same pie, and so renaming a source fixes the whole history at
--     once. ON DELETE SET NULL: deleting a source must not delete the
--     deals that came through it, they just stop being attributed.
--
--   * `deals.closed_at` is new and load-bearing. Until now "won this
--     month" was read off `updated_at`, which moves every time anyone
--     edits a note — a deal won in June and touched in August counted
--     as an August win. The trigger stamps it on the transition into
--     won/lost and clears it on reopen, so a month's revenue stops
--     drifting. Existing closed rows are backfilled from `updated_at`,
--     the best evidence available for history that was never recorded.
--
--   * `sales_goals` uses a NULL `profile_id` to mean "the whole
--     account". Two partial unique indexes rather than one UNIQUE
--     constraint, because NULLs do not collide in a plain unique index
--     and the account-wide goal would be insertable twice.
--
-- Idempotent — safe to re-run.
-- ============================================================

-- ============================================================
-- PRODUCTS — the account's catalogue
-- ============================================================
CREATE TABLE IF NOT EXISTS products (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  -- Creator. Kept for parity with every other domain table; ownership
  -- for access purposes is `account_id`.
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  -- Suggested price. Copied into a line item on selection, never read
  -- back for historical rows.
  default_price NUMERIC(12,2) NOT NULL DEFAULT 0,
  -- Archived products stay joinable for old deals but drop out of the
  -- picker.
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Case-insensitive uniqueness: "Evento" and "evento" are the same
-- product, and letting both exist splits the chart in two.
CREATE UNIQUE INDEX IF NOT EXISTS idx_products_account_name
  ON products(account_id, lower(name));
CREATE INDEX IF NOT EXISTS idx_products_account_active
  ON products(account_id) WHERE is_active;

ALTER TABLE products ENABLE ROW LEVEL SECURITY;

-- Settings-class, same shape as tags/custom_fields (migration 017):
-- every member reads, admins and above write.
DROP POLICY IF EXISTS products_select ON products;
DROP POLICY IF EXISTS products_insert ON products;
DROP POLICY IF EXISTS products_update ON products;
DROP POLICY IF EXISTS products_delete ON products;
CREATE POLICY products_select ON products FOR SELECT
  USING (is_account_member(account_id));
CREATE POLICY products_insert ON products FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));
CREATE POLICY products_update ON products FOR UPDATE
  USING (is_account_member(account_id, 'admin'));
CREATE POLICY products_delete ON products FOR DELETE
  USING (is_account_member(account_id, 'admin'));

DROP TRIGGER IF EXISTS set_updated_at ON products;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON products
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- LEAD_SOURCES — where the deal came from
-- ============================================================
CREATE TABLE IF NOT EXISTS lead_sources (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  -- Drives the swatch in the origin breakdown so the same source keeps
  -- the same colour across sessions instead of depending on row order.
  color TEXT NOT NULL DEFAULT '#3b82f6',
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_lead_sources_account_name
  ON lead_sources(account_id, lower(name));

ALTER TABLE lead_sources ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS lead_sources_select ON lead_sources;
DROP POLICY IF EXISTS lead_sources_insert ON lead_sources;
DROP POLICY IF EXISTS lead_sources_update ON lead_sources;
DROP POLICY IF EXISTS lead_sources_delete ON lead_sources;
CREATE POLICY lead_sources_select ON lead_sources FOR SELECT
  USING (is_account_member(account_id));
CREATE POLICY lead_sources_insert ON lead_sources FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));
CREATE POLICY lead_sources_update ON lead_sources FOR UPDATE
  USING (is_account_member(account_id, 'admin'));
CREATE POLICY lead_sources_delete ON lead_sources FOR DELETE
  USING (is_account_member(account_id, 'admin'));

DROP TRIGGER IF EXISTS set_updated_at ON lead_sources;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON lead_sources
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- DEALS — new columns
-- ============================================================
ALTER TABLE deals
  ADD COLUMN IF NOT EXISTS source_id UUID REFERENCES lead_sources(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS value_is_manual BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_deals_source ON deals(source_id);
-- The dashboard's hot path: "this account's deals that closed inside
-- the reference period". Partial, because open deals have no closed_at
-- and would only bloat the index.
CREATE INDEX IF NOT EXISTS idx_deals_account_closed
  ON deals(account_id, closed_at) WHERE closed_at IS NOT NULL;
-- Serves the open-pipeline half of the dashboard (open value, open by
-- stage, open by owner) without touching closed rows.
CREATE INDEX IF NOT EXISTS idx_deals_account_status
  ON deals(account_id, status);

-- Backfill: everything already won or lost gets its last known edit as
-- the close date. Guarded so a re-run cannot overwrite real timestamps
-- stamped by the trigger below.
UPDATE deals
   SET closed_at = COALESCE(updated_at, created_at)
 WHERE status IN ('won', 'lost')
   AND closed_at IS NULL;

-- Stamp `closed_at` on the transition into a closed status, clear it on
-- reopen. Only fires when `status` actually changed, so ordinary edits
-- to a won deal leave the close date alone — the whole point of the
-- column.
CREATE OR REPLACE FUNCTION touch_deal_closed_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NEW.status IN ('won', 'lost') THEN
      -- Preserve an explicitly supplied date (an importer backdating
      -- history); only fill in the blank.
      NEW.closed_at := COALESCE(NEW.closed_at, NOW());
    ELSE
      NEW.closed_at := NULL;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_deal_status_closed ON deals;
CREATE TRIGGER on_deal_status_closed
  BEFORE UPDATE ON deals
  FOR EACH ROW EXECUTE FUNCTION touch_deal_closed_at();

-- A deal can also be born closed (imported history).
CREATE OR REPLACE FUNCTION set_deal_closed_at_on_insert()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status IN ('won', 'lost') THEN
    NEW.closed_at := COALESCE(NEW.closed_at, NOW());
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_deal_insert_closed ON deals;
CREATE TRIGGER on_deal_insert_closed
  BEFORE INSERT ON deals
  FOR EACH ROW EXECUTE FUNCTION set_deal_closed_at_on_insert();

-- ============================================================
-- DEAL_PRODUCTS — line items
-- ============================================================
CREATE TABLE IF NOT EXISTS deal_products (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  deal_id UUID NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  -- RESTRICT, not CASCADE: see the header. History outlives the
  -- catalogue entry.
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  quantity NUMERIC(12,2) NOT NULL DEFAULT 1 CHECK (quantity > 0),
  -- Snapshot of the price actually charged, not a live lookup.
  unit_price NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (unit_price >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The same product twice on one deal is a quantity, not two lines —
-- and collapsing it keeps the per-product aggregation honest.
CREATE UNIQUE INDEX IF NOT EXISTS idx_deal_products_unique
  ON deal_products(deal_id, product_id);
CREATE INDEX IF NOT EXISTS idx_deal_products_product
  ON deal_products(product_id);
CREATE INDEX IF NOT EXISTS idx_deal_products_account
  ON deal_products(account_id);

ALTER TABLE deal_products ENABLE ROW LEVEL SECURITY;

-- Deal-class, not settings-class: an agent closing a sale has to be
-- able to say what was sold.
DROP POLICY IF EXISTS deal_products_select ON deal_products;
DROP POLICY IF EXISTS deal_products_insert ON deal_products;
DROP POLICY IF EXISTS deal_products_update ON deal_products;
DROP POLICY IF EXISTS deal_products_delete ON deal_products;
CREATE POLICY deal_products_select ON deal_products FOR SELECT
  USING (is_account_member(account_id));
CREATE POLICY deal_products_insert ON deal_products FOR INSERT
  WITH CHECK (is_account_member(account_id, 'agent'));
CREATE POLICY deal_products_update ON deal_products FOR UPDATE
  USING (is_account_member(account_id, 'agent'));
CREATE POLICY deal_products_delete ON deal_products FOR DELETE
  USING (is_account_member(account_id, 'agent'));

-- Keep deals.value equal to the sum of its line items, unless the deal
-- has been flagged as manually priced.
CREATE OR REPLACE FUNCTION recompute_deal_value()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_deal_id UUID := COALESCE(NEW.deal_id, OLD.deal_id);
  v_total NUMERIC(12,2);
BEGIN
  SELECT COALESCE(SUM(quantity * unit_price), 0)
    INTO v_total
    FROM deal_products
   WHERE deal_id = v_deal_id;

  UPDATE deals
     SET value = v_total
   WHERE id = v_deal_id
     AND value_is_manual = FALSE
     -- Skip the write (and the updated_at trigger, and the realtime
     -- broadcast) when nothing actually moved.
     AND value IS DISTINCT FROM v_total;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS on_deal_products_changed ON deal_products;
CREATE TRIGGER on_deal_products_changed
  AFTER INSERT OR UPDATE OR DELETE ON deal_products
  FOR EACH ROW EXECUTE FUNCTION recompute_deal_value();

-- ============================================================
-- SALES_GOALS — monthly target, account-wide or per seller
-- ============================================================
CREATE TABLE IF NOT EXISTS sales_goals (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  -- NULL = the account's own target. Otherwise the seller it belongs
  -- to. CASCADE: a removed teammate's personal target is meaningless.
  profile_id UUID REFERENCES profiles(id) ON DELETE CASCADE,
  -- Always the first day of the month. The CHECK keeps callers from
  -- inventing mid-month periods that no query would ever match.
  -- Spelled as a day-of-month test rather than date_trunc() because a
  -- CHECK needs an immutable expression and this one plainly is.
  period_month DATE NOT NULL CHECK (EXTRACT(DAY FROM period_month) = 1),
  target_amount NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (target_amount >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Two partial indexes instead of one UNIQUE(account_id, period_month,
-- profile_id): NULL profile_id would not collide with itself, so the
-- account-wide goal could be inserted any number of times.
CREATE UNIQUE INDEX IF NOT EXISTS idx_sales_goals_account_month
  ON sales_goals(account_id, period_month) WHERE profile_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_sales_goals_account_month_profile
  ON sales_goals(account_id, period_month, profile_id) WHERE profile_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sales_goals_profile ON sales_goals(profile_id);

ALTER TABLE sales_goals ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS sales_goals_select ON sales_goals;
DROP POLICY IF EXISTS sales_goals_insert ON sales_goals;
DROP POLICY IF EXISTS sales_goals_update ON sales_goals;
DROP POLICY IF EXISTS sales_goals_delete ON sales_goals;
CREATE POLICY sales_goals_select ON sales_goals FOR SELECT
  USING (is_account_member(account_id));
CREATE POLICY sales_goals_insert ON sales_goals FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));
CREATE POLICY sales_goals_update ON sales_goals FOR UPDATE
  USING (is_account_member(account_id, 'admin'));
CREATE POLICY sales_goals_delete ON sales_goals FOR DELETE
  USING (is_account_member(account_id, 'admin'));

DROP TRIGGER IF EXISTS set_updated_at ON sales_goals;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON sales_goals
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
