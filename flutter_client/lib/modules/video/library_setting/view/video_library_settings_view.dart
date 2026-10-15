import 'package:WaterNasOS/core/theme/custom_colors.dart';
import 'package:WaterNasOS/modules/base/components/custom_bordered_icon_button.dart';
import 'package:WaterNasOS/modules/base/components/custom_glass_card.dart';
import 'package:WaterNasOS/modules/base/components/custom_switch.dart';
import 'package:WaterNasOS/utils/device_utils.dart';
import 'package:WaterNasOS/utils/dialog_util.dart';
import 'package:flutter/material.dart';
import 'package:get/get.dart';
import 'package:WaterNasOS/modules/video/library_setting/controller/video_library_settings_controller.dart';
import 'package:WaterNasOS/modules/video/library_setting/models/video_library.dart';

/// 「影视库」管理页：每个影视库对应左侧栏的一个栏目
///紧凑布局：一个库一行，横向排布图标 / 名称 / 类型 / 计数 / 操作
class VideoLibrarySettingsView extends StatelessWidget {
  const VideoLibrarySettingsView({super.key});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final customColors = theme.extension<CustomColors>();
    final isNarrow = DeviceUtils.isMobile;

    return GetBuilder<VideoLibrarySettingsController>(
      init: VideoLibrarySettingsController(),
      builder: (ctrl) {
        return Container(
          color: customColors?.mainContentBgColor,
          child: isNarrow
              ? Obx(() {
                  final items = ctrl.libraries.toList();
                  return ListView(
                    padding: const EdgeInsets.fromLTRB(16, 12, 16, 16),
                    children: [
                      Text(
                        'video_library_manage_title'.tr,
                        style: theme.textTheme.titleMedium,
                      ),
                      const SizedBox(height: 4),
                      Text(
                        'video_library_manage_desc'.tr,
                        style: theme.textTheme.bodySmall?.copyWith(
                          color: theme.colorScheme.onSurface.withValues(
                            alpha: 0.6,
                          ),
                        ),
                      ),
                      const SizedBox(height: 12),
                      for (final lib in items) ...[
                        _LibraryCard(library: lib, compact: true),
                        const SizedBox(height: 8),
                      ],
                      _MobileAddLibraryCard(
                        onTap: () => _showAddDialog(context, ctrl),
                      ),
                    ],
                  );
                })
              : Column(
                  children: [
                    Padding(
                      padding: const EdgeInsets.fromLTRB(16, 12, 16, 10),
                      child: Row(
                        children: [
                          Text(
                            'video_library_manage_title'.tr,
                            style: theme.textTheme.titleMedium,
                          ),
                          const SizedBox(width: 10),
                          Expanded(
                            child: Text(
                              'video_library_manage_desc'.tr,
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: theme.textTheme.bodySmall?.copyWith(
                                color: theme.colorScheme.onSurface.withValues(
                                  alpha: 0.6,
                                ),
                              ),
                            ),
                          ),
                        ],
                      ),
                    ),
                    Expanded(
                      child: Obx(() {
                        final items = ctrl.libraries.toList();
                        return ListView.separated(
                          padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
                          itemCount: items.length + 1,
                          separatorBuilder: (_, __) => const SizedBox(height: 8),
                          itemBuilder: (context, index) {
                            if (index < items.length) {
                              return _LibraryCard(library: items[index]);
                            }
                            return _AddLibraryRow(onTap: () => _showAddDialog(context, ctrl));
                          },
                        );
                      }),
                    ),
                  ],
                ),
        );
      },
    );
  }
}

/// 新建影视库：分类创建后不可修改
Future<void> _showAddDialog(
  BuildContext context,
  VideoLibrarySettingsController ctrl,
) async {
  final theme = Theme.of(context);
  final nameCtrl = TextEditingController();
  String libType = 'movie';

  await showDialog<void>(
    context: context,
    builder: (dialogContext) {
      return StatefulBuilder(
        builder: (ctx, setState) {
          return DialogUtil.createAlertDialog(
            title: Text('video_library_add_title'.tr),
            content: SizedBox(
              width: 360,
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  TextField(
                    controller: nameCtrl,
                    autofocus: true,
                    decoration: InputDecoration(
                      labelText: 'video_library_name_label'.tr,
                      hintText: 'video_library_name_hint'.tr,
                      border: const OutlineInputBorder(),
                    ),
                  ),
                  const SizedBox(height: 16),
                  Text(
                    'video_library_type_label'.tr,
                    style: theme.textTheme.titleSmall,
                  ),
                  const SizedBox(height: 2),
                  Text(
                    'video_library_type_immutable'.tr,
                    style: theme.textTheme.bodySmall?.copyWith(
                      color: theme.colorScheme.onSurface.withValues(alpha: 0.6),
                    ),
                  ),
                  const SizedBox(height: 8),
                  for (final t in kVideoLibTypes)
                    RadioListTile<String>(
                      value: t,
                      groupValue: libType,
                      dense: true,
                      contentPadding: EdgeInsets.zero,
                      visualDensity: VisualDensity.compact,
                      title: Text(libTypeLabelKey(t).tr),
                      onChanged: (v) {
                        if (v == null) return;
                        setState(() => libType = v);
                      },
                    ),
                ],
              ),
            ),
            actions: [
              TextButton(
                onPressed: () => Navigator.of(dialogContext).pop(),
                child: Text('cancel'.tr),
              ),
              ElevatedButton(
                onPressed: () async {
                  final name = nameCtrl.text.trim();
                  if (name.isEmpty) {
                    DialogUtil.showInfoDialog(
                      title: 'tip'.tr,
                      content: 'video_library_name_required'.tr,
                      buttonText: 'ok'.tr,
                    );
                    return;
                  }
                  Navigator.of(dialogContext).pop();
                  await ctrl.addLibrary(name, libType);
                },
                child: Text('video_library_add'.tr),
              ),
            ],
          );
        },
      );
    },
  );
}

Future<void> _showRenameDialog(
  VideoLibrarySettingsController ctrl,
  VideoLibrary library,
) async {
  final name = await DialogUtil.showInputDialog(
    title: 'video_library_rename_title'.tr,
    content: 'video_library_name_label'.tr,
    initialValue: library.displayName,
    confirmText: 'confirm'.tr,
    cancelText: 'cancel'.tr,
    validator: (v) => (v ?? '').trim().isEmpty
        ? 'video_library_name_required'.tr
        : null,
  );
  if (name == null) return;
  await ctrl.renameLibrary(library, name);
}

class _MobileAddLibraryCard extends StatelessWidget {
  final VoidCallback onTap;

  const _MobileAddLibraryCard({required this.onTap});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return CustomGlassCard(
      onTap: onTap,
      borderRadius: 10.0,
      padding: const EdgeInsets.symmetric(vertical: 12),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Icon(
            Icons.add_circle_outline,
            size: 18,
            color: theme.colorScheme.primary,
          ),
          const SizedBox(width: 6),
          Text(
            'video_library_add'.tr,
            style: theme.textTheme.titleSmall?.copyWith(fontSize: 13),
          ),
        ],
      ),
    );
  }
}

class _AddLibraryRow extends StatelessWidget {
  final VoidCallback onTap;

  const _AddLibraryRow({required this.onTap});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return CustomGlassCard(
      onTap: onTap,
      padding: const EdgeInsets.symmetric(vertical: 12),
      borderRadius: 10.0,
      child: Row(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Icon(
            Icons.add_circle_outline,
            size: 18,
            color: theme.colorScheme.primary,
          ),
          const SizedBox(width: 6),
          Text(
            'video_library_add'.tr,
            style: theme.textTheme.titleSmall?.copyWith(fontSize: 13),
          ),
        ],
      ),
    );
  }
}

/// 单行紧凑卡片：图标 + 名称/类型 + 计数 + 改名/删除
///
/// [compact] = 手机窄屏（2026-10-12 改）：
/// 原来手机上也走 PC 那一行，图标 + 名称 + 改名 + 删除 + 主页开关 + 响度开关全挤在
/// 一行里 ⇒ 「名称」那一格被压到只剩几十像素，**库名整个看不见**。
/// 现在手机端改成上下两行：第一行图标 + 库名（独占剩余宽度）+ 操作按钮，
/// 第二行类型/计数 + 两个开关。
class _LibraryCard extends StatelessWidget {
  final VideoLibrary library;
  final bool compact;

  const _LibraryCard({required this.library, this.compact = false});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final ctrl = Get.find<VideoLibrarySettingsController>();
    final faint = theme.colorScheme.onSurface.withValues(alpha: 0.5);

    if (compact) {
      return CustomGlassCard(
        padding: const EdgeInsets.fromLTRB(12, 10, 8, 10),
        borderRadius: 10.0,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: [
            // 第一行：图标 + 库名 + 操作按钮（库名独占剩余宽度，不会再被挤没）
            Row(
              children: [
                Icon(
                  libTypeIcon(library.libType),
                  size: 20,
                  color: theme.colorScheme.primary,
                ),
                const SizedBox(width: 10),
                Expanded(child: _buildName(theme)),
                CustomBorderedIconButton(
                  icon: Icons.edit_outlined,
                  tooltip: 'video_library_rename_title'.tr,
                  onTap: () => _showRenameDialog(ctrl, library),
                ),
                if (!library.isDefault) ...[
                  const SizedBox(width: 6),
                  CustomBorderedIconButton(
                    icon: Icons.delete_outline,
                    tooltip: 'delete'.tr,
                    onTap: () => ctrl.deleteLibrary(library),
                  ),
                ],
              ],
            ),
            const SizedBox(height: 8),
            // 第二行：类型 / 来源数 / 条目数
            Text(
              '${libTypeLabelKey(library.libType).tr} · '
              '${'video_library_source_count'.tr} ${library.sourceCount} · '
              '${library.totalCount} ${'video_library_item_count'.tr}',
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: theme.textTheme.bodySmall?.copyWith(
                color: faint,
                fontSize: 11,
              ),
            ),
            const SizedBox(height: 6),
            // 第三行：两个开关（带文字说明，不再只靠 tooltip —— 手机上没有 hover）
            Wrap(
              spacing: 16,
              runSpacing: 6,
              crossAxisAlignment: WrapCrossAlignment.center,
              children: [
                _ToggleRow(
                  icon: Icons.home_outlined,
                  label: 'video_library_show_in_home'.tr,
                  value: library.showInHome,
                  onChanged: (v) => ctrl.setShowInHome(library, v),
                  faint: faint,
                ),
                _ToggleRow(
                  icon: Icons.graphic_eq,
                  label: 'video_audio_normalize'.tr,
                  value: library.audioNormalize,
                  onChanged: (v) => ctrl.setAudioNormalize(library, v),
                  faint: faint,
                ),
                // ⭐ 日本电影（2026-10-12）：开了才在列表显示「中/无码」徽章与筛选
                if (library.libType == 'movie')
                  _ToggleRow(
                    icon: Icons.local_movies_outlined,
                    label: 'video_library_jp_movie'.tr,
                    value: library.jpMovie,
                    onChanged: (v) => ctrl.setJpMovie(library, v),
                    faint: faint,
                  ),
              ],
            ),
          ],
        ),
      );
    }

    return CustomGlassCard(
      padding: const EdgeInsets.fromLTRB(12, 10, 8, 10),
      borderRadius: 10.0,
      child: Row(
        children: [
          Icon(
            libTypeIcon(library.libType),
            size: 20,
            color: theme.colorScheme.primary,
          ),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                _buildName(theme),
                const SizedBox(height: 1),
                Text(
                  '${libTypeLabelKey(library.libType).tr} · '
                  '${'video_library_source_count'.tr} ${library.sourceCount} · '
                  '${library.totalCount} ${'video_library_item_count'.tr}',
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: theme.textTheme.bodySmall?.copyWith(
                    color: faint,
                    fontSize: 11,
                  ),
                ),
              ],
            ),
          ),
          CustomBorderedIconButton(
            icon: Icons.edit_outlined,
            tooltip: 'video_library_rename_title'.tr,
            onTap: () => _showRenameDialog(ctrl, library),
          ),
          if (!library.isDefault) ...[
            const SizedBox(width: 6),
            CustomBorderedIconButton(
              icon: Icons.delete_outline,
              tooltip: 'delete'.tr,
              onTap: () => ctrl.deleteLibrary(library),
            ),
          ],
          const SizedBox(width: 10),
          // 是否在影视主页显示该库分类：内置电影/电视剧默认开启，新建库默认关闭
          Tooltip(
            message: 'video_library_show_in_home'.tr,
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Icon(
                  Icons.home_outlined,
                  size: 14,
                  color: faint,
                ),
                const SizedBox(width: 4),
                CustomSwitch(
                  value: library.showInHome,
                  onChanged: (v) => ctrl.setShowInHome(library, v),
                ),
              ],
            ),
          ),
          const SizedBox(width: 10),
          // 音频响度归一化：开启后扫描/重扫该库时测量音量，播放转码时对齐（默认关闭）
          Tooltip(
            message: 'video_audio_normalize'.tr,
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Icon(
                  Icons.graphic_eq,
                  size: 14,
                  color: faint,
                ),
                const SizedBox(width: 4),
                CustomSwitch(
                  value: library.audioNormalize,
                  onChanged: (v) => ctrl.setAudioNormalize(library, v),
                ),
              ],
            ),
          ),
          if (library.libType == 'movie') ...[
            const SizedBox(width: 10),
            // ⭐ 日本电影（2026-10-12）
            Tooltip(
              message: 'video_library_jp_movie'.tr,
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Icon(Icons.local_movies_outlined, size: 14, color: faint),
                  const SizedBox(width: 4),
                  CustomSwitch(
                    value: library.jpMovie,
                    onChanged: (v) => ctrl.setJpMovie(library, v),
                  ),
                ],
              ),
            ),
          ],
          const SizedBox(width: 4),
        ],
      ),
    );
  }

  /// 库名 + 「内置」徽章（PC / 手机两种布局共用）
  Widget _buildName(ThemeData theme) {
    return Row(
      children: [
        Flexible(
          child: Text(
            library.displayName,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: theme.textTheme.titleSmall?.copyWith(
              fontWeight: FontWeight.w600,
            ),
          ),
        ),
        if (library.isDefault) ...[
          const SizedBox(width: 6),
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 5, vertical: 1),
            decoration: BoxDecoration(
              color: theme.colorScheme.primary.withValues(alpha: 0.12),
              borderRadius: BorderRadius.circular(4),
            ),
            child: Text(
              'video_library_builtin'.tr,
              style: theme.textTheme.labelSmall?.copyWith(
                color: theme.colorScheme.primary,
                fontSize: 10,
              ),
            ),
          ),
        ],
      ],
    );
  }
}

/// 手机端的一枚带文字开关（图标 + 文案 + 开关）
class _ToggleRow extends StatelessWidget {
  final IconData icon;
  final String label;
  final bool value;
  final ValueChanged<bool> onChanged;
  final Color faint;

  const _ToggleRow({
    required this.icon,
    required this.label,
    required this.value,
    required this.onChanged,
    required this.faint,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Icon(icon, size: 14, color: faint),
        const SizedBox(width: 4),
        Text(
          label,
          style: theme.textTheme.bodySmall?.copyWith(
            color: faint,
            fontSize: 11,
          ),
        ),
        const SizedBox(width: 4),
        CustomSwitch(value: value, onChanged: onChanged),
      ],
    );
  }
}
