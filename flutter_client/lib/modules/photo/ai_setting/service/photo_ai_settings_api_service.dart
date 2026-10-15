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
