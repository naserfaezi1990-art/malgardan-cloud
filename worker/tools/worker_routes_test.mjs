// Route/auth logic of the Worker with a stubbed Neon driver (no network).  node worker_routes_test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbw-'));
fs.mkdirSync(path.join(dir, 'node_modules/@neondatabase/serverless'), { recursive: true });
fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}');
fs.writeFileSync(path.join(dir, 'node_modules/@neondatabase/serverless/package.json'), '{"name":"@neondatabase/serverless","type":"module","main":"index.js"}');
fs.writeFileSync(path.join(dir, 'node_modules/@neondatabase/serverless/index.js'),
  'export function neon(){ return { query: async (q, p) => globalThis.__db(q, p) }; }');
fs.copyFileSync(path.resolve(import.meta.dirname, '../src/index.js'), path.join(dir, 'worker.js'));
const worker = (await import(pathToFileURL(path.join(dir, 'worker.js')).href)).default;

let n = 0;
const eq = (a, b, label) => { n++; if (JSON.stringify(a) !== JSON.stringify(b)) { console.error('FAIL:', label, JSON.stringify(a), '!=', JSON.stringify(b)); process.exit(1); } };
const call = async (method, url, { headers = {}, body } = {}) => {
  const r = await worker.fetch(new Request('https://x.test' + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), { DATABASE_URL: 'x' });
  return { status: r.status, json: await r.json() };
};
const TOKEN = 'a'.repeat(14), SESSION = 'b'.repeat(64), KEY = 'fbk_' + 'k'.repeat(40);
const queries = [];
globalThis.__db = async (q, p) => {
  queries.push(q);
  if (q.includes('get_party_info')) return [{ party_id: 1, party_name: 'P', client_name: 'C', needs_login: true, authorized: p[1] === SESSION }];
  if (q.includes('get_party_accounts') || q.includes('get_party_receipts')) return [];
  if (q.includes('fb_party_login')) return [{ t: p[2] === 'good' ? SESSION : null }];
  if (q.includes('fb_admin_login')) return [{ t: p[2] === 'good' ? SESSION : null }];
  if (q.includes('fb_admin_info')) return [{ tenant_name: 'T', needs_login: p[0] !== 'nopass', authorized: p[1] === SESSION }];
  if (q.includes('fb_admin_accounts') || q.includes('fb_admin_receipts')) return [];
  if (q.includes('fb_sync')) { if (p[0] !== KEY) throw new Error('invalid_key'); return [{ r: { receipts: 1 } }]; }
  if (q.includes('fb_set_admin')) { if (p[0] !== KEY) throw new Error('invalid_key'); if (p[2].length < 6) throw new Error('weak_credentials'); return [{}]; }
  if (q.includes('fb_set_party_pass')) return [{ ok: true }];
  return [];
};

// party link
let r = await call('GET', '/party?token=' + TOKEN);
eq([r.status, r.json.needs_login], [401, true], 'protected party link asks for login (no data leaked)');
eq(Object.keys(r.json).sort(), ['needs_login', 'party_name'], 'login response carries no account data');
r = await call('GET', '/party?token=' + TOKEN, { headers: { Authorization: 'Bearer ' + SESSION } });
eq(r.status, 200, 'valid session opens the party link');
r = await call('GET', '/party?token=zz');
eq(r.status, 400, 'malformed token refused before touching the db');
r = await call('POST', '/party/login', { body: { token: TOKEN, user: 'u', password: 'bad' } });
eq(r.status, 401, 'wrong party password -> 401');
r = await call('POST', '/party/login', { body: { token: TOKEN, user: 'u', password: 'good' } });
eq([r.status, r.json.session], [200, SESSION], 'right party password -> session');

// admin
r = await call('GET', '/admin?c=beta');
eq([r.status, r.json.needs_login], [401, true], 'admin page asks for login');
r = await call('GET', '/admin?c=nopass');
eq(r.status, 403, 'tenant without a manager password has no admin link yet');
r = await call('GET', '/admin?c=beta', { headers: { Authorization: 'Bearer ' + SESSION } });
eq(r.status, 200, 'admin session opens the page');
r = await call('GET', '/admin?c=BAD SLUG');
eq(r.status, 400, 'bad slug refused');
r = await call('POST', '/admin/login', { body: { c: 'beta', user: 'a', password: 'good' } });
eq(r.status, 200, 'admin login ok');
r = await call('GET', '/admin?token=' + TOKEN);
eq(r.status, 403, 'legacy token path still answers (and is refused by the db function here)');

// sync + credentials
r = await call('POST', '/sync', { headers: { 'X-Sync-Key': 'short' }, body: {} });
eq(r.status, 401, 'short key refused');
r = await call('POST', '/sync', { headers: { 'X-Sync-Key': 'fbk_' + 'z'.repeat(40) }, body: { receipts: [] } });
eq(r.status, 401, 'unknown key -> 401');
r = await call('POST', '/sync', { headers: { 'X-Sync-Key': KEY }, body: { receipts: [{}] } });
eq([r.status, r.json.ok], [200, true], 'valid key syncs');
r = await call('POST', '/sync', { headers: { 'X-Sync-Key': KEY }, body: { receipts: new Array(1001).fill({}) } });
eq(r.status, 413, 'oversized batch refused');
r = await call('POST', '/credentials/admin', { headers: { 'X-Sync-Key': KEY }, body: { user: 'amir', password: '123' } });
eq(r.status, 400, 'weak admin password -> 400 with a readable error');
r = await call('POST', '/credentials/admin', { headers: { 'X-Sync-Key': KEY }, body: { user: 'amir', password: 'secret123' } });
eq(r.status, 200, 'strong admin password accepted');
// ---- دروازه‌ی Gemini
const callAI = async (env, headers, body, qs = '') => {
  const r = await worker.fetch(new Request('https://x.test/gemini/generate' + qs, { method: 'POST', headers, body: JSON.stringify(body) }), env);
  return { status: r.status, text: await r.text() };
};
const GKEY = 'fbk_' + 'g'.repeat(40);
let googleCalls = [];
globalThis.fetch = async (url, opts) => {
  googleCalls.push({ url: String(url), body: opts && opts.body });
  return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"amount":1}' }] } }] }), { status: googleStatus });
};
let googleStatus = 200;
const aiQueries = [];
globalThis.__db = async (q, p) => {
  aiQueries.push(q);
  if (q.includes('fb_ai_gate')) { if (p[0] !== GKEY) throw new Error('invalid_key'); if (globalThis.__quota) throw new Error('quota_exceeded'); return [{ t: 7 }]; }
  if (q.includes('fb_ai_error')) return [{}];
  return [];
};
let a = await callAI({ DATABASE_URL: 'x', GEMINI_API_KEY: 'SECRET-GOOGLE-KEY' }, { 'X-Sync-Key': 'short' }, {});
eq(a.status, 401, 'ai: short key refused');
a = await callAI({ DATABASE_URL: 'x' }, { 'X-Sync-Key': GKEY }, {});
eq(a.status, 503, 'ai: Worker without a Gemini secret answers 503 (clear, not a crash)');
a = await callAI({ DATABASE_URL: 'x', GEMINI_API_KEY: 'SECRET-GOOGLE-KEY' }, { 'X-Sync-Key': 'fbk_' + 'z'.repeat(40) }, { contents: [] });
eq(a.status, 401, 'ai: unknown sync key -> 401');
googleCalls = [];
a = await callAI({ DATABASE_URL: 'x', GEMINI_API_KEY: 'SECRET-GOOGLE-KEY' }, { 'X-Sync-Key': GKEY }, { contents: [{ parts: [{ text: 'hi' }] }] });
eq(a.status, 200, 'ai: valid key is forwarded to Google');
eq([googleCalls.length, googleCalls[0].url.includes('key=SECRET-GOOGLE-KEY'), googleCalls[0].url.includes('gemini-3.6-flash')], [1, true, true], 'ai: the Google key is added by the Worker, default model');
eq(a.text.includes('SECRET-GOOGLE-KEY'), false, 'ai: the Google key never appears in the response');
a = await callAI({ DATABASE_URL: 'x', GEMINI_API_KEY: 'SECRET-GOOGLE-KEY' }, { 'X-Sync-Key': GKEY }, {}, '?model=../../evil');
eq(a.status, 400, 'ai: model name is validated');
globalThis.__quota = true;
a = await callAI({ DATABASE_URL: 'x', GEMINI_API_KEY: 'SECRET-GOOGLE-KEY' }, { 'X-Sync-Key': GKEY }, { contents: [] });
eq(a.status, 429, 'ai: tenant over its daily cap -> 429');
globalThis.__quota = false;
googleStatus = 503;
a = await callAI({ DATABASE_URL: 'x', GEMINI_API_KEY: 'SECRET-GOOGLE-KEY' }, { 'X-Sync-Key': GKEY }, { contents: [] });
eq(a.status, 503, 'ai: Google errors are passed through (the app retries them)');
eq(aiQueries.some((q) => q.includes('fb_ai_error')), true, 'ai: errors are counted per tenant');
r = await call('GET', '/nothing');
eq(r.status, 404, 'unknown route');
// نبودنِ نشتِ خطای داخلی
globalThis.__db = async () => { throw new Error('connection string postgres://u:SECRET@h/db'); };
r = await call('GET', '/party?token=' + TOKEN);
eq([r.status, JSON.stringify(r.json).includes('SECRET')], [500, false], 'internal errors never leak details');
console.log(`PASS: worker routes (${n} checks)`);
