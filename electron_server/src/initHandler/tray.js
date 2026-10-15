const os = require('os');
const path = require('path');
const fs = require('fs');
const Logger = require('../utils/logger');
const autoLaunchUtil = require('../utils/autoLaunchUtil');

function getRootPath(app) {
  if (!app) return null;
  if (!app.isPackaged) {
    return path.resolve(__dirname, '..', '..');
  }
  let rootPath = path.dirname(app.getPath('exe'));
  if (os.platform() === 'darwin') {
    rootPath = path.dirname(rootPath);
  }
  return rootPath;
}

function resolveTrayIconPath(rootPath) {
  if (!rootPath) return null;
  const libsDir = path.join(rootPath, 'libs');
  const platform = process.platform;
  let candidates = ['logo-tray.png'];
  if (platform === 'darwin') {
    candidates = ['tray-mac.png', 'logo-tray.png'];
  } else if (platform === 'win32') {
    candidates = ['tray-win.png', 'logo-tray.png'];
  } else {
    candidates = ['tray-linux.png', 'logo-tray.png'];
  }

  for (const name of candidates) {
    const p = path.join(libsDir, name);
    try {
      if (fs.existsSync(p)) return p;
    } catch {}
  }
  return null;
}

module.exports = {
  initTray(mainWindow) {
    let app, Menu, Tray;
    try {
      ({ app, Menu, Tray } = require('electron'));
    } catch (e) {
      return null;
    }

    if (!app || !Menu || !Tray || !mainWindow) {
      return null;
    }

    this.mainWindow = mainWindow;

    if (this.tray) {
      return this.tray;
    }

    const rootPath = getRootPath(app);
    const iconPath = resolveTrayIconPath(rootPath);

    try {
      this.tray = iconPath ? new Tray(iconPath) : new Tray();
    } catch (e) {
      Logger.error('Tray init failed:', e && e.message ? e.message : e);
      this.tray = null;
      return null;
    }

    const toggleWindow = () => {
      try {
        if (!this.mainWindow || this.mainWindow.isDestroyed()) return;
        if (this.mainWindow.isVisible()) {
          this.mainWindow.hide();
        } else {
          this.mainWindow.show();
          this.mainWindow.focus();
        }
      } catch {}
    };

    /** 读当前「开机自动启动」状态（注册表 / LaunchAgent / autostart） */
    const readOpenAtLogin = () => {
      try {
        return !!autoLaunchUtil.getOpenAtLogin(app);
      } catch (e) {
        return false;
      }
    };

    let refreshTrayMenu = () => {};

    const buildTrayMenuTemplate = () => [
      {
        label: 'Show/Hide',
        click: toggleWindow,
      },
      { type: 'separator' },
      // ⭐ 开机自动启动（2026-10-13）：托盘右键直接勾选。
      //    同时写系统自启项（注册表 Run / LaunchAgent / ~/.config/autostart）
      //    与数据库配置 openAtLogin，保证与「设置」页里的开关是同一份状态。
      {
        label: '开机自动启动',
        type: 'checkbox',
        checked: readOpenAtLogin(),
        click: async item => {
          const next = !!item.checked;
          let ok = false;
          try {
            ok = autoLaunchUtil.setOpenAtLogin(app, next) !== false;
          } catch (e) {
            ok = false;
          }
          if (!ok) {
            // 写系统自启项失败：回滚勾选态，别让界面骗人
            item.checked = !next;
            refreshTrayMenu();
            return;
          }
          try {
            const tableConfig = require('../db/table/tableConfig');
            if (tableConfig && tableConfig.setConfigByKey) {
              await tableConfig.setConfigByKey(
                tableConfig.KEY_OPEN_AT_LOGIN,
                next ? 'true' : 'false'
              );
            }
          } catch (e) {
            Logger.error(
              'Tray save openAtLogin failed:',
              e && e.message ? e.message : e
            );
          }
        },
      },
      { type: 'separator' },
      {
        label: 'Restart',
        click: () => {
          try {
            this.trayQuitRequested = true;
            app.relaunch();
            app.quit();
          } catch {}
        },
      },
      {
        label: 'Exit',
        click: () => {
          try {
            this.trayQuitRequested = true;
            app.quit();
          } catch {}
        },
      },
    ];

    refreshTrayMenu = () => {
      try {
        this.tray.setContextMenu(Menu.buildFromTemplate(buildTrayMenuTemplate()));
      } catch {}
    };

    const contextMenu = Menu.buildFromTemplate(buildTrayMenuTemplate());
    try {
      this.tray.setToolTip('WaterNasOS');
    } catch {}
    try {
      this.tray.setContextMenu(contextMenu);
    } catch {}
    try {
      this.tray.on('click', toggleWindow);
    } catch {}

    try {
      this.mainWindow.on('close', event => {
        if (this.trayQuitRequested) return;
        if (!this.tray) return;
        try {
          event.preventDefault();
          if (this.mainWindow && !this.mainWindow.isDestroyed()) {
            this.mainWindow.hide();
          }
        } catch {}
      });
    } catch {}

    return this.tray;
  },

  destroyTray() {
    if (this.tray) {
      try {
        this.tray.destroy();
      } catch {}
      this.tray = null;
    }
  },
};
