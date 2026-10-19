const ResponseUtil = require('../../../apiUtils/responseUtil');
const FaceService = require('./faceService');
const archiver = require('archiver');
const path = require('path');
const fs = require('fs');
const Logger = require('../../../../utils/logger');
const photoTimeLineService = require('../timeline/photoTimeLineService');
const tableConfig = require('../../../../db/table/tableConfig');
const userUtil = require('../../../../utils/userUtil');

// 人脸聚类参数默认值 / 取值范围（服务端与 AI 设置页共用口径）
const FACE_TUNING_DEFAULTS = { simThresh: 0.45, minQuality: 75, secondMergeThresh: 0.45, threads: 3, namedExtraReq: 0.05 };
const FACE_TUNING_RANGE = {
  simThresh: [0.2, 0.9],
  minQuality: [40, 95],
  secondMergeThresh: [0.2, 0.9],
  threads: [1, 8],
  // ⭐ 2026-10-19 已命名人物的额外认领门槛（父子/表兄弟这类家族脸靠它拉开）
  namedExtraReq: [0, 0.2],
};

async function getEnableByKey(key) {
  try {
    const raw = await tableConfig.getConfigByKey(key);
    return raw === '1' ? 1 : 0;
  } catch (_) {
    return 0;
  }
}

class FaceController {
  listFaces = async (req, res) => {
    try {
      const faceEnable = await getEnableByKey('ai_face_enable');
      if (faceEnable !== 1) {
        const body = req.body || {};
        const page = Math.max(1, Number(body.page) || 1);
        const pageSize = Math.max(1, Math.min(200, Number(body.pageSize ?? body.page_size) || 60));
        return ResponseUtil.success(
          req,
          res,
          {
            faceEnable,
            items: [],
            pagination: {
              total: 0,
              page,
              pageSize,
            },
          },
          'common.SUCCESS',
          200
        );
      }
      let validPaths;
      // 按归属隔离：所有用户（含管理员）都只能看到自己源目录下的照片。
      // 不要再加 isAdmin 例外 —— 隐私设计要求超管也只看自己的。
      if (req.user) {
        const validPathsRaw = await photoTimeLineService.getValidPaths(req.user);
        validPaths = (validPathsRaw || []).map(p => (p ? String(p) : '')).filter(Boolean);
      }
      const service = new FaceService(req.dbPhoto);
      const result = await service.listFaces({ ...(req.body || {}), ...(validPaths !== undefined ? { validPaths } : {}) });
      // ⭐ 识别进度一起返回：用户在人脸页就能看到「识别到多少 / 共多少」
      const progress = await (async () => {
        try {
          const row = await req
            .dbPhoto('photo_index')
            .where('is_file', 1)
            .andWhere('in_trash', 0)
            .select(
              req.dbPhoto.raw('COUNT(1) as total'),
              req.dbPhoto.raw('SUM(CASE WHEN gen_faces = 1 THEN 1 ELSE 0 END) as done')
            )
            .first();
          const total = Number(row && row.total ? row.total : 0) || 0;
          const done = Number(row && row.done ? row.done : 0) || 0;
          return {
            total,
            done,
            remain: Math.max(0, total - done),
            percent: total > 0 ? Math.round((done / total) * 100) : 0,
          };
        } catch (_) {
          return { total: 0, done: 0, remain: 0, percent: 0 };
        }
      })();
      return ResponseUtil.success(req, res, { faceEnable, faceProgress: progress, ...result }, 'common.SUCCESS', 200);
    } catch (e) {
      return ResponseUtil.error(req, res, 'common.ERROR', 500);
    }
  };

  setFaceCover = async (req, res) => {
    try {
      const body = req.body || {};
      const service = new FaceService(req.dbPhoto);
      const result = await service.setFaceCover({
        faceId: body.face_id ?? body.faceId,
        fileHash: body.file_hash ?? body.fileHash,
      });
      return ResponseUtil.success(req, res, result, 'common.SUCCESS', 200);
    } catch (e) {
      const msgKey = e && e.message ? e.message : 'common.ERROR';
      const statusCode = e && e.statusCode ? Number(e.statusCode) : msgKey === 'common.NOT_FOUND' ? 404 : msgKey === 'common.PARAM_ERROR' ? 400 : 500;
      return ResponseUtil.error(req, res, msgKey, statusCode);
    }
  };

  updateFaceName = async (req, res) => {
    try {
      const body = req.body || {};
      const service = new FaceService(req.dbPhoto);
      const result = await service.updateFaceName({
        faceId: body.face_id ?? body.faceId,
        name: body.name,
      });
      return ResponseUtil.success(req, res, result, 'common.SUCCESS', 200);
    } catch (e) {
      const msgKey = e && e.message ? e.message : 'common.ERROR';
      const statusCode = e && e.statusCode ? Number(e.statusCode) : msgKey === 'common.NOT_FOUND' ? 404 : msgKey === 'common.PARAM_ERROR' ? 400 : 500;
      return ResponseUtil.error(req, res, msgKey, statusCode);
    }
  };

  /// 取当前用户可见的相册源（人脸写操作的校验口径，与列表一致：零角色例外）
  _validPathsOf = async (req) => {
    if (!req.user) return [];
    const raw = await photoTimeLineService.getValidPaths(req.user);
    return (raw || []).map(p => (p ? String(p) : '')).filter(Boolean);
  };

  mergeFaces = async (req, res) => {
    try {
      const body = req.body || {};
      const service = new FaceService(req.dbPhoto);
      const result = await service.mergeFaces({
        faceIds: body.face_ids ?? body.faceIds,
        fromFaceId: body.from_face_id ?? body.fromFaceId,
        toFaceId: body.to_face_id ?? body.toFaceId,
        validPaths: await this._validPathsOf(req),
      });
      return ResponseUtil.success(req, res, result, 'common.SUCCESS', 200);
    } catch (e) {
      const msgKey = e && e.message ? e.message : 'common.ERROR';
      const statusCode = e && e.statusCode ? Number(e.statusCode) : msgKey === 'common.NOT_FOUND' ? 404 : msgKey === 'common.PARAM_ERROR' ? 400 : 500;
      return ResponseUtil.error(req, res, msgKey, statusCode);
    }
  };

  setFaceStatus = async (req, res) => {
    try {
      const body = req.body || {};
      const service = new FaceService(req.dbPhoto);
      const result = await service.updateFaceStatus({
        faceId: body.face_id ?? body.faceId,
        status: body.status ?? body.state,
        is_hide: body.is_hide ?? body.isHide,
        validPaths: await this._validPathsOf(req),
      });
      return ResponseUtil.success(req, res, result, 'common.SUCCESS', 200);
    } catch (e) {
      const msgKey = e && e.message ? e.message : 'common.ERROR';
      const statusCode = e && e.statusCode ? Number(e.statusCode) : msgKey === 'common.NOT_FOUND' ? 404 : msgKey === 'common.PARAM_ERROR' ? 400 : 500;
      return ResponseUtil.error(req, res, msgKey, statusCode);
    }
  };

  /** 清理历史误检人脸（全局维护操作，限管理员） */
  purgeSuspiciousFaces = async (req, res) => {
    try {
      const body = req.body || {};
      const service = new FaceService(req.dbPhoto);
      const result = await service.purgeSuspiciousFaces({
        maxFacesPerImage: body.max_faces_per_image ?? body.maxFacesPerImage,
        minBoxWidthRatio: body.min_box_width_ratio ?? body.minBoxWidthRatio,
      });
      return ResponseUtil.success(req, res, result, 'common.SUCCESS', 200);
    } catch (err) {
      return ResponseUtil.error(req, res, 'common.ERROR', 500);
    }
  };

  /** 只重建「当前用户可见范围内」照片的人脸（普通用户可用，不碰别人的相册） */
  rescanFaces = async (req, res) => {
    try {
      const service = new FaceService(req.dbPhoto);
      const validPaths = await this._validPathsOf(req);
      const result = await service.rescanFaces({ validPaths });
      return ResponseUtil.success(req, res, result, 'common.SUCCESS', 200);
    } catch (err) {
      return ResponseUtil.error(req, res, 'common.ERROR', 500);
    }
  };

  /**
   * ⭐ 2026-10-16 P0-7 重扫两阶段：preview —— 只返回「将要发生什么」，**不写任何数据**。
   * 前端先展示差异（将移除多少脸 / 影响多少人物组 / 重跑多少张），用户确认后再调 /face/rescan。
   */
  previewRescanFaces = async (req, res) => {
    try {
      const service = new FaceService(req.dbPhoto);
      const validPaths = await this._validPathsOf(req);
      const result = await service.previewRescan({ validPaths });
      return ResponseUtil.success(req, res, result, 'common.SUCCESS', 200);
    } catch (err) {
      Logger.error('previewRescanFaces error', err);
      return ResponseUtil.error(req, res, 'common.ERROR', 500);
    }
  };

  /**
   * ⭐ 2026-10-16 P0-2 合影组合相册：按「同框人脸组合」聚合（只算当前用户可见范围）。
   */
  listPeerGroups = async (req, res) => {
    try {
      const service = new FaceService(req.dbPhoto);
      const validPaths = await this._validPathsOf(req);
      const body = req.body || {};
      const result = await service.listPeerGroups({
        validPaths,
        limit: body.limit,
        minFaces: body.min_faces ?? body.minFaces,
      });
      return ResponseUtil.success(req, res, result, 'common.SUCCESS', 200);
    } catch (err) {
      Logger.error('listPeerGroups error', err);
      return ResponseUtil.error(req, res, 'common.ERROR', 500);
    }
  };

  /**
   * ⭐ 2026-10-16 P0-5 人物关系图谱数据：共同出现次数（边）+ 人物节点。
   */
  listRelations = async (req, res) => {
    try {
      const service = new FaceService(req.dbPhoto);
      const validPaths = await this._validPathsOf(req);
      const body = req.body || {};
      const result = await service.listRelations({
        validPaths,
        limit: body.limit,
        minCount: body.min_count ?? body.minCount,
        focusFaceId: body.focus_face_id ?? body.focusFaceId,
      });
      return ResponseUtil.success(req, res, result, 'common.SUCCESS', 200);
    } catch (err) {
      Logger.error('listRelations error', err);
      return ResponseUtil.error(req, res, 'common.ERROR', 500);
    }
  };

  /**
   * ⭐ 2026-10-16 存量补扫：只把「已标记完成、但实际没有任何人脸行」的照片重新入队。
   * 与 /face/rescan 不同 —— 不清已有分组，只补跑被「烧掉」的照片（普通用户可用）。
   */
  rescanMissingFaces = async (req, res) => {
    try {
      const body = req.body || {};
      const service = new FaceService(req.dbPhoto);
      const validPaths = await this._validPathsOf(req);
      const result = await service.rescanMissingFaces({
        validPaths,
        dryRun: body.dry_run ?? body.dryRun,
      });
      return ResponseUtil.success(req, res, result, 'common.SUCCESS', 200);
    } catch (err) {
      Logger.error('rescanMissingFaces error', err);
      return ResponseUtil.error(req, res, 'common.ERROR', 500);
    }
  };

  /**
   * ⭐ 2026-10-16 全库「合并相似人物」（限超管）：一次性把分裂的碎片组归并。
   * 可传 dry_run 先预览要合并多少对。
   */
  mergeSimilarFaces = async (req, res) => {
    try {
      const body = req.body || {};
      const service = new FaceService(req.dbPhoto);
      const result = await service.mergeSimilarFaces({
        threshold: body.threshold,
        margin: body.margin,
        limit: body.limit,
        dryRun: body.dry_run ?? body.dryRun,
      });
      return ResponseUtil.success(req, res, result, 'common.SUCCESS', 200);
    } catch (err) {
      Logger.error('mergeSimilarFaces error', err);
      return ResponseUtil.error(req, res, 'common.ERROR', 500);
    }
  };

  resetFaces = async (req, res) => {
    try {
      const service = new FaceService(req.dbPhoto);
      const result = await service.resetFaceRecognition();
      return ResponseUtil.success(req, res, result, 'common.SUCCESS', 200);
    } catch (e) {
      const msgKey = e && e.message ? e.message : 'common.ERROR';
      const statusCode = e && e.statusCode ? Number(e.statusCode) : msgKey === 'common.NOT_FOUND' ? 404 : msgKey === 'common.PARAM_ERROR' ? 400 : 500;
      return ResponseUtil.error(req, res, msgKey, statusCode);
    }
  };

  faceImage = async (req, res) => {
    try {
      const body = req.body || {};
      const service = new FaceService(req.dbPhoto);
      const { buffer, mime } = await service.getFaceImageBuffer({
        faceId: body.face_id ?? body.faceId,
        fileHash: body.file_hash ?? body.fileHash,
        size: body.size,
        quality: body.quality,
      });
      res.set('Content-Type', mime || 'application/octet-stream');
      return res.send(buffer);
    } catch (e) {
      const msgKey = e && e.message ? e.message : 'common.ERROR';
      const statusCode = e && e.statusCode ? Number(e.statusCode) : msgKey === 'common.NOT_FOUND' ? 404 : msgKey === 'common.PARAM_ERROR' ? 400 : 500;
      return ResponseUtil.error(req, res, msgKey, statusCode);
    }
  };

  faceImageGet = async (req, res) => {
    try {
      const query = req.query || {};
      let validPaths;
      // 按归属隔离：所有用户（含管理员）都只能看到自己源目录下的照片。
      // 不要再加 isAdmin 例外 —— 隐私设计要求超管也只看自己的。
      if (req.user) {
        const validPathsRaw = await photoTimeLineService.getValidPaths(req.user);
        validPaths = (validPathsRaw || []).map(p => (p ? String(p) : '')).filter(Boolean);
      }
      const service = new FaceService(req.dbPhoto);
      const { buffer, mime } = await service.getFaceImageBuffer({
        faceId: query.face_id ?? query.faceId,
        fileHash: query.file_hash ?? query.fileHash,
        size: query.size,
        quality: query.quality,
        ...(validPaths !== undefined ? { validPaths } : {}),
      });
      res.set('Content-Type', mime || 'application/octet-stream');
      return res.send(buffer);
    } catch (e) {
      const msgKey = e && e.message ? e.message : 'common.ERROR';
      const statusCode = e && e.statusCode ? Number(e.statusCode) : msgKey === 'common.NOT_FOUND' ? 404 : msgKey === 'common.PARAM_ERROR' ? 400 : 500;
      return ResponseUtil.error(req, res, msgKey, statusCode);
    }
  };

  listPhotoFaces = async (req, res) => {
    try {
      const body = req.body || {};
      let validPaths;
      // 按归属隔离：所有用户（含管理员）都只能看到自己源目录下的照片。
      // 不要再加 isAdmin 例外 —— 隐私设计要求超管也只看自己的。
      if (req.user) {
        const validPathsRaw = await photoTimeLineService.getValidPaths(req.user);
        validPaths = (validPathsRaw || []).map(p => (p ? String(p) : '')).filter(Boolean);
      }
      const service = new FaceService(req.dbPhoto);
      const items = await service.listPhotoFaces({
        fileHash: body.file_hash ?? body.fileHash,
        ...(validPaths !== undefined ? { validPaths } : {}),
      });
      return ResponseUtil.success(req, res, { items }, 'common.SUCCESS', 200);
    } catch (e) {
      const msgKey = e && e.message ? e.message : 'common.ERROR';
      const statusCode = e && e.statusCode ? Number(e.statusCode) : msgKey === 'common.NOT_FOUND' ? 404 : msgKey === 'common.PARAM_ERROR' ? 400 : 500;
      return ResponseUtil.error(req, res, msgKey, statusCode);
    }
  };

  removePhotoFromFace = async (req, res) => {
    try {
      const body = req.body || {};
      const service = new FaceService(req.dbPhoto);
      const result = await service.removePhotoFromFace({
        faceId: body.face_id ?? body.faceId,
        fileHash: body.file_hash ?? body.fileHash,
        validPaths: await this._validPathsOf(req),
      });
      // ⭐ 2026-10-19 移出即重识别：该图已被重新置为 gen_faces=0，
      // 但 faceWorker 可能已因队列取空而退出（退出后只在 15s 内查一次 pending），
      // 这里主动拉一次；已在跑 / 已暂停 / 开关关掉就什么都不做。
      try {
        const workers = require('../../../../initHandler/workers');
        const { getSingletonWorkerManager } = require('../../../../workers/singletonWorkerManager');
        const mgr = getSingletonWorkerManager();
        const running = !!(mgr && typeof mgr.isWorkerRunning === 'function' && mgr.isWorkerRunning('faceWorker'));
        const paused = !!(mgr && typeof mgr.isAiPaused === 'function' && mgr.isAiPaused());
        if (!running && !paused && workers && typeof workers.startFaceWorker === 'function') {
          const enabled = typeof workers.isAiWorkerEnabled === 'function'
            ? await workers.isAiWorkerEnabled('ai_face_enable')
            : true;
          if (enabled) workers.startFaceWorker();
        }
      } catch (_) {}
      return ResponseUtil.success(req, res, result, 'common.SUCCESS', 200);
    } catch (e) {
      const msgKey = e && e.message ? e.message : 'common.ERROR';
      const statusCode = e && e.statusCode ? Number(e.statusCode) : msgKey === 'common.NOT_FOUND' ? 404 : msgKey === 'common.PARAM_ERROR' ? 400 : 500;
      return ResponseUtil.error(req, res, msgKey, statusCode);
    }
  };

  movePhotoToFace = async (req, res) => {
    try {
      const body = req.body || {};
      const service = new FaceService(req.dbPhoto);
      const result = await service.movePhotoToFace({
        fromFaceId: body.from_face_id ?? body.fromFaceId,
        toFaceId: body.to_face_id ?? body.toFaceId,
        fileHashes: body.file_hashes ?? body.fileHashes,
      });
      return ResponseUtil.success(req, res, result, 'common.SUCCESS', 200);
    } catch (e) {
      const msgKey = e && e.message ? e.message : 'common.ERROR';
      const statusCode = e && e.statusCode ? Number(e.statusCode) : msgKey === 'common.NOT_FOUND' ? 404 : msgKey === 'common.PARAM_ERROR' ? 400 : 500;
      return ResponseUtil.error(req, res, msgKey, statusCode);
    }
  };

  downloadFacePhotos = async (req, res) => {
    try {
      const query = req.query || {};
      const body = req.body || {};

      const raw = query.face_ids ?? query.faceIds ?? query.face_id ?? query.faceId ?? body.face_ids ?? body.faceIds ?? body.face_id ?? body.faceId;

      const validPathsRaw = await photoTimeLineService.getValidPaths(req.user);
      const validPathsForQuery = (validPathsRaw || []).map(p => (p ? String(p) : '')).filter(Boolean);
      const validPaths = validPathsForQuery.map(p => path.resolve(String(p)));

      const service = new FaceService(req.dbPhoto);
      const rows = await service.listFacePhotoIndexRows({ faceIds: raw, validPaths: validPathsForQuery });

      const isUnder = (filePath, dirPath) => {
        const fileResolved = path.resolve(String(filePath || ''));
        const dirResolved = path.resolve(String(dirPath || ''));
        if (!fileResolved || !dirResolved) return false;
        if (fileResolved === dirResolved) return true;
        const prefix = dirResolved.endsWith(path.sep) ? dirResolved : dirResolved + path.sep;
        return fileResolved.startsWith(prefix);
      };

      const filtered = [];
      const seen = new Set();

      for (const r of rows) {
        const p = r && r.path ? String(r.path) : '';
        const filename = r && r.filename ? String(r.filename) : '';
        if (!p || !filename) continue;
        const fullPath = path.join(p, filename);
        const normalizedFullPath = path.resolve(fullPath);
        if (seen.has(normalizedFullPath)) continue;
        if (validPaths.length > 0 && !validPaths.some(vp => isUnder(normalizedFullPath, vp))) {
          continue;
        }
        try {
          const st = await fs.promises.stat(normalizedFullPath);
          if (!st.isFile()) continue;
        } catch (_) {
          continue;
        }
        seen.add(normalizedFullPath);
        filtered.push({
          fullPath: normalizedFullPath,
          filename,
          photoId: Number(r && r.photo_id ? r.photo_id : 0) || 0,
        });
      }

      if (filtered.length === 0) {
        return ResponseUtil.error(req, res, 'auth.PERMISSION_DENIED', 403);
      }

      const faceIds = [];
      const rawFaceIds = Array.isArray(raw) ? raw : raw === null || raw === undefined ? [] : [raw];
      for (const v of rawFaceIds) {
        if (v === null || v === undefined || v === '') continue;
        if (typeof v === 'string' && v.includes(',')) {
          for (const part of v.split(',')) {
            const id = Number(part);
            if (Number.isFinite(id) && id > 0) faceIds.push(id);
          }
          continue;
        }
        const id = Number(v);
        if (Number.isFinite(id) && id > 0) faceIds.push(id);
      }
      const uniqueFaceIds = [...new Set(faceIds)];

      const filenameFromParams = req.params && req.params.filename ? String(req.params.filename) : '';
      const zipName = filenameFromParams || (uniqueFaceIds.length === 1 ? `face_${uniqueFaceIds[0]}.zip` : `faces_${uniqueFaceIds.length}.zip`);

      const archive = archiver('zip', { zlib: { level: 1 } });
      res.attachment(zipName);

      let stopped = false;
      const stop = err => {
        if (stopped) return;
        stopped = true;
        try {
          archive.abort();
        } catch (_) {}
        Logger.error('Archive error', err);
        if (!res.headersSent) {
          res.status(500).send({ error: err && err.message ? err.message : 'Archive error' });
          return;
        }
        res.destroy(err instanceof Error ? err : new Error('Archive error'));
      };
      archive.on('error', stop);
      res.on('error', stop);
      res.on('close', () => {
        if (stopped) return;
        stopped = true;
        try {
          archive.abort();
        } catch (_) {}
      });

      archive.pipe(res);

      const usedNames = new Set();

      for (const item of filtered) {
        const base = path.basename(item.filename || item.fullPath);
        let entryName = base || 'photo';
        if (usedNames.has(entryName)) {
          const pid = item.photoId > 0 ? String(item.photoId) : 'dup';
          entryName = `${pid}_${entryName}`;
        }
        let i = 1;
        while (usedNames.has(entryName)) {
          const pid = item.photoId > 0 ? String(item.photoId) : 'dup';
          entryName = `${pid}_${i}_${base}`;
          i += 1;
        }
        usedNames.add(entryName);
        archive.file(item.fullPath, { name: entryName });
      }

      await archive.finalize();
    } catch (err) {
      Logger.error('Face download error', err);
      if (!res.headersSent) {
        return ResponseUtil.error(req, res, 'common.ERROR', 500);
      }
      res.destroy(err instanceof Error ? err : new Error('Face download error'));
    }
  };
  /**
   * 人脸聚类参数（2026-10-13）：AI 设置页可调，改完点「重新聚类」生效。
   * - simThresh：基础匹配阈值，越大越严格（不同人更不容易被并到一起，同人也更容易裂开）
   * - minQuality：入库最低质量，越大越能挡住模糊/侧脸/误检
   * - secondMergeThresh：二次合并阈值，越大越不容易在维护阶段把不同人再并到一起
   */
  getFaceTuning = async (req, res) => {
    try {
      const readNum = async (key, def) => {
        try {
          const raw = await tableConfig.getConfigByKey(key);
          const n = Number(raw);
          return raw === null || raw === undefined || raw === '' || !Number.isFinite(n) ? def : n;
        } catch (_) {
          return def;
        }
      };
      const simThresh = await readNum('ai_face_sim_thresh', FACE_TUNING_DEFAULTS.simThresh);
      const minQuality = await readNum('ai_face_min_quality', FACE_TUNING_DEFAULTS.minQuality);
      const secondMergeThresh = await readNum(
        'ai_face_second_merge_thresh',
        FACE_TUNING_DEFAULTS.secondMergeThresh
      );
      const threads = await readNum('ai_face_threads', FACE_TUNING_DEFAULTS.threads);
      const namedExtraReq = await readNum('ai_face_named_extra_req', FACE_TUNING_DEFAULTS.namedExtraReq);
      return ResponseUtil.success(
        req,
        res,
        { simThresh, minQuality, secondMergeThresh, threads, namedExtraReq, range: FACE_TUNING_RANGE },
        'common.SUCCESS',
        200
      );
    } catch (err) {
      return ResponseUtil.error(req, res, 'common.ERROR', 500);
    }
  };

  setFaceTuning = async (req, res) => {
    try {
      const body = (req && req.body) || {};
      const clampTo = (v, def, range) => {
        const n = Number(v);
        if (!Number.isFinite(n)) return def;
        return Math.max(range[0], Math.min(range[1], n));
      };
      const simThresh = clampTo(body.simThresh, FACE_TUNING_DEFAULTS.simThresh, FACE_TUNING_RANGE.simThresh);
      const minQuality = clampTo(body.minQuality, FACE_TUNING_DEFAULTS.minQuality, FACE_TUNING_RANGE.minQuality);
      const secondMergeThresh = clampTo(
        body.secondMergeThresh,
        FACE_TUNING_DEFAULTS.secondMergeThresh,
        FACE_TUNING_RANGE.secondMergeThresh
      );
      const threads = clampTo(body.threads, FACE_TUNING_DEFAULTS.threads, FACE_TUNING_RANGE.threads);
      const namedExtraReq = clampTo(body.namedExtraReq, FACE_TUNING_DEFAULTS.namedExtraReq, FACE_TUNING_RANGE.namedExtraReq);

      // 线程数变化需要重启识别进程才生效（worker 启动时读一次）
      let prevThreads = FACE_TUNING_DEFAULTS.threads;
      try {
        const rawPrev = await tableConfig.getConfigByKey('ai_face_threads');
        const nPrev = Number(rawPrev);
        if (rawPrev !== null && rawPrev !== undefined && rawPrev !== '' && Number.isFinite(nPrev)) {
          prevThreads = nPrev;
        }
      } catch (_) {}

      await tableConfig.setConfigByKey('ai_face_sim_thresh', String(simThresh));
      await tableConfig.setConfigByKey('ai_face_min_quality', String(minQuality));
      await tableConfig.setConfigByKey('ai_face_second_merge_thresh', String(secondMergeThresh));
      await tableConfig.setConfigByKey('ai_face_threads', String(threads));
      await tableConfig.setConfigByKey('ai_face_named_extra_req', String(namedExtraReq));

      // 线程数改了 ⇒ 重启人脸 worker（停旧起新；识别任务会自动继续）
      const threadsChanged = Math.floor(prevThreads) !== Math.floor(threads);
      if (threadsChanged && process.send) {
        try {
          process.send({ type: 'toggleAiFace', data: { enable: 0 } });
          setTimeout(() => {
            try {
              process.send({ type: 'toggleAiFace', data: { enable: 1 } });
            } catch (_) {}
          }, 1500);
        } catch (_) {}
      }

      return ResponseUtil.success(
        req,
        res,
        { simThresh, minQuality, secondMergeThresh, threads, namedExtraReq, range: FACE_TUNING_RANGE, restarted: threadsChanged },
        'common.SUCCESS',
        200
      );
    } catch (err) {
      return ResponseUtil.error(req, res, 'common.ERROR', 500);
    }
  };

}

module.exports = new FaceController();
