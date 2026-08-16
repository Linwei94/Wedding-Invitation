// 出席登记名单接口（Cloudflare Worker + D1）
//
// 页面本身是静态的、托管在 GitHub Pages 上，跑不了后端，所以名单存在这里。
// 三个接口，**全部要口令**：
//   POST /api/rsvp   写入/更新一条登记
//   GET  /api/list   读取全部名单
//   GET  /health     存活探测 + 条数
//
// 为什么写入也要口令：请柬页面上已经没有宾客自助登记的表单了——国内宾客占大多数，
// 而境外接口在国内能不能通没法保证，提交失败又是静默的，所以改成宾客直接告诉新人、
// 由新人在后台「手工补录」录入。既然唯一的调用方就是后台，写入就没有理由公开，
// 于是蜜罐、按 IP 限流、以及「为了不误伤宾客而放开来源」这些全都不需要了。
//
// 如果以后想把宾客自助表单加回来，要改的是：这里放开 POST 的鉴权、
// 加回蜜罐与限流、并把写入的 CORS 放宽（原因见 git 历史里的说明）。

const MAX_NAME = 40;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = corsHeaders(env, request);

    try {
      if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: cors });
      }

      if (!env.ADMIN_TOKEN) {
        return json({ ok: false, error: '服务端未设置 ADMIN_TOKEN' }, 500, cors);
      }
      // 三个接口都要口令，所以鉴权放在路由之前，不可能有哪条路径漏掉。
      if (!safeEqual(request.headers.get('x-admin-token') || '', env.ADMIN_TOKEN)) {
        return json({ ok: false, error: '口令不正确' }, 401, cors);
      }

      if (url.pathname === '/health') {
        return await health(env, cors);
      }
      if (url.pathname === '/api/rsvp' && request.method === 'POST') {
        return await submit(request, env, cors);
      }
      if (url.pathname === '/api/list' && request.method === 'GET') {
        return await listAll(env, cors);
      }
      return json({ ok: false, error: '接口不存在' }, 404, cors);
    } catch (err) {
      // 兜底：任何未预料的异常也要带上 CORS 头返回，否则浏览器只能看到一个
      // 没有信息的 "Failed to fetch"，前端分不清是网络问题还是服务端报错。
      return json({ ok: false, error: '服务器出错：' + msg(err) }, 500, cors);
    }
  },

  async scheduled(event, env, ctx) {
    const { backup } = await import('./backup.js');
    ctx.waitUntil(backup(env));
  },
};

// ---- POST /api/rsvp ----

async function submit(request, env, cors) {
  // 后台用 text/plain 发送，所以自己 parse，不能用 request.json()。
  let body;
  try {
    body = JSON.parse(await request.text());
  } catch {
    return json({ ok: false, error: '请求格式错误' }, 400, cors);
  }
  if (!body || typeof body !== 'object') {
    return json({ ok: false, error: '请求格式错误' }, 400, cors);
  }

  const name = str(body.name, MAX_NAME);
  if (!name) {
    return json({ ok: false, error: '请填写姓名' }, 400, cors);
  }
  const count = clampCount(body.count);
  const now = new Date().toISOString();

  // 流水先写，名单后写。顺序是故意的：万一 upsert 失败，流水里仍留有这次写入，
  // 名单可以事后从流水还原；反过来就真丢了。
  await env.DB.prepare(
    'INSERT INTO rsvp_log (name, count, at) VALUES (?, ?, ?)'
  ).bind(name, count, now).run();

  // 一条语句完成「有则更新、无则新增」，避免先读后写的竞态，
  // 并且用 excluded.* 保住首次登记时间 created_at。
  const res = await env.DB.prepare(
    `INSERT INTO rsvp (name, count, created_at, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET
       count = excluded.count,
       updated_at = excluded.updated_at
     RETURNING created_at = updated_at AS is_new`
  ).bind(name, count, now, now).first();

  return json({ ok: true, mode: res && res.is_new ? 'created' : 'updated' }, 200, cors);
}

// ---- GET /api/list ----

async function listAll(env, cors) {
  // 一条 SELECT 拿全部，不像 KV 那样要先 list 再逐个 get。
  const { results } = await env.DB.prepare(
    `SELECT name, count, created_at, updated_at
     FROM rsvp ORDER BY updated_at DESC`
  ).all();

  const records = (results || []).map((r) => ({
    name: r.name,
    count: Number(r.count) || 0,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));

  return json({
    ok: true,
    records,
    summary: {
      entries: records.length,
      attendingPeople: records.reduce((sum, r) => sum + r.count, 0),
      lastSubmissionAt: records.length ? records[0].updatedAt : null,
    },
  }, 200, cors);
}

// ---- GET /health ----
//
// 真的去查一下数据库，而不是无脑返回 ok——否则「Worker 活着但 D1 绑错了」
// 这种故障它会报健康。
async function health(env, cors) {
  try {
    const row = await env.DB.prepare(
      'SELECT COUNT(*) AS n, MAX(updated_at) AS last FROM rsvp'
    ).first();
    return json({
      ok: true,
      entries: Number((row && row.n) || 0),
      lastSubmissionAt: (row && row.last) || null,
    }, 200, cors);
  } catch (err) {
    return json({ ok: false, error: '数据库不可用：' + msg(err) }, 503, cors);
  }
}

// ---- 小工具 ----

function str(value, max) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function clampCount(value) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return 1;
  return Math.min(Math.max(n, 1), 5);
}

function msg(err) {
  return String((err && err.message) || err);
}

// 定长比较，避免响应时间泄漏口令。
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...cors,
    },
  });
}

// 后台页面在 GitHub Pages 上、接口在 Cloudflare 上，属于跨域，所以要带 CORS 头。
// ALLOWED_ORIGIN 是英文逗号分隔的白名单；留空表示不限（只建议本地调试时这样）。
function corsHeaders(env, request) {
  const allowed = String(env.ALLOWED_ORIGIN || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const origin = request.headers.get('Origin') || '';
  return {
    'Access-Control-Allow-Origin': !allowed.length
      ? '*'
      : allowed.includes(origin) ? origin : allowed[0],
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, x-admin-token',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}
