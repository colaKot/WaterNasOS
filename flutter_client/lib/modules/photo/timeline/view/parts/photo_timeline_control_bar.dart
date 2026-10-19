import '../../../../home/views/pc_components/pc_app_window.dart';
import 'package:flutter/material.dart';
import 'package:get/get.dart';
import '../../../../base/components/custom_bordered_icon_button.dart';
import '../../controller/photo_timeline_controller.dart';
import '../../../search/view/photo_search_overlay.dart';
import '../../../../base/components/custom_popup_select_button.dart';
import '../../../../base/components/custom_segmented_icon_toggle.dart';
import '../../../../../utils/popup_menu_util.dart';

class PhotoTimelineControlBar extends GetView<PhotoTimelineController> {
  final String? controllerTag;
  PhotoTimelineControlBar({super.key, this.controllerTag});

  @override
  String? get tag => controllerTag;

  final _pathFilterKey = GlobalKey();

  /// 类型开关的三段下标映射。
  /// `livephoto`（实况）不在开关里，归到「全部」那一段显示，避免开关没有选中项。
  static int _fileTypeIndex(String value) {
    switch (value) {
      case 'photo':
        return 1;
      case 'video':
        return 2;
      default:
        return 0;
    }
  }

  @override
  Widget build(BuildContext context) {
    // ⭐ 右侧给窗口按钮组让位（2026-10-09）。搜索栏被Expanded/Align 推到最右，
    // 不让位会被窗口按钮压住。
    final ctrlW = PcWindowScope.of(context)?.titleBarControlsWidth ?? 0;
    return Container(
      height: 48,
      padding: EdgeInsets.fromLTRB(16, 0, 16 + ctrlW, 0),
      child: Row(
        children: [
          // ⭐ 2026-10-16：原来的「类型」下拉（全部/照片/视频/实况）与右侧新增的三段开关
          // 语义重复，这里收成一个独立的「实况」开关按钮 —— 能力保留，控件不重复。
          Obx(
            () {
              final liveSelected = controller.fileType.value == 'livephoto';
              return CustomBorderedIconButton(
                tooltip: 'timeline_live_photos'.tr,
                icon: Icons.motion_photos_on_outlined,
                active: liveSelected,
                onTap: () => controller.setFileType(
                  liveSelected ? 'all' : 'livephoto',
                ),
              );
            },
          ),

          Obx(() {
            if (controller.baseGeohash.value.isEmpty) {
              return const SizedBox(width: 0);
            }
            return Padding(
              padding: const EdgeInsets.only(left: 4),
              child: CustomPopupSelectButton<int>(
                tooltip: 'distance'.tr,
                icon: Icons.place_outlined,
                value: controller.nearbyRangeKm.value,
                defaultValue: 2,
                items: const [
                  CustomPopupSelectItem(value: 2, label: '2km'),
                  CustomPopupSelectItem(value: 5, label: '5km'),
                  CustomPopupSelectItem(value: 10, label: '10km'),
                  CustomPopupSelectItem(value: 50, label: '50km'),
                  CustomPopupSelectItem(value: 80, label: '80km'),
                ],
                onSelected: controller.setNearbyRangeKm,
              ),
            );
          }),
          // 来源文件夹筛选按钮
          Padding(
            key: _pathFilterKey,
            padding: const EdgeInsets.only(left: 4, right: 4),
            child: Obx(
              () => CustomBorderedIconButton(
                tooltip: 'timeline_path_filter'.tr,
                icon: Icons.source_outlined,
                active: controller.selectedPaths.isNotEmpty,
                onTap: () {
                  PopupMenuUtil.showBelowButton<void>(
                    context: context,
                    buttonKey: _pathFilterKey,
                    items: [
                      PopupMenuItem(
                        enabled: false,
                        padding: EdgeInsets.zero,
                        child: Container(
                          width: 350,
                          constraints: const BoxConstraints(maxHeight: 500),
                          child: Column(
                            mainAxisSize: MainAxisSize.min,
                            children: [
                              Padding(
                                padding: const EdgeInsets.symmetric(
                                  horizontal: 16,
                                  vertical: 12,
                                ),
                                child: Row(
                                  mainAxisAlignment:
                                      MainAxisAlignment.spaceBetween,
                                  children: [
                                    Text(
                                      'timeline_path_filter'.tr,
                                      style: Get.textTheme.titleSmall,
                                    ),
                                    TextButton(
                                      onPressed: () {
                                        controller.clearSourcePathSelection();
                                        Navigator.of(context).pop();
                                      },
                                      child: Text('reset'.tr),
                                    ),
                                  ],
                                ),
                              ),
                              const Divider(height: 1),
                              Flexible(
                                child: Obx(() {
                                  if (controller.availablePaths.isEmpty) {
                                    return Padding(
                                      padding: EdgeInsets.all(20),
                                      child: Text('no_path'.tr),
                                    );
                                  }
                                  return ListView.builder(
                                    shrinkWrap: true,
                                    itemCount: controller.availablePaths.length,
                                    itemBuilder: (ctx, index) {
                                      final item =
                                          controller.availablePaths[index];
                                      final path = item.path;
                                      return Obx(() {
                                        final isSelected = controller
                                            .selectedPaths
                                            .contains(path);
                                        return CheckboxListTile(
                                          contentPadding:
                                              const EdgeInsets.symmetric(
                                                horizontal: 12,
                                              ),
                                          dense: true,
                                          controlAffinity:
                                              ListTileControlAffinity.leading,
                                          title: Row(
                                            children: [
                                              Expanded(
                                                child: Text(
                                                  path,
                                                  style:
                                                      Get.textTheme.bodySmall,
                                                ),
                                              ),
                                              if (item.valid)
                                                const Icon(
                                                  Icons.check_circle,
                                                  color: Colors.green,
                                                  size: 16,
                                                )
                                              else
                                                const Icon(
                                                  Icons.cancel,
                                                  color: Colors.red,
                                                  size: 16,
                                                ),
                                            ],
                                          ),
                                          value: isSelected,
                                          onChanged: (val) {
                                            controller.setSourcePathSelected(
                                              path,
                                              val == true,
                                            );
                                          },
                                        );
                                      });
                                    },
                                  );
                                }),
                              ),
                            ],
                          ),
                        ),
                      ),
                    ],
                  );
                },
              ),
            ),
          ),
          // const SizedBox(width: 10),
          Padding(
            padding: const EdgeInsets.only(right: 4),
            child: Obx(
              () => CustomBorderedIconButton(
                icon: controller.sortOrder.value == 'desc'
                    ? Icons.rotate_left
                    : Icons.rotate_right,
                onTap: controller.toggleSortOrder,
              ),
            ),
          ),
          Padding(
            padding: const EdgeInsets.only(right: 4),
            child: Obx(() {
              final isMin = controller.itemSize.value <= controller.minItemSize;
              return CustomBorderedIconButton(
                icon: Icons.zoom_out,
                enabled: !isMin,
                onTap: () => controller.changeItemSize(-60),
              );
            }),
          ),
          Padding(
            padding: const EdgeInsets.only(right: 4),
            child: Obx(() {
              final isMax = controller.itemSize.value >= controller.maxItemSize;
              return CustomBorderedIconButton(
                icon: Icons.zoom_in,
                enabled: !isMax,
                onTap: () => controller.changeItemSize(60),
              );
            }),
          ),
          Obx(
            () => CustomBorderedIconButton(
              tooltip: 'zoom_mode'.tr,
              icon: controller.isCoverMode.value ? Icons.crop : Icons.grid_view,
              onTap: controller.toggleCoverMode,
            ),
          ),
          // ⭐ 2026-10-16 新增：三选一类型开关（全部 / 图片 / 视频）。
          // 造型与影视列表的「封面图 / 缩略图」开关同族（CustomSegmentedIconToggleN）。
          // 直接复用既有多语言键 all / timeline_photos / timeline_videos，无需新增词条。
          Padding(
            padding: const EdgeInsets.only(left: 4),
            child: Obx(
              () => CustomSegmentedIconToggleN(
                items: [
                  CustomSegmentedToggleItem(
                    icon: Icons.select_all,
                    tooltip: 'all'.tr,
                  ),
                  CustomSegmentedToggleItem(
                    icon: Icons.image_outlined,
                    tooltip: 'timeline_photos'.tr,
                  ),
                  CustomSegmentedToggleItem(
                    icon: Icons.videocam_outlined,
                    tooltip: 'timeline_videos'.tr,
                  ),
                ],
                selectedIndex: _fileTypeIndex(controller.fileType.value),
                onChanged: (i) =>
                    controller.setFileType(const ['all', 'photo', 'video'][i]),
              ),
            ),
          ),

          ///
          Expanded(
            child: Align(
              alignment: Alignment.centerRight,
              child: ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 200),
                child: SizedBox(
                  width: double.infinity,
                  // ⭐ 2026-10-18 \u6362\u6210\u641c\u7d22\u6d6e\u5c42\u5165\u53e3\uff08\u63a8\u8350\u8bcd + \u8054\u60f3 + \u6700\u8fd1\u641c\u7d22\uff09
                  child: PhotoSearchEntry(
                    hintText: 'search'.tr,
                    onSubmit: (q) {
                      controller.searchController.text = q;
                      controller.onSearchChanged(q);
                    },
                  ),
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}
