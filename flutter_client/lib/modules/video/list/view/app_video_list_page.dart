import 'package:WaterNasOS/core/routes/app_routes.dart';
import 'package:WaterNasOS/core/theme/custom_colors.dart';
import 'package:WaterNasOS/core/user/current_user_controller.dart';
import 'package:WaterNasOS/modules/base/components/custom_bordered_icon_button.dart';
import 'package:WaterNasOS/modules/base/components/custom_expandable_search_bar.dart';
import 'package:WaterNasOS/modules/video/base/views/app_video_item_poster.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:get/get.dart';
import '../../../base/components/custom_no_data.dart';
import '../../history/controller/video_history_controller.dart';
import '../../video_main/view/app_video_settings_view.dart';
import '../controller/video_list_controller.dart';
import 'parts/video_list_filter_menu.dart';
import 'parts/video_list_grid.dart';
import 'parts/video_list_sort_menu.dart';

class AppVideoListPage extends StatefulWidget {
  final String initialMediaType;
  final String listType;
  final int? collectionId;
  final int? smartAlbumId;

  /// 限定到某个影视库（0 = 不限，走原来的 movie/tv 全量入口）。
  /// 2026-10-12：安卓端栏目条改成动态库列表后，需要按库过滤。
  final int libraryId;
  final List<String> initialGenres;
  final List<String> initialRegions;
  final List<String> initialActors;
  final List<String> initialDirectors;
  final VoidCallback? onBack;
  const AppVideoListPage({
    super.key,
    required this.initialMediaType,
    this.listType = '',
    this.collectionId,
    this.smartAlbumId,
    this.libraryId = 0,
    this.initialGenres = const <String>[],
    this.initialRegions = const <String>[],
    this.initialActors = const <String>[],
    this.initialDirectors = const <String>[],
    this.onBack,
  });

  @override
  State<AppVideoListPage> createState() => _AppVideoListPageState();
}

class _AppVideoListPageState extends State<AppVideoListPage> {
  final ScrollController _scrollController = ScrollController();
  late final String _controllerTag;
  late final String _historyControllerTag;

  TextEditingController? _searchCtrl;
  Worker? _searchWorker;

  bool get _isHistory => widget.listType.trim().toLowerCase() == 'history';

  @override
  void initState() {
    super.initState();
    _controllerTag =
        'app_video_list_${widget.initialMediaType}_${widget.listType}_${widget.collectionId ?? 0}_${widget.smartAlbumId ?? 0}_lib${widget.libraryId}_${widget.initialGenres.join('|')}_${widget.initialRegions.join('|')}_${widget.initialActors.join('|')}_${widget.initialDirectors.join('|')}_${UniqueKey()}';
    _historyControllerTag = 'app_video_history_${UniqueKey()}';
    _scrollController.addListener(_onScroll);
  }

  @override
  void dispose() {
    _searchWorker?.dispose();
    _searchCtrl?.dispose();
    _scrollController.removeListener(_onScroll);
    _scrollController.dispose();
    super.dispose();
  }

  void _openSettings() {
    Get.to(
      () => Scaffold(
        appBar: AppBar(title: Text('setting'.tr)),
        body: const AppVideoSettingsView(),
      ),
      preventDuplicates: false,
    );
  }

  void _onScroll() {
    if (_isHistory) return;
    final ctrl = Get.isRegistered<VideoListController>(tag: _controllerTag)
        ? Get.find<VideoListController>(tag: _controllerTag)
        : null;
    if (ctrl == null) return;
    if (!_scrollController.hasClients) return;

    final pos = _scrollController.position;
    if (pos.maxScrollExtent <= 0) return;
    if (pos.pixels >= pos.maxScrollExtent - 360) {
      ctrl.loadMore(fromAuto: true).catchError((_) {});
    }
  }

  void _handleBack() {
    final cb = widget.onBack;
    if (cb != null) {
      cb();
      return;
    }
    AppRoutes.back();
  }

  Future<void> _openSortSheet(VideoListController controller) async {
    await showModalBottomSheet<void>(
      context: context,
      showDragHandle: true,
      useSafeArea: true,
      builder: (ctx) {
        final theme = Theme.of(ctx);
        final entries = getVideoListSortEntries(controller);
        return Material(
          color: theme.colorScheme.surface,
          child: Obx(() {
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
                      leading:
                          controller.sortBy.value == e.by &&
                              controller.sortOrder.value == e.order
                          ? Icon(Icons.check, color: theme.colorScheme.primary)
                          : const SizedBox(width: 24),
                      title: Text(e.labelKey!.tr),
                      onTap: () {
                        Navigator.of(ctx).pop();
                        controller.setSort(e.by!, e.order!);
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

  Future<void> _openFilterSheet(VideoListController controller) async {
    await showModalBottomSheet<void>(
      context: context,
      showDragHandle: true,
      isScrollControlled: true,
      useSafeArea: true,
      builder: (ctx) {
        final theme = Theme.of(ctx);
        final maxH = MediaQuery.of(ctx).size.height * 0.86;
        return Material(
          color: theme.colorScheme.surface,
          child: ConstrainedBox(
            constraints: BoxConstraints(maxHeight: maxH),
            child: SingleChildScrollView(
              padding: const EdgeInsets.only(bottom: 16),
              child: Center(
                child: ConstrainedBox(
                  constraints: const BoxConstraints(maxWidth: 860),
                  child: VideoListFilterPanel(
                    controller: controller,
                    showMediaTypeFilter: true,
                    contentPadding: const EdgeInsets.fromLTRB(14, 8, 14, 12),
                  ),
                ),
              ),
            ),
          ),
        );
      },
    );
  }

  @override
  Widget build(BuildContext context) {
    final topPad = MediaQuery.of(context).padding.top;
    final theme = Theme.of(context);
    final customColors = theme.extension<CustomColors>();
    final statusBarIconBrightness = theme.brightness == Brightness.dark
        ? Brightness.light
        : Brightness.dark;
    if (_isHistory) {
      return AnnotatedRegion<SystemUiOverlayStyle>(
        value: SystemUiOverlayStyle(
          statusBarIconBrightness: statusBarIconBrightness,
          statusBarBrightness: theme.brightness,
        ),
        child: Material(
          color: theme.scaffoldBackgroundColor,
          child: GetBuilder<VideoHistoryController>(
            tag: _historyControllerTag,
            init: VideoHistoryController(),
            builder: (ctrl) {
              return Column(
                children: [
                  Padding(
                    padding: EdgeInsets.fromLTRB(12, topPad, 12, 8),
                    child: SizedBox(height: 0),
                  ),
                  Expanded(
                    child: Material(
                      color: customColors?.mainContentBgColor,
                      child: Obx(() {
                        if (ctrl.loading.value) {
                          return const Center(
                            child: CircularProgressIndicator(),
                          );
                        }

                        if (ctrl.items.isEmpty) {
                          return CustomNoData(text: 'video_history_empty'.tr);
                        }

                        return RefreshIndicator(
                          onRefresh: () => ctrl.refreshList(showLoading: false),
                          child: Scrollbar(
                            controller: _scrollController,
                            child: CustomScrollView(
                              controller: _scrollController,
                              cacheExtent: 1600,
                              slivers: [
                                SliverPadding(
                                  padding: const EdgeInsets.fromLTRB(
                                    16,
                                    10,
                                    16,
                                    16,
                                  ),
                                  sliver: _AppVideoHistoryGrid(
                                    controller: ctrl,
                                  ),
                                ),
                                const SliverToBoxAdapter(
                                  child: SizedBox(height: 92),
                                ),
                              ],
                            ),
                          ),
                        );
                      }),
                    ),
                  ),
                ],
              );
            },
          ),
        ),
      );
    }

    return AnnotatedRegion<SystemUiOverlayStyle>(
      value: SystemUiOverlayStyle(
        statusBarIconBrightness: statusBarIconBrightness,
        statusBarBrightness: theme.brightness,
      ),
      child: Material(
        color: theme.scaffoldBackgroundColor,
        child: GetBuilder<VideoListController>(
          tag: _controllerTag,
          init: VideoListController(
            initialMediaType: widget.initialMediaType,
            listType: widget.listType,
            collectionId: widget.collectionId,
            smartAlbumId: widget.smartAlbumId,
            libraryId: widget.libraryId,
            initialGenres: widget.initialGenres,
            initialRegions: widget.initialRegions,
            initialActors: widget.initialActors,
            initialDirectors: widget.initialDirectors,
          ),
          builder: (ctrl) {
            if (_searchCtrl == null) {
              _searchCtrl = TextEditingController(text: ctrl.searchText.value);
              _searchWorker = ever<String>(ctrl.searchText, (v) {
                if (!mounted) return;
                if (_searchCtrl!.text == v) return;
                _searchCtrl!.value = _searchCtrl!.value.copyWith(
                  text: v,
                  selection: TextSelection.collapsed(offset: v.length),
                  composing: TextRange.empty,
                );
              });
            }
            return Column(
              children: [
                Padding(
                  padding: EdgeInsets.fromLTRB(8, topPad + 6, 8, 4),
                  child: Column(
                    children: [
                      Row(
                        crossAxisAlignment: CrossAxisAlignment.center,
                        children: [
                          CustomBorderedIconButton(
                            icon: Icons.home_outlined,
                            onTap: _handleBack,
                            tooltip: 'app_files_back_home'.tr,
                          ),
                          // if (CurrentUserController.instance.isAdmin) ...[
                          //   const SizedBox(width: 6),
                          //   CustomBorderedIconButton(
                          //     icon: Icons.settings_outlined,
                          //     onTap: _openSettings,
                          //     tooltip: 'setting'.tr,
                          //   ),
                          // ],
                          const SizedBox(width: 8),
                          Expanded(
                            child: CustomExpandableSearchBar(
                              controller: _searchCtrl,
                              hintText: 'video_list_search_hint'.tr,
                              onChanged: ctrl.setSearchText,
                              onClear: ctrl.clearSearch,
                              defaultExpanded: true,
                            ),
                          ),
                          const SizedBox(width: 8),
                          Obx(() {
                            return CustomBorderedIconButton(
                              icon: Icons.sort_by_alpha,
                              onTap: () => _openSortSheet(ctrl),
                              tooltip: 'sort'.tr,
                              active: ctrl.hasCustomSort,
                            );
                          }),
                          const SizedBox(width: 6),
                          // ⭐ 2026-10-19 「来源」按钮从移动端顶栏撤掉（用户要求：手机上看不到用处），
                          //    换成封面图 / 缩略图切换；状态按库持久化（同桌面端 setShowFanart）。
                          Obx(() {
                            final fanart = ctrl.showFanart.value;
                            return CustomBorderedIconButton(
                              icon: fanart
                                  ? Icons.crop_16_9
                                  : Icons.crop_portrait,
                              onTap: () => ctrl.setShowFanart(!fanart),
                              tooltip: fanart
                                  ? 'video_list_image_fanart'.tr
                                  : 'video_list_image_poster'.tr,
                              active: fanart,
                            );
                          }),
                          const SizedBox(width: 6),
                          Obx(() {
                            return CustomBorderedIconButton(
                              icon: Icons.filter_alt_outlined,
                              onTap: () => _openFilterSheet(ctrl),
                              tooltip: 'filter'.tr,
                              active: ctrl.hasActiveFilters,
                            );
                          }),
                          const SizedBox(width: 6),
                          // ⭐ 桌面端没有下拉刷新手势，必须留一个显式刷新入口
                          CustomBorderedIconButton(
                            icon: Icons.refresh,
                            onTap: () => ctrl.refreshList(showLoading: false),
                            tooltip: 'refresh'.tr,
                          ),
                        ],
                      ),
                    ],
                  ),
                ),
                Expanded(
                  child: Material(
                    color: customColors?.mainContentBgColor,
                    child: Obx(() {
                      if (ctrl.loading.value) {
                        return const Center(child: CircularProgressIndicator());
                      }

                      if (ctrl.items.isEmpty) {
                        return CustomNoData(text: 'no_data'.tr);
                      }

                      return Scrollbar(
                        controller: _scrollController,
                        child: CustomScrollView(
                          controller: _scrollController,
                          cacheExtent: 1600,
                          slivers: [
                            SliverPadding(
                              padding: const EdgeInsets.fromLTRB(
                                16,
                                10,
                                16,
                                16,
                              ),
                              sliver: _AppVideoListGrid(controller: ctrl),
                            ),
                            SliverToBoxAdapter(
                              child: Padding(
                                padding: const EdgeInsets.only(bottom: 92),
                                child: VideoListFooter(controller: ctrl),
                              ),
                            ),
                          ],
                        ),
                      );
                    }),
                  ),
                ),
              ],
            );
          },
        ),
      ),
    );
  }
}

class _AppVideoListGrid extends StatelessWidget {
  final VideoListController controller;
  const _AppVideoListGrid({required this.controller});

  @override
  Widget build(BuildContext context) {
    return Obx(() {
      final posterScale = controller.posterScale.value;
      final showFanart = controller.showFanart.value;
      return SliverLayoutBuilder(
        builder: (context, constraints) {
          final maxWidth = constraints.crossAxisExtent;
          final spacing = maxWidth < 420 ? 10.0 : 12.0;

          // ⭐ 2026-10-19 缩略图模式：一行一个，宽度自适应整行。
          //   高度按 3:2 横版反算（= 刮削 backdrop 的真实比例），再加标题区高度。
          if (showFanart) {
            final itemWidth = maxWidth;
            final imageHeight = itemWidth / (3 / 2);
            final estimatedHeight = imageHeight + 54;
            return SliverGrid(
              delegate: SliverChildBuilderDelegate(
                (context, idx) => _buildItem(idx, itemWidth, true),
                childCount: controller.items.length,
                addAutomaticKeepAlives: false,
              ),
              gridDelegate: SliverGridDelegateWithFixedCrossAxisCount(
                crossAxisCount: 1,
                mainAxisSpacing: spacing,
                crossAxisSpacing: spacing,
                childAspectRatio: itemWidth / estimatedHeight,
              ),
            );
          }

          final baseWidth = maxWidth < 420 ? 120.0 : 140.0;
          final desiredWidth = baseWidth * posterScale;
          final crossAxisCount = (maxWidth / desiredWidth).floor().clamp(2, 6);
          final totalSpacing = spacing * (crossAxisCount - 1);
          final itemWidth = ((maxWidth - totalSpacing) / crossAxisCount)
              .floorToDouble();
          final estimatedHeight = itemWidth * 1.5 + 54;
          final aspectRatio = itemWidth / estimatedHeight;

          return SliverGrid(
            delegate: SliverChildBuilderDelegate(
              (context, idx) => _buildItem(idx, itemWidth, false),
              childCount: controller.items.length,
              addAutomaticKeepAlives: false,
            ),
            gridDelegate: SliverGridDelegateWithFixedCrossAxisCount(
              crossAxisCount: crossAxisCount,
              mainAxisSpacing: spacing,
              crossAxisSpacing: spacing,
              childAspectRatio: aspectRatio,
            ),
          );
        },
      );
    });
  }

  Widget _buildItem(int idx, double width, bool showFanart) {
    final item = controller.items[idx];
    return AppVideoItemPoster(
      item: item,
      width: width,
      showFanart: showFanart,
      progress: null,
      onDeleted: (deleted) {
        controller.items.removeWhere((e) => e.id == deleted.id);
        controller.total.value = (controller.total.value - 1).clamp(0, 1 << 30);
      },
      onFavoriteChanged: (isFav) => controller.updateFavoriteState(item.id, isFav),
    );
  }
}

class _AppVideoHistoryGrid extends StatelessWidget {
  final VideoHistoryController controller;
  const _AppVideoHistoryGrid({required this.controller});

  @override
  Widget build(BuildContext context) {
    VideoListController.ensureSharedPosterScaleLoaded();
    return Obx(() {
      final posterScale = VideoListController.sharedPosterScale.value;
      return SliverLayoutBuilder(
        builder: (context, constraints) {
          final maxWidth = constraints.crossAxisExtent;
          final baseWidth = maxWidth < 420 ? 120.0 : 140.0;
          final desiredWidth = baseWidth * posterScale;
          final crossAxisCount = (maxWidth / desiredWidth).floor().clamp(2, 6);
          final spacing = maxWidth < 420 ? 10.0 : 12.0;
          final totalSpacing = spacing * (crossAxisCount - 1);
          final itemWidth = ((maxWidth - totalSpacing) / crossAxisCount)
              .floorToDouble();
          final estimatedHeight = itemWidth * 1.5 + 54;
          final aspectRatio = itemWidth / estimatedHeight;

          return SliverGrid(
            delegate: SliverChildBuilderDelegate(
              (context, idx) {
                final item = controller.items[idx];
                return AppVideoItemPoster(
                  item: item,
                  width: itemWidth,
                  progress: item.progress,
                  onDeleted: (deleted) =>
                      controller.items.removeWhere((e) => e.id == deleted.id),
                  onFavoriteChanged: (isFav) {
                    controller.items[idx] = controller.items[idx].copyWith(
                      isFavorite: isFav,
                    );
                  },
                );
              },
              childCount: controller.items.length,
              addAutomaticKeepAlives: false,
            ),
            gridDelegate: SliverGridDelegateWithFixedCrossAxisCount(
              crossAxisCount: crossAxisCount,
              mainAxisSpacing: spacing,
              crossAxisSpacing: spacing,
              childAspectRatio: aspectRatio,
            ),
          );
        },
      );
    });
  }
}
