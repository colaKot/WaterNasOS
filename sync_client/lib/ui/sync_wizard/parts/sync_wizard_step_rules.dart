part of '../sync_create_wizard_view.dart';

/// 步骤二：规则设置（任务名称 + 同步模式 + 同步策略）
class _WizardStepRules extends StatefulWidget {
  final SyncWizardController ctrl;

  const _WizardStepRules({required this.ctrl});

  @override
  State<_WizardStepRules> createState() => _WizardStepRulesState();
}

class _WizardStepRulesState extends State<_WizardStepRules> {
  SyncWizardController get ctrl => widget.ctrl;

  late final TextEditingController _nameCtrl;
  late final TextEditingController _intervalCtrl;

  @override
  void initState() {
    super.initState();
    _nameCtrl = TextEditingController(text: ctrl.taskName.value);
    _intervalCtrl = TextEditingController(
      text: ctrl.intervalMinutes.value.toString(),
    );
  }

  @override
  void dispose() {
    _nameCtrl.dispose();
    _intervalCtrl.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        _label(context, 'sync_task_name'.tr),
        const SizedBox(height: 8),
        TextField(
          controller: _nameCtrl,
          maxLength: SyncWizardController.maxTaskNameLength,
          onChanged: (v) {
            ctrl.setTaskName(v);
            setState(() {});
          },
          decoration: InputDecoration(
            hintText: 'sync_task_name_hint'.tr,
            counterText:
                '${ctrl.taskName.value.length} / ${SyncWizardController.maxTaskNameLength}',
            border: const OutlineInputBorder(),
            isDense: true,
          ),
        ),
        const SizedBox(height: 12),
        _label(context, 'sync_mode'.tr),
        const SizedBox(height: 8),
        Obx(
          () => Row(
            children: [
              for (final mode in SyncMode.all) ...[
                Expanded(
                  child: _modeCard(
                    context,
                    mode: mode,
                    selected: ctrl.mode.value == mode,
                    onTap: () => ctrl.setMode(mode),
                  ),
                ),
                if (mode != SyncMode.all.last) const SizedBox(width: 10),
              ],
            ],
          ),
        ),
        const SizedBox(height: 8),
        Obx(
          () => Text(
            '* ${SyncMode.descKey(ctrl.mode.value).tr}',
            style: Theme.of(context).textTheme.bodySmall?.copyWith(
                  color: scheme.onSurface.withValues(alpha: 0.6),
                ),
          ),
        ),
        const SizedBox(height: 20),
        _realtimeRow(context),
        const SizedBox(height: 8),
        _advancedSection(context),
      ],
    );
  }

  Widget _label(BuildContext context, String text) {
    return Text(
      text,
      style: Theme.of(context)
          .textTheme
          .bodyMedium
          ?.copyWith(fontWeight: FontWeight.w600),
    );
  }

  /// 单个同步模式卡片
  Widget _modeCard(
    BuildContext context, {
    required String mode,
    required bool selected,
    required VoidCallback onTap,
  }) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final accent = selected
        ? scheme.primary
        : scheme.onSurface.withValues(alpha: 0.45);

    IconData iconFor(String m) {
      switch (m) {
        case SyncMode.downloadOnly:
          return Icons.download_outlined;
        case SyncMode.uploadOnly:
          return Icons.upload_outlined;
        default:
          return Icons.sync;
      }
    }

    return InkWell(
      borderRadius: BorderRadius.circular(10),
      onTap: onTap,
      child: AnimatedContainer(
        duration: const Duration(milliseconds: 150),
        padding: const EdgeInsets.fromLTRB(14, 12, 14, 14),
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(10),
          border: Border.all(
            color: selected ? scheme.primary : scheme.outlineVariant,
            width: selected ? 2 : 1,
          ),
          color: selected
              ? scheme.primary.withValues(alpha: 0.04)
              : Colors.transparent,
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Expanded(
                  child: Text(
                    SyncMode.labelKey(mode).tr,
                    style: theme.textTheme.titleSmall?.copyWith(
                      fontWeight: FontWeight.w600,
                      color: selected ? scheme.primary : null,
                    ),
                  ),
                ),
                Icon(
                  selected
                      ? Icons.radio_button_checked
                      : Icons.radio_button_unchecked,
                  size: 18,
                  color: selected ? scheme.primary : accent,
                ),
              ],
            ),
            const SizedBox(height: 12),
            SizedBox(
              height: 56,
              child: Row(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  Icon(
                    Icons.laptop_windows_outlined,
                    size: 32,
                    color: scheme.onSurface.withValues(alpha: 0.5),
                  ),
                  const SizedBox(width: 6),
                  Icon(iconFor(mode), size: 20, color: accent),
                  const SizedBox(width: 6),
                  Icon(
                    Icons.storage_outlined,
                    size: 28,
                    color: scheme.onSurface.withValues(alpha: 0.5),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  /// 按需同步开关
  Widget _realtimeRow(BuildContext context) {
    final theme = Theme.of(context);
    return Obx(
      () => Row(
        children: [
          Checkbox(
            value: ctrl.realtime.value,
            onChanged: (v) => ctrl.realtime.value = v == true,
            visualDensity: VisualDensity.compact,
          ),
          Text('sync_realtime'.tr, style: theme.textTheme.bodyMedium),
          const SizedBox(width: 6),
          TextButton(
            onPressed: () => showDialog<void>(
              context: context,
              builder: (_) => AlertDialog(
                title: Text('sync_realtime'.tr),
                content: Text('sync_realtime_desc'.tr),
                actions: [
                  TextButton(
                    onPressed: () => Navigator.of(context).pop(),
                    child: Text('ok'.tr),
                  ),
                ],
              ),
            ),
            style: TextButton.styleFrom(
              padding: const EdgeInsets.symmetric(horizontal: 6),
              minimumSize: Size.zero,
              tapTargetSize: MaterialTapTargetSize.shrinkWrap,
            ),
            child: Text('sync_more_info'.tr),
          ),
        ],
      ),
    );
  }

  /// 高级设置：定时同步、冲突处理、删除传播
  Widget _advancedSection(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(10),
        color: scheme.surfaceContainerHighest.withValues(alpha: 0.35),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            'sync_advanced'.tr,
            style: theme.textTheme.bodyMedium?.copyWith(
              fontWeight: FontWeight.w600,
            ),
          ),
          const SizedBox(height: 10),
          Row(
            children: [
              Expanded(
                child: Text(
                  'sync_interval'.tr,
                  style: theme.textTheme.bodySmall,
                ),
              ),
              SizedBox(
                width: 96,
                child: TextField(
                  controller: _intervalCtrl,
                  keyboardType: TextInputType.number,
                  textAlign: TextAlign.center,
                  decoration: const InputDecoration(
                    isDense: true,
                    border: OutlineInputBorder(),
                  ),
                  onChanged: (v) {
                    final n = int.tryParse(v.trim()) ?? 0;
                    ctrl.intervalMinutes.value = n.clamp(0, 24 * 60);
                  },
                ),
              ),
              const SizedBox(width: 8),
              Text('sync_minutes'.tr, style: theme.textTheme.bodySmall),
            ],
          ),
          const SizedBox(height: 4),
          Text(
            'sync_interval_hint'.tr,
            style: theme.textTheme.bodySmall?.copyWith(
              color: scheme.onSurface.withValues(alpha: 0.5),
            ),
          ),
          const SizedBox(height: 12),
          Obx(
            () => Row(
              children: [
                Expanded(
                  child: Text(
                    'sync_conflict_strategy'.tr,
                    style: theme.textTheme.bodySmall,
                  ),
                ),
                DropdownButton<String>(
                  value: ctrl.conflictStrategy.value,
                  underline: const SizedBox.shrink(),
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
                  onChanged: (v) {
                    if (v != null) ctrl.conflictStrategy.value = v;
                  },
                ),
              ],
            ),
          ),
          const SizedBox(height: 4),
          Obx(
            () => Row(
              children: [
                Checkbox(
                  value: ctrl.deleteExtra.value,
                  onChanged: (v) => ctrl.deleteExtra.value = v == true,
                  visualDensity: VisualDensity.compact,
                ),
                Expanded(
                  child: Text(
                    'sync_delete_extra'.tr,
                    style: theme.textTheme.bodySmall,
                  ),
                ),
              ],
            ),
          ),
          Text(
            'sync_delete_extra_hint'.tr,
            style: theme.textTheme.bodySmall?.copyWith(
              color: scheme.onSurface.withValues(alpha: 0.5),
            ),
          ),
        ],
      ),
    );
  }
}
