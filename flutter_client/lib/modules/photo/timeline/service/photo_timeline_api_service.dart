import '../../../../core/api/base_api_service.dart';
import '../models/photo_timeline_model.dart';

class PhotoTimelineApiService extends BaseApiService {
  /// ⭐ 2026-10-16 P0-4：搜索联想（人物 / 场景 / 活动 / 相机 / 文件名 / OCR / 年份）。
  /// 计数按当前用户可见范围重算，可直接展示。
  Future<ApiResponse<List<PhotoSearchSuggestion>>> suggestSearch({
    required String query,
    int limit = 8,
  }) async {
    final res = await apiPost<Map<String, dynamic>>(
      '/api/photo/search/suggest',
      body: {'q': query, 'limit': limit},
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
    final raw = data['items'];
    final items = raw is List
        ? raw
            .whereType<Map>()
            .map((e) =>
                PhotoSearchSuggestion.fromJson(e.cast<String, dynamic>()))
            .where((e) => e.label.isNotEmpty)
            .toList()
        : <PhotoSearchSuggestion>[];
    return ApiResponse.success(
      items,
      message: res.message,
      code: res.code,
      rawResponse: res.rawResponse,
    );
  }

  /// ⭐ 2026-10-16 P0-2：合影组合相册（按同框人脸组合聚合，只算本人可见范围）。
  Future<ApiResponse<PhotoPeerGroupResult>> listPeerGroups({
    int limit = 60,
    int minFaces = 2,
  }) async {
    final res = await apiPost<Map<String, dynamic>>(
      '/api/photo/face/group_combos',
      body: {'limit': limit, 'min_faces': minFaces},
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
      PhotoPeerGroupResult.fromJson(res.data ?? <String, dynamic>{}),
      message: res.message,
      code: res.code,
      rawResponse: res.rawResponse,
    );
  }

  /// ⭐ 2026-10-16 P0-8：对指定照片按项重跑 AI（face / ocr / place / activity）。
  /// 只重置所选项目的标记，其它识别结果不受影响。
  Future<ApiResponse<Map<String, dynamic>>> rerunAi({
    required List<String> fileHashes,
    required List<String> kinds,
  }) async {
    return apiPost<Map<String, dynamic>>(
      '/api/photo/app_ai/rerun',
      body: {'file_hashes': fileHashes, 'kinds': kinds},
      showLoading: true,
    );
  }

  Future<ApiResponse<Map<String, dynamic>>> getPhotoProperties(
    String path, {
    bool showLoading = false,
  }) {
    return apiPost<Map<String, dynamic>>(
      '/api/photo/properties/get',
      body: {'path': path},
      showLoading: showLoading,
    );
  }

  /// ⭐ 2026-10-16 P0-1：**只做语义解析，不查库**。
  ///
  /// 给搜索框下方的「已识别 / 未识别 / 命中的活动」提示条用。
  /// 与 `/api/photo/place/search` 的区别：那条路要去 photo_places 捞一遍相册并算可见性，
  /// 这里纯内存解析（短语词表 + 短语嵌入），代价极低，可以跟着输入防抖直接调。
  Future<ApiResponse<PhotoSearchParseResult>> parseSearchQuery({
    required String query,
  }) async {
    final res = await apiPost<Map<String, dynamic>>(
      '/api/photo/place/parse',
      body: {'query': query},
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
      PhotoSearchParseResult.fromJson(data),
      message: res.message,
      code: res.code,
      rawResponse: res.rawResponse,
    );
  }

  /// 获取时间轴日期列表
  Future<ApiResponse<TimelineDateListResult>> getTimelineDateList({
    String sort = 'desc',
    String? fileType,
    String? search,
    String? geohash,
    List<String>? sourceList,
    String? listType,
    int? albumId,
    int? collectionId,
    int? smartAlbumId,
    int? faceId,
    List<int>? comboFaceIds,
    String? placeName,
    bool loadTheDay = false,
    int? year,
  }) async {
    final res = await apiPost<Map<String, dynamic>>(
      '/api/photo/timeline/dates',
      body: {
        'sort': sort,
        'fileType': fileType,
        'search': search,
        if (geohash != null && geohash.trim().isNotEmpty)
          'geohash': geohash.trim(),
        if (sourceList != null) 'sourceList': sourceList,
        if (listType != null) 'list_type': listType,
        if (albumId != null) 'album_id': albumId,
        if (collectionId != null) 'collection_id': collectionId,
        if (smartAlbumId != null) 'smart_album_id': smartAlbumId,
        if (faceId != null) 'face_id': faceId,
        if (comboFaceIds != null && comboFaceIds.isNotEmpty)
          'combo_face_ids': comboFaceIds,
        if (placeName != null && placeName.trim().isNotEmpty)
          'place_name': placeName.trim(),
        if (loadTheDay) 'loadTheDay': 1,
        if (year != null) 'year': year,
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

    final data = res.data ?? {};
    final rawItems = data['items'] as List<dynamic>? ?? [];
    final items = rawItems
        .whereType<Map>()
        .map((e) => TimelineDateItem.fromJson(e.cast<String, dynamic>()))
        .toList();

    final validPathsRaw = (data['validPaths'] as List<dynamic>? ?? []);
    final validPaths = validPathsRaw.map((e) {
      if (e is String) return TimelinePathItem(path: e, valid: true); // 兼容旧数据
      return TimelinePathItem.fromJson((e as Map).cast<String, dynamic>());
    }).toList();

    return ApiResponse.success(
      TimelineDateListResult(items: items, validPaths: validPaths),
      message: res.message,
      code: res.code,
      rawResponse: res.rawResponse,
    );
  }

  Future<ApiResponse<TimelinePhotoListResult>> getTimelinePhotoList({
    String sort = 'desc',
    String? fileType,
    required int startTime,
    required int endTime,
    String? search,
    String? geohash,
    List<String>? sourceList,
    String? listType,
    int? albumId,
    int? collectionId,
    int? smartAlbumId,
    int? faceId,
    List<int>? comboFaceIds,
    String? placeName,
    bool loadTheDay = false,
    int? year,
  }) async {
    final res = await apiPost<Map<String, dynamic>>(
      '/api/photo/timeline/photos',
      body: {
        'sort': sort,
        'fileType': fileType,
        'startTime': startTime,
        'endTime': endTime,
        'search': search,
        if (geohash != null && geohash.trim().isNotEmpty)
          'geohash': geohash.trim(),
        if (sourceList != null) 'sourceList': sourceList,
        if (listType != null) 'list_type': listType,
        if (albumId != null) 'album_id': albumId,
        if (collectionId != null) 'collection_id': collectionId,
        if (smartAlbumId != null) 'smart_album_id': smartAlbumId,
        if (faceId != null) 'face_id': faceId,
        if (comboFaceIds != null && comboFaceIds.isNotEmpty)
          'combo_face_ids': comboFaceIds,
        if (placeName != null && placeName.trim().isNotEmpty)
          'place_name': placeName.trim(),
        if (loadTheDay) 'loadTheDay': 1,
        if (year != null) 'year': year,
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

    final data = res.data ?? const <String, dynamic>{};

    final rawPhotoList = data['photoList'] as List<dynamic>? ?? const [];
    final photoList = rawPhotoList
        .whereType<Map>()
        .map((e) => TimelinePhotoItem.fromJson(e.cast<String, dynamic>()))
        .toList();

    final rawDateInfoList = data['dateInfoList'] as List<dynamic>? ?? const [];
    final dateInfoList = rawDateInfoList
        .whereType<Map>()
        .map((e) => TimelineDateInfo.fromJson(e.cast<String, dynamic>()))
        .toList();

    return ApiResponse.success(
      TimelinePhotoListResult(photoList: photoList, dateInfoList: dateInfoList),
      message: res.message,
      code: res.code,
      rawResponse: res.rawResponse,
    );
  }

  Future<ApiResponse<TimelineYearListResult>> getTimelineYearList() async {
    final res = await apiPost<Map<String, dynamic>>(
      '/api/photo/timeline/years',
      body: const <String, dynamic>{},
      showLoading: false,
    );

    if (!res.success) {
      return ApiResponse.failure(
        res.message ?? 'network_failure',
        code: res.code,
        rawResponse: res.rawResponse,
      );
    }

    final data = res.data ?? const <String, dynamic>{};
    final rawItems = data['items'] as List<dynamic>? ?? const [];
    final items = rawItems
        .whereType<Map>()
        .map((e) => TimelineYearItem.fromJson(e.cast<String, dynamic>()))
        .toList();

    return ApiResponse.success(
      TimelineYearListResult(items: items),
      message: res.message,
      code: res.code,
      rawResponse: res.rawResponse,
    );
  }

  Future<ApiResponse<List<TimelineDetectedFaceItem>>> listPhotoFaces({
    required String fileHash,
  }) async {
    final hash = fileHash.trim();
    if (hash.isEmpty) {
      return ApiResponse.failure('network_failure');
    }

    final res = await apiPost<Map<String, dynamic>>(
      '/api/photo/face/photo/list',
      body: {'file_hash': hash},
      showLoading: false,
    );

    if (!res.success) {
      return ApiResponse.failure(
        res.message ?? 'network_failure',
        code: res.code,
        rawResponse: res.rawResponse,
      );
    }

    final data = res.data ?? const <String, dynamic>{};
    final rawItems = data['items'] as List<dynamic>? ?? const [];
    final items = rawItems
        .whereType<Map>()
        .map(
          (e) => TimelineDetectedFaceItem.fromJson(e.cast<String, dynamic>()),
        )
        .where((e) => e.faceId > 0)
        .toList();

    return ApiResponse.success(
      items,
      message: res.message,
      code: res.code,
      rawResponse: res.rawResponse,
    );
  }

  Future<ApiResponse<bool>> removePhotoFromFace({
    required int faceId,
    required String fileHash,
  }) async {
    final hash = fileHash.trim();
    if (faceId <= 0 || hash.isEmpty) {
      return ApiResponse.failure('network_failure');
    }

    final res = await apiPost<dynamic>(
      '/api/photo/face/photo/remove',
      body: {'face_id': faceId, 'file_hash': hash},
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

  Future<ApiResponse<bool>> movePhotoToFace({
    required int fromFaceId,
    required int toFaceId,
    required List<String> fileHashes,
  }) async {
    final hashes = fileHashes
        .map((e) => e.trim())
        .where((e) => e.isNotEmpty)
        .toSet()
        .toList();
    if (fromFaceId <= 0 || toFaceId <= 0 || fromFaceId == toFaceId) {
      return ApiResponse.failure('network_failure');
    }
    if (hashes.isEmpty) {
      return ApiResponse.failure('network_failure');
    }

    final res = await apiPost<dynamic>(
      '/api/photo/face/photo/move',
      body: {
        'from_face_id': fromFaceId,
        'to_face_id': toFaceId,
        'file_hashes': hashes,
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

    return ApiResponse.success(
      true,
      message: res.message,
      code: res.code,
      rawResponse: res.rawResponse,
    );
  }

  /// 切换收藏状态
  Future<ApiResponse<Map<String, dynamic>>> toggleFavorite(
    String fileHash,
  ) async {
    return apiPost<Map<String, dynamic>>(
      '/api/photo/favorite/toggle',
      body: {'file_hash': fileHash},
      showLoading: false,
    );
  }

  /// 批量收藏/取消收藏
  Future<bool> batchFavorite(List<String> fileHashes, bool isFavorite) async {
    final res = await apiPost<void>(
      '/api/photo/favorite/batch',
      body: {'file_hashes': fileHashes, 'is_favorite': isFavorite},
    );
    return res.success;
  }

  /// 批量将照片放入回收站
  /// 返回 [ApiResponse] 以便调用方根据 [code]（如 403）展示对应提示（如权限被拒绝）
  Future<ApiResponse<void>> batchTrash(List<int> ids) async {
    return apiPost<void>('/api/photo/trash/add', body: {'ids': ids});
  }

  /// ⭐ 2026-10-16 P0-6：删除并留可撤销日志（返回 operationId，供「撤销」按钮用）。
  /// 与 batchTrash 的区别：服务端会写一条 photo_operation_log，7 天内可按 id 回滚。
  Future<ApiResponse<Map<String, dynamic>>> batchTrashLogged(List<int> ids) async {
    return apiPost<Map<String, dynamic>>(
      '/api/photo/trash/add',
      body: {'ids': ids},
    );
  }

  /// ⭐ 2026-10-16 P0-6：批量「预演」—— 只返回将影响多少张 / 多少字节，**不写库**。
  Future<ApiResponse<Map<String, dynamic>>> previewTrash(
    List<int> ids, {
    bool inTrash = true,
  }) async {
    return apiPost<Map<String, dynamic>>(
      '/api/photo/trash/preview',
      body: {'ids': ids, 'in_trash': inTrash ? 1 : 0},
      showLoading: false,
    );
  }

  /// ⭐ 2026-10-16 P0-6：撤销一次批量操作。
  Future<ApiResponse<Map<String, dynamic>>> undoOperation(int operationId) async {
    return apiPost<Map<String, dynamic>>(
      '/api/photo/operation/undo',
      body: {'operation_id': operationId},
    );
  }

  /// ⭐ 2026-10-16 P0-3 以图搜图：传一张库内照片的 file_hash，返回可见范围内最像的 N 张。
  /// 返回的条目已带 fullpath/filename/type，可直接喂给 CustomGallery 看图器。
  Future<ApiResponse<List<Map<String, dynamic>>>> searchByImage({
    required String fileHash,
    int limit = 40,
  }) async {
    final res = await apiPost<Map<String, dynamic>>(
      '/api/photo/place/search_image',
      body: {'file_hash': fileHash, 'limit': limit},
      showLoading: true,
    );
    if (!res.success) {
      return ApiResponse.failure(
        res.message ?? 'network_failure',
        code: res.code,
        rawResponse: res.rawResponse,
      );
    }
    final data = res.data ?? <String, dynamic>{};
    final raw = data['items'];
    final items = raw is List
        ? raw.whereType<Map>().map((e) => e.cast<String, dynamic>()).toList()
        : <Map<String, dynamic>>[];
    return ApiResponse.success(
      items,
      message: res.message,
      code: res.code,
      rawResponse: res.rawResponse,
    );
  }

  /// 从回收站中恢复照片
  Future<bool> restoreFromTrash(List<int> ids) async {
    final res = await apiPost<void>(
      '/api/photo/trash/restore',
      body: {'ids': ids},
    );
    return res.success;
  }

  /// 恢复回收站内所有照片
  Future<bool> restoreAllFromTrash() async {
    final res = await apiPost<void>(
      '/api/photo/trash/restore',
      body: {'restore_all': 1},
    );
    return res.success;
  }

  /// 从回收站中删除（物理删除）
  /// 返回 [ApiResponse] 以便调用方根据 [code]（如 403）展示对应提示（如权限被拒绝）
  Future<ApiResponse<void>> deleteFromTrash(
    List<int> ids, {
    bool recycle = false,
    bool deleteLivePhotoFile = true,
    bool deleteRawFile = true,
  }) async {
    return apiPost<void>(
      '/api/photo/trash/delete',
      body: {
        'ids': ids,
        'recycle': recycle,
        'delete_livephoto_file': deleteLivePhotoFile ? 1 : 0,
        'delete_raw_file': deleteRawFile ? 1 : 0,
      },
    );
  }

  /// 获取回收站内的照片列表
  Future<ApiResponse<Map<String, dynamic>>> getTrashPhotoList({
    int page = 1,
    int pageSize = 20,
    String? fileType,
    String? search,
    String sortField = 'in_trash_time',
    String sortOrder = 'desc',
  }) async {
    final res = await apiPost<Map<String, dynamic>>(
      '/api/photo/trash/list',
      body: {
        'page': page,
        'pageSize': pageSize,
        'fileType': fileType,
        'search': search,
        'sortField': sortField,
        'sortOrder': sortOrder,
      },
      showLoading: false,
    );

    return res;
  }

  /// 清空回收站
  /// 返回 [ApiResponse] 以便调用方根据 [code]（如 403）展示对应提示（如权限被拒绝）
  Future<ApiResponse<void>> emptyTrash({
    bool recycle = false,
    bool deleteLivePhotoFile = true,
    bool deleteRawFile = true,
  }) async {
    return apiPost<void>(
      '/api/photo/trash/empty',
      body: {
        'recycle': recycle,
        'delete_livephoto_file': deleteLivePhotoFile ? 1 : 0,
        'delete_raw_file': deleteRawFile ? 1 : 0,
      },
    );
  }
}
