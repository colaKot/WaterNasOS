import 'dart:async';

import 'package:get/get.dart';
import 'package:nascab_sync_core/nascab_sync_core.dart';

import '../../../core/api/api_controller.dart';
import '../../../core/web/local_kv_store_stub.dart'
    if (dart.library.html) '../../../core/web/local_kv_store_web.dart';
import '../../../desktop/desktop_tray.dart';
import '../../../utils/dialog_util.dart';
import '../../../utils/device_utils.dart';
import '../../../utils/toast_util.dart';
import '../service/sync_api_service.dart';

class SyncTaskListController extends GetxController {
  final _api = SyncApiService();

  /// 全局暂停自动同步的持久化键（桌面端托盘菜单可切换）。
  static const String _autoPausedKey = 'sync_auto_paused';

  final RxString currentPageKey = 'sync.tasks'.obs;
  final RxDouble leftWidth = 180.0.obs;
  final RxBool sidebarCollapsed = false.obs;

  final RxList<SyncTask> tasks = <SyncTask>[].obs;
  final RxBool isLoading = false.obs;
  final RxString errorText = ''.obs;
  final RxString keyword = ''.obs;

  /// 本账号下「旧版未绑定主机」的同步任务数量（>0 时列表页提示认领到本机）。
  final RxInt legacyPendingCount = 0.obs;

  /// 当前电脑名称（主机名），用于「同步设备」展示与上报 device_name。
  final RxString deviceNameRx = ''.obs;

  final opLoadingById = <int, bool>{}.obs;

  /// 全局自动同步是否被用户暂停（托盘菜单切换，重启后仍生效）。
  final RxBool autoPaused = false.obs;

  Timer? _pollTimer;
  Completer<void>? _refreshCompleter;

  SyncEngine get engine => SyncEngine.instance;

  /// 当前电脑名称：优先主机名（解析完成前退回平台名）。
  String get deviceName =>
      deviceNameRx.value.isNotEmpty ? deviceNameRx.value : DeviceUtils.platformName;

  /// 已登录的 NAS 地址
  String get serverLabel {
    final base = ApiController.instance.baseUrl.trim();
    if (base.isEmpty) return '-';
    try {
      final uri = Uri.parse(base);
      if (uri.host.isNotEmpty) return uri.host;
    } catch (_) {}
    return base;
  }

  String get serverId => ApiController.instance.state.serverId;

  @override
  void onInit() {
    super.onInit();
    _ensureDeviceName();
    // 自动同步（按需监听 + 定时）触发后静默执行，不弹任何提示
    SyncScheduler.instance.onTrigger = _autoSync;
    SyncScheduler.instance.start();
    // 桌面端：把「立即同步 / 暂停自动同步」接到系统托盘，
    // 让主客户端具备独立同步客户端那样的后台常驻能力。
    _bindTrayCallbacks();
    _restoreAutoPaused();
    refreshList(showLoading: false, clearOnFail: true, waitIfBusy: false);
    _startPolling();
  }

  /// 解析本机主机名（设备展示名）。失败不影响主流程。
  Future<void> _ensureDeviceName() async {
    try {
      final name = await SyncDeviceId.resolveName();
      if (name.isNotEmpty) deviceNameRx.value = name;
    } catch (_) {}
  }

  @override
  void onClose() {
    _stopPolling();
    DesktopTray.onSyncNow = null;
    DesktopTray.isAutoSyncPaused = null;
    DesktopTray.onToggleAutoSyncPaused = null;
    SyncScheduler.instance.onTrigger = null;
    SyncScheduler.instance.stop();
    super.onClose();
  }

  void _bindTrayCallbacks() {
    if (DeviceUtils.isWeb || !DeviceUtils.isDesktop) return;
    DesktopTray.onSyncNow = () {
      Future<void>(() => syncAllNow());
    };
    DesktopTray.isAutoSyncPaused = () => autoPaused.value;
    DesktopTray.onToggleAutoSyncPaused = () {
      Future<void>(() => setAutoPaused(!autoPaused.value));
    };
    // 菜单项里有动态文案（暂停/恢复），回调注册后刷新一次。
    Future<void>(() => DesktopTray.updateMenu());
  }

  /// 读回「自动同步是否被暂停」，重启后仍按用户上次的选择执行。
  Future<void> _restoreAutoPaused() async {
    try {
      final raw = await kvGet(_autoPausedKey);
      if (raw == '1') {
        autoPaused.value = true;
        SyncScheduler.instance.pause();
      }
    } catch (_) {}
  }

  /// 切换全局自动同步暂停（托盘菜单入口）。
  Future<void> setAutoPaused(bool value) async {
    autoPaused.value = value;
    if (value) {
      SyncScheduler.instance.pause();
      ToastUtil.show('sync_auto_pause'.tr);
    } else {
      SyncScheduler.instance.resume();
      ToastUtil.show('sync_auto_resume'.tr);
      await refreshList(showLoading: false, clearOnFail: false, waitIfBusy: false);
    }
    try {
      await kvSet(_autoPausedKey, value ? '1' : '0');
    } catch (_) {}
    Future<void>(() => DesktopTray.updateMenu());
  }

  /// 托盘「立即同步」：把全部任务依次跑一遍（静默，不弹进度）。
  Future<void> syncAllNow() async {
    for (final task in tasks.toList()) {
      if (engine.isRunning(task.id)) continue;
      await _autoSync(task);
    }
  }

  /// 由调度器触发的自动同步
  Future<void> _autoSync(SyncTask task) async {
    if (engine.isRunning(task.id)) return;
    await engine.run(task);
    await refreshList(
      showLoading: false,
      clearOnFail: false,
      waitIfBusy: false,
    );
  }

  void selectPage(String key) {
    currentPageKey.value = key;
  }

  void _startPolling() {
    _pollTimer?.cancel();
    _pollTimer = Timer.periodic(const Duration(seconds: 3), (_) {
      refreshList(showLoading: false, clearOnFail: false, waitIfBusy: false);
    });
  }

  void _stopPolling() {
    _pollTimer?.cancel();
    _pollTimer = null;
  }

  Future<void> refreshList({
    bool showLoading = true,
    bool clearOnFail = true,
    bool waitIfBusy = true,
  }) async {
    final inflight = _refreshCompleter;
    if (inflight != null && !inflight.isCompleted) {
      if (!waitIfBusy) return;
      await inflight.future;
    }
    _refreshCompleter = Completer<void>();
    isLoading.value = true;
    errorText.value = '';
    try {
      if (showLoading) DialogUtil.showLoading(message: 'loading'.tr);
      final res = await _api.list(
        page: 1,
        keyword: keyword.value.trim().isEmpty ? null : keyword.value.trim(),
      );
      if (!res.success) {
        errorText.value = res.message ?? 'operation_failed'.tr;
        if (clearOnFail) tasks.assignAll(const []);
        return;
      }
      final items = (res.data ?? const <String, dynamic>{})['items'];
      final list = (items is List ? items : const [])
          .whereType<Map>()
          .map((e) => SyncTask.fromMap(Map<String, dynamic>.from(e)))
          .toList();
      tasks.assignAll(list);
      SyncScheduler.instance.syncTasks(list);
      // 旧版（未绑定主机）任务数：>0 时列表页提示「归属到本机」。
      // 只有本机任务为空或用户主动查看时才需要打扰，故仅刷新计数，不弹窗。
      final pending = (res.data ?? const <String, dynamic>{})['legacy_pending_count'];
      legacyPendingCount.value = pending is int
          ? pending
          : int.tryParse('${pending ?? ''}') ?? 0;
    } catch (_) {
      errorText.value = 'operation_failed'.tr;
      if (clearOnFail) tasks.assignAll(const []);
    } finally {
      if (showLoading) DialogUtil.dismissLoading(force: true);
      isLoading.value = false;
      if (_refreshCompleter != null && !_refreshCompleter!.isCompleted) {
        _refreshCompleter!.complete();
      }
    }
  }

  Future<bool> upsert({
    int? id,
    required String name,
    required String mode,
    required String localDir,
    required String remoteDir,
    required SyncFilterConfig filterConfig,
    required SyncConfig syncConfig,
  }) async {
    final taskName = name.trim();
    if (taskName.isEmpty ||
        taskName.length > 32 ||
        localDir.trim().isEmpty ||
        remoteDir.trim().isEmpty) {
      ToastUtil.show('sync_required'.tr);
      return false;
    }
    if (!SyncMode.all.contains(mode)) {
      ToastUtil.show('operation_failed'.tr);
      return false;
    }

    final res = await _api.upsert(
      id: id,
      name: taskName,
      mode: mode,
      localDir: localDir.trim(),
      remoteDir: remoteDir.trim(),
      filterConfig: filterConfig,
      syncConfig: syncConfig,
      // device_id 由 API 服务按本机机器标识自动带上（SyncDeviceId），
      // 同一台机器上的主客户端与独立同步客户端因此归属同一设备。
      deviceName: deviceName,
    );
    if (!res.success) {
      ToastUtil.show(res.message ?? 'operation_failed'.tr);
      return false;
    }
    await refreshList(showLoading: false, clearOnFail: true, waitIfBusy: true);
    ToastUtil.show('operation_success'.tr);
    return true;
  }

  Future<bool> remove({required int id}) async {
    final confirmed = await DialogUtil.showConfirmDialog(
      title: 'need_confirm'.tr,
      content: 'sync_delete_confirm'.tr,
      confirmText: 'ok'.tr,
      cancelText: 'cancel'.tr,
    );
    if (confirmed != true) return false;

    final res = await _api.delete(id: id);
    if (!res.success) {
      ToastUtil.show(res.message ?? 'delete_failed'.tr);
      return false;
    }
    await SyncLocalStore.instance.clearBaseline(id);
    SyncEngine.instance.clearProgress(id);
    await refreshList(showLoading: false, clearOnFail: true, waitIfBusy: true);
    ToastUtil.show('delete_success'.tr);
    return true;
  }

  /// 认领旧版任务：把本账号下「未绑定主机」的任务全部划到本机名下。
  ///
  /// 升级到设备隔离版本后，以前「同账号共享」的旧任务没有机器归属，
  /// 在**应该拥有它们的那台机器**上点一次「归属到本机」即可收编；
  /// 已被其它机器认领走的不会被抢走。
  Future<bool> claimLegacyTasks() async {
    final confirmed = await DialogUtil.showConfirmDialog(
      title: 'need_confirm'.tr,
      content: 'sync_legacy_claim_confirm'.trParams({
        'count': legacyPendingCount.value.toString(),
        'device': deviceName,
      }),
      confirmText: 'ok'.tr,
      cancelText: 'cancel'.tr,
    );
    if (confirmed != true) return false;

    final res = await _api.claimLegacy();
    if (!res.success) {
      ToastUtil.show(res.message ?? 'operation_failed'.tr);
      return false;
    }
    final claimed = res.data?['claimed'];
    await refreshList(showLoading: false, clearOnFail: false, waitIfBusy: true);
    ToastUtil.show('sync_legacy_claimed'.trParams({
      'count': '${claimed ?? 0}',
    }));
    return true;
  }

  /// 手动触发一次同步
  Future<void> startSync(SyncTask task) async {
    if (engine.isRunning(task.id)) {
      ToastUtil.show('sync_already_running'.tr);
      return;
    }
    opLoadingById[task.id] = true;
    opLoadingById.refresh();
    SyncScheduler.instance.markRan(task.id);
    try {
      final result = await engine.run(task);
      if (isClosed) return;
      if (result.ok) {
        if (result.uploadCount == 0 &&
            result.downloadCount == 0 &&
            result.deleteCount == 0) {
          ToastUtil.show('sync_up_to_date'.tr);
        } else {
          ToastUtil.show('sync_completed'.tr);
        }
      } else {
        ToastUtil.show(result.error ?? 'operation_failed'.tr);
      }
    } finally {
      opLoadingById[task.id] = false;
      opLoadingById.refresh();
      await refreshList(
        showLoading: false,
        clearOnFail: false,
        waitIfBusy: true,
      );
    }
  }

  /// 停止正在运行的同步
  Future<void> stopSync(int taskId) async {
    engine.cancel(taskId);
    ToastUtil.show('sync_stopping'.tr);
  }

  Future<Map<String, dynamic>?> fetchRecords({
    required int taskId,
    int page = 1,
    int pageSize = 50,
  }) async {
    final res = await _api.listRecords(
      taskId: taskId,
      page: page,
      pageSize: pageSize,
    );
    if (!res.success) return null;
    return res.data;
  }

  Future<void> setKeyword(String value) async {
    keyword.value = value;
    await refreshList(showLoading: false, clearOnFail: false, waitIfBusy: true);
  }
}
