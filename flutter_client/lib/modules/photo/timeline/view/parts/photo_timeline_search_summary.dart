import 'package:flutter/material.dart';
import 'package:get/get.dart';

import '../../controller/photo_timeline_controller.dart';
import '../../models/photo_timeline_model.dart';

/// ⭐ 2026-10-16 P0-1：时间轴搜索的语义提示条。
///
/// 服务端**早就**在用 placesQuery 把「夕阳下的沙滩」解析成「日落 + 海滩」再检索
/// （photoTimeLineService.buildBaseQuery），还按命中标签数重排；
/// 但客户端一直没把它显示出来 —— 用户只看到「列表变了」，搜不到时也不知道
/// 该换个说法还是库里真的没有。
///
/// 这里把「已识别 / 未识别 / 命中的活动」摊开，话术复用 AI 场景页
/// （AiScenesSearchSummary）的 `scene_search_*` 键，语义上保持一致。
///
/// 无搜索词、或还没有任何解析结果时返回 0 高度，不占用原有布局。
class PhotoTimelineSearchSummary extends StatelessWidget {
  final PhotoTimelineController controller;

  const PhotoTimelineSearchSummary({super.key, required this.controller});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Obx(() {
      if (controller.searchKeyword.value.trim().isEmpty) {
        return const SizedBox.shrink();
      }
      final tags = controller.searchTags.toList();
      final activityNames =
          controller.searchActivities.map((e) => e.actName).toList();
      final unmatched = controller.searchUnmatched.toList();
      final parsing = controller.searchParsing.value;

      // 场景标签与活动标签合并展示：对用户而言都是「我猜你想找的东西」，
      // 分成两行反而要先解释「场景」和「活动」的区别。
      final recognized = <String>[...tags, ...activityNames];
      if (!parsing && recognized.isEmpty && unmatched.isEmpty) {
        return const SizedBox.shrink();
      }

      final chips = <Widget>[];
      if (parsing) {
        chips.add(
          SizedBox(
            width: 11,
            height: 11,
            child: CircularProgressIndicator(
              strokeWidth: 1.5,
              color: theme.colorScheme.primary,
            ),
          ),
        );
        chips.add(const SizedBox(width: 6));
      } else {
        chips.add(
          Icon(
            controller.searchSemantic.value
                ? Icons.auto_awesome
                : Icons.search_outlined,
            size: 13,
            color: theme.colorScheme.primary,
          ),
        );
        chips.add(const SizedBox(width: 4));
      }

      final textStyle = theme.textTheme.bodySmall?.copyWith(
        color: theme.colorScheme.onSurfaceVariant,
      );

      if (recognized.isNotEmpty) {
        chips.add(
          Text(
            '${'scene_search_recognized'.tr}：${recognized.join(' · ')}',
            style: textStyle,
            maxLines: 2,
            overflow: TextOverflow.ellipsis,
          ),
        );
      }
      if (unmatched.isNotEmpty) {
        if (recognized.isNotEmpty) {
          chips.add(Padding(
            padding: const EdgeInsets.symmetric(horizontal: 6),
            child: Text('|', style: textStyle),
          ));
        }
        chips.add(
          Text(
            '${'scene_search_unmatched'.tr}：${unmatched.join(' · ')}',
            style: textStyle?.copyWith(
              color: theme.colorScheme.onSurfaceVariant.withValues(alpha: 0.7),
            ),
            maxLines: 2,
            overflow: TextOverflow.ellipsis,
          ),
        );
      }

      final suggestions = controller.searchSuggestions.toList();

      return Container(
        width: double.infinity,
        padding: const EdgeInsets.fromLTRB(10, 4, 10, 5),
        color: theme.colorScheme.surfaceContainerHighest.withValues(alpha: 0.35),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: [
            if (chips.isNotEmpty)
              Wrap(
                crossAxisAlignment: WrapCrossAlignment.center,
                spacing: 0,
                runSpacing: 2,
                children: chips,
              ),
            // ⭐ 2026-10-16 P0-4：联想建议 chip —— 点一下就把该词写进搜索框并立即检索。
            if (suggestions.isNotEmpty) ...[
              if (chips.isNotEmpty) const SizedBox(height: 3),
              Wrap(
                spacing: 6,
                runSpacing: 4,
                children: [
                  for (final s in suggestions)
                    _SuggestionChip(
                      suggestion: s,
                      onTap: () => controller.applySearchKeyword(s.label),
                    ),
                ],
              ),
            ],
          ],
        ),
      );
    });
  }
}

/// 联想建议 chip：图标按类型区分，右侧带该词在**本人可见范围**内的张数。
class _SuggestionChip extends StatelessWidget {
  final PhotoSearchSuggestion suggestion;
  final VoidCallback onTap;

  const _SuggestionChip({required this.suggestion, required this.onTap});

  IconData get _icon {
    switch (suggestion.type) {
      case 'person':
        return Icons.person_outline;
      case 'activity':
        return Icons.directions_run;
      case 'camera':
        return Icons.photo_camera_outlined;
      case 'filename':
        return Icons.insert_drive_file_outlined;
      case 'ocr':
        return Icons.text_fields;
      case 'year':
        return Icons.event_outlined;
      default:
        return Icons.image_outlined;
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(11),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
        decoration: BoxDecoration(
          color: theme.colorScheme.surfaceContainerHighest.withValues(alpha: 0.5),
          borderRadius: BorderRadius.circular(11),
          border: Border.all(
            color: theme.colorScheme.outlineVariant.withValues(alpha: 0.6),
          ),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(_icon, size: 12, color: theme.colorScheme.primary),
            const SizedBox(width: 4),
            Text(
              suggestion.label,
              style: theme.textTheme.bodySmall,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
            ),
            if (suggestion.count > 0) ...[
              const SizedBox(width: 4),
              Text(
                '${suggestion.count}',
                style: theme.textTheme.labelSmall?.copyWith(
                  color: theme.colorScheme.onSurfaceVariant,
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }
}
