part of '../sync_main_view.dart';

/// 同步模块左侧菜单
class _SyncLeftMenu extends StatelessWidget {
  final SyncTaskListController ctrl;
  final bool collapsed;
  final VoidCallback onToggleCollapse;
  final VoidCallback onCreate;

  const _SyncLeftMenu({
    required this.ctrl,
    required this.collapsed,
    required this.onToggleCollapse,
    required this.onCreate,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);

    // ⭐ 左栏底色补画到窗口标题栏左侧（框架已把内容层整体下移，见 PcLeftRailTopExtend）
    return PcLeftRailTopExtend(
      color: theme.cardColor,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          SizedBox(
            height: 56,
            child: Row(
              children: [
                const SizedBox(width: 8),
                CustomIconButton(
                  icon: collapsed
                      ? Icons.chevron_right_outlined
                      : Icons.chevron_left_outlined,
                  onPressed: onToggleCollapse,
                  buttonSize: 36,
                  iconSize: 20,
                ),
                if (!collapsed) ...[
                  const SizedBox(width: 4),
                  Expanded(
                    child: Text(
                      'app_sync'.tr,
                      overflow: TextOverflow.ellipsis,
                      style: theme.textTheme.titleMedium?.copyWith(
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                  ),
                ],
              ],
            ),
          ),
          const SizedBox(height: 4),
          Obx(
            () => _menuTile(
              context,
              icon: Icons.sync_outlined,
              title: 'sync_menu_tasks'.tr,
              selected: ctrl.currentPageKey.value == 'sync.tasks',
              onTap: () => ctrl.selectPage('sync.tasks'),
            ),
          ),
          _menuTile(
            context,
            icon: Icons.help_outline,
            title: 'sync_menu_help'.tr,
            selected: ctrl.currentPageKey.value == 'sync.help',
            onTap: () {
              ctrl.selectPage('sync.help');
              _showSyncHelp();
              ctrl.selectPage('sync.tasks');
            },
          ),
          const Spacer(),
          // Web 端不显示「创建同步任务」入口
          if (!DeviceUtils.isWeb)
            if (!collapsed)
              Padding(
                padding: const EdgeInsets.all(12),
                child: SizedBox(
                  width: double.infinity,
                  child: FilledButton.icon(
                    onPressed: onCreate,
                    icon: const Icon(Icons.add, size: 18),
                    label: Text(
                      'sync_create_task'.tr,
                      overflow: TextOverflow.ellipsis,
                    ),
                  ),
                ),
              )
            else
              Padding(
                padding: const EdgeInsets.all(12),
                child: CustomIconButton(
                  icon: Icons.add,
                  tooltip: 'sync_create_task'.tr,
                  onPressed: onCreate,
                  buttonSize: 40,
                  iconSize: 20,
                ),
              ),
          const SizedBox(height: 8),
        ],
      ),
    );
  }

  Widget _menuTile(
    BuildContext context, {
    required IconData icon,
    required String title,
    required bool selected,
    required VoidCallback onTap,
  }) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
      child: Material(
        color: selected
            ? scheme.primary.withValues(alpha: 0.12)
            : Colors.transparent,
        borderRadius: BorderRadius.circular(8),
        child: InkWell(
          borderRadius: BorderRadius.circular(8),
          onTap: onTap,
          child: Container(
            height: 42,
            padding: EdgeInsets.symmetric(horizontal: collapsed ? 0 : 12),
            alignment: collapsed ? Alignment.center : Alignment.centerLeft,
            child: collapsed
                ? Icon(
                    icon,
                    size: 20,
                    color: selected
                        ? scheme.primary
                        : scheme.onSurface.withValues(alpha: 0.7),
                  )
                : Row(
                    children: [
                      Icon(
                        icon,
                        size: 20,
                        color: selected
                            ? scheme.primary
                            : scheme.onSurface.withValues(alpha: 0.7),
                      ),
                      const SizedBox(width: 10),
                      Expanded(
                        child: Text(
                          title,
                          overflow: TextOverflow.ellipsis,
                          style: theme.textTheme.bodyMedium?.copyWith(
                            color: selected ? scheme.primary : null,
                            fontWeight:
                                selected ? FontWeight.w600 : FontWeight.w400,
                          ),
                        ),
                      ),
                    ],
                  ),
          ),
        ),
      ),
    );
  }
}
