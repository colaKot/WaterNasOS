let app, BrowserWindow, Menu, Tray, protocol, ipcMain;
const Logger = require('./logger');

try {
  let elec = require('electron');
  app = elec.app;
  BrowserWindow = elec.BrowserWindow;
  Menu = elec.Menu;
  Tray = elec.Tray;
  protocol = elec.protocol;
  ipcMain = elec.ipcMain;
} catch (err) {
  //docker模式 无界面运行
  Logger.info('Clientless service mode');
}
const os = require('os');
const config = require('../config/config');
const path = require('path');
const tableConfig = require('../db/table/tableConfig');
const portfinder = require('portfinder');

class AppUtil {
  constructor() {}
  /**
   * 获取配置的API端口号
   * @param {boolean} getHttps - 是否获取HTTPS端口
   * @returns {number} - 配置的API端口号
   */
  async getConfigApiPort(getHttps) {
    // ⭐ 2026-10-18：显式设置了 PORT / HTTPS_PORT 环境变量时，env **优先于**库里的历史值。
    //   背景：端口第一次启动后会被写进 config（apiPortHttp），之后 getConfigApiPort 一直读库，
    //   于是 Docker 里改 `-e PORT=8080`、或换端口启动已有 data 目录，都会被**静默忽略**——
    //   容器监听旧端口、宿主映射新端口，表现就是「起了但连不上」。
    //   桌面端不设这两个变量，所以仍然走「UI 设置 > 默认值」的老逻辑，行为不变。
    const envRaw = getHttps ? process.env.HTTPS_PORT : process.env.PORT;
    if (envRaw !== undefined && String(envRaw).trim() !== '') {
      const envPort = parseInt(String(envRaw).trim(), 10);
      if (Number.isInteger(envPort) && envPort > 0 && envPort <= 65535) {
        const stored = await tableConfig.getConfigByKey(
          getHttps ? tableConfig.KEY_API_PORT_HTTPS : tableConfig.KEY_API_PORT_HTTP
        );
        const storedPort = parseInt(String(stored || ''), 10);
        if (Number.isInteger(storedPort) && storedPort > 0 && storedPort !== envPort) {
          Logger.warn(
            `⚠️ ${getHttps ? 'HTTPS_PORT' : 'PORT'} env=${envPort} 覆盖库内端口 ${storedPort}` +
              `（桌面端请改用「设置 → API」修改，避免环境变量把设置顶掉）`
          );
        }
        return envPort;
      }
    }

    //获取用户设置的api服务端口号
    let configPort = getHttps ? config.app.httpsPort : config.app.port;
    let portConfig = await tableConfig.getConfigByKey(getHttps ? tableConfig.KEY_API_PORT_HTTPS : tableConfig.KEY_API_PORT_HTTP);
    if (portConfig) {
      let dbPort = parseInt(portConfig);
      if (dbPort <= 0 || dbPort > 65535) {
        // 设置的端口无效 还用默认的
      } else {
        configPort = dbPort;
      }
    }
    return configPort;
  }
  /**
   * 获取可用端口
   * @param {number} basePort - 基础端口号
   * @param {function} callback - 回调函数，参数为错误对象和可用端口号
   */
  async getFreePort(basePort) {
    try {
      const freePort = await portfinder.getPortPromise({
        port: basePort, // minimum port
        stopPort: 65535, // maximum port
      });
      return freePort;
    } catch (err) {
      Logger.error('Failed to get free port', err);
      return null;
    }
  }
}

// 创建单例实例
const appUtil = new AppUtil();
// 导出单例实例
module.exports = appUtil;
