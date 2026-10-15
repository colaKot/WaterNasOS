/// 客户端本机解码能力探测（非 Web 端：Windows / macOS / Linux / Android / iOS）。
///
/// 桌面端播放引擎是 fvp（内置 libmpv + ffmpeg），H.264/H.265/AV1 都有**软件解码**兜底；
/// 安卓端默认走 media3（ExoPlayer），配了 FFmpeg 扩展解码器，硬解失败会自动回退软解。
/// 因此本机解码能力一律视为可用（真正跑不动时由播放器侧降级到 H.264 兜底）。
/// 真正的限制在服务端编码能力（由 /api/video/getPlayQuality 回吐 codecCapability）。
///
/// 说明：这里不区分硬件解码是否可用。硬件解码只影响功耗与高码率流畅度，
/// 软解能跑通即视为「本机可以解码」。
bool deviceSupportsVideoCodec(String codec) => true;
