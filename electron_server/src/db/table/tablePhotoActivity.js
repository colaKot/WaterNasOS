const knexUtil = require('../knexUtil');
const dbUtil = require('../dbUtil');
const Logger = require('../../utils/logger');

/**
 * 活动相册聚合表（对标 photo_places）
 *
 * ⭐ 为什么要独立于 photo_places（2026-10-15，docs §8.22.7）：
 *   1) **不能共享标签空间**：placesFusion 的两处归一化都是跨类的
 *      （zscoreAcrossClasses + softmax 分母为全体指数和），把活动类掺进去会稀释旧类的票
 *      —— 实测 Top-1 47.4% → 40.0%，p=0.0156。
 *   2) **活动天然是多标签**：一张照片可以既在「海边」又「划船」又「大笑」。
 *   3) **可判性 head 拦下的照片恰恰最需要活动标签**：人像/合影/婚礼这类
 *      「不该给场景标签」的照片，正是「合影/摆拍/大笑」最该命中的对象
 *      （§8.14 实测：以人为主体的婚礼现场 28%、服装店 45% 会被 head 拦下）。
 *      若把活动列挂在 photo_places2filehash 上，这些照片会连活动标签一起丢。
 *
 * 主键用英文 `act_key`（如 swimming）而不是中文展示名：程序判断用 key，
 * 中文只做展示（`act_name`），避免以后改文案把数据打散。
 */
class tablePhotoActivity {
  constructor() {
    this.tableName = 'photo_activity';
  }

  async createTable(connection = null) {
    const knex = connection && connection.knex ? connection.knex : knexUtil.getInstance(dbUtil.DB_PATHS.PHOTO_DB);
    const tableExists = await knex.schema.hasTable(this.tableName);
    if (!tableExists) {
      await knex.schema.createTable(this.tableName, table => {
        table.text('act_key').primary();
        table.text('act_name').notNullable().defaultTo('');   // 中文展示名
        table.integer('photo_count').notNullable().defaultTo(0);
        table.integer('is_hide').notNullable().defaultTo(0);
        table.timestamp('create_time').defaultTo(knex.fn.now());
        table.timestamp('update_time').defaultTo(knex.fn.now());
        // 与 photo_places.weight_sum 对称：活动分之和作为排序键（低置信自然沉底）
        table.float('score_sum').notNullable().defaultTo(0);
        table.integer('count_high').notNullable().defaultTo(0);
      });
      Logger.info(`✅ Table ${this.tableName} created`);
    }
  }

  async createIndexes(connection = null) {
    const knex = connection && connection.knex ? connection.knex : knexUtil.getInstance(dbUtil.DB_PATHS.PHOTO_DB);
    const existingIndexes = await knex.raw(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='${this.tableName}'`);
    const indexNames = Array.isArray(existingIndexes) ? existingIndexes.map(row => row.name) : (existingIndexes?.rows || []).map(row => row.name);

    const targetIndexes = [
      { columns: ['photo_count'], name: 'idx_photo_activity_photo_count', unique: false },
      { columns: ['score_sum'], name: 'idx_photo_activity_score_sum', unique: false },
      { columns: ['is_hide'], name: 'idx_photo_activity_is_hide', unique: false },
      { columns: ['act_key'], name: 'idx_photo_activity_act_key', unique: false },
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

const tablePhotoActivityInstance = new tablePhotoActivity();
module.exports = tablePhotoActivityInstance;
