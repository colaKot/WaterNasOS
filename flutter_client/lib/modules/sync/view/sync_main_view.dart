import '../../home/views/pc_components/pc_app_window.dart';
import 'package:WaterNasOS/modules/base/components/custom_glass_card.dart';
import 'package:WaterNasOS/modules/base/components/custom_no_data.dart';
import 'package:flutter/material.dart';
import 'package:get/get.dart';
import 'package:nascab_sync_core/nascab_sync_core.dart';

import '../../../utils/dialog_util.dart';
import '../../../utils/device_utils.dart';
import '../../base/components.dart';
import '../controller/sync_task_list_controller.dart';
import 'create/sync_create_wizard_view.dart';

part 'parts/sync_left_menu.dart';
part 'parts/sync_task_list_panel.dart';
part 'parts/sync_task_card.dart';
part 'parts/sync_record_dialog.dart';

/// 目录同步模块入口
///
/// 桌面端：左侧菜单 + 右侧任务列表
/// 移动端：单页任务列表
class SyncMainView extends StatelessWidget {
  const SyncMainView({super.key});

  @override
  Widget build(BuildContext context) {
    // 桌面端该控制器已在应用启动时常驻注册（保证后台自动同步），这里复用同一实例
    final ctrl = Get.isRegistered<SyncTaskListController>()
        ? Get.find<SyncTaskListController>()
        : Get.put(SyncTaskListController());
    return GetBuilder<SyncTaskListController>(
      init: ctrl,
      builder: (ctrl) {
        // Web 端不提供「创建同步任务」入口（无本地目录选择能力）
        final allowCreate = !DeviceUtils.isWeb;
        if (DeviceUtils.isMobile) {
          return Scaffold(
            appBar: AppBar(
              leading: const BackButton(),
              title: Text('app_sync'.tr),
              actions: [
                if (allowCreate)
                  IconButton(
                    onPressed: () => _openCreateWizard(context, ctrl),
                    icon: const Icon(Icons.add_outlined),
                    tooltip: 'sync_create_task'.tr,
                  ),
                IconButton(
                  onPressed: () => ctrl.refreshList(showLoading: true),
                  icon: const Icon(Icons.refresh_outlined),
                ),
              ],
            ),
            body: _SyncTaskListPanel(
              ctrl: ctrl,
              showHeader: false,
              onCreate: allowCreate ? () => _openCreateWizard(context, ctrl) : null,
            ),
          );
        }

        return Obx(() {
          final collapsed = ctrl.sidebarCollapsed.value;
          final leftWidth = collapsed ? 64.0 : ctrl.leftWidth.value;
          return Scaffold(
            body: Row(
              children: [
                AnimatedContainer(
                  duration: const Duration(milliseconds: 180),
                  curve: Curves.easeOutCubic,
                  width: leftWidth,
                  child: _SyncLeftMenu(
                    ctrl: ctrl,
                    collapsed: collapsed,
                    onToggleCollapse: () =>
                        ctrl.sidebarCollapsed.value = !collapsed,
                    onCreate: () => _openCreateWizard(context, ctrl),
                  ),
                ),
                Expanded(
                  child: _SyncTaskListPanel(
                    ctrl: ctrl,
                    onCreate:
                        allowCreate ? () => _openCreateWizard(context, ctrl) : null,
                  ),
                ),
              ],
            ),
          );
        });
      },
    );
  }
}

/// 打开创建 / 编辑同步任务向导
Future<void> _openCreateWizard(
  BuildContext context,
  SyncTaskListController ctrl, {
  SyncTask? editing,
}) async {
  final ok = await showDialog<bool>(
    context: context,
    barrierDismissible: false,
    builder: (_) => SyncCreateWizardView(editingTask: editing),
  );
  if (ok == true) {
    await ctrl.refreshList(
      showLoading: false,
      clearOnFail: false,
      waitIfBusy: true,
    );
  }
}

/// 展示同步运行记录
void _showSyncRecordsDialog(BuildContext context, SyncTaskListController ctrl, SyncTask task) {
  showDialog<void>(
    context: context,
    builder: (_) => _SyncRecordDialog(ctrl: ctrl, task: task),
  );
}

/// 统一的错误提示
void _showSyncError(String message) {
  DialogUtil.showErrorDialog(message: message);
}

/// 「使用说明」弹窗。
///
/// ⚠️ 以前这里借用了 [_showSyncError]，于是弹窗标题显示成「错误」——
/// 文案本身是说明书，标题却是错误，用户已经指出过。现在走信息弹窗，
/// 标题固定为菜单项自己的名字「使用说明」。
void _showSyncHelp() {
  DialogUtil.showInfoDialog(
    title: 'sync_menu_help'.tr,
    content: 'sync_help_tooltip'.tr,
  );
}
