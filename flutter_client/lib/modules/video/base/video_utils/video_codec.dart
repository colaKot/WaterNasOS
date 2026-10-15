/// 「输出视频编码方式」档位的**唯一**定义。
///
/// ⚠️ 顺序与命名必须与服务端
/// `electron_server/src/api/modules/video/config/videoConfigController.js` 里的
/// `VIDEO_CODEC_OPTIONS` 完全一致 —— 服务端按这份白名单校验入库值，对不上会被判非法。
/// 要增删档位，两边必须同一次改完。
///
/// 该设置**按端隔离**（web / android / ios / desktop 各存一份），
/// 因为各端解码能力差异很大：桌面/移动端走 fvp（libmpv 软解）三编码都能兜底，
/// 而 Web 端受浏览器限制（Chrome 基本不支持 H.265）。
///
/// 语义：编码选择只在**需要转码**时生效；原画直推（rawFile）保持源文件编码不变。
class VideoCodec {
  const VideoCodec._();

  static const String h264 = 'h264';
  static const String h265 = 'h265';
  static const String av1 = 'av1';

  /// 下拉顺序。H.264 兼容性最好，作为默认值。
  static const List<String> options = [h264, h265, av1];

  /// 归一化服务端/本地存的值；非法或缺失一律回退 [h264]。
  static String normalize(String? raw) {
    final v = (raw ?? '').trim().toLowerCase();
    if (v == 'h265' || v == 'hevc' || v == 'h.265') return h265;
    if (v == 'av1') return av1;
    return h264;
  }

  /// 界面显示名。H.264 / H.265 / AV1 都是行业通用技术名词，各语言写法一致，不走多语言。
  static String label(String codec) {
    switch (normalize(codec)) {
      case h265:
        return 'H.265 / HEVC';
      case av1:
        return 'AV1';
      default:
        return 'H.264 / AVC';
    }
  }

  /// 是否需要「服务端 + 客户端都得支持」的额外提示（H.264 不需要）。
  static bool needsSupportHint(String codec) => normalize(codec) != h264;

  /// 该编码在 HLS 里用的分片容器是否必须是 fMP4。
  /// 与服务端 `buildStaticVodM3u8` / `transcodeWorker` 同款规则：
  /// H.264 走传统 MPEG-TS；H.265/AV1 必须走 fMP4（AV1 in MPEG-TS 无法解析）。
  static bool usesFmp4(String codec) => normalize(codec) != h264;
}
