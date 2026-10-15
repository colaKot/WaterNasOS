import 'dart:convert';

enum PhotoBackupSourceType { album, folder }

enum PhotoBackupRunTrigger { uploadNew, uploadAll, autoStart }

/// 备份目录偏好。
/// - [byAlbum] 保留本地相册分类结构（在目标目录下按相册名建子目录）
/// - [byMonth] 按年/月归档（服务端按拍摄时间生成 `YYYY/MM/`）
/// - [byYear]  按年归档（服务端按拍摄时间生成 `YYYY/`）
enum PhotoBackupDirStyle { byAlbum, byMonth, byYear }

/// 相册备份的**唯一**任务（整机相册共用一份配置，不再支持多任务）。
class PhotoBackupTask {
  final int id;
  final String serverId;
  final int userId;
  final String name;
  final PhotoBackupSourceType sourceType;

  /// 单个来源 id（文件夹来源时使用）
  final String sourceId;
  final String sourceName;

  /// 选中的手机相册 id 列表；为空表示「全部」（扫描系统「所有照片」）。
  final List<String> sourceIds;

  /// 与 [sourceIds] 一一对应的相册名（用于「按相册」归档）。
  final List<String> sourceNames;

  final String targetDir;
  final String nameStrategy;
  final String saveType;
  final bool uploadLivePhotoVideo;
  final bool autoStartOnLaunch;

  /// 备份总开关：开启后 App 打开/联网可用时自动跑一轮。
  final bool enabled;

  /// 仅备份照片（过滤视频）。
  final bool onlyPhotos;

  /// 按拍摄日期重命名（IMG_yyyyMMdd_HHmmss）。
  final bool renameByDate;

  /// 允许使用流量备份。
  final bool useCellular;

  /// 节能备份（低电量自动暂停）。
  final bool savingMode;

  /// 不熄屏备份。
  final bool keepScreenOn;

  /// 本机设备名（用于默认备份目录 `<相册源根>/<设备名>`）。
  final String deviceName;

  final int createdAtMs;
  final int updatedAtMs;

  const PhotoBackupTask({
    required this.id,
    required this.serverId,
    required this.userId,
    required this.name,
    required this.sourceType,
    required this.sourceId,
    required this.sourceName,
    required this.sourceIds,
    required this.sourceNames,
    required this.targetDir,
    required this.nameStrategy,
    required this.saveType,
    required this.uploadLivePhotoVideo,
    required this.autoStartOnLaunch,
    required this.enabled,
    required this.onlyPhotos,
    required this.renameByDate,
    required this.useCellular,
    required this.savingMode,
    required this.keepScreenOn,
    required this.deviceName,
    required this.createdAtMs,
    required this.updatedAtMs,
  });

  /// 目录偏好（由 saveType 映射）。
  PhotoBackupDirStyle get dirStyle {
    final v = saveType.trim().toLowerCase();
    if (v == 'month') return PhotoBackupDirStyle.byMonth;
    if (v == 'year') return PhotoBackupDirStyle.byYear;
    return PhotoBackupDirStyle.byAlbum;
  }

  static List<String> _asStringList(Object? value) {
    final raw = (value ?? '').toString().trim();
    if (raw.isEmpty) return const <String>[];
    try {
      final decoded = jsonDecode(raw);
      if (decoded is List) {
        return decoded
            .map((e) => e.toString().trim())
            .where((e) => e.isNotEmpty)
            .toList(growable: false);
      }
    } catch (_) {
      // 兼容旧数据：曾用 'a,b' 之类的朴素分隔
      return raw
          .split(',')
          .map((e) => e.trim())
          .where((e) => e.isNotEmpty)
          .toList(growable: false);
    }
    return const <String>[];
  }

  static PhotoBackupTask fromMap(Map<String, Object?> row) {
    int asInt(Object? value, int fallback) {
      if (value is int) return value;
      if (value is num) return value.toInt();
      return int.tryParse(value?.toString() ?? '') ?? fallback;
    }

    final sourceTypeRaw = (row['source_type']?.toString() ?? '').trim();
    final sourceType = sourceTypeRaw == 'album'
        ? PhotoBackupSourceType.album
        : PhotoBackupSourceType.folder;

    return PhotoBackupTask(
      id: asInt(row['id'], 0),
      serverId: (row['server_id']?.toString() ?? '').trim(),
      userId: asInt(row['user_id'], 0),
      name: (row['name']?.toString() ?? '').trim(),
      sourceType: sourceType,
      sourceId: (row['source_id']?.toString() ?? '').trim(),
      sourceName: (row['source_name']?.toString() ?? '').trim(),
      sourceIds: _asStringList(row['source_ids']),
      sourceNames: _asStringList(row['source_names']),
      targetDir: (row['target_dir']?.toString() ?? '').trim(),
      nameStrategy: (row['name_strategy']?.toString() ?? 'skip').trim(),
      saveType: (row['save_type']?.toString() ?? '').trim(),
      uploadLivePhotoVideo: asInt(row['upload_live_photo_video'], 0) == 1,
      autoStartOnLaunch: asInt(row['auto_start_on_launch'], 0) == 1,
      enabled: asInt(row['enabled'], 0) == 1,
      onlyPhotos: asInt(row['only_photos'], 0) == 1,
      renameByDate: asInt(row['rename_by_date'], 0) == 1,
      useCellular: asInt(row['use_cellular'], 0) == 1,
      savingMode: asInt(row['saving_mode'], 1) == 1,
      keepScreenOn: asInt(row['keep_screen_on'], 1) == 1,
      deviceName: (row['device_name']?.toString() ?? '').trim(),
      createdAtMs: asInt(row['created_at_ms'], 0),
      updatedAtMs: asInt(row['updated_at_ms'], 0),
    );
  }

  PhotoBackupTask copyWith({
    List<String>? sourceIds,
    List<String>? sourceNames,
    String? targetDir,
    String? saveType,
    bool? uploadLivePhotoVideo,
    bool? autoStartOnLaunch,
    bool? enabled,
    bool? onlyPhotos,
    bool? renameByDate,
    bool? useCellular,
    bool? savingMode,
    bool? keepScreenOn,
    String? deviceName,
    String? nameStrategy,
  }) {
    return PhotoBackupTask(
      id: id,
      serverId: serverId,
      userId: userId,
      name: name,
      sourceType: sourceType,
      sourceId: sourceId,
      sourceName: sourceName,
      sourceIds: sourceIds ?? this.sourceIds,
      sourceNames: sourceNames ?? this.sourceNames,
      targetDir: targetDir ?? this.targetDir,
      nameStrategy: nameStrategy ?? this.nameStrategy,
      saveType: saveType ?? this.saveType,
      uploadLivePhotoVideo: uploadLivePhotoVideo ?? this.uploadLivePhotoVideo,
      autoStartOnLaunch: autoStartOnLaunch ?? this.autoStartOnLaunch,
      enabled: enabled ?? this.enabled,
      onlyPhotos: onlyPhotos ?? this.onlyPhotos,
      renameByDate: renameByDate ?? this.renameByDate,
      useCellular: useCellular ?? this.useCellular,
      savingMode: savingMode ?? this.savingMode,
      keepScreenOn: keepScreenOn ?? this.keepScreenOn,
      deviceName: deviceName ?? this.deviceName,
      createdAtMs: createdAtMs,
      updatedAtMs: updatedAtMs,
    );
  }
}

class PhotoBackupRunRecord {
  final int id;
  final int taskId;
  final String triggerType;
  final int startedAtMs;
  final int finishedAtMs;
  final int successCount;
  final int failedCount;
  final int totalBytes;

  const PhotoBackupRunRecord({
    required this.id,
    required this.taskId,
    required this.triggerType,
    required this.startedAtMs,
    required this.finishedAtMs,
    required this.successCount,
    required this.failedCount,
    required this.totalBytes,
  });

  static PhotoBackupRunRecord fromMap(Map<String, Object?> row) {
    int asInt(Object? value, int fallback) {
      if (value is int) return value;
      if (value is num) return value.toInt();
      return int.tryParse(value?.toString() ?? '') ?? fallback;
    }

    return PhotoBackupRunRecord(
      id: asInt(row['id'], 0),
      taskId: asInt(row['task_id'], 0),
      triggerType: (row['trigger_type']?.toString() ?? '').trim(),
      startedAtMs: asInt(row['started_at_ms'], 0),
      finishedAtMs: asInt(row['finished_at_ms'], 0),
      successCount: asInt(row['success_count'], 0),
      failedCount: asInt(row['failed_count'], 0),
      totalBytes: asInt(row['total_bytes'], 0),
    );
  }
}

class PhotoBackupFileRecord {
  final int id;
  final int taskId;
  final int runId;
  final String sourceUniqueId;
  final String displayName;
  final String localPath;
  final int size;
  final int sourceCreateAtMs;
  final int uploadedAtMs;
  final String status;
  final String error;

  const PhotoBackupFileRecord({
    required this.id,
    required this.taskId,
    required this.runId,
    required this.sourceUniqueId,
    required this.displayName,
    required this.localPath,
    required this.size,
    required this.sourceCreateAtMs,
    required this.uploadedAtMs,
    required this.status,
    required this.error,
  });

  /// 是否因「内容重复」被跳过（不占用云端空间，也不算失败）。
  bool get isSkipped => status == 'skipped';

  static PhotoBackupFileRecord fromMap(Map<String, Object?> row) {
    int asInt(Object? value, int fallback) {
      if (value is int) return value;
      if (value is num) return value.toInt();
      return int.tryParse(value?.toString() ?? '') ?? fallback;
    }

    return PhotoBackupFileRecord(
      id: asInt(row['id'], 0),
      taskId: asInt(row['task_id'], 0),
      runId: asInt(row['run_id'], 0),
      sourceUniqueId: (row['source_unique_id']?.toString() ?? '').trim(),
      displayName: (row['display_name']?.toString() ?? '').trim(),
      localPath: (row['local_path']?.toString() ?? '').trim(),
      size: asInt(row['size'], 0),
      sourceCreateAtMs: asInt(row['source_create_at_ms'], 0),
      uploadedAtMs: asInt(row['uploaded_at_ms'], 0),
      status: (row['status']?.toString() ?? '').trim(),
      error: (row['error']?.toString() ?? '').trim(),
    );
  }
}
