import 'dart:async';
import 'dart:math';
import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:flutter/widgets.dart';
import 'package:get/get.dart';
import 'package:path/path.dart' as path;
import 'package:shared_preferences/shared_preferences.dart';
import 'package:wakelock_plus/wakelock_plus.dart';
import 'package:flutter_fullscreen/flutter_fullscreen.dart';
import '../../../core/api/api_controller.dart';
import 'package:uuid/uuid.dart';
import '../../../utils/dialog_util.dart';
import '../../../utils/http_util.dart';
import '../../../utils/toast_util.dart';
import '../../../utils/device_utils.dart';
import '../../../utils/user_agent_util.dart';
import '../../music/play_service/controller/music_play_service_controller.dart';
import '../../video/base/video_utils/play_quality.dart';
import '../../video/base/video_utils/video_codec.dart';
import '../../video/base/video_utils/video_codec_support.dart';
import '../cache/video_range_memory_cache.dart';
import '../playback/playback_engine.dart';
import '../playback/playback_engine_factory.dart';
import '../playback/playback_engine_type.dart';
import 'platform/video_platform.dart';
import '../subtitle/webvtt_parser.dart';
import '../subtitle/subtitle_language.dart';

part 'parts/controls.dart';
part 'parts/lifecycle.dart';
part 'parts/playback.dart';
part 'parts/polling.dart';
part 'parts/transcode.dart';
part 'parts/window.dart';
part 'parts/stream.dart';
part 'parts/stream_info.dart';
part 'parts/autosave.dart';
part 'parts/auto_skip.dart';
part 'parts/resume.dart';
part 'parts/preference.dart';
part 'parts/listener.dart';
part 'parts/engine_switch.dart';
part 'parts/web_subtitle.dart';

/// 视频播放器控制器
/// 负责管理视频播放状态、播放列表、窗口管理等
class PlayerController extends GetxController with WindowListener {
  /// 播放列表 (包含视频文件信息的Map)
  final List<Map<String, dynamic>> playlist = [];

  /// 当前播放索引
  final RxInt currentIndex = 0.obs;

  /// path是个url 从加密空间来的一般这个标记是true
  final RxBool isUrlSource = false.obs;

  /// 播放内核（FVP / Media3 等）；必须为 Rx，否则 Obx 不会在赋值后挂载 PlatformView。
  final Rxn<PlaybackEngine> playbackEngine = Rxn<PlaybackEngine>();

  /// 当前使用的播放内核类型；Android 可在设置中切换。
  final Rx<PlaybackEngineType> playbackEngineType =
      defaultPlaybackEngineType().obs;

  Completer<void>? _media3SurfaceReady;
  int? _media3WaitInitGeneration;

  /// 原画↔转码切换时禁止 Media3 热切换（HLS ↔ 直链需完整重建）
  bool _disallowEngineHotSwap = false;

  /// 从转码切回原画后，音轨/字幕在首帧播放后再应用，避免 FVP 黑屏
  bool _deferOriginalTracksUntilPlaying = false;

  /// 是否已初始化
  final RxBool isInitialized = false.obs;

  /// 当前画面宽高比（拿不到就按 16:9）。字幕避让黑边时要按真实比例算。
  double get videoAspectRatio {
    final ar = playbackEngine.value?.value.aspectRatio ?? 0;
    return (ar > 0.1 && ar.isFinite) ? ar : (16 / 9);
  }

  /// 是否应挂载 [PlaybackVideoSurface]。
  /// Media3 须先创建 PlatformView 才能完成 openUrl，不能等 [isInitialized] 为 true。
  bool get shouldMountVideoSurface {
    final engine = playbackEngine.value;
    if (engine == null) return false;
    if (isInitialized.value) return true;
    return engine.type == PlaybackEngineType.media3;
  }

  /// 是否正在播放
  final RxBool isPlaying = false.obs;

  /// 当前播放位置
  final Rx<Duration> position = Duration.zero.obs;

  /// 视频总时长
  final Rx<Duration> duration = Duration.zero.obs;

  /// 缓冲位置
  final Rx<Duration> buffered = Duration.zero.obs;

  /// 播放速度
  final RxDouble playbackSpeed = 1.0.obs;

  /// 音量
  final RxDouble volume = 1.0.obs;

  /// 是否全屏
  final RxBool isFullscreen = false.obs;

  /// ⭐ 2026-10-19 画面缩放：true = 铺满屏幕（裁掉溢出，四周不留黑边），
  /// false = 适应（完整画面，留黑边）。手机全屏原来按原始比例居中，
  /// 画面显得很小 ⇒ 默认改成铺满，可随时切回适应，选择记在本机。
  final RxBool isVideoCover = true.obs;

  final RxBool isLandscape = false.obs;

  final RxBool isLocked = false.obs;
  final RxBool showLockedIcon = false.obs;
  Timer? _lockIconTimer;

  final RxBool isLooping = false.obs;

  final RxString loopMode = 'sequence'.obs;

  /// 控制栏是否显示
  final RxBool showControls = true.obs;

  /// 按住 Ctrl 加速播放中
  final RxBool isCtrlSpeedBoost = false.obs;

  /// Ctrl 加速前的速度，用于恢复
  double _speedBeforeCtrlBoost = 1.0;

  /// 恢复播放提示倒计时（0 表示不显示）
  final RxInt resumeTipCountdown = 0.obs;
  Timer? _resumeTipTimer;

  /// 隐藏控制栏的计时器
  Timer? _hideTimer;

  /// 自动保存计时器
  Timer? _autoSaveTimer;

  Timer? _transcodeSeekTimer;
  Timer? _positionPollTimer;
  bool _isPollingPosition = false;
  bool _restoreMaximizedAfterExitFullscreen = false;

  /// 单曲循环时防止「片尾 → seek(0) + play → 未及时更新 position → 再次触发片尾」的无限 pause/start 循环
  bool _singleLoopCooldown = false;
  Timer? _singleLoopCooldownTimer;

  Worker? _autoSkipWorker;
  int _openSkipStartSeconds = 0;
  int _openSkipEndSeconds = 0;
  bool _didApplyResumeForCurrentSource = false;
  bool _skipIntroConsumed = false;
  bool _skipOutroConsumed = false;
  bool _skipOutroSuppressedByResume = false;

  /// 原始音轨列表 (Map)
  final List<Map<String, dynamic>> _rawAudioTracks = [];

  /// 原始视频流列表 (Map)
  final List<Map<String, dynamic>> _rawVideoTracks = [];
  List<Map<String, dynamic>> get rawVideoTracks => _rawVideoTracks;
  List<Map<String, dynamic>> get rawAudioTracks => _rawAudioTracks;
  List<Map<String, dynamic>> get rawSubtitleTracks => _rawSubtitleTracks;

  /// 音轨列表 (Display Names)
  final RxList<String> audioTracks = <String>[].obs;
  final RxString currentAudioTrack = ''.obs;

  /// 原始字幕列表 (Map)
  final List<Map<String, dynamic>> _rawSubtitleTracks = [];

  /// 字幕列表 (Display Names)
  final RxList<String> subtitleTracks = <String>[].obs;
  final RxString currentSubtitleTrack = ''.obs;

  // Client subtitle overlay (Web + 非 Web 转码；与播放引擎解耦)
  final RxList<SubtitleCue> webSubtitleCues = <SubtitleCue>[].obs;
  final RxString webActiveSubtitleText = ''.obs;
  String _webSubtitleCacheKey = '';
  bool _webSubtitleLoading = false;

  /// 当前播放ID (用于转码)
  String? _playId;

  /// 当前播放质量 (original, 480p_1m, 720p_2m, 1080p_5m, 4k_10m ...)
  final RxString currentQuality = 'original'.obs;

  /// 质量列表。定义见 [PlayQuality]（与服务端白名单一一对应，改动必须两边同步）。
  /// ⭐ 2026-10-15：随输出编码变化 —— H.265/AV1 会多出 4K 低码率与 1440p 系列档位，
  /// 由 [_syncQualityOptionsForCodec] 在读到配置、编码降级或切换后刷新。
  final RxList<String> qualityOptions =
      RxList<String>(PlayQuality.optionsFor(VideoCodec.h264));

  /// 按当前输出编码刷新可选档位；当前档位在新编码下不合法时回退到原画。
  void _syncQualityOptionsForCodec() {
    final next = PlayQuality.optionsFor(preferredOutputCodec);
    final same =
        next.length == qualityOptions.length &&
        next.asMap().entries.every((e) => qualityOptions[e.key] == e.value);
    if (!same) {
      qualityOptions.assignAll(next);
    }
    if (currentQuality.value != PlayQuality.originalAudio &&
        !next.contains(currentQuality.value)) {
      currentQuality.value = PlayQuality.original;
    }
  }

  String qualityLabelShort(String quality) => PlayQuality.label(quality);

  Map<String, dynamic>? _pendingPreference;
  Duration? _pendingResumePosition;

  /// 首帧 URL 已带 `seek=`（转码），避免再发起一次客户端 seek。
  int? _resumeSeekBakedIntoUrlSeconds;
  int? _sourceDurationSeconds; // 视频源总时长
  int? _sourceFileSizeBytes; // 文件大小（字节），用于 P2P 中继下大文件默认转码
  int ignoreFindSub = 1;
  int _transcodeBaseSeconds = 0; // 转码基础秒数
  int? _pendingTranscodeSeekSeconds;

  /// 内置转码兜底画质（用户没配默认码率时用）
  final String defaultTranscodeQuality = '1080p_3m';

  /// 服务端配置的「默认播放画质」（影视设置页写入）。'original' 表示默认原画播放。
  /// 在 openPlaylist 时拉一次；播放中手动切换画质不会改它。
  String _defaultPlayQuality = 'original';

  /// ⭐ 输出视频编码方式（2026-10-13）：影视设置页写入，**按端隔离**（web/android/ios/desktop）。
  /// 'h264' / 'h265' / 'av1'。只在**需要转码**时生效；原画直推保持源文件编码。
  String _preferredOutputCodec = VideoCodec.h264;

  /// 服务端支持的编码能力（来自 /api/video/getPlayQuality 的 codecCapability）：
  /// 形如 { 'h264': {'soft': true, 'hw': true, 'supported': true}, ... }
  Map<String, dynamic> _serverCodecCapability = <String, dynamic>{};

  /// 因服务端/本机不兼容而把编码临时回退成 H.264 时的覆盖值（仅本次播放有效，
  /// 不回写用户设置）。null 表示没有回退。
  String? _effectiveOutputCodecOverride;

  /// ⭐ 默认字幕语言（2026-10-15）：影视设置页写入，打开播放列表时随画质一次拉回。
  /// 取值见 [SubtitleLanguage]：'' 自动 | 'none' 不加载 | 'zh-CN' | 'zh-TW' | 'en' | 'ja' | 'ko'
  String _defaultSubtitleLanguage = SubtitleLanguage.auto;

  /// 默认字幕语言（设置页 / 调试用）。
  String get defaultSubtitleLanguage => _defaultSubtitleLanguage;

  /// 本次播放检测到的「编码不兼容」提示文案；供 UI 读取后弹出，读走即清空。
  String? _outputCodecIncompatibleMessage;
  String? consumeOutputCodecIncompatibleMessage() {
    final msg = _outputCodecIncompatibleMessage;
    _outputCodecIncompatibleMessage = null;
    return msg;
  }

  /// 本次播放实际使用的输出编码（用户设置，或回退后的 H.264）。
  String get preferredOutputCodec =>
      _effectiveOutputCodecOverride ?? _preferredOutputCodec;

  /// 服务端是否支持某编码。能力表缺失时保守放行（交给服务端转码时兜底）。
  bool serverSupportsCodec(String codec) {
    final entry = _serverCodecCapability[codec];
    if (entry is Map) {
      final supported = entry['supported'];
      if (supported is bool) return supported;
    }
    return true;
  }

  /// 当前设备（浏览器/fvp）是否能解码某编码。
  bool deviceCanDecodeCodec(String codec) => deviceSupportsVideoCodec(codec);

  /// 兜底转码画质：用户配了默认码率就用它，否则用内置的 1080p_3m。
  /// 用于「原画失败自动切转码」「容器/编码不支持自动切转码」等被动降级路径。
  String get fallbackTranscodeQuality =>
      _defaultPlayQuality != 'original' ? _defaultPlayQuality : defaultTranscodeQuality;

  int maxReloadRetries = 2; // 最大重试次数
  int _reloadRetryCount = 0; // 当前重试次数
  bool _isRecoveringFromError = false; // 是否正在从错误中恢复
  bool _isPlaybackErrorDialogOpen = false; // 是否正在显示播放出错对话框
  bool _autoSwitchedToTranscode = false; // 原画失败后是否已自动切转码（对齐 TV 端）
  late final _PlayerFullScreenRelay _fullScreenRelay = _PlayerFullScreenRelay(
    onChanged: _onFullScreenChanged,
  );

  String? _pendingInitKey;
  int _initGeneration = 0;
  bool _isClosingPlayer = false;
  static const MethodChannel _macosAudioOutputChannel = MethodChannel(
    'nascab.macos.audio_output',
  );

  @override
  void onInit() {
    super.onInit();
    _onControllerInit();
  }

  @override
  void onClose() {
    _onControllerClose();
    super.onClose();
  }

  void _onFullScreenChanged(bool enabled, SystemUiMode? systemUiMode) {
    if (isClosed) return;
    isFullscreen.value = enabled;
  }

  Future<void> openPlaylist({
    required List<Map<String, dynamic>> items,
    int initialIndex = 0,
    int? maxRetryCount,
  }) async {
    if (isClosed) return;
    final list = items.toList(growable: false);
    playlist
      ..clear()
      ..addAll(list);
    if (maxRetryCount != null && maxRetryCount >= 0) {
      maxReloadRetries = maxRetryCount;
    }
    final idx = list.isEmpty
        ? 0
        : initialIndex.clamp(0, max(0, list.length - 1)).toInt();
    currentIndex.value = idx;
    _reloadRetryCount = 0;
    _isRecoveringFromError = false;
    _isPlaybackErrorDialogOpen = false;
    _autoSwitchedToTranscode = false;
    _isClosingPlayer = false;
    final initKey = _pendingInitKey;
    if (initKey != null && initKey.isNotEmpty) {
      cancelVideoControllerInit(initKey);
      _pendingInitKey = null;
    }
    if (playlist.isEmpty) return;
    await loadPlaybackEnginePreference();
    await loadVideoScaleMode();
    await loadDefaultPlayQuality();
    await _initializePlayer(keepPosition: false);
  }
}
