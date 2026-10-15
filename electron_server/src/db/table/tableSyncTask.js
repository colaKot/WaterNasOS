const knexUtil = require('../knexUtil');
const dbUtil = require('../dbUtil');
const Logger = require('../../utils/logger');

/**
 * 电脑 <-> NAS 目录同步任务表
 * local_dir 只作为展示与校验用，真正的本地文件系统在客户端；
 * remote_dir 是 NAS 侧目录，服务端据此扫描并生成同步计划。
 */
class tableSyncTask {
  // 同步模式
  static MODE_BIDIRECTIONAL = 'bidirectional'; // 双向同步
  static MODE_DOWNLOAD_ONLY = 'download_only'; // 仅下载（NAS -> 电脑）
  static MODE_UPLOAD_ONLY = 'upload_only'; // 仅上传（电脑 -> NAS）

  static MODES = [tableSyncTask.MODE_BIDIRECTIONAL, tableSyncTask.MODE_DOWNLOAD_ONLY, tableSyncTask.MODE_UPLOAD_ONLY];

  // 任务状态
  static STATUS_IDLE = 'idle';
  static STATUS_RUNNING = 'running';
  static STATUS_PAUSED = 'paused';
  static STATUS_ERROR = 'error';

  static STATUSES = [tableSyncTask.STATUS_IDLE, tableSyncTask.STATUS_RUNNING, tableSyncTask.STATUS_PAUSED, tableSyncTask.STATUS_ERROR];

  constructor() {
    this.tableName = 'sync_task';
  }

  async createTable(connection = null) {
    const knex = connection && connection.knex ? connection.knex : knexUtil.getInstance(dbUtil.DB_PATHS.MAIN_DB);
    const tableExists = await knex.schema.hasTable(this.tableName);
    if (!tableExists) {
      await knex.schema.createTable(this.tableName, table => {
        table.increments('id').primary();
        table.integer('uid').notNullable(); // 任务归属用户
        table.text('name').notNullable(); // 任务名称
        table.text('device_id').notNullable().defaultTo(''); // 客户端设备标识
        table.text('device_name').notNullable().defaultTo(''); // 客户端设备名称
        table.text('mode').notNullable().defaultTo(tableSyncTask.MODE_BIDIRECTIONAL); // 同步模式
        table.text('local_dir').notNullable().defaultTo(''); // 电脑目录（仅记录展示）
        table.text('remote_dir').notNullable(); // NAS 目录
        table.text('filter_config').notNullable().defaultTo('{}'); // 过滤规则 JSON
        table.text('sync_config').notNullable().defaultTo('{}'); // 同步策略 JSON
        table.text('status').notNullable().defaultTo(tableSyncTask.STATUS_IDLE);
        table.text('progress').notNullable().defaultTo('');
        table.timestamp('last_sync_time').nullable();
        table.text('last_error').nullable();
        table.timestamp('create_time').defaultTo(knex.fn.now());
        table.timestamp('update_time').defaultTo(knex.fn.now());
      });
      Logger.info(`✅ Table ${this.tableName} created`);
    }
  }

  async createIndexes(connection = null) {
    const knex = connection && connection.knex ? connection.knex : knexUtil.getInstance(dbUtil.DB_PATHS.MAIN_DB);
    const existingIndexes = await knex.raw(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='${this.tableName}'`);
    const rows = Array.isArray(existingIndexes) ? existingIndexes : existingIndexes?.rows || [];
    const indexNames = rows.map(row => row.name);

    const targetIndexes = [
      { columns: ['uid'], name: 'idx_sync_task_uid', unique: false },
      { columns: ['status'], name: 'idx_sync_task_status', unique: false },
      { columns: ['mode'], name: 'idx_sync_task_mode', unique: false },
      { columns: ['device_id'], name: 'idx_sync_task_device_id', unique: false },
      // 设备隔离（2026-10-12）：list/summary/归属校验都按 (uid, device_id) 查
      { columns: ['uid', 'device_id'], name: 'idx_sync_task_uid_device', unique: false },
      { columns: ['remote_dir'], name: 'idx_sync_task_remote_dir', unique: false },
      { columns: ['create_time'], name: 'idx_sync_task_create_time', unique: false },
      { columns: ['uid', 'status'], name: 'idx_sync_task_uid_status', unique: false },
    ];

    for (const index of targetIndexes) {
      if (indexNames.includes(index.name)) continue;
      await knex.schema.alterTable(this.tableName, table => {
        if (index.unique) {
          table.unique(index.columns, index.name);
        } else {
          table.index(index.columns, index.name);
        }
      });
      Logger.info(`✅ Created ${index.unique ? 'unique ' : ''}index ${index.name} on table ${this.tableName}`);
    }
  }
}

const instance = new tableSyncTask();
instance.MODE_BIDIRECTIONAL = tableSyncTask.MODE_BIDIRECTIONAL;
instance.MODE_DOWNLOAD_ONLY = tableSyncTask.MODE_DOWNLOAD_ONLY;
instance.MODE_UPLOAD_ONLY = tableSyncTask.MODE_UPLOAD_ONLY;
instance.MODES = tableSyncTask.MODES;
instance.STATUS_IDLE = tableSyncTask.STATUS_IDLE;
instance.STATUS_RUNNING = tableSyncTask.STATUS_RUNNING;
instance.STATUS_PAUSED = tableSyncTask.STATUS_PAUSED;
instance.STATUS_ERROR = tableSyncTask.STATUS_ERROR;
instance.STATUSES = tableSyncTask.STATUSES;

module.exports = instance;
