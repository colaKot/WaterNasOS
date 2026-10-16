const ResponseUtil = require('../../../apiUtils/responseUtil');
const { getUserLanguage } = require('../../../../utils/i18nUtil');
const AppAiService = require('./appAiService');
const photoTimeLineService = require('../timeline/photoTimeLineService');
const userUtil = require('../../../../utils/userUtil');

class AppAiController {
  async overview(req, res) {
    try {
      const locale = getUserLanguage(req);
      let validPaths;
      // 按归属隔离：所有用户（含管理员）都只能看到自己源目录下的照片。
      // 不要再加 isAdmin 例外 —— 隐私设计要求超管也只看自己的。
      if (req.user) {
        const validPathsRaw = await photoTimeLineService.getValidPaths(req.user);
        validPaths = (validPathsRaw || []).map(p => (p ? String(p) : '')).filter(Boolean);
      }
      const service = new AppAiService(req.dbPhoto);
      const result = await service.getOverview({
        locale,
        ...(req.body || {}),
        ...(validPaths !== undefined ? { validPaths } : {}),
      });
      return ResponseUtil.success(req, res, result, 'common.SUCCESS', 200);
    } catch (_) {
      return ResponseUtil.error(req, res, 'common.ERROR', 500);
    }
  }

  // ---------------------------------------------------------------------------
  // 2026-10-16 P1/P2 照片域智能发现：全部只读（记忆的确认结果按 uid 存 config）。
  // 可见性口径统一：非管理员一律传 validPaths（零角色例外）。
  // ---------------------------------------------------------------------------

  async _scopeParams(req) {
    const params = { ...(req.body || {}) };
    if (!userUtil.isAdmin(req.user)) {
      const validPathsRaw = await photoTimeLineService.getValidPaths(req.user);
      params.validPaths = (validPathsRaw || []).map(x => (x ? String(x) : '')).filter(Boolean);
    }
    return params;
  }

  /** P1-11 时光对照 */
  async timeCompare(req, res) {
    try {
      const service = new AppAiService(req.dbPhoto);
      const result = await service.timeCompare(await this._scopeParams(req));
      return ResponseUtil.success(req, res, result, 'common.SUCCESS', 200);
    } catch (err) {
      Logger.error('timeCompare error', err);
      const code = err && err.statusCode ? Number(err.statusCode) : 500;
      return ResponseUtil.error(req, res, (err && err.message) || 'common.ERROR', code);
    }
  }

  /** P1-17 一日一帧 */
  async dayFrames(req, res) {
    try {
      const service = new AppAiService(req.dbPhoto);
      const result = await service.dayFrames(await this._scopeParams(req));
      return ResponseUtil.success(req, res, result, 'common.SUCCESS', 200);
    } catch (err) {
      Logger.error('dayFrames error', err);
      return ResponseUtil.error(req, res, 'common.ERROR', 500);
    }
  }

  /** P1-13 票据 / 行程（轻量版） */
  async tickets(req, res) {
    try {
      const service = new AppAiService(req.dbPhoto);
      const result = await service.tickets(await this._scopeParams(req));
      return ResponseUtil.success(req, res, result, 'common.SUCCESS', 200);
    } catch (err) {
      Logger.error('tickets error', err);
      return ResponseUtil.error(req, res, 'common.ERROR', 500);
    }
  }

  /** P1-14 记忆发现：候选 + 已确认 */
  async memories(req, res) {
    try {
      const service = new AppAiService(req.dbPhoto);
      const params = await this._scopeParams(req);
      params.uid = req.user && req.user.id ? Number(req.user.id) : 0;
      const result = await service.memoryCandidates(params);
      return ResponseUtil.success(req, res, result, 'common.SUCCESS', 200);
    } catch (err) {
      Logger.error('memories error', err);
      return ResponseUtil.error(req, res, 'common.ERROR', 500);
    }
  }

  /** P1-14 记忆：确认保存 */
  async saveMemory(req, res) {
    try {
      const service = new AppAiService(req.dbPhoto);
      const body = req.body || {};
      const result = await service.saveMemory({
        ...body,
        uid: req.user && req.user.id ? Number(req.user.id) : 0,
      });
      return ResponseUtil.success(req, res, result, 'common.SUCCESS', 200);
    } catch (err) {
      Logger.error('saveMemory error', err);
      const code = err && err.statusCode ? Number(err.statusCode) : 500;
      return ResponseUtil.error(req, res, (err && err.message) || 'common.ERROR', code);
    }
  }

  /** P1-14 记忆：删除 */
  async removeMemory(req, res) {
    try {
      const service = new AppAiService(req.dbPhoto);
      const body = req.body || {};
      const result = await service.removeMemory({
        ...body,
        uid: req.user && req.user.id ? Number(req.user.id) : 0,
      });
      return ResponseUtil.success(req, res, result, 'common.SUCCESS', 200);
    } catch (err) {
      Logger.error('removeMemory error', err);
      return ResponseUtil.error(req, res, 'common.ERROR', 500);
    }
  }

  /** P1-16 相似 / 重复照片工具箱（数据层） */
  async duplicates(req, res) {
    try {
      const service = new AppAiService(req.dbPhoto);
      const result = await service.duplicates(await this._scopeParams(req));
      return ResponseUtil.success(req, res, result, 'common.SUCCESS', 200);
    } catch (err) {
      Logger.error('duplicates error', err);
      return ResponseUtil.error(req, res, 'common.ERROR', 500);
    }
  }

  /** P1-15 模型目录（只读） */
  async models(req, res) {
    try {
      const service = new AppAiService(req.dbPhoto);
      const result = await service.modelCatalog();
      return ResponseUtil.success(req, res, result, 'common.SUCCESS', 200);
    } catch (err) {
      Logger.error('models error', err);
      return ResponseUtil.error(req, res, 'common.ERROR', 500);
    }
  }

  /** P2-21 年度报告 */
  async yearReport(req, res) {
    try {
      const service = new AppAiService(req.dbPhoto);
      const result = await service.yearReport(await this._scopeParams(req));
      return ResponseUtil.success(req, res, result, 'common.SUCCESS', 200);
    } catch (err) {
      Logger.error('yearReport error', err);
      return ResponseUtil.error(req, res, 'common.ERROR', 500);
    }
  }

  /** P1-10 足迹叙事层：访问片段 + 旅行连线 */
  async travelLines(req, res) {
    try {
      const service = new AppAiService(req.dbPhoto);
      const result = await service.travelLines(await this._scopeParams(req));
      return ResponseUtil.success(req, res, result, 'common.SUCCESS', 200);
    } catch (err) {
      Logger.error('travelLines error', err);
      return ResponseUtil.error(req, res, 'common.ERROR', 500);
    }
  }

  /** ⭐ P2-18/P2-20 开放平台：读模型 API 配置（api_key 只回掩码） */
  async modelApiGet(req, res) {
    try {
      const service = new AppAiService(req.dbPhoto);
      const result = await service.getModelApi();
      return ResponseUtil.success(req, res, result, 'common.SUCCESS', 200);
    } catch (err) {
      Logger.error('modelApiGet error', err);
      return ResponseUtil.error(req, res, 'common.ERROR', 500);
    }
  }

  /** ⭐ 保存模型 API 配置（api_key 留空 = 保留原值） */
  async modelApiSet(req, res) {
    try {
      const service = new AppAiService(req.dbPhoto);
      const result = await service.setModelApi(req.body || {});
      return ResponseUtil.success(req, res, result, 'common.SUCCESS', 200);
    } catch (err) {
      Logger.error('modelApiSet error', err);
      return ResponseUtil.error(req, res, 'common.ERROR', 500);
    }
  }

  /** ⭐ 真实连通性测试（拿凭据真发一次请求） */
  async modelApiTest(req, res) {
    try {
      const service = new AppAiService(req.dbPhoto);
      const result = await service.testModelApi(req.body || {});
      return ResponseUtil.success(req, res, result, 'common.SUCCESS', 200);
    } catch (err) {
      Logger.error('modelApiTest error', err);
      return ResponseUtil.error(req, res, 'common.ERROR', 500);
    }
  }

  /**
   * ⭐ 2026-10-16 P1-9 暂停 / 恢复 AI 流水线（写入型控制的第一块，可逆、不丢数据）。
   */
  async queuePause(req, res) {
    try {
      const service = new AppAiService(req.dbPhoto);
      const body = req.body || {};
      const paused = body.paused === true || body.paused === 1 || body.paused === '1';
      const result = await service.setQueuePaused({ paused });
      return ResponseUtil.success(req, res, result, 'common.SUCCESS', 200);
    } catch (err) {
      Logger.error('queuePause error', err);
      return ResponseUtil.error(req, res, 'common.ERROR', 500);
    }
  }

  /**
   * ⭐ 2026-10-16 P1-9 任务进度聚合：只在**管理员**时给全库口径，普通用户按自己的可见范围。
   */
  async queue(req, res) {
    try {
      const service = new AppAiService(req.dbPhoto);
      const params = { ...(req.body || {}) };
      if (!userUtil.isAdmin(req.user)) {
        const validPathsRaw = await photoTimeLineService.getValidPaths(req.user);
        params.validPaths = (validPathsRaw || []).map(x => (x ? String(x) : '')).filter(Boolean);
      }
      const result = await service.getQueueStatus(params);
      return ResponseUtil.success(req, res, result, 'common.SUCCESS', 200);
    } catch (err) {
      Logger.error('queue error', err);
      return ResponseUtil.error(req, res, 'common.ERROR', 500);
    }
  }

  /**
   * ⭐ 2026-10-16 P0-8 单张 / 多张照片「重新识别（分项）」：把人脸 / OCR / 场景 / 活动
   * 中指定的项按 file_hash 重新入队（只重置这一项的标记，不影响其它项）。
   */
  async rerun(req, res) {
    try {
      let validPaths;
      // 可见性零角色例外：所有用户（含管理员）只允许重跑自己源目录下的照片
      if (req.user) {
        const validPathsRaw = await photoTimeLineService.getValidPaths(req.user);
        validPaths = (validPathsRaw || []).map(p => (p ? String(p) : '')).filter(Boolean);
      }
      const service = new AppAiService(req.dbPhoto);
      const result = await service.rerunAi({
        ...(req.body || {}),
        ...(validPaths !== undefined ? { validPaths } : {}),
      });
      return ResponseUtil.success(req, res, result, 'common.SUCCESS', 200);
    } catch (err) {
      const msgKey = err && err.message ? err.message : 'common.ERROR';
      const statusCode = err && err.statusCode ? Number(err.statusCode) : 500;
      return ResponseUtil.error(req, res, msgKey, statusCode);
    }
  }

  /**
   * ⭐ 2026-10-16 OCR 全库重跑：清掉已有 OCR 文本并重置入队标记（换 OCR 模型后用）。
   * 全库动作，与 /place/reset 同口径（管理员，不做可见范围过滤）。
   */
  async resetOcr(req, res) {
    try {
      const service = new AppAiService(req.dbPhoto);
      const result = await service.resetOcrRecognition();
      return ResponseUtil.success(req, res, result, 'common.SUCCESS', 200);
    } catch (err) {
      Logger.error('resetOcr error', err);
      return ResponseUtil.error(req, res, 'common.ERROR', 500);
    }
  }
}

module.exports = new AppAiController();
