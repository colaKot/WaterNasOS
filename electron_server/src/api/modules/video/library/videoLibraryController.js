const ResponseUtil = require('../../../apiUtils/responseUtil');
const VideoLibraryService = require('./videoLibraryService');

class VideoLibraryController {
  /**
   * 影视库列表（所有登录用户可读，左侧栏需要）
   * 返回每个库的条目统计
   */
  async listLibraries(req, res) {
    try {
      const service = new VideoLibraryService(req.dbVideo);
      const list = await service.listLibrariesWithCounts(req.user);
      return ResponseUtil.success(req, res, list, 'video.VIDEO_LIBRARY_LIST_SUCCESS', 200);
    } catch (err) {
      return ResponseUtil.error(req, res, 'video.VIDEO_LIBRARY_LIST_FAILED', 500);
    }
  }

  /**
   * 切换「日本电影库」（超级管理员）
   * params: id
   * body: { jp_movie: 0 | 1 }
   * 开启后：列表页显示「中 / 无码」徽章，并开放对应筛选
   */
  async setJpMovie(req, res) {
    try {
      const service = new VideoLibraryService(req.dbVideo);
      const id = req.params && req.params.id;
      const row = await service.setJpMovie(id, req.body || {});
      return ResponseUtil.success(req, res, row, 'video.VIDEO_LIBRARY_UPDATE_SUCCESS', 200);
    } catch (err) {
      const msgKey = err && err.message ? err.message : 'common.ERROR';
      const statusCode = msgKey === 'common.NOT_FOUND' ? 404 : 400;
      return ResponseUtil.error(req, res, msgKey, statusCode);
    }
  }

  /**
   * 重排影视库顺序（管理员）
   * body: { ids: number[] } —— 客户端拖出来的完整顺序
   */
  async reorderLibraries(req, res) {
    try {
      const service = new VideoLibraryService(req.dbVideo);
      const body = req.body || {};
      const ids = body.ids ?? body.libraryIds ?? body.library_ids;
      const ordered = await service.reorderLibraries(ids);
      return ResponseUtil.success(req, res, { ids: ordered }, 'video.VIDEO_LIBRARY_UPDATE_SUCCESS', 200);
    } catch (err) {
      const msgKey = err && err.message ? err.message : 'common.ERROR';
      return ResponseUtil.error(req, res, msgKey, 400);
    }
  }

  /**
   * 新建影视库（管理员）
   * body: { name: string, lib_type: "movie" | "tv" | "image" | "mixed" }
   */
  async addLibrary(req, res) {
    try {
      const service = new VideoLibraryService(req.dbVideo);
      const row = await service.addLibrary(req.body || {});
      return ResponseUtil.success(req, res, row, 'video.VIDEO_LIBRARY_ADD_SUCCESS', 201);
    } catch (err) {
      const msgKey = err && err.message ? err.message : 'common.ERROR';
      const statusCode = msgKey === 'video.VIDEO_LIBRARY_NAME_EXISTS' ? 409 : 400;
      return ResponseUtil.error(req, res, msgKey, statusCode);
    }
  }

  /**
   * 重命名影视库（管理员）
   * 类型创建后不可修改，此接口只改名字
   * params: id
   * body: { name: string }
   */
  async renameLibrary(req, res) {
    try {
      const service = new VideoLibraryService(req.dbVideo);
      const id = req.params && req.params.id;
      const row = await service.renameLibrary(id, req.body || {});
      return ResponseUtil.success(req, res, row, 'video.VIDEO_LIBRARY_UPDATE_SUCCESS', 200);
    } catch (err) {
      const msgKey = err && err.message ? err.message : 'common.ERROR';
      const statusCode = msgKey === 'common.NOT_FOUND' ? 404 : msgKey === 'video.VIDEO_LIBRARY_NAME_EXISTS' ? 409 : 400;
      return ResponseUtil.error(req, res, msgKey, statusCode);
    }
  }

  /**
   * 切换「是否在主页显示该库分类」（管理员）
   * params: id
   * body: { show_in_home: 0 | 1 }
   */
  async setShowInHome(req, res) {
    try {
      const service = new VideoLibraryService(req.dbVideo);
      const id = req.params && req.params.id;
      const row = await service.setShowInHome(id, req.body || {});
      return ResponseUtil.success(req, res, row, 'video.VIDEO_LIBRARY_UPDATE_SUCCESS', 200);
    } catch (err) {
      const msgKey = err && err.message ? err.message : 'common.ERROR';
      const statusCode = msgKey === 'common.NOT_FOUND' ? 404 : 400;
      return ResponseUtil.error(req, res, msgKey, statusCode);
    }
  }

  /**
   * 切换「音频响度归一化」（管理员）
   * params: id
   * body: { audio_normalize: 0 | 1 }
   * 开启后：扫描/重扫该库时测量音频响度；已有文件在开启后会立即启动补齐测量
   */
  async setAudioNormalize(req, res) {
    try {
      const service = new VideoLibraryService(req.dbVideo);
      const id = req.params && req.params.id;
      const row = await service.setAudioNormalize(id, req.body || {});
      const enabled = Number(row && row.audio_normalize) === 1;
      // 开启时通知主进程启动响度测量进程，补齐该库已入库文件的测量值
      if (enabled && typeof process.send === 'function') {
        try {
          process.send({ type: 'startVideoLoudnessWorker' });
        } catch (_) {}
      }
      return ResponseUtil.success(req, res, row, 'video.VIDEO_LIBRARY_UPDATE_SUCCESS', 200);
    } catch (err) {
      const msgKey = err && err.message ? err.message : 'common.ERROR';
      const statusCode = msgKey === 'common.NOT_FOUND' ? 404 : 400;
      return ResponseUtil.error(req, res, msgKey, statusCode);
    }
  }

  /**
   * 删除影视库（管理员）
   * 内置库不可删除；库内仍有来源时拒绝删除
   * params: id
   */
  async deleteLibrary(req, res) {
    try {
      const service = new VideoLibraryService(req.dbVideo);
      const id = req.params && req.params.id;
      const result = await service.deleteLibrary(id);
      return ResponseUtil.success(req, res, result, 'video.VIDEO_LIBRARY_DELETE_SUCCESS', 200);
    } catch (err) {
      const msgKey = err && err.message ? err.message : 'common.ERROR';
      const statusCode = msgKey === 'common.NOT_FOUND' ? 404 : 400;
      return ResponseUtil.error(req, res, msgKey, statusCode);
    }
  }
}

module.exports = new VideoLibraryController();
