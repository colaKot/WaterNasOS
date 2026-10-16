import 'package:flutter/material.dart';
import '../../../core/theme/app_tokens.dart';

/// 两段式图标开关（2026-10-10，影视列表的「封面图 / 缩略图」用）。
///
/// 造型与 [CustomBorderedIconButton] 同族：方形圆角 + 细边框 + 图标居中。
/// 区别是两半**共享一个外框**、中间一条细缝，选中的那半用主题主色
/// 描边底色高亮、图标也换成主色 —— 看起来是「一个开关」而不是两个按钮。
///
/// 整体尺寸 = 2 × [size]（外加 0.5 的分隔缝），所以 [size] 取 32 时与旁边的
/// 图标按钮等高，只是宽一倍。
class CustomSegmentedIconToggle extends StatelessWidget {
  final IconData firstIcon;
  final IconData secondIcon;
  final String? firstTooltip;
  final String? secondTooltip;

  /// true = 选中**后半**（[secondIcon]），false = 选中前半。
  final bool secondSelected;
  final ValueChanged<bool>? onChanged;

  /// 每一半的边长。
  final double size;
  final double iconSize;
  final double borderRadius;

  /// 点哪一半就把哪个值回调出去；[enabled] 为 false 时整组不可点。
  final bool enabled;

  const CustomSegmentedIconToggle({
    super.key,
    required this.firstIcon,
    required this.secondIcon,
    required this.secondSelected,
    this.firstTooltip,
    this.secondTooltip,
    this.onChanged,
    this.size = 32,
    this.iconSize = 16,
    this.borderRadius = AppRadius.item,
    this.enabled = true,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final activeColor = theme.colorScheme.primary;
    final activeBg = activeColor.withValues(alpha: 0.1);
    final inactiveBorder = theme.dividerColor;
    final inactiveIcon = theme.colorScheme.onSurface.withValues(alpha: 0.7);
    final radius = Radius.circular(borderRadius);

    Widget half({
      required IconData icon,
      required String? tooltip,
      required bool selected,
      required bool isSecond,
    }) {
      // 只有外侧两个角随外框走，贴着中缝的角保持直角
      final shape = BorderRadius.horizontal(
        left: isSecond ? Radius.zero : radius,
        right: isSecond ? radius : Radius.zero,
      );

      final child = InkWell(
        onTap: enabled ? () => onChanged?.call(isSecond) : null,
        borderRadius: shape,
        hoverColor: activeColor.withValues(alpha: 0.06),
        child: AnimatedContainer(
          duration: const Duration(milliseconds: 150),
          width: size,
          height: size,
          alignment: Alignment.center,
          decoration: BoxDecoration(
            color: selected ? activeBg : Colors.transparent,
            borderRadius: shape,
          ),
          child: Icon(
            icon,
            size: iconSize,
            color: enabled
                ? (selected ? activeColor : inactiveIcon)
                : theme.disabledColor,
          ),
        ),
      );

      if (tooltip == null || tooltip.isEmpty) return child;
      return Tooltip(message: tooltip, child: child);
    }

    return Container(
      decoration: BoxDecoration(
        border: Border.all(color: inactiveBorder),
        borderRadius: BorderRadius.circular(borderRadius),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          half(
            icon: firstIcon,
            tooltip: firstTooltip,
            selected: !secondSelected,
            isSecond: false,
          ),
          Container(width: 0.5, height: size, color: inactiveBorder),
          half(
            icon: secondIcon,
            tooltip: secondTooltip,
            selected: secondSelected,
            isSecond: true,
          ),
        ],
      ),
    );
  }
}


/// N 段式图标开关（2026-10-16，相册时间轴的「全部 / 图片 / 视频」用）。
///
/// 造型与 [CustomSegmentedIconToggle] 完全同族：所有分段**共享一个外框**、
/// 段与段之间一条 0.5px 细缝，选中段用主题主色描边底色 + 主色图标高亮，
/// 整组看起来是「一个开关」而不是 N 个按钮。
///
/// 与两段版的区别只有两点：段数可变（≥2）、选中态用**下标**而不是 bool 表达。
/// [size] 取 32 时与旁边的 [CustomBorderedIconButton] 等高，宽度为 size × 段数。
class CustomSegmentedIconToggleN extends StatelessWidget {
  final List<CustomSegmentedToggleItem> items;

  /// 当前选中项的下标；越界时按首/末段兜底，不会抛异常。
  final int selectedIndex;
  final ValueChanged<int>? onChanged;

  /// 每一段的边长（正方形）。
  final double size;
  final double iconSize;
  final double borderRadius;

  /// false 时整组变灰且不可点。
  final bool enabled;

  const CustomSegmentedIconToggleN({
    super.key,
    required this.items,
    required this.selectedIndex,
    this.onChanged,
    this.size = 32,
    this.iconSize = 16,
    this.borderRadius = AppRadius.item,
    this.enabled = true,
  });

  @override
  Widget build(BuildContext context) {
    if (items.isEmpty) return const SizedBox.shrink();
    final theme = Theme.of(context);
    final activeColor = theme.colorScheme.primary;
    final activeBg = activeColor.withValues(alpha: 0.1);
    final borderColor = theme.dividerColor;
    final inactiveIcon = theme.colorScheme.onSurface.withValues(alpha: 0.7);
    final radius = Radius.circular(borderRadius);
    final active = selectedIndex.clamp(0, items.length - 1);

    return Container(
      decoration: BoxDecoration(
        border: Border.all(color: borderColor),
        borderRadius: BorderRadius.circular(borderRadius),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          for (var i = 0; i < items.length; i++) ...[
            // 段间细缝：只有内侧两角保持直角，外侧两角跟随外框圆角
            if (i > 0) Container(width: 0.5, height: size, color: borderColor),
            _buildHalf(
              context: context,
              item: items[i],
              index: i,
              selected: i == active,
              isFirst: i == 0,
              isLast: i == items.length - 1,
              radius: radius,
              activeColor: activeColor,
              activeBg: activeBg,
              inactiveIcon: inactiveIcon,
            ),
          ],
        ],
      ),
    );
  }

  Widget _buildHalf({
    required BuildContext context,
    required CustomSegmentedToggleItem item,
    required int index,
    required bool selected,
    required bool isFirst,
    required bool isLast,
    required Radius radius,
    required Color activeColor,
    required Color activeBg,
    required Color inactiveIcon,
  }) {
    final theme = Theme.of(context);
    final shape = BorderRadius.horizontal(
      left: isFirst ? radius : Radius.zero,
      right: isLast ? radius : Radius.zero,
    );

    final child = InkWell(
      onTap: enabled ? () => onChanged?.call(index) : null,
      borderRadius: shape,
      hoverColor: activeColor.withValues(alpha: 0.06),
      child: AnimatedContainer(
        duration: const Duration(milliseconds: 150),
        width: size,
        height: size,
        alignment: Alignment.center,
        decoration: BoxDecoration(
          color: selected ? activeBg : Colors.transparent,
          borderRadius: shape,
        ),
        child: Icon(
          item.icon,
          size: iconSize,
          color: enabled
              ? (selected ? activeColor : inactiveIcon)
              : theme.disabledColor,
        ),
      ),
    );

    final tip = item.tooltip;
    if (tip == null || tip.isEmpty) return child;
    return Tooltip(message: tip, child: child);
  }
}

/// [CustomSegmentedIconToggleN] 的单个分段描述。
class CustomSegmentedToggleItem {
  final IconData icon;
  final String? tooltip;

  const CustomSegmentedToggleItem({required this.icon, this.tooltip});
}
