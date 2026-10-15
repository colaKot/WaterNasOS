import 'package:WaterNasOS/core/bootstrap/app_launch.dart' as shell_launch;
import 'package:WaterNasOS/main.dart' as shell;

/// WaterNasPhoto（独立 exe）入口。
///
/// 本工程 **不复制主客户端任何业务代码**：通过 `pubspec.yaml` 里的
/// `WaterNasOS: path: ../flutter_client` 直接复用主客户端整套代码，
/// 这里只声明启动模式。
///
/// `AppLaunchMode.photo` 模式下：
///   * 首页只展示相册（appKey = photo）这一个应用；
///   * 登录 / 选服务器成功后自动进入相册；
///   * 相册同步的 MD5 内容去重等能力与主客户端完全一致；
///   * 后续改动做在主客户端，这里自动生效（同一个代码源）。
Future<void> main() =>
    shell.runWaterNasOSApp(launchMode: shell_launch.AppLaunchMode.photo);
