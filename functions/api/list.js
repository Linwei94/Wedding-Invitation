// EdgeOne Pages Function: GET /api/list
// Returns every RSVP record as JSON, for the /admin page.
//
// Protected by a shared secret: the caller must send the value of the
// ADMIN_TOKEN environment variable in an "x-admin-token" header.

export async function onRequestGet(context) {
  const { request, env } = context;
  const cors = corsHeaders(env, request);

  const kv = env.RSVP_KV;
  if (!kv) {
    return json({ ok: false, error: '服务端未绑定 KV 存储（RSVP_KV）' }, 500, cors);
  }
  if (!env.ADMIN_TOKEN) {
    return json({ ok: false, error: '服务端未设置 ADMIN_TOKEN' }, 500, cors);
  }

  const supplied = request.headers.get('x-admin-token') || '';
  if (!safeEqual(supplied, env.ADMIN_TOKEN)) {
    return json({ ok: false, error: '口令不正确' }, 401, cors);
  }

  let records;
  try {
    records = await readAll(kv);
  } catch (err) {
    return json({ ok: false, error: '读取失败：' + msg(err) }, 502, cors);
  }

  records.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));

  const attending = records.filter((r) => r.attend === '出席');
  return json({
    ok: true,
    records,
    summary: {
      entries: records.length,
      attendingEntries: attending.length,
      attendingPeople: attending.reduce((sum, r) => sum + (Number(r.count) || 0), 0),
    },
  }, 200, cors);
}

async function readAll(kv) {
  const out = [];
  let cursor;

  // KV list responses are paginated; keep following the cursor until the
  // provider reports the listing is complete.
  do {
    const page = await kv.list({ prefix: 'rsvp:', cursor });
    const keys = (page && page.keys) || [];

    for (const entry of keys) {
      const key = typeof entry === 'string' ? entry : entry.name;
      if (!key) continue;
      const raw = await kv.get(key);
      if (!raw) continue;
      try {
        out.push(JSON.parse(raw));
      } catch {
        // Skip anything that is not a record we wrote.
      }
    }

    cursor = page && page.list_complete === false ? page.cursor : undefined;
  } while (cursor);

  return out;
}

// Compare in constant time so the response timing does not leak the token.
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
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
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'x-admin-token',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

export function onRequestOptions(context) {
  return new Response(null, { status: 204, headers: corsHeaders(context.env, context.request) });
}
