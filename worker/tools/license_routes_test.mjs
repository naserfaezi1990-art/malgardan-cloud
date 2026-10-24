// /license/* routes of the Worker with a stubbed Neon driver and a REAL Ed25519 key (no network).  node license_routes_test.mjs
// With --emit <file>: also writes {public_hex, check:{request,response}, credit:{...}} for the app-side (Python) cross-check.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbl-'));
fs.mkdirSync(path.join(dir, 'node_modules/@neondatabase/serverless'), { recursive: true });
fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}');
fs.writeFileSync(path.join(dir, 'node_modules/@neondatabase/serverless/package.json'), '{"name":"@neondatabase/serverless","type":"module","main":"index.js"}');
fs.writeFileSync(path.join(dir, 'node_modules/@neondatabase/serverless/index.js'),
  'export function neon(url){ return { query: async (q, p) => globalThis.__db(url, q, p) }; }');
fs.copyFileSync(path.resolve(import.meta.dirname, '../src/index.js'), path.join(dir, 'worker.js'));
fs.copyFileSync(path.resolve(import.meta.dirname, '../src/prompts.js'), path.join(dir, 'prompts.js'));
const worker = (await import(pathToFileURL(path.join(dir, 'worker.js')).href)).default;

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const SIGN = privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64');
const PUB_HEX = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
const ENV = { DATABASE_URL: 'cloud-db', LICENSE_DB_URL: 'license-db', LICENSE_SIGN_KEY: SIGN };

let n = 0;
const eq = (a, b, label) => { n++; if (JSON.stringify(a) !== JSON.stringify(b)) { console.error('FAIL:', label, JSON.stringify(a), '!=', JSON.stringify(b)); process.exit(1); } };
const ok = (c, label) => eq(!!c, true, label);
const call = async (method, url, { body, env = ENV } = {}) => {
  const r = await worker.fetch(new Request('https://x.test' + url, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }), env, { waitUntil: (p) => p });
  return { status: r.status, json: await r.json() };
};
const verify = (reply) => {
  const canon = (v) => (v === null || typeof v !== 'object') ? JSON.stringify(v) : Array.isArray(v) ? '[' + v.map(canon).join(',') + ']' : '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
  return crypto.verify(null, Buffer.from(canon(reply.payload)), publicKey, Buffer.from(reply.signature, 'base64'));
};
const MID = 'ab'.repeat(32), OTHER = 'cd'.repeat(32), NONCE = '0123456789abcdef0123456789abcdef';
const seen = [];
let license = { revoked: false, expires_at: '2030-01-01T00:00:00Z', is_expired: false, gemini_credit_remaining: 500 };
globalThis.__db = async (url, q, p) => {
  seen.push([url, q.split('(')[0].trim().slice(0, 40)]);
  if (q.includes('FROM licenses')) return p[0] === MID ? [license] : [];
  if (q.includes('consume_gemini_credit')) return p[0] === MID ? [{ allowed: globalThis.__allowed !== false }] : [];
  if (q.includes('report_version') || q.includes('report_error')) { if (globalThis.__reportFail) throw new Error('fn missing'); return [{}]; }
  if (q.includes('FROM app_releases')) {
    if (q.includes('sha256') && globalThis.__noSha) throw new Error('column sha256 does not exist');
    return [{ version: '2.14.2', download_url: 'https://github.com/x/y/releases/download/v2.14.2/Fishban-Setup-2.14.2.exe', notes: 'n', sha256: 'a'.repeat(64) }];
  }
  return [];
};

// پیکربندی نشده
let r = await call('POST', '/license/check', { body: { machine_id: MID, nonce: NONCE }, env: { DATABASE_URL: 'x' } });
eq(r.status, 503, 'not configured -> 503 (old apps keep working)');
r = await call('POST', '/license/check', { body: { machine_id: MID, nonce: NONCE }, env: { DATABASE_URL: 'x', LICENSE_DB_URL: 'x' } });
eq(r.status, 503, 'no signing key -> 503');
eq(seen.length, 0, 'no database is touched when not configured');

// ورودی نامعتبر، قبل از هر پرس‌وجو
for (const [body, label] of [[{ machine_id: 'short', nonce: NONCE }, 'bad machine id'], [{ machine_id: MID, nonce: 'zz' }, 'bad nonce'], [{ machine_id: MID.toUpperCase(), nonce: NONCE }, 'uppercase machine id']]) {
  r = await call('POST', '/license/check', { body });
  eq(r.status, 400, label + ' refused');
}
eq(seen.length, 0, 'invalid input never reaches the database');
r = await call('GET', '/license/check');
eq(r.status, 404, 'GET on a POST route -> 404');

// check: وضعیت‌ها
r = await call('POST', '/license/check', { body: { machine_id: MID, nonce: NONCE, version: '2.14.1' } });
eq(r.status, 200, 'check ok');
ok(verify(r.json), 'the reply is signed with the Worker key');
eq([r.json.payload.status, r.json.payload.nonce, r.json.payload.machine_id, r.json.payload.credit, r.json.payload.purpose], ['ok', NONCE, MID, 500, 'license-check'], 'payload echoes machine id + nonce');
eq(r.json.payload.valid_until - r.json.payload.issued, 36 * 3600, 'an ok token lives 36 hours');
eq(r.json.payload.expires_at, 1893456000, 'expiry as epoch seconds');
ok(seen.every(([u]) => u === 'license-db'), 'only the license database is queried');
ok(seen.some(([, q]) => q.includes('report_version')), 'the app version is recorded (best effort)');
const emitCheck = { request: { machine_id: MID, nonce: NONCE, version: '2.14.1' }, response: r.json };
license = { ...license, revoked: true };
r = await call('POST', '/license/check', { body: { machine_id: MID, nonce: NONCE } });
eq([r.json.payload.status, r.json.payload.valid_until - r.json.payload.issued], ['revoked', 600], 'revoked: short token, status revoked');
license = { revoked: false, expires_at: '2020-01-01T00:00:00Z', is_expired: true, gemini_credit_remaining: null };
r = await call('POST', '/license/check', { body: { machine_id: MID, nonce: NONCE } });
eq([r.json.payload.status, r.json.payload.credit], ['expired', null], 'expired + unlimited credit (null)');
r = await call('POST', '/license/check', { body: { machine_id: OTHER, nonce: NONCE } });
eq(r.json.payload.status, 'unknown', 'a machine that is not in the table -> unknown');
globalThis.__reportFail = true;
license = { revoked: false, expires_at: null, is_expired: false, gemini_credit_remaining: 5 };
r = await call('POST', '/license/check', { body: { machine_id: MID, nonce: NONCE, version: '2.14.1' } });
eq([r.status, r.json.payload.status, r.json.payload.expires_at], [200, 'ok', null], 'a failing report_version never breaks the check; no expiry = null');
globalThis.__reportFail = false;
// عوض‌کردنِ یک بایتِ پاسخ، امضا را باطل می‌کند
const forged = JSON.parse(JSON.stringify(r.json)); forged.payload.status = 'revoked';
eq(verify(forged), false, 'a tampered payload fails verification');

// حداقلِ نسخه (MIN_APP_VERSION): فقط وقتی مالک تنظیم کرده و برنامه نسخه‌اش را فرستاده
license = { revoked: false, expires_at: null, is_expired: false, gemini_credit_remaining: 5 };
const withMin = (min) => ({ ...ENV, MIN_APP_VERSION: min });
r = await call('POST', '/license/check', { body: { machine_id: MID, nonce: NONCE, version: '2.14.1' }, env: withMin('2.14.2') });
eq([r.json.payload.status, r.json.payload.valid_until - r.json.payload.issued], ['outdated', 600], 'a version below the minimum is outdated (short token)');
ok(verify(r.json), 'the outdated reply is signed too');
r = await call('POST', '/license/check', { body: { machine_id: MID, nonce: NONCE, version: '2.14.2' }, env: withMin('2.14.2') });
eq(r.json.payload.status, 'ok', 'the minimum itself is allowed');
r = await call('POST', '/license/check', { body: { machine_id: MID, nonce: NONCE, version: '2.15.0' }, env: withMin('2.14.2') });
eq(r.json.payload.status, 'ok', 'newer versions are allowed');
r = await call('POST', '/license/check', { body: { machine_id: MID, nonce: NONCE, version: '2.9.9' }, env: withMin('2.14.0') });
eq(r.json.payload.status, 'outdated', 'versions compare numerically (2.9.9 < 2.14.0)');
r = await call('POST', '/license/check', { body: { machine_id: MID, nonce: NONCE }, env: withMin('9.9.9') });
eq(r.json.payload.status, 'ok', 'no version sent (startup) -> never locked by the minimum');
r = await call('POST', '/license/check', { body: { machine_id: MID, nonce: NONCE, version: '1.0.0' }, env: withMin('garbage') });
eq(r.json.payload.status, 'ok', 'an invalid MIN_APP_VERSION locks nobody');
r = await call('POST', '/license/check', { body: { machine_id: MID, nonce: NONCE, version: '1.0.0' } });
eq(r.json.payload.status, 'ok', 'MIN_APP_VERSION unset -> nobody is locked');
license = { revoked: true, expires_at: null, is_expired: false, gemini_credit_remaining: 5 };
r = await call('POST', '/license/check', { body: { machine_id: MID, nonce: NONCE, version: '1.0.0' }, env: withMin('2.0.0') });
eq(r.json.payload.status, 'revoked', 'revoked still wins over outdated');
license = { revoked: false, expires_at: null, is_expired: false, gemini_credit_remaining: 500 };

// credit
r = await call('POST', '/license/credit', { body: { machine_id: MID, nonce: NONCE } });
eq([r.status, r.json.payload.allowed, r.json.payload.purpose], [200, true, 'license-credit'], 'credit allowed');
ok(verify(r.json), 'credit reply is signed');
const emitCredit = { request: { machine_id: MID, nonce: NONCE }, response: r.json };
globalThis.__allowed = false;
r = await call('POST', '/license/credit', { body: { machine_id: MID, nonce: NONCE } });
eq(r.json.payload.allowed, false, 'quota finished -> allowed=false');
r = await call('POST', '/license/credit', { body: { machine_id: OTHER, nonce: NONCE } });
eq(r.json.payload.allowed, true, 'unknown machine = unlimited (as before)');
r = await call('POST', '/license/credit', { body: { machine_id: MID } });
eq(r.status, 400, 'credit needs a nonce');

// report
r = await call('POST', '/license/report', { body: { machine_id: MID, source: 'server.do_POST', message: 'boom', context: '/api/x', app_version: '2.14.1' } });
eq([r.status, r.json.ok], [200, true], 'error report accepted');

// update
r = await call('GET', '/license/update');
eq([r.status, r.json.version, r.json.sha256], [200, '2.14.2', 'a'.repeat(64)], 'latest release');
globalThis.__noSha = true;
r = await call('GET', '/license/update');
eq([r.status, r.json.version], [200, '2.14.2'], 'before the sha256 column exists the old query is used');

// ادعا: کلیدِ خصوصی هرگز در هیچ پاسخی نیست
ok(!JSON.stringify(r.json).includes(SIGN), 'the signing key never appears in a reply');

if (process.argv.includes('--emit')) {
  fs.writeFileSync(process.argv[process.argv.indexOf('--emit') + 1], JSON.stringify({ public_hex: PUB_HEX, check: emitCheck, credit: emitCredit }));
}
console.log(`PASS: license routes (${n} checks)`);
