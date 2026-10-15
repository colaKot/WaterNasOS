import 'package:flutter/material.dart';
import '../beans/video_item_bean.dart';
import 'video_item_common.dart';
import '../../../../core/routes/app_routes.dart';
import '../video_utils/video_utils.dart';
import '../video_utils/video_item_utils.dart';
import '../../favorite/service/video_favorite_api_service.dart';

class VideoItemPoster extends StatefulWidget {
  final VideoHomeItemBean item;
  final double width;
  final double borderRadius;
  final double imageRadius;
  final EdgeInsets contentPadding;
  final double? progress;
  final int? currentAlbumId;
  final VoidCallback? onRemovedFromCurrentAlbum;
  final VoidCallback? onTap;
  final VoidCallback? onTitleTap;
  final ValueChanged<bool>? onFavoriteChanged;
  final ValueChanged<VideoHomeItemBean>? onDeleted;

  /// ⭐ 横版「缩略图」模式（2026-10-10）：显示 fanart（16:9）而不是竖版 poster（2:3）。
  /// 由影视列表顶栏的两段开关控制，默认 false = 沿用原来的竖版封面。
  final bool showFanart;

  const VideoItemPoster({
    super.key,
    required this.item,
    this.width = 192,
    this.borderRadius = 16,
    this.imageRadius = 12,
    this.contentPadding = const EdgeInsets.all(10),
    this.progress,
    this.currentAlbumId,
    this.onRemovedFromCurrentAlbum,
    this.onTap,
    this.onTitleTap,
    this.onFavoriteChanged,
    this.onDeleted,
    this.showFanart = false,
  });

  @override
  State<VideoItemPoster> createState() => _VideoItemPosterState();
}

class _VideoItemPosterState extends State<VideoItemPoster> {
  bool _hovered = false;
  bool? _isFavorite;
  bool _favoriteLoading = false;

  bool get _effectiveFavorite => _isFavorite ?? widget.item.isFavorite;

  @override
  void didUpdateWidget(covariant VideoItemPoster oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.item.isFavorite != widget.item.isFavorite) {
      if (_isFavorite == null) return;
      _isFavorite = null;
    }
  }

  Future<void> _toggleFavorite() async {
    if (_favoriteLoading) return;
    final id = widget.item.id;
    if (id <= 0) return;

    final prev = _effectiveFavorite;
    final next = !prev;

    setState(() {
      _favoriteLoading = true;
      _isFavorite = next;
    });

    try {
      final ok = next
          ? await VideoFavoriteApiService.instance.addFavorite(id)
          : await VideoFavoriteApiService.instance.removeFavorite(id);
      if (!ok) {
        setState(() {
          _isFavorite = prev;
        });
        return;
      }
      widget.onFavoriteChanged?.call(next);
    } finally {
      if (mounted) {
        setState(() {
          _favoriteLoading = false;
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final item = widget.item;
    final title = item.nfoName.isNotEmpty ? item.nfoName : item.filename;
    final year = item.nfoYear > 0 ? item.nfoYear.toString() : '';
    // ⭐ 同一张卡片两种图：竖版封面 2:3 / 横版缩略图 16:9（外层的网格宽度会跟着变）
    final posterUrl = widget.showFanart
        ? VideoUtils.getFanartThumbUrl(item, size: 500)
        : VideoUtils.getPosterUrl(item, size: 500);

    final p = widget.progress;
    final safeProgress = p?.clamp(0, 1).toDouble();

    final child = MouseRegion(
      cursor: SystemMouseCursors.click,
      onEnter: (_) => setState(() => _hovered = true),
      onExit: (_) => setState(() => _hovered = false),
      child: SizedBox(
        width: widget.width,
        child: Material(
          color: Colors.transparent,
          borderRadius: BorderRadius.circular(widget.borderRadius),
          child: InkWell(
            borderRadius: BorderRadius.circular(widget.borderRadius),
            onTap: widget.onTap ?? () => AppRoutes.toVideoDetail(item.id),
            child: Container(
              padding: widget.contentPadding,
              decoration: BoxDecoration(
                // color: theme.colorScheme.surface.withValues(alpha: 0.55),
                borderRadius: BorderRadius.circular(widget.borderRadius),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  AspectRatio(
                    // ⭐ 横版 3:2 = 刮削出的 backdrop 图的真实比例（见 video_list_grid 注释）
                    aspectRatio: widget.showFanart ? 3 / 2 : 2 / 3,
                    child: Stack(
                      fit: StackFit.expand,
                      children: [
                        VideoItemCoverImage(
                          imageUrl: posterUrl,
                          borderRadius: widget.imageRadius,
                          rating: item.nfoScore,
                          typeText: videoMediaTypeText(item.mediaType),
                          hovered: _hovered,
                          // ⭐ 横版缩略图用 contain：库里横屏 / 竖屏视频混排，
                          //    用固定比例的框去 cover 一定会把其中一类裁掉一大块。
                          fit: widget.showFanart
                              ? BoxFit.contain
                              : BoxFit.cover,
                        ),
                        // ⭐ 日本片标记徽章（2026-10-12）：封面右上角，压在图片之上
                        if (item.hasJpTags)
                          Positioned(
                            top: 6,
                            right: 6,
                            child: JpTagBadges(item: item),
                          ),
                        if (_hovered || _effectiveFavorite)
                          Positioned(
                            top: 6,
                            left: 6,
                            child: Material(
                              color: Colors.transparent,
                              child: InkWell(
                                borderRadius: BorderRadius.circular(999),
                                onTap: _toggleFavorite,
                                child: Container(
                                  padding: const EdgeInsets.all(6),
                                  decoration: BoxDecoration(
                                    color: theme.colorScheme.surface.withValues(
                                      alpha: 0.75,
                                    ),
                                    borderRadius: BorderRadius.circular(999),
                                    border: Border.all(
                                      color: theme.colorScheme.onSurface
                                          .withValues(alpha: 0.12),
                                    ),
                                  ),
                                  child: Icon(
                                    _effectiveFavorite
                                        ? Icons.favorite
                                        : Icons.favorite_border,
                                    size: 18,
                                    color: _effectiveFavorite
                                        ? Colors.red
                                        : theme.colorScheme.onSurface,
                                  ),
                                ),
                              ),
                            ),
                          ),
                        if (safeProgress != null && safeProgress > 0)
                          Positioned(
                            top: 0,
                            left: 0,
                            right: 0,
                            child: IgnorePointer(
                              child: Align(
                                alignment: Alignment.topCenter,
                                child: FractionallySizedBox(
                                  widthFactor: 0.8,
                                  child: ClipRRect(
                                    borderRadius: BorderRadius.circular(99),
                                    child: LinearProgressIndicator(
                                      value: safeProgress,
                                      minHeight: 5,
                                      backgroundColor: theme
                                          .colorScheme
                                          .onSurface
                                          .withValues(alpha: 0.12),
                                      valueColor: AlwaysStoppedAnimation<Color>(
                                        theme.colorScheme.primary,
                                      ),
                                    ),
                                  ),
                                ),
                              ),
                            ),
                          ),
                      ],
                    ),
                  ),
                  if (safeProgress != null)
                    const SizedBox(height: 10)
                  else
                    const SizedBox(height: 4),
                  InkWell(
                    // onTap:
                    //     widget.onTitleTap ??
                    //     () => AppRoutes.toVideoDetail(item.id),
                    child: Align(
                      alignment: Alignment.center,
                      child: Text(
                        title,
                        textAlign: TextAlign.center,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: theme.textTheme.titleMedium,
                      ),
                    ),
                  ),
                  if (year.isNotEmpty) ...[
                    const SizedBox(height: 4),
                    Text(
                      year,
                      textAlign: TextAlign.center,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: theme.textTheme.labelMedium?.copyWith(
                        color: theme.colorScheme.onSurface.withValues(
                          alpha: 0.6,
                        ),
                      ),
                    ),
                  ],
                ],
              ),
            ),
          ),
        ),
      ),
    );

    final itemOpen = widget.onTap ?? () => AppRoutes.toVideoDetail(item.id);
    return VideoItemContextMenuRegion(
      item: item,
      onOpen: itemOpen,
      onDeleted: widget.onDeleted,
      currentAlbumId: widget.currentAlbumId,
      onRemovedFromCurrentAlbum: widget.onRemovedFromCurrentAlbum,
      child: child,
    );
  }
}

/// ⭐ 日本片标记徽章（2026-10-12）。
///
/// 显示在封面**右上角**：`中` = 中文字幕、`无码` = 无码，两个都有就并排。
/// 数据来自视频索引的 `jp_uncensored` / `jp_chinese_sub` 两列（扫描时从文件名
/// 后缀 `-U` / `-C` / `-UC` 解析）。没标记时返回零尺寸，不影响布局。
///
/// ⚠️ 网格、安卓端海报、瀑布流三处共用这一个组件，别各写一份。
class JpTagBadges extends StatelessWidget {
  final VideoHomeItemBean item;

  /// 小尺寸场景（安卓端海报较小）可以传 0.9 缩短一点
  final double scale;

  const JpTagBadges({super.key, required this.item, this.scale = 1.0});

  @override
  Widget build(BuildContext context) {
    if (!item.hasJpTags) return const SizedBox.shrink();
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        if (item.jpChineseSub) _chip('中', const Color(0xFF2E7D32)),
        if (item.jpChineseSub && item.jpUncensored) SizedBox(width: 4 * scale),
        if (item.jpUncensored) _chip('无码', const Color(0xFFC62828)),
      ],
    );
  }

  Widget _chip(String text, Color color) {
    return Container(
      padding: EdgeInsets.symmetric(
        horizontal: 5 * scale,
        vertical: 1.5 * scale,
      ),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.92),
        borderRadius: BorderRadius.circular(4 * scale),
      ),
      child: Text(
        text,
        style: TextStyle(
          color: Colors.white,
          fontSize: 10 * scale,
          height: 1.15,
          fontWeight: FontWeight.w700,
        ),
      ),
    );
  }
}
