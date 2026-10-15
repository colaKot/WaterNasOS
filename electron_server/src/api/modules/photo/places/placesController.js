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
}

module.exports = new PlacesController();
