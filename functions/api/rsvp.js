// EdgeOne Pages Function: POST /api/rsvp
// Stores wedding RSVP submissions in EdgeOne KV, keyed by guest name, so a
// guest who submits again under the same name edits their entry rather than
// creating a duplicate.
//
// Requires a KV namespace bound to this project under the name RSVP_KV.

const MAX_NAME = 40;
const MAX_CITY = 40;
const MAX_NOTE = 500;

export async function onRequestPost(context) {
  const { request, env } = context;
  const cors = corsHeaders(env, request);

  const kv = env.RSVP_KV;
  if (!kv) {
    return json({ ok: false, error: '服务端未绑定 KV 存储（RSVP_KV）' }, 500, cors);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: '请求格式错误' }, 400, cors);
  }

  const name = str(body.name, MAX_NAME);
  if (!name) {
    return json({ ok: false, error: '请填写姓名' }, 400, cors);
  }

  const key = 'rsvp:' + name;

  let previous = null;
  try {
    const raw = await kv.get(key);
    if (raw) previous = JSON.parse(raw);
  } catch {
    // A corrupt or unreadable existing value should not block a new
    // submission; treat it as a fresh entry.
    previous = null;
  }

  const now = new Date().toISOString();
  const record = {
    name,
    attend: body.attend === '不出席' ? '不出席' : '出席',
    count: count(body.count),
    city: str(body.city, MAX_CITY) || '上海',
    note: str(body.note, MAX_NOTE),
    createdAt: (previous && previous.createdAt) || now,
    updatedAt: now,
  };

  try {
    await kv.put(key, JSON.stringify(record));
  } catch (err) {
    return json({ ok: false, error: '保存失败：' + msg(err) }, 502, cors);
  }

  return json({ ok: true, mode: previous ? 'updated' : 'created' }, 200, cors);
}

function str(value, max) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function count(value) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return 1;
  return Math.min(Math.max(n, 1), 5);
}

function msg(err) {
  return String((err && err.message) || err);
}

function json(obj, status = 200, cors = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...cors,
    },
  });
}

// The page is served from GitHub Pages while these functions run on EdgeOne,
// so every response needs CORS headers. Set ALLOWED_ORIGIN to the site's
// origin (e.g. https://www.taolinwei.com) to restrict it; unset means "any".
function corsHeaders(env, request) {
  const allowed = env.ALLOWED_ORIGIN || '';
  const origin = request.headers.get('Origin') || '';
  return {
    'Access-Control-Allow-Origin': allowed ? (origin === allowed ? origin : allowed) : '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

export function onRequestOptions(context) {
  return new Response(null, { status: 204, headers: corsHeaders(context.env, context.request) });
}
