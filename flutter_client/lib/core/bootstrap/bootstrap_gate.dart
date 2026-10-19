import 'dart:async';

import 'package:device_info_plus/device_info_plus.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_quill/flutter_quill.dart';
import 'package:flutter_fullscreen/flutter_fullscreen.dart';
import 'package:get/get.dart';
import 'package:nascab_sync_core/nascab_sync_core.dart';
import 'package:package_info_plus/package_info_plus.dart';
import 'package:photo_manager/photo_manager.dart' as pm;
import 'package:share_plus/share_plus.dart';

import '../../desktop/desktop_tray.dart';
import '../../modules/auth/service/auth_api_service.dart';
import '../../modules/fileBackup/localBackup/local_backup_controller.dart';
import '../../modules/home/service/appearance_api_service.dart';
import '../../modules/music/play_service/controller/music_play_service_controller.dart';
import '../../modules/photoBackup/controller/photo_backup_controller.dart';
import '../../modules/sync/controller/sync_task_list_controller.dart';
import '../../modules/sync/service/sync_api_service.dart';
import '../../modules/sync/service/sync_host_impl.dart';
import '../../modules/video_player/controllers/platform/video_platform.dart';
import '../../utils/cache_manager.dart';
import '../../utils/device_utils.dart';
import '../api/api_controller.dart';
import '../api/io_self_signed_http_overrides.dart';
import '../bg/background_controller.dart';
import '../bg_task/hw_metrics_controller.dart';
import '../languages/language_service.dart';
import '../notification/transfer_work_notification_hub.dart';
import '../routes/app_routes.dart';
import '../theme/theme_apply_service.dart';
import '../theme/theme_manager.dart';
import '../user/current_user_controller.dart';
import '../web/context_menu_stub.dart'
    if (dart.library.html) '../web/context_menu_web.dart';
import 'app_launch.dart';
import 'startup_diag.dart';

const double _scrollbarThickness = 8;

final WidgetStateProperty<double> _scrollbarThicknessState =
    WidgetStateProperty.all(_scrollbarThickness);

/// 启动闸门。
///
/// 与旧写法的唯一区别：**先出首帧，再做初始化**。
/// 旧写法把一整串 `await` 放在 `runApp` 之前，任何一步卡住都只能对着
/// 系统启动画面干等（release 包看不到日志，用户也无法自证卡在哪）。
///
/// 现在：
/// - 首帧立刻绘制（前 1.2s 仍是白底，尽量还原原来的启动观感）；
/// - 1.2s 内没完成 ⇒ 显示启动诊断页（步骤 / 耗时 / 异常 / 一键分享）；
/// - 初始化全部完成 ⇒ 再切成真正的 GetMaterialApp，行为和原来一致。
class BootstrapGate extends StatefulWidget {
  const BootstrapGate({super.key, required this.launchMode});

  final AppLaunchMode launchMode;

  @override
  State<BootstrapGate> createState() => _BootstrapGateState();
}

class _BootstrapGateState extends State<BootstrapGate> {
  Widget? _root;
  bool _showDetail = false;
  bool _failed = false;
  String _verdict = '';
  Timer? _ticker;
  Timer? _detailTimer;
  bool _running = false;

  @override
  void initState() {
    super.initState();
    // 每 250ms 刷新一次计时，卡住时用户能直观看到"已等待 Ns"。
    _ticker = Timer.periodic(const Duration(milliseconds: 250), (_) {
      if (!mounted || _root != null) return;
      setState(() {});
    });
    _detailTimer = Timer(const Duration(milliseconds: 1200), () {
      if (!mounted || _root != null) return;
      setState(() => _showDetail = true);
    });
    _run();
  }

  @override
  void dispose() {
    _ticker?.cancel();
    _detailTimer?.cancel();
    super.dispose();
  }

  Future<void> _step(
    String name,
    FutureOr<void> Function() action, {
    bool required = true,
  }) async {
    final s = StartupDiag.instance.begin(name);
    try {
      await action();
      StartupDiag.instance.end(s);
    } catch (e, st) {
      StartupDiag.instance.fail(s, e, st);
      if (required) rethrow;
    }
  }

  /// 后台任务：保持「不阻塞启动」的原行为，但仍记录状态，
  /// 这样诊断页能看出是它慢，而不是它把启动卡死了。
  void _background(String name, FutureOr<void> Function() action) {
    final s = StartupDiag.instance.begin(name);
    Future<void>.sync(action).then<void>((_) {
      StartupDiag.instance.end(s);
    }).catchError((Object e, StackTrace st) {
      StartupDiag.instance.fail(s, e, st);
    });
  }

  Future<void> _run() async {
    if (_running) return;
    _running = true;
    if (mounted) {
      setState(() {
        _failed = false;
        _verdict = '';
      });
    }
    final diag = StartupDiag.instance;

    try {
      await _step('应用 HTTP 覆盖（自签证书兼容）', () {
        applyIoSelfSignedHttpOverridesIfNeeded();
      });

      await _step('读取设备信息', () async {
        final buf = StringBuffer();
        try {
          buf.write(DeviceUtils.platformName);
          if (DeviceUtils.isAndroid) {
            final info = await DeviceInfoPlugin().androidInfo;
            buf.write(
              ' / ${info.manufacturer} ${info.model} / Android ${info.version.release} (SDK ${info.version.sdkInt})',
            );
          }
          final pi = await PackageInfo.fromPlatform();
          diag.appInfo =
              '${pi.appName} ${pi.version} (build ${pi.buildNumber}) / ${pi.packageName}';
        } catch (e) {
          buf.write(' / 读取设备信息失败: $e');
        }
        diag.deviceInfo = buf.toString();
      }, required: false);

      await _step('初始化全屏能力', () => FullScreen.ensureInitialized());

      if (DeviceUtils.isMobile && !DeviceUtils.isWeb) {
        await _step(
          '锁定竖屏',
          () => SystemChrome.setPreferredOrientations([
            DeviceOrientation.portraitUp,
          ]),
        );
      }

      await _step('读取本地缓存（SharedPreferences）', () => CacheManager().init());
      await _step('读取主题设置', () => ThemeManager().init());
      await _step(
        '加载多语言资源（13 种）',
        () => Get.putAsync<LanguageService>(() => LanguageService().init()),
      );

      if (DeviceUtils.isAndroid) {
        // 原实现是 unawaited，这里保持不等待，只做记录。
        _background(
          '初始化通知中心（后台，不阻塞）',
          () => TransferWorkNotificationHub.instance.ensureInitialized(),
        );
      }

      if (!DeviceUtils.isWeb && (DeviceUtils.isIOS || DeviceUtils.isAndroid)) {
        // 同上：原来是 unawaited(clearFileCache())，不能改成 await。
        _background('清理相册文件缓存（后台，不阻塞）', () => pm.PhotoManager.clearFileCache());
      }

      await _step('注册 API 控制器', () {
        Get.put<ApiController>(ApiController(), permanent: true);
        Get.lazyPut<AuthApiService>(() => AuthApiService(), fenix: true);
        Get.lazyPut<AppearanceApiService>(() => AppearanceApiService(), fenix: true);
        Get.lazyPut<BackgroundController>(() => BackgroundController(), fenix: true);
        Get.lazyPut<CurrentUserController>(
          () => CurrentUserController(),
          fenix: true,
        );
        Get.lazyPut<HwMetricsController>(
          () => HwMetricsController(),
          fenix: true,
        );
      });

      await _step('启动音乐播放服务', () {
        Get.put(MusicPlayServiceController(), permanent: true);
      });

      await _step('装配目录同步核心', () {
        Get.lazyPut<SyncApiService>(() => SyncApiService(), fenix: true);
        // 同步引擎在 PC 端与 Windows 独立客户端之间共用，这里注入 PC 端专属的
        // 鉴权、上传实现与下载通道（直连 / P2P）。
        SyncHostHolder.instance = FlutterSyncHost.instance;
      });

      if (!DeviceUtils.isWeb && DeviceUtils.isDesktop) {
        await _step('初始化本地备份与同步控制器', () {
          Get.put(LocalBackupController(), permanent: true);
          Get.put(SyncTaskListController(), permanent: true);
        }, required: false);
        await _step('初始化托盘', () => DesktopTray.init(), required: false);
      }

      if (!DeviceUtils.isWeb && DeviceUtils.isMobile) {
        await _step('初始化相册备份控制器', () {
          Get.put(PhotoBackupController(), permanent: true);
        });
      }

      if (DeviceUtils.isWeb) {
        await _step('Web 端初始化', () {
          disableDefaultContextMenu();
          registerFvp();
        }, required: false);
      }

      await _step('准备界面', () async {
        if (!mounted) return;
        setState(() {
          _root = _WaterNasRoot(
            initialThemeMode: ThemeManager().getThemeMode(),
            initialRoute:
                DeviceUtils.isWeb ? AppRoutes.login : AppRoutes.serverList,
          );
        });
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _failed = true;
        _showDetail = true;
        _verdict = '启动在「${StartupDiag.instance.current?.name ?? '未知步骤'}」中断';
      });
    }
  }

  Future<void> _retry() async {
    StartupDiag.instance.steps.clear();
    StartupDiag.instance.revision.value++;
    StartupDiag.instance.frameworkError = null;
    _running = false;
    setState(() {
      _failed = false;
      _verdict = '';
      _showDetail = false;
      _root = null;
    });
    _detailTimer?.cancel();
    _detailTimer = Timer(const Duration(milliseconds: 1200), () {
      if (!mounted || _root != null) return;
      setState(() => _showDetail = true);
    });
    await _run();
  }

  Future<void> _shareReport() async {
    final text = StartupDiag.instance.report(verdict: _verdict);
    try {
      await Share.share(text, subject: 'WaterNasOS 启动诊断');
    } catch (_) {
      await Clipboard.setData(ClipboardData(text: text));
      if (!mounted) return;
      ScaffoldMessenger.maybeOf(context)?.showSnackBar(
        const SnackBar(content: Text('已复制到剪贴板，直接粘贴发出去即可')),
      );
    }
  }

  Future<void> _copyReport() async {
    final text = StartupDiag.instance.report(verdict: _verdict);
    await Clipboard.setData(ClipboardData(text: text));
    if (!mounted) return;
    ScaffoldMessenger.maybeOf(context)?.showSnackBar(
      const SnackBar(content: Text('已复制到剪贴板')),
    );
  }

  @override
  Widget build(BuildContext context) {
    final root = _root;
    if (root != null) return root;
    // 前 1.2 秒保持白底，尽量还原原来的启动观感，不吓到用户。
    if (!_showDetail) {
      return const ColoredBox(color: Colors.white);
    }
    return _StartupDiagnosticApp(
      failed: _failed,
      verdict: _verdict,
      onRetry: _retry,
      onShare: _shareReport,
      onCopy: _copyReport,
    );
  }
}

/// 真正的应用根（原 `_runNasCabApp` 的内容，改为返回 Widget）。
class _WaterNasRoot extends StatelessWidget {
  const _WaterNasRoot({
    required this.initialThemeMode,
    required this.initialRoute,
  });

  final ThemeMode initialThemeMode;
  final String initialRoute;

  @override
  Widget build(BuildContext context) {
    // ⭐ 配色方案 / 外观皮肤 / 字体都从持久化读取（换肤系统）。
    // 启动与设置页切换走同一个 ThemeApplyService，避免两处逻辑不一致。
    final persisted = ThemeApplyService.instance.readPersisted();
    // 滚动条粗细沿用用户设置（静态成员，只能类名访问）
    ThemeApplyService.scrollbarThicknessProvider = () =>
        _scrollbarThicknessState;

    return GetMaterialApp(
      navigatorKey: Get.key,
      title: AppLaunch.appTitle,
      // 亮/暗两套都按当前「配色 + 皮肤 + 字体」现场构建；滚动条底色取主题 outline
      // （换配色自动跟随），粗细与悬停态仍由用户设置控制（功能，不是风格）。
      theme: ThemeApplyService.instance.lightFor(
        persisted.scheme,
        skin: persisted.skin,
        fontFamily: persisted.fontFamily,
      ),
      darkTheme: ThemeApplyService.instance.darkFor(
        persisted.scheme,
        skin: persisted.skin,
        fontFamily: persisted.fontFamily,
      ),
      themeMode: initialThemeMode,
      localizationsDelegates: const [
        GlobalMaterialLocalizations.delegate,
        GlobalWidgetsLocalizations.delegate,
        GlobalCupertinoLocalizations.delegate,
        FlutterQuillLocalizations.delegate,
      ],
      supportedLocales: LanguageService.supportedLocales.keys.map((code) {
        final parts = code.split('_');
        if (parts.length == 2) return Locale(parts[0], parts[1]);
        return Locale(parts[0]);
      }).toList(),
      translations: LanguageService.to,
      locale: Get.locale,
      fallbackLocale: const Locale('zh', 'CN'),
      initialRoute: initialRoute,
      getPages: AppRoutes.getPages,
    );
  }
}

/// 启动诊断页（自带 MaterialApp，不依赖任何业务主题/多语言）。
class _StartupDiagnosticApp extends StatelessWidget {
  const _StartupDiagnosticApp({
    required this.failed,
    required this.verdict,
    required this.onRetry,
    required this.onShare,
    required this.onCopy,
  });

  final bool failed;
  final String verdict;
  final Future<void> Function() onRetry;
  final Future<void> Function() onShare;
  final Future<void> Function() onCopy;

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      debugShowCheckedModeBanner: false,
      home: _StartupDiagnosticPage(
        failed: failed,
        verdict: verdict,
        onRetry: onRetry,
        onShare: onShare,
        onCopy: onCopy,
      ),
    );
  }
}

class _StartupDiagnosticPage extends StatefulWidget {
  const _StartupDiagnosticPage({
    required this.failed,
    required this.verdict,
    required this.onRetry,
    required this.onShare,
    required this.onCopy,
  });

  final bool failed;
  final String verdict;
  final Future<void> Function() onRetry;
  final Future<void> Function() onShare;
  final Future<void> Function() onCopy;

  @override
  State<_StartupDiagnosticPage> createState() => _StartupDiagnosticPageState();
}

class _StartupDiagnosticPageState extends State<_StartupDiagnosticPage> {
  Timer? _t;

  @override
  void initState() {
    super.initState();
    _t = Timer.periodic(const Duration(milliseconds: 300), (_) {
      if (mounted) setState(() {});
    });
  }

  @override
  void dispose() {
    _t?.cancel();
    super.dispose();
  }

  Color _markColor(StartupStep s) {
    if (s.error != null) return const Color(0xFFFF6B6B);
    if (s.done) return const Color(0xFF6BD58A);
    return const Color(0xFFFFC24B);
  }

  String _markText(StartupStep s) {
    if (s.error != null) return '✗';
    if (s.done) return '✓';
    return '…';
  }

  @override
  Widget build(BuildContext context) {
    final diag = StartupDiag.instance;
    final steps = diag.steps;
    final current = diag.current;
    final stuck = current != null && !current.done;

    return Scaffold(
      backgroundColor: const Color(0xFF101418),
      body: SafeArea(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 14, 16, 8),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    widget.failed ? '启动中断' : '启动进行中',
                    style: TextStyle(
                      color: widget.failed
                          ? const Color(0xFFFF6B6B)
                          : const Color(0xFFE6EDF3),
                      fontSize: 20,
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                  const SizedBox(height: 8),
                  Text(
                    _headline(steps, stuck),
                    style: const TextStyle(
                      color: Color(0xFFE6EDF3),
                      fontSize: 14,
                      height: 1.35,
                    ),
                  ),
                  const SizedBox(height: 4),
                  if (diag.deviceInfo.isNotEmpty)
                    Text(
                      diag.deviceInfo,
                      style: const TextStyle(
                        color: Color(0xFF8B98A5),
                        fontSize: 11.5,
                        height: 1.35,
                      ),
                    ),
                  if (diag.appInfo.isNotEmpty)
                    Text(
                      diag.appInfo,
                      style: const TextStyle(
                        color: Color(0xFF8B98A5),
                        fontSize: 11.5,
                        height: 1.35,
                      ),
                    ),
                ],
              ),
            ),
            const Divider(height: 1, color: Color(0xFF232B33)),
            Expanded(
              child: ListView.builder(
                padding: const EdgeInsets.fromLTRB(16, 10, 16, 10),
                itemCount: steps.length,
                itemBuilder: (context, i) {
                  final s = steps[i];
                  final isCurrent = identical(s, current) && !s.done;
                  return Container(
                    margin: const EdgeInsets.only(bottom: 8),
                    padding: const EdgeInsets.symmetric(
                      horizontal: 10,
                      vertical: 8,
                    ),
                    decoration: BoxDecoration(
                      color: isCurrent
                          ? const Color(0x14FFC24B)
                          : const Color(0xFF171D23),
                      borderRadius: BorderRadius.circular(8),
                      border: Border.all(
                        color: isCurrent
                            ? const Color(0x66FFC24B)
                            : const Color(0xFF232B33),
                      ),
                    ),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Row(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            SizedBox(
                              width: 20,
                              child: Text(
                                _markText(s),
                                style: TextStyle(
                                  color: _markColor(s),
                                  fontSize: 14,
                                  fontWeight: FontWeight.w700,
                                ),
                              ),
                            ),
                            Expanded(
                              child: Text(
                                s.name,
                                style: TextStyle(
                                  color: _markColor(s),
                                  fontSize: 13.5,
                                  height: 1.3,
                                  fontWeight: isCurrent
                                      ? FontWeight.w600
                                      : FontWeight.w500,
                                ),
                              ),
                            ),
                            const SizedBox(width: 8),
                            Text(
                              s.elapsedText,
                              style: TextStyle(
                                color: isCurrent
                                    ? const Color(0xFFFFC24B)
                                    : const Color(0xFF8B98A5),
                                fontSize: 12,
                              ),
                            ),
                          ],
                        ),
                        if (s.detail != null && s.detail!.isNotEmpty)
                          Padding(
                            padding: const EdgeInsets.only(left: 20, top: 4),
                            child: Text(
                              s.detail!,
                              style: const TextStyle(
                                color: Color(0xFF8B98A5),
                                fontSize: 11.5,
                                height: 1.35,
                              ),
                            ),
                          ),
                        if (s.error != null)
                          Padding(
                            padding: const EdgeInsets.only(left: 20, top: 4),
                            child: SelectableText(
                              '${s.error}',
                              style: const TextStyle(
                                color: Color(0xFFFF9C9C),
                                fontSize: 11.5,
                                height: 1.35,
                              ),
                            ),
                          ),
                      ],
                    ),
                  );
                },
              ),
            ),
            if (diag.frameworkError != null)
              Container(
                width: double.infinity,
                color: const Color(0x22FF6B6B),
                padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
                child: SelectableText(
                  '框架异常: ${diag.frameworkError}',
                  style: const TextStyle(
                    color: Color(0xFFFF9C9C),
                    fontSize: 11.5,
                  ),
                ),
              ),
            Container(
              padding: const EdgeInsets.fromLTRB(12, 10, 12, 12),
              decoration: const BoxDecoration(
                border: Border(top: BorderSide(color: Color(0xFF232B33))),
              ),
              child: Row(
                children: [
                  Expanded(
                    child: FilledButton.icon(
                      onPressed: () => widget.onShare(),
                      style: FilledButton.styleFrom(
                        backgroundColor: const Color(0xFF2F81F7),
                        foregroundColor: Colors.white,
                        padding: const EdgeInsets.symmetric(vertical: 12),
                      ),
                      icon: const Icon(Icons.ios_share, size: 18),
                      label: const Text('发给开发者'),
                    ),
                  ),
                  const SizedBox(width: 8),
                  OutlinedButton(
                    onPressed: () => widget.onCopy(),
                    style: OutlinedButton.styleFrom(
                      foregroundColor: const Color(0xFFE6EDF3),
                      side: const BorderSide(color: Color(0xFF303A44)),
                      padding: const EdgeInsets.symmetric(
                        horizontal: 14,
                        vertical: 12,
                      ),
                    ),
                    child: const Text('复制'),
                  ),
                  const SizedBox(width: 8),
                  OutlinedButton(
                    onPressed: () => widget.onRetry(),
                    style: OutlinedButton.styleFrom(
                      foregroundColor: const Color(0xFFE6EDF3),
                      side: const BorderSide(color: Color(0xFF303A44)),
                      padding: const EdgeInsets.symmetric(
                        horizontal: 14,
                        vertical: 12,
                      ),
                    ),
                    child: const Text('重试'),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  String _headline(List<StartupStep> steps, bool stuck) {
    if (widget.verdict.isNotEmpty) return widget.verdict;
    if (stuck) {
      final cur = steps.last;
      return '卡在第 ${steps.length} 步：${cur.name}（已等待 ${cur.elapsedText}）\n截图或点下方按钮发给我即可。';
    }
    return '启动较慢：已完成 ${steps.where((s) => s.done).length}/${steps.length} 步';
  }
}
