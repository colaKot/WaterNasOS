import 'package:flutter/material.dart';
import 'package:get/get.dart';
import 'package:flutter/services.dart';
import '../../../../core/user/current_user_controller.dart';
import '../../ai_setting/view/photo_ai_settings_view.dart';
import '../../preview_setting/view/photo_preview_settings_view.dart';
import '../../source_setting/view/photo_source_settings_view.dart';

class AppPhotoSettingsView extends StatelessWidget {
  final int initialTabIndex;
  const AppPhotoSettingsView({super.key, this.initialTabIndex = 0});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final barColor = theme.colorScheme.surface;

    // ⭐ 2026-10-13：「来源设置 / 预览设置」对所有登录用户开放（每个用户管理自己的
    //    图片来源与预览偏好，服务端按 uid 隔离）；只有「AI 设置」给超级管理员
    //    （2026-10-12 用户要求）。因此不再按 isAdmin 分叉，只按 isSuperAdmin 决定 AI tab。
    final isSuperAdmin = CurrentUserController.instance.isSuperAdmin;

    // AI 设置 tab 只对超管出现 —— 用可变列表而不是 const，避免
    // length 与 children 数量对不上（TabController 会直接抛异常）。
    final tabViews = <Widget>[
      const PhotoSourceSettingsView(),
      const PhotoPreviewSettingsView(),
      if (isSuperAdmin) const PhotoAiSettingsView(),
    ];
    final tabItems = <Widget>[
      Tab(
        icon: const Icon(Icons.folder_outlined),
        text: 'settings_source'.tr,
      ),
      Tab(
        icon: const Icon(Icons.tune_outlined),
        text: 'photo_preview_settings_title'.tr,
      ),
      if (isSuperAdmin)
        Tab(
          icon: const Icon(Icons.auto_awesome_outlined),
          text: 'photo_ai_settings_title'.tr,
        ),
    ];

    return DefaultTabController(
      length: tabViews.length,
      initialIndex: initialTabIndex.clamp(0, tabViews.length - 1),
      child: Scaffold(
        appBar: AppBar(title: Text('setting'.tr)),
        body: AnnotatedRegion<SystemUiOverlayStyle>(
          value: SystemUiOverlayStyle(
            statusBarColor: barColor,
            statusBarIconBrightness: Brightness.dark,
            statusBarBrightness: Brightness.light,
            systemNavigationBarColor: barColor,
            systemNavigationBarIconBrightness: Brightness.dark,
            systemNavigationBarDividerColor: barColor,
          ),
          child: TabBarView(children: tabViews),
        ),
        bottomNavigationBar: Container(
          color: barColor,
          child: SafeArea(
            top: false,
            child: TabBar(
              dividerColor: Colors.transparent,
              labelColor: theme.colorScheme.primary,
              unselectedLabelColor: theme.colorScheme.onSurfaceVariant,
              indicatorColor: theme.colorScheme.primary,
              tabs: tabItems,
            ),
          ),
        ),
      ),
    );
  }
}
