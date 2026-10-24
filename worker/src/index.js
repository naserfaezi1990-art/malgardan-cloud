import { neon } from '@neondatabase/serverless';
import { PROMPTS } from './prompts.js';
function corsHeaders() {
return { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Sync-Key, X-Install-Id, X-Call-Kind', 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
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
if (/quota_exceeded/.test(m)) return json({ error: 'سهمیه‌ی امروزِ فیش‌بانِ شما تمام شد؛ با پشتیبانی تماس بگیرید' }, 429);
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
// سقفِ دستگاه: یک کدِ اتصال حداکثر روی max_devices کامپیوتر (migration 008). قبل از اجرای 008 یا برای برنامه‌ی قدیمی (بدونِ X-Install-Id) بی‌صدا رد می‌شود،
// مگر مالک require_install_id را برای آن مشتری روشن کرده باشد.
async function deviceGate(sql, key, request) {
const install = (request.headers.get('X-Install-Id') || '').toLowerCase();
let r;
try { r = (await sql.query('SELECT fb_device_gate($1, $2) AS r', [key, /^[0-9a-f]{8,40}$/.test(install) ? install : null]))[0].r; } catch (e) { return null; }
if (r === 'limit') return json({ error: 'این کدِ اتصال روی بیش از تعدادِ مجازِ کامپیوتر استفاده شده؛ برای کامپیوترِ تازه با پشتیبانی تماس بگیرید', code: 'device_limit' }, 403);
if (r === 'need_install_id') return json({ error: 'نسخه‌ی برنامه قدیمی است؛ آن را به‌روز کنید', code: 'need_update' }, 403);
return null;
}
// ---- مجوز (لایسنس): برنامه‌ی مشتری دیگر رشته‌ی اتصالِ دیتابیسِ مجوزها را ندارد؛ فقط از اینجا جوابِ «امضاشده» می‌گیرد.
// کلیدِ امضا (LICENSE_SIGN_KEY، Ed25519 PKCS8 به base64) و رشته‌ی دیتابیسِ مجوزها (LICENSE_DB_URL) فقط در Secretهای Worker هستند.
// تا این دو تنظیم نشده‌اند همه‌ی /license/* جوابِ ۵۰۳ می‌دهند و برنامه‌های موجود به روشِ قبلی ادامه می‌دهند.
function isMachineId(v) { return typeof v === 'string' && /^[0-9a-f]{64}$/.test(v); }
function isNonce(v) { return typeof v === 'string' && /^[0-9a-f]{16,64}$/.test(v); }
// JSON با کلیدهای مرتب و بدون فاصله (همان json.dumps(sort_keys=True, separators=(',',':')) در پایتون)؛ مقدارها فقط ASCII/عدد صحیح
function canon(v) {
if (v === null || typeof v !== 'object') return JSON.stringify(v);
if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
}
function b64(buf) { let s = ''; const a = new Uint8Array(buf); for (let i = 0; i < a.length; i++) s += String.fromCharCode(a[i]); return btoa(s); }
function fromB64(s) { const bin = atob(s); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; }
let _signKey = null;
async function signKey(env) {
const src = env.LICENSE_SIGN_KEY;
if (!src) return null;
if (_signKey && _signKey.src === src) return _signKey;
const der = fromB64(String(src).trim());
let k, alg;
try { alg = { name: 'Ed25519' }; k = await crypto.subtle.importKey('pkcs8', der, alg, false, ['sign']); }
catch (e) { alg = { name: 'NODE-ED25519', namedCurve: 'NODE-ED25519' }; k = await crypto.subtle.importKey('pkcs8', der, alg, false, ['sign']); }
_signKey = { src, k, alg };
return _signKey;
}
async function signedReply(env, payload) {
const sk = await signKey(env);
const sig = await crypto.subtle.sign(sk.alg, sk.k, new TextEncoder().encode(canon(payload)));
return json({ payload, signature: b64(sig) });
}
// نسخه‌ی کم‌تر از حداقل (MIN_APP_VERSION، متغیرِ Worker) = «outdated»: مالک با یک دستور نسخه‌ی قدیمی/نشت‌شده را از چک‌کردنِ مجوز می‌اندازد.
// خالی/نامعتبر = هیچ نسخه‌ای قفل نمی‌شود. فقط وقتی برنامه نسخه‌اش را فرستاده باشد (بعد از بالاآمدن) سنجیده می‌شود.
function verTuple(v) { const m = String(v || '').match(/\d+/g) || []; return [Number(m[0] || 0), Number(m[1] || 0), Number(m[2] || 0)]; }
function verLess(a, b) { const x = verTuple(a), y = verTuple(b); for (let i = 0; i < 3; i++) { if (x[i] !== y[i]) return x[i] < y[i]; } return false; }
async function licenseRoute(url, request, env, ctx) {
if (!env.LICENSE_DB_URL || !env.LICENSE_SIGN_KEY) return json({ error: 'سرویسِ مجوز روی سرور تنظیم نشده' }, 503);
const lsql = neon(env.LICENSE_DB_URL);
const now = Math.floor(Date.now() / 1000);
// آخرین نسخه‌ی منتشرشده (اطلاعاتِ عمومی؛ بدونِ امضا)
if (url.pathname === '/license/update' && request.method === 'GET') {
let rows;
try { rows = await lsql.query('SELECT version, download_url, notes, sha256 FROM app_releases ORDER BY released_at DESC LIMIT 1'); }
catch (e) { rows = await lsql.query('SELECT version, download_url, notes FROM app_releases ORDER BY released_at DESC LIMIT 1'); }
return json(rows.length ? { version: rows[0].version, download_url: rows[0].download_url, notes: rows[0].notes || null, sha256: rows[0].sha256 || null } : {});
}
if (request.method !== 'POST') return json({ error: 'not found' }, 404);
const b = await readJson(request, 8000);
if (!isMachineId(b.machine_id)) return json({ error: 'شناسه‌ی دستگاه نامعتبر است' }, 400);
if (url.pathname === '/license/check') {
if (!isNonce(b.nonce)) return json({ error: 'درخواست نامعتبر است' }, 400);
const rows = await lsql.query('SELECT revoked, expires_at, expires_at < now() AS is_expired, gemini_credit_remaining FROM licenses WHERE machine_id=$1', [b.machine_id]);
let status = 'unknown', expires = null, credit = null;
if (rows.length) {
const r = rows[0];
status = r.revoked ? 'revoked' : (r.is_expired ? 'expired' : 'ok');
if (status === 'ok' && /^[0-9.]{1,20}$/.test(String(b.version || '')) && /^[0-9.]{1,20}$/.test(String(env.MIN_APP_VERSION || '')) && verLess(b.version, env.MIN_APP_VERSION)) status = 'outdated';
expires = r.expires_at ? Math.floor(new Date(r.expires_at).getTime() / 1000) : null;
credit = r.gemini_credit_remaining === null || r.gemini_credit_remaining === undefined ? null : Math.floor(Number(r.gemini_credit_remaining));
}
const ver = String(b.version || '');
if (status === 'ok' && /^[0-9.]{1,20}$/.test(ver)) {
const rec = lsql.query('SELECT report_version($1,$2)', [b.machine_id, ver]).catch(() => {});
if (ctx && ctx.waitUntil) ctx.waitUntil(rec);
}
// ok: ۳۶ ساعت؛ هر وضعیتِ دیگر فقط چند دقیقه (برای ردِ سریع)
return signedReply(env, { v: 1, purpose: 'license-check', machine_id: b.machine_id, nonce: b.nonce, status, expires_at: expires, credit, issued: now, valid_until: now + (status === 'ok' ? 36 * 3600 : 600) });
}
if (url.pathname === '/license/credit') {
if (!isNonce(b.nonce)) return json({ error: 'درخواست نامعتبر است' }, 400);
const rows = await lsql.query('SELECT * FROM consume_gemini_credit($1)', [b.machine_id]);
const allowed = !rows.length || !!rows[0].allowed;
return signedReply(env, { v: 1, purpose: 'license-credit', machine_id: b.machine_id, nonce: b.nonce, allowed, issued: now, valid_until: now + 300 });
}
if (url.pathname === '/license/report') {
const src = String(b.source || '').slice(0, 100), msg = String(b.message || '').slice(0, 2000), cx = String(b.context || '').slice(0, 4000), ver = String(b.app_version || '').slice(0, 20);
const rec = lsql.query('SELECT report_error($1,$2,$3,$4,$5)', [b.machine_id, src, msg, cx, ver]).catch(() => {});
if (ctx && ctx.waitUntil) ctx.waitUntil(rec); else await rec;
return json({ ok: true });
}
return json({ error: 'not found' }, 404);
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
{ const blocked = await deviceGate(sql, key, request); if (blocked) return blocked; }
const body = await readJson(request, MAX_SYNC_BYTES);
const rows = (a) => (Array.isArray(a) ? a.length : 0);
if (rows(body.receipts) > 1000 || rows(body.accounts) > 2000 || rows(body.parties) > 2000 || rows(body.deletes) > 2000) return json({ error: 'دسته خیلی بزرگ است' }, 413);
const out = await sql.query('SELECT fb_sync($1, $2::jsonb) AS r', [key, JSON.stringify(body)]);
// همین کد اتصال روی کامپیوترِ دیگری هم کار می‌کند؟ (شناسه از روی سخت‌افزار، نه دیتابیس؛ قبل از اجرای migrationِ ۰۰۶ بی‌صدا رد می‌شود)
let otherDevices;
const install = (request.headers.get('X-Install-Id') || '').toLowerCase();
if (/^[0-9a-f]{8,40}$/.test(install)) {
  try { otherDevices = Number((await sql.query('SELECT fb_device_seen($1, $2) AS n', [key, install]))[0].n) || 0; } catch (e) { otherDevices = undefined; }
}
return json({ ok: true, result: out[0].r, ...(otherDevices === undefined ? {} : { other_devices: otherDevices }) });
}
// ---- پرامپت‌های سمتِ سرور: برنامه فقط «fb_prompt» (نام) می‌فرستد؛ متنِ پرامپت فقط اینجاست
if (url.pathname === '/gemini/caps' && request.method === 'GET') return json({ v: 1, server_prompts: Object.keys(PROMPTS) });
// ---- دروازه‌ی هوش مصنوعی: کلیدِ Gemini فقط اینجاست؛ مشتری با کلید همگام‌سازیِ خودش می‌آید و مصرفش شمرده می‌شود
if (url.pathname === '/gemini/generate' && request.method === 'POST') {
const key = request.headers.get('X-Sync-Key') || '';
if (key.length < 20 || key.length > 200) return json({ error: 'کلید همگام‌سازی نامعتبر است' }, 401);
if (!env.GEMINI_API_KEY) return json({ error: 'کلیدِ چشمِ فیش‌بان روی سرور تنظیم نشده' }, 503);
{ const blocked = await deviceGate(sql, key, request); if (blocked) return blocked; }
const raw = await request.text();
if (raw.length > 14000000) return json({ error: 'تصویر خیلی بزرگ است' }, 413);
let body;
try { body = JSON.parse(raw); } catch (e) { return json({ error: 'درخواست نامعتبر است' }, 400); }
if (body && body.fb_prompt !== undefined) {
// پرامپتِ سمتِ سرور: نامِ ناشناخته رد؛ متن به‌عنوانِ اولین بخش جلوی ورودیِ کاربر می‌نشیند و fb_prompt هرگز به Gemini نمی‌رسد
const name = String(body.fb_prompt);
if (!Object.prototype.hasOwnProperty.call(PROMPTS, name)) return json({ error: 'پرامپتِ نامعتبر' }, 400);
delete body.fb_prompt;
if (!body.contents || !Array.isArray(body.contents) || !body.contents[0] || !Array.isArray(body.contents[0].parts)) return json({ error: 'درخواست نامعتبر است' }, 400);
body.contents[0].parts.unshift({ text: PROMPTS[name] });
}
const model = String(url.searchParams.get('model') || 'gemini-3.6-flash');
if (!/^gemini-[a-z0-9.\-]{2,40}$/.test(model)) return json({ error: 'مدل نامعتبر است' }, 400);
const gate = await sql.query('SELECT fb_ai_gate($1) AS t', [key]);
const tenant = gate[0] && gate[0].t;
const ctl = new AbortController();
const timer = setTimeout(() => ctl.abort(), 45000);
try {
const g = await fetch('https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(model) + ':generateContent?key=' + encodeURIComponent(env.GEMINI_API_KEY), {
method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ctl.signal });
const text = await g.text();
if (!g.ok && tenant) { try { await sql.query('SELECT fb_ai_error($1)', [tenant]); } catch (e) { /* شمارش خطا مهم نیست */ } }
if (g.ok && tenant) {
// هزینه‌ی واقعیِ هر مشتری: توکن‌های هر تماس (ورودی/خروجی/تفکر) + نوعِ تماس که برنامه می‌فرستد. شکستِ ثبت هرگز جوابِ مشتری را خراب نمی‌کند.
const kind = (String(request.headers.get('X-Call-Kind') || 'other').toLowerCase().replace(/[^a-z_]/g, '').slice(0, 20)) || 'other';
let u = {};
try { u = (JSON.parse(text) || {}).usageMetadata || {}; } catch (e) { u = {}; }
const n = (v) => (Number.isFinite(Number(v)) ? Math.max(0, Math.floor(Number(v))) : 0);
const rec = sql.query('SELECT fb_ai_usage($1,$2,$3,$4,$5,$6)', [tenant, kind, model, n(u.promptTokenCount), n(u.candidatesTokenCount), n(u.thoughtsTokenCount)]).catch(() => {});
if (ctx && ctx.waitUntil) ctx.waitUntil(rec); else await rec;
}
return new Response(text, { status: g.status, headers: corsHeaders() });
} catch (e) {
if (tenant) { try { await sql.query('SELECT fb_ai_error($1)', [tenant]); } catch (e2) { /* ignore */ } }
return json({ error: 'سرویسِ خواندنِ فیش‌بان در دسترس نبود' }, 504);
} finally { clearTimeout(timer); }
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
if (url.pathname.startsWith('/license/')) return await licenseRoute(url, request, env, ctx);
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
