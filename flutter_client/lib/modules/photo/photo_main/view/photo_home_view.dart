import 'package:flutter/material.dart';
import 'package:get/get.dart';
import 'package:WaterNasOS/core/theme/custom_colors.dart';
import '../controller/photo_home_controller.dart';
import 'home_parts/photo_left_menu.dart';
import '../../source_setting/view/photo_source_settings_view.dart';
import '../../album/view/photo_album_list_view.dart';
import '../../collection/view/photo_collection_list_view.dart';
import '../../timeline/view/pc_photo_timeline.dart';
import '../../trash/view/photo_trash_view.dart';
import '../../smart_album/view/photo_smart_album_list_view.dart';
import '../../the_day/view/photo_the_day_view.dart';
import '../../map/view/photo_footprint_map_view.dart';
import '../../ai_setting/view/photo_ai_settings_view.dart';
import '../../ai_faces/view/ai_faces_view.dart';
import '../../ai_gps_add/view/ai_gps_add_view.dart';
import '../../ai_scenes/view/ai_scenes_view.dart';
import '../../ai_similar/view/ai_similar_view.dart';
import '../../insight/view/app_photo_insight_view.dart';
import '../../home_dashboard/view/photo_dashboard_view.dart';
import '../../recall/view/photo_memory_view.dart';
import '../../recall/view/photo_day_frame_view.dart';
import '../../recall/view/photo_tickets_view.dart';
import '../../recall/view/photo_annual_view.dart';
import '../../ai_setting/view/photo_models_view.dart';
import '../../search/view/photo_ask_overlay.dart';
import '../../preview_setting/view/photo_preview_settings_view.dart';
import '../../../folder_view/folder_view_module_type.dart';
import '../../../folder_view/view/pc_folder_view_page.dart';

class PhotoHomeView extends StatelessWidget {
  const PhotoHomeView({super.key});

  @override
  Widget build(BuildContext context) {
    return GetBuilder<PhotoHomeController>(
      init: PhotoHomeController(),
      builder: (ctrl) {
        return Obx(() {
          final collapsed = ctrl.sidebarCollapsed.value;
          final leftWidth = collapsed ? 64.0 : ctrl.leftWidth.value;

          // ⭐ 2026-10-18 右下角挂相册 AI 问答浮窗：相册里任何页面都能随手问一句
          // Row 不套 Positioned.fill：父级若给的是无界高度，Positioned.fill 会算不出尺寸。
          // 非 positioned 的 Row 按自身尺寸参与 Stack 布局，右下角浮窗照样贴边。
          return Stack(
            children: [
              Row(
                children: [
                  AnimatedContainer(
                    duration: const Duration(milliseconds: 180),
                    curve: Curves.easeOutCubic,
                    width: leftWidth,
                    child: PhotoLeftMenu(
                      controller: ctrl,
                      collapsed: collapsed,
                      onToggleCollapse: () =>
                          ctrl.sidebarCollapsed.value = !collapsed,
                    ),
                  ),
                  Expanded(child: _buildRight(ctrl)),
                ],
              ),
              const Positioned(
                right: 20,
                bottom: 20,
                child: PhotoAskOverlay(),
              ),
            ],
          );
        });
      },
    );
  }

  Widget _buildRight(PhotoHomeController ctrl) {
    return Builder(
      builder: (context) {
        final theme = Theme.of(context);
        final customColors = Theme.of(context).extension<CustomColors>();
        return ColoredBox(
          color: customColors?.mainContentBgColor ?? theme.colorScheme.surface,
          child: Obx(() {
            final key = ctrl.currentPageKey.value;
            // ⭐ 2026-10-18 相册首页（看板）：是相册的落地页，不分角色
            if (key == 'home') {
              return PhotoDashboardView(onNavigate: ctrl.selectPage);
            } else if (key == 'memory') {
              return PhotoMemoryView(onNavigate: ctrl.selectPage);
            } else if (key == 'memory.day_frame') {
              return const PhotoDayFrameView();
            } else if (key == 'tickets') {
              return const PhotoTicketsView();
            } else if (key == 'annual') {
              return PhotoAnnualView(onNavigate: ctrl.selectPage);
            } else if (key == 'settings.source') {
              return const PhotoSourceSettingsView();
            } else if (key == 'all.timeline') {
              return PcPhotoTimelineView(
                listType: 'timeline',
                key: const ValueKey('timeline'),
                alertWhenNoSourcePath: true,
                // 首页搜索栏跳过来时把关键词带进时间线（取一次就清空）
                initialSearch: ctrl.takePendingSearch(),
              );
            } else if (key == 'favorites') {
              return const PcPhotoTimelineView(
                listType: 'favorite',
                key: ValueKey('favorite'),
              );
            } else if (key == 'all.file_view') {
              return const KeyedSubtree(
                key: ValueKey('photo_folder_view'),
                child: PcFolderViewPage(moduleType: FolderViewModuleType.photo),
              );
            } else if (key == 'all.footprint') {
              return const PhotoFootprintMapView();
            } else if (key == 'recycle_bin') {
              return const PhotoTrashView();
            } else if (key == 'album.normal') {
              return const PhotoAlbumListView(type: 'all');
            } else if (key == 'album.shared') {
              return const PhotoAlbumListView(type: 'shared_to_me');
            } else if (key == 'album.collection') {
              return const PhotoCollectionListView();
            } else if (key == "album.smart") {
              return const PhotoSmartAlbumListView();
            } else if (key == "all.the_day") {
              return const PhotoTheDayView();
            } else if (key == "settings.ai") {
              return const PhotoAiSettingsView();
            } else if (key == "settings.models") {
              return const PhotoModelsView();
            } else if (key == "settings.preview") {
              return const PhotoPreviewSettingsView();
            } else if (key == "ai.face") {
              return const AiFacesView();
            } else if (key == "ai.scene") {
              return const AiScenesView();
            } else if (key == "ai.similar") {
              return const AiSimilarView();
            } else if (key == "ai.insight") {
              return const PhotoInsightView();
            } else if (key == "ai.gps_supplement") {
              return const AiGpsAddView();
            }
            return Center(child: Text('not_implemented_yet'.tr));
          }),
        );
      },
    );
  }
}
