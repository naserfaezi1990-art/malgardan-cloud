// Device limit in the Worker (/sync and /gemini/generate) with a stubbed Neon driver.  node device_gate_test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbd-'));
fs.mkdirSync(path.join(dir, 'node_modules/@neondatabase/serverless'), { recursive: true });
fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}');
fs.writeFileSync(path.join(dir, 'node_modules/@neondatabase/serverless/package.json'), '{"name":"@neondatabase/serverless","type":"module","main":"index.js"}');
fs.writeFileSync(path.join(dir, 'node_modules/@neondatabase/serverless/index.js'), 'export function neon(){ return { query: async (q, p) => globalThis.__db(q, p) }; }');
fs.copyFileSync(path.resolve(import.meta.dirname, '../src/index.js'), path.join(dir, 'worker.js'));
fs.copyFileSync(path.resolve(import.meta.dirname, '../src/prompts.js'), path.join(dir, 'prompts.js'));
const worker = (await import(pathToFileURL(path.join(dir, 'worker.js')).href)).default;

let n = 0;
const eq = (a, b, label) => { n++; if (JSON.stringify(a) !== JSON.stringify(b)) { console.error('FAIL:', label, JSON.stringify(a), '!=', JSON.stringify(b)); process.exit(1); } };
const KEY = 'fbk_' + 'k'.repeat(40), INST = 'ab12cd34ef567890';
const call = async (url, headers = {}, body = {}) => {
  const r = await worker.fetch(new Request('https://x.test' + url, { method: 'POST', headers: { 'X-Sync-Key': KEY, ...headers }, body: JSON.stringify(body) }), { DATABASE_URL: 'x', GEMINI_API_KEY: 'g' }, { waitUntil: (p) => p });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};
const seen = [];
globalThis.__gate = 'ok';
globalThis.__db = async (q, p) => {
  seen.push(q.split('(')[0].trim().slice(0, 30));
  if (q.includes('fb_device_gate')) { if (globalThis.__gate === 'missing') throw new Error('function fb_device_gate does not exist'); return [{ r: globalThis.__gate }]; }
  if (q.includes('fb_sync')) return [{ r: { receipts: 1 } }];
  if (q.includes('fb_device_seen')) return [{ n: 0 }];
  if (q.includes('fb_ai_gate')) return [{ t: 1 }];
  return [];
};
globalThis.fetch = async () => new Response(JSON.stringify({ candidates: [] }), { status: 200 });

// ok: همه‌چیز مثلِ قبل
let r = await call('/sync', { 'X-Install-Id': INST }, { receipts: [] });
eq(r.status, 200, 'registered/allowed device syncs');
r = await call('/gemini/generate', { 'X-Install-Id': INST }, { contents: [] });
eq(r.status, 200, 'registered/allowed device reads fiches');

// سقف: سومین کامپیوتر
globalThis.__gate = 'limit';
seen.length = 0;
r = await call('/sync', { 'X-Install-Id': INST }, { receipts: [] });
eq([r.status, r.json.code], [403, 'device_limit'], 'a third computer is refused on /sync');
ok: { eq(seen.includes('SELECT fb_sync'), false, 'a refused device never reaches the sync function'); }
seen.length = 0;
r = await call('/gemini/generate', { 'X-Install-Id': INST }, { contents: [] });
eq([r.status, r.json.code], [403, 'device_limit'], 'a third computer is refused by the AI gateway (the eye needs our server)');
eq(seen.includes('SELECT fb_ai_gate'), false, 'a refused device costs nothing: no AI gate / usage record');

// بدونِ شناسه (برنامه‌ی قدیمی): اگر require_install_id خاموش است ok، روشن = به‌روز کن
globalThis.__gate = 'ok';
r = await call('/gemini/generate', {}, { contents: [] });
eq(r.status, 200, 'an old app without X-Install-Id still works while the owner has not required it');
globalThis.__gate = 'need_install_id';
r = await call('/gemini/generate', {}, { contents: [] });
eq([r.status, r.json.code], [403, 'need_update'], 'with require_install_id the old app is told to update');
r = await call('/sync', {}, { receipts: [] });
eq([r.status, r.json.code], [403, 'need_update'], 'same on /sync');

// قبل از اجرای 008: بی‌صدا رد می‌شود
globalThis.__gate = 'missing';
r = await call('/sync', { 'X-Install-Id': INST }, { receipts: [] });
eq(r.status, 200, 'before migration 008 the gate is skipped silently');
r = await call('/gemini/generate', { 'X-Install-Id': INST }, { contents: [] });
eq(r.status, 200, 'before migration 008 the AI gateway is unchanged');

// شناسه‌ی نامعتبر مثلِ «بدونِ شناسه» حساب می‌شود (هرگز به SQL نمی‌رسد)
globalThis.__gate = 'ok';
const params = [];
const orig = globalThis.__db;
globalThis.__db = async (q, p) => { if (q.includes('fb_device_gate')) params.push(p[1]); return orig(q, p); };
await call('/sync', { 'X-Install-Id': "x'; drop table tenants;--" }, { receipts: [] });
eq(params[0], null, 'a malformed install id is sent as NULL, never as text');
console.log(`PASS: device gate (${n} checks)`);
