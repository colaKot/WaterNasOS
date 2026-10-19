import 'package:flutter/material.dart';
import 'package:get/get.dart';
import '../../controllers/custom_gallery_controller.dart';

/// 画廊导航箭头组件。
///
/// ⭐ 2026-10-19：补交互反馈。旧版整块 20% 屏宽的透明区域被点中都没有任何视觉变化，
/// 用户不知道能不能点；首/末张也照样可点（点了没反应，像卡住）。现在：
///   · 鼠标移入 ⇒ 圆形底加深、外描边提亮、整体放大 10%、箭头朝方向轻推 2px；
///   · 鼠标按下 ⇒ 缩到 0.92，松开回弹（120ms，easeOut）；
///   · 首张的左箭头 / 末张的右箭头 ⇒ 半透明禁用态，不响应点击。
class GalleryNavigationArrow extends StatefulWidget {
  const GalleryNavigationArrow({super.key, required this.isLeft});

  /// 是否为左箭头
  final bool isLeft;

  @override
  State<GalleryNavigationArrow> createState() => _GalleryNavigationArrowState();
}

class _GalleryNavigationArrowState extends State<GalleryNavigationArrow> {
  bool _hovering = false;
  bool _pressed = false;

  @override
  Widget build(BuildContext context) {
    final controller = Get.find<CustomGalleryController>();
    final screenWidth = MediaQuery.of(context).size.width;
    final isLeft = widget.isLeft;

    return Obx(() {
      final total = controller.galleryItems.length;
      final index = controller.currentIndex.value;
      final atEdge = isLeft ? index <= 0 : index >= total - 1;
      final disabled = total <= 1 || atEdge;
      final visible = controller.isControlsVisible.value;

      return Positioned(
        left: isLeft ? 0 : null,
        right: isLeft ? null : 0,
        top: 0,
        bottom: 0,
        width: screenWidth * 0.2,
        child: IgnorePointer(
          ignoring: disabled,
          child: GestureDetector(
            behavior: HitTestBehavior.translucent,
            onTapDown: disabled
                ? null
                : (_) => setState(() => _pressed = true),
            onTapCancel: () => setState(() => _pressed = false),
            onTapUp: disabled
                ? null
                : (_) => setState(() => _pressed = false),
            onTap: () => isLeft
                ? controller.previousImage()
                : controller.nextImage(),
            child: AnimatedOpacity(
              opacity: visible ? 1.0 : 0.0,
              duration: const Duration(milliseconds: 200),
              child: Align(
                alignment: isLeft ? Alignment.centerLeft : Alignment.centerRight,
                child: Padding(
                  padding: isLeft
                      ? const EdgeInsets.only(left: 20)
                      : const EdgeInsets.only(right: 20),
                  child: MouseRegion(
                    cursor: disabled
                        ? SystemMouseCursors.basic
                        : SystemMouseCursors.click,
                    onEnter: (_) => setState(() => _hovering = true),
                    onExit: (_) {
                      setState(() {
                        _hovering = false;
                        _pressed = false;
                      });
                    },
                    child: AnimatedScale(
                      scale: _pressed ? 0.92 : (_hovering ? 1.10 : 1.0),
                      duration: const Duration(milliseconds: 120),
                      curve: Curves.easeOut,
                      child: AnimatedContainer(
                        duration: const Duration(milliseconds: 140),
                        curve: Curves.easeOut,
                        width: 64,
                        height: 64,
                        alignment: Alignment.center,
                        decoration: BoxDecoration(
                          color: Colors.black.withValues(
                            alpha: disabled
                                ? 0.26
                                : (_hovering ? 0.62 : 0.42),
                          ),
                          shape: BoxShape.circle,
                          border: Border.all(
                            width: 0.5,
                            color: Colors.white.withValues(
                              alpha: disabled
                                  ? 0.10
                                  : (_hovering ? 0.38 : 0.14),
                            ),
                          ),
                        ),
                        child: AnimatedSlide(
                          offset: _hovering && !disabled
                              ? Offset(isLeft ? -0.06 : 0.06, 0)
                              : Offset.zero,
                          duration: const Duration(milliseconds: 140),
                          curve: Curves.easeOut,
                          child: Icon(
                            isLeft ? Icons.chevron_left : Icons.chevron_right,
                            color: Colors.white.withValues(
                              alpha: disabled ? 0.38 : 1.0,
                            ),
                            size: 40,
                          ),
                        ),
                      ),
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
      );
    });
  }
}
