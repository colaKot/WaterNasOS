import '../../../../core/api/base_api_service.dart';
import '../models/ai_faces_models.dart';

class PhotoAiFacesApiService extends BaseApiService {
  Future<ApiResponse<AiFaceListResult>> listFaces({
    int page = 1,
    int pageSize = 50,
    String status = 'visiable',
    String keyword = '',
  }) async {
    final res = await apiPost<Map<String, dynamic>>(
      '/api/photo/face/list',
      body: {
        'page': page,
        'pageSize': pageSize,
        'status': status,
        if (keyword.trim().isNotEmpty) 'keyword': keyword.trim(),
      },
      showLoading: false,
    );

    if (!res.success) {
      return ApiResponse.failure(
        res.message ?? 'network_failure',
        code: res.code,
        rawResponse: res.rawResponse,
      );
    }

    final data = res.data ?? <String, dynamic>{};
    return ApiResponse.success(
      AiFaceListResult.fromJson(data),
      message: res.message,
      code: res.code,
      rawResponse: res.rawResponse,
    );
  }

  Future<ApiResponse<bool>> updateFaceName({
    required int faceId,
    required String name,
  }) async {
    final res = await apiPost<dynamic>(
      '/api/photo/face/name/update',
      body: {'face_id': faceId, 'name': name},
      showLoading: false,
    );
    if (!res.success) {
      return ApiResponse.failure(
        res.message ?? 'network_failure',
        code: res.code,
        rawResponse: res.rawResponse,
      );
    }
    return ApiResponse.success(
      true,
      message: res.message,
      code: res.code,
      rawResponse: res.rawResponse,
    );
  }

  Future<ApiResponse<bool>> setFaceStatus({
    required int faceId,
    required bool isHide,
  }) async {
    final res = await apiPost<dynamic>(
      '/api/photo/face/status/set',
      body: {'face_id': faceId, 'is_hide': isHide ? 1 : 0},
      showLoading: false,
    );
    if (!res.success) {
      return ApiResponse.failure(
        res.message ?? 'network_failure',
        code: res.code,
        rawResponse: res.rawResponse,
      );
    }
    return ApiResponse.success(
      true,
      message: res.message,
      code: res.code,
      rawResponse: res.rawResponse,
    );
  }

  Future<ApiResponse<bool>> mergeFaces({required List<int> faceIds}) async {
    final ids = faceIds.where((e) => e > 0).toList();
    final res = await apiPost<dynamic>(
      '/api/photo/face/merge',
      body: {'face_ids': ids},
      showLoading: false,
      // 2026-10-13：合并是单事务搬数千行 f2 + 样本，大图库下远超默认 10s；
      // 超时会被用户当成「合并失败」（实际服务端还在跑甚至已成功）。
      timeout: const Duration(seconds: 120),
    );
    if (!res.success) {
      return ApiResponse.failure(
        res.message ?? 'network_failure',
        code: res.code,
        rawResponse: res.rawResponse,
      );
    }
    return ApiResponse.success(
      true,
      message: res.message,
      code: res.code,
      rawResponse: res.rawResponse,
    );
  }

  Future<ApiResponse<bool>> moveFaceToOther({
    required int fromFaceId,
    required int toFaceId,
  }) async {
    if (fromFaceId <= 0 || toFaceId <= 0 || fromFaceId == toFaceId) {
      return ApiResponse.failure('network_failure');
    }

    final res = await apiPost<dynamic>(
      '/api/photo/face/merge',
      body: {'from_face_id': fromFaceId, 'to_face_id': toFaceId},
      showLoading: false,
    );
    if (!res.success) {
      return ApiResponse.failure(
        res.message ?? 'network_failure',
        code: res.code,
        rawResponse: res.rawResponse,
      );
    }

    return ApiResponse.success(
      true,
      message: res.message,
      code: res.code,
      rawResponse: res.rawResponse,
    );
  }

  /// 只重建「我可见范围内」照片的人脸（不碰别人的相册）
  /// ⭐ 2026-10-16 P0-7 重扫「两阶段」的预览：只算差异，**不写库**。
  /// 返回 {photos, faceRows, faces, samples, emptyGroupsAfter}，交给用户确认后再跑 rescanFaces。
  Future<ApiResponse<Map<String, dynamic>>> previewRescanFaces() async {
    final res = await apiPost<Map<String, dynamic>>(
      '/api/photo/face/rescan/preview',
      body: {},
      showLoading: true,
    );
    if (!res.success) {
      return ApiResponse.failure(
        res.message ?? 'network_failure',
        code: res.code,
        rawResponse: res.rawResponse,
      );
    }
    return ApiResponse.success(
      res.data ?? <String, dynamic>{},
      message: res.message,
      code: res.code,
      rawResponse: res.rawResponse,
    );
  }

  Future<ApiResponse<bool>> rescanFaces({bool showLoading = false}) async {
    final res = await apiPost<dynamic>(
      '/api/photo/face/rescan',
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

  Future<ApiResponse<bool>> resetFaces() async {
    final res = await apiPost<dynamic>(
      '/api/photo/face/reset',
      body: {},
      showLoading: false,
    );
    if (!res.success) {
      return ApiResponse.failure(
        res.message ?? 'network_failure',
        code: res.code,
        rawResponse: res.rawResponse,
      );
    }
    return ApiResponse.success(
      true,
      message: res.message,
      code: res.code,
      rawResponse: res.rawResponse,
    );
  }
  /// ⭐ 2026-10-16 P0-5：人物关系图谱数据（共同出现的边 + 人物节点）。
  Future<ApiResponse<AiFaceRelationsResult>> listRelations({
    int limit = 120,
    int minCount = 2,
  }) async {
    final res = await apiPost<Map<String, dynamic>>(
      '/api/photo/face/relations',
      body: {'limit': limit, 'min_count': minCount},
      showLoading: false,
    );
    if (!res.success) {
      return ApiResponse.failure(
        res.message ?? 'network_failure',
        code: res.code,
        rawResponse: res.rawResponse,
      );
    }
    return ApiResponse.success(
      AiFaceRelationsResult.fromJson(res.data ?? <String, dynamic>{}),
      message: res.message,
      code: res.code,
      rawResponse: res.rawResponse,
    );
  }

}
