const express = require('express');
const router = express.Router();
const { authenticateJWT } = require('../../middleware/authMiddleware');
const SyncValidation = require('./syncValidation');
const syncController = require('./syncController');

// 这里刻意不挂 requirePermission，路径级鉴权放在 syncController 里。原因：
//   1. /plan、/deleteRemote、/mkdir 的请求体里只有任务 id，目标目录要从
//      sync_task 表里取，requirePermission 的 from: 'body.xxx' 没有字段可指；
//   2. /upsert 需要按 mode（双向 / 仅上传 / 仅下载）推导该目录需要哪些动作，
//      中间件表达不了这种依赖；
//   3. /probe 无权限时要返回 200 + allowed:false 让客户端弹友好提示，而不是 403。
// 具体实现见 syncController 的 requiredActions / assertSyncDirPermission。

// 任务管理
router.post('/list', authenticateJWT, SyncValidation.validateList(), SyncValidation.handleValidationErrors, (req, res) => syncController.list(req, res));
router.post('/summary', authenticateJWT, SyncValidation.validateSummary(), SyncValidation.handleValidationErrors, (req, res) => syncController.summary(req, res));
router.post('/get', authenticateJWT, SyncValidation.validateGet(), SyncValidation.handleValidationErrors, (req, res) => syncController.get(req, res));
router.post('/upsert', authenticateJWT, SyncValidation.validateUpsert(), SyncValidation.handleValidationErrors, (req, res) => syncController.upsert(req, res));
router.post('/delete', authenticateJWT, SyncValidation.validateDelete(), SyncValidation.handleValidationErrors, (req, res) => syncController.remove(req, res));
router.post('/status', authenticateJWT, SyncValidation.validateUpdateStatus(), SyncValidation.handleValidationErrors, (req, res) => syncController.updateStatus(req, res));
router.post('/records/list', authenticateJWT, SyncValidation.validateListRecords(), SyncValidation.handleValidationErrors, (req, res) => syncController.listRecords(req, res));

// 设备归属：把旧版（未绑定主机）任务认领到本机
router.post('/device/claimLegacy', authenticateJWT, SyncValidation.validateClaimLegacy(), SyncValidation.handleValidationErrors, (req, res) => syncController.claimLegacy(req, res));

// 服务端接收端：路径探测、同步计划、结果回写、NAS 侧删除与建目录
router.post('/probe', authenticateJWT, SyncValidation.validateProbe(), SyncValidation.handleValidationErrors, (req, res) => syncController.probe(req, res));
router.post('/plan', authenticateJWT, SyncValidation.validatePlan(), SyncValidation.handleValidationErrors, (req, res) => syncController.plan(req, res));
router.post('/report', authenticateJWT, SyncValidation.validateReport(), SyncValidation.handleValidationErrors, (req, res) => syncController.report(req, res));
router.post('/deleteRemote', authenticateJWT, SyncValidation.validateDeleteRemote(), SyncValidation.handleValidationErrors, (req, res) => syncController.deleteRemote(req, res));
router.post('/mkdir', authenticateJWT, SyncValidation.validateMkdir(), SyncValidation.handleValidationErrors, (req, res) => syncController.mkdir(req, res));

module.exports = router;
