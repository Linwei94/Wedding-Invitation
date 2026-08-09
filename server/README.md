# 自托管部署说明

把整个网站（网页 + 登记接口 + 数据）跑在自己的腾讯云服务器上。

- 域名：`wedding.taolinwei.com`
- 服务器：`120.53.229.45`
- 数据存放：服务器上的 `server/data/rsvp.json`，**数据全程在国内，不出境**

## 架构

```
访客 ──HTTPS──▶ nginx (80/443)
                 ├── /            网页、图片、音乐 → 直接读 /var/www/wedding 下的文件
                 └── /api/*       → 转发给 127.0.0.1:3000 的 Node 服务
                                     └── 读写 server/data/rsvp.json
```

网页和接口**同一个域名**，所以不存在跨域问题（`index.html` 里的 `API_BASE` 留空即可）。
Node 只监听 `127.0.0.1`，外网碰不到，只能经 nginx 进来。

## 为什么用 JSON 文件而不是数据库

这套东西部署好之后，出问题时没人能立刻登进服务器排查。所以存储层是按"最不容易启动失败"来选的：
不需要编译原生模块、不需要另起一个数据库服务、不需要管账号密码。
几百条 `{姓名, 人数, 备注, 时间}` 用 JSON 文件完全够用，写入是原子的（先写临时文件再 rename），
并发写入走同一个队列排队，不会互相覆盖。

后台的图表是在浏览器里用这份数据算的，不依赖数据库。

---

## 部署步骤

以下命令都在**服务器上**执行（`ssh root@120.53.229.45`）。

### 1. 域名解析

先在域名商后台加一条记录，等这步生效了再往下走，否则第 5 步申请证书会失败：

| 类型 | 主机记录 | 记录值 |
| --- | --- | --- |
| A | `wedding` | `120.53.229.45` |

验证（在你自己电脑上跑）：

```bash
ping wedding.taolinwei.com     # 解析到 120.53.229.45 就算生效
```

### 2. 腾讯云安全组放行端口

控制台 → 轻量应用服务器/云服务器 → 防火墙（安全组）→ 放行 **80** 和 **443**。

> 这一步最容易漏。漏了的话服务全都正常启动，但外面就是打不开，很难查。

### 3. 装依赖

```bash
# Node 18+（Ubuntu/Debian）
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs nginx git

node -v      # 确认 ≥ 18
```

### 4. 拉代码、装依赖、起服务

```bash
git clone https://github.com/Linwei94/Wedding-Invitation.git /var/www/wedding
cd /var/www/wedding/server
npm install --omit=dev

# 数据目录要让服务进程可写
mkdir -p /var/www/wedding/server/data
chown -R www-data:www-data /var/www/wedding/server/data

# 装 systemd 服务
cp deploy/wedding.service /etc/systemd/system/
# ⚠️ 改掉里面的 ADMIN_TOKEN，别用示例值
nano /etc/systemd/system/wedding.service

systemctl daemon-reload
systemctl enable --now wedding
systemctl status wedding --no-pager     # 看到 active (running) 就对了
curl -s http://127.0.0.1:3000/health    # 应返回 {"ok":true}
```

### 5. 配 nginx + 申请 HTTPS 证书

```bash
cp /var/www/wedding/server/deploy/nginx.conf /etc/nginx/conf.d/wedding.conf
nginx -t && systemctl reload nginx

# 免费证书，certbot 会自动改写上面的 conf 加上 443 和证书路径
apt-get install -y certbot python3-certbot-nginx
certbot --nginx -d wedding.taolinwei.com

# 证书 90 天到期，certbot 装好后会自动续期，验证一下：
systemctl list-timers | grep certbot
```

### 6. 验收

```bash
curl -I https://wedding.taolinwei.com/                    # 200
curl -I https://wedding.taolinwei.com/server/store.js     # 403（服务端代码不可读）
curl -I https://wedding.taolinwei.com/.git/config         # 403（仓库历史不可读）
```

浏览器打开 `https://wedding.taolinwei.com/`，填一次登记表单，
再打开 `https://wedding.taolinwei.com/admin.html` 输入口令，能看到刚才那条就成功了。

---

## 日常操作

**更新网页内容**（改完推到 GitHub 后）：

```bash
cd /var/www/wedding && git pull
systemctl restart wedding      # 只改了图片/网页的话这步可以省
```

**备份宾客名单**（建议婚礼前手动存几次）：

```bash
cp /var/www/wedding/server/data/rsvp.json ~/rsvp-$(date +%F).json
```

后台页面上的「导出 Excel（CSV）」也能拿到同样的数据。

**看日志**：

```bash
journalctl -u wedding -n 50 --no-pager
tail -50 /var/log/nginx/error.log
```

## 出问题时怎么查

| 现象 | 大概率原因 |
| --- | --- |
| 网页打不开、一直转圈 | 安全组没放行 80/443（第 2 步） |
| 502 Bad Gateway | Node 服务没起来 → `systemctl status wedding` |
| 提交登记报错 | 数据目录没有写权限 → 检查第 4 步的 `chown` |
| 后台提示"服务端未设置 ADMIN_TOKEN" | service 文件里的口令没改或没 `daemon-reload` |
| 证书申请失败 | 域名解析还没生效，或 80 端口被占用 |

## 安全须知

- **`ADMIN_TOKEN` 一定要改掉**，后台页面公开可访问，只有口令挡着
- 仓库是公开的，`server/data/` 已加进 `.gitignore`，**宾客数据不会被提交上去**
- nginx 配置里显式拦掉了 `.git` 和 `server/`；改配置时别把这两条删了
