// 每天把名单备份到一个**私有**仓库（由 wrangler.toml 里的 cron 触发）。
//
// 为什么值得做：名单是这个项目里唯一不可再生的东西。Worker 挂了可以重部，
// 域名解析错了可以改，名单丢了就只能挨个打电话问。
//
// 为什么用 Worker 而不是浏览器去写 GitHub：写仓库需要 PAT，放进静态页面就等于公开
// （而且 GitHub 的密钥扫描会直接把它吊销）。Worker 在国内之外，访问 github.com 没问题，
// PAT 作为 secret 只存在服务端。
//
// 备份仓库必须是私有的：里面是宾客的真实姓名。

export async function backup(env) {
  if (!env.BACKUP_REPO || !env.BACKUP_TOKEN) return;   // 没配就当没开

  const { results } = await env.DB.prepare(
    `SELECT name, count, created_at, updated_at
     FROM rsvp ORDER BY updated_at DESC`
  ).all();
  const rows = results || [];

  // 拒绝用一份「突然少了很多」的数据覆盖好的备份。
  // 没有这道闸，一次读取异常就会把上一份完好的名单冲掉，而且悄无声息。
  const previous = await readPrevious(env);
  if (previous !== null && rows.length < previous - 2) {
    throw new Error(
      `名单条数从 ${previous} 掉到 ${rows.length}，疑似读取异常，本次不备份`
    );
  }

  const stamp = new Date().toISOString();
  await put(env, `${env.BACKUP_PATH || 'guests'}.json`,
    JSON.stringify({ backedUpAt: stamp, entries: rows.length, records: rows }, null, 2));
  await put(env, `${env.BACKUP_PATH || 'guests'}.csv`, toCsv(rows));

  // 只有确实备份成功了才 ping。这样「密钥被吊销」「推送失败」会变成一条告警，
  // 而不是安静地什么都没发生。
  if (env.HEALTHCHECK_URL) {
    await fetch(env.HEALTHCHECK_URL, { method: 'POST', body: `ok ${rows.length}` });
  }
}

async function readPrevious(env) {
  const res = await gh(env, `${env.BACKUP_PATH || 'guests'}.json`, { method: 'GET' });
  if (res.status === 404) return null;          // 第一次备份
  if (!res.ok) return null;                     // 读不到就别拦着这次备份
  try {
    const file = await res.json();
    const body = JSON.parse(atob(file.content.replace(/\n/g, '')));
    return Number(body.entries);
  } catch {
    return null;
  }
}

async function put(env, path, content) {
  // GitHub Contents API 要求内容是 base64，且更新已有文件必须带上它的 sha。
  const head = await gh(env, path, { method: 'GET' });
  let sha;
  if (head.ok) {
    const meta = await head.json();
    sha = meta.sha;
  }

  const res = await gh(env, path, {
    method: 'PUT',
    body: JSON.stringify({
      message: `备份出席名单 ${new Date().toISOString().slice(0, 10)}`,
      content: b64(content),
      sha,
    }),
  });
  if (!res.ok) {
    throw new Error(`备份 ${path} 失败：HTTP ${res.status} ${await res.text()}`);
  }
}

function gh(env, path, init) {
  return fetch(`https://api.github.com/repos/${env.BACKUP_REPO}/contents/${path}`, {
    ...init,
    headers: {
      'Authorization': `Bearer ${env.BACKUP_TOKEN}`,
      'Accept': 'application/vnd.github+json',
      'User-Agent': 'wedding-rsvp-backup',
      'Content-Type': 'application/json',
    },
  });
}

// 中文要用 UTF-8 再 base64，直接 btoa 会在非 Latin-1 字符上抛错。
function b64(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function toCsv(rows) {
  const head = ['姓名', '人数', '首次登记', '最后修改'];
  const body = rows.map((r) => [r.name, r.count, r.created_at, r.updated_at]);
  // 带 BOM，Excel 打开中文才不乱码。
  return '﻿' + [head, ...body].map((cols) => cols.map(cell).join(',')).join('\r\n');
}

// 除了正常转义引号，还要掐掉 Excel 公式注入：万一姓名里出现
// =HYPERLINK("http://坏地址")，双击打开 CSV 就会变成一个活的公式。
function cell(value) {
  let s = String(value == null ? '' : value);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return '"' + s.replace(/"/g, '""') + '"';
}
