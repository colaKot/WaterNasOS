import 'package:flutter/material.dart';
import 'package:get/get.dart';
import 'package:nascab_sync_core/nascab_sync_core.dart';

import '../sync/sync_controller.dart';
import 'sync_wizard/sync_create_wizard_view.dart';

/// 主页：同步任务列表。
class HomeView extends StatelessWidget {
  const HomeView({super.key});

  @override
  Widget build(BuildContext context) {
    final ctrl = SyncController.instance;

    return Scaffold(
      appBar: AppBar(
        titleSpacing: 20,
        title: Obx(
          () => Row(
            children: [
              Image.asset(
                'assets/sync.webp',
                width: 22,
                height: 22,
                errorBuilder: (_, __, ___) => const Icon(Icons.sync, size: 20),
              ),
              const SizedBox(width: 10),
              const Text('WaterNasSync'),
              const SizedBox(width: 12),
              if (ctrl.tasks.isNotEmpty)
                Text(
                  'sync_task_count'.trParams({'count': '${ctrl.tasks.length}'}),
                  style: Theme.of(context).textTheme.bodySmall,
                ),
            ],
          ),
        ),
        actions: [
          Obx(
            () => Tooltip(
              message: ctrl.autoPaused.value
                  ? 'tray_resume_auto'.tr
                  : 'tray_pause_auto'.tr,
              child: IconButton(
                icon: Icon(
                  ctrl.autoPaused.value
                      ? Icons.play_circle_outline
                      : Icons.pause_circle_outline,
                ),
                onPressed: () async {
                  final next = !ctrl.autoPaused.value;
                  await ctrl.setAutoPaused(next);
                  Get.snackbar(
                    'app_name'.tr,
                    next ? 'sync_paused_all'.tr : 'sync_resumed_all'.tr,
                    snackPosition: SnackPosition.BOTTOM,
                    duration: const Duration(seconds: 2),
                  );
                },
              ),
            ),
          ),
          IconButton(
            tooltip: 'refresh'.tr,
            icon: const Icon(Icons.refresh),
            onPressed: () => ctrl.refreshTasks(showLoading: true),
          ),
          IconButton(
            tooltip: 'settings'.tr,
            icon: const Icon(Icons.settings_outlined),
            onPressed: () => Get.toNamed('/settings'),
          ),
          const SizedBox(width: 8),
        ],
      ),
      body: Column(
        children: [
          _buildLegacyClaimBanner(context, ctrl),
          Expanded(
            child: Obx(() {
              if (ctrl.loading.value && ctrl.tasks.isEmpty) {
                return const Center(child: CircularProgressIndicator());
              }
              if (ctrl.errorText.value.isNotEmpty && ctrl.tasks.isEmpty) {
                return _ErrorState(
                  message: ctrl.errorText.value,
                  onRetry: () => ctrl.refreshTasks(showLoading: true),
                );
              }
              if (ctrl.tasks.isEmpty) {
                return const _EmptyState();
              }
              return ListView.separated(
                padding: const EdgeInsets.fromLTRB(16, 16, 16, 96),
                itemCount: ctrl.tasks.length,
                separatorBuilder: (_, __) => const SizedBox(height: 12),
                itemBuilder: (context, index) =>
                    _TaskCard(task: ctrl.tasks[index]),
              );
            }),
          ),
        ],
      ),
      floatingActionButton: FloatingActionButton.extended(
        // 新建任务走与主客户端一致的三步向导弹窗（设备 → 规则 → 路径），
        // 关闭向导后才可能误触，所以禁止点遮罩关闭。
        onPressed: () => showDialog<bool>(
          context: context,
          barrierDismissible: false,
          builder: (_) => const SyncCreateWizardView(),
        ),
        icon: const Icon(Icons.add),
        label: Text('sync_create_task'.tr),
      ),
    );
  }

  /// 旧版任务认领横幅：账号下存在「未绑定主机」的旧同步任务时提示用户。
  ///
  /// 只提示不自动认领——任务该归哪台机器只有用户知道，自动抢会造成基线错位。
  Widget _buildLegacyClaimBanner(BuildContext context, SyncController ctrl) {
    return Obx(() {
      final pending = ctrl.legacyPendingCount.value;
      if (pending <= 0) return const SizedBox.shrink();
      final theme = Theme.of(context);
      return Container(
        margin: const EdgeInsets.fromLTRB(16, 12, 16, 0),
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
        decoration: BoxDecoration(
          color: theme.colorScheme.tertiaryContainer.withValues(alpha: 0.4),
          borderRadius: BorderRadius.circular(10),
        ),
        child: Row(
          children: [
            Icon(Icons.devices_outlined, size: 20, color: theme.colorScheme.tertiary),
            const SizedBox(width: 10),
            Expanded(
              child: Text(
                'sync_legacy_banner'.trParams({
                  'count': '$pending',
                  'device': ctrl.deviceLabel,
                }),
                style: theme.textTheme.bodySmall,
              ),
            ),
            const SizedBox(width: 8),
            TextButton(
              onPressed: ctrl.claimLegacyTasks,
              child: Text('sync_legacy_claim_action'.tr),
            ),
          ],
        ),
      );
    });
  }
}

class _EmptyState extends StatelessWidget {
  const _EmptyState();

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(
            Icons.cloud_sync_outlined,
            size: 56,
            color: theme.disabledColor,
          ),
          const SizedBox(height: 14),
          Text('sync_no_tasks'.tr, style: theme.textTheme.titleMedium),
          const SizedBox(height: 6),
          Text(
            'sync_no_tasks_desc'.tr,
            style: theme.textTheme.bodySmall,
            textAlign: TextAlign.center,
          ),
        ],
      ),
    );
  }
}

class _ErrorState extends StatelessWidget {
  const _ErrorState({required this.message, required this.onRetry});

  final String message;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(32),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(Icons.cloud_off_outlined, size: 48, color: theme.disabledColor),
            const SizedBox(height: 14),
            Text(message, textAlign: TextAlign.center),
            const SizedBox(height: 16),
            OutlinedButton.icon(
              onPressed: onRetry,
              icon: const Icon(Icons.refresh),
              label: Text('retry'.tr),
            ),
          ],
        ),
      ),
    );
  }
}

/// 单个同步任务卡片
///
/// 信息结构与主客户端 `_SyncTaskCard` 对齐：标题 + 模式/状态标签、
/// 两端路径、上次同步时间与错误、进度条、策略摘要与操作按钮。
class _TaskCard extends StatefulWidget {
  const _TaskCard({required this.task});

  final SyncTask task;

  @override
  State<_TaskCard> createState() => _TaskCardState();
}

class _TaskCardState extends State<_TaskCard> {
  /// 手动触发的「立即同步」正在请求中（按钮转圈、防重复点击）
  bool _starting = false;

  SyncTask get task => widget.task;

  Color _statusColor(ThemeData theme, String status) {
    switch (status) {
      case SyncStatus.running:
        return theme.colorScheme.primary;
      case SyncStatus.error:
        return theme.colorScheme.error;
      case SyncStatus.paused:
        return theme.colorScheme.tertiary;
      default:
        return theme.colorScheme.onSurface.withValues(alpha: 0.55);
    }
  }

  Color _modeColor(ThemeData theme, String mode) {
    switch (mode) {
      case SyncMode.downloadOnly:
        return theme.colorScheme.tertiary;
      case SyncMode.uploadOnly:
        return theme.colorScheme.secondary;
      default:
        return theme.colorScheme.primary;
    }
  }

  Future<void> _run() async {
    if (_starting) return;
    setState(() => _starting = true);
    try {
      final result = await SyncController.instance.runTask(task);
      if (!mounted || result == null) return;
      final msg = result.ok
          ? 'sync_result_line'.trParams({
              'up': '${result.uploadCount}',
              'down': '${result.downloadCount}',
              'del': '${result.deleteCount}',
              'skip': '${result.skipCount}',
              'fail': '${result.failCount}',
            })
          : (result.error ?? 'sync_phase_failed'.tr);
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(msg), duration: const Duration(seconds: 4)),
      );
    } finally {
      if (mounted) setState(() => _starting = false);
    }
  }

  Future<void> _delete() async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text('sync_delete_confirm'.tr),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(false),
            child: Text('cancel'.tr),
          ),
          FilledButton(
            onPressed: () => Navigator.of(ctx).pop(true),
            child: Text('delete'.tr),
          ),
        ],
      ),
    );
    if (ok != true || !mounted) return;
    final err = await SyncController.instance.removeTask(task.id);
    if (!mounted) return;
    if (err != null) {
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(err)));
    }
  }

  void _edit() {
    // 编辑走同一个向导，带上原任务做回填；同样禁止点遮罩关闭。
    showDialog<bool>(
      context: context,
      barrierDismissible: false,
      builder: (_) => SyncCreateWizardView(editingTask: task),
    );
  }

  void _showRecords() {
    showDialog<void>(
      context: context,
      builder: (_) => _RecordsDialog(taskId: task.id, taskName: task.name),
    );
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final engine = SyncEngine.instance;

    return Obx(() {
      final progress = engine.progressOf(task.id);
      final running = engine.isRunning(task.id) ||
          (progress != null && !progress.isFinished) ||
          task.status == SyncStatus.running;

      return Card(
        elevation: 0,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(12),
          side: BorderSide(color: theme.dividerColor.withValues(alpha: 0.5)),
        ),
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Icon(Icons.sync, size: 20, color: _modeColor(theme, task.mode)),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      task.name,
                      overflow: TextOverflow.ellipsis,
                      style: theme.textTheme.titleSmall?.copyWith(
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                  ),
                  _chip(
                    context,
                    text: SyncMode.labelKey(task.mode).tr,
                    color: _modeColor(theme, task.mode),
                  ),
                  const SizedBox(width: 6),
                  _chip(
                    context,
                    text: SyncStatus.labelKey(
                      running ? SyncStatus.running : task.status,
                    ).tr,
                    color: _statusColor(
                      theme,
                      running ? SyncStatus.running : task.status,
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 10),
              _pathRow(
                context,
                icon: Icons.computer_outlined,
                label: 'sync_local_dir'.tr,
                value: task.localDir,
              ),
              const SizedBox(height: 6),
              _pathRow(
                context,
                icon: Icons.dns_outlined,
                label: 'sync_remote_dir'.tr,
                value: task.remoteDir,
              ),
              const SizedBox(height: 10),
              Row(
                children: [
                  Icon(
                    Icons.schedule,
                    size: 14,
                    color: scheme.onSurface.withValues(alpha: 0.55),
                  ),
                  const SizedBox(width: 4),
                  Text(
                    '${'sync_last_sync'.tr}: ${formatTimeMs(task.lastSyncTime)}',
                    style: theme.textTheme.bodySmall?.copyWith(
                      color: scheme.onSurface.withValues(alpha: 0.6),
                    ),
                  ),
                  const Spacer(),
                  if (task.lastError.trim().isNotEmpty)
                    Flexible(
                      child: Text(
                        task.lastError.trim(),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: theme.textTheme.bodySmall?.copyWith(
                          color: scheme.error,
                        ),
                      ),
                    ),
                ],
              ),
              if (running) ...[
                const SizedBox(height: 12),
                _buildProgress(context, progress),
              ],
              const SizedBox(height: 12),
              Row(
                children: [
                  Expanded(
                    child: Text(
                      _syncConfigSummary(task),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: theme.textTheme.bodySmall?.copyWith(
                        color: scheme.onSurface.withValues(alpha: 0.55),
                      ),
                    ),
                  ),
                  const SizedBox(width: 8),
                  if (running)
                    TextButton.icon(
                      onPressed: () =>
                          SyncController.instance.cancelTask(task.id),
                      icon: const Icon(Icons.stop_circle_outlined, size: 18),
                      label: Text('sync_stop'.tr),
                    )
                  else
                    FilledButton.tonalIcon(
                      onPressed: _starting ? null : _run,
                      icon: _starting
                          ? const SizedBox(
                              width: 16,
                              height: 16,
                              child: CircularProgressIndicator(strokeWidth: 2),
                            )
                          : const Icon(Icons.play_arrow, size: 18),
                      label: Text('sync_start_now'.tr),
                    ),
                  const SizedBox(width: 4),
                  IconButton(
                    icon: const Icon(Icons.history, size: 18),
                    tooltip: 'sync_records'.tr,
                    onPressed: _showRecords,
                  ),
                  IconButton(
                    icon: const Icon(Icons.edit_outlined, size: 18),
                    tooltip: 'edit'.tr,
                    onPressed: running ? null : _edit,
                  ),
                  IconButton(
                    icon: const Icon(Icons.delete_outline, size: 18),
                    tooltip: 'delete'.tr,
                    onPressed: running ? null : _delete,
                  ),
                ],
              ),
            ],
          ),
        ),
      );
    });
  }

  Widget _buildProgress(BuildContext context, SyncProgress? progress) {
    final theme = Theme.of(context);
    final phase = progress?.phase ?? SyncPhase.scanning;
    final percent = progress?.percent ?? 0;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        ClipRRect(
          borderRadius: BorderRadius.circular(4),
          child: LinearProgressIndicator(
            value: percent > 0 ? percent : null,
            minHeight: 6,
          ),
        ),
        const SizedBox(height: 6),
        Row(
          children: [
            Expanded(
              child: Text(
                SyncPhase.labelKey(phase).tr,
                style: theme.textTheme.bodySmall,
              ),
            ),
            if ((progress?.currentRelPath ?? '').isNotEmpty)
              Flexible(
                child: Text(
                  progress!.currentRelPath,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  textAlign: TextAlign.right,
                  style: theme.textTheme.bodySmall?.copyWith(
                    color: theme.colorScheme.onSurface.withValues(alpha: 0.55),
                  ),
                ),
              ),
          ],
        ),
      ],
    );
  }

  Widget _pathRow(
    BuildContext context, {
    required IconData icon,
    required String label,
    required String value,
  }) {
    final theme = Theme.of(context);
    return Row(
      children: [
        Icon(
          icon,
          size: 14,
          color: theme.colorScheme.onSurface.withValues(alpha: 0.55),
        ),
        const SizedBox(width: 6),
        SizedBox(
          width: 78,
          child: Text(
            label,
            style: theme.textTheme.bodySmall?.copyWith(
              color: theme.colorScheme.onSurface.withValues(alpha: 0.55),
            ),
          ),
        ),
        Expanded(
          child: Tooltip(
            message: value,
            child: Text(
              value,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: theme.textTheme.bodyMedium,
            ),
          ),
        ),
      ],
    );
  }

  Widget _chip(
    BuildContext context, {
    required String text,
    required Color color,
  }) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.12),
        borderRadius: BorderRadius.circular(6),
      ),
      child: Text(
        text,
        style: Theme.of(context)
            .textTheme
            .labelSmall
            ?.copyWith(color: color, fontWeight: FontWeight.w500),
      ),
    );
  }

  /// 同步策略摘要，例如「按需同步 · 每30分钟」
  String _syncConfigSummary(SyncTask task) {
    final parts = <String>[];
    if (task.syncConfig.realtime) {
      parts.add('sync_realtime'.tr);
    }
    if (task.syncConfig.intervalMinutes > 0) {
      parts.add(
        'sync_interval_every'.trParams({
          'minutes': task.syncConfig.intervalMinutes.toString(),
        }),
      );
    }
    if (task.syncConfig.deleteExtra && task.mode == SyncMode.bidirectional) {
      parts.add('sync_delete_extra'.tr);
    }
    if (parts.isEmpty) parts.add('sync_manual_only'.tr);
    return parts.join(' · ');
  }
}

/// 同步运行记录弹窗
///
/// 信息结构与主客户端 `_SyncRecordDialog` 对齐：每条记录给出
/// 成功/失败状态、时间、各项计数与传输量，失败时展开错误明细。
class _RecordsDialog extends StatefulWidget {
  const _RecordsDialog({required this.taskId, required this.taskName});

  final int taskId;
  final String taskName;

  @override
  State<_RecordsDialog> createState() => _RecordsDialogState();
}

class _RecordsDialogState extends State<_RecordsDialog> {
  late Future<List<SyncRecord>> _future;

  @override
  void initState() {
    super.initState();
    _future = SyncController.instance.loadRecords(widget.taskId);
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return AlertDialog(
      title: Text('${'sync_records'.tr} · ${widget.taskName}'),
      constraints: const BoxConstraints(maxWidth: 680, minWidth: 360),
      content: SizedBox(
        width: 640,
        height: 420,
        child: FutureBuilder<List<SyncRecord>>(
          future: _future,
          builder: (context, snapshot) {
            if (snapshot.connectionState == ConnectionState.waiting) {
              return const Center(child: CircularProgressIndicator());
            }
            final records = snapshot.data ?? const <SyncRecord>[];
            if (records.isEmpty) {
              return Center(
                child: Text(
                  'sync_no_records'.tr,
                  style: theme.textTheme.bodyMedium?.copyWith(
                    color: theme.colorScheme.onSurface.withValues(alpha: 0.6),
                  ),
                ),
              );
            }
            return ListView.separated(
              itemCount: records.length,
              separatorBuilder: (_, __) => const SizedBox(height: 8),
              itemBuilder: (context, index) {
                final r = records[index];
                final ok = r.isSuccess;
                final color =
                    ok ? theme.colorScheme.primary : theme.colorScheme.error;
                return Container(
                  padding: const EdgeInsets.all(12),
                  decoration: BoxDecoration(
                    borderRadius: BorderRadius.circular(10),
                    border: Border.all(
                      color: theme.colorScheme.outlineVariant
                          .withValues(alpha: 0.5),
                    ),
                  ),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(
                        children: [
                          Icon(
                            ok
                                ? Icons.check_circle_outline
                                : Icons.error_outline,
                            size: 16,
                            color: color,
                          ),
                          const SizedBox(width: 6),
                          Text(
                            ok
                                ? 'sync_record_success'.tr
                                : 'sync_record_failed'.tr,
                            style: theme.textTheme.bodyMedium?.copyWith(
                              color: color,
                              fontWeight: FontWeight.w600,
                            ),
                          ),
                          const Spacer(),
                          Text(
                            formatTimeMs(r.startTime),
                            style: theme.textTheme.bodySmall?.copyWith(
                              color: theme.colorScheme.onSurface
                                  .withValues(alpha: 0.6),
                            ),
                          ),
                        ],
                      ),
                      const SizedBox(height: 8),
                      Wrap(
                        spacing: 12,
                        runSpacing: 4,
                        children: [
                          _stat(theme, 'sync_stat_upload', r.uploadCount),
                          _stat(theme, 'sync_stat_download', r.downloadCount),
                          _stat(theme, 'sync_stat_delete', r.deleteCount),
                          _stat(theme, 'sync_stat_skip', r.skipCount),
                          _stat(
                            theme,
                            'sync_stat_fail',
                            r.failCount,
                            danger: r.failCount > 0,
                          ),
                          _stat(
                            theme,
                            'sync_stat_bytes',
                            null,
                            text: formatBytes(r.bytesTransferred),
                          ),
                        ],
                      ),
                      if (r.errorList.isNotEmpty) ...[
                        const SizedBox(height: 8),
                        Container(
                          width: double.infinity,
                          padding: const EdgeInsets.all(8),
                          decoration: BoxDecoration(
                            color: theme.colorScheme.errorContainer
                                .withValues(alpha: 0.3),
                            borderRadius: BorderRadius.circular(6),
                          ),
                          child: Text(
                            r.errorList.take(5).join('\n'),
                            style: theme.textTheme.bodySmall,
                          ),
                        ),
                      ],
                    ],
                  ),
                );
              },
            );
          },
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(),
          child: Text('ok'.tr),
        ),
      ],
    );
  }

  Widget _stat(
    ThemeData theme,
    String labelKey,
    int? value, {
    String? text,
    bool danger = false,
  }) {
    final color = danger
        ? theme.colorScheme.error
        : theme.colorScheme.onSurface.withValues(alpha: 0.75);
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Text(
          '${labelKey.tr} ',
          style: theme.textTheme.bodySmall?.copyWith(
            color: theme.colorScheme.onSurface.withValues(alpha: 0.55),
          ),
        ),
        Text(
          text ?? (value ?? 0).toString(),
          style: theme.textTheme.bodySmall?.copyWith(
            color: color,
            fontWeight: FontWeight.w600,
          ),
        ),
      ],
    );
  }
}
