part of '../sync_main_view.dart';

/// 同步任务列表面板
class _SyncTaskListPanel extends StatefulWidget {
  final SyncTaskListController ctrl;
  final bool showHeader;
  final VoidCallback? onCreate;

  const _SyncTaskListPanel({
    required this.ctrl,
    this.showHeader = true,
    this.onCreate,
  });

  @override
  State<_SyncTaskListPanel> createState() => _SyncTaskListPanelState();
}

class _SyncTaskListPanelState extends State<_SyncTaskListPanel> {
  late final TextEditingController _searchCtrl;

  @override
  void initState() {
    super.initState();
    _searchCtrl = TextEditingController(text: widget.ctrl.keyword.value);
  }

  @override
  void dispose() {
    _searchCtrl.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final compact = DeviceUtils.isPhone(context);

    return Container(
      color: theme.scaffoldBackgroundColor,
      child: Column(
        children: [
          if (widget.showHeader) _buildHeader(context),
          _buildLegacyClaimBanner(context),
          Expanded(
            child: Obx(() {
              final ctrl = widget.ctrl;
              if (ctrl.isLoading.value && ctrl.tasks.isEmpty) {
                return const Center(child: CircularProgressIndicator());
              }
              if (ctrl.errorText.value.isNotEmpty && ctrl.tasks.isEmpty) {
                return CustomNoData(
                  text: ctrl.errorText.value,
                  imageWidth: 100,
                  imageHeight: 100,
                );
              }
              if (ctrl.tasks.isEmpty) {
                return Center(
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      CustomNoData(
                        text: 'sync_no_tasks'.tr,
                        imageWidth: 120,
                        imageHeight: 120,
                      ),
                      // Web 端不提供「创建同步任务」入口（无本地目录选择能力）
                      if (widget.onCreate != null) ...[
                        const SizedBox(height: 8),
                        FilledButton.icon(
                          onPressed: widget.onCreate,
                          icon: const Icon(Icons.add, size: 18),
                          label: Text('sync_create_task'.tr),
                        ),
                      ],
                    ],
                  ),
                );
              }
              return RefreshIndicator(
                onRefresh: () => ctrl.refreshList(showLoading: false),
                child: ListView.builder(
                  padding: EdgeInsets.symmetric(
                    horizontal: compact ? 8 : 16,
                    vertical: 12,
                  ),
                  itemCount: ctrl.tasks.length,
                  itemBuilder: (context, index) {
                    final task = ctrl.tasks[index];
                    return _SyncTaskCard(
                      ctrl: ctrl,
                      task: task,
                      onEdit: () => _openCreateWizard(
                        context,
                        ctrl,
                        editing: task,
                      ),
                      onShowRecords: () =>
                          _showSyncRecordsDialog(context, ctrl, task),
                    );
                  },
                ),
              );
            }),
          ),
        ],
      ),
    );
  }

  /// 旧版任务认领横幅：账号下存在「未绑定主机」的旧同步任务时提示用户。
  ///
  /// 只提示不自动认领——任务该归哪台机器只有用户知道，自动抢会造成基线错位。
  Widget _buildLegacyClaimBanner(BuildContext context) {
    final ctrl = widget.ctrl;
    return Obx(() {
      final pending = ctrl.legacyPendingCount.value;
      if (pending <= 0) return const SizedBox.shrink();
      final theme = Theme.of(context);
      final scheme = theme.colorScheme;
      return Container(
        margin: const EdgeInsets.fromLTRB(16, 8, 16, 4),
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
        decoration: BoxDecoration(
          color: scheme.tertiaryContainer.withValues(alpha: 0.35),
          borderRadius: BorderRadius.circular(10),
          border: Border.all(color: scheme.tertiary.withValues(alpha: 0.35)),
        ),
        child: Row(
          children: [
            Icon(Icons.devices_outlined, size: 20, color: scheme.tertiary),
            const SizedBox(width: 10),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    'sync_legacy_banner'.trParams({
                      'count': pending.toString(),
                      'device': ctrl.deviceName,
                    }),
                    style: theme.textTheme.bodySmall,
                  ),
                  const SizedBox(height: 2),
                  Text(
                    'sync_legacy_banner_desc'.tr,
                    style: theme.textTheme.labelSmall?.copyWith(
                      color: scheme.onSurface.withValues(alpha: 0.6),
                    ),
                  ),
                ],
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

  Widget _buildHeader(BuildContext context) {
    final theme = Theme.of(context);
    return CustomGlassCard(
      margin: const EdgeInsets.fromLTRB(16, 16, 16, 4),
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
      child: Row(
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  'sync_menu_tasks'.tr,
                  maxLines: 1,
                  softWrap: false,
                  overflow: TextOverflow.ellipsis,
                  style: theme.textTheme.titleMedium?.copyWith(
                    fontWeight: FontWeight.w600,
                  ),
                ),
                const SizedBox(height: 2),
                Obx(
                  () => Text(
                    'sync_task_count'.trParams({
                      'count': widget.ctrl.tasks.length.toString(),
                    }),
                    maxLines: 1,
                    softWrap: false,
                    overflow: TextOverflow.ellipsis,
                    style: theme.textTheme.bodySmall?.copyWith(
                      color: theme.colorScheme.onSurface.withValues(alpha: 0.6),
                    ),
                  ),
                ),
              ],
            ),
          ),
          // 搜索栏：原先右侧还挤着「创建同步任务」按钮，现已移除，故加宽并右移
          SizedBox(
            width: 260,
            child: CustomTextField(
              controller: _searchCtrl,
              hintText: 'search'.tr,
              prefixIcon: const Icon(Icons.search, size: 18),
              onChanged: (v) => widget.ctrl.setKeyword(v),
            ),
          ),
          const SizedBox(width: 8),
          CustomIconButton(
            icon: Icons.refresh_outlined,
            tooltip: 'refresh'.tr,
            onPressed: () => widget.ctrl.refreshList(showLoading: true),
          ),
          // 让位窗口按钮组（避免标题被窗口控件压住）
          SizedBox(
            width: PcWindowScope.of(context)?.titleBarControlsWidth ?? 0,
          ),
        ],
      ),
    );
  }
}
