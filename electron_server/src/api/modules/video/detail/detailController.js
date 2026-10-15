const ResponseUtil = require('../../../apiUtils/responseUtil');
const VideoDetailService = require('./detailService');
const fs = require('fs');
const path = require('path');
const { isWithinAllowPath } = require('../../../../utils/permissionUtil');
const userUtil = require('../../../../utils/userUtil');
const VideoSourceService = require('../source/videoSourceService');
const { applyVisibleIndexFilter } = require('../videoVisibilityUtil');

class VideoDetailController {
  /**
   * 路径级鉴权：按 video_index 记录的源目录判断当前用户是否有权访问。
   * 详情/剧集/播放信息/光盘内容都会返回绝对文件路径与 NFO 元数据，
   * index_id 是自增整数可枚举，不校验的话知道 id 即可越权读取无权目录的媒体信息。
   *
   * ⭐ 可见性口径与**列表页完全一致**（共用 `videoVisibilityUtil.applyVisibleIndexFilter`）。
   * 以前这里走 `permissionUtil.hasPermission`：单向下沉匹配 + 只用 `row.path`，
   * 导致子账号「列表能看、点详情 403」的两种典型情形：
   *   ① 授权到子目录（授权 `…\TV\BreakingBad`、来源 `…\TV`）⇒ 列表靠「目录行特判」显示，
   *      详情拿 `path=…\TV` 去比对 `startsWith('…\BreakingBad\')` 为 false；
   *   ② 裸前缀兄弟目录（授权 `E:\Media`、来源 `E:\Media2`）⇒ 列表裸双向 startsWith 通过，
   *      详情带分隔符边界的单向下沉不通过。
   *
   * ⚠️ 必须是箭头函数属性，不能写成普通 async 方法。
   * 路由里以 `router.get('/detail', authenticateJWT, controller.getDetail)` 的形式
   * 把方法引用直接交给 Express，若框架/包装层在派发时丢掉了 `this`，
   * 普通方法体内的 `this._ensureIndexAccess` 会抛
   * "Cannot read properties of undefined"，导致详情/剧集/播放信息/光盘内容全部 500。
   * 箭头函数的 this 来自词法作用域（类定义处），与调用方式无关，天然免疫。
   */
  _ensureIndexAccess = async (req, indexId) => {
    const id = Number(indexId);
    if (!Number.isFinite(id) || id <= 0) {
      return { ok: false, statusCode: 400, message: 'common.PARAM_ERROR' };
    }
    const row = await req.dbVideo('video_index').where({ id }).first('id', 'path').catch(() => null);
    if (!row) {
      return { ok: false, statusCode: 404, message: 'common.NOT_FOUND' };
    }

    // ① scoped token 的 allow_path 安全边界（单向下沉，只在该令牌设置时才生效）。
    //    普通登录用户没有 allow_path，这里恒为 true，行为与原实现一致。
    if (!isWithinAllowPath(req.user, row.path ? String(row.path) : '')) {
      return { ok: false, statusCode: 403, message: 'auth.PERMISSION_DENIED' };
    }

    // ② 管理员/超管直接放行（与原 hasPermission 的超管短路一致，
    //    也避免「来源表为空导致管理员自己也 403」这种误伤）。
    if (userUtil.isAdmin(req.user)) {
      return { ok: true };
    }

    // ③ 普通用户：走与列表页同一套可见路径 + 可见性条件
    let validPaths = [];
    try {
      validPaths = await new VideoSourceService(req.dbVideo).getValidPaths(req.user);
    } catch (_) {
      validPaths = [];
    }
    if (!Array.isArray(validPaths) || validPaths.length === 0) {
      return { ok: false, statusCode: 403, message: 'auth.PERMISSION_DENIED' };
    }

    const visible = await applyVisibleIndexFilter(req.dbVideo('video_index').where('id', id), validPaths)
      .first('id')
      .catch(() => null);
    if (!visible) {
      return { ok: false, statusCode: 403, message: 'auth.PERMISSION_DENIED' };
    }

    return { ok: true };
  };

  getDetail = async (req, res) => {
    try {
      const uid = req.user && req.user.id ? Number(req.user.id) : 0;
      if (!uid) return ResponseUtil.unauthorized(req, res);

      const q = req.query || {};
      const indexId = Number(q.index_id ?? q.indexId ?? 0) || 0;
      const guard = await this._ensureIndexAccess(req, indexId);
      if (!guard.ok) return ResponseUtil.error(req, res, guard.message, guard.statusCode);

      const service = new VideoDetailService(req.dbVideo);
      const data = await service.getDetail({ uid, indexId });
      return ResponseUtil.success(req, res, data, 'common.SUCCESS', 200);
    } catch (e) {
      const msgKey = e && e.message ? e.message : 'common.ERROR';
      const statusCode = e && e.statusCode ? Number(e.statusCode) : 500;
      return ResponseUtil.error(req, res, msgKey, statusCode);
    }
  };

  getEpisodes = async (req, res) => {
    try {
      const uid = req.user && req.user.id ? Number(req.user.id) : 0;
      if (!uid) return ResponseUtil.unauthorized(req, res);

      const q = req.query || {};
      const indexId = Number(q.index_id ?? q.indexId ?? 0) || 0;
      const page = Number(q.page ?? 1) || 1;
      const pageSize = Number(q.page_size ?? q.pageSize ?? 50) || 50;
      const sortOrder = String(q.sort_order ?? q.sortOrder ?? 'asc');

      const guard = await this._ensureIndexAccess(req, indexId);
      if (!guard.ok) return ResponseUtil.error(req, res, guard.message, guard.statusCode);

      const service = new VideoDetailService(req.dbVideo);
      const data = await service.getEpisodesPaged({
        indexId,
        page,
        pageSize,
        sortOrder,
      });
      return ResponseUtil.success(req, res, data, 'common.SUCCESS', 200);
    } catch (e) {
      const msgKey = e && e.message ? e.message : 'common.ERROR';
      const statusCode = e && e.statusCode ? Number(e.statusCode) : 500;
      return ResponseUtil.error(req, res, msgKey, statusCode);
    }
  };

  getTvPlayInfo = async (req, res) => {
    try {
      const uid = req.user && req.user.id ? Number(req.user.id) : 0;
      if (!uid) return ResponseUtil.unauthorized(req, res);

      const q = req.query || {};
      const indexId = Number(q.index_id ?? q.indexId ?? 0) || 0;

      const guard = await this._ensureIndexAccess(req, indexId);
      if (!guard.ok) return ResponseUtil.error(req, res, guard.message, guard.statusCode);

      const service = new VideoDetailService(req.dbVideo);
      const data = await service.getTvPlayInfo({ uid, indexId });
      return ResponseUtil.success(req, res, data, 'common.SUCCESS', 200);
    } catch (e) {
      const msgKey = e && e.message ? e.message : 'common.ERROR';
      const statusCode = e && e.statusCode ? Number(e.statusCode) : 500;
      return ResponseUtil.error(req, res, msgKey, statusCode);
    }
  };

  getDiscContents = async (req, res) => {
    try {
      const uid = req.user && req.user.id ? Number(req.user.id) : 0;
      if (!uid) return ResponseUtil.unauthorized(req, res);

      const q = req.query || {};
      const indexId = Number(q.index_id ?? q.indexId ?? 0) || 0;

      const guard = await this._ensureIndexAccess(req, indexId);
      if (!guard.ok) return ResponseUtil.error(req, res, guard.message, guard.statusCode);

      const service = new VideoDetailService(req.dbVideo);
      const data = await service.getDiscContents({ indexId });
      return ResponseUtil.success(req, res, data, 'common.SUCCESS', 200);
    } catch (e) {
      const msgKey = e && e.message ? e.message : 'common.ERROR';
      const statusCode = e && e.statusCode ? Number(e.statusCode) : 500;
      return ResponseUtil.error(req, res, msgKey, statusCode);
    }
  };

  getDiscContentThumb = async (req, res) => {
    try {
      const uid = req.user && req.user.id ? Number(req.user.id) : 0;
      if (!uid) return res.status(401).end();

      const q = req.query || {};
      const indexId = Number(q.index_id ?? q.indexId ?? 0) || 0;
      const internalPath = String(q.internal_path ?? q.internalPath ?? '').trim();
      const size = Math.max(1, Number(q.size ?? 320) || 320);

      const guard = await this._ensureIndexAccess(req, indexId);
      if (!guard.ok) return res.status(guard.statusCode || 403).end();

      const service = new VideoDetailService(req.dbVideo);
      const tinyPath = await service.getDiscContentThumbPath({
        indexId,
        internalPath,
        size,
      });
      if (!tinyPath) return res.status(404).end();

      res.set('Content-Type', 'image/webp');
      return res.sendFile(tinyPath);
    } catch (_) {
      return res.status(404).end();
    }
  };

  async setOpenSkip(req, res) {
    try {
      const uid = req.user && req.user.id ? Number(req.user.id) : 0;
      if (!uid) return ResponseUtil.unauthorized(req, res);

      const body = req.body || {};
      const indexId = Number(body.index_id ?? body.indexId ?? 0) || 0;
      const openSkipStartSec = body.open_skip_start_sec ?? body.openSkipStartSec ?? 0;
      const openSkipEndSec = body.open_skip_end_sec ?? body.openSkipEndSec ?? 0;

      const service = new VideoDetailService(req.dbVideo);
      const data = await service.setOpenSkip({
        indexId,
        openSkipStartSec,
        openSkipEndSec,
      });
      return ResponseUtil.success(req, res, data, 'common.SUCCESS', 200);
    } catch (e) {
      const msgKey = e && e.message ? e.message : 'common.ERROR';
      const statusCode = e && e.statusCode ? Number(e.statusCode) : 500;
      return ResponseUtil.error(req, res, msgKey, statusCode);
    }
  }

  async getPersonImage(req, res) {
    try {
      const uid = req.user && req.user.id ? Number(req.user.id) : 0;
      if (!uid) return res.status(401).end();

      const q = req.query || {};
      let tmdbId = String(q.tmdb_id ?? q.tmdbId ?? '').trim();
      const indexId = Number(q.index_id ?? q.indexId ?? 0) || 0;
      const name = String(q.name ?? '').trim();
      let thumb = String(q.thumb ?? '').trim();

      const size = 500;

      const service = new VideoDetailService(req.dbVideo);

      // ⭐ 日本片演员没有 tmdbId：客户端只给 index_id + 演员名，
      //    这里从索引里把 NFO 记的 thumb（Jellyfin 生成的本地头像路径，
      //    或我们刮削时抓到的站点头像 URL）取出来，再决定是直接读本地文件还是下载。
      if (indexId > 0 && name && (!thumb || !tmdbId)) {
        const guard = await this._ensureIndexAccess(req, indexId);
        if (!guard.ok) return res.status(guard.statusCode || 403).end();
        const found = await service.findPersonMetaInIndex({ indexId, name });
        if (found) {
          if (!thumb && found.thumb) thumb = found.thumb;
          if (!tmdbId && found.tmdbId) tmdbId = found.tmdbId;
        }
      }

      if (!tmdbId && !thumb) return res.status(400).end();

      const info = await service.getPersonJpegCacheInfo({
        tmdbId,
        size,
        thumbUrl: thumb,
      });
      if (!info || !info.filePath) return res.status(404).end();

      const filePath = String(info.filePath || '').trim();
      const url = String(info.url || '').trim();
      if (!filePath) return res.status(404).end();

      if (info.exists) {
        // 本地 Jellyfin 头像可能是 png/webp，按扩展名给对 Content-Type，
        // 否则客户端会按 jpeg 解码失败、退回占位图。
        const ext = path.extname(filePath).toLowerCase();
        const mime = ext === '.png'
          ? 'image/png'
          : ext === '.webp'
            ? 'image/webp'
            : ext === '.gif'
              ? 'image/gif'
              : 'image/jpeg';
        res.set('Content-Type', mime);
        return res.sendFile(filePath);
      }

      if (!url) return res.status(404).end();
      try {
        if (typeof process.send === 'function') {
          process.send({ type: 'downloadUrlToFile', data: { url, targetPath: filePath, timeoutMs: 30000, allowProxy: true } });
        }
      } catch (_) {}

      res.set('Content-Type', 'image/jpeg');
      const deadlineAt = Date.now() + 15000;
      while (Date.now() < deadlineAt) {
        if (req.aborted) return;
        try {
          const st = await fs.promises.stat(filePath);
          if (st && st.isFile() && Number(st.size || 0) > 0) {
            return res.sendFile(filePath);
          }
        } catch (_) {}
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      return res.status(404).end();
    } catch (_) {
      return res.status(404).end();
    }
  }

  async getPosterImage(req, res) {
    try {
      const uid = req.user && req.user.id ? Number(req.user.id) : 0;
      if (!uid) return res.status(401).end();

      const q = req.query || {};
      const tmdbId = String(q.tmdb_id ?? q.tmdbId ?? '').trim();
      const mediaType = String(q.media_type ?? q.mediaType ?? '')
        .trim()
        .toLowerCase();
      if (!tmdbId) return res.status(400).end();
      if (mediaType !== 'movie' && mediaType !== 'tv') return res.status(400).end();

      const size = Math.max(1, Number(q.size ?? 342) || 342);
      const thumb = String(q.thumb ?? '').trim();

      const service = new VideoDetailService(req.dbVideo);
      const info = await service.getPosterJpegCacheInfo({
        tmdbId,
        mediaType,
        size,
        thumbUrl: thumb,
      });
      if (!info || !info.filePath) return res.status(404).end();

      const filePath = String(info.filePath || '').trim();
      const url = String(info.url || '').trim();
      if (!filePath) return res.status(404).end();

      if (info.exists) {
        res.set('Content-Type', 'image/jpeg');
        return res.sendFile(filePath);
      }

      if (!url) return res.status(404).end();
      try {
        await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
      } catch (_) {}

      try {
        if (typeof process.send === 'function') {
          process.send({ type: 'downloadUrlToFile', data: { url, targetPath: filePath, timeoutMs: 30000, allowProxy: true } });
        }
      } catch (_) {}

      res.set('Content-Type', 'image/jpeg');
      const deadlineAt = Date.now() + 15000;
      while (Date.now() < deadlineAt) {
        if (req.aborted) return;
        try {
          const st = await fs.promises.stat(filePath);
          if (st && st.isFile() && Number(st.size || 0) > 0) {
            return res.sendFile(filePath);
          }
        } catch (_) {}
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      return res.status(404).end();
    } catch (_) {
      return res.status(404).end();
    }
  }
}

module.exports = new VideoDetailController();
