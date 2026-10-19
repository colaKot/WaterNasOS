import 'package:flutter/material.dart';

import 'core/bootstrap/app_launch.dart';
import 'core/bootstrap/bootstrap_gate.dart';
import 'core/bootstrap/startup_diag.dart';

Future<void> main() => runWaterNasOSApp();

/// 共享启动入口。
///
/// 主客户端（WaterNasOS 完整版）走 `main()`（等价于 `full`）；
/// 派生的独立程序（photo_client / music_client）通过 `path:` 依赖本工程，
/// 在各自的 `main()` 里调用 `runWaterNasOSApp(launchMode: ...)` 即可，
/// **不复制任何业务代码**。
///
/// ⚠️ 初始化流水线已移到 `BootstrapGate`（core/bootstrap/bootstrap_gate.dart）。
/// 旧写法在 `runApp` 之前 `await` 一整串初始化，任何一步卡住都只剩系统启动画面
/// —— release 包看不到 print，用户也无法自证卡在哪里。
/// 现在先出首帧，1.2 秒内没完成就渲染启动诊断页（步骤/耗时/异常/一键分享）。
Future<void> runWaterNasOSApp({
  AppLaunchMode launchMode = AppLaunchMode.full,
}) async {
  AppLaunch.mode = launchMode;
  // 确保Flutter绑定已初始化
  WidgetsFlutterBinding.ensureInitialized();
  installStartupErrorHandlers();
  runApp(BootstrapGate(launchMode: launchMode));
}
