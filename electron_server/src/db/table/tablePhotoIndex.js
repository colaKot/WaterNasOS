const knexUtil = require('../knexUtil');
const dbUtil = require('../dbUtil');
const Logger = require('../../utils/logger');

class tablePhotoIndex {
  constructor() {
    this.tableName = 'photo_index';
  }

  async ensureColumns(knex) {
    const info = await knex.raw(`PRAGMA table_info('${this.tableName}')`).catch(() => null);
    const rows = Array.isArray(info) ? info : ((info?.rows || info) ?? []);
    const colNames = new Set((rows || []).map(r => (r && r.name ? String(r.name) : '')).filter(Boolean));

    const addColumn = async (name, sqlType) => {
      try {
        await knex.raw(`ALTER TABLE ${this.tableName} ADD COLUMN ${name} ${sqlType}`);
      } catch (_) {}
    };

    if (!colNames.has('gen_hash')) {
      await addColumn('gen_hash', 'INTEGER DEFAULT 0');
    }
    if (!colNames.has('gen_phash')) {
      await addColumn('gen_phash', 'INTEGER DEFAULT 0');
    }
    if (!colNames.has('gen_gps_add')) {
      await addColumn('gen_gps_add', 'INTEGER DEFAULT 0');
    }
    // 内容级去重用的内容 MD5（与 /api/file/md5 同算法，惰性填充）
    if (!colNames.has('content_md5')) {
      await addColumn('content_md5', 'TEXT');
    }
    // ⭐ 2026-10-15 活动识别（独立于场景维度，docs §8.22.7）。
    // 老数据默认 0 ⇒ 会全量重扫一遍活动标签；场景标签不受影响（用 gen_place）。
    if (!colNames.has('gen_activity')) {
      await addColumn('gen_activity', 'INTEGER DEFAULT 0');
    }
    // ⭐ 2026-10-16 P0-3 以图搜图：CLIP 图像嵌入（L2 归一化 float32 × 512 = 2048 字节）。
    // 此前 placesClipUtil.scoreImage 算出的 emb 只用于与标签嵌入点积、**算完即丢**，
    // 所以「以图搜图」必须先把向量留下来。消费方 = placesService.searchByImage。
    // 老数据为 NULL ⇒ 由 tool/_backfill_clip_emb.js 回填（按 clip_emb IS NULL 天然可续跑）。
    if (!colNames.has('clip_emb')) {
      await addColumn('clip_emb', 'BLOB');
    }
    // ⭐ 2026-10-17 记录该向量由哪个塔产出（如 vision_model / vision_model_int8）。
    // 换塔后历史向量与查询向量**不同空间**，同维塔骗得过维度检查
    // ⇒ 必须有标记才能拒绝跨塔比较（避免点积出一堆无意义的噪声分）。
    // NULL = P0-3 时代写入的，视为当前塔，不阻断老数据。
    if (!colNames.has('emb_model')) {
      await addColumn('emb_model', 'TEXT');
    }
    // ⭐ 2026-10-17 完成时间戳（与布尔位 gen_faces 并存，纯附加、不改既有语义）。
    // 布尔位只能表达「跑过了」，表达不了「什么时候跑的」⇒ 做增量/调参重跑时
    // 只能全量重扫（我们已经在 gen_faces 上踩过两次坑：失败被烧成 1、park 后永不再起）。
    if (!colNames.has('faces_recognized_at')) {
      await addColumn('faces_recognized_at', 'DATETIME');
    }
    // ⚠️ gen_activity_attempts（活动维度尝试次数）走**迁移**管理，不在这里 ensureColumns：
    //    见 src/db/migrations/0003-gen-activity-attempts.js ——
    //    新结构变更统一走迁移，避免「同一列有两个来源」对不上。
  }

  /**
   * 创建 photo_index 表
   * @param {Object} connection 数据库连接对象
   */
  async createTable(connection = null) {
    let knex;
    if (connection) {
      knex = connection.knex;
    } else {
      knex = knexUtil.getInstance(dbUtil.DB_PATHS.PHOTO_DB);
    }

    // 检查表是否已存在
    const tableExists = await knex.schema.hasTable(this.tableName);
    if (!tableExists) {
      await knex.schema.createTable(this.tableName, table => {
        table.increments('id').primary();
        table.string('path').notNullable(); // 路径
        table.string('filename').notNullable(); // 文件名
        table.string('file_hash'); // 文件哈希
        table.boolean('is_file').defaultTo(1); // 是否为文件
        table.boolean('in_trash').defaultTo(0); // 是否在回收站
        table.datetime('in_trash_time'); // 回收站时间
        table.datetime('ctime'); // 创建时间
        table.datetime('mtime'); // 修改时间
        table.datetime('original_time').defaultTo(0); // 注意：datetime类型存0可能在某些数据库有差异，但在sqlite通常没问题作为兼容
        table.date('original_date'); // 拍摄日期
        table.integer('is_lvp').defaultTo(0); // 是否为livephoto
        table.integer('is_merge_lvp').defaultTo(0); // 是否为合并后的livephoto 照片和视频都在一个文件里,通过exif判断
        table.string('live_filename'); // 配套livephoto的视频文件名
        table.integer('size').defaultTo(0); // 文件大小
        table.integer('type').defaultTo(0); // 文件类型
        table.integer('width').defaultTo(0); // 宽度
        table.integer('height').defaultTo(0); // 高度
        table.integer('duration').defaultTo(0); // 持续时间
        table.float('latitude').defaultTo(0); // 纬度
        table.float('longitude').defaultTo(0); // 经度
        table.string('phash'); // phash
        table.string('geohash'); // 地理位置哈希
        table.string('geohash2'); // 地理位置哈希
        table.string('geohash3'); // 地理位置哈希
        table.string('geohash4'); // 地理位置哈希
        table.string('geohash5'); // 地理位置哈希
        table.string('geohash6'); // 地理位置哈希
        table.string('ext').defaultTo(''); // 扩展名
        table.string('raw_filename'); // 配套raw文件名
        table.string('camera'); // 拍摄设备型号
        table.timestamp('create_time').defaultTo(knex.fn.now()); // 创建时间
        table.integer('check_time').defaultTo(0); // 检查时间
        table.string('is_show').defaultTo('1'); // 用户指定 TEXT DEFAULT (1)
        table.integer('gen_tags').defaultTo(0); // 是否已经生成标签
        table.integer('gen_phash').defaultTo(0); // 是否已经生成phash
        table.integer('gen_describe').defaultTo(0); // 是否已经生成描述
        table.integer('gen_place').defaultTo(0); // 是否已经生成场景信息
        table.integer('gen_activity').defaultTo(0); // 是否已经生成活动信息（独立于场景，见 tablePhotoActivity.js）
        table.integer('gen_ocr').defaultTo(0); // 是否已经生成ocr
        table.integer('gen_faces').defaultTo(0); // 是否已经生成人脸
        table.integer('gen_tiny').defaultTo(0); // 是否已经生成缩略图
        table.integer('gen_hash').defaultTo(0); // 是否已完成去重检测：0未开始 1待检测 2已检测
        table.integer('gen_gps_add').defaultTo(0); // GPS补充扫描状态：0待扫描 1已扫描/已补充 2已跳过
      });
      Logger.info(`✅ Table ${this.tableName} created`);
    }
    // ⭐ 新建库也必须走一遍 ensureColumns
    // createTable 的列清单只是基线，
    // 新增列（emb_model / clip_emb / content_md5 等）只在 ensureColumns 里。
    // 只在「表已存在」分支调 ⇒ 全新库缺列，
    // 迁移 0002 建 emb_model 索引直接拒绝启动（2026-10-18 实测）。
    await this.ensureColumns(knex);
  }

  /**
   * 创建索引
   * @param {Object} connection 数据库连接对象
   */
  async createIndexes(connection = null) {
    let knex;
    if (connection) {
      knex = connection.knex;
    } else {
      knex = knexUtil.getInstance(dbUtil.DB_PATHS.PHOTO_DB);
    }

    // 检查索引是否已存在
    const existingIndexes = await knex.raw(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='${this.tableName}'`);
    const indexNames = Array.isArray(existingIndexes) ? existingIndexes.map(row => row.name) : (existingIndexes?.rows || []).map(row => row.name);

    const targetIndexes = [
      {
        columns: ['path', 'filename', 'is_file', 'in_trash', 'type', 'original_time'],
        name: 'idx_photo_index_path_filename_time',
        unique: true,
      },
      {
        columns: ['path', 'filename', 'is_file', 'in_trash', 'type', 'original_date'],
        name: 'idx_photo_index_path_filename_date',
        unique: true,
      },
      {
        columns: ['path', 'filename', 'is_file', 'in_trash', 'type', 'geohash'],
        name: 'idx_photo_index_path_filename_geohash',
        unique: true,
      },
      {
        columns: ['path', 'filename', 'is_file', 'in_trash', 'type', 'camera'],
        name: 'idx_photo_index_path_filename_camera',
        unique: true,
      },
      {
        columns: ['path', 'original_date'],
        name: 'idx_photo_index_path_original_date',
        unique: false,
      },
      {
        columns: ['path', 'live_filename'],
        name: 'idx_photo_index_path_live_filename',
        unique: false,
      },
      {
        columns: ['path', 'raw_filename'],
        name: 'idx_photo_index_path_raw_filename',
        unique: false,
      },
      { columns: ['file_hash'], name: 'idx_photo_index_file_hash', unique: false },
      { columns: ['geohash2'], name: 'idx_photo_index_geohash2', unique: false },
      { columns: ['geohash3'], name: 'idx_photo_index_geohash3', unique: false },
      { columns: ['geohash4'], name: 'idx_photo_index_geohash4', unique: false },
      { columns: ['geohash5'], name: 'idx_photo_index_geohash5', unique: false },
      { columns: ['geohash6'], name: 'idx_photo_index_geohash6', unique: false },
      { columns: ['original_time'], name: 'idx_photo_index_original_time', unique: false },

      { columns: ['gen_faces', 'is_file', 'in_trash', 'type', 'original_time', 'id'], name: 'idx_photo_index_gen_faces_queue', unique: false },
      { columns: ['gen_place', 'is_file', 'in_trash', 'type', 'id'], name: 'idx_photo_index_gen_place_queue', unique: false },
      { columns: ['gen_activity', 'is_file', 'in_trash', 'type', 'id'], name: 'idx_photo_index_gen_activity_queue', unique: false },

      { columns: ['gen_phash', 'id'], name: 'idx_photo_index_gen_phash_queue', unique: false },
      { columns: ['gen_phash', 'phash', 'id'], name: 'idx_photo_index_gen_phash_phash', unique: false },
      { columns: ['gen_gps_add', 'camera', 'original_time', 'id'], name: 'idx_photo_index_gen_gps_add_queue', unique: false },
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
  }

  async createTriggers(connection = null) {
    const knex = connection && connection.knex ? connection.knex : knexUtil.getInstance(dbUtil.DB_PATHS.PHOTO_DB);

    const hasSimilarTable = await knex.schema.hasTable('photo_similar').catch(() => false);
    if (!hasSimilarTable) return;

    const triggers = [
      {
        name: 'trg_photo_index_delete_photo_similar',
        sql: `
          CREATE TRIGGER trg_photo_index_delete_photo_similar
          AFTER DELETE ON photo_index
          FOR EACH ROW
          BEGIN
            DELETE FROM photo_similar WHERE index_id = OLD.id;
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

// 创建单例实例
const tablePhotoIndexInstance = new tablePhotoIndex();

// 导出单例实例
module.exports = tablePhotoIndexInstance;
