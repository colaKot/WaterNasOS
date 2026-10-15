# WaterNasOS 音乐（独立客户端）

复用主客户端 `flutter_client`（包名 `WaterNasOS`）**整套代码**的 Windows 独立程序，
产物 `NasCabMusic.exe`。音乐能力与主客户端完全一致（歌单 / 收藏 / 歌词 / 播放引擎 /
音频缓存），且**不复制任何业务代码**。

## 代码复用方式

`pubspec.yaml`：

```yaml
dependencies:
  WaterNasOS:
    path: ../flutter_client   # 主客户端 = 唯一代码源
```

`lib/main.dart` 只有 3 行有效代码：

```dart
Future<void> main() =>
    shell.runWaterNasOSApp(launchMode: shell_launch.AppLaunchMode.music);
```

`AppLaunchMode.music` 由主客户端 `lib/core/bootstrap/app_launch.dart` 定义，作用：

1. **登录 / 选服务器成功后整屏直接进入音乐** —— 不出现桌面、dock、启动器
   （`pc_home_page.dart` 在非 `full` 模式下直接渲染 `MusicMainView`，不再渲染虚拟桌面）；
2. 窗口标题为「WaterNasOS 音乐」（`AppWindowTitle.defaultTitle` 跟随启动模式）；
3. exe 图标与托盘图标均为音乐专属（由 `assets/app_icons/music.webp` 生成）。

### 怎么确认它是「独立程序」

| 项 | 主客户端 | 本程序 |
|---|---|---|
| exe 名 | `WaterNasClient.exe` | **`NasCabMusic.exe`** |
| exe 图标 | 蓝色箭头（WaterNasOS） | **红色音符（音乐）** |
| 窗口标题 | `WaterNasOS` | **`WaterNasOS 音乐`** |
| 单实例 mutex | `Global\NasCabOS_SingleInstance` | **`Global\NasCabMusic_SingleInstance`** |
| 窗口类名 | `FLUTTER_RUNNER_WIN32_WINDOW` | **`NASACB_MUSIC_WIN32_WINDOW`** |
| 托盘图标 | `assets/tray_icon_round.ico`（WaterNasOS） | **音乐专属（已替换）** |
| Android applicationId | `com.nascabos.mobile` | **`com.nascabos.music`** |
| Android 桌面名 | `WaterNasOS` | **`WaterNasOS 音乐`** |
| Android 图标 | 主端图标 | **红色音符（各密度 15 张已替换）** |

两者可同时运行、互不干扰（单实例锁与窗口类名都不同），任务栏是两个独立图标；
Android 侧 applicationId 不同就能与主客户端、相册端**三个 App 同时安装在一台手机上**。

> **改动只做在主客户端**（`flutter_client/`），本工程自动生效 —— 同一个代码源。

## 构建

```bash
cd music_client
flutter pub get                 # 必须先跑：会生成 windows/flutter/generated_plugins.cmake、
                                # android/app/src/main/java/io/flutter/plugins/GeneratedPluginRegistrant.java 等

# Windows
flutter build windows --release
# 产物：build/windows/x64/runner/Release/NasCabMusic.exe（分发须整目录打包 exe + data/ + *.dll）

# Android
flutter build apk --release            # 产物：build/app/outputs/flutter-apk/app-release.apk
flutter build appbundle --release      # 上架 Google Play 用 AAB
```

> Android 发布签名：`android/app/build.gradle.kts` 的 release 走 `android/key.properties`
> （`storeFile` / `storePassword` / `keyAlias` / `keyPassword`）。该文件被 `.gitignore` 排除，
> 需自行创建；可与主客户端**共用同一个 keystore**（applicationId 不同即是不同 App）。

## 平台工程（已按「派生独立客户端三坑」改造）

### Windows

| 文件 | 改动 |
|---|---|
| `windows/CMakeLists.txt` | `project(NasCabMusic)` / `BINARY_NAME = NasCabMusic` |
| `windows/runner/utils.cpp` | 单实例 mutex `Global\NasCabMusic_SingleInstance`；窗口类名 `NASACB_MUSIC_WIN32_WINDOW`；单实例消息名 `NasCabMusic_ShowExistingInstance`；exe 名 `NasCabMusic.exe` |
| `windows/runner/main.cpp` | 窗口标题「WaterNasOS 音乐」，初始 1280×800 |
| `windows/runner/Runner.rc` | 产品名 / 文件描述 `WaterNasOS Music` |
| `windows/runner/resources/app_icon.ico` | 由 `assets/app_icons/music.webp` 转换而来 |
| `windows/flutter/generated_plugins.cmake`、`generated_plugin_registrant.cc` | **已清空**（跑 `flutter pub get` 后由工具填回） |

### Android

从 `flutter_client/android` 整棵复制后打补丁（生成器 `../tool/_gen_standalone_android.py`）：

| 项 | 改动 |
|---|---|
| `android/app/build.gradle.kts` | `namespace` / `applicationId` → `com.nascabos.music` |
| `android/app/src/main/kotlin/com/nascabos/music/` | Kotlin 包目录由 `mobile/` 改名而来，`package` / `import` 同步改写 |
| `AndroidManifest.xml` | `android:label` → **WaterNasOS 音乐** |
| `res/mipmap-*/{ic_launcher,launcher_icon}.png`、`res/drawable-*/ic_launcher_foreground.png` | 15 张图标全部由 `assets/app_icons/music.webp` 生成 |
| `app/src/main/java/.../GeneratedPluginRegistrant.java` | **已排除**（每次构建自动生成；留着会引用本工程没有的插件而报错） |

刻意**没动**的两处：

- MethodChannel 名 `com.nascabos/playback`、`com.nascabos/playback_events/*`
  —— Dart 侧（`media3_playback_engine.dart`）写死了同样的串；
- `MainActivity extends AudioServiceActivity` 与 manifest 里的 `AudioService` 服务声明
  —— 音乐播放靠它（含后台播放 / 通知栏 / 锁屏控制），所以音乐端**绝对不能**丢这一段。

## 已知限制 / 注意事项

- 本项目**未在本机编译验证**（本机 Dart 无法创建子进程，`flutter build` 跑不起来）。
  首次构建请在装有 Flutter SDK 的机器上执行，按提示修正。
- `assets/` 只复制了音乐 / 登录 / 主题用到的子集。**依赖方不会继承主客户端的
  `assets:` 声明**（也不会继承 `dependency_overrides`），所以这里必须各自复制 + 各自声明；
  声明时**子目录要逐条列出**（Flutter 的目录条目不递归，`music/musicCover96/` 这类
  分档封面目录漏一条就会在播放页缺图）。新增功能若引用了其他资源，需同步补进来。
- 有意不打包的资源（对应模块在本端不可达，不会触发）：
  `assets/book/`、`assets/web/`（阅读器）。
- `dependency_overrides`（audio_service / dchs_motion_sensors）已在本工程 `pubspec.yaml`
  里按其相对路径 `../flutter_client/packages/...` 同样声明 —— **音乐端尤其重要**：
  主客户端用的是打过补丁的本地 `audio_service`（修复桌面 `MediaSession.onPlayPause`
  不转发导致播放/暂停键无响应），不声明会静默退回 pub 版。
- 音乐模块含平台条件导入（`cache/music_audio_cache_io.dart` / `_stub.dart`），
  复用自动生效，无需在本工程重复。
- 服务端 `src/config/config.js` 的 `defaultApps` **无需改动**（`photo` / `music` 本来就在里面）。

## 自检

```bash
python ../tool/_check_standalone_pubspec.py    # assets / dependency_overrides / fonts 是否都落地
python ../tool/_check_standalone_assets.py     # lib 里引用的 assets 是否都拷到了
python ../tool/_check_standalone_android.py    # 安卓端 applicationId / 包名 / label / 图标是否真正独立
```

三者都是静态比对，**不替代** `flutter build` 的编译与资产校验。

方案与设计说明见 `../docs/相册同步MD5去重与独立App方案.md`。
