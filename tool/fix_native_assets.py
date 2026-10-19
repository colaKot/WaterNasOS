#!/usr/bin/env python3
"""清缓存后重建 Flutter native assets（pdfium / sqlite3）—— 走本地代理。

## 为什么需要这个脚本

`flutter clean` 会删掉 `.dart_tool/hooks_runner`，而里面缓存着各包 build hook
产出的原生库。其中：

  * `pdfium_dart` —— hook 里 **硬编码** 从 GitHub Releases 下载
    （`bblanchon/pdfium-binaries`），没有任何 user_defines 可配置。
    国内网络直连会失败，表现为：
        Target build_hooks failed : error : Building native assets failed.
        PDFium download failed (ClientException: Proxy failed to establish tunnel)
  * `sqlite3` —— 已在各 app 的 pubspec 里配成
    `hooks.user_defines.sqlite3.source: source` + `third_party/sqlite3/sqlite3.c`，
    纯本地编译，**不依赖网络**，本脚本与它无关。

所以：clean 之后，只要有可用代理，用本脚本跑一次构建就能把 pdfium 缓存补回来。

## 用法

    python tool/fix_native_assets.py                      # 自动探测本机代理端口
    python tool/fix_native_assets.py --proxy 21578        # 指定代理端口
    python tool/fix_native_assets.py --target windows     # 默认 windows
    python tool/fix_native_assets.py --target android     # 需要 NDK（已随 Gradle 装好）

探测顺序：命令行 > 环境变量 HTTPS_PROXY > 常见本地端口(21578/7890/10809/1080/61582)。
"""

import argparse
import os
import subprocess
import sys
import urllib.error
import urllib.request

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FLUTTER = os.path.join('G:\\', 'work', '_toolchain', 'flutter-sdk', 'flutter', 'bin', 'flutter.bat')
CANDIDATE_PORTS = [21578, 7890, 10809, 1080, 61582]
PROBE_URL = 'https://github.com/bblanchon/pdfium-binaries/releases/download/chromium%2F7811/pdfium-win-x64.tgz'


def port_works(port: int, timeout: int = 12) -> bool:
    """用 urllib 真正过代理拉一次 GitHub 的头，比单纯连端口可靠。"""
    proxy = f'http://127.0.0.1:{port}'
    handler = urllib.request.ProxyHandler({'http': proxy, 'https': proxy})
    opener = urllib.request.build_opener(handler)
    req = urllib.request.Request(PROBE_URL, method='HEAD')
    try:
        with opener.open(req, timeout=timeout) as resp:
            return resp.status in (200, 206)
    except Exception:
        return False


def detect_proxy(explicit: str | None) -> int | None:
    if explicit:
        p = int(explicit)
        print(f'[*] 使用指定端口 {p} ... ', end='', flush=True)
        print('可用' if port_works(p) else '不可用')
        return p if port_works(p) else None

    env_proxy = os.environ.get('HTTPS_PROXY') or os.environ.get('https_proxy')
    if env_proxy and '127.0.0.1' in env_proxy:
        try:
            p = int(env_proxy.rsplit(':', 1)[-1].strip('/'))
            print(f'[*] 环境变量里的代理 {p} ... ', end='', flush=True)
            if port_works(p):
                print('可用')
                return p
            print('不可用')
        except ValueError:
            pass

    for p in CANDIDATE_PORTS:
        print(f'[*] 探测 127.0.0.1:{p} ... ', end='', flush=True)
        if port_works(p):
            print('可用')
            return p
        print('跳过')
    return None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--proxy', help='代理端口，例如 21578')
    ap.add_argument('--target', default='windows', choices=['windows', 'android', 'macos', 'linux'])
    ap.add_argument('--app', default='flutter_client',
                    help='要构建的客户端目录（默认 flutter_client）')
    args = ap.parse_args()

    port = detect_proxy(args.proxy)
    if port is None:
        print('\n[!] 没找到可用的代理。')
        print('    pdfium 的 build hook 必须能访问 GitHub，否则构建会报')
        print('    "Building native assets failed"。请先启动代理再重试，')
        print('    或用 --proxy <端口> 指定。')
        return 2

    env = dict(os.environ)
    proxy_url = f'http://127.0.0.1:{port}'
    env['HTTPS_PROXY'] = proxy_url
    env['HTTP_PROXY'] = proxy_url
    env.setdefault('PUB_HOSTED_URL', 'https://pub.flutter-io.cn')
    env.setdefault('FLUTTER_STORAGE_BASE_URL', 'https://storage.flutter-io.cn')

    app_dir = os.path.join(REPO, args.app)
    if not os.path.isdir(app_dir):
        print(f'[!] 找不到目录 {app_dir}')
        return 2

    cmd = [FLUTTER, 'build', args.target, '--release', '--no-pub']
    print(f'\n[*] 在 {args.app} 执行：{" ".join(cmd)}')
    print(f'[*] 代理：{proxy_url}\n')

    proc = subprocess.run(cmd, cwd=app_dir, env=env)
    if proc.returncode != 0:
        print(f'\n[!] 构建失败，退出码 {proc.returncode}')
        print('    如果报的是 pdfium 下载失败，换一个代理端口再试。')
        return proc.returncode

    # 顺带核对缓存是否真的落地了
    hooks = os.path.join(app_dir, '.dart_tool', 'hooks_runner', 'shared')
    found = []
    for root, _dirs, files in os.walk(hooks):
        for f in files:
            if f.startswith('libpdfium') or f.startswith('pdfium.') or f.startswith('libsqlite3') or f.startswith('sqlite3.'):
                found.append(os.path.join(root, f))
    if found:
        print('\n[+] native assets 缓存：')
        for f in found:
            print(f'    {os.path.relpath(f, app_dir)}  ({os.path.getsize(f) // 1024} KB)')
    else:
        print('\n[?] 缓存里没找到 pdfium/sqlite3 产物，但构建成功了 —— 可能该平台不需要它们。')
    return 0


if __name__ == '__main__':
    sys.exit(main())
