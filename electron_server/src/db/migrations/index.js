'use strict';
/**
 * 极简迁移执行器（schema-as-code）。
 *
 * 设计目标只有一个：**让结构变更可见、有序、可复现**。
 * 不做回滚（SQLite 的 DDL 回滚不可靠，假承诺比没承诺更糟），
 * 不做自动生成 diff（那要靠 ORM，我们不是）。
 *
 * 用法：
 *   · 服务端起服时自动跑（见 dbUtil.createAllTablesAndIndexes 末尾）
 *   · 手动：`tool/migrate.js status|verify|up [--dry-run]`
 *
 * 登记表：**主库**的 `schema_migrations`（全局一份，跨库迁移也记在这里）
 * 迁移文件：`NNNN-名字.js`，导出 `{ name, up({ knexMain, knexPhoto, knexVideo, knexBook, knexMusic, knexFile }) }`
 *
 * ⛔ 铁律：登记表里记的是**已经跑过的**；磁盘上有但没登记进 `_order.js` 的，
 *    一律视为配置错误并**抛错**（不是忽略、不是自动补登记）。
 */

const fs = require('fs');
const path = require('path');
const Logger = require('../../utils/logger');
const ORDER = require('./_order');

const TABLE = 'schema_migrations';
const DIR = __dirname;
const FILE_RE = /^\d{4}-[A-Za-z0-9_.-]+\.js$/;

/** 磁盘上实际存在的迁移名（按文件名排序） */
function listFiles() {
  return fs
    .readdirSync(DIR)
    .filter((f) => FILE_RE.test(f))
    .map((f) => f.replace(/\.js$/, ''))
    .sort();
}

/**
 * 校验磁盘 ↔ 清单是否一致。
 * @returns {{ok:boolean, order:string[], files:string[], notListed:string[], missing:string[]}}
 */
function verifyOrder() {
  const files = listFiles();
  const order = Array.isArray(ORDER) ? ORDER.slice() : [];
  const notListed = files.filter((f) => order.indexOf(f) === -1);
  const missing = order.filter((f) => files.indexOf(f) === -1);
  return { ok: notListed.length === 0 && missing.length === 0, order, files, notListed, missing };
}

async function ensureTable(knexMain) {
  const has = await knexMain.schema.hasTable(TABLE);
  if (has) return;
  await knexMain.schema.createTable(TABLE, (t) => {
    t.increments('id').primary();
    t.text('name').notNullable().unique();
    // 跑完的时间戳（对标 Immich 用可空时间戳而不是布尔位来表达「做没做、什么时候做的」）
    t.timestamp('applied_at').defaultTo(knexMain.fn.now());
    t.float('duration_ms').nullable();
  });
  Logger.info(`✅ Table ${TABLE} created`);
}

async function appliedSet(knexMain) {
  try {
    const rows = await knexMain(TABLE).select('name');
    return new Set((Array.isArray(rows) ? rows : []).map((r) => String(r.name)));
  } catch (_) {
    return new Set();
  }
}

/**
 * 待执行的迁移（**严格按 _order.js 的顺序**，不按文件名重排）。
 * 若已有迁移被「跳过」（清单顺序与已登记记录矛盾），直接抛错而不是继续。
 */
async function pending(knexMain) {
  const check = verifyOrder();
  if (!check.ok) {
    const err = new Error(
      `迁移清单不一致：未在 _order.js 登记=[${check.notListed.join(', ') || '无'}]；` +
        `清单里有但磁盘上不存在=[${check.missing.join(', ') || '无'}]`
    );
    err.code = 'MIGRATION_ORDER_MISMATCH';
    throw err;
  }
  const applied = await appliedSet(knexMain);
  const out = [];
  for (const name of check.order) {
    if (applied.has(name)) continue;
    out.push(name);
    }
  // 防「已登记但清单里没有」：说明有人删了清单项
  for (const name of applied) {
    if (check.order.indexOf(name) === -1) {
      const err = new Error(`已应用过迁移 ${name}，但它不在 _order.js 里了（不允许删清单项）`);
      err.code = 'MIGRATION_ORDER_MISMATCH';
      throw err;
    }
  }
  return out;
}

/**
 * 执行迁移。
 * ⚠️ 逐条执行、逐条登记：某条失败就停在那儿，下次启动从它继续（幂等性由迁移自己保证）。
 *
 * @param {{knexMain:any, knexPhoto?:any, knexVideo?:any, knexBook?:any, knexMusic?:any, knexFile?:any}} ctx
 * @param {{dryRun?:boolean}} [opts]
 * @returns {Promise<{applied:string[], skipped:string[]}>}
 */
async function migrate(ctx, opts = {}) {
  const knexMain = ctx && ctx.knexMain;
  if (!knexMain) throw new Error('migrate() 需要 ctx.knexMain');
  const dryRun = opts.dryRun === true;

  await ensureTable(knexMain);
  const todo = await pending(knexMain);
  const applied = await appliedSet(knexMain);
  const skipped = Array.from(applied).filter((n) => todo.indexOf(n) === -1);

  if (todo.length === 0) {
    return { applied: [], skipped };
  }

  const done = [];
  for (const name of todo) {
    const mod = require(path.join(DIR, name));
    if (!mod || typeof mod.up !== 'function') {
      throw new Error(`迁移 ${name} 没有导出 up() 函数`);
    }
    if (dryRun) {
      Logger.info(`[migrate] (dry-run) 将执行 ${name}`);
      done.push(name);
      continue;
    }
    const t0 = Date.now();
    await mod.up(ctx);
    const ms = Date.now() - t0;
    await knexMain(TABLE).insert({ name, duration_ms: ms });
    Logger.info(`[migrate] ✅ ${name} (${ms}ms)`);
    done.push(name);
  }
  return { applied: done, skipped };
}

/** 只读查询：已应用 / 待应用 / 清单一致性 */
async function status(ctx) {
  const knexMain = ctx && ctx.knexMain;
  if (!knexMain) throw new Error('status() 需要 ctx.knexMain');
  await ensureTable(knexMain);
  const check = verifyOrder();
  let appliedList = [];
  try {
    appliedList = (await knexMain(TABLE).select('name', 'applied_at').orderBy('id', 'asc')).map((r) => ({
      name: String(r.name),
      applied_at: r.applied_at ? String(r.applied_at) : null,
    }));
  } catch (_) {
    appliedList = [];
  }
  const appliedNames = new Set(appliedList.map((r) => r.name));
  let todo = [];
  let error = null;
  try {
    todo = await pending(knexMain);
  } catch (err) {
    error = err.message;
  }
  return {
    consistent: check.ok,
    not_listed: check.notListed,
    missing: check.missing,
    applied: appliedList,
    pending: todo,
    error,
  };
}

module.exports = { TABLE, DIR, listFiles, verifyOrder, pending, migrate, status, ORDER };
