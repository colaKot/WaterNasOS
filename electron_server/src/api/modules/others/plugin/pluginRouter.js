const express = require('express');
const router = express.Router();
const { authenticateJWT } = require('../../../middleware/authMiddleware');
const { requireAdmin, requireSuperAdmin } = require('../../../middleware/authMiddleware');
const pluginController = require('./pluginController');

router.post('/mountLibsStatus', authenticateJWT, (req, res) => pluginController.getMountLibsStatus(req, res));


// ⭐ 2026-10-17 插件（扩展点）状态与开关。
// ⛔ 路由层一律包箭头 —— 控制器是实例导出，裸引用会丢 `this`（`/app_ai/*` 就这么翻过车）。
router.post('/list', authenticateJWT, requireAdmin, (req, res) => pluginController.listPlugins(req, res));
router.post('/reload', authenticateJWT, requireSuperAdmin, (req, res) => pluginController.reloadPlugins(req, res));
router.post('/enable', authenticateJWT, requireSuperAdmin, (req, res) => pluginController.setPluginEnable(req, res));

module.exports = router;
