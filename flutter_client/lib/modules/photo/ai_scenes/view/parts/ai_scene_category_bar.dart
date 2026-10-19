import 'package:flutter/material.dart';
import 'package:get/get.dart';

import '../../controller/ai_scenes_controller.dart';

/// ⭐ 2026-10-18 智能分类的「大类」条。
///
/// 原来几十个细场景平铺在一起（室内游泳池 / 食物特写 / 幼儿园教室…），
/// 用户根本不知道从哪看起。这里在顶部加一层大类：先选「出行 / 美食 / 自然」，
/// 再在里面看具体场景。大类映射由服务端 `photoCategoryUtil` 给，和年度总结共用一份规则。
///
/// 只渲染「这个库真的有」的大类（计数为 0 的不占位置），避免一排灰按钮。
class AiSceneCategoryBar extends StatelessWidget {
  final AiScenesController controller;

  const AiSceneCategoryBar({super.key, required this.controller});

  /// 展示顺序：常用的排前面；'other' 永远最后
  static const List<String> _order = [
    'all',
    'travel',
    'stay',
    'food',
    'nature',
    'architecture',
    'sport',
    'pet',
    'people',
    'work',
    'other',
  ];

  String _labelOf(String key) {
    if (key == 'all') return 'all'.tr;
    if (key == 'other') return 'photo_cat_other'.tr;
    return 'photo_annual_cat_$key'.tr;
  }

  @override
  Widget build(BuildContext context) {
    // Obx 而不是外层 GetBuilder：切换大类只改 categoryFilter（不改 items 的话
    // GetBuilder 不会收到 update），用 Obx 才能让选中态和角标跟着变。
    return Obx(() => _buildBar(context));
  }

  Widget _buildBar(BuildContext context) {
    final theme = Theme.of(context);
    final counts = controller.categoryCounts;
    final visible = <String>[
      for (final k in _order)
        if (k == 'all' || (counts[k] ?? 0) > 0) k,
    ];
    // 只有一个「全部」时整条不显示，别占一行空白
    if (visible.length <= 1) return const SizedBox.shrink();

    return Container(
      height: 48,
      alignment: Alignment.centerLeft,
      child: ListView.separated(
        scrollDirection: Axis.horizontal,
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
        itemCount: visible.length,
        separatorBuilder: (_, _) => const SizedBox(width: 8),
        itemBuilder: (context, i) {
          final key = visible[i];
          final selected = controller.categoryFilter.value == key;
          return InkWell(
            onTap: () => controller.setCategoryFilter(key),
            borderRadius: BorderRadius.circular(18),
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
              decoration: BoxDecoration(
                color: selected
                    ? theme.colorScheme.primary.withValues(alpha: 0.10)
                    : Colors.transparent,
                borderRadius: BorderRadius.circular(18),
                border: Border.all(
                  color: selected
                      ? theme.colorScheme.primary.withValues(alpha: 0.38)
                      : theme.colorScheme.outlineVariant.withValues(alpha: 0.5),
                ),
              ),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(
                    _labelOf(key),
                    style: theme.textTheme.bodySmall?.copyWith(
                      color: selected
                          ? theme.colorScheme.primary
                          : theme.colorScheme.onSurface,
                      fontWeight:
                          selected ? FontWeight.w600 : FontWeight.w400,
                    ),
                  ),
                  const SizedBox(width: 5),
                  Text(
                    '${counts[key] ?? 0}',
                    style: theme.textTheme.labelSmall?.copyWith(
                      color: theme.colorScheme.onSurfaceVariant,
                    ),
                  ),
                ],
              ),
            ),
          );
        },
      ),
    );
  }
}
