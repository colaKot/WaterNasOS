/// WaterNasOS 目录同步核心。
///
/// 两个客户端共用这一份实现：
///   - `flutter_client`（PC 主客户端）—— 提供 FlutterSyncHost
///   - `sync_client`（Windows 独立同步客户端）—— 提供 DesktopSyncHost
///
/// 宿主差异全部收在 [SyncHost] 这一个接口里（鉴权 / 上传 / 下载通道 /
/// 协议调用 / 文案），其余逻辑（扫描、三向比对、上传下载落盘、基线维护、
/// 调度、删除传播、路径穿越防护）全部在这里共享。
library nascab_sync_core;

export 'src/sync_device_id.dart';
export 'src/sync_engine.dart';
export 'src/sync_host.dart';
export 'src/sync_local_scanner.dart';
export 'src/sync_local_store.dart';
export 'src/sync_models.dart';
export 'src/sync_protocol.dart';
export 'src/sync_scheduler.dart';
