#!/usr/bin/env node
/**
 * 导出 OpenAPI 规格到文件（「单一真源」落盘）。
 *
 * 用法（必须在 electron_server 目录下、用 Electron 的 Node 跑）：
 *   node_modules\electron\dist\electron.exe ..\tool\dump_openapi.js [输出路径]
 *
 * 默认输出 `outputs/openapi.json`。这份文件应当**随代码一起提交**：
 *   · 前后端对齐接口时看它，而不是翻路由文件
 *   · 将来生成 Dart/TS 客户端时以它为输入
 *   · 每次改动接口后重新导出，diff 里就能看出「谁动了哪个接口」
 *
 * ⚠️ 会 require 整个 express app（只构建不监听），所以会有副作用日志（userDataFolder 之类），属正常。
 */
'use strict';
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..', 'electron_server');
process.chdir(ROOT);

const outArg = process.argv[2];
const OUT = outArg
  ? path.resolve(outArg)
  : path.resolve(__dirname, '..', 'outputs', 'openapi.json');

// app.js 会打一堆启动日志；只在真的是报错时放行到 stderr
const realLog = console.log;
console.log = (...a) => {
  const s = String(a[0] || '');
  if (/error|fail|throw|undefined is not/i.test(s)) realLog(...a);
};
const realWarn = console.warn;
console.warn = () => {};

let app;
try {
  app = require(path.join(ROOT, 'src', 'api', 'app'));
} catch (err) {
  console.log = realLog;
  console.error('❌ 构建 express app 失败：', err && err.message ? err.message : err);
  console.error('   （若原因与数据库有关，请先设置 PATH_DATABASE 指向 nascab_os_server 的 database 目录）');
  process.exit(2);
}
console.log = realLog;
console.warn = realWarn;

const oas = require(path.join(ROOT, 'src', 'api', 'openapi'));
let version = '0.0.0';
try {
  version = String(require(path.join(ROOT, 'package.json')).version || '0.0.0');
} catch (_) {}

const spec = oas.buildSpec(app, { version, title: 'WaterNasOS Server API' });

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(spec, null, 2) + '\n', 'utf8');

const S = spec['x-summary'];
console.log('✅ 已导出：' + OUT);
console.log('   路径 ' + S.path_count + ' 条 ｜ 路由 ' + S.route_count + ' 条 ｜ 通配跳过 ' + S.wildcard_skipped);
console.log('   模块（tags）：' + spec.tags.map((t) => t.name).join(', '));
console.log('\n⚠️ 鉴权覆盖审计：' + S.unsecured_count + ' 个接口没有 authenticateJWT');
for (const u of S.unsecured) console.log('   · ' + u);
console.log('\n（这些不一定是问题：websocket 通道与 /api/mcp 走的是各自的鉴权方式。');
console.log('  但它们是最该定期核对的一批 —— appAccessGuard 对未登记前缀是放行的。）');
