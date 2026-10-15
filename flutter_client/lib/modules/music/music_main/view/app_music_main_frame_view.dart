import 'package:WaterNasOS/core/theme/custom_colors.dart';
import 'package:WaterNasOS/core/bootstrap/app_launch.dart';
import 'package:WaterNasOS/core/user/current_user_controller.dart';
import 'package:WaterNasOS/modules/folder_view/folder_view_module_type.dart';
import 'package:WaterNasOS/modules/folder_view/view/app_folder_view_page.dart';
import 'package:WaterNasOS/modules/music/cache_setting/view/music_cache_settings_view.dart';
import 'package:WaterNasOS/modules/music/collection/view/music_collection_list_view.dart';
import 'package:WaterNasOS/modules/music/play_service/app_components/app_music_play_ctrl_floating_bar.dart';
import 'package:WaterNasOS/modules/music/music_main/view/app_music_main_view.dart';
import 'package:WaterNasOS/modules/music/play_service/play_ctrl_fullscreen/music_play_ctrl_fullscreen_sheet.dart';
import 'package:WaterNasOS/modules/music/playlist/view/play_list_list_view.dart';
import 'package:WaterNasOS/modules/music/source_setting/view/music_source_settings_view.dart';
import 'package:WaterNasOS/utils/device_utils.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:get/get.dart';

class AppMusicMainFrameView extends StatefulWidget {
  const AppMusicMainFrameView({super.key});

  @override
  State<AppMusicMainFrameView> createState() => _AppMusicMainFrameViewState();
}

class _AppMusicMainFrameViewState extends State<AppMusicMainFrameView> {
  int _tabIndex = 0;
  bool _showFullPlayer = false;

  /// 独立音乐 App（music_client）模式：本文件的音乐端专属改动只在此模式下生效，
  /// 主客户端（AppLaunchMode.full）行为一字不变。
  bool get _isMusicApp => AppLaunch.mode == AppLaunchMode.music;

  void _openSettings() {
    Get.to(
      () => Scaffold(
        appBar: AppBar(title: Text('setting'.tr)),
        body: const _AppMusicSettingsTab(),
      ),
      preventDuplicates: false,
    );
  }

  Widget _buildTabBody() {
    if (_tabIndex == 0) {
      return AppMusicMainView(onOpenSettings: _openSettings);
    }
    if (_tabIndex == 1) {
      return const KeyedSubtree(
        key: ValueKey('app_music_playlists'),
        child: PlayListListView(),
      );
    }
    if (_tabIndex == 2) {
      return const KeyedSubtree(
        key: ValueKey('app_music_collections'),
        child: MusicCollectionListView(),
      );
    }
    if (_tabIndex == 3) {
      return const KeyedSubtree(
        key: ValueKey('app_music_file_view'),
        child: AppFolderViewPage(moduleType: FolderViewModuleType.music),
      );
    }
    return Center(child: Text('not_implemented_yet'.tr));
  }

  bool _tabNeedsOwnStatusBar() => _tabIndex == 1 || _tabIndex == 2;

  void _openFullscreen() {
    if (_showFullPlayer) return;
    setState(() => _showFullPlayer = true);
  }

  void _closeFullscreen() {
    if (!_showFullPlayer) return;
    setState(() => _showFullPlayer = false);
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final customColors = theme.extension<CustomColors>();
    final barColor =
        customColors?.oprationBarBgColor ?? theme.colorScheme.surface;

    final Widget content = _showFullPlayer
        ? Scaffold(
            backgroundColor: theme.scaffoldBackgroundColor,
            body: MusicPlayCtrlFullScreenSheet(onClose: _closeFullscreen),
          )
        : _buildMainScaffold(theme: theme, barColor: barColor);

    // 独立音乐端：体系内没有「桌面」可回，系统返回一律在音乐端内部消化
    // （全屏播放器先关播放器 -> 非首页 tab 先回首页 tab -> 首页 tab 退出应用），
    // 绝不回桌面。主客户端维持原逻辑（pop 回桌面）。
    if (!_isMusicApp) return content;
    return PopScope(
      canPop: false,
      onPopInvoked: (didPop) {
        if (didPop) return;
        if (_showFullPlayer) {
          _closeFullscreen();
          return;
        }
        if (_tabIndex != 0) {
          setState(() => _tabIndex = 0);
          return;
        }
        // 歌曲首页再返回：退出应用（而不是露出下面的桌面）
        SystemNavigator.pop();
      },
      child: content,
    );
  }

  Widget _buildMainScaffold({
    required ThemeData theme,
    required Color barColor,
  }) {
    final floatingBottom = 5.0;

    return Scaffold(
      backgroundColor: theme.scaffoldBackgroundColor,
      body: Stack(
        children: [
          Positioned.fill(
            child: _tabIndex == 0 || _tabNeedsOwnStatusBar()
                ? _buildTabBody()
                : SafeArea(top: true, bottom: false, child: _buildTabBody()),
          ),
          Positioned(
            left: 12,
            right: 12,
            bottom: floatingBottom,
            child: AppMusicPlayCtrlFloatingBar(
              onOpenFullscreen: _openFullscreen,
            ),
          ),
        ],
      ),
      bottomNavigationBar: ColoredBox(
        color: barColor,
        child: SafeArea(
          top: false,
          child: BottomNavigationBar(
            backgroundColor: barColor,
            elevation: 0,
            currentIndex: _tabIndex,
            onTap: (i) {
              if (i == _tabIndex) return;
              setState(() => _tabIndex = i);
            },
            selectedItemColor: theme.colorScheme.primary,
            unselectedItemColor: theme.colorScheme.onSurfaceVariant,
            type: BottomNavigationBarType.fixed,
            items: [
              BottomNavigationBarItem(
                icon: const Icon(Icons.home_outlined),
                label: 'home'.tr,
              ),
              BottomNavigationBarItem(
                icon: const Icon(Icons.queue_music_outlined),
                label: 'music_menu_library_playlists'.tr,
              ),
              BottomNavigationBarItem(
                icon: const Icon(Icons.collections_bookmark_outlined),
                label: 'music_collection_title'.tr,
              ),
              BottomNavigationBarItem(
                icon: const Icon(Icons.folder_outlined),
                label: 'file'.tr,
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _AppMusicSettingsTab extends StatelessWidget {
  const _AppMusicSettingsTab();

  @override
  Widget build(BuildContext context) {
    final isAdmin = CurrentUserController.instance.isAdmin;
    final theme = Theme.of(context);
    final customColors = theme.extension<CustomColors>();

    if (!isAdmin) {
      if (!DeviceUtils.isWeb) {
        return ColoredBox(
          color: customColors?.mainContentBgColor ?? theme.colorScheme.surface,
          child: SafeArea(
            bottom: false,
            child: const KeyedSubtree(
              key: ValueKey('app_music_settings_cache'),
              child: MusicCacheSettingsView(),
            ),
          ),
        );
      }
      return Center(child: Text('not_implemented_yet'.tr));
    }

    final tabs = <Widget>[];
    final tabViews = <Widget>[];

    tabs.add(Tab(text: 'settings_source'.tr));
    tabViews.add(
      const KeyedSubtree(
        key: ValueKey('app_music_settings_source'),
        child: MusicSourceSettingsView(),
      ),
    );

    if (!DeviceUtils.isWeb) {
      tabs.add(Tab(text: 'music_menu_settings_cache'.tr));
      tabViews.add(
        const KeyedSubtree(
          key: ValueKey('app_music_settings_cache'),
          child: MusicCacheSettingsView(),
        ),
      );
    }

    if (tabs.isEmpty) {
      return Center(child: Text('not_implemented_yet'.tr));
    }

    return DefaultTabController(
      length: tabs.length,
      child: ColoredBox(
        color: customColors?.mainContentBgColor ?? theme.colorScheme.surface,
        child: Column(
          children: [
            SafeArea(
              bottom: false,
              child: Padding(
                padding: const EdgeInsets.fromLTRB(16, 8, 16, 0),
                child: TabBar(
                  dividerColor: Colors.transparent,
                  labelStyle: theme.textTheme.titleSmall?.copyWith(
                    fontWeight: FontWeight.w700,
                  ),
                  tabs: tabs,
                ),
              ),
            ),
            Expanded(child: TabBarView(children: tabViews)),
          ],
        ),
      ),
    );
  }
}
