'use strict';
/**
 * sqlite-vec（vec0 虚表）接入层 —— 向量检索下沉数据库。
 *
 * 为什么是它（设计借鉴 Immich v3.3，代码未参考其实现）：
 *   Immich 把向量放进 Postgres 并用 HNSW 索引（`vector_cosine_ops, m=16, ef_construction=300`），
 *   检索时过滤条件与 `order by embedding <=> q limit k` 写在同一条 SQL 里。
 *   我们是单机 SQLite，等价物就是 sqlite-vec。
 *
 * ⭐ 为什么它能绕开我们最怕的坑：sqlite-vec 是**普通 SQLite 可加载扩展（.dll）**，
 *   不是 Node 原生模块 ⇒ 不参与 Node/Electron ABI 匹配 ⇒ **不需要 electron-rebuild**。
 *   我们的 better-sqlite3 是 Electron ABI，绝不能 rebuild；加原生模块（hnswlib/usearch）就会踩这个雷。
 *
 * 本机实测（30000×512 float32，Electron 37 + better-sqlite3 12.5）：
 *   写入 30k ≈ 0.6s ｜ KNN top-60 ≈ 70ms ｜ KNN(400)+JOIN+路径过滤 ≈ 96ms
 *   对照：JS 全表扫同一批数据 ≈ 490ms（且要把 60MB Buffer 搬进 JS 堆）
 *
 * ⚠️ 铁律：扩展加载失败必须**静默降级**，绝不能阻断服务启动或抛到调用方。
 *    老库、未随包的 dll、非 win-x64 平台都要能照常跑（只是向量检索退回旧路径）。
 */

const path = require('path');
const fs = require('fs');
const Logger = require('./logger');

/** 塔输出的向量维度。换塔若改维度，这里与 photo_emb 表要一起改。 */
const VEC_DIM = 512;

/** 检索表名。rowid 直接复用 `photo_index.id`，便于 KNN 之后 JOIN 回主表。 */
const TABLE = 'photo_emb';

let _dllPathCache = null;
let _availableCache = null;
let _loadErrorLogged = false;

/**
 * dll 位置：随包放在应用根目录 `vendor/sqlite_vec/vec0.dll`（走 extraFiles，不进 asar）。
 * 开发环境根目录 = electron_server/，生产 = exe 所在目录。
 */
function resolveDllPath() {
  if (_dllPathCache !== null) return _dllPathCache;
  try {
    const config = require('../config/config');
    _dllPathCache = path.join(config.getRootPath(), 'vendor', 'sqlite_vec', 'vec0.dll');
  } catch (_) {
    _dllPathCache = path.join(__dirname, '..', '..', 'vendor', 'sqlite_vec', 'vec0.dll');
  }
  return _dllPathCache;
}

function isAvailable() {
  if (_availableCache !== null) return _availableCache;
  try {
    _availableCache = fs.existsSync(resolveDllPath());
  } catch (_) {
    _availableCache = false;
  }
  return _availableCache;
}

/**
 * 在一个原始 better-sqlite3 Database 上加载扩展。
 * @param {any} db better-sqlite3 实例
 * @returns {boolean} 是否加载成功
 */
function loadOnDatabase(db) {
  if (!isAvailable()) return false;
  if (!db || typeof db.loadExtension !== 'function') return false;
  try {
    db.loadExtension(resolveDllPath());
    return true;
  } catch (err) {
    if (!_loadErrorLogged) {
      _loadErrorLogged = true;
      Logger.warn(
        `[sqliteVec] 扩展加载失败，向量检索退回旧路径（不影响其他功能）：${err && err.message ? err.message : err}`
      );
    }
    return false;
  }
}

/**
 * 往 knex 配置里注入"每条连接都加载扩展"的钩子。
 *
 * ⚠️ 必须在 pool 层做：knex 的连接池是懒建的（min=0, max=5），
 *    只加载一次的话，第 2 条连接上就会报 "no such module: vec0"。
 * ⚠️ 钩子必须容错：扩展缺失时静默放行，不能让整个连接池建不起来。
 *
 * @param {Object} knexConfig 传给 knex() 的配置对象（原地修改）
 */
function applyKnexExtension(knexConfig) {
  if (!knexConfig || typeof knexConfig !== 'object') return knexConfig;
  const prevPool = knexConfig.pool || {};
  const prevAfterCreate = prevPool.afterCreate;
  knexConfig.pool = Object.assign({}, prevPool, {
    afterCreate: (conn, done) => {
      try {
        loadOnDatabase(conn);
      } catch (_) {
        /* 容错：加载失败照常放行 */
      }
      if (typeof prevAfterCreate === 'function') {
        return prevAfterCreate(conn, done);
      }
      return done(null, conn);
    },
  });
  return knexConfig;
}

/** Float32Array / Array → 存进 vec0 的 BLOB（小端 float32 连续内存）。 */
function toVecBlob(emb) {
  if (!emb) return null;
  if (Buffer.isBuffer(emb)) return emb;
  const f32 = emb instanceof Float32Array ? emb : Float32Array.from(emb);
  return Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength);
}

/** vec0 读回的 BLOB → Float32Array（零拷贝视图，调用方不要再改它）。 */
function fromVecBlob(buf) {
  if (!buf) return null;
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  if (b.byteLength < VEC_DIM * 4) return null;
  return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
}

/**
 * 建检索表（幂等）。vec0 虚表不支持 IF NOT EXISTS 之外的 schema 变更，
 * 维度改了必须先 DROP 再建（由调用方决定，避免误删数据）。
 * @returns {Promise<boolean>} 是否就绪
 */
async function ensureTable(knex) {
  if (!isAvailable() || !knex) return false;
  try {
    await knex.raw(
      `CREATE VIRTUAL TABLE IF NOT EXISTS ${TABLE} USING vec0(emb float[${VEC_DIM}])`
    );
    return true;
  } catch (err) {
    Logger.warn(`[sqliteVec] 建表 ${TABLE} 失败：${err && err.message ? err.message : err}`);
    return false;
  }
}

/**
 * 写/更新一行的向量。无扩展、无向量时静默跳过（调用方不必判断）。
 * ⚠️ 先按 rowid 预删再插：vec0 对 rowid 冲突不保证覆盖语义，预删最稳
 *    （且我们踩过 onConflict().ignore() 返回 [undefined] 的坑，不依赖 upsert 语义）。
 */
/**
 * 写/更新一行的向量。无扩展、无向量时静默跳过（调用方不必判断）。
 *
 * ⚠️ 两个踩过的坑，别再踩：
 *   1) **rowid 不能用参数绑定**：knex 会把 JS number 当 REAL 绑出去，
 *      vec0 直接报 "Only integers are allows for primary key values"。
 *      所以 rowid 校验成安全正整数后**直接内插**（纯数字，无注入面），只把向量走绑定。
 *   2) vec0 对 rowid 冲突不保证覆盖语义 ⇒ 先删后插最稳
 *      （也避开我们踩过的 `onConflict().ignore()` 返回 [undefined] 那类坑）。
 */
async function upsertEmb(knexOrTrx, id, emb) {
  if (!isAvailable()) return false;
  const rowid = Number(id);
  if (!Number.isSafeInteger(rowid) || rowid <= 0 || !emb) return false;
  const blob = toVecBlob(emb);
  if (!blob || blob.byteLength !== VEC_DIM * 4) return false;
  try {
    await knexOrTrx.raw(`DELETE FROM ${TABLE} WHERE rowid = ${rowid}`);
    await knexOrTrx.raw(`INSERT INTO ${TABLE} (rowid, emb) VALUES (${rowid}, ?)`, [blob]);
    return true;
  } catch (err) {
    Logger.warn(`[sqliteVec] 写入 ${TABLE} 失败 id=${rowid}：${err && err.message ? err.message : err}`);
    return false;
  }
}

async function deleteEmb(knexOrTrx, id) {
  if (!isAvailable()) return false;
  const rowid = Number(id);
  if (!Number.isSafeInteger(rowid) || rowid <= 0) return false;
  try {
    await knexOrTrx.raw(`DELETE FROM ${TABLE} WHERE rowid = ${rowid}`);
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * KNN 检索（余弦距离，因为两边都已 L2 归一化 ⇒ 距离 = 2-2cos，单调等价）。
 *
 * @param {any} knex
 * @param {Float32Array|Buffer} queryEmb
 * @param {number} limit 取多少条
 * @returns {Promise<Array<{id:number, distance:number}>>} 失败返回 []
 */
async function knn(knex, queryEmb, limit = 200) {
  if (!isAvailable() || !knex || !queryEmb) return [];
  const blob = toVecBlob(queryEmb);
  if (!blob || blob.byteLength !== VEC_DIM * 4) return [];
  const n = Math.max(1, Math.min(10000, Math.floor(Number(limit) || 200)));
  try {
    const rows = await knex.raw(
      `SELECT rowid AS id, distance FROM ${TABLE} WHERE emb MATCH ? ORDER BY distance LIMIT ${n}`,
      [blob]
    );
    const list = Array.isArray(rows) ? rows : (rows && rows.rows) || [];
    return list.map(r => ({ id: Number(r.id), distance: Number(r.distance) }));
  } catch (err) {
    Logger.warn(`[sqliteVec] KNN 失败，调用方应退回旧路径：${err && err.message ? err.message : err}`);
    return [];
  }
}

module.exports = {
  VEC_DIM,
  TABLE,
  resolveDllPath,
  isAvailable,
  loadOnDatabase,
  applyKnexExtension,
  toVecBlob,
  fromVecBlob,
  ensureTable,
  upsertEmb,
  deleteEmb,
  knn,
};
