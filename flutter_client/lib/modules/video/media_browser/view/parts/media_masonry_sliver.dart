import 'package:WaterNasOS/modules/video/base/beans/video_item_bean.dart';
import 'package:WaterNasOS/modules/video/media_browser/view/parts/video_media_grid.dart';
import 'package:flutter/material.dart';

/// 手写瀑布流（**零新依赖**）。
///
/// ## 为什么不引 `flutter_staggered_grid_view`
/// 本地 pub 缓存里没有这个包，引进来就得联网 `pub get`（构建风险大）。
/// 而 SDK 自带的两件套已经够用：
///
/// * [SliverCrossAxisGroup]：`setupParentData` 会给每个子 sliver 设
///   `crossAxisFlex = 1`，于是把 `crossAxisExtent` **均分**给 N 个子 sliver，
///   并且给它们传同一个 `scrollOffset` ⇒ 各列天然同步滚动、整体只有一个滚动条。
/// * [SliverVariedExtentList]：`itemExtentBuilder` 给出**精确**主轴向高度。
///   ⚠️ **不能图省事用 `SliverList`** —— 它只报「已 layout 的 child」的 extent，
///   `scrollExtent` 会被低估，表现是滚动条长度乱跳 + 滚到底自动加载判不出来。
///   `RenderSliverFixedExtentBoxAdaptor.computeMaxScrollOffset()` 在
///   `itemExtentBuilder` 非空时是**累加全部 childCount 个 extent**，是精确值。
///
/// ## 列分配为什么可以每次 rebuild 重算
/// [distributeColumns] 只依赖 `(item 数, 列数, 列宽, 每项比例)`，是纯函数 +
/// 确定性贪心（每次塞进当前最矮的列）⇒ 同样的输入永远得到同样的列划分，
/// 所以重算不会让条目在列之间"跳"。O(n × 列数)，几千项也就几万次浮点运算。
class MediaMasonrySliver extends StatelessWidget {
  final List<VideoHomeItemBean> items;

  /// 目标列宽（越大一行越少）。
  ///
  /// ⭐ 430 是「**卡片短边 ≈240**」倒推出来的（需求 2026-10-11 明确要求 240）：
  /// 瀑布流的列宽是均分的，而混合库里绝大多数是**横屏**素材
  /// （库5 实测：影片 16:9、同名封面图 2560×1440 也是 16:9），
  /// 横屏项的高度 = 列宽 × 9/16 ⇒ 只有列宽 ≈430 时高度才够 240。
  /// 原来的 180 会让横屏影片卡片只有 180×101，是整页里最小的一类。
  final double desiredColumnWidth;

  /// 视频条目用横版缩略图（fanart 3:2）还是竖版封面（poster 2:3）
  final bool showFanart;

  /// ⭐ 名称显示（2026-10-11）：瀑布流里名字压在**图片内部最下方**。
  ///
  /// 刻意**不占额外高度** —— 每项的主轴高度仍严格等于
  /// `columnWidth / aspect`，[SliverVariedExtentList.itemExtentBuilder] 与
  /// 实际 child 高度必须逐像素一致，否则 `scrollExtent` 会被算错、
  /// 出现"滚到底还有空白 / 加载不出来"。
  final bool showName;

  final void Function(int index) onOpen;

  const MediaMasonrySliver({
    super.key,
    required this.items,
    required this.onOpen,
    this.desiredColumnWidth = 430,
    this.showFanart = false,
    this.showName = false,
  });

  /// 没有宽高信息时的兜底比例：4:3（需求明确「不要方形」）
  static const double fallbackAspect = 4 / 3;

  /// 「显式竖版海报」的基名。扫描期 `videoIndexIndexUtil.resolveArtworkPaths`
  /// 会把这些通用名当成 poster 候选，它们天生是竖版（TMDB 海报 ≈ 2:3），
  /// 所以**不能**用视频自己的横版尺寸去套它们。
  static const Set<String> _portraitPosterBases = <String>{
    'poster',
    'folder',
    'cover',
    'front',
    'movie',
    'season',
  };

  /// 这条目的封面是不是一张「显式竖版海报」（poster.jpg / xxx-poster.jpg）。
  /// ⚠️ 只认 [posterPath]：同名图片（xxx.mp4 + xxx.jpg）走的是默认分支 ——
  /// 它本来就和视频同比例，正是本次要修的那种情况。
  static bool _isExplicitPortraitPoster(VideoHomeItemBean item) {
    final raw = item.posterPath.trim();
    if (raw.isEmpty) return false;
    final name = raw.split(RegExp(r'[\\/]')).last;
    final dot = name.lastIndexOf('.');
    final base = (dot > 0 ? name.substring(0, dot) : name).trim().toLowerCase();
    if (base.isEmpty) return false;
    if (_portraitPosterBases.contains(base)) return true;
    for (final suf in const <String>['-poster', '_poster', '-post', '_post']) {
      if (base.endsWith(suf)) return true;
    }
    return false;
  }

  /// 单项的宽高比（= w / h）。会被夹到 [0.5, 2.6]：
  /// 全景长图（如 9504×6336 之外的极端比例）或细长条如果不夹，
  /// 会把某一列拉成一条缝，整个瀑布流就废了。
  static double aspectFor(VideoHomeItemBean item, {bool showFanart = false}) {
    final w = item.width;
    final h = item.height;

    if (item.isImage) {
      if (w > 0 && h > 0) {
        final a = w / h;
        if (a.isFinite && a > 0) return a.clamp(0.5, 2.6);
      }
      return fallbackAspect;
    }

    // ---- 视频 ----
    // ⭐ 这里原来**一律**返回 2:3 / 3:2（影视库的「竖版封面 / 横版缩略图」惯例），
    //    在图片视频混合库里就出事了：混合库的视频几乎全是横屏（实测 991 条里
    //    986 条有 ffprobe 尺寸，全是 3840×2160 / 1280×720 这种），而它们的封面
    //    通常就是同目录的同名图片（实测 955/991，其中 937 张是横版截图）
    //    ⇒ 横版的图被塞进 2:3 竖框、被 cover 裁掉左右一大半，
    //    用户看到的就是「明明是横屏的视频，显示成了竖屏」。
    //    现在：有真实尺寸就按真实比例走。
    if (showFanart && item.fanartPath.trim().isNotEmpty) {
      // backdrop 实测 ≈1.49，不是 16:9；拿它去 cover 16:9 的框会上下各裁一条
      return 3 / 2;
    }
    if (w > 0 && h > 0 && !_isExplicitPortraitPoster(item)) {
      final a = w / h;
      if (a.isFinite && a > 0) return a.clamp(0.5, 2.6);
    }
    // 没有尺寸 / 或封面是显式竖版海报 ⇒ 回到影视库的惯例比例
    return showFanart ? 3 / 2 : 2 / 3;
  }

  /// 确定性贪心：按顺序把每一项塞进「当前累计高度最矮」的列。
  /// 返回「第 c 列依次放哪些 item 下标」。
  static List<List<int>> distributeColumns({
    required int itemCount,
    required int columnCount,
    required double columnWidth,
    required double spacing,
    required double Function(int index) aspectAt,
  }) {
    final columns = List<List<int>>.generate(columnCount, (_) => <int>[]);
    if (columnCount <= 0 || itemCount <= 0) return columns;
    final heights = List<double>.filled(columnCount, 0);

    for (var i = 0; i < itemCount; i++) {
      var best = 0;
      for (var c = 1; c < columnCount; c++) {
        if (heights[c] < heights[best]) best = c;
      }
      columns[best].add(i);
      final a = aspectAt(i);
      final h = (a.isFinite && a > 0) ? columnWidth / a : columnWidth;
      heights[best] += h + spacing;
    }
    return columns;
  }

  @override
  Widget build(BuildContext context) {
    return SliverLayoutBuilder(
      builder: (context, constraints) {
        final maxWidth = constraints.crossAxisExtent;
        final spacing = maxWidth < 520 ? 6.0 : 10.0;
        final desired = maxWidth < 520 ? 130.0 : desiredColumnWidth;
        final columnCount = ((maxWidth + spacing) / (desired + spacing))
            .floor()
            .clamp(2, 8);

        // 每列左右各留 spacing/2 ⇒ 相邻列内容之间的可见间隙正好是 spacing
        final columnWidth = maxWidth / columnCount - spacing;
        if (columnWidth <= 0) return const SliverToBoxAdapter(child: SizedBox());

        final columns = distributeColumns(
          itemCount: items.length,
          columnCount: columnCount,
          columnWidth: columnWidth,
          spacing: spacing,
          aspectAt: (i) => aspectFor(items[i], showFanart: showFanart),
        );

        // ⚠️ 必须**恒发满 columnCount 个子 sliver**：
        //    SliverCrossAxisGroup 是按「各子项的 crossAxisFlex 之和」均分轴宽的，
        //    少发一个空列就会让剩下的列被拉宽，列宽就不再是 columnWidth 了。
        return SliverCrossAxisGroup(
          slivers: [
            for (var c = 0; c < columnCount; c++)
              SliverPadding(
                padding: EdgeInsets.symmetric(horizontal: spacing / 2),
                sliver: columns[c].isEmpty
                    ? const SliverToBoxAdapter(child: SizedBox())
                    : SliverVariedExtentList(
                        itemExtentBuilder: (index, dimensions) {
                          final itemIndex = columns[c][index];
                          return columnWidth /
                                  aspectFor(
                                    items[itemIndex],
                                    showFanart: showFanart,
                                  ) +
                              spacing;
                        },
                        delegate: SliverChildBuilderDelegate((context, index) {
                          // 防御：items 缩水后仍持有旧下标会越界（删图 / 刷新竞态）
                          final col = columns[c];
                          if (index < 0 || index >= col.length) {
                            return const SizedBox.shrink();
                          }
                          final itemIndex = col[index];
                          if (itemIndex < 0 || itemIndex >= items.length) {
                            return const SizedBox.shrink();
                          }
                          return Padding(
                            padding: EdgeInsets.only(bottom: spacing),
                            child: VideoMediaTile(
                              item: items[itemIndex],
                              size: columnWidth,
                              // ⭐ 透传「封面图 / 缩略图」开关：漏了它的话，
                              //    瀑布流里切这个开关将完全没有反应（只有网格模式会变）。
                              showFanart: showFanart,
                              // ⭐ 透传「名称显示」开关。overlayTitle: true ⇒
                              //    名字压在图片内部最下方，**不改变 itemExtent**
                              //    （上面 itemExtentBuilder 只算 columnWidth / aspect）。
                              showName: showName,
                              overlayTitle: true,
                              onTap: () => onOpen(itemIndex),
                            ),
                          );
                        }, childCount: columns[c].length),
                      ),
              ),
          ],
        );
      },
    );
  }
}
