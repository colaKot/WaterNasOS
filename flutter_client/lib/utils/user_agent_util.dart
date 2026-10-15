import 'dart:io';
import 'package:device_info_plus/device_info_plus.dart';
import 'package:package_info_plus/package_info_plus.dart';
import 'package:flutter/foundation.dart';
import 'package:uuid/uuid.dart';
import '../core/bootstrap/app_launch.dart';
import 'cache_manager.dart';

class UserAgentUtil {
  static String? _cachedUserAgent;
  static Map<String, String>? _cachedPlatformInfo;

  /// 获取User-Agent字符串
  /// 格式: AppName/Version (Platform; OS Version; Device Model)
  static Future<String> getUserAgent() async {
    if (_cachedUserAgent != null) {
      return _cachedUserAgent!;
    }

    try {
      final packageInfo = await PackageInfo.fromPlatform();
      final appName = _headerSafeAppName();
      final version = _headerSafe(packageInfo.version);
      final buildNumber = _headerSafe(packageInfo.buildNumber);

      final info = await _getPlatformInfo();
      final platformInfo = _headerSafe(info['platform'] ?? 'Unknown');
      final osVersion = _headerSafe(info['osVersion'] ?? 'Unknown');
      final deviceModel = _headerSafe(info['deviceModel'] ?? 'Unknown');

      // 构建User-Agent
      // NasCab/1.0.0+1 (Android; 12; Google Pixel 6)
      _cachedUserAgent =
          '$appName/$version+$buildNumber ($platformInfo; $osVersion; $deviceModel)';
    } catch (e) {
      print('Error generating User-Agent: $e');
      _cachedUserAgent = 'NasCabClient/Unknown';
    }

    return _cachedUserAgent!;
  }

  /// ⛔ HTTP 头值必须能编码为 latin1（可打印 ASCII）。
  ///
  /// dart:io 会在**写 socket 阶段**对非法头值抛
  /// `FormatException: Invalid HTTP header field value`，而调用方
  /// （`base_api_service._requestInterceptor`）的 try/catch 只包了「赋值」那一行，
  /// 包不住「发送」阶段 ⇒ 结果是**该客户端所有请求全部失败**，
  /// 在登录页只会显示「登录失败」，完全误导。
  ///
  /// 实际踩雷（2026-10-13）：相册/音乐独立端的 `PackageInfo.appName` 取自
  /// `android:label`，当时是「WaterNasOS 相册」这类含中文的值 ⇒ UA 含中文 ⇒
  /// 该端**全盘连不上服务器**。现已两头收口：各端 label 改成 ASCII 短名
  /// （WNClient / WNPhoto / WNMusic），且本函数按 mode 返回固定 ASCII 全名。
  static String _headerSafe(String raw) {
    final sb = StringBuffer();
    for (final r in raw.runes) {
      if (r >= 0x20 && r <= 0x7E) sb.writeCharCode(r);
    }
    return sb.toString().trim();
  }

  /// 应用名：**完全按启动模式取固定的 ASCII 全名**，不再依赖 `PackageInfo.appName`。
  ///
  /// 这样 UA 与各平台的显示名彻底解耦 —— 安卓图标名是短名（`WNClient` /
  /// `WNPhoto` / `WNMusic`）、Windows 是 `ProductName`，以后改显示名不会再波及 UA，
  /// 也就不会再出现「改个名字把整端网络改挂」这种事。
  ///
  /// 服务端 `uaUtil.js` 是按 UA 的 `名字/版本 (...)` **结构**解析、不认字面量，
  /// 所以这套全名可以直接换。
  static String _headerSafeAppName() {
    switch (AppLaunch.mode) {
      case AppLaunchMode.full:
        return 'WaterNasClient';
      case AppLaunchMode.photo:
        return 'WaterNasPhoto';
      case AppLaunchMode.music:
        return 'WaterNasMusic';
    }
  }

  static Future<Map<String, String>> _getPlatformInfo() async {
    if (_cachedPlatformInfo != null) {
      return _cachedPlatformInfo!;
    }

    String platformInfo = 'Unknown';
    String osVersion = 'Unknown';
    String deviceModel = 'Unknown';

    final deviceInfo = DeviceInfoPlugin();

    if (kIsWeb) {
      final webBrowserInfo = await deviceInfo.webBrowserInfo;
      platformInfo = 'Web';
      osVersion = webBrowserInfo.userAgent ?? '';
      deviceModel = webBrowserInfo.browserName.toString();
    } else {
      if (Platform.isAndroid) {
        final androidInfo = await deviceInfo.androidInfo;
        platformInfo = 'Android';
        osVersion = androidInfo.version.release;
        deviceModel = '${androidInfo.manufacturer} ${androidInfo.model}';
      } else if (Platform.isIOS) {
        final iosInfo = await deviceInfo.iosInfo;
        platformInfo = 'iOS';
        osVersion = iosInfo.systemVersion;
        deviceModel = iosInfo.name;
      } else if (Platform.isMacOS) {
        final macOsInfo = await deviceInfo.macOsInfo;
        platformInfo = 'macOS';
        osVersion =
            '${macOsInfo.majorVersion}.${macOsInfo.minorVersion}.${macOsInfo.patchVersion}';
        deviceModel = macOsInfo.model;
      } else if (Platform.isWindows) {
        final windowsInfo = await deviceInfo.windowsInfo;
        platformInfo = 'Windows';
        osVersion = '${windowsInfo.majorVersion}.${windowsInfo.minorVersion}';
        deviceModel = 'PC';
      } else if (Platform.isLinux) {
        final linuxInfo = await deviceInfo.linuxInfo;
        platformInfo = 'Linux';
        osVersion = linuxInfo.versionId ?? '';
        deviceModel = linuxInfo.name;
      }
    }

    _cachedPlatformInfo = {
      'platform': platformInfo,
      'osVersion': osVersion,
      'deviceModel': deviceModel,
    };
    return _cachedPlatformInfo!;
  }

  static Future<String> _getOrCreateStorageId() async {
    final cache = CacheManager();
    final existing = cache.getString(CacheKeys.deviceFingerprintSeed);
    if (existing != null && existing.trim().isNotEmpty) return existing;
    final id = const Uuid().v4();
    await cache.setString(CacheKeys.deviceFingerprintSeed, id);
    return id;
  }

  static Future<String> getOrCreatePersistentDeviceId() async {
    return await _getOrCreateStorageId();
  }

  static String getOrCreateVideoPlayerDeviceIdSync() {
    final cache = CacheManager();
    final existing = cache.getString(CacheKeys.videoPlayerDeviceId);
    if (existing != null && existing.trim().isNotEmpty) return existing.trim();
    final id = const Uuid().v4();
    cache.setString(CacheKeys.videoPlayerDeviceId, id);
    return id;
  }

  /// 设备展示名（用于相册备份的默认目录名，如 `Xiaomi 14` / `iPhone 15` / `PC`）。
  /// 与 [getDeviceFingerprintPayload] 的 `device_name` 不同：这里不带平台前缀，更适合做目录名。
  static Future<String> getDeviceDisplayName() async {
    try {
      if (kIsWeb) return 'Web';
      final deviceInfo = DeviceInfoPlugin();
      if (Platform.isAndroid) {
        final a = await deviceInfo.androidInfo;
        final model = a.model.trim();
        return model.isEmpty ? 'Android' : model;
      }
      if (Platform.isIOS) {
        final i = await deviceInfo.iosInfo;
        final name = i.name.trim();
        return name.isEmpty ? 'iPhone' : name;
      }
      // 桌面端统一取主机名（避免依赖各平台结构体的字段名差异）
      final host = Platform.localHostname.trim();
      if (host.isNotEmpty) return host;
      if (Platform.isMacOS) return 'Mac';
      if (Platform.isWindows) return 'PC';
      if (Platform.isLinux) return 'Linux';
    } catch (_) {}
    return 'Device';
  }

  static Future<Map<String, dynamic>> getDeviceFingerprintPayload() async {
    final userAgent = await getUserAgent();
    final info = await _getPlatformInfo();
    final locale = PlatformDispatcher.instance.locale.toLanguageTag();
    final now = DateTime.now();
    final storageId = await _getOrCreateStorageId();
    final deviceName = '${info['platform'] ?? ''} ${info['deviceModel'] ?? ''}'
        .trim();

    return {
      'user_agent': userAgent,
      'platform': info['platform'],
      'os_version': info['osVersion'],
      'device_model': info['deviceModel'],
      'device_name': deviceName,
      'language': locale,
      'timezone_offset': now.timeZoneOffset.inMinutes,
      'timezone_name': now.timeZoneName,
      'storage_id': storageId,
      'storage_type': 'shared_preferences',
    };
  }
}
