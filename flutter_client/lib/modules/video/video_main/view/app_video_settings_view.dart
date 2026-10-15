import 'package:WaterNasOS/core/theme/custom_colors.dart';
import 'package:WaterNasOS/core/user/current_user_controller.dart';
import 'package:WaterNasOS/modules/video/library_setting/view/video_library_settings_view.dart';
import 'package:WaterNasOS/modules/video/other_setting/view/video_other_settings_view.dart';
import 'package:WaterNasOS/modules/video/source_setting/view/video_source_settings_view.dart';
import 'package:flutter/material.dart';
import 'package:get/get.dart';

class AppVideoSettingsView extends StatelessWidget {
  const AppVideoSettingsView({super.key});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final customColors = theme.extension<CustomColors>();

    // ⭐ 2026-10-12 权限隔离：影视库管理 / 来源设置 / 转码 / 刮削 / 字幕提取
    // 这些都只有管理员能碰（服务端那几个接口也挂了 requireAdmin）。
    // 普通用户进来只给一个「播放设置」——那是他自己的偏好，且按端隔离。
    if (!CurrentUserController.instance.isSuperAdmin) {
      return ColoredBox(
        color: customColors?.mainContentBgColor ?? theme.colorScheme.surface,
        child: const VideoOtherSettingsView(onlyPlayback: true),
      );
    }

    return DefaultTabController(
      length: 3,
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
                  tabs: [
                    Tab(text: 'video_library_manage_title'.tr),
                    Tab(text: 'settings_source'.tr),
                    Tab(text: 'video_other_settings_title'.tr),
                  ],
                ),
              ),
            ),
            const Expanded(
              child: TabBarView(
                children: [
                  KeyedSubtree(
                    key: ValueKey('app_video_settings_library'),
                    child: VideoLibrarySettingsView(),
                  ),
                  KeyedSubtree(
                    key: ValueKey('app_video_settings_source'),
                    child: VideoSourceSettingsView(),
                  ),
                  KeyedSubtree(
                    key: ValueKey('app_video_settings_other'),
                    child: VideoOtherSettingsView(),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}
