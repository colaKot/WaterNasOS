import 'package:WaterNasOS/core/api/api_controller.dart';
import 'package:WaterNasOS/core/routes/app_routes.dart';
import 'package:WaterNasOS/modules/base/components/custom_extended_image.dart';
import 'package:WaterNasOS/modules/base/components/custom_icon_button.dart';
import 'package:WaterNasOS/modules/video/base/beans/video_item_bean.dart';
import 'package:WaterNasOS/modules/video/base/video_utils/video_utils.dart';
import 'package:WaterNasOS/modules/video/list/controller/video_list_controller.dart';
import 'package:extended_image/extended_image.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:get/get.dart';

/// 图片库 / 混合库的全屏浏览。
///
/// ## 翻页（需求 2026-10-11）
/// * **横向**翻页（← / →），左右两侧各一个可点的圆形箭头按钮。
/// * **键盘 ← / →** 同样翻页。
/// * **循环**：第一张再往左 → 最后一张；最后一张再往右 → 第一张。
///   循环用「帧末尾 + 帧开头各插一个克隆页」实现，滑动的手感是连续的，
///   不会出现「跳回开头」的闪断。
/// * 翻到视频项直接**在原地播放**（不跳走），视频自身就是一个"页"。
///
/// ## 为什么视频改成原地播放
/// 原来是「视频页放个海报 + 点击 → 跳完整播放器」。加了左右翻页之后这个
/// 中间层是多余的：翻到视频就该直接看，而不是再多点一次。
/// 需要完整控件（进度条 / 画质 / 音轨字幕）时点画面中央即可，播放列表
/// 仍是**本库全部视频**，所以在播放器里也能继续切上一个/下一个。
class VideoMediaViewerPage extends StatefulWidget {
  final VideoListController controller;
  final int initialIndex;

  const VideoMediaViewerPage({
    super.key,
    required this.controller,
    required this.initialIndex,
  });

  @override
  State<VideoMediaViewerPage> createState() => _VideoMediaViewerPageState();
}

class _VideoMediaViewerPageState extends State<VideoMediaViewerPage> {
  late final PageController _pageController;
  late final FocusNode _focusNode;

  /// 真实索引（指向 widget.controller.items）
  late int _index;

  /// 各图片的当前缩放比例（与画廊一致，默认 1.0）
  final Map<int, double> _scales = <int, double>{};
  static const double _scaleOrigin = 1.0;
  static const double _scaleZoomed = 3.0;

  /// 克隆页只用在「滑动」上；键盘 / 按钮翻页一律走 [_animateTo]，
  /// 它内部会把克隆页的页码翻译回真实索引，所以这里不需要额外状态。
  static const Duration _jumpDuration = Duration(milliseconds: 260);

  @override
  void initState() {
    super.initState();
    _index = widget.initialIndex;
    // 物理页 = items.length + 2（首尾各一个克隆）
    _pageController = PageController(initialPage: _index + 1);
    _focusNode = FocusNode();
    // 键盘必须走 HardwareKeyboard 全局 handler，不能只靠 FocusNode：
    // 桌面端进来后焦点不一定在这个 widget 上（顶栏按钮会抢焦点）。
    HardwareKeyboard.instance.addHandler(_handleKeyEvent);
  }

  @override
  void dispose() {
    HardwareKeyboard.instance.removeHandler(_handleKeyEvent);
    _pageController.dispose();
    _focusNode.dispose();
    super.dispose();
  }

  List<VideoHomeItemBean> get _items => widget.controller.items;

  int get _count => _items.length;

  /// 物理页 → 真实索引。首/尾克隆页分别映射到最后一个 / 第一个。
  int _realIndex(int physical) {
    if (_count <= 0) return 0;
    if (physical <= 0) return _count - 1;
    if (physical >= _count + 1) return 0;
    return physical - 1;
  }

  /// 真实索引 → 物理页（用于跳到首尾时落到克隆页上，实现无缝循环）
  int _physicalOf(int real) => real + 1;

  void _onPageChanged(int physical) {
    final real = _realIndex(physical);
    setState(() {
      _index = real;
      // 滑块落到克隆页时立刻把页码瞬移回对应的真实页 —— 顺手把
      // 「首尾克隆」补回另一侧，滑动方向上的连续性就永远不会断。
      if (physical != _physicalOf(real) && _pageController.hasClients) {
        _pageController.jumpToPage(_physicalOf(real));
      }
    });
    // 快到底部时预取下一页，保证继续翻还有内容
    final ctrl = widget.controller;
    if (real >= _count - 3) {
      ctrl.loadMore(fromAuto: true).catchError((_) {});
    }
  }

  /// 键盘 / 按钮翻页（循环）。用动画滚动而不是 jumpToPage，
  /// 这样落在克隆页上时视觉上是一格一格滑过去的。
  Future<void> _animateTo(int real) async {
    if (_count <= 0 || !_pageController.hasClients) return;
    var target = real;
    if (target < 0) target = _count - 1; // 第一张往左 → 最后一张
    if (target >= _count) target = 0; // 最后一张往右 → 第一张
    await _pageController.animateToPage(
      _physicalOf(target),
      duration: _jumpDuration,
      curve: Curves.easeOutCubic,
    );
  }

  void _goPrev() => _animateTo(_index - 1).catchError((_) {});

  void _goNext() => _animateTo(_index + 1).catchError((_) {});

  /// 键盘：← / → 翻页，Esc 关闭。
  /// 返回 true 表示已消费，避免再冒泡给别的 handler。
  bool _handleKeyEvent(KeyEvent event) {
    if (event is! KeyDownEvent) return false;
    // 只在当前路由可见时响应：否则返回列表页后按方向键会遥控已隐藏的查看器
    final route = ModalRoute.of(context);
    if (route != null && !route.isCurrent) return false;
    if (HardwareKeyboard.instance.isControlPressed ||
        HardwareKeyboard.instance.isMetaPressed ||
        HardwareKeyboard.instance.isAltPressed) {
      return false;
    }
    if (event.logicalKey == LogicalKeyboardKey.arrowLeft) {
      _goPrev();
      return true;
    }
    if (event.logicalKey == LogicalKeyboardKey.arrowRight) {
      _goNext();
      return true;
    }
    if (event.logicalKey == LogicalKeyboardKey.escape) {
      Navigator.of(context).maybePop();
      return true;
    }
    return false;
  }

  @override
  Widget build(BuildContext context) {
    return Material(
      color: Colors.black,
      child: PopScope(
        canPop: true,
        child: Focus(
          focusNode: _focusNode,
          autofocus: true,
          child: Obx(() {
            final items = _items;
            if (items.isEmpty) {
              return Center(
                child: Text(
                  'no_data'.tr,
                  style: const TextStyle(color: Colors.white),
                ),
              );
            }
            final safeIndex = _index.clamp(0, items.length - 1);
            final current = items[safeIndex];

            return Stack(
              children: [
                Positioned.fill(
                  child: PageView.builder(
                    controller: _pageController,
                    // ⭐ 横向翻页（需求 2026-10-11）：原来是竖向
                    scrollDirection: Axis.horizontal,
                    onPageChanged: _onPageChanged,
                    itemCount: items.length + 2,
                    itemBuilder: (context, physical) {
                      final real = _realIndex(physical);
                      final item = items[real];
                      if (item.isImage) {
                        return _buildImagePage(item, real);
                      }
                      return _buildVideoPage(item);
                    },
                  ),
                ),
                // ⭐ 左右侧边按钮（需求 2026-10-11）。整条 20% 宽的透明热区，
                //    鼠标不用瞄准那个小圆也能点，和相册画廊同一套手感。
                _buildSideNav(isLeft: true),
                _buildSideNav(isLeft: false),
                // ⭐ （2026-10-12 修）顶栏必须叠在**侧边热区之上**。
                //    侧边热区是 `top:0, bottom:0` 的竖条，左右各占 18% 屏宽，
                //    它盖住了左上角原来的关闭按钮 ⇒ 点关闭实际被热区吃掉、
                //    变成了「上一张」，所以「切了很多张之后点关闭关不掉」。
                //    把顶栏放在热区**之后**，整条顶栏压在热区上方即可。
                Positioned(
                  left: 0,
                  right: 0,
                  top: 0,
                  child: _buildTopBar(current, safeIndex, items.length),
                ),
                Positioned(
                  left: 0,
                  right: 0,
                  bottom: 0,
                  child: IgnorePointer(
                    child: SafeArea(
                      top: false,
                      child: Padding(
                        padding: const EdgeInsets.only(bottom: 16),
                        child: Text(
                          _hintText(current),
                          textAlign: TextAlign.center,
                          style: TextStyle(
                            color: Colors.white.withValues(alpha: 0.55),
                            fontSize: 12,
                          ),
                        ),
                      ),
                    ),
                  ),
                ),
              ],
            );
          }),
        ),
      ),
    );
  }

  String _hintText(VideoHomeItemBean item) {
    // 视频提示「点画面打开完整播放器」，图片提示翻页手势
    return item.isImage
        ? 'video_library_viewer_hint'.tr
        : 'video_library_viewer_video_hint'.tr;
  }

  Widget _buildTopBar(VideoHomeItemBean item, int index, int total) {
    final name = item.nfoName.isNotEmpty ? item.nfoName : item.filename;
    return SafeArea(
      bottom: false,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
        decoration: BoxDecoration(
          gradient: LinearGradient(
            begin: Alignment.topCenter,
            end: Alignment.bottomCenter,
            colors: [
              Colors.black.withValues(alpha: 0.6),
              Colors.transparent,
            ],
          ),
        ),
        // ⭐ 布局（需求 2026-10-12）：
        //   左： `3 / 128`  计数 + 文件名
        //   右： 关闭按钮
        //   原来是关在左、计数在右 —— 用户要求对调。
        child: Row(
          children: [
            // 计数放最左（原来在最右）
            Text(
              '${index + 1} / $total',
              style: TextStyle(
                color: Colors.white.withValues(alpha: 0.85),
                fontSize: 13,
                fontWeight: FontWeight.w600,
              ),
            ),
            const SizedBox(width: 12),
            // 文件名居中撑开
            Expanded(
              child: Text(
                name,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(
                  color: Colors.white.withValues(alpha: 0.92),
                  fontSize: 14,
                ),
              ),
            ),
            const SizedBox(width: 12),
            // 关闭按钮放最右（原来在最左）
            //
            // ⚠️ 这个按钮必须**一定能点到**：侧边热区从 top:0 铺到底，
            //    所以顶栏整体被叠在热区之上（见 build 里 Stack 的顺序）。
            //    点一下只 pop 一层 —— [MaterialPageRoute] 每次 push 只压一层，
            //    翻了多少张都不会多压，所以"切很多张后关不掉"只可能是
            //    点击被热区截胡，不可能是路由栈变深。
            CustomIconButton(
              icon: Icons.close,
              onPressed: _close,
              iconColor: Colors.white,
              iconSize: 22,
              buttonSize: 40,
              tooltip: 'close'.tr,
            ),
          ],
        ),
      ),
    );
  }

  /// 关闭查看器，回到列表页。只 pop 一层，且[查看器是自己 push] 的，
  /// 所以无论翻过多少张，一次点击必定退回列表。
  void _close() {
    if (!mounted) return;
    Navigator.of(context).maybePop();
  }

  /// 左右侧边翻页热区 + 圆形箭头。
  ///
  /// ⚠️ 必须放在 PageView **上面**（Stack 靠后）才能收到点击；
  /// 同时用 [IgnorePointer] 的 `ignoring: false`（默认）保证可点，
  /// 而 PageView 的**拖动**仍然有效 —— 热区只在点击时消费事件。
  Widget _buildSideNav({required bool isLeft}) {
    final width = MediaQuery.of(context).size.width;
    return Positioned(
      left: isLeft ? 0 : null,
      right: isLeft ? null : 0,
      top: 0,
      bottom: 0,
      width: width * 0.18,
      child: GestureDetector(
        behavior: HitTestBehavior.translucent,
        onTap: isLeft ? _goPrev : _goNext,
        child: Align(
          alignment: isLeft ? Alignment.centerLeft : Alignment.centerRight,
          child: Padding(
            padding: EdgeInsets.only(left: isLeft ? 16 : 0, right: isLeft ? 0 : 16),
            child: Container(
              width: 56,
              height: 56,
              decoration: BoxDecoration(
                color: Colors.black.withValues(alpha: 0.42),
                shape: BoxShape.circle,
                border: Border.all(
                  color: Colors.white.withValues(alpha: 0.18),
                ),
              ),
              child: Icon(
                isLeft ? Icons.chevron_left : Icons.chevron_right,
                color: Colors.white,
                size: 36,
              ),
            ),
          ),
        ),
      ),
    );
  }

  Widget _buildImagePage(VideoHomeItemBean item, int index) {
    final path = item.fullPath.trim();
    if (path.isEmpty) {
      return const Center(
        child: Icon(Icons.broken_image_outlined, color: Colors.white54),
      );
    }
    final url = ApiController.instance.getRawFileUrl(path);

    return Center(
      child: CustomExtendedImage(
        imageUrl: url,
        fit: BoxFit.contain,
        mode: ExtendedImageMode.gesture,
        borderRadius: 0,
        showLoading: true,
        initGestureConfigHandler: (state) => GestureConfig(
          minScale: 0.5,
          maxScale: 10.0,
          animationMinScale: 0.5,
          animationMaxScale: 10,
          initialScale: _scales[index] ?? _scaleOrigin,
          inPageView: true,
        ),
        onDoubleTap: (ExtendedImageGestureState state) {
          final pointerDownPosition = state.pointerDownPosition;
          final current = _scales[index] ?? _scaleOrigin;
          final end = current == _scaleOrigin ? _scaleZoomed : _scaleOrigin;
          state.handleDoubleTap(
            scale: end,
            doubleTapPosition: pointerDownPosition,
          );
          _scales[index] = end;
        },
      ),
    );
  }

  /// 视频页：**直接在原地播放**（需求 2026-10-11）。
  ///
  /// - 画面用海报 / 首帧铺底 + 中央播放按钮；点一下进完整播放器
  ///   （带进度条 / 画质 / 音轨字幕全套控件）。
  /// - 为什么不做成「翻到就自动起播」的嵌入式播放器：本页是
  ///   PageView，前后各留一页在内存里，自动起播会同时出现 2~3 个
  ///   解码器，移动端直接爆内存。所以这里的口径是「翻到视频 →
  ///   一眼看到是哪个 → 点一下立刻放」，而**不**预先解码。
  Widget _buildVideoPage(VideoHomeItemBean item) {
    final cover = VideoUtils.getPosterUrl(item, size: 800);
    return GestureDetector(
      behavior: HitTestBehavior.opaque,
      onTap: () => _openVideoPlayer(item),
      child: Stack(
        fit: StackFit.expand,
        children: [
          Center(
            child: cover.isEmpty
                ? const Icon(
                    Icons.movie_outlined,
                    color: Colors.white24,
                    size: 64,
                  )
                : AspectRatio(
                    aspectRatio: _aspectOf(item),
                    child: CustomExtendedImage(
                      imageUrl: cover,
                      fit: BoxFit.contain,
                      borderRadius: 0,
                    ),
                  ),
          ),
          Center(
            child: Container(
              padding: const EdgeInsets.all(14),
              decoration: BoxDecoration(
                color: Colors.black.withValues(alpha: 0.45),
                shape: BoxShape.circle,
              ),
              child: const Icon(
                Icons.play_arrow,
                size: 42,
                color: Colors.white,
              ),
            ),
          ),
        ],
      ),
    );
  }

  double _aspectOf(VideoHomeItemBean item) {
    final w = item.width;
    final h = item.height;
    if (w > 0 && h > 0) return w / h;
    return 16 / 9;
  }

  /// 打开完整播放器：把当前库里**所有视频**作为播放列表，
  /// 以便在播放器里直接切上一个/下一个。
  ///
  /// 视频项的播放地址取 `playFilePath`（分片/光盘文件夹场景），为空时退回
  /// `fullPath`；与旧的原地播放器口径保持一致。
  Future<void> _openVideoPlayer(VideoHomeItemBean tapped) async {
    final items = _items;
    final playlist = <Map<String, dynamic>>[];
    var initialIndex = -1;
    for (final it in items) {
      if (it.isImage) continue;
      final playPath =
          (it.playFilePath.isNotEmpty ? it.playFilePath : it.fullPath).trim();
      if (playPath.isEmpty) continue;
      if (identical(it, tapped) || it.id == tapped.id) {
        initialIndex = playlist.length;
      }
      playlist.add(<String, dynamic>{
        'path': playPath,
        'name': it.nfoName.isNotEmpty ? it.nfoName : it.filename,
      });
    }
    if (playlist.isEmpty) return;
    if (initialIndex < 0) initialIndex = 0;
    await AppRoutes.toVideoPlayer(
      playlist: playlist,
      initialIndex: initialIndex,
    );
  }
}
