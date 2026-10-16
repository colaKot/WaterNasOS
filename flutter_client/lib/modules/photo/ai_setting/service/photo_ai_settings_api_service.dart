import 'package:get/get.dart';
import '../../../../core/api/base_api_service.dart';

class PhotoAiSettingsApiService extends BaseApiService {
  static PhotoAiSettingsApiService get instance =>
      Get.isRegistered<PhotoAiSettingsApiService>()
      ? Get.find<PhotoAiSettingsApiService>()
      : PhotoAiSettingsApiService();

  Future<ApiResponse<Map<String, dynamic>>> getAiConfig({
    bool showLoading = false,
  }) {
    return apiPost<Map<String, dynamic>>(
      '/api/photo/getAiConfig',
      body: {},
      showLoading: showLoading,
    );
  }

  // ---------------------------------------------------------------------------
  // 2026-10-16 P2-18/P2-20 开放平台：MCP 服务配置 + 模型 API（Agent 用）
  // MCP 的三个管理接口在 /api/mcp/*（走登录 JWT + 超管）；模型 API 在 /api/photo/app_ai/model_api/*
  // ---------------------------------------------------------------------------

  /// 读 MCP 服务状态（开关 / 令牌掩码 / 归属用户 / 工具清单）
  Future<ApiResponse<Map<String, dynamic>>> getMcpStatus() {
    return apiPost<Map<String, dynamic>>('/api/mcp/status', body: {}, showLoading: false);
  }

  /// 改 MCP 开关 / 归属用户（只传要改的字段）
  Future<ApiResponse<Map<String, dynamic>>> setMcpConfig({bool? enabled, int? uid}) {
    return apiPost<Map<String, dynamic>>(
      '/api/mcp/config/set',
      body: {
        if (enabled != null) 'enabled': enabled ? 1 : 0,
        if (uid != null) 'uid': uid,
      },
    );
  }

  /// 轮换令牌：旧令牌立即失效；**明文只在这次响应里出现一次**
  Future<ApiResponse<Map<String, dynamic>>> rotateMcpToken() {
    return apiPost<Map<String, dynamic>>('/api/mcp/token/rotate', body: {});
  }

  /// 读模型 API 配置（api_key 只回掩码）
  Future<ApiResponse<Map<String, dynamic>>> getModelApi() {
    return apiPost<Map<String, dynamic>>('/api/photo/app_ai/model_api/get', body: {}, showLoading: false);
  }

  /// 保存模型 API 配置（apiKey 传空 = 保留已存的密钥）
  Future<ApiResponse<Map<String, dynamic>>> setModelApi({
    String? baseUrl,
    String? apiKey,
    String? model,
  }) {
    return apiPost<Map<String, dynamic>>(
      '/api/photo/app_ai/model_api/set',
      body: {
        if (baseUrl != null) 'base_url': baseUrl,
        if (apiKey != null && apiKey.trim().isNotEmpty) 'api_key': apiKey.trim(),
        if (model != null) 'model': model,
      },
    );
  }

  /// 真发一次请求验证凭据（服务端走全局代理）
  Future<ApiResponse<Map<String, dynamic>>> testModelApi({
    String? baseUrl,
    String? apiKey,
    String? model,
  }) {
    return apiPost<Map<String, dynamic>>(
      '/api/photo/app_ai/model_api/test',
      body: {
        if (baseUrl != null) 'base_url': baseUrl,
        if (apiKey != null && apiKey.trim().isNotEmpty) 'api_key': apiKey.trim(),
        if (model != null) 'model': model,
      },
      showLoading: false,
    );
  }

  /// ⭐ 2026-10-16 P1-9：暂停 / 恢复 AI 流水线（暂停时 worker 写完当前这张就退出，队列标记保留）
  Future<ApiResponse<Map<String, dynamic>>> setQueuePaused(bool paused) {
    return apiPost<Map<String, dynamic>>(
      '/api/photo/app_ai/queue/pause',
      body: {'paused': paused ? 1 : 0},
    );
  }

  /// ⭐ 2026-10-16 P1-9：AI 任务进度聚合（待处理 / 已完成 / 百分比 / worker 是否在跑）。
  Future<ApiResponse<Map<String, dynamic>>> getQueueStatus({
    bool showLoading = false,
  }) {
    return apiPost<Map<String, dynamic>>(
      '/api/photo/app_ai/queue',
      body: {},
      showLoading: showLoading,
    );
  }

  // ---------------------------------------------------------------------------
  // 2026-10-16 P1/P2 照片域「智能发现」：全部对应 /api/photo/app_ai/* 的只读聚合
  // ---------------------------------------------------------------------------

  /// P1-17 一日一帧
  Future<ApiResponse<Map<String, dynamic>>> getDayFrames({int days = 30}) {
    return apiPost<Map<String, dynamic>>('/api/photo/app_ai/day_frames', body: {'days': days}, showLoading: false);
  }

  /// P1-13 票据与行程（轻量版）
  Future<ApiResponse<Map<String, dynamic>>> getTickets({int limit = 200}) {
    return apiPost<Map<String, dynamic>>('/api/photo/app_ai/tickets', body: {'limit': limit}, showLoading: false);
  }

  /// P1-14 记忆：候选 + 已确认
  Future<ApiResponse<Map<String, dynamic>>> getMemories({int days = 365, int minPhotos = 8}) {
    return apiPost<Map<String, dynamic>>('/api/photo/app_ai/memories', body: {'days': days, 'min_photos': minPhotos}, showLoading: false);
  }

  /// P1-14 记忆：确认保存
  Future<ApiResponse<Map<String, dynamic>>> saveMemory(Map<String, dynamic> memory) {
    return apiPost<Map<String, dynamic>>('/api/photo/app_ai/memory/save', body: memory);
  }

  /// P1-14 记忆：删除
  Future<ApiResponse<Map<String, dynamic>>> removeMemory(String key) {
    return apiPost<Map<String, dynamic>>('/api/photo/app_ai/memory/remove', body: {'key': key});
  }

  /// P1-16 重复照片工具箱（数据层）
  Future<ApiResponse<Map<String, dynamic>>> getDuplicates({int limit = 50}) {
    return apiPost<Map<String, dynamic>>('/api/photo/app_ai/duplicates', body: {'limit': limit}, showLoading: false);
  }

  /// P1-15 模型目录（只读）
  Future<ApiResponse<Map<String, dynamic>>> getModels() {
    return apiPost<Map<String, dynamic>>('/api/photo/app_ai/models', body: {}, showLoading: false);
  }

  /// P2-21 年度报告
  Future<ApiResponse<Map<String, dynamic>>> getYearReport(int year) {
    return apiPost<Map<String, dynamic>>('/api/photo/app_ai/year_report', body: {'year': year}, showLoading: false);
  }

  /// P1-10 足迹叙事层：访问片段 + 旅行连线
  Future<ApiResponse<Map<String, dynamic>>> getTravelLines({int? year, int precision = 5}) {
    return apiPost<Map<String, dynamic>>(
      '/api/photo/app_ai/travel_lines',
      body: {'year': year, 'precision': precision},
      showLoading: false,
    );
  }

  /// P1-11 时光对照：同一地点跨年份的相似照片
  Future<ApiResponse<Map<String, dynamic>>> getTimeCompare(String fileHash, {int limit = 20}) {
    return apiPost<Map<String, dynamic>>(
      '/api/photo/app_ai/time_compare',
      body: {'file_hash': fileHash, 'limit': limit},
      showLoading: true,
    );
  }

  Future<ApiResponse<Map<String, dynamic>>> setAiOcrEnable(
    bool enable, {
    bool showLoading = false,
  }) {
    return apiPost<Map<String, dynamic>>(
      '/api/photo/setAiOcrEnable',
      body: {'enable': enable ? 1 : 0},
      showLoading: showLoading,
    );
  }

  Future<ApiResponse<Map<String, dynamic>>> setAiPetEnable(
    bool enable, {
    bool showLoading = false,
  }) {
    return apiPost<Map<String, dynamic>>(
      '/api/photo/setAiPetEnable',
      body: {'enable': enable ? 1 : 0},
      showLoading: showLoading,
    );
  }

  Future<ApiResponse<Map<String, dynamic>>> setAiFaceEnable(
    bool enable, {
    bool showLoading = false,
  }) {
    return apiPost<Map<String, dynamic>>(
      '/api/photo/setAiFaceEnable',
      body: {'enable': enable ? 1 : 0},
      showLoading: showLoading,
    );
  }

  Future<ApiResponse<Map<String, dynamic>>> setAiPlaceEnable(
    bool enable, {
    bool showLoading = false,
  }) {
    return apiPost<Map<String, dynamic>>(
      '/api/photo/setAiPlaceEnable',
      body: {'enable': enable ? 1 : 0},
      showLoading: showLoading,
    );
  }

  Future<ApiResponse<Map<String, dynamic>>> setAiSimilarEnable(
    bool enable, {
    bool showLoading = false,
  }) {
    return apiPost<Map<String, dynamic>>(
      '/api/photo/setAiSimilarEnable',
      body: {'enable': enable ? 1 : 0},
      showLoading: showLoading,
    );
  }

  Future<ApiResponse<Map<String, dynamic>>> setAiGpuPrefer(
    bool enable, {
    bool showLoading = false,
  }) {
    return apiPost<Map<String, dynamic>>(
      '/api/photo/setAiGpuPrefer',
      body: {'enable': enable ? 1 : 0},
      showLoading: showLoading,
    );
  }

  Future<ApiResponse<Map<String, dynamic>>> resetSimilar({
    bool showLoading = false,
  }) {
    return apiPost<Map<String, dynamic>>(
      '/api/photo/similar/reset',
      body: {},
      showLoading: showLoading,
    );
  }

  /// 重置场景识别：清空 photo_places* 并把 gen_place 置 0 后重扫
  Future<ApiResponse<Map<String, dynamic>>> resetPlaces({
    bool showLoading = false,
  }) {
    return apiPost<Map<String, dynamic>>(
      '/api/photo/place/reset',
      body: {},
      showLoading: showLoading,
    );
  }

  /// ⭐ 2026-10-16 OCR 全库重跑：清掉 photo_info_fts.ocr 并把 gen_ocr 置 0 后重扫。
  /// 换 OCR 模型（PP-OCRv5 → v6）后刷新存量结果用；全库跑，数小时量级。
  Future<ApiResponse<Map<String, dynamic>>> resetOcr({
    bool showLoading = false,
  }) {
    return apiPost<Map<String, dynamic>>(
      '/api/photo/app_ai/ocr/reset',
      body: {},
      showLoading: showLoading,
    );
  }

  /// ⭐ 2026-10-16 只重置**活动维度**（不动场景）：清 gen_activity 与 photo_activity* 后重扫。
  /// 场景已跑完而活动只跑了一半时用；不必推倒场景重来。
  Future<ApiResponse<Map<String, dynamic>>> resetActivity({
    bool showLoading = false,
  }) {
    return apiPost<Map<String, dynamic>>(
      '/api/photo/place/activity/reset',
      body: {},
      showLoading: showLoading,
    );
  }

  /// 活动维度开关（ai_activity_enable，未设置 = 开）
  Future<ApiResponse<Map<String, dynamic>>> setAiActivityEnable(
    bool enable, {
    bool showLoading = false,
  }) {
    return apiPost<Map<String, dynamic>>(
      '/api/photo/setAiActivityEnable',
      body: {'enable': enable ? 1 : 0},
      showLoading: showLoading,
    );
  }

  Future<ApiResponse<Map<String, dynamic>>> setAiFaceMinShowCount(
    int minShowCount, {
    bool showLoading = false,
  }) {
    final v = minShowCount < 0 ? 0 : minShowCount;
    return apiPost<Map<String, dynamic>>(
      '/api/photo/setAiFaceMinShowCount',
      body: {'min_show_count': v},
      showLoading: showLoading,
    );
  }

  /// 清理历史误检人脸（/face/purge，超管）
  Future<ApiResponse<Map<String, dynamic>>> purgeSuspiciousFaces({
    bool showLoading = false,
  }) async {
    final res = await apiPost<Map<String, dynamic>>(
      '/api/photo/face/purge',
      body: {},
      showLoading: showLoading,
    );
    if (!res.success) {
      return ApiResponse.failure(
        res.message ?? 'network_failure',
        code: res.code,
        rawResponse: res.rawResponse,
      );
    }
    return ApiResponse.success(
      (res.data ?? const <String, dynamic>{}).cast<String, dynamic>(),
      message: res.message,
      rawResponse: res.rawResponse,
    );
  }

  /// 重新聚类：清空人脸分组并按当前参数重扫（/face/reset）
  Future<ApiResponse<bool>> resetFaces({bool showLoading = false}) async {
    final res = await apiPost<dynamic>(
      '/api/photo/face/reset',
      body: {},
      showLoading: showLoading,
    );
    if (!res.success) {
      return ApiResponse.failure(
        res.message ?? 'network_failure',
        code: res.code,
        rawResponse: res.rawResponse,
      );
    }
    return ApiResponse.success(true, message: res.message, rawResponse: res.rawResponse);
  }

  /// 人脸聚类参数（严格度 / 最低质量 / 二次合并阈值），仅超管
  Future<ApiResponse<Map<String, dynamic>>> getFaceTuning({
    bool showLoading = false,
  }) {
    return apiPost<Map<String, dynamic>>(
      '/api/photo/face/tuning/get',
      body: {},
      showLoading: showLoading,
    );
  }

  Future<ApiResponse<Map<String, dynamic>>> setFaceTuning({
    required double simThresh,
    required int minQuality,
    required double secondMergeThresh,
    int? threads,
    bool showLoading = false,
  }) {
    return apiPost<Map<String, dynamic>>(
      '/api/photo/face/tuning/set',
      body: {
        'simThresh': simThresh,
        'minQuality': minQuality,
        'secondMergeThresh': secondMergeThresh,
        if (threads != null) 'threads': threads,
      },
      showLoading: showLoading,
    );
  }

  Future<ApiResponse<Map<String, dynamic>>> getPreviewConfig({
    bool showLoading = false,
  }) {
    return apiPost<Map<String, dynamic>>(
      '/api/photo/getPreviewConfig',
      body: {},
      showLoading: showLoading,
    );
  }

  Future<ApiResponse<Map<String, dynamic>>> setPreviewSize(
    String size, {
    bool showLoading = false,
  }) {
    return apiPost<Map<String, dynamic>>(
      '/api/photo/setPreviewSize',
      body: {'size': size},
      showLoading: showLoading,
    );
  }
}
