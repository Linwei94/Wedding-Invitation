// 本地跑 Worker 的壳子：用 node:sqlite 模拟 Cloudflare D1，同时把静态页面也伺服起来。
// 这样不用部署就能把「填表 → 写库 → 后台看名单」整条链路真的跑一遍。
//
//   node worker/dev.mjs <仓库目录> [端口]
//
// 只用于本地验证，不是生产代码。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

const ROOT = process.argv[2] || process.cwd();
const PORT = Number(process.argv[3] || 8813);

const db = new DatabaseSync(':memory:');
db.exec(fs.readFileSync(path.join(ROOT, 'worker/schema.sql'), 'utf8'));

// D1 的最小可用子集：prepare().bind().run()/.first()/.all()
const D1 = {
  prepare(sql) {
    let params = [];
    const api = {
      bind(...args) { params = args; return api; },
      async run() { db.prepare(sql).run(...params); return { success: true }; },
      async first() { return db.prepare(sql).get(...params) ?? null; },
      async all() { return { results: db.prepare(sql).all(...params) }; },
    };
    return api;
  },
};

const env = {
  DB: D1,
  ADMIN_TOKEN: process.env.ADMIN_TOKEN || 'test-token-1234567890',
  ALLOWED_ORIGIN: process.env.ALLOWED_ORIGIN ?? 'https://www.taolinwei.com,https://linwei94.github.io',
};

const worker = (await import(pathToFileURL(path.join(ROOT, 'worker/src/index.js')))).default;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.jpg': 'image/jpeg', '.png': 'image/png', '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg', '.webmanifest': 'application/manifest+json',
};

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1:' + PORT);

  if (url.pathname.startsWith('/api/') || url.pathname === '/health') {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) headers.set(k, v);
    const request = new Request(url, {
      method: req.method,
      headers,
      body: ['GET', 'HEAD', 'OPTIONS'].includes(req.method) ? undefined : Buffer.concat(chunks),
    });
    const out = await worker.fetch(request, env);
    res.writeHead(out.status, Object.fromEntries(out.headers));
    res.end(Buffer.from(await out.arrayBuffer()));
    return;
  }

  let file = path.join(ROOT, decodeURIComponent(url.pathname));
  // 目录当成 index.html，跟 GitHub Pages 的行为保持一致——
  // 否则本地看 /en/ 是 404，而线上是好的，白排查一轮。
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) {
    file = path.join(file, 'index.html');
  }
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404).end('not found');
    return;
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}).listen(PORT, '127.0.0.1', () => console.log('dev worker on http://127.0.0.1:' + PORT));
