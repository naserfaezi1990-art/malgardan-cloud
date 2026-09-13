import { neon } from '@neondatabase/serverless';
function corsHeaders() {
return { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
}
function json(data, status) {
return new Response(JSON.stringify(data), { status: status || 200, headers: corsHeaders() });
}
function isValidToken(token) {
return typeof token === 'string' && /^[0-9a-f]{32,128}$/.test(token);
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
return json({ party: info[0], accounts, receipts });
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
