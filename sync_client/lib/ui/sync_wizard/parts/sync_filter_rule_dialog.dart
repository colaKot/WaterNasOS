part of '../sync_create_wizard_view.dart';

/// 过滤规则弹窗
///
/// 规则与服务端 syncUtil.isExcluded 一一对应：
/// 排除小于 / 排除大于 / 排除隐藏文件 / 排除文件类型（tmp、temp 由系统始终过滤）
class _SyncFilterRuleDialog extends StatefulWidget {
  final SyncWizardController ctrl;

  const _SyncFilterRuleDialog({required this.ctrl});

  @override
  State<_SyncFilterRuleDialog> createState() => _SyncFilterRuleDialogState();
}

class _SyncFilterRuleDialogState extends State<_SyncFilterRuleDialog>
    with SingleTickerProviderStateMixin {
  late final TabController _tabController;
  late SyncFilterConfig _draft;

  late final TextEditingController _smallSizeCtrl;
  late final TextEditingController _largeSizeCtrl;
  late final TextEditingController _extInputCtrl;

  @override
  void initState() {
    super.initState();
    _tabController = TabController(length: 2, vsync: this);
    _draft = widget.ctrl.filterConfig.value.clone();
    _smallSizeCtrl = TextEditingController(
      text: _draft.excludeSmallSize.toString(),
    );
    _largeSizeCtrl = TextEditingController(
      text: _draft.excludeLargeSize.toString(),
    );
    _extInputCtrl = TextEditingController();
  }

  @override
  void dispose() {
    _tabController.dispose();
    _smallSizeCtrl.dispose();
    _largeSizeCtrl.dispose();
    _extInputCtrl.dispose();
    super.dispose();
  }

  void _addExtension(String raw) {
    final parts = raw
        .split(RegExp(r'[,，\s]+'))
        .map((e) => e.trim().replaceFirst(RegExp(r'^\.'), '').toLowerCase())
        .where((e) => e.isNotEmpty);
    var changed = false;
    for (final p in parts) {
      if (!_draft.excludeExtensions.contains(p)) {
        _draft.excludeExtensions.add(p);
        changed = true;
      }
    }
    _extInputCtrl.clear();
    if (changed) setState(() {});
  }

  void _save() {
    _draft.excludeSmallSize = int.tryParse(_smallSizeCtrl.text.trim()) ?? 10;
    _draft.excludeLargeSize = int.tryParse(_largeSizeCtrl.text.trim()) ?? 10;
    widget.ctrl.updateFilter(_draft);
    Navigator.of(context).pop();
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final isDesktop = widget.ctrl.isDesktopPlatform;

    final body = Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        TabBar(
          controller: _tabController,
          labelColor: theme.colorScheme.primary,
          unselectedLabelColor:
              theme.colorScheme.onSurface.withValues(alpha: 0.6),
          indicatorColor: theme.colorScheme.primary,
          tabs: [
            Tab(text: 'sync_filter_tab_rules'.tr),
            Tab(text: 'sync_filter_tab_selective'.tr),
          ],
        ),
        const Divider(height: 1),
        SizedBox(
          height: isDesktop ? 400 : 360,
          child: TabBarView(
            controller: _tabController,
            children: [_buildRulesTab(context), _buildSelectiveTab(context)],
          ),
        ),
      ],
    );

    // 独立端只跑桌面系统；非桌面时退回全屏弹窗，避免小屏被固定尺寸撑破。
    if (!isDesktop) {
      return Dialog.fullscreen(
        child: Material(
          child: Column(
            children: [
              AppBar(
                title: Text('sync_filter_rule'.tr),
                leading: IconButton(
                  icon: const Icon(Icons.close),
                  onPressed: () => Navigator.of(context).pop(),
                ),
              ),
              Expanded(child: body),
              _actions(context),
            ],
          ),
        ),
      );
    }

    return Dialog(
      insetPadding: const EdgeInsets.all(24),
      clipBehavior: Clip.antiAlias,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
      child: SizedBox(
        width: 680,
        child: Material(
          color: theme.colorScheme.surface,
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              SizedBox(
                height: 50,
                child: Row(
                  children: [
                    const SizedBox(width: 20),
                    Expanded(
                      child: Text(
                        'sync_filter_rule'.tr,
                        style: theme.textTheme.titleSmall?.copyWith(
                          fontWeight: FontWeight.w600,
                        ),
                      ),
                    ),
                    IconButton(
                      icon: const Icon(Icons.close, size: 20),
                      onPressed: () => Navigator.of(context).pop(),
                    ),
                    const SizedBox(width: 8),
                  ],
                ),
              ),
              body,
              const Divider(height: 1),
              _actions(context),
            ],
          ),
        ),
      ),
    );
  }

  Widget _actions(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 14),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.end,
        children: [
          TextButton(
            onPressed: () => Navigator.of(context).pop(),
            child: Text('cancel'.tr),
          ),
          const SizedBox(width: 8),
          FilledButton(onPressed: _save, child: Text('ok'.tr)),
        ],
      ),
    );
  }

  /// 规则设置
  Widget _buildRulesTab(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    return SingleChildScrollView(
      padding: const EdgeInsets.fromLTRB(20, 18, 20, 20),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          _sizeRow(
            context,
            enabled: _draft.excludeSmallEnabled,
            label: 'sync_filter_exclude_small'.tr,
            sizeCtrl: _smallSizeCtrl,
            unit: _draft.excludeSmallUnit,
            onToggle: (v) => setState(() => _draft.excludeSmallEnabled = v),
            onUnitChanged: (u) => setState(() => _draft.excludeSmallUnit = u),
          ),
          const SizedBox(height: 14),
          _sizeRow(
            context,
            enabled: _draft.excludeLargeEnabled,
            label: 'sync_filter_exclude_large'.tr,
            sizeCtrl: _largeSizeCtrl,
            unit: _draft.excludeLargeUnit,
            onToggle: (v) => setState(() => _draft.excludeLargeEnabled = v),
            onUnitChanged: (u) => setState(() => _draft.excludeLargeUnit = u),
          ),
          const SizedBox(height: 18),
          Row(
            children: [
              Checkbox(
                value: _draft.excludeHidden,
                onChanged: (v) =>
                    setState(() => _draft.excludeHidden = v == true),
                visualDensity: VisualDensity.compact,
              ),
              Expanded(
                child: Text(
                  'sync_filter_exclude_hidden'.tr,
                  style: theme.textTheme.bodyMedium,
                ),
              ),
            ],
          ),
          const SizedBox(height: 8),
          Row(
            children: [
              Checkbox(
                value: _draft.excludeExtensionEnabled,
                onChanged: (v) => setState(
                    () => _draft.excludeExtensionEnabled = v == true),
                visualDensity: VisualDensity.compact,
              ),
              Expanded(
                child: Text(
                  'sync_filter_exclude_ext'.tr,
                  style: theme.textTheme.bodyMedium,
                ),
              ),
            ],
          ),
          const SizedBox(height: 8),
          Container(
            width: double.infinity,
            padding: const EdgeInsets.all(10),
            decoration: BoxDecoration(
              borderRadius: BorderRadius.circular(8),
              border: Border.all(color: scheme.outlineVariant),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Wrap(
                  spacing: 8,
                  runSpacing: 8,
                  crossAxisAlignment: WrapCrossAlignment.center,
                  children: [
                    for (final ext in _draft.excludeExtensions)
                      InputChip(
                        label: Text(ext),
                        visualDensity: VisualDensity.compact,
                        onDeleted: _draft.excludeExtensionEnabled
                            ? () => setState(
                                  () => _draft.excludeExtensions.remove(ext),
                                )
                            : null,
                      ),
                    SizedBox(
                      width: 140,
                      child: TextField(
                        controller: _extInputCtrl,
                        enabled: _draft.excludeExtensionEnabled,
                        decoration: const InputDecoration(
                          isDense: true,
                          border: InputBorder.none,
                          hintText: '',
                        ),
                        onSubmitted: _addExtension,
                        onChanged: (v) {
                          if (v.contains(',') || v.contains('，')) {
                            _addExtension(v);
                          }
                        },
                      ),
                    ),
                  ],
                ),
              ],
            ),
          ),
          const SizedBox(height: 10),
          Text(
            'sync_filter_ext_hint'.tr,
            style: theme.textTheme.bodySmall?.copyWith(
              color: scheme.onSurface.withValues(alpha: 0.55),
            ),
          ),
        ],
      ),
    );
  }

  Widget _sizeRow(
    BuildContext context, {
    required bool enabled,
    required String label,
    required TextEditingController sizeCtrl,
    required String unit,
    required ValueChanged<bool> onToggle,
    required ValueChanged<String> onUnitChanged,
  }) {
    final theme = Theme.of(context);
    return Row(
      children: [
        Checkbox(
          value: enabled,
          onChanged: (v) => onToggle(v == true),
          visualDensity: VisualDensity.compact,
        ),
        Text(label, style: theme.textTheme.bodyMedium),
        const SizedBox(width: 10),
        SizedBox(
          width: 84,
          child: TextField(
            controller: sizeCtrl,
            enabled: enabled,
            keyboardType: TextInputType.number,
            decoration: const InputDecoration(
              isDense: true,
              border: OutlineInputBorder(),
            ),
          ),
        ),
        const SizedBox(width: 8),
        Container(
          width: 88,
          padding: const EdgeInsets.symmetric(horizontal: 8),
          decoration: BoxDecoration(
            border: Border.all(
              color: Theme.of(context).colorScheme.outlineVariant,
            ),
            borderRadius: BorderRadius.circular(4),
          ),
          child: DropdownButton<String>(
            value: unit,
            isExpanded: true,
            isDense: true,
            underline: const SizedBox.shrink(),
            items: [
              for (final u in kSizeUnits)
                DropdownMenuItem(value: u, child: Text(u)),
            ],
            onChanged: enabled
                ? (v) {
                    if (v != null) onUnitChanged(v);
                  }
                : null,
          ),
        ),
        const SizedBox(width: 8),
        Text('sync_filter_file_suffix'.tr, style: theme.textTheme.bodyMedium),
      ],
    );
  }

  /// 选择性同步（按文件夹/文件挑选）
  Widget _buildSelectiveTab(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.all(24),
      child: Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(
              Icons.tune,
              size: 40,
              color: theme.colorScheme.onSurface.withValues(alpha: 0.35),
            ),
            const SizedBox(height: 12),
            Text(
              'sync_filter_selective_title'.tr,
              style: theme.textTheme.titleSmall,
            ),
            const SizedBox(height: 8),
            Text(
              'sync_filter_selective_desc'.tr,
              textAlign: TextAlign.center,
              style: theme.textTheme.bodySmall?.copyWith(
                color: theme.colorScheme.onSurface.withValues(alpha: 0.6),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
