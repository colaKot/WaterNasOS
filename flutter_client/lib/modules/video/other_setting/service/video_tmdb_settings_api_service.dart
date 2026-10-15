import 'package:get/get.dart';
import '../../../../core/api/base_api_service.dart';
import '../../../../utils/device_utils.dart';

class VideoTmdbSettingsApiService extends BaseApiService {
  static VideoTmdbSettingsApiService get instance =>
      Get.isRegistered<VideoTmdbSettingsApiService>()
      ? Get.find<VideoTmdbSettingsApiService>()
      : VideoTmdbSettingsApiService();

  Future<ApiResponse<Map<String, dynamic>>> getTmdbConfig({
    bool showLoading = false,
  }) {
    return apiPost<Map<String, dynamic>>(
      '/api/video/getTmdbConfig',
      body: {},
      showLoading: showLoading,
    );
  }

  /// 保存 TMDB 凭据与首选语言。
  ///
  /// ⭐ 2026-10-12：代理不再由影视设置管理（统一到「系统设置 → 网络代理」），
  /// 所以这里**不再下发 proxyEnable / proxyUrl**。服务端在请求未带代理字段时
  /// 会保持库里原值不动，不会把用户已有的代理配置清空。
  Future<ApiResponse<Map<String, dynamic>>> setTmdbConfig({
    required String accessToken,
    required String language,
    bool showLoading = false,
  }) {
    return apiPost<Map<String, dynamic>>(
      '/api/video/setTmdbConfig',
      body: {'accessToken': accessToken, 'language': language},
      showLoading: showLoading,
    );
  }

  Future<ApiResponse<Map<String, dynamic>>> getTranscodeConfig({
    bool showLoading = false,
  }) {
    return apiPost<Map<String, dynamic>>(
      '/api/video/getTranscodeConfig',
      body: {},
      showLoading: showLoading,
    );
  }

  Future<ApiResponse<Map<String, dynamic>>> getSubtitleConfig({
    bool showLoading = false,
  }) {
    return apiPost<Map<String, dynamic>>(
      '/api/video/getSubtitleConfig',
      body: {},
      showLoading: showLoading,
    );
  }

  Future<ApiResponse<Map<String, dynamic>>> setSubtitleConfig({
    required bool preExtractEnable,
    String? defaultSubtitleLanguage,
    bool showLoading = false,
  }) {
    return apiPost<Map<String, dynamic>>(
      '/api/video/setSubtitleConfig',
      body: {
        'preExtractEnable': preExtractEnable ? 1 : 0,
        // ⭐ 默认字幕语言（2026-10-15）：不传时服务端保持原值不动
        if (defaultSubtitleLanguage != null)
          'defaultSubtitleLanguage': defaultSubtitleLanguage,
      },
      showLoading: showLoading,
    );
  }

  Future<ApiResponse<Map<String, dynamic>>> setTranscodeConfig({
    required String tempDir,
    required String preferredHwDecoder,
    bool showLoading = false,
  }) {
    return apiPost<Map<String, dynamic>>(
      '/api/video/setTranscodeConfig',
      body: {
        'tempDir': tempDir,
        'preferredHwDecoder': preferredHwDecoder,
      },
      showLoading: showLoading,
    );
  }

  /// 读取「默认播放画质 / 音频降混」。
  ///
  /// ⭐ 按端隔离（2026-10-12）：必须带 `clientType`，服务端按 (uid, 端) 存，
  /// 这样安卓端设了默认画质不会顺手把 web 端一起改掉。该接口对所有登录用户开放。
  Future<ApiResponse<Map<String, dynamic>>> getPlayQuality({
    bool showLoading = false,
  }) {
    return apiPost<Map<String, dynamic>>(
      '/api/video/getPlayQuality',
      body: {'clientType': DeviceUtils.clientTypeKey},
      showLoading: showLoading,
    );
  }

  /// 保存「默认播放画质 / 音频降混 / 输出编码方式」（只影响当前端 + 当前用户）。
  ///
  /// [codec] 为可选项（2026-10-13 新增）：不传时服务端保持库里原值不动，
  /// 所以老调用点不受影响。
  Future<ApiResponse<Map<String, dynamic>>> setPlayQuality({
    required String quality,
    required bool audioDownmix,
    String? codec,
    bool showLoading = false,
  }) {
    return apiPost<Map<String, dynamic>>(
      '/api/video/setPlayQuality',
      body: {
        'quality': quality,
        'audioDownmix': audioDownmix ? 1 : 0,
        if (codec != null && codec.isNotEmpty) 'codec': codec,
        'clientType': DeviceUtils.clientTypeKey,
      },
      showLoading: showLoading,
    );
  }
}
