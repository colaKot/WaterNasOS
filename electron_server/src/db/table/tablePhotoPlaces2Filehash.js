const knexUtil = require('../knexUtil');
const dbUtil = require('../dbUtil');
const Logger = require('../../utils/logger');

class tablePhotoPlaces2Filehash {
  constructor() {
    this.tableName = 'photo_places2filehash';
  }

  /**
   * ⭐ 2026-10-13 补齐 alt_place_name 列（次可能的场景标签）。
   * 背景：ResNet50-Places365 对室内场景置信度虚高（用户房间里被判成「病房」，
   * top-1 置信度 0.6+ 但第二名常是更合理的室内标签）。
   * 存下第二名后，搜索/相册可按任一标签命中，给误判照片第二次被找到的机会。
   */
  async ensureColumns(knex) {
    const info = await knex.raw(`PRAGMA table_info('${this.tableName}')`).catch(() => null);
    const rows = Array.isArray(info) ? info : ((info?.rows || info) ?? []);
    const colNames = new Set((rows || []).map(r => (r && r.name ? String(r.name) : '')).filter(Boolean));

    if (!colNames.has('alt_place_name')) {
      try {
        await knex.raw(`ALTER TABLE ${this.tableName} ADD COLUMN alt_place_name TEXT NULL`);
        Logger.info(`✅ Added column alt_place_name to table ${this.tableName}`);
      } catch (err) {
        Logger.error(`❌ Add column alt_place_name failed on ${this.tableName}:`, err);
      }
    }

    // ⭐ 2026-10-14 场景识别 v2：主标签不再是非黑即白，而是带「权重」和「判定状态」。
    //   place_score  主标签权重 0~1（融合后的置信度，列表排序/降权都靠它）
    //   place_status confident | ambiguous | unknown（铁柱选定：低置信保留但降权）
    //   alt_labels   其余候选标签的 JSON 数组 [{label,weight}]，供后续 UI 展示
    const newCols = [
      ['place_score', 'REAL NULL'],
      ['place_status', 'TEXT NULL'],
      ['alt_labels', 'TEXT NULL'],
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
        table.text('place_name').notNullable().defaultTo('');
        table.string('file_hash').notNullable();
        table.timestamp('create_time').defaultTo(knex.fn.now());
        // ⭐ 2026-10-13 次可能场景（NULL = 没有）
        table.text('alt_place_name').nullable();
        // ⭐ 2026-10-14 场景识别 v2：主标签权重 / 判定状态 / 其余候选
        table.float('place_score').nullable();
        table.text('place_status').nullable();
        table.text('alt_labels').nullable();
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
      { columns: ['place_name'], name: 'idx_photo_places2filehash_place_name', unique: false },
      { columns: ['place_name', 'file_hash'], name: 'uniq_photo_places2filehash_place_name_file_hash', unique: true },
      { columns: ['file_hash'], name: 'uniq_photo_places2filehash_file_hash', unique: true },
      // ⭐ 2026-10-13 次可能场景索引（搜索/相册按 alt 命中）
      { columns: ['alt_place_name'], name: 'idx_photo_places2filehash_alt_place_name', unique: false },
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

const tablePhotoPlaces2FilehashInstance = new tablePhotoPlaces2Filehash();
module.exports = tablePhotoPlaces2FilehashInstance;
