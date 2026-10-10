-- Central Gemini gateway: the key lives only in the Worker; customers authenticate with their sync key.
-- Usage is counted per tenant and per day (for pricing and for an optional daily cap).
-- @@
ALTER TABLE {S}.tenants ADD COLUMN IF NOT EXISTS ai_daily_cap int
-- @@
CREATE TABLE IF NOT EXISTS {S}.ai_usage(
  tenant_id int NOT NULL,
  day date NOT NULL,
  calls int NOT NULL DEFAULT 0,
  errors int NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, day)
)
-- @@
CREATE OR REPLACE FUNCTION {S}.fb_ai_gate(p_key text) RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO {S}, public
AS $$
DECLARE t tenants%ROWTYPE; d date := (now() AT TIME ZONE 'Asia/Tehran')::date; used int;
BEGIN
  SELECT * INTO t FROM tenants WHERE sync_key_hash = fb_hash(p_key) AND status='active';
  IF NOT FOUND THEN RAISE EXCEPTION 'invalid_key'; END IF;
  SELECT calls INTO used FROM ai_usage WHERE tenant_id=t.id AND day=d;
  IF t.ai_daily_cap IS NOT NULL AND coalesce(used,0) >= t.ai_daily_cap THEN RAISE EXCEPTION 'quota_exceeded'; END IF;
  INSERT INTO ai_usage(tenant_id,day,calls) VALUES (t.id,d,1)
    ON CONFLICT (tenant_id,day) DO UPDATE SET calls = ai_usage.calls + 1;
  RETURN t.id;
END $$
-- @@
CREATE OR REPLACE FUNCTION {S}.fb_ai_error(p_tenant int) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path TO {S}, public
AS $$ INSERT INTO ai_usage(tenant_id,day,calls,errors) VALUES (p_tenant,(now() AT TIME ZONE 'Asia/Tehran')::date,0,1)
      ON CONFLICT (tenant_id,day) DO UPDATE SET errors = ai_usage.errors + 1 $$
