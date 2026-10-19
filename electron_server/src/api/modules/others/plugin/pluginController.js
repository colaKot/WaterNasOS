const ResponseUtil = require('../../../apiUtils/responseUtil');
const Logger = require('../../../../utils/logger');
const remoteAssets = require('../../../../utils/remoteAssetsManager');
const tableConfig = require('../../../../db/table/tableConfig');
const plugins = require('../../../../plugins');

class PluginController {
  async getMountLibsStatus(req, res) {
    try {
      const data = remoteAssets.getMountLibsStatus();
      return ResponseUtil.success(req, res, data, 'common.SUCCESS', 200);
    } catch (e) {
      Logger.error('plugin mountLibsStatus failed', e);
      return ResponseUtil.error(req, res, 'common.ERROR', 500);
    }
  }

  /**
   * ⭐ 2026-10-17 插件状态（管理员可见）。
   * ⛔ 关于安全：本实现**没有沙箱** —— 插件就是普通 Node 模块。
   *    所以默认全局关闭（`plugin_enable`），开启即等于信任 plugins/ 目录里的代码。
   */
  listPlugins = async (req, res) => {
    try {
      await plugins.bus.ensureLoaded();
      return ResponseUtil.success(req, res, plugins.bus.status(), 'common.SUCCESS', 200);
    } catch (e) {
      Logger.error('plugin list failed', e);
      return ResponseUtil.error(req, res, 'common.ERROR', 500);
    }
  };

  /** 重新扫描并加载（超管；加载本身会 require 插件代码，属于敏感操作） */
  reloadPlugins = async (req, res) => {
    try {
      const force = String(req.body && (req.body.force ?? req.body.enable)) === '1' ||
        (req.body && req.body.force === true);
      const r = await plugins.bus.load(force);
      return ResponseUtil.success(req, res, { ...plugins.bus.status(), reload: { loaded: r.loaded.length, errors: r.errors } }, 'common.SUCCESS', 200);
    } catch (e) {
      Logger.error('plugin reload failed', e);
      return ResponseUtil.error(req, res, 'common.ERROR', 500);
    }
  };

  /** 开关插件总闸（超管）。写入配置键 plugin_enable（全局，非用户级）。 */
  setPluginEnable = async (req, res) => {
    try {
      const raw = req.body && (req.body.enable ?? req.body.value);
      const enable = String(raw) === '1' || raw === true;
      await tableConfig.setConfigByKey('plugin_enable', enable ? '1' : '0');
      await plugins.bus.load(enable);
      return ResponseUtil.success(req, res, plugins.bus.status(), 'common.SUCCESS', 200);
    } catch (e) {
      Logger.error('plugin setEnable failed', e);
      return ResponseUtil.error(req, res, 'common.ERROR', 500);
    }
  };
}

module.exports = new PluginController();
