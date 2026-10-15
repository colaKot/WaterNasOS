part of '../sync_create_wizard_view.dart';

/// 步骤三：同步路径（电脑文件路径 + NAS 文件路径）
class _WizardStepPaths extends StatefulWidget {
  final SyncWizardController ctrl;

  const _WizardStepPaths({required this.ctrl});

  @override
  State<_WizardStepPaths> createState() => _WizardStepPathsState();
}

class _WizardStepPathsState extends State<_WizardStepPaths> {
  SyncWizardController get ctrl => widget.ctrl;

  late final TextEditingController _localCtrl;
  late final TextEditingController _remoteCtrl;

  @override
  void initState() {
    super.initState();
    _localCtrl = TextEditingController(text: ctrl.localDir.value);
    _remoteCtrl = TextEditingController(text: ctrl.remoteDir.value);
  }

  @override
  void dispose() {
    _localCtrl.dispose();
    _remoteCtrl.dispose();
    super.dispose();
  }

  Future<void> _pickLocal() async {
    await ctrl.pickLocalDir();
    _localCtrl.text = ctrl.localDir.value;
    if (mounted) setState(() {});
  }

  Future<void> _pickRemote() async {
    // 独立端用自己的逐级下钻目录浏览器（showRemoteDirPicker），
    // 不引主客户端的 folder_picker_dialog。
    await ctrl.pickRemoteDir(
      () => showRemoteDirPicker(
        context,
        initialPath: ctrl.remoteDir.value.trim().isEmpty
            ? null
            : ctrl.remoteDir.value.trim(),
      ),
    );
    _remoteCtrl.text = ctrl.remoteDir.value;
    if (mounted) setState(() {});
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        _pathField(
          context,
          label: 'sync_local_dir'.tr,
          hint: 'sync_pick_local_dir'.tr,
          icon: Icons.laptop_windows_outlined,
          controller: _localCtrl,
          onTap: _pickLocal,
          helper: 'sync_local_dir_hint'.tr,
        ),
        const SizedBox(height: 22),
        _pathField(
          context,
          label: 'sync_remote_dir'.tr,
          hint: 'sync_pick_remote_dir'.tr,
          icon: Icons.dns_outlined,
          controller: _remoteCtrl,
          onTap: _pickRemote,
          helper: 'sync_remote_dir_hint'.tr,
        ),
        const SizedBox(height: 22),
        Obx(
          () => _summaryCard(
            context,
            mode: ctrl.mode.value,
            localDir: ctrl.localDir.value,
            remoteDir: ctrl.remoteDir.value,
          ),
        ),
        const SizedBox(height: 12),
        Row(
          children: [
            Icon(
              Icons.shield_outlined,
              size: 15,
              color: scheme.onSurface.withValues(alpha: 0.55),
            ),
            const SizedBox(width: 6),
            Expanded(
              child: Text(
                'sync_safety_hint'.tr,
                style: theme.textTheme.bodySmall?.copyWith(
                  color: scheme.onSurface.withValues(alpha: 0.55),
                ),
              ),
            ),
          ],
        ),
      ],
    );
  }

  Widget _pathField(
    BuildContext context, {
    required String label,
    required String hint,
    required IconData icon,
    required TextEditingController controller,
    required VoidCallback onTap,
    required String helper,
  }) {
    final theme = Theme.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          label,
          style: theme.textTheme.bodyMedium?.copyWith(
            fontWeight: FontWeight.w600,
          ),
        ),
        const SizedBox(height: 8),
        InkWell(
          borderRadius: BorderRadius.circular(8),
          onTap: onTap,
          child: AbsorbPointer(
            child: TextField(
              controller: controller,
              readOnly: true,
              decoration: InputDecoration(
                hintText: hint,
                prefixIcon: Icon(icon, size: 20),
                suffixIcon: const Icon(Icons.folder_open_outlined, size: 20),
                border: const OutlineInputBorder(),
                isDense: true,
              ),
            ),
          ),
        ),
        const SizedBox(height: 6),
        Text(
          helper,
          style: theme.textTheme.bodySmall?.copyWith(
            color: theme.colorScheme.onSurface.withValues(alpha: 0.5),
          ),
        ),
      ],
    );
  }

  /// 路径对照摘要，直观展示两端映射关系
  Widget _summaryCard(
    BuildContext context, {
    required String mode,
    required String localDir,
    required String remoteDir,
  }) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final arrow = mode == SyncMode.uploadOnly
        ? Icons.arrow_forward
        : mode == SyncMode.downloadOnly
            ? Icons.arrow_back
            : Icons.compare_arrows;

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
            'sync_summary'.tr,
            style: theme.textTheme.bodyMedium?.copyWith(
              fontWeight: FontWeight.w600,
            ),
          ),
          const SizedBox(height: 10),
          Row(
            children: [
              Expanded(
                child: Text(
                  localDir.trim().isEmpty ? '-' : localDir,
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: theme.textTheme.bodySmall,
                ),
              ),
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: 10),
                child: Icon(arrow, size: 20, color: scheme.primary),
              ),
              Expanded(
                child: Text(
                  remoteDir.trim().isEmpty ? '-' : remoteDir,
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  textAlign: TextAlign.right,
                  style: theme.textTheme.bodySmall,
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }
}
