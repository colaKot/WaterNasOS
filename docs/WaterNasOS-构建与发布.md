# WaterNasOS 构建与客户端发布

> 从 `memory/MEMORY.md` 外迁的构建细节（MEMORY.md 有注入上限，只留指针）。
> 环境：Windows，零下载资源池 `G:\work\_toolchain\`（Flutter 3.47.5 = `flutter-sdk\flutter`、JDK17、Android SDK 36 / NDK 28.2.13676358、离线 pdfium）。

## 0. 通用铁律

- 所有 batch 一律 `tool/env.bat` 同款变量；**`.bat` 里不许有中文注释**（cmd 按 GBK 解码），**也不要在 `rem` 行写圆括号**。
- **Agent 树里跑不了 flutter** ⇒ 用 `tool/build-bridge.bat` 起桥，再
  `python tool/bridge_cli.py run --cwd G:\work\nascab --timeout 3600 --shell "<abs>\tool\xxx.bat"`。
  **桥接回包里的 `rc` 不可信**，只看日志里的 `EXITCODE=0`。
- 长构建**先重定向日志再 tail**；进度看**日志大小 + mtime**，不看最后一行。
- 判定成功一律「日志关键字 + 产物 mtime」，不看退出码本身。

## 1. 网页端（web）

| 步骤 | 命令 | 判据 |
|---|---|---|
| 编译（**唯一闸门**） | `tool/build_web.bat` | 日志 `√ Built build\web` + `EXITCODE=0`（≈125s） |
| 热更进服务端包 | `tool/dev_update.py --dist dN` | 1~2s |

- ⛔ `flutter build bundle` **不是**闸门；⛔ `dart analyze` 常无响应 ⇒ 用
  `check_dart_imports.py` + `check_dart_brackets.py` 补（两者都不查 switch 穷尽性）。
- ⭐**改了 web 要拷两处**：`<dist>/win-unpacked/web/main/` + `electron_server/web/main/`，
  必须**整目录同步 `*.js` + `*.part.js` + `*.map`**（dart2js 把代码散在 22 个
  `main.dart.js_N.part.js`，只换 `main.dart.js` ⇒ **整站白屏**）。
- ⚠️ **中文 i18n 在 `main.dart.js_1.part.js`**，grep `main.dart.js` 找中文是假阴性。
- ⚠️ **dart2js 会 mangle 符号名** ⇒ 只能搜字符串/数字字面量证明「改动进包」；
  而 **AOT 快照（`app.so`）保留符号名**，可直接按 ASCII 搜函数名，中文按 **UTF-16LE** 搜。
- SW 与三层缓存仍在 ⇒ 测完要**关标签页 + 硬刷新**。

## 2. 服务端整包（Electron）

`tool/build_server_pack.bat [dist_vN] [nokill]`（≈200s）

⛔⛔ **顺序不能反**，否则产物里是旧 web：

1. `tool/build_web.bat`
2. `tool/build_server_pack.bat dist_vN`（⚠️ 同名 dist 要先清空，回收站装不下 ⇒ **一律换新号**）
3. `tool/_sync_web_build.py`（把 `DSTS` 改到新 dist）—— pack 拷的是 `electron_server/web/main`，是旧货

复核用**递归** md5（顶层 `ls | wc -l` 会把 `assets/canvaskit`、`icons` 子目录算进去，34 vs 32 是假差异）。

产物：`electron_server/dist_vN/win-unpacked/`，主程序 `WaterNasOSServer.exe`，
日志 `win-unpacked/logs/combined.log`（**JSONL**，Python 逐行 `json.loads`）。

## 3. 桌面客户端（Flutter Windows）

`tool/build_main_win.bat`（主端，≈176s）｜`tool/_build_sync_win.bat`（只打 sync，≈75s）｜`tool/build_music_sync_win.bat`

- 都保留 `del CMakeCache.txt`，否则 fvp 会去 sourceforge 拉 mdk-sdk 卡死
  （正确做法是把已验证的 `mdk-sdk` 与 `.7z` 拷进 `pub.dev` 那份 fvp 缓存；
  两个 pub 源并存，`.plugin_symlinks/fvp` 的 realpath 决定读哪份）。
- ⭐ 只有 Dart 变时 `WaterNasClient.exe` mtime **不变是正常的** —— 真身在 AOT 快照
  `Release/data/app.so`；`flutter build windows` 走 path 依赖 ⇒ 改 `packages/` 会一起进包。
- ⚠️ `flutter build windows` 需系统「开发人员模式」。
- 分发：`tool/_pack_main_win_zip.py` ⇒ `G:\work\_dist\WaterNasClient-win-x64-<ver>-<date>.zip`
  （整目录打包，含 exe + ~40 个 dll + `data/`）。
- 启动自检：`./WaterNasClient.exe` 打印 `Using the Impeller rendering backend` + 中文语言检测日志即 OK。

## 4. 安卓客户端（Flutter Android）

`tool/build_main_android.bat`（主端）｜`tool/build_photo_android.bat`（相册）

```bat
flutter build apk --release --no-tree-shake-icons --no-pub ^
  --target-platform android-arm64 ^
  --android-skip-build-dependency-validation
```

- `--no-tree-shake-icons`：不加会停在 idle dartvm（2026-10-09 实测）。
- `--android-skip-build-dependency-validation`：Gradle 8.12 < Flutter 3.47.5 要求的 8.14，
  升级 wrapper 要下载，而本机只缓存了 `gradle-8.12-all` ⇒ 只能跳过校验。
- ⚠️ 机器默认 JDK 是 25，Gradle 8.12 直接拒 ⇒ 脚本里必须
  `flutter config --jdk-dir="G:\work\_toolchain\jdk17\jdk-17.0.20.1+1"`。

### 4.1 两个 gitignore 前置文件（仓库里没有，换机器要重建）

| 文件 | 内容 | 不写会怎样 |
|---|---|---|
| `android/local.properties` | `sdk.dir=G:\\work\\_toolchain\\android-sdk`（**转义双反斜杠**） | 落到系统 SDK ⇒ 缺 NDK 28.2.13676358 ⇒ 尝试下载 |
| `android/key.properties` | 见下 | release `signingConfig` 全 null ⇒ `Keystore file not set` |

`key.properties` 现用 **debug keystore**（与 photo_client 同一份）：

```
storePassword = <7 字符>
keyPassword   = <7 字符>
keyAlias      = androiddebugkey
storeFile     = C:/Users/cola/.android/debug.keystore
```

### 4.2 ⭐⭐⭐ pdfium 的 native-asset hook 会去 github 下载

`pdfium_dart-0.3.1/hook/build.dart` 从 `github.com/bblanchon/pdfium-binaries` 取 tarball，
本机不可达 ⇒ `PDFium download failed ... errno 121` ⇒ `Target build_hooks failed`。

**通法**（该 hook 开头就是「目标文件已存在就 return」）：

```
G:\work\_toolchain\pdfium\pdfium-android-arm64.tgz   →  解出 lib/libpdfium.so
   ↓
flutter_client\.dart_tool\hooks_runner\shared\pdfium_dart\build\chromium_7811\android-arm64\libpdfium.so
```

同目录下 `win-x64/pdfium.dll`、`android-arm/` 历史上已就位（桌面端一直靠它）。
**只预置了 arm64** ⇒ 构建必须带 `--target-platform android-arm64`。

> 通法推广：任何 native hook 报下载失败，先去**别的客户端**的
> `.dart_tool/hooks_runner/shared/<pkg>/build/` 找已下好的复制过来，比联网重下稳。

### 4.3 ⛔ `ndk.abiFilters` 对 Flutter 工程无效

`defaultConfig.ndk.abiFilters += "arm64-v8a"` **实测没用**（打完的包里仍是三个 ABI）。
要真正剔除，用 `packaging`：

```kotlin
packaging {
    jniLibs {
        excludes += listOf("lib/armeabi-v7a/**", "lib/x86/**", "lib/x86_64/**")
    }
}
```

效果：APK **143.9 MB → 87.2 MB**（`lib` 未压缩 119.7 MB → 69.8 MB）。
理由：flutter 侧只 AOT 编了 arm64，其余 ABI 剩下的全是第三方预编译 `.so`
（mdk / ffmpeg / webrtc），装到对应设备上会因缺 `libflutter.so` **运行期崩**，
不如直接剔掉 —— 既不误导安装，又省体积。

### 4.4 校验产物

```bash
BT=/g/work/_toolchain/android-sdk/build-tools/36.0.0
"$BT/zipalign.exe" -c -v 4 app-release.apk          # Verification successful
"$BT/aapt2.exe" dump badging app-release.apk        # package / versionName / native-code
"$JH/bin/java.exe" -jar "$BT/lib/apksigner.jar" verify --print-certs -v app-release.apk
```

### 4.5 ⚠️ 包名冲突

主端与 photo_client 的 `applicationId` **都是 `com.nascabos.mobile`**，且用同一张
debug 证书 ⇒ **装在同一台手机会互相覆盖**。要并存必须给其中一个改包名。

## 5. 分发产物一览（`G:\work\_dist\`）

| 产物 | 命名 |
|---|---|
| 桌面主客户端 | `WaterNasClient-win-x64-<ver>-<date>.zip` |
| 安卓主客户端 | `WaterNasOS-Android-arm64-<ver>-<date>.apk` |
| 同步工具 | `WaterNasSync-win-x64-<date>.zip` |

| 安卓 TV | `WaterNasOS-TV-<ver>-<date>.apk`（`tool\build_tv_android.bat release`） |

## 6. 安卓 TV（`tv_android/`）

### 6.1 构建与签名

```bash
cmd //c "tool\build_tv_android.bat release"   # 约 3~4 分钟，产出并签名到 G://work//_dist//
```

- 用 `%USERPROFILE%\.android\debug.keystore`（`androiddebugkey`）签名 ⇒ 与历史包同一证书，可覆盖安装。
- ⛔ **versionCode 必须递增**（当前 20 / versionName 2.0.0）：同 versionCode 的包在很多电视上会提示「应用未安装」。

### 6.2 ⛔ 升级提示 / 版本号 / 签名（2026-10 踩坑）

`https://nas.cab/config/updateInfo/android_tv.json` 指向
`download.nas.cab/app/android-tv/nascabos-android-tv-1.1.0.apk`（107,515,989 B，2026-10-13）：

- 实测该包：`com.nascabos.tv` / **versionCode=10** / **versionName=1.1.0** / 签名证书 **CN=nascabos**。
- 本仓库 `app/build.gradle.kts` 当时只有 `versionCode=9 / versionName=1.0.0`，
  ⇒ 每次启动都判定「有 1.1.0」并弹窗。
- ⛔ **跨签名的包不能覆盖安装**：本仓库脚本用 `%USERPROFILE%\.android\debug.keystore`
  （CN=Android Debug），而线上 1.1.0 是 CN=nascabos 签的。装在 1.1.0 上的机器必须先卸载，
  或改用发布 1.1.0 时的同一 keystore 签名。
- 现在版本号已抬到 **versionCode 20 / versionName 2.0.0**（必须都大于线上的 10 / 1.1.0，
  否则那个提示会一直出现）。

`TvAppUpdate.parseJson` 还要求配置**同时**带：

```json
{ "new_version": "1.1.0", "version_code": 11, "apk_package": "com.nascabos.tv",
  "apk_file_url": "https://.../xxx.apk", "constraint": false }
```

- 缺 `version_code` ⇒ 视为非本渠道，**一律不提示**（现有 android_tv.json 就是这种，需要发版时补字段）；
- `apk_package` 缺省视为同包，但建议显式写；
- 判定条件：`version_code > 本地 versionCode` **且** `new_version > 本地 versionName`。

### 6.3 应用白名单与图片授权（TV 端不支持应用）

- TV 首页的行（影视/相册/音乐）由 `GET /api/apps/getApps` 的 `all_app` 决定，服务端已按
  `userAllowedApps`（超管给子账号配的白名单）与 `normalUserNoShowApps` 过滤；无权限的应用整行不出现。
- ⛔ **封面走 `/api/file/tiny`**，它挂在 `/api/file`（folder 应用）前缀下。只给 `movie`/`music`
  的账号会因应用白名单 403 ⇒ **列表有、封面全空白**。因此 `appAccessGuard` 对
  `tiny / rawFile / mergeLvpVideo / attributes` 这四个**自带路径权限校验**的接口做了豁免
  （见 `PATH_LEVEL_GUARDED_API_PREFIXES`）。新增这类媒体辅助接口时要同步登记。

### 6.4 自动登录

`MainActivity.restoreSessionOrAutoLogin()`：

1. 本地 token 按 `lastLoginTime + expiresIn` 估算未过期且是直连地址 ⇒ 不发请求直接进首页；
2. 存了账号密码、没勾「每次都要输入密码」、且用户没主动登出（`auth_prefs/auth_auto_login_disabled`）⇒ 静默重登；
3. 都失败 ⇒ 静默退回服务器列表，用户点一下即可。
