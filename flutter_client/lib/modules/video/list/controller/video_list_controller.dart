import 'dart:async';
import 'package:get/get.dart';
import '../../../../utils/cache_manager.dart';
import '../../base/beans/video_item_bean.dart';
import '../../base/services/video_item_sync_service.dart';
import '../../media_browser/bean/media_folder_item.dart';
import '../../media_browser/service/media_folder_api_service.dart';
import '../service/video_list_api_service.dart';
import '../view/parts/video_list_sort_menu.dart';
import '../../../../utils/device_utils.dart';

enum VideoListSortBy { favoriteTime, viewTime, year, score, createTime, name, takenTime }

enum VideoListSortOrder { asc, desc }

class VideoListYearGroup {
  final String label;
  final List<int> years;
  final bool single;
  const VideoListYearGroup({
    required this.label,
    required this.years,
    required this.single,
  });
}

class VideoListSourceFilterStorage {
  static const String _cacheKeyPrefix = 'video_list_selected_source_paths';
  final CacheManager _cacheManager = CacheManager();

  String _buildCacheKey({
    required String listType,
    required String mediaType,
  }) {
    final lt = listType.trim().isEmpty ? 'default' : listType.trim();
    final mt = mediaType.trim().isEmpty ? 'all' : mediaType.trim();
    return '${_cacheKeyPrefix}_${lt}_$mt';
  }

  Future<List<String>> restoreSelection({
    required String listType,
    required String mediaType,
    required Iterable<String> availablePaths,
  }) async {
    final cacheKey = _buildCacheKey(listType: listType, mediaType: mediaType);
    List<String> savedPaths;
    try {
      savedPaths = _normalizePaths(_cacheManager.getStringList(cacheKey));
    } catch (_) {
      return const <String>[];
    }
    if (savedPaths.isEmpty) {
      return const <String>[];
    }
    final availablePathSet = _normalizePaths(availablePaths).toSet();
    final restoredPaths = savedPaths
        .where(availablePathSet.contains)
        .toList(growable: false);
    if (_samePaths(savedPaths, restoredPaths)) {
      return restoredPaths;
    }
    await saveSelection(
      listType: listType,
      mediaType: mediaType,
      paths: restoredPaths,
    );
    return restoredPaths;
  }

  Future<void> saveSelection({
    required String listType,
    required String mediaType,
    required Iterable<String> paths,
  }) async {
    final cacheKey = _buildCacheKey(listType: listType, mediaType: mediaType);
    final normalizedPaths = _normalizePaths(paths);
    if (normalizedPaths.isEmpty) {
      try {
        await _cacheManager.remove(cacheKey);
      } catch (_) {}
      return;
    }
    try {
      await _cacheManager.setStringList(cacheKey, normalizedPaths);
    } catch (_) {}
  }

  List<String> _normalizePaths(Iterable<String>? paths) {
    if (paths == null) {
      return const <String>[];
    }
    final normalized = <String>[];
    final seen = <String>{};
    for (final rawPath in paths) {
      final path = rawPath.trim();
      if (path.isEmpty || !seen.add(path)) {
        continue;
      }
      normalized.add(path);
    }
    return normalized;
  }

  bool _samePaths(List<String> left, List<String> right) {
    if (left.length != right.length) {
      return false;
    }
    for (var index = 0; index < left.length; index++) {
      if (left[index] != right[index]) {
        return false;
      }
    }
    return true;
  }
}

class VideoListController extends GetxController {
  static const String _keySortBy = 'video_list_sort_by';
  static const String _keySortOrder = 'video_list_sort_order';
  static const String _keyPosterScale = 'video_list_poster_scale';
  /// 图片模式的持久化**前缀**，实际 key 会再拼上「库 / 影集」后缀。
  static const String _keyShowFanartPrefix = 'video_list_show_fanart';
  /// 布局模式（瀑布流 / 普通网格）的持久化前缀，同样按「库 / 影集」分开存。
  static const String _keyWaterfallPrefix = 'video_list_waterfall';
  /// 名称显示开关的持久化前缀，同样按「库 / 影集」分开存。
  static const String _keyShowNamePrefix = 'video_list_show_name';
  static double posterScaleMin = DeviceUtils.isMobile ? 0.9 : 0.7;
  static double posterScaleMax = DeviceUtils.isMobile ? 1.6 : 1.4;
  static const double posterScaleStep = 0.1;
  static final RxDouble sharedPosterScale = 1.0.obs;
  static bool _posterScaleLoaded = false;


  final String initialMediaType;
  final String listType;
  final int? albumId;
  final int? collectionId;
  final int? smartAlbumId;
  /// 影视库 id：>0 时只列出该库来源下的条目
  final int libraryId;
  final List<String> initialGenres;
  final List<String> initialRegions;
  final List<String> initialActors;
  final List<String> initialDirectors;

  /// 是否进「文件夹层级」模式（图片库 / 混合库专用）。
  /// 做成 Rx 而不是 final，是为了顶栏那个「文件夹 / 全部平铺」按钮能实时切。
  final RxBool folderViewEnabled;
  VideoListController({
    required this.initialMediaType,
    this.listType = '',
    this.albumId,
    this.collectionId,
    this.smartAlbumId,
    this.libraryId = 0,
    this.initialGenres = const <String>[],
    this.initialRegions = const <String>[],
    this.initialActors = const <String>[],
    this.initialDirectors = const <String>[],
    bool folderView = false,
  }) : folderViewEnabled = folderView.obs;

  bool get isFavoriteList => listType.trim().toLowerCase() == 'favorite';
  bool get isAlbumList => (albumId ?? 0) > 0;

  // 当前列表数据
  final RxList<VideoHomeItemBean> items = <VideoHomeItemBean>[].obs;
  // 首屏加载状态
  final RxBool loading = false.obs;
  // 分页加载状态
  final RxBool loadingMore = false.obs;
  // 是否还有更多页
  final RxBool hasMore = true.obs;
  // 自动加载失败时，显示“加载更多”按钮兜底
  final RxBool autoLoadFailed = false.obs;

  // 后端返回的总数（用于UI展示可选）
  final RxInt total = 0.obs;

  // 当前媒体类型：movie / tv
  final RxString mediaType = ''.obs;
  // 搜索关键字（nfo_name / filename）
  final RxString searchText = ''.obs;
  // 筛选：genres / region（后端使用索引表 video_index2key 精确匹配）
  final RxList<String> genres = <String>[].obs;
  final RxList<String> regions = <String>[].obs;
  final RxList<String> actors = <String>[].obs;
  final RxList<String> directors = <String>[].obs;
  final RxList<int> selectedYears = <int>[].obs;

  final RxList<String> availableGenres = <String>[].obs;
  final RxList<String> availableRegions = <String>[].obs;
  final RxList<int> availableYears = <int>[].obs;
  final RxList<int> baseAvailableYears = <int>[].obs;

  final RxList<VideoListPathItem> availablePaths = <VideoListPathItem>[].obs;
  final RxList<String> selectedPaths = <String>[].obs;
  final VideoListSourceFilterStorage _sourceFilterStorage =
      VideoListSourceFilterStorage();

  final Rx<VideoListSortBy> sortBy = VideoListSortBy.viewTime.obs;
  final Rx<VideoListSortOrder> sortOrder = VideoListSortOrder.desc.obs;
  final RxDouble posterScale = sharedPosterScale;
  /// ⭐ 列表图片模式（2026-10-10）：false = 竖版封面（poster 2:3），
  /// true = 横版缩略图（fanart ≈3:2）。
  ///
  /// ⚠️ **每个库 / 影集各自独立**（刻意不做 static 共享）—— 在一个库里切成
  /// 缩略图不能连带改掉别的库。选择按 [libraryId] / 影集 id / [mediaType]
  /// 分别存（见 [_imageModeStorageSuffix]），重进同一个库还记得上次的。
  final RxBool showFanart = false.obs;

  /// ⭐ 布局模式（2026-10-10）：true = **瀑布流**（每项按自己的宽高比），
  /// false = **普通网格**（统一 4:3，一行对齐）。
  ///
  /// 与 [folderViewEnabled] **正交** —— 「文件夹层级 / 整库平铺」和
  /// 「瀑布流 / 网格」是两个独立的开关，四种组合都成立。
  ///
  /// 同样**按库 / 影集独立持久化**（见 [_imageModeStorageSuffix]），
  /// 默认**开**（图片库/混合库的主要用途就是看图，瀑布流更好看）。
  final RxBool waterfallEnabled = true.obs;

  /// ⭐ 名称显示开关（2026-10-11）：true = 在卡片上显示文件 / 影片名称。
  ///
  /// **呈现位置由布局决定**（用户明确要求）：
  /// * 瀑布流 → 名字压在**图片内部的最下方**（`VideoMediaTile(overlayTitle: true)`），
  ///   不占额外高度 ⇒ 每项的主轴高度仍严格按 `columnWidth / aspect` 计算。
  /// * 普通网格 → 名字写在**图片下方**（和影视列表的卡片一样），
  ///   所以网格的 `childAspectRatio` 要把标题行的高度反算进去。
  ///
  /// 与 [waterfallEnabled] / [showFanart] 一样**按库 / 影集独立持久化**，
  /// 默认**关**（图片库主要用途是看图）。
  final RxBool showName = false.obs;

  // ================== 文件夹层级（图片库 / 混合库专用）==================
  /// 当前所在目录（空串 = 库根）
  final RxString folderPath = ''.obs;
  /// 当前目录的直接子文件夹
  final RxList<MediaFolderItem> subFolders = <MediaFolderItem>[].obs;
  /// 面包屑（从所属来源根一路走到当前目录）
  final RxList<MediaFolderSegment> breadcrumbs = <MediaFolderSegment>[].obs;
  /// 上一级目录；库根 / 来源根为空串（空 = 不能再往上）
  final RxString parentFolderPath = ''.obs;
  final RxBool foldersLoading = false.obs;
  /// 当前目录**自身**（不含子目录）的文件数
  final RxInt selfCount = 0.obs;
  /// 当前目录**整棵子树**的量（本级 + 所有子文件夹），顶栏那个数字用它
  final RxInt subtreeTotal = 0.obs;

  /// 搜索时看整棵子树（否则搜不到子目录里的图）；平时只看本目录自身。
  /// ⚠️ 'exact' 与 'subtree' 是两种不同的服务端口径，别混：
  ///    exact → 只返回 path **恰等于**本目录的行（拼接前缀都不算）
  String get effectiveFolderMode {
    if (!folderViewEnabled.value) return '';
    return searchText.value.trim().isNotEmpty ? 'subtree' : 'exact';
  }

  /// 搜索态下不展示文件夹卡片：结果已经跨目录了，再列目录会自相矛盾
  bool get showFolderCards =>
      folderViewEnabled.value && searchText.value.trim().isEmpty;

  bool get canGoUp =>
      folderViewEnabled.value && parentFolderPath.value.trim().isNotEmpty;

  /// 切进某个目录（传空串 = 回库根）
  Future<void> setFolder(String path) async {
    final next = path.trim();
    if (next == folderPath.value) return;
    folderPath.value = next;
    items.clear();
    await refreshList(showLoading: true);
  }

  Future<void> goUp() async {
    if (!canGoUp) return;
    await setFolder(parentFolderPath.value);
  }

  /// 文件夹视图 ↔ 整库平铺
  Future<void> setFolderView(bool enabled) async {
    if (folderViewEnabled.value == enabled) return;
    folderViewEnabled.value = enabled;
    if (!enabled) {
      folderPath.value = '';
      subFolders.clear();
      breadcrumbs.clear();
      parentFolderPath.value = '';
      selfCount.value = 0;
      subtreeTotal.value = 0;
    }
    items.clear();
    await refreshList(showLoading: true);
  }

  /// 拉当前目录的子文件夹。
  /// **失败不抛**：文件夹列表挂了不该连带把本级文件的瀑布流也弄崩 ——
  /// 后者才是用户最需要看到的内容。
  Future<void> loadFolders() async {
    if (!showFolderCards || libraryId <= 0) {
      subFolders.clear();
      breadcrumbs.clear();
      parentFolderPath.value = '';
      selfCount.value = 0;
      return;
    }
    foldersLoading.value = true;
    try {
      final level = await MediaFolderApiService.instance.listFolders(
        libraryId: libraryId,
        folderPath: folderPath.value,
      );
      subFolders.assignAll(level.folders);
      breadcrumbs.assignAll(level.segments);
      parentFolderPath.value = level.parentPath ?? '';
      selfCount.value = level.selfCount;
      subtreeTotal.value =
          level.selfCount + level.folders.fold<int>(0, (a, f) => a + f.count);
    } catch (_) {
      subFolders.clear();
      breadcrumbs.clear();
      parentFolderPath.value = '';
      selfCount.value = 0;
    } finally {
      foldersLoading.value = false;
    }
  }

  /// ⭐ 这个列表是不是「图片 / 混合库」（走 [VideoMediaBrowserPage]）。
  ///
  /// 判据是 [initialMediaType]：图片库传 'image'，混合库传 ''（不限定类型），
  /// 影视库传 'movie' / 'tv'。见 `VideoMediaBrowserPage` 构造 controller 的地方。
  bool get isMediaGridLibrary {
    final mt = initialMediaType.trim().toLowerCase();
    return mt == 'image' || mt.isEmpty;
  }

  bool get hasActiveFilters =>
      genres.isNotEmpty ||
      regions.isNotEmpty ||
      actors.isNotEmpty ||
      directors.isNotEmpty ||
      selectedYears.isNotEmpty;

  int get selectedYearGroupCount {
    if (selectedYears.isEmpty) return 0;
    final groups = getYearGroups();
    if (groups.isEmpty) return 1;
    final selected = selectedYears.toSet();
    final selectedGroupCount = groups.where((g) {
      if (g.single) {
        return selected.length == 1 && selected.contains(g.years.first);
      }
      return g.years.every(selected.contains);
    }).length;
    return selectedGroupCount > 0 ? selectedGroupCount : 1;
  }

  int get activeFilterCount =>
      genres.length +
      regions.length +
      actors.length +
      directors.length +
      selectedYearGroupCount;

  bool get hasCustomSort {
    // ⭐ 图片 / 混合库（2026-10-12）：默认是 name asc，不是 createTime desc；
    //    这里若沿用影视库口径，会把「名字升序」误判成"用户自定义过"，
    //    导致排序图标高亮 / 重置按钮逻辑出错。
    if (isMediaGridLibrary) {
      return sortBy.value != VideoListSortBy.name ||
          sortOrder.value != VideoListSortOrder.asc;
    }
    final defaultBy = isFavoriteList
        ? VideoListSortBy.favoriteTime
        : VideoListSortBy.createTime;
    return sortBy.value != defaultBy ||
        sortOrder.value != VideoListSortOrder.desc;
  }

  int _page = 1;
  final int _pageSize = 30;

  /// ⭐ 混合库翻页游标（2026-10-12）：服务端 _listMixedPaged 用「排序键 + 来源侧
  /// + 表内 id」做 keyset 分页（两表归并下 offset 分页必然重复）。第一页为空，
  /// 之后每页把响应里的 nextCursor 存下来、下一页原样回传。
  /// 图片库 / 影视库服务端返回空串 ⇒ 这个变量恒为空，行为与原来完全一致。
  String _cursor = '';
  Timer? _searchDebounce;
  StreamSubscription<int>? _deletedSubscription;

  /// 排序持久化键后缀。
  ///
  /// ⭐ 图片 / 混合库（2026-10-12）：必须走 [\_imageModeStorageSuffix]，
  /// 与 [\_showFanartKey] / [\_waterfallKey] / [\_showNameKey] 一个口径 ——
  /// 因为这些入口**都不带 listType**，若按 listType 取后缀，所有图片库 /
  /// 影集全会撞到同一个 `default` 键，A 库选的排序会串到 B 库去。
  /// 影视库没有 libraryId/collectionId…，[listType] 本身就唯一，行为不变。
  String _sortStorageSuffix() {
    if (isMediaGridLibrary || libraryId > 0) {
      return _imageModeStorageSuffix();
    }
    final t = listType.trim();
    return t.isEmpty ? 'default' : t;
  }

  static double normalizePosterScale(double value) {
    final clamped = value.clamp(posterScaleMin, posterScaleMax);
    return (clamped * 100).roundToDouble() / 100;
  }

  static void ensureSharedPosterScaleLoaded() {
    if (_posterScaleLoaded) return;
    sharedPosterScale.value = loadStoredPosterScale();
    _posterScaleLoaded = true;
  }

  static double loadStoredPosterScale() {
    try {
      final cached = CacheManager().getDouble(_keyPosterScale);
      if (cached == null || !cached.isFinite) return 1.0;
      return normalizePosterScale(cached);
    } catch (_) {
      return 1.0;
    }
  }

  VideoListSortBy? _parseSortBy(String? s) {
    final t = s?.trim();
    if (t == null || t.isEmpty) return null;
    switch (t) {
      case 'favorite_time':
        return VideoListSortBy.favoriteTime;
      case 'view_time':
        return VideoListSortBy.viewTime;
      case 'year':
        return VideoListSortBy.year;
      case 'score':
        return VideoListSortBy.score;
      case 'create_time':
        return VideoListSortBy.createTime;
      case 'name':
        return VideoListSortBy.name;
      case 'taken_at':
        // ⭐ 拍摄时间（2026-10-12）：与 [_toSortByParam] 的映射必须成对，
        //    漏了这个 case 会导致「选了拍摄时间 → 重进库又退回默认」。
        return VideoListSortBy.takenTime;
      default:
        return null;
    }
  }

  VideoListSortOrder? _parseSortOrder(String? s) {
    final t = s?.trim();
    if (t == null || t.isEmpty) return null;
    switch (t) {
      case 'asc':
        return VideoListSortOrder.asc;
      case 'desc':
        return VideoListSortOrder.desc;
      default:
        return null;
    }
  }

  void _loadSortSettings() {
    try {
      final suf = _sortStorageSuffix();
      final byStr = CacheManager().getString('${_keySortBy}_$suf');
      final orderStr = CacheManager().getString('${_keySortOrder}_$suf');
      // 缺一半、空串、脏数据：一律不应用，保持 onInit 已设的默认排序
      if (byStr == null ||
          orderStr == null ||
          byStr.trim().isEmpty ||
          orderStr.trim().isEmpty) {
        return;
      }
      final by = _parseSortBy(byStr);
      final order = _parseSortOrder(orderStr);
      if (by == null || order == null) return;
      if (!videoListSortPairMatchesMenu(this, by, order)) return;
      sortBy.value = by;
      sortOrder.value = order;
    } catch (_) {}
  }

  void _saveSortSettings() {
    try {
      final suf = _sortStorageSuffix();
      CacheManager().setString(
        '${_keySortBy}_$suf',
        _toSortByParam(sortBy.value),
      );
      CacheManager().setString(
        '${_keySortOrder}_$suf',
        _toSortOrderParam(sortOrder.value),
      );
    } catch (_) {}
  }

  void _loadPosterScale() {
    ensureSharedPosterScaleLoaded();
  }

  void _savePosterScale() {
    try {
      final normalized = normalizePosterScale(posterScale.value);
      posterScale.value = normalized;
      CacheManager().setDouble(_keyPosterScale, normalized);
    } catch (_) {}
  }

  /// 图片模式的持久化键后缀 —— **让每个库 / 影集各自独立**。
  ///
  /// 优先用具体的容器 id；都没有（「全部」这类入口）才退到 [initialMediaType]。
  String _imageModeStorageSuffix() {
    final parts = <String>[];
    if (libraryId > 0) parts.add('lib$libraryId');
    if (collectionId != null && collectionId! > 0) {
      parts.add('col$collectionId');
    }
    if (smartAlbumId != null && smartAlbumId! > 0) {
      parts.add('smart$smartAlbumId');
    }
    if (albumId != null && albumId! > 0) parts.add('alb$albumId');
    if (parts.isEmpty) {
      final mt = initialMediaType.trim();
      parts.add(mt.isEmpty ? 'default' : mt);
    }
    return parts.join('_');
  }

  String get _showFanartKey =>
      '${_keyShowFanartPrefix}_${_imageModeStorageSuffix()}';

  void _loadShowFanart() {
    try {
      showFanart.value = CacheManager().getBool(_showFanartKey) ?? false;
    } catch (_) {
      showFanart.value = false;
    }
  }

  /// 切换**当前库**的图片模式：false = 竖版封面，true = 横版缩略图。
  /// 只影响这一个库 / 影集，并且它自己记住自己的选择。
  void setShowFanart(bool on) {
    if (showFanart.value == on) return;
    showFanart.value = on;
    try {
      CacheManager().setBool(_showFanartKey, on);
    } catch (_) {}
  }

  String get _waterfallKey =>
      '${_keyWaterfallPrefix}_${_imageModeStorageSuffix()}';

  void _loadWaterfall() {
    try {
      waterfallEnabled.value = CacheManager().getBool(_waterfallKey) ?? true;
    } catch (_) {
      waterfallEnabled.value = true;
    }
  }

  /// 切换**当前库**的布局：true = 瀑布流，false = 普通网格。
  /// 纯 UI 状态，不重新拉数据。
  void setWaterfall(bool on) {
    if (waterfallEnabled.value == on) return;
    waterfallEnabled.value = on;
    try {
      CacheManager().setBool(_waterfallKey, on);
    } catch (_) {}
  }

  String get _showNameKey =>
      '${_keyShowNamePrefix}_${_imageModeStorageSuffix()}';

  void _loadShowName() {
    try {
      showName.value = CacheManager().getBool(_showNameKey) ?? false;
    } catch (_) {
      showName.value = false;
    }
  }

  /// 切换**当前库**的名称显示：true = 显示名称。
  /// 纯 UI 状态，不重新拉数据；渲染位置随布局自动切换（见 [showName]）。
  void setShowName(bool on) {
    if (showName.value == on) return;
    showName.value = on;
    try {
      CacheManager().setBool(_showNameKey, on);
    } catch (_) {}
  }

  @override
  void onInit() {
    super.onInit();
    _deletedSubscription = VideoItemSyncService.deletedStream.listen(
      _handleExternalDelete,
    );
    mediaType.value = initialMediaType;
    // ⭐ 图片 / 混合库的默认排序 = **名字升序**（需求 2026-10-12）。
    //    ⚠️ 必须放在 `_loadSortSettings()` **之前**：那个方法读不到缓存时会
    //    保留这里设的默认值；读到缓存（用户上次手动选过）则覆盖它。
    //    影视库维持原来的 viewTime desc 不动。
    if (isMediaGridLibrary) {
      sortBy.value = VideoListSortBy.name;
      sortOrder.value = VideoListSortOrder.asc;
    }
    if (isFavoriteList) {
      sortBy.value = VideoListSortBy.favoriteTime;
      sortOrder.value = VideoListSortOrder.desc;
    }
    _loadSortSettings();
    _loadPosterScale();
    _loadShowFanart();
    _loadWaterfall();
    _loadShowName();
    genres.assignAll(
      initialGenres.map((e) => e.trim()).where((e) => e.isNotEmpty),
    );
    regions.assignAll(
      initialRegions.map((e) => e.trim()).where((e) => e.isNotEmpty),
    );
    actors.assignAll(
      initialActors.map((e) => e.trim()).where((e) => e.isNotEmpty),
    );
    directors.assignAll(
      initialDirectors.map((e) => e.trim()).where((e) => e.isNotEmpty),
    );
    refreshList(showLoading: true);
  }

  @override
  void onClose() {
    _deletedSubscription?.cancel();
    _searchDebounce?.cancel();
    super.onClose();
  }

  void _handleExternalDelete(int indexId) {
    if (indexId <= 0) return;
    final before = items.length;
    items.removeWhere((e) => e.id == indexId);
    final removed = before - items.length;
    if (removed > 0) {
      total.value = (total.value - removed).clamp(0, 1 << 30);
    }
  }

  Future<void> refreshList({bool showLoading = false}) async {
    final requestedSelectedPaths = selectedPaths.toList(growable: false);
    loading.value = true;
    autoLoadFailed.value = false;
    try {
      _page = 1;
      _cursor = '';
      final effectiveMediaType = initialMediaType.trim().isNotEmpty
          ? initialMediaType.trim()
          : mediaType.value.trim();
      final res = await VideoListApiService.instance.listPaged(
        page: _page,
        pageSize: _pageSize,
        listType: listType,
        mediaType: effectiveMediaType,
        albumId: albumId,
        collectionId: collectionId,
        smartAlbumId: smartAlbumId,
        libraryId: libraryId > 0 ? libraryId : null,
        search: searchText.value,
        genres: genres.toList(),
        regions: regions.toList(),
        actors: actors.toList(),
        directors: directors.toList(),
        years: selectedYears.toList(),
        // ⭐ 文件夹视图下不发来源筛选：folderPath 本身就是路径口径，
        //    两个一起发会被服务端 intersect 掉，出现「明明在浏览却 403」。
        sourceList: (folderViewEnabled.value || requestedSelectedPaths.isEmpty)
            ? null
            : requestedSelectedPaths,
        sortBy: _toSortByParam(sortBy.value),
        sortOrder: _toSortOrderParam(sortOrder.value),
        folderPath: folderPath.value,
        folderMode: effectiveFolderMode,
        cursor: _cursor,
        showLoading: showLoading,
      );
      items.assignAll(res.items);
      total.value = res.pagination.total;
      hasMore.value = res.pagination.hasNextPage;
      _cursor = res.pagination.nextCursor;
      availablePaths.assignAll(res.validPaths);
      // 子文件夹列表跟本级文件一起取，避免「内容区空白一下再蹦出目录卡片」
      await loadFolders();
      final didRestoreSelectedPaths = await _restoreSelectedPaths(
        effectiveMediaType: effectiveMediaType,
        availablePathItems: res.validPaths,
      );
      if (
        didRestoreSelectedPaths &&
        !_sameSelectedPaths(requestedSelectedPaths, selectedPaths)
      ) {
        await refreshList(showLoading: false);
        return;
      }
      final filters = res.filters;
      if (filters != null) {
        availableGenres.assignAll(filters.genres);
        availableRegions.assignAll(filters.regions);
        availableYears.assignAll(filters.years);
        if (selectedYears.isEmpty) {
          baseAvailableYears.assignAll(filters.years);
        }
      }
    } finally {
      loading.value = false;
    }
  }

  bool _sameSelectedPaths(List<String> left, List<String> right) {
    if (left.length != right.length) {
      return false;
    }
    for (var index = 0; index < left.length; index++) {
      if (left[index] != right[index]) {
        return false;
      }
    }
    return true;
  }

  Future<bool> _restoreSelectedPaths({
    required String effectiveMediaType,
    required List<VideoListPathItem> availablePathItems,
  }) async {
    final restoredPaths = await _sourceFilterStorage.restoreSelection(
      listType: listType,
      mediaType: effectiveMediaType,
      availablePaths: availablePathItems.map((e) => e.path),
    );
    if (_sameSelectedPaths(selectedPaths, restoredPaths)) {
      return false;
    }
    selectedPaths.assignAll(restoredPaths);
    return true;
  }

  Future<void> setSourcePathSelected(
    String path,
    bool isSelected, {
    bool showLoading = false,
  }) async {
    final normalizedPath = path.trim();
    if (normalizedPath.isEmpty) {
      return;
    }
    final nextSelectedPaths = selectedPaths.toList(growable: true);
    final hasSelected = nextSelectedPaths.contains(normalizedPath);
    if (isSelected) {
      if (hasSelected) {
        return;
      }
      nextSelectedPaths.add(normalizedPath);
    } else {
      if (!hasSelected) {
        return;
      }
      nextSelectedPaths.remove(normalizedPath);
    }
    selectedPaths.assignAll(nextSelectedPaths);
    final effectiveMediaType = initialMediaType.trim().isNotEmpty
        ? initialMediaType.trim()
        : mediaType.value.trim();
    await _sourceFilterStorage.saveSelection(
      listType: listType,
      mediaType: effectiveMediaType,
      paths: selectedPaths,
    );
    await refreshList(showLoading: showLoading);
  }

  Future<void> clearSourcePathSelection({
    bool refresh = true,
    bool showLoading = false,
  }) async {
    selectedPaths.clear();
    final effectiveMediaType = initialMediaType.trim().isNotEmpty
        ? initialMediaType.trim()
        : mediaType.value.trim();
    await _sourceFilterStorage.saveSelection(
      listType: listType,
      mediaType: effectiveMediaType,
      paths: const <String>[],
    );
    if (refresh) {
      await refreshList(showLoading: showLoading);
    }
  }

  Future<void> loadMore({bool fromAuto = false}) async {
    if (loadingMore.value || loading.value) return;
    if (!hasMore.value) return;
    if (fromAuto && autoLoadFailed.value) return;

    loadingMore.value = true;
    try {
      final nextPage = _page + 1;
      final effectiveMediaType = initialMediaType.trim().isNotEmpty
          ? initialMediaType.trim()
          : mediaType.value.trim();
      final res = await VideoListApiService.instance.listPaged(
        page: nextPage,
        pageSize: _pageSize,
        listType: listType,
        mediaType: effectiveMediaType,
        albumId: albumId,
        collectionId: collectionId,
        smartAlbumId: smartAlbumId,
        libraryId: libraryId > 0 ? libraryId : null,
        search: searchText.value,
        genres: genres.toList(),
        regions: regions.toList(),
        actors: actors.toList(),
        directors: directors.toList(),
        years: selectedYears.toList(),
        sourceList: (folderViewEnabled.value || selectedPaths.isEmpty)
            ? null
            : selectedPaths.toList(),
        sortBy: _toSortByParam(sortBy.value),
        sortOrder: _toSortOrderParam(sortOrder.value),
        // ⭐ 翻页必须沿用同一个文件夹口径，否则第 2 页会悄悄变成「整库」
        folderPath: folderPath.value,
        folderMode: effectiveFolderMode,
        // ⭐ 混合库游标：必须与上一页的 folderPath/sortBy 完全一致，
        //    否则游标里的排序键会与新口径错位（表现：第 2 页开始乱序）。
        cursor: _cursor,
        showLoading: false,
      );
      _page = nextPage;
      items.addAll(res.items);
      total.value = res.pagination.total;
      hasMore.value = res.pagination.hasNextPage;
      _cursor = res.pagination.nextCursor;
      autoLoadFailed.value = false;
    } catch (_) {
      autoLoadFailed.value = true;
      rethrow;
    } finally {
      loadingMore.value = false;
    }
  }

  void setMediaType(String type) {
    if (mediaType.value == type) return;
    mediaType.value = type;
    refreshList(showLoading: true);
  }

  void updateFavoriteState(int indexId, bool isFavorite) {
    final id = indexId;
    if (id <= 0) return;

    if (listType.trim().toLowerCase() == 'favorite' && !isFavorite) {
      items.removeWhere((e) => e.id == id);
      total.value = (total.value - 1).clamp(0, 1 << 30);
      return;
    }

    final i = items.indexWhere((e) => e.id == id);
    if (i == -1) return;
    items[i] = items[i].copyWith(isFavorite: isFavorite);
  }

  void removeFromCurrentAlbumState(int indexId) {
    if (!isAlbumList) return;
    final id = indexId;
    if (id <= 0) return;
    items.removeWhere((e) => e.id == id);
    total.value = (total.value - 1).clamp(0, 1 << 30);
  }

  void setSearchText(String v) {
    searchText.value = v;
    _searchDebounce?.cancel();
    _searchDebounce = Timer(const Duration(milliseconds: 350), () {
      refreshList(showLoading: false);
    });
  }

  void setSearchImmediate(String v) {
    searchText.value = v;
    _searchDebounce?.cancel();
    refreshList(showLoading: false);
  }

  void clearSearch() {
    if (searchText.value.isEmpty) return;
    searchText.value = '';
    refreshList(showLoading: false);
  }

  void toggleGenre(String g) {
    final v = g.trim();
    if (v.isEmpty) return;
    if (genres.contains(v)) {
      genres.remove(v);
    } else {
      genres.add(v);
    }
    refreshList(showLoading: true);
  }

  void toggleRegion(String r) {
    final v = r.trim();
    if (v.isEmpty) return;
    if (regions.contains(v)) {
      regions.remove(v);
    } else {
      regions.add(v);
    }
    refreshList(showLoading: true);
  }

  void toggleYear(int year) {
    final y = year;
    if (y <= 0) return;
    if (selectedYears.length == 1 && selectedYears.first == y) {
      selectedYears.clear();
    } else {
      selectedYears.assignAll(<int>[y]);
    }
    refreshList(showLoading: true);
  }

  void toggleYearGroup(List<int> years) {
    final ys = years.where((e) => e > 0).toSet().toList(growable: false)
      ..sort((a, b) => b.compareTo(a));
    if (ys.isEmpty) return;
    final selected = selectedYears.toSet();
    final isSameSelection =
        selectedYears.length == ys.length && ys.every(selected.contains);
    if (isSameSelection) {
      selectedYears.clear();
    } else {
      selectedYears.assignAll(ys);
    }
    refreshList(showLoading: true);
  }

  void setYears(List<int> years) {
    selectedYears.assignAll(
      years.where((e) => e > 0).toSet().toList()
        ..sort((a, b) => b.compareTo(a)),
    );
    refreshList(showLoading: true);
  }

  List<VideoListYearGroup> getYearGroups() {
    final sourceYears = baseAvailableYears.isNotEmpty
        ? baseAvailableYears
        : availableYears;
    final years = sourceYears.where((e) => e > 0).toSet().toList()
      ..sort((a, b) => b.compareTo(a));
    if (years.isEmpty) return const <VideoListYearGroup>[];

    final latest = years.first;
    final groups = <VideoListYearGroup>[
      VideoListYearGroup(
        label: latest.toString(),
        years: <int>[latest],
        single: true,
      ),
    ];

    final latestDecade = (latest ~/ 10) * 10;
    final decadeWindowCount = 5;
    final minDecade = latestDecade - (decadeWindowCount - 1) * 10;

    for (var d = latestDecade; d >= minDecade; d -= 10) {
      final decadeYears = years
          .where((y) => y >= d && y < d + 10)
          .toList(growable: false);
      if (decadeYears.isEmpty) continue;
      if (d == latestDecade &&
          decadeYears.length == 1 &&
          decadeYears.first == latest) {
        continue;
      }
      groups.add(
        VideoListYearGroup(label: '${d}s', years: decadeYears, single: false),
      );
    }

    final olderYears = years
        .where((y) => y < minDecade)
        .toList(growable: false);
    if (olderYears.isNotEmpty) {
      groups.add(
        VideoListYearGroup(label: '更早', years: olderYears, single: false),
      );
    }
    return groups;
  }

  void resetFilter() {
    genres.clear();
    regions.clear();
    selectedYears.clear();
    refreshList(showLoading: true);
  }

  void setSort(VideoListSortBy by, VideoListSortOrder order) {
    sortBy.value = by;
    sortOrder.value = order;
    _saveSortSettings();
    refreshList(showLoading: true);
  }

  void increasePosterScale() {
    posterScale.value = normalizePosterScale(
      posterScale.value + posterScaleStep,
    );
    _savePosterScale();
  }

  void decreasePosterScale() {
    posterScale.value = normalizePosterScale(
      posterScale.value - posterScaleStep,
    );
    _savePosterScale();
  }

  String _toSortByParam(VideoListSortBy v) {
    switch (v) {
      case VideoListSortBy.favoriteTime:
        return 'favorite_time';
      case VideoListSortBy.viewTime:
        return 'view_time';
      case VideoListSortBy.year:
        return 'year';
      case VideoListSortBy.score:
        return 'score';
      case VideoListSortBy.createTime:
        return 'create_time';
      case VideoListSortBy.name:
        return 'name';
      case VideoListSortBy.takenTime:
        // ⭐ 拍摄时间（2026-10-12）：图片库 / 混合库专用。服务端
        //    `_normalizeSortBy` 不认这个值时回落 create_time，所以这里必须
        //    显式映射成它认的字符串 —— 见 electron_server 的
        //    `_normalizeSortBy` 白名单（已同步加 'taken_at'）。
        return 'taken_at';
    }
  }

  String _toSortOrderParam(VideoListSortOrder v) {
    switch (v) {
      case VideoListSortOrder.asc:
        return 'asc';
      case VideoListSortOrder.desc:
        return 'desc';
    }
  }
}
