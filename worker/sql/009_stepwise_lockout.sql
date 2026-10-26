-- Stepwise login lockout (owner request 1405/08/04): 3 wrong attempts -> 1 minute, 4th -> 5 minutes, 5th -> 15 minutes, 6th and later -> 60 minutes.
-- Replaces the fixed "5 wrong = 15 minutes" rule. The counter resets after a successful login (the login functions already delete the row) or after 24 hours without a failure.
-- fb_guard raises 'locked:<seconds>' so the Worker can tell the page how long to wait (retry_after) and the page shows a countdown.
-- Additive (one nullable column + two CREATE OR REPLACE FUNCTION); safe on production. Rehearse first:
--   py migrate.py --schema fbtest --rehearse   (then --file 009_stepwise_lockout.sql --schema public)
-- @@
ALTER TABLE {S}.login_attempts ADD COLUMN IF NOT EXISTS locked_until timestamptz
-- @@
CREATE OR REPLACE FUNCTION {S}.fb_guard(p_k text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO {S}, public
AS $$
DECLARE r login_attempts%ROWTYPE; secs int;
BEGIN
  SELECT * INTO r FROM login_attempts WHERE k = p_k;
  IF FOUND AND r.locked_until IS NOT NULL AND r.locked_until > now() THEN
    secs := ceil(extract(epoch FROM (r.locked_until - now())))::int;
    RAISE EXCEPTION 'locked:%', secs;
  END IF;
END $$
-- @@
CREATE OR REPLACE FUNCTION {S}.fb_fail(p_k text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO {S}, public
AS $$
DECLARE n int;
BEGIN
  INSERT INTO login_attempts(k, fails, since) VALUES (p_k, 1, now())
  ON CONFLICT (k) DO UPDATE SET
    fails = CASE WHEN login_attempts.since < now() - interval '24 hours' THEN 1 ELSE login_attempts.fails + 1 END,
    since = now();
  SELECT fails INTO n FROM login_attempts WHERE k = p_k;
  UPDATE login_attempts SET locked_until = CASE
      WHEN n >= 6 THEN now() + interval '60 minutes'
      WHEN n = 5 THEN now() + interval '15 minutes'
      WHEN n = 4 THEN now() + interval '5 minutes'
      WHEN n = 3 THEN now() + interval '1 minute'
      ELSE NULL END
  WHERE k = p_k;
END $$
