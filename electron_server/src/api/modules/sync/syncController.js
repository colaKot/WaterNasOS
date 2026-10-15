const fs = require('fs-extra');
const path = require('path');
const ResponseUtil = require('../../apiUtils/responseUtil');
const Logger = require('../../../utils/logger');
const { hasPermission } = require('../../../utils/permissionUtil');
const tableSyncTask = require('../../../db/table/tableSyncTask');
const { SyncService } = require('./syncService');
const { buildPlan } = require('./syncPlanService');
const syncUtil = require('./syncUtil');

function currentUid(req) {
  return req.user && req.user.id ? Number(req.user.id) : 0;
}

/// 从请求体取设备上下文（v2 协议：device_id + device_bound）。
/// 旧客户端两者都没有 ⇒ deviceBound=false，服务端按「未绑定桶」兼容。
function deviceCtx(req) {
  const body = req.body || {};
  const bound = body.device_bound === true || body.device_bound === 'true' || body.device_bound === 1 || body.device_bound === '1';
  const deviceId = String(body.device_id ?? '').trim();
  return { deviceId, deviceBound: bound && !!deviceId };
}

function normalizeManifest(list, maxItems = 200000) {
  if (!Array.isArray(list)) return [];
  const out = [];
  const limit = Math.min(list.length, maxItems);
  for (let i = 0; i < limit; i++) {
    const item = list[i];
    if (!item || typeof item !== 'object') continue;
    const rel = syncUtil.normalizeRelPath(item.relPath);
    if (!rel) continue;
    out.push({
      relPath: rel,
      size: Number(item.size) || 0,
      mtimeMs: Number(item.mtimeMs) || 0,
    });
  }
  return out;
}

/**
 * 某个同步任务真正会用到的目录权限（按模式取）。
 *
 * 判据必须与「执行侧」一致，否则会出现任务建得出来、一跑就 403：
 * - view     ：/plan 会递归扫描 NAS 目录
 * - download ：/api/file/download（fileRouter 校验 ['download','view']）
 * - upload   ：/api/file/upload/chunk 与 /mkdir
 * - delete   ：/deleteRemote（仅双向且开启删除传播时）
 *
 * hasPermission 对 view/download 已内建「公共共享目录」放行，与 file 层行为一致。
 */
function requiredActions(mode, syncConfig) {
  const m = String(mode || tableSyncTask.MODE_BIDIRECTIONAL);
  const cfg = syncUtil.normalizeSyncConfig(syncConfig);
  const needsRead = m === tableSyncTask.MODE_DOWNLOAD_ONLY || m === tableSyncTask.MODE_BIDIRECTIONAL;
  const needsWrite = m === tableSyncTask.MODE_UPLOAD_ONLY || m === tableSyncTask.MODE_BIDIRECTIONAL;

  const actions = ['view'];
  if (needsRead) actions.push('download');
  if (needsWrite) actions.push('upload');
  if (m === tableSyncTask.MODE_BIDIRECTIONAL && cfg.deleteExtra) actions.push('delete');
  return actions;
}

/** 校验用户对同步目标目录是否具备本任务所需的全部权限，缺一即抛 403 */
async function assertSyncDirPermission(req, remoteDir, mode, syncConfig) {
  const actions = requiredActions(mode, syncConfig);
  for (const action of actions) {
    const ok = await hasPermission(req.dbMain, req.user, action, remoteDir).catch(() => false);
    if (!ok) throw syncUtil.buildHttpError('sync.REMOTE_DIR_NO_PERMISSION', 403);
  }
}

class SyncController {
  async list(req, res) {
    try {
      const service = new SyncService(req.dbMain);
      const { page, pageSize, status, mode, keyword, sort_by, sort_order } = req.body || {};
      const data = await service.list({
        uid: currentUid(req),
        page,
        pageSize,
        status,
        mode,
        keyword,
        sortBy: sort_by,
        sortOrder: sort_order,
        ...deviceCtx(req),
      });
      return ResponseUtil.success(req, res, data, 'common.SUCCESS', 200);
    } catch (e) {
      Logger.error('sync list failed', e);
      return ResponseUtil.error(req, res, 'common.ERROR', 500);
    }
  }

  async summary(req, res) {
    try {
      const service = new SyncService(req.dbMain);
      const data = await service.summary({ uid: currentUid(req), ...deviceCtx(req) });
      return ResponseUtil.success(req, res, data, 'common.SUCCESS', 200);
    } catch (e) {
      Logger.error('sync summary failed', e);
      return ResponseUtil.error(req, res, 'common.ERROR', 500);
    }
  }

  async get(req, res) {
    try {
      const service = new SyncService(req.dbMain);
      const { id } = req.body || {};
      const data = await service.get({ id, uid: currentUid(req), ...deviceCtx(req) });
      return ResponseUtil.success(req, res, data, 'common.SUCCESS', 200);
    } catch (e) {
      return ResponseUtil.error(req, res, e && e.message ? String(e.message) : 'common.ERROR', (e && e.statusCode) || 500);
    }
  }

  async upsert(req, res) {
    try {
      const service = new SyncService(req.dbMain);
      const { id, name, mode, local_dir, remote_dir, filter_config, sync_config, device_id, device_name } = req.body || {};

      // 建任务前先把「执行时一定会用到」的权限验一遍。
      // 不验的话任务能顺利入库，但一跑就被 /plan、/mkdir、上传、下载各自拦掉，
      // 用户只会看到一堆莫名其妙的失败。
      // 判据与执行侧完全一致，所以今天能跑通的任务，其 owner 一定有权限 —— 补闸
      // 不会拒绝任何「本来就能正常同步」的任务，只会挡住本来就跑不通的僵尸任务。
      // 注意：这只是创建时的检查，执行侧那几处仍然必须保留（权限可能事后被回收）。
      const remoteAbs = await syncUtil.resolveRemoteDir(remote_dir, { requireExists: false });
      await assertSyncDirPermission(req, remoteAbs, mode, sync_config);

      const data = await service.upsert({
        id,
        uid: currentUid(req),
        name,
        mode,
        localDir: local_dir,
        remoteDir: remote_dir,
        filterConfig: filter_config,
        syncConfig: sync_config,
        deviceId: device_id,
        deviceName: device_name,
        ...deviceCtx(req),
      });
      return ResponseUtil.success(req, res, data, 'common.SUCCESS', 200);
    } catch (e) {
      Logger.error('sync upsert failed', e);
      return ResponseUtil.error(req, res, e && e.message ? String(e.message) : 'common.ERROR', (e && e.statusCode) || 500);
    }
  }

  async remove(req, res) {
    try {
      const service = new SyncService(req.dbMain);
      const { id } = req.body || {};
      const data = await service.remove({ id, uid: currentUid(req), ...deviceCtx(req) });
      return ResponseUtil.success(req, res, data, 'common.SUCCESS', 200);
    } catch (e) {
      Logger.error('sync delete failed', e);
      return ResponseUtil.error(req, res, e && e.message ? String(e.message) : 'common.ERROR', (e && e.statusCode) || 500);
    }
  }

  async updateStatus(req, res) {
    try {
      const service = new SyncService(req.dbMain);
      const { id, status, progress, last_error, last_sync_time } = req.body || {};
      const data = await service.updateStatus({
        id,
        uid: currentUid(req),
        status,
        progress,
        lastError: last_error,
        lastSyncTime: last_sync_time,
        ...deviceCtx(req),
      });
      return ResponseUtil.success(req, res, data, 'common.SUCCESS', 200);
    } catch (e) {
      return ResponseUtil.error(req, res, e && e.message ? String(e.message) : 'common.ERROR', (e && e.statusCode) || 500);
    }
  }

  async listRecords(req, res) {
    try {
      const service = new SyncService(req.dbMain);
      const { id, page, pageSize } = req.body || {};
      const data = await service.listRecords({ taskId: id, uid: currentUid(req), page, pageSize, ...deviceCtx(req) });
      return ResponseUtil.success(req, res, data, 'common.SUCCESS', 200);
    } catch (e) {
      return ResponseUtil.error(req, res, e && e.message ? String(e.message) : 'common.ERROR', (e && e.statusCode) || 500);
    }
  }

  /**
   * 路径探测：客户端创建任务前检查 NAS 目录是否可用
   */
  async probe(req, res) {
    try {
      const { path: targetPath } = req.body || {};
      const abs = await syncUtil.resolveRemoteDir(targetPath, { requireExists: false });

      // 先鉴权，再决定要不要碰文件系统。
      // 反过来写的话，对该目录毫无权限的用户也能从 exists / isDirectory /
      // writable / fileCount 反推出目录结构，等于一个目录探测接口。
      const allowed = await hasPermission(req.dbMain, req.user, 'view', abs).catch(() => false);
      if (!allowed) {
        return ResponseUtil.success(
          req,
          res,
          { path: abs, allowed: false, exists: false, isDirectory: false, writable: false, fileCount: 0 },
          'common.SUCCESS',
          200
        );
      }

      const exists = await fs.pathExists(abs).catch(() => false);
      let isDirectory = false;
      let writable = false;
      let fileCount = 0;

      if (exists) {
        const stat = await fs.stat(abs).catch(() => null);
        isDirectory = !!(stat && stat.isDirectory());
        if (isDirectory) {
          try {
            await fs.access(abs, fs.constants.W_OK);
            writable = true;
          } catch (_) {
            writable = false;
          }
          const entries = await fs.readdir(abs).catch(() => []);
          fileCount = Array.isArray(entries) ? entries.length : 0;
        }
      }

      return ResponseUtil.success(req, res, { path: abs, exists, isDirectory, writable, fileCount, allowed: true }, 'common.SUCCESS', 200);
    } catch (e) {
      return ResponseUtil.error(req, res, 'common.ERROR', (e && e.statusCode) || 500);
    }
  }

  /**
   * 生成同步计划：客户端上报本地清单与基线，服务端扫描 NAS 目录后做三向比对
   */
  async plan(req, res) {
    try {
      const service = new SyncService(req.dbMain);
      const uid = currentUid(req);
      const { id, local_files, baseline_files, max_list_per_type } = req.body || {};

      const task = await service.get({ id, uid, ...deviceCtx(req) });
      const remoteDir = await syncUtil.resolveRemoteDir(task.remote_dir, { requireExists: true });

      const allowed = await hasPermission(req.dbMain, req.user, 'view', remoteDir).catch(() => false);
      if (!allowed) throw syncUtil.buildHttpError('common.FORBIDDEN', 403);

      const localFiles = normalizeManifest(local_files);
      const baselineFiles = normalizeManifest(baseline_files);

      const scanResult = await syncUtil.scanDirectory(remoteDir, syncUtil.normalizeFilterConfig(task.filter_config));

      const plan = buildPlan({
        task,
        localFiles,
        baselineFiles,
        remoteFiles: scanResult.files,
        maxListPerType: Number.isFinite(Number(max_list_per_type)) ? Number(max_list_per_type) : 5000,
      });

      const sessionId = `sync_${task.id}_${Date.now()}`;

      await service.updateStatus({
        id: task.id,
        uid,
        status: 'running',
        progress: {
          sessionId,
          startedAt: Date.now(),
          phase: 'planning',
          ...plan.summary,
        },
        ...deviceCtx(req),
      });

      return ResponseUtil.success(
        req,
        res,
        {
          sessionId,
          taskId: task.id,
          mode: plan.mode,
          hasBaseline: plan.hasBaseline,
          remoteDir,
          remoteScanned: scanResult.files.length,
          remoteSkipped: scanResult.skipped,
          remoteTruncated: scanResult.truncated,
          summary: plan.summary,
          upload: plan.upload,
          download: plan.download,
          deleteRemote: plan.deleteRemote,
          deleteLocal: plan.deleteLocal,
          conflicts: plan.conflicts,
          truncated: plan.truncated,
        },
        'common.SUCCESS',
        200
      );
    } catch (e) {
      Logger.error('sync plan failed', e);
      return ResponseUtil.error(req, res, 'common.ERROR', (e && e.statusCode) || 500);
    }
  }

  /**
   * 回写一轮同步结果
   */
  async report(req, res) {
    try {
      const service = new SyncService(req.dbMain);
      const uid = currentUid(req);
      const {
        id,
        start_time,
        end_time,
        status,
        upload_count,
        download_count,
        delete_count,
        skip_count,
        fail_count,
        bytes_transferred,
        error_list,
      } = req.body || {};

      const data = await service.addRecord({
        taskId: id,
        uid,
        startTime: start_time,
        endTime: end_time,
        status,
        uploadCount: upload_count,
        downloadCount: download_count,
        deleteCount: delete_count,
        skipCount: skip_count,
        failCount: fail_count,
        bytesTransferred: bytes_transferred,
        errorList: error_list,
        ...deviceCtx(req),
      });

      const finalStatus = String(status || '') === 'failed' ? 'error' : 'idle';
      await service.updateStatus({
        id,
        uid,
        status: finalStatus,
        progress: {
          finishedAt: Date.now(),
          phase: 'done',
          upload: Number(upload_count) || 0,
          download: Number(download_count) || 0,
          delete: Number(delete_count) || 0,
          fail: Number(fail_count) || 0,
        },
        lastError: String(status || '') === 'failed' ? `sync.SYNC_FAILED` : null,
        ...deviceCtx(req),
      });

      return ResponseUtil.success(req, res, data, 'common.SUCCESS', 200);
    } catch (e) {
      Logger.error('sync report failed', e);
      return ResponseUtil.error(req, res, 'common.ERROR', (e && e.statusCode) || 500);
    }
  }

  /**
   * 删除 NAS 侧文件（同步计划中的 deleteRemote）
   */
  async deleteRemote(req, res) {
    try {
      const service = new SyncService(req.dbMain);
      const uid = currentUid(req);
      const { id, rel_paths } = req.body || {};

      const task = await service.get({ id, uid, ...deviceCtx(req) });
      const remoteDir = await syncUtil.resolveRemoteDir(task.remote_dir, { requireExists: true });

      const allowed = await hasPermission(req.dbMain, req.user, 'view', remoteDir).catch(() => false);
      if (!allowed) throw syncUtil.buildHttpError('common.FORBIDDEN', 403);
      const canDelete = await hasPermission(req.dbMain, req.user, 'delete', remoteDir).catch(() => false);
      if (!canDelete) throw syncUtil.buildHttpError('common.FORBIDDEN', 403);

      const list = Array.isArray(rel_paths) ? rel_paths.slice(0, 5000) : [];
      let deleted = 0;
      const failed = [];
      for (const rel of list) {
        try {
          const abs = syncUtil.safeJoin(remoteDir, rel);
          await fs.remove(abs);
          deleted++;
        } catch (err) {
          failed.push({ relPath: String(rel || ''), error: String((err && err.message) || 'error') });
        }
      }

      return ResponseUtil.success(req, res, { deleted, failed, total: list.length }, 'common.SUCCESS', 200);
    } catch (e) {
      Logger.error('sync deleteRemote failed', e);
      return ResponseUtil.error(req, res, 'common.ERROR', (e && e.statusCode) || 500);
    }
  }

  /**
   * 在 NAS 侧创建目录
   */
  async mkdir(req, res) {
    try {
      const service = new SyncService(req.dbMain);
      const uid = currentUid(req);
      const { id, rel_path } = req.body || {};

      const task = await service.get({ id, uid, ...deviceCtx(req) });
      const remoteDir = await syncUtil.resolveRemoteDir(task.remote_dir, { requireExists: true });

      const allowed = await hasPermission(req.dbMain, req.user, 'upload', remoteDir).catch(() => false);
      if (!allowed) throw syncUtil.buildHttpError('common.FORBIDDEN', 403);

      const abs = syncUtil.safeJoin(remoteDir, rel_path);
      await fs.ensureDir(abs);
      return ResponseUtil.success(req, res, { path: abs }, 'common.SUCCESS', 200);
    } catch (e) {
      return ResponseUtil.error(req, res, 'common.ERROR', (e && e.statusCode) || 500);
    }
  }

  /**
   * 认领旧版任务：把本账号下「未绑定主机」的任务全部划到本机名下。
   *
   * 只影响 device_id 为空 / 不带 m: 前缀的任务；已被其它机器认领的不动，
   * 因此重复调用安全。典型用途：升级到设备隔离版本后，在老机器上点一次
   * 「归属到本机」，把以前共享桶里的任务收回到自己名下。
   */
  async claimLegacy(req, res) {
    try {
      const service = new SyncService(req.dbMain);
      const { device_id, device_name } = req.body || {};
      const ctx = deviceCtx(req);
      if (!ctx.deviceBound) {
        return ResponseUtil.error(req, res, 'sync.DEVICE_ID_REQUIRED', 400);
      }
      const data = await service.claimLegacy({
        uid: currentUid(req),
        deviceId: ctx.deviceId,
        deviceName: device_name,
      });
      return ResponseUtil.success(req, res, data, 'common.SUCCESS', 200);
    } catch (e) {
      Logger.error('sync claimLegacy failed', e);
      return ResponseUtil.error(req, res, e && e.message ? String(e.message) : 'common.ERROR', (e && e.statusCode) || 500);
    }
  }
}

module.exports = new SyncController();
