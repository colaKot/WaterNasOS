'use strict';
/**
 * 照片向量检索表（sqlite-vec vec0 虚表）。
 *
 * 设计取舍（2026-10-17）：
 *   保留 `photo_index.clip_emb` 作为**源数据**（页面内重排还要读它），
 *   本表只做**检索索引**的副本。代价是向量存两份（67k 张 ≈ +137MB），
 *   换来的是零迁移风险 + 随时可回退（删掉本表即回到旧的 JS 全表扫）。
 *
 * rowid 直接复用 `photo_index.id` ⇒ KNN 之后可以直接 JOIN 回主表做权限/时间窗过滤。
 * ⚠️ vec0 虚表没有普通索引可言，也没有 ensureColumns 概念：维度变了只能 DROP 重建。
 */

const knexUtil = require('../knexUtil');
const dbUtil = require('../dbUtil');
const Logger = require('../../utils/logger');
const sqliteVec = require('../../utils/sqliteVecUtil');

class tablePhotoEmb {
  constructor() {
    this.tableName = sqliteVec.TABLE; // photo_emb
  }

  async createTable(connection = null) {
    if (!sqliteVec.isAvailable()) {
      // 扩展不在（非 win-x64、dll 未随包）⇒ 不建表，调用方全部走降级路径。
      return;
    }
    const knex = connection && connection.knex ? connection.knex : knexUtil.getInstance(dbUtil.DB_PATHS.PHOTO_DB);

    // ⚠️ 维度漂移保护：vec0 建表时把维度固化在 schema 里。
    //    如果库里已存在一张维度不同的表，必须先 DROP（否则所有写入都会静默失败）。
    let existingDdl = '';
    try {
      const row = await knex.raw(`SELECT sql FROM sqlite_master WHERE type='table' AND name='${this.tableName}'`);
      const rows = Array.isArray(row) ? row : (row && row.rows) || [];
      existingDdl = rows.length > 0 && rows[0] ? String(rows[0].sql || '') : '';
    } catch (_) {
      existingDdl = '';
    }

    const want = `float[${sqliteVec.VEC_DIM}]`;
    if (existingDdl && existingDdl.indexOf(want) === -1) {
      Logger.warn(`⚠️  ${this.tableName} 维度与当前设置不符，重建：${existingDdl.slice(0, 120)}`);
      await knex.raw(`DROP TABLE IF EXISTS ${this.tableName}`).catch(() => {});
      existingDdl = '';
    }

    if (!existingDdl) {
      const ok = await sqliteVec.ensureTable(knex);
      if (ok) {
        Logger.info(`✅ Table ${this.tableName} created (vec0, dim=${sqliteVec.VEC_DIM})`);
      }
    }
  }

  // vec0 虚表本身即索引结构，无额外索引可建。保留空实现以对齐 dbUtil 的调用约定。
  async createIndexes() {}
}

const tablePhotoEmbInstance = new tablePhotoEmb();
module.exports = tablePhotoEmbInstance;
