import 'dart:io';

import 'package:flutter/material.dart';
import 'package:get/get.dart';
import 'package:nascab_sync_core/nascab_sync_core.dart';

import '../../sync/sync_wizard_controller.dart';
import '../remote_dir_picker.dart';

part 'parts/sync_wizard_step_device.dart';
part 'parts/sync_wizard_step_rules.dart';
part 'parts/sync_wizard_step_paths.dart';
part 'parts/sync_filter_rule_dialog.dart';

/// 创建 / 编辑同步任务向导
///
/// 形态与主客户端 `SyncCreateWizardView` 完全一致：
/// 标题栏 + 步骤条 + 内容区 + 底栏，桌面用 860×620 的 Dialog。
/// 步骤：1 同步设备 → 2 规则设置 → 3 同步路径。
class SyncCreateWizardView extends StatefulWidget {
  final SyncTask? editingTask;

  const SyncCreateWizardView({super.key, this.editingTask});

  @override
  State<SyncCreateWizardView> createState() => _SyncCreateWizardViewState();
}

class _SyncCreateWizardViewState extends State<SyncCreateWizardView> {
  final SyncWizardController ctrl = SyncWizardController();

  @override
  void initState() {
    super.initState();
    final t = widget.editingTask;
    if (t != null) ctrl.loadFromTask(t);
  }

  @override
  void dispose() {
    ctrl.dispose();
    super.dispose();
  }

  Future<void> _onPrimaryAction() async {
    final err = ctrl.validateStep(ctrl.step.value);
    if (err != null) {
      _showError(err.tr);
      return;
    }
    if (ctrl.canGoNext) {
      ctrl.goNext();
      return;
    }
    final ok = await ctrl.submit();
    if (!mounted) return;
    if (ok) {
      Navigator.of(context).pop(true);
    }
  }

  void _showError(String message) {
    ScaffoldMessenger.maybeOf(context)?.showSnackBar(
      SnackBar(content: Text(message), duration: const Duration(seconds: 2)),
    );
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);

    final content = Obx(() {
      final step = ctrl.step.value;
      return Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          _buildTitleBar(context),
          const Divider(height: 1),
          _SyncWizardStepsBar(ctrl: ctrl),
          const Divider(height: 1),
          Expanded(
            child: SingleChildScrollView(
              padding: EdgeInsets.symmetric(
                horizontal: ctrl.isDesktopPlatform ? 28 : 16,
                vertical: 20,
              ),
              child: _buildStepContent(step),
            ),
          ),
          const Divider(height: 1),
          _buildBottomBar(context),
        ],
      );
    });

    // 独立端只跑桌面系统；非桌面时退回全屏弹窗，避免小屏被固定尺寸撑破。
    if (!ctrl.isDesktopPlatform) {
      return Dialog.fullscreen(child: Material(child: content));
    }

    return Dialog(
      insetPadding: const EdgeInsets.all(24),
      clipBehavior: Clip.antiAlias,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
      child: SizedBox(
        width: 860,
        height: 620,
        child: Material(color: theme.colorScheme.surface, child: content),
      ),
    );
  }

  Widget _buildStepContent(int step) {
    switch (step) {
      case 0:
        return _WizardStepDevice(ctrl: ctrl);
      case 1:
        return _WizardStepRules(ctrl: ctrl);
      case 2:
      default:
        return _WizardStepPaths(ctrl: ctrl);
    }
  }

  Widget _buildTitleBar(BuildContext context) {
    final theme = Theme.of(context);
    final title =
        ctrl.isEdit ? 'sync_edit_task'.tr : 'sync_create_task'.tr;
    return SizedBox(
      height: 54,
      child: Row(
        children: [
          const SizedBox(width: 20),
          Expanded(
            child: Text(
              title,
              style: theme.textTheme.titleMedium?.copyWith(
                fontWeight: FontWeight.w600,
              ),
            ),
          ),
          IconButton(
            onPressed: ctrl.saving.value
                ? null
                : () => Navigator.of(context).pop(false),
            icon: const Icon(Icons.close, size: 20),
            tooltip: 'cancel'.tr,
          ),
          const SizedBox(width: 8),
        ],
      ),
    );
  }

  Widget _buildBottomBar(BuildContext context) {
    final step = ctrl.step.value;
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 14),
      child: Row(
        children: [
          if (step == 2)
            OutlinedButton(
              onPressed: () => ctrl.goPrev(),
              child: Text('sync_prev_step'.tr),
            ),
          if (step == 2) const SizedBox(width: 8),
          if (step == 2)
            OutlinedButton.icon(
              onPressed: () => _openFilterRule(context),
              icon: const Icon(Icons.filter_alt_outlined, size: 18),
              label: Text('sync_filter_rule'.tr),
            ),
          const Spacer(),
          if (step == 1)
            OutlinedButton(
              onPressed: () => ctrl.goPrev(),
              child: Text('sync_prev_step'.tr),
            ),
          if (step == 1) const SizedBox(width: 12),
          TextButton(
            onPressed: ctrl.saving.value
                ? null
                : () => Navigator.of(context).pop(false),
            child: Text('cancel'.tr),
          ),
          const SizedBox(width: 8),
          Obx(
            () => FilledButton(
              onPressed: ctrl.saving.value ? null : _onPrimaryAction,
              child: ctrl.saving.value
                  ? const SizedBox(
                      width: 16,
                      height: 16,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : Text(
                      step < 2 ? 'sync_next_step'.tr : 'sync_create'.tr,
                    ),
            ),
          ),
        ],
      ),
    );
  }

  Future<void> _openFilterRule(BuildContext context) async {
    await showDialog<void>(
      context: context,
      builder: (_) => _SyncFilterRuleDialog(ctrl: ctrl),
    );
  }
}

/// 顶部步骤条：1 同步设备 > 2 规则设置 > 3 同步路径
class _SyncWizardStepsBar extends StatelessWidget {
  final SyncWizardController ctrl;

  const _SyncWizardStepsBar({required this.ctrl});

  @override
  Widget build(BuildContext context) {
    const counts = 3;
    return Obx(() {
      final current = ctrl.step.value;
      final items = <Widget>[];
      for (var i = 0; i < counts; i++) {
        items.add(
          _stepItem(
            context,
            index: i,
            current: current,
            title: _stepTitle(i),
            onTap: () => ctrl.jumpTo(i),
          ),
        );
        if (i < counts - 1) {
          items.add(
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 8),
              child: Icon(
                Icons.chevron_right,
                size: 18,
                color: Theme.of(context)
                    .colorScheme
                    .onSurface
                    .withValues(alpha: 0.35),
              ),
            ),
          );
        }
      }
      return Padding(
        padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 14),
        child: Row(mainAxisAlignment: MainAxisAlignment.center, children: items),
      );
    });
  }

  String _stepTitle(int index) {
    switch (index) {
      case 0:
        return 'sync_step_device'.tr;
      case 1:
        return 'sync_step_rules'.tr;
      default:
        return 'sync_step_paths'.tr;
    }
  }

  Widget _stepItem(
    BuildContext context, {
    required int index,
    required int current,
    required String title,
    required VoidCallback onTap,
  }) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final active = index == current;
    final done = index < current;
    final color = active || done
        ? scheme.primary
        : scheme.onSurface.withValues(alpha: 0.35);

    return InkWell(
      borderRadius: BorderRadius.circular(20),
      onTap: onTap,
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Container(
              width: 22,
              height: 22,
              alignment: Alignment.center,
              decoration: BoxDecoration(
                shape: BoxShape.circle,
                color: active
                    ? scheme.primary
                    : (done
                        ? scheme.primary.withValues(alpha: 0.15)
                        : Colors.transparent),
                border: Border.all(color: color, width: 1.2),
              ),
              child: done && !active
                  ? Icon(Icons.check, size: 13, color: scheme.primary)
                  : Text(
                      '${index + 1}',
                      style: theme.textTheme.labelSmall?.copyWith(
                        color: active ? scheme.onPrimary : color,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
            ),
            const SizedBox(width: 6),
            Text(
              title,
              style: theme.textTheme.bodyMedium?.copyWith(
                color: color,
                fontWeight: active ? FontWeight.w600 : FontWeight.w400,
              ),
            ),
          ],
        ),
      ),
    );
  }
}
