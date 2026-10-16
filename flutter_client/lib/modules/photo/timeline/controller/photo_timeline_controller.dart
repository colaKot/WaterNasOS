import 'dart:async';
import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:get/get.dart';
import 'package:flutter/rendering.dart';

import '../../../../../core/api/api_controller.dart';
import '../../../../../utils/http_util.dart';
import 'package:intl/intl.dart';
import '../../../../core/user/current_user_controller.dart';
import '../../../../utils/cache_manager.dart';
import '../../../../utils/dialog_util.dart';
import '../../../../utils/toast_util.dart';
import '../../../../utils/device_utils.dart';
import '../../../base/components/custom_extended_image.dart';
import '../../../folder_view/folder_view_module_type.dart';
import '../../../gallery/controllers/custom_gallery_controller.dart';
import '../../../gallery/views/custom_gallery.dart';
import '../../../home/views/pc_home_controller.dart';
import '../../ai_faces/models/ai_faces_models.dart';
import '../../ai_faces/service/photo_ai_faces_api_service.dart';
import '../../ai_setting/service/photo_ai_settings_api_service.dart';
import '../service/photo_offline_snapshot.dart';
import '../../photo_main/controller/photo_home_controller.dart';
import '../../album/models/photo_album_model.dart';
import '../../album/service/photo_album_api_service.dart';
import '../../album/view/photo_album_list_view.dart';
import '../../album/view/app_photo_album_list_page.dart';
import '../../app_setting/view/app_photo_settings_view.dart';
import '../../../transfer/controllers/download_controller.dart';
import '../models/photo_timeline_model.dart';
import '../service/photo_timeline_api_service.dart';
import '../../../video_player/views/app_video_player_page.dart';
import '../../../video_player/views/pc_video_player_view.dart';
part 'parts/photo_timeline_settings.dart';
part 'parts/photo_timeline_loading.dart';
part 'parts/photo_timeline_pagination.dart';
part 'parts/photo_timeline_scroll.dart';
part 'parts/photo_timeline_utils.dart';
part 'parts/photo_timeline_media.dart';
part 'parts/photo_timeline_selection.dart';

sealed class TimelineListItem {
  const TimelineListItem();
  String get id;
}

class TimelineListDateHeader extends TimelineListItem {
  final String date;

  const TimelineListDateHeader({required this.date});

  @override
  String get id => 'date_$date';
}

class TimelineListPhoto extends TimelineListItem {
  final TimelinePhotoItem photo;

  const TimelineListPhoto({required this.photo});

  @override
  String get id => 'photo_${photo.id}';
}

/// 照片时间轴页面的核心控制器。
///
/// 该控制器负责：
/// - 拉取日期列表与照片列表，并把扁平数据分组为 `photoGroups` 供 UI 渲染
/// - 监听滚动，在接近顶部/底部时触发分页加载
/// - 侧边栏点击日期后的跳转定位
/// - 多选/批量操作（下载、收藏、删除等）
///
/// 为了便于维护，本文件只保留“状态定义 + 生命周期”，具体逻辑按职责拆分到 `controller/parts` 目录中，
/// 通过 `part` + `extension` 组合实现同一库内的逻辑拆分。
class PhotoTimelineController extends GetxController {
  final PhotoTimelineSourceFilterStorage _sourceFilterStorage =
      PhotoTimelineSourceFilterStorage();
  final String initialListType;
  final int? initialAlbumId;
  final int? initialCollectionId;
  final int? initialSmartAlbumId;
  final int? initialFaceId;
  final List<int>? initialComboFaceIds;
  final String? initialPlaceName;
  final bool initialLoadTheDay;
  final String? initialGeohash;

  /// ⭐ 强制 geohash 反查精度（2~6）。足迹地图点开某个 marker 时传入该 marker 的聚合档位，
  /// 保证「地图上这个点代表的范围」与「点开后列出的照片范围」一致。
  /// 为 0 / null 时按 [nearbyRangeKm] 的默认映射走（原行为）。
  final int precisionOverride;

  final int? initialYear;

  /// 未配置来源路径时是否弹出管理员提示（仅 PC 照片主页「时间轴」与 App 照片管理首页应开启）。
  final bool alertWhenNoSourcePath;

  PhotoTimelineController({
    this.initialListType = 'timeline',
    this.initialAlbumId,
    this.initialCollectionId,
    this.initialSmartAlbumId,
    this.initialFaceId,
    this.initialComboFaceIds,
    this.initialPlaceName,
    this.initialLoadTheDay = false,
    this.initialGeohash,
    this.precisionOverride = 0,
    this.initialYear,
    this.alertWhenNoSourcePath = false,
  });
  final int minItemSize = DeviceUtils.isMobile ? 60 : 120;
  final int maxItemSize = 400;

  /// 分页加载时，每次请求的照片数量下限。
  static final int minGetCount = 300;

  /// 时间轴接口服务（日期列表、照片列表）。
  final PhotoTimelineApiService _apiService = PhotoTimelineApiService();

  /// 日期列表（右侧时间轴与分组统计使用）。
  final RxList<TimelineDateItem> dateList = <TimelineDateItem>[].obs;

  /// UI 直接消费的扁平化渲染列表：包含日期 header、照片 item 与上下 loading。
  final RxList<TimelineListItem> photoItems = <TimelineListItem>[].obs;

  final RxMap<String, TimelineDateInfo> dateInfoMap =
      <String, TimelineDateInfo>{}.obs;

  /// 日期列表是否在加载中（首屏骨架/占位）。
  final RxBool isLoadingDates = false.obs;

  /// 向上分页加载标记（顶部 loading）。
  final RxBool isLoadingUp = false.obs;

  /// 向下分页加载标记（底部 loading）。
  final RxBool isLoadingDown = false.obs;

  /// 向上是否还有更多数据可加载。
  final RxBool hasMoreUp = true.obs;

  /// 向下是否还有更多数据可加载。
  final RxBool hasMoreDown = true.obs;

  /// 当前是否处于时间轴 hover 状态（用于 overlay 显示）。
  final RxBool isTimelineHovering = false.obs;

  /// 当前 hover 时展示的日期字符串。
  final RxString timelineHoverDate = ''.obs;

  /// 可用的路径列表 (从服务端获取)
  final RxList<TimelinePathItem> availablePaths = <TimelinePathItem>[].obs;

  /// 当前选中的路径过滤 (路径字符串)
  final RxList<String> selectedPaths = <String>[].obs;

  /// 搜索关键字
  final RxString searchKeyword = ''.obs;
  final TextEditingController searchController = TextEditingController();
  Timer? _searchDebounce;

  /// ⭐ 2026-10-16 P0-1：搜索的语义解析结果（「已识别 / 未识别 / 命中的活动」）。
  /// 服务端一直在解析（placesQuery），客户端此前没把它显示出来 ⇒ 用户看不到「系统猜到了什么」。
  final RxList<String> searchTags = <String>[].obs;
  final RxList<String> searchUnmatched = <String>[].obs;
  final RxList<PhotoSearchActivity> searchActivities =
      <PhotoSearchActivity>[].obs;
  final RxBool searchSemantic = false.obs;
  final RxBool searchParsing = false.obs;

  /// 解析请求序号：防抖 + 网络乱序时只认最后一次响应。
  int _searchParseSeq = 0;

  /// ⭐ 2026-10-16 P1-12 离线快照：断网时用本地快照渲染，并告诉用户快照是什么时候的。
  final RxString offlineNotice = ''.obs;
  final RxBool offlineMode = false.obs;

  /// ⭐ 2026-10-16 P0-4：搜索联想建议（点击直接改写搜索词）。
  final RxList<PhotoSearchSuggestion> searchSuggestions =
      <PhotoSearchSuggestion>[].obs;


  final RxString baseGeohash = ''.obs;
  final RxInt nearbyRangeKm = 2.obs;

  /// 列表类型：timeline (默认), favorite (收藏)
  final RxString listType = 'timeline'.obs;
  final RxnInt albumId = RxnInt();
  final RxnInt collectionId = RxnInt();
  final RxnInt smartAlbumId = RxnInt();
  final RxnInt faceId = RxnInt();

  /// ⭐ 2026-10-16 P0-2 合影组合：一组根人脸 id（语义是**交集**，不是并集）。
  final RxList<int> comboFaceIds = <int>[].obs;
  final RxnString placeName = RxnString();
  final RxBool loadTheDay = false.obs;
  final RxnInt year = RxnInt();

  /// 排序方式：`desc` 为较新在前，`asc` 为较旧在前。
  final RxString sortOrder = 'desc'.obs;

  /// 文件类型过滤：`all` / 其他枚举值（由 UI 传入）。
  final RxString fileType = 'all'.obs;

  /// 网格单元最大宽度（影响列数与布局）。
  final RxDouble itemSize = 140.0.obs;

  /// 图片显示模式：true=cover (裁切), false=contain (缩放)
  final RxBool isCoverMode = true.obs;

  // --- Layout Constants (Must match View) ---
  static const double crossAxisSpacing = 8;
  static const double mainAxisSpacing = 8;
  static const double leftPadding = 16;
  static const double rightPadding = 40;
  static const double headerExtent = 50;
  static const double topLoadingExtent = 64.0;

  double layoutCrossAxisSpacing = PhotoTimelineController.crossAxisSpacing;
  double layoutMainAxisSpacing = PhotoTimelineController.mainAxisSpacing;
  double layoutLeftPadding = PhotoTimelineController.leftPadding;
  double layoutRightPadding = PhotoTimelineController.rightPadding;
  double layoutHeaderExtent = PhotoTimelineController.headerExtent;
  double layoutTopLoadingExtent = PhotoTimelineController.topLoadingExtent;

  double _viewportContentWidth = 0;
  int _crossAxisCount = 0;
  double _cellMainAxisExtent = 0;

  void updateLayoutInfo(
    double contentWidth,
    int crossAxisCount,
    double cellMainAxisExtent,
  ) {
    _viewportContentWidth = contentWidth;
    _crossAxisCount = crossAxisCount;
    _cellMainAxisExtent = cellMainAxisExtent;
  }

  /// 是否处于多选模式（影响底部栏显示与交互逻辑）。
  final RxBool isMultiSelectMode = false.obs;

  /// 已选中条目的 id 集合。
  final RxSet<int> selectedItems = <int>{}.obs;

  final selectionRect = Rxn<Rect>();
  final selectionRectContent = Rxn<Rect>();
  Offset? _dragStartViewport;
  double _dragStartScrollOffset = 0;
  Set<int>? _dragSelectionBaseline;

  /// 首次加载时的锚点 Item ID (用于加载上一页后回跳)
  String? savedAnchorItemId;

  /// 首次加载时的锚点 Item 相对偏移量
  double savedAnchorItemOffset = 0.0;

  /// 列表滚动控制器（统一管理滚动监听与跳转定位）。
  final ScrollController scrollController = ScrollController();

  /// 列表 key（预留：用于必要时触发 rebuild/定位）。
  final GlobalKey listViewKey = GlobalKey();

  /// 滚动触发分页的节流锁，防止边界抖动造成重复请求。
  bool _scrollLoadLock = false;

  /// 本地缓存 key：排序方式。
  static const String keySortOrder = 'timeline_sort_order';

  /// 本地缓存 key：文件类型过滤。
  static const String keyFileType = 'timeline_file_type';

  /// 本地缓存 key：缩略图尺寸。
  static const String keyItemSize = 'timeline_item_size';

  /// 本地缓存 key：图片显示模式。
  static const String keyIsCoverMode = 'timeline_is_cover_mode';

  /// 右侧时间轴是否显示（自动隐藏逻辑见 `photo_timeline_scroll.dart`）。
  final RxBool isTimelineVisible = false.obs;
  Timer? _timelineHideTimer;

  /// 最近一次拉取结果（目前主要用于调试/扩展，逻辑上不依赖它驱动 UI）。
  FetchResult _lastFetchResult = const FetchResult(
    hasData: false,
    incomingCount: 0,
    addedCount: 0,
  );

  /// 照片列表接口每页大小（与服务端约定）。
  static int defaultPageSize = 20;

  String? get geohashForRequest {
    final gh = baseGeohash.value.trim();
    if (gh.isEmpty) return null;
    // ⭐ 2026-10-16 足迹地图点开时下发的是「逗号分隔的 geohash 格集合」
    // （该 marker 聚合到的每一格，精度一致）。服务端会做精确集合匹配（whereIn），
    // 这里必须原样透传 —— 一旦拿去截前缀，就会把邻居格整片捞进来。
    if (gh.contains(',')) return gh;
    // ⭐ 地图传入的聚合档位优先。它和地图 marker 的聚合范围是同一套口径，
    // 不用就会出现「marker 代表一大片、点开只列很小一块」的错位。
    if (precisionOverride >= 2 && precisionOverride <= 6) {
      final len = precisionOverride.clamp(2, gh.length);
      return gh.substring(0, len);
    }
    final precision = switch (nearbyRangeKm.value) {
      2 => 6,
      5 => 5,
      10 => 4,
      50 => 3,
      80 => 2,
      _ => 6,
    };
    final len = precision.clamp(2, gh.length);
    return gh.substring(0, len);
  }

  void setNearbyRangeKm(int km) {
    nearbyRangeKm.value = km;
    // ⭐ 用户手动调范围 = 明确放弃「地图那个 marker 的范围」，退化成按前缀查。
    // 否则格集合会一直优先于用户选择，范围选择器看起来像失灵。
    final gh = baseGeohash.value.trim();
    final comma = gh.indexOf(',');
    if (comma > -1) {
      baseGeohash.value = gh.substring(0, comma);
    }
    refreshTimeline();
  }

  @override
  void onInit() {
    super.onInit();
    listType.value = initialListType;
    albumId.value = initialAlbumId;
    collectionId.value = initialCollectionId;
    smartAlbumId.value = initialSmartAlbumId;
    faceId.value = initialFaceId;
    if (initialComboFaceIds != null && initialComboFaceIds!.isNotEmpty) {
      comboFaceIds.assignAll(initialComboFaceIds!);
    }
    if (initialPlaceName != null && initialPlaceName!.trim().isNotEmpty) {
      placeName.value = initialPlaceName!.trim();
    }
    loadTheDay.value = initialLoadTheDay;
    if (initialGeohash != null && initialGeohash!.trim().isNotEmpty) {
      baseGeohash.value = initialGeohash!.trim();
    }
    year.value = initialYear;
    if (Get.arguments != null && Get.arguments is Map) {
      if (Get.arguments['listType'] != null) {
        listType.value = Get.arguments['listType'];
      }
      if (Get.arguments['albumId'] != null) {
        final v = Get.arguments['albumId'];
        if (v is int) {
          albumId.value = v;
        } else if (v is num) {
          albumId.value = v.toInt();
        } else {
          albumId.value = int.tryParse(v.toString());
        }
      }
      if (Get.arguments['collectionId'] != null) {
        final v = Get.arguments['collectionId'];
        if (v is int) {
          collectionId.value = v;
        } else if (v is num) {
          collectionId.value = v.toInt();
        } else {
          collectionId.value = int.tryParse(v.toString());
        }
      }
      if (Get.arguments['smartAlbumId'] != null) {
        final v = Get.arguments['smartAlbumId'];
        if (v is int) {
          smartAlbumId.value = v;
        } else if (v is num) {
          smartAlbumId.value = v.toInt();
        } else {
          smartAlbumId.value = int.tryParse(v.toString());
        }
      }
      if (Get.arguments['faceId'] != null) {
        final v = Get.arguments['faceId'];
        if (v is int) {
          faceId.value = v;
        } else if (v is num) {
          faceId.value = v.toInt();
        } else {
          faceId.value = int.tryParse(v.toString());
        }
      }

      if (Get.arguments['placeName'] != null) {
        final v = Get.arguments['placeName'].toString().trim();
        if (v.isNotEmpty) {
          placeName.value = v;
        }
      }
      if (baseGeohash.value.isEmpty && Get.arguments['geohash'] != null) {
        final gh = Get.arguments['geohash'].toString().trim();
        if (gh.isNotEmpty) {
          baseGeohash.value = gh;
        }
      }
      if (Get.arguments['year'] != null) {
        final v = Get.arguments['year'];
        if (v is int) {
          year.value = v;
        } else if (v is num) {
          year.value = v.toInt();
        } else {
          year.value = int.tryParse(v.toString());
        }
      }
    }
    _loadSettings();
    _loadDateList();
    scrollController.addListener(_onScroll);
  }

  @override
  void onClose() {
    scrollController.dispose();
    searchController.dispose();
    _timelineHideTimer?.cancel();
    _searchDebounce?.cancel();
    super.onClose();
  }

  void onSearchChanged(String val) {
    if (_searchDebounce?.isActive ?? false) _searchDebounce!.cancel();
    _searchDebounce = Timer(const Duration(milliseconds: 500), () {
      searchKeyword.value = val;
      refreshTimeline();
      // ⭐ 与列表刷新并行：解析与联想只用于「提示条 / 建议」，不阻塞结果渲染。
      _parseSearch(val);
      _fetchSuggestions(val);
    });
  }

  /// ⭐ 2026-10-16 P0-1：取回语义解析结果（已识别 / 未识别 / 活动命中）。
  /// 失败与超时都只清空提示条，**不影响搜索结果本身**。
  Future<void> _parseSearch(String val) async {
    final q = val.trim();
    final seq = ++_searchParseSeq;
    if (q.isEmpty) {
      searchTags.clear();
      searchUnmatched.clear();
      searchActivities.clear();
      searchSemantic.value = false;
      searchParsing.value = false;
      return;
    }
    searchParsing.value = true;
    try {
      final res = await _apiService.parseSearchQuery(query: q);
      if (seq != _searchParseSeq) return; // 已有更新的请求，丢弃本次
      if (!res.success || res.data == null) {
        searchTags.clear();
        searchUnmatched.clear();
        searchActivities.clear();
        searchSemantic.value = false;
        return;
      }
      final data = res.data!;
      searchTags.assignAll(data.tags);
      searchUnmatched.assignAll(data.unmatched);
      searchActivities.assignAll(data.activities);
      searchSemantic.value =
          data.available && (data.tags.isNotEmpty || data.activities.isNotEmpty);
    } catch (_) {
      if (seq == _searchParseSeq) {
        searchTags.clear();
        searchUnmatched.clear();
        searchActivities.clear();
        searchSemantic.value = false;
      }
    } finally {
      if (seq == _searchParseSeq) searchParsing.value = false;
    }
  }

  void clearSearch() {
    searchKeyword.value = '';
    searchController.clear();
    _searchParseSeq++; // 作废在途请求
    searchTags.clear();
    searchUnmatched.clear();
    searchActivities.clear();
    searchSemantic.value = false;
    searchParsing.value = false;
    searchSuggestions.clear();
    refreshTimeline();
  }

  /// ⭐ 2026-10-16 P0-4：取搜索联想建议。失败只清空建议，不影响搜索结果。
  Future<void> _fetchSuggestions(String val) async {
    final q = val.trim();
    final seq = ++_searchParseSeq;
    if (q.isEmpty) {
      searchSuggestions.clear();
      return;
    }
    try {
      final res = await _apiService.suggestSearch(query: q);
      if (seq != _searchParseSeq) return;
      searchSuggestions.assignAll(res.success && res.data != null
          ? res.data!.where((e) => e.label != q).take(8)
          : const <PhotoSearchSuggestion>[]);
    } catch (_) {
      if (seq == _searchParseSeq) searchSuggestions.clear();
    }
  }

  /// ⭐ 2026-10-16 P0-4：点选一条联想建议 —— 直接把它写进搜索框并立即检索。
  void applySearchKeyword(String keyword) {
    final k = keyword.trim();
    if (k.isEmpty) return;
    if (_searchDebounce?.isActive ?? false) _searchDebounce!.cancel();
    searchController.text = k;
    searchController.selection =
        TextSelection.collapsed(offset: k.length);
    searchKeyword.value = k;
    refreshTimeline();
    _parseSearch(k);
    _fetchSuggestions(k);
  }
}
