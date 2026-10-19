import 'package:get/get.dart';

import 'package:WaterNasOS/core/api/base_api_service.dart';
import 'package:WaterNasOS/modules/photo/ai_setting/service/photo_ai_settings_api_service.dart';

/// ⭐ 2026-10-18 相册首页看板控制器。
///
/// 一次进场只打两个请求：
///   1) `/photo/app_ai/home_summary` —— 我的照片 / 拍摄时光 / 足迹 / 人物 / 那年今日
///   2) `/photo/app_ai/memories`     —— 「发现新的记忆」用候选列表前几
/// 两个请求互相独立（任一失败另一张卡照常显示），所以用 Future.wait 并行 + 各自兜底。
class PhotoDashboardController extends GetxController {
  PhotoAiSettingsApiService get _api => PhotoAiSettingsApiService.instance;

  final RxBool loading = true.obs;
  final RxnString error = RxnString();
  final RxMap<String, dynamic> summary = <String, dynamic>{}.obs;
  final RxList<Map<String, dynamic>> memoryCandidates = <Map<String, dynamic>>[].obs;

  @override
  void onInit() {
    super.onInit();
    load();
  }

  Future<void> load() async {
    loading.value = true;
    error.value = null;
    try {
      final results = await Future.wait<Object?>([
        _api.getHomeSummary(),
        _api.getMemories(days: 400, minPhotos: 6),
      ]);
      final home = results[0];
      final mem = results[1];
      var anyOk = false;
      if (home is ApiResponse<Map<String, dynamic>> && home.success && home.data != null) {
        summary.assignAll(home.data!);
        anyOk = true;
      }
      if (mem is ApiResponse<Map<String, dynamic>> && mem.success && mem.data != null) {
        memoryCandidates.assignAll(_asList(mem.data!['candidates']));
        anyOk = true;
      }
      if (!anyOk) {
        error.value = 'operation_failed'.tr;
      }
    } catch (_) {
      error.value = 'operation_failed'.tr;
    } finally {
      loading.value = false;
    }
  }

  // ---------------------------------------------------------------- 便捷读取

  Map<String, dynamic> get library => _mapOf(summary['library']);

  Map<String, dynamic> get heat => _mapOf(summary['heat']);

  Map<String, dynamic> get footprint => _mapOf(summary['footprint']);

  Map<String, dynamic> get people => _mapOf(summary['people']);

  List<Map<String, dynamic>> get onThisDay => _asList(summary['on_this_day']);

  List<Map<String, dynamic>> get heatDays => _asList(heat['days']);

  List<Map<String, dynamic>> get heatYears => _asList(heat['by_year']);

  List<Map<String, dynamic>> get topPeople => _asList(people['items']);

  int get photoCount => _intOf(library['photos']);

  int get videoCount => _intOf(library['videos']);

  int get totalCount => _intOf(library['total']);

  int get todayNew => _intOf(library['today_new']);

  int get totalBytes => _intOf(library['bytes']);

  int get heatTotal => _intOf(heat['total']);

  int get heatActiveDays => _intOf(heat['active_days']);

  int get cityCount => _intOf(footprint['cities']);

  int get placeCount => _intOf(footprint['places']);

  int get footprintDays => _intOf(footprint['days']);

  int get pendingFaces => _intOf(people['pending']);

  /// 最新一个有照片的年份（用于「年度回忆录」文案）
  int get latestYear =>
      heatYears.isEmpty ? DateTime.now().year : _intOf(heatYears.first['year']);

  /// 峰值月 + 张数（用于拍摄时光卡片左下角）
  ///
  /// ⚠️ 必须带上**年份**：`heat.days` 是「近 365 天」，跨年之后峰值月很可能落在去年。
  /// 以前只回 month，前端拿 `DateTime.now().year` 去拼文案 ⇒ 2026 年 10 月打开首页，
  /// 会说「2026 年 12 月拍摄最多」—— 12 月根本还没到。
  ({int year, int month, int count}) get peakMonth {
    final days = heatDays;
    if (days.isEmpty) return (year: 0, month: 0, count: 0);
    final byMonth = <String, int>{};
    for (final d in days) {
      final date = (d['date'] ?? '').toString();
      if (date.length < 7) continue;
      final key = date.substring(0, 7); // yyyy-MM
      final n = _intOf(d['count']);
      if (n <= 0) continue;
      byMonth[key] = (byMonth[key] ?? 0) + n;
    }
    if (byMonth.isEmpty) return (year: 0, month: 0, count: 0);
    var best = byMonth.keys.first;
    for (final k in byMonth.keys) {
      if ((byMonth[k] ?? 0) > (byMonth[best] ?? 0)) best = k;
    }
    return (
      year: int.tryParse(best.substring(0, 4)) ?? 0,
      month: int.tryParse(best.substring(5, 7)) ?? 0,
      count: byMonth[best] ?? 0,
    );
  }

  // ------------------------------------------------------------------ 工具

  Map<String, dynamic> _mapOf(dynamic raw) {
    if (raw is Map) return raw.cast<String, dynamic>();
    return const <String, dynamic>{};
  }

  List<Map<String, dynamic>> _asList(dynamic raw) {
    if (raw is! List) return const <Map<String, dynamic>>[];
    return raw.whereType<Map>().map((e) => e.cast<String, dynamic>()).toList();
  }

  int _intOf(dynamic raw) {
    if (raw is num) return raw.toInt();
    return int.tryParse(raw?.toString() ?? '') ?? 0;
  }
}
