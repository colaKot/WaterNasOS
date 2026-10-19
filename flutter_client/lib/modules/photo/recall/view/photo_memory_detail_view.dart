import 'package:flutter/material.dart';
import 'package:get/get.dart';
import 'package:WaterNasOS/core/api/api_controller.dart';
import 'package:WaterNasOS/core/theme/custom_colors.dart';
import 'package:WaterNasOS/modules/base/components/custom_extended_image.dart';
import 'package:WaterNasOS/modules/photo/shared/photo_viewer_helper.dart';
import 'package:WaterNasOS/utils/toast_util.dart';

import '../../ai_setting/service/photo_ai_settings_api_service.dart';

/// ⭐ 2026-10-19 记忆详情页（记忆列表 → 详情 → 单张放大）。
///
/// 之前卡片点一下就直接 `openSinglePhoto`，只能看封面那一张 —— 一段「那天拍了 30 张」
/// 的记忆等于丢了 29 张。现在先进这一页：封面 + 备注 + 按天分组的照片时间线，
/// 点其中任意一张才进看图器，而且传的是**整组**，左右键/左右滑动都能翻。
///
/// ⭐ 2026-10-19 追加：把照片**移出记忆**。
///   · 右击任意一张 → 弹出菜单（移出这一张 / 进入多选）；
///   · 多选：长按进多选，或点右上角「多选」，右下角统一「移出记忆（n）」；
///   · 只改记忆的 exclude_hashes，**原图不删**，相册里照样在。
class PhotoMemoryDetailView extends StatefulWidget {
  /// 列表卡片的原始数据（key / date / title / note / photo_count / cover_path / scenes）
  final Map<String, dynamic> memory;

  /// 返回上一级（由 PhotoMemoryView 控制，桌面端没有 Navigator 栈可回）
  final VoidCallback onBack;

  /// 主操作（待确认=「确定」/ 已确认=「删除」/ 已忽略=「恢复」）
  final String? primaryLabel;
  final Future<void> Function()? onPrimary;

  /// 次操作（只有待确认有「忽略」）
  final String? secondaryLabel;
  final Future<void> Function()? onSecondary;

  /// ⭐ 只有「我的记忆」（已确认）允许移出照片：候选还没落库，移出了也没处存
  final bool canRemove;

  /// 移出成功后通知列表刷新（卡片张数变了）
  final VoidCallback? onChanged;

  const PhotoMemoryDetailView({
    super.key,
    required this.memory,
    required this.onBack,
    this.primaryLabel,
    this.onPrimary,
    this.secondaryLabel,
    this.onSecondary,
    this.canRemove = false,
    this.onChanged,
  });

  @override
  State<PhotoMemoryDetailView> createState() => _PhotoMemoryDetailViewState();
}

class _PhotoMemoryDetailViewState extends State<PhotoMemoryDetailView> {
  bool _loading = true;
  String? _error;
  List<Map<String, dynamic>> _items = const <Map<String, dynamic>>[];

  /// 多选态：勾中的 file_hash（后端按 file_hash 记住「移出」了哪几张）
  bool _selectMode = false;
  final Set<String> _selected = <String>{};
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final key = (widget.memory['key'] ?? '').toString();
    final date = (widget.memory['date'] ?? '').toString();
    if (key.isEmpty || date.isEmpty) {
      setState(() => _loading = false);
      return;
    }
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final res = await PhotoAiSettingsApiService.instance
          .getMemoryPhotos(key, date: date);
      if (!mounted) return;
      if (!res.success || res.data == null) {
        setState(() {
          _error = 'operation_failed'.tr;
          _items = const <Map<String, dynamic>>[];
          _loading = false;
        });
        return;
      }
      final raw = res.data!['items'];
      setState(() {
        _items = raw is List
            ? [
                for (final e in raw)
                  if (e is Map) e.cast<String, dynamic>(),
              ]
            : const <Map<String, dynamic>>[];
        _selected.removeWhere((h) => !_hashSet().contains(h));
        _loading = false;
      });
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _error = 'operation_failed'.tr;
        _loading = false;
      });
    }
  }

  Set<String> _hashSet() => _items
      .map((e) => (e['file_hash'] ?? '').toString())
      .where((e) => e.isNotEmpty)
      .toSet();

  /// 把当前这一组照片整组丢给看图器（左右键/滑动翻页由看图器负责）
  void _openAt(int index) {
    final photos = <Map<String, dynamic>>[
      for (final it in _items)
        {
          'type': (it['type'] as num?)?.toInt() == 2 ? 'video' : 'image',
          'path': (it['fullpath'] ?? '').toString(),
          'name': (it['filename'] ?? '').toString(),
          'photoId': 0,
        },
    ];
    if (photos.isEmpty) return;
    openPhotoImages(photos, index);
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final customColors = theme.extension<CustomColors>();
    return Container(
      color: customColors?.mainContentBgColor ?? theme.scaffoldBackgroundColor,
      child: Stack(
        children: [
          CustomScrollView(
            slivers: [
              SliverToBoxAdapter(child: _buildHeader(context)),
              SliverToBoxAdapter(child: _buildCover(context)),
              if (_noteText.isNotEmpty)
                SliverToBoxAdapter(child: _buildNote(context)),
              SliverToBoxAdapter(child: _buildTimelineTitle(context)),
              ..._buildBody(context),
              // 多选时给底部操作条留位置，别让最后一行照片被盖住
              SliverToBoxAdapter(child: SizedBox(height: _selectMode ? 84 : 28)),
            ],
          ),
          // ⭐ 右下角：统一移出
          if (_selectMode)
            Positioned(left: 0, right: 0, bottom: 0, child: _buildSelectBar(context)),
          if (_busy)
            Positioned.fill(
              child: ColoredBox(
                color: scheme.scrim.withValues(alpha: 0.12),
                child: const Center(child: CircularProgressIndicator()),
              ),
            ),
        ],
      ),
    );
  }

  Widget _buildHeader(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    return Padding(
      padding: const EdgeInsets.fromLTRB(10, 10, 20, 6),
      child: Row(
        children: [
          IconButton(
            onPressed: widget.onBack,
            icon: const Icon(Icons.arrow_back),
            tooltip: 'back'.tr,
          ),
          const SizedBox(width: 2),
          Expanded(
            child: Text(
              _titleText,
              style: theme.textTheme.titleLarge
                  ?.copyWith(fontWeight: FontWeight.w800, letterSpacing: -0.3),
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
            ),
          ),
          if (_items.isNotEmpty)
            Text(
              '${_items.length} ${'photo_home_photos_short'.tr}',
              style: theme.textTheme.bodySmall
                  ?.copyWith(color: scheme.onSurfaceVariant),
            ),
          // ⭐ 移出记忆：入口 1（右上角多选开关）
          if (widget.canRemove && _items.isNotEmpty) ...[
            const SizedBox(width: 8),
            SizedBox(
              height: 32,
              child: _selectMode
                  ? OutlinedButton(
                      onPressed: _busy ? null : _exitSelect,
                      style: OutlinedButton.styleFrom(
                        padding: const EdgeInsets.symmetric(horizontal: 12),
                        visualDensity: VisualDensity.compact,
                      ),
                      child: Text(
                        'photo_memory_select_cancel'.tr,
                        style: const TextStyle(fontSize: 12),
                      ),
                    )
                  : OutlinedButton.icon(
                      onPressed: _busy ? null : _enterSelect,
                      icon: const Icon(Icons.checklist, size: 15),
                      label: Text(
                        'photo_memory_select_mode'.tr,
                        style: const TextStyle(fontSize: 12),
                      ),
                      style: OutlinedButton.styleFrom(
                        padding: const EdgeInsets.symmetric(horizontal: 12),
                        visualDensity: VisualDensity.compact,
                      ),
                    ),
            ),
          ],
          if (widget.secondaryLabel != null && widget.onSecondary != null) ...[
            const SizedBox(width: 8),
            SizedBox(
              height: 32,
              child: OutlinedButton(
                onPressed: () => _run(widget.onSecondary),
                style: OutlinedButton.styleFrom(
                  padding: const EdgeInsets.symmetric(horizontal: 12),
                  visualDensity: VisualDensity.compact,
                ),
                child: Text(widget.secondaryLabel!, style: const TextStyle(fontSize: 12)),
              ),
            ),
          ],
          if (widget.primaryLabel != null && widget.onPrimary != null) ...[
            const SizedBox(width: 8),
            SizedBox(
              height: 32,
              child: FilledButton(
                onPressed: () => _run(widget.onPrimary),
                style: FilledButton.styleFrom(
                  padding: const EdgeInsets.symmetric(horizontal: 14),
                  visualDensity: VisualDensity.compact,
                ),
                child: Text(widget.primaryLabel!, style: const TextStyle(fontSize: 12)),
              ),
            ),
          ],
        ],
      ),
    );
  }

  Widget _buildTimelineTitle(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    return Padding(
      padding: const EdgeInsets.fromLTRB(20, 18, 20, 10),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(Icons.photo_library_outlined, size: 17, color: scheme.primary),
              const SizedBox(width: 6),
              Text(
                'photo_memory_detail_timeline'.tr,
                style:
                    theme.textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w700),
              ),
              const SizedBox(width: 8),
              Text(
                '${_items.length} ${'photo_home_photos_short'.tr}',
                style: theme.textTheme.bodySmall
                    ?.copyWith(color: scheme.onSurfaceVariant),
              ),
            ],
          ),
          // 桌面端用户不一定知道能右击，明说一句
          if (widget.canRemove && _items.isNotEmpty && !_selectMode)
            Padding(
              padding: const EdgeInsets.only(top: 4, left: 23),
              child: Text(
                'photo_memory_remove_hint'.tr,
                style: theme.textTheme.labelSmall
                    ?.copyWith(color: scheme.onSurfaceVariant),
              ),
            ),
        ],
      ),
    );
  }

  /// 底部操作条：左边已选张数，右下角「移出记忆（n）」
  Widget _buildSelectBar(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    return Material(
      color: scheme.surface,
      elevation: 8,
      child: SafeArea(
        top: false,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(20, 10, 20, 10),
          child: Row(
            children: [
              Expanded(
                child: Text(
                  'photo_memory_selected'.trParams({'count': '${_selected.length}'}),
                  style: theme.textTheme.bodySmall
                      ?.copyWith(color: scheme.onSurfaceVariant),
                ),
              ),
              TextButton(
                onPressed: _busy ? null : _toggleSelectAll,
                child: Text('photo_memory_select_all'.tr),
              ),
              const SizedBox(width: 6),
              SizedBox(
                height: 34,
                child: FilledButton.icon(
                  onPressed: (_selected.isEmpty || _busy)
                      ? null
                      : () => _removeHashes(_selected.toList()),
                  style: FilledButton.styleFrom(
                    backgroundColor: scheme.error,
                    foregroundColor: scheme.onError,
                    padding: const EdgeInsets.symmetric(horizontal: 14),
                    visualDensity: VisualDensity.compact,
                  ),
                  icon: const Icon(Icons.playlist_remove, size: 17),
                  label: Text(
                    'photo_memory_remove_selected'
                        .trParams({'count': '${_selected.length}'}),
                    style: const TextStyle(fontSize: 12),
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  /// 执行动作 → 成功就退回列表（失败由列表那边 toast，不在这里重复提示）
  Future<void> _run(Future<void> Function()? action) async {
    if (action == null) return;
    await action();
    if (!mounted) return;
    widget.onBack();
  }

  /// ⭐ 2026-10-19 用户自己写过备注就用备注；没有就用「地点 · 干了什么 · N 张」
  /// 的真实标签摘要（不编故事），两者都空就整块不显示。
  String get _noteText {
    final note = (widget.memory['note'] ?? '').toString().trim();
    if (note.isNotEmpty) return note;
    final place = (widget.memory['place'] ?? '').toString().trim();
    final acts = _listOf(widget.memory['activities']);
    final what = acts.isNotEmpty ? acts : _scenesOf(widget.memory);
    final count = (widget.memory['photo_count'] as num?)?.toInt() ?? 0;
    return <String>[
      if (place.isNotEmpty) place,
      if (what.isNotEmpty) what.take(2).join(' · '),
      if (count > 0) '$count ${'photo_home_photos_short'.tr}',
    ].join(' · ');
  }

  static List<String> _listOf(dynamic raw) {
    if (raw is! List) return const <String>[];
    return raw.map((e) => e.toString()).where((e) => e.isNotEmpty).toList();
  }

  String get _titleText {
    final t = (widget.memory['title'] ?? '').toString().trim();
    if (t.isNotEmpty) return t;
    return _prettyDate((widget.memory['date'] ?? '').toString());
  }

  Widget _buildCover(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final cover = (widget.memory['cover_path'] ?? '').toString();
    final url = cover.isEmpty ? '' : ApiController.instance.getTinyUrl(cover);
    final count = (widget.memory['photo_count'] as num?)?.toInt() ?? _items.length;
    final scenes = _scenesOf(widget.memory);
    return Padding(
      padding: const EdgeInsets.fromLTRB(20, 6, 20, 0),
      child: ClipRRect(
        borderRadius: BorderRadius.circular(16),
        child: SizedBox(
          height: 240,
          child: Stack(
            fit: StackFit.expand,
            children: [
              if (url.isEmpty)
                ColoredBox(
                  color: scheme.surfaceContainerHighest,
                  child: Icon(Icons.image_outlined, color: scheme.onSurfaceVariant, size: 40),
                )
              else
                CustomExtendedImage(imageUrl: url, fit: BoxFit.cover),
              const DecoratedBox(
                decoration: BoxDecoration(
                  gradient: LinearGradient(
                    begin: Alignment.topCenter,
                    end: Alignment.bottomCenter,
                    colors: [Colors.transparent, Colors.black87],
                    stops: [0.35, 1.0],
                  ),
                ),
              ),
              Positioned(
                left: 20,
                right: 20,
                bottom: 16,
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text(
                      _prettyDate((widget.memory['date'] ?? '').toString()),
                      style: const TextStyle(
                        color: Colors.white,
                        fontSize: 24,
                        fontWeight: FontWeight.w800,
                        height: 1.2,
                      ),
                    ),
                    const SizedBox(height: 4),
                    Text(
                      [
                        '$count ${'photo_home_photos_short'.tr}',
                        if (scenes.isNotEmpty) scenes.take(3).join(' · '),
                      ].join(' · '),
                      style: const TextStyle(color: Colors.white70, fontSize: 12),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _buildNote(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    return Padding(
      padding: const EdgeInsets.fromLTRB(20, 14, 20, 0),
      child: Container(
        width: double.infinity,
        padding: const EdgeInsets.fromLTRB(16, 12, 16, 12),
        decoration: BoxDecoration(
          color: scheme.surface,
          borderRadius: BorderRadius.circular(12),
          border: Border.all(color: scheme.outlineVariant.withValues(alpha: 0.42)),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              'photo_memory_detail_note'.tr,
              style: theme.textTheme.labelSmall?.copyWith(color: scheme.onSurfaceVariant),
            ),
            const SizedBox(height: 6),
            Text(
              _noteText,
              style: theme.textTheme.bodyMedium?.copyWith(height: 1.5),
            ),
          ],
        ),
      ),
    );
  }

  List<Widget> _buildBody(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    if (_loading) {
      return const [
        SliverToBoxAdapter(
          child: Padding(
            padding: EdgeInsets.only(top: 60),
            child: Center(child: CircularProgressIndicator()),
          ),
        ),
      ];
    }
    if (_error != null) {
      return [
        SliverToBoxAdapter(
          child: Padding(
            padding: const EdgeInsets.only(top: 50),
            child: Column(
              children: [
                Icon(Icons.error_outline, size: 34, color: scheme.onSurfaceVariant),
                const SizedBox(height: 10),
                Text(_error!, style: const TextStyle(fontSize: 13)),
                const SizedBox(height: 12),
                FilledButton.tonal(onPressed: _load, child: Text('retry'.tr)),
              ],
            ),
          ),
        ),
      ];
    }
    if (_items.isEmpty) {
      return [
        SliverToBoxAdapter(
          child: Padding(
            padding: const EdgeInsets.only(top: 50),
            child: Column(
              children: [
                Icon(Icons.image_outlined, size: 34, color: scheme.onSurfaceVariant),
                const SizedBox(height: 10),
                Text('photo_memory_detail_empty'.tr, style: const TextStyle(fontSize: 13)),
              ],
            ),
          ),
        ),
      ];
    }
    // 记忆天然是「一天一簇」，这里仍按日期分组，兼容以后扩展成多天的事件
    final groups = <String, List<int>>{};
    for (var i = 0; i < _items.length; i++) {
      final d = (_items[i]['date'] ?? '').toString();
      groups.putIfAbsent(d, () => <int>[]).add(i);
    }
    final slivers = <Widget>[];
    for (final entry in groups.entries) {
      slivers.add(
        SliverToBoxAdapter(
          child: Padding(
            padding: const EdgeInsets.fromLTRB(20, 6, 20, 8),
            child: Text(
              _prettyDate(entry.key),
              style: TextStyle(
                fontSize: 13,
                fontWeight: FontWeight.w600,
                color: scheme.onSurfaceVariant,
              ),
            ),
          ),
        ),
      );
      slivers.add(
        SliverPadding(
          padding: const EdgeInsets.fromLTRB(20, 0, 20, 14),
          sliver: SliverGrid(
            gridDelegate: const SliverGridDelegateWithMaxCrossAxisExtent(
              maxCrossAxisExtent: 180,
              mainAxisSpacing: 10,
              crossAxisSpacing: 10,
            ),
            delegate: SliverChildBuilderDelegate(
              (context, gi) {
                final idx = entry.value[gi];
                final it = _items[idx];
                final hash = (it['file_hash'] ?? '').toString();
                return _PhotoTile(
                  path: (it['fullpath'] ?? '').toString(),
                  isVideo: (it['type'] as num?)?.toInt() == 2,
                  selectMode: _selectMode,
                  selected: _selected.contains(hash),
                  onTap: () => _onTileTap(idx, hash),
                  onLongPress: widget.canRemove
                      ? () {
                          setState(() {
                            _selectMode = true;
                            if (hash.isNotEmpty) _selected.add(hash);
                          });
                        }
                      : null,
                  onSecondaryTapDown: widget.canRemove
                      ? (details) => _showPhotoMenu(details.globalPosition, hash)
                      : null,
                );
              },
              childCount: entry.value.length,
            ),
          ),
        ),
      );
    }
    return slivers;
  }

  void _onTileTap(int idx, String hash) {
    if (!_selectMode) {
      _openAt(idx);
      return;
    }
    if (hash.isEmpty) return;
    setState(() {
      if (!_selected.remove(hash)) _selected.add(hash);
    });
  }

  void _enterSelect() => setState(() => _selectMode = true);

  void _exitSelect() => setState(() {
        _selectMode = false;
        _selected.clear();
      });

  void _toggleSelectAll() {
    final all = _hashSet();
    setState(() {
      if (_selected.length >= all.length) {
        _selected.clear();
      } else {
        _selected
          ..clear()
          ..addAll(all);
      }
    });
  }

  /// 右击菜单（桌面端）：移出这一张 / 进入多选
  Future<void> _showPhotoMenu(Offset globalPos, String hash) async {
    if (hash.isEmpty || _busy) return;
    final chosen = await showMenu<String>(
      context: context,
      position: RelativeRect.fromLTRB(
        globalPos.dx,
        globalPos.dy,
        globalPos.dx + 1,
        globalPos.dy + 1,
      ),
      items: <PopupMenuEntry<String>>[
        PopupMenuItem<String>(
          value: 'remove',
          height: 40,
          child: Row(
            children: [
              const Icon(Icons.playlist_remove, size: 18),
              const SizedBox(width: 8),
              Text('photo_memory_remove_photo'.tr, style: const TextStyle(fontSize: 13)),
            ],
          ),
        ),
        PopupMenuItem<String>(
          value: 'select',
          height: 40,
          child: Row(
            children: [
              const Icon(Icons.checklist, size: 18),
              const SizedBox(width: 8),
              Text('photo_memory_select_mode'.tr, style: const TextStyle(fontSize: 13)),
            ],
          ),
        ),
      ],
    );
    if (!mounted || chosen == null) return;
    if (chosen == 'remove') {
      await _removeHashes(<String>[hash]);
    } else {
      setState(() {
        _selectMode = true;
        _selected.add(hash);
      });
    }
  }

  /// 移出记忆：一次提交多张，成功后重拉这一组并通知列表刷新计数
  Future<void> _removeHashes(List<String> hashes) async {
    final key = (widget.memory['key'] ?? '').toString();
    final date = (widget.memory['date'] ?? '').toString();
    final list = hashes.where((h) => h.isNotEmpty).toSet().toList();
    if (key.isEmpty || list.isEmpty || _busy) return;
    setState(() => _busy = true);
    try {
      final res = await PhotoAiSettingsApiService.instance
          .excludeMemoryPhotos(key, date: date, hashes: list);
      if (!mounted) return;
      if (!res.success) {
        ToastUtil.show('operation_failed'.tr);
        return;
      }
      setState(() {
        _selected.removeAll(list);
        if (_selected.isEmpty) _selectMode = false;
      });
      ToastUtil.show(
        'photo_memory_remove_done'.trParams({'count': '${list.length}'}),
      );
      await _load();
      widget.onChanged?.call();
    } catch (_) {
      if (mounted) ToastUtil.show('operation_failed'.tr);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  List<String> _scenesOf(Map<String, dynamic> m) {
    final raw = m['scenes'];
    if (raw is! List) return const <String>[];
    return raw.map((e) => e.toString()).where((e) => e.isNotEmpty).toList();
  }
}

class _PhotoTile extends StatelessWidget {
  final String path;
  final bool isVideo;
  final bool selectMode;
  final bool selected;
  final VoidCallback onTap;
  final VoidCallback? onLongPress;
  final void Function(TapDownDetails)? onSecondaryTapDown;

  const _PhotoTile({
    required this.path,
    required this.isVideo,
    required this.selectMode,
    required this.selected,
    required this.onTap,
    this.onLongPress,
    this.onSecondaryTapDown,
  });

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final url = path.isEmpty ? '' : ApiController.instance.getTinyUrl(path);
    return ClipRRect(
      borderRadius: BorderRadius.circular(10),
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
          if (selected)
            ColoredBox(color: scheme.primary.withValues(alpha: 0.22)),
          if (isVideo)
            const Positioned(
              right: 6,
              bottom: 6,
              child: Icon(Icons.play_circle_fill, color: Colors.white70, size: 22),
            ),
          // 勾选圈：多选态一律显示（未选=空心），已选显示实心对勾
          if (selectMode || selected)
            Positioned(
              left: 6,
              top: 6,
              child: Container(
                width: 20,
                height: 20,
                decoration: BoxDecoration(
                  shape: BoxShape.circle,
                  color: selected ? scheme.primary : Colors.black.withValues(alpha: 0.35),
                  border: Border.all(color: Colors.white.withValues(alpha: 0.9), width: 1.4),
                ),
                child: selected
                    ? Icon(Icons.check, size: 13, color: scheme.onPrimary)
                    : null,
              ),
            ),
          Positioned.fill(
            child: GestureDetector(
              behavior: HitTestBehavior.opaque,
              onTap: onTap,
              onLongPress: onLongPress,
              onSecondaryTapDown: onSecondaryTapDown,
            ),
          ),
        ],
      ),
    );
  }
}

String _prettyDate(String raw) {
  final d = DateTime.tryParse(raw);
  if (d == null) return raw;
  return '${d.year} 年 ${d.month.toString().padLeft(2, '0')} 月 ${d.day.toString().padLeft(2, '0')} 日';
}
