// 说明：本页（旧的单页表单）已被「设备 → 规则 → 路径」三步向导
// （ui/sync_wizard/sync_create_wizard_view.dart）取代，路由与入口均已移除，
// 此文件仅作参考保留，不再被任何页面引用。请勿删除。
import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:get/get.dart';
import 'package:nascab_sync_core/nascab_sync_core.dart';

import '../core/file_api.dart';
import '../sync/sync_controller.dart';
import 'remote_dir_picker.dart';

/// 任务编辑页：新建 / 修改一个同步任务。
class TaskEditView extends StatefulWidget {
  const TaskEditView({super.key});

  @override
  State<TaskEditView> createState() => _TaskEditViewState();
}

class _TaskEditViewState extends State<TaskEditView> {
  late final TextEditingController _nameCtrl;
  late final TextEditingController _localCtrl;
  late final TextEditingController _remoteCtrl;
  late final TextEditingController _intervalCtrl;
  late final TextEditingController _smallSizeCtrl;
  late final TextEditingController _largeSizeCtrl;
  late final TextEditingController _extCtrl;

  SyncTask? _origin;
  late String _mode;
  late SyncFilterConfig _filter;
  late SyncConfig _syncCfg;
  bool _saving = false;

  /// NAS 侧「当前账号可用目录」的候选，供下拉快选（来自 /api/file/list）
  List<String> _remoteRoots = const [];

  bool get _isEdit => _origin != null;

  @override
  void initState() {
    super.initState();
    final arg = Get.arguments;
    final task = arg is SyncTask ? arg : null;
    _origin = task;

    _mode = task?.mode ?? SyncMode.bidirectional;
    _filter = task?.filterConfig.clone() ?? SyncFilterConfig();
    _syncCfg = task != null
        ? SyncConfig.fromJson(task.syncConfig.toJson())
        : SyncConfig();

    _nameCtrl = TextEditingController(text: task?.name ?? '');
    _localCtrl = TextEditingController(text: task?.localDir ?? '');
    _remoteCtrl = TextEditingController(text: task?.remoteDir ?? '');
    _intervalCtrl =
        TextEditingController(text: '${_syncCfg.intervalMinutes}');
    _smallSizeCtrl =
        TextEditingController(text: '${_filter.excludeSmallSize}');
    _largeSizeCtrl =
        TextEditingController(text: '${_filter.excludeLargeSize}');
    _extCtrl = TextEditingController(text: _filter.excludeExtensions.join(','));
    _loadRemoteRoots();
  }

  @override
  void dispose() {
    _nameCtrl.dispose();
    _localCtrl.dispose();
    _remoteCtrl.dispose();
    _intervalCtrl.dispose();
    _smallSizeCtrl.dispose();
    _largeSizeCtrl.dispose();
    _extCtrl.dispose();
    super.dispose();
  }

  Future<void> _pickLocalDir() async {
    try {
      final dir = await FilePicker.platform.getDirectoryPath(
        dialogTitle: 'sync_local_dir'.tr,
      );
      if (dir == null || dir.isEmpty) return;
      setState(() => _localCtrl.text = dir);
    } catch (_) {
      _toast('sync_pick_local_failed'.tr);
    }
  }

  /// 拉取当前账号可见的 NAS 根目录，作为「NAS 目录」的候选。
  /// 失败就静默降级成纯手填，不打扰用户。
  Future<void> _loadRemoteRoots() async {
    final res = await FileApiService.instance.listDirs();
    if (!mounted || !res.success || res.data == null) return;
    setState(() {
      _remoteRoots = res.data!.dirs.map((e) => e.path).toList();
    });
  }

  /// 打开 NAS 目录浏览器逐级选择
  Future<void> _browseRemoteDir() async {
    final picked = await showRemoteDirPicker(
      context,
      initialPath: _remoteCtrl.text.trim(),
    );
    if (picked == null || picked.isEmpty || !mounted) return;
    setState(() => _remoteCtrl.text = picked);
  }

  void _toast(String msg) {
    if (!mounted) return;
    ScaffoldMessenger.of(context)
        .showSnackBar(SnackBar(content: Text(msg)));
  }

  Future<void> _save() async {
    if (_saving) return;

    final name = _nameCtrl.text.trim();
    final local = _localCtrl.text.trim();
    final remote = _remoteCtrl.text.trim();

    if (name.isEmpty) return _toast('sync_task_name_required'.tr);
    if (local.isEmpty) return _toast('sync_local_dir_required'.tr);
    if (remote.isEmpty) return _toast('sync_remote_dir_required'.tr);
    if (local == remote) return _toast('sync_dir_same'.tr);

    // 收集过滤规则
    _filter
      ..excludeSmallSize = int.tryParse(_smallSizeCtrl.text.trim()) ?? 10
      ..excludeLargeSize = int.tryParse(_largeSizeCtrl.text.trim()) ?? 10
      ..excludeExtensions = _extCtrl.text
          .split(',')
          .map((e) => e.trim().replaceFirst(RegExp(r'^\.'), '').toLowerCase())
          .where((e) => e.isNotEmpty)
          .toList();

    _syncCfg.intervalMinutes =
        (int.tryParse(_intervalCtrl.text.trim()) ?? 1).clamp(0, 24 * 60);

    setState(() => _saving = true);
    final err = await SyncController.instance.createOrUpdate(
      id: _origin?.id,
      name: name,
      mode: _mode,
      localDir: local,
      remoteDir: remote,
      filterConfig: _filter,
      syncConfig: _syncCfg,
    );
    if (!mounted) return;
    setState(() => _saving = false);

    if (err != null) {
      _toast(err);
      return;
    }
    Get.back();
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);

    return Scaffold(
      appBar: AppBar(
        title: Text(
          _isEdit ? 'sync_edit_task'.tr : 'sync_create_task'.tr,
        ),
        actions: [
          Padding(
            padding: const EdgeInsets.only(right: 12),
            child: FilledButton.icon(
              onPressed: _saving ? null : _save,
              icon: _saving
                  ? const SizedBox(
                      width: 14,
                      height: 14,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : const Icon(Icons.check, size: 18),
              label: Text('save'.tr),
            ),
          ),
        ],
      ),
      body: ListView(
        padding: const EdgeInsets.fromLTRB(20, 16, 20, 40),
        children: [
          _Section(
            title: 'sync_task_name'.tr,
            child: TextField(
              controller: _nameCtrl,
              decoration: InputDecoration(
                hintText: 'sync_task_name_hint'.tr,
                border: const OutlineInputBorder(),
                isDense: true,
              ),
            ),
          ),
          _Section(
            title: 'sync_local_dir'.tr,
            child: Row(
              children: [
                Expanded(
                  child: TextField(
                    controller: _localCtrl,
                    decoration: const InputDecoration(
                      hintText: r'D:\work\docs',
                      border: OutlineInputBorder(),
                      isDense: true,
                    ),
                  ),
                ),
                const SizedBox(width: 8),
                OutlinedButton.icon(
                  onPressed: _pickLocalDir,
                  icon: const Icon(Icons.folder_open, size: 18),
                  label: Text('edit'.tr),
                ),
              ],
            ),
          ),
          _Section(
            title: 'sync_remote_dir'.tr,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    Expanded(
                      child: TextField(
                        controller: _remoteCtrl,
                        decoration: InputDecoration(
                          hintText: '/volume1/backup/docs',
                          border: const OutlineInputBorder(),
                          isDense: true,
                          // 可编辑下拉：候选是账号可用目录，但输入框仍可自由手填
                          suffixIcon: PopupMenuButton<String>(
                            tooltip: '',
                            icon: const Icon(Icons.arrow_drop_down, size: 20),
                            onSelected: (v) =>
                                setState(() => _remoteCtrl.text = v),
                            itemBuilder: (ctx) {
                              if (_remoteRoots.isEmpty) {
                                return [
                                  PopupMenuItem<String>(
                                    enabled: false,
                                    value: '',
                                    child: Text('sync_remote_roots_empty'.tr),
                                  ),
                                ];
                              }
                              return _remoteRoots
                                  .map(
                                    (p) => PopupMenuItem<String>(
                                      value: p,
                                      child: Text(
                                        p,
                                        maxLines: 1,
                                        overflow: TextOverflow.ellipsis,
                                      ),
                                    ),
                                  )
                                  .toList();
                            },
                          ),
                        ),
                      ),
                    ),
                    const SizedBox(width: 8),
                    OutlinedButton.icon(
                      onPressed: _browseRemoteDir,
                      icon: const Icon(Icons.folder_open, size: 18),
                      label: Text('sync_browse'.tr),
                    ),
                  ],
                ),
                const SizedBox(height: 6),
                Text(
                  'sync_remote_dir_helper'.tr,
                  style: theme.textTheme.bodySmall,
                ),
              ],
            ),
          ),
          _Section(
            title: 'sync_mode'.tr,
            child: Column(
              children: SyncMode.all
                  .map(
                    (m) => RadioListTile<String>(
                      value: m,
                      groupValue: _mode,
                      onChanged: (v) => setState(() => _mode = v ?? _mode),
                      title: Text(SyncMode.labelKey(m).tr),
                      subtitle: Text(
                        SyncMode.descKey(m).tr,
                        style: theme.textTheme.bodySmall,
                      ),
                      dense: true,
                      contentPadding: EdgeInsets.zero,
                    ),
                  )
                  .toList(),
            ),
          ),
          _Section(
            title: 'sync_rules'.tr,
            child: Column(
              children: [
                SwitchListTile(
                  value: _syncCfg.realtime,
                  onChanged: (v) => setState(() => _syncCfg.realtime = v),
                  title: Text('sync_realtime'.tr),
                  subtitle: Text(
                    'sync_realtime_desc'.tr,
                    style: theme.textTheme.bodySmall,
                  ),
                  dense: true,
                  contentPadding: EdgeInsets.zero,
                ),
                const SizedBox(height: 6),
                Row(
                  children: [
                    Expanded(
                      child: Text('sync_interval'.tr),
                    ),
                    SizedBox(
                      width: 90,
                      child: TextField(
                        controller: _intervalCtrl,
                        keyboardType: TextInputType.number,
                        decoration: const InputDecoration(
                          border: OutlineInputBorder(),
                          isDense: true,
                        ),
                      ),
                    ),
                    const SizedBox(width: 8),
                    Text('sync_minutes'.tr),
                  ],
                ),
                const SizedBox(height: 4),
                Align(
                  alignment: Alignment.centerLeft,
                  child: Text(
                    'sync_interval_hint'.tr,
                    style: theme.textTheme.bodySmall,
                  ),
                ),
                const SizedBox(height: 10),
                if (_mode == SyncMode.bidirectional)
                  SwitchListTile(
                    value: _syncCfg.deleteExtra,
                    onChanged: (v) =>
                        setState(() => _syncCfg.deleteExtra = v),
                    title: Text('sync_delete_extra'.tr),
                    subtitle: Text(
                      'sync_delete_extra_hint'.tr,
                      style: theme.textTheme.bodySmall,
                    ),
                    dense: true,
                    contentPadding: EdgeInsets.zero,
                  ),
                const SizedBox(height: 6),
                Row(
                  children: [
                    Expanded(child: Text('sync_conflict_strategy'.tr)),
                    DropdownButton<String>(
                      value: _syncCfg.conflictStrategy,
                      onChanged: (v) => setState(
                        () => _syncCfg.conflictStrategy = v ?? 'prefer_newer',
                      ),
                      items: [
                        DropdownMenuItem(
                          value: 'prefer_newer',
                          child: Text('sync_conflict_prefer_newer'.tr),
                        ),
                        DropdownMenuItem(
                          value: 'prefer_local',
                          child: Text('sync_conflict_prefer_local'.tr),
                        ),
                        DropdownMenuItem(
                          value: 'prefer_remote',
                          child: Text('sync_conflict_prefer_remote'.tr),
                        ),
                      ],
                    ),
                  ],
                ),
              ],
            ),
          ),
          _Section(
            title: 'sync_filter'.tr,
            child: Column(
              children: [
                SwitchListTile(
                  value: _filter.excludeHidden,
                  onChanged: (v) => setState(() => _filter.excludeHidden = v),
                  title: Text('sync_filter_hidden'.tr),
                  subtitle: Text(
                    'sync_filter_hidden_desc'.tr,
                    style: theme.textTheme.bodySmall,
                  ),
                  dense: true,
                  contentPadding: EdgeInsets.zero,
                ),
                SwitchListTile(
                  value: _filter.excludeSmallEnabled,
                  onChanged: (v) =>
                      setState(() => _filter.excludeSmallEnabled = v),
                  title: Text('sync_filter_small'.tr),
                  dense: true,
                  contentPadding: EdgeInsets.zero,
                ),
                if (_filter.excludeSmallEnabled)
                  _SizeRow(
                    controller: _smallSizeCtrl,
                    unit: _filter.excludeSmallUnit,
                    onUnitChanged: (u) =>
                        setState(() => _filter.excludeSmallUnit = u),
                  ),
                SwitchListTile(
                  value: _filter.excludeLargeEnabled,
                  onChanged: (v) =>
                      setState(() => _filter.excludeLargeEnabled = v),
                  title: Text('sync_filter_large'.tr),
                  dense: true,
                  contentPadding: EdgeInsets.zero,
                ),
                if (_filter.excludeLargeEnabled)
                  _SizeRow(
                    controller: _largeSizeCtrl,
                    unit: _filter.excludeLargeUnit,
                    onUnitChanged: (u) =>
                        setState(() => _filter.excludeLargeUnit = u),
                  ),
                SwitchListTile(
                  value: _filter.excludeExtensionEnabled,
                  onChanged: (v) =>
                      setState(() => _filter.excludeExtensionEnabled = v),
                  title: Text('sync_filter_ext'.tr),
                  dense: true,
                  contentPadding: EdgeInsets.zero,
                ),
                if (_filter.excludeExtensionEnabled)
                  TextField(
                    controller: _extCtrl,
                    decoration: InputDecoration(
                      hintText: 'sync_filter_ext_hint'.tr,
                      border: const OutlineInputBorder(),
                      isDense: true,
                    ),
                  ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _Section extends StatelessWidget {
  const _Section({required this.title, required this.child});

  final String title;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.only(bottom: 22),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            title,
            style: theme.textTheme.titleSmall?.copyWith(
              fontWeight: FontWeight.w600,
            ),
          ),
          const SizedBox(height: 10),
          child,
        ],
      ),
    );
  }
}

class _SizeRow extends StatelessWidget {
  const _SizeRow({
    required this.controller,
    required this.unit,
    required this.onUnitChanged,
  });

  final TextEditingController controller;
  final String unit;
  final ValueChanged<String> onUnitChanged;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Row(
        children: [
          SizedBox(
            width: 110,
            child: TextField(
              controller: controller,
              keyboardType: TextInputType.number,
              decoration: const InputDecoration(
                border: OutlineInputBorder(),
                isDense: true,
              ),
            ),
          ),
          const SizedBox(width: 10),
          DropdownButton<String>(
            value: kSizeUnits.contains(unit) ? unit : 'MB',
            onChanged: (v) => onUnitChanged(v ?? 'MB'),
            items: kSizeUnits
                .map((u) => DropdownMenuItem(value: u, child: Text(u)))
                .toList(),
          ),
        ],
      ),
    );
  }
}
