import 'package:flutter/material.dart';
import 'package:get/get.dart';
import 'package:WaterNasOS/core/api/api_controller.dart';
import 'package:WaterNasOS/core/theme/custom_colors.dart';
import 'package:WaterNasOS/modules/base/components/custom_extended_image.dart';
import 'package:WaterNasOS/modules/photo/shared/photo_viewer_helper.dart';

import '../controller/photo_annual_controller.dart';

/// ⭐ 2026-10-19 年度总结页（重写）。
///
/// 结构仍然是「时光账本 → 年度生活图谱 → 高光时刻 → 年度足迹 → 四季之景」，
/// 但实现换成了**零依赖**的写法：
///   · 不用 `Obx`/`RxMap`，改 `GetBuilder` 读普通字段；
///   · 不用 `CustomPaint` 画环图，改横向比例条（信息量一样，绘制路径少一层）；
///   · 不用 `dashboard_cards.dart`，页面自己带卡片壳，避免首页组件在别的约束下互相牵连。
///
/// 上一版三个端都灰白的直接原因是 build 期抛异常 —— release 下 ErrorWidget 是灰底，
/// 看上去就是「什么都没有」。所以这一版把「出错」也当成一种正常状态来渲染（见 _ErrorPanel）。
class PhotoAnnualView extends StatelessWidget {
  final void Function(String key)? onNavigate;

  const PhotoAnnualView({super.key, this.onNavigate});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final customColors = theme.extension<CustomColors>();
    return GetBuilder<PhotoAnnualController>(
      init: PhotoAnnualController(),
      builder: (ctrl) {
        return Container(
          color: customColors?.mainContentBgColor ?? theme.scaffoldBackgroundColor,
          child: Center(
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 1080),
              child: ListView(
                padding: const EdgeInsets.fromLTRB(20, 18, 20, 30),
                children: [
                  _Header(ctrl: ctrl),
                  const SizedBox(height: 16),
                  if (ctrl.loading)
                    const Padding(
                      padding: EdgeInsets.only(top: 80),
                      child: Center(child: CircularProgressIndicator()),
                    )
                  else if (ctrl.error != null)
                    _ErrorPanel(message: ctrl.error!, onRetry: () => ctrl.load())
                  else if (ctrl.isEmpty)
                    _EmptyPanel(year: ctrl.year)
                  else ...[
                    _BookCard(ctrl: ctrl),
                    const SizedBox(height: 14),
                    if (ctrl.categories.isNotEmpty) ...[
                      _CategoryCard(ctrl: ctrl),
                      const SizedBox(height: 14),
                    ],
                    _HighlightCard(ctrl: ctrl),
                    const SizedBox(height: 14),
                    _FootprintCard(ctrl: ctrl, onOpenMap: () => onNavigate?.call('all.footprint')),
                    if (ctrl.seasons.any((s) => (s['count'] as num? ?? 0) > 0)) ...[
                      const SizedBox(height: 14),
                      _SeasonCard(ctrl: ctrl),
                    ],
                  ],
                ],
              ),
            ),
          ),
        );
      },
    );
  }
}

// ---------------------------------------------------------------------- 头部

class _Header extends StatelessWidget {
  final PhotoAnnualController ctrl;

  const _Header({required this.ctrl});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final muted = theme.colorScheme.onSurfaceVariant;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          'photo_annual_title'.tr,
          style: theme.textTheme.headlineSmall?.copyWith(
            fontWeight: FontWeight.w800,
            letterSpacing: -0.4,
          ),
        ),
        const SizedBox(height: 2),
        Text(
          'photo_annual_subtitle'.tr,
          style: theme.textTheme.bodySmall?.copyWith(color: muted),
        ),
        const SizedBox(height: 12),
        Wrap(
          spacing: 6,
          runSpacing: 6,
          children: [
            for (final y in ctrl.years)
              _YearChip(
                year: y,
                selected: y == ctrl.year,
                onTap: () => ctrl.load(target: y),
              ),
          ],
        ),
      ],
    );
  }
}

class _YearChip extends StatelessWidget {
  final int year;
  final bool selected;
  final VoidCallback onTap;

  const _YearChip({
    required this.year,
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
          '$year',
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

// ---------------------------------------------------------------------- 卡片壳

class _Card extends StatelessWidget {
  final Widget child;

  const _Card({required this.child});

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Container(
      padding: const EdgeInsets.all(18),
      decoration: BoxDecoration(
        color: scheme.surface,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: scheme.outlineVariant.withValues(alpha: 0.42)),
      ),
      child: child,
    );
  }
}

class _CardTitle extends StatelessWidget {
  final String title;
  final String? subtitle;
  final IconData icon;
  final String? actionLabel;
  final VoidCallback? onAction;

  const _CardTitle({
    required this.title,
    required this.icon,
    this.subtitle,
    this.actionLabel,
    this.onAction,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    return Row(
      children: [
        Icon(icon, size: 18, color: scheme.primary),
        const SizedBox(width: 6),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(
                title,
                style: theme.textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w700),
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
              ),
              if (subtitle != null && subtitle!.isNotEmpty)
                Padding(
                  padding: const EdgeInsets.only(top: 2),
                  child: Text(
                    subtitle!,
                    style: theme.textTheme.bodySmall?.copyWith(color: scheme.onSurfaceVariant),
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
              children: [Text(actionLabel!), const Icon(Icons.chevron_right, size: 16)],
            ),
          ),
      ],
    );
  }
}

// ---------------------------------------------------------------------- 时光账本

class _BookCard extends StatelessWidget {
  final PhotoAnnualController ctrl;

  const _BookCard({required this.ctrl});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final stats = <({String value, String label})>[
      (value: '${ctrl.total}', label: 'photo_annual_photos'.tr),
      (value: '${ctrl.videos}', label: 'photo_annual_videos'.tr),
      (value: '${ctrl.activeDays}', label: 'photo_annual_days'.tr),
      (value: '${ctrl.cities}', label: 'photo_annual_cities'.tr),
      (value: ctrl.videoDurationText, label: 'photo_annual_video_time'.tr),
    ];
    return ClipRRect(
      borderRadius: BorderRadius.circular(18),
      child: Container(
        padding: const EdgeInsets.fromLTRB(22, 22, 22, 20),
        decoration: BoxDecoration(
          gradient: LinearGradient(
            begin: Alignment.topLeft,
            end: Alignment.bottomRight,
            colors: [scheme.primary, Colors.black.withValues(alpha: 0.78)],
          ),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              'photo_annual_book'.tr,
              style: const TextStyle(
                color: Colors.white70,
                fontSize: 12,
                letterSpacing: 1.5,
                fontWeight: FontWeight.w600,
              ),
            ),
            const SizedBox(height: 10),
            Text(
              '${ctrl.year}',
              style: const TextStyle(
                color: Colors.white,
                fontSize: 38,
                height: 1,
                letterSpacing: -1,
                fontWeight: FontWeight.w800,
              ),
            ),
            const SizedBox(height: 10),
            Text(
              'photo_annual_book_line1'.trParams({'count': '${ctrl.total}'}),
              style: const TextStyle(color: Colors.white, fontSize: 15, height: 1.5),
            ),
            const SizedBox(height: 2),
            Text(
              'photo_annual_book_line2'.trParams({
                'cities': '${ctrl.cities}',
                'days': '${ctrl.activeDays}',
              }),
              style: TextStyle(color: Colors.white.withValues(alpha: 0.82), fontSize: 12, height: 1.5),
            ),
            const SizedBox(height: 18),
            Wrap(
              spacing: 10,
              runSpacing: 10,
              children: [
                for (final s in stats)
                  Container(
                    padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 9),
                    decoration: BoxDecoration(
                      color: Colors.white.withValues(alpha: 0.12),
                      borderRadius: BorderRadius.circular(12),
                    ),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Text(
                          s.value,
                          style: const TextStyle(
                            color: Colors.white,
                            fontSize: 18,
                            fontWeight: FontWeight.w700,
                            height: 1.1,
                          ),
                        ),
                        const SizedBox(height: 2),
                        Text(s.label, style: const TextStyle(color: Colors.white70, fontSize: 11)),
                      ],
                    ),
                  ),
              ],
            ),
          ],
          ),
        ),
    );
  }
}

// ---------------------------------------------------------------------- 生活图谱

class _CategoryCard extends StatelessWidget {
  final PhotoAnnualController ctrl;

  const _CategoryCard({required this.ctrl});

  static const _palette = <Color>[
    Color(0xFF2F80ED),
    Color(0xFF2FA37C),
    Color(0xFFE08A2B),
    Color(0xFF8B5CF6),
    Color(0xFF4CAF50),
    Color(0xFFE05C8A),
    Color(0xFFD4A017),
    Color(0xFF78909C),
  ];

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final muted = theme.colorScheme.onSurfaceVariant;
    final cats = ctrl.categories;
    return _Card(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          _CardTitle(
            title: 'photo_annual_map'.tr,
            subtitle: 'photo_annual_map_sub'.tr,
            icon: Icons.pie_chart_outline,
          ),
          const SizedBox(height: 14),
          for (var i = 0; i < cats.length; i++) ...[
            if (i > 0) const SizedBox(height: 10),
            _CategoryRow(
              label: 'photo_annual_cat_${cats[i]['key']}'.tr,
              ratio: ((cats[i]['ratio'] as num?)?.toDouble() ?? 0).clamp(0.0, 1.0),
              count: (cats[i]['count'] as num?)?.toInt() ?? 0,
              color: _palette[i % _palette.length],
              muted: muted,
            ),
          ],
        ],
      ),
    );
  }
}

class _CategoryRow extends StatelessWidget {
  final String label;
  final double ratio;
  final int count;
  final Color color;
  final Color muted;

  const _CategoryRow({
    required this.label,
    required this.ratio,
    required this.count,
    required this.color,
    required this.muted,
  });

  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        Container(
          width: 9,
          height: 9,
          decoration: BoxDecoration(color: color, borderRadius: BorderRadius.circular(2)),
        ),
        const SizedBox(width: 8),
        SizedBox(
          width: 86,
          child: Text(
            label,
            style: const TextStyle(fontSize: 12),
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
          ),
        ),
        Expanded(
          child: ClipRRect(
            borderRadius: BorderRadius.circular(4),
            child: LinearProgressIndicator(
              value: ratio,
              minHeight: 7,
              backgroundColor: color.withValues(alpha: 0.12),
              valueColor: AlwaysStoppedAnimation<Color>(color),
            ),
          ),
        ),
        const SizedBox(width: 8),
        SizedBox(
          width: 42,
          child: Text(
            '${(ratio * 100).round()}%',
            textAlign: TextAlign.right,
            style: TextStyle(fontSize: 11, color: muted),
          ),
        ),
      ],
    );
  }
}

// ---------------------------------------------------------------------- 高光时刻

class _HighlightCard extends StatelessWidget {
  final PhotoAnnualController ctrl;

  const _HighlightCard({required this.ctrl});

  @override
  Widget build(BuildContext context) {
    final items = <({IconData icon, String title, String value, String unit})>[];
    final short = 'photo_home_photos_short'.tr;

    final people = ctrl.topPeople;
    if (people.isNotEmpty) {
      items.add((
        icon: Icons.face_retouching_natural_outlined,
        title: 'photo_annual_top_person'.tr,
        value: (people.first['name'] ?? '').toString(),
        unit: '${(people.first['count'] as num?)?.toInt() ?? 0} $short',
      ));
    }
    final scenes = ctrl.topScenes;
    if (scenes.isNotEmpty) {
      items.add((
        icon: Icons.landscape_outlined,
        title: 'photo_annual_top_scene'.tr,
        value: (scenes.first['name'] ?? '').toString(),
        unit: '${(scenes.first['count'] as num?)?.toInt() ?? 0} $short',
      ));
    }
    final acts = ctrl.topActivities;
    if (acts.isNotEmpty) {
      items.add((
        icon: Icons.directions_run,
        title: 'photo_annual_top_activity'.tr,
        value: (acts.first['name'] ?? '').toString(),
        unit: '${(acts.first['count'] as num?)?.toInt() ?? 0} $short',
      ));
    }
    final busy = ctrl.busyDays;
    if (busy.isNotEmpty) {
      items.add((
        icon: Icons.event_available_outlined,
        title: 'photo_annual_busiest'.tr,
        value: (busy.first['date'] ?? '').toString(),
        unit: '${(busy.first['count'] as num?)?.toInt() ?? 0} $short',
      ));
    }
    final cams = ctrl.topCameras;
    if (cams.isNotEmpty) {
      items.add((
        icon: Icons.camera_alt_outlined,
        title: 'photo_annual_top_camera'.tr,
        value: (cams.first['name'] ?? '').toString(),
        unit: '${(cams.first['count'] as num?)?.toInt() ?? 0} $short',
      ));
    }
    if (items.isEmpty) return const SizedBox.shrink();

    return _Card(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          _CardTitle(
            title: 'photo_annual_highlights'.tr,
            subtitle: 'photo_annual_highlights_sub'.tr,
            icon: Icons.auto_awesome,
          ),
          const SizedBox(height: 14),
          Wrap(
            spacing: 10,
            runSpacing: 10,
            children: [
              for (final it in items)
                SizedBox(
                  width: 200,
                  child: _HighlightTile(
                    icon: it.icon,
                    title: it.title,
                    value: it.value,
                    unit: it.unit,
                  ),
                ),
            ],
          ),
        ],
      ),
    );
  }
}

class _HighlightTile extends StatelessWidget {
  final IconData icon;
  final String title;
  final String value;
  final String unit;

  const _HighlightTile({
    required this.icon,
    required this.title,
    required this.value,
    required this.unit,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: scheme.surfaceContainerHighest.withValues(alpha: 0.36),
        borderRadius: BorderRadius.circular(12),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          Row(
            children: [
              Icon(icon, size: 14, color: scheme.primary),
              const SizedBox(width: 6),
              Expanded(
                child: Text(
                  title,
                  style: TextStyle(fontSize: 11, color: scheme.onSurfaceVariant),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
              ),
            ],
          ),
          const SizedBox(height: 8),
          Text(
            value.isEmpty ? '—' : value,
            style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w700),
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
          ),
          const SizedBox(height: 2),
          Text(unit, style: TextStyle(fontSize: 11, color: scheme.onSurfaceVariant)),
        ],
      ),
    );
  }
}

// ---------------------------------------------------------------------- 年度足迹

class _FootprintCard extends StatelessWidget {
  final PhotoAnnualController ctrl;
  final VoidCallback onOpenMap;

  const _FootprintCard({required this.ctrl, required this.onOpenMap});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final muted = theme.colorScheme.onSurfaceVariant;
    final km = (ctrl.farthest['km'] as num?)?.toInt() ?? 0;
    return _Card(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          _CardTitle(
            title: 'photo_annual_footprint'.tr,
            subtitle: 'photo_annual_footprint_sub'.tr,
            icon: Icons.explore_outlined,
            actionLabel: 'photo_annual_view_map'.tr,
            onAction: onOpenMap,
          ),
          const SizedBox(height: 14),
          Row(
            children: [
              Expanded(child: _FootItem(value: '${ctrl.cities}', label: 'photo_annual_cities'.tr)),
              Expanded(child: _FootItem(value: '${ctrl.places}', label: 'photo_annual_places'.tr)),
              Expanded(child: _FootItem(value: '${ctrl.activeDays}', label: 'photo_annual_days'.tr)),
            ],
          ),
          if (km > 0) ...[
            const SizedBox(height: 10),
            Text(
              'photo_annual_farthest'.trParams({'km': '$km'}),
              style: TextStyle(fontSize: 12, color: muted),
            ),
          ],
        ],
      ),
    );
  }
}

class _FootItem extends StatelessWidget {
  final String value;
  final String label;

  const _FootItem({required this.value, required this.label});

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          value,
          style: const TextStyle(fontSize: 22, fontWeight: FontWeight.w800, height: 1),
        ),
        const SizedBox(height: 4),
        Text(label, style: TextStyle(fontSize: 12, color: scheme.onSurfaceVariant)),
      ],
    );
  }
}

// ---------------------------------------------------------------------- 四季

class _SeasonCard extends StatelessWidget {
  final PhotoAnnualController ctrl;

  const _SeasonCard({required this.ctrl});

  @override
  Widget build(BuildContext context) {
    final list = ctrl.seasons.where((s) => (s['count'] as num? ?? 0) > 0).toList();
    return _Card(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          _CardTitle(
            title: 'photo_annual_seasons'.tr,
            subtitle: 'photo_annual_seasons_sub'.tr,
            icon: Icons.eco_outlined,
          ),
          const SizedBox(height: 14),
          Wrap(
            spacing: 10,
            runSpacing: 10,
            children: [
              for (final s in list)
                SizedBox(
                  width: 168,
                  height: 120,
                  child: _SeasonTile(
                    coverPath: (s['cover_path'] ?? '').toString(),
                    label: 'photo_annual_season_${s['key']}'.tr,
                    count: (s['count'] as num?)?.toInt() ?? 0,
                  ),
                ),
            ],
          ),
        ],
      ),
    );
  }
}

class _SeasonTile extends StatelessWidget {
  final String coverPath;
  final String label;
  final int count;

  const _SeasonTile({
    required this.coverPath,
    required this.label,
    required this.count,
  });

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final url = coverPath.isEmpty ? '' : ApiController.instance.getTinyUrl(coverPath);
    return ClipRRect(
      borderRadius: BorderRadius.circular(12),
      child: Stack(
        fit: StackFit.expand,
        children: [
          if (url.isEmpty)
            ColoredBox(
              color: scheme.surfaceContainerHighest,
              child: Icon(Icons.image_outlined, color: scheme.onSurfaceVariant),
            )
          else
            CustomExtendedImage(imageUrl: url, fit: BoxFit.cover),
          const DecoratedBox(
            decoration: BoxDecoration(
              gradient: LinearGradient(
                begin: Alignment.topCenter,
                end: Alignment.bottomCenter,
                colors: [Colors.transparent, Colors.black54],
                stops: [0.4, 1.0],
              ),
            ),
          ),
          Positioned(
            left: 12,
            bottom: 10,
            right: 12,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  label,
                  style: const TextStyle(
                    color: Colors.white,
                    fontSize: 14,
                    fontWeight: FontWeight.w700,
                  ),
                ),
                Text(
                  '$count ${'photo_home_photos_short'.tr}',
                  style: const TextStyle(color: Colors.white70, fontSize: 11),
                ),
              ],
            ),
          ),
          Positioned.fill(
            child: Material(
              color: Colors.transparent,
              child: InkWell(
                onTap: () => openSinglePhoto(coverPath, label),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

// ---------------------------------------------------------------------- 空 / 错误

class _EmptyPanel extends StatelessWidget {
  final int year;

  const _EmptyPanel({required this.year});

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Padding(
      padding: const EdgeInsets.only(top: 70),
      child: Column(
        children: [
          Icon(Icons.bar_chart, size: 38, color: scheme.onSurfaceVariant),
          const SizedBox(height: 12),
          Text(
            'photo_annual_empty'.trParams({'year': '$year'}),
            textAlign: TextAlign.center,
            style: const TextStyle(fontSize: 14),
          ),
        ],
      ),
    );
  }
}

class _ErrorPanel extends StatelessWidget {
  final String message;
  final VoidCallback onRetry;

  const _ErrorPanel({required this.message, required this.onRetry});

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Padding(
      padding: const EdgeInsets.only(top: 70),
      child: Column(
        children: [
          Icon(Icons.error_outline, size: 38, color: scheme.onSurfaceVariant),
          const SizedBox(height: 12),
          Text(message, textAlign: TextAlign.center, style: const TextStyle(fontSize: 14)),
          const SizedBox(height: 14),
          FilledButton.tonal(onPressed: onRetry, child: Text('retry'.tr)),
        ],
      ),
    );
  }
}
