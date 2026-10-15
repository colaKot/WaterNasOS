import 'package:WaterNasOS/core/user/current_user_controller.dart';
import 'package:flutter/material.dart';
import 'package:get/get.dart';
import '../../../../base/components/side_menu_two_level.dart';
import '../../controller/photo_home_controller.dart';

class PhotoLeftMenu extends StatelessWidget {
  final PhotoHomeController controller;
  final bool collapsed;
  final VoidCallback? onToggleCollapse;

  const PhotoLeftMenu({
    super.key,
    required this.controller,
    this.collapsed = false,
    this.onToggleCollapse,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final isAdmin = CurrentUserController.instance.isAdmin;
    final isSuperAdmin = CurrentUserController.instance.isSuperAdmin;
    final groups = <SideMenuTwoLevelGroup>[
      SideMenuTwoLevelGroup(
        title: 'photo_menu_all'.tr,
        icon: Icons.photo_library_outlined,
        expanded: controller.isAllExpanded,
        items: [
          TwoLevelSideMenuItem(
            title: 'photo_menu_all_timeline'.tr,
            key: 'all.timeline',
            icon: Icons.timeline_outlined,
          ),
          TwoLevelSideMenuItem(
            title: 'photo_menu_all_footprint'.tr,
            key: 'all.footprint',
            icon: Icons.place_outlined,
          ),
          TwoLevelSideMenuItem(
            title: 'photo_menu_all_the_day'.tr,
            key: 'all.the_day',
            icon: Icons.calendar_today,
          ),
          TwoLevelSideMenuItem(
            title: 'favorites'.tr,
            key: 'favorites',
            icon: Icons.favorite_outline,
          ),
          TwoLevelSideMenuItem(
            title: 'photo_menu_all_file_view'.tr,
            key: 'all.file_view',
            icon: Icons.folder_outlined,
          ),
          TwoLevelSideMenuItem(
            title: 'recycle_bin'.tr,
            key: 'recycle_bin',
            icon: Icons.delete_sweep_outlined,
          ),
        ],
      ),
      SideMenuTwoLevelGroup(
        title: 'photo_menu_album'.tr,
        icon: Icons.collections_bookmark_outlined,
        expanded: controller.isAlbumExpanded,
        items: [
          TwoLevelSideMenuItem(
            title: 'photo_menu_album_normal'.tr,
            key: 'album.normal',
            icon: Icons.photo_album_outlined,
          ),
          TwoLevelSideMenuItem(
            title: 'photo_menu_album_smart'.tr,
            key: 'album.smart',
            icon: Icons.auto_awesome_outlined,
          ),
          TwoLevelSideMenuItem(
            title: 'photo_menu_album_collection'.tr,
            key: 'album.collection',
            icon: Icons.collections_outlined,
          ),
        ],
      ),
      SideMenuTwoLevelGroup(
        title: 'photo_menu_ai'.tr,
        icon: Icons.auto_awesome_outlined,
        expanded: controller.isAiExpanded,
        items: [
          TwoLevelSideMenuItem(
            title: 'photo_menu_ai_face'.tr,
            key: 'ai.face',
            icon: Icons.face_retouching_natural_outlined,
          ),
          TwoLevelSideMenuItem(
            title: 'photo_menu_ai_scene'.tr,
            key: 'ai.scene',
            icon: Icons.landscape_outlined,
          ),
          if (isAdmin)
            TwoLevelSideMenuItem(
              title: 'photo_menu_ai_similar'.tr,
              key: 'ai.similar',
              icon: Icons.auto_fix_high_outlined,
            ),
          if (isAdmin)
            TwoLevelSideMenuItem(
              title: 'photo_menu_ai_gps_supplement'.tr,
              key: 'ai.gps_supplement',
              icon: Icons.gps_fixed_outlined,
            ),
        ],
      ),
      SideMenuTwoLevelGroup(
        title: 'setting'.tr,
        icon: Icons.settings_outlined,
        expanded: controller.isSettingsExpanded,
        items: [
          // ⭐ 2026-10-13：「来源设置」对所有登录用户开放（每个用户管理自己的图片来源，
          //    服务端 photo_source 按 uid 隔离）；只有「AI 设置」限超级管理员。
          TwoLevelSideMenuItem(
            title: 'settings_source'.tr,
            key: 'settings.source',
            icon: Icons.folder_special_outlined,
          ),
          // ⭐ 2026-10-13：桌面/web 端相册不放「相册备份」入口 —— 备份控制器只在
          // 原生手机端注册（main.dart: !isWeb && isMobile），露出来点进去也是空白。
          // 相册备份只保留：手机主客户端（首页监控卡）+ 相册独立 App（底部「备份」tab）。
          TwoLevelSideMenuItem(
            title: 'photo_menu_settings_preview'.tr,
            key: 'settings.preview',
            icon: Icons.photo_size_select_large_outlined,
          ),
          // ⭐ 2026-10-12：「AI 设置」大栏目只给超级管理员（用户要求，其他人不需要）
          if (isSuperAdmin)
            TwoLevelSideMenuItem(
              title: 'photo_ai_settings_title'.tr,
              key: 'settings.ai',
              icon: Icons.tag_faces_outlined,
            ),
        ],
      ),
    ];
    return TwoLevelSideMenu(
      currentKey: controller.currentPageKey,
      onSelect: controller.selectPage,
      groups: groups,
      collapsed: collapsed,
      onToggleCollapse: onToggleCollapse,
      toggleExpandTooltip: 'photo_sidebar_expand'.tr,
      toggleCollapseTooltip: 'photo_sidebar_collapse'.tr,
      headerTrailing: Obx(() {
        return Text(
          "total_count".trParams({
            'count': controller.totalCount.value.toString(),
          }),
          style: theme.textTheme.bodyMedium?.copyWith(
            color: theme.colorScheme.onSurface.withValues(alpha: 0.6),
          ),
        );
      }),
    );
  }
}
