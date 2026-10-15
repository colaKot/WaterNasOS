import 'dart:html' as html;
import 'dart:math';

/// 设备标识：web 实现。
///
/// 浏览器没有机器级身份，用 localStorage 里持久化的随机 id：
/// 每个浏览器 profile 是一个独立「设备」。跨浏览器 / 跨机器天然隔离；
/// 同一浏览器重复打开解析结果稳定。
///
/// 说明：这里刻意用 SDK 自带的 dart:html 而不是 package:web —— 核心包不想
/// 为这一个文件多背一个外部依赖（离线环境解析不到就等于 web 端同步全挂）。
class SyncDeviceId {
  SyncDeviceId._();

  static const String _storageKey = 'nascab_sync.device_id';

  static String? _cached;

  static Future<String> resolve() async {
    final hit = _cached;
    if (hit != null && hit.isNotEmpty) return hit;
    final storage = html.window.localStorage;
    final existing = (storage[_storageKey] ?? '').trim();
    if (existing.isNotEmpty) {
      _cached = existing;
      return existing;
    }
    final rand = Random();
    const hex = '0123456789abcdef';
    final buf = StringBuffer('web-');
    for (var i = 0; i < 16; i++) {
      buf.write(hex[rand.nextInt(16)]);
    }
    final id = buf.toString();
    storage[_storageKey] = id;
    _cached = id;
    return id;
  }

  /// 设备展示名：Web 端没有主机名概念，固定返回空串由调用方兜底。
  static Future<String> resolveName() async => '';
}
