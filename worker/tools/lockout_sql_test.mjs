import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';

const db = new PGlite();
await db.exec(`CREATE SCHEMA s; CREATE TABLE s.login_attempts(k text PRIMARY KEY, fails int NOT NULL DEFAULT 0, since timestamptz NOT NULL DEFAULT now());`);
const sqlFile = fs.readFileSync(process.argv[2], 'utf8');
for (const chunk of sqlFile.split('-- @@')) {
  const body = chunk.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n').trim();
  if (body) await db.exec(body.replaceAll('{S}', 's'));
}
let fails = 0;
const check = (c, label) => { console.log((c ? 'OK   ' : 'FAIL ') + label); if (!c) fails++; };
const guard = async (k) => { try { await db.query(`SELECT s.fb_guard($1)`, [k]); return null; } catch (e) { return String(e.message); } };
const fail = (k) => db.query(`SELECT s.fb_fail($1)`, [k]);
const row = async (k) => (await db.query(`SELECT fails, locked_until FROM s.login_attempts WHERE k=$1`, [k])).rows[0];
const expire = (k) => db.query(`UPDATE s.login_attempts SET locked_until = now() - interval '1 second' WHERE k=$1`, [k]);

const k = 'admin:demo';
check((await guard(k)) === null, 'بدونِ سابقه: ورود مجاز است');
await fail(k); check((await guard(k)) === null, 'بعد از ۱ اشتباه: قفل نیست');
await fail(k); check((await guard(k)) === null, 'بعد از ۲ اشتباه: قفل نیست');
await fail(k);
let g = await guard(k);
check(g && /locked:(\d+)/.test(g), 'بعد از ۳ اشتباه: قفل می‌شود: ' + g);
let secs = Number((g.match(/locked:(\d+)/) || [])[1]);
check(secs > 0 && secs <= 60, `قفلِ ۱ دقیقه‌ای (باقی‌مانده ${secs} ثانیه)`);
await expire(k);
check((await guard(k)) === null, 'بعد از پایانِ ۱ دقیقه: دوباره می‌شود تلاش کرد');
await fail(k);
g = await guard(k); secs = Number((g.match(/locked:(\d+)/) || [])[1]);
check(secs > 60 && secs <= 300, `۴امین اشتباه: قفلِ ۵ دقیقه‌ای (${secs}s)`);
await expire(k); await fail(k);
g = await guard(k); secs = Number((g.match(/locked:(\d+)/) || [])[1]);
check(secs > 300 && secs <= 900, `۵امین اشتباه: قفلِ ۱۵ دقیقه‌ای (${secs}s)`);
await expire(k); await fail(k);
g = await guard(k); secs = Number((g.match(/locked:(\d+)/) || [])[1]);
check(secs > 900 && secs <= 3600, `۶امین اشتباه: قفلِ ۶۰ دقیقه‌ای (${secs}s)`);
await expire(k); await fail(k);
g = await guard(k); secs = Number((g.match(/locked:(\d+)/) || [])[1]);
check(secs > 900 && secs <= 3600, `اشتباهِ بعدی هم ۶۰ دقیقه (${secs}s)`);
// ورودِ موفق = حذفِ ردیف (همان کاری که fb_admin_login می‌کند)
await db.query(`DELETE FROM s.login_attempts WHERE k=$1`, [k]);
check((await guard(k)) === null && !(await row(k)), 'ورودِ موفق شمارنده را پاک می‌کند');
// ۲۴ ساعت بدونِ اشتباه: شمارنده از نو
await fail(k); await fail(k); await fail(k);
await db.query(`UPDATE s.login_attempts SET since = now() - interval '25 hours', locked_until = now() - interval '24 hours' WHERE k=$1`, [k]);
await fail(k);
const r = await row(k);
check(r.fails === 1 && r.locked_until === null, `بعد از ۲۴ ساعت شمارنده از نو شروع می‌شود (fails=${r.fails})`);
// کلیدهای مختلف (مدیر / طرف‌حساب) از هم جدا هستند
await fail('party:tok'); await fail('party:tok'); await fail('party:tok');
check((await guard('party:tok')) !== null && (await guard('admin:other')) === null, 'قفلِ یک کلید روی کلیدِ دیگر اثر ندارد');
console.log(fails ? `\nFAILED: ${fails}` : '\nALL PASS');
process.exit(fails ? 1 : 0);
