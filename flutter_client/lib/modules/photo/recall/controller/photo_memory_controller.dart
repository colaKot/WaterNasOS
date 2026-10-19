import 'package:get/get.dart';

import 'package:WaterNasOS/modules/photo/ai_setting/service/photo_ai_settings_api_service.dart';

/// ⭐ 2026-10-18 记忆页控制器。
///
/// 三个状态互斥但同源：
///   待确认 = 服务端算出来的事件候选（还没认领）
///   我的记忆 = 用户确认过的（存 config，按 uid）
///   已忽略 = 用户点过"不是我想要的"，候选不再重复出现
/// 所有写操作都只动 config，不碰照片。
class PhotoMemoryController extends GetxController {
  PhotoAiSettingsApiService get _api => PhotoAiSettingsApiService.instance;

  final RxBool loading = true.obs;
  final RxnString error = RxnString();

  final RxList<Map<String, dynamic>> candidates = <Map<String, dynamic>>[].obs;
  final RxList<Map<String, dynamic>> memories = <Map<String, dynamic>>[].obs;
  final RxList<Map<String, dynamic>> ignored = <Map<String, dynamic>>[].obs;
  final RxList<Map<String, dynamic>> chapters = <Map<String, dynamic>>[].obs;

  /// 0 = 待确认 / 1 = 我的记忆 / 2 = 已忽略
  /// ⭐ 2026-10-19 默认落在「我的记忆」（已确认）：记忆页第一页给已确认的。
  final RxInt tabIndex = 1.obs;

  @override
  void onInit() {
    super.onInit();
    load();
  }

  Future<void> load() async {
    loading.value = true;
    error.value = null;
    await _fetch();
    loading.value = false;
  }

  /// 写操作之后用这个：不闪 loading，只把数据换掉。
  Future<void> _refreshQuiet() async {
    await _fetch();
  }

  /// ⭐ 2026-10-19 给「记忆详情」用：在那里把照片移出记忆后，列表要悄悄重拉一遍
  /// （张数/封面变了），但不能闪 loading 把用户弹回顶部。
  Future<void> refreshQuiet() async {
    await _fetch();
  }

  Future<void> _fetch() async {
    try {
      // minPhotos 12 / limit 40：本机实测 minPhotos=8 会筛出 1400+ 候选，
      // 对用户来说等于没筛选。先给最像“有事发生”的那几十条。
      final res = await _api.getMemories(days: 3650, minPhotos: 12, limit: 40);
      if (!res.success || res.data == null) {
        error.value = 'operation_failed'.tr;
        return;
      }
      final data = res.data!;
      candidates.assignAll(_asListOf(data['candidates']));
      memories.assignAll(_asListOf(data['memories']));
      ignored.assignAll(_asListOf(data['ignored']));
      chapters.assignAll(_asListOf(data['chapters']));
    } catch (_) {
      error.value = 'operation_failed'.tr;
    }
  }

  Future<bool> confirm(Map<String, dynamic> c) async {
    final res = await _api.saveMemory({
      'key': c['key'],
      'title': c['title'] ?? '',
      'date': c['date'],
      'note': c['note'] ?? '',
      'photo_count': c['photo_count'] ?? 0,
      'cover_path': c['cover_path'] ?? '',
      'scenes': c['scenes'] ?? const <String>[],
      'activities': c['activities'] ?? const <String>[],
      'people': c['people'] ?? const <String>[],
    });
    if (!res.success) return false;
    candidates.removeWhere((e) => e['key'] == c['key']);
    await _refreshQuiet();
    return true;
  }

  Future<bool> ignore(Map<String, dynamic> c) async {
    final key = (c['key'] ?? '').toString();
    if (key.isEmpty) return false;
    final res = await _api.ignoreMemory(c);
    if (!res.success) return false;
    candidates.removeWhere((e) => e['key'] == key);
    await _refreshQuiet();
    return true;
  }

  Future<bool> restore(String key) async {
    final res = await _api.restoreMemory(key);
    if (!res.success) return false;
    await _refreshQuiet();
    return true;
  }

  Future<bool> remove(String key) async {
    final res = await _api.removeMemory(key);
    if (!res.success) return false;
    memories.removeWhere((e) => e['key'] == key);
    await _refreshQuiet();
    return true;
  }

  int get pendingCount => candidates.length;

  List<Map<String, dynamic>> _asListOf(dynamic raw) {
    if (raw is! List) return const <Map<String, dynamic>>[];
    return raw.whereType<Map>().map((e) => e.cast<String, dynamic>()).toList();
  }
}
