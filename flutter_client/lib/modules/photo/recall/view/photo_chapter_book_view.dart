import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:get/get.dart';
import 'package:intl/intl.dart';
import 'package:WaterNasOS/core/api/api_controller.dart';
import 'package:WaterNasOS/core/theme/custom_colors.dart';
import 'package:WaterNasOS/modules/base/components/custom_extended_image.dart';
import 'package:WaterNasOS/modules/photo/shared/photo_viewer_helper.dart';

import '../../ai_setting/service/photo_ai_settings_api_service.dart';

/// ⭐ 2026-10-19 人生章节「书本」。
///
/// 记忆页顶部的「人生章节」以前点一下只放大封面那一张 —— 一年的照片等于只剩一张。
/// 现在点进去是一本可以翻的书：**一页 = 一段已确认的记忆**，左页摆照片、右页写这一段的文字
/// （地点 + 场景/活动/人物 + 备注），底部左右翻页，键盘 ←/→ 也能翻。
///
/// ⭐ 2026-10-19 二次调整（用户要求）：
///   ① 底部翻页按钮之外，书页左右两侧再加一对大箭头（桌面端不用去底部找）；
///   ② 内容从 1 月 1 日开始（服务端已改升序），不再是「最近的日子在前」；
///   ③ 只收这一年里**用户确认过的记忆**（服务端过滤，没有确认过就是空书）；
///   ④ 竖屏照片不再被 16:10 硬裁：主图按片子的真实比例选框，配图比例不搭就整张放进深底里。
class PhotoChapterBookView extends StatefulWidget {
  final int year;
  final VoidCallback onBack;

  const PhotoChapterBookView({
    super.key,
    required this.year,
    required this.onBack,
  });

  @override
  State<PhotoChapterBookView> createState() => _PhotoChapterBookViewState();
}

class _PhotoChapterBookViewState extends State<PhotoChapterBookView> {
  final FocusNode _focus = FocusNode(debugLabel: 'photo-chapter-book');
  /// ⭐ 翻页后要回到页首：不加这个，上一页滚到一半，下一页进来还是那个位置
  final ScrollController _scroll = ScrollController();

  bool _loading = true;
  String? _error;
  bool _truncated = false;
  List<Map<String, dynamic>> _days = const <Map<String, dynamic>>[];
  int _index = 0;

  @override
  void initState() {
    super.initState();
    _load();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) _focus.requestFocus();
    });
  }

  @override
  void dispose() {
    _focus.dispose();
    _scroll.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final res = await PhotoAiSettingsApiService.instance
          .getChapterBook(widget.year);
      if (!mounted) return;
      if (!res.success || res.data == null) {
        setState(() {
          _error = 'operation_failed'.tr;
          _loading = false;
        });
        return;
      }
      final raw = res.data!['days'];
      setState(() {
        _days = raw is List
            ? [
                for (final e in raw)
                  if (e is Map) e.cast<String, dynamic>(),
              ]
            : const <Map<String, dynamic>>[];
        _truncated = res.data!['truncated'] == true;
        _index = 0;
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

  void _go(int delta) {
    if (_days.isEmpty) return;
    _setIndex((_index + delta).clamp(0, _days.length - 1));
  }

  void _setIndex(int next) {
    if (next == _index) return;
    setState(() => _index = next);
    // 换页后回到页首（书页内容是各自独立的，位置没必要继承）
    if (_scroll.hasClients) _scroll.jumpTo(0);
  }

  KeyEventResult _onKey(FocusNode node, KeyEvent event) {
    if (event is! KeyDownEvent) return KeyEventResult.ignored;
    final key = event.logicalKey;
    if (key == LogicalKeyboardKey.arrowLeft || key == LogicalKeyboardKey.pageUp) {
      _go(-1);
      return KeyEventResult.handled;
    }
    if (key == LogicalKeyboardKey.arrowRight ||
        key == LogicalKeyboardKey.pageDown) {
      _go(1);
      return KeyEventResult.handled;
    }
    if (key == LogicalKeyboardKey.home) {
      _setIndex(0);
      return KeyEventResult.handled;
    }
    if (key == LogicalKeyboardKey.end && _days.isNotEmpty) {
      _setIndex(_days.length - 1);
      return KeyEventResult.handled;
    }
    if (key == LogicalKeyboardKey.escape) {
      widget.onBack();
      return KeyEventResult.handled;
    }
    return KeyEventResult.ignored;
  }

  /// 打开这一段的整组照片（看图器自带左右滑动 / 左右键 / ESC）
  void _openDay(int photoIndex) {
    if (_days.isEmpty) return;
    final raw = _days[_index]['photos'];
    if (raw is! List) return;
    final photos = <Map<String, dynamic>>[
      for (final p in raw)
        if (p is Map && (p['fullpath'] ?? '').toString().isNotEmpty)
          {
            'type': 'image',
            'path': (p['fullpath'] ?? '').toString(),
            'name': (p['filename'] ?? '').toString(),
            'photoId': 0,
          },
    ];
    if (photos.isEmpty) return;
    openPhotoImages(photos, photoIndex.clamp(0, photos.length - 1));
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final customColors = theme.extension<CustomColors>();
    return Container(
      color: customColors?.mainContentBgColor ?? theme.scaffoldBackgroundColor,
      child: Focus(
        focusNode: _focus,
        autofocus: true,
        onKeyEvent: _onKey,
        child: Column(
          children: [
            _buildHeader(context),
            Expanded(child: _buildBody(context)),
            if (!_loading && _error == null && _days.isNotEmpty)
              _buildFooter(context),
          ],
        ),
      ),
    );
  }

  // ------------------------------------------------------------------ 头部

  Widget _buildHeader(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    return Padding(
      padding: const EdgeInsets.fromLTRB(10, 10, 20, 4),
      child: Row(
        children: [
          IconButton(
            onPressed: widget.onBack,
            icon: const Icon(Icons.arrow_back),
            tooltip: 'back'.tr,
          ),
          const SizedBox(width: 2),
          Expanded(
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.baseline,
              textBaseline: TextBaseline.alphabetic,
              children: [
                Text(
                  'photo_book_title'.trParams({'year': '${widget.year}'}),
                  style: theme.textTheme.titleLarge?.copyWith(
                    fontWeight: FontWeight.w800,
                    letterSpacing: -0.3,
                  ),
                ),
                const SizedBox(width: 10),
                if (_days.isNotEmpty)
                  Text(
                    'photo_book_days'.trParams({'count': '${_days.length}'}),
                    style: theme.textTheme.bodySmall
                        ?.copyWith(color: scheme.onSurfaceVariant),
                  ),
              ],
            ),
          ),
          if (_truncated)
            Text(
              'photo_book_truncated'.tr,
              style: theme.textTheme.labelSmall
                  ?.copyWith(color: scheme.onSurfaceVariant),
            ),
        ],
      ),
    );
  }

  // ------------------------------------------------------------------ 主体

  Widget _buildBody(BuildContext context) {
    if (_loading) return const Center(child: CircularProgressIndicator());
    final err = _error;
    if (err != null) {
      return Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(err, style: Theme.of(context).textTheme.bodyLarge),
            const SizedBox(height: 12),
            FilledButton.tonal(onPressed: _load, child: Text('retry'.tr)),
          ],
        ),
      );
    }
    if (_days.isEmpty) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Text(
            'photo_book_empty'.trParams({'year': '${widget.year}'}),
            textAlign: TextAlign.center,
            style: Theme.of(context).textTheme.bodyLarge,
          ),
        ),
      );
    }
    final day = _days[_index];
    return LayoutBuilder(
      builder: (context, constraints) {
        final wide = constraints.maxWidth >= 860;
        // 书本给一个确定高度：页面内容超出就在页内滚动，
        // 不靠 IntrinsicHeight 硬撑 —— 备注很长时那会把整本书撑成一条长条。
        final bookHeight = wide
            ? (constraints.maxWidth * 0.42).clamp(430.0, 660.0).toDouble()
            : null;
        return Stack(
          children: [
            SingleChildScrollView(
              controller: _scroll,
              padding: EdgeInsets.fromLTRB(wide ? 52 : 20, 6, wide ? 52 : 20, 10),
              child: Center(
                child: ConstrainedBox(
                  constraints: const BoxConstraints(maxWidth: 1180),
                  child: _Book(
                    year: widget.year,
                    day: day,
                    pageNo: _index,
                    total: _days.length,
                    wide: wide,
                    height: bookHeight,
                    onOpenPhoto: _openDay,
                  ),
                ),
              ),
            ),
            // ⭐ 书页两侧的大箭头：底部那对太远，翻页习惯上是「点边」
            Align(
              alignment: Alignment.centerLeft,
              child: _ArrowButton(
                left: true,
                enabled: _index > 0,
                onTap: () => _go(-1),
              ),
            ),
            Align(
              alignment: Alignment.centerRight,
              child: _ArrowButton(
                left: false,
                enabled: _index < _days.length - 1,
                onTap: () => _go(1),
              ),
            ),
          ],
        );
      },
    );
  }

  // ------------------------------------------------------------------ 底部翻页

  Widget _buildFooter(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final day = _days[_index];
    final date = (day['date'] ?? '').toString();
    return Padding(
      padding: const EdgeInsets.fromLTRB(20, 0, 20, 14),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Row(
            children: [
              SizedBox(
                height: 34,
                child: FilledButton.tonalIcon(
                  onPressed: _index > 0 ? () => _go(-1) : null,
                  icon: const Icon(Icons.arrow_back_ios_new, size: 13),
                  label: Text(
                    'photo_book_prev'.tr,
                    style: const TextStyle(fontSize: 13),
                  ),
                ),
              ),
              Expanded(
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text(
                      date,
                      textAlign: TextAlign.center,
                      style: theme.textTheme.bodyMedium
                          ?.copyWith(fontWeight: FontWeight.w700),
                    ),
                    Text(
                      'photo_book_page'.trParams({
                        'current': '${_index + 1}',
                        'total': '${_days.length}',
                      }),
                      style: theme.textTheme.labelSmall
                          ?.copyWith(color: scheme.onSurfaceVariant),
                    ),
                  ],
                ),
              ),
              SizedBox(
                height: 34,
                child: FilledButton.tonalIcon(
                  onPressed: _index < _days.length - 1 ? () => _go(1) : null,
                  icon: const Icon(Icons.arrow_forward_ios, size: 13),
                  label: Text(
                    'photo_book_next'.tr,
                    style: const TextStyle(fontSize: 13),
                  ),
                ),
              ),
            ],
          ),
          const SizedBox(height: 4),
          Text(
            'photo_book_hint'.tr,
            style: theme.textTheme.labelSmall
                ?.copyWith(color: scheme.onSurfaceVariant),
          ),
        ],
      ),
    );
  }
}

/// 书页左右两侧的翻页圆钮
class _ArrowButton extends StatelessWidget {
  final bool left;
  final bool enabled;
  final VoidCallback onTap;

  const _ArrowButton({
    required this.left,
    required this.enabled,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Padding(
      padding: EdgeInsets.only(left: left ? 6 : 0, right: left ? 0 : 6),
      child: Material(
        color: scheme.surface.withValues(alpha: enabled ? 0.94 : 0.55),
        shape: const CircleBorder(),
        elevation: enabled ? 2 : 0,
        child: InkWell(
          customBorder: const CircleBorder(),
          onTap: enabled ? onTap : null,
          child: SizedBox(
            width: 38,
            height: 38,
            child: Icon(
              left ? Icons.chevron_left : Icons.chevron_right,
              size: 26,
              color: enabled
                  ? scheme.onSurface
                  : scheme.onSurfaceVariant.withValues(alpha: 0.35),
            ),
          ),
        ),
      ),
    );
  }
}

// ---------------------------------------------------------------------- 书本

class _Book extends StatelessWidget {
  final int year;
  final Map<String, dynamic> day;
  final int pageNo;
  final int total;
  final bool wide;
  final double? height;
  final void Function(int index) onOpenPhoto;

  const _Book({
    required this.year,
    required this.day,
    required this.pageNo,
    required this.total,
    required this.wide,
    required this.height,
    required this.onOpenPhoto,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    // 「纸」的底色：不写死米白（换肤/暗色会崩），用主色淡淡叠一层，两页略有差别暗示中缝
    final paper = Color.alphaBlend(
      scheme.primary.withValues(alpha: 0.035),
      scheme.surface,
    );
    final paperRight = Color.alphaBlend(
      scheme.primary.withValues(alpha: 0.06),
      scheme.surface,
    );
    final left = _PhotoPage(
      year: year,
      day: day,
      pageNo: pageNo,
      wide: wide,
      onOpenPhoto: onOpenPhoto,
    );
    final right = _StoryPage(
      day: day,
      pageNo: pageNo,
      wide: wide,
      onOpenPhoto: onOpenPhoto,
    );
    return Container(
      decoration: BoxDecoration(
        color: paper,
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: scheme.outlineVariant.withValues(alpha: 0.5)),
        boxShadow: [
          BoxShadow(
            color: Colors.black.withValues(alpha: 0.06),
            blurRadius: 18,
            offset: const Offset(0, 6),
          ),
        ],
      ),
      child: wide
          ? SizedBox(
              height: height,
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Expanded(
                    child: ClipRRect(
                      borderRadius: const BorderRadius.horizontal(
                        left: Radius.circular(10),
                      ),
                      child: ColoredBox(
                        color: paper,
                        child: SingleChildScrollView(child: left),
                      ),
                    ),
                  ),
                  // 中缝
                  Container(
                    width: 1,
                    decoration: BoxDecoration(
                      gradient: LinearGradient(
                        begin: Alignment.topCenter,
                        end: Alignment.bottomCenter,
                        colors: [
                          scheme.outlineVariant.withValues(alpha: 0.05),
                          scheme.outlineVariant.withValues(alpha: 0.55),
                          scheme.outlineVariant.withValues(alpha: 0.05),
                        ],
                      ),
                    ),
                  ),
                  Expanded(
                    child: ClipRRect(
                      borderRadius: const BorderRadius.horizontal(
                        right: Radius.circular(10),
                      ),
                      child: ColoredBox(
                        color: paperRight,
                        child: SingleChildScrollView(child: right),
                      ),
                    ),
                  ),
                ],
              ),
            )
          : Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                left,
                Divider(
                  height: 1,
                  color: scheme.outlineVariant.withValues(alpha: 0.4),
                ),
                ColoredBox(color: paperRight, child: right),
              ],
            ),
    );
  }
}

// ---------------------------------------------------------------- 左页：照片

class _PhotoPage extends StatelessWidget {
  final int year;
  final Map<String, dynamic> day;
  final int pageNo;
  final bool wide;
  final void Function(int index) onOpenPhoto;

  const _PhotoPage({
    required this.year,
    required this.day,
    required this.pageNo,
    required this.wide,
    required this.onOpenPhoto,
  });

  List<Map<String, dynamic>> get _photos {
    final raw = day['photos'];
    if (raw is! List) return const <Map<String, dynamic>>[];
    return [
      for (final p in raw)
        if (p is Map) p.cast<String, dynamic>(),
    ];
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final photos = _photos;
    final count = (day['photo_count'] as num?)?.toInt() ?? photos.length;
    final date = _parseDate((day['date'] ?? '').toString());
    final mm = date == null ? '--' : date.month.toString().padLeft(2, '0');
    final dd = date == null ? '--' : date.day.toString().padLeft(2, '0');
    final pad = wide ? 26.0 : 18.0;
    // ⭐ 主图按第一张的真实比例取框：竖片给竖框，横片给横框，别硬裁成 16:10
    final heroRatio = _frameFor(photos.isNotEmpty ? photos.first : null);

    return Padding(
      padding: EdgeInsets.fromLTRB(pad, pad, pad, 16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  'photo_book_album'.trParams({'year': '$year'}),
                  style: theme.textTheme.labelMedium?.copyWith(
                    color: scheme.onSurfaceVariant,
                    letterSpacing: 0.6,
                  ),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
              ),
              Text(
                _isoDate(date),
                style: theme.textTheme.labelSmall
                    ?.copyWith(color: scheme.onSurfaceVariant),
              ),
            ],
          ),
          const SizedBox(height: 10),
          Row(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              Text(
                '$mm / $dd',
                style: (wide
                        ? theme.textTheme.displaySmall
                        : theme.textTheme.headlineMedium)
                    ?.copyWith(
                  fontWeight: FontWeight.w300,
                  letterSpacing: 1.2,
                  height: 1,
                ),
              ),
              const Spacer(),
              Column(
                crossAxisAlignment: CrossAxisAlignment.end,
                mainAxisSize: MainAxisSize.min,
                children: [
                  if (_weekday(date).isNotEmpty)
                    Text(
                      _weekday(date),
                      style: theme.textTheme.labelSmall
                          ?.copyWith(color: scheme.onSurfaceVariant),
                    ),
                  Text(
                    'photo_book_count'.trParams({'count': '$count'}),
                    style: theme.textTheme.labelSmall
                        ?.copyWith(color: scheme.onSurfaceVariant),
                  ),
                ],
              ),
            ],
          ),
          const SizedBox(height: 12),
          if (photos.isEmpty)
            AspectRatio(
              aspectRatio: 16 / 10,
              child: ColoredBox(
                color: scheme.surfaceContainerHighest.withValues(alpha: 0.6),
                child: Icon(Icons.image_outlined,
                    color: scheme.onSurfaceVariant, size: 34),
              ),
            )
          else
            _PhotoTile(
              path: (photos.first['fullpath'] ?? '').toString(),
              aspectRatio: heroRatio,
              size: 720,
              photoRatio: _ratioOf(photos.first),
              onTap: () => onOpenPhoto(0),
            ),
          if (photos.length > 1) ...[
            const SizedBox(height: 8),
            Row(
              children: [
                Expanded(
                  child: _PhotoTile(
                    path: (photos[1]['fullpath'] ?? '').toString(),
                    aspectRatio: 3 / 2,
                    size: 360,
                    photoRatio: _ratioOf(photos[1]),
                    onTap: () => onOpenPhoto(1),
                  ),
                ),
                if (photos.length > 2) ...[
                  const SizedBox(width: 8),
                  Expanded(
                    child: _PhotoTile(
                      path: (photos[2]['fullpath'] ?? '').toString(),
                      aspectRatio: 3 / 2,
                      size: 360,
                      photoRatio: _ratioOf(photos[2]),
                      onTap: () => onOpenPhoto(2),
                    ),
                  ),
                ],
              ],
            ),
          ],
          const SizedBox(height: 18),
          Row(
            children: [
              Expanded(
                child: Text(
                  'photo_book_select'.trParams({
                    'count': '${photos.length.clamp(0, 3)}',
                  }),
                  style: theme.textTheme.labelSmall
                      ?.copyWith(color: scheme.onSurfaceVariant),
                ),
              ),
              // 只有 3 张的时候没有「全部」可看；超过 3 张才给入口
              // （@count 用实际拿到的张数，别承诺看图器里没有的照片）
              if (photos.length > 3)
                TextButton(
                  onPressed: () => onOpenPhoto(0),
                  style: TextButton.styleFrom(
                    padding: const EdgeInsets.symmetric(horizontal: 8),
                    minimumSize: const Size(0, 28),
                    tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                  ),
                  child: Text(
                    'photo_book_view_all'
                        .trParams({'count': '${photos.length}'}),
                    style: theme.textTheme.labelSmall,
                  ),
                ),
            ],
          ),
          const SizedBox(height: 2),
          Align(
            alignment: Alignment.centerRight,
            child: Text(
              '${pageNo + 1}',
              style: theme.textTheme.labelSmall?.copyWith(
                color: scheme.onSurfaceVariant.withValues(alpha: 0.7),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

// ---------------------------------------------------------------- 右页：文字

class _StoryPage extends StatelessWidget {
  final Map<String, dynamic> day;
  final int pageNo;
  final bool wide;
  final void Function(int index) onOpenPhoto;

  const _StoryPage({
    required this.day,
    required this.pageNo,
    required this.wide,
    required this.onOpenPhoto,
  });

  List<Map<String, dynamic>> get _photos {
    final raw = day['photos'];
    if (raw is! List) return const <Map<String, dynamic>>[];
    return [
      for (final p in raw)
        if (p is Map) p.cast<String, dynamic>(),
    ];
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final date = _parseDate((day['date'] ?? '').toString());
    final place = (day['place'] ?? '').toString().trim();
    final note = (day['note'] ?? '').toString().trim();
    final photos = _photos;
    final tags = <String>[
      ..._strings(day['scenes']),
      ..._strings(day['activities']),
      ..._strings(day['people']),
    ];
    final pad = wide ? 26.0 : 18.0;

    return Padding(
      padding: EdgeInsets.fromLTRB(pad, pad, pad, 16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  'photo_book_story_head'
                      .trParams({'date': _isoDate(date)}),
                  style: theme.textTheme.labelMedium
                      ?.copyWith(color: scheme.onSurfaceVariant),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
              ),
            ],
          ),
          const SizedBox(height: 12),
          Text(
            _diaryLine(date),
            style: theme.textTheme.labelSmall?.copyWith(
              color: scheme.primary,
              letterSpacing: 0.4,
            ),
          ),
          const SizedBox(height: 4),
          Text(
            place.isEmpty ? 'photo_book_unknown_place'.tr : place,
            style: theme.textTheme.titleMedium?.copyWith(
              fontWeight: FontWeight.w700,
              height: 1.3,
            ),
            maxLines: 2,
            overflow: TextOverflow.ellipsis,
          ),
          const SizedBox(height: 12),
          Text(
            _storyOf(day),
            style: theme.textTheme.bodyMedium?.copyWith(
              height: 1.85,
              color: scheme.onSurface.withValues(alpha: 0.9),
            ),
          ),
          const SizedBox(height: 14),
          Row(
            children: [
              Icon(
                note.isEmpty ? Icons.auto_awesome_outlined : Icons.check_circle_outline,
                size: 14,
                color: scheme.onSurfaceVariant,
              ),
              const SizedBox(width: 5),
              Expanded(
                child: Text(
                  note.isEmpty ? 'photo_book_local_note'.tr : 'photo_book_ai_note'.tr,
                  style: theme.textTheme.labelSmall
                      ?.copyWith(color: scheme.onSurfaceVariant),
                ),
              ),
            ],
          ),
          if (tags.isNotEmpty) ...[
            const SizedBox(height: 12),
            Wrap(
              spacing: 6,
              runSpacing: 6,
              children: [
                for (final t in tags.take(8))
                  Container(
                    padding:
                        const EdgeInsets.symmetric(horizontal: 9, vertical: 3),
                    decoration: BoxDecoration(
                      color: scheme.primary.withValues(alpha: 0.08),
                      borderRadius: BorderRadius.circular(20),
                    ),
                    child: Text(
                      '# $t',
                      style: theme.textTheme.labelSmall
                          ?.copyWith(color: scheme.primary),
                    ),
                  ),
              ],
            ),
          ],
          const SizedBox(height: 18),
          if (photos.length > 3) ...[
            Text(
              'photo_book_moments'.tr,
              style: theme.textTheme.labelMedium
                  ?.copyWith(color: scheme.onSurfaceVariant),
            ),
            const SizedBox(height: 8),
            Row(
              children: [
                for (var i = 3; i < photos.length && i < 6; i++) ...[
                  if (i > 3) const SizedBox(width: 6),
                  Expanded(
                    child: _PhotoTile(
                      path: (photos[i]['fullpath'] ?? '').toString(),
                      aspectRatio: 1,
                      size: 240,
                      photoRatio: _ratioOf(photos[i]),
                      onTap: () => onOpenPhoto(i),
                    ),
                  ),
                ],
              ],
            ),
          ],
          Align(
            alignment: Alignment.centerRight,
            child: Text(
              '${pageNo + 2}',
              style: theme.textTheme.labelSmall?.copyWith(
                color: scheme.onSurfaceVariant.withValues(alpha: 0.7),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

// ---------------------------------------------------------------------- 组件

/// ⭐ 照片格：比例对不上时**整张放进去**（深底 + contain），不再硬裁。
/// 竖屏照片塞进 16:10 / 3:2 的横框里，以前是 cover 裁掉大半张，所以怎么看怎么怪。
class _PhotoTile extends StatelessWidget {
  final String path;
  final double aspectRatio;
  final int size;

  /// 原图宽高比（w / h）；0 = 服务端没给，按 cover 处理
  final double photoRatio;
  final VoidCallback? onTap;

  const _PhotoTile({
    required this.path,
    required this.aspectRatio,
    required this.size,
    this.photoRatio = 0,
    this.onTap,
  });

  bool get _contain {
    if (photoRatio <= 0) return false;
    return (photoRatio - aspectRatio).abs() / aspectRatio > 0.18;
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final url = path.isEmpty ? '' : ApiController.instance.getTinyUrl(path, size: size);
    return ClipRRect(
      borderRadius: BorderRadius.circular(6),
      child: AspectRatio(
        aspectRatio: aspectRatio,
        child: Stack(
          fit: StackFit.expand,
          children: [
            if (url.isEmpty)
              ColoredBox(
                color: scheme.surfaceContainerHighest.withValues(alpha: 0.6),
                child: Icon(Icons.image_outlined,
                    color: scheme.onSurfaceVariant, size: 22),
              )
            else if (!_contain)
              CustomExtendedImage(imageUrl: url, fit: BoxFit.cover)
            else ...[
              // 铺底：同一张图 cover 后压暗，看起来像「虚化底」，不会露出突兀的白边
              CustomExtendedImage(imageUrl: url, fit: BoxFit.cover, showLoading: false),
              const ColoredBox(color: Color(0x8C000000)),
              CustomExtendedImage(imageUrl: url, fit: BoxFit.contain, showLoading: false),
            ],
            if (onTap != null)
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

/// 「我的影像日记 · 星期三」——日期格式拿不到就只留标题
String _diaryLine(DateTime? date) {
  final title = 'photo_book_diary'.tr;
  final wd = _weekday(date);
  return wd.isEmpty ? title : '$title · $wd';
}

// ---------------------------------------------------------------------- 工具

DateTime? _parseDate(String raw) {
  if (raw.trim().isEmpty) return null;
  return DateTime.tryParse(raw);
}

/// 照片宽高比（w/h）；拿不到就返回 0
double _ratioOf(Map<String, dynamic>? p) {
  if (p == null) return 0;
  final w = (p['width'] as num?)?.toDouble() ?? 0;
  final h = (p['height'] as num?)?.toDouble() ?? 0;
  if (w <= 0 || h <= 0) return 0;
  return w / h;
}

/// 主图该用多大的框：竖片竖框、横片横框、方片方框
double _frameFor(Map<String, dynamic>? p) {
  final r = _ratioOf(p);
  if (r <= 0) return 16 / 10;
  if (r < 0.72) return 9 / 16;
  if (r < 0.95) return 3 / 4;
  if (r < 1.15) return 1;
  if (r > 2.1) return 21 / 9;
  if (r > 1.7) return 16 / 9;
  return 4 / 3;
}

String _isoDate(DateTime? d) {
  if (d == null) return '';
  final mm = d.month.toString().padLeft(2, '0');
  final dd = d.day.toString().padLeft(2, '0');
  return '${d.year}.$mm.$dd';
}

String _weekday(DateTime? d) {
  if (d == null) return '';
  try {
    final lc = Get.locale?.toString() ?? 'zh_CN';
    return DateFormat('EEEE', lc).format(d);
  } catch (_) {
    return '';
  }
}

List<String> _strings(dynamic raw) {
  if (raw is! List) return const <String>[];
  return raw
      .map((e) => e.toString().trim())
      .where((e) => e.isNotEmpty)
      .toList();
}

/// 这一天的文字：有已确认记忆的备注就用备注，否则按真实标签拼一句
/// （不编故事：只描述「几张、在哪、画面里有什么、和谁」）。
String _storyOf(Map<String, dynamic> day) {
  final note = (day['note'] ?? '').toString().trim();
  if (note.isNotEmpty) return note;
  final count = (day['photo_count'] as num?)?.toInt() ?? 0;
  final place = (day['place'] ?? '').toString().trim();
  final scenes = _strings(day['scenes']);
  final acts = _strings(day['activities']);
  final people = _strings(day['people']);
  final buf = StringBuffer();
  buf.write(place.isEmpty
      ? 'photo_book_story_plain'.trParams({'count': '$count'})
      : 'photo_book_story_place'
          .trParams({'count': '$count', 'place': place}));
  if (scenes.isNotEmpty) {
    buf.write('photo_book_story_scenes'
        .trParams({'scenes': scenes.take(3).join('、')}));
  }
  if (acts.isNotEmpty) {
    buf.write('photo_book_story_acts'
        .trParams({'acts': acts.take(2).join('、')}));
  }
  if (people.isNotEmpty) {
    buf.write('photo_book_story_people'
        .trParams({'names': people.take(3).join('、')}));
  }
  buf.write('photo_book_story_end'.tr);
  return buf.toString();
}
