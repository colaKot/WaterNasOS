import 'package:WaterNasOS/core/routes/app_routes.dart';
import 'package:WaterNasOS/core/bootstrap/app_launch.dart';
import 'package:WaterNasOS/core/theme/custom_colors.dart';
import 'package:WaterNasOS/core/user/current_user_controller.dart';
import 'package:WaterNasOS/modules/transfer/views/download/download_center/app_download_center_view.dart';
import 'package:WaterNasOS/modules/music/album_artist_list/controller/album_artist_list_controller.dart';
import 'package:WaterNasOS/modules/music/album_artist_list/view/album_artist_list_page.dart';
import 'package:WaterNasOS/modules/base/components/custom_bordered_icon_button.dart';
import 'package:WaterNasOS/modules/music/list/controller/music_list_controller.dart';
import 'package:WaterNasOS/modules/music/list/view/music_list_page.dart';
import 'package:WaterNasOS/modules/music/sub_list/controller/music_sub_list_controller.dart';
import 'package:WaterNasOS/modules/music/sub_list/view/parts/music_sub_list_header.dart';
import 'package:WaterNasOS/modules/music/sub_list/view/parts/music_sub_list_overlay_body.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:get/get.dart';

class AppMusicMainView extends StatefulWidget {
  const AppMusicMainView({super.key, this.onOpenSettings});

  final VoidCallback? onOpenSettings;

  @override
  State<AppMusicMainView> createState() => _AppMusicMainViewState();
}

class _AppMusicMainViewState extends State<AppMusicMainView>
    with SingleTickerProviderStateMixin {
  late final TabController _tabController;

  @override
  void initState() {
    super.initState();
    _tabController = TabController(length: 5, vsync: this);
  }

  @override
  void dispose() {
    _tabController.dispose();
    super.dispose();
  }

  void _openHome() {
    AppRoutes.toHome();
  }

  /// 独立音乐 App（music_client）模式：本文件的音乐端专属改动只在此模式下生效，
  /// 主客户端（AppLaunchMode.full）行为一字不变。
  bool get _isMusicApp => AppLaunch.mode == AppLaunchMode.music;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final customColors = theme.extension<CustomColors>();
    final barColor =
        customColors?.oprationBarBgColor ?? theme.colorScheme.surface;
    return AnnotatedRegion<SystemUiOverlayStyle>(
      value: SystemUiOverlayStyle(
        statusBarColor: barColor,
        statusBarIconBrightness: theme.brightness == Brightness.dark
            ? Brightness.light
            : Brightness.dark,
        statusBarBrightness: theme.brightness,
        systemNavigationBarColor: barColor,
        systemNavigationBarIconBrightness: theme.brightness == Brightness.dark
            ? Brightness.light
            : Brightness.dark,
        systemNavigationBarDividerColor: barColor,
      ),
      child: Column(
        children: [
          ColoredBox(
            color: barColor,
            child: SafeArea(
              bottom: false,
              child: Container(
                decoration: BoxDecoration(
                  color: barColor,
                  border: Border(bottom: BorderSide(color: theme.dividerColor)),
                ),
                child: SizedBox(
                  height: kToolbarHeight,
                  child: Row(
                    children: [
                      SizedBox(width: 12),
                      // 独立音乐端没有「主菜单/桌面」可回：删掉回主菜单按钮，
                      // 曲库/收藏等 tab 随之整体左移（主客户端保持不变）
                      if (!_isMusicApp)
                        CustomBorderedIconButton(
                          tooltip: 'app_files_back_home'.tr,
                          onTap: _openHome,
                          icon: Icons.home_outlined,
                        ),
                      Expanded(
                        child: TabBar(
                          controller: _tabController,
                          isScrollable: true,
                          tabAlignment: TabAlignment.start,
                          padding: EdgeInsets.zero,
                          dividerColor: Colors.transparent,
                          labelColor: theme.colorScheme.onSurface,
                          unselectedLabelColor:
                              theme.colorScheme.onSurfaceVariant,
                          labelStyle: theme.textTheme.titleSmall?.copyWith(
                            fontWeight: FontWeight.w700,
                          ),
                          unselectedLabelStyle: theme.textTheme.titleSmall
                              ?.copyWith(fontWeight: FontWeight.w600),
                          indicatorColor: theme.colorScheme.primary,
                          tabs: [
                            Tab(text: 'music_menu_library_songs'.tr),
                            Tab(text: 'favorites'.tr),
                            Tab(text: 'music_menu_library_history'.tr),
                            Tab(text: 'music_menu_library_albums'.tr),
                            Tab(text: 'music_menu_library_artists'.tr),
                          ],
                        ),
                      ),
                      // 独立音乐端：设置按钮左边加下载按钮（向下箭头），直达下载中心；
                      // 下载中心返回即回到本歌曲首页，不回桌面
                      if (_isMusicApp)
                        CustomBorderedIconButton(
                          icon: Icons.arrow_downward,
                          tooltip: 'home_download_center'.tr,
                          onTap: () =>
                              Get.to(() => const AppDownloadCenterView()),
                        ),
                      if (CurrentUserController.instance.isAdmin)
                        CustomBorderedIconButton(
                          tooltip: 'setting'.tr,
                          onTap: widget.onOpenSettings,
                          icon: Icons.settings_outlined,
                        ),
                      SizedBox(width: 12),
                    ],
                  ),
                ),
              ),
            ),
          ),
          Expanded(
            child: SafeArea(
              top: false,
              child: TabBarView(
                controller: _tabController,
                children: const [
                  KeyedSubtree(
                    key: ValueKey('app_music_tab_songs'),
                    child: MusicListPage(
                      listType: '',
                      initialSortBy: MusicListSortBy.title,
                      initialSortOrder: MusicListSortOrder.asc,
                    ),
                  ),
                  KeyedSubtree(
                    key: ValueKey('app_music_tab_favorite'),
                    child: MusicListPage(
                      isFavorite: true,
                      listType: '',
                      initialSortBy: MusicListSortBy.favoriteTime,
                      initialSortOrder: MusicListSortOrder.desc,
                    ),
                  ),
                  KeyedSubtree(
                    key: ValueKey('app_music_tab_history'),
                    child: _AppMusicHistoryTab(),
                  ),
                  KeyedSubtree(
                    key: ValueKey('app_music_tab_albums'),
                    child: AlbumArtistListPage(
                      keyType: 'album',
                      initialSortBy: AlbumArtistListSortBy.count,
                      initialSortOrder: AlbumArtistListSortOrder.desc,
                    ),
                  ),
                  KeyedSubtree(
                    key: ValueKey('app_music_tab_artists'),
                    child: AlbumArtistListPage(
                      keyType: 'artist',
                      initialSortBy: AlbumArtistListSortBy.count,
                      initialSortOrder: AlbumArtistListSortOrder.desc,
                    ),
                  ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _AppMusicHistoryTab extends StatefulWidget {
  const _AppMusicHistoryTab();

  @override
  State<_AppMusicHistoryTab> createState() => _AppMusicHistoryTabState();
}

class _AppMusicHistoryTabState extends State<_AppMusicHistoryTab> {
  final ScrollController _scrollController = ScrollController();
  late final String _controllerTag;
  MusicSubListController? _controller;

  @override
  void initState() {
    super.initState();
    _controllerTag = 'app_music_history_${UniqueKey()}';
    _scrollController.addListener(_onScroll);
  }

  @override
  void dispose() {
    _scrollController.removeListener(_onScroll);
    _scrollController.dispose();
    if (Get.isRegistered<MusicSubListController>(tag: _controllerTag)) {
      Get.delete<MusicSubListController>(tag: _controllerTag);
    }
    super.dispose();
  }

  void _onScroll() {
    final ctrl =
        _controller ??
        (Get.isRegistered<MusicSubListController>(tag: _controllerTag)
            ? Get.find<MusicSubListController>(tag: _controllerTag)
            : null);
    if (ctrl == null) return;
    if (!_scrollController.hasClients) return;
    ctrl.markScrolling();
    final pos = _scrollController.position;
    if (pos.maxScrollExtent <= 0) return;
    if (pos.pixels >= pos.maxScrollExtent - 360) {
      ctrl.loadMore(fromAuto: true).catchError((_) {});
    }
  }

  @override
  Widget build(BuildContext context) {
    return GetBuilder<MusicSubListController>(
      tag: _controllerTag,
      init: MusicSubListController(
        keyType: 'history',
        name: 'music_menu_library_history'.tr,
        isHistory: true,
      ),
      builder: (ctrl) {
        _controller = ctrl;
        return Column(
          children: [
            Obx(() {
              if (ctrl.items.isEmpty) return const SizedBox.shrink();
              return MusicSubListMobilePageHeader(controller: ctrl);
            }),
            Expanded(
              child: MusicSubListOverlayBody(
                controller: ctrl,
                scrollController: _scrollController,
              ),
            ),
          ],
        );
      },
    );
  }
}
