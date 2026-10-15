import 'dart:io';

import 'package:file_picker/file_picker.dart';
import 'package:get/get.dart';
import 'package:nascab_sync_core/nascab_sync_core.dart';

import '../core/session.dart';
import 'sync_api_service.dart';
import 'sync_controller.dart';

/// 创建 / 编辑同步任务的三步向导（独立同步客户端版）
///
/// 步骤：1 同步设备 → 2 规则设置 → 3 同步路径。
/// 状态机与主客户端 `flutter_client` 的同名控制器保持一致，
/// 但独立端没有 ApiController / DeviceUtils / DialogUtil / ToastUtil：
/// - 服务器地址改从 [SessionController] 取；
/// - 提示改用 Get.snackbar（无 context 场景也能弹）；
/// - 保存中的加载态交给界面上的按钮 loading 表达，不再弹全局 loading。
class SyncWizardController extends GetxController {
  static const int maxTaskNameLength = 32;

  /// 0 = 同步设备，1 = 规则设置，2 = 同步路径
  final RxInt step = 0.obs;

  final RxString taskName = ''.obs;
  final RxString mode = SyncMode.bidirectional.obs;

  /// 按需同步（本地文件变化时自动触发）：默认关闭
  final RxBool realtime = false.obs;

  /// 定时同步间隔（分钟），0 表示不定时；默认 1 分钟
  final RxInt intervalMinutes = 1.obs;

  final RxString localDir = ''.obs;
  final RxString remoteDir = ''.obs;

  /// 冲突处理：prefer_newer / prefer_local / prefer_remote
  final RxString conflictStrategy = 'prefer_newer'.obs;

  /// 是否把删除动作传播到另一端（仅双向同步）
  final RxBool deleteExtra = false.obs;

  final Rx<SyncFilterConfig> filterConfig = SyncFilterConfig().obs;

  final RxBool saving = false.obs;
  final RxBool probing = false.obs;

  int? editingId;

  /// 当前电脑名称（主机名）：解析完成前退回平台名。
  final RxString deviceNameRx = ''.obs;
  String get deviceName =>
      deviceNameRx.value.isNotEmpty ? deviceNameRx.value : _platformName;

  bool get isEdit => editingId != null;
  bool get canGoNext => step.value < 2;
  bool get canGoPrev => step.value > 0;

  /// 独立端只跑桌面系统，这里用 Platform 判一下，
  /// 避免将来误在移动端构建时走到桌面窗口尺寸。
  bool get isDesktopPlatform =>
      Platform.isWindows || Platform.isMacOS || Platform.isLinux;

  /// 主机名解析失败时的兜底展示名。
  String get _platformName {
    if (Platform.isWindows) return 'Windows 电脑';
    if (Platform.isMacOS) return 'Mac';
    if (Platform.isLinux) return 'Linux 电脑';
    return '本机';
  }

  /// 已登录 NAS 的展示名：优先取主机名（去掉协议与端口），退化到原始地址。
  String get serverLabel {
    final base = SessionController.instance.baseUrl.value.trim();
    if (base.isEmpty) return '-';
    try {
      final uri = Uri.parse(base);
      if (uri.host.isNotEmpty) return uri.host;
    } catch (_) {}
    return base;
  }

  @override
  void onInit() {
    super.onInit();
    _ensureDeviceName();
  }

  /// 解析本机主机名（设备展示名）。失败不影响主流程。
  Future<void> _ensureDeviceName() async {
    try {
      final name = await SyncDeviceId.resolveName();
      if (name.isNotEmpty) deviceNameRx.value = name;
    } catch (_) {}
  }

  void loadFromTask(SyncTask task) {
    editingId = task.id;
    taskName.value = task.name;
    mode.value = task.mode;
    realtime.value = task.syncConfig.realtime;
    intervalMinutes.value = task.syncConfig.intervalMinutes;
    conflictStrategy.value = task.syncConfig.conflictStrategy;
    deleteExtra.value = task.syncConfig.deleteExtra;
    localDir.value = task.localDir;
    remoteDir.value = task.remoteDir;
    filterConfig.value = task.filterConfig.clone();
    step.value = 0;
  }

  void goNext() {
    if (step.value >= 2) return;
    step.value += 1;
  }

  void goPrev() {
    if (step.value <= 0) return;
    step.value -= 1;
  }

  void jumpTo(int index) {
    if (index < 0 || index > 2) return;
    step.value = index;
  }

  void setTaskName(String value) {
    final v = value.length > maxTaskNameLength
        ? value.substring(0, maxTaskNameLength)
        : value;
    taskName.value = v;
  }

  void setMode(String value) {
    if (!SyncMode.all.contains(value)) return;
    mode.value = value;
  }

  /// 选择电脑上的同步目录
  Future<void> pickLocalDir() async {
    try {
      final path = await FilePicker.platform.getDirectoryPath();
      if (path == null || path.trim().isEmpty) return;
      localDir.value = path.trim();
    } catch (e) {
      _toast('sync_pick_local_failed'.tr);
    }
  }

  /// 设置电脑目录（手填）
  void setLocalDir(String path) {
    localDir.value = path.trim();
  }

  /// 选择 NAS 上的同步目录（[openPicker] 返回选中的目录，取消返回 null）
  Future<void> pickRemoteDir(Future<String?> Function() openPicker) async {
    final picked = (await openPicker())?.trim() ?? '';
    if (picked.isEmpty) return;
    remoteDir.value = picked;
    await probeRemoteDir();
  }

  void setRemoteDir(String path) {
    remoteDir.value = path.trim();
  }

  /// 探测 NAS 目录状态
  Future<void> probeRemoteDir() async {
    final path = remoteDir.value.trim();
    if (path.isEmpty) return;
    probing.value = true;
    try {
      final res = await SyncApiService.instance.probe(path: path);
      if (!res.success || res.data == null) return;
      final data = res.data!;
      final allowed = data['allowed'] == true;
      final exists = data['exists'] == true;
      final isDirectory = data['isDirectory'] == true;
      // 无权限时服务端不再返回真实的 exists / isDirectory（避免泄露目录结构），
      // 所以必须优先判 allowed，否则这条提示永远不会触发。
      if (!allowed) {
        _toast('sync_remote_no_permission'.tr);
      } else if (exists && !isDirectory) {
        _toast('sync_remote_not_directory'.tr);
      }
    } catch (_) {
    } finally {
      probing.value = false;
    }
  }

  void updateFilter(SyncFilterConfig value) {
    filterConfig.value = value;
    filterConfig.refresh();
  }

  SyncConfig buildSyncConfig() => SyncConfig(
        realtime: realtime.value,
        intervalMinutes: intervalMinutes.value,
        conflictStrategy: conflictStrategy.value,
        deleteExtra: deleteExtra.value,
      );

  /// 校验当前步骤，返回错误文案 key（null 表示通过）
  String? validateStep(int index) {
    if (index == 1) {
      final name = taskName.value.trim();
      if (name.isEmpty || name.length > maxTaskNameLength) {
        return 'sync_task_name_required';
      }
    }
    if (index == 2) {
      if (localDir.value.trim().isEmpty) return 'sync_local_dir_required';
      if (remoteDir.value.trim().isEmpty) return 'sync_remote_dir_required';
      if (localDir.value.trim() == remoteDir.value.trim()) {
        return 'sync_dir_same';
      }
    }
    return null;
  }

  /// 提交创建 / 更新
  Future<bool> submit() async {
    // 一次性校验前两步，任一不通过就跳回该步并提示（与主客户端一致）
    for (var i = 1; i <= 2; i++) {
      final err = validateStep(i);
      if (err != null) {
        step.value = i;
        _toast(err.tr);
        return false;
      }
    }

    saving.value = true;
    try {
      final res = await SyncApiService.instance.upsert(
        id: editingId,
        name: taskName.value.trim(),
        mode: mode.value,
        localDir: localDir.value.trim(),
        remoteDir: remoteDir.value.trim(),
        filterConfig: filterConfig.value,
        syncConfig: buildSyncConfig(),
        // device_id 由 API 服务按本机机器标识自动带上（SyncDeviceId）
        deviceName: deviceName,
      );
      if (!res.success) {
        _toast(res.message ?? 'operation_failed'.tr);
        return false;
      }
      // 保存成功后让任务列表立刻反映最新配置
      await SyncController.instance.refreshTasks();
      return true;
    } catch (_) {
      _toast('operation_failed'.tr);
      return false;
    } finally {
      saving.value = false;
    }
  }

  /// 无 context 场景的轻提示
  void _toast(String message) {
    Get.snackbar(
      'tip'.tr,
      message,
      snackPosition: SnackPosition.BOTTOM,
      duration: const Duration(seconds: 2),
    );
  }
}
