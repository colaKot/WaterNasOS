"""把 Flutter Web 的 Noto 回退字体镜像到 flutter_client/web/fonts_fallback/s/。

背景（2026-10-19）：
  Flutter Web（CanvasKit）本身不带中日韩字形。某段文字缺字形时，引擎会去
  `fontFallbackBaseUrl`（默认 https://fonts.gstatic.com/s/）现拉 Noto 的分片 woff2。
  NAS 在内网、或客户端连不上 gstatic ⇒ 拉不到 ⇒ 满屏「方块里一个 X」。
  `web/index.html` 已把 fontFallbackBaseUrl 指到 `fonts_fallback/s/`，
  这个脚本负责把**同一个 SDK 版本**里登记的那批 URL 抄到本地。

用法：
  python tool/fetch_fallback_fonts.py            # 只补缺的
  python tool/fetch_fallback_fonts.py --clean    # 先清空再全下
  python tool/fetch_fallback_fonts.py --list     # 只打印清单，不下载

⚠️ 升级 Flutter SDK 之后必须重跑：URL 里带版本与内容哈希（如 notosanssc/v37/xxx.woff2），
   SDK 一换，旧文件名全失效 ⇒ 又变回豆腐块。
"""
import argparse
import concurrent.futures
import os
import re
import shutil
import sys
import urllib.request

SDK_FILES = [
    'font_fallback_data.dart',
    'canvaskit/fonts.dart',
    'skwasm/skwasm_impl/font_collection.dart',
]
# 只镜像中文界面真正会用到的族：简中 / 繁中 / emoji / 符号 / Roboto（Latin 主体）
FAMILIES = {
    'notosanssc',
    'notosanstc',
    'notocoloremoji',
    'notosanssymbols2',
    'notosanssymbols',
    'notosans',
    'roboto',
}
# canvaskit/fonts.dart 里 roboto 的 URL 是插值拼出来的，正则抓不到，单独补
EXTRA = ['roboto/v32/KFOmCnqEu92Fr1Me4GZLCzYlKw.woff2']

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEST = os.path.join(ROOT, 'flutter_client', 'web', 'fonts_fallback', 's')
BASE = 'https://fonts.gstatic.com/s/'


def sdk_engine_dir():
    """找当前项目用的 Flutter SDK 里的 web 引擎目录。"""
    candidates = [
        os.environ.get('FLUTTER_ROOT', ''),
        r'G:\work\_toolchain\flutter-sdk\flutter',
    ]
    for root in candidates:
        if not root:
            continue
        p = os.path.join(
            root, 'bin', 'cache', 'flutter_web_sdk', 'lib', '_engine', 'engine'
        )
        if os.path.isdir(p):
            return p
    raise SystemExit('找不到 flutter_web_sdk/lib/_engine/engine，请设 FLUTTER_ROOT')


def collect_urls(engine):
    urls = []
    for rel in SDK_FILES:
        path = os.path.join(engine, rel)
        if not os.path.isfile(path):
            continue
        src = open(path, encoding='utf-8').read()
        for m in re.findall(r"'((?:[a-z0-9_]+)/(?:v\d+)/[^']+?\.(?:woff2|ttf))'", src):
            urls.append(m)
    urls.extend(EXTRA)
    seen, out = set(), []
    for u in urls:
        fam = u.split('/')[0]
        if fam not in FAMILIES or u in seen:
            continue
        seen.add(u)
        out.append(u)
    return out


def fetch(rel, force=False):
    dst = os.path.join(DEST, rel.replace('/', os.sep))
    if not force and os.path.isfile(dst) and os.path.getsize(dst) > 512:
        return 'skip'
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    last = None
    for _ in range(3):
        try:
            with urllib.request.urlopen(BASE + rel, timeout=60) as r:
                data = r.read()
            if len(data) < 512:
                raise IOError('too small: %d' % len(data))
            with open(dst, 'wb') as f:
                f.write(data)
            return len(data)
        except Exception as e:  # noqa: BLE001 - 网络错误统一重试三次
            last = e
    print('FAIL %s (%s)' % (rel, last))
    return 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--clean', action='store_true', help='先清空目标目录')
    ap.add_argument('--list', action='store_true', help='只打印清单')
    args = ap.parse_args()

    urls = collect_urls(sdk_engine_dir())
    print('SDK 里登记的字体分片：%d 个' % len(urls))
    if args.list:
        for u in urls:
            print(u)
        return

    if args.clean and os.path.isdir(DEST):
        shutil.rmtree(DEST)
    os.makedirs(DEST, exist_ok=True)

    total = 0
    with concurrent.futures.ThreadPoolExecutor(16) as ex:
        results = list(ex.map(lambda u: fetch(u, force=args.clean), urls))
    total = sum(r for r in results if isinstance(r, int))
    new = sum(1 for r in results if isinstance(r, int) and r > 0)
    fail = sum(1 for r in results if r == 0)
    print('下载 %d 个 (%.1f MB)，跳过 %d 个，失败 %d 个' % (
        new, total / 1048576.0,
        sum(1 for r in results if r == 'skip'), fail))
    print('目标目录：%s' % DEST)
    if fail:
        sys.exit(1)


if __name__ == '__main__':
    main()
