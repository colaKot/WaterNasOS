import 'package:flutter/material.dart';
import 'package:get/get.dart';
import 'package:WaterNasOS/core/api/api_controller.dart';
import 'package:WaterNasOS/core/theme/custom_colors.dart';
import 'package:WaterNasOS/modules/base/components/custom_extended_image.dart';
import 'package:WaterNasOS/modules/gallery/controllers/custom_gallery_controller.dart';
import 'package:WaterNasOS/modules/gallery/views/custom_gallery.dart';
import 'package:WaterNasOS/modules/home/views/pc_home_controller.dart';
import 'package:WaterNasOS/utils/device_utils.dart';

import '../../photo_main/controller/photo_home_controller.dart';
import '../../search/view/photo_search_overlay.dart';
import '../controller/photo_dashboard_controller.dart';
import 'parts/dashboard_cards.dart';

/// ⭐ 2026-10-18 相册「首页」看板。
///
/// 相册原来一进来就是时间线：能翻到照片，但看不到「这一整库照片长什么样」。
/// 这一页照行影集的首页节拍排：那年今日 → 新的记忆 → 我的照片 → 拍摄时光 →
/// 足迹 / 人物，每块都能点进对应功能页。
///
/// 数据只打两个接口（home_summary + memories），失败互不影响；
/// 看图一律复用既有的桌面看图窗 / CustomGallery，不自己写查看器。
class PhotoDashboardView extends StatefulWidget {
  /// 交给外层（PhotoHomeView）切页；首页上的所有跳转都走它，避免自己 push 出嵌套页面。
  final void Function(String key)? onNavigate;

  const PhotoDashboardView({super.key, this.onNavigate});

  @override
  State<PhotoDashboardView> createState() => _PhotoDashboardViewState();
}

class _PhotoDashboardViewState extends State<PhotoDashboardView> {
  late final PhotoDashboardController _ctrl;

  @override
  void initState() {
    super.initState();
    _ctrl = Get.isRegistered<PhotoDashboardController>()
        ? Get.find<PhotoDashboardController>()
        : Get.put(PhotoDashboardController());
  }

  void _go(String key) => widget.onNavigate?.call(key);

  /// 搜索提交 → 跳到时间轴并按该关键词搜（关键词存在 PhotoHomeController 里带走）
  void _submitSearch(String query) {
    final q = query.trim();
    if (q.isEmpty) return;
    if (Get.isRegistered<PhotoHomeController>()) {
      Get.find<PhotoHomeController>().openSearch(q);
    } else {
      _go('all.timeline');
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final customColors = theme.extension<CustomColors>();
    return Container(
      color: customColors?.mainContentBgColor ?? theme.scaffoldBackgroundColor,
      child: Obx(() {
        if (_ctrl.loading.value && _ctrl.summary.isEmpty) {
          return const Center(child: CircularProgressIndicator());
        }
        final err = _ctrl.error.value;
        if (err != null && _ctrl.summary.isEmpty) {
          return _HomeError(message: err, onRetry: _ctrl.load);
        }
        return RefreshIndicator(
          onRefresh: _ctrl.load,
          child: SingleChildScrollView(
            physics: const AlwaysScrollableScrollPhysics(),
            padding: const EdgeInsets.fromLTRB(20, 18, 20, 28),
            child: Center(
              child: ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 1240),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    _PageHeader(
                      onRefresh: _ctrl.load,
                      onSettings: () => _go('settings.source'),
                    ),
                    const SizedBox(height: 14),
                    // ⭐ 2026-10-19 首页大搜索栏：和时间轴那条是同一个搜索浮层
                    // （推荐词 + 联想 + 最近搜索），只是尺寸给大一点、放在最上面。
                    _BigSearchBar(onSubmit: _submitSearch),
                    const SizedBox(height: 18),
                    _OnThisDaySection(
                      items: _ctrl.onThisDay,
                      onOpen: _openItem,
                      onViewAll: () => _go('all.the_day'),
                    ),
                    const SizedBox(height: kHomeGap),
                    _NewMemorySection(
                      items: _ctrl.memoryCandidates.take(3).toList(),
                      onOpen: _openMemory,
                      onViewAll: () => _go('ai.insight'),
                    ),
                    const SizedBox(height: kHomeGap),
                    _PromptBar(
                      // ⭐ 2026-10-19 三个入口各给一个能画出来的图标 + 独立色调：
                      //   原先用的 bolt / location_city_outlined 在线上构建里是空白方框
                      //   （图标字体子集里没有这两个字形），改用全局已大量使用、确认在
                      //   字体子集内的 event_outlined / place_outlined。
                      icon: Icons.event_outlined,
                      tint: Colors.teal,
                      title: 'photo_home_keep_moment'.tr,
                      subtitle: 'photo_home_keep_moment_sub'.tr,
                      onTap: () => _go('all.the_day'),
                    ),
                    const SizedBox(height: 10),
                    _PromptBar(
                      icon: Icons.movie_filter_outlined,
                      title: 'photo_home_year_recap'.tr,
                      subtitle: 'photo_home_year_recap_sub'
                          .trParams({'year': '${_ctrl.latestYear}'}),
                      accent: true,
                      onTap: () => _go('ai.insight'),
                    ),
                    const SizedBox(height: 10),
                    _PromptBar(
                      icon: Icons.place_outlined,
                      tint: Colors.orange,
                      title: 'photo_home_explore_city'.tr,
                      subtitle: 'photo_home_explore_city_sub'.tr,
                      onTap: () => _go('all.footprint'),
                    ),
                    const SizedBox(height: 18),
                    LibraryStatCard(
                      photos: _ctrl.photoCount,
                      videos: _ctrl.videoCount,
                      todayNew: _ctrl.todayNew,
                      totalBytes: _ctrl.totalBytes,
                      onViewStorage: () => _go('all.file_view'),
                    ),
                    const SizedBox(height: kHomeGap),
                    ShotTimeCard(
                      days: _ctrl.heatDays,
                      years: _ctrl.heatYears,
                      total: _ctrl.heatTotal,
                      activeDays: _ctrl.heatActiveDays,
                      peakYear: _ctrl.peakMonth.year,
                      peakMonth: _ctrl.peakMonth.month,
                      peakMonthCount: _ctrl.peakMonth.count,
                    ),
                    const SizedBox(height: kHomeGap),
                    LayoutBuilder(
                      builder: (context, c) {
                        if (c.maxWidth < 860) {
                          return Column(
                            children: [
                              FootprintCard(
                                cities: _ctrl.cityCount,
                                places: _ctrl.placeCount,
                                days: _ctrl.footprintDays,
                                onView: () => _go('all.footprint'),
                              ),
                              const SizedBox(height: kHomeGap),
                              PeopleCard(
                                items: _ctrl.topPeople,
                                pending: _ctrl.pendingFaces,
                                onViewAll: () => _go('ai.face'),
                                onConfirm: () => _go('ai.face'),
                              ),
                            ],
                          );
                        }
                        return Row(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Expanded(
                              child: FootprintCard(
                                cities: _ctrl.cityCount,
                                places: _ctrl.placeCount,
                                days: _ctrl.footprintDays,
                                onView: () => _go('all.footprint'),
                              ),
                            ),
                            const SizedBox(width: kHomeGap),
                            Expanded(
                              child: PeopleCard(
                                items: _ctrl.topPeople,
                                pending: _ctrl.pendingFaces,
                                onViewAll: () => _go('ai.face'),
                                onConfirm: () => _go('ai.face'),
                              ),
                            ),
                          ],
                        );
                      },
                    ),
                  ],
                ),
              ),
            ),
          ),
        );
      }),
    );
  }

  /// 打开一组图片（桌面走既有看图窗，移动端走 CustomGallery）。
  void _openItem(String path, String name) {
    if (path.isEmpty) return;
    final images = <Map<String, dynamic>>[
      {'type': 'image', 'path': path, 'name': name, 'photoId': 0},
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

  void _openMemory(Map<String, dynamic> memory) {
    _openItem(
      (memory['cover_path'] ?? '').toString(),
      (memory['title'] ?? '').toString(),
    );
  }
}

/// 首页顶部的大搜索框：只是入口，点开还是那个共用的搜索浮层。
class _BigSearchBar extends StatelessWidget {
  final void Function(String query) onSubmit;

  const _BigSearchBar({required this.onSubmit});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    return InkWell(
      onTap: () => showPhotoSearchOverlay(context, onSubmit: onSubmit),
      borderRadius: BorderRadius.circular(18),
      child: Container(
        height: 54,
        padding: const EdgeInsets.symmetric(horizontal: 18),
        decoration: BoxDecoration(
          color: scheme.surface,
          borderRadius: BorderRadius.circular(18),
          border: Border.all(
            color: scheme.outlineVariant.withValues(alpha: 0.55),
          ),
          boxShadow: [
            BoxShadow(
              color: Colors.black.withValues(alpha: 0.04),
              blurRadius: 12,
              offset: const Offset(0, 3),
            ),
          ],
        ),
        child: Row(
          children: [
            Icon(Icons.search, size: 22, color: scheme.onSurfaceVariant),
            const SizedBox(width: 12),
            Expanded(
              child: Text(
                'photo_search_hint_full'.tr,
                style: theme.textTheme.bodyMedium?.copyWith(
                  color: scheme.onSurfaceVariant,
                ),
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
              ),
            ),
            const SizedBox(width: 10),
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
              decoration: BoxDecoration(
                color: scheme.primary.withValues(alpha: 0.1),
                borderRadius: BorderRadius.circular(20),
              ),
              child: Row(
                children: [
                  Icon(Icons.auto_awesome, size: 13, color: scheme.primary),
                  const SizedBox(width: 4),
                  Text(
                    'AI',
                    style: theme.textTheme.labelSmall?.copyWith(
                      color: scheme.primary,
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _PageHeader extends StatelessWidget {
  final Future<void> Function() onRefresh;
  final VoidCallback onSettings;

  const _PageHeader({required this.onRefresh, required this.onSettings});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Row(
      crossAxisAlignment: CrossAxisAlignment.center,
      children: [
        Flexible(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(
                'photo_home_title'.tr,
                style: theme.textTheme.headlineSmall?.copyWith(
                  fontWeight: FontWeight.w800,
                  letterSpacing: -0.4,
                ),
              ),
              const SizedBox(height: 2),
              Text(
                'photo_home_subtitle'.tr,
                style: theme.textTheme.bodySmall?.copyWith(
                  color: theme.colorScheme.onSurfaceVariant,
                ),
              ),
            ],
          ),
        ),
        IconButton(
          tooltip: 'refresh'.tr,
          onPressed: () => onRefresh(),
          icon: const Icon(Icons.refresh, size: 20),
        ),
        IconButton(
          tooltip: 'settings_source'.tr,
          onPressed: onSettings,
          icon: const Icon(Icons.folder_special_outlined, size: 20),
        ),
      ],
    );
  }
}

/// 那年今日：往年同月同日按年各一张，最多 3 张横排（中间那张给更大权重）。
class _OnThisDaySection extends StatelessWidget {
  final List<Map<String, dynamic>> items;
  final void Function(String path, String name) onOpen;
  final VoidCallback onViewAll;

  const _OnThisDaySection({
    required this.items,
    required this.onOpen,
    required this.onViewAll,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    if (items.isEmpty) {
      return HomeCard(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            HomeSectionTitle(
              title: 'photo_home_on_this_day'.tr,
              subtitle: 'photo_home_on_this_day_sub'.tr,
              icon: Icons.history,
            ),
            const SizedBox(height: 14),
            Container(
              height: 120,
              alignment: Alignment.center,
              decoration: BoxDecoration(
                color: theme.colorScheme.surfaceContainerHighest
                    .withValues(alpha: 0.35),
                borderRadius: BorderRadius.circular(12),
              ),
              child: Text(
                'photo_home_no_on_this_day'.tr,
                style: theme.textTheme.bodySmall?.copyWith(
                  color: theme.colorScheme.onSurfaceVariant,
                ),
              ),
            ),
          ],
        ),
      );
    }
    final list = items.take(3).toList();
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        HomeSectionTitle(
          title: 'photo_home_on_this_day'.tr,
          subtitle: 'photo_home_on_this_day_sub'.tr,
          icon: Icons.history,
          actionLabel: 'photo_home_view_all'.tr,
          onAction: onViewAll,
        ),
        const SizedBox(height: 10),
        SizedBox(
          height: 232,
          child: Row(
            children: [
              for (var i = 0; i < list.length; i++) ...[
                if (i > 0) const SizedBox(width: 10),
                Expanded(
                  flex: list.length == 3 ? (i == 1 ? 4 : 3) : 1,
                  child: _HeroTile(
                    path: (list[i]['fullpath'] ?? '').toString(),
                    name: (list[i]['filename'] ?? '').toString(),
                    year: (list[i]['year'] as num?)?.toInt() ?? 0,
                    date: (list[i]['date'] ?? '').toString(),
                    count: (list[i]['photo_count'] as num?)?.toInt() ?? 0,
                    onTap: () => onOpen(
                      (list[i]['fullpath'] ?? '').toString(),
                      (list[i]['filename'] ?? '').toString(),
                    ),
                  ),
                ),
              ],
            ],
          ),
        ),
      ],
    );
  }
}

class _HeroTile extends StatelessWidget {
  final String path;
  final String name;
  final int year;
  final String date;
  final int count;
  final VoidCallback onTap;

  const _HeroTile({
    required this.path,
    required this.name,
    required this.year,
    required this.date,
    required this.count,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final url = path.isEmpty ? '' : ApiController.instance.getTinyUrl(path);
    return ClipRRect(
      borderRadius: BorderRadius.circular(14),
      child: Stack(
        fit: StackFit.expand,
        children: [
          if (url.isEmpty)
            ColoredBox(
              color: theme.colorScheme.surfaceContainerHighest,
              child: Icon(Icons.image_outlined,
                  color: theme.colorScheme.onSurfaceVariant),
            )
          else
            CustomExtendedImage(imageUrl: url, fit: BoxFit.cover),
          // 底部渐变保证白字在亮图上也能读
          const DecoratedBox(
            decoration: BoxDecoration(
              gradient: LinearGradient(
                begin: Alignment.topCenter,
                end: Alignment.bottomCenter,
                colors: [Colors.transparent, Colors.black54],
                stops: [0.45, 1.0],
              ),
            ),
          ),
          Positioned(
            left: 14,
            right: 14,
            bottom: 12,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  '$year 年',
                  style: theme.textTheme.labelSmall?.copyWith(
                    color: Colors.white70,
                    fontWeight: FontWeight.w600,
                  ),
                ),
                const SizedBox(height: 2),
                Text(
                  _prettyDate(date),
                  style: theme.textTheme.titleSmall?.copyWith(
                    color: Colors.white,
                    fontWeight: FontWeight.w700,
                  ),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
                const SizedBox(height: 2),
                Row(
                  children: [
                    const Icon(Icons.camera_alt_outlined,
                        size: 11, color: Colors.white70),
                    const SizedBox(width: 4),
                    Text(
                      '$count ${'photo_home_photos_short'.tr}',
                      style: theme.textTheme.labelSmall
                          ?.copyWith(color: Colors.white70),
                    ),
                  ],
                ),
              ],
            ),
          ),
          Positioned.fill(
            child: Material(
              color: Colors.transparent,
              child: InkWell(
                onTap: onTap,
                hoverColor: Colors.white.withValues(alpha: 0.06),
              ),
            ),
          ),
        ],
      ),
    );
  }

  String _prettyDate(String raw) {
    final d = DateTime.tryParse(raw);
    if (d == null) return raw;
    return '${d.year}年${d.month}月${d.day}日';
  }
}

/// 发现新的记忆：候选事件前 3 条，卡片式横排。
class _NewMemorySection extends StatelessWidget {
  final List<Map<String, dynamic>> items;
  final void Function(Map<String, dynamic> memory) onOpen;
  final VoidCallback onViewAll;

  const _NewMemorySection({
    required this.items,
    required this.onOpen,
    required this.onViewAll,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return HomeCard(
      padding: const EdgeInsets.fromLTRB(18, 16, 18, 18),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          HomeSectionTitle(
            title: 'photo_home_new_memory'.tr,
            subtitle: 'photo_home_new_memory_sub'.tr,
            icon: Icons.auto_awesome,
            actionLabel: 'photo_home_view_all'.tr,
            onAction: onViewAll,
          ),
          const SizedBox(height: 12),
          if (items.isEmpty)
            Text(
              'photo_home_no_new_memory'.tr,
              style: theme.textTheme.bodySmall?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
              ),
            )
          else
            SizedBox(
              height: 176,
              child: Row(
                children: [
                  for (var i = 0; i < items.length; i++) ...[
                    if (i > 0) const SizedBox(width: 12),
                    Expanded(child: _MemoryTile(item: items[i], onTap: () => onOpen(items[i]))),
                  ],
                ],
              ),
            ),
        ],
      ),
    );
  }
}

class _MemoryTile extends StatelessWidget {
  final Map<String, dynamic> item;
  final VoidCallback onTap;

  const _MemoryTile({required this.item, required this.onTap});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final cover = (item['cover_path'] ?? '').toString();
    final url = cover.isEmpty ? '' : ApiController.instance.getTinyUrl(cover);
    final date = (item['date'] ?? '').toString();
    final count = (item['photo_count'] as num?)?.toInt() ?? 0;
    final scenes = ((item['scenes'] as List?) ?? const []).join(' · ');
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Expanded(
            child: ClipRRect(
              borderRadius: BorderRadius.circular(12),
              child: url.isEmpty
                  ? ColoredBox(
                      color: theme.colorScheme.surfaceContainerHighest,
                      child: Icon(Icons.image_outlined,
                          color: theme.colorScheme.onSurfaceVariant),
                    )
                  : CustomExtendedImage(imageUrl: url, fit: BoxFit.cover),
            ),
          ),
          const SizedBox(height: 8),
          Text(
            _prettyDate(date),
            style: theme.textTheme.bodyMedium
                ?.copyWith(fontWeight: FontWeight.w600),
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
          ),
          const SizedBox(height: 2),
          Text(
            count > 0
                ? '$count ${'photo_home_photos_short'.tr}${scenes.isEmpty ? '' : ' · $scenes'}'
                : scenes,
            style: theme.textTheme.labelSmall?.copyWith(
              color: theme.colorScheme.onSurfaceVariant,
            ),
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
          ),
        ],
      ),
    );
  }

  String _prettyDate(String raw) {
    final d = DateTime.tryParse(raw);
    if (d == null) return raw;
    return '${d.year} 年 ${d.month.toString().padLeft(2, '0')} 月 ${d.day.toString().padLeft(2, '0')} 日';
  }
}

/// 窄条引导（为今天留一个瞬间 / 年度回忆录 / 踏城市）。
class _PromptBar extends StatelessWidget {
  final IconData icon;
  final String title;
  final String subtitle;
  final bool accent;

  /// 非 accent 时的强调色（图标 + 图标底色）。null = 跟随 onSurface。
  final Color? tint;
  final VoidCallback onTap;

  const _PromptBar({
    required this.icon,
    required this.title,
    required this.subtitle,
    required this.onTap,
    this.accent = false,
    this.tint,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final bg = accent
        ? theme.colorScheme.primary.withValues(alpha: 0.08)
        : theme.colorScheme.surface;
    final fg = accent
        ? theme.colorScheme.primary
        : (tint ?? theme.colorScheme.onSurface);
    return Material(
      color: bg,
      borderRadius: BorderRadius.circular(14),
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(14),
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 13),
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(14),
            border: Border.all(
              color: accent
                  ? theme.colorScheme.primary.withValues(alpha: 0.18)
                  : theme.colorScheme.outlineVariant.withValues(alpha: 0.42),
            ),
          ),
          child: Row(
            children: [
              Container(
                width: 30,
                height: 30,
                decoration: BoxDecoration(
                  color: fg.withValues(alpha: 0.10),
                  borderRadius: BorderRadius.circular(9),
                ),
                child: Icon(icon, size: 16, color: fg),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text(
                      title,
                      style: theme.textTheme.bodyMedium?.copyWith(
                        fontWeight: FontWeight.w600,
                        color: fg,
                      ),
                    ),
                    const SizedBox(height: 1),
                    Text(
                      subtitle,
                      style: theme.textTheme.labelSmall?.copyWith(
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

class _HomeError extends StatelessWidget {
  final String message;
  final Future<void> Function() onRetry;

  const _HomeError({required this.message, required this.onRetry});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(Icons.error_outline,
              size: 36, color: theme.colorScheme.onSurfaceVariant),
          const SizedBox(height: 10),
          Text(message, style: theme.textTheme.bodyMedium),
          const SizedBox(height: 12),
          FilledButton.tonal(
            onPressed: () => onRetry(),
            child: Text('retry'.tr),
          ),
        ],
      ),
    );
  }
}
