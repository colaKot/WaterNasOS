import 'package:WaterNasOS/core/routes/app_routes.dart';
import 'package:WaterNasOS/core/theme/custom_colors.dart';
import 'package:WaterNasOS/modules/base/components/custom_bordered_icon_button.dart';
import 'package:WaterNasOS/modules/base/components/custom_expandable_search_bar.dart';
import 'package:WaterNasOS/modules/base/components/custom_no_data.dart';
import 'package:WaterNasOS/modules/base/components/custom_segmented_icon_toggle.dart';
import 'package:WaterNasOS/modules/video/base/beans/video_item_bean.dart';
import 'package:WaterNasOS/modules/video/list/controller/video_list_controller.dart';
import 'package:WaterNasOS/modules/video/list/view/parts/video_list_grid.dart';
import 'package:WaterNasOS/modules/video/list/view/parts/video_list_sort_menu.dart';
import 'package:WaterNasOS/modules/video/media_browser/view/parts/media_folder_grid.dart';
import 'package:WaterNasOS/modules/video/media_browser/view/parts/media_masonry_sliver.dart';
import 'package:WaterNasOS/modules/video/media_browser/view/parts/video_media_grid.dart';
import 'package:WaterNasOS/modules/video/media_browser/view/video_media_viewer_page.dart';
import 'package:WaterNasOS/utils/device_utils.dart';
import 'package:flutter/material.dart';
import 'package:get/get.dart';
import '../../../home/views/pc_components/pc_app_window.dart';

/// 图片库 / 混合库的浏览页。
///
/// ## 两个**互相独立**的开关（都在顶栏）
/// * **文件夹 / 整库平铺**（[VideoListController.folderViewEnabled]）
///   文件夹视图按目录层级逐层下钻：每层 = 4:3 的文件夹卡片（在上）+
///   本级文件（在下）；最后一层没有子文件夹 ⇒ 整页就是文件。
/// * **瀑布流 / 普通网格**（[VideoListController.waterfallEnabled]）
///   瀑布流按每项自己的宽高比排（视频在混合库里有 ffprobe 尺寸，横屏就是横屏）；
///   普通网格统一 4:3、一行对齐。
///
/// 两者正交，四种组合都成立 —— 所以「整库平铺」也能用瀑布流。
///
/// ## 搜索
/// 搜索时口径换成「当前目录的整棵子树」并且不再展示文件夹卡片 ——
/// 结果是跨目录的，再列目录只会自相矛盾。库根搜索 == 整库搜索。
class VideoMediaBrowserPage extends StatefulWidget {
  final int libraryId;

  /// image 只列图片；mixed 图片与影视混排
  final String libType;
  final String title;

  const VideoMediaBrowserPage({
    super.key,
    required this.libraryId,
    required this.libType,
    required this.title,
  });

  @override
  State<VideoMediaBrowserPage> createState() => _VideoMediaBrowserPageState();
}

class _VideoMediaBrowserPageState extends State<VideoMediaBrowserPage> {
  final ScrollController _scrollController = ScrollController();
  final TextEditingController _searchController = TextEditingController();
  late final String _controllerTag;

  bool get _isImageOnly => widget.libType == 'image';

  @override
  void initState() {
    super.initState();
    // ⚠️ tag 里**不能**带当前目录：目录状态存在 controller 内部
    //    （folderPath 是 Rx），tag 一变就会新建一个 controller，
    //    搜索框内容、排序、滚动位置全部丢失。
    _controllerTag = 'video_media_browser_${widget.libraryId}_${widget.libType}';
    _scrollController.addListener(_onScroll);
  }

  @override
  void dispose() {
    _scrollController.removeListener(_onScroll);
    _scrollController.dispose();
    _searchController.dispose();
    super.dispose();
  }

  void _onScroll() {
    final ctrl = Get.isRegistered<VideoListController>(tag: _controllerTag)
        ? Get.find<VideoListController>(tag: _controllerTag)
        : null;
    if (ctrl == null || !_scrollController.hasClients) return;
    final pos = _scrollController.position;
    if (pos.maxScrollExtent <= 0) return;
    if (pos.pixels >= pos.maxScrollExtent - 360) {
      ctrl.loadMore(fromAuto: true).catchError((_) {});
    }
  }

  Future<void> _openViewer(VideoListController ctrl, int index) async {
    // ⭐ 混合库点视频：**直接进播放页**，不经过中间的全屏查看器
    //    （需求 2026-10-11：视频没有可看的"信息"，中间那一层纯属多一次点击）。
    final items = ctrl.items;
    if (index >= 0 && index < items.length && !items[index].isImage) {
      await _openVideoFromList(ctrl, items[index]);
      return;
    }
    await Navigator.of(context).push<void>(
      MaterialPageRoute<void>(
        builder: (_) =>
            VideoMediaViewerPage(controller: ctrl, initialIndex: index),
      ),
    );
  }

  /// 从列表直接进播放器：把**本库全部视频**作为播放列表，
  /// 这样在播放器里也能继续切上一个/下一个。
  ///
  /// 口径与 [VideoMediaViewerPage] 里那份完全一致（`playFilePath` 优先，
  /// 回退 `fullPath`；`id` 用来定位初始项）—— 两处必须同步改。
  Future<void> _openVideoFromList(
    VideoListController ctrl,
    VideoHomeItemBean tapped,
  ) async {
    final playlist = <Map<String, dynamic>>[];
    var initialIndex = -1;
    for (final it in ctrl.items) {
      if (it.isImage) continue;
      final playPath =
          (it.playFilePath.isNotEmpty ? it.playFilePath : it.fullPath).trim();
      if (playPath.isEmpty) continue;
      if (identical(it, tapped) || it.id == tapped.id) {
        initialIndex = playlist.length;
      }
      playlist.add(<String, dynamic>{
        'path': playPath,
        'name': it.nfoName.isNotEmpty ? it.nfoName : it.filename,
      });
    }
    if (playlist.isEmpty) return;
    if (initialIndex < 0) initialIndex = 0;
    await AppRoutes.toVideoPlayer(
      playlist: playlist,
      initialIndex: initialIndex,
    );
  }

  void _enterFolder(VideoListController ctrl, String path) {
    // 换目录要回到顶部，否则会停在上一个目录的滚动位置上
    if (_scrollController.hasClients) _scrollController.jumpTo(0);
    ctrl.setFolder(path).catchError((_) {});
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final customColors = theme.extension<CustomColors>();

    return GetBuilder<VideoListController>(
      tag: _controllerTag,
      init: VideoListController(
        // 图片库只列图片；混合库不限定类型，图片与影视一起返回
        initialMediaType: _isImageOnly ? 'image' : '',
        libraryId: widget.libraryId,
        folderView: true,
      ),
      builder: (ctrl) {
        return ColoredBox(
          color: customColors?.mainContentBgColor ?? theme.colorScheme.surface,
          child: Column(
            children: [
              _buildTopBar(theme, ctrl),
              Expanded(
                child: Obx(() {
                  // ⭐ 这些读取**必须在 Obx 闭包内**（build 阶段）完成：
                  //   下面的 MediaFolderGrid / MediaMasonrySliver 内部是
                  //   SliverLayoutBuilder，属于 **layout 阶段**，那时
                  //   RxInterface.proxy 早已还原 ⇒ 那里读 Rx 监听不到任何依赖
                  //   （表现：顶栏有数量、内容区一片空白）。
                  final items = ctrl.items.toList(growable: false);
                  final folders = ctrl.subFolders.toList(growable: false);
                  final waterfallOn = ctrl.waterfallEnabled.value;
                  final showFanart = ctrl.showFanart.value;
                  // ⭐ 名称显示开关同样必须在这里（build 阶段）读一次：
                  //    下面两个 Sliver 内部都是 layout 阶段，读不到 Rx 依赖。
                  final showName = ctrl.showName.value;
                  final showFolderSection =
                      ctrl.showFolderCards && folders.isNotEmpty;

                  if (ctrl.loading.value) {
                    return const Center(child: CircularProgressIndicator());
                  }
                  if (items.isEmpty && !showFolderSection) {
                    return CustomNoData(text: 'no_data'.tr);
                  }

                  return Scrollbar(
                    thumbVisibility: true,
                    controller: _scrollController,
                    child: CustomScrollView(
                      controller: _scrollController,
                      slivers: [
                        if (showFolderSection) ...[
                          _sectionHeader('dir'.tr, folders.length),
                          SliverPadding(
                            padding: const EdgeInsets.fromLTRB(16, 0, 16, 0),
                            sliver: MediaFolderGrid(
                              folders: folders,
                              onOpen: (folder) =>
                                  _enterFolder(ctrl, folder.path),
                            ),
                          ),
                        ],
                        if (items.isNotEmpty)
                          SliverPadding(
                            // 目录卡片和文件之间留一点呼吸；只有文件时保持原边距
                            padding: EdgeInsets.fromLTRB(
                              16,
                              showFolderSection ? 18 : 10,
                              16,
                              16,
                            ),
                            // ⭐ 布局只由「瀑布流 / 网格」这个开关决定，**与文件夹视图无关**：
                            //    以前是「文件夹视图 ⇒ 瀑布流、整库平铺 ⇒ 网格」绑死的，
                            //    于是想整库看瀑布流就没辙（需求 2026-10-10 要求拆开）。
                            sliver: waterfallOn
                                ? MediaMasonrySliver(
                                    items: items,
                                    showFanart: showFanart,
                                    // ⭐ 瀑布流：名字压在图片内部最下方
                                    showName: showName,
                                    onOpen: (index) => _openViewer(ctrl, index),
                                  )
                                : VideoMediaGrid(
                                    controller: ctrl,
                                    showFanart: showFanart,
                                    // ⭐ 网格：名字写在图片下方（由 Grid 自己读
                                    //    controller.showName —— 它是 StatelessWidget
                                    //    且内部有 Obx，本来就要自己监听）
                                    onOpen: (index) => _openViewer(ctrl, index),
                                  ),
                          ),
                        if (items.isNotEmpty)
                          SliverToBoxAdapter(
                            child: Padding(
                              padding: const EdgeInsets.only(bottom: 20),
                              child: VideoListFooter(controller: ctrl),
                            ),
                          ),
                      ],
                    ),
                  );
                }),
              ),
            ],
          ),
        );
      },
    );
  }

  Widget _sectionHeader(String label, int count) {
    final theme = Theme.of(context);
    return SliverToBoxAdapter(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(18, 14, 16, 8),
        child: Row(
          children: [
            Text(label, style: theme.textTheme.titleSmall),
            const SizedBox(width: 6),
            Text(
              '$count',
              style: theme.textTheme.bodySmall?.copyWith(
                color: theme.colorScheme.onSurface.withValues(alpha: 0.55),
              ),
            ),
          ],
        ),
      ),
    );
  }

  /// 顶栏：手机端与桌面端**两套排布**。
  ///
  /// 手机端以前直接复用桌面端那一行（搜索框 + 面包屑 + 数量 + 4 个开关），
  /// 在窄屏上整行溢出到屏幕外，且没有避让状态栏 / 刘海 / 灵动岛。
  /// 现在按影视库 App 端（`AppVideoListPage`）的口径重排。
  Widget _buildTopBar(ThemeData theme, VideoListController ctrl) {
    final isPhone = DeviceUtils.isMobile || DeviceUtils.isPhone(context);
    return isPhone
        ? _buildMobileTopBar(theme, ctrl)
        : _buildDesktopTopBar(theme, ctrl);
  }

  /// 手机端顶栏（需求 2026-10-13）：
  /// `[返回上一级]  [搜索栏]  [AZ 排序]  [瀑布流]  [显示名称]`
  ///
  /// * 不做排序文字、不显示媒体数量、不显示面包屑（窄屏放不下）
  /// * 真实避让状态栏高度 `MediaQuery.padding.top`（外层 `SafeArea(top:false)`
  ///   刻意关掉了顶部，所以必须在这里补，否则内容会顶进灵动岛 / 刘海）
  Widget _buildMobileTopBar(ThemeData theme, VideoListController ctrl) {
    final topPad = MediaQuery.of(context).padding.top;
    return Padding(
      padding: EdgeInsets.fromLTRB(8, topPad + 6, 8, 4),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.center,
        children: [
          // 返回上一级：只在文件夹视图且确实有上一级时出现
          Obx(() {
            if (!ctrl.canGoUp) return const SizedBox.shrink();
            return CustomBorderedIconButton(
              icon: Icons.arrow_back,
              tooltip: 'back'.tr,
              onTap: () => _enterFolder(ctrl, ctrl.parentFolderPath.value),
            );
          }),
          Obx(
            () => SizedBox(width: ctrl.canGoUp ? 8 : 0),
          ),
          Expanded(
            child: CustomExpandableSearchBar(
              controller: _searchController,
              hintText: 'search'.tr,
              onChanged: ctrl.setSearchText,
              onClear: ctrl.clearSearch,
              defaultExpanded: true,
            ),
          ),
          const SizedBox(width: 8),
          // 排序：**只给 AZ 图标**，点开走底部面板（与影视库 App 端一致）
          Obx(
            () => CustomBorderedIconButton(
              icon: Icons.sort_by_alpha,
              tooltip: 'sort'.tr,
              active: ctrl.hasCustomSort,
              onTap: () => _openSortSheet(ctrl),
            ),
          ),
          const SizedBox(width: 6),
          // 瀑布流 / 网格：小图标，点一下就地切换
          Obx(
            () => _mobileToggle(
              icon: ctrl.waterfallEnabled.value
                  ? Icons.view_quilt_rounded
                  : Icons.grid_view_rounded,
              tooltip: ctrl.waterfallEnabled.value
                  ? 'video_list_waterfall'.tr
                  : 'video_list_grid'.tr,
              active: ctrl.waterfallEnabled.value,
              onTap: () => ctrl.setWaterfall(!ctrl.waterfallEnabled.value),
            ),
          ),
          const SizedBox(width: 6),
          // 显示 / 隐藏名称：同一个小图标
          Obx(
            () => _mobileToggle(
              icon: ctrl.showName.value
                  ? Icons.title_rounded
                  : Icons.hide_image_outlined,
              tooltip: ctrl.showName.value
                  ? 'video_list_show_name'.tr
                  : 'video_list_hide_name'.tr,
              active: ctrl.showName.value,
              onTap: () => ctrl.setShowName(!ctrl.showName.value),
            ),
          ),
        ],
      ),
    );
  }

  /// 手机端的小号切换按钮（比 [`CustomBorderedIconButton`] 的 App 默认尺寸小一档）
  Widget _mobileToggle({
    required IconData icon,
    required String tooltip,
    required bool active,
    required VoidCallback onTap,
  }) {
    return CustomBorderedIconButton(
      icon: icon,
      tooltip: tooltip,
      active: active,
      size: 30,
      iconSize: 17,
      borderRadius: 8,
      onTap: onTap,
    );
  }

  /// 手机端排序面板（底部弹出），条目与桌面端菜单**同一份数据源**
  Future<void> _openSortSheet(VideoListController ctrl) async {
    await showModalBottomSheet<void>(
      context: context,
      showDragHandle: true,
      useSafeArea: true,
      builder: (ctx) {
        final theme = Theme.of(ctx);
        return Material(
          color: theme.colorScheme.surface,
          child: Obx(() {
            final entries = getVideoListSortEntries(ctrl);
            return ListView(
              shrinkWrap: true,
              padding: const EdgeInsets.fromLTRB(12, 0, 12, 16),
              children: [
                for (final e in entries) ...[
                  if (e.divider)
                    const Divider(height: 1)
                  else
                    ListTile(
                      dense: true,
                      leading: ctrl.sortBy.value == e.by &&
                              ctrl.sortOrder.value == e.order
                          ? Icon(Icons.check, color: theme.colorScheme.primary)
                          : const SizedBox(width: 24),
                      title: Text(e.labelKey!.tr),
                      onTap: () {
                        Navigator.of(ctx).pop();
                        ctrl.setSort(e.by!, e.order!);
                      },
                    ),
                ],
              ],
            );
          }),
        );
      },
    );
  }

  /// 桌面 / Web 顶栏
  Widget _buildDesktopTopBar(ThemeData theme, VideoListController ctrl) {
    // ⭐ 右侧给窗口按钮组让位（2026-10-09）：搜索框被推到最右
    final ctrlW = PcWindowScope.of(context)?.titleBarControlsWidth ?? 0;
    return Padding(
      padding: EdgeInsets.fromLTRB(16, 12, 16 + ctrlW, 8),
      child: Row(
        children: [
          // 返回上一级（只在文件夹视图且确实有上一级时出现）
          Obx(() {
            if (!ctrl.canGoUp) return const SizedBox.shrink();
            return IconButton(
              visualDensity: VisualDensity.compact,
              tooltip: 'back'.tr,
              icon: const Icon(Icons.arrow_back, size: 18),
              onPressed: () => _enterFolder(ctrl, ctrl.parentFolderPath.value),
            );
          }),
          // 面包屑
          Expanded(child: Obx(() => _buildBreadcrumb(theme, ctrl))),
          const SizedBox(width: 10),
          // 数量：文件夹视图下显示「整棵子树」的量，否则显示整库量
          Obx(
            () => Text(
              '${ctrl.folderViewEnabled.value ? ctrl.subtreeTotal.value : ctrl.total.value}',
              style: theme.textTheme.bodySmall?.copyWith(
                color: theme.colorScheme.onSurface.withValues(alpha: 0.6),
              ),
            ),
          ),
          const SizedBox(width: 6),
          _buildViewToggle(ctrl),
          const SizedBox(width: 6),
          // ⭐ 排序（2026-10-12，需求）：**放在视图开关之前**，与影视列表
          //    顶栏的排布一致（先排序，再布局类开关）。默认名字升序。
          //    直接用影视库那套 [VideoListSortMenu] —— 它内部会按
          //    `isMediaGridLibrary` 自动换成图片 / 混合库适用的排序项。
          VideoListSortMenu(controller: ctrl),
          const SizedBox(width: 6),
          // ⭐ 瀑布流 / 网格
          //
          // ⛔ 这里**没有**「封面图 / 缩略图」开关（2026-10-13，用户要求）：
          //    本页只服务图片库与图片+视频混合库，封面图竖版海报对图片毫无意义，
          //    混排时那两个按钮也只是噪音。混合库里的视频统一走默认海报形态。
          _buildLayoutToggle(ctrl),
          const SizedBox(width: 6),
          // ⭐ 名称显示开关（2026-10-11）：瀑布流压在图片内部最下方，
          //    网格写在图片下方（与影视列表卡片一致）
          _buildNameToggle(ctrl),
          const SizedBox(width: 6),
          SizedBox(
            width: 240,
            height: 36,
            child: TextField(
              controller: _searchController,
              textAlignVertical: TextAlignVertical.center,
              decoration: InputDecoration(
                isDense: true,
                hintText: 'search'.tr,
                prefixIcon: const Icon(Icons.search, size: 18),
                suffixIcon: Obx(
                  () => ctrl.searchText.value.isEmpty
                      ? const SizedBox.shrink()
                      : IconButton(
                          icon: const Icon(Icons.close, size: 16),
                          onPressed: () {
                            _searchController.clear();
                            ctrl.clearSearch();
                          },
                        ),
                ),
                border: const OutlineInputBorder(),
                contentPadding: const EdgeInsets.symmetric(vertical: 8),
              ),
              onChanged: ctrl.setSearchText,
              onSubmitted: ctrl.setSearchImmediate,
            ),
          ),
        ],
      ),
    );
  }

  /// 文件夹视图 ↔ 整库平铺
  Widget _buildViewToggle(VideoListController ctrl) {
    return Obx(() {
      final on = ctrl.folderViewEnabled.value;
      return IconButton(
        visualDensity: VisualDensity.compact,
        // 图标显示的是「当前形态」，tooltip 说的是「点它会切到哪」
        tooltip: on ? 'all'.tr : 'dir'.tr,
        icon: Icon(
          on ? Icons.grid_view_rounded : Icons.folder_rounded,
          size: 20,
        ),
        onPressed: () => ctrl.setFolderView(!on),
      );
    });
  }

  /// 瀑布流 ↔ 普通网格
  Widget _buildLayoutToggle(VideoListController ctrl) {
    return Obx(() {
      final waterfall = ctrl.waterfallEnabled.value;
      return CustomSegmentedIconToggle(
        // 左 = 瀑布流（view_quilt 就是「不等高格子」的象形），右 = 普通网格
        firstIcon: Icons.view_quilt_rounded,
        secondIcon: Icons.grid_view_rounded,
        firstTooltip: 'video_list_waterfall'.tr,
        secondTooltip: 'video_list_grid'.tr,
        // 组件语义：secondSelected = 选中后半（网格）
        secondSelected: !waterfall,
        onChanged: (second) => ctrl.setWaterfall(!second),
      );
    });
  }

  /// 名称显示开 / 关。
  ///
  /// 用同一个两段组件当**开关**（而不是单独画一个按钮）：本页所有视图控制
  /// 都是这个组件的两段形态，保持一致；「不显示 / 显示」正好是它的两段。
  /// ⚠️ 图标显示的是**当前形态**（与 [_buildViewToggle] 同一约定）。
  Widget _buildNameToggle(VideoListController ctrl) {
    return Obx(() {
      final on = ctrl.showName.value;
      return CustomSegmentedIconToggle(
        firstIcon: Icons.hide_image_outlined,
        secondIcon: Icons.title_rounded,
        firstTooltip: 'video_list_hide_name'.tr,
        secondTooltip: 'video_list_show_name'.tr,
        secondSelected: on,
        // 组件语义：secondSelected = 选中后半（显示名称）
        onChanged: ctrl.setShowName,
      );
    });
  }

  Widget _buildBreadcrumb(ThemeData theme, VideoListController ctrl) {
    final crumbs = ctrl.breadcrumbs;
    final dim = theme.colorScheme.onSurface.withValues(alpha: 0.4);
    final children = <Widget>[
      _crumbText(theme, widget.title, onTap: () => _enterFolder(ctrl, '')),
    ];
    for (var i = 0; i < crumbs.length; i++) {
      final seg = crumbs[i];
      final isLast = i == crumbs.length - 1;
      children.add(Icon(Icons.chevron_right, size: 16, color: dim));
      children.add(
        _crumbText(
          theme,
          seg.name,
          strong: isLast,
          // 最后一段就是当前目录，点了也没变化
          onTap: isLast ? null : () => _enterFolder(ctrl, seg.path),
        ),
      );
    }
    return SingleChildScrollView(
      scrollDirection: Axis.horizontal,
      // 路径很深时优先露出最后几段（当前目录才是重点）
      reverse: true,
      child: Row(children: children),
    );
  }

  Widget _crumbText(
    ThemeData theme,
    String text, {
    VoidCallback? onTap,
    bool strong = false,
  }) {
    final style =
        (strong ? theme.textTheme.titleSmall : theme.textTheme.bodyMedium)
            ?.copyWith(
              color: strong
                  ? theme.colorScheme.onSurface
                  : theme.colorScheme.onSurface.withValues(alpha: 0.65),
            );
    final label = Text(
      text,
      style: style,
      maxLines: 1,
      overflow: TextOverflow.ellipsis,
    );
    if (onTap == null) {
      return Padding(
        padding: const EdgeInsets.symmetric(horizontal: 2),
        child: label,
      );
    }
    return InkWell(
      borderRadius: BorderRadius.circular(6),
      onTap: onTap,
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 4),
        child: label,
      ),
    );
  }
}
