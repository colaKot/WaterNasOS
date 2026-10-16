#!/usr/bin/env bash
# =============================================================
#  WaterNasOS 官方站点（wnos.gexuan.net）· 服务器端部署脚本
#
#  在服务器上执行（需要 sudo）：
#    sudo bash /srv/wnos/deploy/deploy-wnos.sh
#
#  做的事（与 deploy-blog.sh 同套路，绝不触碰 swim-api / swim-blog）：
#    1) rsync 静态文件 /srv/wnos/deploy/ → /srv/wnos/www（--delete）
#    2) 安装 nginx-wnos.conf 到 sites-available/swim-wnos 并启用
#    3) nginx -t 校验通过后 reload
#    4) 自检：本机 Host 头打首页 / 跳转 / 静态资源 / 博客与网关回归
#
#  幂等：重复执行只是刷新文件与配置。
#
#  ⚠️ 前置：证书须已签发并安装到 /etc/nginx/ssl/wnos.gexuan.net/
#    （签发：~/.acme.sh/acme.sh --issue --dns dns_ali -d wnos.gexuan.net --keylength ec-256）
# =============================================================
set -euo pipefail

APP_DIR=/srv/wnos
SRC="$APP_DIR/deploy"
DST="$APP_DIR/www"
NGINX_SRC="$SRC/nginx-wnos.conf"
NGINX_DST=/etc/nginx/sites-available/swim-wnos
NGINX_LINK=/etc/nginx/sites-enabled/swim-wnos
CERT=/etc/nginx/ssl/wnos.gexuan.net/fullchain.pem
CERT_KEY=/etc/nginx/ssl/wnos.gexuan.net/privkey.pem

log() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }

[ "$(id -u)" -eq 0 ] || { echo "请用 sudo 执行：sudo bash $0"; exit 1; }
[ -d "$SRC" ] || { echo "缺少 $SRC —— 先把 deploy/wnos/ 上传到 $SRC"; exit 1; }
[ -f "$NGINX_SRC" ] || { echo "缺少 $NGINX_SRC"; exit 1; }
[ -f "$CERT" ] && [ -f "$CERT_KEY" ] || {
  echo "缺少证书 $CERT / $CERT_KEY"
  echo "先签发：~/.acme.sh/acme.sh --issue --dns dns_ali -d wnos.gexuan.net --keylength ec-256"
  exit 1
}

# ---------------------------------------------------------------- 1. 同步静态文件
log "1/4 同步静态文件到 $DST"
install -d -m 755 "$DST"

if command -v rsync >/dev/null 2>&1; then
  rsync -a --delete \
    --exclude='deploy-wnos.sh' --exclude='nginx-wnos.conf' --exclude='README.md' \
    --exclude='preview' \
    "$SRC/" "$DST/"
else
  # 没有 rsync 时用「新建 → 换名」的方式，避免出现半截状态
  rm -rf "$DST.new" "$DST.old"
  mkdir -p "$DST.new"
  cp -a "$SRC/." "$DST.new/"
  rm -f "$DST.new/deploy-wnos.sh" "$DST.new/nginx-wnos.conf" "$DST.new/README.md"
  rm -rf "$DST.new/preview"
  [ -d "$DST" ] && mv "$DST" "$DST.old"
  mv "$DST.new" "$DST"
  rm -rf "$DST.old"
fi

find "$DST" -type d -exec chmod 755 {} +
find "$DST" -type f -exec chmod 644 {} +
echo "  文件数：$(find "$DST" -type f | wc -l)"

# ---------------------------------------------------------------- 2. 安装站点配置
log "2/4 安装 Nginx 站点 swim-wnos"
install -m 644 "$NGINX_SRC" "$NGINX_DST"
ln -sfn "$NGINX_DST" "$NGINX_LINK"

# ---------------------------------------------------------------- 3. 校验并重载
log "3/4 校验配置并 reload"
nginx -t
systemctl reload nginx

# ---------------------------------------------------------------- 4. 自检
log "4/4 自检"

# ⚠️ 一律用 HTTPS + Host 头打本机：80 段带 301 跳转，走 HTTP 只会拿到 301。
#    本机 curl 的 Host 头指域名，nginx 按 server_name 精确匹配落到 swim-wnos。

idx_code="$(curl -sk -o /tmp/wnos-index.html -w '%{http_code}' --max-time 8 -H 'Host: wnos.gexuan.net' https://127.0.0.1/ || true)"
if [ "$idx_code" = "200" ] \
  && grep -q '粤ICP备18009785号' /tmp/wnos-index.html \
  && grep -q 'github.com/colaKot/WaterNasOS' /tmp/wnos-index.html; then
  echo "  ✓ 首页 200，页脚含备案号，GitHub 链接在位"
else
  echo "  ✗ 首页异常：HTTP $idx_code"
  head -c 300 /tmp/wnos-index.html || true
fi

http_code="$(curl -sk -o /dev/null -w '%{http_code}' --max-time 8 -H 'Host: wnos.gexuan.net' http://127.0.0.1/ || true)"
echo "  $( [ "$http_code" = "301" ] && echo ✓ || echo ✗ ) HTTP → HTTPS 跳转：$http_code"

css_code="$(curl -sk -o /dev/null -w '%{http_code}' --max-time 8 -H 'Host: wnos.gexuan.net' https://127.0.0.1/assets/style.css || true)"
echo "  $( [ "$css_code" = "200" ] && echo ✓ || echo ✗ ) 样式 /assets/style.css → HTTP $css_code"

fav_code="$(curl -sk -o /dev/null -w '%{http_code}' --max-time 8 -H 'Host: wnos.gexuan.net' https://127.0.0.1/assets/favicon.svg || true)"
echo "  $( [ "$fav_code" = "200" ] && echo ✓ || echo ✗ ) 图标 /assets/favicon.svg → HTTP $fav_code"

# 证书主体必须是本域名
cert_cn="$(echo | openssl s_client -connect 127.0.0.1:443 -servername wnos.gexuan.net 2>/dev/null | openssl x509 -noout -subject 2>/dev/null || true)"
echo "  证书主体：${cert_cn:-<取不到>}"

# ---------- 回归：不能把博客站和网关打挂 ----------
blog_code="$(curl -sk -o /dev/null -w '%{http_code}' --max-time 8 -H 'Host: www.gexuan.net' https://127.0.0.1/ || true)"
echo "  $( [ "$blog_code" = "200" ] && echo ✓ || echo ✗ ) 回归：www.gexuan.net 首页 → HTTP $blog_code"

api_code="$(curl -sk -o /dev/null -w '%{http_code}' --max-time 8 https://127.0.0.1/healthz || true)"
echo "  $( [ "$api_code" = "200" ] && echo ✓ || echo ✗ ) 回归：/healthz 网关 → HTTP $api_code"

echo
echo "站点根目录：$DST"
echo "站点配置：  $NGINX_DST"
echo "日志：      /var/log/nginx/swim-wnos.access.log"
echo "外网验证：  curl -sSI https://wnos.gexuan.net/ | head -5"
