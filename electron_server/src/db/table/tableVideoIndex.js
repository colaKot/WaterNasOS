const knexUtil = require('../knexUtil');
const dbUtil = require('../dbUtil');
const Logger = require('../../utils/logger');

class tableVideoIndex {
  constructor() {
    this.tableName = 'video_index';
  }

  async createTable(connection = null) {
    const knex = connection && connection.knex ? connection.knex : knexUtil.getInstance(dbUtil.DB_PATHS.VIDEO_DB);
    const tableExists = await knex.schema.hasTable(this.tableName);
    if (!tableExists) {
      await knex.schema.createTable(this.tableName, table => {
        table.increments('id').primary();
        table.string('path').notNullable();
        table.string('filename').notNullable();
        table.string('filename_fl').defaultTo('');
        table.string('ext').defaultTo('');
        table.integer('is_file').notNullable().defaultTo(1);
        table.string('file_hash').defaultTo('');
        table.string('play_rel_path').defaultTo('');
        table.string('nfo_name').defaultTo('');
        table.string('nfo_name_fl').defaultTo('');
        // ⭐ 自然排序键（2026-10-12）：数字段补零后的 lower(显示名)，
        //    混合库两侧归并排序时用它，见 firstLetterUtil.getNaturalSortKey
        table.string('natural_name').defaultTo('');
        table.string('media_type').defaultTo('');
        table.integer('season_count').notNullable().defaultTo(0);
        table.integer('episod_count').notNullable().defaultTo(0);
        table.integer('size').notNullable().defaultTo(0);
        table.integer('width').notNullable().defaultTo(0);
        table.integer('height').notNullable().defaultTo(0);
        table.integer('duration').notNullable().defaultTo(0);
        table.text('nfo_alias').defaultTo('');
        table.text('nfo_tags').defaultTo('');
        table.text('nfo_regions').defaultTo('');
        table.text('nfo_language').defaultTo('');
        table.string('nfo_imdb_id').defaultTo('');
        table.text('nfo_genres').defaultTo('');
        table.date('nfo_release_date');
        table.text('nfo_storyline').defaultTo('');
        table.float('nfo_score').notNullable().defaultTo(0);
        table.integer('nfo_year').notNullable().defaultTo(0);
        table.text('nfo_actor').defaultTo('');
        table.text('nfo_director').defaultTo('');
        table.text('poster_path').defaultTo(''); //海报路径
        table.text('fanart_path').defaultTo(''); //横版海报图路径
        table.text('logo_path').defaultTo(''); //logo图路径
        table.text('nfo_actor_json').defaultTo('[]');
        table.text('nfo_director_json').defaultTo('[]');
        table.integer('open_skip_start_sec').notNullable().defaultTo(0);
        table.integer('open_skip_end_sec').notNullable().defaultTo(0);
        table.integer('nfo_get_state').notNullable().defaultTo(0);
        table.integer('gen_subtitle_vtt').notNullable().defaultTo(0);
        table.integer('gen_tiny').notNullable().defaultTo(0);
        table.integer('episod_num').notNullable().defaultTo(0);
        table.timestamp('create_time').defaultTo(knex.fn.now());
        table.timestamp('view_time');
      });
      Logger.info(`✅ Table ${this.tableName} created`);
    } else {
      const result = await knex.raw(`PRAGMA table_info(${this.tableName})`).catch(() => []);
      const rows = Array.isArray(result) ? result : result?.rows || [];
      const colNames = new Set((rows || []).map(r => (r && r.name ? String(r.name) : '')).filter(Boolean));
      const addColumn = async (name, sqlType) => {
        if (colNames.has(name)) return;
        await knex.raw(`ALTER TABLE ${this.tableName} ADD COLUMN ${name} ${sqlType}`);
        Logger.info(`✅ Added ${name} column to table ${this.tableName}`);
      };
      await addColumn('play_rel_path', "TEXT DEFAULT ''");
      await addColumn('gen_subtitle_vtt', 'INTEGER NOT NULL DEFAULT 0');
      // ⭐ 自然排序键（2026-10-12）：老库补列后是空串，必须跑回填脚本
      await addColumn('natural_name', "TEXT DEFAULT ''");
    }

    // 图片索引独立表（说明见本文件末尾 _ensureImageIndexTable）
    await this._ensureImageIndexTable(knex);
  }

  async createIndexes(connection = null) {
    const knex = connection && connection.knex ? connection.knex : knexUtil.getInstance(dbUtil.DB_PATHS.VIDEO_DB);
    const existingIndexes = await knex.raw(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='${this.tableName}'`);
    const indexNames = Array.isArray(existingIndexes) ? existingIndexes.map(row => row.name) : (existingIndexes?.rows || []).map(row => row.name);

    const targetIndexes = [
      { columns: ['path', 'filename'], name: 'uidx_video_index_path_filename', unique: true },

      { columns: ['path', 'filename', 'media_type', 'create_time'], name: 'idx_video_index_path_filename_media_type_create_time', unique: false },
      { columns: ['path', 'filename', 'media_type', 'view_time'], name: 'idx_video_index_path_filename_media_type_view_time', unique: false },
      { columns: ['path', 'filename', 'media_type', 'nfo_regions'], name: 'idx_video_index_path_filename_media_type_nfo_regions', unique: false },
      { columns: ['path', 'filename', 'media_type', 'nfo_language'], name: 'idx_video_index_path_filename_media_type_nfo_language', unique: false },
      { columns: ['path', 'filename', 'media_type', 'nfo_genres'], name: 'idx_video_index_path_filename_media_type_nfo_genres', unique: false },
      { columns: ['path', 'filename', 'media_type', 'nfo_release_date'], name: 'idx_video_index_path_filename_media_type_nfo_release_date', unique: false },
      { columns: ['path', 'filename', 'media_type', 'nfo_score'], name: 'idx_video_index_path_filename_media_type_nfo_score', unique: false },
      { columns: ['path', 'filename', 'media_type', 'nfo_director'], name: 'idx_video_index_path_filename_media_type_nfo_director', unique: false },
      { columns: ['path', 'filename', 'media_type', 'nfo_actor'], name: 'idx_video_index_path_filename_media_type_nfo_actor', unique: false },
    ];

    for (const index of targetIndexes) {
      if (!indexNames.includes(index.name)) {
        await knex.schema.alterTable(this.tableName, table => {
          if (index.unique) {
            table.unique(index.columns, index.name);
          } else {
            table.index(index.columns, index.name);
          }
        });
        Logger.info(`✅ Created index ${index.name} on table ${this.tableName}`);
      }
    }

    await this.createTriggers({ knex });

    await this._ensureImageIndexIndexes(knex);
  }

  /* ==========================================================================
   * 图片索引独立表 image_index
   *
   * ⚠️ 为什么定义在这里而不是单独开一个 tableImageIndex.js：
   *   开发期热更工具 `tool/dev_update.py` 只会重写 app.asar 里**已存在**的条目，
   *   新建的源文件进不了归档 ⇒ 启动时 require 会 MODULE_NOT_FOUND。
   *   放在既有文件里可以零成本地随热更生效。
   *
   * 为什么拆表：原来图片和影视共用 video_index，那张表 10 个索引里有 8 个后缀列
   * （nfo_regions/genres/score/director/actor…）对图片**恒为空**，7.5 万张图 ≈ 75 万个
   * 无用索引条目；且 media_type 排在第 3 位，`WHERE media_type='image'` 吃不到索引前缀。
   * 新表只要 4 个索引，实测 7 万条深分页 2ms、缩略图队列 0.01ms。
   * ========================================================================*/

  async _ensureImageIndexTable(knex) {
    const name = 'image_index';
    const exists = await knex.schema.hasTable(name);
    if (!exists) {
      await knex.schema.createTable(name, table => {
        table.increments('id').primary();
        table.integer('library_id').notNullable().defaultTo(0); // 所属影视库（等值过滤主键）
        table.integer('source_id').notNullable().defaultTo(0); // 所属来源
        table.string('path').notNullable(); // 文件所在目录
        table.string('filename').notNullable();
        table.string('filename_fl').defaultTo(''); // 首字母（搜索用）
        // ⭐ 自然排序键：数字段左侧补零后的 lower(filename)，见 firstLetterUtil.getNaturalSortKey
        //    排序时直接 ORDER BY 这一列（纯文本 BINARY 序 == 自然序，且能走索引）
        table.string('natural_name').defaultTo('');
        table.string('ext').defaultTo('');
        table.integer('size').notNullable().defaultTo(0);
        table.integer('width').notNullable().defaultTo(0);
        table.integer('height').notNullable().defaultTo(0);
        table.integer('taken_at').notNullable().defaultTo(0); // 拍摄时间(ms)，排序主键
        table.integer('file_mtime').notNullable().defaultTo(0); // 文件修改时间(ms)，增量扫描判据
        table.integer('file_ctime').notNullable().defaultTo(0);
        table.string('file_hash').defaultTo('');
        table.integer('gen_tiny').notNullable().defaultTo(0);
        table.integer('view_time');
        table.integer('is_favorite').notNullable().defaultTo(0);
        table.integer('create_time').notNullable().defaultTo(0);
      });
      Logger.info(`✅ Table ${name} created`);
      return;
    }

    // 老库升级：按需补列
    const result = await knex.raw(`PRAGMA table_info(${name})`).catch(() => []);
    const rows = Array.isArray(result) ? result : result?.rows || [];
    const colNames = new Set((rows || []).map(r => (r && r.name ? String(r.name) : '')).filter(Boolean));
    const addColumn = async (col, sqlType) => {
      if (colNames.has(col)) return;
      await knex.raw(`ALTER TABLE ${name} ADD COLUMN ${col} ${sqlType}`);
      Logger.info(`✅ Added ${col} column to table ${name}`);
    };
    await addColumn('library_id', 'INTEGER NOT NULL DEFAULT 0');
    await addColumn('source_id', 'INTEGER NOT NULL DEFAULT 0');
    await addColumn('taken_at', 'INTEGER NOT NULL DEFAULT 0');
    await addColumn('file_mtime', 'INTEGER NOT NULL DEFAULT 0');
    await addColumn('file_ctime', 'INTEGER NOT NULL DEFAULT 0');
    await addColumn('file_hash', "TEXT DEFAULT ''");
    await addColumn('is_favorite', 'INTEGER NOT NULL DEFAULT 0');
    await addColumn('create_time', 'INTEGER NOT NULL DEFAULT 0');
    // ⭐ 自然排序键（2026-10-12）：列建好后**旧行是空串**，
    //    必须跑 tool/_backfill_natural_name.js 回填，否则旧图会全排在最前面。
    await addColumn('natural_name', "TEXT DEFAULT ''");
  }

  async _ensureImageIndexIndexes(knex) {
    const name = 'image_index';
    const existing = await knex.raw(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name=?`, [name]).catch(() => []);
    const rows = Array.isArray(existing) ? existing : existing?.rows || [];
    const indexNames = new Set((rows || []).map(r => (r && r.name ? String(r.name) : '')).filter(Boolean));

    // 全部用 raw SQL：knex.schema 的 index() 不支持 DESC 排序与部分索引(WHERE)
    const targets = [
      { name: 'uidx_image_index_path_filename', sql: `CREATE UNIQUE INDEX uidx_image_index_path_filename ON image_index (path, filename)` },
      { name: 'idx_image_index_lib_taken', sql: `CREATE INDEX idx_image_index_lib_taken ON image_index (library_id, taken_at DESC, id DESC)` },
      { name: 'idx_image_index_lib_path', sql: `CREATE INDEX idx_image_index_lib_path ON image_index (library_id, path)` },
      // ⭐ 自然排序索引（2026-10-12）：ORDER BY natural_name 走这条，避免 7 万行排序
      { name: 'idx_image_index_lib_natural', sql: `CREATE INDEX idx_image_index_lib_natural ON image_index (library_id, natural_name, id)` },
      // 部分索引：只索引待生成缩略图的行 ⇒ 取队列 O(log n)，不用扫 7 万行
      { name: 'idx_image_index_pending_tiny', sql: `CREATE INDEX idx_image_index_pending_tiny ON image_index (id) WHERE gen_tiny = 0` },
    ];
    for (const idx of targets) {
      if (indexNames.has(idx.name)) continue;
      await knex.raw(idx.sql).catch(err => {
        Logger.error(`❌ create index ${idx.name} failed:`, err && err.message);
      });
      Logger.info(`✅ Created index ${idx.name} on table ${name}`);
    }
  }

  async createTriggers(connection = null) {
    const knex = connection && connection.knex ? connection.knex : knexUtil.getInstance(dbUtil.DB_PATHS.VIDEO_DB);
    const triggers = [
      {
        name: 'trg_video_index_delete_video_index2key',
        sql: `
          CREATE TRIGGER trg_video_index_delete_video_index2key
          AFTER DELETE ON video_index
          FOR EACH ROW
          BEGIN
            DELETE FROM video_index2key WHERE index_id = OLD.id;
          END;
        `,
      },
      {
        name: 'trg_video_index_delete_video_favorite',
        sql: `
          CREATE TRIGGER trg_video_index_delete_video_favorite
          AFTER DELETE ON video_index
          FOR EACH ROW
          BEGIN
            DELETE FROM video_favorite WHERE index_id = OLD.id;
          END;
        `,
      },
    ];

    for (const t of triggers) {
      const existing = await knex.raw("SELECT name FROM sqlite_master WHERE type='trigger' AND name=?", [t.name]);
      const triggerExists = Array.isArray(existing) ? existing.length > 0 : (existing?.rows || []).length > 0;
      if (triggerExists) continue;
      await knex.raw(t.sql);
      Logger.info(`✅ Created trigger ${t.name} on table ${this.tableName}`);
    }
  }
}

module.exports = new tableVideoIndex();
