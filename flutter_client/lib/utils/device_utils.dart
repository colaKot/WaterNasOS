import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'device_utils_web.dart'
    if (dart.library.io) 'device_utils_io.dart'
    as platform;

class DeviceUtils {
  static const double phoneBreakpoint = 600;
  static const double desktopBreakpoint = 600;

  static double _webLogicalWidth() {
    try {
      final views = WidgetsBinding.instance.platformDispatcher.views;
      if (views.isEmpty) return 0;
      final view = views.first;
      final dpr = view.devicePixelRatio <= 0 ? 1.0 : view.devicePixelRatio;
      return view.physicalSize.width / dpr;
    } catch (_) {
      return 0;
    }
  }

  static bool _webUserAgentIsMobile() {
    try {
      final userAgent = platform.getWebUserAgent();
      if (userAgent.isEmpty) return false;
      final lower = userAgent.toLowerCase();
      return lower.contains('mobile') ||
          lower.contains('android') ||
          lower.contains('iphone') ||
          lower.contains('ipod') ||
          lower.contains('webos') ||
          lower.contains('blackberry') ||
          lower.contains('windows phone');
    } catch (_) {
      return false;
    }
  }

  /// Web：仅当 UA 同时满足 Safari 典型结构（Apple 文档中的 Version/ 与 WebKit 构建号）。
  /// 真 Safari 为 `Safari/604`、`Safari/605` 等（≥600）；Chromium 兼容字段为 `Safari/537.x`，不满足。
  static bool get isWebSafariBrowser {
    if (!kIsWeb) return false;
    try {
      final ua = platform.getWebUserAgent();
      if (ua.isEmpty) return false;
      if (!RegExp(r'Version/\d').hasMatch(ua)) return false;
      final m = RegExp(r'Safari/(\d+)').firstMatch(ua);
      if (m == null) return false;
      final major = int.tryParse(m.group(1)!) ?? 0;
      return major >= 600;
    } catch (_) {
      return false;
    }
  }

  /// 检测当前是否为桌面设备
  static bool get isDesktop {
    if (kIsWeb) {
      return _webLogicalWidth() >= desktopBreakpoint;
    }

    return defaultTargetPlatform == TargetPlatform.windows ||
        defaultTargetPlatform == TargetPlatform.macOS ||
        defaultTargetPlatform == TargetPlatform.linux;
  }

  /// 检测当前是否为移动设备
  static bool get isMobile {
    if (kIsWeb) {
      final w = _webLogicalWidth();
      return w > 0 && w < phoneBreakpoint && _webUserAgentIsMobile();
    }

    return defaultTargetPlatform == TargetPlatform.android ||
        defaultTargetPlatform == TargetPlatform.iOS;
  }

  /// 原生手机 App（非 web、非桌面）。
  /// 相册备份等「仅手机端可用」的能力用这个判断 —— 桌面/web 不注册备份控制器，
  /// 入口露出来点进去也是空白。
  static bool get isNativeMobile => !kIsWeb && isMobile;

  /// 检测当前是否为Web平台
  static bool get isWeb => kIsWeb;

  static bool get isDesktopOrWeb => isDesktop || isWeb;

  static bool get isAndroid =>
      !kIsWeb && defaultTargetPlatform == TargetPlatform.android;

  static bool get isIOS =>
      !kIsWeb && defaultTargetPlatform == TargetPlatform.iOS;

  static bool get isWindows =>
      !kIsWeb && defaultTargetPlatform == TargetPlatform.windows;

  static bool get isMacOS =>
      !kIsWeb && defaultTargetPlatform == TargetPlatform.macOS;

  static bool get isLinux =>
      !kIsWeb && defaultTargetPlatform == TargetPlatform.linux;

  static bool get isFuchsia =>
      !kIsWeb && defaultTargetPlatform == TargetPlatform.fuchsia;

  /// 服务端「按端隔离配置」用的客户端类型键（2026-10-12）。
  ///
  /// ⚠️ 必须与 `electron_server/src/api/modules/video/config/videoConfigController.js`
  /// 里的 `CLIENT_TYPE_KEYS` = ['web','android','ios','desktop'] 一字不差，
  /// 否则服务端会把请求归一成空串，退化成「所有端共用一份配置」。
  /// 用途：播放默认画质 / 音频降混这类「每端各自一份」的用户偏好。
  static String get clientTypeKey {
    if (kIsWeb) return 'web';
    switch (defaultTargetPlatform) {
      case TargetPlatform.android:
        return 'android';
      case TargetPlatform.iOS:
        return 'ios';
      case TargetPlatform.windows:
      case TargetPlatform.macOS:
      case TargetPlatform.linux:
        return 'desktop';
      default:
        return 'desktop';
    }
  }

  /// 获取设备平台名称
  static String get platformName {
    if (kIsWeb) {
      return 'Web';
    }

    switch (defaultTargetPlatform) {
      case TargetPlatform.android:
        return 'Android';
      case TargetPlatform.iOS:
        return 'iOS';
      case TargetPlatform.windows:
        return 'Windows';
      case TargetPlatform.macOS:
        return 'macOS';
      case TargetPlatform.linux:
        return 'Linux';
      case TargetPlatform.fuchsia:
        return 'Fuchsia';
    }
  }

  /// 根据屏幕宽度判断是否为平板设备
  static bool isTablet(BuildContext context) {
    final width = MediaQuery.of(context).size.width;
    return width >= phoneBreakpoint;
  }

  /// 根据屏幕宽度判断是否为手机设备
  static bool isPhone(BuildContext context) {
    final width = MediaQuery.of(context).size.width;
    return !isDesktopOrWeb && (width < phoneBreakpoint || isMobile);
  }

  static bool isTabletLayout(BuildContext context) {
    final width = MediaQuery.of(context).size.width;
    return width >= phoneBreakpoint && width < desktopBreakpoint;
  }

  static bool isDesktopLayout(BuildContext context) {
    final width = MediaQuery.of(context).size.width;
    return width >= desktopBreakpoint;
  }

  /// 获取设备屏幕信息
  static String getScreenInfo(BuildContext context) {
    final size = MediaQuery.of(context).size;
    final orientation = MediaQuery.of(context).orientation;

    return '屏幕尺寸: ${size.width.toStringAsFixed(1)} x ${size.height.toStringAsFixed(1)}, 方向: ${orientation == Orientation.portrait ? '竖屏' : '横屏'}';
  }
}
