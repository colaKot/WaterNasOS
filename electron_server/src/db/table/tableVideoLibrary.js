const knexUtil = require('../knexUtil');
const dbUtil = require('../dbUtil');
const Logger = require('../../utils/logger');

// 影视库类型（创建后不可修改）
// movie: 电影  tv: 影视剧  image: 图片  mixed: 图片和影视混合
const LIB_TYPES = ['movie', 'tv', 'image', 'mixed'];

// 内置影视库（首次建库时写入，不允许删除，只允许改名）
const DEFAULT_LIBRARIES = [
  { name: '电影', name_key: 'video_library_default_movie', lib_type: 'movie', is_default: 1, sort: 1 },
  { name: '电视剧', name_key: 'video_library_default_tv', lib_type: 'tv', is_default: 1, sort: 2 },
];

class tableVideoLibrary {
  constructor() {
    this.tableName = 'video_library';
  }

  async createTable(connection = null) {
    const knex = connection && connection.knex ? connection.knex : knexUtil.getInstance(dbUtil.DB_PATHS.VIDEO_DB);

    const tableExists = await knex.schema.hasTable(this.tableName);
    if (!tableExists) {
      await knex.schema.createTable(this.tableName, table => {
        table.increments('id').primary();
        table.string('name').notNullable().defaultTo('');
        table.string('name_key').defaultTo(''); // 内置库的多语言 key，用户改名后置空
        table.string('lib_type').notNullable(); // movie | tv | image | mixed
        table.integer('is_default').notNullable().defaultTo(0); // 1 = 内置，不可删除
        table.integer('show_in_home').notNullable().defaultTo(0); // 1 = 主页显示该库分类
        table.integer('audio_normalize').notNullable().defaultTo(0); // 1 = 扫描时测量该库音频响度并在转码时归一化
        table.integer('sort').notNullable().defaultTo(0);
        table.timestamp('create_time').defaultTo(knex.fn.now());
      });
      Logger.info(`✅ Table ${this.tableName} created`);
    } else {
      const result = await knex.raw(`PRAGMA table_info(${this.tableName})`).catch(() => []);
      const rows = Array.isArray(result) ? result : result?.rows || [];
      const colNames = new Set((rows || []).map(r => (r && r.name ? String(r.name) : '')).filter(Boolean));
      if (!colNames.has('name_key')) {
        await knex.raw(`ALTER TABLE ${this.tableName} ADD COLUMN name_key TEXT DEFAULT ''`).catch(() => {});
        Logger.info(`✅ Added name_key column to table ${this.tableName}`);
      }
      if (!colNames.has('show_in_home')) {
        await knex.raw(`ALTER TABLE ${this.tableName} ADD COLUMN show_in_home INTEGER NOT NULL DEFAULT 0`).catch(() => {});
        Logger.info(`✅ Added show_in_home column to table ${this.tableName}`);
      }
      if (!colNames.has('audio_normalize')) {
        await knex.raw(`ALTER TABLE ${this.tableName} ADD COLUMN audio_normalize INTEGER NOT NULL DEFAULT 0`).catch(() => {});
        Logger.info(`✅ Added audio_normalize column to table ${this.tableName}`);
      }
    }

    await this.ensureDefaultLibraries(knex);
    await this.migrateShowInHome(knex);
  }

  // 老库迁移：内置电影/电视剧默认在主页显示，其余库默认不显示
  async migrateShowInHome(knex) {
    await knex(this.tableName)
      .where({ is_default: 1 })
      .update({ show_in_home: 1 })
      .catch(() => {});
  }

  // 幂等写入内置影视库：仅在表为空时写入
  async ensureDefaultLibraries(knex) {
    const row = await knex(this.tableName)
      .count({ cnt: 'id' })
      .first()
      .catch(() => null);
    const count = Number(row && row.cnt ? row.cnt : 0) || 0;
    if (count > 0) return;

    const toInsert = DEFAULT_LIBRARIES.map(item => ({
      name: item.name,
      name_key: item.name_key,
      lib_type: item.lib_type,
      is_default: item.is_default,
      show_in_home: item.is_default,
      sort: item.sort,
      create_time: new Date(),
    }));

    await knex(this.tableName)
      .insert(toInsert)
      .catch(err => {
        Logger.error('❌ video_library seed failed:', err);
      });
    Logger.info(`✅ Table ${this.tableName} seeded ${toInsert.length} default libraries`);
  }

  async createIndexes(connection = null) {
    const knex = connection && connection.knex ? connection.knex : knexUtil.getInstance(dbUtil.DB_PATHS.VIDEO_DB);

    const existingIndexes = await knex.raw(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='${this.tableName}'`);
    const indexNames = Array.isArray(existingIndexes) ? existingIndexes.map(row => row.name) : (existingIndexes?.rows || []).map(row => row.name);

    const targetIndexes = [
      { columns: ['sort'], name: 'idx_video_library_sort', unique: false },
      { columns: ['lib_type'], name: 'idx_video_library_lib_type', unique: false },
    ];

    for (const index of targetIndexes) {
      if (!indexNames.includes(index.name)) {
        await knex.schema.alterTable(this.tableName, table => {
          table.index(index.columns, index.name);
        });
        Logger.info(`✅ Created index ${index.name} on table ${this.tableName}`);
      }
    }
  }
}

const tableVideoLibraryInstance = new tableVideoLibrary();
tableVideoLibraryInstance.LIB_TYPES = LIB_TYPES;
tableVideoLibraryInstance.DEFAULT_LIBRARIES = DEFAULT_LIBRARIES;

module.exports = tableVideoLibraryInstance;
