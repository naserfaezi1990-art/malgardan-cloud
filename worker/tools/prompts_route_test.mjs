// Server-side prompts in the Worker: /gemini/caps and fb_prompt in /gemini/generate (stubbed Neon + Gemini).  node prompts_route_test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbp-'));
fs.mkdirSync(path.join(dir, 'node_modules/@neondatabase/serverless'), { recursive: true });
fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}');
fs.writeFileSync(path.join(dir, 'node_modules/@neondatabase/serverless/package.json'), '{"name":"@neondatabase/serverless","type":"module","main":"index.js"}');
fs.writeFileSync(path.join(dir, 'node_modules/@neondatabase/serverless/index.js'), 'export function neon(){ return { query: async (q, p) => globalThis.__db(q, p) }; }');
fs.copyFileSync(path.resolve(import.meta.dirname, '../src/index.js'), path.join(dir, 'worker.js'));
fs.copyFileSync(path.resolve(import.meta.dirname, '../src/prompts.js'), path.join(dir, 'prompts.js'));
const worker = (await import(pathToFileURL(path.join(dir, 'worker.js')).href)).default;
const { PROMPTS } = await import(pathToFileURL(path.join(dir, 'prompts.js')).href);

let n = 0;
const eq = (a, b, label) => { n++; if (JSON.stringify(a) !== JSON.stringify(b)) { console.error('FAIL:', label, JSON.stringify(a), '!=', JSON.stringify(b)); process.exit(1); } };
const KEY = 'fbk_' + 'k'.repeat(40);
globalThis.__db = async (q) => (q.includes('fb_ai_gate') ? [{ t: 1 }] : (q.includes('fb_device_gate') ? [{ r: 'ok' }] : []));
let sent = null;
globalThis.fetch = async (url, init) => { sent = JSON.parse(init.body); return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{}' }] } }] }), { status: 200 }); };
const gen = async (body) => {
  sent = null;
  const r = await worker.fetch(new Request('https://x.test/gemini/generate?model=gemini-3.6-flash', { method: 'POST', headers: { 'X-Sync-Key': KEY }, body: JSON.stringify(body) }), { DATABASE_URL: 'x', GEMINI_API_KEY: 'g' }, { waitUntil: (p) => p });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};

// caps
let r = await worker.fetch(new Request('https://x.test/gemini/caps'), { DATABASE_URL: 'x' }, {});
const caps = await r.json();
eq([r.status, caps.server_prompts.sort()], [200, ['account_card', 'bulk_reformat', 'details', 'fiche', 'offered', 'transaction']], 'caps lists the six server-side prompts (no key needed, no prompt text)');
eq(JSON.stringify(caps).includes(PROMPTS.fiche.slice(0, 20)), false, 'caps never reveals the prompt text');

// vision: متنِ پرامپت را Worker جلوی ورودی می‌گذارد
const img = { inline_data: { mime_type: 'image/jpeg', data: 'AAAA' } };
r = await gen({ contents: [{ parts: [img] }], fb_prompt: 'fiche' });
eq(r.status, 200, 'a named prompt is accepted');
eq(sent.contents[0].parts[0], { text: PROMPTS.fiche }, 'the Worker puts the real prompt first');
eq(sent.contents[0].parts[1], img, 'the customer image follows');
eq('fb_prompt' in sent, false, 'fb_prompt is never forwarded to Gemini');
// متن: مقدارِ کاربر بعد از پرامپت
r = await gen({ contents: [{ parts: [{ text: 'خطِ ۱\nخطِ ۲' }] }], fb_prompt: 'bulk_reformat' });
eq([sent.contents[0].parts[0].text === PROMPTS.bulk_reformat, sent.contents[0].parts[1].text], [true, 'خطِ ۱\nخطِ ۲'], 'text prompts: prompt first, the user text after');
// generationConfig حفظ می‌شود
r = await gen({ contents: [{ parts: [img] }], fb_prompt: 'details', generationConfig: { thinkingConfig: { thinkingLevel: 'low' } } });
eq(sent.generationConfig.thinkingConfig.thinkingLevel, 'low', 'generationConfig passes through');
// نامِ ناشناخته/ساختارِ خراب
for (const bad of ['nope', '__proto__', 'constructor', 'toString']) {
  r = await gen({ contents: [{ parts: [img] }], fb_prompt: bad });
  eq([r.status, sent], [400, null], `unknown prompt name «${bad}» is refused before Gemini`);
}
r = await gen({ fb_prompt: 'fiche' });
eq([r.status, sent], [400, null], 'a broken body is refused');
// بدونِ fb_prompt (برنامه‌ی قدیمی/کلیدِ محلی): بدنه دست‌نخورده، پرامپتِ خودش
const full = { contents: [{ parts: [{ text: 'LOCAL PROMPT' }, img] }] };
r = await gen(full);
eq([r.status, sent], [200, full], 'without fb_prompt the body is forwarded unchanged (old apps keep working)');
console.log(`PASS: server-side prompts (${n} checks)`);
