# Fishban cloud — multi-tenant cutover (owner runbook)

Built and tested, NOT yet applied to production:
- `sql/001_multitenant.sql` — additive migration (rehearsed on scratch schema `fbtest`: 37 checks pass, `tools/test_fbtest.py`)
- `src/index.js` — Worker: /sync (batch, per-customer key), /party + /party/login, /admin?c=<slug> + /admin/login, nightly janitor (`tools/worker_routes_test.mjs`, 20 checks)
- `docs/index.html`, `docs/admin.html` — login screens
- App side (2.13.1 source): connect code instead of the Neon string, batched sync, manager/party passwords (`tests/cloud_gateway_test.py`)

Model: the cloud is a **2-day live mirror** (today + yesterday, Tehran). Receipts older than yesterday are dropped on every sync and nightly.

## Order matters (the old direct-to-Neon sync stops working after step 1, until step 4)
```
set FB_NEON_SECRET=<path to a json file with {"connection_string": "..."}>   # owner's machine only
cd worker\tools
py migrate.py --schema public                      # 1. additive; existing rows become tenant 1
py provision_tenant.py --slug owner --name "Owner" --id 1     # 2. prints a CONNECT CODE once
cd ..; npx wrangler deploy                         # 3. new Worker (needs `wrangler login` as you)
git push origin main                               # 4. panel pages (GitHub Pages)
```
5. Owner's own app: Settings > cloud > paste the connect code, then «همگام‌سازی الان».
6. Per customer: `py provision_tenant.py --slug chehresazan --name "..."` -> paste the code in THEIR app (you, in person). Then in the app set the manager user/password.
7. Customer manager link: `https://panel.fishbanapp.com/admin.html?c=<slug>`; party links: unchanged (`/?t=<token>`), optional per-party password.

Key hygiene: `--rotate` replaces a key at once; `--suspend` cuts a customer off. The Neon connection string never goes on a customer PC.
Rollback of the Worker: `wrangler rollback`. The migration only adds columns/tables/functions (PKs become (tenant_id,id)).
