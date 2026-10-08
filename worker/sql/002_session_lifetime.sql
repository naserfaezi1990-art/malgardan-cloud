-- Remember-me: a manager/party logs in once per device and stays signed in (no practical expiry).
-- Changing the password (fb_set_admin / fb_set_party_pass) already deletes every session of that scope, so it revokes devices.
-- @@
CREATE OR REPLACE FUNCTION {S}.fb_new_session(p_tenant int, p_kind text, p_party int) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO {S}, public
AS $$
DECLARE raw text := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
BEGIN
  INSERT INTO sessions(token_hash,tenant_id,kind,party_id,expires_at)
  VALUES (fb_hash(raw),p_tenant,p_kind,p_party, now() + interval '10 years');  -- effectively "stay signed in on this device"
  RETURN raw;
END $$
