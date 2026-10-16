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

/// ⭐ 2026-10-16 P0-5：人物关系图谱的一个节点（一个人物）。
class AiFaceRelationNode {
  final int faceId;
  final String name;
  final int faceCount;

  const AiFaceRelationNode({
    required this.faceId,
    required this.name,
    required this.faceCount,
  });

  factory AiFaceRelationNode.fromJson(Map<String, dynamic> json) {
    return AiFaceRelationNode(
      faceId: (json['face_id'] as num?)?.toInt() ?? 0,
      name: json['name']?.toString() ?? '',
      faceCount: (json['face_count'] as num?)?.toInt() ?? 0,
    );
  }

  String get displayName => name.trim().isEmpty ? '#$faceId' : name;
}

/// ⭐ 2026-10-16 P0-5：一条「共同出现」的边。
class AiFaceRelationEdge {
  final int a;
  final int b;
  final int count;

  const AiFaceRelationEdge({
    required this.a,
    required this.b,
    required this.count,
  });

  factory AiFaceRelationEdge.fromJson(Map<String, dynamic> json) {
    return AiFaceRelationEdge(
      a: (json['a'] as num?)?.toInt() ?? 0,
      b: (json['b'] as num?)?.toInt() ?? 0,
      count: (json['count'] as num?)?.toInt() ?? 0,
    );
  }
}

class AiFaceRelationsResult {
  final List<AiFaceRelationNode> nodes;
  final List<AiFaceRelationEdge> edges;
  final int total;

  const AiFaceRelationsResult({
    required this.nodes,
    required this.edges,
    this.total = 0,
  });

  factory AiFaceRelationsResult.fromJson(Map<String, dynamic> json) {
    final nodesRaw = json['nodes'];
    final edgesRaw = json['edges'];
    return AiFaceRelationsResult(
      nodes: nodesRaw is List
          ? nodesRaw
              .whereType<Map>()
              .map((e) => AiFaceRelationNode.fromJson(e.cast<String, dynamic>()))
              .where((e) => e.faceId > 0)
              .toList()
          : <AiFaceRelationNode>[],
      edges: edgesRaw is List
          ? edgesRaw
              .whereType<Map>()
              .map((e) => AiFaceRelationEdge.fromJson(e.cast<String, dynamic>()))
              .where((e) => e.a > 0 && e.b > 0)
              .toList()
          : <AiFaceRelationEdge>[],
      total: (json['total'] as num?)?.toInt() ?? 0,
    );
  }
}
