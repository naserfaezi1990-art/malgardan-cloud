import { neon } from '@neondatabase/serverless';
function corsHeaders() {
return { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Sync-Key', 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
}
const MAX_SYNC_BYTES = 1500000;
function bearer(request) {
const h = request.headers.get('Authorization') || '';
return h.startsWith('Bearer ') ? h.slice(7).trim() : '';
}
async function readJson(request, limit) {
const text = await request.text();
if (text.length > limit) { const e = new Error('too_large'); e.code = 413; throw e; }
try { return text ? JSON.parse(text) : {}; } catch (e) { const x = new Error('bad_json'); x.code = 400; throw x; }
}
function mapDbError(err) {
const m = String((err && err.message) || err);
if (/invalid_key/.test(m)) return json({ error: 'کلید همگام‌سازی نامعتبر یا غیرفعال است' }, 401);
if (/locked/.test(m)) return json({ error: 'تلاش‌های ناموفق زیاد بود؛ ۱۵ دقیقه بعد دوباره امتحان کنید' }, 429);
if (/weak_credentials/.test(m)) return json({ error: 'نام کاربری حداقل ۳ و رمز حداقل ۶ کاراکتر باشد' }, 400);
return null;
}
function json(data, status) {
return new Response(JSON.stringify(data), { status: status || 200, headers: corsHeaders() });
}
// لینکِ طرف‌حساب فقط ۲ روزِ اخیر (امروز و دیروز، به وقتِ تهران) را نشان می‌دهد؛ ابر فقط آینه‌ی زنده است و داده‌ی قدیمی‌تر از دیتابیس پاک می‌شود.
function toAsciiDigits(s) { return String(s == null ? '' : s).replace(/[۰-۹]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d)); }
function normJalali(s) {
const m = toAsciiDigits(s).match(/(\d{4})\D+(\d{1,2})\D+(\d{1,2})/);
return m ? m[1] + '/' + m[2].padStart(2, '0') + '/' + m[3].padStart(2, '0') : '';
}
function gregorianToJalali(gy, gm, gd) {
const g_d_m = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
const gy2 = gm > 2 ? gy + 1 : gy;
let days = 355666 + 365 * gy + Math.floor((gy2 + 3) / 4) - Math.floor((gy2 + 99) / 100) + Math.floor((gy2 + 399) / 400) + gd + g_d_m[gm - 1];
let jy = -1595 + 33 * Math.floor(days / 12053);
days %= 12053;
jy += 4 * Math.floor(days / 1461);
days %= 1461;
if (days > 365) { jy += Math.floor((days - 1) / 365); days = (days - 1) % 365; }
let jm, jd;
if (days < 186) { jm = 1 + Math.floor(days / 31); jd = 1 + (days % 31); } else { jm = 7 + Math.floor((days - 186) / 30); jd = 1 + ((days - 186) % 30); }
return jy + '/' + String(jm).padStart(2, '0') + '/' + String(jd).padStart(2, '0');
}
function jalaliDaysAgoTehran(n) {
const t = new Date(Date.now() + 3.5 * 3600 * 1000 - n * 86400000);
return gregorianToJalali(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}
function isValidToken(token) {
return typeof token === 'string' && /^[0-9a-f]{14,128}$/.test(token);
}
function isValidSession(token) {
return typeof token === 'string' && /^[0-9a-f]{64}$/.test(token);
}
function isValidSlug(slug) {
return typeof slug === 'string' && /^[a-z0-9][a-z0-9-]{1,40}$/.test(slug);
}
async function partyView(sql, token, session) {
const info = await sql.query('SELECT * FROM get_party_info($1, $2)', [token, isValidSession(session) ? session : null]);
if (!info.length) return json({ error: 'لینک پیدا نشد یا غیرفعال است' }, 404);
if (!info[0].authorized) return json({ needs_login: true, party_name: info[0].party_name }, 401);
const accounts = await sql.query('SELECT * FROM get_party_accounts($1)', [token]);
const receipts = await sql.query('SELECT * FROM get_party_receipts($1)', [token]);
const cutoff = jalaliDaysAgoTehran(1);
const recentReceipts = receipts.filter((r) => normJalali(r.date_jalali) >= cutoff);
const recentAccountIds = new Set(recentReceipts.map((r) => r.account_id));
const recentAccounts = accounts.filter((a) => normJalali(a.valid_jalali) >= cutoff || recentAccountIds.has(a.account_id));
const { needs_login, authorized, ...party } = info[0];
return json({ party, accounts: recentAccounts, receipts: recentReceipts, window_from: cutoff, protected: !!needs_login });
}
export default {
async fetch(request, env, ctx) {
if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders() });
const url = new URL(request.url);
const sql = neon(env.DATABASE_URL);
try {
// ---- مشتری (برنامه‌ی نصب‌شده) با «کلید همگام‌سازی» خودش؛ هیچ‌وقت رشته‌ی Neon پیش مشتری نیست
if (url.pathname === '/sync' && request.method === 'POST') {
const key = request.headers.get('X-Sync-Key') || '';
if (key.length < 20 || key.length > 200) return json({ error: 'کلید همگام‌سازی نامعتبر است' }, 401);
const body = await readJson(request, MAX_SYNC_BYTES);
const rows = (a) => (Array.isArray(a) ? a.length : 0);
if (rows(body.receipts) > 1000 || rows(body.accounts) > 2000 || rows(body.parties) > 2000 || rows(body.deletes) > 2000) return json({ error: 'دسته خیلی بزرگ است' }, 413);
const out = await sql.query('SELECT fb_sync($1, $2::jsonb) AS r', [key, JSON.stringify(body)]);
return json({ ok: true, result: out[0].r });
}
if (url.pathname === '/credentials/admin' && request.method === 'POST') {
const key = request.headers.get('X-Sync-Key') || '';
const b = await readJson(request, 2000);
await sql.query('SELECT fb_set_admin($1, $2, $3)', [key, String(b.user || ''), String(b.password || '')]);
return json({ ok: true });
}
if (url.pathname === '/credentials/client' && request.method === 'POST') {
const key = request.headers.get('X-Sync-Key') || '';
const b = await readJson(request, 2000);
const cid = Number(b.client_id);
if (!Number.isInteger(cid)) return json({ error: 'کارفرما نامعتبر است' }, 400);
await sql.query('SELECT fb_set_client_pass($1, $2, $3, $4)', [key, cid, String(b.user || ''), String(b.password || '')]);
return json({ ok: true });
}
if (url.pathname === '/credentials/party' && request.method === 'POST') {
const key = request.headers.get('X-Sync-Key') || '';
const b = await readJson(request, 2000);
const pid = Number(b.party_id);
if (!Number.isInteger(pid)) return json({ error: 'طرف‌حساب نامعتبر است' }, 400);
const r = await sql.query('SELECT fb_set_party_pass($1, $2, $3, $4) AS ok', [key, pid, String(b.user || ''), String(b.password || '')]);
return json({ ok: !!(r[0] && r[0].ok) });
}
// ---- لینک طرف‌حساب
if (url.pathname === '/party') {
const token = url.searchParams.get('token') || '';
if (!isValidToken(token)) return json({ error: 'لینک نامعتبر است' }, 400);
const session = bearer(request);
// لینکِ بدون رمز: جوابِ ۱۵ ثانیه در Cloudflare کش می‌شود تا بازشدن‌های پشت‌سرهم دیتابیس (و هزینه‌ی Neon) را درگیر نکند.
// لینکِ رمزدار هرگز کش نمی‌شود.
const cacheOk = !session && typeof caches !== 'undefined' && caches.default;
const cacheKey = cacheOk ? new Request('https://cache.fishbanapp.internal/party/' + token) : null;
if (cacheOk) {
const hit = await caches.default.match(cacheKey);
if (hit) return new Response(await hit.text(), { status: 200, headers: corsHeaders() });
}
const res = await partyView(sql, token, session);
if (cacheOk && res.status === 200) {
const text = await res.clone().text();
let open = false;
try { open = JSON.parse(text).protected === false; } catch (e) { open = false; }
if (open) {
const put = caches.default.put(cacheKey, new Response(text, { headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=15' } }));
if (ctx && ctx.waitUntil) ctx.waitUntil(put); else await put;
}
}
return res;
}
if (url.pathname === '/party/login' && request.method === 'POST') {
const b = await readJson(request, 2000);
if (!isValidToken(b.token)) return json({ error: 'لینک نامعتبر است' }, 400);
const r = await sql.query('SELECT fb_party_login($1, $2, $3) AS t', [b.token, String(b.user || ''), String(b.password || '')]);
if (!r[0] || !r[0].t) return json({ error: 'نام کاربری یا رمز اشتباه است' }, 401);
return json({ session: r[0].t });
}
// ---- اتاق فرمان‌ِ مدیر: ورود با نام کاربری و رمز
if (url.pathname === '/admin/login' && request.method === 'POST') {
const b = await readJson(request, 2000);
if (!isValidSlug(b.c)) return json({ error: 'لینک نامعتبر است' }, 400);
const kid = b.k === undefined || b.k === null || b.k === '' ? null : Number(b.k);
if (kid !== null && !Number.isInteger(kid)) return json({ error: 'لینک نامعتبر است' }, 400);
const r = kid === null
? await sql.query('SELECT fb_admin_login($1, $2, $3) AS t', [b.c, String(b.user || ''), String(b.password || '')])
: await sql.query('SELECT fb_client_login($1, $2, $3, $4) AS t', [b.c, kid, String(b.user || ''), String(b.password || '')]);
if (!r[0] || !r[0].t) return json({ error: 'نام کاربری یا رمز اشتباه است' }, 401);
return json({ session: r[0].t });
}
if (url.pathname === '/admin') {
const date = url.searchParams.get('date') || null;
const slug = url.searchParams.get('c') || '';
if (slug) {
if (!isValidSlug(slug)) return json({ error: 'لینک نامعتبر است' }, 400);
const session = bearer(request);
const kRaw = url.searchParams.get('k');
const kid = kRaw === null || kRaw === '' ? null : Number(kRaw);
if (kid !== null && !Number.isInteger(kid)) return json({ error: 'لینک نامعتبر است' }, 400);
const info = await sql.query('SELECT * FROM fb_admin_info($1, $2, $3)', [slug, isValidSession(session) ? session : null, kid]);
if (!info.length) return json({ error: 'لینک پیدا نشد' }, 404);
if (!info[0].needs_login) return json({ error: 'رمز این اتاق فرمان هنوز در برنامه تعیین نشده است' }, 403);
if (!info[0].authorized) return json({ needs_login: true, tenant_name: info[0].tenant_name }, 401);
const accounts = await sql.query('SELECT * FROM fb_admin_accounts($1)', [session]);
const receipts = await sql.query('SELECT * FROM fb_admin_receipts($1, $2)', [session, date]);
return json({ accounts, receipts, tenant_name: info[0].tenant_name });
}
// لینک قدیمیِ توکنی (فقط تا وقتی مالک رمز نگذاشته)
const token = url.searchParams.get('token') || '';
if (!isValidToken(token)) return json({ error: 'دسترسی نامعتبر است' }, 400);
const valid = await sql.query('SELECT is_valid_admin_token($1) AS ok', [token]);
if (!valid.length || !valid[0].ok) return json({ error: 'دسترسی نامعتبر است' }, 403);
const accounts = await sql.query('SELECT * FROM get_admin_accounts($1)', [token]);
const receipts = await sql.query('SELECT * FROM get_admin_receipts($1, $2)', [token, date]);
return json({ accounts, receipts });
}
return json({ error: 'not found' }, 404);
} catch (err) {
if (err && err.code === 413) return json({ error: 'درخواست خیلی بزرگ است' }, 413);
if (err && err.code === 400) return json({ error: 'درخواست نامعتبر است' }, 400);
const mapped = mapDbError(err);
if (mapped) return mapped;
console.error(String((err && err.stack) || err));
return json({ error: 'خطای داخلی سرور' }, 500);
}
},
// هر شب: هر چه از پنجره‌ی ۲ روزه بیرون افتاده پاک شود (علاوه بر پاک‌سازی لحظه‌ای در هر sync)
async scheduled(event, env) {
const sql = neon(env.DATABASE_URL);
try { await sql.query('SELECT fb_janitor()'); } catch (err) { console.error(String((err && err.stack) || err)); }
}
};
