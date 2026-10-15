import 'package:get/get.dart';
import 'package:WaterNasOS/core/api/base_api_service.dart';
import 'package:WaterNasOS/modules/video/library_setting/models/video_library.dart';

class VideoLibraryApiService extends BaseApiService {
  static VideoLibraryApiService get instance =>
      Get.isRegistered<VideoLibraryApiService>()
      ? Get.find<VideoLibraryApiService>()
      : VideoLibraryApiService();

  /// 影视库列表（所有登录用户可读，左侧栏也需要）
  Future<List<VideoLibrary>> listLibraries({bool showLoading = false}) async {
    final res = await apiPost<List<dynamic>>(
      '/api/video/library/list',
      body: {},
      showLoading: showLoading,
    );
    if (!res.success) return <VideoLibrary>[];

    final raw = res.data ?? <dynamic>[];
    return raw
        .whereType<Map>()
        .map((e) => VideoLibrary.fromJson(e.cast<String, dynamic>()))
        .where((e) => e.id > 0)
        .toList();
  }

  /// 新建影视库；[libType] 创建后不可修改
  Future<ApiResponse<Map<String, dynamic>>> addLibrary(
    String name, {
    required String libType,
    bool showLoading = true,
  }) {
    return apiPost<Map<String, dynamic>>(
      '/api/video/library/add',
      body: {'name': name, 'lib_type': libType},
      showLoading: showLoading,
    );
  }

  /// 重命名影视库（只改名字，类型不变）
  Future<ApiResponse<Map<String, dynamic>>> renameLibrary(
    int id,
    String name, {
    bool showLoading = true,
  }) {
    return apiPost<Map<String, dynamic>>(
      '/api/video/library/rename/$id',
      body: {'name': name},
      showLoading: showLoading,
    );
  }

  /// 切换「是否在主页显示该库分类」
  Future<ApiResponse<Map<String, dynamic>>> setShowInHome(
    int id,
    bool showInHome, {
    bool showLoading = true,
  }) {
    return apiPost<Map<String, dynamic>>(
      '/api/video/library/show_in_home/$id',
      body: {'show_in_home': showInHome ? 1 : 0},
      showLoading: showLoading,
    );
  }

  /// 切换「音频响度归一化」：开启后扫描/重扫该库时测量音频响度
  Future<ApiResponse<Map<String, dynamic>>> setAudioNormalize(
    int id,
    bool audioNormalize, {
    bool showLoading = true,
  }) {
    return apiPost<Map<String, dynamic>>(
      '/api/video/library/audio_normalize/$id',
      body: {'audio_normalize': audioNormalize ? 1 : 0},
      showLoading: showLoading,
    );
  }

  /// 重排影视库顺序（管理员）：[ids] 是拖出来的完整顺序，服务端按 1..n 重写 sort。
  ///
  /// 顺序是**服务端全局的**，所以 web 左侧栏与安卓端栏目条会一起跟着变。
  Future<ApiResponse<Map<String, dynamic>>> reorderLibraries(
    List<int> ids, {
    bool showLoading = true,
  }) {
    return apiPost<Map<String, dynamic>>(
      '/api/video/library/reorder',
      body: {'ids': ids},
      showLoading: showLoading,
    );
  }

  /// 切换「日本电影库」（2026-10-12）。
  ///
  /// 开了以后：列表页封面显示「中 / 无码」徽章，并开放分辨率/无码/中文字幕筛选。
  /// 服务端也会据此决定 list 接口要不要回 jp_* 字段。
  Future<ApiResponse<Map<String, dynamic>>> setJpMovie(
    int id,
    bool jpMovie, {
    bool showLoading = true,
  }) {
    return apiPost<Map<String, dynamic>>(
      '/api/video/library/jp_movie/$id',
      body: {'jp_movie': jpMovie ? 1 : 0},
      showLoading: showLoading,
    );
  }

  /// 删除影视库：内置库与仍有来源的库会被服务端拒绝
  Future<ApiResponse<Map<String, dynamic>>> deleteLibrary(
    int id, {
    bool showLoading = true,
  }) {
    return apiPost<Map<String, dynamic>>(
      '/api/video/library/delete/$id',
      body: {},
      showLoading: showLoading,
    );
  }
}
