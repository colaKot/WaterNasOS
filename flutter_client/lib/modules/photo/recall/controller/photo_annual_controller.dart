import 'package:get/get.dart';

import 'package:WaterNasOS/modules/photo/ai_setting/service/photo_ai_settings_api_service.dart';

/// ⭐ 2026-10-19 年度总结控制器（GetBuilder 版，重写）。
///
/// 上一版把整页押在 `RxMap` + `Obx` 上：只要 build 期有一次读取/类型异常，
/// release 下 ErrorWidget 就是一块灰底 ⇒ 三个端看到的都是「灰白一片」，
/// 控制台还只剩一句 `Instance of 'minified:xxx'`。
///
/// 这一版刻意退到最朴素的结构：
///   · 状态用普通字段，改完调 `update()`；不依赖 Rx 的懒初始化、不依赖引用相等；
///   · 所有数值都过一遍 `_int()` / `_list()`，服务端字段缺失就是 0 / 空列表；
///   · 出错只落到 `error` 文案上，永远不再把异常抛进 widget 树。
class PhotoAnnualController extends GetxController {
  PhotoAiSettingsApiService get _api => PhotoAiSettingsApiService.instance;

  int year = DateTime.now().year;
  bool loading = true;
  String? error;
  Map<String, dynamic> report = const <String, dynamic>{};

  /// 可切换的年份（当前年往前 5 年）
  List<int> get years {
    final now = DateTime.now().year;
    return [for (var i = 0; i < 5; i++) now - i];
  }

  @override
  void onInit() {
    super.onInit();
    // 放到 microtask：GetBuilder 的 init 发生在 initState，此时同步 update() 会在
    // 父级 build 过程中触发重建（release 静默、debug 直接 assert）。
    Future.microtask(load);
  }

  Future<void> load({int? target}) async {
    final y = target ?? year;
    year = y;
    loading = true;
    error = null;
    update();
    try {
      final res = await _api.getYearReport(y);
      if (!res.success || res.data == null) {
        error = 'operation_failed'.tr;
        report = const <String, dynamic>{};
      } else {
        report = res.data!;
      }
    } catch (_) {
      error = 'operation_failed'.tr;
      report = const <String, dynamic>{};
    } finally {
      loading = false;
      update();
    }
  }

  bool get isEmpty => report.isEmpty || report['empty'] == true;

  int get total => _int(report['total']);
  int get videos => _int(report['videos']);
  int get cities => _int(report['cities']);
  int get activeDays => _int(report['active_days']);
  int get videoSeconds => _int(report['video_seconds']);
  int get bytes => _int(report['bytes']);
  int get places => _int(report['places']);

  List<int> get months {
    final raw = report['months'];
    if (raw is! List) return const <int>[];
    return [for (final e in raw) _int(e)];
  }

  List<Map<String, dynamic>> get categories => _list(report['categories']);
  List<Map<String, dynamic>> get seasons => _list(report['seasons']);
  List<Map<String, dynamic>> get topPeople => _list(report['top_people']);
  List<Map<String, dynamic>> get topScenes => _list(report['top_scenes']);
  List<Map<String, dynamic>> get topActivities => _list(report['top_activities']);
  List<Map<String, dynamic>> get topCameras => _list(report['top_cameras']);
  List<Map<String, dynamic>> get busyDays => _list(report['busy_days']);

  Map<String, dynamic> get farthest {
    final raw = report['farthest'];
    if (raw is Map) return raw.cast<String, dynamic>();
    return const <String, dynamic>{};
  }

  /// 视频总时长文案：<1 分钟按秒、<1 小时按分钟、否则 x 小时 y 分
  String get videoDurationText {
    final s = videoSeconds;
    if (s <= 0) return '0';
    if (s < 60) return '$s ${'photo_annual_second'.tr}';
    if (s < 3600) return '${(s / 60).round()} ${'photo_annual_minute'.tr}';
    final h = s ~/ 3600;
    final m = ((s % 3600) / 60).round();
    return m == 0
        ? '$h ${'photo_annual_hour'.tr}'
        : '$h ${'photo_annual_hour'.tr} $m ${'photo_annual_minute'.tr}';
  }

  /// 封面的挑选口径：四季里张数最多、且真有封面图的那一季。
  String get heroCover {
    var best = '';
    var bestCount = 0;
    for (final s in seasons) {
      final c = _int(s['count']);
      final cover = (s['cover_path'] ?? '').toString();
      if (cover.isNotEmpty && c > bestCount) {
        bestCount = c;
        best = cover;
      }
    }
    return best;
  }

  int _int(dynamic v) {
    if (v is num) return v.toInt();
    if (v == null) return 0;
    return int.tryParse(v.toString()) ?? 0;
  }

  List<Map<String, dynamic>> _list(dynamic raw) {
    if (raw is! List) return const <Map<String, dynamic>>[];
    final out = <Map<String, dynamic>>[];
    for (final e in raw) {
      if (e is Map) out.add(e.cast<String, dynamic>());
    }
    return out;
  }
}
