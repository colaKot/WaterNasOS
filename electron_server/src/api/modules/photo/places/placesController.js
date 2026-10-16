const ResponseUtil = require('../../../apiUtils/responseUtil');
const Logger = require('../../../../utils/logger');
const PlacesService = require('./placesService');
const { getUserLanguage } = require('../../../../utils/i18nUtil');
const tableConfig = require('../../../../db/table/tableConfig');
const photoTimeLineService = require('../timeline/photoTimeLineService');
const userUtil = require('../../../../utils/userUtil');

async function getEnableByKey(key) {
  try {
    const raw = await tableConfig.getConfigByKey(key);
    return raw === '1' ? 1 : 0;
  } catch (_) {
    return 0;
  }
}

class PlacesController {
  async listPlaces(req, res) {
    try {
      const placeEnable = await getEnableByKey('ai_place_enable');
      if (placeEnable !== 1) {
        return ResponseUtil.success(
          req,
          res,
          {
            placeEnable,
            items: [],
            pagination: { total: 0, page: 1, pageSize: 0 },
          },
          'common.SUCCESS',
          200
        );
      }
      const locale = getUserLanguage(req);
      let validPaths;
      // 按归属隔离：所有用户（含管理员）都只能看到自己源目录下的照片。
      // 不要再加 isAdmin 例外 —— 隐私设计要求超管也只看自己的。
      if (req.user) {
        const validPathsRaw = await photoTimeLineService.getValidPaths(req.user);
        validPaths = (validPathsRaw || []).map(p => (p ? String(p) : '')).filter(Boolean);
      }
      const service = new PlacesService(req.dbPhoto);
      const result = await service.listPlaces({ ...(req.body || {}), locale, ...(validPaths !== undefined ? { validPaths } : {}) });
      return ResponseUtil.success(req, res, { placeEnable, ...result }, 'common.SUCCESS', 200);
    } catch (error) {
      Logger.error('listPlaces error:', error);
      const statusCode = error.statusCode || 500;
      return ResponseUtil.error(req, res, error.message || 'common.ERROR', statusCode);
    }
  }

  async setPlaceStatus(req, res) {
    try {
      const service = new PlacesService(req.dbPhoto);
      const result = await service.updatePlaceStatus(req.body || {});
      return ResponseUtil.success(req, res, result, 'common.SUCCESS', 200);
    } catch (e) {
      Logger.error('setPlaceStatus error:', e);
      const msgKey = e && e.message ? e.message : 'common.ERROR';
      const statusCode = e && e.statusCode ? Number(e.statusCode) : msgKey === 'common.NOT_FOUND' ? 404 : msgKey === 'common.PARAM_ERROR' ? 400 : 500;
      return ResponseUtil.error(req, res, msgKey, statusCode);
    }
  }

  /**
   * ⭐ 2026-10-14 场景语义搜索入口：支持「夕阳下的海滩」这类自然语言查询。
   * ⚠️ 路由是裸引用注册（router.post('/x', ctrl.m)），派发时 this 是 undefined，
   *    所以本方法内一律不能用 this。
   */
  async searchPlaces(req, res) {
    try {
      const placeEnable = await getEnableByKey('ai_place_enable');
      const locale = getUserLanguage(req);
      let validPaths;
      // 可见性按归属隔离：与 listPlaces 同一口径，不加 isAdmin 例外。
      if (req.user) {
        const validPathsRaw = await photoTimeLineService.getValidPaths(req.user);
        validPaths = (validPathsRaw || []).map(p => (p ? String(p) : '')).filter(Boolean);
      }
      const service = new PlacesService(req.dbPhoto);
      const body = req.body || {};
      const query = body.query !== undefined ? body.query : body.keyword;
      const result = await service.searchPlaces({
        ...body,
        query,
        locale,
        ...(validPaths !== undefined ? { validPaths } : {}),
      });
      return ResponseUtil.success(req, res, { placeEnable, ...result }, 'common.SUCCESS', 200);
    } catch (error) {
      Logger.error('searchPlaces error:', error);
      const statusCode = error.statusCode || 500;
      return ResponseUtil.error(req, res, error.message || 'common.ERROR', statusCode);
    }
  }

  /**
   * ⭐ 2026-10-16 P0-1：只做语义解析（不查库），供照片时间轴搜索框展示
   * 「已识别 / 未识别 / 匹配到的活动」提示条。
   */
  async parseQuery(req, res) {
    try {
      const body = req.body || {};
      const query = body.query !== undefined ? body.query : body.keyword;
      const service = new PlacesService(req.dbPhoto);
      const result = await service.parseQuery({ query });
      return ResponseUtil.success(req, res, result, 'common.SUCCESS', 200);
    } catch (error) {
      Logger.error('parseQuery error:', error);
      return ResponseUtil.error(req, res, error.message || 'common.ERROR', 500);
    }
  }

  /**
   * ⭐ 2026-10-16 P0-3 以图搜图：body 传 {file_hash} 或 {path} 或 {image_base64}。
   * 结果只含**当前用户可见范围**内的照片。
   */
  async searchImage(req, res) {
    try {
      const body = req.body || {};
      let validPaths;
      if (req.user) {
        const validPathsRaw = await photoTimeLineService.getValidPaths(req.user);
        validPaths = (validPathsRaw || []).map(p => (p ? String(p) : '')).filter(Boolean);
      }
      const service = new PlacesService(req.dbPhoto);
      const result = await service.searchByImage({
        ...body,
        ...(validPaths !== undefined ? { validPaths } : {}),
      });
      return ResponseUtil.success(req, res, result, 'common.SUCCESS', 200);
    } catch (error) {
      Logger.error('searchImage error:', error);
      const statusCode = error && error.statusCode ? Number(error.statusCode) : 500;
      return ResponseUtil.error(req, res, error.message || 'common.ERROR', statusCode);
    }
  }

  /**
   * ⭐ 2026-10-16 P0-4 搜索联想：人物 / 场景 / 活动 / 相机 / 文件名 / OCR / 年份 聚合建议。
   * 计数一律按当前用户可见范围重算（不做角色例外）。
   */
  async suggest(req, res) {
    try {
      const body = req.body || {};
      let validPaths;
      if (req.user) {
        const validPathsRaw = await photoTimeLineService.getValidPaths(req.user);
        validPaths = (validPathsRaw || []).map(p => (p ? String(p) : '')).filter(Boolean);
      }
      const service = new PlacesService(req.dbPhoto);
      const result = await service.suggest({
        ...body,
        ...(validPaths !== undefined ? { validPaths } : {}),
      });
      return ResponseUtil.success(req, res, result, 'common.SUCCESS', 200);
    } catch (error) {
      Logger.error('suggest error:', error);
      return ResponseUtil.error(req, res, error.message || 'common.ERROR', 500);
    }
  }

  async resetPlaces(req, res) {
    try {
      const service = new PlacesService(req.dbPhoto);
      const result = await service.resetPlacesRecognition();
      const placeEnable = await getEnableByKey('ai_place_enable');
      if (placeEnable === 1 && process.send) {
        try {
          process.send({ type: 'toggleAiPlace', data: { enable: 1 } });
        } catch (_) {}
      }
      return ResponseUtil.success(
        req,
        res,
        { ok: true, ...result },
        'common.SUCCESS',
        200
      );
    } catch (e) {
      Logger.error('resetPlaces error:', e);
      return ResponseUtil.error(req, res, 'common.ERROR', 500);
    }
  }

  /**
   * ⭐ 2026-10-16 只重置活动维度（不动场景）：清 gen_activity 与 photo_activity* 后重扫。
   * 重置完必须把 placesWorker 拉起来 —— worker 干净退出后只会在有 signal 时重启，
   * 光重置标记它不会自己开始跑。
   */
  async resetActivity(req, res) {
    try {
      const service = new PlacesService(req.dbPhoto);
      const result = await service.resetActivityRecognition();
      const rawActivityEnable = await tableConfig.getConfigByKey('ai_activity_enable').catch(() => null);
      // 未设置 = 开（与 placesWorker 的读法一致）
      const activityOn = !(rawActivityEnable !== null && rawActivityEnable !== undefined && ['0', 'false'].includes(String(rawActivityEnable).toLowerCase()));
      if (activityOn && process.send) {
        try {
          // 复用 place 的开关消息：两者是同一个 placesWorker
          process.send({ type: 'toggleAiPlace', data: { enable: 1 } });
        } catch (_) {}
      }
      return ResponseUtil.success(req, res, { ok: true, ...result }, 'common.SUCCESS', 200);
    } catch (e) {
      Logger.error('resetActivity error:', e);
      return ResponseUtil.error(req, res, 'common.ERROR', 500);
    }
  }
}

module.exports = new PlacesController();
