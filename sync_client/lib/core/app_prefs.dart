import 'dart:io';

import 'package:nascab_sync_core/nascab_sync_core.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// 应用级偏好 + 本机设备标识。
///
/// 同步任务在服务端按「设备」登记，独立客户端需要稳定上报同一个 device_id，
/// 否则每次运行都会被当成一台新电脑。
class AppPrefs {
  AppPrefs._();

  static const String _kAutoStart = 'nascab_sync.auto_start';
  static const String _kAutoSyncPaused = 'nascab_sync.auto_sync_paused';
  static const String _kDeviceName = 'nascab_sync.device_name';

  static SharedPreferences? _prefs;

  static Future<SharedPreferences> _sp() async =>
      _prefs ??= await SharedPreferences.getInstance();

  // ── 开机自启 ──

  static Future<bool> getAutoStart() async {
    final sp = await _sp();
    return sp.getBool(_kAutoStart) ?? false;
  }

  static Future<void> setAutoStart(bool value) async {
    final sp = await _sp();
    await sp.setBool(_kAutoStart, value);
  }

  // ── 全局暂停（托盘菜单控制） ──

  static Future<bool> getAutoSyncPaused() async {
    final sp = await _sp();
    return sp.getBool(_kAutoSyncPaused) ?? false;
  }

  static Future<void> setAutoSyncPaused(bool value) async {
    final sp = await _sp();
    await sp.setBool(_kAutoSyncPaused, value);
  }

  // ── 设备标识 ──

  /// 设备 ID：本机机器级标识（与主客户端同一套解析，见核心包 SyncDeviceId）。
  ///
  /// 2026-10-12 之前这里是「每安装一个随机 UUID」，导致同一台机器上
  /// 独立同步客户端与主客户端被当成两台设备、任务互不相通；现在改为
  /// OS 机器级标识（Windows MachineGuid 等），同机一致、换机必不同。
  static Future<String> getDeviceId() => SyncDeviceId.resolve();

  /// 设备名（本地展示用，用户可改名）：默认取本机主机名。
  /// 注意：上报给服务端的 device_name 统一用主机名，避免两个客户端互相覆盖。
  static Future<String> getDeviceName() async {
    final sp = await _sp();
    final cached = sp.getString(_kDeviceName);
    if (cached != null && cached.isNotEmpty) return cached;

    String name;
    try {
      name = Platform.localHostname;
    } catch (_) {
      name = 'Windows 电脑';
    }
    if (name.trim().isEmpty) name = 'Windows 电脑';
    await sp.setString(_kDeviceName, name);
    return name;
  }

  static Future<void> setDeviceName(String name) async {
    final sp = await _sp();
    await sp.setString(_kDeviceName, name.trim());
  }
}
