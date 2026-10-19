import 'package:get/get.dart';

import 'package:WaterNasOS/modules/photo/ai_setting/service/photo_ai_settings_api_service.dart';

/// ⭐ 2026-10-18 票夹控制器。
///
/// 对应 `/photo/app_ai/tickets`。服务端在 OCR 索引不可用时会降级返回
/// `degraded=true + reason`，这里把原因带出去给界面，而不是让用户面对一个空列表。
class PhotoTicketsController extends GetxController {
  PhotoAiSettingsApiService get _api => PhotoAiSettingsApiService.instance;

  final RxBool loading = true.obs;
  final RxnString error = RxnString();
  final RxString degradedReason = ''.obs;
  final RxList<Map<String, dynamic>> tickets = <Map<String, dynamic>>[].obs;
  final RxList<Map<String, dynamic>> trips = <Map<String, dynamic>>[].obs;

  /// all / train / flight / ticket_other
  final RxString kindFilter = 'all'.obs;

  @override
  void onInit() {
    super.onInit();
    load();
  }

  Future<void> load() async {
    loading.value = true;
    error.value = null;
    degradedReason.value = '';
    try {
      final res = await _api.getTickets();
      if (!res.success || res.data == null) {
        error.value = 'operation_failed'.tr;
        return;
      }
      final data = res.data!;
      tickets.assignAll(_asList(data['tickets']));
      trips.assignAll(_asList(data['trips']));
      if (data['degraded'] == true) {
        degradedReason.value = (data['reason'] ?? '').toString();
      }
    } catch (_) {
      error.value = 'operation_failed'.tr;
    } finally {
      loading.value = false;
    }
  }

  List<Map<String, dynamic>> get filtered {
    final k = kindFilter.value;
    if (k == 'all') return tickets;
    return tickets.where((t) => (t['kind'] ?? '') == k).toList();
  }

  int countOf(String kind) {
    if (kind == 'all') return tickets.length;
    return tickets.where((t) => (t['kind'] ?? '') == kind).length;
  }

  /// 按「年-月」倒序分组，返回 (label, items)。
  List<({String label, List<Map<String, dynamic>> items})> get grouped {
    final map = <String, List<Map<String, dynamic>>>{};
    for (final t in filtered) {
      final date = (t['date'] ?? '').toString();
      final key = date.length >= 7 ? date.substring(0, 7) : '未知';
      map.putIfAbsent(key, () => []).add(t);
    }
    final keys = map.keys.toList()..sort((a, b) => b.compareTo(a));
    final out = <({String label, List<Map<String, dynamic>> items})>[];
    for (final k in keys) {
      final items = map[k]!;
      items.sort((a, b) {
        final da = (a['date'] ?? '').toString();
        final db = (b['date'] ?? '').toString();
        return db.compareTo(da);
      });
      out.add((label: _monthLabel(k), items: items));
    }
    return out;
  }

  String _monthLabel(String key) {
    if (key == '未知' || key.length < 7) return '未知时间';
    final y = key.substring(0, 4);
    final m = int.tryParse(key.substring(5, 7)) ?? 0;
    return '$y 年 $m 月';
  }

  /// 卡片标题：有站名用「A → B」，没有就用票据类型（不编）。
  String titleOf(Map<String, dynamic> t) {
    final from = (t['from_station'] ?? '').toString();
    final to = (t['to_station'] ?? '').toString();
    if (from.isNotEmpty && to.isNotEmpty) return '$from → $to';
    if (from.isNotEmpty) return from;
    return (t['kind_label'] ?? '').toString();
  }

  /// 卡片副标题：车次/航班号 · 日期 时间
  String subtitleOf(Map<String, dynamic> t) {
    final parts = <String>[];
    final code = (t['code'] ?? t['train_no'] ?? '').toString();
    if (code.isNotEmpty) parts.add(code);
    final date = (t['date'] ?? '').toString();
    final time = (t['time'] ?? '').toString();
    if (date.isNotEmpty) parts.add(time.isNotEmpty ? '$date $time' : date);
    return parts.join(' · ');
  }

  List<Map<String, dynamic>> _asList(dynamic raw) {
    if (raw is! List) return const <Map<String, dynamic>>[];
    return raw.whereType<Map>().map((e) => e.cast<String, dynamic>()).toList();
  }
}
