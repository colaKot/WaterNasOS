import 'package:flutter/material.dart';
import 'package:get/get.dart';
import 'package:WaterNasOS/core/api/api_controller.dart';
import 'package:WaterNasOS/core/theme/custom_colors.dart';
import 'package:WaterNasOS/modules/base/components/custom_extended_image.dart';
import 'package:WaterNasOS/modules/photo/shared/photo_viewer_helper.dart';

import '../controller/photo_day_frame_controller.dart';

/// ⭐ 2026-10-19 每日一帧（独立页面，网格版）。
///
/// 从「智能发现」里拆出来：那一版是一行一张的列表（44px 缩略图 + 一行字），
/// 看成片几乎没有价值。这里换成大图网格 —— 一帧一格，图占满格子，
/// 日期与当天的标签压在底部渐变上，右上角标当天张数。
class PhotoDayFrameView extends StatelessWidget {
  const PhotoDayFrameView({super.key});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final customColors = theme.extension<CustomColors>();
    return GetBuilder<PhotoDayFrameController>(
      init: PhotoDayFrameController(),
      builder: (ctrl) {
        return Container(
          color: customColors?.mainContentBgColor ?? theme.scaffoldBackgroundColor,
          child: CustomScrollView(
            slivers: [
              SliverToBoxAdapter(child: _Header(ctrl: ctrl)),
              if (ctrl.loading)
                const SliverFillRemaining(
                  hasScrollBody: false,
                  child: Center(child: CircularProgressIndicator()),
                )
              else if (ctrl.error != null)
                SliverFillRemaining(
                  hasScrollBody: false,
                  child: _Hint(
                    icon: Icons.error_outline,
                    title: ctrl.error!,
                    actionLabel: 'retry'.tr,
                    onAction: () => ctrl.load(),
                  ),
                )
              else if (ctrl.items.isEmpty)
                SliverFillRemaining(
                  hasScrollBody: false,
                  child: _Hint(
                    icon: Icons.auto_awesome_mosaic_outlined,
                    title: 'photo_day_frame_empty'.tr,
                  ),
                )
              else
                SliverPadding(
                  padding: const EdgeInsets.fromLTRB(20, 4, 20, 26),
                  sliver: SliverGrid(
                    gridDelegate: const SliverGridDelegateWithMaxCrossAxisExtent(
                      maxCrossAxisExtent: 300,
                      mainAxisExtent: 250,
                      crossAxisSpacing: 14,
                      mainAxisSpacing: 14,
                    ),
                    delegate: SliverChildBuilderDelegate(
                      (context, i) => _DayFrameTile(
                        item: ctrl.items[i],
                        onTap: () => _openDayFrames(ctrl, i),
                      ),
                      childCount: ctrl.items.length,
                    ),
                  ),
                ),
            ],
          ),
        );
      },
    );
  }
}

class _Header extends StatelessWidget {
  final PhotoDayFrameController ctrl;

  const _Header({required this.ctrl});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    return Padding(
      padding: const EdgeInsets.fromLTRB(20, 18, 20, 14),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            'photo_day_frame_title'.tr,
            style: theme.textTheme.headlineSmall?.copyWith(
              fontWeight: FontWeight.w800,
              letterSpacing: -0.4,
            ),
          ),
          const SizedBox(height: 2),
          Text(
            'photo_day_frame_sub'.tr,
            style: theme.textTheme.bodySmall?.copyWith(color: scheme.onSurfaceVariant),
          ),
          const SizedBox(height: 12),
          Wrap(
            spacing: 6,
            runSpacing: 6,
            children: [
              for (final d in PhotoDayFrameController.ranges)
                _RangeChip(
                  label: 'photo_day_frame_last_days'.trParams({'days': '$d'}),
                  selected: d == ctrl.days,
                  onTap: () => ctrl.load(range: d),
                ),
            ],
          ),
        ],
      ),
    );
  }
}

class _RangeChip extends StatelessWidget {
  final String label;
  final bool selected;
  final VoidCallback onTap;

  const _RangeChip({
    required this.label,
    required this.selected,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(16),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
        decoration: BoxDecoration(
          color: selected ? scheme.primary.withValues(alpha: 0.10) : Colors.transparent,
          borderRadius: BorderRadius.circular(16),
          border: Border.all(
            color: selected
                ? scheme.primary.withValues(alpha: 0.35)
                : scheme.outlineVariant.withValues(alpha: 0.5),
          ),
        ),
        child: Text(
          label,
          style: TextStyle(
            fontSize: 12,
            color: selected ? scheme.primary : scheme.onSurface,
            fontWeight: selected ? FontWeight.w600 : FontWeight.w400,
          ),
        ),
      ),
    );
  }
}

/// ⭐ 2026-10-19：点开任意一帧时把**整组帧**交给查看器。
/// 旧实现走 openSinglePhoto ⇒ 列表只有 1 张，左右按钮/键盘都成了摆设。
/// 索引按「过滤掉空路径后的位置」算，避免中间有坏数据时打开错的那张。
void _openDayFrames(PhotoDayFrameController ctrl, int index) {
  final entries = <Map<String, dynamic>>[];
  var target = 0;
  final items = ctrl.items;
  for (var i = 0; i < items.length; i++) {
    final it = items[i];
    final path = (it['fullpath'] ?? '').toString();
    if (path.isEmpty) continue;
    if (i == index) target = entries.length;
    entries.add({
      'type': 'image',
      'path': path,
      'name': PhotoDayFrameController.prettyDate(
        (it['date'] ?? '').toString(),
      ),
      'photoId': 0,
    });
  }
  if (entries.isEmpty) return;
  openPhotoImages(entries, target);
}

class _DayFrameTile extends StatelessWidget {
  final Map<String, dynamic> item;
  final VoidCallback onTap;

  const _DayFrameTile({required this.item, required this.onTap});

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final fullpath = (item['fullpath'] ?? '').toString();
    final url = fullpath.isEmpty ? '' : ApiController.instance.getTinyUrl(fullpath);
    final date = (item['date'] ?? '').toString();
    final caption = (item['caption'] ?? '').toString();
    final count = (item['day_photo_count'] as num?)?.toInt() ?? 0;
    final title = PhotoDayFrameController.prettyDate(date);

    return ClipRRect(
      borderRadius: BorderRadius.circular(14),
      child: Stack(
        fit: StackFit.expand,
        children: [
          if (url.isEmpty)
            ColoredBox(
              color: scheme.surfaceContainerHighest,
              child: Icon(Icons.image_outlined, color: scheme.onSurfaceVariant, size: 32),
            )
          else
            CustomExtendedImage(imageUrl: url, fit: BoxFit.cover),
          const DecoratedBox(
            decoration: BoxDecoration(
              gradient: LinearGradient(
                begin: Alignment.topCenter,
                end: Alignment.bottomCenter,
                colors: [Colors.transparent, Colors.black87],
                stops: [0.42, 1.0],
              ),
            ),
          ),
          if (count > 0)
            Positioned(
              right: 10,
              top: 10,
              child: Container(
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                decoration: BoxDecoration(
                  color: Colors.black.withValues(alpha: 0.46),
                  borderRadius: BorderRadius.circular(20),
                ),
                child: Text(
                  '$count ${'photo_home_photos_short'.tr}',
                  style: const TextStyle(color: Colors.white, fontSize: 11),
                ),
              ),
            ),
          Positioned(
            left: 12,
            right: 12,
            bottom: 11,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  title,
                  style: const TextStyle(
                    color: Colors.white,
                    fontSize: 18,
                    fontWeight: FontWeight.w800,
                    height: 1.2,
                  ),
                ),
                if (caption.isNotEmpty) ...[
                  const SizedBox(height: 3),
                  Text(
                    caption,
                    style: const TextStyle(
                      color: Colors.white70,
                      fontSize: 11.5,
                      height: 1.35,
                    ),
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                  ),
                ],
              ],
            ),
          ),
          Positioned.fill(
            child: Material(
              color: Colors.transparent,
              child: InkWell(
                onTap: onTap,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _Hint extends StatelessWidget {
  final IconData icon;
  final String title;
  final String? actionLabel;
  final VoidCallback? onAction;

  const _Hint({
    required this.icon,
    required this.title,
    this.actionLabel,
    this.onAction,
  });

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(icon, size: 38, color: scheme.onSurfaceVariant),
            const SizedBox(height: 12),
            Text(title, textAlign: TextAlign.center, style: const TextStyle(fontSize: 14)),
            if (actionLabel != null) ...[
              const SizedBox(height: 14),
              FilledButton.tonal(onPressed: onAction, child: Text(actionLabel!)),
            ],
          ],
        ),
      ),
    );
  }
}
