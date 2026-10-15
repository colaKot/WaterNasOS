import 'package:WaterNasOS/core/api/api_controller.dart';
import 'package:WaterNasOS/modules/base/components/custom_extended_image.dart';
import 'package:WaterNasOS/modules/video/base/beans/video_item_bean.dart';
// ⭐ 日本片徽章组件与海报组件共用（见 base/views/video_item_poster.dart）
import 'package:WaterNasOS/modules/video/base/views/video_item_poster.dart';
import 'package:WaterNasOS/modules/video/base/video_utils/video_utils.dart';
import 'package:WaterNasOS/modules/video/list/controller/video_list_controller.dart';
import 'package:flutter/material.dart';
import 'package:get/get.dart';

/// 图片库 / 混合库：网格缩略图列表（统一格子比例，即「普通网格」）
class VideoMediaGrid extends StatelessWidget {
  final VideoListController controller;
  final ValueChanged<int> onOpen;

  /// 视频条目用横版缩略图还是竖版封面（对应顶栏「封面图 / 缩略图」开关）。
  /// 图片条目不受影响（永远用自己的 tiny 缩略图）。
  final bool showFanart;

  const VideoMediaGrid({
    super.key,
    required this.controller,
    required this.onOpen,
    this.showFanart = false,
  });

  /// 格子比例：**4:3**（需求明确「不要方形」）。
  /// 这里是「普通网格」，一行必须对齐 ⇒ 只能取一个统一比例。
  /// 想看每张原比例的用「瀑布流」（media_masonry_sliver.dart）。
  static const double tileAspect = 4 / 3;

  /// 开了名称显示时，标题行占掉的高度（文字 12px × height 1.15 ≈ 14，
  /// 加 6 的间距 ⇒ 20）。网格的 `childAspectRatio` 必须把它算进去，
  /// 否则标题会把图片挤扁 / 溢出整行高度不一致。
  static const double titleRowHeight = 20;

  /// 网格缩略图地址：图片走 tiny 缩略图，视频走海报/首帧
  static String thumbUrlOf(
    VideoHomeItemBean item, {
    int size = 400,
    bool showFanart = false,
  }) {
    if (item.isImage) {
      final p = item.fullPath.trim();
      if (p.isEmpty) return '';
      return ApiController.instance.getTinyUrl(p, size: size);
    }
    return showFanart
        ? VideoUtils.getFanartThumbUrl(item, size: size)
        : VideoUtils.getPosterUrl(item, size: size);
  }

  @override
  Widget build(BuildContext context) {
    return Obx(() {
      // ⭐ 这些读取**必须在 Obx 闭包内**（也就是 build 阶段）完成。
      // SliverLayoutBuilder.builder 是 **layout 阶段**才跑的，那时 RxInterface.proxy
      // 早已还原 ⇒ GetX 监听到 0 个响应式依赖 ⇒ canUpdate==false ⇒
      // 抛 "the improper use of a GetX has been detected"，整棵Sliver 子树渲染失败
      // （表现：顶栏有数量、内容区一片空白）。
      final items = controller.items.toList(growable: false);
      final posterScale = controller.posterScale.value;
      final showName = controller.showName.value;
      return SliverLayoutBuilder(
        builder: (context, constraints) {
          final maxWidth = constraints.crossAxisExtent;
          // ⭐ 320 是「**卡片短边 =240**」倒推的（需求 2026-10-11）：
          //    普通网格统一 4:3 ⇒ 高 = 宽 × 3/4，要短边 240 就得宽 320。
          //    原来是 160（= 160×120，确实太小）。
          final baseWidth = maxWidth < 520 ? 120.0 : 320.0;
          final desiredWidth = baseWidth * posterScale;
          final crossAxisCount = (maxWidth / desiredWidth).floor().clamp(2, 12);
          final spacing = maxWidth < 520 ? 8.0 : 12.0;
          final totalSpacing = spacing * (crossAxisCount - 1);
          final itemWidth = (maxWidth - totalSpacing) / crossAxisCount;
          // 图片高度（4:3）+ 可选标题行 ⇒ 格子主轴高度
          final imageHeight = itemWidth / tileAspect;
          final cellHeight = imageHeight + (showName ? titleRowHeight : 0);

          return SliverGrid(
            delegate: SliverChildBuilderDelegate((context, idx) {
              final item = items[idx];
              // ⭐ 网格模式（需求 2026-10-11）：名字写在**图片下方**，
              //    和影视列表的卡片一样。
              if (showName) {
                return VideoMediaTitleCell(
                  item: item,
                  width: itemWidth,
                  imageHeight: imageHeight,
                  showFanart: showFanart,
                  onTap: () => onOpen(idx),
                );
              }
              return VideoMediaTile(
                item: item,
                size: itemWidth,
                showFanart: showFanart,
                onTap: () => onOpen(idx),
              );
            }, childCount: items.length),
            gridDelegate: SliverGridDelegateWithFixedCrossAxisCount(
              crossAxisCount: crossAxisCount,
              mainAxisSpacing: spacing,
              crossAxisSpacing: spacing,
              // ⭐ 原来是 1（正方形）—— 图片被裁成方砖，一排下来既看不出构图、
              //    也看不出横竖，观感很差。改成 **4:3**：横向略宽、封面按 cover
              //    裁切，一行永远对齐。想要原比例的去看「瀑布流」
              //    （media_masonry_sliver.dart，按 width/height 还原真实比例）。
              // ⚠️ 开了名称显示后必须用**反算的** aspectRatio，不能再用常量
              //    tileAspect —— 否则标题行会把图片挤扁。
              childAspectRatio: showName
                  ? (itemWidth / cellHeight)
                  : tileAspect,
            ),
          );
        },
      );
    });
  }
}

/// 带下方标题的网格卡片：图片（圆角）+ 图片下方一行名称。
///
/// 对齐方式与 `VideoItemPoster`（影视列表卡片）一致：标题居中、单行省略；
/// 图片与标题之间的间距 = [VideoMediaGrid.titleRowHeight] - 行高，保证
/// 整格高度恰好等于网格算出来的 `cellHeight`。
class VideoMediaTitleCell extends StatelessWidget {
  final VideoHomeItemBean item;
  final double width;
  final double imageHeight;
  final bool showFanart;
  final VoidCallback onTap;

  const VideoMediaTitleCell({
    super.key,
    required this.item,
    required this.width,
    required this.imageHeight,
    required this.onTap,
    this.showFanart = false,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final url = VideoMediaGrid.thumbUrlOf(
      item,
      size: (width * 2).round(),
      showFanart: showFanart,
    );
    final hasTitle = VideoMediaTile.titleOf(item).isNotEmpty;

    return MouseRegion(
      cursor: SystemMouseCursors.click,
      child: GestureDetector(
        onTap: onTap,
        // 外层 Column 高度 == imageHeight + titleRowHeight == 格子高度
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            SizedBox(
              height: imageHeight,
              child: ClipRRect(
                borderRadius: BorderRadius.circular(10),
                child: Stack(
                  fit: StackFit.expand,
                  children: [
                    ColoredBox(
                      color: theme.colorScheme.onSurface.withValues(alpha: 0.06),
                      child: url.isEmpty
                          ? Icon(
                              Icons.broken_image_outlined,
                              color: theme.colorScheme.onSurface.withValues(
                                alpha: 0.3,
                              ),
                            )
                          : CustomExtendedImage(
                              imageUrl: url,
                              fit: BoxFit.cover,
                              borderRadius: 0,
                              showLoading: false,
                            ),
                    ),
                    if (!item.isImage)
                      Positioned(
                        left: 6,
                        bottom: 6,
                        child: Container(
                          padding: const EdgeInsets.all(5),
                          decoration: BoxDecoration(
                            color: Colors.black.withValues(alpha: 0.5),
                            shape: BoxShape.circle,
                          ),
                          child: const Icon(
                            Icons.play_arrow,
                            size: 16,
                            color: Colors.white,
                          ),
                        ),
                      ),
                  ],
                ),
              ),
            ),
            if (hasTitle)
              // 标题行：文字 12px × height 1.15 ≈ 14 + 上方 6 间距 = 20
              Padding(
                padding: const EdgeInsets.only(top: 6),
                child: Text(
                  VideoMediaTile.titleOf(item),
                  textAlign: TextAlign.center,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: theme.textTheme.bodySmall?.copyWith(
                    fontSize: 12,
                    height: 1.15,
                    color: theme.colorScheme.onSurface.withValues(alpha: 0.88),
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }
}

class VideoMediaTile extends StatelessWidget {
  final VideoHomeItemBean item;
  final double size;
  final bool showFanart;
  final VoidCallback onTap;

  /// ⭐ 名称显示（2026-10-11）——**呈现位置由它决定**：
  /// * `true`  = 名字压在**图片内部的最下方**（瀑布流用；不占额外高度）
  /// * `false` = 名字写在**图片下方**（普通网格用；由 [VideoMediaGrid] 预留行高）
  final bool showName;
  final bool overlayTitle;

  const VideoMediaTile({
    super.key,
    required this.item,
    required this.size,
    required this.onTap,
    this.showFanart = false,
    this.showName = false,
    this.overlayTitle = false,
  });

  /// 卡片上要显示的名字：影视条目优先用刮削名（NFO），图片没有 NFO ⇒ 文件名。
  ///
  /// ⚠️ 图片的 [VideoHomeItemBean.filename] 就是**带后缀的原始文件名**
  /// （服务端存的是 `filename` + `path`，不是拼接好的全路径）——
  /// 用户要的是"名称"，不是"全路径"，所以这里直接用它，**不要**再拼 `path`。
  static String titleOf(VideoHomeItemBean item) {
    final nfo = item.nfoName.trim();
    if (nfo.isNotEmpty) return nfo;
    return item.filename.trim();
  }

  /// 名字文字样式：图片库里的名字是"压在照片上"的信息，用固定白色 + 黑色渐变，
  /// 与 [MediaFolderTile] 的目录名、以及播放角标**同一口径**（不跟主题走）。
  static const TextStyle _overlayTextStyle = TextStyle(
    color: Colors.white,
    fontSize: 12,
    fontWeight: FontWeight.w600,
    height: 1.15,
  );

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final url = VideoMediaGrid.thumbUrlOf(
      item,
      size: (size * 2).round(),
      showFanart: showFanart,
    );
    final overlay = showName && overlayTitle;

    return MouseRegion(
      cursor: SystemMouseCursors.click,
      child: GestureDetector(
        onTap: onTap,
        child: ClipRRect(
          borderRadius: BorderRadius.circular(10),
          child: Stack(
            fit: StackFit.expand,
            children: [
              ColoredBox(
                color: theme.colorScheme.onSurface.withValues(alpha: 0.06),
                child: url.isEmpty
                    ? Icon(
                        Icons.broken_image_outlined,
                        color: theme.colorScheme.onSurface.withValues(alpha: 0.3),
                      )
                    : CustomExtendedImage(
                        imageUrl: url,
                        fit: BoxFit.cover,
                        borderRadius: 0,
                        showLoading: false,
                      ),
              ),
              // ⭐ 日本片徽章（2026-10-12）：瀑布流封面右上角
              //    数据来自视频索引 jp_uncensored / jp_chinese_sub（扫描时从
              //    文件名后缀 -U / -C / -UC 解析）；只对开了「日本电影」的库有值。
              if (item.hasJpTags)
                Positioned(
                  top: 6,
                  right: 6,
                  child: JpTagBadges(item: item, scale: 0.85),
                ),
              // 视频条目叠一个播放角标，与图片区分。
              // ⚠️ 开了内部标题时角标要上移，否则会和标题叠在一起。
              if (!item.isImage)
                Positioned(
                  left: 6,
                  bottom: overlay ? 34 : 6,
                  child: Container(
                    padding: const EdgeInsets.all(5),
                    decoration: BoxDecoration(
                      color: Colors.black.withValues(alpha: 0.5),
                      shape: BoxShape.circle,
                    ),
                    child: const Icon(
                      Icons.play_arrow,
                      size: 16,
                      color: Colors.white,
                    ),
                  ),
                ),
              // ⭐ 瀑布流：名字压在图片内部最下方（需求 2026-10-11）
              if (overlay)
                Positioned(
                  left: 0,
                  right: 0,
                  bottom: 0,
                  child: Container(
                    padding: const EdgeInsets.fromLTRB(8, 20, 8, 7),
                    decoration: BoxDecoration(
                      gradient: LinearGradient(
                        begin: Alignment.topCenter,
                        end: Alignment.bottomCenter,
                        colors: [
                          Colors.transparent,
                          Colors.black.withValues(alpha: 0.78),
                        ],
                      ),
                    ),
                    child: Text(
                      titleOf(item),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: _overlayTextStyle,
                    ),
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }
}
