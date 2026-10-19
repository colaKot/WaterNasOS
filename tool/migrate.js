#!/usr/bin/env node
/**
 * 迁移 CLI。
 *
 * 用法（必须在 electron_server 目录下、用 Electron 的 Node 跑 —— better-sqlite3 是 Electron ABI）：
 *   set PATH_DATABASE=%APPDATA%\nascab_os_server\database
 *   set ELECTRON_RUN_AS_NODE=1
 *   node_modules\electron\dist\electron.exe ..\tool\migrate.js status
 *   node_modules\electron\dist\electron.exe ..\tool\migrate.js verify
 *   node_modules\electron\dist\electron.exe ..\tool\migrate.js up [--dry-run]
 */
'use strict';
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..', 'electron_server');
process.chdir(ROOT);

const cmd = (process.argv[2] || 'status').toLowerCase();
const dryRun = process.argv.includes('--dry-run');

const DB_DIR = process.env.PATH_DATABASE || path.join(process.env.APPDATA || '', 'nascab_os_server', 'database');
const MAIN_DB = path.join(DB_DIR, 'nascab_main.db');
const PHOTO_DB = path.join(DB_DIR, 'nascab_photo.db');
if (!fs.existsSync(MAIN_DB)) {
  console.error('❌ 找不到主库：' + MAIN_DB);
  console.error('   请设置 PATH_DATABASE 指向 nascab_os_server 的 database 目录');
  process.exit(2);
}

const knexFactory = require(path.join(ROOT, 'node_modules', 'knex'));
const mk = (file) => knexFactory({ client: 'better-sqlite3', connection: { filename: file }, useNullAsDefault: true });
const knexMain = mk(MAIN_DB);
const knexPhoto = fs.existsSync(PHOTO_DB) ? mk(PHOTO_DB) : null;
knexMain.raw('PRAGMA busy_timeout = 15000').catch(() => {});
if (knexPhoto) knexPhoto.raw('PRAGMA busy_timeout = 15000').catch(() => {});

const migrations = require(path.join(ROOT, 'src', 'db', 'migrations'));

(async () => {
  const ctx = { knexMain, knexPhoto };

  if (cmd === 'verify') {
    const c = migrations.verifyOrder();
    console.log('清单（_order.js）共', c.order.length, '条：');
    for (const n of c.order) console.log('   ', n, c.files.indexOf(n) === -1 ? '  ❌ 磁盘上不存在' : '');
    if (c.notListed.length) console.log('❌ 未登记进 _order.js：', c.notListed.join(', '));
    if (c.missing.length) console.log('❌ 清单里有但磁盘上不存在：', c.missing.join(', '));
    console.log(c.ok ? '\n✅ 清单一致' : '\n❌ 清单不一致（启动会被拒绝）');
    process.exit(c.ok ? 0 : 1);
  }

  if (cmd === 'status') {
    const st = await migrations.status(ctx);
    console.log('清单一致 =', st.consistent ? '✅' : '❌ ' + (st.error || ''));
    if (st.not_listed.length) console.log('  未登记：', st.not_listed.join(', '));
    if (st.missing.length) console.log('  缺失：', st.missing.join(', '));
    console.log('\n已应用（' + st.applied.length + '）：');
    for (const r of st.applied) console.log('   ', r.name, r.applied_at || '');
    console.log('\n待应用（' + st.pending.length + '）：');
    for (const n of st.pending) console.log('   ', n);
    if (st.error) { console.error('\n❌ ' + st.error); process.exit(1); }
    process.exit(0);
  }

  if (cmd === 'up') {
    const r = await migrations.migrate(ctx, { dryRun });
    console.log((dryRun ? '(dry-run) ' : '') + '本次应用 ' + r.applied.length + ' 条：' + (r.applied.join(', ') || '无'));
    process.exit(0);
  }

  console.error('未知命令：' + cmd + '（可用：status / verify / up）');
  process.exit(1);
})().catch(async (e) => {
  console.error('❌', e && e.message ? e.message : e);
  process.exit(1);
});
