class AiSceneCover {
  final String fullpath;

  AiSceneCover({required this.fullpath});

  factory AiSceneCover.fromJson(Map<String, dynamic> json) {
    return AiSceneCover(fullpath: json['fullpath']?.toString() ?? '');
  }
}

class AiSceneItem {
  final String placeName;
  final String placeNameRaw;
  final int photoCount;
  final bool isHide;
  final AiSceneCover? cover;

  AiSceneItem({
    required this.placeName,
    required this.placeNameRaw,
    required this.photoCount,
    required this.isHide,
    this.cover,
  });

  factory AiSceneItem.fromJson(Map<String, dynamic> json) {
    final coverRaw = json['cover'];
    final rawName =
        (json['place_name_raw'] ?? json['placeNameRaw'] ?? json['place_name'])
            ?.toString() ??
        '';
    return AiSceneItem(
      placeName: json['place_name']?.toString() ?? '',
      placeNameRaw: rawName,
      photoCount:
          (json['photo_count'] as num?)?.toInt() ??
          (json['photoCount'] as num?)?.toInt() ??
          0,
      isHide: (json['is_hide'] as num?)?.toInt() == 1,
      cover: coverRaw is Map
          ? AiSceneCover.fromJson(coverRaw.cast<String, dynamic>())
          : null,
    );
  }
}

class AiSceneListResult {
  final List<AiSceneItem> items;
  final int total;
  final int page;
  final int pageSize;
  final bool placeEnable;

  AiSceneListResult({
    required this.items,
    required this.total,
    required this.page,
    required this.pageSize,
    required this.placeEnable,
  });

  factory AiSceneListResult.fromJson(Map<String, dynamic> json) {
    bool parseEnable(dynamic v) {
      if (v is bool) return v;
      if (v is num) return v.toInt() == 1;
      if (v is String) return v == '1' || v.toLowerCase() == 'true';
      return true;
    }

    final raw = (json['items'] as List<dynamic>? ?? []);
    final items = raw
        .whereType<Map>()
        .map((e) => AiSceneItem.fromJson(e.cast<String, dynamic>()))
        .where((e) => e.placeNameRaw.trim().isNotEmpty)
        .toList();

    final pagination =
        (json['pagination'] as Map?)?.cast<String, dynamic>() ?? {};
    final total = (pagination['total'] as num?)?.toInt() ?? 0;
    final page = (pagination['page'] as num?)?.toInt() ?? 1;
    final pageSize = (pagination['pageSize'] as num?)?.toInt() ?? 50;

    return AiSceneListResult(
      items: items,
      total: total,
      page: page,
      pageSize: pageSize,
      placeEnable: parseEnable(json['placeEnable'] ?? json['place_enable']),
    );
  }
}

/// 语义搜索命中结果。
///
/// 为什么只需要「相册原名列表」而不是完整条目：
/// 相册列表接口（/photo/place/list）本来就一次返回全部相册（含封面与隐藏状态），
/// 所以搜索只需拿到**命中顺序**，再去本地列表里取原有条目 —— 封面/隐藏状态天然保留，
/// 也免掉服务端再算一遍封面。
class AiSceneSearchResult {
  /// 服务端按相关度排好序的相册原名
  final List<String> rawNames;

  /// 已识别的场景标签（用于给用户看「已识别：日落 · 海滩」）
  final List<String> tags;

  /// 未被词表识别的片段（用于提示「没听懂：xxx」）
  final List<String> unmatched;

  /// true = 走了语义解析；false = 退回标签名子串匹配
  final bool semantic;

  AiSceneSearchResult({
    required this.rawNames,
    required this.tags,
    required this.unmatched,
    required this.semantic,
  });

  factory AiSceneSearchResult.fromJson(Map<String, dynamic> json) {
    final raw = (json['items'] as List<dynamic>? ?? []);
    final names = <String>[];
    for (final e in raw) {
      if (e is! Map) continue;
      final n = (e['place_name_raw'] ?? e['place_name'])?.toString() ?? '';
      if (n.trim().isNotEmpty) names.add(n.trim());
    }

    final parsed = (json['parsed'] as Map?)?.cast<String, dynamic>();
    final tags = <String>[];
    final tagList = (parsed?['tags'] as List<dynamic>?) ?? const [];
    for (final t in tagList) {
      final label = t is Map ? (t['label']?.toString() ?? '') : '';
      if (label.trim().isNotEmpty && !tags.contains(label.trim())) {
        tags.add(label.trim());
      }
    }
    final unmatched = <String>[];
    final unList = (parsed?['unmatched'] as List<dynamic>?) ?? const [];
    for (final u in unList) {
      final s = u?.toString().trim() ?? '';
      if (s.isNotEmpty) unmatched.add(s);
    }

    return AiSceneSearchResult(
      rawNames: names,
      tags: tags,
      unmatched: unmatched,
      semantic: json['mode']?.toString() == 'semantic',
    );
  }
}
