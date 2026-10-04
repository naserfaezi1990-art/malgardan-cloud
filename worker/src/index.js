import { neon } from '@neondatabase/serverless';
function corsHeaders() {
return { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
}
function json(data, status) {
return new Response(JSON.stringify(data), { status: status || 200, headers: corsHeaders() });
}
// لینکِ طرف‌حساب فقط ۲ روزِ اخیر (امروز و دیروز، به وقتِ تهران) را نشان می‌دهد؛ اطلاعاتِ قدیمی‌تر از روی لینک پاک است و از خودِ برنامه گرفته می‌شود.
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
export default {
async fetch(request, env) {
if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders() });
const url = new URL(request.url);
const sql = neon(env.DATABASE_URL);
try {
if (url.pathname === '/party') {
const token = url.searchParams.get('token') || '';
if (!isValidToken(token)) return json({ error: 'لینک نامعتبر است' }, 400);
const info = await sql.query('SELECT * FROM get_party_info($1)', [token]);
if (!info.length) return json({ error: 'لینک پیدا نشد یا غیرفعال است' }, 404);
const accounts = await sql.query('SELECT * FROM get_party_accounts($1)', [token]);
const receipts = await sql.query('SELECT * FROM get_party_receipts($1)', [token]);
const cutoff = jalaliDaysAgoTehran(1);
const recentReceipts = receipts.filter((r) => normJalali(r.date_jalali) >= cutoff);
const recentAccountIds = new Set(recentReceipts.map((r) => r.account_id));
const recentAccounts = accounts.filter((a) => normJalali(a.valid_jalali) >= cutoff || recentAccountIds.has(a.account_id));
return json({ party: info[0], accounts: recentAccounts, receipts: recentReceipts, window_from: cutoff });
}
if (url.pathname === '/admin') {
const token = url.searchParams.get('token') || '';
const date = url.searchParams.get('date') || null;
if (!isValidToken(token)) return json({ error: 'دسترسی نامعتبر است' }, 400);
const valid = await sql.query('SELECT is_valid_admin_token($1) AS ok', [token]);
if (!valid.length || !valid[0].ok) return json({ error: 'دسترسی نامعتبر است' }, 403);
const accounts = await sql.query('SELECT * FROM get_admin_accounts($1)', [token]);
const receipts = await sql.query('SELECT * FROM get_admin_receipts($1, $2)', [token, date]);
return json({ accounts, receipts });
}
return json({ error: 'not found' }, 404);
} catch (err) {
console.error(String((err && err.stack) || err));
return json({ error: 'خطای داخلی سرور' }, 500);
}
}
};
