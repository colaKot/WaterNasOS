import 'package:flutter/material.dart';
import 'package:get/get.dart';
import 'package:WaterNasOS/core/theme/custom_colors.dart';

import '../service/photo_ai_settings_api_service.dart';

/// ⭐ 2026-10-19 模型目录（从「智能发现」挪到设置里）。
///
/// 只读：列出本机已就位的 AI 模型包（名字 / bundle id / 文件数 / 占用）。
/// 以前挂在智能发现页的第 7 个标签，那里入口太深，也没人天天看 —— 归到设置更顺手。
class PhotoModelsController extends GetxController {
  PhotoAiSettingsApiService get _api => PhotoAiSettingsApiService.instance;

  bool loading = true;
  String? error;
  List<Map<String, dynamic>> items = const <Map<String, dynamic>>[];

  @override
  void onInit() {
    super.onInit();
    // 放到 microtask：GetBuilder 的 init 发生在 initState，此时同步 update() 会在
    // 父级 build 过程中触发重建（release 静默、debug 直接 assert）。
    Future.microtask(load);
  }

  Future<void> load() async {
    loading = true;
    error = null;
    update();
    try {
      final res = await _api.getModels();
      if (!res.success || res.data == null) {
        error = 'operation_failed'.tr;
        items = const <Map<String, dynamic>>[];
      } else {
        final raw = res.data!['items'];
        items = raw is List
            ? [
                for (final e in raw)
                  if (e is Map) e.cast<String, dynamic>(),
              ]
            : const <Map<String, dynamic>>[];
      }
    } catch (_) {
      error = 'operation_failed'.tr;
      items = const <Map<String, dynamic>>[];
    } finally {
      loading = false;
      update();
    }
  }

  static String formatBytes(int v) {
    if (v <= 0) return '0 B';
    const units = <String>['B', 'KB', 'MB', 'GB', 'TB'];
    double d = v.toDouble();
    var i = 0;
    while (d >= 1024 && i < units.length - 1) {
      d /= 1024;
      i += 1;
    }
    return '${d.toStringAsFixed(d >= 100 || i == 0 ? 0 : 1)} ${units[i]}';
  }
}

class PhotoModelsView extends StatelessWidget {
  const PhotoModelsView({super.key});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final customColors = theme.extension<CustomColors>();
    return GetBuilder<PhotoModelsController>(
      init: PhotoModelsController(),
      builder: (ctrl) {
        return Container(
          color: customColors?.mainContentBgColor ?? theme.scaffoldBackgroundColor,
          child: ListView(
            padding: const EdgeInsets.fromLTRB(20, 18, 20, 26),
            children: [
              Text(
                'photo_models_title'.tr,
                style: theme.textTheme.headlineSmall?.copyWith(
                  fontWeight: FontWeight.w800,
                  letterSpacing: -0.4,
                ),
              ),
              const SizedBox(height: 2),
              Text(
                'photo_models_sub'.tr,
                style: theme.textTheme.bodySmall?.copyWith(color: scheme.onSurfaceVariant),
              ),
              const SizedBox(height: 16),
              if (ctrl.loading)
                const Padding(
                  padding: EdgeInsets.only(top: 60),
                  child: Center(child: CircularProgressIndicator()),
                )
              else if (ctrl.error != null)
                _Hint(
                  icon: Icons.error_outline,
                  title: ctrl.error!,
                  actionLabel: 'retry'.tr,
                  onAction: ctrl.load,
                )
              else if (ctrl.items.isEmpty)
                _Hint(icon: Icons.memory, title: 'photo_models_empty'.tr)
              else
                for (final m in ctrl.items)
                  Container(
                    margin: const EdgeInsets.only(bottom: 10),
                    padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
                    decoration: BoxDecoration(
                      color: scheme.surface,
                      borderRadius: BorderRadius.circular(12),
                      border: Border.all(
                        color: scheme.outlineVariant.withValues(alpha: 0.42),
                      ),
                    ),
                    child: Row(
                      children: [
                        Container(
                          width: 38,
                          height: 38,
                          decoration: BoxDecoration(
                            color: scheme.primary.withValues(alpha: 0.10),
                            borderRadius: BorderRadius.circular(10),
                          ),
                          child: Icon(Icons.memory, size: 20, color: scheme.primary),
                        ),
                        const SizedBox(width: 12),
                        Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(
                                (m['name'] ?? '').toString(),
                                style: theme.textTheme.bodyMedium
                                    ?.copyWith(fontWeight: FontWeight.w700),
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                              ),
                              const SizedBox(height: 2),
                              Text(
                                [
                                  'photo_models_files'
                                      .trParams({'count': '${(m['files'] as num?)?.toInt() ?? 0}'}),
                                  PhotoModelsController.formatBytes(
                                    (m['bytes'] as num?)?.toInt() ?? 0,
                                  ),
                                  if ((m['bundle_id'] ?? '').toString().isNotEmpty)
                                    (m['bundle_id'] ?? '').toString(),
                                ].join(' · '),
                                style: theme.textTheme.bodySmall
                                    ?.copyWith(color: scheme.onSurfaceVariant),
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                              ),
                            ],
                          ),
                        ),
                      ],
                    ),
                  ),
            ],
          ),
        );
      },
    );
  }
}

class _Hint extends StatelessWidget {
  final IconData icon;
  final String title;
  final String? actionLabel;
  final VoidCallback? onAction;

  const _Hint({
    required this.icon,
    required this.title,
    this.actionLabel,
    this.onAction,
  });

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Padding(
      padding: const EdgeInsets.only(top: 60),
      child: Column(
        children: [
          Icon(icon, size: 38, color: scheme.onSurfaceVariant),
          const SizedBox(height: 12),
          Text(title, textAlign: TextAlign.center, style: const TextStyle(fontSize: 14)),
          if (actionLabel != null) ...[
            const SizedBox(height: 14),
            FilledButton.tonal(onPressed: onAction, child: Text(actionLabel!)),
          ],
        ],
      ),
    );
  }
}
