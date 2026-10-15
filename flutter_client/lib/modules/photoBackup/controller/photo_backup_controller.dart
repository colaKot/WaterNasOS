import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:crypto/crypto.dart';
import 'package:cross_file/cross_file.dart';
import 'package:connectivity_plus/connectivity_plus.dart';
import 'package:dio/dio.dart' as dio;
import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:get/get.dart';
import 'package:path/path.dart' as p;
import 'package:permission_handler/permission_handler.dart';
import 'package:photo_manager/photo_manager.dart' as pm;
import 'package:wakelock_plus/wakelock_plus.dart';

import '../../../core/api/api_controller.dart';
import '../../../core/api/dio_bad_certificate_compat.dart';
import '../../../core/notification/transfer_work_notification_hub.dart';
import '../../../core/user/current_user_controller.dart';
import '../../../utils/device_utils.dart';
import '../../../utils/dialog_util.dart';
import '../../../utils/toast_util.dart';
import '../../../utils/user_agent_util.dart';
import '../../photo/source_setting/service/photo_source_api_service.dart';
import '../../transfer/controllers/upload_parts/upload_core.dart';
import '../../transfer/controllers/upload_parts/upload_transfer_helper.dart';
import '../../transfer/utils/upload_temp_file_cleaner.dart';
import '../models/photo_backup_models.dart';
import '../storage/photo_backup_storage.dart';

void _photoBackupLog(String label, [Object? value]) {
  // ignore: avoid_print
  print('[PhotoBackup] $label${value != null ? ': $value' : ''}');
}

/// 备份阶段：off=未开启 / idle=已开启待备份 / running=备份中 / done=已完成 / error=出错
class PhotoBackupRuntime {
  final RxBool running = false.obs;
  final RxString status = 'idle'.obs;
  final RxString currentFile = ''.obs;
  final RxInt totalFiles = 0.obs;
  final RxInt doneFiles = 0.obs;
  final RxInt totalBytes = 0.obs;
  final RxInt doneBytes = 0.obs;
  final RxString error = ''.obs;

  /// 本次实际上传成功的文件数
  final RxInt uploadedFiles = 0.obs;

  /// 本次因「内容重复」跳过的文件数（不重复上传的关键指标）
  final RxInt skippedFiles = 0.obs;

  /// 累计已备份到 NAS 的文件数（历史全部成功记录）
  final RxInt totalBackedUp = 0.obs;

  /// 有总大小时按字节，否则按文件数；都未知时返回 null（显示为 indeterminate）。
  double? get progress {
    final totalB = totalBytes.value;
    if (totalB > 0) {
      final done = doneBytes.value;
      if (done <= 0) return 0;
      if (done >= totalB) return 1;
      return done / totalB;
    }
    final totalF = totalFiles.value;
    if (totalF > 0) {
      final done = doneFiles.value;
      if (done <= 0) return 0;
      if (done >= totalF) return 1;
      return done / totalF;
    }
    return null;
  }
}

class PhotoBackupController extends GetxController {
  final _storage = PhotoBackupStorage.instance;

  /// 兼容外部调用（登出确认、任务中心等）：整机只有一个备份任务。
  final RxList<PhotoBackupTask> tasks = <PhotoBackupTask>[].obs;

  final RxBool loading = true.obs;

  /// 默认备份位置（相册源根目录 + 设备名），未在任务里自定义时生效。
  final RxString defaultTargetDir = ''.obs;

  /// 本机设备名（默认目录用）。
  final RxString deviceName = ''.obs;

  /// 是否已配置相册源（没配置就没有默认备份位置）。
  final RxBool hasPhotoSource = true.obs;

  final PhotoBackupRuntime runtime = PhotoBackupRuntime();

  /// 唯一的备份任务；null 表示尚未登录/未初始化。
  final Rx<PhotoBackupTask?> _task = Rx<PhotoBackupTask?>(null);

  /// 进程内 MD5 记忆缓存（key = uniqueId|size|mtime），避免同一次运行内重复计算。
  final Map<String, String> _md5MemoryCache = {};

  /// 本次运行内已处理（或被跳过）的素材 id，用于跨相册去重。
  final Set<String> _runHandledIds = {};

  /// 本次运行内已处理的内容 MD5，用于「同一张图出现多次」的兜底去重。
  final Set<String> _runHandledMd5 = {};

  int _wakelockRefCount = 0;
  String _lastIdentityKey = '';
  String _lastAutoTriggerIdentityKey = '';
  bool _wakeLockEnabled = false;
  late final dio.Dio _dio;

  /// 网络变化监听：备份进行中离开 Wi-Fi 时自动暂停，回到 Wi-Fi 时自动续跑。
  /// 只在「没开流量备份 + 手机端」生效；桌面端 isMobile=false 永远不拦。
  StreamSubscription<List<ConnectivityResult>>? _connSub;

  /// 因「未开流量备份且不在 Wi-Fi」挂起：等连回 Wi-Fi 自动开始/继续。
  bool _autoResumePending = false;

  /// 取消原因 key（区分「用户手动取消」与「网络切换暂停」）。
  String? _cancelReason;

  /// 备份并发数（用户要求默认 5）：物化 / MD5 / 上传三处池共用。
  static const int _backupConcurrency = 5;

  /// 扫描期并发数：每张图的 size 要单独发一次 MediaStore 查询（插件不把 SIZE 列随列表带回），
  /// 并发发出去能把「查询 + 通道往返」的等待叠起来。
  static const int _scanConcurrency = 8;

  /// 本轮各 size 出现次数（run 级）：同 size 出现多次的素材必须算 MD5，
  /// 否则批内/跨批的重复内容会漏过「本次运行 md5 去重」。
  final Map<int, int> _runSizeCount = {};

  PhotoBackupTask? get task => _task.value;

  /// 实际生效的备份目标目录。
  String get effectiveTargetDir {
    final t = _task.value;
    if (t == null) return '';
    final custom = t.targetDir.trim();
    if (custom.isNotEmpty) return custom;
    if (defaultTargetDir.value.trim().isEmpty) return '';
    return _joinPath(defaultTargetDir.value, deviceName.value);
  }

  bool get isRunning => runtime.running.value;

  /// 当前是否应禁止走流量：没开「使用流量备份」且在手机上。
  /// 桌面端 isMobile=false，永不拦截；任务未加载时也不拦（由调用方前置判空）。
  bool get _cellularBlocked {
    final t = _task.value;
    return t != null && !t.useCellular && DeviceUtils.isMobile;
  }

  /// 状态卡文案 key 所需的阶段。
  String get phase {
    final t = _task.value;
    if (t == null || !t.enabled) return 'off';
    if (runtime.running.value) return 'running';
    if (runtime.error.value.trim().isNotEmpty) return 'error';
    if (runtime.doneFiles.value > 0 || runtime.totalBackedUp.value > 0) {
      return 'done';
    }
    return 'idle';
  }

  /// 已选相册展示文案（「全部」或「已选 N 个相册」）。
  List<String> get selectedAlbumIds => _task.value?.sourceIds ?? const <String>[];

  /// 路径拼接：跟随基线路径的分隔符风格（NAS 可能是 Windows 路径）。
  static String _joinPath(String base, String child) {
    final b = base.trim();
    final c = child.trim();
    if (b.isEmpty || c.isEmpty) return b;
    final sep = b.contains('\\') ? '\\' : '/';
    final left = b.endsWith('/') || b.endsWith('\\')
        ? b.substring(0, b.length - 1)
        : b;
    return '$left$sep$c';
  }

  String _errorMessage(dynamic e) {
    if (e is dio.DioException && e.type == dio.DioExceptionType.cancel) {
      return 'photo_backup_manual_cancel'.tr;
    }
    return UploadTransferHelper.getServerMessage(e);
  }

  /// 取消文案分级（2026-10-13）：
  /// 1. 有显式原因（用户手动停止 / 切到移动网络暂停）→ 用它；
  /// 2. 没原因但「手机端 + 未开流量备份 + 当前不在 Wi-Fi」→ 报「Wi-Fi 未连接」，
  ///    并挂起等 Wi-Fi 回来自动续跑（断网时底层可能直接取消请求，没有显式原因）；
  /// 3. 都不是 → 用户已取消。
  Future<String> _resolveCancelMessage() async {
    final reason = _cancelReason;
    if (reason != null) return reason.tr;
    if (_cellularBlocked && !await _isOnWifi()) {
      _autoResumePending = true;
      return 'photo_backup_wifi_required'.tr;
    }
    return 'photo_backup_manual_cancel'.tr;
  }

  void _syncBackupWorkNotification(PhotoBackupRuntime rt) {
    TransferWorkNotificationHub.instance.photoBackupProgressThrottled(
      currentFile: rt.currentFile.value,
      progress: rt.progress,
      doneFiles: rt.doneFiles.value,
      totalFiles: rt.totalFiles.value,
    );
  }

  @override
  void onInit() {
    super.onInit();
    _dio = createDioWithBadCertificateCompat(
      dio.BaseOptions(
        connectTimeout: const Duration(seconds: 30),
        receiveTimeout: const Duration(minutes: 5),
      ),
    );
    _connSub = Connectivity().onConnectivityChanged.listen(_onConnectivityChanged);
    unawaited(init());
  }

  @override
  void onClose() {
    _connSub?.cancel();
    _connSub = null;
    _cancelRunning();
    super.onClose();
  }

  /// 网络变化：回 Wi-Fi 时把挂起的备份跑起来；离开 Wi-Fi 时把进行中的备份暂停。
  void _onConnectivityChanged(List<ConnectivityResult> results) {
    final onWifi = results.contains(ConnectivityResult.wifi);
    if (onWifi) {
      if (!_autoResumePending || runtime.running.value) return;
      final t = _task.value;
      if (t == null || !t.enabled) {
        _autoResumePending = false;
        return;
      }
      _autoResumePending = false;
      _photoBackupLog('network', 'wifi restored -> auto resume');
      unawaited(startBackup(trigger: PhotoBackupRunTrigger.autoStart));
      return;
    }
    // 没有 Wi-Fi 了：开着流量备份就放行，否则暂停当前轮次
    if (!runtime.running.value || !_cellularBlocked) return;
    _cancelReason = 'photo_backup_paused_mobile';
    _autoResumePending = true;
    _photoBackupLog('network', 'left wifi -> pause backup');
    ToastUtil.show('photo_backup_paused_mobile'.tr);
    _cancelRunning();
  }

  PhotoBackupRuntime runtimeOf(int taskId) => runtime;

  _Identity _identity() {
    final serverId = ApiController.instance.state.serverId.trim();
    final userId = CurrentUserController.instance.current?.id ?? 0;
    return _Identity(serverId: serverId, userId: userId);
  }

  // ---------------------------------------------------------------------------
  // 初始化 / 配置
  // ---------------------------------------------------------------------------

  /// 初始化：解析设备名 -> 载入（或创建）唯一任务 -> 拉相册源算默认目录 -> 刷新累计统计。
  Future<void> init() async {
    loading.value = true;
    try {
      if (deviceName.value.trim().isEmpty) {
        try {
          final name = await UserAgentUtil.getDeviceDisplayName();
          deviceName.value = name.trim().isEmpty ? 'Device' : name.trim();
        } catch (_) {
          deviceName.value = 'Device';
        }
      }
      await _ensureTask();
      await refreshDefaultTargetDir();
      await refreshCounters();
    } finally {
      loading.value = false;
    }
  }

  Future<void> _ensureTask() async {
    final identity = _identity();
    if (identity.serverId.isEmpty || identity.userId <= 0) {
      _task.value = null;
      tasks.clear();
      return;
    }
    var t = await _storage.getSingleTask(
      serverId: identity.serverId,
      userId: identity.userId,
    );
    if (t == null) {
      final name = deviceName.value.trim().isEmpty
          ? 'photo_backup_task_name'.tr
          : deviceName.value.trim();
      await _storage.upsertTask(
        serverId: identity.serverId,
        userId: identity.userId,
        name: name,
        sourceType: 'album',
        sourceId: '',
        sourceName: '',
        targetDir: '',
        nameStrategy: 'skip',
        saveType: '',
        uploadLivePhotoVideo: false,
        autoStartOnLaunch: false,
        enabled: false,
        onlyPhotos: false,
        renameByDate: false,
        useCellular: false,
        savingMode: true,
        keepScreenOn: true,
        deviceName: deviceName.value.trim(),
      );
      t = await _storage.getSingleTask(
        serverId: identity.serverId,
        userId: identity.userId,
      );
    }
    _task.value = t;
    if (t != null) {
      tasks.assignAll([t]);
    } else {
      tasks.clear();
    }
  }

  /// 拉取相册源，算出默认备份位置：`<相册源根>/<设备名>`。
  Future<void> refreshDefaultTargetDir() async {
    try {
      final sources = await PhotoSourceApiService.instance.listSources();
      final roots = sources
          .map((e) => e.path.trim())
          .where((e) => e.isNotEmpty)
          .toList(growable: false);
      hasPhotoSource.value = roots.isNotEmpty;
      defaultTargetDir.value = roots.isEmpty ? '' : roots.first;
    } catch (e) {
      _photoBackupLog('refreshDefaultTargetDir failed', e);
    }
  }

  Future<void> refreshCounters() async {
    final t = _task.value;
    if (t == null) {
      runtime.totalBackedUp.value = 0;
      return;
    }
    try {
      runtime.totalBackedUp.value = await _storage.countSuccessFiles(t.id);
    } catch (_) {
      runtime.totalBackedUp.value = 0;
    }
  }

  /// 会话（服务器/用户）变化时：重新载入任务与会话相关数据。
  Future<void> onSessionMaybeChanged() async {
    final id = _identity();
    final key = '${id.serverId}#${id.userId}';
    if (key == _lastIdentityKey && _task.value != null) return;
    _lastIdentityKey = key;
    await init();
  }

  /// 连接确认可用后调用：若开启了备份总开关，则自动跑一轮。
  Future<void> onConnectionConfirmed() async {
    if (!ApiController.instance.isAuthenticated) return;
    final id = _identity();
    if (id.serverId.isEmpty || id.userId <= 0) return;
    final key = '${id.serverId}#${id.userId}';
    if (_lastAutoTriggerIdentityKey == key) return;

    if (_task.value == null) await init();
    final t = _task.value;
    if (t == null || !t.enabled) return;
    if (runtime.running.value) return;
    if (!t.useCellular && DeviceUtils.isMobile && !await _isOnWifi()) {
      // 没开流量备份又不在 Wi-Fi：本轮不自动开始，挂起等 Wi-Fi
      _autoResumePending = true;
      _photoBackupLog('onConnectionConfirmed', 'skip auto-start: not on WiFi');
      return;
    }
    _lastAutoTriggerIdentityKey = key;
    await startBackup(trigger: PhotoBackupRunTrigger.autoStart);
  }

  Future<bool> _isOnWifi() async {
    try {
      final result = await Connectivity().checkConnectivity();
      return result.contains(ConnectivityResult.wifi);
    } catch (_) {
      return false;
    }
  }

  Future<void> _persist(PhotoBackupTask next) async {
    await _storage.upsertTask(
      id: next.id,
      serverId: next.serverId,
      userId: next.userId,
      name: next.name,
      sourceType: next.sourceType == PhotoBackupSourceType.album
          ? 'album'
          : 'folder',
      sourceId: next.sourceId,
      sourceName: next.sourceName,
      targetDir: next.targetDir,
      nameStrategy: next.nameStrategy.trim().isEmpty
          ? 'skip'
          : next.nameStrategy.trim(),
      saveType: next.saveType,
      uploadLivePhotoVideo: next.uploadLivePhotoVideo,
      autoStartOnLaunch: next.autoStartOnLaunch,
      sourceIds: next.sourceIds,
      sourceNames: next.sourceNames,
      enabled: next.enabled,
      onlyPhotos: next.onlyPhotos,
      renameByDate: next.renameByDate,
      useCellular: next.useCellular,
      savingMode: next.savingMode,
      keepScreenOn: next.keepScreenOn,
      deviceName: next.deviceName,
    );
    _task.value = next;
    tasks.assignAll([next]);
  }

  Future<void> setEnabled(bool value) async {
    final t = _task.value;
    if (t == null) return;
    // 打开开关就先交互式要一次相册权限：没权限的话后面「选相册 / 开始备份」都是空的
    if (value && !await _ensurePhotoPermission(interactive: true)) return;
    await _persist(t.copyWith(enabled: value));
    if (value) {
      // 没开流量备份又不在 Wi-Fi：先不开跑，挂起等 Wi-Fi（与自动触发同一口径）
      if (_cellularBlocked && !await _isOnWifi()) {
        _autoResumePending = true;
        ToastUtil.show('photo_backup_wait_wifi'.tr);
        return;
      }
      unawaited(startBackup());
    } else {
      _autoResumePending = false;
      _cancelReason = 'photo_backup_manual_cancel';
      _cancelRunning();
    }
  }

  Future<void> setSelectedAlbums({
    required List<String> ids,
    required List<String> names,
  }) async {
    final t = _task.value;
    if (t == null) return;
    await _persist(t.copyWith(sourceIds: ids, sourceNames: names));
  }

  Future<void> setTargetDir(String dir) async {
    final t = _task.value;
    if (t == null) return;
    await _persist(t.copyWith(targetDir: dir.trim()));
  }

  Future<void> setDirStyle(PhotoBackupDirStyle style) async {
    final t = _task.value;
    if (t == null) return;
    final saveType = switch (style) {
      PhotoBackupDirStyle.byAlbum => '',
      PhotoBackupDirStyle.byMonth => 'month',
      PhotoBackupDirStyle.byYear => 'year',
    };
    await _persist(t.copyWith(saveType: saveType));
  }

  Future<void> setOnlyPhotos(bool v) async {
    final t = _task.value;
    if (t == null) return;
    await _persist(t.copyWith(onlyPhotos: v));
  }

  Future<void> setUploadLivePhotoVideo(bool v) async {
    final t = _task.value;
    if (t == null) return;
    await _persist(t.copyWith(uploadLivePhotoVideo: v));
  }

  Future<void> setRenameByDate(bool v) async {
    final t = _task.value;
    if (t == null) return;
    await _persist(t.copyWith(renameByDate: v));
  }

  Future<void> setUseCellular(bool v) async {
    final t = _task.value;
    if (t == null) return;
    await _persist(t.copyWith(useCellular: v));
    // 用户主动打开流量备份：把因「不在 Wi-Fi」挂起的轮次立刻跑起来
    if (v && _autoResumePending && !runtime.running.value) {
      _autoResumePending = false;
      unawaited(startBackup());
    }
  }

  Future<void> setSavingMode(bool v) async {
    final t = _task.value;
    if (t == null) return;
    await _persist(t.copyWith(savingMode: v));
  }

  Future<void> setKeepScreenOn(bool v) async {
    final t = _task.value;
    if (t == null) return;
    await _persist(t.copyWith(keepScreenOn: v));
  }

  // ---------------------------------------------------------------------------
  // 运行
  // ---------------------------------------------------------------------------

  Future<void> startBackup({
    PhotoBackupRunTrigger trigger = PhotoBackupRunTrigger.uploadNew,
  }) async {
    await _run(modeAll: false, trigger: trigger);
  }

  /// 备份页底部「立即备份」按钮入口：**与顶部总开关联动** ——
  /// 没开启就先把总开关打开（`setEnabled(true)` 会按 Wi-Fi 守卫决定立即开跑还是等 Wi-Fi），
  /// 已开启则直接跑一轮（同样尊重 Wi-Fi 守卫：没开流量备份时不硬走移动网络）。
  Future<void> requestBackupNow() async {
    final t = _task.value;
    if (t == null) return;
    if (!t.enabled) {
      await setEnabled(true);
      return;
    }
    if (_cellularBlocked && !await _isOnWifi()) {
      _autoResumePending = true;
      ToastUtil.show('photo_backup_wait_wifi'.tr);
      return;
    }
    await startBackup();
  }

  /// 清空本地记录后重新扫描全部素材（仍靠内容去重保证不重复上传）。
  Future<void> startBackupAll() async {
    await _run(modeAll: true, trigger: PhotoBackupRunTrigger.uploadAll);
  }

  void cancelTask([int? taskId]) {
    // 用户手动停止：清掉挂起标记，回到 Wi-Fi 也不自动续跑；文案显式标记「用户已取消」
    _autoResumePending = false;
    _cancelReason = 'photo_backup_manual_cancel';
    _cancelRunning();
  }

  void _cancelRunning() {
    final token = _cancelTokens[runtime];
    if (token != null && !token.isCancelled) token.cancel();
  }

  /// 登出或切换服务器前调用：取消进行中的相册备份。
  void cancelAllRunning() {
    _cancelReason = 'photo_backup_manual_cancel';
    _cancelRunning();
  }

  final Map<PhotoBackupRuntime, dio.CancelToken> _cancelTokens = {};

  Future<List<PhotoBackupRunRecord>> listRuns() async {
    final t = _task.value;
    if (t == null) return const <PhotoBackupRunRecord>[];
    return await _storage.listRuns(t.id);
  }

  Future<List<PhotoBackupFileRecord>> listRunFiles(int runId) async {
    return await _storage.listRunFiles(runId);
  }

  Future<void> deleteRun(int runId) async {
    await _storage.deleteRun(runId);
    await refreshCounters();
  }

  Future<void> _run({
    required bool modeAll,
    required PhotoBackupRunTrigger trigger,
  }) async {
    if (_task.value == null) await init();
    final task = _task.value;
    if (task == null) return;
    final rt = runtime;
    if (rt.running.value) return;

    final token = ApiController.instance.accessToken?.trim() ?? '';
    if (token.isEmpty) {
      rt.error.value = 'network_failure'.tr;
      return;
    }
    final targetDir = effectiveTargetDir;
    if (targetDir.trim().isEmpty) {
      ToastUtil.show('photo_backup_target_required'.tr);
      return;
    }

    final granted = await _ensurePhotoPermission();
    if (!granted) return;

    rt.running.value = true;
    rt.status.value = 'running';
    rt.error.value = '';
    rt.currentFile.value = '';
    rt.totalBytes.value = 0;
    rt.doneBytes.value = 0;
    rt.totalFiles.value = 0;
    rt.doneFiles.value = 0;
    rt.uploadedFiles.value = 0;
    rt.skippedFiles.value = 0;
    _runHandledIds.clear();
    _runHandledMd5.clear();
    _runSizeCount.clear();

    if (task.keepScreenOn) _enableWakeLock();
    unawaited(TransferWorkNotificationHub.instance.backupWorkBegan());

    final cancelToken = dio.CancelToken();
    _cancelTokens[rt]?.cancel();
    _cancelTokens[rt] = cancelToken;

    final runTotal = Stopwatch()..start();
    _photoBackupLog(
      '_run start',
      'modeAll=$modeAll target=$targetDir dirStyle=${task.dirStyle}',
    );

    int? runId;
    int uploaded = 0;
    int skipped = 0;
    int failed = 0;
    int consumedBytes = 0;
    try {
      if (modeAll) {
        await _storage.clearTaskRecords(task.id);
        _runHandledIds.clear();
      }
      // 本地已处理清单：成功过的素材直接跳过，避免每轮重复查远端
      final handledBefore = modeAll
          ? <String>{}
          : await _storage.listHandledUniqueIds(task.id);

      runId = await _storage.createRun(
        taskId: task.id,
        triggerType: _triggerValue(trigger),
        startedAtMs: DateTime.now().millisecondsSinceEpoch,
      );

      final albums = await _resolveSelectedAlbums(task);
      if (albums.isEmpty) {
        await _storage.finishRun(
          runId: runId,
          finishedAtMs: DateTime.now().millisecondsSinceEpoch,
          successCount: 0,
          failedCount: 0,
          totalBytes: 0,
        );
        rt.error.value = 'photo_backup_no_files_album'.tr;
        return;
      }

      // 预计总数：设备内**唯一**素材数（见 _estimateTotalFiles）
      rt.totalFiles.value = await _estimateTotalFiles(albums);

      final baseUrl = ApiController.instance.baseUrl;
      final byAlbum = task.dirStyle == PhotoBackupDirStyle.byAlbum;

      await for (final batch in _scanAlbumsLight(albums, task, handledBefore)) {
        if (cancelToken.isCancelled) {
          throw dio.DioException(
            requestOptions: dio.RequestOptions(path: ''),
            type: dio.DioExceptionType.cancel,
          );
        }
        // 已备份素材的「零 I/O 跳过」也计入进度，进度条随轻量扫描一起走完
        if (batch.handledSkipped > 0) {
          rt.doneFiles.value += batch.handledSkipped;
          // 「已备份素材的零 I/O 跳过」也要计入「跳过」数，否则进度已走到几千、
          // 而「跳过」一直显示 0（2026-10-15 修）
          rt.skippedFiles.value += batch.handledSkipped;
          _syncBackupWorkNotification(rt);
        }
        if (batch.entries.isEmpty) continue;
        final result = await _processBatch(
          task: task,
          albumName: batch.albumName,
          raw: batch.entries,
          byAlbum: byAlbum,
          targetDir: targetDir,
          baseUrl: baseUrl,
          token: token,
          cancelToken: cancelToken,
          runId: runId,
          rt: rt,
        );
        uploaded += result.uploaded;
        skipped += result.skipped;
        failed += result.failed;
        consumedBytes += result.bytes;
        // ⭐ 单批失败不再中断整轮：失败条目已入记录，继续处理后续相册，
        //    最后经 finishRun(failedCount) 与状态卡汇总。
      }

      await _storage.finishRun(
        runId: runId,
        finishedAtMs: DateTime.now().millisecondsSinceEpoch,
        successCount: uploaded,
        failedCount: failed,
        totalBytes: consumedBytes,
      );
      rt.uploadedFiles.value = uploaded;
      rt.skippedFiles.value = skipped;
      rt.status.value = failed > 0 ? 'error' : 'idle';
      if (failed == 0 && uploaded == 0) {
        ToastUtil.show(
          skipped > 0
              ? 'photo_backup_all_duplicated'.tr
              : 'photo_backup_no_new_files'.tr,
        );
      }
    } catch (e) {
      if (runId != null) {
        await _storage.finishRun(
          runId: runId,
          finishedAtMs: DateTime.now().millisecondsSinceEpoch,
          successCount: uploaded,
          failedCount: failed > 0 ? failed : 1,
          totalBytes: consumedBytes,
        );
      }
      if (e is _PhotoBackupPermissionDeniedException) {
        rt.error.value = '';
      } else if (e is dio.DioException && e.type == dio.DioExceptionType.cancel) {
        // 取消原因分级：显式原因（手动停止 / 切移动网络暂停）> 断网兜底 > 用户已取消
        rt.error.value = await _resolveCancelMessage();
      } else {
        rt.error.value = _errorMessage(e);
      }
      rt.status.value = 'idle';
    } finally {
      unawaited(TransferWorkNotificationHub.instance.backupWorkEnded());
      rt.running.value = false;
      rt.currentFile.value = '';
      _cancelTokens.remove(rt);
      _cancelReason = null;
      _disableWakeLock();
      await refreshCounters();
      _photoBackupLog('_run total', '${runTotal.elapsedMilliseconds}ms');
    }
  }

  /// 处理一批轻量素材：size 预检 -> 按需取文件/MD5 -> 内容去重 -> 并发上传。
  ///
  /// ⭐ 快路设计（2026-10-13，几万张图场景）：
  /// 1. 扫描阶段已按「历史成功 id」过滤，已备份素材零 I/O；
  /// 2. 本批 size 先问服务端「有没有候选」——没有候选的 size 意味着内容不可能已存在
  ///    （同内容必同 size），可**跳过本地 MD5** 直接上传；
  /// 3. 只有「size 有候选」或「同 size 本轮出现多次」的素材才值得算 MD5；
  /// 4. 上传走 5 并发池，单文件失败自动重试，不再一失败就中断整轮。
  Future<_BatchResult> _processBatch({
    required PhotoBackupTask task,
    required String albumName,
    required List<_LightEntry> raw,
    required bool byAlbum,
    required String targetDir,
    required String baseUrl,
    required String token,
    required dio.CancelToken cancelToken,
    required int runId,
    required PhotoBackupRuntime rt,
  }) async {
    final result = _BatchResult();

    // 1) size 预检（不带 md5）：absent = 服务端该用户全部源里没有同 size 候选
    final absentSizes = await _queryAbsentSizes(
      entries: raw,
      baseUrl: baseUrl,
      token: token,
      cancelToken: cancelToken,
    );

    // 2) 分类：需要「取文件 + 算 MD5」的 vs 可免 MD5 直接上传的
    final needMd5 = <_LightEntry>[];
    final direct = <_LightEntry>[];
    for (final e in raw) {
      final dupInRun = e.size > 0 && (_runSizeCount[e.size] ?? 0) > 1;
      final maybeOnServer =
          absentSizes == null || !absentSizes.contains(e.size);
      if (dupInRun || maybeOnServer) {
        needMd5.add(e);
      } else {
        direct.add(e);
      }
    }

    // 3) 物化（originFile + stat，5 并发重叠 I/O）；失败的条目为 null
    final toMaterialize = <_LightEntry>[...needMd5, ...direct];
    final materialized = await _materializeEntries(toMaterialize);

    // 4) 按需算 MD5（5 并发，进程内/sqlite 缓存优先）
    final needMd5Ids = {for (final e in needMd5) e.sourceUniqueId};
    final md5Map = <String, String>{};
    await _runPool(materialized.length, (i) async {
      final entry = materialized[i];
      if (entry == null) return;
      if (!needMd5Ids.contains(entry.sourceUniqueId)) return;
      md5Map[entry.sourceUniqueId] = await _computeLocalMd5(item: entry);
    });

    // 5) 批内内容去重（同步进行，无并发间隙）：内容相同的只处理第一次
    final candidates = <_SourceEntry>[];
    for (final entry in materialized) {
      if (entry == null) continue;
      final md5 = md5Map[entry.sourceUniqueId] ?? '';
      if (md5.isNotEmpty) {
        if (_runHandledMd5.contains(md5)) {
          await _record(
            task: task,
            runId: runId,
            item: entry,
            status: 'skipped',
            error: '',
            rt: rt,
          );
          result.skipped += 1;
          rt.skippedFiles.value += 1;
          continue;
        }
        _runHandledMd5.add(md5);
      }
      candidates.add(entry);
    }
    if (candidates.isEmpty) return result;

    // 6) 二轮内容比对：只对带了 md5 的条目问服务端（direct 条目已由 absent 判定不可能存在）
    final withMd5 = candidates
        .where((e) => (md5Map[e.sourceUniqueId] ?? '').isNotEmpty)
        .toList();
    final remoteMatched = withMd5.isEmpty
        ? <String>{}
        : await _queryRemoteExisting(
            entries: withMd5,
            md5Map: md5Map,
            baseUrl: baseUrl,
            token: token,
            cancelToken: cancelToken,
          );
    final remoteCheckOk = remoteMatched != null;

    // 7) 组装上传清单
    final uploads = <_SourceEntry>[];
    for (final item in candidates) {
      if (cancelToken.isCancelled) {
        throw dio.DioException(
          requestOptions: dio.RequestOptions(path: ''),
          type: dio.DioExceptionType.cancel,
        );
      }
      final md5 = md5Map[item.sourceUniqueId] ?? '';
      if (remoteCheckOk && md5.isNotEmpty && remoteMatched!.contains(md5)) {
        _photoBackupLog('skip(duplicated in photo sources)', item.displayName);
        await _record(
          task: task,
          runId: runId,
          item: item,
          status: 'skipped',
          error: '',
          rt: rt,
        );
        result.skipped += 1;
        rt.skippedFiles.value += 1;
        continue;
      }

      // 服务端内容索引不可用（老版本服务端/二轮请求失败）时回退逐条判定
      if (!remoteCheckOk && md5.isNotEmpty) {
        final samePath = await _shouldSkipExistingContent(
          task: task,
          item: item,
          targetDir: targetDir,
          albumName: albumName,
          byAlbum: byAlbum,
          baseUrl: baseUrl,
          token: token,
          cancelToken: cancelToken,
        );
        if (samePath) {
          await _record(
            task: task,
            runId: runId,
            item: item,
            status: 'skipped',
            error: '',
            rt: rt,
          );
          result.skipped += 1;
          rt.skippedFiles.value += 1;
          continue;
        }
      }

      uploads.add(item);
    }

    // 8) 上传池：5 并发 + 单文件重试；失败记录后继续，不中断整轮
    await _runPool(uploads.length, (i) async {
      final item = uploads[i];
      if (cancelToken.isCancelled) {
        throw dio.DioException(
          requestOptions: dio.RequestOptions(path: ''),
          type: dio.DioExceptionType.cancel,
        );
      }
      rt.currentFile.value = item.displayName;
      _syncBackupWorkNotification(rt);

      try {
        await _uploadWithRetry(
          task: task,
          item: item,
          albumName: albumName,
          byAlbum: byAlbum,
          targetDir: targetDir,
          baseUrl: baseUrl,
          token: token,
          cancelToken: cancelToken,
          rt: rt,
        );
        result.uploaded += 1;
        rt.uploadedFiles.value += 1;
        result.bytes += item.size;
        await _record(
          task: task,
          runId: runId,
          item: item,
          status: 'success',
          error: '',
          rt: rt,
        );
      } catch (e) {
        // 取消必须向上抛（结束整轮并显示「用户已取消」）
        if (e is dio.DioException && e.type == dio.DioExceptionType.cancel) {
          rethrow;
        }
        final msg = _errorMessage(e);
        rt.error.value = msg;
        result.failed += 1;
        await _record(
          task: task,
          runId: runId,
          item: item,
          status: 'error',
          error: msg,
          rt: rt,
        );
      }
    });
    return result;
  }

  /// 简易并发池：[concurrency] 个 worker 依次领取 [total] 个任务。
  /// worker 自行 try/catch 决定是否中断；取消（DioException cancel）会向上抛。
  Future<void> _runPool(
    int total,
    Future<void> Function(int index) worker, {
    int? concurrency,
  }) async {
    if (total <= 0) return;
    var n = concurrency ?? _backupConcurrency;
    if (n < 1) n = 1;
    if (n > total) n = total;
    var next = 0;
    Future<void> drain() async {
      while (true) {
        final i = next++;
        if (i >= total) return;
        await worker(i);
      }
    }

    await Future.wait(List.generate(n, (_) => drain()));
  }

  /// 轻量条目 -> 完整条目：取原文件（Android 上是 MediaStore 拷贝，5 并发重叠 I/O）。
  /// 返回与入参等长的列表，取文件失败的条目为 null。
  Future<List<_SourceEntry?>> _materializeEntries(
    List<_LightEntry> lights,
  ) async {
    final out = List<_SourceEntry?>.filled(lights.length, null);
    await _runPool(lights.length, (i) async {
      out[i] = await _materializeOne(lights[i]);
    });
    return out;
  }

  Future<_SourceEntry?> _materializeOne(_LightEntry light) async {
    try {
      final File file;
      if (light.isLiveVideo) {
        final live = await light.asset.originFileWithSubtype;
        if (live == null) return null;
        file = live;
      } else {
        final f = await light.asset.originFile;
        if (f == null) return null;
        file = f;
      }
      final size = await file.length();
      if (size <= 0) return null;
      final mtimeMs = file.statSync().modified.millisecondsSinceEpoch;
      return _SourceEntry(
        sourceUniqueId: light.sourceUniqueId,
        displayName: light.displayName,
        localPath: file.path,
        orderMs: light.orderMs,
        size: size,
        fileMtimeMs: mtimeMs,
      );
    } catch (e) {
      _photoBackupLog('materialize failed', '${light.sourceUniqueId} -> $e');
      return null;
    }
  }

  /// size 预检：问服务端「这些 size 在我全部相册源里有没有候选」。
  /// 返回 absent（无候选的 size 集合）；null = 服务端不支持该字段（老版本）或请求失败，
  /// 调用方需回退到「全部算 MD5」的老路。
  Future<Set<int>?> _queryAbsentSizes({
    required List<_LightEntry> entries,
    required String baseUrl,
    required String token,
    required dio.CancelToken cancelToken,
  }) async {
    final sizes = <int>{for (final e in entries) if (e.size > 0) e.size};
    if (sizes.isEmpty) return <int>{};
    final absent = <int>{};
    const chunk = 200;
    final list = sizes.toList();
    try {
      for (var i = 0; i < list.length; i += chunk) {
        final slice = list.sublist(
          i,
          (i + chunk) > list.length ? list.length : i + chunk,
        );
        final resp = await _dio.post<dynamic>(
          '$baseUrl/api/photo/backup/check_content',
          data: {
            'items': [for (final s in slice) {'size': s}],
          },
          options: dio.Options(headers: {'Authorization': 'Bearer $token'}),
          cancelToken: cancelToken,
        );
        final body = resp.data;
        if (body is! Map || body['success'] != true) return null;
        final data = body['data'];
        if (data is! Map) return null;
        final rawAbsent = data['absent'];
        if (rawAbsent is! List) return null; // 老服务端：没有 absent 字段
        for (final v in rawAbsent) {
          final n = v is num ? v.toInt() : int.tryParse(v.toString());
          if (n != null && n > 0) absent.add(n);
        }
      }
      return absent;
    } catch (e) {
      _photoBackupLog('absent precheck failed -> legacy md5 path', e);
      return null;
    }
  }

  /// 单文件上传（带重试）：默认最多 3 次尝试，退避 2s/4s。
  /// 取消与 4xx 立即抛出；超时/连接错误/5xx 才重试。
  Future<void> _uploadWithRetry({
    required PhotoBackupTask task,
    required _SourceEntry item,
    required String albumName,
    required bool byAlbum,
    required String targetDir,
    required String baseUrl,
    required String token,
    required dio.CancelToken cancelToken,
    required PhotoBackupRuntime rt,
    int maxAttempts = 3,
  }) async {
    var attempt = 0;
    while (true) {
      try {
        await _uploadEntry(
          task: task,
          item: item,
          albumName: albumName,
          byAlbum: byAlbum,
          targetDir: targetDir,
          baseUrl: baseUrl,
          token: token,
          cancelToken: cancelToken,
          rt: rt,
        );
        return;
      } catch (e) {
        if (e is dio.DioException && e.type == dio.DioExceptionType.cancel) {
          rethrow;
        }
        if (cancelToken.isCancelled) {
          throw dio.DioException(
            requestOptions: dio.RequestOptions(path: ''),
            type: dio.DioExceptionType.cancel,
          );
        }
        attempt++;
        if (attempt >= maxAttempts || !_isRetryableUploadError(e)) rethrow;
        _photoBackupLog(
          'upload retry',
          '${item.displayName} attempt=$attempt/$maxAttempts',
        );
        await Future.delayed(Duration(seconds: 2 * attempt));
      }
    }
  }

  static bool _isRetryableUploadError(Object e) {
    if (e is dio.DioException) {
      switch (e.type) {
        case dio.DioExceptionType.connectionTimeout:
        case dio.DioExceptionType.sendTimeout:
        case dio.DioExceptionType.receiveTimeout:
        case dio.DioExceptionType.connectionError:
          return true;
        case dio.DioExceptionType.badResponse:
          final code = e.response?.statusCode ?? 0;
          return code >= 500;
        default:
          return e.type == dio.DioExceptionType.unknown;
      }
    }
    // 普通异常（临时 IO 等）也值得重试
    return true;
  }

  Future<void> _record({
    required PhotoBackupTask task,
    required int runId,
    required _SourceEntry item,
    required String status,
    required String error,
    required PhotoBackupRuntime rt,
  }) async {
    try {
      await _storage.insertFileRecord(
        taskId: task.id,
        runId: runId,
        sourceUniqueId: item.sourceUniqueId,
        displayName: item.displayName,
        localPath: item.localPath,
        size: item.size,
        sourceCreateAtMs: item.orderMs,
        uploadedAtMs: DateTime.now().millisecondsSinceEpoch,
        status: status,
        error: error,
      );
    } catch (e) {
      _photoBackupLog('insertFileRecord failed', e);
    }
    await UploadTempFileCleaner.instance.maybeDeleteSandboxTempFile(
      item.localPath,
    );
    rt.doneFiles.value += 1;
    if (rt.totalBytes.value > 0 && rt.doneBytes.value > rt.totalBytes.value) {
      rt.doneBytes.value = rt.totalBytes.value;
    }
  }

  /// 单个条目的上传（按目录偏好决定相对路径）。
  Future<void> _uploadEntry({
    required PhotoBackupTask task,
    required _SourceEntry item,
    required String albumName,
    required bool byAlbum,
    required String targetDir,
    required String baseUrl,
    required String token,
    required dio.CancelToken cancelToken,
    required PhotoBackupRuntime rt,
  }) async {
    final fileHash = sha256
        .convert(
          utf8.encode('${item.sourceUniqueId}|${item.size}|${item.fileMtimeMs}'),
        )
        .toString();
    // 按相册归档时在目标目录下建相册子目录；按年月/年由服务端按拍摄时间归档。
    final relativePath = byAlbum
        ? p.posix.join(_safeSegment(albumName), item.displayName)
        : null;
    await UploadCore.processFile(
      dioClient: _dio,
      baseUrl: baseUrl,
      token: token,
      fileRef: XFile(item.localPath, name: item.displayName),
      fileName: item.displayName,
      fileSize: item.size,
      remotePath: targetDir,
      nameStrategy: task.nameStrategy.trim().isEmpty
          ? 'skip'
          : task.nameStrategy.trim(),
      saveType: task.saveType.isEmpty ? null : task.saveType,
      fileHash: fileHash,
      cancelToken: cancelToken,
      relativePath: relativePath,
      fileMtimeMs: item.fileMtimeMs,
      fileBirthtimeMs: item.orderMs > 0 ? item.orderMs : null,
      onProgress: (increment) {
        rt.doneBytes.value += increment;
        _syncBackupWorkNotification(rt);
      },
      onCompleted: (_) {},
    );
  }

  /// 目录名安全化：去掉非法字符，避免相册名里带 `\ / :` 之类导致建目录失败。
  static String _safeSegment(String raw) {
    var s = raw.trim();
    if (s.isEmpty) return 'Album';
    s = s.replaceAll(RegExp(r'[\\/:*?"<>|]'), '_');
    s = s.replaceAll(RegExp(r'\s+'), ' ').trim();
    if (s.isEmpty) return 'Album';
    if (s == '.' || s == '..') return 'Album';
    return s;
  }

  /// 批量查询：这些内容是否已存在于该用户的**全部相册源**中。
  ///
  /// 返回 null 表示接口不可用（老版本服务端），调用方需回退到逐条判定。
  Future<Set<String>?> _queryRemoteExisting({
    required List<_SourceEntry> entries,
    required Map<String, String> md5Map,
    required String baseUrl,
    required String token,
    required dio.CancelToken cancelToken,
  }) async {
    final items = <Map<String, dynamic>>[];
    for (final e in entries) {
      final md5 = md5Map[e.sourceUniqueId] ?? '';
      if (md5.isEmpty) continue;
      items.add({'md5': md5, 'size': e.size});
    }
    if (items.isEmpty) return <String>{};

    final matched = <String>{};
    const chunk = 200;
    try {
      for (var i = 0; i < items.length; i += chunk) {
        final slice = items.sublist(
          i,
          (i + chunk) > items.length ? items.length : i + chunk,
        );
        final resp = await _dio.post<dynamic>(
          '$baseUrl/api/photo/backup/check_content',
          data: {'items': slice},
          options: dio.Options(headers: {'Authorization': 'Bearer $token'}),
          cancelToken: cancelToken,
        );
        final body = resp.data;
        if (body is! Map || body['success'] != true) return null;
        final data = body['data'];
        if (data is! Map) return null;
        final raw = data['matched'];
        if (raw is! List) return null;
        for (final m in raw) {
          final v = m.toString().trim().toLowerCase();
          if (v.isNotEmpty) matched.add(v);
        }
      }
      return matched;
    } catch (e) {
      _photoBackupLog('check_content failed -> fallback', e);
      return null;
    }
  }

  /// 兜底判定（服务端无内容索引时）：目标路径下同名文件且 **大小 + 内容 MD5** 一致则跳过。
  Future<bool> _shouldSkipExistingContent({
    required PhotoBackupTask task,
    required _SourceEntry item,
    required String targetDir,
    required String albumName,
    required bool byAlbum,
    required String baseUrl,
    required String token,
    required dio.CancelToken cancelToken,
  }) async {
    if (task.saveType.trim().isNotEmpty) return false;
    if (item.size <= 0) return false;

    try {
      final relPath = byAlbum
          ? p.posix.join(_safeSegment(albumName), item.displayName)
          : item.displayName;
      final resolved = await _getJson(
        '$baseUrl/api/file/attributes/resolve',
        queryParameters: {'targetDir': targetDir, 'relativePath': relPath},
        token: token,
        cancelToken: cancelToken,
      );
      if (resolved == null || resolved['success'] != true) return false;
      final data = resolved['data'];
      if (data is! Map) return false;
      if (data['isFile'] != true) return false;
      if (_asIntOrNull(data['size']) != item.size) return false;

      final remotePath = data['path']?.toString().trim() ?? '';
      if (remotePath.isEmpty) return false;

      final localMd5 = await _computeLocalMd5(item: item);
      if (localMd5.isEmpty) return false;

      final md5Resp = await _getJson(
        '$baseUrl/api/file/md5',
        queryParameters: {'path': remotePath},
        token: token,
        cancelToken: cancelToken,
      );
      if (md5Resp == null || md5Resp['success'] != true) return false;
      final md5Data = md5Resp['data'];
      if (md5Data is! Map) return false;
      final remoteMd5 = md5Data['md5']?.toString().trim() ?? '';
      if (remoteMd5.isEmpty) return false;

      return remoteMd5 == localMd5;
    } catch (e) {
      _photoBackupLog('content dedup probe failed', '$albumName -> $e');
      return false;
    }
  }

  /// 本地文件内容 MD5：进程内缓存 -> sqlite 缓存 -> 实算并回写。
  /// 算法与服务端 `GET /api/file/md5` 保持一致（<50MB 全量；>=50MB 取头/尾各 1MB）。
  Future<String> _computeLocalMd5({required _SourceEntry item}) async {
    final key = '${item.sourceUniqueId}|${item.size}|${item.fileMtimeMs}';
    final memo = _md5MemoryCache[key];
    if (memo != null && memo.isNotEmpty) return memo;

    final cached = await _storage.loadHashCache(
      sourceUniqueId: item.sourceUniqueId,
      size: item.size,
      mtimeMs: item.fileMtimeMs,
    );
    if (cached != null && cached.isNotEmpty) {
      _rememberMd5(key, cached);
      return cached;
    }

    String value;
    try {
      value = await UploadTransferHelper.computeFileMd5(
        item.localPath,
        fileSize: item.size,
      );
    } catch (e) {
      _photoBackupLog('computeFileMd5 failed', '$key -> $e');
      return '';
    }
    if (value.isEmpty) return '';
    _rememberMd5(key, value);
    await _storage.upsertHashCache(
      sourceUniqueId: item.sourceUniqueId,
      size: item.size,
      mtimeMs: item.fileMtimeMs,
      md5: value,
    );
    return value;
  }

  void _rememberMd5(String key, String value) {
    if (_md5MemoryCache.length > 20000) _md5MemoryCache.clear();
    _md5MemoryCache[key] = value;
  }

  Future<Map?> _getJson(
    String url, {
    required Map<String, dynamic> queryParameters,
    required String token,
    required dio.CancelToken cancelToken,
  }) async {
    final resp = await _dio.get<dynamic>(
      url,
      queryParameters: queryParameters,
      options: dio.Options(headers: {'Authorization': 'Bearer $token'}),
      cancelToken: cancelToken,
    );
    final body = resp.data;
    return body is Map ? body.cast<String, dynamic>() : null;
  }

  static int? _asIntOrNull(Object? value) {
    if (value is int) return value;
    if (value is num) return value.toInt();
    return int.tryParse(value?.toString() ?? '');
  }

  String _triggerValue(PhotoBackupRunTrigger trigger) {
    switch (trigger) {
      case PhotoBackupRunTrigger.uploadAll:
        return 'upload_all';
      case PhotoBackupRunTrigger.autoStart:
        return 'auto_start';
      case PhotoBackupRunTrigger.uploadNew:
        return 'upload_new';
    }
  }

  void _enableWakeLock() {
    _wakelockRefCount += 1;
    if (_wakelockRefCount == 1 && !_wakeLockEnabled) {
      _wakeLockEnabled = true;
      WakelockPlus.enable();
    }
  }

  void _disableWakeLock() {
    _wakelockRefCount -= 1;
    if (_wakelockRefCount <= 0) {
      _wakelockRefCount = 0;
      if (_wakeLockEnabled) {
        _wakeLockEnabled = false;
        WakelockPlus.disable();
      }
    }
  }

  // ---------------------------------------------------------------------------
  // 相册扫描
  // ---------------------------------------------------------------------------

  Future<bool> _ensurePhotoPermission({bool interactive = false}) async {
    if (kIsWeb || (!Platform.isAndroid && !Platform.isIOS)) return true;
    if (interactive) {
      return PhotoBackupController.ensurePhotoPermissionInteractive();
    }
    final state = await pm.PhotoManager.requestPermissionExtend();
    if (state.hasAccess) return true;
    ToastUtil.show('photo_library_permission_missing'.tr);
    return false;
  }

  /// 交互式申请相册（照片/视频）权限，供「打开开关」「选择相册」等入口复用。
  ///
  /// - 未授权：弹系统权限框；
  /// - 已被永久拒绝（系统不再弹）：弹对话框引导去应用设置里手动开。
  ///
  /// 返回 true 表示已拿到权限。非 Android/iOS（桌面/Web）直接放行。
  static Future<bool> ensurePhotoPermissionInteractive() async {
    if (kIsWeb || (!Platform.isAndroid && !Platform.isIOS)) return true;
    final state = await pm.PhotoManager.requestPermissionExtend();
    if (state.hasAccess) return true;
    // photo_manager 的 PermissionState 不区分「是否永久拒绝」，这里统一弹对话框引导去系统设置：
    // 尚未授权时点「去设置」能直接开启；被永久拒绝时系统不会再弹，也只能走设置页。
    final go = await DialogUtil.showConfirmDialog(
      title: 'photo_library_permission_missing'.tr,
      content: 'photo_library_permission_settings_hint'.tr,
      confirmText: 'photo_library_permission_settings_btn'.tr,
      cancelText: 'cancel'.tr,
    );
    if (go == true) {
      try {
        await pm.PhotoManager.openSetting();
      } catch (_) {}
    }
    return false;
  }

  /// 打开应用设置。iOS 上先提示并延迟再打开，减少从设置返回时的崩溃。
  void openAppSettingsForPhotoPermission() {
    if (Platform.isIOS) {
      ToastUtil.show('permission_open_settings_ios_hint'.tr);
      Future.delayed(const Duration(milliseconds: 500), () {
        openAppSettings();
      });
    } else {
      openAppSettings();
    }
  }

  /// 解析要扫描的相册列表：未选则用系统「所有照片」，否则按选中 id 取。
  Future<List<pm.AssetPathEntity>> _resolveSelectedAlbums(
    PhotoBackupTask task,
  ) async {
    final all = await pm.PhotoManager.getAssetPathList(
      type: pm.RequestType.common,
      hasAll: true,
      onlyAll: false,
      filterOption: Platform.isAndroid
          ? pm.AdvancedCustomFilter(
              orderBy: [pm.OrderByItem.desc(pm.CustomColumns.android.modifiedDate)],
            )
          : null,
    );
    if (all.isEmpty) return const <pm.AssetPathEntity>[];

    if (task.sourceIds.isEmpty) {
      final allPath = all.firstWhereOrNull((e) => e.isAll);
      return allPath == null ? [all.first] : [allPath];
    }
    final byId = <String, pm.AssetPathEntity>{for (final e in all) e.id: e};
    final out = <pm.AssetPathEntity>[];
    for (final id in task.sourceIds) {
      final hit = byId[id];
      if (hit != null) out.add(hit);
    }
    return out;
  }

  /// 预计总数（仅用于进度展示）：取「全部」相册的素材数 = **设备内唯一素材数**。
  ///
  /// ⚠️ 不能把选中相册的 assetCountAsync 直接相加 —— Android 上 getAssetPathList
  /// 返回的相册是**互相重叠**的（「全部/最近」包含一切，另有「相机」「截图」「微信」
  /// 等子集），相加会把同一张照片数成好几张，正是「手机里 7000 多张、这里却显示
  /// 1 万多张」的原因（2026-10-15 修）。拿不到「全部」相册时才退化为求和。
  Future<int> _estimateTotalFiles(List<pm.AssetPathEntity> albums) async {
    try {
      final all = await pm.PhotoManager.getAssetPathList(
        type: pm.RequestType.common,
        hasAll: true,
        onlyAll: false,
      );
      final allPath = all.firstWhereOrNull((e) => e.isAll);
      if (allPath != null) {
        return await allPath.assetCountAsync;
      }
    } catch (_) {}
    var sum = 0;
    for (final a in albums) {
      try {
        sum += await a.assetCountAsync;
      } catch (_) {}
    }
    return sum;
  }

  /// 轻量扫描：只用 MediaStore 元数据（id/type/fileSize/title），**不取原文件**。
  ///
  /// ⭐ 历史已成功上传的素材在这里就跳过（零 I/O：不拷贝原文件、不算 MD5、不问服务端），
  /// 几万张图的复扫因此只要秒级；`fileSize` 是 MediaStore 单列查询，不走文件拷贝。
  Stream<_LightBatch> _scanAlbumsLight(
    List<pm.AssetPathEntity> albums,
    PhotoBackupTask task,
    Set<String> handledBefore,
  ) async* {
    // 页大一点：每页只发一次 MediaStore 列表查询，减少翻页往返
    const pageSize = 100;
    for (final album in albums) {
      var page = 0;
      while (true) {
        final list = await album.getAssetListPaged(page: page, size: pageSize);
        if (list.isEmpty) break;

        // 1) 先按 id 过滤（纯内存，零 I/O）：历史已备份的直接跳过
        final pendingItems = <pm.AssetEntity>[];
        var handledSkipped = 0;
        for (final item in list) {
          if (task.onlyPhotos && item.type != pm.AssetType.image) continue;
          final liveWanted =
              task.uploadLivePhotoVideo && item.type == pm.AssetType.image;
          final imageHandled = handledBefore.contains(item.id);
          final liveHandled = handledBefore.contains('${item.id}#live');
          // 快路：图片已备份且（不需要 live 或 live 也已备份）=> 零 I/O 跳过
          if (imageHandled && (!liveWanted || liveHandled)) {
            handledSkipped += 1;
            continue;
          }
          // 同一次运行内同一素材只处理一次（跨相册）
          if (!_runHandledIds.add(item.id)) continue;
          pendingItems.add(item);
        }

        // 2) 并发取 size：每张一次 MediaStore 单列查询（不拷贝文件）。
        //    photo_manager 不把 SIZE 列随列表查询带回（AssetEntity 没有 size 字段），
        //    只能逐张查 —— 并发发出去把「查询 + 通道往返」的等待叠起来。
        final sizes = List<int>.filled(pendingItems.length, 0);
        if (pendingItems.isNotEmpty) {
          await _runPool(
            pendingItems.length,
            (i) async {
              try {
                sizes[i] = await pendingItems[i].fileSize;
              } catch (_) {
                sizes[i] = 0;
              }
            },
            concurrency: _scanConcurrency,
          );
        }

        // 3) 组装轻量条目
        final entries = <_LightEntry>[];
        for (var i = 0; i < pendingItems.length; i++) {
          final item = pendingItems[i];
          final orderMs = item.createDateTime.millisecondsSinceEpoch;
          if (!handledBefore.contains(item.id)) {
            final size = sizes[i];
            if (size <= 0) continue;
            final name = await _lightDisplayName(task, item);
            entries.add(
              _LightEntry(
                asset: item,
                sourceUniqueId: item.id,
                displayName: name,
                orderMs: orderMs,
                size: size,
                isLiveVideo: false,
              ),
            );
            _runSizeCount[size] = (_runSizeCount[size] ?? 0) + 1;
          }
          if (task.uploadLivePhotoVideo &&
              item.type == pm.AssetType.image &&
              !handledBefore.contains('${item.id}#live')) {
            final base = await _lightDisplayName(task, item);
            entries.add(
              _LightEntry(
                asset: item,
                sourceUniqueId: '${item.id}#live',
                displayName: '${p.basenameWithoutExtension(base)}.MOV',
                orderMs: orderMs,
                // live 视频的 size 要取了文件才知道，标记 0 走「必算 MD5」通道
                size: 0,
                isLiveVideo: true,
              ),
            );
          }
        }

        if (entries.isNotEmpty || handledSkipped > 0) {
          yield _LightBatch(
            albumName: album.name,
            entries: entries,
            handledSkipped: handledSkipped,
          );
        }
        if (list.length < pageSize) break;
        page += 1;
      }
    }
  }

  /// 轻量显示名：Android 上 title 已随分页查询带回（零额外查询）。
  Future<String> _lightDisplayName(
    PhotoBackupTask task,
    pm.AssetEntity item,
  ) async {
    final rawName = (await item.titleAsync).trim();
    final originName = rawName.isEmpty ? item.id : rawName;
    return task.renameByDate
        ? _renamedByDate(originName, item.createDateTime)
        : originName;
  }

  /// 按拍摄日期重命名：`IMG_20231005_143000.jpg`（保留原扩展名）。
  static String _renamedByDate(String originName, DateTime time) {
    final ext = p.extension(originName);
    String two(int v) => v.toString().padLeft(2, '0');
    final stamp =
        '${time.year}${two(time.month)}${two(time.day)}_${two(time.hour)}${two(time.minute)}${two(time.second)}';
    return 'IMG_$stamp$ext';
  }
}

/// 相册权限未授予且已弹窗引导用户去设置，不再在卡片上显示错误文案。
class _PhotoBackupPermissionDeniedException implements Exception {}

class _Identity {
  final String serverId;
  final int userId;
  const _Identity({required this.serverId, required this.userId});
}

class _BatchResult {
  int uploaded = 0;
  int skipped = 0;
  int failed = 0;
  int bytes = 0;
}

class _LightBatch {
  final String albumName;

  /// 本页待处理的轻量条目（已按「历史成功 id / 本轮到过 id」过滤）。
  final List<_LightEntry> entries;

  /// 本页因「已备份」零 I/O 跳过的素材数（计入进度，让进度条随扫描走完）。
  final int handledSkipped;

  const _LightBatch({
    required this.albumName,
    required this.entries,
    required this.handledSkipped,
  });
}

/// 轻量素材条目：仅 MediaStore 元数据，**未取原文件**
/// （localPath/mtime 在物化阶段拿文件时才有）。
class _LightEntry {
  final pm.AssetEntity asset;
  final String sourceUniqueId;
  final String displayName;
  final int orderMs;

  /// MediaStore 的 SIZE 列（fileSize，不拷贝文件）；live 视频未知时为 0。
  final int size;

  /// Live Photo 的视频分量（要取 `originFileWithSubtype`）。
  final bool isLiveVideo;

  const _LightEntry({
    required this.asset,
    required this.sourceUniqueId,
    required this.displayName,
    required this.orderMs,
    required this.size,
    required this.isLiveVideo,
  });
}

class _SourceEntry {
  final String sourceUniqueId;
  final String displayName;
  final String localPath;
  final int orderMs;
  final int size;
  final int fileMtimeMs;

  const _SourceEntry({
    required this.sourceUniqueId,
    required this.displayName,
    required this.localPath,
    required this.orderMs,
    required this.size,
    required this.fileMtimeMs,
  });
}
