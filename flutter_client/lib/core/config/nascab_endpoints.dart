import 'package:flutter/foundation.dart';

class NasCabEndpoints {
  NasCabEndpoints._();

  /// 本项目是 GNasCab（fork 自 nascab/NasCabOS），发行仓库在这里。
  /// 版本检查只认这个仓库的 release —— 见 `utils/update_check_helper.dart`。
  static const String githubRepo = 'colaKot/WaterNasOS';

  // defaultValue: kReleaseMode ? 'https://nas.cab' : 'https://test.nas.cab',
  static const String websiteBaseUrl = String.fromEnvironment(
    'NASCAB_WEBSITE_BASE_URL',
    defaultValue: kReleaseMode ? 'https://nas.cab' : 'https://nas.cab',
  );
  // defaultValue: kReleaseMode ? 'https://nas.cab' : 'https://test.nas.cab',
  static const String signalBaseUrl = String.fromEnvironment(
    'NASCAB_SIGNAL_BASE_URL',
    defaultValue: kReleaseMode ? 'https://nas.cab' : 'https://nas.cab',
  );
}

