import 'package:flutter/material.dart';
import 'package:get/get.dart';
import 'package:WaterNasOS/core/api/api_controller.dart';
import 'package:WaterNasOS/core/theme/custom_colors.dart';
import 'package:WaterNasOS/modules/base/components/custom_extended_image.dart';
import 'package:WaterNasOS/modules/gallery/controllers/custom_gallery_controller.dart';
import 'package:WaterNasOS/modules/gallery/views/custom_gallery.dart';
import 'package:WaterNasOS/modules/home/views/pc_home_controller.dart';
import 'package:WaterNasOS/utils/device_utils.dart';

import '../controller/photo_tickets_controller.dart';

/// ⭐ 2026-10-18 票夹页。
///
/// 对齐行影集的票夹：按月份分组、一张票据一张卡（缩略图 + 出发/到达 + 车次 + 时间）。
/// 站名不是每张都能从 OCR 里稳定切出来，切不出来就退回显示「火车票 / 机票」——
/// 宁可不显示，也不摆一个错的站名上去。
class PhotoTicketsView extends StatefulWidget {
  const PhotoTicketsView({super.key});

  @override
  State<PhotoTicketsView> createState() => _PhotoTicketsViewState();
}

class _PhotoTicketsViewState extends State<PhotoTicketsView> {
  late final PhotoTicketsController _ctrl;

  @override
  void initState() {
    super.initState();
    _ctrl = Get.isRegistered<PhotoTicketsController>()
        ? Get.find<PhotoTicketsController>()
        : Get.put(PhotoTicketsController());
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final customColors = theme.extension<CustomColors>();
    return Container(
      color: customColors?.mainContentBgColor ?? theme.scaffoldBackgroundColor,
      child: Obx(() {
        if (_ctrl.loading.value && _ctrl.tickets.isEmpty) {
          return const Center(child: CircularProgressIndicator());
        }
        final err = _ctrl.error.value;
        if (err != null) {
          return _Centered(
            icon: Icons.error_outline,
            title: err,
            actionLabel: 'retry'.tr,
            onAction: _ctrl.load,
          );
        }
        final groups = _ctrl.grouped;
        return CustomScrollView(
          slivers: [
            SliverToBoxAdapter(child: _buildHeader(context)),
            if (_ctrl.degradedReason.value.isNotEmpty)
              SliverToBoxAdapter(child: _buildDegradedBanner(context)),
            if (groups.isEmpty)
              SliverFillRemaining(
                hasScrollBody: false,
                child: _Centered(
                  icon: Icons.receipt_long_outlined,
                  title: 'photo_tickets_empty'.tr,
                  subtitle: 'photo_tickets_empty_hint'.tr,
                ),
              )
            else
              for (final g in groups)
                SliverToBoxAdapter(
                  child: Padding(
                    padding: const EdgeInsets.fromLTRB(24, 18, 24, 0),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          g.label,
                          style: theme.textTheme.titleMedium?.copyWith(
                            fontWeight: FontWeight.w700,
                          ),
                        ),
                        const SizedBox(height: 10),
                        _TicketGrid(
                          items: g.items,
                          titleOf: _ctrl.titleOf,
                          subtitleOf: _ctrl.subtitleOf,
                          onTap: _openTicket,
                        ),
                      ],
                    ),
                  ),
                ),
            const SliverToBoxAdapter(child: SizedBox(height: 28)),
          ],
        );
      }),
    );
  }

  Widget _buildHeader(BuildContext context) {
    final theme = Theme.of(context);
    final muted = theme.colorScheme.onSurfaceVariant;
    final tabs = <({String key, String label})>[
      (key: 'all', label: 'photo_tickets_all'.tr),
      (key: 'train', label: 'photo_tickets_train'.tr),
      (key: 'flight', label: 'photo_tickets_flight'.tr),
      (key: 'ticket_other', label: 'photo_tickets_other'.tr),
    ];
    return Padding(
      padding: const EdgeInsets.fromLTRB(24, 20, 24, 0),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Flexible(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text(
                      'photo_tickets_title'.tr,
                      style: theme.textTheme.headlineSmall?.copyWith(
                        fontWeight: FontWeight.w800,
                        letterSpacing: -0.4,
                      ),
                    ),
                    const SizedBox(height: 2),
                    Text(
                      'photo_tickets_summary'.trParams({
                        'count': '${_ctrl.tickets.length}',
                        'trips': '${_ctrl.trips.length}',
                      }),
                      style: theme.textTheme.bodySmall?.copyWith(color: muted),
                    ),
                  ],
                ),
              ),
              IconButton(
                tooltip: 'refresh'.tr,
                onPressed: _ctrl.load,
                icon: const Icon(Icons.refresh, size: 20),
              ),
            ],
          ),
          const SizedBox(height: 12),
          SingleChildScrollView(
            scrollDirection: Axis.horizontal,
            child: Row(
              children: [
                for (var i = 0; i < tabs.length; i++) ...[
                  _FilterChip(
                    label: tabs[i].label,
                    count: _ctrl.countOf(tabs[i].key),
                    selected: _ctrl.kindFilter.value == tabs[i].key,
                    onTap: () => _ctrl.kindFilter.value = tabs[i].key,
                  ),
                  if (i != tabs.length - 1) const SizedBox(width: 8),
                ],
              ],
            ),
          ),
          const SizedBox(height: 6),
        ],
      ),
    );
  }

  Widget _buildDegradedBanner(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.fromLTRB(24, 10, 24, 0),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
        decoration: BoxDecoration(
          color: theme.colorScheme.errorContainer.withValues(alpha: 0.45),
          borderRadius: BorderRadius.circular(10),
        ),
        child: Row(
          children: [
            Icon(Icons.warning_amber_rounded,
                size: 16, color: theme.colorScheme.onErrorContainer),
            const SizedBox(width: 8),
            Expanded(
              child: Text(
                'photo_tickets_degraded'.tr,
                style: theme.textTheme.bodySmall?.copyWith(
                  color: theme.colorScheme.onErrorContainer,
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  void _openTicket(Map<String, dynamic> t) {
    final path = (t['fullpath'] ?? '').toString();
    if (path.isEmpty) return;
    final images = <Map<String, dynamic>>[
      {
        'type': 'image',
        'path': path,
        'name': (t['filename'] ?? '').toString(),
        'photoId': 0,
      },
    ];
    if (DeviceUtils.isDesktop && Get.isRegistered<PcHomeController>()) {
      Get.find<PcHomeController>().openImageViewer(
        images,
        0,
        deleteHandler: (item, _) async => false,
      );
      return;
    }
    if (!Get.isRegistered<CustomGalleryController>()) {
      Get.put(CustomGalleryController());
    }
    final galleryCtrl = CustomGalleryController.instance;
    galleryCtrl.configure(deleteHandler: (item, _) async => false);
    galleryCtrl.isControlsVisible.value = true;
    galleryCtrl.galleryItems = images;
    galleryCtrl.galleryInitialIndex.value = 0;
    Get.to(() => const CustomGallery());
  }
}

class _FilterChip extends StatelessWidget {
  final String label;
  final int count;
  final bool selected;
  final VoidCallback onTap;

  const _FilterChip({
    required this.label,
    required this.count,
    required this.selected,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(20),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 7),
        decoration: BoxDecoration(
          color: selected
              ? theme.colorScheme.primary.withValues(alpha: 0.10)
              : Colors.transparent,
          borderRadius: BorderRadius.circular(20),
          border: Border.all(
            color: selected
                ? theme.colorScheme.primary.withValues(alpha: 0.35)
                : theme.colorScheme.outlineVariant.withValues(alpha: 0.5),
          ),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(
              label,
              style: theme.textTheme.bodyMedium?.copyWith(
                color: selected
                    ? theme.colorScheme.primary
                    : theme.colorScheme.onSurface,
                fontWeight: selected ? FontWeight.w600 : FontWeight.w400,
              ),
            ),
            const SizedBox(width: 5),
            Text(
              '$count',
              style: theme.textTheme.labelSmall?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _TicketGrid extends StatelessWidget {
  final List<Map<String, dynamic>> items;
  final String Function(Map<String, dynamic>) titleOf;
  final String Function(Map<String, dynamic>) subtitleOf;
  final void Function(Map<String, dynamic>) onTap;

  const _TicketGrid({
    required this.items,
    required this.titleOf,
    required this.subtitleOf,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(
      builder: (context, c) {
        final cols = c.maxWidth >= 1100 ? 3 : (c.maxWidth >= 680 ? 2 : 1);
        const gap = 12.0;
        final width = (c.maxWidth - gap * (cols - 1)) / cols;
        return Wrap(
          spacing: gap,
          runSpacing: gap,
          children: [
            for (final t in items)
              SizedBox(
                width: width,
                child: _TicketCard(
                  item: t,
                  title: titleOf(t),
                  subtitle: subtitleOf(t),
                  onTap: () => onTap(t),
                ),
              ),
          ],
        );
      },
    );
  }
}

class _TicketCard extends StatelessWidget {
  final Map<String, dynamic> item;
  final String title;
  final String subtitle;
  final VoidCallback onTap;

  const _TicketCard({
    required this.item,
    required this.title,
    required this.subtitle,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final path = (item['fullpath'] ?? '').toString();
    final url = path.isEmpty ? '' : ApiController.instance.getTinyUrl(path);
    final kindLabel = (item['kind_label'] ?? '').toString();
    return Material(
      color: theme.colorScheme.surface,
      borderRadius: BorderRadius.circular(12),
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(12),
        child: Container(
          padding: const EdgeInsets.all(10),
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(12),
            border: Border.all(
              color: theme.colorScheme.outlineVariant.withValues(alpha: 0.42),
            ),
          ),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.center,
            children: [
              ClipRRect(
                borderRadius: BorderRadius.circular(8),
                child: SizedBox(
                  width: 56,
                  height: 56,
                  child: url.isEmpty
                      ? ColoredBox(
                          color: theme.colorScheme.surfaceContainerHighest,
                          child: Icon(Icons.receipt_long_outlined,
                              size: 20,
                              color: theme.colorScheme.onSurfaceVariant),
                        )
                      : CustomExtendedImage(imageUrl: url, fit: BoxFit.cover),
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    if (kindLabel.isNotEmpty)
                      Text(
                        kindLabel,
                        style: theme.textTheme.labelSmall?.copyWith(
                          color: theme.colorScheme.onSurfaceVariant,
                        ),
                      ),
                    const SizedBox(height: 2),
                    Text(
                      title,
                      style: theme.textTheme.bodyLarge?.copyWith(
                        fontWeight: FontWeight.w600,
                      ),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                    ),
                    const SizedBox(height: 2),
                    Text(
                      subtitle,
                      style: theme.textTheme.bodySmall?.copyWith(
                        color: theme.colorScheme.onSurfaceVariant,
                      ),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                    ),
                  ],
                ),
              ),
              Icon(Icons.chevron_right,
                  size: 18, color: theme.colorScheme.onSurfaceVariant),
            ],
          ),
        ),
      ),
    );
  }
}

class _Centered extends StatelessWidget {
  final IconData icon;
  final String title;
  final String? subtitle;
  final String? actionLabel;
  final Future<void> Function()? onAction;

  const _Centered({
    required this.icon,
    required this.title,
    this.subtitle,
    this.actionLabel,
    this.onAction,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(icon, size: 38, color: theme.colorScheme.onSurfaceVariant),
            const SizedBox(height: 12),
            Text(title, style: theme.textTheme.bodyLarge),
            if (subtitle != null) ...[
              const SizedBox(height: 6),
              Text(
                subtitle!,
                textAlign: TextAlign.center,
                style: theme.textTheme.bodySmall?.copyWith(
                  color: theme.colorScheme.onSurfaceVariant,
                ),
              ),
            ],
            if (actionLabel != null) ...[
              const SizedBox(height: 14),
              FilledButton.tonal(
                onPressed: onAction == null ? null : () => onAction!(),
                child: Text(actionLabel!),
              ),
            ],
          ],
        ),
      ),
    );
  }
}
