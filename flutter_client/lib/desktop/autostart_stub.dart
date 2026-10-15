/// Web / 非 IO 环境占位：没有开机自启概念，一律返回不可用。
class AutoStart {
  AutoStart._();

  static Future<bool> isEnabled() async => false;

  static Future<bool> setEnabled(bool enabled) async => false;
}
