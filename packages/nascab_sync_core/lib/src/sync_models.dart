/// 电脑 <-> NAS 目录同步模块的数据模型

/// 同步模式
class SyncMode {
  static const String bidirectional = 'bidirectional';
  static const String downloadOnly = 'download_only';
  static const String uploadOnly = 'upload_only';

  static const List<String> all = [bidirectional, downloadOnly, uploadOnly];

  /// 对应的多语言 key
  static String labelKey(String mode) {
    switch (mode) {
      case downloadOnly:
        return 'sync_mode_download_only';
      case uploadOnly:
        return 'sync_mode_upload_only';
      case bidirectional:
      default:
        return 'sync_mode_bidirectional';
    }
  }

  static String descKey(String mode) {
    switch (mode) {
      case downloadOnly:
        return 'sync_mode_download_only_desc';
      case uploadOnly:
        return 'sync_mode_upload_only_desc';
      case bidirectional:
      default:
        return 'sync_mode_bidirectional_desc';
    }
  }
}

/// 任务状态
class SyncStatus {
  static const String idle = 'idle';
  static const String running = 'running';
  static const String paused = 'paused';
  static const String error = 'error';

  static String labelKey(String status) {
    switch (status) {
      case running:
        return 'sync_status_running';
      case paused:
        return 'sync_status_paused';
      case error:
        return 'sync_status_error';
      case idle:
      default:
        return 'sync_status_idle';
    }
  }
}

int? parseTimeMs(dynamic v) {
  if (v == null) return null;
  if (v is DateTime) return v.millisecondsSinceEpoch;
  if (v is int) return v > 10000000000 ? v : v * 1000;
  if (v is num) {
    final n = v.toInt();
    return n > 10000000000 ? n : n * 1000;
  }
  final s = v.toString().trim();
  if (s.isEmpty) return null;
  final n = int.tryParse(s);
  if (n != null) return n > 10000000000 ? n : n * 1000;
  final dt = DateTime.tryParse(s);
  return dt?.millisecondsSinceEpoch;
}

String formatTimeMs(int? ms) {
  if (ms == null || ms <= 0) return '-';
  final local = DateTime.fromMillisecondsSinceEpoch(ms).toLocal();
  String two(int x) => x.toString().padLeft(2, '0');
  return '${local.year}-${two(local.month)}-${two(local.day)} '
      '${two(local.hour)}:${two(local.minute)}:${two(local.second)}';
}

String formatBytes(int bytes) {
  if (bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  double value = bytes.toDouble();
  int idx = 0;
  while (value >= 1024 && idx < units.length - 1) {
    value /= 1024;
    idx++;
  }
  final text = value >= 100 || idx == 0
      ? value.toStringAsFixed(0)
      : value.toStringAsFixed(1);
  return '$text ${units[idx]}';
}

const List<String> kSizeUnits = ['B', 'KB', 'MB', 'GB', 'TB'];

/// 过滤规则配置（对应截图中的「过滤规则」弹窗）
class SyncFilterConfig {
  bool excludeSmallEnabled;
  int excludeSmallSize;
  String excludeSmallUnit;
  bool excludeLargeEnabled;
  int excludeLargeSize;
  String excludeLargeUnit;
  bool excludeHidden;
  bool excludeExtensionEnabled;
  List<String> excludeExtensions;

  SyncFilterConfig({
    this.excludeSmallEnabled = false,
    this.excludeSmallSize = 10,
    this.excludeSmallUnit = 'KB',
    this.excludeLargeEnabled = false,
    this.excludeLargeSize = 10,
    this.excludeLargeUnit = 'GB',
    this.excludeHidden = true,
    this.excludeExtensionEnabled = true,
    List<String>? excludeExtensions,
  }) : excludeExtensions = excludeExtensions ?? <String>['lnk', 'pst', 'swp'];

  factory SyncFilterConfig.fromJson(dynamic raw) {
    final map = raw is Map ? raw : const <String, dynamic>{};
    List<String> ext = <String>['lnk', 'pst', 'swp'];
    final rawExt = map['excludeExtensions'];
    if (rawExt is List) {
      final list = rawExt
          .map((e) => e?.toString().trim().replaceFirst(RegExp(r'^\.'), '') ?? '')
          .where((e) => e.isNotEmpty)
          .map((e) => e.toLowerCase())
          .toList();
      if (list.isNotEmpty) ext = list;
    }
    final unitA = map['excludeSmallUnit']?.toString().toUpperCase() ?? 'KB';
    final unitB = map['excludeLargeUnit']?.toString().toUpperCase() ?? 'GB';
    return SyncFilterConfig(
      excludeSmallEnabled: map['excludeSmallEnabled'] == true,
      excludeSmallSize: int.tryParse(map['excludeSmallSize']?.toString() ?? '') ?? 10,
      excludeSmallUnit: kSizeUnits.contains(unitA) ? unitA : 'KB',
      excludeLargeEnabled: map['excludeLargeEnabled'] == true,
      excludeLargeSize: int.tryParse(map['excludeLargeSize']?.toString() ?? '') ?? 10,
      excludeLargeUnit: kSizeUnits.contains(unitB) ? unitB : 'GB',
      excludeHidden: map['excludeHidden'] != false,
      excludeExtensionEnabled: map['excludeExtensionEnabled'] != false,
      excludeExtensions: ext,
    );
  }

  Map<String, dynamic> toJson() => {
        'excludeSmallEnabled': excludeSmallEnabled,
        'excludeSmallSize': excludeSmallSize,
        'excludeSmallUnit': excludeSmallUnit,
        'excludeLargeEnabled': excludeLargeEnabled,
        'excludeLargeSize': excludeLargeSize,
        'excludeLargeUnit': excludeLargeUnit,
        'excludeHidden': excludeHidden,
        'excludeExtensionEnabled': excludeExtensionEnabled,
        'excludeExtensions': excludeExtensions,
      };

  SyncFilterConfig clone() => SyncFilterConfig.fromJson(toJson());
}

/// 同步策略配置
class SyncConfig {
  /// 按需同步：本地目录变化时实时触发
  bool realtime;

  /// 定时同步间隔（分钟），0 表示不定时
  int intervalMinutes;

  /// 冲突处理策略：prefer_newer | prefer_local | prefer_remote
  String conflictStrategy;

  /// 是否传播删除（仅双向同步生效）
  bool deleteExtra;

  SyncConfig({
    this.realtime = false,
    this.intervalMinutes = 1,
    this.conflictStrategy = 'prefer_newer',
    this.deleteExtra = false,
  });

  factory SyncConfig.fromJson(dynamic raw) {
    final map = raw is Map ? raw : const <String, dynamic>{};
    final strategy = map['conflictStrategy']?.toString() ?? '';
    return SyncConfig(
      realtime: map['realtime'] == true,
      intervalMinutes:
          int.tryParse(map['intervalMinutes']?.toString() ?? '') ?? 1,
      conflictStrategy:
          ['prefer_newer', 'prefer_local', 'prefer_remote'].contains(strategy)
              ? strategy
              : 'prefer_newer',
      deleteExtra: map['deleteExtra'] == true,
    );
  }

  Map<String, dynamic> toJson() => {
        'realtime': realtime,
        'intervalMinutes': intervalMinutes,
        'conflictStrategy': conflictStrategy,
        'deleteExtra': deleteExtra,
      };
}

/// 同步任务
class SyncTask {
  final int id;
  final String name;
  final String mode;
  final String localDir;
  final String remoteDir;
  final String deviceId;
  final String deviceName;
  final SyncFilterConfig filterConfig;
  final SyncConfig syncConfig;
  final String status;
  final Map<String, dynamic>? progress;
  final int? lastSyncTime;
  final String lastError;
  final int? createTime;
  final int? updateTime;

  SyncTask({
    required this.id,
    required this.name,
    required this.mode,
    required this.localDir,
    required this.remoteDir,
    this.deviceId = '',
    this.deviceName = '',
    required this.filterConfig,
    required this.syncConfig,
    this.status = SyncStatus.idle,
    this.progress,
    this.lastSyncTime,
    this.lastError = '',
    this.createTime,
    this.updateTime,
  });

  factory SyncTask.fromMap(Map<String, dynamic> map) {
    return SyncTask(
      id: int.tryParse(map['id']?.toString() ?? '') ?? 0,
      name: map['name']?.toString() ?? '',
      mode: map['mode']?.toString() ?? SyncMode.bidirectional,
      localDir: map['local_dir']?.toString() ?? '',
      remoteDir: map['remote_dir']?.toString() ?? '',
      deviceId: map['device_id']?.toString() ?? '',
      deviceName: map['device_name']?.toString() ?? '',
      filterConfig: SyncFilterConfig.fromJson(map['filter_config']),
      syncConfig: SyncConfig.fromJson(map['sync_config']),
      status: map['status']?.toString() ?? SyncStatus.idle,
      progress: map['progress'] is Map
          ? Map<String, dynamic>.from(map['progress'] as Map)
          : null,
      lastSyncTime: parseTimeMs(map['last_sync_time']),
      lastError: map['last_error']?.toString() ?? '',
      createTime: parseTimeMs(map['create_time']),
      updateTime: parseTimeMs(map['update_time']),
    );
  }

  bool get isRunning => status == SyncStatus.running;

  Map<String, dynamic> toUpsertBody() => {
        'name': name,
        'mode': mode,
        'local_dir': localDir,
        'remote_dir': remoteDir,
        'filter_config': filterConfig.toJson(),
        'sync_config': syncConfig.toJson(),
        if (deviceId.isNotEmpty) 'device_id': deviceId,
        if (deviceName.isNotEmpty) 'device_name': deviceName,
      };
}

/// 同步计划中的单个文件项
class SyncFileItem {
  final String relPath;
  final int size;
  final int mtimeMs;
  final String reason;

  SyncFileItem({
    required this.relPath,
    this.size = 0,
    this.mtimeMs = 0,
    this.reason = '',
  });

  /// 服务端的时间戳来自 Node 的 `fs.stat().mtimeMs`，是**带小数**的 Number
  /// （NTFS 100ns 精度，序列化后形如 `1772382172000.5`）。
  /// `int.tryParse` 不接受小数点、直接返回 null；一旦被当成 0，下载完成后就
  /// 不会回写本地修改时间，本地 mtime 恒等于「写入时刻」，下一轮比对仍判
  /// 「远端更新」⇒ 同一批文件每轮重新下载，永远不收敛。必须按 num 解析。
  static int _toMs(dynamic v) {
    if (v == null) return 0;
    if (v is int) return v;
    if (v is num) return v.toInt();
    final s = v.toString().trim();
    if (s.isEmpty) return 0;
    return int.tryParse(s) ?? num.tryParse(s)?.toInt() ?? 0;
  }

  factory SyncFileItem.fromMap(Map<String, dynamic> map) => SyncFileItem(
        relPath: map['relPath']?.toString() ?? '',
        size: _toMs(map['size']),
        mtimeMs: _toMs(map['mtimeMs']),
        reason: map['reason']?.toString() ?? '',
      );
}

/// 同步计划
class SyncPlan {
  final String sessionId;
  final int taskId;
  final String mode;
  final String remoteDir;
  final Map<String, dynamic> summary;
  final List<SyncFileItem> upload;
  final List<SyncFileItem> download;
  final List<String> deleteRemote;
  final List<String> deleteLocal;
  final List<Map<String, dynamic>> conflicts;

  SyncPlan({
    required this.sessionId,
    required this.taskId,
    required this.mode,
    required this.remoteDir,
    required this.summary,
    required this.upload,
    required this.download,
    required this.deleteRemote,
    required this.deleteLocal,
    required this.conflicts,
  });

  static List<SyncFileItem> _items(dynamic raw) {
    if (raw is! List) return <SyncFileItem>[];
    return raw
        .whereType<Map>()
        .map((e) => SyncFileItem.fromMap(Map<String, dynamic>.from(e)))
        .where((e) => e.relPath.isNotEmpty)
        .toList();
  }

  static List<String> _paths(dynamic raw) {
    if (raw is! List) return <String>[];
    return raw.map((e) => e?.toString() ?? '').where((e) => e.isNotEmpty).toList();
  }

  factory SyncPlan.fromMap(Map<String, dynamic> map) => SyncPlan(
        sessionId: map['sessionId']?.toString() ?? '',
        taskId: int.tryParse(map['taskId']?.toString() ?? '') ?? 0,
        mode: map['mode']?.toString() ?? SyncMode.bidirectional,
        remoteDir: map['remoteDir']?.toString() ?? '',
        summary: map['summary'] is Map
            ? Map<String, dynamic>.from(map['summary'] as Map)
            : <String, dynamic>{},
        upload: _items(map['upload']),
        download: _items(map['download']),
        deleteRemote: _paths(map['deleteRemote']),
        deleteLocal: _paths(map['deleteLocal']),
        conflicts: map['conflicts'] is List
            ? (map['conflicts'] as List)
                .whereType<Map>()
                .map((e) => Map<String, dynamic>.from(e))
                .toList()
            : <Map<String, dynamic>>[],
      );

  int get totalActions =>
      upload.length + download.length + deleteRemote.length + deleteLocal.length;

  bool get isEmpty => totalActions == 0;

  int count(String key) {
    final v = summary[key];
    if (v is num) return v.toInt();
    return int.tryParse(v?.toString() ?? '') ?? 0;
  }
}

/// 同步运行记录
class SyncRecord {
  final int id;
  final int taskId;
  final int? startTime;
  final int? endTime;
  final String status;
  final int uploadCount;
  final int downloadCount;
  final int deleteCount;
  final int skipCount;
  final int failCount;
  final int bytesTransferred;
  final List<String> errorList;
  final int durationMs;

  SyncRecord({
    required this.id,
    required this.taskId,
    this.startTime,
    this.endTime,
    this.status = '',
    this.uploadCount = 0,
    this.downloadCount = 0,
    this.deleteCount = 0,
    this.skipCount = 0,
    this.failCount = 0,
    this.bytesTransferred = 0,
    this.errorList = const [],
    this.durationMs = 0,
  });

  factory SyncRecord.fromMap(Map<String, dynamic> map) {
    int asInt(dynamic v) => int.tryParse(v?.toString() ?? '') ?? 0;
    return SyncRecord(
      id: asInt(map['id']),
      taskId: asInt(map['task_id']),
      startTime: parseTimeMs(map['start_time']),
      endTime: parseTimeMs(map['end_time']),
      status: map['status']?.toString() ?? '',
      uploadCount: asInt(map['upload_count']),
      downloadCount: asInt(map['download_count']),
      deleteCount: asInt(map['delete_count']),
      skipCount: asInt(map['skip_count']),
      failCount: asInt(map['fail_count']),
      bytesTransferred: asInt(map['bytes_transferred']),
      errorList: map['error_list'] is List
          ? (map['error_list'] as List).map((e) => e?.toString() ?? '').toList()
          : <String>[],
      durationMs: asInt(map['duration_ms']),
    );
  }

  bool get isSuccess => status == 'success';
  bool get isFailed => status == 'failed';
}

/// 客户端本地上报的文件条目
class LocalFileEntry {
  final String relPath;
  final int size;
  final int mtimeMs;

  const LocalFileEntry({
    required this.relPath,
    required this.size,
    required this.mtimeMs,
  });

  Map<String, dynamic> toJson() => {
        'relPath': relPath,
        'size': size,
        'mtimeMs': mtimeMs,
      };
}
