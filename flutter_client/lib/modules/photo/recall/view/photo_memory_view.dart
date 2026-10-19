import 'package:flutter/material.dart';
import 'package:get/get.dart';
import 'package:WaterNasOS/core/api/api_controller.dart';
import 'package:WaterNasOS/core/theme/custom_colors.dart';
import 'package:WaterNasOS/modules/base/components/custom_extended_image.dart';
import 'package:WaterNasOS/utils/toast_util.dart';

import '../controller/photo_memory_controller.dart';
import 'photo_chapter_book_view.dart';
import 'photo_memory_detail_view.dart';

/// ⭐ 2026-10-18 记忆页。
///
/// 三段结构对齐行影集：人生章节（按年）→ 三态标签（待确认 / 我的记忆 / 已忽略）→ 卡片流。
/// 卡片只做两件事：认领（确认记忆）和放弃（忽略）。真看图还是走共用看图器。
class PhotoMemoryView extends StatefulWidget {
  /// 交给 PhotoHomeView 切页（一日一帧等跳转）
  final void Function(String key)? onNavigate;

  const PhotoMemoryView({super.key, this.onNavigate});

  @override
  State<PhotoMemoryView> createState() => _PhotoMemoryViewState();
}

class _PhotoMemoryViewState extends State<PhotoMemoryView> {
  late final PhotoMemoryController _ctrl;

  /// 当前打开的记忆详情；null = 列表态。
  /// 桌面端没有 Navigator 栈可以 pop（相册是桌面里的一个窗口），
  /// 所以「列表 ⇄ 详情」用本页自己的状态切换，返回按钮也在这页画。
  Map<String, dynamic>? _detail;

  /// 详情来自哪个标签页（0 待确认 / 1 我的记忆 / 2 已忽略）——决定右上角给哪组动作
  int _detailTab = 1;

  /// 当前翻开的人生章节（年份）；null = 没开书
  /// —— 桌面端没有 Navigator 栈，书本和列表同页切换，返回也在这页画。
  int? _bookYear;

  @override
  void initState() {
    super.initState();
    _ctrl = Get.isRegistered<PhotoMemoryController>()
        ? Get.find<PhotoMemoryController>()
        : Get.put(PhotoMemoryController());
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final customColors = theme.extension<CustomColors>();
    final bookYear = _bookYear;
    if (bookYear != null) {
      return PhotoChapterBookView(
        year: bookYear,
        onBack: () => setState(() => _bookYear = null),
      );
    }
    final detail = _detail;
    if (detail != null) {
      final tab = _detailTab;
      return PhotoMemoryDetailView(
        memory: detail,
        onBack: () => setState(() => _detail = null),
        primaryLabel: tab == 0
            ? 'photo_memory_confirm'.tr
            : (tab == 1 ? 'delete'.tr : 'photo_memory_restore'.tr),
        onPrimary: () async {
          if (tab == 0) {
            await _confirm(detail);
          } else if (tab == 1) {
            await _remove(detail);
          } else {
            await _restore(detail);
          }
        },
        secondaryLabel: tab == 0 ? 'photo_memory_ignore'.tr : null,
        onSecondary: tab == 0 ? () => _ignore(detail) : null,
        // ⭐ 2026-10-19 只有「我的记忆」能移出照片；移出后刷新列表计数
        canRemove: tab == 1,
        onChanged: () => _ctrl.refreshQuiet(),
      );
    }
    return Container(
      color: customColors?.mainContentBgColor ?? theme.scaffoldBackgroundColor,
      child: Obx(() {
        if (_ctrl.loading.value && _ctrl.chapters.isEmpty && _ctrl.candidates.isEmpty) {
          return const Center(child: CircularProgressIndicator());
        }
        final err = _ctrl.error.value;
        if (err != null) {
          return _EmptyState(
            icon: Icons.error_outline,
            title: err,
            actionLabel: 'retry'.tr,
            onAction: _ctrl.load,
          );
        }
        return CustomScrollView(
          slivers: [
            SliverToBoxAdapter(child: _buildHeader(context)),
            if (_ctrl.chapters.isNotEmpty)
              SliverToBoxAdapter(child: _buildChapters(context)),
            SliverToBoxAdapter(child: _buildTabs(context)),
            _buildBody(context),
            const SliverToBoxAdapter(child: SizedBox(height: 28)),
          ],
        );
      }),
    );
  }

  // ------------------------------------------------------------------ 头部

  Widget _buildHeader(BuildContext context) {
    final theme = Theme.of(context);
    final muted = theme.colorScheme.onSurfaceVariant;
    return Padding(
      padding: const EdgeInsets.fromLTRB(24, 20, 24, 0),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Flexible(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  'photo_memory_title'.tr,
                  style: theme.textTheme.headlineSmall?.copyWith(
                    fontWeight: FontWeight.w800,
                    letterSpacing: -0.4,
                  ),
                ),
                const SizedBox(height: 2),
                Text(
                  'photo_memory_subtitle'.tr,
                  style: theme.textTheme.bodySmall?.copyWith(color: muted),
                ),
              ],
            ),
          ),
          _HeaderAction(
            icon: Icons.autorenew,
            label: 'photo_memory_discover'.tr,
            onTap: () => _ctrl.load(),
          ),
        ],
      ),
    );
  }

  // ------------------------------------------------------------------ 人生章节

  Widget _buildChapters(BuildContext context) {
    final theme = Theme.of(context);
    final muted = theme.colorScheme.onSurfaceVariant;
    return Padding(
      padding: const EdgeInsets.fromLTRB(24, 22, 0, 0),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Padding(
            padding: const EdgeInsets.only(right: 24),
            child: Row(
              children: [
                Flexible(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Text(
                        'photo_memory_chapters'.tr,
                        style: theme.textTheme.titleMedium
                            ?.copyWith(fontWeight: FontWeight.w700),
                      ),
                      const SizedBox(height: 2),
                      Text(
                        'photo_memory_chapters_sub'.tr,
                        style: theme.textTheme.bodySmall?.copyWith(color: muted),
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(height: 12),
          SizedBox(
            height: 150,
            child: ListView.separated(
              scrollDirection: Axis.horizontal,
              padding: const EdgeInsets.only(right: 24),
              itemCount: _ctrl.chapters.length,
              separatorBuilder: (_, _) => const SizedBox(width: 12),
              itemBuilder: (context, i) {
                final c = _ctrl.chapters[i];
                return _ChapterCard(
                  chapter: c,
                  // ⭐ 2026-10-19 点章节不再只放大封面：翻开的是一整年的书（一页 = 一天）
                  onTap: () {
                    final y = (c['year'] as num?)?.toInt() ?? 0;
                    if (y < 1900) return;
                    setState(() => _bookYear = y);
                  },
                );
              },
            ),
          ),
        ],
      ),
    );
  }

  // ------------------------------------------------------------------ 标签

  Widget _buildTabs(BuildContext context) {
    final theme = Theme.of(context);
    // ⭐ 2026-10-19 已确认的放第一页（用户主要看自己的记忆），未确认的排第二；
    // 有待确认时在「待确认」标签上挂一个红点，别让用户漏掉。
    final tabs = <({String label, int count, int index})>[
      (label: 'photo_memory_tab_mine'.tr, count: _ctrl.memories.length, index: 1),
      (label: 'photo_memory_tab_pending'.tr, count: _ctrl.candidates.length, index: 0),
      (label: 'photo_memory_tab_ignored'.tr, count: _ctrl.ignored.length, index: 2),
    ];
    return Container(
      margin: const EdgeInsets.fromLTRB(24, 22, 24, 0),
      decoration: BoxDecoration(
        border: Border(
          bottom: BorderSide(
            color: theme.colorScheme.outlineVariant.withValues(alpha: 0.5),
          ),
        ),
      ),
      child: Row(
        children: [
          for (final t in tabs)
            InkWell(
              onTap: () => _ctrl.tabIndex.value = t.index,
              child: Container(
                padding: const EdgeInsets.fromLTRB(2, 8, 14, 8),
                decoration: BoxDecoration(
                  border: Border(
                    bottom: BorderSide(
                      width: 2,
                      color: _ctrl.tabIndex.value == t.index
                          ? theme.colorScheme.primary
                          : Colors.transparent,
                    ),
                  ),
                ),
                child: Row(
                  children: [
                    Text(
                      t.label,
                      style: theme.textTheme.bodyMedium?.copyWith(
                        color: _ctrl.tabIndex.value == t.index
                            ? theme.colorScheme.primary
                            : theme.colorScheme.onSurface,
                        fontWeight: _ctrl.tabIndex.value == t.index
                            ? FontWeight.w600
                            : FontWeight.w400,
                      ),
                    ),
                    // ⭐ 未确认的候选 > 0 时挂红点：已确认排到第一页后，
                    // 用户很容易忘记第二页还有东西要处理。
                    if (t.index == 0 && t.count > 0) ...[
                      const SizedBox(width: 5),
                      Container(
                        width: 7,
                        height: 7,
                        decoration: BoxDecoration(
                          color: theme.colorScheme.error,
                          shape: BoxShape.circle,
                        ),
                      ),
                    ],
                    const SizedBox(width: 6),
                    Text(
                      '${t.count}',
                      style: theme.textTheme.labelSmall?.copyWith(
                        color: theme.colorScheme.onSurfaceVariant,
                      ),
                    ),
                  ],
                ),
              ),
            ),
        ],
      ),
    );
  }

  // ------------------------------------------------------------------ 卡片区

  Widget _buildBody(BuildContext context) {
    final idx = _ctrl.tabIndex.value;
    if (idx == 0) {
      final items = _ctrl.candidates;
      if (items.isEmpty) {
        return SliverFillRemaining(
          hasScrollBody: false,
          child: _EmptyState(
            icon: Icons.done_all,
            title: 'photo_memory_empty_pending'.tr,
            subtitle: 'photo_memory_empty_pending_hint'.tr,
          ),
        );
      }
      return _grid(
        count: items.length,
        builder: (i) => _MemoryCard(
          coverPath: (items[i]['cover_path'] ?? '').toString(),
          date: (items[i]['date'] ?? '').toString(),
          photoCount: (items[i]['photo_count'] as num?)?.toInt() ?? 0,
          scenes: _scenesOf(items[i]),
          badge: 'photo_memory_badge_pending'.tr,
          note: 'photo_memory_candidate_note'.trParams({
            'count': '${(items[i]['photo_count'] as num?)?.toInt() ?? 0}',
            'date': _prettyDate((items[i]['date'] ?? '').toString()),
          }),
          primaryLabel: 'photo_memory_confirm'.tr,
          onPrimary: () => _confirm(items[i]),
          secondaryLabel: 'photo_memory_ignore'.tr,
          onSecondary: () => _ignore(items[i]),
          onOpenImage: () => _openDetail(items[i]),
        ),
      );
    }
    if (idx == 1) {
      final items = _ctrl.memories;
      if (items.isEmpty) {
        return SliverFillRemaining(
          hasScrollBody: false,
          child: _EmptyState(
            icon: Icons.bookmark_border,
            title: 'photo_memory_empty_mine'.tr,
            subtitle: 'photo_memory_empty_mine_hint'.tr,
          ),
        );
      }
      return _grid(
        count: items.length,
        builder: (i) => _MemoryCard(
          coverPath: (items[i]['cover_path'] ?? '').toString(),
          date: (items[i]['date'] ?? '').toString(),
          photoCount: (items[i]['photo_count'] as num?)?.toInt() ?? 0,
          scenes: _scenesOf(items[i]),
          badge: null,
          // ⭐ 2026-10-19 不再写「已确认的记忆，点开可以再看一遍」这种废话，
          // 直接给「地点 · 干了什么 · N 张」，一眼就知道这段记忆是什么。
          note: _summaryOf(items[i]),
          primaryLabel: 'photo_memory_open'.tr,
          onPrimary: () => _openDetail(items[i]),
          secondaryLabel: 'delete'.tr,
          onSecondary: () => _remove(items[i]),
          onOpenImage: () => _openDetail(items[i]),
        ),
      );
    }
    final items = _ctrl.ignored;
    if (items.isEmpty) {
      return SliverFillRemaining(
        hasScrollBody: false,
        child: _EmptyState(
          icon: Icons.visibility_off_outlined,
          title: 'photo_memory_empty_ignored'.tr,
        ),
      );
    }
    return _grid(
      count: items.length,
      builder: (i) => _MemoryCard(
        coverPath: (items[i]['cover_path'] ?? '').toString(),
        date: (items[i]['date'] ?? '').toString(),
        photoCount: (items[i]['photo_count'] as num?)?.toInt() ?? 0,
        scenes: _scenesOf(items[i]),
        badge: 'photo_memory_badge_ignored'.tr,
        badgeMuted: true,
        note: 'photo_memory_ignored_note'.tr,
        primaryLabel: 'photo_memory_restore'.tr,
        onPrimary: () => _restore(items[i]),
        onSecondary: null,
        onOpenImage: () => _openDetail(items[i]),
      ),
    );
  }

  Widget _grid({required int count, required Widget Function(int) builder}) {
    return SliverPadding(
      padding: const EdgeInsets.fromLTRB(24, 16, 24, 0),
      sliver: SliverGrid(
        gridDelegate: const SliverGridDelegateWithMaxCrossAxisExtent(
          maxCrossAxisExtent: 380,
          // ⭐ 2026-10-19 摘要变一行短句，卡片不用再留大白框的高度
          mainAxisExtent: 296,
          crossAxisSpacing: 14,
          mainAxisSpacing: 14,
        ),
        delegate: SliverChildBuilderDelegate(
          (context, i) => builder(i),
          childCount: count,
        ),
      ),
    );
  }

  // ------------------------------------------------------------------ 操作

  void _openDetail(Map<String, dynamic> m) {
    setState(() {
      _detail = m;
      _detailTab = _ctrl.tabIndex.value;
    });
  }

  Future<void> _confirm(Map<String, dynamic> c) async {
    final ok = await _ctrl.confirm(c);
    ToastUtil.show(ok ? 'photo_memory_confirm_done'.tr : 'operation_failed'.tr);
  }

  Future<void> _ignore(Map<String, dynamic> c) async {
    final ok = await _ctrl.ignore(c);
    ToastUtil.show(ok ? 'photo_memory_ignore_done'.tr : 'operation_failed'.tr);
  }

  Future<void> _remove(Map<String, dynamic> m) async {
    final ok = await _ctrl.remove((m['key'] ?? '').toString());
    ToastUtil.show(ok ? 'delete_success'.tr : 'operation_failed'.tr);
  }

  Future<void> _restore(Map<String, dynamic> m) async {
    final ok = await _ctrl.restore((m['key'] ?? '').toString());
    ToastUtil.show(ok ? 'photo_memory_restored'.tr : 'operation_failed'.tr);
  }

  List<String> _scenesOf(Map<String, dynamic> m) {
    final raw = m['scenes'];
    if (raw is! List) return const <String>[];
    return raw.map((e) => e.toString()).where((e) => e.isNotEmpty).toList();
  }

  /// 活动标签（比场景更贴近「那天到底干了什么」）
  List<String> _activitiesOf(Map<String, dynamic> m) {
    final raw = m['activities'];
    if (raw is! List) return const <String>[];
    return raw.map((e) => e.toString()).where((e) => e.isNotEmpty).toList();
  }

  /// ⭐ 2026-10-19 记忆的一句话摘要：地点 · 干了什么 · N 张。
  ///
  /// 全部来自真实标签（活动优先，没有就退回场景），**不编故事**；
  /// 地点由服务端按 geohash5 反查后放进 `place`，没有 GPS 的这天就没有这一段。
  String _summaryOf(Map<String, dynamic> m) {
    final place = (m['place'] ?? '').toString().trim();
    final acts = _activitiesOf(m);
    final what = acts.isNotEmpty ? acts : _scenesOf(m);
    final count = (m['photo_count'] as num?)?.toInt() ?? 0;
    final parts = <String>[
      if (place.isNotEmpty) place,
      if (what.isNotEmpty) what.take(2).join(' · '),
      if (count > 0) '$count ${'photo_home_photos_short'.tr}',
    ];
    return parts.join(' · ');
  }
}

// ---------------------------------------------------------------------- 组件

String _prettyDate(String raw) {
  final d = DateTime.tryParse(raw);
  if (d == null) return raw;
  return '${d.year} 年 ${d.month.toString().padLeft(2, '0')} 月 ${d.day.toString().padLeft(2, '0')} 日';
}

class _HeaderAction extends StatelessWidget {
  final IconData icon;
  final String label;
  final VoidCallback onTap;

  const _HeaderAction({
    required this.icon,
    required this.label,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return OutlinedButton.icon(
      onPressed: onTap,
      icon: Icon(icon, size: 16),
      label: Text(label),
      style: OutlinedButton.styleFrom(
        visualDensity: VisualDensity.compact,
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
        side: BorderSide(
          color: theme.colorScheme.outlineVariant.withValues(alpha: 0.6),
        ),
        foregroundColor: theme.colorScheme.onSurface,
      ),
    );
  }
}

class _ChapterCard extends StatelessWidget {
  final Map<String, dynamic> chapter;
  final VoidCallback onTap;

  const _ChapterCard({required this.chapter, required this.onTap});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final path = (chapter['cover_path'] ?? '').toString();
    final url = path.isEmpty ? '' : ApiController.instance.getTinyUrl(path);
    final year = chapter['year']?.toString() ?? '';
    final count = (chapter['photo_count'] as num?)?.toInt() ?? 0;
    final start = (chapter['start'] ?? '').toString();
    final end = (chapter['end'] ?? '').toString();
    return ClipRRect(
      borderRadius: BorderRadius.circular(14),
      child: SizedBox(
        width: 300,
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
              left: 14,
              right: 14,
              bottom: 12,
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: [
                  if (start.isNotEmpty && end.isNotEmpty)
                    Text(
                      '$start — $end',
                      style: theme.textTheme.labelSmall
                          ?.copyWith(color: Colors.white70),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                    ),
                  const SizedBox(height: 2),
                  Text(
                    '$year 年的影像',
                    style: theme.textTheme.titleMedium?.copyWith(
                      color: Colors.white,
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                  const SizedBox(height: 2),
                  Text(
                    '$count ${'photo_home_photos_short'.tr}',
                    style: theme.textTheme.labelSmall
                        ?.copyWith(color: Colors.white70),
                  ),
                ],
              ),
            ),
            Positioned.fill(
              child: Material(
                color: Colors.transparent,
                child: InkWell(onTap: onTap),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _MemoryCard extends StatelessWidget {
  final String coverPath;
  final String date;
  final int photoCount;
  final List<String> scenes;
  final String? badge;
  final bool badgeMuted;
  final String note;
  final String primaryLabel;
  final VoidCallback onPrimary;
  final String? secondaryLabel;
  final VoidCallback? onSecondary;
  final VoidCallback onOpenImage;

  const _MemoryCard({
    required this.coverPath,
    required this.date,
    required this.photoCount,
    required this.scenes,
    required this.badge,
    this.badgeMuted = false,
    required this.note,
    required this.primaryLabel,
    required this.onPrimary,
    this.secondaryLabel,
    this.onSecondary,
    required this.onOpenImage,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final muted = theme.colorScheme.onSurfaceVariant;
    final url = coverPath.isEmpty ? '' : ApiController.instance.getTinyUrl(coverPath);
    return ClipRRect(
      borderRadius: BorderRadius.circular(14),
      child: DecoratedBox(
        decoration: BoxDecoration(
          color: theme.colorScheme.surface,
          borderRadius: BorderRadius.circular(14),
          border: Border.all(
            color: theme.colorScheme.outlineVariant.withValues(alpha: 0.42),
          ),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            SizedBox(
              height: 132,
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
                  if (badge != null)
                    Positioned(
                      right: 8,
                      top: 8,
                      child: Container(
                        padding: const EdgeInsets.symmetric(
                            horizontal: 8, vertical: 3),
                        decoration: BoxDecoration(
                          color: badgeMuted
                              ? Colors.black.withValues(alpha: 0.5)
                              : theme.colorScheme.surface.withValues(alpha: 0.92),
                          borderRadius: BorderRadius.circular(20),
                        ),
                        child: Text(
                          badge!,
                          style: theme.textTheme.labelSmall?.copyWith(
                            color: badgeMuted
                                ? Colors.white
                                : theme.colorScheme.primary,
                            fontWeight: FontWeight.w600,
                          ),
                        ),
                      ),
                    ),
                  Positioned.fill(
                    child: Material(
                      color: Colors.transparent,
                      child: InkWell(onTap: onOpenImage),
                    ),
                  ),
                ],
              ),
            ),
            Expanded(
              child: Padding(
                padding: const EdgeInsets.fromLTRB(12, 10, 12, 10),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      _prettyDate(date),
                      style: theme.textTheme.bodyMedium
                          ?.copyWith(fontWeight: FontWeight.w700),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                    ),
                    const SizedBox(height: 3),
                    Text(
                      [
                        '$photoCount ${'photo_home_photos_short'.tr}',
                        if (scenes.isNotEmpty) scenes.take(3).join(' · '),
                      ].join(' · '),
                      style: theme.textTheme.labelSmall?.copyWith(color: muted),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                    ),
                    const SizedBox(height: 8),
                    Expanded(
                      child: Container(
                        width: double.infinity,
                        padding:
                            const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
                        decoration: BoxDecoration(
                          color: theme.colorScheme.surfaceContainerHighest
                              .withValues(alpha: 0.4),
                          borderRadius: BorderRadius.circular(8),
                        ),
                        child: Text(
                          note,
                          style: theme.textTheme.labelSmall
                              ?.copyWith(color: muted, height: 1.4),
                          maxLines: 2,
                          overflow: TextOverflow.ellipsis,
                        ),
                      ),
                    ),
                    const SizedBox(height: 8),
                    Row(
                      children: [
                        Expanded(
                          child: SizedBox(
                            height: 32,
                            child: FilledButton(
                              onPressed: onPrimary,
                              style: FilledButton.styleFrom(
                                padding: EdgeInsets.zero,
                                visualDensity: VisualDensity.compact,
                                textStyle: theme.textTheme.bodySmall,
                              ),
                              child: Text(primaryLabel),
                            ),
                          ),
                        ),
                        if (secondaryLabel != null) ...[
                          const SizedBox(width: 8),
                          SizedBox(
                            height: 32,
                            child: OutlinedButton(
                              onPressed: onSecondary,
                              style: OutlinedButton.styleFrom(
                                padding: const EdgeInsets.symmetric(horizontal: 10),
                                visualDensity: VisualDensity.compact,
                                textStyle: theme.textTheme.bodySmall,
                                side: BorderSide(
                                  color: theme.colorScheme.outlineVariant
                                      .withValues(alpha: 0.7),
                                ),
                                foregroundColor:
                                    theme.colorScheme.onSurfaceVariant,
                              ),
                              child: Text(secondaryLabel!),
                            ),
                          ),
                        ],
                      ],
                    ),
                  ],
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _EmptyState extends StatelessWidget {
  final IconData icon;
  final String title;
  final String? subtitle;
  final String? actionLabel;
  final Future<void> Function()? onAction;

  const _EmptyState({
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
