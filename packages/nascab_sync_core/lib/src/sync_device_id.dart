/// 设备标识解析（条件导入）。
///
/// - io（桌面 / 移动）：优先取「OS 机器级标识」——Windows MachineGuid、
///   macOS IOPlatformUUID、Linux /etc/machine-id。同一台机器上无论哪个
///   客户端（主客户端 / 独立同步客户端）拿到的值都相同；换一台机器必然不同。
///   取不到 OS 标识的平台（Android / iOS）退化为「按安装实例」的随机 id，
///   用 path_provider 持久化，保证同一设备上重复解析结果稳定。
/// - web：浏览器 localStorage 里的随机 id（每个浏览器 profile 一个）。
/// - 其它：stub 抛错，避免静默产出一个不确定的身份。
library sync_device_id;

export 'sync_device_id_stub.dart'
    if (dart.library.io) 'sync_device_id_io.dart'
    if (dart.library.html) 'sync_device_id_web.dart';
