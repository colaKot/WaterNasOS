import 'package:WaterNasOS/core/theme/custom_colors.dart';
import 'package:WaterNasOS/utils/device_utils.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:get/get.dart';
import '../../../base/components/custom_glass_card.dart';
import '../../../base/components/custom_dropdown_field.dart';
import '../../../base/components/custom_switch.dart';
import '../../../../utils/dialog_util.dart';
import '../../../../utils/toast_util.dart';
import '../../../../core/api/api_controller.dart';
import '../controller/photo_ai_settings_controller.dart';
import '../service/photo_ai_settings_api_service.dart';
import '../../../user/service/user_api_service.dart';

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
                      // ⭐ 2026-10-16 P1-9 AI 任务进度面板（只读聚合）
                      const _AiQueuePanel(),
                      const SizedBox(height: 12),
                      // ⭐ 2026-10-16 P2-18/P2-20 开放平台：MCP 服务 + 模型 API
                      const _McpOpenPlatformCard(),
                      const SizedBox(height: 12),
                      const _ModelApiCard(),
                      const SizedBox(height: 12),
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
                                onReset: ctrl.resetOcr,
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
                              return _SwitchItem(
                                title: 'photo_ai_queue_activity'.tr,
                                subtitle: 'photo_ai_enable_activity_subtitle'.tr,
                                progressPercent: ctrl.activityProgress.value,
                                value: ctrl.activityEnabled.value,
                                enabled: ctrl.canEdit,
                                onChanged: (v) => ctrl.toggleActivity(v),
                                onReset: ctrl.resetActivity,
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

/// ⭐ 2026-10-16 P1-9：AI 任务进度面板（只读）。
///
/// 此前设置页只有「开/关」和一个百分比，用户看不到"还剩多少、worker 是不是停了"。
/// 这里把四条流水线 + 图像向量回填的进度一次摊开；**不做暂停/改优先级**——
/// 那属于写入型控制，要等 P0-6 的写操作审计通道扩展后再上。
class _AiQueuePanel extends StatefulWidget {
  const _AiQueuePanel();

  @override
  State<_AiQueuePanel> createState() => _AiQueuePanelState();
}

class _AiQueuePanelState extends State<_AiQueuePanel> {
  final PhotoAiSettingsApiService _api = PhotoAiSettingsApiService.instance;
  List<Map<String, dynamic>> _items = const <Map<String, dynamic>>[];
  bool _loading = true;
  bool _failed = false;
  bool _queuePaused = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    if (mounted) setState(() => _loading = true);
    final res = await _api.getQueueStatus();
    if (!mounted) return;
    final data = res.success ? res.data : null;
    final raw = data == null ? null : data['items'];
    setState(() {
      _items = raw is List
          ? raw
              .whereType<Map>()
              .map((e) => e.cast<String, dynamic>())
              .toList()
          : const <Map<String, dynamic>>[];
      _queuePaused = data != null && data['paused'] == true;
      _failed = !res.success;
      _loading = false;
    });
  }

  String _labelOf(String key) {
    switch (key) {
      case 'faces':
        return 'photo_ai_queue_faces'.tr;
      case 'ocr':
        return 'photo_ai_queue_ocr'.tr;
      case 'place':
        return 'photo_ai_queue_place'.tr;
      case 'activity':
        return 'photo_ai_queue_activity'.tr;
      case 'clip':
        return 'photo_ai_queue_clip'.tr;
      default:
        return key;
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final pendingTotal = _items.fold<int>(
      0,
      (s, e) => s + ((e['pending'] as num?)?.toInt() ?? 0),
    );
    return CustomGlassCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(
                Icons.donut_large,
                size: 16,
                color: theme.colorScheme.primary,
              ),
              const SizedBox(width: 6),
              Text('photo_ai_queue_title'.tr, style: theme.textTheme.titleSmall),
              const Spacer(),
              if (!_loading)
                Text(
                  pendingTotal <= 0
                      ? 'photo_ai_queue_all_done'.tr
                      : '${'photo_ai_queue_pending'.tr} $pendingTotal',
                  style: theme.textTheme.bodySmall?.copyWith(
                    color: theme.colorScheme.onSurfaceVariant,
                  ),
                ),
              // ⭐ P1-9：暂停/恢复（写入型控制里最安全的一个：不丢数据、随时可逆）
              TextButton.icon(
                onPressed: _loading
                    ? null
                    : () async {
                        final res = await _api.setQueuePaused(!_queuePaused);
                        if (!res.success) {
                          ToastUtil.show('operation_failed'.tr);
                        }
                        await _load();
                      },
                icon: Icon(_queuePaused ? Icons.play_arrow : Icons.pause, size: 16),
                label: Text(_queuePaused
                    ? 'photo_ai_queue_resume'.tr
                    : 'photo_ai_queue_pause'.tr),
              ),
              IconButton(
                visualDensity: VisualDensity.compact,
                icon: const Icon(Icons.refresh, size: 18),
                tooltip: 'refresh'.tr,
                onPressed: _loading ? null : _load,
              ),
            ],
          ),
          if (_queuePaused)
            Padding(
              padding: const EdgeInsets.only(top: 6, bottom: 2),
              child: Row(
                children: [
                  Icon(Icons.pause_circle_outline,
                      size: 14, color: theme.colorScheme.error),
                  const SizedBox(width: 4),
                  Expanded(
                    child: Text(
                      'photo_ai_queue_paused'.tr,
                      style: theme.textTheme.bodySmall
                          ?.copyWith(color: theme.colorScheme.error),
                    ),
                  ),
                ],
              ),
            ),
          if (_loading)
            const Padding(
              padding: EdgeInsets.symmetric(vertical: 10),
              child: LinearProgressIndicator(minHeight: 3),
            )
          else if (_failed)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 8),
              child: Text(
                'operation_failed'.tr,
                style: theme.textTheme.bodySmall?.copyWith(
                  color: theme.colorScheme.error,
                ),
              ),
            )
          else
            ..._items.map((it) {
              final pending = (it['pending'] as num?)?.toInt() ?? 0;
              final percent = (it['percent'] as num?)?.toInt() ?? 100;
              final running = it['running'] == true;
              final enabled = it['enabled'] != false;
              return Padding(
                padding: const EdgeInsets.only(top: 8),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        Text(
                          _labelOf(it['key']?.toString() ?? ''),
                          style: theme.textTheme.bodySmall,
                        ),
                        const SizedBox(width: 6),
                        Container(
                          width: 6,
                          height: 6,
                          decoration: BoxDecoration(
                            shape: BoxShape.circle,
                            color: !enabled
                                ? theme.colorScheme.outlineVariant
                                : (running
                                      ? theme.colorScheme.primary
                                      : theme.colorScheme.outline),
                          ),
                        ),
                        const SizedBox(width: 4),
                        Text(
                          !enabled
                              ? 'photo_ai_queue_disabled'.tr
                              : (running
                                    ? 'photo_ai_queue_running'.tr
                                    : 'photo_ai_queue_idle'.tr),
                          style: theme.textTheme.labelSmall?.copyWith(
                            color: theme.colorScheme.onSurfaceVariant,
                          ),
                        ),
                        const Spacer(),
                        Text(
                          '$percent%  ·  $pending',
                          style: theme.textTheme.labelSmall?.copyWith(
                            color: theme.colorScheme.onSurfaceVariant,
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: 4),
                    ClipRRect(
                      borderRadius: BorderRadius.circular(3),
                      child: LinearProgressIndicator(
                        value: (percent.clamp(0, 100)) / 100,
                        minHeight: 4,
                        backgroundColor: theme.colorScheme.surfaceContainerHighest,
                      ),
                    ),
                  ],
                ),
              );
            }),
        ],
      ),
    );
  }
}

/// ⭐ 2026-10-16 P2-18 开放平台：MCP 服务配置。
///
/// 设计口径照 TrailSnap 的 MCP Server（见 docs/WaterNasOS-整合实施路线图.md §5 P2-18）：
///   · **只读**：6 个工具全是查询，写操作不开放（写要等 P2-20 的「预演→确认→可撤销」通道）；
///   · **独立令牌**：`wnos_` 前缀 + scope，与登录 JWT 分离，泄漏一个令牌 ≠ 泄漏账号；
///   · **明文只出现一次**：轮换时返回，之后只回掩码 —— 所以「复制配置」要么刚轮换过，要么先轮换。
class _McpOpenPlatformCard extends StatefulWidget {
  const _McpOpenPlatformCard();

  @override
  State<_McpOpenPlatformCard> createState() => _McpOpenPlatformCardState();
}

class _McpOpenPlatformCardState extends State<_McpOpenPlatformCard> {
  final PhotoAiSettingsApiService _api = PhotoAiSettingsApiService.instance;
  bool _loading = true;
  bool _enabled = true;
  String _tokenMasked = '';
  int _uid = 0;
  List<String> _tools = const <String>[];
  List<Map<String, dynamic>> _users = const <Map<String, dynamic>>[];
  /// 轮换后才有明文；只活在内存里，不落盘
  String _plainToken = '';

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final res = await _api.getMcpStatus();
    List<Map<String, dynamic>> users = const <Map<String, dynamic>>[];
    try {
      final raw = await UserApiService.instance.fetchUsers(limit: 200);
      users = raw.whereType<Map>().map((e) => e.cast<String, dynamic>()).toList();
    } catch (_) {}
    if (!mounted) return;
    final data = res.success ? (res.data ?? const <String, dynamic>{}) : const <String, dynamic>{};
    setState(() {
      _enabled = data['enabled'] != false;
      _tokenMasked = data['tokenMasked']?.toString() ?? '';
      _uid = (data['uid'] as num?)?.toInt() ?? 0;
      _tools = ((data['tools'] as List?) ?? const []).map((e) => e.toString()).toList();
      _users = users;
      _loading = false;
    });
  }

  String get _endpoint {
    final base = ApiController.instance.baseUrl;
    return '${base.replaceAll(RegExp(r'/+$'), '')}/api/mcp';
  }

  Future<void> _toggle(bool v) async {
    setState(() => _enabled = v);
    final res = await _api.setMcpConfig(enabled: v);
    if (!res.success) {
      ToastUtil.show('operation_failed'.tr);
      await _load();
    }
  }

  Future<void> _setOwner(int? uid) async {
    if (uid == null) return;
    final res = await _api.setMcpConfig(uid: uid);
    if (!res.success) {
      ToastUtil.show('operation_failed'.tr);
    }
    await _load();
  }

  Future<void> _rotate() async {
    final ok = await DialogUtil.showConfirmDialog(
      title: 'photo_mcp_token_rotate'.tr,
      content: 'photo_mcp_token_rotate_confirm'.tr,
      confirmText: 'ok'.tr,
      cancelText: 'cancel'.tr,
    );
    if (ok != true) return;
    final res = await _api.rotateMcpToken();
    if (!res.success) {
      ToastUtil.show('operation_failed'.tr);
      return;
    }
    final token = res.data?['token']?.toString() ?? '';
    setState(() => _plainToken = token);
    await _load();
    if (!mounted) return;
    DialogUtil.showInfoDialog(
      title: 'photo_mcp_token'.tr,
      content: '${'photo_mcp_token_once'.tr}\n\n$token',
    );
  }

  Future<void> _copyConfig() async {
    if (_plainToken.isEmpty) {
      ToastUtil.show('photo_mcp_need_token'.tr);
      return;
    }
    final snippet = '{\n'
        '  "mcpServers": {\n'
        '    "waternasos": {\n'
        '      "type": "http",\n'
        '      "url": "$_endpoint",\n'
        '      "headers": { "Authorization": "Bearer $_plainToken" }\n'
        '    }\n'
        '  }\n'
        '}';
    await Clipboard.setData(ClipboardData(text: snippet));
    ToastUtil.show('copy'.tr);
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return CustomGlassCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(Icons.hub_outlined, size: 16, color: theme.colorScheme.primary),
              const SizedBox(width: 6),
              Text('photo_mcp_title'.tr, style: theme.textTheme.titleSmall),
              const Spacer(),
              if (_loading)
                const SizedBox(width: 14, height: 14, child: CircularProgressIndicator(strokeWidth: 2)),
            ],
          ),
          const SizedBox(height: 4),
          Text(
            'photo_mcp_readonly_hint'.tr,
            style: theme.textTheme.bodySmall?.copyWith(color: theme.colorScheme.onSurfaceVariant),
          ),
          const SizedBox(height: 6),
          if (!_loading) ...[
            Row(
              children: [
                Expanded(child: Text('photo_mcp_enable'.tr, style: theme.textTheme.bodyMedium)),
                Switch(value: _enabled, onChanged: _toggle),
              ],
            ),
            _kv(theme, 'photo_mcp_endpoint'.tr, _endpoint),
            _kv(theme, 'photo_mcp_token'.tr, _tokenMasked.isEmpty ? '—' : _tokenMasked),
            Row(
              children: [
                Expanded(
                  child: Text(
                    'photo_mcp_owner'.tr,
                    style: theme.textTheme.bodySmall?.copyWith(color: theme.colorScheme.onSurfaceVariant),
                  ),
                ),
                DropdownButton<int>(
                  value: _users.any((u) => (u['id'] as num?)?.toInt() == _uid) ? _uid : null,
                  hint: Text('$_uid', style: theme.textTheme.bodySmall),
                  items: _users
                      .map(
                        (u) => DropdownMenuItem<int>(
                          value: (u['id'] as num?)?.toInt() ?? 0,
                          child: Text(
                            '${u['username'] ?? u['id']}',
                            style: theme.textTheme.bodySmall,
                          ),
                        ),
                      )
                      .toList(),
                  onChanged: _setOwner,
                ),
              ],
            ),
            if (_tools.isNotEmpty)
              _kv(theme, 'photo_mcp_tools'.tr, _tools.join(' · ')),
            const SizedBox(height: 6),
            Row(
              children: [
                OutlinedButton.icon(
                  onPressed: _rotate,
                  icon: const Icon(Icons.vpn_key_outlined, size: 16),
                  label: Text('photo_mcp_token_rotate'.tr),
                ),
                const SizedBox(width: 8),
                OutlinedButton.icon(
                  onPressed: _copyConfig,
                  icon: const Icon(Icons.copy_all_outlined, size: 16),
                  label: Text('photo_mcp_copy_config'.tr),
                ),
              ],
            ),
            if (_plainToken.isNotEmpty)
              Padding(
                padding: const EdgeInsets.only(top: 6),
                child: Text(
                  '$_plainToken',
                  style: theme.textTheme.bodySmall?.copyWith(color: theme.colorScheme.primary),
                ),
              ),
          ],
        ],
      ),
    );
  }

  Widget _kv(ThemeData theme, String k, String v) {
    return Padding(
      padding: const EdgeInsets.only(top: 3),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(
            width: 84,
            child: Text(
              k,
              style: theme.textTheme.bodySmall?.copyWith(color: theme.colorScheme.onSurfaceVariant),
            ),
          ),
          Expanded(
            child: SelectableText(v, style: theme.textTheme.bodySmall),
          ),
        ],
      ),
    );
  }
}

/// ⭐ 2026-10-16 P2-20 前置：模型 API 配置（OpenAI 兼容）。
///
/// Agent 对话（P2-20）需要一个对话模型，本仓库此前**没有任何 LLM 接入点**；
/// 这里按 TrailSnap 的口径（任意 OpenAI 兼容厂商：base_url + api_key + model）先把配置与
/// **真实连通性测试**做出来 —— 避免出现「填了配置但没人验证过」的死配置。
/// ⚠️ api_key 只存服务端 config 表，读取一律只回掩码。
class _ModelApiCard extends StatefulWidget {
  const _ModelApiCard();

  @override
  State<_ModelApiCard> createState() => _ModelApiCardState();
}

class _ModelApiCardState extends State<_ModelApiCard> {
  final PhotoAiSettingsApiService _api = PhotoAiSettingsApiService.instance;
  final TextEditingController _baseUrl = TextEditingController();
  final TextEditingController _apiKey = TextEditingController();
  final TextEditingController _model = TextEditingController();
  bool _loading = true;
  bool _testing = false;
  bool _hasKey = false;
  String _keyTail = '';
  String _resultText = '';
  bool _resultOk = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _baseUrl.dispose();
    _apiKey.dispose();
    _model.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    final res = await _api.getModelApi();
    if (!mounted) return;
    final d = res.success ? (res.data ?? const <String, dynamic>{}) : const <String, dynamic>{};
    setState(() {
      _baseUrl.text = d['base_url']?.toString() ?? '';
      _model.text = d['model']?.toString() ?? '';
      _hasKey = d['has_key'] == true;
      _keyTail = d['key_tail']?.toString() ?? '';
      _loading = false;
    });
  }

  Future<void> _save() async {
    final res = await _api.setModelApi(
      baseUrl: _baseUrl.text.trim(),
      apiKey: _apiKey.text,
      model: _model.text.trim(),
    );
    if (!res.success) {
      ToastUtil.show('operation_failed'.tr);
      return;
    }
    _apiKey.clear();
    await _load();
    ToastUtil.show('save'.tr);
  }

  Future<void> _test() async {
    setState(() {
      _testing = true;
      _resultText = '';
    });
    final res = await _api.testModelApi(
      baseUrl: _baseUrl.text.trim(),
      apiKey: _apiKey.text,
      model: _model.text.trim(),
    );
    if (!mounted) return;
    final d = res.success ? (res.data ?? const <String, dynamic>{}) : const <String, dynamic>{};
    final ok = d['ok'] == true;
    final models = ((d['models'] as List?) ?? const []).length;
    final exists = d['model_exists'];
    setState(() {
      _testing = false;
      _resultOk = ok;
      _resultText = ok
          ? '${'photo_model_api_ok'.tr} · ${d['latency_ms'] ?? 0}ms'
              '${models > 0 ? ' · ${'photo_model_api_models'.tr} $models' : ''}'
              '${exists == false ? ' · ⚠ ${_model.text.trim()}' : ''}'
          : '${'photo_model_api_fail'.tr} · ${d['message'] ?? ''}';
    });
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return CustomGlassCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(Icons.smart_toy_outlined, size: 16, color: theme.colorScheme.primary),
              const SizedBox(width: 6),
              Text('photo_model_api_title'.tr, style: theme.textTheme.titleSmall),
            ],
          ),
          const SizedBox(height: 6),
          if (!_loading) ...[
            TextField(
              controller: _baseUrl,
              decoration: InputDecoration(
                labelText: 'photo_model_api_base_url'.tr,
                hintText: 'https://api.deepseek.com/v1',
                isDense: true,
              ),
            ),
            const SizedBox(height: 8),
            TextField(
              controller: _apiKey,
              obscureText: true,
              decoration: InputDecoration(
                labelText: 'photo_model_api_key'.tr,
                hintText: _hasKey
                    ? '***$_keyTail · ${'photo_model_api_key_kept'.tr}'
                    : 'sk-...',
                isDense: true,
              ),
            ),
            const SizedBox(height: 8),
            TextField(
              controller: _model,
              decoration: InputDecoration(
                labelText: 'photo_model_api_model'.tr,
                hintText: 'deepseek-chat',
                isDense: true,
              ),
            ),
            const SizedBox(height: 8),
            Row(
              children: [
                FilledButton.tonalIcon(
                  onPressed: _save,
                  icon: const Icon(Icons.save_outlined, size: 16),
                  label: Text('save'.tr),
                ),
                const SizedBox(width: 8),
                OutlinedButton.icon(
                  onPressed: _testing ? null : _test,
                  icon: _testing
                      ? const SizedBox(width: 14, height: 14, child: CircularProgressIndicator(strokeWidth: 2))
                      : const Icon(Icons.wifi_tethering, size: 16),
                  label: Text(_testing ? 'photo_model_api_testing'.tr : 'photo_model_api_test'.tr),
                ),
              ],
            ),
            if (_resultText.isNotEmpty)
              Padding(
                padding: const EdgeInsets.only(top: 8),
                child: Text(
                  _resultText,
                  style: theme.textTheme.bodySmall?.copyWith(
                    color: _resultOk ? theme.colorScheme.primary : theme.colorScheme.error,
                  ),
                ),
              ),
          ],
        ],
      ),
    );
  }
}
