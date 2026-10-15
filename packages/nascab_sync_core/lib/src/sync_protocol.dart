import 'sync_models.dart';

/// 同步模块的全部后端路由。
///
/// 主客户端与独立客户端都从这里取路径，避免两边各写一份字符串而漂移。
class SyncEndpoint {
  SyncEndpoint._();

  static const String list = '/api/sync/list';
  static const String summary = '/api/sync/summary';
  static const String get = '/api/sync/get';
  static const String upsert = '/api/sync/upsert';
  static const String remove = '/api/sync/delete';
  static const String status = '/api/sync/status';
  static const String recordsList = '/api/sync/records/list';
  static const String probe = '/api/sync/probe';
  static const String plan = '/api/sync/plan';
  static const String report = '/api/sync/report';
  static const String deleteRemote = '/api/sync/deleteRemote';
  static const String mkdir = '/api/sync/mkdir';

  /// 把旧版本（未绑定主机）创建的同步任务认领到本机。
  static const String claimLegacy = '/api/sync/device/claimLegacy';

  /// 建议超时（毫秒）。放这里是为了两端一致，避免一边 3 分钟一边 30 秒。
  static const int listTimeoutMs = 30000;
  static const int summaryTimeoutMs = 30000;
  static const int getTimeoutMs = 30000;
  static const int upsertTimeoutMs = 30000;
  static const int removeTimeoutMs = 30000;
  static const int statusTimeoutMs = 30000;
  static const int recordsListTimeoutMs = 30000;
  static const int probeTimeoutMs = 60000;
  static const int planTimeoutMs = 180000;
  static const int reportTimeoutMs = 30000;
  static const int deleteRemoteTimeoutMs = 120000;
  static const int mkdirTimeoutMs = 60000;
  static const int claimLegacyTimeoutMs = 30000;
}

/// 请求体构造器。
///
/// 字段名（local_dir / rel_paths / …）是服务端契约的一部分，只能在这里改一次。
///
/// ⭐ 设备隔离（2026-10-12）：每个请求体都带 `device_id` + `device_bound`。
/// 服务端据此把同步任务 / 记录 / 统计全部收敛到「本机 + 本账号」范围内：
///   - `device_bound: true`  = 新协议，服务端按 (uid, `m:<device_id>`) 精确归属；
///   - 两者都缺省            = 旧客户端，服务端按「未绑定桶」兼容处理（过渡期）。
/// 旧客户端只在 upsert 上传 device_id，不会传 device_bound，因此可被明确区分。
class SyncProtocol {
  SyncProtocol._();

  /// v2 协议标记：带上它就表示「本客户端按设备隔离语义通信」。
  static const bool deviceBoundV2 = true;

  static Map<String, dynamic> listBody({
    int page = 1,
    int? pageSize,
    String? status,
    String? mode,
    String? keyword,
    String? sortBy,
    String? sortOrder,
    String? deviceId,
  }) {
    return {
      'page': page,
      if (pageSize != null) 'pageSize': pageSize,
      if (status != null) 'status': status,
      if (mode != null) 'mode': mode,
      if (keyword != null) 'keyword': keyword,
      if (sortBy != null) 'sort_by': sortBy,
      if (sortOrder != null) 'sort_order': sortOrder,
      if (deviceId != null && deviceId.isNotEmpty) 'device_id': deviceId,
      if (deviceId != null && deviceId.isNotEmpty) 'device_bound': deviceBoundV2,
    };
  }

  static Map<String, dynamic> summaryBody({String? deviceId}) {
    return {
      if (deviceId != null && deviceId.isNotEmpty) 'device_id': deviceId,
      if (deviceId != null && deviceId.isNotEmpty) 'device_bound': deviceBoundV2,
    };
  }

  static Map<String, dynamic> getBody({required int id, String? deviceId}) =>
      _withDevice({'id': id}, deviceId);

  static Map<String, dynamic> upsertBody({
    int? id,
    required String name,
    required String mode,
    required String localDir,
    required String remoteDir,
    required SyncFilterConfig filterConfig,
    required SyncConfig syncConfig,
    String? deviceId,
    String? deviceName,
  }) {
    return _withDevice({
      if (id != null) 'id': id,
      'name': name,
      'mode': mode,
      'local_dir': localDir,
      'remote_dir': remoteDir,
      'filter_config': filterConfig.toJson(),
      'sync_config': syncConfig.toJson(),
      if (deviceId != null && deviceId.isNotEmpty) 'device_id': deviceId,
      if (deviceName != null && deviceName.isNotEmpty) 'device_name': deviceName,
    }, deviceId);
  }

  static Map<String, dynamic> deleteBody({required int id, String? deviceId}) =>
      _withDevice({'id': id}, deviceId);

  static Map<String, dynamic> statusBody({
    required int id,
    String? status,
    Map<String, dynamic>? progress,
    String? lastError,
    String? deviceId,
  }) {
    return _withDevice({
      'id': id,
      if (status != null) 'status': status,
      if (progress != null) 'progress': progress,
      if (lastError != null) 'last_error': lastError,
    }, deviceId);
  }

  static Map<String, dynamic> recordsListBody({
    required int taskId,
    int page = 1,
    int pageSize = 50,
    String? deviceId,
  }) =>
      _withDevice({'id': taskId, 'page': page, 'pageSize': pageSize}, deviceId);

  static Map<String, dynamic> probeBody({required String path}) =>
      {'path': path};

  static Map<String, dynamic> planBody({
    required int id,
    required List<LocalFileEntry> localFiles,
    List<LocalFileEntry> baselineFiles = const [],
    int? maxListPerType,
    String? deviceId,
  }) {
    return _withDevice({
      'id': id,
      'local_files': localFiles.map((e) => e.toJson()).toList(),
      'baseline_files': baselineFiles.map((e) => e.toJson()).toList(),
      if (maxListPerType != null) 'max_list_per_type': maxListPerType,
    }, deviceId);
  }

  static Map<String, dynamic> reportBody({
    required int id,
    required int startTime,
    required int endTime,
    required String status,
    int uploadCount = 0,
    int downloadCount = 0,
    int deleteCount = 0,
    int skipCount = 0,
    int failCount = 0,
    int bytesTransferred = 0,
    List<String> errorList = const [],
    String? deviceId,
  }) {
    return _withDevice({
      'id': id,
      'start_time': startTime,
      'end_time': endTime,
      'status': status,
      'upload_count': uploadCount,
      'download_count': downloadCount,
      'delete_count': deleteCount,
      'skip_count': skipCount,
      'fail_count': failCount,
      'bytes_transferred': bytesTransferred,
      'error_list': errorList,
    }, deviceId);
  }

  static Map<String, dynamic> deleteRemoteBody({
    required int id,
    required List<String> relPaths,
    String? deviceId,
  }) =>
      _withDevice({'id': id, 'rel_paths': relPaths}, deviceId);

  static Map<String, dynamic> mkdirBody({
    required int id,
    required String relPath,
    String? deviceId,
  }) =>
      _withDevice({'id': id, 'rel_path': relPath}, deviceId);

  static Map<String, dynamic> claimLegacyBody({
    required String deviceId,
    String? deviceName,
  }) {
    return {
      'device_id': deviceId,
      'device_bound': deviceBoundV2,
      if (deviceName != null && deviceName.isNotEmpty) 'device_name': deviceName,
    };
  }

  /// 统一给请求体补上设备字段（v2 客户端专用；旧客户端不传 deviceId 即可）。
  static Map<String, dynamic> _withDevice(
    Map<String, dynamic> body,
    String? deviceId,
  ) {
    if (deviceId == null || deviceId.isEmpty) return body;
    return {...body, 'device_id': deviceId, 'device_bound': deviceBoundV2};
  }
}
