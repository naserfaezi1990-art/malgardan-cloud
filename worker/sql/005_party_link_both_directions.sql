-- A party's live link shows both directions: fiches the party SENT (source) and fiches/accounts that came TO it (destination).
-- Before this, a party that is only ever a destination (e.g. Taheri) saw an empty page.
-- @@
DROP FUNCTION IF EXISTS {S}.get_party_receipts(text)
-- @@
CREATE OR REPLACE FUNCTION {S}.get_party_receipts(p_token text)
RETURNS TABLE(account_id integer, owner_name text, payer_name text, amount bigint, tracking_code text, status text, date_jalali text, date_gregorian text, receipt_created_at text, direction text)
LANGUAGE sql SECURITY DEFINER SET search_path TO {S}, public
AS $$ SELECT r.account_id, r.account_owner, r.payer_name, r.amount, r.tracking_code, r.status, r.date_jalali, r.date_gregorian, r.receipt_created_at,
          CASE WHEN r.source_party_id = p.id THEN 'out' ELSE 'in' END
   FROM receipts r JOIN parties p ON p.tenant_id = r.tenant_id AND (p.id = r.source_party_id OR p.id = r.destination_party_id)
   WHERE p.monitor_token = p_token AND p.is_active ORDER BY r.receipt_created_at DESC $$
-- @@
CREATE OR REPLACE FUNCTION {S}.get_party_accounts(p_token text)
RETURNS TABLE(account_id integer, owner_name text, client_name text, target_amount bigint, confirmed_total bigint, remaining_amount bigint, progress_percent integer, status text, last_receipt_at text, party_name text, valid_jalali text)
LANGUAGE sql SECURITY DEFINER SET search_path TO {S}, public
AS $$ SELECT DISTINCT a.id, a.owner_name, a.client_name, a.target_amount, a.confirmed_total, a.remaining_amount, a.progress_percent, a.status, a.last_receipt_at, p.name, a.valid_jalali
   FROM parties p JOIN accounts a ON a.tenant_id = p.tenant_id AND (a.source_party_id = p.id OR a.destination_party_id = p.id OR EXISTS (
     SELECT 1 FROM receipts r WHERE r.tenant_id = a.tenant_id AND r.account_id = a.id AND (r.source_party_id = p.id OR r.destination_party_id = p.id)))
   WHERE p.monitor_token = p_token AND p.is_active $$
