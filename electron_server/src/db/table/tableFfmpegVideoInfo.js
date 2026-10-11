const knexUtil = require('../knexUtil');
const dbUtil = require('../dbUtil');
const Logger = require('../../utils/logger');

class TableFfmpegVideoInfo {
  static async createTable(connection = null) {
    let knex;
    if (connection && connection.knex) {
      knex = connection.knex;
    } else {
      knex = knexUtil.getInstance(dbUtil.DB_PATHS.VIDEO_DB);
    }
    const hasTable = await knex.schema.hasTable('video_ffmpeg_info');
    if (!hasTable) {
      await knex.schema.createTable('video_ffmpeg_info', table => {
        table.string('id').primary();
        table.text('streams');
        table.integer('duration');
        table.string('format');
        table.integer('size');
        table.integer('mtime');
        table.integer('width');
        table.integer('height');
        // Playback hints cache (JSON, built from container atoms / tags), for faster open experience.
        table.text('playback_hints');
        // 音频响度测量结果（JSON，loudnorm 首遍输出），供转码做两遍线性响度归一化
        table.text('audio_loudness');
        table.integer('create_time');
      });
      Logger.info('✅ video_ffmpeg_info table created');
      return;
    }

    // Table exists: best-effort add missing columns (older installs).
    const ensureColumn = async (name, alterFn) => {
      const has = await knex.schema.hasColumn('video_ffmpeg_info', name).catch(() => false);
      if (has) return;
      await knex.schema.alterTable('video_ffmpeg_info', alterFn);
    };

    await ensureColumn('playback_hints', t => t.text('playback_hints'));
    await ensureColumn('audio_loudness', t => t.text('audio_loudness'));
  }

  static async createIndexes(knex) {
    // Indexes can be added here if needed
  }
}

module.exports = TableFfmpegVideoInfo;
