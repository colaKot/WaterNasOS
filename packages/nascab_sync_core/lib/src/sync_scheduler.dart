import 'dart:async';
import 'dart:io';

import 'sync_models.dart';
import 'sync_engine.dart';

/// 同步调度器
///
/// 两种自动触发来源：
/// 1. 按需同步：监听本地目录变化，防抖后触发；
/// 2. 定时同步：按任务配置的间隔定期触发。
///
/// 手动同步由界面直接调用 [SyncEngine.run]，不经过这里。
class SyncScheduler {
  SyncScheduler._();
  static final SyncScheduler instance = SyncScheduler._();

  /// 文件变化后的防抖时长
  static const Duration _fsDebounce = Duration(seconds: 20);

  /// 同一任务两次自动触发的最小间隔
  static const int _minTriggerGapMs = 30 * 1000;

  /// ⭐ 定时同步间隔填 0 时的实际间隔：**30 秒一次**（需求 2026-10-13）。
  ///
  /// 以前 `interval <= 0` 直接 `continue`（= 完全不定时），现在改成「30 秒兜底」：
  /// 既不会像「0 = 立刻再来一次」那样死循环猛扫，也不会完全不扫。
  static const int _zeroIntervalMs = 30 * 1000;

  /// 轮询周期。必须 ≤ [_zeroIntervalMs]，否则 30 秒的间隔排不上号。
  static const Duration _tickPeriod = Duration(seconds: 10);

  final Map<int, StreamSubscription<FileSystemEvent>> _watchers = {};
  final Map<int, Timer> _debounceTimers = {};
  final Map<int, int> _lastRunMs = {};

  List<SyncTask> _tasks = const [];
  Timer? _tickTimer;
  bool _running = false;

  /// 上一轮已知的任务 id，用来识别「刚新建的任务」。
  Set<int> _knownIds = <int>{};

  /// ⚠️ 第一次拿到任务列表只做**登记**，不触发同步 ——
  ///    否则每次开 App 都会把所有任务立刻全跑一遍。
  bool _primed = false;

  /// 由控制器注入：真正执行同步的回调
  Future<void> Function(SyncTask task)? onTrigger;

  bool get isActive => _running;

  /// 全局暂停自动同步（手动同步不受影响）。
  ///
  /// 独立客户端在托盘菜单里可以让用户临时停掉自动同步，
  /// 主客户端目前未使用，但保留在共享层以便两边行为一致。
  bool _paused = false;
  bool get isPaused => _paused;

  void pause() {
    _paused = true;
    for (final t in _debounceTimers.values) {
      t.cancel();
    }
    _debounceTimers.clear();
  }

  void resume() {
    _paused = false;
  }

  void start() {
    if (_running) return;
    _running = true;
    _tickTimer = Timer.periodic(_tickPeriod, (_) => _tick());
  }

  void stop() {
    _running = false;
    _tickTimer?.cancel();
    _tickTimer = null;
    for (final sub in _watchers.values) {
      sub.cancel();
    }
    _watchers.clear();
    for (final t in _debounceTimers.values) {
      t.cancel();
    }
    _debounceTimers.clear();
    _tasks = const [];
  }

  /// 任务列表刷新后调用，同步调度状态（幂等）
  void syncTasks(List<SyncTask> tasks) {
    final prevIds = _knownIds;
    _knownIds = tasks.map((e) => e.id).toSet();
    final wasPrimed = _primed;
    _primed = true;

    _tasks = List<SyncTask>.from(tasks);
    if (_tasks.isEmpty) return;
    start();

    final aliveIds = tasks.map((e) => e.id).toSet();

    // 清理已被删除的任务
    for (final id in _watchers.keys.toList()) {
      if (!aliveIds.contains(id)) {
        _watchers.remove(id)?.cancel();
        _debounceTimers.remove(id)?.cancel();
        _lastRunMs.remove(id);
      }
    }

    final fresh = <SyncTask>[];
    for (final task in tasks) {
      if (wasPrimed && !prevIds.contains(task.id)) {
        // ⭐ 刚新建的任务：清掉节流记录，下面立刻触发一次
        _lastRunMs.remove(task.id);
        fresh.add(task);
      } else {
        final last = task.lastSyncTime;
        _lastRunMs.putIfAbsent(
          task.id,
          () => (last != null && last > 0)
              ? last
              : DateTime.now().millisecondsSinceEpoch,
        );
      }
      if (task.syncConfig.realtime) {
        _ensureWatcher(task);
      } else {
        _watchers.remove(task.id)?.cancel();
      }
    }

    // ⭐ 创建完同步任务后**马上同步一次**（需求 2026-10-13）。
    //    走 force 分支绕过 [_minTriggerGapMs]，否则新任务会被当成「刚跑过」而跳过。
    //    静默执行：由宿主注入的 onTrigger 决定要不要提示。
    for (final task in fresh) {
      unawaited(_trigger(task, force: true));
    }
  }

  void _ensureWatcher(SyncTask task) {
    if (_watchers.containsKey(task.id)) return;
    if (task.localDir.trim().isEmpty) return;
    try {
      final dir = Directory(task.localDir);
      if (!dir.existsSync()) return;
      final sub = dir.watch(recursive: true).listen(
        (_) => _onFsChanged(task),
        onError: (_) {},
        cancelOnError: false,
      );
      _watchers[task.id] = sub;
    } catch (_) {
      // 某些平台或网络盘不支持递归监听，退化为只依赖定时同步
    }
  }

  void _onFsChanged(SyncTask task) {
    if (_paused) return;
    _debounceTimers.remove(task.id)?.cancel();
    _debounceTimers[task.id] = Timer(_fsDebounce, () {
      _debounceTimers.remove(task.id);
      _trigger(task);
    });
  }

  void _tick() {
    if (_paused) return;
    final now = DateTime.now().millisecondsSinceEpoch;
    for (final task in _tasks) {
      final interval = task.syncConfig.intervalMinutes;
      // ⭐ 0（或负数）现在按 30 秒兜底，不再等于「不定时」
      final intervalMs =
          interval <= 0 ? _zeroIntervalMs : interval * 60 * 1000;
      final last = _lastRunMs[task.id] ?? task.lastSyncTime ?? now;
      if (now - last >= intervalMs) {
        _trigger(task);
      }
    }
  }

  Future<void> _trigger(SyncTask task, {bool force = false}) async {
    if (SyncEngine.instance.isRunning(task.id)) return;
    final now = DateTime.now().millisecondsSinceEpoch;
    if (!force) {
      final last = _lastRunMs[task.id] ?? 0;
      if (now - last < _minTriggerGapMs) return;
    }
    _lastRunMs[task.id] = now;
    try {
      await onTrigger?.call(task);
    } catch (_) {}
  }

  /// 任务被手动同步后同步节流时间，避免立刻又被自动触发
  void markRan(int taskId) {
    _lastRunMs[taskId] = DateTime.now().millisecondsSinceEpoch;
  }
}
