const knexUtil = require('../knexUtil');
const dbUtil = require('../dbUtil');
const Logger = require('../../utils/logger');

/**
 * 照片批量操作日志表（P0-6：写操作「预演 → 执行 → 可撤销」）。
 *
 * ⭐ 为什么要这张表：此前批量删除/移动是**直接执行**的，删完就没了 ——
 * 对 NAS 这种「一删几万张」的场景，误操作代价不可逆。改成：
 *   preview（只算代价，不写业务表）→ execute（写 undo_data）→ undo（按 undo_data 回滚）。
 *
 * 行语义：一条记录 = 一次用户确认过的写操作。`status` 三态：
 *   executed（已执行、可撤销） / undone（已撤销） / expired（超期，不可撤销）。
 * `undo_data` 存**业务层快照**（如 in_trash 的旧值），⛔ 不存文件系统级信息 ——
 * 撤销只在索引层回滚，绝不搬动用户的原始文件。
 *
 * 表很短命：7 天 TTL，过期只把 status 置 expired，由维护任务清理。
 */
class tablePhotoOperationLog {
  constructor() {
    this.tableName = 'photo_operation_log';
  }

  async ensureColumns(knex) {
    const info = await knex.raw(`PRAGMA table_info('${this.tableName}')`).catch(() => null);
    const rows = Array.isArray(info) ? info : ((info?.rows || info) ?? []);
    const colNames = new Set((rows || []).map(r => (r && r.name ? String(r.name) : '')).filter(Boolean));
    const newCols = [
      ['expire_time', 'datetime NULL'],
      ['summary', 'TEXT NULL'],
      ['undone_time', 'datetime NULL'],
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
        table.integer('uid').notNullable().defaultTo(0); // 执行者；管理员也按本人记
        table.text('op_type').notNullable().defaultTo('trash'); // trash / untrash / album_remove ...
        table.text('target_ids').notNullable().defaultTo('[]'); // 命中的 photo_index.id 列表（JSON）
        table.text('undo_data').nullable(); // 回滚所需快照（JSON）
        table.text('summary').nullable(); // {count, bytes} 供前端展示
        table.text('status').notNullable().defaultTo('executed'); // executed | undone | expired
        table.timestamp('create_time').defaultTo(knex.fn.now());
        table.timestamp('undone_time').nullable();
        table.timestamp('expire_time').nullable();
      });
      Logger.info(`✅ Table ${this.tableName} created`);
    } else {
      await this.ensureColumns(knex);
    }
  }

  async createIndexes(connection = null) {
    const knex = connection && connection.knex ? connection.knex : knexUtil.getInstance(dbUtil.DB_PATHS.PHOTO_DB);
    const existingIndexes = await knex.raw(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='${this.tableName}'`);
    const indexNames = Array.isArray(existingIndexes)
      ? existingIndexes.map(row => row.name)
      : ((existingIndexes?.rows || []).map(row => row.name));
    const targetIndexes = [
      { columns: ['uid', 'status'], name: 'idx_photo_operation_log_uid_status', unique: false },
      { columns: ['create_time'], name: 'idx_photo_operation_log_create_time', unique: false },
    ];
    for (const index of targetIndexes) {
      if (indexNames.includes(index.name)) continue;
      await knex.schema.alterTable(this.tableName, table => {
        if (index.unique) table.unique(index.columns, index.name);
        else table.index(index.columns, index.name);
      });
      Logger.info(`✅ Created index ${index.name} on table ${this.tableName}`);
    }
  }
}

const tablePhotoOperationLogInstance = new tablePhotoOperationLog();
module.exports = tablePhotoOperationLogInstance;
