"""Owner-only: create a customer (tenant) in the cloud mirror and print its sync key ONCE.

  py provision_tenant.py --slug chehresazan --name "چهره‌سازان"
  py provision_tenant.py --slug owner --name "Naser (own)" --id 1     # adopt the data that already exists (tenant 1)
  py provision_tenant.py --slug chehresazan --rotate                   # new key; the old one stops working at once
  py provision_tenant.py --slug chehresazan --suspend / --resume
  py provision_tenant.py --slug chehresazan --rename "چهره‌سازان"       # the name shown in the manager's greeting
  py provision_tenant.py --slug chehresazan --max-devices 3          # (migration 008) allowed computers per connect code
  py provision_tenant.py --slug chehresazan --reset-devices          # forget registered computers (customer changed PC)
  py provision_tenant.py --slug chehresazan --require-install-id / --no-require-install-id   # refuse apps too old to identify their PC

The key goes into the customer's app (Settings > cloud) by the owner personally; only its SHA-256 hash is stored here.
Never put the Neon connection string on a customer's PC.
"""
import argparse, hashlib, re, secrets, sys
sys.stdout.reconfigure(encoding="utf-8")
from migrate import connection_string, query


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--slug", required=True)
    ap.add_argument("--name")
    ap.add_argument("--id", type=int)
    ap.add_argument("--schema", default="public")
    ap.add_argument("--rotate", action="store_true")
    ap.add_argument("--suspend", action="store_true")
    ap.add_argument("--resume", action="store_true")
    ap.add_argument("--no-clip", action="store_true", help="do not copy the code to the clipboard")
    ap.add_argument("--rename", metavar="NAME")
    ap.add_argument("--max-devices", type=int)
    ap.add_argument("--reset-devices", action="store_true")
    ap.add_argument("--require-install-id", dest="require_install_id", action="store_true", default=None)
    ap.add_argument("--no-require-install-id", dest="require_install_id", action="store_false")
    a = ap.parse_args()
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]{1,40}", a.slug):
        raise SystemExit("slug: 2-41 chars, lowercase letters/digits/dash")
    S, cs = a.schema, connection_string()
    exists = query(cs, f"SELECT id, status FROM {S}.tenants WHERE slug=$1", [a.slug])
    if a.suspend or a.resume:
        if not exists:
            raise SystemExit("no such tenant")
        query(cs, f"UPDATE {S}.tenants SET status=$1 WHERE slug=$2", ["suspended" if a.suspend else "active", a.slug])
        print("suspended" if a.suspend else "resumed"); return
    if a.rename is not None:
        if not exists:
            raise SystemExit("no such tenant")
        nm = a.rename.strip()
        if not 1 <= len(nm) <= 80:
            raise SystemExit("--rename: 1..80 characters")
        query(cs, f"UPDATE {S}.tenants SET name=$1 WHERE slug=$2", [nm, a.slug]); print("name =", nm)
        if a.max_devices is None and not a.reset_devices and a.require_install_id is None:
            return
    if a.max_devices is not None or a.reset_devices or a.require_install_id is not None:
        if not exists:
            raise SystemExit("no such tenant")
        tid = exists[0]["id"] if isinstance(exists[0], dict) else exists[0][0]
        if a.max_devices is not None:
            if not 1 <= a.max_devices <= 20:
                raise SystemExit("--max-devices: 1..20")
            query(cs, f"UPDATE {S}.tenants SET max_devices=$1 WHERE id=$2", [a.max_devices, tid]); print("max_devices =", a.max_devices)
        if a.require_install_id is not None:
            query(cs, f"UPDATE {S}.tenants SET require_install_id=$1 WHERE id=$2", [a.require_install_id, tid]); print("require_install_id =", a.require_install_id)
        if a.reset_devices:
            query(cs, f"DELETE FROM {S}.tenant_devices WHERE tenant_id=$1", [tid]); print("registered computers cleared")
        return
    key = "fbk_" + secrets.token_urlsafe(32)
    h = hashlib.sha256(key.encode()).hexdigest()
    if exists and a.rotate:
        query(cs, f"UPDATE {S}.tenants SET sync_key_hash=$1 WHERE slug=$2", [h, a.slug])
    elif exists:
        raise SystemExit("tenant exists (use --rotate for a new key)")
    else:
        if not a.name:
            raise SystemExit("--name is required for a new tenant")
        if a.id:
            query(cs, f"INSERT INTO {S}.tenants(id,slug,name,sync_key_hash) VALUES ($1,$2,$3,$4)", [a.id, a.slug, a.name, h])
            query(cs, f"SELECT setval(pg_get_serial_sequence('{S}.tenants','id'), GREATEST((SELECT max(id) FROM {S}.tenants),1))")
        else:
            query(cs, f"INSERT INTO {S}.tenants(slug,name,sync_key_hash) VALUES ($1,$2,$3)", [a.slug, a.name, h])
    print("tenant:", a.slug)
    print("CONNECT CODE (shown once; paste it in the customer's app: Settings > cloud):")
    print(a.slug + "~" + key)
    # راحتیِ مالک: کد خودکار روی کلیپ‌بورد می‌رود تا لازم نباشد با ماوس انتخاب شود (با --no-clip خاموش می‌شود)
    if not a.no_clip:
        try:
            import subprocess
            subprocess.run(["clip"], input=(a.slug + "~" + key).encode("ascii"), check=True, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            print(">> The code is now COPIED to the clipboard: just paste it (Ctrl+V).")
        except Exception:
            print(">> (could not copy automatically; select the line above and copy it)")
    print("manager link:  https://panel.fishbanapp.com/admin.html?c=" + a.slug + "   (the customer sets the user/password inside the app)")


if __name__ == "__main__":
    main()
