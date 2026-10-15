import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:get/get.dart';
import 'package:tray_manager/tray_manager.dart';
import 'package:window_manager/window_manager.dart';

import '../core/languages/language_service.dart';
import 'autostart.dart';

/// 桌面端：关窗时收到托盘而非退出；托盘菜单可恢复窗口或彻底退出。
class DesktopTray {
  DesktopTray._();

  static bool _inited = false;

  /// ⭐ 同步相关的托盘回调由 `SyncTaskListController` 在启动时注入。
  ///    这里刻意不直接 import 控制器，避免 tray ←→ controller 互相依赖。
  static VoidCallback? onSyncNow;
  static bool Function()? isAutoSyncPaused;
  static VoidCallback? onToggleAutoSyncPaused;

  static bool get _hasSyncMenu =>
      onSyncNow != null && onToggleAutoSyncPaused != null;

  static String _label(String key) {
    final loc = LanguageService.to.currentLocale;
    final map = LanguageService.to.keys[loc];
    final hit = map?[key];
    if (hit != null) return hit;
    // 兜底到英文，避免只维护了部分语言时托盘里显示裸 key。
    return LanguageService.to.keys['en_US']?[key] ?? key;
  }

  static Future<void> _showMainWindow() async {
    try {
      await windowManager.show();
      await windowManager.focus();
    } catch (_) {}
  }

  /// 托盘「同步设置」：恢复窗口并跳到同步页（复用主界面已有的入口）。
  ///
  /// 路由字面量 `/sync` 与 `AppRoutes.sync` 一致；这里不 import AppRoutes 是为了
  /// 避免「托盘 → 路由 → 同步页 → 同步控制器 → 托盘」的循环依赖。
  static Future<void> _openSyncSettings() async {
    await _showMainWindow();
    try {
      Get.toNamed('/sync');
    } catch (_) {}
  }

  static Future<void> _quitApp() async {
    try {
      await trayManager.destroy();
    } catch (_) {}
    try {
      await windowManager.setPreventClose(false);
    } catch (_) {}
    try {
      await windowManager.destroy();
    } catch (_) {}
    exit(0);
  }

  static Future<void> _applyContextMenu() async {
    final startOnBoot = await AutoStart.isEnabled();
    final items = <MenuItem>[
      MenuItem(
        key: 'tray_show',
        label: _label('tray_show_main_window'),
        onClick: (_) {
          Future<void>(() => _showMainWindow());
        },
      ),
      // ⭐ 开机自动启动（2026-10-13）：托盘右键直接勾选，写系统自启项，
      //    与独立同步端 / 服务端托盘里的同名项行为一致。
      MenuItem.checkbox(
        key: 'tray_start_on_boot',
        label: _label('tray_start_on_boot'),
        checked: startOnBoot,
        onClick: (item) {
          final next = !(item.checked ?? false);
          // 先改本地勾选态：tray_manager 会在 onClick 结束后据此重绘菜单
          item.checked = next;
          Future<void>(() async {
            final ok = await AutoStart.setEnabled(next);
            if (!ok) {
              // 写注册表失败：回滚勾选态并刷新菜单，别让界面骗人
              item.checked = !next;
              await updateMenu();
            }
          });
        },
      ),
    ];

    // 同步菜单：等价于独立同步客户端托盘里的「立即同步 / 暂停自动同步 / 设置」，
    // 主客户端要具备同样的能力（未注册回调时不显示，例如移动端/未登录）。
    if (_hasSyncMenu) {
      final paused = isAutoSyncPaused?.call() ?? false;
      items.addAll([
        MenuItem.separator(),
        MenuItem(
          key: 'tray_sync_now',
          label: _label('sync_start_now'),
          onClick: (_) {
            Future<void>(() => onSyncNow?.call());
          },
        ),
        MenuItem(
          key: 'tray_sync_pause',
          label: _label(paused ? 'sync_auto_resume' : 'sync_auto_pause'),
          onClick: (_) {
            Future<void>(() => onToggleAutoSyncPaused?.call());
          },
        ),
        MenuItem(
          key: 'tray_sync_settings',
          label: _label('sync_menu_tasks'),
          onClick: (_) {
            Future<void>(() => _openSyncSettings());
          },
        ),
      ]);
    }

    items.addAll([
      MenuItem.separator(),
      MenuItem(
        key: 'tray_exit',
        label: _label('tray_exit_app'),
        onClick: (_) {
          Future<void>(() => _quitApp());
        },
      ),
    ]);

    await trayManager.setContextMenu(Menu(items: items));
  }

  static Future<void> updateMenu() async {
    if (!_inited) return;
    await _applyContextMenu();
  }

  static Future<void> init() async {
    if (!(Platform.isWindows || Platform.isMacOS || Platform.isLinux)) return;

    if (_inited) return;
    _inited = true;

    await windowManager.ensureInitialized();
    await windowManager.setPreventClose(true);

    if (Platform.isWindows) {
      await trayManager.setIcon('assets/tray_icon_round.ico');
    } else {
      await trayManager.setIcon('assets/home/logo_round.png');
    }
    await trayManager.setToolTip('WaterNasClient');
    await _applyContextMenu();

    trayManager.addListener(_DesktopTrayListener());
    windowManager.addListener(_DesktopWindowListener());

    LanguageService.to.addOnLanguageChangedCallback(updateMenu);
  }
}

class _DesktopTrayListener with TrayListener {
  @override
  void onTrayIconMouseDown() {
    Future<void>(() => DesktopTray._showMainWindow());
  }

  @override
  void onTrayIconRightMouseDown() {
    trayManager.popUpContextMenu();
  }
}

class _DesktopWindowListener with WindowListener {
  @override
  void onWindowClose() {
    windowManager.hide();
  }

  @override
  void onWindowEvent(String eventName) {
    if (eventName == 'close') {
      windowManager.hide();
    }
  }
}
