import 'package:get/get.dart';

import '../../ai_setting/service/photo_ai_settings_api_service.dart';

/// ⭐ 2026-10-19 每日一帧控制器。
///
/// 数据只来自 `/photo/app_ai/day_frames`（服务端一天挑一张最好的）。
/// 与年度总结同一套写法：普通字段 + `update()`，不把异常抛进 widget 树。
class PhotoDayFrameController extends GetxController {
  PhotoAiSettingsApiService get _api => PhotoAiSettingsApiService.instance;

  /// 可选的回看范围（天）
  static const List<int> ranges = <int>[30, 90, 365];

  int days = 90;
  bool loading = true;
  String? error;
  List<Map<String, dynamic>> items = const <Map<String, dynamic>>[];

  @override
  void onInit() {
    super.onInit();
    // 放到 microtask：GetBuilder 的 init 发生在 initState，此时同步 update() 会在
    // 父级 build 过程中触发重建（release 静默、debug 直接 assert）。
    Future.microtask(load);
  }

  Future<void> load({int? range}) async {
    final d = range ?? days;
    days = d;
    loading = true;
    error = null;
    update();
    try {
      final res = await _api.getDayFrames(days: d);
      if (!res.success || res.data == null) {
        error = 'operation_failed'.tr;
        items = const <Map<String, dynamic>>[];
      } else {
        final raw = res.data!['items'];
        items = raw is List
            ? [
                for (final e in raw)
                  if (e is Map) e.cast<String, dynamic>(),
              ]
            : const <Map<String, dynamic>>[];
      }
    } catch (_) {
      error = 'operation_failed'.tr;
      items = const <Map<String, dynamic>>[];
    } finally {
      loading = false;
      update();
    }
  }

  static String prettyDate(String raw) {
    final s = raw.length >= 10 ? raw.substring(0, 10) : raw;
    final parts = s.split('-');
    if (parts.length != 3) return s;
    final m = int.tryParse(parts[1]) ?? 0;
    final d = int.tryParse(parts[2]) ?? 0;
    if (m <= 0 || d <= 0) return s;
    return '$m 月 $d 日';
  }
}
