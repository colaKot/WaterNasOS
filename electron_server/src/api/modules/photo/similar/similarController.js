const ResponseUtil = require('../../../apiUtils/responseUtil');
const SimilarService = require('./similarService');
const tableConfig = require('../../../../db/table/tableConfig');

async function getEnableByKey(key) {
  try {
    const raw = await tableConfig.getConfigByKey(key);
    return raw === '1' ? 1 : 0;
  } catch (_) {
    return 0;
  }
}

class SimilarController {
  async listSimilarGroups(req, res) {
    try {
      const similarEnable = await getEnableByKey('ai_similar_enable');
      const body = req.body || {};
      const page = Math.max(1, Number(body.page) || 1);
      const pageSize = Math.max(1, Math.min(200, Number(body.pageSize ?? body.page_size) || 20));

      if (similarEnable !== 1) {
        return ResponseUtil.success(
          req,
          res,
          {
            similarEnable,
            items: [],
            pagination: { total: 0, page, pageSize },
          },
          'common.SUCCESS',
          200
        );
      }

      const service = new SimilarService(req.dbPhoto);
      const result = await service.listSimilarGroups({ ...body, page, pageSize });
      return ResponseUtil.success(req, res, { similarEnable, ...result }, 'common.SUCCESS', 200);
    } catch (e) {
      return ResponseUtil.error(req, res, 'common.ERROR', 500);
    }
  }

  async batchDelete(req, res) {
    try {
      const body = req.body || {};
      const ids = body.ids ?? body.id_list ?? body.idList;
      if (!Array.isArray(ids)) return ResponseUtil.error(req, res, 'common.PARAM_ERROR', 400);
      const service = new SimilarService(req.dbPhoto);
      const deleted = await service.batchDeleteSimilarRecords(ids);
      return ResponseUtil.success(req, res, { deleted }, 'common.SUCCESS', 200);
    } catch (e) {
      return ResponseUtil.error(req, res, 'common.ERROR', 500);
    }
  }

  async reset(req, res) {
    try {
      const service = new SimilarService(req.dbPhoto);
      const ok = await service.resetSimilarScan();

      // ⭐ 2026-10-17 P5：原来这里用 `process.send({ type: 'startSimilarScan' })` 去通知「开始扫描」，
      // 但本文件跑在**主 Express 进程**里、没有 IPC 通道 ⇒ `process.send` 是 undefined ⇒
      // 用户点「重新扫描」实际只清了标记，扫描根本不会开始（要等重启服务端才可能跑）。
      // 改成走单例 worker 管理器（与 msgHandler/aiToggle.js 同一套机制）：先停再起，
      // 让 worker 重新读一遍 gen_phash=0 的队列。开关没开就如实返回 scanStarted:false，不假装成功。
      let scanStarted = false;
      if (ok) {
        const workers = require('../../../../initHandler/workers');
        const enabled = typeof workers.isAiWorkerEnabled === 'function'
          ? await workers.isAiWorkerEnabled('ai_similar_enable')
          : false;
        if (enabled) {
          const { getSingletonWorkerManager } = require('../../../../workers/singletonWorkerManager');
          const mgr = getSingletonWorkerManager();
          if (mgr && typeof mgr.stopWorker === 'function') {
            await mgr.stopWorker('similarWorker', 5000).catch(() => false);
          }
          if (typeof workers.startSimilarWorker === 'function') {
            workers.startSimilarWorker();
            scanStarted = true;
          }
        }
      }
      return ResponseUtil.success(req, res, { ok: !!ok, scanStarted }, 'common.SUCCESS', 200);
    } catch (e) {
      return ResponseUtil.error(req, res, 'common.ERROR', 500);
    }
  }
}

module.exports = new SimilarController();
module.exports = new SimilarController();
