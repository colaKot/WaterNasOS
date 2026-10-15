const ResponseUtil = require('../../../apiUtils/responseUtil');
const PhotoSourceService = require('./photoSourceService');
const FileUtil = require('../../../../utils/fileUtil');
const userUtil = require('../../../../utils/userUtil');
const fs = require('fs');

/**
 * 源目录归属规则：
 * - 普通用户只能操作自己的（uid = 自己）
 * - 管理员默认同样只看自己的；只有显式传 body.uid 时才可操作指定用户（管理用途）
 */
function resolveTargetUid(req) {
  const user = req && req.user;
  const selfUid = user && user.id ? Number(user.id) : 0;
  const raw = req && req.body ? req.body.uid : undefined;
  const bodyUid = raw !== undefined && raw !== null && raw !== '' ? Number(raw) : null;
  if (bodyUid && Number.isFinite(bodyUid) && bodyUid > 0 && userUtil.isAdmin(user)) return bodyUid;
  return selfUid;
}

async function stopPhotoIndexWorkerBeforeDelete(timeoutMs = 8000) {
  const waitStopped = new Promise(resolve => {
    if (typeof process.send !== 'function') return resolve(false);

    const requestId = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
    let done = false;
    const timer = setTimeout(
      () => {
        if (done) return;
        done = true;
        process.removeListener('message', onMessage);
        resolve(false);
      },
      Math.max(1000, Number(timeoutMs || 0) || 0)
    );

    const onMessage = message => {
      if (!message || message.type !== 'stopPhotoIndexWorkerResponse') return;
      if (!message.data || message.data.requestId !== requestId) return;
      if (done) return;
      done = true;
      clearTimeout(timer);
      process.removeListener('message', onMessage);
      resolve(!!message.data.stopped);
    };
    process.on('message', onMessage);

    try {
      process.send({ type: 'stopPhotoIndexWorker', data: { requestId } });
    } catch (_) {
      clearTimeout(timer);
      process.removeListener('message', onMessage);
      resolve(false);
    }
  });

  return await waitStopped;
}

class PhotoSourceController {
  async listSources(req, res) {
    try {
      const service = new PhotoSourceService(req.dbPhoto);
      const list = await service.listSources(resolveTargetUid(req));
      const enriched = await Promise.all(
        (list || []).map(async row => {
          const p = row && row.path ? String(row.path) : '';
          let exists = false;
          if (p) {
            try {
              const stat = await fs.promises.stat(p);
              exists = !!(stat && stat.isDirectory());
            } catch (_) {}
          }
          return { ...row, exists };
        })
      );
      return ResponseUtil.success(req, res, enriched, 'photo.PHOTO_SOURCE_LIST_SUCCESS', 200);
    } catch (err) {
      return ResponseUtil.error(req, res, 'photo.PHOTO_SOURCE_LIST_FAILED', 500);
    }
  }

  /**
   * 相册备份：跨相册源内容级去重（含 size 预检）。
   * body: { items: [{ md5?, size }] } -> data: { matched: [md5...], absent: [size...], scanned, hashed }
   * md5 可选：只带 size 的条目用于 absent 预检（该 size 无候选 => 内容必不存在，可免本地 MD5）。
   *
   * 可见性零角色例外：只在该用户自己的相册源范围内比对（超管也一样），
   * 与相册时间线的 getValidPaths 口径保持一致。这是只读查询，无写操作。
   */
  async checkBackupContent(req, res) {
    try {
      const service = new PhotoSourceService(req.dbPhoto);
      const items = req.body && Array.isArray(req.body.items) ? req.body.items : [];
      const uid = req.user && req.user.id ? Number(req.user.id) : 0;
      if (!Number.isFinite(uid) || uid <= 0) {
        return ResponseUtil.error(req, res, 'auth.PERMISSION_DENIED', 403);
      }
      if (items.length === 0) {
        return ResponseUtil.success(req, res, { matched: [], scanned: 0, hashed: 0 }, 'common.SUCCESS', 200);
      }
      const result = await service.findExistingContent(uid, items);
      return ResponseUtil.success(req, res, result, 'common.SUCCESS', 200);
    } catch (err) {
      return ResponseUtil.error(req, res, 'common.ERROR', 500);
    }
  }

  async addSource(req, res) {
    try {
      const service = new PhotoSourceService(req.dbPhoto);
      const { path } = req.body || {};
      // 检查系统关键目录
      if (FileUtil.isProtectedPath(path)) {
        return ResponseUtil.error(req, res, 'file.SYSTEM_PROTECTED_PATH');
      }
      // 检查目录是否存在
      if (!fs.existsSync(path)) {
        return ResponseUtil.error(req, res, 'file.FOLDER_NOT_EXIST');
      }

      const result = await service.addSource(path, resolveTargetUid(req));
      const statusCode = result.action === 'insert' ? 201 : 200;
      const messageKey = result.action === 'insert' ? 'photo.PHOTO_SOURCE_ADD_SUCCESS' : 'photo.PHOTO_SOURCE_UPDATE_SUCCESS';

      const scanPath = result && result.row && result.row.path ? String(result.row.path) : '';
      if (scanPath) {
        try {
          const exists = await req.dbPhoto('photo_scan_task').where({ scan_path: scanPath }).first();
          if (!exists) {
            await req.dbPhoto('photo_scan_task').insert({
              scan_path: scanPath,
              remark: 'source_add',
              create_time: new Date(),
            });
          }
          if (process.send) {
            process.send({ type: 'startPhotoIndexWorker', data: { scanPath } });
          }
        } catch (_) {}
      }
      if (process.send) {
        try {
          process.send({ type: 'resetPhotoWatchWorker' });
        } catch (_) {}
      }

      return ResponseUtil.success(req, res, result.row, messageKey, statusCode);
    } catch (err) {
      const msgKey = err && err.message ? err.message : 'common.ERROR';
      const statusCode = msgKey === 'photo.PHOTO_SOURCE_EXISTS' || msgKey === 'photo.PHOTO_SOURCE_PARENT_EXISTS' ? 409 : 400;
      if (err && err.args) {
        return ResponseUtil.errorWithArgs(req, res, msgKey, err.args, statusCode);
      }
      return ResponseUtil.error(req, res, msgKey, statusCode);
    }
  }

  async scanSource(req, res) {
    try {
      const rawPath = req.body && req.body.path !== undefined ? req.body.path : req.body && req.body.scan_path !== undefined ? req.body.scan_path : '';
      const input = rawPath === undefined || rawPath === null ? '' : String(rawPath).trim();
      if (!input) {
        return ResponseUtil.error(req, res, 'validation.VALIDATION_ERROR', 400);
      }

      const ownerUid = resolveTargetUid(req);
      let scanPaths = [];
      if (input === 'all') {
        const rows = await req
          .dbPhoto('photo_source')
          .where({ uid: ownerUid })
          .select('path')
          .catch(() => []);
        scanPaths = (rows || []).map(r => (r && r.path ? String(r.path) : '')).filter(Boolean);
      } else {
        const scanPath = input;
        const row = await req.dbPhoto('photo_source').where({ path: scanPath, uid: ownerUid }).first('id');
        if (!row || !row.id) {
          return ResponseUtil.error(req, res, 'common.NOT_FOUND', 404);
        }
        scanPaths = [scanPath];
      }

      const unique = Array.from(new Set((scanPaths || []).map(p => (p ? String(p) : '')).filter(Boolean)));
      if (unique.length === 0) {
        return ResponseUtil.success(req, res, { inserted: 0 }, 'common.SUCCESS', 200);
      }

      const remark = input === 'all' ? 'source_scan_all' : 'source_scan';
      const inserted = await req.dbPhoto.transaction(async trx => {
        const existingRows = await trx('photo_scan_task')
          .select('scan_path')
          .whereIn('scan_path', unique)
          .catch(() => []);
        const existing = new Set();
        for (const r of existingRows || []) {
          const s = r && r.scan_path ? String(r.scan_path) : '';
          if (s) existing.add(s);
        }

        const toInsert = [];
        for (const p of unique) {
          if (!existing.has(p)) {
            toInsert.push({
              scan_path: p,
              remark,
              create_time: new Date(),
            });
          }
        }

        if (toInsert.length === 0) return 0;
        await trx('photo_scan_task').insert(toInsert);
        return toInsert.length;
      });

      if (process.send) {
        try {
          process.send({ type: 'startPhotoIndexWorker', data: { scanPath: input } });
        } catch (_) {}
      }

      return ResponseUtil.success(req, res, { inserted }, 'common.SUCCESS', 200);
    } catch (err) {
      return ResponseUtil.error(req, res, 'common.ERROR', 500);
    }
  }

  async deleteSource(req, res) {
    try {
      await stopPhotoIndexWorkerBeforeDelete();
      const service = new PhotoSourceService(req.dbPhoto);
      const { id, path } = req.body || {};
      const affected = await service.deleteSource({
        id,
        path,
        uid: req.user && req.user.id,
        allowAnyOwner: userUtil.isAdmin(req.user),
      });
      if (process.send) {
        try {
          process.send({ type: 'resetPhotoWatchWorker' });
        } catch (_) {}
      }
      if (process.send) {
        try {
          process.send({ type: 'startPhotoIndexWorker', data: {} });
        } catch (_) {}
      }
      return ResponseUtil.success(req, res, { affected }, 'photo.PHOTO_SOURCE_DELETE_SUCCESS', 200);
    } catch (err) {
      const msgKey = err && err.message ? err.message : 'common.ERROR';
      const statusCode = err && err.statusCode ? Number(err.statusCode) : 400;
      return ResponseUtil.error(req, res, msgKey, statusCode);
    }
  }

  async updateSource(req, res) {
    try {
      const service = new PhotoSourceService(req.dbPhoto);
      const id = req.params && req.params.id;
      const row = await service.updateSource(
        id,
        req.body || {},
        req.user && req.user.id,
        userUtil.isAdmin(req.user)
      );
      if (process.send) {
        try {
          process.send({ type: 'resetPhotoWatchWorker' });
        } catch (_) {}
      }
      return ResponseUtil.success(req, res, row, 'photo.PHOTO_SOURCE_UPDATE_SUCCESS', 200);
    } catch (err) {
      const msgKey = err && err.message ? err.message : 'common.ERROR';
      const statusCode = err && err.statusCode ? Number(err.statusCode) : msgKey === 'common.NOT_FOUND' ? 404 : 400;
      return ResponseUtil.error(req, res, msgKey, statusCode);
    }
  }

  async relocateSource(req, res) {
    try {
      const service = new PhotoSourceService(req.dbPhoto);
      const id = req.params && req.params.id;
      const { new_path: newPath } = req.body || {};
      if (FileUtil.isProtectedPath(newPath)) {
        return ResponseUtil.error(req, res, 'file.SYSTEM_PROTECTED_PATH');
      }
      if (!newPath) {
        return ResponseUtil.error(req, res, 'validation.VALIDATION_ERROR', 400);
      }

      let stat;
      try {
        stat = await fs.promises.stat(String(newPath));
      } catch (_) {
        stat = null;
      }
      if (!stat || !stat.isDirectory()) {
        return ResponseUtil.error(req, res, 'file.FOLDER_NOT_EXIST', 400);
      }

      const result = await service.relocateSource(
        id,
        newPath,
        req.user && req.user.id,
        userUtil.isAdmin(req.user)
      );

      if (process.send) {
        try {
          process.send({ type: 'resetPhotoWatchWorker' });
        } catch (_) {}
      }

      return ResponseUtil.success(req, res, result, 'photo.PHOTO_SOURCE_RELOCATE_SUCCESS', 200);
    } catch (err) {
      const msgKey = err && err.message ? err.message : 'common.ERROR';
      const statusCode = err && err.statusCode ? Number(err.statusCode) : msgKey === 'common.NOT_FOUND' ? 404 : 400;
      if (err && err.args) {
        return ResponseUtil.errorWithArgs(req, res, msgKey, err.args, statusCode);
      }
      return ResponseUtil.error(req, res, msgKey, statusCode);
    }
  }

  async regenerateThumbnails(req, res) {
    try {
      // 将 photo_index 表的 gen_tiny 全部重置为 0
      await req.dbPhoto('photo_index')
        .where({ is_file: 1, in_trash: 0 })
        .whereIn('type', [1, 2])
        .update({ gen_tiny: 0 });

      // 将 video_index 表的 gen_tiny 全部重置为 0
      if (req.dbVideo) {
        await req.dbVideo('video_index')
          .where({ is_file: 1 })
          .whereIn('ext', (() => {
            try {
              const config = require('../../../../config/config');
              return Array.isArray(config.videoTypeList) ? config.videoTypeList : [];
            } catch (_) {
              return [];
            }
          })())
          .update({ gen_tiny: 0 });
      }

      // 影视库里的图片存在独立表 image_index，缩略图也一并重置
      // （否则"重建缩略图"对图片库无效）
      if (req.dbVideo) {
        await req.dbVideo('image_index').update({ gen_tiny: 0 }).catch(() => {});
      }

      // 启动缩略图生成进程（若已在运行则跳过，会在下次轮询中自动处理新记录）
      if (process.send) {
        try {
          process.send({ type: 'startTinyImageWorker' });
        } catch (_) {}
      }

      return ResponseUtil.success(req, res, {}, 'common.SUCCESS', 200);
    } catch (err) {
      return ResponseUtil.error(req, res, 'common.ERROR', 500);
    }
  }
}

module.exports = new PhotoSourceController();
