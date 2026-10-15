import 'package:flutter/material.dart';
import 'package:get/get.dart';
import '../../../../base/components/custom_hover_select_menu.dart';
import '../../../../base/components/custom_bordered_icon_button.dart';
import '../../../../base/components/custom_expandable_search_bar.dart';
import '../../../../home/views/pc_components/pc_app_window.dart';
import '../../../../../core/user/current_user_controller.dart';
import '../../controller/ai_scenes_controller.dart';

/// 语义搜索结果提示条：把「已识别：日落 · 海滩」和「未识别：xx」摊开给用户看。
///
/// ⭐ 为什么必须显示：语义搜索是「猜」的，用户看不到猜的过程就没法判断
/// 结果为什么是这样；把解析结果亮出来，搜不到时才知道该换个说法还是真没有。
class AiScenesSearchSummary extends StatelessWidget {
  final AiScenesController controller;
  const AiScenesSearchSummary({super.key, required this.controller});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Obx(() {
      if (controller.keyword.value.trim().isEmpty) return const SizedBox.shrink();
      final tags = controller.searchTags;
      final unmatched = controller.searchUnmatched;
      final searching = controller.isSearching.value;
      if (!searching && tags.isEmpty && unmatched.isEmpty) {
        return const SizedBox.shrink();
      }

      final rows = <Widget>[];
      if (searching) {
        rows.add(
          SizedBox(
            width: 12,
            height: 12,
            child: CircularProgressIndicator(
              strokeWidth: 1.6,
              color: theme.colorScheme.primary,
            ),
          ),
        );
        rows.add(const SizedBox(width: 6));
      } else {
        rows.add(
          Icon(
            controller.searchSemantic.value
                ? Icons.auto_awesome
                : Icons.search_outlined,
            size: 13,
            color: theme.colorScheme.primary,
          ),
        );
        rows.add(const SizedBox(width: 4));
      }

      if (tags.isNotEmpty) {
        rows.add(
          Text(
            '${'scene_search_recognized'.tr}：${tags.join(' · ')}',
            style: theme.textTheme.bodySmall?.copyWith(
              color: theme.colorScheme.onSurface.withValues(alpha: 0.85),
              fontWeight: FontWeight.w500,
            ),
          ),
        );
      } else if (!searching) {
        rows.add(
          Text(
            'scene_search_no_result'.tr,
            style: theme.textTheme.bodySmall?.copyWith(
              color: theme.colorScheme.onSurface.withValues(alpha: 0.6),
            ),
          ),
        );
      }

      if (unmatched.isNotEmpty && !searching) {
        rows.add(const SizedBox(width: 8));
        rows.add(
          Flexible(
            child: Text(
              '${'scene_search_unmatched'.tr}：${unmatched.join(' ')}',
              overflow: TextOverflow.ellipsis,
              style: theme.textTheme.bodySmall?.copyWith(
                color: theme.colorScheme.onSurface.withValues(alpha: 0.45),
              ),
            ),
          ),
        );
      }

      return Container(
        width: double.infinity,
        margin: const EdgeInsets.fromLTRB(16, 0, 16, 8),
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
        decoration: BoxDecoration(
          color: theme.colorScheme.primary.withValues(alpha: 0.07),
          borderRadius: BorderRadius.circular(8),
        ),
        child: Row(children: rows),
      );
    });
  }
}

class AiScenesTopBar extends StatelessWidget {
  final AiScenesController controller;
  const AiScenesTopBar({super.key, required this.controller});

  @override
  Widget build(BuildContext context) {
    final isAdmin = CurrentUserController.instance.isAdmin;
    // ⭐ 右侧给窗口按钮组让位（2026-10-09）：刷新/搜索按钮贴最右
    final ctrlW = PcWindowScope.of(context)?.titleBarControlsWidth ?? 0;
    return Container(
      padding: EdgeInsets.fromLTRB(16, 12, 16 + ctrlW, 12),
      child: LayoutBuilder(
        builder: (context, constraints) {
          final filter = Obx(() {
            final v = controller.statusFilter.value;
            return CustomHoverSelectMenu<String>(
              value: v,
              height: 44,
              buttonIcon: Icons.filter_alt_outlined,
              items: [
                CustomHoverSelectMenuItem(
                  value: 'visiable',
                  label: 'face_filter_visible'.tr,
                  icon: Icons.visibility,
                ),
                CustomHoverSelectMenuItem(
                  value: 'hide',
                  label: 'face_filter_hidden'.tr,
                  icon: Icons.visibility_off,
                ),
                CustomHoverSelectMenuItem(
                  value: 'all',
                  label: 'all'.tr,
                  icon: Icons.filter_alt_outlined,
                ),
              ],
              onSelected: controller.setStatusFilter,
            );
          });

          return Row(
            children: [
              filter,
              const Spacer(),
              if (isAdmin)
                CustomBorderedIconButton(
                  icon: Icons.clear_all,
                  tooltip: 'reset'.tr,
                  onTap: controller.confirmAndResetScenes,
                ),
              const SizedBox(width: 6),
              CustomBorderedIconButton(
                icon: Icons.refresh,
                tooltip: 'refresh'.tr,
                onTap: controller.refreshScenes,
              ),
              const SizedBox(width: 6),
              CustomExpandableSearchBar(
                controller: controller.searchController,
                hintText: 'scene_search_hint'.tr,
                onChanged: controller.updateKeyword,
                onClear: controller.clearKeyword,
              ),
            ],
          );
        },
      ),
    );
  }
}
