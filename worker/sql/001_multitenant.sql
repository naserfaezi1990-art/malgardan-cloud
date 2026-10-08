-- Fishban cloud: multi-tenant mirror (additive migration)
-- {S} is the schema name (public in production, fbtest when rehearsing). Statements are separated by a marker line (see migrate.py).
-- The cloud is a 2-day LIVE MIRROR, not an archive: every receipt older than yesterday (Tehran) is dropped.
-- @@
CREATE EXTENSION IF NOT EXISTS pgcrypto
-- @@
CREATE TABLE IF NOT EXISTS {S}.tenants(
  id serial PRIMARY KEY,
  slug text NOT NULL UNIQUE,
  name text NOT NULL,
  sync_key_hash text NOT NULL UNIQUE,
  admin_user text,
  admin_pass_hash text,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now()
)
-- @@
CREATE TABLE IF NOT EXISTS {S}.sessions(
  token_hash text PRIMARY KEY,
  tenant_id int NOT NULL,
  kind text NOT NULL,
  party_id int,
  expires_at timestamptz NOT NULL
)
-- @@
CREATE TABLE IF NOT EXISTS {S}.login_attempts(
  k text PRIMARY KEY,
  fails int NOT NULL DEFAULT 0,
  since timestamptz NOT NULL DEFAULT now()
)
-- @@
ALTER TABLE {S}.parties ADD COLUMN IF NOT EXISTS tenant_id int NOT NULL DEFAULT 1
-- @@
ALTER TABLE {S}.parties ADD COLUMN IF NOT EXISTS login_user text
-- @@
ALTER TABLE {S}.parties ADD COLUMN IF NOT EXISTS pass_hash text
-- @@
ALTER TABLE {S}.accounts ADD COLUMN IF NOT EXISTS tenant_id int NOT NULL DEFAULT 1
-- @@
ALTER TABLE {S}.receipts ADD COLUMN IF NOT EXISTS tenant_id int NOT NULL DEFAULT 1
-- @@
ALTER TABLE {S}.parties DROP CONSTRAINT IF EXISTS parties_pkey
-- @@
ALTER TABLE {S}.parties ADD PRIMARY KEY (tenant_id, id)
-- @@
ALTER TABLE {S}.accounts DROP CONSTRAINT IF EXISTS accounts_pkey
-- @@
ALTER TABLE {S}.accounts ADD PRIMARY KEY (tenant_id, id)
-- @@
CREATE INDEX IF NOT EXISTS idx_receipts_tenant_date ON {S}.receipts(tenant_id, date_gregorian)
-- @@
CREATE INDEX IF NOT EXISTS idx_receipts_tenant_party ON {S}.receipts(tenant_id, source_party_id)
-- @@
CREATE INDEX IF NOT EXISTS idx_accounts_tenant ON {S}.accounts(tenant_id)
-- @@
CREATE OR REPLACE FUNCTION {S}.fb_hash(p text) RETURNS text LANGUAGE sql IMMUTABLE
AS $$ SELECT encode(sha256(convert_to(coalesce(p,''),'UTF8')),'hex') $$
-- @@
CREATE OR REPLACE FUNCTION {S}.fb_cutoff() RETURNS text LANGUAGE sql STABLE
AS $$ SELECT to_char((now() AT TIME ZONE 'Asia/Tehran')::date - 1, 'YYYY-MM-DD') $$
-- @@
CREATE OR REPLACE FUNCTION {S}.fb_sync(p_key text, p jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO {S}, public
AS $$
DECLARE t int; cut text; n_p int:=0; n_a int:=0; n_r int:=0; n_d int:=0; n_old int:=0;
BEGIN
  SELECT id INTO t FROM tenants WHERE sync_key_hash = fb_hash(p_key) AND status='active';
  IF t IS NULL THEN RAISE EXCEPTION 'invalid_key'; END IF;
  cut := fb_cutoff();

  INSERT INTO parties(tenant_id,id,client_id,client_name,name,monitor_token,is_active,synced_at)
  SELECT t,x.id,x.client_id,coalesce(x.client_name,''),x.name,x.monitor_token,true,now()
  FROM jsonb_to_recordset(coalesce(p->'parties','[]'::jsonb)) AS x(id int,client_id int,client_name text,name text,monitor_token text)
  ON CONFLICT (tenant_id,id) DO UPDATE SET client_id=EXCLUDED.client_id, client_name=EXCLUDED.client_name,
    name=EXCLUDED.name, monitor_token=EXCLUDED.monitor_token, is_active=true, synced_at=now();
  GET DIAGNOSTICS n_p = ROW_COUNT;

  INSERT INTO accounts(tenant_id,id,client_id,client_name,owner_name,bank_name,account_number,account_type,has_limit,target_amount,
    status,source_party_id,source_party_name,destination_party_id,destination_party_name,valid_jalali,valid_gregorian,
    confirmed_total,allocated_total,remaining_amount,progress_percent,receipt_count,last_receipt_at,account_created_at,synced_at)
  SELECT t,x.id,x.client_id,coalesce(x.client_name,''),coalesce(x.owner_name,''),x.bank_name,x.account_number,x.account_type,
    coalesce(x.has_limit,false),coalesce(x.target_amount,0),x.status,x.source_party_id,x.source_party_name,x.destination_party_id,
    coalesce(x.destination_party_name,''),x.valid_jalali,x.valid_gregorian,coalesce(x.confirmed_total,0),coalesce(x.allocated_total,0),
    x.remaining_amount,x.progress_percent,coalesce(x.receipt_count,0),x.last_receipt_at,coalesce(x.account_created_at,''),now()
  FROM jsonb_to_recordset(coalesce(p->'accounts','[]'::jsonb)) AS x(id int,client_id int,client_name text,owner_name text,bank_name text,
    account_number text,account_type text,has_limit boolean,target_amount bigint,status text,source_party_id int,source_party_name text,
    destination_party_id int,destination_party_name text,valid_jalali text,valid_gregorian text,confirmed_total bigint,allocated_total bigint,
    remaining_amount bigint,progress_percent int,receipt_count int,last_receipt_at text,account_created_at text)
  ON CONFLICT (tenant_id,id) DO UPDATE SET client_id=EXCLUDED.client_id, client_name=EXCLUDED.client_name, owner_name=EXCLUDED.owner_name,
    bank_name=EXCLUDED.bank_name, account_number=EXCLUDED.account_number, account_type=EXCLUDED.account_type, has_limit=EXCLUDED.has_limit,
    target_amount=EXCLUDED.target_amount, status=EXCLUDED.status, source_party_id=EXCLUDED.source_party_id,
    source_party_name=EXCLUDED.source_party_name, destination_party_id=EXCLUDED.destination_party_id,
    destination_party_name=EXCLUDED.destination_party_name, valid_jalali=EXCLUDED.valid_jalali, valid_gregorian=EXCLUDED.valid_gregorian,
    confirmed_total=EXCLUDED.confirmed_total, allocated_total=EXCLUDED.allocated_total, remaining_amount=EXCLUDED.remaining_amount,
    progress_percent=EXCLUDED.progress_percent, receipt_count=EXCLUDED.receipt_count, last_receipt_at=EXCLUDED.last_receipt_at,
    account_created_at=EXCLUDED.account_created_at, synced_at=now();
  GET DIAGNOSTICS n_a = ROW_COUNT;

  -- receipts older than the 2-day window are never stored (a big history re-sync must not fill the cloud)
  INSERT INTO receipts(tenant_id,sync_uuid,receipt_id,account_id,account_owner,client_id,client_name,source_party_id,source_party_name,
    destination_party_id,destination_party_name,payer_name,amount,tracking_code,status,date_gregorian,date_jalali,receipt_created_at,synced_at)
  SELECT t,x.sync_uuid,x.receipt_id,x.account_id,coalesce(x.account_owner,''),x.client_id,coalesce(x.client_name,''),x.source_party_id,
    x.source_party_name,x.destination_party_id,coalesce(x.destination_party_name,''),x.payer_name,x.amount,x.tracking_code,x.status,
    x.date_gregorian,x.date_jalali,x.receipt_created_at,now()
  FROM jsonb_to_recordset(coalesce(p->'receipts','[]'::jsonb)) AS x(sync_uuid uuid,receipt_id int,account_id int,account_owner text,client_id int,
    client_name text,source_party_id int,source_party_name text,destination_party_id int,destination_party_name text,payer_name text,
    amount bigint,tracking_code text,status text,date_gregorian text,date_jalali text,receipt_created_at text)
  WHERE coalesce(nullif(x.date_gregorian,''), to_char(now() AT TIME ZONE 'Asia/Tehran','YYYY-MM-DD')) >= cut
  ON CONFLICT (sync_uuid) DO UPDATE SET receipt_id=EXCLUDED.receipt_id, account_id=EXCLUDED.account_id, account_owner=EXCLUDED.account_owner,
    client_id=EXCLUDED.client_id, client_name=EXCLUDED.client_name, source_party_id=EXCLUDED.source_party_id,
    source_party_name=EXCLUDED.source_party_name, destination_party_id=EXCLUDED.destination_party_id,
    destination_party_name=EXCLUDED.destination_party_name, payer_name=EXCLUDED.payer_name, amount=EXCLUDED.amount,
    tracking_code=EXCLUDED.tracking_code, status=EXCLUDED.status, date_gregorian=EXCLUDED.date_gregorian, date_jalali=EXCLUDED.date_jalali,
    receipt_created_at=EXCLUDED.receipt_created_at, synced_at=now()
  WHERE receipts.tenant_id = t;
  GET DIAGNOSTICS n_r = ROW_COUNT;

  DELETE FROM receipts WHERE tenant_id=t AND sync_uuid IN (
    SELECT (jsonb_array_elements_text(coalesce(p->'deletes','[]'::jsonb)))::uuid);
  GET DIAGNOSTICS n_d = ROW_COUNT;

  -- 2-day mirror: drop what fell out of the window
  DELETE FROM receipts WHERE tenant_id=t AND coalesce(nullif(date_gregorian,''), to_char(synced_at AT TIME ZONE 'Asia/Tehran','YYYY-MM-DD')) < cut;
  GET DIAGNOSTICS n_old = ROW_COUNT;
  DELETE FROM accounts WHERE tenant_id=t AND synced_at < now() - interval '3 days';
  DELETE FROM sessions WHERE expires_at < now();
  RETURN jsonb_build_object('parties',n_p,'accounts',n_a,'receipts',n_r,'deleted',n_d,'expired',n_old);
END $$
-- @@
CREATE OR REPLACE FUNCTION {S}.fb_janitor() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO {S}, public
AS $$
DECLARE cut text := fb_cutoff(); a int; b int; c int;
BEGIN
  DELETE FROM receipts WHERE coalesce(nullif(date_gregorian,''), to_char(synced_at AT TIME ZONE 'Asia/Tehran','YYYY-MM-DD')) < cut;
  GET DIAGNOSTICS a = ROW_COUNT;
  DELETE FROM accounts WHERE synced_at < now() - interval '3 days';
  GET DIAGNOSTICS b = ROW_COUNT;
  DELETE FROM sessions WHERE expires_at < now();
  GET DIAGNOSTICS c = ROW_COUNT;
  DELETE FROM login_attempts WHERE since < now() - interval '1 day';
  RETURN jsonb_build_object('receipts',a,'accounts',b,'sessions',c);
END $$
-- @@
CREATE OR REPLACE FUNCTION {S}.fb_new_session(p_tenant int, p_kind text, p_party int) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO {S}, public
AS $$
DECLARE raw text := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
BEGIN
  INSERT INTO sessions(token_hash,tenant_id,kind,party_id,expires_at) VALUES (fb_hash(raw),p_tenant,p_kind,p_party, now() + interval '12 hours');
  RETURN raw;
END $$
-- @@
CREATE OR REPLACE FUNCTION {S}.fb_guard(p_k text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO {S}, public
AS $$
DECLARE r login_attempts%ROWTYPE;
BEGIN
  SELECT * INTO r FROM login_attempts WHERE k=p_k;
  IF FOUND AND r.since > now() - interval '15 minutes' AND r.fails >= 5 THEN RAISE EXCEPTION 'locked'; END IF;
END $$
-- @@
CREATE OR REPLACE FUNCTION {S}.fb_fail(p_k text) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path TO {S}, public
AS $$ INSERT INTO login_attempts(k,fails,since) VALUES (p_k,1,now())
   ON CONFLICT (k) DO UPDATE SET fails = CASE WHEN login_attempts.since < now() - interval '15 minutes' THEN 1 ELSE login_attempts.fails + 1 END,
                                  since = CASE WHEN login_attempts.since < now() - interval '15 minutes' THEN now() ELSE login_attempts.since END $$
-- @@
CREATE OR REPLACE FUNCTION {S}.fb_admin_login(p_slug text, p_user text, p_pass text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO {S}, public
AS $$
DECLARE t tenants%ROWTYPE; v_k text := 'admin:' || lower(coalesce(p_slug,''));
BEGIN
  PERFORM fb_guard(v_k);
  SELECT * INTO t FROM tenants WHERE slug = lower(coalesce(p_slug,'')) AND status='active';
  IF NOT FOUND OR t.admin_pass_hash IS NULL OR t.admin_user IS DISTINCT FROM p_user
     OR t.admin_pass_hash <> crypt(coalesce(p_pass,''), t.admin_pass_hash) THEN
    PERFORM fb_fail(v_k); RETURN NULL;  -- no RAISE here: it would roll the failure counter back
  END IF;
  DELETE FROM login_attempts WHERE login_attempts.k = v_k;
  RETURN fb_new_session(t.id,'admin',NULL);
END $$
-- @@
CREATE OR REPLACE FUNCTION {S}.fb_party_login(p_token text, p_user text, p_pass text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO {S}, public
AS $$
DECLARE p parties%ROWTYPE; v_k text := 'party:' || coalesce(p_token,'');
BEGIN
  PERFORM fb_guard(v_k);
  SELECT * INTO p FROM parties WHERE monitor_token = p_token AND is_active;
  IF NOT FOUND OR p.pass_hash IS NULL OR p.login_user IS DISTINCT FROM p_user
     OR p.pass_hash <> crypt(coalesce(p_pass,''), p.pass_hash) THEN
    PERFORM fb_fail(v_k); RETURN NULL;
  END IF;
  DELETE FROM login_attempts WHERE login_attempts.k = v_k;
  RETURN fb_new_session(p.tenant_id,'party',p.id);
END $$
-- @@
CREATE OR REPLACE FUNCTION {S}.fb_set_admin(p_key text, p_user text, p_pass text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO {S}, public
AS $$
DECLARE t int;
BEGIN
  SELECT id INTO t FROM tenants WHERE sync_key_hash = fb_hash(p_key) AND status='active';
  IF t IS NULL THEN RAISE EXCEPTION 'invalid_key'; END IF;
  IF coalesce(length(p_user),0) < 3 OR coalesce(length(p_pass),0) < 6 THEN RAISE EXCEPTION 'weak_credentials'; END IF;
  UPDATE tenants SET admin_user=p_user, admin_pass_hash=crypt(p_pass, gen_salt('bf', 8)) WHERE id=t;
  DELETE FROM sessions WHERE tenant_id=t AND kind='admin';
  RETURN true;
END $$
-- @@
CREATE OR REPLACE FUNCTION {S}.fb_set_party_pass(p_key text, p_party int, p_user text, p_pass text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO {S}, public
AS $$
DECLARE t int;
BEGIN
  SELECT id INTO t FROM tenants WHERE sync_key_hash = fb_hash(p_key) AND status='active';
  IF t IS NULL THEN RAISE EXCEPTION 'invalid_key'; END IF;
  IF coalesce(p_pass,'') = '' THEN
    UPDATE parties SET login_user=NULL, pass_hash=NULL WHERE tenant_id=t AND id=p_party;
  ELSE
    IF coalesce(length(p_user),0) < 3 OR length(p_pass) < 6 THEN RAISE EXCEPTION 'weak_credentials'; END IF;
    UPDATE parties SET login_user=p_user, pass_hash=crypt(p_pass, gen_salt('bf', 8)) WHERE tenant_id=t AND id=p_party;
  END IF;
  DELETE FROM sessions WHERE tenant_id=t AND kind='party' AND party_id=p_party;
  RETURN FOUND;
END $$
-- @@
CREATE OR REPLACE FUNCTION {S}.fb_session_ok(p_session text, p_kind text, p_tenant int, p_party int) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO {S}, public
AS $$ SELECT EXISTS (SELECT 1 FROM sessions s WHERE s.token_hash = fb_hash(p_session) AND s.kind=p_kind AND s.tenant_id=p_tenant
   AND (p_party IS NULL OR s.party_id=p_party) AND s.expires_at > now()) $$
-- @@
DROP FUNCTION IF EXISTS {S}.get_party_info(text)
-- @@
CREATE OR REPLACE FUNCTION {S}.get_party_info(p_token text, p_session text DEFAULT NULL)
RETURNS TABLE(party_id integer, party_name text, client_name text, needs_login boolean, authorized boolean)
LANGUAGE sql SECURITY DEFINER SET search_path TO {S}, public
AS $$ SELECT p.id, p.name, p.client_name, p.pass_hash IS NOT NULL,
   (p.pass_hash IS NULL OR fb_session_ok(p_session,'party',p.tenant_id,p.id))
   FROM parties p WHERE p.monitor_token = p_token AND p.is_active $$
-- @@
CREATE OR REPLACE FUNCTION {S}.get_party_receipts(p_token text)
RETURNS TABLE(account_id integer, owner_name text, payer_name text, amount bigint, tracking_code text, status text, date_jalali text, date_gregorian text, receipt_created_at text)
LANGUAGE sql SECURITY DEFINER SET search_path TO {S}, public
AS $$ SELECT r.account_id, r.account_owner, r.payer_name, r.amount, r.tracking_code, r.status, r.date_jalali, r.date_gregorian, r.receipt_created_at
   FROM receipts r JOIN parties p ON p.tenant_id = r.tenant_id AND p.id = r.source_party_id
   WHERE p.monitor_token = p_token AND p.is_active ORDER BY r.receipt_created_at DESC $$
-- @@
CREATE OR REPLACE FUNCTION {S}.get_party_accounts(p_token text)
RETURNS TABLE(account_id integer, owner_name text, client_name text, target_amount bigint, confirmed_total bigint, remaining_amount bigint, progress_percent integer, status text, last_receipt_at text, party_name text, valid_jalali text)
LANGUAGE sql SECURITY DEFINER SET search_path TO {S}, public
AS $$ SELECT DISTINCT a.id, a.owner_name, a.client_name, a.target_amount, a.confirmed_total, a.remaining_amount, a.progress_percent, a.status, a.last_receipt_at, p.name, a.valid_jalali
   FROM parties p JOIN accounts a ON a.tenant_id = p.tenant_id AND (a.source_party_id = p.id OR EXISTS (
     SELECT 1 FROM receipts r WHERE r.tenant_id = a.tenant_id AND r.account_id = a.id AND r.source_party_id = p.id))
   WHERE p.monitor_token = p_token AND p.is_active $$
-- @@
CREATE OR REPLACE FUNCTION {S}.fb_admin_info(p_slug text, p_session text)
RETURNS TABLE(tenant_name text, needs_login boolean, authorized boolean)
LANGUAGE sql SECURITY DEFINER SET search_path TO {S}, public
AS $$ SELECT t.name, t.admin_pass_hash IS NOT NULL, fb_session_ok(p_session,'admin',t.id,NULL) FROM tenants t WHERE t.slug = lower(coalesce(p_slug,'')) AND t.status='active' $$
-- @@
CREATE OR REPLACE FUNCTION {S}.fb_admin_accounts(p_session text) RETURNS SETOF {S}.accounts
LANGUAGE sql SECURITY DEFINER SET search_path TO {S}, public
AS $$ SELECT a.* FROM accounts a JOIN sessions s ON s.tenant_id = a.tenant_id
   WHERE s.token_hash = fb_hash(p_session) AND s.kind='admin' AND s.expires_at > now()
   ORDER BY a.progress_percent ASC NULLS FIRST, a.id DESC $$
-- @@
CREATE OR REPLACE FUNCTION {S}.fb_admin_receipts(p_session text, p_date text DEFAULT NULL) RETURNS SETOF {S}.receipts
LANGUAGE sql SECURITY DEFINER SET search_path TO {S}, public
AS $$ SELECT r.* FROM receipts r JOIN sessions s ON s.tenant_id = r.tenant_id
   WHERE s.token_hash = fb_hash(p_session) AND s.kind='admin' AND s.expires_at > now()
     AND (p_date IS NULL OR r.date_jalali = p_date) ORDER BY r.receipt_created_at DESC $$
-- @@
-- legacy single-token admin link: tenant 1 only, and only until its owner sets a real login
CREATE OR REPLACE FUNCTION {S}.is_valid_admin_token(p_token text) RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path TO {S}, public
AS $$ SELECT p_token = (SELECT value FROM app_settings WHERE key='admin_token')
   AND NOT EXISTS (SELECT 1 FROM tenants WHERE id=1 AND admin_pass_hash IS NOT NULL) $$
-- @@
CREATE OR REPLACE FUNCTION {S}.get_admin_accounts(p_token text) RETURNS SETOF {S}.accounts
LANGUAGE sql SECURITY DEFINER SET search_path TO {S}, public
AS $$ SELECT a.* FROM accounts a WHERE a.tenant_id=1 AND is_valid_admin_token(p_token) ORDER BY a.progress_percent ASC NULLS FIRST, a.id DESC $$
-- @@
CREATE OR REPLACE FUNCTION {S}.get_admin_receipts(p_token text, p_date text DEFAULT NULL) RETURNS SETOF {S}.receipts
LANGUAGE sql SECURITY DEFINER SET search_path TO {S}, public
AS $$ SELECT r.* FROM receipts r WHERE r.tenant_id=1 AND is_valid_admin_token(p_token) AND (p_date IS NULL OR r.date_jalali = p_date) ORDER BY r.receipt_created_at DESC $$
