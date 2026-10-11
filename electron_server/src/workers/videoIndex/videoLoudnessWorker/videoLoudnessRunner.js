'use strict';

const fs = require('fs');
const path = require('path');
const dbUtil = require('../../../db/dbUtil');
const knexUtil = require('../../../db/knexUtil');
const VideoFfprobeUtil = require('../../../utils/videoFfprobeUtil');
const Logger = require('../../../utils/logger');

const PLAYABLE_MEDIA_TYPES = ['movie', 'episod', 'bdmv', 'video_ts'];
// 测量失败时的占位值：标记为「已处理」避免反复重试，转码时退回动态单遍 loudnorm
const UNAVAILABLE_LOUDNESS = JSON.stringify({ unavailable: true });

function resolvePlayableFilePath(row) {
  const baseDir = row && row.path ? String(row.path).trim() : '';
  const filename = row && row.filename ? String(row.filename).trim() : '';
  if (!baseDir || !filename) return '';
  const fullPath = path.join(baseDir, filename);
  const mediaType = row && row.media_type ? String(row.media_type).trim() : '';
  const playRelPath = row && row.play_rel_path ? String(row.play_rel_path).trim() : '';
  if ((mediaType === 'bdmv' || mediaType === 'video_ts') && playRelPath) {
    return path.resolve(fullPath, playRelPath);
  }
  return fullPath;
}

async function sourceRootExists(rootPath) {
  const resolved = path.resolve(String(rootPath || '').trim());
  if (!resolved) return false;
  try {
    const st = await fs.promises.stat(resolved);
    return !!(st && st.isDirectory());
  } catch (_) {
    return false;
  }
}

function applySourceRootFilter(qb, roots) {
  qb.where(inner => {
    for (const root of roots) {
      const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
      inner.orWhere('path', root).orWhere('path', 'like', `${prefix}%`);
      inner.orWhere({ path: path.dirname(root), filename: path.basename(root) });
    }
  });
}

class VideoLoudnessRunner {
  async init() {
    if (!knexUtil.hasConnection(dbUtil.DB_PATHS.VIDEO_DB)) {
      await knexUtil.init(dbUtil.DB_PATHS.VIDEO_DB);
    }
    if (!knexUtil.hasConnection(dbUtil.DB_PATHS.MAIN_DB)) {
      await knexUtil.init(dbUtil.DB_PATHS.MAIN_DB);
    }
    this.knexVideo = knexUtil.getInstance(dbUtil.DB_PATHS.VIDEO_DB);
    this._existingSourceRoots = null;
    this._deferredIds = new Set();
  }

  /** 存在「开启音频响度归一化」的影视库时才需要补齐 */
  async getEnabledLibraryIds() {
    const rows = await this.knexVideo('video_library')
      .where({ audio_normalize: 1 })
      .select('id')
      .catch(() => []);
    const ids = [];
    for (const r of rows || []) {
      const id = Number(r && r.id) || 0;
      if (id) ids.push(id);
    }
    return ids;
  }

  /** 开启归一化的影视库下的、可访问的来源根目录 */
  async getEnabledSourceRoots({ refresh = false } = {}) {
    if (!refresh && Array.isArray(this._existingSourceRoots)) return this._existingSourceRoots;
    const rows = await this.knexVideo('video_source as s')
      .leftJoin('video_library as l', 'l.id', 's.library_id')
      .where('l.audio_normalize', 1)
      .select('s.path')
      .orderBy('s.id', 'asc')
      .catch(() => []);
    const existing = [];
    const seen = new Set();
    for (const row of rows || []) {
      const raw = row && row.path ? String(row.path).trim() : '';
      if (!raw) continue;
      const resolved = path.resolve(raw);
      if (seen.has(resolved)) continue;
      seen.add(resolved);
      if (await sourceRootExists(resolved)) existing.push(resolved);
    }
    this._existingSourceRoots = existing;
    return existing;
  }

  async getPendingRow(existingRoots) {
    const roots = Array.isArray(existingRoots) ? existingRoots : [];
    if (roots.length === 0) return null;
    const deferredIds = Array.from(this._deferredIds || []).filter(id => Number(id) > 0);

    return (
      this.knexVideo('video_index as vi')
        .leftJoin('video_ffmpeg_info as fi', 'fi.id', 'vi.file_hash')
        .select('vi.id', 'vi.path', 'vi.filename', 'vi.media_type', 'vi.file_hash', 'vi.play_rel_path')
        .whereIn('vi.media_type', PLAYABLE_MEDIA_TYPES)
        .whereNot('vi.file_hash', '')
        .modify(qb => {
          if (deferredIds.length > 0) qb.whereNotIn('vi.id', deferredIds);
        })
        .where(qb => {
          qb.whereNull('fi.audio_loudness').orWhere('fi.audio_loudness', '');
        })
        .andWhere(qb => applySourceRootFilter(qb, roots))
        .orderBy('vi.id', 'asc')
        .first()
        .catch(() => null)
    );
  }

  async markDone(fileHash, loudness) {
    const id = fileHash ? String(fileHash).trim() : '';
    if (!id) return;
    const value = loudness ? JSON.stringify(loudness) : UNAVAILABLE_LOUDNESS;
    await VideoFfprobeUtil.upsertFfmpegVideoInfo(this.knexVideo, id, { audioLoudness: value }).catch(() => {});
  }

  async processRow(row) {
    const fileHash = row && row.file_hash ? String(row.file_hash).trim() : '';
    const filePath = resolvePlayableFilePath(row);
    if (!fileHash || !filePath) {
      // 无 file_hash 无法写缓存，直接跳过（延迟标记，避免死循环）
      this._deferredIds.add(row && row.id);
      return { processed: false, skippedInaccessible: true };
    }
    try {
      const st = await fs.promises.stat(filePath);
      if (!st || !st.isFile()) {
        this._deferredIds.add(row.id);
        return { processed: false, retryLater: true };
      }
    } catch (e) {
      Logger.info(
        `🔊 loudness scan skip (file inaccessible) id=${row.id} err=${e && e.code ? e.code : 'stat_failed'}`
      );
      this._deferredIds.add(row.id);
      return { processed: false, retryLater: true };
    }

    let loudness = null;
    try {
      loudness = await VideoFfprobeUtil.measureAudioLoudness(filePath);
    } catch (e) {
      Logger.error(`❌ loudness measure failed id=${row.id}`, e);
    }
    await this.markDone(fileHash, loudness);
    if (loudness) {
      Logger.info(`🔊 loudness measured id=${row.id} I=${loudness.input_i} TP=${loudness.input_tp}`);
    } else {
      Logger.info(`🔊 loudness unavailable (no audio / failed) id=${row.id}`);
    }
    return { processed: true };
  }

  async runOnce() {
    const enabledLibraryIds = await this.getEnabledLibraryIds();
    if (enabledLibraryIds.length === 0) {
      return { processed: false, disabled: true };
    }
    const existingRoots = await this.getEnabledSourceRoots({ refresh: true });
    if (existingRoots.length === 0) {
      return { processed: false, noAvailableSources: true };
    }
    const row = await this.getPendingRow(existingRoots);
    if (!row) return { processed: false };
    return await this.processRow(row);
  }
}

async function hasPendingVideoLoudnessWork() {
  const runner = new VideoLoudnessRunner();
  await runner.init();
  const enabledLibraryIds = await runner.getEnabledLibraryIds();
  if (enabledLibraryIds.length === 0) return false;
  const roots = await runner.getEnabledSourceRoots({ refresh: true });
  if (roots.length === 0) return false;
  const row = await runner.getPendingRow(roots);
  return !!row;
}

module.exports = { VideoLoudnessRunner, hasPendingVideoLoudnessWork };