import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:get/get.dart';
import 'package:WaterNasOS/core/api/api_controller.dart';
import 'package:WaterNasOS/modules/base/components/custom_extended_image.dart';

/// ⭐ 2026-10-18 相册首页看板：卡片组件集合。
///
/// 设计口径（对齐行影集那种「首页」）：
///   · 卡片 = 白底 + 16 圆角 + 极淡描边（不投阴影，避免列表里一层层发灰）；
///   · 数字用 28~34 的 w700 大字，单位/说明用 bodySmall 灰字压在下面；
///   · 所有颜色取 Theme.colorScheme，不硬编码色值 —— 换主题必须跟着变。

const double kHomeGap = 14;

/// 首页统一卡片容器。
class HomeCard extends StatelessWidget {
  final Widget child;
  final EdgeInsetsGeometry padding;
  final EdgeInsetsGeometry? margin;

  const HomeCard({
    super.key,
    required this.child,
    this.padding = const EdgeInsets.all(18),
    this.margin,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Container(
      margin: margin,
      padding: padding,
      decoration: BoxDecoration(
        color: theme.colorScheme.surface,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(
          color: theme.colorScheme.outlineVariant.withValues(alpha: 0.42),
        ),
      ),
      child: child,
    );
  }
}

/// 段落标题：标题 + 说明 + 右侧动作。
class HomeSectionTitle extends StatelessWidget {
  final String title;
  final String? subtitle;
  final String? actionLabel;
  final VoidCallback? onAction;
  final IconData? icon;

  const HomeSectionTitle({
    super.key,
    required this.title,
    this.subtitle,
    this.actionLabel,
    this.onAction,
    this.icon,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Row(
      crossAxisAlignment: CrossAxisAlignment.center,
      children: [
        if (icon != null) ...[
          Icon(icon, size: 18, color: theme.colorScheme.primary),
          const SizedBox(width: 6),
        ],
        Flexible(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(
                title,
                style: theme.textTheme.titleMedium?.copyWith(
                  fontWeight: FontWeight.w700,
                ),
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
              ),
              if (subtitle != null && subtitle!.isNotEmpty)
                Padding(
                  padding: const EdgeInsets.only(top: 2),
                  child: Text(
                    subtitle!,
                    style: theme.textTheme.bodySmall?.copyWith(
                      color: theme.colorScheme.onSurfaceVariant,
                    ),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                  ),
                ),
            ],
          ),
        ),
        if (actionLabel != null)
          TextButton(
            onPressed: onAction,
            style: TextButton.styleFrom(
              visualDensity: VisualDensity.compact,
              padding: const EdgeInsets.symmetric(horizontal: 8),
            ),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(actionLabel!),
                const Icon(Icons.chevron_right, size: 16),
              ],
            ),
          ),
      ],
    );
  }
}

/// 「我的照片」统计卡。
class LibraryStatCard extends StatelessWidget {
  final int photos;
  final int videos;
  final int todayNew;
  final int totalBytes;
  final VoidCallback? onViewStorage;

  const LibraryStatCard({
    super.key,
    required this.photos,
    required this.videos,
    required this.todayNew,
    required this.totalBytes,
    this.onViewStorage,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final muted = theme.colorScheme.onSurfaceVariant;
    return HomeCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(Icons.photo_library_outlined,
                  size: 18, color: theme.colorScheme.primary),
              const SizedBox(width: 6),
              Text(
                'photo_home_my_photos'.tr,
                style: theme.textTheme.titleMedium
                    ?.copyWith(fontWeight: FontWeight.w700),
              ),
            ],
          ),
          const SizedBox(height: 2),
          Text(
            'photo_home_my_photos_sub'.tr,
            style: theme.textTheme.bodySmall?.copyWith(color: muted),
          ),
          const SizedBox(height: 14),
          Row(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              Expanded(
                flex: 3,
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      '$photos',
                      style: theme.textTheme.displaySmall?.copyWith(
                        fontWeight: FontWeight.w800,
                        height: 1.0,
                        letterSpacing: -1,
                      ),
                    ),
                    const SizedBox(height: 6),
                    Text(
                      'photo_home_photos_unit'.tr,
                      style: theme.textTheme.bodySmall?.copyWith(color: muted),
                    ),
                  ],
                ),
              ),
              Expanded(
                flex: 2,
                child: _MiniStat(
                  value: '+$todayNew',
                  label: 'photo_home_today_new'.tr,
                ),
              ),
              Expanded(
                flex: 2,
                child: _MiniStat(
                  value: formatBytes(totalBytes),
                  label: 'photo_home_storage_used'.tr,
                ),
              ),
              if (videos > 0)
                Expanded(
                  flex: 2,
                  child: _MiniStat(
                    value: '$videos',
                    label: 'photo_home_videos_unit'.tr,
                  ),
                ),
            ],
          ),
          const SizedBox(height: 14),
          Divider(
            height: 1,
            color: theme.colorScheme.outlineVariant.withValues(alpha: 0.4),
          ),
          const SizedBox(height: 10),
          Row(
            children: [
              Expanded(
                child: Text(
                  '${'photo_home_storage_current'.tr}${formatBytes(totalBytes)}',
                  style: theme.textTheme.bodySmall?.copyWith(color: muted),
                ),
              ),
              TextButton(
                onPressed: onViewStorage,
                style: TextButton.styleFrom(
                  visualDensity: VisualDensity.compact,
                  padding: const EdgeInsets.symmetric(horizontal: 8),
                ),
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text('photo_home_view_storage'.tr),
                    const Icon(Icons.chevron_right, size: 16),
                  ],
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

class _MiniStat extends StatelessWidget {
  final String value;
  final String label;

  const _MiniStat({required this.value, required this.label});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          value,
          style: theme.textTheme.titleLarge?.copyWith(
            fontWeight: FontWeight.w700,
          ),
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
        ),
        const SizedBox(height: 2),
        Text(
          label,
          style: theme.textTheme.bodySmall?.copyWith(
            color: theme.colorScheme.onSurfaceVariant,
          ),
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
        ),
      ],
    );
  }
}

/// 「拍摄时光」热力图卡：左侧环形图（按年占比）+ 右侧点阵（近一年每日张数）。
class ShotTimeCard extends StatelessWidget {
  final List<Map<String, dynamic>> days;
  final List<Map<String, dynamic>> years;
  final int total;
  final int activeDays;
  final int peakYear;
  final int peakMonth;
  final int peakMonthCount;

  const ShotTimeCard({
    super.key,
    required this.days,
    required this.years,
    required this.total,
    required this.activeDays,
    required this.peakYear,
    required this.peakMonth,
    required this.peakMonthCount,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final muted = theme.colorScheme.onSurfaceVariant;
    final slices = _buildSlices(context);
    final sum = slices.fold<int>(0, (a, b) => a + b.count);

    return HomeCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Icon(Icons.grain, size: 18, color: theme.colorScheme.primary),
              const SizedBox(width: 6),
              Text(
                'photo_home_shot_time'.tr,
                style: theme.textTheme.titleMedium
                    ?.copyWith(fontWeight: FontWeight.w700),
              ),
              const Spacer(),
              Container(
                padding:
                    const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
                decoration: BoxDecoration(
                  color: theme.colorScheme.primary.withValues(alpha: 0.08),
                  borderRadius: BorderRadius.circular(20),
                ),
                child: Text(
                  'photo_home_last_year'.tr,
                  style: theme.textTheme.bodySmall?.copyWith(
                    color: theme.colorScheme.primary,
                  ),
                ),
              ),
            ],
          ),
          const SizedBox(height: 4),
          Text(
            'photo_home_shot_time_sub'
                .trParams({'count': '$total', 'days': '$activeDays'}),
            style: theme.textTheme.bodySmall?.copyWith(color: muted),
          ),
          const SizedBox(height: 16),
          LayoutBuilder(
            builder: (context, constraints) {
              final narrow = constraints.maxWidth < 720;
              final donut = SizedBox(
                width: 120,
                height: 120,
                child: Stack(
                  alignment: Alignment.center,
                  children: [
                    CustomPaint(
                      size: const Size(120, 120),
                      painter: _DonutPainter(slices: slices, total: sum),
                    ),
                    Column(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Text(
                          '$sum',
                          style: theme.textTheme.titleMedium?.copyWith(
                            fontWeight: FontWeight.w700,
                          ),
                        ),
                        Text(
                          'photo_home_photos_short'.tr,
                          style: theme.textTheme.labelSmall
                              ?.copyWith(color: muted),
                        ),
                      ],
                    ),
                  ],
                ),
              );
              final legend = Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: [
                  for (final s in slices.take(4))
                    Padding(
                      padding: const EdgeInsets.only(bottom: 6),
                      child: Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          Container(
                            width: 8,
                            height: 8,
                            decoration: BoxDecoration(
                              color: s.color,
                              borderRadius: BorderRadius.circular(2),
                            ),
                          ),
                          const SizedBox(width: 6),
                          Text(
                            '${s.label}　${sum == 0 ? 0 : (s.count * 100 / sum).round()}%',
                            style: theme.textTheme.bodySmall
                                ?.copyWith(color: muted),
                          ),
                        ],
                      ),
                    ),
                  if (peakMonth > 0)
                    Padding(
                      padding: const EdgeInsets.only(top: 2),
                      child: Text(
                        'photo_home_peak_month'.trParams({
                          'month': '${peakYear > 0 ? peakYear : DateTime.now().year} 年 $peakMonth 月',
                          'count': '$peakMonthCount',
                        }),
                        style: theme.textTheme.bodySmall?.copyWith(
                          color: muted,
                          fontSize: 11,
                        ),
                      ),
                    ),
                ],
              );
              if (narrow) {
                return Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [donut, const SizedBox(width: 16), legend],
                    ),
                    const SizedBox(height: 14),
                    HeatMatrix(days: days),
                    const SizedBox(height: 8),
                    _buildLegendHint(context),
                  ],
                );
              }
              return Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  donut,
                  const SizedBox(width: 14),
                  legend,
                  const SizedBox(width: 18),
                  Expanded(
                    flex: 3,
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        HeatMatrix(days: days),
                        const SizedBox(height: 8),
                        _buildLegendHint(context),
                      ],
                    ),
                  ),
                ],
              );
            },
          ),
        ],
      ),
    );
  }

  Widget _buildLegendHint(BuildContext context) {
    final theme = Theme.of(context);
    final muted = theme.colorScheme.onSurfaceVariant;
    return Row(
      children: [
        Text(
          'photo_home_less'.tr,
          style: theme.textTheme.labelSmall
              ?.copyWith(color: muted, fontSize: 10),
        ),
        const SizedBox(width: 4),
        for (final a in const [0.08, 0.28, 0.5, 0.72, 1.0])
          Container(
            width: 9,
            height: 9,
            margin: const EdgeInsets.only(right: 3),
            decoration: BoxDecoration(
              color: theme.colorScheme.primary.withValues(alpha: a),
              borderRadius: BorderRadius.circular(2),
            ),
          ),
        const SizedBox(width: 2),
        Text(
          'photo_home_more'.tr,
          style: theme.textTheme.labelSmall
              ?.copyWith(color: muted, fontSize: 10),
        ),
      ],
    );
  }

  List<({String label, int count, Color color})> _buildSlices(BuildContext context) {
    final theme = Theme.of(context);
    final base = theme.colorScheme.primary;
    final list = <({String label, int count, Color color})>[];
    final top = years.take(4).toList();
    var rest = 0;
    for (var i = 0; i < years.length; i++) {
      final c = (years[i]['count'] as num?)?.toInt() ?? 0;
      if (i >= top.length) rest += c;
    }
    for (var i = 0; i < top.length; i++) {
      final y = (top[i]['year'] as num?)?.toInt() ?? 0;
      final c = (top[i]['count'] as num?)?.toInt() ?? 0;
      if (y <= 0 || c <= 0) continue;
      list.add((
        label: '$y',
        count: c,
        color: base.withValues(alpha: 1.0 - i * 0.18),
      ));
    }
    if (rest > 0) {
      list.add((label: '···', count: rest, color: base.withValues(alpha: 0.22)));
    }
    if (list.isEmpty) {
      list.add((label: 'no_data'.tr, count: 0, color: base.withValues(alpha: 0.15)));
    }
    return list;
  }
}

class _DonutPainter extends CustomPainter {
  final List<({String label, int count, Color color})> slices;
  final int total;

  const _DonutPainter({required this.slices, required this.total});

  @override
  void paint(Canvas canvas, Size size) {
    final rect = Rect.fromLTWH(0, 0, size.width, size.height);
    final stroke = size.width * 0.16;
    final paint = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = stroke;
    final arcRect = rect.deflate(stroke / 2 + 1);

    if (total <= 0) {
      paint.color = Colors.grey.withValues(alpha: 0.15);
      canvas.drawArc(arcRect, 0, math.pi * 2, false, paint);
      return;
    }
    var start = -math.pi / 2;
    for (final s in slices) {
      if (s.count <= 0) continue;
      final sweep = math.pi * 2 * (s.count / total);
      paint.color = s.color;
      canvas.drawArc(arcRect, start, sweep - 0.02, false, paint);
      start += sweep;
    }
  }

  @override
  bool shouldRepaint(covariant _DonutPainter oldDelegate) =>
      oldDelegate.total != total || oldDelegate.slices.length != slices.length;
}

/// 近一年每日拍摄点阵（GitHub 风格：一列 7 天，从左到右为时间推进）。
class HeatMatrix extends StatelessWidget {
  final List<Map<String, dynamic>> days;

  const HeatMatrix({super.key, required this.days});

  @override
  Widget build(BuildContext context) {
    final counts = <String, int>{};
    for (final d in days) {
      final date = (d['date'] ?? '').toString();
      final n = (d['count'] as num?)?.toInt() ?? 0;
      if (date.length >= 10) counts[date.substring(0, 10)] = n;
    }

    final now = DateTime.now();
    final end = DateTime(now.year, now.month, now.day);
    final start = end.subtract(const Duration(days: 364));
    final aligned = start.subtract(Duration(days: start.weekday - 1));
    final dayCount = end.difference(aligned).inDays + 1;
    final weekCount = (dayCount / 7).ceil();

    return LayoutBuilder(
      builder: (context, constraints) {
        const gap = 3.0;
        final raw = (constraints.maxWidth - gap * (weekCount - 1)) / weekCount;
        final cell = raw.clamp(4.0, 12.0);
        return Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            for (var w = 0; w < weekCount; w++)
              Padding(
                padding: EdgeInsets.only(right: w == weekCount - 1 ? 0 : gap),
                child: Column(
                  children: [
                    for (var d = 0; d < 7; d++)
                      Padding(
                        padding: const EdgeInsets.only(bottom: gap),
                        child: _dot(
                          context,
                          aligned.add(Duration(days: w * 7 + d)),
                          end,
                          counts,
                          cell,
                        ),
                      ),
                  ],
                ),
              ),
          ],
        );
      },
    );
  }

  Widget _dot(
    BuildContext context,
    DateTime date,
    DateTime end,
    Map<String, int> counts,
    double cell,
  ) {
    if (date.isAfter(end)) {
      return SizedBox(width: cell, height: cell);
    }
    final key =
        '${date.year.toString().padLeft(4, '0')}-${date.month.toString().padLeft(2, '0')}-${date.day.toString().padLeft(2, '0')}';
    final n = counts[key] ?? 0;
    final box = Container(
      width: cell,
      height: cell,
      decoration: BoxDecoration(
        color: _heatColor(context, n),
        borderRadius: BorderRadius.circular(cell > 8 ? 2.5 : 2),
      ),
    );
    // 空白天不挂 Tooltip：一年 360 多个格子，全挂会明显拖慢首页滚动
    if (n <= 0) return box;
    return Tooltip(
      message: '$key  $n ${'photo_home_photos_short'.tr}',
      waitDuration: const Duration(milliseconds: 320),
      child: box,
    );
  }

  Color _heatColor(BuildContext context, int n) {
    final theme = Theme.of(context);
    if (n <= 0) {
      return theme.colorScheme.onSurface.withValues(alpha: 0.06);
    }
    if (n <= 2) return theme.colorScheme.primary.withValues(alpha: 0.28);
    if (n <= 9) return theme.colorScheme.primary.withValues(alpha: 0.5);
    if (n <= 49) return theme.colorScheme.primary.withValues(alpha: 0.74);
    return theme.colorScheme.primary;
  }
}

/// 「我的足迹」卡。
class FootprintCard extends StatelessWidget {
  final int cities;
  final int places;
  final int days;
  final VoidCallback? onView;

  const FootprintCard({
    super.key,
    required this.cities,
    required this.places,
    required this.days,
    this.onView,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final muted = theme.colorScheme.onSurfaceVariant;
    return HomeCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          HomeSectionTitle(
            title: 'photo_home_footprint'.tr,
            icon: Icons.place_outlined,
            actionLabel: 'photo_home_view_footprint'.tr,
            onAction: onView,
          ),
          const SizedBox(height: 2),
          Text(
            'photo_home_footprint_sub'.tr,
            style: theme.textTheme.bodySmall?.copyWith(color: muted),
          ),
          const SizedBox(height: 14),
          Row(
            children: [
              Expanded(
                child: _FootStat(value: '$cities', label: 'photo_home_cities'.tr),
              ),
              Expanded(
                child: _FootStat(value: '$places', label: 'photo_home_places'.tr),
              ),
              Expanded(
                child: _FootStat(value: '$days', label: 'photo_home_days'.tr),
              ),
            ],
          ),
          const SizedBox(height: 12),
          Text(
            'photo_home_footprint_note'.tr,
            style: theme.textTheme.labelSmall?.copyWith(
              color: muted,
              fontSize: 10,
            ),
          ),
        ],
      ),
    );
  }
}

class _FootStat extends StatelessWidget {
  final String value;
  final String label;

  const _FootStat({required this.value, required this.label});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          value,
          style: theme.textTheme.headlineSmall?.copyWith(
            fontWeight: FontWeight.w800,
            height: 1.0,
          ),
        ),
        const SizedBox(height: 4),
        Text(
          label,
          style: theme.textTheme.bodySmall?.copyWith(
            color: theme.colorScheme.onSurfaceVariant,
          ),
        ),
      ],
    );
  }
}

/// 「镜头里的相伴」卡。
class PeopleCard extends StatelessWidget {
  final List<Map<String, dynamic>> items;
  final int pending;
  final VoidCallback? onViewAll;
  final VoidCallback? onConfirm;
  final void Function(Map<String, dynamic> item)? onOpenPerson;

  const PeopleCard({
    super.key,
    required this.items,
    required this.pending,
    this.onViewAll,
    this.onConfirm,
    this.onOpenPerson,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final muted = theme.colorScheme.onSurfaceVariant;
    return HomeCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          HomeSectionTitle(
            title: 'photo_home_people'.tr,
            icon: Icons.people_outline,
            actionLabel: 'photo_home_view_people'.tr,
            onAction: onViewAll,
          ),
          const SizedBox(height: 2),
          Text(
            'photo_home_people_sub'.trParams({'count': '${items.length}'}),
            style: theme.textTheme.bodySmall?.copyWith(color: muted),
          ),
          const SizedBox(height: 14),
          if (items.isEmpty)
            Text(
              'photo_home_no_people'.tr,
              style: theme.textTheme.bodySmall?.copyWith(color: muted),
            )
          else
            Row(
              children: [
                for (final p in items)
                  Expanded(
                    child: InkWell(
                      onTap: onOpenPerson == null ? null : () => onOpenPerson!(p),
                      borderRadius: BorderRadius.circular(10),
                      child: Padding(
                        padding: const EdgeInsets.symmetric(vertical: 2),
                        child: Column(
                          children: [
                            _Avatar(
                              path: (p['cover_path'] ?? '').toString(),
                              faceId: (p['face_id'] as num?)?.toInt() ?? 0,
                            ),
                            const SizedBox(height: 8),
                            Text(
                              (p['name'] ?? '').toString(),
                              style: theme.textTheme.bodyMedium
                                  ?.copyWith(fontWeight: FontWeight.w600),
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                            ),
                            const SizedBox(height: 2),
                            Text(
                              '${(p['photo_count'] as num?)?.toInt() ?? 0}${'photo_home_photos_short'.tr}',
                              style: theme.textTheme.labelSmall
                                  ?.copyWith(color: muted),
                            ),
                          ],
                        ),
                      ),
                    ),
                  ),
              ],
            ),
          if (pending > 0) ...[
            const SizedBox(height: 12),
            Container(
              padding: const EdgeInsets.fromLTRB(12, 8, 8, 8),
              decoration: BoxDecoration(
                color: theme.colorScheme.primary.withValues(alpha: 0.06),
                borderRadius: BorderRadius.circular(10),
              ),
              child: Row(
                children: [
                  Icon(Icons.auto_awesome,
                      size: 14, color: theme.colorScheme.primary),
                  const SizedBox(width: 6),
                  Expanded(
                    child: Text(
                      'photo_home_pending_faces'.trParams({'count': '$pending'}),
                      style: theme.textTheme.bodySmall,
                    ),
                  ),
                  TextButton(
                    onPressed: onConfirm,
                    style: TextButton.styleFrom(
                      visualDensity: VisualDensity.compact,
                      padding: const EdgeInsets.symmetric(horizontal: 6),
                    ),
                    child: Text('photo_home_go_confirm'.tr),
                  ),
                ],
              ),
            ),
          ],
        ],
      ),
    );
  }
}

class _Avatar extends StatelessWidget {
  final String path;
  final int faceId;

  const _Avatar({required this.path, this.faceId = 0});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    // ⭐ 2026-10-19：优先用人脸识别里那张裁切头像。
    //    服务端给的 cover_path 是「这张脸出现的某张原图」，缩略之后经常是半张脸、
    //    后脑勺或者一整张合影 —— 首页三个圆头像里看到的就是这种「奇怪的图」。
    //    face_id 拿不到时才回落到原图缩略。
    final url = faceId > 0
        ? ApiController.instance.getFaceImageUrl(
            faceId: faceId,
            size: 240,
            quality: 85,
          )
        : (path.isEmpty ? '' : ApiController.instance.getTinyUrl(path));
    return Container(
      width: 54,
      height: 54,
      decoration: BoxDecoration(
        shape: BoxShape.circle,
        color: theme.colorScheme.primary.withValues(alpha: 0.1),
      ),
      clipBehavior: Clip.antiAlias,
      child: url.isEmpty
          ? Icon(Icons.person_outline,
              size: 26, color: theme.colorScheme.primary)
          : CustomExtendedImage(imageUrl: url, fit: BoxFit.cover),
    );
  }
}

/// 字节格式化（首页多处共用）。
String formatBytes(int v) {
  if (v <= 0) return '0 B';
  const units = <String>['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  double d = v.toDouble();
  var i = 0;
  while (d >= 1024 && i < units.length - 1) {
    d /= 1024;
    i += 1;
  }
  return '${d.toStringAsFixed(d >= 100 || i == 0 ? 0 : 1)} ${units[i]}';
}
