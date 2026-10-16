class PhotoMapTileServer {
  final String name;
  final String server;
  final String coordinate;
  final int maxLevel;
  final bool isDefault;
  final bool isCustom;
  final bool isCurrent;

  const PhotoMapTileServer({
    required this.name,
    required this.server,
    required this.coordinate,
    required this.maxLevel,
    required this.isDefault,
    required this.isCustom,
    required this.isCurrent,
  });

  factory PhotoMapTileServer.fromJson(Map<String, dynamic> json) {
    return PhotoMapTileServer(
      name: (json['name'] ?? '').toString(),
      server: (json['server'] ?? '').toString(),
      coordinate: (json['coordinate'] ?? 'WGS-84').toString(),
      maxLevel: int.tryParse((json['maxLevel'] ?? 18).toString()) ?? 18,
      isDefault: json['isDefault'] == true || json['isDefault'] == 1,
      isCustom: json['isCustom'] == true || json['isCustom'] == 1,
      isCurrent: json['current'] == true || json['current'] == 1,
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'name': name,
      'server': server,
      'coordinate': coordinate,
      'maxLevel': maxLevel,
      'isDefault': isDefault ? 1 : 0,
    };
  }
}

class PhotoMapZoomInfo {
  final int minZoom;
  final int maxZoom;

  const PhotoMapZoomInfo({required this.minZoom, required this.maxZoom});

  factory PhotoMapZoomInfo.fromJson(Map<String, dynamic> json) {
    return PhotoMapZoomInfo(
      minZoom: int.tryParse((json['minZoom'] ?? 2).toString()) ?? 2,
      maxZoom: int.tryParse((json['maxZoom'] ?? 18).toString()) ?? 18,
    );
  }
}

class PhotoMapIndexItem {
  final int id;

  /// 代表照片坐标（该网格内 id 最大的一张）。
  /// 优先用 [cellLat]/[cellLng]（网格中心），为空才回退到这里的原始坐标。
  final double latitude;
  final double longitude;

  /// ⚠️ 2026-10-16 起**服务端不再下发**这两个字段。
  /// 试过「marker 吸附格心」，用户否掉了：位置必须落在真实照片上；
  /// 「重叠的合成一个」改由客户端按世界像素距离做（见 [PhotoMapCluster]）。
  /// 字段保留只为兼容老的本地缓存响应。
  final double? cellLat;
  final double? cellLng;

  /// ⭐ 该网格内的照片数量。>1 表示这是一个聚合点，UI 应显示数字角标。
  /// 之前服务端根本没返回这个字段，marker 也无法区分「单张」和「一簇」。
  /// 声明成可空：老服务端响应/ 缓存数据里没有这个 key。
  final int? photoCount;

  /// ⭐ 该 marker 的 geohash 精度档位（2~6，null/0 = 未知）。
  /// 点开反查时必须用同一档位，否则会出现「marker 代表很大范围、点开只列很少照片」。
  final int? cellPrecision;

  final String? geohash;
  final int? originalTime;
  final String? fullpath;
  final String? type;
  final num? duration;

  const PhotoMapIndexItem({
    required this.id,
    required this.latitude,
    required this.longitude,
    this.cellLat,
    this.cellLng,
    this.photoCount,
    this.cellPrecision,
    this.geohash,
    this.originalTime,
    this.fullpath,
    this.type,
    this.duration,
  });

  /// 是否为聚合点（含多张照片）。字段缺失时按单张处理。
  bool get isCluster => (photoCount ?? 1) > 1;

  factory PhotoMapIndexItem.fromJson(Map<String, dynamic> json) {
    final count = int.tryParse((json['photo_count'] ?? 1).toString()) ?? 1;
    final precision = int.tryParse((json['cell_precision'] ?? 0).toString()) ?? 0;
    return PhotoMapIndexItem(
      id: int.tryParse((json['id'] ?? 0).toString()) ?? 0,
      latitude: double.tryParse((json['latitude'] ?? 0).toString()) ?? 0,
      longitude: double.tryParse((json['longitude'] ?? 0).toString()) ?? 0,
      cellLat: double.tryParse((json['cell_lat'] ?? '').toString()),
      cellLng: double.tryParse((json['cell_lng'] ?? '').toString()),
      photoCount: count > 0 ? count : 1,
      // 0 / 解析失败都视为「未知档位」，由调用方回退到旧的 nearbyRangeKm 逻辑
      cellPrecision: precision >= 2 && precision <= 6 ? precision : null,
      geohash: json['geohash']?.toString(),
      originalTime: int.tryParse((json['original_time'] ?? '').toString()),
      fullpath: json['fullpath']?.toString(),
      type: json['type']?.toString(),
      duration: json['duration'] as num?,
    );
  }
}

/// 足迹地图上「聚合后」的一个 marker。
///
/// ⭐ 2026-10-16 方案：marker 落在**代表照片的真实坐标**上，把屏幕上互相压盖的合成一个。
/// 落点用的是**簇种子**（簇内 photo_count 最大的那一格）的真实坐标 —— 不是几何中心。
/// 这样有两个性质：
///   1. marker 永远落在真实照片上，不会像「吸附格心」那样换缩放档时整体平移一次；
///   2. 贪心合并时各簇的种子两两必然 ≥ 阈值 ⇒ **聚合后数学上不可能再互相压盖**。
class PhotoMapCluster {
  /// 落点依据的那张照片（簇内 photo_count 最大的格子）。
  final PhotoMapIndexItem seed;

  /// 簇内所有格子的 photo_count 之和 —— 就是角标要显示的数字。
  final int photoCount;

  /// 被合并进来的格子数。1 = 自己一个人，没有合并。
  final int cellCount;

  /// 点开这个簇时传给周边时间轴的 geohash 前缀长度（2~6）。
  /// 不传的话会按默认 2km 反查 ⇒ 「地图上一个点代表一大片、点开只列一小块」。
  ///
  /// ⚠️ 2026-10-16 起不再是「点开范围」的判据（改用 [cells] 精确集合），
  /// 只作为拿到老服务端响应（没有 [cellPrecision]）时的兜底档位保留。
  final int clickPrecision;

  /// ⭐ 2026-10-16：簇内**所有成员格**在 [cellPrecision] 精度下的 geohash（去重 + 排序）。
  ///
  /// 点开这个 marker 时原样下发给服务端做**精确集合匹配**：
  /// 「地图角标显示多少张」==「点进去列出来多少张」。
  ///
  /// 为什么不用 single seed + 前缀 LIKE：一个簇可能合并了屏幕上互相压盖的多个格，
  /// 而 seed 只是其中一张数最大的格；只要按 seed 的前缀去 LIKE，就会把邻居格一起捞进来。
  /// 实测林和西附近：geohash6 一格 68 张，按 geohash5 前缀查是 1389 张，按 geohash4 是 10090 张
  /// —— 这正是「地图上 21 张、点进去几百张」的来源。
  final List<String> cells;

  /// [cells] 里各格的精度（2~7）。0 = 未知（老服务端响应）。
  final int cellPrecision;

  const PhotoMapCluster({
    required this.seed,
    required this.photoCount,
    required this.cellCount,
    required this.clickPrecision,
    this.cells = const <String>[],
    this.cellPrecision = 0,
  });

  double get latitude => seed.latitude;
  double get longitude => seed.longitude;

  /// 角标是否显示数字。
  bool get showBadge => photoCount > 1;
}

