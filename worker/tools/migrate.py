"""Run worker/sql/*.sql against Neon (HTTP /sql, one statement per call).

  py migrate.py --schema fbtest --rehearse    # build a scratch copy of the tables and run the migration there
  py migrate.py --schema public               # PRODUCTION (additive; owner runs this deliberately)

The connection string is read from the FB_NEON_URL environment variable, or from the path in FB_NEON_SECRET
(a JSON file with "connection_string"). It is never printed.
"""
import argparse, json, os, sys, urllib.request, urllib.error
from pathlib import Path
from urllib.parse import urlparse

HERE = Path(__file__).resolve().parent


def connection_string():
    cs = os.environ.get("FB_NEON_URL", "").strip()
    if not cs and os.environ.get("FB_NEON_SECRET"):
        cs = json.loads(Path(os.environ["FB_NEON_SECRET"]).read_text(encoding="utf-8"))["connection_string"]
    if not cs:
        raise SystemExit("set FB_NEON_URL or FB_NEON_SECRET")
    return cs


def query(cs, sql, params=None):
    host = urlparse(cs).hostname
    req = urllib.request.Request(f"https://{host}/sql", method="POST",
                                 data=json.dumps({"query": sql, "params": params or []}).encode(),
                                 headers={"Content-Type": "application/json", "Neon-Connection-String": cs})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.loads(r.read().decode()).get("rows", [])
    except urllib.error.HTTPError as e:
        raise RuntimeError(e.read().decode(errors="replace")[:600])


def statements(schema):
    out = []
    for f in sorted((HERE.parent / "sql").glob("*.sql")):
        for chunk in f.read_text(encoding="utf-8").split("-- @@"):
            body = "\n".join(l for l in chunk.splitlines() if not l.strip().startswith("--")).strip()
            if body:
                out.append(body.replace("{S}", schema))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--schema", default="fbtest")
    ap.add_argument("--rehearse", action="store_true")
    a = ap.parse_args()
    cs = connection_string()
    if a.rehearse:
        if a.schema == "public":
            raise SystemExit("--rehearse never runs on public")
        query(cs, f"DROP SCHEMA IF EXISTS {a.schema} CASCADE")
        query(cs, f"CREATE SCHEMA {a.schema}")
        for t in ("parties", "accounts", "receipts", "app_settings"):
            query(cs, f"CREATE TABLE {a.schema}.{t} (LIKE public.{t} INCLUDING ALL)")
    for i, s in enumerate(statements(a.schema), 1):
        try:
            query(cs, s)
        except Exception as e:
            raise SystemExit(f"statement {i} failed: {e}\n{s[:200]}")
    print(f"ok: {i} statements applied to schema {a.schema}")


if __name__ == "__main__":
    main()
