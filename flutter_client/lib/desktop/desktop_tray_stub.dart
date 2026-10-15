import 'package:flutter/foundation.dart';

/// Web 或非 IO 环境占位（无托盘、无拦截关窗）。
class DesktopTray {
  DesktopTray._();

  /// 同步相关的托盘回调（移动端/Web 无托盘，仅保持与桌面端一致的接口）。
  static VoidCallback? onSyncNow;
  static bool Function()? isAutoSyncPaused;
  static VoidCallback? onToggleAutoSyncPaused;

  static Future<void> init() async {}
  static Future<void> updateMenu() async {}
}
