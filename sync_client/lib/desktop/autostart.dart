import 'dart:io';

/// 开机自启：写 HKCU 下的 Run 项。
///
/// 不引第三方包，直接用 `reg` 命令，行为透明、便于排查。
/// 注册表项：`HKCU\Software\Microsoft\Windows\CurrentVersion\Run` → `WaterNasSync`
class AutoStart {
  AutoStart._();

  static const String _valueName = 'WaterNasSync';
  static const String _runKey =
      r'HKCU\Software\Microsoft\Windows\CurrentVersion\Run';

  /// 启动参数：开机自启时静默进托盘
  static const String _autostartFlag = '--autostart';

  static Future<bool> isEnabled() async {
    if (!Platform.isWindows) return false;
    try {
      final r = await Process.run('reg', ['query', _runKey, '/v', _valueName]);
      return r.exitCode == 0;
    } catch (_) {
      return false;
    }
  }

  /// 返回是否设置成功
  static Future<bool> setEnabled(bool enabled) async {
    if (!Platform.isWindows) return false;
    try {
      if (enabled) {
        final exe = Platform.resolvedExecutable;
        final r = await Process.run('reg', [
          'add',
          _runKey,
          '/v',
          _valueName,
          '/t',
          'REG_SZ',
          '/d',
          '"$exe" $_autostartFlag',
          '/f',
        ]);
        return r.exitCode == 0;
      }
      final r = await Process.run('reg', [
        'delete',
        _runKey,
        '/v',
        _valueName,
        '/f',
      ]);
      // 值本来就不存在时 reg 会返回非 0，此时同样是「已禁用」
      return r.exitCode == 0 || !await isEnabled();
    } catch (_) {
      return false;
    }
  }
}
