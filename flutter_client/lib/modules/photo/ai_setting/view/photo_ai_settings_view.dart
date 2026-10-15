import 'package:WaterNasOS/core/theme/custom_colors.dart';
import 'package:WaterNasOS/utils/device_utils.dart';
import 'package:flutter/material.dart';
import 'package:get/get.dart';
import '../../../base/components/custom_glass_card.dart';
import '../../../base/components/custom_dropdown_field.dart';
import '../../../base/components/custom_switch.dart';
import '../../../../utils/dialog_util.dart';
import '../../../../core/api/api_controller.dart';
import '../controller/photo_ai_settings_controller.dart';

class PhotoAiSettingsView extends StatelessWidget {
  const PhotoAiSettingsView({super.key});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final customColors = Theme.of(context).extension<CustomColors>();
    final isNarrow = DeviceUtils.isMobile;
    return GetBuilder<PhotoAiSettingsController>(
      init: PhotoAiSettingsController(),
      builder: (ctrl) {
        return Container(
          color: customColors?.mainContentBgColor,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Padding(
                padding: EdgeInsets.fromLTRB(16, isNarrow ? 12 : 12, 16, 10),
                child: Align(
                  alignment: Alignment.centerLeft,
                  child: Wrap(
                    spacing: 10,
                    runSpacing: 6,
                    crossAxisAlignment: WrapCrossAlignment.center,
                    children: [
                      Text(
                        'photo_ai_settings_title'.tr,
                        style: theme.textTheme.titleMedium,
                      ),
                      IconButton(
                        tooltip: 'help'.tr,
                        onPressed: () {
                          DialogUtil.showInfoDialog(
                            title: 'tip'.tr,
                            content: 'photo_ai_settings_help_content'.tr,
                          );
                        },
                        icon: const Icon(Icons.help_outline),
                      ),
                      IconButton(
                        tooltip: 'refresh'.tr,
                        onPressed: () => ctrl.fetchSettings(showLoading: true),
                        icon: const Icon(Icons.refresh),
                      ),
                    ],
                  ),
                ),
              ),
              Expanded(
                child: SingleChildScrollView(
                  padding: const EdgeInsets.fromLTRB(16, 0, 16, 12),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      const SizedBox(height: 2),
                      // GPU 优先开关（需要服务器版本 >= 10）
                      if (ApiController.instance.isServerVersionAtLeast(10))
                        CustomGlassCard(
                          child: Obx(() {
                            return _SwitchItem(
                              title: 'photo_ai_gpu_prefer'.tr,
                              subtitle: 'photo_ai_gpu_prefer_subtitle'.tr,
                              value: ctrl.gpuPrefer.value,
                              enabled: ctrl.canEdit,
                              onChanged: (v) => ctrl.toggleGpu(v),
                            );
                          }),
                        ),
                      if (ApiController.instance.isServerVersionAtLeast(10))
                        const SizedBox(height: 12),
                      CustomGlassCard(
                        child: Column(
                          children: [
                            Obx(() {
                              return _SwitchItem(
                                title: 'photo_ai_enable_ocr'.tr,
                                subtitle: 'photo_ai_enable_ocr_subtitle'.tr,
                                progressPercent: ctrl.ocrProgress.value,
                                value: ctrl.ocrEnabled.value,
                                enabled: ctrl.canEdit,
                                onChanged: (v) => ctrl.toggleOcr(v),
                              );
                            }),
                            const Divider(height: 1),
                            // Obx(() {
                            //   return _SwitchItem(
                            //     title: 'photo_ai_enable_pet'.tr,
                            //     value: ctrl.petEnabled.value,
                            //     enabled: ctrl.canEdit,
                            //     onChanged: (v) => ctrl.togglePet(v),
                            //   );
                            // }),
                            // const Divider(height: 1),
                            Obx(() {
                              return _SwitchItem(
                                title: 'photo_ai_enable_scene'.tr,
                                subtitle: 'photo_ai_enable_scene_subtitle'.tr,
                                progressPercent: ctrl.placeProgress.value,
                                value: ctrl.placeEnabled.value,
                                enabled: ctrl.canEdit,
                                onChanged: (v) => ctrl.togglePlace(v),
                                onReset: ctrl.resetPlaces,
                              );
                            }),
                            const Divider(height: 1),
                            Obx(() {
                              return _SimilarDedupItem(
                                value: ctrl.similarEnabled.value,
                                scanPercent: ctrl.similarScanProgress.value,
                                comparePercent:
                                    ctrl.similarCompareProgress.value,
                                enabled: ctrl.canEdit,
                                onChanged: (v) => ctrl.toggleSimilar(v),
                                onReset: () => ctrl.resetSimilar(),
                              );
                            }),
                          ],
                        ),
                      ),
                      const SizedBox(height: 12),
                      CustomGlassCard(
                        child: Column(
                          children: [
                            Obx(() {
                              return _SwitchItem(
                                title: 'photo_ai_enable_face'.tr,
                                progressPercent: ctrl.faceProgress.value,
                                value: ctrl.faceEnabled.value,
                                enabled: ctrl.canEdit,
                                onChanged: (v) => ctrl.toggleFace(v),
                              );
                            }),
                            const Divider(height: 1),
                            Obx(() {
                              return _AutoHideFacesItem(
                                value: ctrl.faceMinShowCount.value,
                                enabled: ctrl.canEdit,
                                onChanged: (v) => ctrl.setFaceMinShowCount(v),
                              );
                            }),
                            const Divider(height: 1),
                            // 人脸聚类参数：调完要「重新聚类」才生效
                            Obx(() {
                              return _FaceTuningItem(
                                simThresh: ctrl.faceSimThresh.value,
                                minQuality: ctrl.faceMinQuality.value,
                                secondMergeThresh:
                                    ctrl.faceSecondMergeThresh.value,
                                threads: ctrl.faceThreads.value,
                                enabled: ctrl.canEdit,
                                onSimChanged: (v) =>
                                    ctrl.faceSimThresh.value = v,
                                onMinQualityChanged: (v) =>
                                    ctrl.faceMinQuality.value = v,
                                onSecondMergeChanged: (v) =>
                                    ctrl.faceSecondMergeThresh.value = v,
                                onThreadsChanged: (v) =>
                                    ctrl.faceThreads.value = v,
                                onSave: ctrl.saveFaceTuning,
                                onRecluster: () => ctrl.reclusterFaces(),
                                onPurge: () => ctrl.purgeSuspiciousFaces(),
                              );
                            }),
                          ],
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            ],
          ),
        );
      },
    );
  }
}

class _SwitchItem extends StatelessWidget {
  final String title;
  final String? subtitle;
  final int? progressPercent;
  final bool value;
  final bool enabled;
  final ValueChanged<bool> onChanged;
  /// 可选：重置按钮回调。为 null 时不显示按钮（人脸/相似项另有专用组件）。
  final VoidCallback? onReset;

  const _SwitchItem({
    required this.title,
    this.subtitle,
    this.progressPercent,
    required this.value,
    required this.enabled,
    required this.onChanged,
    this.onReset,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final subtitleText = subtitle;
    final p = progressPercent;
    final showProgress = p != null;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 12),
      child: Row(
        children: [
          Expanded(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    Text(
                      title,
                      style: theme.textTheme.titleSmall?.copyWith(
                        color: theme.colorScheme.onSurface,
                      ),
                    ),
                    if (showProgress) SizedBox(width: 8),
                    if (showProgress)
                      Text(
                        'photo_ai_progress_suffix'.trParams({
                          'percent': p.clamp(0, 100).toString(),
                        }),
                        style: theme.textTheme.bodySmall?.copyWith(
                          color: theme.colorScheme.onSurface.withValues(
                            alpha: 0.6,
                          ),
                        ),
                      ),
                  ],
                ),
                if (subtitleText != null && subtitleText.isNotEmpty) ...[
                  const SizedBox(height: 4),
                  Text(
                    subtitleText,
                    style: theme.textTheme.bodySmall?.copyWith(
                      color: theme.colorScheme.onSurface.withValues(alpha: 0.6),
                    ),
                  ),
                ],
              ],
            ),
          ),
          const SizedBox(width: 12),
          if (onReset != null)
            TextButton(
              onPressed: enabled ? onReset : null,
              child: Text('reset'.tr),
            ),
          if (onReset != null) const SizedBox(width: 8),
          CustomSwitch(value: value, onChanged: enabled ? onChanged : null),
        ],
      ),
    );
  }
}

class _AutoHideFacesItem extends StatelessWidget {
  final int value;
  final bool enabled;
  final ValueChanged<int> onChanged;

  const _AutoHideFacesItem({
    required this.value,
    required this.enabled,
    required this.onChanged,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final fg = enabled
        ? theme.colorScheme.onSurface
        : theme.colorScheme.onSurface.withOpacity(0.5);

    const options = [0, 3, 5, 10];
    final shown = options.contains(value) ? value : 0;

    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            'photo_ai_auto_hide_face_album'.tr,
            style: theme.textTheme.titleSmall?.copyWith(color: fg),
          ),
          const SizedBox(height: 4),
          Text(
            'photo_ai_auto_hide_face_album_subtitle'.tr,
            style: theme.textTheme.bodySmall?.copyWith(
              color: fg.withOpacity(0.6),
            ),
          ),
          const SizedBox(height: 10),
          LayoutBuilder(
            builder: (context, constraints) {
              final maxWidth = constraints.maxWidth;
              final fieldWidth = maxWidth > 360 ? 360.0 : maxWidth;
              return Align(
                alignment: Alignment.centerLeft,
                child: SizedBox(
                  width: fieldWidth,
                  height: 44,
                  child: CustomDropdownField<int>(
                    value: shown,
                    enabled: enabled,
                    contentPadding: const EdgeInsets.symmetric(
                      horizontal: 12,
                      vertical: 8,
                    ),
                    items: options
                        .map(
                          (e) => DropdownMenuItem<int>(
                            value: e,
                            child: Text(
                              'photo_ai_auto_hide_face_album_option_$e'.tr,
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                            ),
                          ),
                        )
                        .toList(),
                    onChanged: (v) {
                      if (v == null) return;
                      onChanged(v);
                    },
                  ),
                ),
              );
            },
          ),
        ],
      ),
    );
  }
}

/// 人脸聚类参数（2026-10-13）：三个滑块 + 保存 + 重新聚类。
/// 说明写在标题下方，用户据此判断「调大 = 更严格 = 不同人更不容易被并到一起」。
class _FaceTuningItem extends StatelessWidget {
  const _FaceTuningItem({
    super.key,
    required this.simThresh,
    required this.minQuality,
    required this.secondMergeThresh,
    required this.threads,
    required this.enabled,
    required this.onSimChanged,
    required this.onMinQualityChanged,
    required this.onSecondMergeChanged,
    required this.onThreadsChanged,
    required this.onSave,
    required this.onRecluster,
    required this.onPurge,
  });

  final double simThresh;
  final int minQuality;
  final double secondMergeThresh;
  final int threads;
  final bool enabled;
  final ValueChanged<double> onSimChanged;
  final ValueChanged<int> onMinQualityChanged;
  final ValueChanged<double> onSecondMergeChanged;
  final ValueChanged<int> onThreadsChanged;
  final VoidCallback onSave;
  final VoidCallback onRecluster;
  final VoidCallback onPurge;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    Widget slider({
      required String title,
      required String subtitle,
      required double value,
      required double min,
      required double max,
      required int divisions,
      required String valueLabel,
      required ValueChanged<double> onChanged,
    }) {
      return Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(title, style: theme.textTheme.titleSmall),
              ),
              Text(
                valueLabel,
                style: theme.textTheme.bodySmall?.copyWith(
                  color: theme.colorScheme.onSurfaceVariant,
                ),
              ),
            ],
          ),
          Text(
            subtitle,
            style: theme.textTheme.bodySmall?.copyWith(
              color: theme.colorScheme.onSurface.withValues(alpha: 0.6),
            ),
          ),
          SliderTheme(
            data: SliderTheme.of(context).copyWith(
              trackHeight: 3,
              overlayShape: SliderComponentShape.noOverlay,
            ),
            child: Slider(
              value: value.clamp(min, max),
              min: min,
              max: max,
              divisions: divisions,
              label: valueLabel,
              onChanged: enabled ? onChanged : null,
            ),
          ),
        ],
      );
    }

    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 12, 16, 12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  'photo_ai_face_tuning'.tr,
                  style: theme.textTheme.titleSmall,
                ),
              ),
              TextButton.icon(
                onPressed: enabled ? onSave : null,
                icon: const Icon(Icons.save_outlined, size: 18),
                label: Text('photo_ai_face_tuning_save'.tr),
              ),
            ],
          ),
          Text(
            'photo_ai_face_tuning_sub'.tr,
            style: theme.textTheme.bodySmall?.copyWith(
              color: theme.colorScheme.onSurface.withValues(alpha: 0.6),
            ),
          ),
          const SizedBox(height: 8),
          slider(
            title: 'photo_ai_face_sim_thresh'.tr,
            subtitle: 'photo_ai_face_sim_thresh_sub'.tr,
            value: simThresh,
            min: 0.2,
            max: 0.9,
            divisions: 14,
            valueLabel: simThresh.toStringAsFixed(2),
            onChanged: onSimChanged,
          ),
          slider(
            title: 'photo_ai_face_min_quality'.tr,
            subtitle: 'photo_ai_face_min_quality_sub'.tr,
            value: minQuality.toDouble(),
            min: 40,
            max: 95,
            divisions: 11,
            valueLabel: '$minQuality',
            onChanged: (v) => onMinQualityChanged(v.round()),
          ),
          slider(
            title: 'photo_ai_face_second_merge'.tr,
            subtitle: 'photo_ai_face_second_merge_sub'.tr,
            value: secondMergeThresh,
            min: 0.2,
            max: 0.9,
            divisions: 14,
            valueLabel: secondMergeThresh.toStringAsFixed(2),
            onChanged: onSecondMergeChanged,
          ),
          // 识别线程数（2026-10-13）：并行检测，默认 3
          const SizedBox(height: 4),
          Row(
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      'photo_ai_face_threads'.tr,
                      style: theme.textTheme.titleSmall,
                    ),
                    Text(
                      'photo_ai_face_threads_hint'.tr,
                      style: theme.textTheme.bodySmall?.copyWith(
                        color: theme.colorScheme.onSurface.withValues(alpha: 0.6),
                      ),
                    ),
                  ],
                ),
              ),
              const SizedBox(width: 12),
              SizedBox(
                width: 96,
                height: 44,
                child: CustomDropdownField<int>(
                  value: threads.clamp(1, 8),
                  contentPadding: const EdgeInsets.symmetric(
                    horizontal: 12,
                    vertical: 8,
                  ),
                  items: const [1, 2, 3, 4, 6, 8]
                      .map(
                        (e) => DropdownMenuItem<int>(
                          value: e,
                          child: Text('$e'),
                        ),
                      )
                      .toList(),
                  onChanged: (v) {
                    if (v == null) return;
                    onThreadsChanged(v);
                  },
                ),
              ),
            ],
          ),
          const SizedBox(height: 4),
          Align(
            alignment: Alignment.centerLeft,
            child: Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                OutlinedButton.icon(
                  onPressed: enabled ? onRecluster : null,
                  icon: const Icon(Icons.refresh, size: 18),
                  label: Text('photo_ai_face_recluster'.tr),
                ),
                OutlinedButton.icon(
                  onPressed: enabled ? onPurge : null,
                  icon: const Icon(Icons.cleaning_services_outlined, size: 18),
                  label: Text('face_purge_suspicious'.tr),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _SimilarDedupItem extends StatelessWidget {
  final bool value;
  final int scanPercent;
  final int comparePercent;
  final bool enabled;
  final ValueChanged<bool> onChanged;
  final VoidCallback onReset;

  const _SimilarDedupItem({
    required this.value,
    required this.scanPercent,
    required this.comparePercent,
    required this.enabled,
    required this.onChanged,
    required this.onReset,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scan = scanPercent.clamp(0, 100);
    final compare = comparePercent.clamp(0, 100);
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 12),
      child: Row(
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  'photo_ai_enable_similar'.tr,
                  style: theme.textTheme.titleSmall?.copyWith(
                    color: theme.colorScheme.onSurface,
                  ),
                ),
                const SizedBox(height: 4),
                Text(
                  'photo_ai_enable_similar_subtitle'.tr,
                  style: theme.textTheme.bodySmall?.copyWith(
                    color: theme.colorScheme.onSurface.withValues(alpha: 0.6),
                  ),
                ),
                const SizedBox(height: 4),
                Row(
                  children: [
                    Text(
                      'photo_ai_similar_scan_progress_suffix'.trParams({
                        'percent': scan.toString(),
                      }),
                      style: theme.textTheme.bodySmall?.copyWith(
                        color: theme.colorScheme.onSurface.withValues(
                          alpha: 0.6,
                        ),
                      ),
                    ),
                    const SizedBox(width: 10),
                    Text(
                      'photo_ai_similar_compare_progress_suffix'.trParams({
                        'percent': compare.toString(),
                      }),
                      style: theme.textTheme.bodySmall?.copyWith(
                        color: theme.colorScheme.onSurface.withValues(
                          alpha: 0.6,
                        ),
                      ),
                    ),
                  ],
                ),
              ],
            ),
          ),
          TextButton(
            onPressed: enabled ? onReset : null,
            child: Text('reset'.tr),
          ),
          const SizedBox(width: 8),
          CustomSwitch(value: value, onChanged: enabled ? onChanged : null),
        ],
      ),
    );
  }
}
