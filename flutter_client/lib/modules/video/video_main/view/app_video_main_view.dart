import 'dart:math' as math;

import 'package:WaterNasOS/core/routes/app_routes.dart';
import 'package:WaterNasOS/core/theme/custom_colors.dart';
import 'package:WaterNasOS/core/user/current_user_controller.dart';
import 'package:WaterNasOS/modules/folder_view/folder_view_module_type.dart';
import 'package:WaterNasOS/modules/folder_view/view/app_folder_view_page.dart';
import 'package:WaterNasOS/modules/video/app_album/view/app_video_albums_home_page.dart';
import 'package:WaterNasOS/modules/base/components/custom_bordered_icon_button.dart';
import 'package:WaterNasOS/modules/video/home/view/app_video_home_page.dart';
import 'package:WaterNasOS/modules/video/library_setting/models/video_library.dart';
import 'package:WaterNasOS/modules/video/library_setting/service/video_library_api_service.dart';
import 'package:WaterNasOS/modules/video/media_browser/view/video_media_browser_page.dart';
import 'package:WaterNasOS/utils/toast_util.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:get/get.dart';
import '../../list/view/app_video_list_page.dart';
import 'app_video_settings_view.dart';

/// 安卓端影视主界面。
///
/// 2026-10-12 三处结构性调整：
/// ① 底部「栏目条」不再写死「主页 / 电影 / 电视剧 / 收藏」，改为**动态读取影视库**
///    （与 web 左侧栏同一口径：只列 totalCount > 0 的库），横向可滑动；
/// ② 「收藏」从栏目条挪到底部导航栏，位置在「专辑」之后；
/// ③ 进入图片库 / 混合库时走 [VideoMediaBrowserPage]，与 web 端
///    `VideoMainView` 的 `isMediaGridLib` 分支保持一致。
class AppVideoMainView extends StatefulWidget {
  const AppVideoMainView({super.key});

  @override
  State<AppVideoMainView> createState() => _AppVideoMainViewState();
}

class _AppVideoMainViewState extends State<AppVideoMainView> {
  /// 底部导航：0 影视库 / 1 历史 / 2 专辑 / 3 收藏 / 4 文件
  int _tabIndex = 0;

  /// 影视库 tab 内选中的库：0 = 影视库首页
  int _selectedLibId = 0;

  /// 与 web 左侧栏同口径：只显示「有内容」的库
  List<VideoLibrary> _libraries = <VideoLibrary>[];

  @override
  void initState() {
    super.initState();
    _loadLibraries();
  }

  /// 拉取可见影视库。
  ///
  /// ⚠️ 过滤条件必须与 `VideoLeftMenu` 一致（`totalCount > 0`）：
  /// 服务端的 counts 是按「该用户可见路径」统计的，无权限时天然是 0，
  /// 所以一个条件同时管住「空库」和「无权限库」。
  Future<void> _loadLibraries() async {
    final list = await VideoLibraryApiService.instance.listLibraries();
    if (!mounted) return;
    final visible = list.where((l) => l.totalCount > 0).toList();
    setState(() {
      _libraries = visible;
      if (_selectedLibId != 0 &&
          !visible.any((l) => l.id == _selectedLibId)) {
        _selectedLibId = 0;
      }
    });
  }

  VideoLibrary? _libById(int id) {
    for (final l in _libraries) {
      if (l.id == id) return l;
    }
    return null;
  }

  /// 首页「电影 / 电视剧」入口 → 找到同类库并切过去（找不到就回首页）
  void _openLibByType(String libType) {
    for (final l in _libraries) {
      if (l.libType == libType) {
        setState(() => _selectedLibId = l.id);
        return;
      }
    }
    setState(() => _selectedLibId = 0);
  }

  void _openHome() {
    AppRoutes.toHome();
  }

  Future<void> _openSettings() async {
    await Get.to(
      () => Scaffold(
        appBar: AppBar(title: Text('setting'.tr)),
        body: const AppVideoSettingsView(),
      ),
      preventDuplicates: false,
    );
    // 设置里可能改了库（新增/删除），回来刷新栏目条
    if (mounted) await _loadLibraries();
  }

  /// ⭐ 库排序（仅管理员）。
  ///
  /// 顺序是服务端全局的（`video_library.sort`），所以拖完 web 左侧栏也跟着变。
  Future<void> _openReorderSheet() async {
    if (_libraries.isEmpty) return;
    if (!CurrentUserController.instance.isSuperAdmin) return;
    final theme = Theme.of(context);
    final order = List<VideoLibrary>.from(_libraries);

    final saved = await showModalBottomSheet<bool>(
      context: context,
      showDragHandle: true,
      isScrollControlled: true,
      useSafeArea: true,
      builder: (ctx) {
        return StatefulBuilder(
          builder: (ctx, setSheetState) {
            final height = math.min(
              order.length * 56.0 + 150,
              MediaQuery.of(ctx).size.height * 0.82,
            );
            return SizedBox(
              height: height,
              child: Material(
                color: theme.colorScheme.surface,
                child: Column(
                  children: [
                    Padding(
                      padding: const EdgeInsets.fromLTRB(16, 0, 16, 10),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            'video_library_reorder_title'.tr,
                            style: theme.textTheme.titleSmall,
                          ),
                          const SizedBox(height: 2),
                          Text(
                            'video_library_reorder_desc'.tr,
                            style: theme.textTheme.bodySmall?.copyWith(
                              color: theme.colorScheme.onSurface.withValues(
                                alpha: 0.6,
                              ),
                            ),
                          ),
                        ],
                      ),
                    ),
                    const Divider(height: 1),
                    Expanded(
                      child: ReorderableListView.builder(
                        padding: const EdgeInsets.symmetric(vertical: 4),
                        itemCount: order.length,
                        onReorder: (oldIndex, newIndex) {
                          setSheetState(() {
                            if (newIndex > oldIndex) newIndex -= 1;
                            final item = order.removeAt(oldIndex);
                            order.insert(newIndex, item);
                          });
                        },
                        itemBuilder: (ctx, i) {
                          final lib = order[i];
                          return ListTile(
                            key: ValueKey('app_video_reorder_lib_${lib.id}'),
                            dense: true,
                            leading: Icon(
                              libTypeIcon(lib.libType),
                              size: 20,
                              color: theme.colorScheme.primary,
                            ),
                            title: Text(lib.displayName),
                            trailing: const Icon(Icons.drag_handle),
                          );
                        },
                      ),
                    ),
                    const Divider(height: 1),
                    Padding(
                      padding: const EdgeInsets.fromLTRB(12, 8, 12, 12),
                      child: Row(
                        mainAxisAlignment: MainAxisAlignment.end,
                        children: [
                          TextButton(
                            onPressed: () => Navigator.of(ctx).pop(false),
                            child: Text('cancel'.tr),
                          ),
                          const SizedBox(width: 8),
                          ElevatedButton(
                            onPressed: () => Navigator.of(ctx).pop(true),
                            child: Text('save'.tr),
                          ),
                        ],
                      ),
                    ),
                  ],
                ),
              ),
            );
          },
        );
      },
    );

    if (saved != true) return;
    final res = await VideoLibraryApiService.instance.reorderLibraries(
      order.map((e) => e.id).toList(),
    );
    if (!res.success) {
      ToastUtil.show(res.message ?? 'operation_failed'.tr);
      return;
    }
    ToastUtil.show('operation_success'.tr);
    await _loadLibraries();
  }

  Widget _modeChip({
    required String label,
    required bool selected,
    required VoidCallback onTap,
    IconData? icon,
    VoidCallback? onLongPress,
  }) {
    final theme = Theme.of(context);
    return InkWell(
      onTap: onTap,
      onLongPress: onLongPress,
      borderRadius: BorderRadius.circular(16),
      child: Container(
        height: 32,
        padding: const EdgeInsets.symmetric(horizontal: 14),
        alignment: Alignment.center,
        decoration: BoxDecoration(
          color: selected ? theme.colorScheme.primary : Colors.transparent,
          borderRadius: BorderRadius.circular(16),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            if (icon != null) ...[
              Icon(
                icon,
                size: 15,
                color: selected
                    ? theme.colorScheme.onPrimary
                    : theme.colorScheme.onSurface,
              ),
              const SizedBox(width: 5),
            ],
            Text(
              label,
              style: theme.textTheme.labelLarge?.copyWith(
                color: selected
                    ? theme.colorScheme.onPrimary
                    : theme.colorScheme.onSurface,
                fontWeight: FontWeight.w600,
              ),
            ),
          ],
        ),
      ),
    );
  }

  /// 浮动栏目条：主页 + 全部可见影视库，横向滑动，长按库可排序。
  ///
  /// ⛔ 不要用 Expanded 均分宽度 —— 库一多每个 chip 会被压到看不见名字。
  /// 这里改成内容自适应宽度 + 横向滚动。
  Widget _buildFloatingModeBar() {
    final theme = Theme.of(context);
    final customColors = theme.extension<CustomColors>();
    final isAdmin = CurrentUserController.instance.isSuperAdmin;

    if (_tabIndex != 0) return const SizedBox.shrink();

    return Positioned(
      left: 0,
      right: 0,
      bottom: 10,
      child: Container(
        height: 45,
        margin: const EdgeInsets.symmetric(horizontal: 16),
        padding: const EdgeInsets.symmetric(horizontal: 4),
        decoration: BoxDecoration(
          color: (customColors?.oprationBarBgColor ?? theme.colorScheme.surface)
              .withValues(alpha: 0.92),
          borderRadius: BorderRadius.circular(22.5),
        ),
        child: SingleChildScrollView(
          scrollDirection: Axis.horizontal,
          child: Row(
            children: [
              _modeChip(
                label: 'home'.tr,
                selected: _selectedLibId == 0,
                onTap: () => setState(() => _selectedLibId = 0),
              ),
              for (final lib in _libraries)
                Padding(
                  padding: const EdgeInsets.only(left: 2),
                  child: _modeChip(
                    label: lib.displayName,
                    icon: libTypeIcon(lib.libType),
                    selected: _selectedLibId == lib.id,
                    onTap: () => setState(() => _selectedLibId = lib.id),
                    onLongPress: isAdmin ? _openReorderSheet : null,
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _buildTabBody() {
    if (_tabIndex == 0) {
      if (_selectedLibId == 0) {
        return AppVideoHomePage(
          key: const ValueKey('app_video_home'),
          onOpenMovie: () => _openLibByType('movie'),
          onOpenTv: () => _openLibByType('tv'),
          onOpenLibrary: (id) => setState(() => _selectedLibId = id),
          onOpenHistory: () => setState(() => _tabIndex = 1),
        );
      }
      final lib = _libById(_selectedLibId);
      if (lib == null) {
        // 库被删/无权限了：退回首页（_loadLibraries 里也会纠正选中项）
        return AppVideoHomePage(
          key: const ValueKey('app_video_home'),
          onOpenMovie: () => _openLibByType('movie'),
          onOpenTv: () => _openLibByType('tv'),
          onOpenLibrary: (id) => setState(() => _selectedLibId = id),
          onOpenHistory: () => setState(() => _tabIndex = 1),
        );
      }
      // ⭐ 图片库 / 混合库：与 web 端一致，走「网格 + 竖向全屏浏览」
      if (lib.isMediaGridLib) {
        return KeyedSubtree(
          key: ValueKey('app_video_media_browser_${lib.id}'),
          child: VideoMediaBrowserPage(
            key: ValueKey('app_video_media_browser_page_${lib.id}'),
            libraryId: lib.id,
            libType: lib.libType,
            title: lib.displayName,
          ),
        );
      }
      return KeyedSubtree(
        key: ValueKey('app_video_library_list_${lib.id}'),
        child: AppVideoListPage(
          key: ValueKey('app_video_library_list_page_${lib.id}'),
          initialMediaType: lib.libType,
          libraryId: lib.id,
          onBack: () => setState(() => _selectedLibId = 0),
        ),
      );
    }
    if (_tabIndex == 1) {
      return AppVideoListPage(
        key: const ValueKey('app_video_list_history'),
        initialMediaType: '',
        listType: 'history',
        onBack: () => setState(() {
          _tabIndex = 0;
          _selectedLibId = 0;
        }),
      );
    }
    if (_tabIndex == 2) {
      return const KeyedSubtree(
        key: ValueKey('app_video_albums_home'),
        child: AppVideoAlbumsHomePage(),
      );
    }
    // ⭐ 收藏：2026-10-12 从栏目条挪到底部导航（位置在「专辑」之后）
    if (_tabIndex == 3) {
      return AppVideoListPage(
        key: const ValueKey('app_video_list_favorite'),
        initialMediaType: '',
        listType: 'favorite',
        onBack: () => setState(() {
          _tabIndex = 0;
          _selectedLibId = 0;
        }),
      );
    }
    if (_tabIndex == 4) {
      return const KeyedSubtree(
        key: ValueKey('app_video_file_view'),
        child: AppFolderViewPage(moduleType: FolderViewModuleType.video),
      );
    }
    return Center(child: Text('not_implemented_yet'.tr));
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final customColors = theme.extension<CustomColors>();
    final barColor =
        customColors?.oprationBarBgColor ?? theme.colorScheme.surface;

    final bottomItems = <BottomNavigationBarItem>[
      BottomNavigationBarItem(
        icon: const Icon(Icons.movie_filter_outlined),
        label: 'video_menu_library'.tr,
      ),
      BottomNavigationBarItem(
        icon: const Icon(Icons.history_outlined),
        label: 'video_menu_library_history'.tr,
      ),
      BottomNavigationBarItem(
        icon: const Icon(Icons.video_collection_outlined),
        label: 'video_menu_albums'.tr,
      ),
      // ⭐ 收藏移到底部导航，位置紧跟「专辑」
      BottomNavigationBarItem(
        icon: const Icon(Icons.favorite_outline),
        label: 'favorites'.tr,
      ),
      BottomNavigationBarItem(
        icon: const Icon(Icons.folder_outlined),
        label: 'file'.tr,
      ),
    ];

    final isHome = _tabIndex == 0 && _selectedLibId == 0;
    final statusBarIconBrightness = isHome
        ? Brightness.light
        : (theme.brightness == Brightness.dark
              ? Brightness.light
              : Brightness.dark);

    return Scaffold(
      backgroundColor: theme.scaffoldBackgroundColor,
      body: AnnotatedRegion<SystemUiOverlayStyle>(
        value: SystemUiOverlayStyle(
          statusBarColor: Colors.transparent,
          statusBarIconBrightness: statusBarIconBrightness,
          statusBarBrightness: isHome ? Brightness.dark : theme.brightness,
          systemNavigationBarColor: barColor,
          systemNavigationBarIconBrightness: Brightness.dark,
          systemNavigationBarDividerColor: barColor,
        ),
        child: Stack(
          children: [
            SafeArea(
              top: false,
              bottom: false,
              child: Column(
                children: [
                  Expanded(
                    child: Stack(
                      children: [_buildTabBody(), _buildFloatingModeBar()],
                    ),
                  ),
                ],
              ),
            ),
            if (isHome)
              Positioned(
                left: 12,
                top: MediaQuery.of(context).padding.top + 10,
                child: CustomBorderedIconButton(
                  icon: Icons.home_outlined,
                  onTap: _openHome,
                  size: 42,
                  iconSize: 22,
                  borderRadius: 999,
                  backgroundColor: theme.colorScheme.surface.withValues(
                    alpha: 0.75,
                  ),
                  borderColor: theme.colorScheme.onSurface.withValues(
                    alpha: 0.12,
                  ),
                  iconColor: theme.colorScheme.onSurface,
                ),
              ),
            // ⭐ 设置入口对**所有**用户开放（2026-10-12）：
            // 子账号进去只会看到「播放设置」（默认画质 / 音频降混，且按端隔离），
            // 转码 / 刮削 / 字幕 / 影视库 / 来源 都只有管理员可见。
            if (isHome)
              Positioned(
                right: 12,
                top: MediaQuery.of(context).padding.top + 10,
                child: CustomBorderedIconButton(
                  icon: Icons.settings_outlined,
                  onTap: _openSettings,
                  size: 42,
                  iconSize: 22,
                  borderRadius: 999,
                  backgroundColor: theme.colorScheme.surface.withValues(
                    alpha: 0.75,
                  ),
                  borderColor: theme.colorScheme.onSurface.withValues(
                    alpha: 0.12,
                  ),
                  iconColor: theme.colorScheme.onSurface,
                ),
              ),
          ],
        ),
      ),
      bottomNavigationBar: ColoredBox(
        color: barColor,
        child: SafeArea(
          top: false,
          child: BottomNavigationBar(
            backgroundColor: barColor,
            elevation: 0,
            currentIndex: _tabIndex.clamp(0, bottomItems.length - 1),
            onTap: (i) {
              if (i == _tabIndex) return;
              setState(() => _tabIndex = i);
            },
            selectedItemColor: theme.colorScheme.primary,
            unselectedItemColor: theme.colorScheme.onSurfaceVariant,
            type: BottomNavigationBarType.fixed,
            items: bottomItems,
          ),
        ),
      ),
    );
  }
}
