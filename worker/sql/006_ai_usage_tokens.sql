-- Per-call token accounting for the AI gateway: what each customer really costs (calls alone say nothing about price).
-- One row per tenant / day / call kind (fiche, details, account, text, other) / model. Additive; safe to run on production.
-- @@
CREATE TABLE IF NOT EXISTS {S}.ai_usage_kind(
  tenant_id int NOT NULL,
  day date NOT NULL,
  kind text NOT NULL,
  model text NOT NULL DEFAULT '',
  calls int NOT NULL DEFAULT 0,
  tokens_in bigint NOT NULL DEFAULT 0,
  tokens_out bigint NOT NULL DEFAULT 0,
  tokens_think bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, day, kind, model)
)
-- @@
CREATE OR REPLACE FUNCTION {S}.fb_ai_usage(p_tenant int, p_kind text, p_model text, p_in bigint, p_out bigint, p_think bigint) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path TO {S}, public
AS $$ INSERT INTO ai_usage_kind(tenant_id,day,kind,model,calls,tokens_in,tokens_out,tokens_think)
      VALUES (p_tenant,(now() AT TIME ZONE 'Asia/Tehran')::date,left(coalesce(nullif(p_kind,''),'other'),20),left(coalesce(p_model,''),40),1,
              greatest(coalesce(p_in,0),0),greatest(coalesce(p_out,0),0),greatest(coalesce(p_think,0),0))
      ON CONFLICT (tenant_id,day,kind,model) DO UPDATE SET calls=ai_usage_kind.calls+1,
        tokens_in=ai_usage_kind.tokens_in+excluded.tokens_in, tokens_out=ai_usage_kind.tokens_out+excluded.tokens_out,
        tokens_think=ai_usage_kind.tokens_think+excluded.tokens_think $$
-- @@
-- Same connect code running on two computers at once (copied data folder): each install sends a machine-derived id with /sync;
-- the app shows a warning when another device used the same key in the last 30 minutes.
CREATE TABLE IF NOT EXISTS {S}.tenant_devices(
  tenant_id int NOT NULL,
  install_id text NOT NULL,
  first_seen timestamptz NOT NULL DEFAULT now(),
  last_seen timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, install_id)
)
-- @@
CREATE OR REPLACE FUNCTION {S}.fb_device_seen(p_key text, p_install text) RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO {S}, public
AS $$
DECLARE t int; n int;
BEGIN
  SELECT id INTO t FROM tenants WHERE sync_key_hash = fb_hash(p_key) AND status='active';
  IF NOT FOUND OR p_install !~ '^[0-9a-f]{8,40}$' THEN RETURN 0; END IF;
  INSERT INTO tenant_devices(tenant_id, install_id) VALUES (t, p_install)
    ON CONFLICT (tenant_id, install_id) DO UPDATE SET last_seen = now();
  DELETE FROM tenant_devices WHERE tenant_id = t AND last_seen < now() - interval '30 days';
  SELECT count(*) INTO n FROM tenant_devices WHERE tenant_id = t AND install_id <> p_install AND last_seen > now() - interval '30 minutes';
  RETURN n;
END $$
