"""Behaviour tests for the multi-tenant functions, run against the scratch schema (never public).
  py migrate.py --schema fbtest --rehearse ; py test_fbtest.py
"""
import json, sys, uuid, datetime
sys.stdout.reconfigure(encoding="utf-8")
from migrate import connection_string, query

S = "fbtest"
cs = connection_string()
n = 0


def q(sql, params=None):
    return query(cs, sql.replace("{S}", S), params)


def check(cond, label):
    global n
    n += 1
    if not cond:
        raise SystemExit("FAIL: " + label)


def raises(fn, needle):
    try:
        fn()
    except RuntimeError as e:
        return needle in str(e)
    return False


def fb_hash(p):
    import hashlib
    return hashlib.sha256(p.encode()).hexdigest()


tehran_today = (datetime.datetime.utcnow() + datetime.timedelta(hours=3, minutes=30)).date()
D0, D1, D3 = (str(tehran_today - datetime.timedelta(days=d)) for d in (0, 1, 3))

q("DELETE FROM {S}.receipts"); q("DELETE FROM {S}.accounts"); q("DELETE FROM {S}.parties"); q("DELETE FROM {S}.tenants")
q("DELETE FROM {S}.sessions"); q("DELETE FROM {S}.login_attempts"); q("DELETE FROM {S}.app_settings")
KA, KB = "key-a-" + uuid.uuid4().hex, "key-b-" + uuid.uuid4().hex
q("INSERT INTO {S}.tenants(id,slug,name,sync_key_hash) VALUES (1,'owner','Owner',$1),(2,'beta','Beta Co',$2)", [fb_hash(KA), fb_hash(KB)])


def payload(pid_name, token, d_new, d_old):
    return {"parties": [{"id": 1, "client_id": 1, "client_name": "C", "name": pid_name, "monitor_token": token}],
            "accounts": [{"id": 1, "client_id": 1, "client_name": "C", "owner_name": "O", "bank_name": "B", "account_number": "1",
                          "account_type": "daily", "has_limit": True, "target_amount": 1000, "status": "active", "source_party_id": 1,
                          "source_party_name": pid_name, "destination_party_id": 2, "destination_party_name": "D", "valid_jalali": "1405/07/15",
                          "valid_gregorian": d_new, "confirmed_total": 0, "allocated_total": 0, "remaining_amount": 1000, "progress_percent": 0,
                          "receipt_count": 0, "last_receipt_at": None, "account_created_at": "x"}],
            "receipts": [{"sync_uuid": str(uuid.uuid4()), "receipt_id": 1, "account_id": 1, "account_owner": "O", "client_id": 1, "client_name": "C",
                          "source_party_id": 1, "source_party_name": pid_name, "destination_party_id": 2, "destination_party_name": "D",
                          "payer_name": "p", "amount": 500, "tracking_code": "t", "status": "confirmed", "date_gregorian": d_new,
                          "date_jalali": "1405/07/15", "receipt_created_at": d_new + " 10:00:00"},
                         {"sync_uuid": str(uuid.uuid4()), "receipt_id": 2, "account_id": 1, "account_owner": "O", "client_id": 1, "client_name": "C",
                          "source_party_id": 1, "source_party_name": pid_name, "destination_party_id": 2, "destination_party_name": "D",
                          "payer_name": "old", "amount": 7, "tracking_code": "o", "status": "confirmed", "date_gregorian": d_old,
                          "date_jalali": "1405/07/10", "receipt_created_at": d_old + " 10:00:00"}]}


# the same local ids (party 1, account 1) in two tenants must not collide
ra = q("SELECT {S}.fb_sync($1,$2::jsonb) r", [KA, json.dumps(payload("PartyA", "aaaaaaaaaaaaaa", D0, D3))])[0]["r"]
rb = q("SELECT {S}.fb_sync($1,$2::jsonb) r", [KB, json.dumps(payload("PartyB", "bbbbbbbbbbbbbb", D1, D3))])[0]["r"]
check(ra["receipts"] == 1 and rb["receipts"] == 1, f"only receipts inside the 2-day window are stored: {ra} {rb}")
check(q("SELECT count(*) c FROM {S}.parties")[0]["c"] == "2", "same party id in two tenants coexists")
check(q("SELECT count(*) c FROM {S}.accounts")[0]["c"] == "2", "same account id in two tenants coexists")
check(raises(lambda: q("SELECT {S}.fb_sync('wrong-key','{}'::jsonb)"), "invalid_key"), "wrong sync key is refused")
q("UPDATE {S}.tenants SET status='suspended' WHERE id=2")
check(raises(lambda: q("SELECT {S}.fb_sync($1,'{}'::jsonb)", [KB]), "invalid_key"), "suspended tenant cannot sync")
q("UPDATE {S}.tenants SET status='active' WHERE id=2")

# party view is isolated per token
ra = q("SELECT * FROM {S}.get_party_receipts('aaaaaaaaaaaaaa')")
check(len(ra) == 1 and ra[0]["payer_name"] == "p", f"party A sees only its own receipt: {ra}")
check(len(q("SELECT * FROM {S}.get_party_accounts('bbbbbbbbbbbbbb')")) == 1, "party B sees its own account")
info = q("SELECT * FROM {S}.get_party_info('aaaaaaaaaaaaaa')")[0]
check(info["needs_login"] is False and info["authorized"] is True, "party without a password opens freely")

# retention: re-syncing the same old receipt does not re-store it; janitor drops what aged out
old_uuid = str(uuid.uuid4())
q("INSERT INTO {S}.receipts(tenant_id,sync_uuid,receipt_id,account_id,account_owner,client_id,client_name,destination_party_id,destination_party_name,amount,status,date_gregorian,date_jalali,receipt_created_at,synced_at) VALUES (1,$1,9,1,'O',1,'C',2,'D',5,'confirmed',$2,'x','x',now())", [old_uuid, D3])
j = q("SELECT {S}.fb_janitor() r")[0]["r"]
check(j["receipts"] >= 1 and q("SELECT count(*) c FROM {S}.receipts WHERE sync_uuid=$1", [old_uuid])[0]["c"] == "0", f"janitor drops receipts older than yesterday: {j}")

# deletes are tenant-scoped
sid = q("SELECT sync_uuid FROM {S}.receipts WHERE tenant_id=2")[0]["sync_uuid"]
q("SELECT {S}.fb_sync($1,$2::jsonb)", [KA, json.dumps({"deletes": [sid]})])
check(q("SELECT count(*) c FROM {S}.receipts WHERE tenant_id=2")[0]["c"] == "1", "tenant A cannot delete tenant B's receipt")
q("SELECT {S}.fb_sync($1,$2::jsonb)", [KB, json.dumps({"deletes": [sid]})])
check(q("SELECT count(*) c FROM {S}.receipts WHERE tenant_id=2")[0]["c"] == "0", "owner tenant can delete its own receipt")

# admin login: weak credentials refused, good ones work, wrong ones lock out, tenants are isolated
check(raises(lambda: q("SELECT {S}.fb_set_admin($1,'ab','123')", [KA]), "weak_credentials"), "weak admin credentials refused")
check(raises(lambda: q("SELECT {S}.fb_set_admin('nope','admin','secret123')"), "invalid_key"), "set_admin needs a valid key")
q("SELECT {S}.fb_set_admin($1,'amir','secret123')", [KA])
check(q("SELECT admin_pass_hash FROM {S}.tenants WHERE id=1")[0]["admin_pass_hash"].startswith("$2"), "password stored as bcrypt")
check("secret123" not in json.dumps(q("SELECT * FROM {S}.tenants")), "plain password is not stored")
ok = q("SELECT * FROM {S}.fb_admin_info('owner', NULL)")[0]
check(ok["needs_login"] is True and ok["authorized"] is False, "admin page asks for login")
tok = q("SELECT {S}.fb_admin_login('owner','amir','secret123') t")[0]["t"]
check(len(tok) == 64, "login returns a session token")
check(q("SELECT * FROM {S}.fb_admin_info('owner',$1)", [tok])[0]["authorized"] is True, "session authorizes the admin page")
check(len(q("SELECT * FROM {S}.fb_admin_accounts($1)", [tok])) == 1, "admin sees only its tenant's accounts")
check(len(q("SELECT * FROM {S}.fb_admin_receipts($1,NULL)", [tok])) == 1, "admin sees only its tenant's receipts")
check(q("SELECT * FROM {S}.fb_admin_accounts('bogus')") == [], "bogus session sees nothing")
check(q("SELECT * FROM {S}.fb_admin_info('beta',$1)", [tok])[0]["authorized"] is False, "owner's session does not open another tenant's panel")
for _ in range(5):
    check(q("SELECT {S}.fb_admin_login('owner','amir','wrong-pass') t")[0]["t"] is None, "wrong admin password returns no session")
check(raises(lambda: q("SELECT {S}.fb_admin_login('owner','amir','secret123')"), "locked"), "5 wrong passwords lock the login (even the right one)")
q("DELETE FROM {S}.login_attempts")

# party password
check(raises(lambda: q("SELECT {S}.fb_set_party_pass($1,1,'ab','x')", [KA]), "weak_credentials"), "weak party credentials refused")
q("SELECT {S}.fb_set_party_pass($1,1,'taheri','pw123456')", [KA])
info = q("SELECT * FROM {S}.get_party_info('aaaaaaaaaaaaaa')")[0]
check(info["needs_login"] is True and info["authorized"] is False, "party link now requires login")
pt = q("SELECT {S}.fb_party_login('aaaaaaaaaaaaaa','taheri','pw123456') t")[0]["t"]
check(q("SELECT * FROM {S}.get_party_info('aaaaaaaaaaaaaa',$1)", [pt])[0]["authorized"] is True, "party session authorizes")
check(q("SELECT * FROM {S}.get_party_info('bbbbbbbbbbbbbb',$1)", [pt])[0]["needs_login"] is False, "other party unaffected")
check(q("SELECT {S}.fb_party_login('aaaaaaaaaaaaaa','taheri','nope') t")[0]["t"] is None, "wrong party password refused")
q("SELECT {S}.fb_set_party_pass($1,1,'','')", [KA])
check(q("SELECT * FROM {S}.get_party_info('aaaaaaaaaaaaaa')")[0]["needs_login"] is False, "empty password removes protection")

# legacy admin token: tenant 1 only, off once a real login exists
q("INSERT INTO {S}.app_settings(key,value) VALUES ('admin_token','legacytoken')")
check(q("SELECT {S}.is_valid_admin_token('legacytoken') v")[0]["v"] is False, "legacy admin link is disabled once tenant 1 has a login")
q("UPDATE {S}.tenants SET admin_pass_hash=NULL, admin_user=NULL WHERE id=1")
check(q("SELECT {S}.is_valid_admin_token('legacytoken') v")[0]["v"] is True, "legacy admin link works before a login is set")
check(len(q("SELECT * FROM {S}.get_admin_accounts('legacytoken')")) == 1, "legacy link sees tenant 1 only")
print(f"PASS: multi-tenant cloud functions ({n} checks)")
