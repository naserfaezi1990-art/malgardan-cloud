-- Per-client (کارفرما) manager links: one login per client that sees ONLY that client's accounts and receipts.
-- The tenant-wide manager login (client_id NULL) keeps seeing everything; a client session can never open the full panel.
-- @@
CREATE TABLE IF NOT EXISTS {S}.client_logins(
  tenant_id int NOT NULL,
  client_id int NOT NULL,
  login_user text NOT NULL,
  pass_hash text NOT NULL,
  PRIMARY KEY (tenant_id, client_id)
)
-- @@
ALTER TABLE {S}.sessions ADD COLUMN IF NOT EXISTS client_id int
-- @@
CREATE OR REPLACE FUNCTION {S}.fb_new_session(p_tenant int, p_kind text, p_party int, p_client int) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO {S}, public
AS $$
DECLARE raw text := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
BEGIN
  INSERT INTO sessions(token_hash,tenant_id,kind,party_id,client_id,expires_at)
  VALUES (fb_hash(raw),p_tenant,p_kind,p_party,p_client, now() + interval '10 years');
  RETURN raw;
END $$
-- @@
CREATE OR REPLACE FUNCTION {S}.fb_client_login(p_slug text, p_client int, p_user text, p_pass text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO {S}, public
AS $$
DECLARE t tenants%ROWTYPE; c client_logins%ROWTYPE; v_k text := 'client:' || lower(coalesce(p_slug,'')) || ':' || coalesce(p_client::text,'');
BEGIN
  PERFORM fb_guard(v_k);
  SELECT * INTO t FROM tenants WHERE slug = lower(coalesce(p_slug,'')) AND status='active';
  IF FOUND THEN SELECT * INTO c FROM client_logins WHERE tenant_id=t.id AND client_id=p_client; END IF;
  IF t.id IS NULL OR c.client_id IS NULL OR c.login_user IS DISTINCT FROM p_user
     OR c.pass_hash <> crypt(coalesce(p_pass,''), c.pass_hash) THEN
    PERFORM fb_fail(v_k); RETURN NULL;
  END IF;
  DELETE FROM login_attempts WHERE login_attempts.k = v_k;
  RETURN fb_new_session(t.id,'admin',NULL,p_client);
END $$
-- @@
CREATE OR REPLACE FUNCTION {S}.fb_set_client_pass(p_key text, p_client int, p_user text, p_pass text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO {S}, public
AS $$
DECLARE t int;
BEGIN
  SELECT id INTO t FROM tenants WHERE sync_key_hash = fb_hash(p_key) AND status='active';
  IF t IS NULL THEN RAISE EXCEPTION 'invalid_key'; END IF;
  IF coalesce(p_pass,'') = '' THEN
    DELETE FROM client_logins WHERE tenant_id=t AND client_id=p_client;
  ELSE
    IF coalesce(length(p_user),0) < 3 OR length(p_pass) < 6 THEN RAISE EXCEPTION 'weak_credentials'; END IF;
    INSERT INTO client_logins(tenant_id,client_id,login_user,pass_hash) VALUES (t,p_client,p_user,crypt(p_pass, gen_salt('bf', 8)))
      ON CONFLICT (tenant_id,client_id) DO UPDATE SET login_user=EXCLUDED.login_user, pass_hash=EXCLUDED.pass_hash;
  END IF;
  DELETE FROM sessions WHERE tenant_id=t AND kind='admin' AND client_id = p_client;
  RETURN true;
END $$
-- @@
DROP FUNCTION IF EXISTS {S}.fb_admin_info(text, text)
-- @@
CREATE OR REPLACE FUNCTION {S}.fb_admin_info(p_slug text, p_session text, p_client int DEFAULT NULL)
RETURNS TABLE(tenant_name text, needs_login boolean, authorized boolean)
LANGUAGE sql SECURITY DEFINER SET search_path TO {S}, public
AS $$ SELECT t.name,
   CASE WHEN p_client IS NULL THEN t.admin_pass_hash IS NOT NULL
        ELSE EXISTS (SELECT 1 FROM client_logins c WHERE c.tenant_id=t.id AND c.client_id=p_client) END,
   EXISTS (SELECT 1 FROM sessions s WHERE s.token_hash = fb_hash(p_session) AND s.kind='admin' AND s.tenant_id=t.id
           AND s.client_id IS NOT DISTINCT FROM p_client AND s.expires_at > now())
   FROM tenants t WHERE t.slug = lower(coalesce(p_slug,'')) AND t.status='active' $$
-- @@
CREATE OR REPLACE FUNCTION {S}.fb_admin_accounts(p_session text) RETURNS SETOF {S}.accounts
LANGUAGE sql SECURITY DEFINER SET search_path TO {S}, public
AS $$ SELECT a.* FROM accounts a JOIN sessions s ON s.tenant_id = a.tenant_id
   WHERE s.token_hash = fb_hash(p_session) AND s.kind='admin' AND s.expires_at > now()
     AND (s.client_id IS NULL OR a.client_id = s.client_id)
   ORDER BY a.progress_percent ASC NULLS FIRST, a.id DESC $$
-- @@
CREATE OR REPLACE FUNCTION {S}.fb_admin_receipts(p_session text, p_date text DEFAULT NULL) RETURNS SETOF {S}.receipts
LANGUAGE sql SECURITY DEFINER SET search_path TO {S}, public
AS $$ SELECT r.* FROM receipts r JOIN sessions s ON s.tenant_id = r.tenant_id
   WHERE s.token_hash = fb_hash(p_session) AND s.kind='admin' AND s.expires_at > now()
     AND (s.client_id IS NULL OR r.client_id = s.client_id)
     AND (p_date IS NULL OR r.date_jalali = p_date) ORDER BY r.receipt_created_at DESC $$
