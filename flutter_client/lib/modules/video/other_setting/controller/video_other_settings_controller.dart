import 'package:flutter/material.dart';
import 'package:get/get.dart';
import '../../../../core/user/current_user_controller.dart';
import '../../../../utils/dialog_util.dart';
import '../../../../utils/toast_util.dart';
import '../../base/video_utils/play_quality.dart';
import '../../../video_player/subtitle/subtitle_language.dart';
import '../../base/video_utils/video_codec.dart';
import '../../base/video_utils/video_codec_support.dart';
import '../service/video_tmdb_settings_api_service.dart';

class TranscodeHwDecoderOption {
  final String key;
  final String label;
  final String kind;
  final List<String> codecs;

  const TranscodeHwDecoderOption({
    required this.key,
    required this.label,
    required this.kind,
    required this.codecs,
  });

  factory TranscodeHwDecoderOption.fromJson(Map<String, dynamic> json) {
    final codecsRaw = json['codecs'];
    final codecs = codecsRaw is List
        ? codecsRaw.map((e) => e.toString().trim()).where((e) => e.isNotEmpty).toList()
        : <String>[];
    return TranscodeHwDecoderOption(
      key: (json['key']?.toString() ?? '').trim(),
      label: (json['label']?.toString() ?? '').trim(),
      kind: (json['kind']?.toString() ?? '').trim(),
      codecs: codecs,
    );
  }
}

class VideoOtherSettingsController extends GetxController {
  /// TMDB 支持的语言（与国际化 13 种一致：空为跟随系统）
  static const Set<String> allowedTmdbLanguages = {
    '',
    'en-US',
    'zh-CN',
    'es-ES',
    'fr-FR',
    'de-DE',
    'ja-JP',
    'pt-BR',
    'ru-RU',
    'ar-SA',
    'ko-KR',
    'th-TH',
    'vi-VN',
    'id-ID',
  };

  final RxBool loading = false.obs;

  final TextEditingController tmdbTokenController = TextEditingController();

  final RxString tmdbLanguage = ''.obs;
  final RxString transcodeTempDir = ''.obs;
  final RxString preferredHwDecoder = ''.obs;
  final RxString effectiveHwDecoderLabel = ''.obs;
  final RxList<TranscodeHwDecoderOption> availableHwDecoders =
      <TranscodeHwDecoderOption>[].obs;
  final RxBool subtitlePreExtractEnabled = true.obs;

  /// ⭐ 默认字幕语言（2026-10-15）：播放时按此语言自动匹配字幕。
  /// 取值见 [SubtitleLanguage]：'' 自动 | 'none' 不加载 | 'zh-CN' | 'zh-TW' | 'en' | 'ja' | 'ko'
  final RxString defaultSubtitleLanguage = SubtitleLanguage.auto.obs;
  final RxString defaultPlayQuality = 'original'.obs;
  /// 音频降混：勾选后每次转码都把非双声道音轨降混成双声道（默认不勾选）
  final RxBool audioDownmixEnabled = false.obs;
  /// ⭐ 输出视频编码方式（2026-10-13）：h264 / h265 / av1，默认 h264。
  /// 与画质同一套按端隔离存储，只在转码时生效。
  final RxString videoCodec = VideoCodec.h264.obs;
  /// 服务端编码能力（getPlayQuality 回吐）：{ 'av1': {'soft':..,'hw':..,'supported':..} }
  Map<String, dynamic> serverCodecCapability = <String, dynamic>{};

  final _api = VideoTmdbSettingsApiService.instance;

  /// 只有管理员能读写的设置（服务端那几个接口都挂了 requireAdmin）。
  ///
  /// 2026-10-12：转码 / 刮削 / 字幕三块对普通用户隐藏。**不能只是视图上藏起来** ——
  /// 还得连请求都不发，否则子账号一进页面就是一串 403，还会弹「操作失败」。
  bool get isSuperAdminUser => CurrentUserController.instance.isSuperAdmin;

  @override
  void onInit() {
    super.onInit();
    if (isSuperAdminUser) {
      fetchSettings(showLoading: false);
      fetchTranscodeSettings(showLoading: false);
      fetchSubtitleSettings(showLoading: false);
    }
    // 播放设置（默认画质 / 音频降混）是每个用户自己的偏好，且按端隔离，人人可读写
    fetchPlayQualitySettings(showLoading: false);
  }

  @override
  void onClose() {
    tmdbTokenController.dispose();
    super.onClose();
  }

  Future<void> fetchSettings({bool showLoading = false}) async {
    if (loading.value) return;
    loading.value = true;
    try {
      final res = await _api.getTmdbConfig(showLoading: showLoading);
      if (!res.success) {
        ToastUtil.show(res.message ?? 'operation_failed'.tr);
        return;
      }
      final data = res.data ?? <String, dynamic>{};
      final rawToken = (data['accessToken']?.toString() ?? '').trim();
      // 已加密的 token（enc. 开头）不显示、不回填
      tmdbTokenController.text = rawToken.startsWith('enc.') ? '' : rawToken;
      final lang = (data['language']?.toString() ?? '').trim();
      tmdbLanguage.value = allowedTmdbLanguages.contains(lang) ? lang : '';
    } finally {
      loading.value = false;
    }
  }

  Future<void> fetchTranscodeSettings({bool showLoading = false}) async {
    try {
      final res = await _api.getTranscodeConfig(showLoading: showLoading);
      if (!res.success) {
        ToastUtil.show(res.message ?? 'operation_failed'.tr);
        return;
      }
      final data = res.data ?? <String, dynamic>{};
      transcodeTempDir.value = (data['tempDir']?.toString() ?? '').trim();
      final optionsRaw = data['availableHwDecoders'];
      final options = optionsRaw is List
          ? optionsRaw
                .whereType<Map>()
                .map((item) => TranscodeHwDecoderOption.fromJson(
                      item.map((key, value) => MapEntry(key.toString(), value)),
                    ))
                .where((item) => item.key.isNotEmpty)
                .toList()
          : <TranscodeHwDecoderOption>[];
      availableHwDecoders.assignAll(options);
      final preferred = (data['preferredHwDecoder']?.toString() ?? '').trim();
      preferredHwDecoder.value =
          options.any((item) => item.key == preferred) ? preferred : '';
      effectiveHwDecoderLabel.value =
          ((data['effectiveHwDecoder'] as Map?)?['label']?.toString() ?? '')
              .trim();
    } catch (_) {}
  }

  Future<void> saveSettings() async {
    final accessToken = tmdbTokenController.text.trim();
    final language = tmdbLanguage.value.trim();

    DialogUtil.showLoading(message: 'loading'.tr);
    try {
      final res = await _api.setTmdbConfig(
        accessToken: accessToken,
        language: language,
        showLoading: false,
      );
      if (!res.success) {
        DialogUtil.dismissLoading();
        ToastUtil.show(res.message ?? 'operation_failed'.tr);
        return;
      }
      DialogUtil.dismissLoading();
      ToastUtil.show('operation_success'.tr);
      await fetchSettings(showLoading: false);
    } finally {
      DialogUtil.dismissLoading();
    }
  }

  void setTranscodeTempDirDraft(String dir) {
    transcodeTempDir.value = dir.trim();
  }

  void resetTranscodeTempDirDraft() {
    transcodeTempDir.value = '';
  }

  Future<void> fetchSubtitleSettings({bool showLoading = false}) async {
    try {
      final res = await _api.getSubtitleConfig(showLoading: showLoading);
      if (!res.success) {
        ToastUtil.show(res.message ?? 'operation_failed'.tr);
        return;
      }
      final data = res.data ?? <String, dynamic>{};
      subtitlePreExtractEnabled.value =
          data['preExtractEnable'] == 1 || data['preExtractEnable'] == '1' || data['preExtractEnable'] == true;
      defaultSubtitleLanguage.value = SubtitleLanguage.normalize(
        data['defaultSubtitleLanguage']?.toString(),
      );
    } catch (_) {}
  }

  Future<void> saveSubtitleSettings() async {
    DialogUtil.showLoading(message: 'loading'.tr);
    try {
      final res = await _api.setSubtitleConfig(
        preExtractEnable: subtitlePreExtractEnabled.value,
        defaultSubtitleLanguage: defaultSubtitleLanguage.value,
        showLoading: false,
      );
      if (!res.success) {
        DialogUtil.dismissLoading();
        ToastUtil.show(res.message ?? 'operation_failed'.tr);
        return;
      }
      DialogUtil.dismissLoading();
      ToastUtil.show('operation_success'.tr);
      await fetchSubtitleSettings(showLoading: false);
    } finally {
      DialogUtil.dismissLoading();
    }
  }

  Future<void> saveTranscodeSettings() async {
    DialogUtil.showLoading(message: 'loading'.tr);
    try {
      final res = await _api.setTranscodeConfig(
        tempDir: transcodeTempDir.value.trim(),
        preferredHwDecoder: preferredHwDecoder.value.trim(),
        showLoading: false,
      );
      if (!res.success) {
        DialogUtil.dismissLoading();
        ToastUtil.show(res.message ?? 'operation_failed'.tr);
        return;
      }
      DialogUtil.dismissLoading();
      ToastUtil.show('operation_success'.tr);
      await fetchTranscodeSettings(showLoading: false);
    } finally {
      DialogUtil.dismissLoading();
    }
  }

  void setPreferredHwDecoder(String value) {
    preferredHwDecoder.value = value.trim();
  }

  /// 把画质键翻译成界面文案（原画走多语言，其余是「分辨率 + 码率」）。
  String playQualityLabel(String quality) => PlayQuality.label(quality);

  Future<void> fetchPlayQualitySettings({bool showLoading = false}) async {
    try {
      final res = await _api.getPlayQuality(showLoading: showLoading);
      if (!res.success) return;
      final data = res.data ?? <String, dynamic>{};
      // ⭐ 输出编码方式 + 服务端能力（2026-10-13）
      videoCodec.value = VideoCodec.normalize(data['codec']?.toString());
      // ⭐ 档位按编码校验（2026-10-15）：265 专属档位在 h264 列表里判非法会丢配置
      final codecOpts = PlayQuality.optionsFor(videoCodec.value);
      final quality = (data['quality']?.toString() ?? '').trim();
      defaultPlayQuality.value = codecOpts.contains(quality)
          ? quality
          : PlayQuality.original;
      audioDownmixEnabled.value =
          data['audioDownmix'] == 1 ||
          data['audioDownmix'] == '1' ||
          data['audioDownmix'] == true;
      final cap = data['codecCapability'];
      serverCodecCapability = cap is Map
          ? cap.map((k, v) => MapEntry(k.toString(), v))
          : <String, dynamic>{};
    } catch (_) {}
  }

  /// 某编码在当前环境的可用性提示；null 表示可用。
  /// 服务端能力表缺失时保守视为可用（交给服务端保存时兜底校验）。
  String? codecAvailabilityHint(String codec) {
    if (!VideoCodec.needsSupportHint(codec)) return null;
    final cap = serverCodecCapability[codec];
    if (cap is Map && cap['supported'] == false) {
      return 'video_codec_server_unsupported_short'.tr;
    }
    if (!deviceSupportsVideoCodec(codec)) {
      return 'video_codec_client_unsupported_short'.tr;
    }
    return null;
  }

  Future<void> savePlayQualitySettings() async {
    final codec = videoCodec.value;
    var quality = defaultPlayQuality.value;
    if (!PlayQuality.optionsFor(codec).contains(quality)) {
      // 切换输出编码后原档位不再合法（如 1440p_5m 换回 h264）⇒ 回退原画，
      // 避免服务端白名单判非法导致保存失败。
      quality = PlayQuality.original;
      defaultPlayQuality.value = quality;
    }
    DialogUtil.showLoading(message: 'loading'.tr);
    try {
      final res = await _api.setPlayQuality(
        quality: quality,
        audioDownmix: audioDownmixEnabled.value,
        codec: videoCodec.value,
        showLoading: false,
      );
      if (!res.success) {
        DialogUtil.dismissLoading();
        ToastUtil.show(res.message ?? 'operation_failed'.tr);
        return;
      }
      DialogUtil.dismissLoading();
      ToastUtil.show('operation_success'.tr);
      await fetchPlayQualitySettings(showLoading: false);
    } finally {
      DialogUtil.dismissLoading();
    }
  }

  TranscodeHwDecoderOption? findHwDecoderOption(String key) {
    final value = key.trim();
    for (final item in availableHwDecoders) {
      if (item.key == value) return item;
    }
    return null;
  }

  String buildHwDecoderSummary(TranscodeHwDecoderOption option) {
    final parts = <String>[];
    if (option.kind.isNotEmpty) {
      parts.add(option.kind == 'discrete'
          ? 'video_transcode_hwaccel_kind_discrete'.tr
          : option.kind == 'integrated'
              ? 'video_transcode_hwaccel_kind_integrated'.tr
              : option.kind);
    }
    if (option.codecs.isNotEmpty) {
      parts.add(option.codecs
          .map((codec) => codec.toUpperCase())
          .toSet()
          .join(' / '));
    }
    return parts.join(' · ');
  }
}
