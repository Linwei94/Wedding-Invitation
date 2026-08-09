# 登记接口服务（部署在你自己的腾讯云服务器上）

网页本身是静态的、托管在 GitHub Pages（`wedding.taolinwei.com`）上，**跑不了后端代码**。
所以出席登记的两个接口单独跑在你的服务器 `120.53.229.45`（域名 `tlwxpw.xyz`）上：

| 接口 | 用途 |
| --- | --- |
| `POST /api/rsvp` | 访客提交/修改登记 |
| `GET /api/list` | 后台读取名单（需要口令） |
| `GET /health` | 健康检查，返回 `{"ok":true}` |

## 为什么用 JSON 文件而不是数据库

这套东西我没法登录你的服务器远程排查，所以选型上优先考虑**部署一次成功的概率**：

- 不用 MySQL/PostgreSQL：省掉装数据库、建库建表、配账号密码这些环节
- 不用 SQLite 的 Node 驱动：那些包需要本地编译，编译失败时很难远程指导修
- 只依赖一个 `express`，`npm install` 基本不会出意外

几百条 `{姓名, 人数, 备注}` 用 JSON 文件完全够用。写入做了两件事保证安全：

- **原子写入**：先写临时文件再 `rename`，`rename` 在 Linux 上是原子操作，
  所以读的人永远不会读到写了一半的文件（进程被杀也不会损坏数据）
- **串行队列**：所有写操作排队执行，避免两个请求同时"读-改-写"导致互相覆盖
  （已用 25 个并发请求实测，零丢失）

数据文件在 `data/rsvp.json`，直接 `cat` 就能看，备份就是复制这个文件。

## 部署步骤

以下命令在**你的服务器**上执行（`120.53.229.45`）。

### 1. 装 Node.js（若还没装）

```bash
curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash -   # CentOS/TencentOS
sudo yum install -y nodejs
# Ubuntu/Debian 用：
# curl -fsSL https://deb.nodesource.com/setup_20.x | sudo bash - && sudo apt install -y nodejs
node -v    # 确认 >= 18
```

### 2. 放代码

```bash
sudo mkdir -p /var/www/wedding-api
sudo git clone https://github.com/Linwei94/Wedding-Invitation.git /tmp/wedding
sudo cp -r /tmp/wedding/server/* /var/www/wedding-api/
cd /var/www/wedding-api
sudo npm install --omit=dev
sudo mkdir -p data && sudo chown -R www-data:www-data /var/www/wedding-api
```

> CentOS 系没有 `www-data` 用户，可改用 `nginx` 用户，
> 同时把 `wedding.service` 里的 `User=`/`Group=` 一起改掉。

### 3. 配置并启动服务

```bash
sudo cp deploy/wedding.service /etc/systemd/system/
sudo nano /etc/systemd/system/wedding.service     # 把 ADMIN_TOKEN 改成你自己的口令
sudo systemctl daemon-reload
sudo systemctl enable --now wedding
sudo systemctl status wedding                     # 应显示 active (running)
curl http://127.0.0.1:3000/health                 # 应返回 {"ok":true}
```

### 4. 域名解析

在域名商把 `tlwxpw.xyz` 的 **A 记录**指向 `120.53.229.45`。
等解析生效（`ping tlwxpw.xyz` 能看到这个 IP）再做下一步。

### 5. nginx 反向代理 + HTTPS

```bash
sudo yum install -y nginx      # 或 apt install -y nginx
sudo cp deploy/nginx.conf /etc/nginx/conf.d/wedding.conf
sudo nginx -t                  # 必须显示 syntax is ok
sudo systemctl enable --now nginx

# 申请免费 HTTPS 证书（certbot 会自动改写上面的 nginx 配置）
sudo yum install -y certbot python3-certbot-nginx    # 或 apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d tlwxpw.xyz
```

**HTTPS 是必须的，不是可选项**：网页在 `https://wedding.taolinwei.com` 上，
浏览器不允许 HTTPS 页面去调用 HTTP 接口（混合内容会被直接拦截）。

### 6. 开放防火墙 / 安全组

腾讯云控制台的**安全组**要放行 `80` 和 `443` 端口。
服务器本机若开了防火墙也要放行：

```bash
sudo firewall-cmd --permanent --add-service={http,https} && sudo firewall-cmd --reload
```

> 接口服务只监听 `127.0.0.1:3000`，外网进不来，必须经过 nginx——
> 所以**不要**去开放 3000 端口。

### 7. 验证

```bash
curl https://tlwxpw.xyz/health
curl -X POST https://tlwxpw.xyz/api/rsvp -H 'Content-Type: application/json' \
     -d '{"name":"测试","count":"2"}'
cat /var/www/wedding-api/data/rsvp.json
```

然后打开 `https://wedding.taolinwei.com` 真机提交一次，再到
`https://wedding.taolinwei.com/admin.html` 输入口令看名单。

## 常用维护命令

```bash
sudo systemctl restart wedding          # 重启
sudo journalctl -u wedding -f           # 看实时日志（报错都在这里）
sudo cat /var/www/wedding-api/data/rsvp.json   # 直接看数据
sudo cp /var/www/wedding-api/data/rsvp.json ~/rsvp-backup-$(date +%F).json   # 备份
```

## 改口令

改 `/etc/systemd/system/wedding.service` 里的 `ADMIN_TOKEN`，然后：

```bash
sudo systemctl daemon-reload && sudo systemctl restart wedding
```

## 换域名时

三个地方要一起改，否则跨域会被浏览器拦：

1. `wedding.service` 里的 `ALLOWED_ORIGIN`（网页所在域名）
2. 仓库根目录 `index.html` 和 `admin.html` 里的 `API_BASE`（接口所在域名）
3. `index.html` 里那几行 `og:` 绝对地址
