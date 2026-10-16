# WaterNasOS 官方站点部署（wnos.gexuan.net）

纯静态站，照搬泳者圈「技术博客」的上云套路：静态文件 + nginx + acme.sh（阿里云 DNS-01）证书。
与同机的 `swim-blog`（www.gexuan.net）、`swim-api`（106.54.217.61）互不干扰——
本配置是 `server_name` 精确匹配，**不是** default_server。

## 目录

| 位置 | 说明 |
| --- | --- |
| `index.html` | 单页站：Hero / 功能特性 / 全端覆盖 / 下载 / GitHub |
| `assets/` | `style.css`（博客同款设计语言 + 追加样式）、`favicon.svg` |
| `nginx-wnos.conf` | nginx 站点配置（80→301，443 精确匹配 wnos.gexuan.net） |
| `deploy-wnos.sh` | 服务器端部署脚本（rsync + 安装 conf + reload + 自检） |

## 首次部署（已由 2026-10-15 完成，留档）

服务器：腾讯云轻量 `106.54.217.61`（`ssh -i miyao/cola.pem ubuntu@gexuan.net`，密钥在 swim-app 侧，**不随仓库**）。

1. 阿里云 DNS 加 A 记录：`wnos.gexuan.net` → `106.54.217.61`
2. 服务器签发证书（DNS-01，凭据在 `~/.acme.sh/account.conf`，自动续期）：
   ```bash
   ~/.acme.sh/acme.sh --issue --dns dns_ali -d wnos.gexuan.net --keylength ec-256
   sudo mkdir -p /etc/nginx/ssl/wnos.gexuan.net && sudo chown ubuntu:ubuntu /etc/nginx/ssl/wnos.gexuan.net
   ~/.acme.sh/acme.sh --installcert -d wnos.gexuan.net \
     --fullchain-file /etc/nginx/ssl/wnos.gexuan.net/fullchain.pem \
     --key-file /etc/nginx/ssl/wnos.gexuan.net/privkey.pem \
     --reloadcmd "sudo systemctl reload nginx"
   ```
3. 上传部署源并执行脚本（`/.` 传目录内容，落到 `/srv/wnos/deploy/` 平铺结构）：
   ```bash
   scp -i miyao/cola.pem -r deploy/wnos/. ubuntu@gexuan.net:/srv/wnos/deploy/
   ssh -i miyao/cola.pem ubuntu@gexuan.net 'sudo bash /srv/wnos/deploy/deploy-wnos.sh'
   ```

## 日常更新

改完 `index.html` / `assets/` 后重跑第 3 步即可（幂等，`rsync --delete` 会清掉多余文件）。

## 安全红线

- `.pem` / `server-secrets.env` 等密钥只在 `swim-app/miyao/`，**不进本仓库、不进上传包**。
- acme.sh 的阿里云凭据只在服务器 `~/.acme.sh/account.conf`，不另存副本。
- 服务端 `.env` 不在本站点职责内（本站是纯静态，无后端）。
