class AiFaceItem {
  final int faceId;
  final int faceCount;
  final String? coverFileHash;
  final String? name;
  final bool isHide;

  AiFaceItem({
    required this.faceId,
    required this.faceCount,
    this.coverFileHash,
    this.name,
    this.isHide = false,
  });

  factory AiFaceItem.fromJson(Map<String, dynamic> json) {
    return AiFaceItem(
      faceId:
          (json['face_id'] as num?)?.toInt() ??
          (json['faceId'] as num?)?.toInt() ??
          0,
      faceCount:
          (json['face_count'] as num?)?.toInt() ??
          (json['faceCount'] as num?)?.toInt() ??
          0,
      coverFileHash: json['cover_file_hash']?.toString(),
      name: json['name']?.toString(),
      isHide: (json['is_hide'] as num?)?.toInt() == 1,
    );
  }
}

/// 人脸识别进度（服务端在 /face/list 一并返回，2026-10-13）
class AiFaceProgress {
  final int total;
  final int done;
  final int remain;
  final int percent;

  const AiFaceProgress({
    this.total = 0,
    this.done = 0,
    this.remain = 0,
    this.percent = 0,
  });

  bool get finished => total > 0 && remain <= 0;

  factory AiFaceProgress.fromJson(dynamic raw) {
    if (raw is! Map) return const AiFaceProgress();
    int n(dynamic v) => (v as num?)?.toInt() ?? 0;
    return AiFaceProgress(
      total: n(raw['total']),
      done: n(raw['done']),
      remain: n(raw['remain']),
      percent: n(raw['percent']),
    );
  }
}

class AiFaceListResult {
  final List<AiFaceItem> items;
  final int total;
  final int page;
  final int pageSize;
  final bool faceEnable;

  /// 识别进度：已识别 / 总数 / 剩余 / 百分比
  final AiFaceProgress progress;

  AiFaceListResult({
    required this.items,
    required this.total,
    required this.page,
    required this.pageSize,
    required this.faceEnable,
    this.progress = const AiFaceProgress(),
  });

  factory AiFaceListResult.fromJson(Map<String, dynamic> json) {
    bool parseEnable(dynamic v) {
      if (v is bool) return v;
      if (v is num) return v.toInt() == 1;
      if (v is String) return v == '1' || v.toLowerCase() == 'true';
      return true;
    }

    final raw = (json['items'] as List<dynamic>? ?? []);
    final items = raw
        .whereType<Map>()
        .map((e) => AiFaceItem.fromJson(e.cast<String, dynamic>()))
        .where((e) => e.faceId > 0)
        .toList();

    final pagination =
        (json['pagination'] as Map?)?.cast<String, dynamic>() ?? {};
    final total = (pagination['total'] as num?)?.toInt() ?? 0;
    final page = (pagination['page'] as num?)?.toInt() ?? 1;
    final pageSize = (pagination['pageSize'] as num?)?.toInt() ?? 50;

    return AiFaceListResult(
      items: items,
      total: total,
      page: page,
      pageSize: pageSize,
      faceEnable: parseEnable(json['faceEnable'] ?? json['face_enable']),
      progress: AiFaceProgress.fromJson(
        json['faceProgress'] ?? json['face_progress'],
      ),
    );
  }
}
