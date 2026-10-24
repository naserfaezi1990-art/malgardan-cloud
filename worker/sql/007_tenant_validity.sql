-- Server-side lock: license revocation / expiry now also switches the customer's CLOUD service off (AI gateway, sync, command room, party links),
-- so a patched app cannot keep using what only we can provide. Additive; safe on production.
-- @@
ALTER TABLE {S}.tenants ADD COLUMN IF NOT EXISTS valid_until timestamptz
-- @@
CREATE OR REPLACE FUNCTION {S}.fb_tenant_set(p_slug text, p_active boolean, p_until timestamptz) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO {S}, public
AS $$
DECLARE t tenants%ROWTYPE;
BEGIN
  SELECT * INTO t FROM tenants WHERE slug = lower(coalesce(p_slug,''));
  IF NOT FOUND THEN RETURN 'not_found'; END IF;
  UPDATE tenants SET status = CASE WHEN p_active THEN 'active' ELSE 'suspended' END, valid_until = p_until WHERE id = t.id;
  IF NOT p_active THEN
    UPDATE parties SET is_active = false WHERE tenant_id = t.id;      -- party links stop opening immediately
    DELETE FROM sessions WHERE tenant_id = t.id;                       -- signed-in command rooms are kicked out
  END IF;
  RETURN CASE WHEN p_active THEN 'active' ELSE 'suspended' END;
END $$
-- @@
CREATE OR REPLACE FUNCTION {S}.fb_janitor() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO {S}, public
AS $$
DECLARE cut text := fb_cutoff(); a int; b int; c int; d int;
BEGIN
  DELETE FROM receipts WHERE coalesce(nullif(date_gregorian,''), to_char(synced_at AT TIME ZONE 'Asia/Tehran','YYYY-MM-DD')) < cut;
  GET DIAGNOSTICS a = ROW_COUNT;
  DELETE FROM accounts WHERE synced_at < now() - interval '3 days';
  GET DIAGNOSTICS b = ROW_COUNT;
  DELETE FROM sessions WHERE expires_at < now();
  GET DIAGNOSTICS c = ROW_COUNT;
  DELETE FROM login_attempts WHERE since < now() - interval '1 day';
  -- expired service (license date + 1 day, set by the panel): suspend nightly
  UPDATE parties SET is_active = false WHERE tenant_id IN (SELECT id FROM tenants WHERE status='active' AND valid_until IS NOT NULL AND valid_until < now());
  DELETE FROM sessions WHERE tenant_id IN (SELECT id FROM tenants WHERE status='active' AND valid_until IS NOT NULL AND valid_until < now());
  UPDATE tenants SET status='suspended' WHERE status='active' AND valid_until IS NOT NULL AND valid_until < now();
  GET DIAGNOSTICS d = ROW_COUNT;
  RETURN jsonb_build_object('receipts',a,'accounts',b,'sessions',c,'suspended',d);
END $$
