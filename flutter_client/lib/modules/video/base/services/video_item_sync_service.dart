import 'dart:async';

class VideoItemSyncService {
  static final StreamController<int> _deletedController =
      StreamController<int>.broadcast();
  static final StreamController<int> _updatedController =
      StreamController<int>.broadcast();

  static Stream<int> get deletedStream => _deletedController.stream;

  /// 「某个条目已被重新刮削」的通知流。
  ///
  /// 通知到订阅方时，服务端的 NFO 可能已经写完（见 [notifyUpdated] 的延迟说明），
  /// 订阅方收到后直接刷新列表即可。
  static Stream<int> get updatedStream => _updatedController.stream;

  static void notifyDeleted(int indexId) {
    if (indexId <= 0 || _deletedController.isClosed) return;
    _deletedController.add(indexId);
  }

  /// 通知「某条目已在服务端重新刮削」。
  ///
  /// ⚠️ 服务端刮削是异步子进程：`scrape/start` 返回时 NFO 与封面都还没落盘，
  /// 立刻刷新只会拿到旧数据（用户看到的现象就是「点了应用没反应」）。
  /// 所以这里统一延后广播，订阅方无需再各自掐时间。
  /// 分两次是为了同时覆盖 TMDB 的快速路径和日本片逐个站点重试的慢路径。
  static void notifyUpdated(int indexId) {
    if (indexId <= 0) return;
    for (final delay in const [Duration(seconds: 3), Duration(seconds: 12)]) {
      Timer(delay, () {
        if (_updatedController.isClosed) return;
        _updatedController.add(indexId);
      });
    }
  }
}