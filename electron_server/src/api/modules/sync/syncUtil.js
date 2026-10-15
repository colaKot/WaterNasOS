const fs = require('fs-extra');
const path = require('path');
const Logger = require('../../../utils/logger');

/**
 * 目录同步公共工具：路径规范化、过滤规则、目录扫描。
 * 客户端与服务端共用同一套过滤语义，服务端侧再兜底过滤一次，避免客户端旧版本规则不一致。
 */

// 系统始终过滤的扩展名（截图中的说明：tmp 和 temp 会始终由系统过滤）
const SYSTEM_EXCLUDED_EXTENSIONS = ['tmp', 'temp'];
// 系统始终过滤的文件名
const SYSTEM_EXCLUDED_NAMES = ['.DS_Store', 'Thumbs.db', 'desktop.ini'];

const SIZE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

const DEFAULT_FILTER_CONFIG = {
  excludeSmallEnabled: false,
  excludeSmallSize: 10,
  excludeSmallUnit: 'KB',
  excludeLargeEnabled: false,
  excludeLargeSize: 10,
  excludeLargeUnit: 'GB',
  excludeHidden: true,
  excludeExtensionEnabled: true,
  excludeExtensions: ['lnk', 'pst', 'swp'],
};

const DEFAULT_SYNC_CONFIG = {
  realtime: false, // 按需同步（实时监控）：默认关闭
  intervalMinutes: 1, // 定时同步间隔，0 表示不定时；默认 1 分钟
  conflictStrategy: 'prefer_newer', // prefer_newer | prefer_local | prefer_remote
  deleteExtra: false, // 是否传播删除（仅双向同步生效）
};

function buildHttpError(msgKey, statusCode) {
  const err = new Error(String(msgKey || 'common.ERROR'));
  err.statusCode = Number(statusCode || 500) || 500;
  return err;
}

function unitToBytes(value, unit) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  const u = String(unit || 'B').toUpperCase();
  const idx = SIZE_UNITS.indexOf(u);
  if (idx < 0) return n;
  return n * Math.pow(1024, idx);
}

/** 把过滤规则补全为完整结构，兼容旧数据与缺省字段 */
function normalizeFilterConfig(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const ext = Array.isArray(src.excludeExtensions)
    ? src.excludeExtensions
        .map(v => String(v || '').trim().replace(/^\./, '').toLowerCase())
        .filter(Boolean)
    : DEFAULT_FILTER_CONFIG.excludeExtensions.slice();
  return {
    excludeSmallEnabled: src.excludeSmallEnabled === true,
    excludeSmallSize: Number.isFinite(Number(src.excludeSmallSize)) ? Number(src.excludeSmallSize) : DEFAULT_FILTER_CONFIG.excludeSmallSize,
    excludeSmallUnit: SIZE_UNITS.includes(String(src.excludeSmallUnit || '').toUpperCase())
      ? String(src.excludeSmallUnit).toUpperCase()
      : DEFAULT_FILTER_CONFIG.excludeSmallUnit,
    excludeLargeEnabled: src.excludeLargeEnabled === true,
    excludeLargeSize: Number.isFinite(Number(src.excludeLargeSize)) ? Number(src.excludeLargeSize) : DEFAULT_FILTER_CONFIG.excludeLargeSize,
    excludeLargeUnit: SIZE_UNITS.includes(String(src.excludeLargeUnit || '').toUpperCase())
      ? String(src.excludeLargeUnit).toUpperCase()
      : DEFAULT_FILTER_CONFIG.excludeLargeUnit,
    excludeHidden: src.excludeHidden !== false,
    excludeExtensionEnabled: src.excludeExtensionEnabled !== false,
    excludeExtensions: Array.from(new Set(ext)),
  };
}

function normalizeSyncConfig(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const strategy = String(src.conflictStrategy || '').trim();
  const interval = Number(src.intervalMinutes);
  return {
    realtime: src.realtime === true,
    intervalMinutes: Number.isFinite(interval) && interval >= 0 ? Math.min(interval, 24 * 60) : DEFAULT_SYNC_CONFIG.intervalMinutes,
    conflictStrategy: ['prefer_newer', 'prefer_local', 'prefer_remote'].includes(strategy) ? strategy : DEFAULT_SYNC_CONFIG.conflictStrategy,
    deleteExtra: src.deleteExtra === true,
  };
}

/** 相对路径统一为 POSIX 风格，去首尾斜杠 */
function normalizeRelPath(raw) {
  let s = String(raw || '')
    .replace(/\\/g, '/')
    .trim();
  while (s.startsWith('/')) s = s.slice(1);
  while (s.endsWith('/')) s = s.slice(0, -1);
  return s;
}

/**
 * 判断相对路径是否应被过滤（返回 true 表示排除）。
 * @param {string} relPath 相对路径（POSIX 风格）
 * @param {number} size 文件大小（字节），目录传 0
 * @param {object} filter 已 normalize 的过滤规则
 */
function isExcluded(relPath, size, filter) {
  const rel = normalizeRelPath(relPath);
  if (!rel) return false;

  const segments = rel.split('/').filter(Boolean);
  const baseName = segments.length ? segments[segments.length - 1] : rel;
  const lowerBase = baseName.toLowerCase();

  if (SYSTEM_EXCLUDED_NAMES.includes(lowerBase)) return true;

  const ext = path.posix.extname(lowerBase).replace(/^\./, '');
  if (ext && SYSTEM_EXCLUDED_EXTENSIONS.includes(ext)) return true;

  // 隐藏文件/文件夹：任一层以 "." 开头
  if (filter.excludeHidden) {
    const hasHiddenSegment = segments.some(seg => seg.startsWith('.') && seg !== '.' && seg !== '..');
    if (hasHiddenSegment) return true;
  }

  // 排除文件类型（按扩展名）
  if (filter.excludeExtensionEnabled && ext && filter.excludeExtensions.includes(ext)) return true;

  const bytes = Number(size);
  if (Number.isFinite(bytes) && bytes >= 0) {
    if (filter.excludeSmallEnabled) {
      const min = unitToBytes(filter.excludeSmallSize, filter.excludeSmallUnit);
      if (bytes > 0 && min > 0 && bytes < min) return true;
    }
    if (filter.excludeLargeEnabled) {
      const max = unitToBytes(filter.excludeLargeSize, filter.excludeLargeUnit);
      if (max > 0 && bytes > max) return true;
    }
  }

  return false;
}

/**
 * 递归扫描目录，返回文件清单。
 * 只返回文件（不含目录），relPath 为相对 rootDir 的 POSIX 风格路径。
 * @returns {Promise<{files: Array<{relPath:string,size:number,mtimeMs:number}>, skipped:number, truncated:boolean}>}
 */
async function scanDirectory(rootDir, filter, options = {}) {
  const maxFiles = Number.isFinite(Number(options.maxFiles)) ? Number(options.maxFiles) : 200000;
  const maxDepth = Number.isFinite(Number(options.maxDepth)) ? Number(options.maxDepth) : 64;
  const files = [];
  let skipped = 0;
  let truncated = false;

  const walk = async (dir, relPrefix, depth) => {
    if (truncated) return;
    if (depth > maxDepth) {
      skipped++;
      return;
    }
    let entries = [];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (e) {
      Logger.warn(`sync scanDirectory readdir failed: ${dir}`, e && e.message);
      skipped++;
      return;
    }

    for (const entry of entries) {
      if (truncated) return;
      const name = entry.name;
      const rel = relPrefix ? `${relPrefix}/${name}` : name;
      const full = path.join(dir, name);

      if (entry.isDirectory()) {
        if (isExcluded(rel, 0, filter)) {
          skipped++;
          continue;
        }
        await walk(full, rel, depth + 1);
        continue;
      }

      if (!entry.isFile()) {
        skipped++;
        continue;
      }

      let stat = null;
      try {
        stat = await fs.stat(full);
      } catch (_) {
        skipped++;
        continue;
      }

      if (isExcluded(rel, stat.size, filter)) {
        skipped++;
        continue;
      }

      if (files.length >= maxFiles) {
        truncated = true;
        return;
      }

      files.push({
        relPath: rel,
        size: Number(stat.size) || 0,
        // 取整到毫秒：客户端按 int 解析时间戳，带小数的 mtimeMs 会被丢成 0
        mtimeMs: Math.round(Number(stat.mtimeMs) || 0),
      });
    }
  };

  await walk(rootDir, '', 0);
  return { files, skipped, truncated };
}

/** 校验并解析 NAS 侧目录，必须是绝对路径且存在 */
async function resolveRemoteDir(remoteDir, { requireExists = true } = {}) {
  const raw = String(remoteDir || '').trim();
  if (!raw) throw buildHttpError('sync.REMOTE_DIR_REQUIRED', 400);
  const abs = path.resolve(raw);
  if (!path.isAbsolute(abs)) throw buildHttpError('sync.REMOTE_DIR_INVALID', 400);
  if (requireExists) {
    const exists = await fs.pathExists(abs).catch(() => false);
    if (!exists) throw buildHttpError('sync.REMOTE_DIR_NOT_FOUND', 404);
    const stat = await fs.stat(abs).catch(() => null);
    if (!stat || !stat.isDirectory()) throw buildHttpError('sync.REMOTE_DIR_NOT_DIRECTORY', 400);
  }
  return abs;
}

/** 防目录穿越：相对路径解析后必须仍位于 rootDir 内 */
function safeJoin(rootDir, relPath) {
  const rel = normalizeRelPath(relPath);
  if (!rel) throw buildHttpError('sync.REL_PATH_INVALID', 400);
  const parts = rel.split('/');
  if (parts.some(p => p === '..' || p === '')) throw buildHttpError('sync.REL_PATH_INVALID', 400);
  const abs = path.resolve(rootDir, ...parts);
  const rootResolved = path.resolve(rootDir);
  const withSep = rootResolved.endsWith(path.sep) ? rootResolved : rootResolved + path.sep;
  if (abs !== rootResolved && !abs.startsWith(withSep)) {
    throw buildHttpError('sync.REL_PATH_INVALID', 400);
  }
  return abs;
}

module.exports = {
  SIZE_UNITS,
  SYSTEM_EXCLUDED_EXTENSIONS,
  SYSTEM_EXCLUDED_NAMES,
  DEFAULT_FILTER_CONFIG,
  DEFAULT_SYNC_CONFIG,
  buildHttpError,
  unitToBytes,
  normalizeFilterConfig,
  normalizeSyncConfig,
  normalizeRelPath,
  isExcluded,
  scanDirectory,
  resolveRemoteDir,
  safeJoin,
};
