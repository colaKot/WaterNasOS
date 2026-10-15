import 'dart:async';

import 'package:get/get.dart';
import 'package:nascab_sync_core/nascab_sync_core.dart';

import '../core/app_prefs.dart';
import '../core/session.dart';
import 'sync_api_service.dart';

/// 同步任务控制器：列表、执行、增删改，以及调度器绑定。
class SyncController extends GetxController {
  static SyncController get instance => Get.find<SyncController>();

  final RxList<SyncTask> tasks = <SyncTask>[].obs;
  final RxBool loading = false.obs;
  final RxString errorText = ''.obs;

  /// 本账号下「旧版未绑定主机」的同步任务数量（>0 时提示认领到本机）。
  final RxInt legacyPendingCount = 0.obs;

  /// 本机展示名（主机名；用户改名仅本地生效）。
  final RxString deviceNameRx = ''.obs;
  String get deviceLabel =>
      deviceNameRx.value.isNotEmpty ? deviceNameRx.value : '本机';

  /// 全局暂停自动同步（托盘菜单可切换）
  final RxBool autoPaused = false.obs;

  Timer? _refreshTimer;

  @override
  void onInit() {
    super.onInit();
    SyncScheduler.instance.onTrigger = (task) => runTask(task);
    Future<void>(() async {
      try {
        autoPaused.value = await AppPrefs.getAutoSyncPaused();
        if (autoPaused.value) SyncScheduler.instance.pause();
      } catch (_) {}
      try {
        final name = await AppPrefs.getDeviceName();
        if (name.trim().isNotEmpty) deviceNameRx.value = name.trim();
      } catch (_) {}
      // 未登录时不去请求，避免无意义的失败（登录成功后由界面触发刷新）
      if (SessionController.instance.loggedIn.value) {
        await refreshTasks();
      }
    });
    // 定时对齐服务端任务列表（其它端可能改了配置）
    _refreshTimer = Timer.periodic(const Duration(seconds: 30), (_) {
      if (SessionController.instance.loggedIn.value) {
        refreshTasks();
      }
    });
  }

  @override
  void onClose() {
    _refreshTimer?.cancel();
    SyncScheduler.instance.stop();
    super.onClose();
  }

  bool isRunning(int taskId) => SyncEngine.instance.isRunning(taskId);

  SyncProgress? progressOf(int taskId) => SyncEngine.instance.progressOf(taskId);

  /// 拉取任务列表并同步给调度器
  Future<void> refreshTasks({bool showLoading = false}) async {
    if (showLoading) loading.value = true;
    errorText.value = '';
    try {
      // 服务端 sync/list 校验 pageSize ∈ [1,100]（validation.LIMIT_INVALID），
      // 这里按 100 分页拉全，避免任务数超过一页时漏掉。
      const int pageSize = 100;
      final all = <SyncTask>[];
      // 旧版（未绑定主机）任务数：>0 时界面提示「归属到本机」。每页响应都带，取最后一页即可。
      var legacyPending = 0;
      var page = 1;
      while (true) {
        final res = await SyncApiService.instance
            .list(page: page, pageSize: pageSize);
        if (!res.success) {
          errorText.value = res.message ?? 'operation_failed'.tr;
          return;
        }
        final data = res.data ?? const <String, dynamic>{};
        final items = data['items'];
        final batch = (items is List ? items : const [])
            .whereType<Map>()
            .map((e) => SyncTask.fromMap(Map<String, dynamic>.from(e)))
            .toList();
        all.addAll(batch);
        final totalNum = int.tryParse('${data['total']}') ?? all.length;
        final rawPending = data['legacy_pending_count'];
        legacyPending = rawPending is int
            ? rawPending
            : int.tryParse('${rawPending ?? ''}') ?? 0;
        if (batch.length < pageSize || all.length >= totalNum || page >= 100) {
          break;
        }
        page++;
      }
      tasks.assignAll(all);
      SyncScheduler.instance.syncTasks(all);
      legacyPendingCount.value = legacyPending;
    } catch (e) {
      errorText.value = 'operation_failed'.tr;
    } finally {
      loading.value = false;
    }
  }

  /// 执行单个任务，返回结果供界面提示
  Future<SyncRunResult?> runTask(SyncTask task) async {
    if (SyncEngine.instance.isRunning(task.id)) {
      return null;
    }
    SyncScheduler.instance.markRan(task.id);
    try {
      await SyncApiService.instance
          .updateStatus(id: task.id, status: SyncStatus.running);
    } catch (_) {}

    final result = await SyncEngine.instance.run(task);

    try {
      await SyncApiService.instance.updateStatus(
        id: task.id,
        status: result.ok ? SyncStatus.idle : SyncStatus.error,
        lastError: result.ok ? '' : (result.error ?? ''),
      );
    } catch (_) {}

    unawaited(refreshTasks());
    return result;
  }

  /// 依次执行全部任务（不并发，避免把带宽打满）
  Future<void> runAllTasks() async {
    for (final task in tasks.toList()) {
      await runTask(task);
    }
  }

  void cancelTask(int taskId) {
    SyncEngine.instance.cancel(taskId);
  }

  /// 切换全局自动同步暂停
  Future<void> setAutoPaused(bool value) async {
    autoPaused.value = value;
    if (value) {
      SyncScheduler.instance.pause();
    } else {
      SyncScheduler.instance.resume();
    }
    await AppPrefs.setAutoSyncPaused(value);
  }

  Future<String?> createOrUpdate({
    int? id,
    required String name,
    required String mode,
    required String localDir,
    required String remoteDir,
    required SyncFilterConfig filterConfig,
    required SyncConfig syncConfig,
  }) async {
    // device_id 由 API 服务按本机机器标识自动带上（SyncDeviceId）——
    // 同一台机器上的独立同步客户端与主客户端因此归属同一设备、任务互通。
    // device_name 统一上报主机名，避免两个客户端互相改来改去。
    final deviceName = await SyncDeviceId.resolveName();

    final res = await SyncApiService.instance.upsert(
      id: id,
      name: name,
      mode: mode,
      localDir: localDir,
      remoteDir: remoteDir,
      filterConfig: filterConfig,
      syncConfig: syncConfig,
      deviceName: deviceName,
    );

    if (!res.success) return res.message ?? 'operation_failed'.tr;
    await refreshTasks();
    return null;
  }

  /// 认领旧版任务：把本账号下「未绑定主机」的任务全部划到本机名下。
  ///
  /// 升级到设备隔离版本后，以前「同账号共享」的旧任务没有机器归属，
  /// 在**应该拥有它们的那台机器**上点一次「归属到本机」即可收编；
  /// 已被其它机器认领走的不会被抢走。
  Future<bool> claimLegacyTasks() async {
    final res = await SyncApiService.instance.claimLegacy();
    if (!res.success) {
      errorText.value = res.message ?? 'operation_failed'.tr;
      return false;
    }
    await refreshTasks();
    return true;
  }

  Future<String?> removeTask(int id) async {
    final res = await SyncApiService.instance.delete(id: id);
    if (!res.success) return res.message ?? 'operation_failed'.tr;
    SyncEngine.instance.clearProgress(id);
    await refreshTasks();
    return null;
  }

  /// 取单个任务的最新详情
  Future<SyncTask?> getTask(int id) async {
    final res = await SyncApiService.instance.get(id: id);
    if (!res.success || res.data == null) return null;
    final raw = res.data!['item'] ?? res.data!['task'] ?? res.data!;
    if (raw is Map) {
      return SyncTask.fromMap(Map<String, dynamic>.from(raw));
    }
    return null;
  }

  /// 取同步记录
  Future<List<SyncRecord>> loadRecords(int taskId) async {
    final res = await SyncApiService.instance.listRecords(taskId: taskId);
    if (!res.success) return const [];
    final items = (res.data ?? const <String, dynamic>{})['items'];
    return (items is List ? items : const [])
        .whereType<Map>()
        .map((e) => SyncRecord.fromMap(Map<String, dynamic>.from(e)))
        .toList();
  }
}
