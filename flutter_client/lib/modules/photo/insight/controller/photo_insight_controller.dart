import 'package:get/get.dart';

import '../../../../core/api/base_api_service.dart';
import '../../ai_setting/service/photo_ai_settings_api_service.dart';

/// ⭐ 2026-10-16 P1/P2 照片域「智能发现」总控制器。
///
/// 时间轴/相册解决「找到某张」，这一页解决「发现我没想到的」：
///   一日一帧（P1-17）、票据与行程（P1-13）、记忆（P1-14）、
///   重复照片（P1-16）、年度报告（P2-21）、模型目录（P1-15）、旅程回放（P1-10）。
///
/// 所有数据都来自服务端**只读**聚合（记忆的「记下来」是唯一的写入，且按 uid 存 config）。
/// 页面刻意不做重交互：每个标签页只负责「拉一次、列出来、点开看图」，
/// 真正的照片浏览复用既有的 CustomGallery / 桌面看图窗。
class PhotoInsightController extends GetxController {
  PhotoAiSettingsApiService get _api => PhotoAiSettingsApiService.instance;

  /// 当前标签页下标
  final RxInt tabIndex = 0.obs;

  /// 每个标签页各自的加载态与数据（互不影响）
  final Map<String, RxBool> _loading = <String, RxBool>{};
  final Map<String, RxnString> _error = <String, RxnString>{};

  final RxList<Map<String, dynamic>> dayFrames = <Map<String, dynamic>>[].obs;
  final RxList<Map<String, dynamic>> tickets = <Map<String, dynamic>>[].obs;
  final RxList<Map<String, dynamic>> trips = <Map<String, dynamic>>[].obs;
  final RxList<Map<String, dynamic>> memoryCandidates = <Map<String, dynamic>>[].obs;
  final RxList<Map<String, dynamic>> memories = <Map<String, dynamic>>[].obs;
  final RxList<Map<String, dynamic>> dupGroups = <Map<String, dynamic>>[].obs;
  final RxInt dupWastedBytes = 0.obs;
  final RxInt dupMissingMd5 = 0.obs;
  final RxList<Map<String, dynamic>> models = <Map<String, dynamic>>[].obs;
  final RxMap<String, dynamic> yearReport = <String, dynamic>{}.obs;
  final RxInt reportYear = DateTime.now().year.obs;
  final RxList<Map<String, dynamic>> visits = <Map<String, dynamic>>[].obs;
  final RxList<Map<String, dynamic>> travelLines = <Map<String, dynamic>>[].obs;
  final RxInt replayIndex = (-1).obs;

  /// 已加载过的标签页（避免来回切页重复请求）
  final Set<String> _loaded = <String>{};

  bool isLoading(String key) => _loading[key]?.value ?? false;
  String? errorOf(String key) => _error[key]?.value;

  RxBool _flag(String key) => _loading.putIfAbsent(key, () => false.obs);
  RxnString _err(String key) => _error.putIfAbsent(key, () => RxnString());

  /// 标签页 key：day_frame / tickets / memories / duplicates / models / report / travel
  Future<void> ensureLoaded(String key, {bool force = false}) async {
    if (!force && _loaded.contains(key)) return;
    _loaded.add(key);
    await _load(key);
  }

  Future<void> reload(String key) async {
    _loaded.add(key);
    await _load(key);
  }

  Future<void> _load(String key) async {
    final loading = _flag(key);
    final error = _err(key);
    loading.value = true;
    error.value = null;
    try {
      switch (key) {
        case 'day_frame':
          final res = await _api.getDayFrames();
          dayFrames.assignAll(_itemsOf(res));
          break;
        case 'tickets':
          final res = await _api.getTickets();
          final data = res.success ? (res.data ?? const <String, dynamic>{}) : const <String, dynamic>{};
          tickets.assignAll(_asList(data['tickets']));
          trips.assignAll(_asList(data['trips']));
          break;
        case 'memories':
          final res = await _api.getMemories();
          final data = res.success ? (res.data ?? const <String, dynamic>{}) : const <String, dynamic>{};
          memoryCandidates.assignAll(_asList(data['candidates']));
          memories.assignAll(_asList(data['memories']));
          break;
        case 'duplicates':
          final res = await _api.getDuplicates();
          final data = res.success ? (res.data ?? const <String, dynamic>{}) : const <String, dynamic>{};
          dupGroups.assignAll(_asList(data['groups']));
          dupWastedBytes.value = (data['total_wasted_bytes'] as num?)?.toInt() ?? 0;
          dupMissingMd5.value = (data['missing_md5'] as num?)?.toInt() ?? 0;
          break;
        case 'models':
          final res = await _api.getModels();
          final data = res.success ? (res.data ?? const <String, dynamic>{}) : const <String, dynamic>{};
          models.assignAll(_asList(data['items']));
          break;
        case 'report':
          final res = await _api.getYearReport(reportYear.value);
          yearReport.value = res.success
              ? (res.data ?? const <String, dynamic>{})
              : const <String, dynamic>{};
          break;
        case 'travel':
          final res = await _api.getTravelLines();
          final data = res.success ? (res.data ?? const <String, dynamic>{}) : const <String, dynamic>{};
          visits.assignAll(_asList(data['visits']));
          travelLines.assignAll(_asList(data['lines']));
          break;
      }
    } finally {
      loading.value = false;
    }
  }

  List<Map<String, dynamic>> _itemsOf(ApiResponse<Map<String, dynamic>> res) {
    if (!res.success || res.data == null) return const <Map<String, dynamic>>[];
    return _asList(res.data!['items']);
  }

  List<Map<String, dynamic>> _asList(dynamic raw) {
    if (raw is! List) return const <Map<String, dynamic>>[];
    return raw.whereType<Map>().map((e) => e.cast<String, dynamic>()).toList();
  }

  /// ⭐ P1-14：确认一条候选记忆（「记下来」）。
  Future<bool> confirmMemory(Map<String, dynamic> candidate) async {
    final res = await _api.saveMemory({
      'key': candidate['key'],
      'title': candidate['title'] ?? '',
      'date': candidate['date'],
      'note': candidate['note'] ?? '',
      'photo_count': candidate['photo_count'] ?? 0,
      'cover_path': candidate['cover_path'] ?? '',
      'scenes': candidate['scenes'] ?? const <String>[],
      'activities': candidate['activities'] ?? const <String>[],
      'people': candidate['people'] ?? const <String>[],
    });
    if (!res.success) return false;
    memories.assignAll(_asList(res.data?['memories']));
    memoryCandidates.removeWhere((e) => e['key'] == candidate['key']);
    return true;
  }

  Future<bool> removeMemory(Map<String, dynamic> memory) async {
    final res = await _api.removeMemory(memory['key']?.toString() ?? '');
    if (!res.success) return false;
    memories.assignAll(_asList(res.data?['memories']));
    return true;
  }

  /// P2-21：切换报告年份
  Future<void> setReportYear(int year) async {
    reportYear.value = year;
    yearReport.value = const <String, dynamic>{};
    await reload('report');
  }

  /// P1-10：列表式回放（每 800ms 前进一个访问片段；不做地图动画）
  Future<void> toggleReplay() async {
    if (replayIndex.value >= 0) {
      replayIndex.value = -1;
      return;
    }
    replayIndex.value = 0;
    while (replayIndex.value >= 0 && replayIndex.value < visits.length) {
      await Future<void>.delayed(const Duration(milliseconds: 800));
      if (replayIndex.value < 0) return;
      replayIndex.value += 1;
    }
    replayIndex.value = -1;
  }
}
