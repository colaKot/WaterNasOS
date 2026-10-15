const tableSyncTask = require('../../../db/table/tableSyncTask');
const syncUtil = require('./syncUtil');

// 文件系统时间精度差异容差（FAT 为 2 秒粒度）
const MTIME_TOLERANCE_MS = 2000;

function sameFile(a, b) {
  if (!a || !b) return false;
  if (Number(a.size) !== Number(b.size)) return false;
  const diff = Math.abs(Number(a.mtimeMs) - Number(b.mtimeMs));
  return diff <= MTIME_TOLERANCE_MS;
}

function toMap(list) {
  const map = new Map();
  if (Array.isArray(list)) {
    for (const item of list) {
      const rel = syncUtil.normalizeRelPath(item && item.relPath);
      if (!rel) continue;
      map.set(rel, {
        relPath: rel,
        size: Number(item.size) || 0,
        // 统一取整：Node 的 stat.mtimeMs 带小数（NTFS 100ns 精度），
        // 老客户端按 int 解析会直接失败并丢成 0，下载后不回写 mtime
        // ⇒ 每轮重复下载。这里取整后即使客户端不升级也能收敛。
        mtimeMs: Math.round(Number(item.mtimeMs) || 0),
      });
    }
  }
  return map;
}

function makeItem(file, reason) {
  return {
    relPath: file.relPath,
    size: file.size,
    mtimeMs: file.mtimeMs,
    reason,
  };
}

/**
 * 计算同步计划。
 * @param {object} params
 * @param {object} params.task 同步任务记录（已 _mapRow）
 * @param {Array} params.localFiles 客户端上报的本地文件清单
 * @param {Array} [params.baselineFiles] 客户端上次同步基线（用于识别删除与冲突）
 * @param {Array} params.remoteFiles 服务端扫描出的 NAS 文件清单
 * @param {number} [params.maxListPerType] 单类计划最多返回条数，防止响应过大
 */
function buildPlan({ task, localFiles, baselineFiles, remoteFiles, maxListPerType = 5000 }) {
  const mode = String(task.mode || tableSyncTask.MODE_BIDIRECTIONAL);
  const syncConfig = syncUtil.normalizeSyncConfig(task.sync_config);
  const hasBaseline = Array.isArray(baselineFiles) && baselineFiles.length > 0;

  const localMap = toMap(localFiles);
  const remoteMap = toMap(remoteFiles);
  const baseMap = toMap(baselineFiles);

  const upload = [];
  const download = [];
  const deleteRemote = [];
  const deleteLocal = [];
  const conflicts = [];
  let skipCount = 0;

  const allPaths = new Set([...localMap.keys(), ...remoteMap.keys()]);
  const orderedPaths = Array.from(allPaths).sort();

  for (const rel of orderedPaths) {
    const l = localMap.get(rel);
    const r = remoteMap.get(rel);
    const b = baseMap.get(rel);

    // ── 仅上传：以本地为准 ──
    if (mode === tableSyncTask.MODE_UPLOAD_ONLY) {
      if (l && !r) {
        upload.push(makeItem(l, 'missing_on_remote'));
      } else if (l && r) {
        if (sameFile(l, r)) skipCount++;
        else upload.push(makeItem(l, 'content_differs'));
      } else {
        // 远端有、本地没有：不上传也不删除（安全策略）
        skipCount++;
      }
      continue;
    }

    // ── 仅下载：以 NAS 为准 ──
    if (mode === tableSyncTask.MODE_DOWNLOAD_ONLY) {
      if (r && !l) {
        download.push(makeItem(r, 'missing_on_local'));
      } else if (r && l) {
        if (sameFile(l, r)) skipCount++;
        else download.push(makeItem(r, 'content_differs'));
      } else {
        skipCount++;
      }
      continue;
    }

    // ── 双向同步 ──
    if (l && r) {
      if (sameFile(l, r)) {
        skipCount++;
        continue;
      }
      if (b) {
        const localChanged = !sameFile(l, b);
        const remoteChanged = !sameFile(r, b);
        if (localChanged && remoteChanged) {
          resolveConflict({ rel, l, r, syncConfig, upload, download, conflicts });
        } else if (localChanged) {
          upload.push(makeItem(l, 'newer_local'));
        } else if (remoteChanged) {
          download.push(makeItem(r, 'newer_remote'));
        } else {
          upload.push(makeItem(l, 'content_differs'));
        }
        continue;
      }
      // 无基线：按修改时间取新
      if (l.mtimeMs > r.mtimeMs + MTIME_TOLERANCE_MS) {
        upload.push(makeItem(l, 'newer_local'));
      } else if (r.mtimeMs > l.mtimeMs + MTIME_TOLERANCE_MS) {
        download.push(makeItem(r, 'newer_remote'));
      } else {
        resolveConflict({ rel, l, r, syncConfig, upload, download, conflicts });
      }
      continue;
    }

    if (l && !r) {
      if (b) {
        // 曾同步过，远端已删除
        if (syncConfig.deleteExtra) {
          deleteLocal.push(rel);
        } else {
          conflicts.push({ relPath: rel, type: 'remote_deleted', resolution: 'skipped' });
          skipCount++;
        }
      } else {
        upload.push(makeItem(l, 'local_only'));
      }
      continue;
    }

    if (!l && r) {
      if (b && hasBaseline) {
        // 曾同步过，本地已删除
        if (syncConfig.deleteExtra) {
          deleteRemote.push(rel);
        } else {
          conflicts.push({ relPath: rel, type: 'local_deleted', resolution: 'skipped' });
          skipCount++;
        }
      } else {
        download.push(makeItem(r, 'remote_only'));
      }
      continue;
    }
  }

  const limitList = list => (list.length > maxListPerType ? list.slice(0, maxListPerType) : list);

  let uploadBytes = 0;
  for (const it of upload) uploadBytes += Number(it.size) || 0;
  let downloadBytes = 0;
  for (const it of download) downloadBytes += Number(it.size) || 0;

  return {
    mode,
    hasBaseline,
    summary: {
      localTotal: localMap.size,
      remoteTotal: remoteMap.size,
      baselineTotal: baseMap.size,
      upload: upload.length,
      download: download.length,
      deleteRemote: deleteRemote.length,
      deleteLocal: deleteLocal.length,
      skip: skipCount,
      conflict: conflicts.length,
      uploadBytes,
      downloadBytes,
    },
    upload: limitList(upload),
    download: limitList(download),
    deleteRemote: limitList(deleteRemote),
    deleteLocal: limitList(deleteLocal),
    conflicts: limitList(conflicts),
    truncated: upload.length > maxListPerType || download.length > maxListPerType || deleteRemote.length > maxListPerType || deleteLocal.length > maxListPerType,
  };
}

function resolveConflict({ rel, l, r, syncConfig, upload, download, conflicts }) {
  const strategy = syncConfig.conflictStrategy;
  let resolution;
  if (strategy === 'prefer_remote') {
    resolution = 'download';
    download.push(makeItem(r, 'conflict'));
  } else if (strategy === 'prefer_local') {
    resolution = 'upload';
    upload.push(makeItem(l, 'conflict'));
  } else {
    // prefer_newer：按 mtime，完全相同时偏向本地
    if (r.mtimeMs > l.mtimeMs + MTIME_TOLERANCE_MS) {
      resolution = 'download';
      download.push(makeItem(r, 'conflict'));
    } else {
      resolution = 'upload';
      upload.push(makeItem(l, 'conflict'));
    }
  }
  conflicts.push({ relPath: rel, type: 'both_modified', resolution });
}

module.exports = { buildPlan, sameFile, MTIME_TOLERANCE_MS };
