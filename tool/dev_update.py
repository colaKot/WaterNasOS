# -*- coding: utf-8 -*-
"""开发期快速更新：把**服务端 app.asar** 和 **web 产物**原地同步进已有的 dist。

比 `build_server_pack.bat` 快约 100 倍（142 秒 → 1.3 秒），因为它完全不碰那
1.3 GB 固定内容（Electron 运行时 / libs / onnx_models / geonames 地理库），
只重写真正会变的东西：

* **服务端代码**在 `resources/app.asar` 的数据区里 —— 每轮重写（默认动作）；
* **前端**在 `resources/web/main/` 和 `electron_server/web/main/` —— 只有当
  `flutter_client/build/web` 比你上次同步时更新时才拷（`--no-web` 可跳过）。

实测结构（dist_v14）
--------------------
* asar 数据区里真正打包的只有 **591 个文件 / 213 MB**，其中约 208 MB 是
  `database/geonames.sqlite` + `onnx_models/` 这两块从不改动的内容；
  真正会变的 `src/` 只有几 MB。
* 另外 **7140 个文件在 index 里带 `unpacked: true`**，实际躺在
  `resources/app.asar.unpacked/` 目录里（electron-builder 的 smartUnpack 把
  含 native 模块的包整个解出来了）。

⚠️ 正因为有这 7140 个 unpacked 条目，**不能用 `asar pack` 重打** ——
   官方 CLI 不会保留 unpacked 标记，重打后 native 模块会加载失败。
   所以这里由 Python 自己重写：**index 结构原样保留**，
   只把数据区里那 591 个 packed 条目的内容重新灌一遍。

做法
----
1. 读 asar 头部 → 拿到 index（JSON）与数据区起点；
2. 遍历 index，收集所有 **非 unpacked** 的条目；
3. 每个条目的新内容**直接取自 `electron_server/<相对路径>`**
   （源已删除的则回退用归档内的旧数据，并打警告）；
4. 按新顺序重算 offset，回填 index，写出新 asar；
5. 首次会留一份 `app.asar.bak` 兜底。

安全性
------
本项目 `package.json` 没有配 `electronFuses`，electron-builder 的
`doAddElectronFuses` 会直接 return、不改任何 fuse ⇒ Electron 用出厂默认值，
`EnableEmbeddedAsarIntegrityValidation` **是关闭的**，所以替换 app.asar
不会让 exe 拒绝启动。

⚠️ 本脚本只用于**开发验证**。正式发布仍然走 `tool/build_server_pack.bat`。

⚠️ app.asar **不能改名 / 不能删**：实测它被某个长期持有句柄的进程以「共享读写」
   方式打开（WorkBuddy 进程树内外都一样），rename / delete 会 WinError 32/5，
   但**允许写内容** —— 所以这里是原地覆盖，而不是替换文件。

用法
----
    python tool/dev_update.py                    # 自动选版本号最大的 dist_vN
    python tool/dev_update.py --dist dist_v14    # 指定输出目录
    python tool/dev_update.py --dry-run          # 只体检，不写盘
    python tool/dev_update.py --no-web           # 只更 asar，不动 web
    python tool/dev_update.py --restore          # 从 app.asar.bak 还原
    （或者直接双击 tool/dev_update.bat）
"""
import argparse
import json
import os
import shutil
import struct
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SERVER = os.path.join(ROOT, 'electron_server')


def log(msg):
    # 控制台是 GBK（cp936）时 '\u2705' 这类字符写 stdout 会抛 UnicodeEncodeError。
    # 它崩在「归档已经写完」之后，会把一次成功的更新变成 rc=1，
    # 而本仓库的判断口径是「看退出码」⇒ 会被误判成失败。退回用 buffer 写 UTF-8。
    try:
        sys.stdout.write(msg + '\n')
    except UnicodeEncodeError:
        sys.stdout.buffer.write((msg + '\n').encode('utf-8', 'replace'))
    sys.stdout.flush()


def overwrite_in_place(new_path, target_path):
    """把 [new_path] 的内容**原地**盖进 [target_path]。

    ⚠️ 这里不能用 `os.replace`。实测 `dist_*/win-unpacked/resources/app.asar`
    被某个长期持有句柄的进程（试过 WorkBuddy 进程树内外都一样）以
    「共享读写」方式打开：**允许写内容，但 rename / delete 一律 WinError 32/5**。
    原地覆盖是这个环境下唯一可行的办法。

    安全性：新内容已经先在 `.new` 里完整生成并自校验，且首次会留
    `app.asar.bak`；万一写一半中断，用 `--restore` 还原即可。
    """
    with open(new_path, 'rb') as src, open(target_path, 'r+b') as dst:
        dst.seek(0)
        while True:
            chunk = src.read(1 << 20)
            if not chunk:
                break
            dst.write(chunk)
        dst.truncate()


def human(n):
    for unit in ('B', 'KB', 'MB', 'GB'):
        if n < 1024 or unit == 'GB':
            return ('%d B' % n) if unit == 'B' else ('%.1f %s' % (n, unit))
        n /= 1024.0


def find_dist(name):
    if name:
        p = os.path.join(SERVER, name)
        if not os.path.isdir(p):
            sys.exit('!! 目录不存在: %s' % p)
        return p, name
    best = None
    for n in os.listdir(SERVER):
        full = os.path.join(SERVER, n)
        if not os.path.isdir(full):
            continue
        if n == 'dist':
            rank = -1
        elif n.startswith('dist_v') and n[6:].isdigit():
            rank = int(n[6:])
        else:
            continue
        if best is None or rank > best[0]:
            best = (rank, n)
    if best is None:
        sys.exit('!! electron_server/ 下没找到 dist / dist_v* 目录，请先跑一次打包')
    return os.path.join(SERVER, best[1]), best[1]


def load_asar(path):
    """返回 (index, data_start, raw_header)；index 即 JSON 里的 files 根节点。"""
    with open(path, 'rb') as f:
        head = f.read(16)
        if len(head) < 16:
            sys.exit('!! app.asar 头部不完整，文件可能已损坏')
        _a, _b, _c, json_size = struct.unpack('<IIII', head)
        raw = f.read(json_size)
    if len(raw) < json_size:
        sys.exit('!! app.asar 的 JSON 索引不完整，文件可能已损坏')
    index = json.loads(raw.decode('utf-8'))
    pad = (4 - json_size % 4) % 4
    return index, 16 + json_size + pad


def collect_packed(node, prefix, out):
    """收集所有**非 unpacked**（真正存在数据区里）的文件条目。"""
    for name, sub in node.items():
        path = prefix + '/' + name if prefix else name
        if 'files' in sub:
            collect_packed(sub['files'], path, out)
        elif not sub.get('unpacked'):
            out.append((path, sub))


def count_unpacked(node):
    n = 0
    for sub in node.values():
        if 'files' in sub:
            n += count_unpacked(sub['files'])
        elif sub.get('unpacked'):
            n += 1
    return n


def sync_web(dist_path, dry):
    """把 flutter_client/build/web 同步到 dist 与 electron_server 两处。

    只在源产物比目标新时才拷，免得把旧的倒灌回去。
    打包产物里本来没有 `web/`（`package.json` 的 files 有 `!web/*`），
    dist 下这一层是我们自己建的。
    """
    src_dir = os.path.join(ROOT, 'flutter_client', 'build', 'web')
    src_main = os.path.join(src_dir, 'main.dart.js')
    if not os.path.isfile(src_main):
        log('  没有 %s，先跑 tool/build_web.bat' % src_dir)
        return
    src_mtime = os.path.getmtime(src_main)
    targets = [
        os.path.join(dist_path, 'win-unpacked', 'web', 'main'),
        os.path.join(SERVER, 'web', 'main'),
    ]
    for dst in targets:
        rel = os.path.relpath(dst, ROOT).replace('\\', '/')
        dst_main = os.path.join(dst, 'main.dart.js')
        if os.path.isfile(dst_main) and os.path.getmtime(dst_main) >= src_mtime:
            log('  = 已是最新：%s' % rel)
            continue
        log('  -> 同步到 %s' % rel)
        if dry:
            continue
        os.makedirs(dst, exist_ok=True)
        for name in os.listdir(src_dir):
            s = os.path.join(src_dir, name)
            d = os.path.join(dst, name)
            if os.path.isdir(s):
                shutil.copytree(s, d, dirs_exist_ok=True)
            else:
                shutil.copy2(s, d)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--dist', default=None, help='输出目录名，如 dist_v14；默认取版本号最大的')
    ap.add_argument('--dry-run', action='store_true', help='只体检，不写盘')
    ap.add_argument('--restore', action='store_true', help='从 app.asar.bak 还原')
    ap.add_argument('--no-web', action='store_true', help='只更 asar，不动 web 产物')
    args = ap.parse_args()

    dist_path, dist_name = find_dist(args.dist)
    res_dir = os.path.join(dist_path, 'win-unpacked', 'resources')
    asar_path = os.path.join(res_dir, 'app.asar')
    bak_path = asar_path + '.bak'

    if not os.path.isfile(asar_path):
        sys.exit('!! 找不到 %s，请先跑一次 tool/build_server_pack.bat' % asar_path)

    if args.restore:
        if not os.path.isfile(bak_path):
            sys.exit('!! 没有备份可还原: %s' % bak_path)
        shutil.copy2(bak_path, asar_path)
        log('✅ 已从 %s 还原 app.asar' % os.path.basename(bak_path))
        return

    log('目标    : %s\\win-unpacked\\resources\\app.asar' % dist_name)
    old_size = os.path.getsize(asar_path)
    log('当前归档: %s' % human(old_size))

    t_all = time.time()
    index, data_start = load_asar(asar_path)
    root = index.get('files', {})
    entries = []
    collect_packed(root, '', entries)
    unpacked_n = count_unpacked(root)
    packed_bytes = sum(e[1].get('size', 0) for e in entries)
    log('归档内容: 数据区内 %d 个文件（%s），unpacked 条目 %d 个（不参与重写）'
        % (len(entries), human(packed_bytes), unpacked_n))

    # ---- 1. 决定每个条目取哪份数据 ----
    from_src = 0
    from_old = 0
    missing = []
    plan = []
    cursor = 0
    for path, node in entries:
        src = os.path.join(SERVER, path.replace('/', os.sep))
        old_off = int(node.get('offset', 0))
        old_len = node.get('size', 0)
        if os.path.isfile(src):
            size = os.path.getsize(src)
            plan.append((path, src, old_off, old_len, cursor, size))
            from_src += 1
        else:
            missing.append(path)
            plan.append((path, None, old_off, old_len, cursor, old_len))
            from_old += 1
        node['size'] = plan[-1][5]
        node['offset'] = str(cursor)
        cursor += plan[-1][5]

    log('数据来源: 源目录 %d 个，回退归档 %d 个' % (from_src, from_old))
    if missing:
        log('  ! 源已不存在、沿用归档旧内容的 %d 个（前 5 个）：' % len(missing))
        for p in missing[:5]:
            log('      %s' % p)

    # ---- web 产物（可选） ----
    log('\n---- web 产物 ----')
    if args.no_web:
        log('  (--no-web：跳过)')
    else:
        sync_web(dist_path, args.dry_run)

    if args.dry_run:
        log('\n(dry-run：检查完毕，未写盘)')
        return

    # ---- 2. 写出新 asar ----
    log('\n写出新归档 …')
    t0 = time.time()
    json_bytes = json.dumps(index, separators=(',', ':'), ensure_ascii=False).encode('utf-8')
    pad = (4 - len(json_bytes) % 4) % 4
    header = struct.pack(
        '<IIII',
        4,
        len(json_bytes) + 8 + pad,
        len(json_bytes) + 4 + pad,
        len(json_bytes),
    )

    tmp_path = asar_path + '.new'
    if os.path.exists(tmp_path):
        os.remove(tmp_path)

    written = 0
    with open(asar_path, 'rb') as old, open(tmp_path, 'wb') as new:
        new.write(header)
        new.write(json_bytes)
        new.write(b'\x00' * pad)
        for path, src, old_off, old_len, new_off, size in plan:
            if src is not None:
                with open(src, 'rb') as fh:
                    left = size
                    while left > 0:
                        chunk = fh.read(min(1 << 20, left))
                        if not chunk:
                            break
                        new.write(chunk)
                        left -= len(chunk)
                    if left > 0:
                        new.write(b'\x00' * left)
                        log('  ! %s 读取短了 %d 字节，已补零' % (path, left))
            else:
                old.seek(data_start + old_off)
                left = old_len
                while left > 0:
                    chunk = old.read(min(1 << 20, left))
                    if not chunk:
                        new.write(b'\x00' * left)
                        left = 0
                        break
                    new.write(chunk)
                    left -= len(chunk)
            written += size

    # ---- 3. 自校验：重新解析一遍新归档 ----
    try:
        check_index, check_start = load_asar(tmp_path)
        check_entries = []
        collect_packed(check_index.get('files', {}), '', check_entries)
        if len(check_entries) != len(entries):
            raise ValueError('条目数不一致 %d != %d' % (len(check_entries), len(entries)))
        expected = sum(e[5] for e in plan)
        if check_start + expected != os.path.getsize(tmp_path):
            raise ValueError('数据区长度不符')
    except Exception as exc:  # noqa: BLE001
        os.remove(tmp_path)
        sys.exit('!! 新归档自校验失败，已放弃写入：%s' % exc)

    if not os.path.exists(bak_path):
        shutil.copy2(asar_path, bak_path)
        log('已备份原始归档 → app.asar.bak（%s）' % human(old_size))

    overwrite_in_place(tmp_path, asar_path)
    try:
        os.remove(tmp_path)
    except OSError:
        pass
    new_size = os.path.getsize(asar_path)
    log('完成 %.1fs，%s → %s' % (time.time() - t0, human(old_size), human(new_size)))

    log('\n✅ %s 已更新（总耗时 %.1fs）' % (dist_name, time.time() - t_all))
    log('   直接启动 %s\\win-unpacked\\WaterNasOSServer.exe 即可。' % dist_name)
    log('   要还原：python tool/dev_update.py --restore')


if __name__ == '__main__':
    main()
