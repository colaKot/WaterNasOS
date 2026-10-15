# WaterNasOS Sync — Windows 独立同步客户端

电脑 ↔ NAS 目录同步的**独立小程序**。不依赖整套 WaterNasOS 客户端，装完就一个托盘图标，
关窗不退出，后台按需 / 定时把指定的电脑目录与 NAS 目录保持一致。

产物：`WaterNasSync.exe`

---

## 为什么是独立程序

主客户端（`flutter_client`）里已经有一个「同步」App，但它得整个客户端装起来。
这个程序只做同步这一件事：登录 → 列任务 → 同步 → 托盘常驻，砍掉了照片、音乐、影视、文件管理
等全部其它模块，也不需要用户理解 WaterNasOS 的其它能力。

---

## 目录结构

```
sync_client/
├── lib/
│   ├── main.dart              入口：窗口、登录态预恢复、宿主装配、托盘初始化
│   ├── app.dart               GetMaterialApp + 路由 + 主题
│   ├── core/
│   │   ├── api.dart           精简 HTTP 封装（Bearer / 401 自动刷新 / 错误中文化）
│   │   ├── session.dart       登录态、token 刷新与持久化
│   │   ├── app_prefs.dart     开机自启开关、全局暂停、设备标识
│   │   └── i18n.dart          简体中文文案表（保留 .tr 调用方式）
│   ├── sync/
│   │   ├── desktop_host_impl.dart  SyncHost 实现（鉴权 / 上传 / 直连下载 / 协议调用）
│   │   ├── sync_api_service.dart   /api/sync/* 接口（路径与请求体来自共享包）
│   │   ├── sync_uploader.dart      分块上传（桌面直连版）
│   │   └── sync_controller.dart    任务列表控制器
│   ├── desktop/
│   │   ├── tray.dart          托盘常驻 + 关窗隐藏
│   │   └── autostart.dart     开机自启（写 HKCU Run 项）
│   └── ui/                    登录 / 任务列表 / 任务编辑 / 设置
├── assets/                    图标
└── windows/                   Windows 平台工程
```

---

## 构建

```bash
cd sync_client

# 1. 必须先跑 pub get —— windows/flutter/generated_plugins.cmake
#    和 generated_plugin_registrant.cc 由它生成，否则插件不会被注册
flutter pub get

# 2. 构建
flutter build windows --release
```

产物路径：

```
build/windows/x64/runner/Release/WaterNasSync.exe
```

**分发时要把整个 `Release` 目录打包**，不能只拷 exe —— 还需要同级的
`flutter_windows.dll`、`data/` 目录（含 Dart AOT 快照与资产）以及各插件的 dll。
仓库里提供了打包脚本：

```bash
python tool/_pack_sync_zip.py            # 产物 zip 落到 G:\work\_dist
python tool/_pack_sync_zip.py <输出目录>
```

调试运行：

```bash
flutter run -d windows
```

> ✅ **已编译验证**（2026-10-12）：`flutter build windows --release` 通过，
> `√ Built build\windows\x64\runner\Release\WaterNasSync.exe`（74.5s），
> 产物可直接双击启动（Impeller/OpenGL 后端正常初始化）。

---

## 首次使用

1. 启动 `WaterNasSync.exe`
2. 填服务器地址（如 `http://192.168.1.100:8080`）、账号、密码，登录
3. 点右下角「新建同步任务」
   - 选电脑目录（可以用「编辑」按钮挑），NAS 目录手工输入服务端路径（如 `/volume1/backup/docs`）
   - 选同步模式：双向 / 仅下载 / 仅上传
   - 按需配置过滤规则
4. 保存后任务出现在列表里，托盘图标右键可「立即同步全部」/「暂停自动同步」

关掉窗口程序**不会退出**，仍在托盘后台同步。要真正退出走托盘右键 → 退出。

---

## 与主客户端的代码关系

同步核心**不是复制，是共享包**：本项目与 `flutter_client` 都依赖
`packages/nascab_sync_core`，同一份代码。

| 代码 | 位置 |
|---|---|
| 数据模型 / 本地扫描 / 基线库 / 调度 / 协议定义 / 同步引擎 | `packages/nascab_sync_core`（两端共用） |
| 宿主实现（鉴权、上传、下载通道、协议调用） | 本项目 `lib/sync/desktop_host_impl.dart` |
| 对端宿主实现 | `flutter_client/lib/modules/sync/service/sync_host_impl.dart` |

引擎与宿主之间只有 `SyncHost` 一个接口（7 个方法），详见
`packages/nascab_sync_core/README.md`。

**同步语义（比对规则、路径处理、mtime 对齐、删除传播、分块大小）只能改共享包**，
改完两端同时生效。两端确实需要不同行为时，加 `SyncHost` 方法，不要在共享包里加
`if (isDesktop)` 分支。

### 与主客户端的有意差异

- 下载通道只走直连（独立程序没有 P2P 中继）
- 宿主不复用主客户端 700 行的 `BaseApiService`（弹窗 / 2FA / 路由跳转耦合太重），
  改为 `core/api.dart` 里的精简实现；上传走 `sync_uploader.dart`，协议完全一致
- 托盘常驻、开机自启、`--autostart` 静默启动是主客户端没有的桌面能力

---

## 平台工程改动记录

从 `flutter_client/windows` 复制后做了这些改造，避免两个程序互相干扰：

| 位置 | 改动 | 原因 |
|---|---|---|
| `windows/CMakeLists.txt` | `project` / `BINARY_NAME` → `WaterNasSync` | 产物名区分 |
| `windows/runner/utils.cpp` | 单实例 mutex → `Global\WaterNasSync_SingleInstance` | **关键**：与主客户端同名会互斥，两者只能开一个 |
| `windows/runner/utils.cpp` | 窗口类名 → `NASACB_SYNC_WIN32_WINDOW` | 避免单实例激活时误找主客户端窗口 |
| `windows/runner/utils.cpp` | 单实例消息名 → `WaterNasSync_ShowExistingInstance` | 同上 |
| `windows/runner/main.cpp` | 窗口标题 `WaterNasSync`，尺寸 1000×720 | |
| `windows/runner/Runner.rc` | 产品名 / 文件名 → `WaterNasSync` | 任务管理器、属性页显示 |
| `windows/runner/resources/app_icon.ico` | 换成同步专属图标 | |

---

## 已知限制 / 待办

- **NAS 目录目前是手工输入路径**，没有目录浏览器。下一步可以基于 `/api/file/list`
  做一个选择器，体验对齐主客户端的 `showFolderPickerBottomSheet`
- **只内置简体中文**，`core/i18n.dart` 已按多语言结构组织，加语言只需扩 map
- **未做过安装包**（Inno Setup / MSIX），当前是绿色目录分发
- 编译已通过（见「构建」），但**首次登录/同步的端到端流程仍需在真实服务端上跑一遍
- 普通用户能否同步某个 NAS 目录，取决于服务端权限模型；当前 `/api/sync/*` 只校验登录态，
  没有按路径鉴权（与主客户端现状一致）
