part of '../video_player_controller.dart';

extension PlayerTracks on PlayerController {
  String _currentPlaybackExtForWebCheck() {
    if (playlist.isEmpty ||
        currentIndex.value < 0 ||
        currentIndex.value >= playlist.length) {
      return '';
    }
    final item = playlist[currentIndex.value];
    final internalPath = item['internalPath']?.toString().trim() ?? '';
    final pathValue = item['path']?.toString().trim() ?? '';
    final candidate = internalPath.isNotEmpty ? internalPath : pathValue;
    return path.extension(candidate).toLowerCase();
  }

  /// 切换音轨
  Future<void> setAudioTrack(String trackLabel, {bool force = false}) async {
    if (currentAudioTrack.value == trackLabel && !force) return;
    currentAudioTrack.value = trackLabel;

    // 保存偏好
    savePreference();

    if (!kIsWeb) {
      //非web端处理
      if (currentQuality.value == 'original') {
        final track = _rawAudioTracks.cast<Map<String, dynamic>>().firstWhere(
          (e) => e['label'] == trackLabel,
          orElse: () => <String, dynamic>{},
        );
        if (track.isEmpty || playbackEngine.value == null) return;
        final mapIndex = track['mapIndex'] as int? ??
            _rawAudioTracks.indexWhere((e) => e['label'] == trackLabel);
        if (mapIndex >= 0) {
          await playbackEngine.value!.setAudioTracks([mapIndex]);
        }
      } else {
        // 转码模式：重启播放以应用新的音轨
        await _initializePlayer(keepPosition: true);
      }
    } else {
      //web端处理
      checkWebIfNeedTranscode();
      // 转码模式：重启播放以应用新的音轨
      await _initializePlayer(keepPosition: true);
    }
  }

  /// 解析原画外挂字幕的 native URL（Media3 侧挂字幕需 sourcePath 推断 MIME）。
  Future<({String url, String sourcePath, String label})?>
      resolveExternalSubtitleNativeConfig(
    String trackLabel, {
    bool forMedia3 = true,
  }) async {
    if (isNoSubtitle(trackLabel)) return null;
    final track = _rawSubtitleTracks.firstWhere(
      (e) => e['label'] == trackLabel,
      orElse: () => <String, dynamic>{},
    );
    if (track.isEmpty || track['isExternal'] != true) return null;
    final sourcePath = track['path']?.toString().trim() ?? '';
    if (sourcePath.isEmpty) return null;
    final label = track['label']?.toString().trim().isNotEmpty == true
        ? track['label']!.toString().trim()
        : path.basename(sourcePath);
    final url = ApiController.instance.getRawFileUrl(
      sourcePath,
      withAccessToken: true,
      isRawFile: true,
    );
    final playbackUrl = forMedia3
        ? await resolveP2pProxyUrlForNativeIfNeeded(url)
        : url;
    return (url: playbackUrl, sourcePath: sourcePath, label: label);
  }

  /// 切换字幕
  Future<void> setSubtitleTrack(String trackLabel, {bool force = false}) async {
    if (currentSubtitleTrack.value == trackLabel && !force) return;
    if (kIsWeb || currentQuality.value != 'original') {
      await applySubtitleTrackWhileTranscoding(
        trackLabel: trackLabel,
        prevLabel: currentSubtitleTrack.value,
      );
      return;
    }

    // 非 web 原画：内嵌字幕走原生；文本外挂走 WebSubtitleOverlay
    final prevSubtitleLabel = currentSubtitleTrack.value;
    var currentSubtitleIsExternal = checkSubtitleIsExternal(prevSubtitleLabel);
    var newSubtitleIsExternal = checkSubtitleIsExternal(trackLabel);
    currentSubtitleTrack.value = trackLabel;
    savePreference();

    final engine = playbackEngine.value;
    if (engine == null) return;
    final isMedia3 = engine.type == PlaybackEngineType.media3;

    if (isNoSubtitle(trackLabel)) {
      if (currentSubtitleIsExternal) {
        _webClearSubtitle();
        if (isTextExternalSubtitleLabel(prevSubtitleLabel)) {
          await engine.setSubtitleTracks([]);
          return;
        }
        await _initializePlayer(keepPosition: true);
        return;
      }
      _webClearSubtitle();
      await engine.setSubtitleTracks([]);
    } else if (newSubtitleIsExternal) {
      if (isTextExternalSubtitleLabel(trackLabel)) {
        await engine.setSubtitleTracks([]);
        await loadWebSubtitleIfNeeded(force: true);
        return;
      }
      final cfg = await resolveExternalSubtitleNativeConfig(
        trackLabel,
        forMedia3: isMedia3,
      );
      if (cfg == null) return;
      _webClearSubtitle();
      if (!isMedia3 || !currentSubtitleIsExternal) {
        await engine.setSubtitleTracks([]);
      }
      await engine.setExternalSubtitle(
        cfg.url,
        label: cfg.label,
        sourcePath: cfg.sourcePath,
      );
    } else {
      if (currentSubtitleIsExternal) {
        _webClearSubtitle();
        if (isTextExternalSubtitleLabel(prevSubtitleLabel)) {
          final newSubtitleIndex = getInnerSubtitleIndex(trackLabel);
          if (newSubtitleIndex != -1) {
            await engine.setSubtitleTracks([newSubtitleIndex]);
          }
          return;
        }
        await _initializePlayer(keepPosition: true);
        return;
      }
      final newSubtitleIndex = getInnerSubtitleIndex(trackLabel);
      if (newSubtitleIndex != -1) {
        await engine.setSubtitleTracks([newSubtitleIndex]);
      }
    }
  }

  int getInnerSubtitleIndex(String label) {
    //当前显示的不是外挂字幕 直接设置即可 要先筛选出内置字幕才能拿到正确的索引
    var innerSubtitleList = _rawSubtitleTracks.where(
      (e) => e['isExternal'] == false,
    );
    final newSubtitleIndex = innerSubtitleList.toList().indexWhere(
      (e) => e['label'] == label,
    );
    return newSubtitleIndex;
  }

  /// 检查是否为文本外挂字幕（非位图 .sup/.sub/.idx）。
  bool isTextExternalSubtitleLabel(String label) {
    if (label.isEmpty || isNoSubtitle(label)) return false;
    for (final s in _rawSubtitleTracks) {
      if (s['label'] != label || s['isExternal'] != true) continue;
      final subPath = s['path']?.toString() ?? '';
      final dot = subPath.lastIndexOf('.');
      final ext = dot >= 0 ? subPath.substring(dot).toLowerCase() : '';
      return ext != '.sup' && ext != '.sub' && ext != '.idx';
    }
    return false;
  }

  /// 检查字幕是否是外挂字幕
  bool checkSubtitleIsExternal(String label) {
    for (final s in _rawSubtitleTracks) {
      if (s['label'] == label) {
        if (s['isExternal'] == true) {
          return true;
        }
      }
    }
    return false;
  }

  /// 判断视频轨是否为杜比视界（判定口径与服务端 `isDolbyVisionStream` 保持一致）。
  /// DV Profile 5 的基底层在 Chromium/Media3 上无法正确渲染，直放会发紫，必须走转码。
  bool _isDolbyVisionVideoTrack(Map<String, dynamic> v) {
    final tag = v['codec_tag_string']?.toString().toLowerCase() ?? '';
    if (tag == 'dvhe' || tag == 'dvh1') return true;
    final tags = v['tags'];
    final encoder = tags is Map ? (tags['encoder']?.toString() ?? '') : '';
    if (encoder.toLowerCase().contains('dovi')) return true;
    final sideDataType = v['side_data_type']?.toString().toLowerCase() ?? '';
    if (sideDataType.contains('dovi') || sideDataType.contains('dolby')) return true;
    final dvProfile = num.tryParse('${v['dv_profile']}');
    if (dvProfile != null && dvProfile > 0) return true;
    if ('${v['rpu_present_flag']}' == '1') return true;
    final sideList = v['side_data_list'];
    if (sideList is List) {
      for (final sd in sideList) {
        if (sd is! Map) continue;
        final t = sd['side_data_type']?.toString().toLowerCase() ?? '';
        if (t.contains('dovi') || t.contains('dolby')) return true;
        final p = num.tryParse('${sd['dv_profile']}');
        if (p != null && p > 0) return true;
      }
    }
    return false;
  }

  /// 当前视频轨里是否存在杜比视界流。
  bool _hasDolbyVisionVideoTrack() {
    for (final v in _rawVideoTracks) {
      if (_isDolbyVisionVideoTrack(v)) return true;
    }
    return false;
  }

  /// Android 原画：仅对 ExoPlayer 难以直链的容器强制转码（对齐 TV 端）。
  void checkAndroidIfNeedTranscode() {
    if (kIsWeb || defaultTargetPlatform != TargetPlatform.android) return;
    if (playbackEngineType.value != PlaybackEngineType.media3) return;
    if (currentQuality.value != 'original') return;

    // 杜比视界直放会发紫（尤其 Profile 5），一律交给服务端色调映射后重编
    if (_hasDolbyVisionVideoTrack()) {
      currentQuality.value = fallbackTranscodeQuality;
      _playId ??= const Uuid().v4();
      return;
    }

    final ext = path
        .extension(currentSourcePathForInfo())
        .toLowerCase()
        .replaceFirst('.', '');
    const forceTranscodeExtensions = {
      'm2ts',
      'mts',
      'm2t',
      'ts',
      'vob',
    };
    if (forceTranscodeExtensions.contains(ext)) {
      currentQuality.value = fallbackTranscodeQuality;
      _playId ??= const Uuid().v4();
    }
  }

  /// AVI / XviD、10-bit H.264 等 Media3 难直链的片源，自动切 FVP（10-bit HEVC 仍走 Media3）。
  bool applyAndroidFvpEngineIfNeeded() {
    if (kIsWeb || defaultTargetPlatform != TargetPlatform.android) return false;
    if (playbackEngineType.value != PlaybackEngineType.media3) return false;
    if (currentQuality.value != 'original') return false;
    if (!androidMedia3SourceNeedsFvpEngine(
      videoTracks: _rawVideoTracks,
      sourcePath: currentSourcePathForInfo(),
    )) {
      return false;
    }
    return applyPlaybackEngineForCurrentSource(PlaybackEngineType.fvp);
  }

  /// Web 端视频能否在「仅转音频」时保持原画直通（服务端 `-c:v copy`）。
  ///
  /// 目前只认 H.264：全平台 Chromium 均可解码。HEVC/HDR/DV 在部分平台需要重编
  /// 或色调映射（如 DoVi P5 直放会发紫），继续交给服务端重编更稳。
  bool _webCanCopyVideoWhileTranscodingAudio() {
    for (final v in _rawVideoTracks) {
      final codec = v['codec_name']?.toString().toLowerCase() ?? '';
      if (codec.isEmpty) continue;
      return codec == 'h264';
    }
    return false;
  }

  /// 检查Web端是否需要转码
  void checkWebIfNeedTranscode() {
    if (!kIsWeb) return;
    // Web端自动检测是否需要转码（仅在原画状态下判定；已在转码则保持用户/当前选择）
    if (currentQuality.value != 'original') return;

    bool needTranscode = false;
    // 是否命中「需要重编视频」的原因（容器/视频编码）。
    // 若只有音频不受支持，则不再降低整片画质，改为「仅转音频、视频原画直通」。
    bool videoReason = false;
    bool audioReason = false;
    String? unsupportedReason;

    const unsupportedContainers = ['.m2ts', '.mts', '.ssif'];
    final playbackExt = _currentPlaybackExtForWebCheck();
    if (unsupportedContainers.contains(playbackExt)) {
      needTranscode = true;
      videoReason = true;
      unsupportedReason = 'Container $playbackExt not supported on Web';
    }

    // 杜比视界（尤其 Profile 5）在 Chromium 无法正确渲染，直放会发紫，必须重编视频。
    // 注意要有 videoReason（而非 audioReason），否则会被「仅转音频、视频直通」分支绕过。
    if (!needTranscode && _hasDolbyVisionVideoTrack()) {
      needTranscode = true;
      videoReason = true;
      unsupportedReason = 'Dolby Vision video: force transcode on Web';
    }

    // 1. 检查音频编码
    // eac3(E-AC-3) 在 Windows 上由 Chromium 走 Media Foundation 解码，不再计入
    // "Web 不支持"，否则会把用户的「原画」静默降级成转码。
    // 常见Web不支持的音频: ac3, dts, truehd
    // 支持: aac, mp3, opus, vorbis, flac (部分)
    final unsupportedAudio = [
      'ac3',
      'dts',
      'truehd',
      'dts-hd',
      'mlp',
    ];
    print("检测web端是否需要转吗:当前音频:${currentAudioTrack.value}");
    //检查一下当前选中的音频是否需要转码
    for (final s in _rawAudioTracks) {
      if (s['label'] == currentAudioTrack.value) {
        final codec = s['codec_name']?.toString().toLowerCase() ?? '';
        print("当前音频编码:$codec");
        if (unsupportedAudio.contains(codec)) {
          needTranscode = true;
          audioReason = true;
          unsupportedReason = 'Audio codec $codec not supported on Web';
          break;
        }
      }
    }

    // 2. 视频（仅 Safari）：HEVC 原画直链常整包拉流、失败后再重试；Chrome 不支持时会较快终止，不拉全文件。
    if (DeviceUtils.isWebSafariBrowser &&
        !needTranscode &&
        _rawVideoTracks.isNotEmpty) {
      const safariHevcVideo = [
        'hevc',
        'h265',
        'hev1',
        'hvc1',
      ];
      for (final v in _rawVideoTracks) {
        final vc = v['codec_name']?.toString().toLowerCase() ?? '';
        if (vc.isEmpty) continue;
        if (safariHevcVideo.contains(vc)) {
          needTranscode = true;
          videoReason = true;
          unsupportedReason =
              'Video codec $vc (HEVC): Safari Web 原画不稳定，已切换转码';
          break;
        }
      }
    }

    // Web 端字幕由独立组件渲染，不再触发“自动切转码”。

    if (!needTranscode) return;
    print('Auto switching to transcode: $unsupportedReason');

    // 仅音频不受支持、且视频本身 Web 可直放：只转音频，视频保持原画分辨率，避免整片降码率。
    if (!videoReason && audioReason && _webCanCopyVideoWhileTranscodingAudio()) {
      currentQuality.value = PlayQuality.originalAudio;
      _playId ??= const Uuid().v4();
      return;
    }

    // 其余情况（容器/视频编码不支持，或无法确认视频可直放）仍走兜底转码画质
    currentQuality.value = fallbackTranscodeQuality;
    _playId ??= const Uuid().v4();
  }

  /// 是否是无字幕
  bool isNoSubtitle(String trackLabel) {
    return trackLabel == 'player_no_subtitle'.tr;
  }

  /// 当前字幕是否是无字幕
  bool get currentIsNoSubtitle => isNoSubtitle(currentSubtitleTrack.value);
}
