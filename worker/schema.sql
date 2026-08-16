-- 出席登记的数据表。用 wrangler 建库后执行：
--   wrangler d1 execute rsvp --remote --file=./schema.sql

-- 当前名单。以姓名为主键，所以同名再提交是覆盖而不是新增。
CREATE TABLE IF NOT EXISTS rsvp (
  name       TEXT PRIMARY KEY,
  count      INTEGER NOT NULL DEFAULT 1,
  created_at TEXT    NOT NULL,
  updated_at TEXT    NOT NULL
);

-- 只追加、不修改的提交流水。名单被覆盖或误删时靠它还原，
-- 同时用来做「同一个 IP 短时间内提交了多少次」的限流判断。
CREATE TABLE IF NOT EXISTS rsvp_log (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  name     TEXT    NOT NULL,
  count    INTEGER NOT NULL,
  ip_hash  TEXT    NOT NULL,  -- 只存盐化哈希，不存真实 IP
  honeypot INTEGER NOT NULL DEFAULT 0,
  at       TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rsvp_log_at    ON rsvp_log(at);
CREATE INDEX IF NOT EXISTS idx_rsvp_log_ip_at ON rsvp_log(ip_hash, at);
