import 'dart:io';

/// 开机自启：Windows 写 HKCU 的 Run 项，macOS 写 LaunchAgent，Linux 写 autostart。
///
/// 不引第三方包：Windows 直接用 `reg` 命令，行为透明、便于排查。
///
/// ⚠️ 注册表值名与独立同步客户端（`WaterNasSync`）**必须不同**，
///    否则两个客户端的自启项会互相覆盖。
class AutoStart {
  AutoStart._();

  static const String _valueName = 'WaterNasClient';
  static const String _runKey =
      r'HKCU\Software\Microsoft\Windows\CurrentVersion\Run';

  /// 启动参数：开机自启时静默进托盘（主客户端启动时自行判断，可不处理）。
  static const String _autostartFlag = '--autostart';

  static Future<bool> isEnabled() async {
    if (Platform.isWindows) return _isEnabledWindows();
    if (Platform.isMacOS) return _isEnabledMac();
    if (Platform.isLinux) return _linuxAutostartFile().existsSync();
    return false;
  }

  /// 返回是否设置成功
  static Future<bool> setEnabled(bool enabled) async {
    if (Platform.isWindows) return _setWindows(enabled);
    if (Platform.isMacOS) return _setMac(enabled);
    if (Platform.isLinux) return _setLinux(enabled);
    return false;
  }

  // ───────────────────────── Windows ─────────────────────────

  static Future<bool> _isEnabledWindows() async {
    try {
      final r = await Process.run('reg', ['query', _runKey, '/v', _valueName]);
      return r.exitCode == 0;
    } catch (_) {
      return false;
    }
  }

  static Future<bool> _setWindows(bool enabled) async {
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
      return r.exitCode == 0 || !await _isEnabledWindows();
    } catch (_) {
      return false;
    }
  }

  // ───────────────────────── macOS ─────────────────────────

  static File _macPlistFile() {
    final home = Platform.environment['HOME'] ?? '';
    return File(
      '$home/Library/LaunchAgents/com.nascabos.client.autostart.plist',
    );
  }

  static Future<bool> _isEnabledMac() async => _macPlistFile().existsSync();

  static Future<bool> _setMac(bool enabled) async {
    try {
      final file = _macPlistFile();
      if (!enabled) {
        if (file.existsSync()) file.deleteSync();
        return true;
      }
      final dir = file.parent;
      if (!dir.existsSync()) dir.createSync(recursive: true);
      final exe = Platform.resolvedExecutable;
      file.writeAsStringSync('''<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.nascabos.client.autostart</string>
  <key>ProgramArguments</key>
  <array>
    <string>$exe</string>
    <string>$_autostartFlag</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
</dict>
</plist>
''');
      return true;
    } catch (_) {
      return false;
    }
  }

  // ───────────────────────── Linux ─────────────────────────

  static File _linuxAutostartFile() {
    final home = Platform.environment['HOME'] ?? '';
    return File('$home/.config/autostart/nascabos-client.desktop');
  }

  static Future<bool> _setLinux(bool enabled) async {
    try {
      final file = _linuxAutostartFile();
      if (!enabled) {
        if (file.existsSync()) file.deleteSync();
        return true;
      }
      final dir = file.parent;
      if (!dir.existsSync()) dir.createSync(recursive: true);
      final exe = Platform.resolvedExecutable;
      file.writeAsStringSync(
        '[Desktop Entry]\n'
        'Type=Application\n'
        'Name=WaterNasClient\n'
        'Exec="$exe" $_autostartFlag\n'
        'X-GNOME-Autostart-enabled=true\n'
        'Terminal=false\n',
      );
      return true;
    } catch (_) {
      return false;
    }
  }
}
