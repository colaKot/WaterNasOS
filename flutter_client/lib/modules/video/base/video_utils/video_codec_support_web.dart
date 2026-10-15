import 'dart:html' as html;

/// 客户端本机解码能力探测（Web 端）。
///
/// 浏览器原生 `<video>` 的解码能力差异很大，且不能靠猜：
/// - H.264：全平台 Chromium / Safari / Firefox 均可
/// - H.265：基本只有 Safari 支持，Chrome / Edge / Firefox 多数不支持
/// - AV1：较新 Chrome / Edge / Firefox 支持，Safari 需较新版本
///
/// 用 `MediaSource.isTypeSupported` 精确探测（不可用再回退到 `<video>.canPlayType`）。
bool deviceSupportsVideoCodec(String codec) {
  final mime = _mimeFor(codec);
  if (mime == null) return true; // 未知编码不拦，交给服务端判定
  try {
    if (html.MediaSource.isTypeSupported(mime)) return true;
  } catch (_) {}
  try {
    final v = html.VideoElement();
    return v.canPlayType(mime).isNotEmpty;
  } catch (_) {
    return false;
  }
}

String? _mimeFor(String codec) {
  switch ((codec).toLowerCase()) {
    case 'h264':
    case 'avc':
      return 'video/mp4; codecs="avc1.42E01E"';
    case 'h265':
    case 'hevc':
      // Main profile, level 3.1, 8bit —— Safari 认 hvc1
      return 'video/mp4; codecs="hvc1.1.6.L93.B0"';
    case 'av1':
      return 'video/mp4; codecs="av01.0.05M.08"';
    default:
      return null;
  }
}
