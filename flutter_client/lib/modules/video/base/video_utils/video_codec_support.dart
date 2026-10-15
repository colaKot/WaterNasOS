/// 本机解码能力探测：Web 用 MediaSource 精确探测，其余端（fvp/mpv）统一视为支持。
export 'video_codec_support_io.dart'
    if (dart.library.html) 'video_codec_support_web.dart';
