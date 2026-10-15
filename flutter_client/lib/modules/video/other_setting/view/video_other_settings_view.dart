import 'package:WaterNasOS/core/theme/custom_colors.dart';
import 'package:WaterNasOS/core/user/current_user_controller.dart';
import 'package:WaterNasOS/utils/device_utils.dart';
import 'package:flutter/material.dart';
import 'package:get/get.dart';
import '../../../base/components/custom_glass_card.dart';
import '../../../base/components/custom_switch.dart';
import '../../../files/views/folder_picker_dialog.dart';
import '../../base/video_utils/play_quality.dart';
import '../../../video_player/subtitle/subtitle_language.dart';
import 'package:WaterNasOS/modules/video/base/video_utils/video_codec.dart';
import '../../../../utils/dialog_util.dart';
import '../controller/video_other_settings_controller.dart';

class VideoOtherSettingsView extends StatelessWidget {
  /// 只显示「播放设置」一块（2026-10-12）。
  ///
  /// 普通用户在服务端没有转码 / 刮削 / 字幕的权限，进到这个页面也只该看到播放设置；
  /// 管理员那边则始终全显示。传 true 也可以给别的入口单独复用「播放设置」卡片。
  final bool onlyPlayback;

  const VideoOtherSettingsView({super.key, this.onlyPlayback = false});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final customColors = Theme.of(context).extension<CustomColors>();
    final isNarrow = DeviceUtils.isMobile;
    // 非管理员一律只留播放设置 —— 双保险，避免以后有人从别处直接把本页塞给子账号
    final playbackOnly = onlyPlayback || !CurrentUserController.instance.isSuperAdmin;
    return GetBuilder<VideoOtherSettingsController>(
      init: VideoOtherSettingsController(),
      builder: (ctrl) {
        return Container(
          color: customColors?.mainContentBgColor,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Padding(
                padding: EdgeInsets.fromLTRB(16, isNarrow ? 12 : 12, 16, 10),
                child: Align(
                  alignment: Alignment.centerLeft,
                  child: Wrap(
                    spacing: 10,
                    runSpacing: 6,
                    crossAxisAlignment: WrapCrossAlignment.center,
                    children: [
                      Text(
                        (playbackOnly
                                ? 'video_playback_settings_title'
                                : 'video_other_settings_title')
                            .tr,
                        style: theme.textTheme.titleMedium,
                      ),
                      IconButton(
                        tooltip: 'refresh'.tr,
                        onPressed: () async {
                          if (!playbackOnly) {
                            await ctrl.fetchSettings(showLoading: true);
                            await ctrl.fetchTranscodeSettings(showLoading: true);
                            await ctrl.fetchSubtitleSettings(showLoading: true);
                          }
                          await ctrl.fetchPlayQualitySettings(showLoading: true);
                        },
                        icon: const Icon(Icons.refresh),
                      ),
                    ],
                  ),
                ),
              ),
              Expanded(
                child: SingleChildScrollView(
                  padding: const EdgeInsets.fromLTRB(16, 0, 16, 12),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      const SizedBox(height: 2),
                      if (!playbackOnly) ...[
                        CustomGlassCard(
                          child: Padding(
                            padding: const EdgeInsets.all(14),
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text(
                                  'video_scrape_settings_title'.tr,
                                  style: theme.textTheme.titleSmall,
                                ),
                                const SizedBox(height: 12),
                                _TokenField(ctrl: ctrl),
                                const SizedBox(height: 12),
                                _LanguageField(ctrl: ctrl),
                                const SizedBox(height: 12),
                                // ⭐ 代理已统一到「系统设置 → 网络代理」（2026-10-12）：
                                // 影视这边不再单独配置代理，只留一行说明指向总配置。
                                Text(
                                  'video_tmdb_proxy_managed_globally'.tr,
                                  style: theme.textTheme.bodySmall,
                                ),
                                const SizedBox(height: 14),
                                Align(
                                  alignment: Alignment.centerRight,
                                  child: ElevatedButton(
                                    onPressed: () => ctrl.saveSettings(),
                                    child: Text('save'.tr),
                                  ),
                                ),
                              ],
                            ),
                          ),
                        ),
                        const SizedBox(height: 12),
                        CustomGlassCard(
                          child: Padding(
                            padding: const EdgeInsets.all(14),
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text(
                                  'video_subtitle_settings_title'.tr,
                                  style: theme.textTheme.titleSmall,
                                ),
                                const SizedBox(height: 12),
                                _SubtitlePreExtractToggle(ctrl: ctrl),
                                const SizedBox(height: 14),
                                _DefaultSubtitleLanguageField(ctrl: ctrl),
                                const SizedBox(height: 14),
                                Align(
                                  alignment: Alignment.centerRight,
                                  child: ElevatedButton(
                                    onPressed: () => ctrl.saveSubtitleSettings(),
                                    child: Text('save'.tr),
                                  ),
                                ),
                              ],
                            ),
                          ),
                        ),
                        const SizedBox(height: 12),
                      ],
                      CustomGlassCard(
                        child: Padding(
                          padding: const EdgeInsets.all(14),
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(
                                'video_playback_settings_title'.tr,
                                style: theme.textTheme.titleSmall,
                              ),
                              const SizedBox(height: 12),
                              _DefaultPlayQualityField(ctrl: ctrl),
                              const SizedBox(height: 14),
                              _VideoCodecField(ctrl: ctrl),
                              const SizedBox(height: 14),
                              _AudioDownmixToggle(ctrl: ctrl),
                              const SizedBox(height: 14),
                              Align(
                                alignment: Alignment.centerRight,
                                child: ElevatedButton(
                                  onPressed: () => ctrl.savePlayQualitySettings(),
                                  child: Text('save'.tr),
                                ),
                              ),
                            ],
                          ),
                        ),
                      ),
                      if (!playbackOnly) ...[
                        const SizedBox(height: 12),
                        CustomGlassCard(
                          child: Padding(
                            padding: const EdgeInsets.all(14),
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text(
                                  'video_transcode_settings_title'.tr,
                                  style: theme.textTheme.titleSmall,
                                ),
                                const SizedBox(height: 12),
                                _TranscodeHwDecoderField(ctrl: ctrl),
                                const SizedBox(height: 12),
                                _TranscodeTempDirField(ctrl: ctrl),
                                const SizedBox(height: 14),
                                Align(
                                  alignment: Alignment.centerRight,
                                  child: ElevatedButton(
                                    onPressed: () => ctrl.saveTranscodeSettings(),
                                    child: Text('save'.tr),
                                  ),
                                ),
                              ],
                            ),
                          ),
                        ),
                      ],
                    ],
                  ),
                ),
              ),
            ],
          ),
        );
      },
    );
  }
}

class _DefaultPlayQualityField extends StatelessWidget {
  final VideoOtherSettingsController ctrl;

  const _DefaultPlayQualityField({required this.ctrl});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Obx(() {
      // ⭐ 档位随输出编码变化（2026-10-15）：读到 videoCodec 也让本组件跟着刷新
      final opts = PlayQuality.optionsFor(ctrl.videoCodec.value);
      final value = opts.contains(ctrl.defaultPlayQuality.value)
          ? ctrl.defaultPlayQuality.value
          : PlayQuality.original;
      return Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            'video_default_play_quality'.tr,
            style: theme.textTheme.titleSmall,
          ),
          const SizedBox(height: 4),
          Text(
            'video_default_play_quality_tip'.tr,
            style: theme.textTheme.bodySmall,
          ),
          const SizedBox(height: 8),
          DropdownButtonFormField<String>(
            value: value,
            isExpanded: true,
            decoration: const InputDecoration(
              border: OutlineInputBorder(),
              isDense: true,
            ),
            items: opts
                .map(
                  (option) => DropdownMenuItem(
                    value: option,
                    child: Text(ctrl.playQualityLabel(option)),
                  ),
                )
                .toList(),
            onChanged: (v) =>
                ctrl.defaultPlayQuality.value = v ?? PlayQuality.original,
          ),
        ],
      );
    });
  }
}

/// ⭐ 输出视频编码方式（2026-10-13）。
///
/// 选项 H.264 / H.265 / AV1；选中非 H.264 时先弹确认框（明确提示「需要服务端支持 +
/// 当前设备能解码」，用户要求「选中了以后再提示」），确认后才生效。
/// 不可用的选项在右侧红字标注原因（服务端不支持 / 当前设备不支持）。
class _VideoCodecField extends StatelessWidget {
  final VideoOtherSettingsController ctrl;

  const _VideoCodecField({required this.ctrl});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Obx(() {
      final value = VideoCodec.normalize(ctrl.videoCodec.value);
      return Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            'video_codec_setting_title'.tr,
            style: theme.textTheme.titleSmall,
          ),
          const SizedBox(height: 4),
          Text(
            'video_codec_setting_tip'.tr,
            style: theme.textTheme.bodySmall,
          ),
          const SizedBox(height: 8),
          DropdownButtonFormField<String>(
            value: value,
            isExpanded: true,
            decoration: const InputDecoration(
              border: OutlineInputBorder(),
              isDense: true,
            ),
            items: VideoCodec.options.map((option) {
              final hint = ctrl.codecAvailabilityHint(option);
              return DropdownMenuItem(
                value: option,
                child: Row(
                  children: [
                    Expanded(child: Text(VideoCodec.label(option))),
                    if (hint != null)
                      Text(
                        hint,
                        style: theme.textTheme.bodySmall?.copyWith(
                          color: theme.colorScheme.error,
                        ),
                      ),
                  ],
                ),
              );
            }).toList(),
            onChanged: (v) async {
              if (v == null) return;
              final next = VideoCodec.normalize(v);
              if (next == value) return;
              // 选中 H.265 / AV1 时先弹提示，确认后才生效
              if (VideoCodec.needsSupportHint(next)) {
                final ok = await DialogUtil.showConfirmDialog(
                  title: 'video_codec_confirm_title'.tr,
                  content: 'video_codec_confirm_message'
                      .trParams({'codec': VideoCodec.label(next)}),
                );
                if (ok != true) return;
              }
              ctrl.videoCodec.value = next;
            },
          ),
        ],
      );
    });
  }
}

class _AudioDownmixToggle extends StatelessWidget {
  final VideoOtherSettingsController ctrl;

  const _AudioDownmixToggle({required this.ctrl});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Obx(() {
      final enabled = ctrl.audioDownmixEnabled.value;
      return Row(
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  'video_audio_downmix'.tr,
                  style: theme.textTheme.titleSmall,
                ),
                const SizedBox(height: 4),
                Text(
                  'video_audio_downmix_tip'.tr,
                  style: theme.textTheme.bodySmall,
                ),
              ],
            ),
          ),
          const SizedBox(width: 12),
          CustomSwitch(
            value: enabled,
            onChanged: (v) => ctrl.audioDownmixEnabled.value = v,
          ),
        ],
      );
    });
  }
}

class _TranscodeHwDecoderField extends StatelessWidget {
  final VideoOtherSettingsController ctrl;

  const _TranscodeHwDecoderField({required this.ctrl});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Obx(() {
      final options = ctrl.availableHwDecoders.toList(growable: false);
      final currentValue =
          ctrl.findHwDecoderOption(ctrl.preferredHwDecoder.value) != null
          ? ctrl.preferredHwDecoder.value
          : '';
      final selectedOption = ctrl.findHwDecoderOption(currentValue);
      final effectiveLabel = ctrl.effectiveHwDecoderLabel.value;
      return Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            'video_transcode_hwaccel_preferred'.tr,
            style: theme.textTheme.titleSmall,
          ),
          const SizedBox(height: 4),
          Text(
            'video_transcode_hwaccel_preferred_tip'.tr,
            style: theme.textTheme.bodySmall,
          ),
          const SizedBox(height: 8),
          if (options.isEmpty)
            Container(
              width: double.infinity,
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 12),
              decoration: BoxDecoration(
                border: Border.all(
                  color: theme.colorScheme.onSurface.withOpacity(0.3),
                ),
                borderRadius: BorderRadius.circular(8),
              ),
              child: Row(
                children: [
                  Icon(
                    Icons.memory_outlined,
                    size: 18,
                    color: theme.colorScheme.onSurface.withOpacity(0.65),
                  ),
                  const SizedBox(width: 8),
                  Text(
                    'video_transcode_hwaccel_none'.tr,
                    style: theme.textTheme.bodyMedium,
                  ),
                ],
              ),
            )
          else
            DropdownButtonFormField<String>(
              value: currentValue,
              isExpanded: true,
              decoration: const InputDecoration(
                border: OutlineInputBorder(),
                isDense: true,
              ),
              items: [
                DropdownMenuItem(value: '', child: Text('auto'.tr)),
                ...options.map(
                  (option) => DropdownMenuItem(
                    value: option.key,
                    child: Text(option.label),
                  ),
                ),
              ],
              onChanged: (value) => ctrl.setPreferredHwDecoder(value ?? ''),
            ),
          if (options.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(top: 8),
              child: Container(
                width: double.infinity,
                padding: const EdgeInsets.symmetric(
                  horizontal: 12,
                  vertical: 10,
                ),
                decoration: BoxDecoration(
                  color: theme.colorScheme.surface.withOpacity(0.4),
                  borderRadius: BorderRadius.circular(8),
                ),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    if (selectedOption != null)
                      Text(
                        '${selectedOption.label} · ${ctrl.buildHwDecoderSummary(selectedOption)}',
                        style: theme.textTheme.bodyMedium,
                      ),
                    if (effectiveLabel.isNotEmpty)
                      Padding(
                        padding: EdgeInsets.only(
                          top: selectedOption != null ? 6 : 0,
                        ),
                        child: Text(
                          '${'video_transcode_hwaccel_current'.tr}: $effectiveLabel',
                          style: theme.textTheme.bodySmall,
                        ),
                      ),
                    if (selectedOption == null && effectiveLabel.isEmpty)
                      Text('auto'.tr, style: theme.textTheme.bodyMedium),
                  ],
                ),
              ),
            ),
        ],
      );
    });
  }
}

class _TranscodeTempDirField extends StatelessWidget {
  final VideoOtherSettingsController ctrl;

  const _TranscodeTempDirField({required this.ctrl});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Obx(() {
      final dir = ctrl.transcodeTempDir.value;
      return Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      'video_transcode_temp_dir'.tr,
                      style: theme.textTheme.titleSmall,
                    ),
                    const SizedBox(height: 4),
                    Text(
                      'video_transcode_temp_dir_tip'.tr,
                      style: theme.textTheme.bodySmall?.copyWith(),
                    ),
                  ],
                ),
              ),
              const SizedBox(width: 8),
              TextButton(
                onPressed: () async {
                  final picked = await showFolderPickerBottomSheet(
                    context,
                    multiSelect: false,
                    allowFileSelect: false,
                    initialPath: dir.isNotEmpty ? dir : null,
                  );
                  final chosen = (picked ?? []).isNotEmpty ? picked!.first : '';
                  if (chosen.isNotEmpty) {
                    ctrl.setTranscodeTempDirDraft(chosen);
                  }
                },
                child: Text('select'.tr),
              ),
              const SizedBox(width: 8),
              TextButton(
                onPressed: () async {
                  ctrl.resetTranscodeTempDirDraft();
                },
                child: Text('reset'.tr),
              ),
            ],
          ),
          const SizedBox(height: 8),
          Container(
            width: double.infinity,
            padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
            decoration: BoxDecoration(
              border: Border.all(
                color: theme.colorScheme.onSurface.withOpacity(0.3),
              ),
              borderRadius: BorderRadius.circular(6),
            ),
            child: Text(
              dir.isNotEmpty ? dir : 'default'.tr,
              style: theme.textTheme.bodyMedium,
            ),
          ),
        ],
      );
    });
  }
}

class _TokenField extends StatelessWidget {
  final VideoOtherSettingsController ctrl;

  const _TokenField({required this.ctrl});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            Text(
              'video_tmdb_access_token'.tr,
              style: theme.textTheme.titleSmall,
            ),
            const SizedBox(width: 6),
            Tooltip(
              message: 'video_tmdb_access_token_help'.tr,
              waitDuration: const Duration(milliseconds: 200),
              child: MouseRegion(
                cursor: SystemMouseCursors.click,
                child: GestureDetector(
                  onTap: () {
                    DialogUtil.showInfoDialog(
                      title: 'tip'.tr,
                      content: 'video_tmdb_access_token_help'.tr,
                    );
                  },
                  child: Icon(Icons.help_outline, size: 18),
                ),
              ),
            ),
          ],
        ),
        const SizedBox(height: 8),
        TextField(
          controller: ctrl.tmdbTokenController,
          maxLines: 1,
          decoration: InputDecoration(
            hintText: 'video_tmdb_access_token_hint'.tr,
            border: const OutlineInputBorder(),
            isDense: true,
          ),
        ),
      ],
    );
  }
}

class _SubtitlePreExtractToggle extends StatelessWidget {
  final VideoOtherSettingsController ctrl;

  const _SubtitlePreExtractToggle({required this.ctrl});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Obx(() {
      final enabled = ctrl.subtitlePreExtractEnabled.value;
      return Row(
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  'video_subtitle_pre_extract_enable'.tr,
                  style: theme.textTheme.titleSmall,
                ),
                const SizedBox(height: 4),
                Text('process.worker.subtitlePreExtract.purpose'.tr),
              ],
            ),
          ),
          const SizedBox(width: 12),
          CustomSwitch(
            value: enabled,
            onChanged: (v) => ctrl.subtitlePreExtractEnabled.value = v,
          ),
        ],
      );
    });
  }
}

/// ⭐ 默认字幕语言（2026-10-15）：播放电影时按所选语言自动匹配字幕。
///
/// 字幕文件命名五花八门（cn / chs / 简中 / 简体中文 / zh-CN / chi …），
/// 识别逻辑见 [SubtitleLanguage]。
class _DefaultSubtitleLanguageField extends StatelessWidget {
  final VideoOtherSettingsController ctrl;

  const _DefaultSubtitleLanguageField({required this.ctrl});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Obx(() {
      final value = SubtitleLanguage.normalize(
        ctrl.defaultSubtitleLanguage.value,
      );
      return Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            'video_default_subtitle_language'.tr,
            style: theme.textTheme.titleSmall,
          ),
          const SizedBox(height: 4),
          Text(
            'video_default_subtitle_language_tip'.tr,
            style: theme.textTheme.bodySmall,
          ),
          const SizedBox(height: 8),
          DropdownButtonFormField<String>(
            value: value,
            isExpanded: true,
            decoration: const InputDecoration(
              border: OutlineInputBorder(),
              isDense: true,
            ),
            items: SubtitleLanguage.options
                .map(
                  (code) => DropdownMenuItem(
                    value: code,
                    child: Text(SubtitleLanguage.labelKey(code).tr),
                  ),
                )
                .toList(),
            onChanged: (v) {
              if (v == null) return;
              ctrl.defaultSubtitleLanguage.value = v;
            },
          ),
        ],
      );
    });
  }
}

class _LanguageField extends StatelessWidget {
  final VideoOtherSettingsController ctrl;

  const _LanguageField({required this.ctrl});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final items = <DropdownMenuItem<String>>[
      DropdownMenuItem(
        value: '',
        child: Text('video_tmdb_language_follow_system'.tr),
      ),
      DropdownMenuItem(
        value: 'en-US',
        child: Text('video_tmdb_language_en'.tr),
      ),
      DropdownMenuItem(
        value: 'zh-CN',
        child: Text('video_tmdb_language_zh'.tr),
      ),
      DropdownMenuItem(
        value: 'es-ES',
        child: Text('video_tmdb_language_es'.tr),
      ),
      DropdownMenuItem(
        value: 'fr-FR',
        child: Text('video_tmdb_language_fr'.tr),
      ),
      DropdownMenuItem(
        value: 'de-DE',
        child: Text('video_tmdb_language_de'.tr),
      ),
      DropdownMenuItem(
        value: 'ja-JP',
        child: Text('video_tmdb_language_ja'.tr),
      ),
      DropdownMenuItem(
        value: 'pt-BR',
        child: Text('video_tmdb_language_pt'.tr),
      ),
      DropdownMenuItem(
        value: 'ru-RU',
        child: Text('video_tmdb_language_ru'.tr),
      ),
      DropdownMenuItem(
        value: 'ar-SA',
        child: Text('video_tmdb_language_ar'.tr),
      ),
      DropdownMenuItem(
        value: 'ko-KR',
        child: Text('video_tmdb_language_ko'.tr),
      ),
      DropdownMenuItem(
        value: 'th-TH',
        child: Text('video_tmdb_language_th'.tr),
      ),
      DropdownMenuItem(
        value: 'vi-VN',
        child: Text('video_tmdb_language_vi'.tr),
      ),
      DropdownMenuItem(
        value: 'id-ID',
        child: Text('video_tmdb_language_id'.tr),
      ),
    ];

    return Obx(() {
      final value = ctrl.tmdbLanguage.value;
      return Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('video_tmdb_language'.tr, style: theme.textTheme.titleSmall),
          const SizedBox(height: 8),
          DropdownButtonFormField<String>(
            value: value,
            items: items,
            onChanged: (v) => ctrl.tmdbLanguage.value = (v ?? '').trim(),
            decoration: const InputDecoration(
              border: OutlineInputBorder(),
              isDense: true,
            ),
          ),
        ],
      );
    });
  }
}

