-- 出席名单的数据表。用 wrangler 建库后执行：
--   wrangler d1 execute rsvp --remote --file=./schema.sql

-- 当前名单。以姓名为主键，所以同名再写是覆盖而不是新增。
CREATE TABLE IF NOT EXISTS rsvp (
  name       TEXT PRIMARY KEY,
  count      INTEGER NOT NULL DEFAULT 1,
  created_at TEXT    NOT NULL,
  updated_at TEXT    NOT NULL
);

-- 只追加、不修改的写入流水。名单被误覆盖或误删时靠它还原：
--   wrangler d1 execute rsvp --remote --command "SELECT * FROM rsvp_log ORDER BY at DESC LIMIT 50"
CREATE TABLE IF NOT EXISTS rsvp_log (
  id    INTEGER PRIMARY KEY AUTOINCREMENT,
  name  TEXT    NOT NULL,
  count INTEGER NOT NULL,
  at    TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rsvp_log_at ON rsvp_log(at);
