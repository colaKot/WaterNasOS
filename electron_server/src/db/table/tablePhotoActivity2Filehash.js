const knexUtil = require('../knexUtil');
const dbUtil = require('../dbUtil');
const Logger = require('../../utils/logger');

/**
 * 活动识别明细表（对标 photo_places2filehash）
 *
 * ⭐ 行数语义（**只在「有活动」时写行**）：
 *   实测 97.1% 的照片被判为「无活动」（docs §8.22.4）。
 *   若「无活动」也写行，表会被 97% 的无用行撑大，且每个查询都要多一个过滤条件。
 *   所以与场景维度「head 拦下就不写行」同一思路：**没活动 = 没这行**。
 *   「跑过但无活动」与「还没跑」的区别由 `photo_index.gen_activity` 承载，不需要第 4 个列。
 *
 * 为什么独立于 photo_places2filehash：见 tablePhotoActivity.js 的文件头说明
 * （最要紧的一条：可判性 head 拦下的人像/合影恰恰最需要活动标签）。
 */
class tablePhotoActivity2Filehash {
  constructor() {
    this.tableName = 'photo_activity2filehash';
  }

  async ensureColumns(knex) {
    const info = await knex.raw(`PRAGMA table_info('${this.tableName}')`).catch(() => null);
    const rows = Array.isArray(info) ? info : ((info?.rows || info) ?? []);
    const colNames = new Set((rows || []).map(r => (r && r.name ? String(r.name) : '')).filter(Boolean));

    const newCols = [
      ['act_key', 'TEXT NULL'],     // 英文 key（swimming / dining …），程序判断用
      ['act_name', 'TEXT NULL'],    // 中文展示名（游泳 / 用餐 …）
      ['act_score', 'REAL NULL'],   // 活动分（Top-1 相似度）
      ['act_status', 'TEXT NULL'],  // activity | none（保留字，便于以后放宽口径）
      ['act_alt', 'TEXT NULL'],     // Top-3 其余候选 JSON [{key,name,score}]
    ];
    for (const [name, type] of newCols) {
      if (colNames.has(name)) continue;
      try {
        await knex.raw(`ALTER TABLE ${this.tableName} ADD COLUMN ${name} ${type}`);
        Logger.info(`✅ Added column ${name} to table ${this.tableName}`);
      } catch (err) {
        Logger.error(`❌ Add column ${name} failed on ${this.tableName}:`, err);
      }
    }
  }

  async createTable(connection = null) {
    const knex = connection && connection.knex ? connection.knex : knexUtil.getInstance(dbUtil.DB_PATHS.PHOTO_DB);
    const tableExists = await knex.schema.hasTable(this.tableName);
    if (!tableExists) {
      await knex.schema.createTable(this.tableName, table => {
        table.increments('id').primary();
        table.text('act_key').notNullable().defaultTo('');
        table.text('act_name').notNullable().defaultTo('');
        table.float('act_score').nullable();
        table.text('act_status').nullable();
        table.text('act_alt').nullable();
        table.string('file_hash').notNullable();
        table.timestamp('create_time').defaultTo(knex.fn.now());
      });
      Logger.info(`✅ Table ${this.tableName} created`);
    } else {
      await this.ensureColumns(knex);
    }
  }

  async createIndexes(connection = null) {
    const knex = connection && connection.knex ? connection.knex : knexUtil.getInstance(dbUtil.DB_PATHS.PHOTO_DB);
    const existingIndexes = await knex.raw(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='${this.tableName}'`);
    const indexNames = Array.isArray(existingIndexes) ? existingIndexes.map(row => row.name) : (existingIndexes?.rows || []).map(row => row.name);

    const targetIndexes = [
      { columns: ['act_key'], name: 'idx_photo_activity2filehash_act_key', unique: false },
      { columns: ['act_name', 'file_hash'], name: 'uniq_photo_activity2filehash_act_name_file_hash', unique: true },
      { columns: ['file_hash'], name: 'uniq_photo_activity2filehash_file_hash', unique: true },
    ];

    for (const index of targetIndexes) {
      if (!indexNames.includes(index.name)) {
        await knex.schema.alterTable(this.tableName, table => {
          if (index.unique) table.unique(index.columns, index.name);
          else table.index(index.columns, index.name);
        });
        Logger.info(`✅ Created index ${index.name} on table ${this.tableName}`);
      }
    }
  }
}

const tablePhotoActivity2FilehashInstance = new tablePhotoActivity2Filehash();
module.exports = tablePhotoActivity2FilehashInstance;
