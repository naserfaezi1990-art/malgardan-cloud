-- Device limit enforced by the cloud: one connect code works on at most `max_devices` computers (default 2: main PC + a spare).
-- A copied install / leaked connect code on a third PC is refused by /sync and /gemini/generate (the AI "eye" needs this server).
-- Old apps (no X-Install-Id) keep working until the owner sets require_install_id=true for that customer. Additive; safe on production;
-- rehearse first:  py migrate.py --schema fbtest --rehearse   (then --file 008_device_limit.sql --schema public)
-- @@
ALTER TABLE {S}.tenants ADD COLUMN IF NOT EXISTS max_devices int NOT NULL DEFAULT 2
-- @@
ALTER TABLE {S}.tenants ADD COLUMN IF NOT EXISTS require_install_id boolean NOT NULL DEFAULT false
-- @@
CREATE OR REPLACE FUNCTION {S}.fb_device_gate(p_key text, p_install text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO {S}, public
AS $$
DECLARE t tenants%ROWTYPE; known boolean; n int;
BEGIN
  SELECT * INTO t FROM tenants WHERE sync_key_hash = fb_hash(p_key) AND status = 'active';
  IF NOT FOUND THEN RETURN 'unknown_key'; END IF;
  IF p_install IS NULL OR p_install !~ '^[0-9a-f]{8,40}$' THEN
    RETURN CASE WHEN t.require_install_id THEN 'need_install_id' ELSE 'ok' END;
  END IF;
  DELETE FROM tenant_devices WHERE tenant_id = t.id AND last_seen < now() - interval '30 days';
  SELECT EXISTS (SELECT 1 FROM tenant_devices WHERE tenant_id = t.id AND install_id = p_install) INTO known;
  IF known THEN
    UPDATE tenant_devices SET last_seen = now() WHERE tenant_id = t.id AND install_id = p_install;
    RETURN 'ok';
  END IF;
  SELECT count(*) INTO n FROM tenant_devices WHERE tenant_id = t.id;
  IF n >= t.max_devices THEN RETURN 'limit'; END IF;
  INSERT INTO tenant_devices(tenant_id, install_id) VALUES (t.id, p_install);
  RETURN 'ok';
END $$
