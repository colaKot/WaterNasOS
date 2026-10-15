import 'dart:io';
import 'dart:math';

import 'package:path/path.dart' as p;
import 'package:path_provider/path_provider.dart';

/// 设备标识：io 实现。
///
/// 身份语义（用户 2026-10-12 定的四条规则）：
///   - 同一台机器 + 同一账号 + 不同客户端 ⇒ 相通
///   - 换机器（哪怕同账号）⇒ 不相通
///   - 不同账号 ⇒ 不相通（账号维度由服务端 uid 隔离，这里只管机器维度）
///
/// 所以这里取的是「机器级」标识：同一台机器上主客户端与独立同步客户端
/// 必须解析出同一个值，不同机器必须不同。
class SyncDeviceId {
  SyncDeviceId._();

  static String? _cached;
  static String? _cachedName;

  /// 解析（并缓存）本机设备标识。
  ///
  /// 顺序：Windows MachineGuid → macOS IOPlatformUUID → Linux machine-id
  ///       → 持久化随机 id（Android / iOS 等取不到 OS 标识的平台）。
  /// 返回值形如 `win-4a3b…` / `mac-…` / `lnx-…` / `app-…`。
  static Future<String> resolve() async {
    final hit = _cached;
    if (hit != null && hit.isNotEmpty) return hit;

    String? id;
    try {
      id = await _readOsMachineId();
    } catch (_) {}
    if (id == null || id.isEmpty) {
      id = await _readOrCreatePersistedId();
    }
    if (id == null || id.isEmpty) {
      throw StateError('无法解析本机设备标识');
    }
    _cached = id;
    return id;
  }

  /// 设备展示名：主机名。取不到返回空串（调用方自行兜底）。
  static Future<String> resolveName() async {
    final hit = _cachedName;
    if (hit != null) return hit;
    String name = '';
    try {
      name = Platform.localHostname.trim();
    } catch (_) {}
    _cachedName = name;
    return name;
  }

  // ── OS 机器级标识 ──

  static Future<String?> _readOsMachineId() async {
    if (Platform.isWindows) return _readWindowsMachineGuid();
    if (Platform.isMacOS) return _readMacOsPlatformUuid();
    if (Platform.isLinux) return _readLinuxMachineId();
    return null;
  }

  /// Windows：注册表 MachineGuid（OS 安装时生成，同机所有用户 / 所有程序一致）。
  ///
  /// `reg query` 输出形如：
  ///   HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Cryptography\MachineGuid
  ///       MachineGuid    REG_SZ    4a3b9c8e-…
  /// 取最后一列即可。失败时再试 PowerShell（某些精简环境没有 reg.exe）。
  static Future<String?> _readWindowsMachineGuid() async {
    const key = r'HKLM\SOFTWARE\Microsoft\Cryptography\MachineGuid';
    final regOut = await _runCapture('reg', ['query', key, '/v', 'MachineGuid']);
    final fromReg = _parseRegValue(regOut);
    if (fromReg != null) return 'win-$fromReg';

    final psOut = await _runCapture('powershell', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '(Get-ItemProperty "$key").MachineGuid',
    ]);
    final fromPs = psOut?.trim();
    if (fromPs != null && fromPs.isNotEmpty) return 'win-$fromPs';
    return null;
  }

  /// 从 `reg query` 输出里抠 REG_SZ 值：找含 MachineGuid 的行，取最后一个非空字段。
  static String? _parseRegValue(String? output) {
    if (output == null || output.isEmpty) return null;
    for (final line in output.split(RegExp(r'\r?\n'))) {
      if (!line.contains('MachineGuid')) continue;
      final parts = line.trim().split(RegExp(r'\s+'));
      final value = parts.isNotEmpty ? parts.last.trim() : '';
      if (value.isNotEmpty && value.toLowerCase() != 'machineguid') return value;
    }
    return null;
  }

  /// macOS：IOPlatformUUID（等同 Windows MachineGuid 的机器级标识）。
  static Future<String?> _readMacOsPlatformUuid() async {
    final out = await _runCapture('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice']);
    if (out == null) return null;
    final m = RegExp('"IOPlatformUUID"\\s*=\\s*"([^"]+)"').firstMatch(out);
    final uuid = m?.group(1)?.trim();
    if (uuid == null || uuid.isEmpty) return null;
    return 'mac-$uuid';
  }

  /// Linux：/etc/machine-id（缺省时退回 /var/lib/dbus/machine-id）。
  static Future<String?> _readLinuxMachineId() async {
    for (final path in const ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
      try {
        final text = File(path).readAsStringSync().trim();
        if (text.isNotEmpty) return 'lnx-$text';
      } catch (_) {}
    }
    return null;
  }

  // ── 兜底：按安装实例的持久化随机 id ──

  static const String _fallbackFileName = 'sync_device_id.txt';

  static Future<String?> _readOrCreatePersistedId() async {
    try {
      // 注意：公开 API 是 getApplicationSupportDirectory()（返回 Directory）；
      // getApplicationSupportPath() 只是平台接口的内部方法，直接调会 Method not found。
      final dir = await getApplicationSupportDirectory();
      final file = File(p.join(dir.path, _fallbackFileName));
      final existing = await file.exists() ? (await file.readAsString()).trim() : '';
      if (existing.isNotEmpty) return 'app-$existing';
      final rand = _randomHex(16);
      await file.writeAsString(rand, flush: true);
      return 'app-$rand';
    } catch (_) {
      return null;
    }
  }

  static String _randomHex(int length) {
    final rand = Random();
    const hex = '0123456789abcdef';
    final buf = StringBuffer();
    for (var i = 0; i < length; i++) {
      buf.write(hex[rand.nextInt(16)]);
    }
    return buf.toString();
  }

  static Future<String?> _runCapture(String exe, List<String> args) async {
    try {
      final result = await Process.run(exe, args, runInShell: Platform.isWindows);
      if (result.exitCode != 0) return null;
      final out = result.stdout;
      return out is String ? out : null;
    } catch (_) {
      return null;
    }
  }
}
