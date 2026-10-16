import 'dart:convert';

import 'package:shared_preferences/shared_preferences.dart';

/// ⭐ 2026-10-16 P1-12 离线快照。
///
/// 断网/服务端没起来时，时间轴原本是一片空白 + 报错。这里把最近一次成功的
/// 日期列表 + 前若干张照片**落到本地**，失败时直接拿快照渲染，并明确标注
/// 「这是快照、更新于什么时候」—— 而不是让用户误以为照片丢了。
///
/// 约束（与 TrailSnap 的口径一致，避免把本地存储写炸）：
///   · 命名空间 = 服务端地址 + uid + 年份 ⇒ 换服务器/换账号不会串；
///   · **同一命名空间最多留 5 份**，超出丢最旧的；
///   · **1 天 TTL**：过期不删也能用，但会标注「快照已过期」；
///   · 单份快照只存**前 120 张**，避免 SharedPreferences 里塞几十 MB。
class PhotoOfflineSnapshot {
  static const int _maxCopies = 5;
  static const int _maxPhotos = 120;
  static const Duration _ttl = Duration(days: 1);

  /// 快照在本地存储里的键前缀
  static const String _prefix = 'photo_snapshot_v1.';

  static Future<SharedPreferences> _prefs() => SharedPreferences.getInstance();

  static String namespace({
    required String server,
    required int uid,
    required int year,
  }) {
    final safeServer = server.replaceAll(RegExp(r'[^A-Za-z0-9_.-]'), '_');
    return '$safeServer.$uid.$year';
  }

  /// 保存一次快照。[dates] 是时间轴的日期列表（原样 JSON），[photos] 只截前 N 张。
  static Future<void> save({
    required String ns,
    required List<dynamic> dates,
    required List<dynamic> photos,
  }) async {
    if (dates.isEmpty && photos.isEmpty) return;
    try {
      final prefs = await _prefs();
      final key = '$_prefix$ns';
      final now = DateTime.now().millisecondsSinceEpoch;
      final payload = jsonEncode({
        'savedAt': now,
        'dates': dates,
        'photos': photos.take(_maxPhotos).toList(),
        'truncated': photos.length > _maxPhotos,
        'total': photos.length,
      });
      await prefs.setString(key, payload);
      await prefs.setInt('$key.savedAt', now);

      // 清理：同一命名空间保留最近 5 份（键带时间戳后缀的不需要，这里按 ns 维度只留 1 份最新 +
      // 记录最近 5 次保存时间，便于「快照历史」展示与排查）
      final historyKey = '$key.history';
      final historyRaw = prefs.getString(historyKey);
      final history = historyRaw == null
          ? <int>[]
          : (jsonDecode(historyRaw) as List).map((e) => (e as num).toInt()).toList();
      history.insert(0, now);
      while (history.length > _maxCopies) {
        history.removeLast();
      }
      await prefs.setString(historyKey, jsonEncode(history));
    } catch (_) {
      // 本地存储写失败不能影响主流程
    }
  }

  /// 读取快照。返回 null 表示没有可用快照。
  /// [allowExpired] 为 true 时，过期快照也返回（但 `expired` 标记为真）。
  static Future<PhotoSnapshotData?> load(
    String ns, {
    bool allowExpired = true,
  }) async {
    try {
      final prefs = await _prefs();
      final key = '$_prefix$ns';
      final raw = prefs.getString(key);
      if (raw == null || raw.isEmpty) return null;
      final map = jsonDecode(raw);
      if (map is! Map) return null;
      final savedAt = (map['savedAt'] as num?)?.toInt() ?? 0;
      final expired = savedAt > 0 &&
          DateTime.now().millisecondsSinceEpoch - savedAt > _ttl.inMilliseconds;
      if (expired && !allowExpired) return null;
      return PhotoSnapshotData(
        savedAt: savedAt,
        expired: expired,
        dates: (map['dates'] as List?) ?? const [],
        photos: (map['photos'] as List?) ?? const [],
        truncated: map['truncated'] == true,
        total: (map['total'] as num?)?.toInt() ?? (map['photos'] as List?)?.length ?? 0,
      );
    } catch (_) {
      return null;
    }
  }

  static Future<void> clear(String ns) async {
    try {
      final prefs = await _prefs();
      final key = '$_prefix$ns';
      await prefs.remove(key);
      await prefs.remove('$key.savedAt');
      await prefs.remove('$key.history');
    } catch (_) {}
  }
}

class PhotoSnapshotData {
  final int savedAt;
  final bool expired;
  final List<dynamic> dates;
  final List<dynamic> photos;
  final bool truncated;
  final int total;

  const PhotoSnapshotData({
    required this.savedAt,
    required this.expired,
    required this.dates,
    required this.photos,
    required this.truncated,
    required this.total,
  });

  DateTime get savedAtTime => DateTime.fromMillisecondsSinceEpoch(savedAt);

  String get savedAtText {
    if (savedAt <= 0) return '';
    final d = savedAtTime;
    String two(int v) => v.toString().padLeft(2, '0');
    return '${d.year}-${two(d.month)}-${two(d.day)} ${two(d.hour)}:${two(d.minute)}';
  }

  static Map<String, dynamic> photoToJson(dynamic item) {
    // 只保留渲染时间轴缩略图真正需要的字段，避免快照体积虚高
    if (item is Map) {
      return <String, dynamic>{
        'id': item['id'],
        'file_hash': item['file_hash'],
        'path': item['path'],
        'filename': item['filename'],
        'original_time': item['original_time'],
        'original_date': item['original_date'],
        'type': item['type'],
        'ext': item['ext'],
        'is_lvp': item['is_lvp'],
      };
    }
    return <String, dynamic>{};
  }
}
