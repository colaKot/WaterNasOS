import 'package:flutter/material.dart';
import 'package:get/get.dart';
import 'package:flutter/services.dart';
import 'package:WaterNasOS/core/bootstrap/app_launch.dart';
import '../../timeline/controller/photo_timeline_controller.dart';
import '../../timeline/view/app_photo_timeline_view.dart';
import '../../../../utils/toast_util.dart';
import '../../../../core/theme/custom_colors.dart';
import '../../timeline/view/app_photo_timeline_view_year.dart';
import '../../map/view/photo_footprint_map_view.dart';
import '../../album/view/app_photo_album_home_page.dart';
import '../../album/view/app_photo_album_list_page.dart';
import '../../smart_album/view/app_photo_smart_album_list_page.dart';
import '../../collection/view/app_photo_collection_list_page.dart';
import '../../../base/components/custom_bordered_icon_button.dart';
import '../../../base/components/custom_expandable_search_bar.dart';
import '../../app_setting/view/app_photo_settings_view.dart';
import '../../app_ai/view/app_photo_ai_view.dart';
import '../../timeline/view/parts/app_photo_timeline_multiselect_bar.dart';
import '../../trash/view/app_photo_trash_view.dart';
import '../../../photoBackup/view/app_photo_backup_view.dart';
import '../../../transfer/views/download/download_center/app_download_center_view.dart';

class AppPhotoMainView extends StatefulWidget {
  const AppPhotoMainView({super.key});

  @override
  State<AppPhotoMainView> createState() => _AppPhotoMainViewState();
}

enum _PhotoCenterMode { timeline, year }

class _AppPhotoMainViewState extends State<AppPhotoMainView> {
  late final String _timelineTag;
  late final PhotoTimelineController _timelineCtrl;
  int _index = 0;
  _PhotoCenterMode _centerMode = _PhotoCenterMode.timeline;
  final FocusNode _searchFocusNode = FocusNode();

  /// 独立相册 App（photo_client）模式：本文件的相册端专属改动只在此模式下生效，
  /// 主客户端（AppLaunchMode.full）行为一字不变。
  bool get _isPhotoApp => AppLaunch.mode == AppLaunchMode.photo;

  Future<void> _showAlbumCreateSheet() async {
    await showModalBottomSheet<void>(
      context: context,
      builder: (ctx) {
        return SafeArea(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              ListTile(
                leading: const Icon(Icons.photo_album_outlined),
                title: Text('app_photo_album_create_album'.tr),
                onTap: () async {
                  Navigator.of(ctx).pop();
                  await Navigator.of(context).push(
                    MaterialPageRoute(
                      builder: (_) => const AppPhotoAlbumListPage(
                        type: 'all',
                        selectionMode: false,
                        autoOpenCreate: true,
                      ),
                    ),
                  );
                },
              ),
              ListTile(
                leading: const Icon(Icons.auto_awesome_outlined),
                title: Text('app_photo_album_create_smart'.tr),
                onTap: () async {
                  Navigator.of(ctx).pop();
                  await Navigator.of(context).push(
                    MaterialPageRoute(
                      builder: (_) => const AppPhotoSmartAlbumListPage(
                        autoOpenCreate: true,
                      ),
                    ),
                  );
                },
              ),
              ListTile(
                leading: const Icon(Icons.folder_outlined),
                title: Text('app_photo_album_create_collection'.tr),
                onTap: () async {
                  Navigator.of(ctx).pop();
                  await Navigator.of(context).push(
                    MaterialPageRoute(
                      builder: (_) => const AppPhotoCollectionListPage(
                        autoOpenCreate: true,
                      ),
                    ),
                  );
                },
              ),
            ],
          ),
        );
      },
    );
  }

  @override
  void initState() {
    super.initState();
    _timelineTag = 'app_photo_timeline_${UniqueKey()}';
    _timelineCtrl = Get.put(
      PhotoTimelineController(
        initialListType: 'timeline',
        alertWhenNoSourcePath: true,
      ),
      tag: _timelineTag,
    );
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      _searchFocusNode.unfocus();
    });
  }

  @override
  void dispose() {
    _searchFocusNode.dispose();
    Get.delete<PhotoTimelineController>(tag: _timelineTag, force: true);
    super.dispose();
  }

  void _ensureSearchContext() {
    var changed = false;
    if (_index != 0) {
      _index = 0;
      changed = true;
    }
    if (_centerMode != _PhotoCenterMode.timeline) {
      _centerMode = _PhotoCenterMode.timeline;
      changed = true;
    }
    if (changed) {
      setState(() {});
    }
    _timelineCtrl.setTimelineMode(
      nextListType: 'timeline',
      nextLoadTheDay: false,
    );
  }

  Widget _buildHeader() {
    if (_index == 4) return const SizedBox.shrink();
    final theme = Theme.of(context);
    final customColors = theme.extension<CustomColors>();
    final barColor =
        customColors?.oprationBarBgColor ?? theme.colorScheme.surface;

    Widget buildNormalHeaderRow() {
      final isPhotoApp = _isPhotoApp;
      return Row(
        children: [
          // 独立相册端没有「桌面」可回：左上角不放主页图标（主客户端保持不变）
          if (!isPhotoApp) ...[
            CustomBorderedIconButton(
              icon: Icons.home_outlined,
              tooltip: 'back'.tr,
              onTap: () => Get.back(),
            ),
            const SizedBox(width: 8),
          ],
          // 搜索栏定宽：独立相册端左置定格；主客户端维持原靠右布局
          // （原先用 Expanded 会贪婪占满整行，把右侧按钮挤到重叠）
          Flexible(
            child: Align(
              alignment:
                  isPhotoApp ? Alignment.centerLeft : Alignment.centerRight,
              child: ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 220),
                child: CustomExpandableSearchBar(
                  hintText: 'photo_timeline_search_hint'.tr,
                  controller: _timelineCtrl.searchController,
                  onChanged: (val) {
                    _ensureSearchContext();
                    _timelineCtrl.onSearchChanged(val);
                  },
                  onClear: _timelineCtrl.clearSearch,
                  defaultExpanded: true,
                ),
              ),
            ),
          ),
          const SizedBox(width: 8),
          // 独立相册端：回收站前加下载按钮（向下箭头），点开即下载中心
          if (_index == 0 && isPhotoApp) ...[
            CustomBorderedIconButton(
              icon: Icons.arrow_downward,
              tooltip: 'home_download_center'.tr,
              onTap: () => Get.to(() => const AppDownloadCenterView()),
            ),
            const SizedBox(width: 8),
          ],
          if (_index == 0)
            CustomBorderedIconButton(
              icon: Icons.delete_outline,
              tooltip: 'recycle_bin'.tr,
              onTap: () {
                Navigator.of(context).push(
                  MaterialPageRoute(builder: (_) => const AppPhotoTrashPage()),
                );
              },
            ),
          if (_index == 0) const SizedBox(width: 8),
          CustomBorderedIconButton(
            icon: _index == 2 ? Icons.add : Icons.settings_outlined,
            tooltip: _index == 2 ? 'create'.tr : 'setting'.tr,
            onTap: () {
              if (_index == 2) {
                _showAlbumCreateSheet();
                return;
              }
              Navigator.of(context).push(
                MaterialPageRoute(builder: (_) => const AppPhotoSettingsView()),
              );
            },
          ),
        ],
      );
    }

    return Container(
      color: barColor,
      child: SafeArea(
        bottom: false,
        child: SizedBox(
          height: kToolbarHeight,
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 6),
            child: _index != 0
                ? buildNormalHeaderRow()
                : Obx(() {
                    final isMulti = _timelineCtrl.isMultiSelectMode.value;
                    if (isMulti) {
                      return Row(
                        children: [
                          IconButton(
                            tooltip: 'cancel'.tr,
                            onPressed: _timelineCtrl.exitMultiSelectMode,
                            icon: const Icon(Icons.close),
                          ),
                          Expanded(
                            child: Text(
                              '${_timelineCtrl.selectedItems.length} ${'selected'.tr}',
                              style: theme.textTheme.titleMedium?.copyWith(
                                fontWeight: FontWeight.w600,
                              ),
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                            ),
                          ),
                        ],
                      );
                    }
                    return buildNormalHeaderRow();
                  }),
          ),
        ),
      ),
    );
  }

  Widget _buildCenter() {
    if (_index == 0) {
      if (_centerMode == _PhotoCenterMode.year) {
        return const AppPhotoTimelineYearPage();
      }
      return AppPhotoTimelineView(controllerTag: _timelineTag);
    }
    if (_index == 1) {
      return const PhotoFootprintMapView();
    }
    if (_index == 2) {
      return const AppPhotoAlbumHomePage();
    }
    if (_index == 3) {
      return const AppPhotoAiView();
    }
    if (_index == 4) {
      // ⭐ 2026-10-19 手机端把「文件」tab 整体去掉（4 个 tab 就到 AI 为止）；
      //    这里只剩独立相册端的第 5 项「备份」。
      if (_isPhotoApp) return const AppPhotoBackupView(embedded: true);
      return Center(child: Text('not_implemented_yet'.tr));
    }
    return Center(child: Text('not_implemented_yet'.tr));
  }

  Widget _modeChip({
    required String label,
    required bool selected,
    required VoidCallback onTap,
  }) {
    final theme = Theme.of(context);
    return Expanded(
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(16),
        child: Container(
          height: 32,
          alignment: Alignment.center,
          decoration: BoxDecoration(
            color: selected ? theme.colorScheme.primary : Colors.transparent,
            borderRadius: BorderRadius.circular(16),
          ),
          child: Text(
            label,
            style: theme.textTheme.labelLarge?.copyWith(
              color: selected ? theme.colorScheme.onPrimary : theme.colorScheme.onSurface,
              fontWeight: FontWeight.w600,
            ),
          ),
        ),
      ),
    );
  }

  Widget _buildFloatingModeBar() {
    if (_index != 0) return const SizedBox.shrink();
    final theme = Theme.of(context);
    final customColors = theme.extension<CustomColors>();
    return Obx(() {
      if (_timelineCtrl.isMultiSelectMode.value) return const SizedBox.shrink();

      final isYear = _centerMode == _PhotoCenterMode.year;
      final isFavorite = !isYear && _timelineCtrl.listType.value == 'favorite';
      final isToday = !isYear && _timelineCtrl.loadTheDay.value;
      final isAll = !isYear && !isFavorite && !isToday;

      return Positioned(
        left: 16,
        right: 16,
        bottom: 10,
        child: Container(
          height: 45,
          padding: const EdgeInsets.symmetric(horizontal: 6),
          decoration: BoxDecoration(
            color:
                (customColors?.oprationBarBgColor ?? theme.colorScheme.surface)
                    .withValues(alpha: 0.92),
            borderRadius: BorderRadius.circular(22.5),
          ),
          child: Row(
            children: [
              _modeChip(
                label: 'all'.tr,
                selected: isAll,
                onTap: () {
                  if (_centerMode != _PhotoCenterMode.timeline) {
                    setState(() => _centerMode = _PhotoCenterMode.timeline);
                  }
                  _timelineCtrl.setTimelineMode(
                    nextListType: 'timeline',
                    nextLoadTheDay: false,
                  );
                },
              ),
              _modeChip(
                label: 'photo_timeline_view_year'.tr,
                selected: isYear,
                onTap: () =>
                    setState(() => _centerMode = _PhotoCenterMode.year),
              ),
              _modeChip(
                label: 'photo_timeline_view_today'.tr,
                selected: isToday,
                onTap: () {
                  if (_centerMode != _PhotoCenterMode.timeline) {
                    setState(() => _centerMode = _PhotoCenterMode.timeline);
                  }
                  _timelineCtrl.setTimelineMode(
                    nextListType: 'timeline',
                    nextLoadTheDay: true,
                  );
                },
              ),
              _modeChip(
                label: 'favorites'.tr,
                selected: isFavorite,
                onTap: () {
                  if (_centerMode != _PhotoCenterMode.timeline) {
                    setState(() => _centerMode = _PhotoCenterMode.timeline);
                  }
                  _timelineCtrl.setTimelineMode(
                    nextListType: 'favorite',
                    nextLoadTheDay: false,
                  );
                },
              ),
            ],
          ),
        ),
      );
    });
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final customColors = theme.extension<CustomColors>();
    final barColor =
        customColors?.oprationBarBgColor ?? theme.colorScheme.surface;
    return GetBuilder<PhotoTimelineController>(
      tag: _timelineTag,
      builder: (_) {
        Widget buildBottomNavigationBar() {
          return BottomNavigationBar(
            currentIndex: _index,
            onTap: (i) {
              if (i == _index) return;
              if (_timelineCtrl.isMultiSelectMode.value) {
                _timelineCtrl.exitMultiSelectMode();
              }
              if (i != 0 && _centerMode != _PhotoCenterMode.timeline) {
                setState(() => _centerMode = _PhotoCenterMode.timeline);
              }
              setState(() => _index = i);
              if (i != 0 && i != 1 && i != 2 && i != 3 && i != 4) {
                ToastUtil.show('not_implemented_yet'.tr);
              }
            },
            selectedItemColor: theme.colorScheme.primary,
            unselectedItemColor: theme.colorScheme.onSurfaceVariant,
            type: BottomNavigationBarType.fixed,
            items: [
              BottomNavigationBarItem(
                icon: const Icon(Icons.photo_library_outlined),
                label: 'app_photo_tab_photos'.tr,
              ),
              BottomNavigationBarItem(
                icon: const Icon(Icons.map_outlined),
                label: 'app_photo_tab_footprint'.tr,
              ),
              BottomNavigationBarItem(
                icon: const Icon(Icons.photo_album_outlined),
                label: 'app_photo_tab_album'.tr,
              ),
              BottomNavigationBarItem(
                icon: const Icon(Icons.auto_awesome_outlined),
                label: 'app_photo_tab_ai'.tr,
              ),
              // ⭐ 2026-10-19：主客户端不再有「文件」tab（找文件走桌面「文件」应用）；
              //    独立相册端保留「备份」作为第 5 项。
              if (_isPhotoApp)
                BottomNavigationBarItem(
                  icon: const Icon(Icons.cloud_upload_outlined),
                  label: 'app_backup'.tr,
                ),
            ],
          );
        }

        Widget buildScaffold({required bool isMulti}) {
          return Scaffold(
            backgroundColor: theme.scaffoldBackgroundColor,
            body: AnnotatedRegion<SystemUiOverlayStyle>(
              value: SystemUiOverlayStyle(
                statusBarColor: barColor,
                statusBarIconBrightness: theme.brightness == Brightness.dark
                    ? Brightness.light
                    : Brightness.dark,
                statusBarBrightness: theme.brightness,
                systemNavigationBarColor: barColor,
                systemNavigationBarIconBrightness:
                    theme.brightness == Brightness.dark
                    ? Brightness.light
                    : Brightness.dark,
                systemNavigationBarDividerColor: barColor,
              ),
              child: Column(
                children: [
                  _buildHeader(),
                  Expanded(
                    child: Stack(
                      children: [_buildCenter(), _buildFloatingModeBar()],
                    ),
                  ),
                ],
              ),
            ),
            bottomNavigationBar: isMulti
                ? AppPhotoTimelineMultiSelectBottomBar(
                    controllerTag: _timelineTag,
                  )
                : buildBottomNavigationBar(),
          );
        }

        // 独立相册端：体系内没有「桌面」可回，系统返回一律在相册端内部消化
        // （多选态先退多选 -> 非照片 tab 先回照片 tab -> 照片 tab 直接退出应用），
        // 绝不回桌面。主客户端维持原逻辑（pop 回桌面）。
        if (_isPhotoApp) {
          return Obx(() {
            final isMulti = _timelineCtrl.isMultiSelectMode.value;
            return PopScope(
              canPop: false,
              onPopInvoked: (didPop) {
                if (didPop) return;
                if (isMulti) {
                  _timelineCtrl.exitMultiSelectMode();
                  return;
                }
                if (_index != 0) {
                  setState(() => _index = 0);
                  return;
                }
                // 照片主页再返回：退出应用（而不是露出下面的桌面）
                SystemNavigator.pop();
              },
              child: buildScaffold(isMulti: isMulti),
            );
          });
        }

        if (_index != 0) {
          return PopScope(
            canPop: true,
            onPopInvoked: (_) {},
            child: buildScaffold(isMulti: false),
          );
        }

        return Obx(() {
          final isMulti = _timelineCtrl.isMultiSelectMode.value;
          return PopScope(
            canPop: !isMulti,
            onPopInvoked: (didPop) {
              if (!didPop && isMulti) _timelineCtrl.exitMultiSelectMode();
            },
            child: buildScaffold(isMulti: isMulti),
          );
        });
      },
    );
  }
}
