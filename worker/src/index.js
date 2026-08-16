// 出席登记接口（Cloudflare Worker + D1）
//
// 页面本身是静态的、托管在 GitHub Pages 上，跑不了后端，所以登记要发到这里。
// 三个接口：
//   POST /api/rsvp   写入/更新一条登记（公开，任何人可调）
//   GET  /api/list   读取全部名单（要 x-admin-token，给 admin.html 用）
//   GET  /health     存活探测 + 给页面预热连接用
//
// 为什么写入接口不校验来源、也不放任何密钥：页面是静态的，任何塞进页面的
// 密钥都等于公开。所以写入靠校验、长度上限、蜜罐和限流来兜，而不是靠密钥。

const MAX_NAME = 40;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = corsHeaders(env, request, url.pathname);

    try {
      if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: cors });
      }
      if (url.pathname === '/health') {
        return health(env, cors);
      }
      if (url.pathname === '/api/rsvp' && request.method === 'POST') {
        return await submit(request, env, cors);
      }
      if (url.pathname === '/api/list' && request.method === 'GET') {
        return await listAll(request, env, cors);
      }
      return json({ ok: false, error: '接口不存在' }, 404, cors);
    } catch (err) {
      // 兜底：任何未预料的异常也要带上 CORS 头返回，否则浏览器只能看到
      // 一个没有信息的 "Failed to fetch"，前端无法区分「被墙」和「服务器报错」。
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
  // 前端用 text/plain 发送（CORS 简单请求，不触发 OPTIONS 预检，省一个往返），
  // 所以这里自己 parse，不能用 request.json()。
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

  // 蜜罐：真人看不到那个输入框（挪到屏幕外 + tabindex=-1 + autocomplete=off），
  // 填了的基本都是脚本。但**命中也照样把人写进名单**——万一某个密码管理器或
  // 读屏工具替真宾客填了这一栏，拒写就等于「他看到登记成功、名单里却没有他」，
  // 那是这个项目里最不能出现的故障。防刷交给限流和长度上限，蜜罐只当一个标记，
  // 记在流水表里事后可查：
  //   wrangler d1 execute rsvp --remote --command "SELECT * FROM rsvp_log WHERE honeypot=1"
  const honeypot = str(body.website_url, 100) ? 1 : 0;

  const ipHash = await hashIp(request.headers.get('CF-Connecting-IP') || '', env.IP_SALT || '');
  const now = new Date().toISOString();

  // 后台的「手工补录」也是走这个公开接口写入的，但那是新人自己在用，不该被限流挡住：
  // 一次粘几十上百位电话确认的宾客进去，第 61 条就会 429。带对口令就跳过限流。
  const isAdmin = !!env.ADMIN_TOKEN &&
    safeEqual(request.headers.get('x-admin-token') || '', env.ADMIN_TOKEN);

  if (!isAdmin && (await tooManyWrites(env, ipHash))) {
    return json({ ok: false, error: '提交太频繁了，请过几分钟再试' }, 429, cors);
  }

  // 流水先写，名单后写。顺序是故意的：万一 upsert 失败，流水里仍留有这次提交，
  // 名单可以事后从流水还原；反过来就真丢了。
  await env.DB.prepare(
    'INSERT INTO rsvp_log (name, count, ip_hash, honeypot, at) VALUES (?, ?, ?, ?, ?)'
  ).bind(name, count, ipHash, honeypot, now).run();

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

// 同一个 IP 在时间窗内写了多少次。Worker 实例的内存不是持久状态，
// 所以限流只能落在 D1 上，直接数流水表。
async function tooManyWrites(env, ipHash) {
  const limit = int(env.RATE_LIMIT, 60);
  const windowMin = int(env.RATE_WINDOW_MIN, 10);
  if (limit <= 0) return false;

  const since = new Date(Date.now() - windowMin * 60 * 1000).toISOString();
  const row = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM rsvp_log WHERE ip_hash = ? AND at > ?'
  ).bind(ipHash, since).first();

  return !!row && Number(row.n) >= limit;
}

// ---- GET /api/list ----

async function listAll(request, env, cors) {
  if (!env.ADMIN_TOKEN) {
    return json({ ok: false, error: '服务端未设置 ADMIN_TOKEN' }, 500, cors);
  }
  const supplied = request.headers.get('x-admin-token') || '';
  if (!safeEqual(supplied, env.ADMIN_TOKEN)) {
    return json({ ok: false, error: '口令不正确' }, 401, cors);
  }

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
// 有两个用途，所以它真的去查一下数据库，而不是无脑返回 ok：
// 1. 页面加载时打一发，把 DNS + TCP + TLS 提前握好，宾客点提交时就只剩一个往返
// 2. 后台显示「最近一条登记是多久前」，用来发现「静悄悄没人提交了」这种故障
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

function int(value, dflt) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : dflt;
}

function msg(err) {
  return String((err && err.message) || err);
}

// 只存 IP 的盐化哈希：限流够用，又不至于把宾客的 IP 明文留在库里。
async function hashIp(ip, salt) {
  if (!ip) return 'unknown';
  const data = new TextEncoder().encode(salt + '|' + ip);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)]
    .slice(0, 16)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
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

// 写入接口对所有来源开放，读取接口只认自己的页面。
//
// 写入这里放开是经过权衡的：没有预检的简单请求会先落库、再由浏览器决定要不要
// 把响应给页面。如果这里卡来源，遇到微信/QQ 内置浏览器或运营商代理改写、丢掉
// Origin 头的情况，就会出现「其实已经写进去了，但宾客看到提交失败」——
// 这比放开来源糟糕得多。写入的防护交给校验、长度上限、蜜罐和限流。
function corsHeaders(env, request, pathname) {
  const common = {
    'Access-Control-Allow-Headers': 'Content-Type, x-admin-token',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };

  if (pathname === '/api/list') {
    const allowed = String(env.ALLOWED_ORIGIN || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const origin = request.headers.get('Origin') || '';
    return {
      ...common,
      'Access-Control-Allow-Origin': !allowed.length
        ? '*'
        : allowed.includes(origin) ? origin : allowed[0],
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
    };
  }

  return {
    ...common,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  };
}
