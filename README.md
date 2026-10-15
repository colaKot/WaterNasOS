# WaterNasOS

> **简体中文** | [English](README.en.md)

WaterNasOS 是一款跨平台 NAS 软件，支持远程管理照片、影音、音乐、图书和文件，并提供文件分享、Transmission 下载、Docker 管理、远程终端、多端目录同步等能力，手机、电脑、电视与网页端共用同一套服务端。

## 项目来源与许可证

> WaterNasOS 是基于 [NasCabOS](https://github.com/nascab/NasCabOS) 二次开发的**修改版**，依据 **GNU GPL v3.0** 发布与再分发。
> 上游原始版权归 Beijing Yunpiao Piao Technology Co., Ltd. 所有（© 2025）；本仓库新增与修改部分的版权归 **colaKot** 所有（© 2026）。
> 本仓库自 **2026-10** 起在原项目基础上完成下述更名、功能增删与全局调整，修改部分同样以 GPL-3.0 授权。
> 完整许可证与原始版权声明见仓库根目录 [LICENSE](LICENSE)，未做任何删改；网络协议、设备指纹与加密数据格式保持兼容。

## 本版本改动一览

以下为本版相对上游的全部改动：较早的功能改动在前，「近期更新」为最近追加的内容，全局性调整在最后。

### 功能改动

- **多端目录同步**：新增 Windows 独立同步客户端 `sync_client` 与共享核心包 `packages/nascab_sync_core`，PC 主客户端与独立同步端共用同一套同步引擎与传输协议；服务端新增 `/api/sync` 命名空间与 `tableSyncTask`、`tableSyncRecord` 两张表。
- **子账号权限体系**：新增应用级访问白名单（`appAccessGuard`）与路径级细粒度权限，可按用户限定可访问目录与操作范围（`/api/user/access-policy`），详见 `docs/子账号权限方案.md`。
- **影视库支持多库**：新增 `video_library` 实体，可分别建立电影 / 电视剧 / 图片 / 混合媒体库，每个库带独立的「在主页显示」开关；图片库与混合库另有自己的网格浏览与全屏查看页。升级时按 `media_type` 自动回填老数据。
- **相册 / 音乐独立客户端**：新增 `photo_client` 与 `music_client`，产出 `NasCabPhoto.exe`、`NasCabMusic.exe`。两者以 path 依赖复用主客户端，**不复制任何业务代码**——`main.dart` 只有三行，设置启动模式（`AppLaunchMode.photo` / `.music`）后即直达相册或音乐，图标与窗口标题各自独立。
- **主题系统**：新增 26 套可在运行时切换的配色方案（设置 → 主题），并抽出设计 token 层（`app_tokens.dart`），把原先散落全项目的间距 / 圆角 / 控件尺寸硬编码数字收成命名常量。
- **相册备份内容级去重**：备份前先比对 NAS 端的**大小 + 内容 MD5**，内容一致直接跳过，不再重复传输未变更的文件。

### 近期更新

- **图片 / 混合媒体库浏览体验**：
  - 新增**排序菜单**（名称 / 拍摄时间 / 查看时间 / 添加时间，默认名称升序），图片库与混合库共用一套，**按库独立记忆**排序偏好。
  - 名称排序采用**自然序**：`(1) < (2) < (10) < (11)`，不再是文本序的 `1, 10, 11, 2`。实现上为 `image_index` / `video_index` 各增 `natural_name` 列并建索引，排序走覆盖索引。
  - **瀑布流**（手写零依赖实现，按图片真实宽高比排版）与**普通网格**两种视图可切换；另有**文件夹层级 / 整库平铺**、**封面图 / 缩略图**、**名称显示**三个开关，均按库独立持久化。
  - 全屏查看器：左右按钮 + 键盘方向键**循环翻页**；混合库中点击视频**直接进入播放页**。
  - 图片缩略图默认**按需生成**（后台常驻 worker 排队），避免全量预生成占用资源。
- **播放器与转码**：
  - **播放画质多档可选**（原始 / 4K / 1080p / 720p / 480p 多档码率），可为库设定默认档位。
  - **音频响度归一化**（按库开关）：可选在扫描时测量该库视频响度，转码时做两遍线性 `loudnorm` 归一，输出音量更一致。
  - **音频降混**开关（默认关闭，保持源声道数）；不支持音频的视频改为**仅转音频**（`-c:v copy`），避免无谓的画质损失。
  - 影片信息卡展示 **4K / HDR10+ / 杜比视界 / 杜比全景声** 等标识（直接读 ffprobe 元数据，无需重扫库）。
- **相册用户隔离**：新增 `uid` owner 维度，**每个用户只看到自己名下的照片与相册**（时间线、人脸、地点、相册、收藏、回收站、AI 搜索统一走同一套可见性判定）；底层索引（缩略图 / 人脸 / 地点 / 相似图）仍保持全局共用，隔离只做在读取层。
- **AI 与识别**：人脸识别模型更换为 **EdgeFace**；相册搜索增强；足迹地图与人脸相关的 GPU 路径优化。
- **TV 端**：新增播放设置引导页与播放参数持久化。
- **界面**：各客户端 App 图标与首页图标资源整体更新。

### 全局性调整

- **项目更名**：项目名与各端显示名统一改为 **WaterNasOS**（Windows 服务端显示为 WaterNasOSServer，TV 端为 WaterNasOS TV）；Flutter 包名由 `NasCabOS` 改为 `WaterNasOS`。桌面主客户端程序名 **WaterNasClient**，独立同步端 **WaterNasSync**。
- **保持兼容**：`applicationId`、iOS Bundle ID、鸿蒙 `bundleName` 等应用标识**保持不变**，已安装用户可正常覆盖升级；网络协议、设备指纹与加密数据格式均未改动。
- **仓库精简**：不再随仓库提供第三方运行时二进制（sftpgo、openlist、ffmpeg、ffprobe、rclone、transmission）与 AI 模型（`onnx_models`）、CocoaPods 依赖树、地名库；可运行 `tool/fetch_nascab_assets.py` 从官方资源清单获取。
- **联系与捐助**：更新为本仓库维护者的微信收款二维码与邮箱。

## 内置应用

WaterNasOS 的每一项功能都是**独立的 App**：有自己的图标、独立页面栈和独立的服务端 API 命名空间，
PC 端还可以从主窗口单独打开。默认应用列表由服务端下发（见 `electron_server/src/config/config.js`
的 `defaultApps`），用户可在设置中隐藏或重新排序。

| 应用 | key | 说明 |
| --- | --- | --- |
| 文件管理 | `folder` | 文件浏览、上传下载、分享 |
| 照片管理 | `photo` | 时间线、自建相册、智能相册、照片合集、人脸/场景识别、相似照片、GPS 补录、足迹地图、那年今日、回收站；**按用户隔离**，各自只看自己的照片 |
| 影视库 | `movie` | 电影与电视剧管理，支持常见视频格式，可建电影/电视剧/图片/混合多库；图片库与混合库支持排序（自然序）、瀑布流/网格、文件夹层级 |
| 图书馆 | `book` | 电子书阅读，支持 EPUB / MOBI / AZW3 / PDF / TXT 等格式 |
| 音乐库 | `music` | 歌曲、专辑、歌手、播放列表、合集、收藏，内置全屏播放器（动态歌词、唱片动效、后台播放） |
| 笔记 | `note` | 富文本笔记 |
| 加密空间 | `encrypted` | AES 加密保存文件，密码加密后存于本机数据库 |
| 媒体工具 | `media_tool` | 批量压缩图片、视频转换 |
| 同步管理 | `sync` | 电脑文件夹与 NAS 目录同步，支持双向 / 仅下载 / 仅上传与过滤规则 |
| 终端 | `terminal` | 远程终端，屏蔽 rm、unlink 等敏感命令 |
| Transmission | `transmission` | BT 下载管理 |
| Docker | `docker` | 宿主机镜像、容器、任务管理 |
| 备份 | `backup` | 手机相册与文件备份 |
| 远程挂载 | `mounts` | 把网络磁盘挂载到服务器目录 |
| 分享管理 | `share` | 通过 WebDAV / FTP / SFTP 等协议分享磁盘 |
| 系统监控 | `monitor` | 实时查看服务器硬件使用情况 |
| 任务中心 | `task_center` | 后台任务查看 |
| 安全中心 | `security` | 登录与安全设置 |
| 用户管理 | `user` | 用户与权限管理 |
| 进程 | `process` | 进程查看 |
| 服务 | `nascab_service` | 服务端状态与账户 |
| 配置中心 | `setting` | 全局设置 |

> `transmission`、`terminal`、`user`、`mounts`、`docker`、`nascab_service`、`monitor`、`process`
> 默认对普通用户隐藏，仅管理员可见。若首页看不到某个应用，多半是被「隐藏应用」挡住了，
> 在设置里恢复即可。

## 项目结构

本代码包含主要以下几个项目：

| 项目 | 说明 |
| --- | --- |
| electron_server | 后端，使用 electron + express 实现本地服务功能 |
| flutter_client | Android + iOS + Windows + Mac 客户端，使用 flutter 实现跨平台客户端 |
| harmony_client | 鸿蒙端，开发中 |
| tv_android | Android TV 端 |
| tv_apple | Apple TV 端 |
| sync_client | Windows 独立同步客户端 |
| photo_client | Windows 相册独立客户端（以 path 依赖复用 `flutter_client`） |
| music_client | Windows 音乐独立客户端（以 path 依赖复用 `flutter_client`） |
| packages/nascab_sync_core | 目录同步核心共享包，PC 主客户端与独立同步端共用 |
| tool | 开发环境脚本与静态自检脚本 |

## 运行方式

服务端运行方式：
先要将 releases 中提供的依赖库和插件（https://github.com/colaKot/WaterNasOS/releases）下载到本地，然后将对应平台的 libs 以及 onnx_models 解压缩后放到 electron_server 根目录下，libs 中是第三方相关插件，onnx_models 中是 ocr 相关模型文件，用于图像识别

```bash
npm i;
npm start;
```

客户端运行方式：

```bash
flutter pub get;
flutter run -d win/ios/android/mac
```

如何把网页端编译后放到服务端下，实现静态网页端的访问：

```bash
将flutter打包web端后放入electron_server/web/main目录下
```

## 捐助支持

如果 WaterNasOS 对您有帮助，欢迎捐助支持我们：

<div align="center">

<img src="qrcode-wechat.webp" width="200" alt="微信捐助二维码" />

</div>

商务合作/联系我们：cola23@126.com

## 许可证

WaterNasOS 以 [GNU General Public License v3.0](LICENSE) 发布。

- 上游原始作品版权归 **Beijing Yunpiao Piao Technology Co., Ltd.** 所有（© 2025），此声明原样保留。
- 本仓库新增与修改部分的版权归 **colaKot** 所有（© 2026）。
- 本仓库在原作品基础上完成的修改，同样以 GPL-3.0 授权，修改日期 **2026-10**。
- 任何再分发者均须保留上述版权声明与许可证全文，并同样以 GPL-3.0 公开源代码。

## 第三方资源与致谢

- [Tabler Icons](https://github.com/tabler/tabler-icons)：窗口控制按钮等界面图标（**MIT License**，© Paweł Kuna），通过 Dart 包 `tabler_icons_plus` 引入。