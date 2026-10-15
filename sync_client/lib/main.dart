import 'package:flutter/material.dart';
import 'package:get/get.dart';
import 'package:nascab_sync_core/nascab_sync_core.dart';
import 'package:window_manager/window_manager.dart';

import 'app.dart';
import 'core/session.dart';
import 'desktop/tray.dart';
import 'sync/desktop_host_impl.dart';
import 'sync/sync_controller.dart';

Future<void> main(List<String> args) async {
  WidgetsFlutterBinding.ensureInitialized();

  // 开机自启拉起时静默进托盘，不弹窗打扰
  final silent = args.contains('--autostart');

  await windowManager.ensureInitialized();
  const options = WindowOptions(
    size: Size(1000, 720),
    minimumSize: Size(780, 560),
    center: true,
    title: 'WaterNasSync',
  );
  await windowManager.waitUntilReadyToShow(options, () async {
    if (!silent) {
      await windowManager.show();
      await windowManager.focus();
    }
  });

  // 登录态先就绪，再决定首屏路由，避免先闪一下登录页
  final session = Get.put(SessionController(), permanent: true);
  await session.restore();

  // 会话彻底失效：停掉自动同步并回到登录页
  session.onSessionExpired = () {
    SyncScheduler.instance.stop();
    if (Get.currentRoute != '/login') {
      Get.offAllNamed('/login');
    }
  };

  // 装配共享同步核心（nascab_sync_core）的宿主实现：
  // 同步引擎与 PC 主客户端共用，这里注入独立端专属的鉴权、上传与直连通道。
  SyncHostHolder.instance = DesktopSyncHost.instance;

  Get.put(SyncController(), permanent: true);

  runApp(SyncApp(initialRoute: session.loggedIn.value ? '/home' : '/login'));

  // 托盘菜单文案走 GetX 翻译表，必须等首帧后翻译就绪再初始化
  WidgetsBinding.instance.addPostFrameCallback((_) {
    SyncTray.init();
  });
}
