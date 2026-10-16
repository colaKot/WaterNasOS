import 'package:flutter/material.dart';
import 'package:get/get.dart';

import '../../../../core/api/api_controller.dart';
import '../../../../core/theme/custom_colors.dart';
import '../../../../utils/device_utils.dart';
import '../../../../utils/toast_util.dart';
import '../../../base/components/custom_extended_image.dart';
import '../../../gallery/controllers/custom_gallery_controller.dart';
import '../../../gallery/views/custom_gallery.dart';
import '../../../home/views/pc_home_controller.dart';
import '../controller/photo_insight_controller.dart';
import '../../timeline/service/photo_timeline_api_service.dart';
import '../../../../utils/dialog_util.dart';

/// ⭐ 2026-10-16 P1/P2「智能发现」总页面。
///
/// 把这一批只读聚合一次收口到一个页面里：一日一帧 / 票据与行程 / 记忆 / 重复照片 /
/// 年度报告 / 旅程回放 / 模型目录。这样新增发现型能力不用再往左侧栏塞一堆入口。
///
/// 设计约束：
///   · 不引入 TabController（7 个标签用可横向滚动的 chip，切页只切 body，避免 dispose 问题）；
///   · 每个标签页加载一次即缓存（`ensureLoaded`），下拉/按钮才强制刷新；
///   · 看图一律复用 CustomGallery / 桌面看图窗，不自己写查看器。
class PhotoInsightView extends StatefulWidget {
  const PhotoInsightView({super.key});

  @override
  State<PhotoInsightView> createState() => _PhotoInsightViewState();
}

class _PhotoInsightViewState extends State<PhotoInsightView> {
  late final PhotoInsightController _ctrl;

  static const List<({String key, String labelKey, IconData icon})> _tabs = [
    (key: 'day_frame', labelKey: 'photo_insight_day_frame', icon: Icons.auto_awesome_mosaic_outlined),
    (key: 'tickets', labelKey: 'photo_insight_tickets', icon: Icons.receipt_long_outlined),
    (key: 'memories', labelKey: 'photo_insight_memories', icon: Icons.bookmark_border),
    (key: 'duplicates', labelKey: 'photo_insight_duplicates', icon: Icons.content_copy_outlined),
    (key: 'report', labelKey: 'photo_insight_year_report', icon: Icons.bar_chart),
    (key: 'travel', labelKey: 'photo_insight_travel', icon: Icons.route_outlined),
    (key: 'models', labelKey: 'photo_insight_models', icon: Icons.memory),
  ];

  @override
  void initState() {
    super.initState();
    _ctrl = Get.isRegistered<PhotoInsightController>()
        ? Get.find<PhotoInsightController>()
        : Get.put(PhotoInsightController());
    _ctrl.ensureLoaded(_tabs[0].key);
  }

  void _select(int index) {
    _ctrl.tabIndex.value = index;
    _ctrl.ensureLoaded(_tabs[index].key);
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final customColors = theme.extension<CustomColors>();
    return Container(
      color: customColors?.mainContentBgColor,
      child: Column(
        children: [
          _buildTabBar(theme),
          const Divider(height: 1),
          Expanded(
            child: Obx(() {
              final key = _tabs[_ctrl.tabIndex.value.clamp(0, _tabs.length - 1)].key;
              return _buildBody(key);
            }),
          ),
        ],
      ),
    );
  }

  Widget _buildTabBar(ThemeData theme) {
    return Obx(() {
      final current = _ctrl.tabIndex.value;
      return SingleChildScrollView(
        scrollDirection: Axis.horizontal,
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
        child: Row(
          children: [
            for (var i = 0; i < _tabs.length; i++) ...[
              _TabChip(
                icon: _tabs[i].icon,
                label: _tabs[i].labelKey.tr,
                selected: current == i,
                onTap: () => _select(i),
              ),
              if (i != _tabs.length - 1) const SizedBox(width: 6),
            ],
          ],
        ),
      );
    });
  }

  Widget _buildBody(String key) {
    if (_ctrl.isLoading(key)) {
      return const Center(child: CircularProgressIndicator());
    }
    final err = _ctrl.errorOf(key);
    if (err != null) {
      return _EmptyHint(
        icon: Icons.error_outline,
        text: err.isEmpty ? 'operation_failed'.tr : err,
        onRetry: () => _ctrl.reload(key),
      );
    }
    switch (key) {
      case 'day_frame':
        return _buildDayFrames();
      case 'tickets':
        return _buildTickets();
      case 'memories':
        return _buildMemories();
      case 'duplicates':
        return _buildDuplicates();
      case 'report':
        return _buildReport();
      case 'travel':
        return _buildTravel();
      case 'models':
        return _buildModels();
      default:
        return const SizedBox.shrink();
    }
  }

  // ------------------------------------------------------------ 各标签页

  Widget _buildDayFrames() {
    final items = _ctrl.dayFrames;
    if (items.isEmpty) return _EmptyHint(icon: Icons.auto_awesome_mosaic_outlined, text: 'no_data'.tr);
    return _InsightList(
      onRefresh: () => _ctrl.reload('day_frame'),
      children: [
        for (final it in items)
          _InsightRow(
            imagePath: it['fullpath']?.toString() ?? '',
            title: it['date']?.toString() ?? '',
            subtitle: (it['caption']?.toString().isNotEmpty ?? false)
                ? it['caption'].toString()
                : '${it['day_photo_count'] ?? 0} · ${'photo_insight_photos'.tr}',
            trailing: '',
            onTap: () => _openImages([
              {
                'type': 'image',
                'path': it['fullpath']?.toString() ?? '',
                'name': it['filename']?.toString() ?? '',
                'photoId': 0,
              }
            ], 0),
          ),
      ],
    );
  }

  Widget _buildTickets() {
    final trips = _ctrl.trips;
    final tickets = _ctrl.tickets;
    if (trips.isEmpty && tickets.isEmpty) {
      return _EmptyHint(icon: Icons.receipt_long_outlined, text: 'no_data'.tr);
    }
    return _InsightList(
      onRefresh: () => _ctrl.reload('tickets'),
      children: [
        if (trips.isNotEmpty) ...[
          _SectionTitle('${'photo_insight_trips'.tr} (${trips.length})'),
          for (final t in trips)
            _InsightRow(
              icon: Icons.route_outlined,
              title: '${'photo_insight_trip'.tr} ${t['index']}',
              subtitle:
                  '${_shortDate(t['start'])} → ${_shortDate(t['end'])}　·　${t['ticket_count']} ${'photo_insight_ticket_unit'.tr}',
              trailing: ((t['kinds'] as List?) ?? const []).join('/'),
              onTap: null,
            ),
        ],
        if (tickets.isNotEmpty) ...[
          const SizedBox(height: 6),
          _SectionTitle('${'photo_insight_tickets'.tr} (${tickets.length})'),
          for (final t in tickets)
            _InsightRow(
              imagePath: t['fullpath']?.toString() ?? '',
              title: '${t['kind_label'] ?? ''}${(t['train_no']?.toString().isNotEmpty ?? false) ? ' · ${t['train_no']}' : ''}',
              subtitle: '${t['date'] ?? ''}　·　${(t['evidence'] as List?)?.join(' ') ?? ''}',
              trailing: '',
              onTap: () => _openImages([
                {
                  'type': 'image',
                  'path': t['fullpath']?.toString() ?? '',
                  'name': t['filename']?.toString() ?? '',
                  'photoId': 0,
                }
              ], 0),
            ),
        ],
      ],
    );
  }

  Widget _buildMemories() {
    final cands = _ctrl.memoryCandidates;
    final saved = _ctrl.memories;
    if (cands.isEmpty && saved.isEmpty) {
      return _EmptyHint(icon: Icons.bookmark_border, text: 'no_data'.tr);
    }
    return _InsightList(
      onRefresh: () => _ctrl.reload('memories'),
      children: [
        if (saved.isNotEmpty) ...[
          _SectionTitle('${'photo_insight_confirmed'.tr} (${saved.length})'),
          for (final m in saved)
            _InsightRow(
              imagePath: m['cover_path']?.toString() ?? '',
              title: (m['title']?.toString().isNotEmpty ?? false)
                  ? m['title'].toString()
                  : (m['date']?.toString() ?? ''),
              subtitle: '${m['date'] ?? ''}　·　${m['photo_count'] ?? 0} ${'photo_insight_photos'.tr}',
              trailingKey: 'delete',
              onTrailing: () async {
                final ok = await _ctrl.removeMemory(m);
                ToastUtil.show(ok ? 'delete_success'.tr : 'operation_failed'.tr);
              },
            ),
          const SizedBox(height: 6),
        ],
        _SectionTitle('${'photo_insight_candidates'.tr} (${cands.length})'),
        for (final c in cands)
          _InsightRow(
            imagePath: c['cover_path']?.toString() ?? '',
            title: '${c['date'] ?? ''}　${((c['scenes'] as List?) ?? const []).take(2).join(' · ')}',
            subtitle:
                '${c['photo_count'] ?? 0} ${'photo_insight_photos'.tr}　·　${((c['people'] as List?) ?? const []).join('、')}',
            trailingKey: 'confirm',
            onTrailing: () async {
              final ok = await _ctrl.confirmMemory(c);
              ToastUtil.show(ok ? 'photo_insight_confirmed'.tr : 'operation_failed'.tr);
            },
          ),
      ],
    );
  }

  Widget _buildDuplicates() {
    final groups = _ctrl.dupGroups;
    return _InsightList(
      onRefresh: () => _ctrl.reload('duplicates'),
      children: [
        _StatCard(rows: [
          ('photo_insight_groups', '${groups.length}'),
          ('photo_insight_wasted', _bytes(_ctrl.dupWastedBytes.value)),
          ('photo_insight_missing_md5', '${_ctrl.dupMissingMd5.value}'),
        ]),
        if (groups.isEmpty)
          _EmptyHint(icon: Icons.content_copy_outlined, text: 'no_data'.tr)
        else
          for (final g in groups)
            _InsightRow(
              imagePath: ((g['items'] as List?)?.isNotEmpty ?? false)
                  ? ((g['items'] as List).first as Map)['fullpath']?.toString() ?? ''
                  : '',
              title: '${g['count'] ?? 0} × ${((g['items'] as List?)?.isNotEmpty ?? false) ? ((g['items'] as List).first as Map)['filename'] ?? '' : ''}',
              subtitle: '${'photo_insight_wasted'.tr} ${_bytes((g['wasted_bytes'] as num?)?.toInt() ?? 0)}',
              trailing: '',
              trailingKey: 'photo_insight_dedupe',
              onTrailing: () => _cleanupDuplicates(g),
              onTap: () {
                final items = ((g['items'] as List?) ?? const [])
                    .whereType<Map>()
                    .map((e) => <String, dynamic>{
                          'type': 'image',
                          'path': e['fullpath']?.toString() ?? '',
                          'name': e['filename']?.toString() ?? '',
                          'photoId': 0,
                        })
                    .toList();
                if (items.isNotEmpty) _openImages(items, 0);
              },
            ),
      ],
    );
  }

  Widget _buildReport() {
    final r = _ctrl.yearReport.value;
    final year = _ctrl.reportYear.value;
    final empty = r.isEmpty || r['empty'] == true;
    final months = (r['months'] as List?)?.map((e) => (e as num).toInt()).toList() ?? const <int>[];
    final maxMonth = months.isEmpty ? 1 : months.reduce((a, b) => a > b ? a : b);
    return _InsightList(
      onRefresh: () => _ctrl.reload('report'),
      children: [
        SingleChildScrollView(
          scrollDirection: Axis.horizontal,
          child: Row(
            children: [
              for (final y in [year + 0, year - 1, year - 2, year - 3, year - 4])
                Padding(
                  padding: const EdgeInsets.only(right: 6),
                  child: _TabChip(
                    icon: Icons.calendar_today,
                    label: '$y',
                    selected: y == year,
                    onTap: () => _ctrl.setReportYear(y),
                  ),
                ),
            ],
          ),
        ),
        const SizedBox(height: 10),
        if (empty)
          _EmptyHint(icon: Icons.bar_chart, text: 'no_data'.tr)
        else ...[
          _StatCard(rows: [
            ('photo_insight_total', '${r['total'] ?? 0}'),
            ('photo_insight_videos', '${r['videos'] ?? 0}'),
            ('photo_insight_active_days', '${r['active_days'] ?? 0}'),
            ('photo_insight_places', '${r['places'] ?? 0}'),
            ('photo_insight_size', _bytes((r['bytes'] as num?)?.toInt() ?? 0)),
          ]),
          const SizedBox(height: 8),
          if (months.length == 12)
            SizedBox(
              height: 84,
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.end,
                children: [
                  for (var i = 0; i < 12; i++)
                    Expanded(
                      child: Column(
                        mainAxisAlignment: MainAxisAlignment.end,
                        children: [
                          Text(
                            '${months[i]}',
                            style: Theme.of(context).textTheme.labelSmall,
                          ),
                          const SizedBox(height: 2),
                          Container(
                            height: 44 * (months[i] / (maxMonth == 0 ? 1 : maxMonth)),
                            margin: const EdgeInsets.symmetric(horizontal: 2),
                            decoration: BoxDecoration(
                              color: Theme.of(context).colorScheme.primary.withValues(alpha: 0.65),
                              borderRadius: BorderRadius.circular(2),
                            ),
                          ),
                          const SizedBox(height: 2),
                          Text('${i + 1}', style: Theme.of(context).textTheme.labelSmall),
                        ],
                      ),
                    ),
                ],
              ),
            ),
          _KeyedList(titleKey: 'photo_insight_top_scenes', list: r['top_scenes']),
          _KeyedList(titleKey: 'photo_insight_top_activities', list: r['top_activities']),
          _KeyedList(titleKey: 'photo_insight_top_people', list: r['top_people']),
          _KeyedList(titleKey: 'photo_insight_top_cameras', list: r['top_cameras']),
        ],
      ],
    );
  }

  Widget _buildTravel() {
    final visits = _ctrl.visits;
    final lines = _ctrl.travelLines;
    if (visits.isEmpty) return _EmptyHint(icon: Icons.route_outlined, text: 'no_data'.tr);
    return Obx(() {
      final idx = _ctrl.replayIndex.value;
      return _InsightList(
        onRefresh: () => _ctrl.reload('travel'),
        children: [
          Row(
            children: [
              FilledButton.tonalIcon(
                onPressed: _ctrl.toggleReplay,
                icon: Icon(idx >= 0 ? Icons.stop : Icons.play_arrow),
                label: Text(idx >= 0 ? 'photo_insight_stop'.tr : 'play'.tr),
              ),
              const SizedBox(width: 10),
              Text(
                '${visits.length} ${'photo_insight_visits'.tr} · ${lines.length} ${'photo_insight_lines'.tr}',
                style: Theme.of(context).textTheme.bodySmall,
              ),
            ],
          ),
          const SizedBox(height: 8),
          for (var i = 0; i < visits.length; i++)
            _InsightRow(
              icon: idx == i ? Icons.place : Icons.place_outlined,
              title: '${visits[i]['key'] ?? ''}',
              subtitle: '${_shortDate(visits[i]['start'])} → ${_shortDate(visits[i]['end'])}',
              trailing: '${visits[i]['photo_count'] ?? 0}',
              highlight: idx == i,
              onTap: null,
            ),
        ],
      );
    });
  }

  Widget _buildModels() {
    final items = _ctrl.models;
    if (items.isEmpty) return _EmptyHint(icon: Icons.memory, text: 'no_data'.tr);
    return _InsightList(
      onRefresh: () => _ctrl.reload('models'),
      children: [
        for (final m in items)
          _InsightRow(
            icon: Icons.memory,
            title: m['name']?.toString() ?? '',
            subtitle:
                '${m['files'] ?? 0} ${'photo_insight_files'.tr}　·　${_bytes((m['bytes'] as num?)?.toInt() ?? 0)}',
            trailing: m['bundle_id']?.toString() ?? '',
            onTap: null,
          ),
      ],
    );
  }

  // ------------------------------------------------------------ 通用

  /// 复用既有看图器打开一组照片（与相似照片页同一套）。
  void _openImages(List<Map<String, dynamic>> items, int index) {
    final images = items
        .where((e) => (e['path']?.toString() ?? '').isNotEmpty)
        .map((e) => <String, dynamic>{
              'type': e['type'] == 'video' ? 'video' : 'image',
              'path': e['path'],
              'name': e['name'] ?? '',
              'photoId': e['photoId'] ?? 0,
            })
        .toList();
    if (images.isEmpty) return;

    Future<bool> deleteHandler(Map<String, dynamic> item, int _) async => false;

    if (DeviceUtils.isDesktop && Get.isRegistered<PcHomeController>()) {
      Get.find<PcHomeController>().openImageViewer(
        images,
        index.clamp(0, images.length - 1),
        deleteHandler: deleteHandler,
      );
      return;
    }
    if (!Get.isRegistered<CustomGalleryController>()) {
      Get.put(CustomGalleryController());
    }
    final galleryCtrl = CustomGalleryController.instance;
    galleryCtrl.configure(deleteHandler: deleteHandler);
    galleryCtrl.isControlsVisible.value = true;
    galleryCtrl.galleryItems = images;
    galleryCtrl.galleryInitialIndex.value = index.clamp(0, images.length - 1);
    Get.to(() => const CustomGallery());
  }


  /// ⭐ 2026-10-16 P1-16：把一组重复里**保留第一张**，其余走 P0-6 的「预演 → 确认 → 可撤销」通道。
  ///
  /// 为什么不自己写删除：批量写操作必须留下 undo_data 才能撤销（见 docs §10 P0-6）。
  /// 删除只动索引（进回收站），不动用户原始文件。
  Future<void> _cleanupDuplicates(Map<String, dynamic> group) async {
    final items = ((group['items'] as List?) ?? const []).whereType<Map>().toList();
    if (items.length < 2) return;
    final keep = items.first;
    final ids = items
        .skip(1)
        .map((e) => (e['id'] as num?)?.toInt() ?? 0)
        .where((e) => e > 0)
        .toList();
    if (ids.isEmpty) {
      ToastUtil.show('photo_insight_dedupe_no_id'.tr);
      return;
    }
    final api = PhotoTimelineApiService();
    final preview = await api.previewTrash(ids);
    final pv = preview.success ? (preview.data ?? <String, dynamic>{}) : <String, dynamic>{};
    final count = (pv['count'] as num?)?.toInt() ?? ids.length;
    final bytes = (pv['bytes'] as num?)?.toInt() ?? 0;
    final ok = await DialogUtil.showConfirmDialog(
      title: 'photo_delete_preview_title'.tr,
      content: [
        'photo_insight_keep_first'.tr + '：' + '${keep['filename'] ?? ''}',
        'photo_delete_preview_photos'.tr + '：$count',
        'photo_delete_preview_size'.tr + '：${_bytes(bytes)}',
      ].join('\n'),
      confirmText: 'ok'.tr,
      cancelText: 'cancel'.tr,
    );
    if (ok != true) return;

    final res = await api.batchTrashLogged(ids);
    if (!res.success) {
      ToastUtil.show('operation_failed'.tr);
      return;
    }
    final operationId = (res.data?['operationId'] as num?)?.toInt();
    await _ctrl.reload('duplicates');
    if (operationId != null && operationId > 0) {
      Get.snackbar(
        'photo_insight_dedupe'.tr,
        'photo_trashed_success'.tr,
        mainButton: TextButton(
          onPressed: () async {
            final undo = await api.undoOperation(operationId);
            ToastUtil.show(undo.success ? 'photo_undo_done'.tr : 'photo_undo_failed'.tr);
            await _ctrl.reload('duplicates');
          },
          child: Text('photo_undo'.tr),
        ),
        duration: const Duration(seconds: 10),
      );
    } else {
      ToastUtil.show('photo_trashed_success'.tr);
    }
  }

  String _shortDate(dynamic iso) {
    final s = iso?.toString() ?? '';
    if (s.length < 10) return s;
    return s.substring(0, 10);
  }

  String _bytes(int v) {
    if (v <= 0) return '0 B';
    const units = <String>['B', 'KB', 'MB', 'GB', 'TB'];
    double d = v.toDouble();
    int i = 0;
    while (d >= 1024 && i < units.length - 1) {
      d /= 1024;
      i += 1;
    }
    return '${d.toStringAsFixed(d >= 100 || i == 0 ? 0 : 1)} ${units[i]}';
  }
}

class _TabChip extends StatelessWidget {
  final IconData icon;
  final String label;
  final bool selected;
  final VoidCallback onTap;

  const _TabChip({
    required this.icon,
    required this.label,
    required this.selected,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final bg = selected
        ? theme.colorScheme.primary.withValues(alpha: 0.14)
        : theme.colorScheme.surfaceContainerHighest.withValues(alpha: 0.42);
    final fg = selected ? theme.colorScheme.primary : theme.colorScheme.onSurfaceVariant;
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(14),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
        decoration: BoxDecoration(color: bg, borderRadius: BorderRadius.circular(14)),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(icon, size: 14, color: fg),
            const SizedBox(width: 5),
            Text(
              label,
              style: theme.textTheme.bodySmall?.copyWith(
                color: fg,
                fontWeight: selected ? FontWeight.w700 : FontWeight.w400,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _SectionTitle extends StatelessWidget {
  final String text;
  const _SectionTitle(this.text);

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.fromLTRB(2, 10, 2, 4),
      child: Text(text, style: theme.textTheme.titleSmall),
    );
  }
}

class _InsightList extends StatelessWidget {
  final List<Widget> children;
  final Future<void> Function() onRefresh;

  const _InsightList({required this.children, required this.onRefresh});

  @override
  Widget build(BuildContext context) {
    return RefreshIndicator(
      onRefresh: onRefresh,
      child: ListView(
        padding: const EdgeInsets.fromLTRB(10, 10, 10, 20),
        children: children,
      ),
    );
  }
}

class _InsightRow extends StatelessWidget {
  final String imagePath;
  final IconData? icon;
  final String title;
  final String subtitle;
  final String trailing;
  final String? trailingKey;
  final Future<void> Function()? onTrailing;
  final VoidCallback? onTap;
  final bool highlight;

  const _InsightRow({
    this.imagePath = '',
    this.icon,
    required this.title,
    this.subtitle = '',
    this.trailing = '',
    this.trailingKey,
    this.onTrailing,
    this.onTap,
    this.highlight = false,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final url = imagePath.isEmpty ? '' : ApiController.instance.getTinyUrl(imagePath);
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(10),
      child: Container(
        margin: const EdgeInsets.only(bottom: 6),
        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
        decoration: BoxDecoration(
          color: highlight
              ? theme.colorScheme.primary.withValues(alpha: 0.12)
              : theme.colorScheme.surfaceContainerHighest.withValues(alpha: 0.28),
          borderRadius: BorderRadius.circular(10),
        ),
        child: Row(
          children: [
            if (url.isNotEmpty)
              ClipRRect(
                borderRadius: BorderRadius.circular(6),
                child: SizedBox(
                  width: 44,
                  height: 44,
                  child: CustomExtendedImage(imageUrl: url, fit: BoxFit.cover),
                ),
              )
            else
              SizedBox(
                width: 44,
                height: 44,
                child: Icon(
                  icon ?? Icons.image_outlined,
                  size: 20,
                  color: theme.colorScheme.onSurfaceVariant,
                ),
              ),
            const SizedBox(width: 10),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(
                    title,
                    style: theme.textTheme.bodyMedium?.copyWith(fontWeight: FontWeight.w600),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                  ),
                  if (subtitle.isNotEmpty)
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
            if (trailing.isNotEmpty)
              Padding(
                padding: const EdgeInsets.only(left: 6),
                child: Text(
                  trailing,
                  style: theme.textTheme.labelSmall?.copyWith(
                    color: theme.colorScheme.onSurfaceVariant,
                  ),
                ),
              ),
            if (trailingKey != null && onTrailing != null)
              TextButton(
                onPressed: onTrailing,
                child: Text(trailingKey!.tr),
              ),
          ],
        ),
      ),
    );
  }
}

class _StatCard extends StatelessWidget {
  final List<(String, String)> rows;
  const _StatCard({required this.rows});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Container(
      padding: const EdgeInsets.all(10),
      decoration: BoxDecoration(
        color: theme.colorScheme.surfaceContainerHighest.withValues(alpha: 0.35),
        borderRadius: BorderRadius.circular(10),
      ),
      child: Wrap(
        spacing: 18,
        runSpacing: 8,
        children: [
          for (final r in rows)
            Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  r.$2,
                  style: theme.textTheme.titleMedium?.copyWith(
                    fontWeight: FontWeight.w700,
                    color: theme.colorScheme.primary,
                  ),
                ),
                Text(
                  r.$1.tr,
                  style: theme.textTheme.labelSmall?.copyWith(
                    color: theme.colorScheme.onSurfaceVariant,
                  ),
                ),
              ],
            ),
        ],
      ),
    );
  }
}

class _KeyedList extends StatelessWidget {
  final String titleKey;
  final dynamic list;
  const _KeyedList({required this.titleKey, required this.list});

  @override
  Widget build(BuildContext context) {
    final items = (list is List) ? list as List : const [];
    if (items.isEmpty) return const SizedBox.shrink();
    final theme = Theme.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        _SectionTitle(titleKey.tr),
        Wrap(
          spacing: 6,
          runSpacing: 6,
          children: [
            for (final e in items.whereType<Map>())
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                decoration: BoxDecoration(
                  color: theme.colorScheme.surfaceContainerHighest.withValues(alpha: 0.5),
                  borderRadius: BorderRadius.circular(10),
                ),
                child: Text(
                  '${e['name']} · ${e['count']}',
                  style: theme.textTheme.labelSmall,
                ),
              ),
          ],
        ),
      ],
    );
  }
}

class _EmptyHint extends StatelessWidget {
  final IconData icon;
  final String text;
  final Future<void> Function()? onRetry;
  const _EmptyHint({required this.icon, required this.text, this.onRetry});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(icon, size: 34, color: theme.colorScheme.outlineVariant),
          const SizedBox(height: 8),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 24),
            child: Text(
              text,
              textAlign: TextAlign.center,
              style: theme.textTheme.bodySmall?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
              ),
            ),
          ),
          if (onRetry != null) ...[
            const SizedBox(height: 6),
            TextButton(onPressed: onRetry, child: Text('refresh'.tr)),
          ],
        ],
      ),
    );
  }
}
