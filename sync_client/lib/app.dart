import 'package:flutter/material.dart';
import 'package:get/get.dart';

import 'core/i18n.dart';
import 'ui/home_view.dart';
import 'ui/login_view.dart';
import 'ui/settings_view.dart';

/// 应用根组件
class SyncApp extends StatelessWidget {
  const SyncApp({super.key, required this.initialRoute});

  final String initialRoute;

  @override
  Widget build(BuildContext context) {
    return GetMaterialApp(
      title: 'WaterNasSync',
      debugShowCheckedModeBanner: false,
      translations: SyncTranslations(),
      locale: const Locale('zh', 'CN'),
      fallbackLocale: const Locale('zh', 'CN'),
      theme: buildSyncTheme(),
      initialRoute: initialRoute,
      getPages: [
        GetPage(name: '/login', page: () => const LoginView()),
        GetPage(name: '/home', page: () => const HomeView()),
        GetPage(name: '/settings', page: () => const SettingsView()),
      ],
    );
  }
}

/// 浅色主题。
///
/// 刻意只设置跨 Flutter 版本都稳定的字段（各控件的细节样式在各页面内就地指定），
/// 避免 `CardTheme` / `CardThemeData` 这类版本间改名的类型引发编译差异。
ThemeData buildSyncTheme() {
  final scheme = ColorScheme.fromSeed(
    seedColor: const Color(0xFF2563EB),
    brightness: Brightness.light,
  );
  return ThemeData(
    useMaterial3: true,
    colorScheme: scheme,
    scaffoldBackgroundColor: const Color(0xFFF7F8FA),
  );
}
