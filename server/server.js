// RSVP API for the wedding invitation site.
//
// The site itself is static and lives on GitHub Pages, which cannot run
// server code — so this process only serves the two endpoints the page
// calls: POST /api/rsvp (submit or edit a registration) and GET /api/list
// (admin-only list + summary). Because the page and the API sit on
// different origins, every response carries CORS headers.

const crypto = require('crypto');
const express = require('express');
const store = require('./store');

const PORT = process.env.PORT || 3000;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
// Comma-separated list of origins allowed to call this API.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGIN || 'https://wedding.taolinwei.com')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const MAX_NAME = 40;
const MAX_NOTE = 500;

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);   // behind nginx, so req.ip reflects the real client
app.use(express.json({ limit: '20kb' }));

app.use((req, res, next) => {
  const origin = req.get('Origin');
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-token');
  res.setHeader('Access-Control-Max-Age', '86400');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.post('/api/rsvp', async (req, res) => {
  const body = req.body || {};
  const name = str(body.name, MAX_NAME);
  if (!name) {
    return res.status(400).json({ ok: false, error: '请填写姓名' });
  }
  try {
    // upsert is queued behind other writes, so the response must wait for it:
    // reporting success before the write lands would hide disk errors.
    const { created } = await store.upsert(name, {
      count: clampCount(body.count),
      note: str(body.note, MAX_NOTE),
    });
    res.json({ ok: true, mode: created ? 'created' : 'updated' });
  } catch (err) {
    console.error('保存登记失败:', err);
    res.status(502).json({ ok: false, error: '保存失败：' + err.message });
  }
});

app.get('/api/list', (req, res) => {
  if (!ADMIN_TOKEN) {
    return res.status(500).json({ ok: false, error: '服务端未设置 ADMIN_TOKEN' });
  }
  if (!safeEqual(req.get('x-admin-token') || '', ADMIN_TOKEN)) {
    return res.status(401).json({ ok: false, error: '口令不正确' });
  }

  let records;
  try {
    records = store.listAll();
  } catch (err) {
    return res.status(502).json({ ok: false, error: '读取失败：' + err.message });
  }
  records.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));

  res.json({
    ok: true,
    records,
    summary: {
      entries: records.length,
      attendingPeople: records.reduce((sum, r) => sum + (Number(r.count) || 0), 0),
    },
  });
});

app.get('/health', (req, res) => res.json({ ok: true }));

function str(value, max) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function clampCount(value) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return 1;
  return Math.min(Math.max(n, 1), 5);
}

// Constant-time comparison so response timing doesn't leak the admin token.
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

app.listen(PORT, '127.0.0.1', () => {
  if (!ADMIN_TOKEN) {
    console.warn('警告：未设置 ADMIN_TOKEN，/api/list（后台名单）暂时无法使用');
  }
  console.log(`登记接口已启动，监听 127.0.0.1:${PORT}`);
  console.log(`允许的来源: ${ALLOWED_ORIGINS.join(', ')}`);
});
