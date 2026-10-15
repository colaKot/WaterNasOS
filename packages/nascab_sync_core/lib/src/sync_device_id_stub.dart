/// 设备标识：stub 实现（既非 io 也非 web 的平台）。
///
/// 真身永远不会走到这里；显式抛错好过返回一个空串——空 device_id 会让
/// 服务端把任务归到「未绑定」桶，等于静默丢掉设备隔离。
class SyncDeviceId {
  SyncDeviceId._();

  static Never _unsupported() => throw UnsupportedError(
        '当前平台不支持解析设备标识（同步功能仅限桌面 / Web）',
      );

  static Future<String> resolve() async => _unsupported();

  /// 设备展示名（主机名；取不到时返回空串）。
  static Future<String> resolveName() async => _unsupported();
}
