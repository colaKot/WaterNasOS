import 'dart:ui' show PlatformDispatcher;

import 'package:flutter/material.dart';

/// 启动阶段记录（诊断用）。
///
/// 目的：release 包看不到 [print]，一旦启动卡住就只能对着 logo 干等。
/// 这里把每个启动步骤的开始/结束/耗时/异常记在内存里，由
/// `BootstrapGate` 渲染成屏幕上的诊断页，用户截图或分享即可。
class StartupStep {
  StartupStep(this.name);

  final String name;
  bool running = false;
  bool done = false;
  Object? error;
  StackTrace? stack;
  String? detail;
  DateTime? startAt;
  DateTime? endAt;

  Duration? get elapsed {
    final s = startAt;
    if (s == null) return null;
    return (endAt ?? DateTime.now()).difference(s);
  }

  String get elapsedText {
    final d = elapsed;
    if (d == null) return '';
    if (d.inMilliseconds < 1000) return '${d.inMilliseconds}ms';
    return '${(d.inMilliseconds / 1000).toStringAsFixed(1)}s';
  }
}

/// 进程级启动诊断记录器（单例，无任何异步依赖，构造后即可用）。
class StartupDiag {
  StartupDiag._();

  static final StartupDiag instance = StartupDiag._();

  final List<StartupStep> steps = <StartupStep>[];

  /// 每次状态变化自增，UI 用它触发重绘。
  final ValueNotifier<int> revision = ValueNotifier<int>(0);

  /// 首次启动（进程创建）时刻。
  final DateTime startedAt = DateTime.now();

  /// 用于展示的基础信息，由调用方尽早填入。
  String deviceInfo = '';
  String appInfo = '';

  /// 框架层未捕获异常（只保留第一条，方便看根因）。
  String? frameworkError;

  /// 尚未结束的步骤（当前正在执行的那一个）。
  StartupStep? get current => steps.isEmpty ? null : steps.last;

  StartupStep begin(String name) {
    final s = StartupStep(name)
      ..running = true
      ..startAt = DateTime.now();
    steps.add(s);
    revision.value++;
    return s;
  }

  void end(StartupStep s, {String? detail}) {
    s
      ..running = false
      ..done = true
      ..endAt = DateTime.now()
      ..detail = detail;
    revision.value++;
  }

  void fail(StartupStep s, Object error, StackTrace? stack) {
    s
      ..running = false
      ..done = true
      ..endAt = DateTime.now()
      ..error = error
      ..stack = stack;
    revision.value++;
  }

  void note(String name, String detail) {
    steps.add(
      StartupStep(name)
        ..done = true
        ..startAt = DateTime.now()
        ..endAt = DateTime.now()
        ..detail = detail,
    );
    revision.value++;
  }

  void recordFrameworkError(Object error, StackTrace? stack) {
    // 只保留第一条，根因通常在第一条。
    frameworkError ??= '$error';
    revision.value++;
  }

  bool get hasFailure => steps.any((s) => s.error != null) || frameworkError != null;

  /// 组装成可直接粘贴/分享的纯文本。
  String report({String? verdict}) {
    final b = StringBuffer();
    b.writeln('WaterNasOS 启动诊断');
    b.writeln('生成时间: ${_fmt(DateTime.now())}');
    b.writeln('启动耗时: ${_fmtDuration(DateTime.now().difference(startedAt))}');
    if (appInfo.isNotEmpty) b.writeln('应用: $appInfo');
    if (deviceInfo.isNotEmpty) b.writeln('设备: $deviceInfo');
    if (verdict != null && verdict.isNotEmpty) {
      b.writeln('结论: $verdict');
    }
    b.writeln('----------------------------------------');
    if (steps.isEmpty) {
      b.writeln('（没有任何启动步骤被记录 —— 卡在 Dart 入口之前）');
    }
    for (var i = 0; i < steps.length; i++) {
      final s = steps[i];
      final mark = s.error != null
          ? '✗ 失败'
          : s.done
              ? '✓ 完成'
              : '… 进行中';
      b.writeln('${i + 1}. [$mark] ${s.name}  ${s.elapsedText}');
      if (s.detail != null && s.detail!.isNotEmpty) {
        b.writeln('     ${s.detail}');
      }
      if (s.error != null) {
        b.writeln('     错误: ${s.error}');
        final st = s.stack;
        if (st != null) {
          final lines = st.toString().split('\n').take(8).join('\n     ');
          b.writeln('     $lines');
        }
      }
    }
    if (frameworkError != null) {
      b.writeln('----------------------------------------');
      b.writeln('框架异常: $frameworkError');
    }
    b.writeln('----------------------------------------');
    b.writeln('（此文本可直接发给开发者）');
    return b.toString();
  }

  static String _fmt(DateTime t) =>
      '${t.year}-${_pad2(t.month)}-${_pad2(t.day)} ${_pad2(t.hour)}:${_pad2(t.minute)}:${_pad2(t.second)}';

  static String _pad2(int v) => v.toString().padLeft(2, '0');

  static String _fmtDuration(Duration d) {
    if (d.inSeconds < 60) return '${(d.inMilliseconds / 1000).toStringAsFixed(1)}s';
    return '${d.inMinutes}m${d.inSeconds % 60}s';
  }
}

/// 安装全局错误钩子：Dart 侧未捕获异常也进诊断页，避免"静默卡死"。
void installStartupErrorHandlers() {
  final previous = FlutterError.onError;
  FlutterError.onError = (FlutterErrorDetails details) {
    StartupDiag.instance.recordFrameworkError(details.exception, details.stack);
    previous?.call(details);
  };

  PlatformDispatcher.instance.onError = (Object error, StackTrace stack) {
    StartupDiag.instance.recordFrameworkError(error, stack);
    return true;
  };

  // release 包默认把构建异常画成灰块，什么都看不出来。
  // 这里换成可读文字，用户截图就能定位。
  ErrorWidget.builder = (FlutterErrorDetails details) {
    return Container(
      color: const Color(0xFF101418),
      alignment: Alignment.center,
      padding: const EdgeInsets.all(18),
      child: SingleChildScrollView(
        child: Text(
          '界面构建失败\n\n${details.exception}\n\n${details.stack ?? ''}',
          style: const TextStyle(
            color: Color(0xFFFF9C9C),
            fontSize: 12,
            height: 1.4,
          ),
        ),
      ),
    );
  };
}
