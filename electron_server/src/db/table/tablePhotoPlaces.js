const knexUtil = require('../knexUtil');
const dbUtil = require('../dbUtil');
const Logger = require('../../utils/logger');

class tablePhotoPlaces {
  constructor() {
    this.tableName = 'photo_places';
  }

  /**
   * ⭐ 2026-10-14 场景识别 v2：相册排序从「张数」升级为「权重和」。
   * 背景：低置信照片以前会被硬塞一个标签并 +1 张数，于是「病房」能攒到 1224 张。
   * 现在每张照片对相册的贡献是它的置信权重，低置信照片自然沉底（但不丢）。
   *   weight_sum  该场景下所有照片的权重和（排序键）
   *   count_high  其中判定为 confident 的张数（用于展示"可靠张数"）
   * 迁移时用 photo_count 回填 weight_sum，保证历史数据排序不乱。
   */
  async ensureColumns(knex) {
    const info = await knex.raw(`PRAGMA table_info('${this.tableName}')`).catch(() => null);
    const rows = Array.isArray(info) ? info : ((info?.rows || info) ?? []);
    const colNames = new Set((rows || []).map(r => (r && r.name ? String(r.name) : '')).filter(Boolean));

    if (!colNames.has('weight_sum')) {
      try {
        await knex.raw(`ALTER TABLE ${this.tableName} ADD COLUMN weight_sum REAL NOT NULL DEFAULT 0`);
        await knex.raw(`UPDATE ${this.tableName} SET weight_sum = photo_count`);
        Logger.info(`✅ Added column weight_sum to table ${this.tableName} (已用 photo_count 回填)`);
      } catch (err) {
        Logger.error(`❌ Add column weight_sum failed on ${this.tableName}:`, err);
      }
    }
    if (!colNames.has('count_high')) {
      try {
        await knex.raw(`ALTER TABLE ${this.tableName} ADD COLUMN count_high INTEGER NOT NULL DEFAULT 0`);
        await knex.raw(`UPDATE ${this.tableName} SET count_high = photo_count`);
        Logger.info(`✅ Added column count_high to table ${this.tableName} (已用 photo_count 回填)`);
      } catch (err) {
        Logger.error(`❌ Add column count_high failed on ${this.tableName}:`, err);
      }
    }
  }

  async createTable(connection = null) {
    const knex = connection && connection.knex ? connection.knex : knexUtil.getInstance(dbUtil.DB_PATHS.PHOTO_DB);
    const tableExists = await knex.schema.hasTable(this.tableName);
    if (!tableExists) {
      await knex.schema.createTable(this.tableName, table => {
        table.text('place_name').primary();
        table.integer('photo_count').notNullable().defaultTo(0);
        table.integer('is_hide').notNullable().defaultTo(0);
        table.timestamp('create_time').defaultTo(knex.fn.now());
        table.timestamp('update_time').defaultTo(knex.fn.now());
        // ⭐ 2026-10-14 场景识别 v2
        table.float('weight_sum').notNullable().defaultTo(0);
        table.integer('count_high').notNullable().defaultTo(0);
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
      { columns: ['photo_count'], name: 'idx_photo_places_photo_count', unique: false },
      { columns: ['weight_sum'], name: 'idx_photo_places_weight_sum', unique: false },
      { columns: ['is_hide'], name: 'idx_photo_places_is_hide', unique: false },
      { columns: ['place_name'], name: 'idx_photo_places_place_name', unique: false },
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

const tablePhotoPlacesInstance = new tablePhotoPlaces();
module.exports = tablePhotoPlacesInstance;
