import 'package:get/get.dart';
import 'package:nascab_sync_core/nascab_sync_core.dart';

import '../../../core/api/base_api_service.dart';

/// 目录同步（电脑 <-> NAS）后端接口。
///
/// 路径与请求体字段由共享包 [SyncProtocol] / [SyncEndpoint] 统一提供，
/// 与 Windows 独立同步客户端（sync_client）保持同一份协议定义；
/// 这里只负责把它接到主客户端自己的 HTTP 封装（loading、重试、通道切换弹窗）上。
///
/// ⭐ 设备隔离（2026-10-12）：每个请求都带 `device_id`（本机机器级标识，
/// 见 [SyncDeviceId]）。服务端据此把任务 / 记录 / 统计全部收敛到
/// 「本机 + 本账号」——同一台机器上的主客户端与独立同步客户端互通，
/// 换机器（哪怕同账号）互不相通。
class SyncApiService extends BaseApiService {
  static SyncApiService get instance => Get.find<SyncApiService>();

  /// 本机设备标识（同一台机器上两个客户端解析结果一致）。
  Future<String> _deviceId() => SyncDeviceId.resolve();

  Future<ApiResponse<Map<String, dynamic>>> list({
    int page = 1,
    int? pageSize,
    String? status,
    String? mode,
    String? keyword,
    String? sortBy,
    String? sortOrder,
  }) async {
    final deviceId = await _deviceId();
    return apiPost<Map<String, dynamic>>(
      SyncEndpoint.list,
      body: SyncProtocol.listBody(
        page: page,
        pageSize: pageSize,
        status: status,
        mode: mode,
        keyword: keyword,
        sortBy: sortBy,
        sortOrder: sortOrder,
        deviceId: deviceId,
      ),
      showLoading: false,
    );
  }

  Future<ApiResponse<Map<String, dynamic>>> summary() async {
    final deviceId = await _deviceId();
    return apiPost<Map<String, dynamic>>(
      SyncEndpoint.summary,
      body: SyncProtocol.summaryBody(deviceId: deviceId),
      showLoading: false,
    );
  }

  Future<ApiResponse<Map<String, dynamic>>> get({required int id}) async {
    final deviceId = await _deviceId();
    return apiPost<Map<String, dynamic>>(
      SyncEndpoint.get,
      body: SyncProtocol.getBody(id: id, deviceId: deviceId),
      showLoading: false,
    );
  }

  Future<ApiResponse<Map<String, dynamic>>> upsert({
    int? id,
    required String name,
    required String mode,
    required String localDir,
    required String remoteDir,
    required SyncFilterConfig filterConfig,
    required SyncConfig syncConfig,
    String? deviceId,
    String? deviceName,
  }) async {
    final device = deviceId ?? await _deviceId();
    return apiPost<Map<String, dynamic>>(
      SyncEndpoint.upsert,
      body: SyncProtocol.upsertBody(
        id: id,
        name: name,
        mode: mode,
        localDir: localDir,
        remoteDir: remoteDir,
        filterConfig: filterConfig,
        syncConfig: syncConfig,
        deviceId: device,
        deviceName: deviceName,
      ),
    );
  }

  Future<ApiResponse<Map<String, dynamic>>> delete({required int id}) async {
    final deviceId = await _deviceId();
    return apiPost<Map<String, dynamic>>(
      SyncEndpoint.remove,
      body: SyncProtocol.deleteBody(id: id, deviceId: deviceId),
    );
  }

  Future<ApiResponse<Map<String, dynamic>>> updateStatus({
    required int id,
    String? status,
    Map<String, dynamic>? progress,
    String? lastError,
  }) async {
    final deviceId = await _deviceId();
    return apiPost<Map<String, dynamic>>(
      SyncEndpoint.status,
      body: SyncProtocol.statusBody(
        id: id,
        status: status,
        progress: progress,
        lastError: lastError,
        deviceId: deviceId,
      ),
      showLoading: false,
    );
  }

  Future<ApiResponse<Map<String, dynamic>>> listRecords({
    required int taskId,
    int page = 1,
    int pageSize = 50,
  }) async {
    final deviceId = await _deviceId();
    return apiPost<Map<String, dynamic>>(
      SyncEndpoint.recordsList,
      body: SyncProtocol.recordsListBody(
        taskId: taskId,
        page: page,
        pageSize: pageSize,
        deviceId: deviceId,
      ),
      showLoading: false,
    );
  }

  /// 探测 NAS 侧目录是否可用
  Future<ApiResponse<Map<String, dynamic>>> probe({required String path}) {
    return apiPost<Map<String, dynamic>>(
      SyncEndpoint.probe,
      body: SyncProtocol.probeBody(path: path),
      timeout: const Duration(milliseconds: SyncEndpoint.probeTimeoutMs),
      showLoading: false,
    );
  }

  /// 提交本地清单，获取同步计划（服务端负责与 NAS 目录比对）
  Future<ApiResponse<Map<String, dynamic>>> plan({
    required int id,
    required List<LocalFileEntry> localFiles,
    List<LocalFileEntry> baselineFiles = const [],
    int? maxListPerType,
  }) async {
    final deviceId = await _deviceId();
    return apiPost<Map<String, dynamic>>(
      SyncEndpoint.plan,
      body: SyncProtocol.planBody(
        id: id,
        localFiles: localFiles,
        baselineFiles: baselineFiles,
        maxListPerType: maxListPerType,
        deviceId: deviceId,
      ),
      timeout: const Duration(milliseconds: SyncEndpoint.planTimeoutMs),
      maxRetries: 0,
      showLoading: false,
      showNetworkIssueOnFailure: false,
    );
  }

  /// 回写一轮同步结果
  Future<ApiResponse<Map<String, dynamic>>> report({
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
  }) async {
    final deviceId = await _deviceId();
    return apiPost<Map<String, dynamic>>(
      SyncEndpoint.report,
      body: SyncProtocol.reportBody(
        id: id,
        startTime: startTime,
        endTime: endTime,
        status: status,
        uploadCount: uploadCount,
        downloadCount: downloadCount,
        deleteCount: deleteCount,
        skipCount: skipCount,
        failCount: failCount,
        bytesTransferred: bytesTransferred,
        errorList: errorList,
        deviceId: deviceId,
      ),
      timeout: const Duration(milliseconds: SyncEndpoint.reportTimeoutMs),
      showLoading: false,
      showNetworkIssueOnFailure: false,
    );
  }

  /// 删除 NAS 侧文件（同步计划中的 deleteRemote）
  Future<ApiResponse<Map<String, dynamic>>> deleteRemote({
    required int id,
    required List<String> relPaths,
  }) async {
    final deviceId = await _deviceId();
    return apiPost<Map<String, dynamic>>(
      SyncEndpoint.deleteRemote,
      body: SyncProtocol.deleteRemoteBody(id: id, relPaths: relPaths, deviceId: deviceId),
      timeout: const Duration(milliseconds: SyncEndpoint.deleteRemoteTimeoutMs),
      showLoading: false,
      showNetworkIssueOnFailure: false,
    );
  }

  /// 在 NAS 侧创建目录
  Future<ApiResponse<Map<String, dynamic>>> mkdir({
    required int id,
    required String relPath,
  }) async {
    final deviceId = await _deviceId();
    return apiPost<Map<String, dynamic>>(
      SyncEndpoint.mkdir,
      body: SyncProtocol.mkdirBody(id: id, relPath: relPath, deviceId: deviceId),
      timeout: const Duration(milliseconds: SyncEndpoint.mkdirTimeoutMs),
      showLoading: false,
    );
  }

  /// 认领旧版任务：把本账号下「未绑定主机」的任务划到本机名下。
  Future<ApiResponse<Map<String, dynamic>>> claimLegacy() async {
    final deviceId = await _deviceId();
    final deviceName = await SyncDeviceId.resolveName();
    return apiPost<Map<String, dynamic>>(
      SyncEndpoint.claimLegacy,
      body: SyncProtocol.claimLegacyBody(deviceId: deviceId, deviceName: deviceName),
      timeout: const Duration(milliseconds: SyncEndpoint.claimLegacyTimeoutMs),
    );
  }
}
