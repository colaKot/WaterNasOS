import 'package:flutter/material.dart';
import 'package:get/get.dart';
import 'package:photo_manager/photo_manager.dart' as pm;

import '../../../utils/dialog_util.dart';
import '../../../utils/toast_util.dart';
import '../../files/views/folder_picker_dialog.dart';
import '../../transfer/controllers/upload_parts/upload_transfer_helper.dart';
import '../controller/photo_backup_controller.dart';
import '../models/photo_backup_models.dart';
import 'photo_backup_album_picker_sheet.dart';

/// 相册备份主页。
///
/// 整机只维护**一份**备份配置：进入即备份页，不再需要「右上角 + 新建任务」。
class AppPhotoBackupView extends GetView<PhotoBackupController> {
  /// 嵌入模式：作为相册应用内的一个页面（不重复套 Scaffold/AppBar）。
  final bool embedded;

  const AppPhotoBackupView({super.key, this.embedded = false});

  @override
  Widget build(BuildContext context) {
    final body = _buildBody(context);
    final bottom = _buildBottomBar();
    if (embedded) {
      return Column(
        children: [
          Expanded(child: body),
          bottom,
        ],
      );
    }
    return Scaffold(
      appBar: AppBar(
        title: Text('home_photo_backup'.tr),
        actions: [
          Obx(
            () => IconButton(
              tooltip: 'photo_backup_rescan_all'.tr,
              onPressed: controller.isRunning
                  ? null
                  : () => _rescanAll(context),
              icon: const Icon(Icons.restart_alt),
            ),
          ),
          IconButton(
            tooltip: 'photo_backup_runs'.tr,
            onPressed: () => _showRuns(context),
            icon: const Icon(Icons.history),
          ),
        ],
      ),
      body: body,
      bottomNavigationBar: bottom,
    );
  }

  Widget _buildBody(BuildContext context) {
    return Obx(() {
      if (controller.loading.value && controller.task == null) {
        return const Center(child: CircularProgressIndicator());
      }
      final task = controller.task;
      if (task == null) {
        return Center(
          child: Padding(
            padding: const EdgeInsets.all(24),
            child: Text(
              'photo_backup_need_login'.tr,
              textAlign: TextAlign.center,
            ),
          ),
        );
      }
      return ListView(
        padding: const EdgeInsets.fromLTRB(12, 12, 12, 24),
        children: [
          if (embedded) ...[
            Row(
              children: [
                Expanded(
                  child: Text(
                    'home_photo_backup'.tr,
                    style: Theme.of(context).textTheme.titleLarge,
                  ),
                ),
                Obx(
                  () => IconButton(
                    tooltip: 'photo_backup_rescan_all'.tr,
                    onPressed: controller.isRunning
                        ? null
                        : () => _rescanAll(context),
                    icon: const Icon(Icons.restart_alt),
                  ),
                ),
                IconButton(
                  tooltip: 'photo_backup_runs'.tr,
                  onPressed: () => _showRuns(context),
                  icon: const Icon(Icons.history),
                ),
              ],
            ),
            const SizedBox(height: 4),
          ],
          _StatusCard(),
          const SizedBox(height: 12),
          _settingsCard(context, task),
          const SizedBox(height: 12),
          _switchesCard(context, task),
          const SizedBox(height: 12),
          _progressCard(context),
        ],
      );
    });
  }

  Widget _buildBottomBar() {
    return Obx(() {
      final running = controller.isRunning;
      final hasTask = controller.task != null;
      if (!hasTask) return const SizedBox.shrink();
      return SafeArea(
        top: false,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(12, 8, 12, 12),
          child: running
              ? OutlinedButton.icon(
                  onPressed: () => controller.cancelTask(),
                  icon: const Icon(Icons.stop_circle_outlined),
                  label: Text('file_backup_stop'.tr),
                )
              : FilledButton.icon(
                  // 与顶部「开启相册备份」总开关联动：没开启会先把开关打开再跑
                  onPressed: () => controller.requestBackupNow(),
                  icon: const Icon(Icons.cloud_upload_outlined),
                  label: Text('photo_backup_backup_now'.tr),
                ),
        ),
      );
    });
  }

  Future<void> _rescanAll(BuildContext context) async {
    final ok = await DialogUtil.showConfirmDialog(
      title: 'need_confirm'.tr,
      content: 'photo_backup_rescan_all_confirm'.tr,
      confirmText: 'ok'.tr,
      cancelText: 'cancel'.tr,
    );
    if (ok == true) {
      await controller.startBackupAll();
    }
  }

  Future<void> _showRuns(BuildContext context) async {
    final runs = await controller.listRuns();
    if (!context.mounted) return;
    if (runs.isEmpty) {
      ToastUtil.show('no_data'.tr);
      return;
    }
    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      builder: (_) => _RunsSheet(runs: runs),
    );
  }

  Widget _settingsCard(BuildContext context, PhotoBackupTask task) {
    final theme = Theme.of(context);
    final albumsLabel = task.sourceIds.isEmpty
        ? 'all'.tr
        : 'photo_backup_albums_selected'.trParams({
            'count': '${task.sourceIds.length}',
          });
    final target = controller.effectiveTargetDir;
    final targetLabel = target.isNotEmpty
        ? target
        : 'photo_backup_target_empty'.tr;

    return _SectionCard(
      children: [
        _lineTile(
          context,
          icon: Icons.photo_library_outlined,
          title: 'photo_backup_source'.tr,
          subtitle: albumsLabel,
          onTap: controller.isRunning ? null : () => _pickAlbums(context, task),
        ),
        const Divider(height: 1, indent: 52),
        _lineTile(
          context,
          icon: Icons.folder_open_outlined,
          title: 'photo_backup_target'.tr,
          subtitle: targetLabel,
          onTap: controller.isRunning ? null : () => _pickTargetDir(context, task),
        ),
        const Divider(height: 1, indent: 52),
        _lineTile(
          context,
          icon: Icons.account_tree_outlined,
          title: 'photo_backup_dir_style'.tr,
          subtitle: _dirStyleSubtitle(task),
          onTap: controller.isRunning ? null : () => _pickDirStyle(context, task),
        ),
        if (!controller.hasPhotoSource.value) ...[
          const SizedBox(height: 8),
          Text(
            'photo_backup_no_source_hint'.tr,
            style: theme.textTheme.bodySmall?.copyWith(
              color: theme.colorScheme.error,
            ),
          ),
        ],
      ],
    );
  }

  String _dirStyleSubtitle(PhotoBackupTask task) {
    switch (task.dirStyle) {
      case PhotoBackupDirStyle.byAlbum:
        return 'photo_backup_dir_by_album'.tr;
      case PhotoBackupDirStyle.byMonth:
        return '${'photo_backup_dir_by_month'.tr} · ${'photo_backup_dir_example_month'.tr}';
      case PhotoBackupDirStyle.byYear:
        return '${'photo_backup_dir_by_year'.tr} · ${'photo_backup_dir_example_year'.tr}';
    }
  }

  Widget _switchesCard(BuildContext context, PhotoBackupTask task) {
    final theme = Theme.of(context);
    Widget sw({
      required String title,
      required String hint,
      required bool value,
      required ValueChanged<bool> onChanged,
    }) {
      return SwitchListTile(
        activeThumbColor: theme.colorScheme.onPrimary,
        contentPadding: const EdgeInsets.symmetric(horizontal: 12),
        value: value,
        onChanged: controller.isRunning ? null : onChanged,
        title: Text(title),
        subtitle: Text(hint, style: theme.textTheme.bodySmall),
      );
    }

    return _SectionCard(
      children: [
        sw(
          title: 'photo_backup_upload_livephoto_video'.tr,
          hint: 'photo_backup_upload_livephoto_video_hint'.tr,
          value: task.uploadLivePhotoVideo,
          onChanged: (v) => controller.setUploadLivePhotoVideo(v),
        ),
        sw(
          title: 'photo_backup_only_photos'.tr,
          hint: 'photo_backup_only_photos_hint'.tr,
          value: task.onlyPhotos,
          onChanged: (v) => controller.setOnlyPhotos(v),
        ),
        sw(
          title: 'photo_backup_rename_by_date'.tr,
          hint: 'photo_backup_rename_by_date_hint'.tr,
          value: task.renameByDate,
          onChanged: (v) => controller.setRenameByDate(v),
        ),
        sw(
          title: 'photo_backup_use_cellular'.tr,
          hint: 'photo_backup_use_cellular_hint'.tr,
          value: task.useCellular,
          onChanged: (v) async {
            if (v) {
              final ok = await DialogUtil.showConfirmDialog(
                title: 'need_confirm'.tr,
                content: 'photo_backup_cellular_confirm'.tr,
                confirmText: 'ok'.tr,
                cancelText: 'cancel'.tr,
              );
              if (ok != true) return;
            }
            await controller.setUseCellular(v);
          },
        ),
        sw(
          title: 'photo_backup_saving_mode'.tr,
          hint: 'photo_backup_saving_mode_hint'.tr,
          value: task.savingMode,
          onChanged: (v) => controller.setSavingMode(v),
        ),
        sw(
          title: 'photo_backup_keep_screen_on'.tr,
          hint: 'photo_backup_keep_screen_on_hint'.tr,
          value: task.keepScreenOn,
          onChanged: (v) => controller.setKeepScreenOn(v),
        ),
      ],
    );
  }

  Widget _progressCard(BuildContext context) {
    return Obx(() {
      final rt = controller.runtime;
      final done = rt.doneFiles.value;
      final total = rt.totalFiles.value;
      final failed = rt.status.value == 'error' && rt.error.value.isNotEmpty;
      if (!rt.running.value && done <= 0 && rt.error.value.isEmpty) {
        return const SizedBox.shrink();
      }
      final theme = Theme.of(context);
      return _SectionCard(
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(12, 12, 12, 4),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                if (rt.running.value) ...[
                  LinearProgressIndicator(value: rt.progress, minHeight: 6),
                  const SizedBox(height: 8),
                ],
                Text(
                  'photo_backup_progress'.trParams({
                    'done': '$done',
                    'total': total > 0 ? '$total' : '-',
                    'bytesDone': UploadTransferHelper.formatBytes(
                      rt.doneBytes.value,
                    ),
                    'bytesTotal': rt.totalBytes.value > 0
                        ? UploadTransferHelper.formatBytes(rt.totalBytes.value)
                        : '-',
                  }),
                  style: theme.textTheme.bodySmall,
                ),
                const SizedBox(height: 2),
                Text(
                  '${'photo_backup_uploaded_count'.trParams({'count': '${rt.uploadedFiles.value}'})} · ${'photo_backup_skipped_dup'.trParams({'count': '${rt.skippedFiles.value}'})}',
                  style: theme.textTheme.bodySmall?.copyWith(
                    color: theme.colorScheme.onSurfaceVariant,
                  ),
                ),
                if (rt.currentFile.value.trim().isNotEmpty) ...[
                  const SizedBox(height: 2),
                  Text(
                    rt.currentFile.value.trim(),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: theme.textTheme.bodySmall?.copyWith(
                      color: theme.colorScheme.onSurfaceVariant,
                    ),
                  ),
                ],
                if (failed) ...[
                  const SizedBox(height: 4),
                  Text(
                    rt.error.value.trim(),
                    style: theme.textTheme.bodySmall?.copyWith(
                      color: theme.colorScheme.error,
                    ),
                  ),
                ],
              ],
            ),
          ),
        ],
      );
    });
  }

  Future<void> _pickAlbums(BuildContext context, PhotoBackupTask task) async {
    final picked = await showPhotoBackupAlbumPicker(
      context,
      selectedIds: task.sourceIds,
    );
    if (picked == null) return;
    await controller.setSelectedAlbums(
      ids: picked.map((e) => e.id).toList(growable: false),
      names: picked.map((e) => e.name).toList(growable: false),
    );
  }

  Future<void> _pickTargetDir(
    BuildContext context,
    PhotoBackupTask task,
  ) async {
    final current = controller.effectiveTargetDir;
    final res = await showFolderPickerBottomSheet(
      context,
      multiSelect: false,
      allowFileSelect: false,
      initialPath: current.trim().isEmpty ? null : current,
    );
    if (res == null || res.isEmpty) return;
    await controller.setTargetDir(res.first.trim());
  }

  Future<void> _pickDirStyle(
    BuildContext context,
    PhotoBackupTask task,
  ) async {
    final current = task.dirStyle;
    final selected = await showModalBottomSheet<PhotoBackupDirStyle>(
      context: context,
      builder: (ctx) {
        return SafeArea(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              for (final style in PhotoBackupDirStyle.values)
                RadioListTile<PhotoBackupDirStyle>(
                  value: style,
                  groupValue: current,
                  title: Text(_dirStyleTitle(style)),
                  subtitle: Text(
                    _dirStyleExample(style),
                    style: Theme.of(ctx).textTheme.bodySmall,
                  ),
                  onChanged: (v) => Navigator.pop(ctx, v),
                ),
            ],
          ),
        );
      },
    );
    if (selected == null) return;
    await controller.setDirStyle(selected);
  }

  String _dirStyleTitle(PhotoBackupDirStyle style) {
    switch (style) {
      case PhotoBackupDirStyle.byAlbum:
        return 'photo_backup_dir_by_album'.tr;
      case PhotoBackupDirStyle.byMonth:
        return 'photo_backup_dir_by_month'.tr;
      case PhotoBackupDirStyle.byYear:
        return 'photo_backup_dir_by_year'.tr;
    }
  }

  String _dirStyleExample(PhotoBackupDirStyle style) {
    switch (style) {
      case PhotoBackupDirStyle.byAlbum:
        return 'photo_backup_dir_example_album'.tr;
      case PhotoBackupDirStyle.byMonth:
        return 'photo_backup_dir_example_month'.tr;
      case PhotoBackupDirStyle.byYear:
        return 'photo_backup_dir_example_year'.tr;
    }
  }

  Widget _lineTile(
    BuildContext context, {
    required IconData icon,
    required String title,
    required String subtitle,
    required VoidCallback? onTap,
  }) {
    final theme = Theme.of(context);
    return ListTile(
      leading: Icon(icon, color: theme.colorScheme.primary),
      title: Text(title),
      subtitle: Text(
        subtitle,
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
        style: theme.textTheme.bodySmall?.copyWith(
          color: theme.colorScheme.onSurfaceVariant,
        ),
      ),
      trailing: const Icon(Icons.chevron_right),
      onTap: onTap,
    );
  }
}

/// 顶部状态卡：照片图标三态（灰 = 未备份 / 上传箭头 = 备份中 / 打勾 = 完成）+ 总开关。
class _StatusCard extends GetView<PhotoBackupController> {
  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Obx(() {
      final task = controller.task;
      final phase = controller.phase;
      final rt = controller.runtime;

      final Color iconColor;
      IconData? badge;
      Color badgeColor;
      switch (phase) {
        case 'running':
          iconColor = theme.colorScheme.primary;
          badge = Icons.arrow_upward_rounded;
          badgeColor = theme.colorScheme.primary;
          break;
        case 'done':
          iconColor = theme.colorScheme.primary;
          badge = Icons.check_rounded;
          badgeColor = Colors.green;
          break;
        case 'error':
          iconColor = theme.colorScheme.error;
          badge = Icons.error_outline_rounded;
          badgeColor = theme.colorScheme.error;
          break;
        case 'idle':
          iconColor = theme.colorScheme.onSurfaceVariant;
          badge = null;
          badgeColor = theme.colorScheme.onSurfaceVariant;
          break;
        default:
          iconColor = theme.colorScheme.outline;
          badge = null;
          badgeColor = theme.colorScheme.outline;
      }

      final String title;
      switch (phase) {
        case 'running':
          title = 'photo_backup_status_running'.trParams({
            'done': '${rt.doneFiles.value}',
            'total': rt.totalFiles.value > 0 ? '${rt.totalFiles.value}' : '-',
          });
          break;
        case 'done':
          title = 'photo_backup_status_done'.trParams({
            'count': '${rt.totalBackedUp.value}',
          });
          break;
        case 'error':
          title = rt.error.value.trim().isEmpty
              ? 'photo_backup_status_error'.tr
              : rt.error.value.trim();
          break;
        case 'idle':
          title = 'photo_backup_status_idle'.tr;
          break;
        default:
          title = 'photo_backup_status_off'.tr;
      }

      return Card(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(12, 12, 12, 4),
          child: Column(
            children: [
              Row(
                children: [
                  SizedBox(
                    width: 52,
                    height: 52,
                    child: Stack(
                      alignment: Alignment.center,
                      children: [
                        Icon(
                          Icons.photo_outlined,
                          size: 44,
                          color: iconColor,
                        ),
                        if (badge != null)
                          Positioned(
                            right: 12,
                            bottom: 10,
                            child: Icon(
                              badge,
                              size: 18,
                              color: badgeColor,
                            ),
                          ),
                      ],
                    ),
                  ),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(title, style: theme.textTheme.titleMedium),
                      ],
                    ),
                  ),
                ],
              ),
              SwitchListTile(
                activeThumbColor: theme.colorScheme.onPrimary,
                contentPadding: EdgeInsets.zero,
                value: task?.enabled ?? false,
                onChanged: (v) => controller.setEnabled(v),
                title: Text('photo_backup_enable'.tr),
                subtitle: Text(
                  'photo_backup_enable_hint'.tr,
                  style: theme.textTheme.bodySmall,
                ),
              ),
            ],
          ),
        ),
      );
    });
  }
}

class _SectionCard extends StatelessWidget {
  final List<Widget> children;
  const _SectionCard({required this.children});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Card(
      clipBehavior: Clip.antiAlias,
      color: theme.cardColor,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: children,
      ),
    );
  }
}

class _RunsSheet extends GetView<PhotoBackupController> {
  final List<PhotoBackupRunRecord> runs;
  const _RunsSheet({required this.runs});

  String _fmtTime(int ms) {
    if (ms <= 0) return '-';
    final dt = DateTime.fromMillisecondsSinceEpoch(ms).toLocal();
    String two(int v) => v.toString().padLeft(2, '0');
    return '${dt.year}-${two(dt.month)}-${two(dt.day)} ${two(dt.hour)}:${two(dt.minute)}';
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return SafeArea(
      child: SizedBox(
        height: 480,
        child: Column(
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 14, 16, 6),
              child: Row(
                children: [
                  Expanded(
                    child: Text(
                      'photo_backup_runs'.tr,
                      style: theme.textTheme.titleMedium,
                    ),
                  ),
                  IconButton(
                    onPressed: () => Navigator.pop(context),
                    icon: const Icon(Icons.close),
                  ),
                ],
              ),
            ),
            const Divider(height: 1),
            Expanded(
              child: ListView.separated(
                itemCount: runs.length,
                separatorBuilder: (_, _) => const Divider(height: 1),
                itemBuilder: (_, i) {
                  final run = runs[i];
                  return ListTile(
                    title: Text(
                      'photo_backup_run_item'.trParams({
                        'success': '${run.successCount}',
                        'failed': '${run.failedCount}',
                      }),
                    ),
                    subtitle: Text(
                      '${_fmtTime(run.startedAtMs)} - ${_fmtTime(run.finishedAtMs)} · ${UploadTransferHelper.formatBytes(run.totalBytes)}',
                    ),
                    trailing: Wrap(
                      spacing: 4,
                      children: [
                        IconButton(
                          tooltip: 'photo_backup_file_logs'.tr,
                          onPressed: () async {
                            final files = await controller.listRunFiles(run.id);
                            if (!context.mounted) return;
                            await showDialog<void>(
                              context: context,
                              builder: (_) =>
                                  _RunFilesDialog(run: run, files: files),
                            );
                          },
                          icon: const Icon(Icons.list_alt_outlined),
                        ),
                        IconButton(
                          tooltip: 'delete'.tr,
                          onPressed: () async {
                            await controller.deleteRun(run.id);
                            if (!context.mounted) return;
                            Navigator.pop(context);
                          },
                          icon: const Icon(Icons.delete_outline),
                        ),
                      ],
                    ),
                  );
                },
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _RunFilesDialog extends StatelessWidget {
  final PhotoBackupRunRecord run;
  final List<PhotoBackupFileRecord> files;

  const _RunFilesDialog({required this.run, required this.files});

  String _fmtTime(int ms) {
    if (ms <= 0) return '-';
    final dt = DateTime.fromMillisecondsSinceEpoch(ms).toLocal();
    String two(int v) => v.toString().padLeft(2, '0');
    return '${dt.year}-${two(dt.month)}-${two(dt.day)} ${two(dt.hour)}:${two(dt.minute)}';
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: Text(
        'photo_backup_file_logs_title'.trParams({
          'time': _fmtTime(run.startedAtMs),
        }),
      ),
      content: SizedBox(
        width: 720,
        height: 420,
        child: files.isEmpty
            ? Center(child: Text('no_data'.tr))
            : ListView.separated(
                itemCount: files.length,
                separatorBuilder: (_, _) => const Divider(height: 1),
                itemBuilder: (_, i) {
                  final item = files[i];
                  final failed = item.status == 'error';
                  final skipped = item.isSkipped;
                  final icon = failed
                      ? Icons.error_outline
                      : (skipped ? Icons.content_copy_outlined : Icons.check_circle_outline);
                  final color = failed
                      ? Colors.red
                      : (skipped ? Colors.orange : Colors.green);
                  return ListTile(
                    leading: Icon(icon, color: color),
                    title: Text(item.displayName),
                    subtitle: Text(
                      '${UploadTransferHelper.formatBytes(item.size)} · '
                      '${skipped ? 'skip'.tr : _fmtTime(item.uploadedAtMs)}'
                      '${item.error.isEmpty ? '' : '\n${item.error}'}',
                    ),
                    isThreeLine: item.error.isNotEmpty,
                  );
                },
              ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(context),
          child: Text('close'.tr),
        ),
      ],
    );
  }
}

/// 相册多选：默认全选，顶部可一键全选/全不选。
Future<List<pm.AssetPathEntity>?> showPhotoBackupAlbumPicker(
  BuildContext context, {
  List<String> selectedIds = const <String>[],
}) {
  return Navigator.of(context).push<List<pm.AssetPathEntity>>(
    MaterialPageRoute<List<pm.AssetPathEntity>>(
      fullscreenDialog: true,
      builder: (_) => PhotoBackupAlbumPickerPage(selectedIds: selectedIds),
    ),
  );
}
