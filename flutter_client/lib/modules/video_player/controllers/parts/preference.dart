part of '../video_player_controller.dart';

/// 保存和读取用户对当前视频的偏好 如字幕索引 声轨索引
extension PlayerPreference on PlayerController {
  /// 拉取服务端配置的「默认播放画质」（影视设置页写入，服务端级配置）。
  ///
  /// 只在打开播放列表时拉一次；失败/未配置都保持 'original'（沿用历史行为）。
  /// 该接口对所有登录用户开放，子账号的播放端同样遵守。
  Future<void> loadDefaultPlayQuality() async {
    _defaultPlayQuality = 'original';
    final baseUrl = ApiController.instance.baseUrl;
    final token = ApiController.instance.accessToken;
    try {
      final res = await HttpUtil.post(
        '$baseUrl/api/video/getPlayQuality',
        // ⭐ 必须带 clientType（2026-10-12）：默认画质是按「端 + 用户」隔离存的，
        // 不带的话服务端会归一成空串，读到的还是那份旧的全量配置 ⇒ 按端隔离失效。
        body: {'clientType': DeviceUtils.clientTypeKey},
        headers: token != null ? {'Authorization': 'Bearer $token'} : null,
      );
      if (!res.isOk) return;
      final data = res.json;
      if (data == null) return;
      final payload = data['data'];
      if (payload is! Map) return;
      // ⭐ 输出编码方式 + 服务端编码能力（2026-10-13）。
      // 与画质同一个接口一次拉回，服务端按 (uid, 端) 隔离存。
      _preferredOutputCodec = VideoCodec.normalize(payload['codec']?.toString());
      // ⭐ 码率档位随编码变化（2026-10-15）：先在当前编码的档位表里建立列表，
      // 否则 265 专属档位（如 1440p_5m）会被 h264 列表判为非法而丢失。
      _syncQualityOptionsForCodec();
      final quality = payload['quality']?.toString().trim() ?? '';
      if (quality.isNotEmpty && qualityOptions.contains(quality)) {
        _defaultPlayQuality = quality;
      }
      final cap = payload['codecCapability'];
      _serverCodecCapability = cap is Map
          ? cap.map((k, v) => MapEntry(k.toString(), v))
          : <String, dynamic>{};
      // ⭐ 默认字幕语言（2026-10-15）：与画质同一接口一次拉回，
      // 打开播放列表时决定默认选中哪条字幕。
      _defaultSubtitleLanguage = SubtitleLanguage.normalize(
        payload['defaultSubtitleLanguage']?.toString(),
      );
    } catch (_) {}
  }

  /// 新开一段播放（非 seek/非手动切画质）时套用配置的默认画质。
  void applyDefaultPlayQualityForNewPlayback() {
    currentQuality.value = _defaultPlayQuality;
  }

  Future<void> saveProgress() async {
    if (playlist.isEmpty || currentIndex.value >= playlist.length) return;
    final fileInfo = playlist[currentIndex.value];
    final path = fileInfo['path']?.toString();
    final internalPath = fileInfo['internalPath']?.toString().trim() ?? '';
    if (path == null) return;
    final p = path.trim().toLowerCase();
    if (p.startsWith('http://') || p.startsWith('https://')) return;

    final baseUrl = ApiController.instance.baseUrl;
    final token = ApiController.instance.accessToken;

    try {
      await HttpUtil.post(
        '$baseUrl/api/videoPlayer/preference',
        body: {
          'filePath': path,
          if (internalPath.isNotEmpty) 'internalPath': internalPath,
          'playback_position': position.value.inSeconds.toString(),
          'subtitle_label': currentSubtitleTrack.value,
          'audio_label': currentAudioTrack.value,
        },
        headers: token != null ? {'Authorization': 'Bearer $token'} : null,
      );
    } catch (_) {}
  }

  /// 保存音频偏好
  void savePreference() {
    saveProgress();
  }

  /// 应用用户上次观看设置的偏好
  Future<void> applyPreference(Map<String, dynamic> pref) async {
    int? asInt(dynamic v) {
      if (v == null) return null;
      if (v is int) return v;
      if (v is num) return v.toInt();
      return int.tryParse(v.toString());
    }

    final audioLabel = pref['audio_label']?.toString();
    if (audioLabel != null && audioLabel.isNotEmpty) {
      for (final t in _rawAudioTracks) {
        if (t['label']?.toString() == audioLabel) {
          currentAudioTrack.value = audioLabel;
          break;
        }
      }
    }

    /// 恢复上次看的字幕
    final subtitleLabel = pref['subtitle_label']?.toString();
    if (subtitleLabel != null && subtitleLabel.isNotEmpty) {
      for (final t in _rawSubtitleTracks) {
        if (t['label']?.toString() == subtitleLabel) {
          currentSubtitleTrack.value = subtitleLabel;
          break;
        }
      }
    }

    // 观看进度：在拉流 URL 生成之前就要可用，否则首包总是从 0 开始再 seek，服务端会起两次 ffmpeg。
    final resumeSeconds = asInt(pref['playback_position']);
    if (resumeSeconds != null && resumeSeconds > 10) {
      if (_resumeSeekBakedIntoUrlSeconds != null &&
          _resumeSeekBakedIntoUrlSeconds == resumeSeconds) {
        // 已在 transcode 的 seek 参数中带上该偏移
      } else {
        _pendingResumePosition = Duration(seconds: resumeSeconds);
      }
    }

  }
}
