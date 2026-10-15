import 'dart:io';

import 'package:get/get.dart';
import 'package:tray_manager/tray_manager.dart';
import 'package:window_manager/window_manager.dart';

import '../sync/sync_controller.dart';
import 'autostart.dart';

/// 托盘常驻 + 关窗最小化。
///
/// 独立同步客户端的常态是「挂在后台跑」，所以关窗只隐藏窗口，
/// 真正退出必须走托盘菜单的「退出」。
class SyncTray {
  SyncTray._();

  static bool _inited = false;

  static Future<void> showWindow() async {
    try {
      await windowManager.show();
      await windowManager.focus();
    } catch (_) {}
  }

  static Future<void> hideWindow() async {
    try {
      await windowManager.hide();
    } catch (_) {}
  }

  static Future<void> quitApp() async {
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
    final ctrl = Get.isRegistered<SyncController>()
        ? SyncController.instance
        : null;
    final paused = ctrl?.autoPaused.value ?? false;
    final startOnBoot = await AutoStart.isEnabled();

    final menu = Menu(
      items: [
        MenuItem(
          key: 'tray_show',
          label: 'tray_show_main_window'.tr,
          onClick: (_) => Future<void>(() => showWindow()),
        ),
        // ⭐ 开机自动启动（2026-10-13）：托盘右键直接勾选，写系统自启项。
        MenuItem.checkbox(
          key: 'tray_start_on_boot',
          label: 'auto_start'.tr,
          checked: startOnBoot,
          onClick: (item) {
            final next = !(item.checked ?? false);
            // 先改本地勾选态：tray_manager 会在 onClick 结束后据此重绘菜单
            item.checked = next;
            Future<void>(() async {
              final ok = await AutoStart.setEnabled(next);
              if (!ok) {
                item.checked = !next; // 写失败回滚，别让界面骗人
                await updateMenu();
              }
            });
          },
        ),
        MenuItem.separator(),
        MenuItem(
          key: 'tray_sync_now',
          label: 'tray_sync_now'.tr,
          onClick: (_) {
            Future<void>(() async {
              await showWindow();
              await SyncController.instance.runAllTasks();
            });
          },
        ),
        MenuItem(
          key: 'tray_toggle_auto',
          label: paused ? 'tray_resume_auto'.tr : 'tray_pause_auto'.tr,
          onClick: (_) {
            Future<void>(() async {
              final current = SyncController.instance.autoPaused.value;
              await SyncController.instance.setAutoPaused(!current);
              await updateMenu();
            });
          },
        ),
        MenuItem.separator(),
        MenuItem(
          key: 'tray_settings',
          label: 'tray_settings'.tr,
          onClick: (_) {
            Future<void>(() async {
              await showWindow();
              if (Get.currentRoute != '/settings') {
                Get.toNamed('/settings');
              }
            });
          },
        ),
        MenuItem.separator(),
        MenuItem(
          key: 'tray_exit',
          label: 'tray_exit_app'.tr,
          onClick: (_) => Future<void>(() => quitApp()),
        ),
      ],
    );
    await trayManager.setContextMenu(menu);
  }

  static Future<void> updateMenu() async {
    if (!_inited) return;
    await _applyContextMenu();
  }

  static Future<void> init() async {
    if (!Platform.isWindows && !Platform.isMacOS && !Platform.isLinux) return;
    if (_inited) return;
    _inited = true;

    await windowManager.ensureInitialized();
    // 关窗时不退出，交给 onWindowClose 隐藏
    await windowManager.setPreventClose(true);

    if (Platform.isWindows) {
      await trayManager.setIcon('assets/tray_icon_round.ico');
    } else {
      await trayManager.setIcon('assets/tray_icon_round.ico');
    }
    await trayManager.setToolTip('WaterNasSync');
    await _applyContextMenu();

    trayManager.addListener(_SyncTrayListener());
    windowManager.addListener(_SyncWindowListener());
  }
}

class _SyncTrayListener with TrayListener {
  @override
  void onTrayIconMouseDown() {
    Future<void>(() => SyncTray.showWindow());
  }

  @override
  void onTrayIconRightMouseDown() {
    trayManager.popUpContextMenu();
  }
}

class _SyncWindowListener with WindowListener {
  @override
  void onWindowClose() {
    // 关窗 = 收进托盘，程序继续在后台同步
    Future<void>(() => SyncTray.hideWindow());
  }

  @override
  void onWindowEvent(String eventName) {
    if (eventName == 'close') {
      Future<void>(() => SyncTray.hideWindow());
    }
  }
}
