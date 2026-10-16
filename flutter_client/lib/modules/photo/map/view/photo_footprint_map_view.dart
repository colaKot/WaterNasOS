import 'package:WaterNasOS/core/theme/custom_colors.dart';
import 'package:flutter/material.dart';
import 'package:flutter_map/flutter_map.dart';
import 'package:get/get.dart';
import '../../../../core/api/api_controller.dart';
import '../../../../utils/device_utils.dart';
import '../../../../utils/local_web_asset_server.dart';
import '../../../base/components/custom_extended_image.dart';
import '../../../home/views/pc_components/pc_app_window.dart';
import '../../timeline/controller/photo_timeline_controller.dart';
import '../../timeline/view/app_photo_timeline_view.dart';
import '../../timeline/view/pc_photo_timeline.dart';
import '../../timeline/view/parts/app_photo_timeline_multiselect_bar.dart';
import '../cache/cached_map_tile_provider.dart';
import '../controller/photo_footprint_map_controller.dart';
import '../models/photo_map_models.dart';
import '../service/photo_map_api_service.dart';

class PhotoFootprintMapView extends StatefulWidget {
  const PhotoFootprintMapView({super.key});

  @override
  State<PhotoFootprintMapView> createState() => _PhotoFootprintMapViewState();
}

class _PhotoFootprintMapViewState extends State<PhotoFootprintMapView> {
  MapController _mapController = MapController();
  bool _initialFetchTriggered = false;
  bool _mapReady = false;
  bool _nearbyTimelineVisible = false;
  String _nearbyTitle = '';
  String? _nearbyGeohash;
  /// 内嵌时间轴沿用地图上这个 marker 的聚合档位（0 = 未知，回退默认 2km 逻辑）。
  int _nearbyPrecision = 0;
  int _nearbyTimelineSeed = 0;
  int _lastMapRebuildSeed = -1;
  Uri? _localProxyBase;
  bool _localProxyAcquired = false;

  @override
  void dispose() {
    if (_localProxyAcquired) {
      LocalWebAssetServer.instance.release();
      _localProxyAcquired = false;
    }
    _mapController.dispose();
    super.dispose();
  }

  /// 足迹 marker 的尺寸：**同屏内所有 marker 一样大**。
  ///
  /// ⚠️ 2026-10-16：尺寸表已收口到 [PhotoFootprintMapController.markerDiameterForTier]，
  /// 因为客户端的**聚合阈值就是按这个直径算的**（1.15 × 直径），两处必须同源 ——
  /// 各写一份会出现「聚合算出来不重叠、画出来却压着」。
  /// 见同文件 `_markerSizeForTier`。
  ///
  /// ⭐ 2026-10-09 改：以前按 `photoCount` 从 85px（≤5 张）线性缩到 35px（≥200 张），
  /// 结果同一屏里大大小小混在一起，照片多的点缩到 35px 连缩略图都看不清。
  /// 现在只保留「随缩放档位收缩」这一层（缩得太小时必须让位，否则 marker 互相压盖），
  /// 同一缩放级别下所有 marker 等大，取的就是原来「大」的那一档尺寸。
  ///
  /// ⚠️ 入参是**档位**而不是原始 zoom（见 `PhotoFootprintMapController.markerSizeTierOf`）：
  /// 直接读连续 zoom 会让 marker 层在拖动/缩放的每一帧重建，那是卡顿的主因。
  double _markerSizeForTier(int tier) =>
      PhotoFootprintMapController.markerDiameterForTier(tier);

  void _scheduleInitialFetch(PhotoFootprintMapController ctrl) {
    if (_initialFetchTriggered || !_mapReady) return;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted || _initialFetchTriggered || !_mapReady) return;
      _initialFetchTriggered = true;
      final camera = _mapController.camera;
      ctrl.onMapChanged(
        bounds: camera.visibleBounds,
        zoomLevel: camera.zoom,
        mapCenter: camera.center,
      );
    });
  }

  @override
  Widget build(BuildContext context) {
    return GetBuilder<PhotoFootprintMapController>(
      init: PhotoFootprintMapController(),
      builder: (ctrl) {
        // ⭐ 快照（**在 Obx 之外**读）：initialCenter / initialZoom 只用于首帧初始化相机
        // （FlutterMap 的 key 带 rebuildSeed，换瓦片服务器才会重建）。
        // 放在 Obx 外读 ⇒ 平移/缩放时整个 Stack 不再重建。
        // ⚠️ 别把这两行搬进 Obx，否则拖动时每帧重建整棵树（就是卡顿的主因）。
        final initialCenter = ctrl.center.value;
        final initialZoom = ctrl.zoom.value;
        return Obx(() {
          final isMobile = DeviceUtils.isMobile;
          final zi = ctrl.zoomInfo.value;
          final token = ApiController.instance.accessToken ?? '';
          final baseUrl = ApiController.instance.baseUrl;
          final isP2p = ApiController.instance.isP2pMode;

          if (isP2p && !DeviceUtils.isWeb && _localProxyBase == null) {
            WidgetsBinding.instance.addPostFrameCallback((_) async {
              if (!mounted || _localProxyBase != null) return;
              final base = await LocalWebAssetServer.instance.acquire();
              if (!mounted) return;
              setState(() {
                _localProxyBase = base;
                _localProxyAcquired = true;
              });
            });
          }
          if (!isP2p && !DeviceUtils.isWeb && _localProxyBase != null) {
            _localProxyAcquired = false;
            _localProxyBase = null;
          }

          final rebuildSeed = ctrl.mapRebuildSeed?.value ?? 0;
          if (_lastMapRebuildSeed != rebuildSeed) {
            _lastMapRebuildSeed = rebuildSeed;
            // 清空 Flutter 内存图片缓存，防止切换瓦片服务器后旧类型瓦片短暂显示
            PaintingBinding.instance.imageCache.clear();
            PaintingBinding.instance.imageCache.clearLiveImages();
            final old = _mapController;
            _mapController = MapController();
            _mapReady = false;
            _initialFetchTriggered = false;
            WidgetsBinding.instance.addPostFrameCallback((_) {
              old.dispose();
            });
          }

          final tileBase = isP2p
              ? (DeviceUtils.isWeb
                    ? '/__p2p__'
                    : (_localProxyBase?.toString() ?? ''))
              : baseUrl;
          final urlTemplate = tileBase.isEmpty
              ? ''
              : (token.isNotEmpty
                    ? '$tileBase/api/mapApi/tile?zoom={z}&x={x}&y={y}&seed=$rebuildSeed&accessToken=${Uri.encodeComponent(token)}'
                    : '$tileBase/api/mapApi/tile?zoom={z}&x={x}&y={y}&seed=$rebuildSeed');

          final minZoom = zi?.minZoom.toDouble() ?? 3.0;
          final maxZoom = zi?.maxZoom.toDouble() ?? 18.0;
          // ⭐ 让开标题栏：窗口按钮（最小化/最大化/关闭）在右上角，
          // 「切换地图」浮动按钮若贴在 top:10 会被压住（2026-10-09）。
          // 下移到标题栏之下（跟随皮肤标题栏高度）。
          final switchButtonTop = PcAppWindow.titleBarHeightFor(context) + 8;

          _scheduleInitialFetch(ctrl);
          final customColors = Theme.of(context).extension<CustomColors>();

          return Stack(
            fit: StackFit.expand,
            children: [
              FlutterMap(
                key: ValueKey('photo_footprint_map_$rebuildSeed'),
                mapController: _mapController,
                options: MapOptions(
                  initialCenter: initialCenter,
                  initialZoom: initialZoom,
                  initialRotation: 0,
                  minZoom: minZoom,
                  maxZoom: maxZoom,
                  interactionOptions: InteractionOptions(
                    flags: isMobile
                        ? (InteractiveFlag.all & ~InteractiveFlag.rotate)
                        : InteractiveFlag.all,
                  ),
                  onMapReady: () {
                    _mapReady = true;
                    _scheduleInitialFetch(ctrl);
                  },
                  onPositionChanged: (pos, _) {
                    final b = pos.visibleBounds;
                    final c = pos.center;
                    final z = pos.zoom;
                    ctrl.onMapChanged(bounds: b, zoomLevel: z, mapCenter: c);
                  },
                ),
                children: [
                  if (urlTemplate.isNotEmpty)
                    TileLayer(
                      urlTemplate: urlTemplate,
                      userAgentPackageName: 'NasCabOS',
                      tileProvider: isP2p && !DeviceUtils.isWeb
                          ? CachedNetworkTileProvider()
                          : null,
                      tileBuilder: (context, tileWidget, tile) {
                        return Container(
                          color: Colors.grey.shade300,
                          child: tileWidget,
                        );
                      },
                    ),
                  // ⭐ marker 层单独一个 Obx：只依赖 `items`（重新拉取才会变，已有 650ms 防抖）
                  // 和 `markerSizeTier`（缩放跨档才变一次）。
                  // 平移/缩放过程中 zoom 每帧都在变，但**这里不读 zoom** ⇒
                  // 拖动时不会重建 marker（原来每帧重建 N 个 marker 是卡顿主因）。
                  Obx(
                    () => MarkerLayer(
                      markers: ctrl.clusters
                          .map((e) => _markerForCluster(context, ctrl, e))
                          .toList(),
                    ),
                  ),
                ],
              ),
              Positioned(
                top: switchButtonTop,
                right: 12,
                child: isMobile
                    ? _FloatingSwitchMapButton(
                        onTap: () => _openSwitchMapDialog(context, ctrl),
                        text: 'photo_map_switch'.tr,
                      )
                    : SafeArea(
                        child: _FloatingSwitchMapButton(
                          onTap: () => _openSwitchMapDialog(context, ctrl),
                          text: 'photo_map_switch'.tr,
                        ),
                      ),
              ),
              Positioned(
                left: 12,
                bottom: 12,
                // 单独 Obx：只有这个小徽章跟着 zoom 重建
                child: Obx(
                  () => _InfoBadge(
                    text:
                        '${'zoom_level'.tr}: ${ctrl.zoom.value.toStringAsFixed(1)}',
                  ),
                ),
              ),
              Positioned(
                right: 12,
                bottom: 12,
                // 单独 Obx：缩放按钮只关心 zoom（用来在到顶/到底时禁用）
                child: Obx(
                  () => _MapZoomButtons(
                    mapController: _mapController,
                    currentZoom: ctrl.zoom.value,
                    minZoom: minZoom,
                    maxZoom: maxZoom,
                    onZoomChanged: () {
                      final camera = _mapController.camera;
                      ctrl.onMapChanged(
                        bounds: camera.visibleBounds,
                        zoomLevel: camera.zoom,
                        mapCenter: camera.center,
                      );
                    },
                  ),
                ),
              ),
              Positioned(
                top: 0,
                left: 0,
                right: 0,
                height: 40,
                child: IgnorePointer(
                  child: DecoratedBox(
                    decoration: BoxDecoration(
                      gradient: LinearGradient(
                        begin: Alignment.topCenter,
                        end: Alignment.bottomCenter,
                        colors: [
                          Colors.black.withValues(alpha: 0.45),
                          Colors.transparent,
                        ],
                      ),
                    ),
                  ),
                ),
              ),
              if (ctrl.loading.value)
                const Positioned.fill(
                  child: IgnorePointer(
                    child: Center(child: CircularProgressIndicator()),
                  ),
                ),
              if (ctrl.errorText.value.isNotEmpty)
                Positioned(
                  left: 12,
                  right: 12,
                  bottom: 56,
                  child: _InfoBadge(text: ctrl.errorText.value),
                ),
              if (_nearbyTimelineVisible)
                Positioned.fill(
                  child: Material(
                    color: customColors?.mainContentBgColor,
                    child: SafeArea(
                      child: Column(
                        children: [
                          Container(
                            height: 46,
                            padding: const EdgeInsets.symmetric(horizontal: 8),
                            decoration: BoxDecoration(
                              border: Border(
                                bottom: BorderSide(
                                  color: Get.theme.dividerColor,
                                ),
                              ),
                            ),
                            child: Row(
                              children: [
                                IconButton(
                                  tooltip: 'back'.tr,
                                  onPressed: () {
                                    setState(() {
                                      _nearbyTimelineVisible = false;
                                    });
                                  },
                                  icon: const Icon(Icons.close),
                                ),
                                Expanded(
                                  child: Text(
                                    "${'location'.tr}-${_nearbyTitle.isNotEmpty ? _nearbyTitle : 'photo_map_location'.tr}",
                                    maxLines: 1,
                                    overflow: TextOverflow.ellipsis,
                                    style: Get.textTheme.titleMedium,
                                  ),
                                ),
                              ],
                            ),
                          ),
                          Expanded(
                            child: PcPhotoTimelineView(
                              key: ValueKey(
                                'map_nearby_timeline_$_nearbyTimelineSeed',
                              ),
                              listType: 'timeline',
                              geohash: _nearbyGeohash,
                              precisionOverride: _nearbyPrecision,
                            ),
                          ),
                        ],
                      ),
                    ),
                  ),
                ),
            ],
          );
        });
      },
    );
  }

  static const double _markerBorderWidth = 2.0;

  String _formatYearMonth(int timestampMs) {
    final d = DateTime.fromMillisecondsSinceEpoch(timestampMs);
    return '${d.year}/${d.month}';
  }

  Marker _markerForCluster(
    BuildContext context,
    PhotoFootprintMapController ctrl,
    PhotoMapCluster cluster,
  ) {
    final item = cluster.seed;
    final p = ctrl.clusterPosition(cluster);
    final fullpath = item.fullpath ?? '';
    final imageUrl = fullpath.isNotEmpty
        ? ApiController.instance.getTinyUrl(fullpath)
        : '';
    final theme = Theme.of(context);
    // 尺寸只跟缩放档位有关（量化过的 Rx，不是连续 zoom），见 _markerSizeForTier。
    final markerSize = _markerSizeForTier(ctrl.markerSizeTier.value);
    final outerRadius = (markerSize * 0.2).clamp(6.0, 14.0);
    final innerRadius = (outerRadius - 2).clamp(4.0, 12.0);
    final fallbackIconSize = (markerSize * 0.35).clamp(16.0, 26.0);
    // 日期条高度和字体随 marker 大小变化
    final barHeight = (markerSize * 0.24).clamp(10.0, 18.0);
    final barFontSize = (markerSize * 0.16).clamp(8.0, 13.0);
    // 底部圆角与 marker 的 innerRadius 一致
    final barBottomRadius = innerRadius;
    final hasDate = item.originalTime != null;

    return Marker(
      width: markerSize,
      height: markerSize,
      point: p,
      child: MouseRegion(
        cursor: SystemMouseCursors.click,
        child: GestureDetector(
          // ⭐ 把该簇聚合到的**全部 geohash 格**传下去，保证「点开后列出的照片」
          //   和「地图上这个 marker 角标显示的张数」是同一批（精确集合匹配）。
          onTap: () => _openMarkerDetail(
            context,
            item,
            precisionOverride: cluster.clickPrecision,
            cells: cluster.cells,
          ),
          child: Container(
            decoration: BoxDecoration(
              color: Colors.white,
              borderRadius: BorderRadius.circular(outerRadius),
              border: Border.all(
                color: Colors.white,
                width: _markerBorderWidth,
              ),
            ),
            // ⭐ 聚合角标必须画在 ClipRRect **外面**：它是宽度随位数自适应的椭圆胶囊，
            // 放在圆角裁剪里会被 marker 的圆角切掉一角（用户报「显示不下」就是这个）。
            child: Stack(
              fit: StackFit.expand,
              children: [
                Positioned.fill(
                  child: ClipRRect(
                    borderRadius: BorderRadius.circular(innerRadius),
                    child: Stack(
                      fit: StackFit.expand,
                      children: [
                        imageUrl.isNotEmpty
                            ? CustomExtendedImage(
                                imageUrl: imageUrl,
                                fit: BoxFit.cover,
                                width: double.infinity,
                                height: double.infinity,
                                borderRadius: innerRadius,
                                showLoading: false,
                              )
                            : Container(
                                color: theme.colorScheme.primary.withValues(
                                  alpha: 0.12,
                                ),
                                child: Icon(
                                  Icons.photo,
                                  size: fallbackIconSize,
                                  color: theme.colorScheme.primary,
                                ),
                              ),
                        if (hasDate)
                          Positioned(
                            left: 0,
                            right: 0,
                            bottom: 0,
                            child: Container(
                              height: barHeight,
                              decoration: BoxDecoration(
                                color: Colors.black.withValues(alpha: 0.5),
                                borderRadius: BorderRadius.only(
                                  bottomLeft: Radius.circular(barBottomRadius),
                                  bottomRight: Radius.circular(
                                    barBottomRadius,
                                  ),
                                ),
                              ),
                              alignment: Alignment.center,
                              child: Text(
                                _formatYearMonth(item.originalTime!),
                                style: TextStyle(
                                  color: Colors.white,
                                  fontSize: barFontSize,
                                  fontWeight: FontWeight.w500,
                                ),
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                              ),
                            ),
                          ),
                      ],
                    ),
                  ),
                ),
                // ⭐ 聚合角标：这个 marker 代表的照片数 > 1 时挂一个数字气泡。
                // 缩小时一整片会合成一个大点并显示总数，放大后拆开、数字变 1、角标自动消失
                // —— 这就是「随缩放自动合并/拆分」在 UI 上的落点。
                // ⚠️ 数字来自 `cluster.photoCount`（被合并进来的所有格子之和），
                //    不是单格的 photo_count。
                if (cluster.showBadge)
                  Positioned(
                    top: 0,
                    right: 0,
                    child: _ClusterCountBadge(
                      count: cluster.photoCount,
                      markerSize: markerSize,
                    ),
                  ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  Future<void> _openMarkerDetail(
    BuildContext context,
    PhotoMapIndexItem item, {
    /// 该 marker 的 geohash 聚合档位（2~6）。0 = 未知，回退到 [PhotoMapIndexItem.cellPrecision]。
    /// 仅在拿不到 [cells]（老服务端响应）时才作为兜底判据。
    int precisionOverride = 0,

    /// ⭐ 该 marker 聚合到的全部 geohash 格（精度 = 服务端 cellPrecision）。
    /// 非空时优先下发给时间轴做精确集合匹配。
    List<String> cells = const <String>[],
  }) async {
    // ⭐ 带上真实坐标：服务端按「离照片最近」取地名。
    // 不给坐标时会退化成用 geohash 格中心反查 —— 市区里几公里的偏差就足以选错地名
    // （林和西被标成 11km 外的「鱼珠」就是这么来的）。
    final geoRes = await PhotoMapApiService.instance.getLocationStr(
      geohash: item.geohash,
      latitude: item.latitude,
      longitude: item.longitude,
    );
    final geoName = geoRes.success ? geoRes.data?.toString() ?? '' : null;
    if (!context.mounted) return;

    final title =
        "${'location'.tr}-${(geoName ?? '').isNotEmpty ? geoName : 'photo_map_location'.tr}";
    // ⭐ 把该 marker 的聚合范围内下发给时间轴。
    // 有格集合就传格集合（逗号分隔，服务端精确匹配）；没有才退回 seed 的 geohash 前缀。
    final geohashParam = cells.isNotEmpty ? cells.join(',') : item.geohash;
    if (DeviceUtils.isMobile) {
      await Get.to(
        () => AppPhotoFootprintNearbyTimelinePage(
          title: title,
          geohash: geohashParam,
          precisionOverride: precisionOverride > 0
              ? precisionOverride
              : (item.cellPrecision ?? 0),
        ),
      );
      return;
    }

    setState(() {
      _nearbyTitle = geoName ?? '';
      _nearbyGeohash = geohashParam;
      // 优先用客户端聚合算出来的档位，其次才是服务端给的格子档位
      _nearbyPrecision = precisionOverride > 0
          ? precisionOverride
          : (item.cellPrecision ?? 0);
      _nearbyTimelineVisible = true;
      _nearbyTimelineSeed += 1;
    });
  }

  Future<void> _openSwitchMapDialog(
    BuildContext context,
    PhotoFootprintMapController ctrl,
  ) async {
    await ctrl.refreshTileServerList();
    if (!context.mounted) return;

    showDialog(
      context: context,
      builder: (ctx) {
        return AlertDialog(
          title: Text('photo_map_switch_title'.tr),
          content: SizedBox(
            width: 520,
            child: Obx(() {
              final list = ctrl.tileServerList;
              if (list.isEmpty) {
                return Center(child: Text('no_data'.tr));
              }
              return ListView.separated(
                shrinkWrap: true,
                itemCount: list.length,
                separatorBuilder: (_, i) => const Divider(height: 1),
                itemBuilder: (_, i) {
                  final s = list[i];
                  final title = s.name;
                  final sub =
                      '${s.coordinate}  ${'zoom_level'.tr}:${s.maxLevel}';
                  return ListTile(
                    title: Text(title),
                    subtitle: Text(sub),
                    trailing: s.isCurrent
                        ? Icon(
                            Icons.check,
                            color: Theme.of(ctx).colorScheme.primary,
                          )
                        : null,
                    onTap: () async {
                      Navigator.of(ctx).pop();
                      final ok = await ctrl.switchTileServer(s);
                      if (!context.mounted) return;
                      if (ok) {
                        final camera = _mapController.camera;
                        ctrl.onMapChanged(
                          bounds: camera.visibleBounds,
                          zoomLevel: camera.zoom,
                          mapCenter: camera.center,
                        );
                      }
                      if (!ok) {
                        ScaffoldMessenger.of(context).showSnackBar(
                          SnackBar(content: Text('operation_failed'.tr)),
                        );
                      }
                    },
                  );
                },
              );
            }),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.of(ctx).pop(),
              child: Text('cancel'.tr),
            ),
          ],
        );
      },
    );
  }
}

class AppPhotoFootprintNearbyTimelinePage extends StatefulWidget {
  final String title;
  final String? geohash;

  /// ⭐ 地图上该 marker 的聚合档位（2~6，0 = 未指定）。
  /// 传下去让列表反查范围与地图聚合范围一致，见 [PhotoTimelineController.precisionOverride]。
  final int precisionOverride;

  const AppPhotoFootprintNearbyTimelinePage({
    super.key,
    required this.title,
    required this.geohash,
    this.precisionOverride = 0,
  });

  @override
  State<AppPhotoFootprintNearbyTimelinePage> createState() =>
      _AppPhotoFootprintNearbyTimelinePageState();
}

class _AppPhotoFootprintNearbyTimelinePageState
    extends State<AppPhotoFootprintNearbyTimelinePage> {
  late final String _timelineTag;

  @override
  void initState() {
    super.initState();
    _timelineTag =
        'app_photo_map_geo_${widget.geohash ?? 'unknown'}_${UniqueKey()}';
  }

  @override
  Widget build(BuildContext context) {
    return GetBuilder<PhotoTimelineController>(
      init: PhotoTimelineController(
        initialListType: 'timeline',
        initialGeohash: widget.geohash,
        precisionOverride: widget.precisionOverride,
      ),
      tag: _timelineTag,
      dispose: (_) {
        Get.delete<PhotoTimelineController>(tag: _timelineTag);
      },
      builder: (_) {
        return Scaffold(
          appBar: AppBar(
            title: Text(widget.title),
            leading: IconButton(
              tooltip: 'back'.tr,
              onPressed: () => Get.back(),
              icon: const Icon(Icons.arrow_back),
            ),
          ),
          body: AppPhotoTimelineView(
            controllerTag: _timelineTag,
            showSearchAction: true,
          ),
          bottomNavigationBar: AppPhotoTimelineMultiSelectBottomBar(
            controllerTag: _timelineTag,
          ),
        );
      },
    );
  }
}

class _FloatingSwitchMapButton extends StatelessWidget {
  final VoidCallback onTap;
  final String text;

  const _FloatingSwitchMapButton({required this.onTap, required this.text});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Material(
      color: theme.colorScheme.surface.withValues(alpha: 0.7),
      borderRadius: BorderRadius.circular(12),
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(12),
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(Icons.layers_outlined, color: theme.colorScheme.onSurface),
              const SizedBox(width: 6),
              Text(text, style: theme.textTheme.bodyMedium),
            ],
          ),
        ),
      ),
    );
  }
}

class _MapZoomButtons extends StatelessWidget {
  final MapController mapController;
  final double currentZoom;
  final double minZoom;
  final double maxZoom;
  final VoidCallback onZoomChanged;

  const _MapZoomButtons({
    required this.mapController,
    required this.currentZoom,
    required this.minZoom,
    required this.maxZoom,
    required this.onZoomChanged,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final canZoomIn = currentZoom < maxZoom;
    final canZoomOut = currentZoom > minZoom;
    return Material(
      color: theme.colorScheme.surface.withValues(alpha: 0.92),
      borderRadius: BorderRadius.circular(10),
      child: Container(
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(10),
          border: Border.all(color: theme.dividerColor),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            IconButton(
              icon: Icon(Icons.remove, color: theme.colorScheme.onSurface),
              onPressed: canZoomOut
                  ? () {
                      final camera = mapController.camera;
                      final newZoom = (currentZoom - 1).clamp(minZoom, maxZoom);
                      mapController.move(camera.center, newZoom);
                      onZoomChanged();
                    }
                  : null,
              tooltip: 'zoom_out'.tr,
            ),
            IconButton(
              icon: Icon(Icons.add, color: theme.colorScheme.onSurface),
              onPressed: canZoomIn
                  ? () {
                      final camera = mapController.camera;
                      final newZoom = (currentZoom + 1).clamp(minZoom, maxZoom);
                      mapController.move(camera.center, newZoom);
                      onZoomChanged();
                    }
                  : null,
              tooltip: 'zoom_in'.tr,
            ),
          ],
        ),
      ),
    );
  }
}

class _InfoBadge extends StatelessWidget {
  final String text;

  const _InfoBadge({required this.text});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
      decoration: BoxDecoration(
        color: theme.colorScheme.surface.withValues(alpha: 0.92),
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: theme.dividerColor),
      ),
      child: Text(text, style: theme.textTheme.bodySmall),
    );
  }
}

/// 地图 marker 右上角的聚合数量气泡。
///
/// 数字来自 [PhotoMapCluster.photoCount]（被合并进来的所有格子之和），
/// 只在 > 1 时显示；放大到这一簇只剩一张照片时角标自动消失，
/// 这就是「缩放时聚合 ↔ 拆分」在视觉上的体现。
class _ClusterCountBadge extends StatelessWidget {
  final int count;
  final double markerSize;

  const _ClusterCountBadge({required this.count, required this.markerSize});

  /// 最多显示 **5 位**数字（用户要求「最多要装下 5 位」）；再大才用「123k」紧凑写法。
  /// 旧实现 4 位就转 k，「9999」在 30px 的正圆里已经放不下被裁掉了。
  static String _format(int n) {
    if (n <= 0) return '';
    if (n < 100000) return '$n';
    final k = n / 1000;
    return '${k.toStringAsFixed(k >= 100 ? 0 : 1)}k';
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final label = _format(count);
    // 气泡随 marker 缩放，但设上下限：小 marker 上不能缩到看不清，大 marker 上别糊满
    final h = (markerSize * 0.42).clamp(16.0, 30.0);
    // ⭐ 字号比原来小一号（0.55 → 0.46，上限 15 → 13），给 5 位数腾出宽度
    final fontSize = (h * 0.46).clamp(9.0, 13.0);

    return Container(
      constraints: BoxConstraints(minWidth: h, minHeight: h),
      padding: EdgeInsets.symmetric(horizontal: h * 0.24),
      decoration: BoxDecoration(
        color: theme.colorScheme.primary,
        // ⭐ 椭圆胶囊：**宽度随数字位数自适应**（原来是 `shape: BoxShape.circle` ——
        // 正圆直径被 minWidth/minHeight 卡死，5 位数只能被裁掉，就是「显示不下」的原因）
        borderRadius: BorderRadius.circular(h / 2),
        border: Border.all(color: Colors.white, width: 1.5),
        boxShadow: [
          BoxShadow(
            color: Colors.black.withValues(alpha: 0.3),
            blurRadius: 3,
            offset: const Offset(0, 1),
          ),
        ],
      ),
      alignment: Alignment.center,
      child: Text(
        label,
        maxLines: 1,
        overflow: TextOverflow.clip,
        style: TextStyle(
          color: theme.colorScheme.onPrimary,
          fontSize: fontSize,
          fontWeight: FontWeight.w700,
          height: 1.0,
        ),
      ),
    );
  }
}
