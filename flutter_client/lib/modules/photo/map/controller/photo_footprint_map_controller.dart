import 'dart:async';
import 'dart:math' as math;
import 'package:get/get.dart';
import 'package:flutter_map/flutter_map.dart' as fm;
import 'package:latlong2/latlong.dart';
import '../../../../utils/cache_manager.dart';
import '../cache/map_tile_cache.dart'
    if (dart.library.io) '../cache/map_tile_cache_io.dart'
    as map_tile_cache;
import '../models/photo_map_models.dart';
import '../service/photo_map_api_service.dart';
import '../utils/coordinate_transform.dart';

class PhotoFootprintMapController extends GetxController {
  final RxBool loading = false.obs;
  final RxString errorText = ''.obs;

  final Rx<PhotoMapZoomInfo?> zoomInfo = Rx<PhotoMapZoomInfo?>(null);
  final Rx<PhotoMapTileServer?> tileServer = Rx<PhotoMapTileServer?>(null);
  final RxList<PhotoMapTileServer> tileServerList = <PhotoMapTileServer>[].obs;

  final RxList<PhotoMapIndexItem> items = <PhotoMapIndexItem>[].obs;

  /// 聚合后的 marker 列表。**视图层只认这个**，不再直接渲染 [items]。
  ///
  /// 为什么不在服务端做：聚合判据是「屏幕上的像素距离」，而像素距离又只由 zoom 决定，
  /// 放在客户端算才能做到「平移不重算、窗口大小不影响、各端结果一致」。
  final RxList<PhotoMapCluster> clusters = <PhotoMapCluster>[].obs;

  /// 聚合阈值 = clusterGapK × marker 直径（世界像素）。
  /// 取 1.15 而不是 1.0：1.0 时两个刚好相切的 marker 会留在两个簇里，看着还是叠。
  static const double clusterGapK = 1.15;

  /// marker 直径（逻辑 px）随尺寸档位取值。
  /// ⚠️ 视图层必须调这个函数，不要再写一份 —— 聚合阈值和绘制尺寸必须同源，
  ///    否则会出现「聚合算出来没重叠、画出来却压着」。
  static double markerDiameterForTier(int tier) {
    switch (tier) {
      case 0:
        return 40.0;
      case 1:
        return 60.0;
      case 2:
        return 70.0;
      default:
        return 85.0;
    }
  }

  /// 上一次聚合结果的签名（种子 id + 张数 + 合并格数）。一样就不写 Rx。
  String _clusterSig = '';

  /// Web Mercator 世界像素。zoom z 下全世界 = 256·2^z 像素。
  ///
  /// ⚠️ 它只跟 zoom 有关，**与窗口尺寸、地图中心完全无关** —— 这是
  ///    「窗口大小改了聚合结果不变」「平移不重算」两个性质的前提。
  static void _worldPx(double lat, double lng, double zoom, List<double> out) {
    final scale = 256.0 * math.pow(2.0, zoom).toDouble();
    out[0] = (lng + 180.0) / 360.0 * scale;
    final sinLat = math.sin(lat * math.pi / 180.0).clamp(-0.9999999, 0.9999999);
    out[1] = (0.5 - math.log((1 + sinLat) / (1 - sinLat)) / (4 * math.pi)) * scale;
  }

  /// 点开簇时用的 geohash 前缀长度：让「点开后列出的范围」≈「地图上这个点代表的范围」。
  static int _clickPrecisionFor(double thresholdPx, double zoom) {
    // 簇内成员都在种子的 thresholdPx 内 ⇒ 簇直径 ≤ 2×阈值
    final spanDeg =
        (thresholdPx * 2) / (256.0 * math.pow(2.0, zoom).toDouble()) * 360.0;
    for (var p = 6; p > 2; p--) {
      final lngBits = (5 * p / 2).ceil();
      if (360.0 / math.pow(2, lngBits) >= spanDeg) return p;
    }
    return 2;
  }

  /// 一个 marker 所代表的 geohash 格（按服务端下发的精度截断）。
  ///
  /// 服务端 marker 的 `photo_count` 统计的正是这一格里的照片数 ⇒ **格 = 这个 marker 代表的范围**。
  /// 点开时把簇内所有格原样交给服务端做精确匹配，角标数字才和列表张数一致。
  ///
  /// ⚠️ 老服务端响应没有 `cellPrecision`（或给的是越界值）时返回空串：宁可不收集，
  /// 也不要塞一个长度对不上 `photo_index.geohash{N}` 列的串进去 —— 那会让服务端查不到任何照片。
  /// 返回空串后由调用方回退到原来的「seed 前缀」逻辑。
  static String cellKeyOf(PhotoMapIndexItem item) {
    final gh = (item.geohash ?? '').trim();
    if (gh.isEmpty) return '';
    final p = item.cellPrecision ?? 0;
    if (p < 2 || p > 7) return '';
    return gh.length > p ? gh.substring(0, p) : gh;
  }

  /// 按「世界像素距离 < 1.15×marker 直径」贪心合并。
  ///
  /// 种子按 photo_count 降序取（最密的那一格先当种子），这样落点就是「这一片最热闹的地方」。
  /// O(n²)，n = 服务端返回的点数（默认 ≤150）⇒ 约 1 万次比较，可以每帧算。
  void _recomputeClusters() {
    final src = items;
    if (src.isEmpty) {
      if (clusters.isNotEmpty) clusters.clear();
      _clusterSig = '';
      return;
    }

    final zoomNow = zoom.value;
    final threshold = markerDiameterForTier(markerSizeTier.value) * clusterGapK;
    final threshold2 = threshold * threshold;

    final n = src.length;
    final px = List<double>.filled(n, 0);
    final py = List<double>.filled(n, 0);
    final probe = List<double>.filled(2, 0);
    for (var i = 0; i < n; i++) {
      _worldPx(src[i].latitude, src[i].longitude, zoomNow, probe);
      px[i] = probe[0];
      py[i] = probe[1];
    }

    final order = List<int>.generate(n, (i) => i);
    order.sort((a, b) {
      final ca = src[a].photoCount ?? 1;
      final cb = src[b].photoCount ?? 1;
      if (ca != cb) return cb - ca;
      return src[b].id - src[a].id;
    });

    final used = List<bool>.filled(n, false);
    final out = <PhotoMapCluster>[];
    final clickPrecision = _clickPrecisionFor(threshold, zoomNow);

    for (var oi = 0; oi < n; oi++) {
      final i = order[oi];
      if (used[i]) continue;
      used[i] = true;
      var total = src[i].photoCount ?? 1;
      var cells = 1;
      // ⭐ 该簇覆盖的 geohash 格集合（精度 = 服务端下发的 cellPrecision）。
      // 点开时原样下发 ⇒ 「角标显示多少张」==「点进去多少张」。
      final cellSet = <String>{};
      final seedKey = cellKeyOf(src[i]);
      if (seedKey.isNotEmpty) cellSet.add(seedKey);
      for (var oj = oi + 1; oj < n; oj++) {
        final j = order[oj];
        if (used[j]) continue;
        final dx = px[j] - px[i];
        final dy = py[j] - py[i];
        if (dx * dx + dy * dy < threshold2) {
          cells++;
          total += src[j].photoCount ?? 1;
          final key = cellKeyOf(src[j]);
          if (key.isNotEmpty) cellSet.add(key);
          used[j] = true;
        }
      }
      final sortedCells = cellSet.toList()..sort();
      out.add(
        PhotoMapCluster(
          seed: src[i],
          photoCount: total,
          cellCount: cells,
          clickPrecision: clickPrecision,
          cells: sortedCells,
          cellPrecision:
              src[i].cellPrecision ??
              (sortedCells.isNotEmpty ? sortedCells.first.length : 0),
        ),
      );
    }

    // ⭐ 组成没变就不动 Rx。onMapChanged 在拖动/缩放的**每一帧**都会来，
    //    每帧 assignAll 会让整个 marker 层重建 —— 那就是「拖起来一顿一顿」的根源。
    final sig = StringBuffer();
    for (final c in out) {
      sig
        ..write(c.seed.id)
        ..write(':')
        ..write(c.photoCount)
        ..write(':')
        ..write(c.cellCount)
        ..write('|');
    }
    final next = sig.toString();
    if (next == _clusterSig) return;
    _clusterSig = next;
    clusters.assignAll(out);
  }

  /// 聚合 marker 的落点（就是种子那张照片的真实坐标，经坐标系转换后）。
  LatLng clusterPosition(PhotoMapCluster cluster) =>
      markerPosition(cluster.seed);
  final Rx<LatLng> center = const LatLng(34.0, 108.0).obs;
  final RxDouble zoom = 5.0.obs;

  /// ⭐ marker 尺寸档位（0..3），由原始 [zoom] **量化**得到。
  ///
  /// ⚠️ 为什么要单独做一个 Rx：`onMapChanged` 在**拖动/缩放的每一帧**都会被调用，
  /// 而 marker 尺寸只跟缩放档位有关。若 marker 直接读 `zoom.value`，
  /// 每帧都会让 marker 层重建（N 个 marker × 每帧）⇒ 拖起来一顿一顿的。
  /// 量化之后只有跨档（<5 / <7 / <8 / 其余）时才变一次。
  final RxInt markerSizeTier = 0.obs;

  /// 把连续缩放值映射成 marker 尺寸档位。档位与 `_markerSizeForTier` 一一对应。
  static int markerSizeTierOf(double z) {
    if (z < 5.0) return 0;
    if (z < 7.0) return 1;
    if (z < 8.0) return 2;
    return 3;
  }

  /// 只在档位真的变了才写 Rx（避免无谓重建）
  void _syncMarkerSizeTier() {
    final t = markerSizeTierOf(zoom.value);
    if (t != markerSizeTier.value) markerSizeTier.value = t;
  }

  RxInt? mapRebuildSeed;

  Timer? _debounceTimer;
  fm.LatLngBounds? _lastFetchedBoundsWgs84;
  int? _lastFetchedZoom;
  Completer<void>? _boundsCancel;

  @override
  void onInit() {
    super.onInit();
    mapRebuildSeed ??= 0.obs;
    final cached = CacheManager().getJson(CacheKeys.photoFootprintMapState);
    if (cached is Map) {
      final lat = cached['lat'];
      final lng = cached['lng'];
      final z = cached['zoom'];
      if (lat is num && lng is num) {
        center.value = LatLng(lat.toDouble(), lng.toDouble());
      }
      if (z is num) {
        zoom.value = z.toDouble();
      }
    }
    _syncMarkerSizeTier();
    initData();
  }

  @override
  void onClose() {
    _debounceTimer?.cancel();
    _boundsCancel?.complete();
    _boundsCancel = null;
    super.onClose();
  }

  String get mapCoordinate =>
      (tileServer.value?.coordinate ?? 'WGS-84').toString();

  Future<void> initData() async {
    loading.value = true;
    errorText.value = '';
    try {
      final zoomRes = await PhotoMapApiService.instance.getZoom();
      if (zoomRes.success && zoomRes.data != null) {
        final (zi, ts) = zoomRes.data!;
        zoomInfo.value = zi;
        tileServer.value = ts;
        zoom.value = zoom.value.clamp(
          zi.minZoom.toDouble(),
          zi.maxZoom.toDouble(),
        );
      }

      final listRes = await PhotoMapApiService.instance.getTileServerList();
      if (listRes.success) {
        tileServerList.assignAll(listRes.data ?? <PhotoMapTileServer>[]);
      }
    } catch (e) {
      errorText.value = e.toString();
    } finally {
      loading.value = false;
    }
  }

  void onMapChanged({
    required fm.LatLngBounds bounds,
    required double zoomLevel,
    required LatLng mapCenter,
  }) {
    center.value = mapCenter;
    zoom.value = zoomLevel;
    _syncMarkerSizeTier();
    // 聚合只跟 zoom / 数据有关，平移不影响 ⇒ 这里直接重算，拖动时不会变。
    _recomputeClusters();

    // 立即取消当前进行中的 bounds 请求，避免 P2P 通道被上一批大响应占满导致卡死
    _boundsCancel?.complete();
    _boundsCancel = null;

    _debounceTimer?.cancel();
    _debounceTimer = Timer(const Duration(milliseconds: 650), () {
      _boundsCancel = Completer<void>();
      final cancelFuture = _boundsCancel!.future;
      fetchBounds(bounds, zoomLevel, cancelFuture: cancelFuture);
      CacheManager().setJson(CacheKeys.photoFootprintMapState, {
        'lat': center.value.latitude,
        'lng': center.value.longitude,
        'zoom': zoom.value,
      });
    });
  }

  Future<void> fetchBounds(
    fm.LatLngBounds mapBounds,
    double zoomLevel, {
    Future<void>? cancelFuture,
  }) async {
    final coord = mapCoordinate;
    final swWgs = _toWgs84(mapBounds.southWest, coord);
    final neWgs = _toWgs84(mapBounds.northEast, coord);
    final b = fm.LatLngBounds(swWgs, neWgs);
    final zInt = zoomLevel.round();

    if (_lastFetchedBoundsWgs84 != null &&
        _lastFetchedZoom != null &&
        _boundsSimilar(_lastFetchedBoundsWgs84!, b) &&
        _lastFetchedZoom == zInt) {
      return;
    }

    try {
      final res = await PhotoMapApiService.instance.getBoundsPhoto(
        minLat: b.southWest.latitude,
        minLng: b.southWest.longitude,
        maxLat: b.northEast.latitude,
        maxLng: b.northEast.longitude,
        zoom: zoomLevel,
        cancelFuture: cancelFuture,
      );
      if (res.success) {
        _lastFetchedBoundsWgs84 = b;
        _lastFetchedZoom = zInt;
        items.assignAll(res.data ?? <PhotoMapIndexItem>[]);
        _recomputeClusters();
      }
    } catch (e) {
      final s = e.toString();
      if (!s.contains('p2p_canceled') && !s.contains('cancel')) {
        errorText.value = s;
      }
    }
  }

  Future<void> refreshTileServerList() async {
    final res = await PhotoMapApiService.instance.getTileServerList();
    if (res.success) {
      tileServerList.assignAll(res.data ?? <PhotoMapTileServer>[]);
      final current = tileServerList.firstWhereOrNull((e) => e.isCurrent);
      if (current != null) {
        tileServer.value = current;
      }
    }
  }

  Future<bool> switchTileServer(PhotoMapTileServer server) async {
    final res = await PhotoMapApiService.instance.setTileServer(server);
    if (!res.success) return false;

    final zoomRes = await PhotoMapApiService.instance.getZoom();
    if (zoomRes.success && zoomRes.data != null) {
      final (zi, ts) = zoomRes.data!;
      zoomInfo.value = zi;
      tileServer.value = ts;
      zoom.value = zoom.value.clamp(
        zi.minZoom.toDouble(),
        zi.maxZoom.toDouble(),
      );
    }

    await refreshTileServerList();
    _lastFetchedBoundsWgs84 = null;
    _lastFetchedZoom = null;
    // 清空磁盘瓦片缓存，避免新旧瓦片混显
    await map_tile_cache.clearMapTileCache();
    mapRebuildSeed ??= 0.obs;
    mapRebuildSeed!.value += 1;
    return true;
  }

  /// 单张照片/网格代表点的落点。
  ///
  /// ⭐ 2026-10-16：一律用**代表照片真实的经纬度**。曾经试过「吸附 geohash 格心」，
  /// 被用户否掉了（位置会整体平移、不再是真实照片的位置）；「重叠的合成一个」改由
  /// [_recomputeClusters] 在客户端按世界像素距离做。
  /// [PhotoMapIndexItem.cellLat] 只用于兼容老的本地缓存，服务端已不再下发。
  LatLng markerPosition(PhotoMapIndexItem item) {
    final coord = mapCoordinate;
    final lat0 = item.cellLat ?? item.latitude;
    final lng0 = item.cellLng ?? item.longitude;
    final (lat, lng) = CoordinateTransform.toMapCoordinate(
      coord,
      lat0,
      lng0,
    );
    return LatLng(lat, lng);
  }

  LatLng _toWgs84(LatLng p, String coordinate) {
    final (lat, lng) = CoordinateTransform.fromMapCoordinate(
      coordinate,
      p.latitude,
      p.longitude,
    );
    return LatLng(lat, lng);
  }

  bool _boundsSimilar(fm.LatLngBounds a, fm.LatLngBounds b) {
    const eps = 0.0008;
    final da =
        (a.southWest.latitude - b.southWest.latitude).abs() +
        (a.southWest.longitude - b.southWest.longitude).abs() +
        (a.northEast.latitude - b.northEast.latitude).abs() +
        (a.northEast.longitude - b.northEast.longitude).abs();
    return da < eps;
  }
}
