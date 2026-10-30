-- Account deletes (owner request 1405/08/08): when an account is deleted in Fishban the online room and the party links must lose it at once.
-- Until now the cloud only upserted accounts (an account vanished only after the 3-day janitor), so a deleted account stayed visible.
-- The app now sends  account_deletes: [account ids]  in /sync. They are applied FIRST (an id that SQLite re-used for a new account arrives
-- as an upsert in the same batch and must win), together with every receipt still stored for those accounts.
-- Older apps never send the key, so the function behaves exactly as before for them.
-- Additive (one CREATE OR REPLACE FUNCTION); safe on production. Rehearse first:
--   py migrate.py --schema fbtest --rehearse   (then --file 010_account_deletes.sql --schema public)
-- @@
CREATE OR REPLACE FUNCTION {S}.fb_sync(p_key text, p jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO {S}, public
AS $$
DECLARE t int; cut text; n_p int:=0; n_a int:=0; n_r int:=0; n_d int:=0; n_old int:=0; n_ad int:=0;
BEGIN
  SELECT id INTO t FROM tenants WHERE sync_key_hash = fb_hash(p_key) AND status='active';
  IF t IS NULL THEN RAISE EXCEPTION 'invalid_key'; END IF;
  cut := fb_cutoff();

  -- deleted accounts first: an id the app re-used for a new account is upserted below and wins
  DELETE FROM receipts WHERE tenant_id=t AND account_id IN (
    SELECT (jsonb_array_elements_text(coalesce(p->'account_deletes','[]'::jsonb)))::int);
  DELETE FROM accounts WHERE tenant_id=t AND id IN (
    SELECT (jsonb_array_elements_text(coalesce(p->'account_deletes','[]'::jsonb)))::int);
  GET DIAGNOSTICS n_ad = ROW_COUNT;

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
  RETURN jsonb_build_object('parties',n_p,'accounts',n_a,'receipts',n_r,'deleted',n_d,'expired',n_old,'accounts_deleted',n_ad);
END $$
