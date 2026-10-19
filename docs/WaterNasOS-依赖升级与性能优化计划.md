# WaterNasOS 依赖盘点与升级计划

> 盘点时间：2026-10-17　｜　数据来源：`npm outdated`、`dart pub outdated`、pub.dev / npm registry / Google Maven 实查
> 状态：**仅评估，未执行任何升级**

---

## 一、工具链基线

| 组件 | 当前 | 最新 stable | 差距 | 结论 |
|---|---|---|---|---|
| Flutter SDK | 3.47.5（2026-09-18） | **3.47.7**（2026-10-08） | 2 个 patch | 已在大版本最新线，只需补 patch |
| Dart SDK | 3.13.4 | 3.13.4 | — | 最新 |
| Flutter beta | — | 3.50.0-0.1.pre | — | 不用 |
| 本机 Node（构建用） | 22.22.2 | 26.12.0（current） | 大 | 构建链跟 Electron 走，暂不动 |
| Electron（服务端运行时） | **37.9.0**（内置 Node 22） | **44.9.0**（`@types/node` ^24 ⇒ Node 24） | **7 个大版本** | 最大的一块欠账，风险也最高 |
| electron-builder | 26.0.12 | 26.15.3 | 同 major | 可升 |
| @electron/rebuild | 4.0.1 | 4.2.1 | 同 major | 可升 |
| Gradle / AGP / Kotlin | 8.12 / 8.9.1 / 2.1.0 | — | 未落后明显 | Flutter 3.47 脚手架同款，保持 |
| NDK | 28.2.13676358 | — | — | 保持 |
| compileSdk / targetSdk | 36 | 36 | — | 最新 |
| HarmonyOS modelVersion | 6.0.2 | 6.0.2 | — | 最新主线 |
| tvOS deploymentTarget | 13.0（工程 17.0） | — | — | 保持 |

---

## 二、Flutter 客户端（flutter_client，direct deps 共 68 个）

### 2.1 可直接删除（代码里 0 引用，纯瘦身）

| 包 | 声明 | 实测引用文件数 | 说明 |
|---|---|---|---|
| `cached_network_image` | ^3.4.1 | **0** | 图片缓存已改走 `extended_image`；它正是 `image` 版本冲突的常见来源 |
| `cupertino_icons` | ^1.0.8 | **0** | 只用 Material Icons，不需要 |
| `unicode` | ^0.3.1 | **0** | 无引用（最新 1.1.9 也不需要追） |

> 删这三条不改变行为，但能减少解析图与潜在版本冲突。**建议 P0 第一批做。**

### 2.2 有大版本可升（按风险分组）

**A 组 — 与性能/体验直接相关**

| 包 | 当前 | 可解析 | 最新 | 说明 |
|---|---|---|---|---|
| `sqlite3` | 2.9.4 | 2.9.4 | **3.7.1** | 客户端本地库核心。3.x 走 native assets，**`sqlite3_flutter_libs` 已 EOL**（见下） |
| `sqlite3_flutter_libs` | 0.5.42 | 0.5.42 | **0.6.0+eol** | 官方描述：“Not used anymore, update to version 3.x of package:sqlite3” ⇒ 升级 `sqlite3` 后**应移除本包** |
| `fvp` | 0.38.1 | 0.38.1 | 0.39.1 | 视频播放内核（拖动/首帧/4K 解码稳定性） |
| `sqflite_common_ffi` | 2.3.7+1 | 2.3.7+1 | 2.4.4 | 随 `sqlite3` 3.x 一起动 |
| `image`（override） | 4.10.1 | 4.10.1 | 4.12.0 | 目前被 `dependency_overrides` 锁死，注释写明 4.11 的 png_decoder 用了 `ZLibDecoder.decodeLazy` 导致 Windows 编译失败 ⇒ 需重测能否解禁 |

**B 组 — plus 系大版本（API 改名密集，建议一次性做完）**

| 包 | 当前 | 最新 |
|---|---|---|
| `file_picker` | 10.3.10 | **13.1.0** |
| `share_plus` | 10.1.4 | **13.3.1** |
| `permission_handler` | 11.4.0 | **13.0.2** |
| `connectivity_plus` | 6.1.5 | **7.3.2** |
| `device_info_plus` | 12.4.0 | **13.3.0** |
| `package_info_plus` | 9.0.1 | **10.2.2** |

引用密度：`file_picker` 15 文件、`permission_handler` 5、`connectivity_plus` 4、`package_info_plus` 3、`share_plus` 2、`device_info_plus` 1 —— 改动集中，可控。

**C 组 — 桌面/UI 组件**

| 包 | 当前 | 最新 | 备注 |
|---|---|---|---|
| `flex_color_scheme` | 8.4.0（硬编码） | 9.0.0 | 主题体系，配合 `ThemeApplyService` 回归测试 |
| `tray_manager` | 0.5.3 | 0.8.0 | 托盘 |
| `desktop_drop` | 0.7.1 | 0.9.1（可解析 0.8.0） | 拖拽上传 |
| `wakelock_plus` | 1.5.2 | 1.8.1 | 6 文件引用 |
| `flutter_local_notifications` | 21.0.0 | 22.3.2 | |
| `pdf` | 3.12.0 | 3.13.1 | 导出 PDF |
| `flutter_lyric` | 3.0.2（硬编码） | 4.1.0 | 歌词组件，7 文件引用 |
| `panorama_viewer` | 2.0.7 | 3.0.0 | 全景 |
| `latlong2` | 0.9.1 | 0.10.1 | 足迹地图 |
| `audio_session` | 0.2.2（硬编码） | 0.2.4 | 与自编译 `audio_service` 联动，需同测 |

**D 组 — 已被约束卡住（暂不动）**

| 包 | 现状 | 原因 |
|---|---|---|
| `audio_service` | path override 自编译 0.18.18 | 修的是 `MediaSession.onPlayPause` 未转发，pub 版 0.18.19 未必含该修复 |
| `dchs_motion_sensors` | path override | 自维护 |
| `flutter_quill` | 11.6.0 硬编码 | 11.6.0 已是最新（要求 Flutter ≥3.44，满足） |
| `pdfrx` | 2.6.5 硬编码 | 已是最新 |
| `video_player` / `extended_image` / `flutter_webrtc` / `dio` / `photo_manager` / `flutter_map` | 2.14.1 / 10.1.0 / 1.6.2+hf4 / 5.11.1 / 3.12.0 / 8.3.2 | **全部已是最新** |

---

## 三、服务端（electron_server，dependencies 53 + dev 10）

### 3.1 性能相关（重点收益）

| 包 | 当前 | 最新 | 收益 | 风险 |
|---|---|---|---|---|
| `onnxruntime-node` | 1.20.0 | **1.30.0** | 跨 10 个小版本：Transformer 图优化、算子融合、线程池调度改进 ⇒ 人脸/OCR/SigLIP/DETR 四条 AI 队列吞吐 | ⚠ 实测当前 `listSupportedBackends()` 返回 `[{cpu,bundled},{dml,bundled}]`，**必须验证 1.30 在 Windows 上仍 bundled DirectML.dll**，否则 GPU 加速静默退回 CPU |
| `sharp` | 0.34.5 | **0.35.5** | libvips 大版本跃升 ⇒ 缩略图/转码吞吐 | 低。仅 3 处 `require`，且 `sharpConfigured.js` 已统一管理 cache/concurrency |
| `better-sqlite3` | 12.5.0 | 13.0.3 | 同步 API 微优化 | ⚠ Electron ABI，必须走 `@electron/rebuild`；建议**跟 Electron 一起升**，不单独升 |
| `knex` | 3.1.0 | 3.3.0 | 查询构建器修复 | 低 |

### 3.2 安全 / 稳定性小版本（低风险，建议 P0 打包）

`node-forge` 1.3.3→1.4.0（加密）、`axios` 1.13.2→1.20.0、`multer` 2.0.2→2.4.0（上传）、`express-validator` 7.3.0→7.3.2、`jsonwebtoken` 9.0.2→9.0.3、`fast-xml-parser` 5.3.3→5.11.2、`winston` 3.18.3→3.19.0、`yjs` 13.6.29→13.6.33、`systeminformation` 5.27.13→5.33.15、`ua-parser-js` 2.0.6→2.0.10、`pinyin-pro` 3.27.0→3.29.5、`nodejieba` 3.5.6→3.5.8、`libheif-js` 1.19.8→1.23.5、`fs-extra`、`jszip`、`ngeohash`、`i18n`、`cors`、`body-parser`、`compression`、`express-static-gzip`、`watchpack`、`@jvmr/pptx-to-html`、`@electron/rebuild`、`electron-builder`（留在 26.x）、`prettier`、`terser`、`supertest`

### 3.3 明确不动

| 包 | 当前 → 最新 | 原因 |
|---|---|---|
| `express` | 4.22.1 → 5.3.0 | ⛔ `tool/dump_openapi.js` 依赖 Express 4 的 `app._router` 抽路由表；升 5 会让 553 路径的 OpenAPI 单一真源失效 |
| `uuid` | 11.1.0 → 14.0.3 | ⛔ `"type": "module"` 且 exports **没有 require 出口** ⇒ CommonJS `require('uuid')` 直接炸（5 处引用） |
| `archiver` | 7.0.1 → 8.0.0 | ⛔ 同上，纯 ESM（5 处引用） |
| `crypto-js` | 4.2.0 → 4.1.1 | latest 反而更低，registry 版本错乱，别动 |
| `otplib` | 12.0.1 → 13.5.0 | 有 require 出口、可升，但 API 全面改为 `@otplib/*` 子包，需改 2FA 代码 ⇒ 独立排期 |
| `pac-proxy-agent` | 7.2.0 → 9.1.0 | ⚠ 记忆中的 `new https.Agent({keepAlive, createConnection})` 在 Node 22 走原型直连的坑 ⇒ 升级必须重验全局代理链路 |
| `node-datachannel` | 0.32.1 → 0.33.4 | 原生模块，跟 Electron 升级一起动 |
| `node-pty` / `bcrypt` | 1.1.0 / 6.0.0 | 原生模块，跟 Electron 升级一起重编 |

---

## 四、其他端

### Android TV（tv_android）

| 库 | 当前 | 最新 | 备注 |
|---|---|---|---|
| `androidx.media3:*` | 1.10.0 | **1.11.1** | 播放内核，值得跟 |
| `okhttp` | 4.12.0 | **5.5.0** | 大版本，`Interceptor` API 有变 |
| `kotlinx-coroutines-android` | 1.8.1 | 1.11.0 | |
| Gradle wrapper | 8.12（腾讯镜像） | 8.14+ | 与 AGP 8.9.1 配套，动了要全量验证打包 |
| `org.webrtc:google-webrtc` | 1.0.32006 | 停更 | 上游已归档，长期需换 LiveKit/自编 WebRTC（与 tv_apple 的 LiveKitWebRTC 统一） |
| `libvlc-all` | 3.5.1 | 3.6.x | 未核实，VLC 4 尚未稳定 |

### Apple TV（tv_apple）

`Alamofire 5.9`、`KeychainAccess 4.2.2`、`TVVLCKit`、`FSPlayer 1.0.4` —— 都是宽松 `from:` 约束，暂无升级压力；`xcodeVersion: "15.0"` 偏旧，若上 Xcode 26 需回归。

### HarmonyOS（harmony_client）

`@ohos/gsyvideoplayer ^1.0.3`、`@ohos/webrtc ^1.0.2` 由 OpenHarmony 三方库中心仓维护，版本节奏不受控，保持现状。

### 共用核心

`packages/nascab_sync_core` — 无第三方依赖压力，跟随主端 SDK 约束即可。

---

## 五、执行计划（四批，互相不阻塞）

### P0 — 零风险清理（预计 0.5 天）

1. `flutter_client/pubspec.yaml` 删除 `cached_network_image`、`cupertino_icons`、`unicode`。
2. 服务端小版本安全批量（3.2 全表），锁 `express` / `uuid` / `archiver` / `crypto-js`。
3. Flutter SDK 3.47.5 → 3.47.7。
4. `npm run depcheck` 复查是否有残留未用依赖。

**验收**：`dart analyze --no-fatal-warnings lib` 0 error；`tool/build_web.bat` 日志 `EXITCODE=0`；服务端 `node src/main_nascab_os.js` 起得来；`tool/dev_update.py` 热更后**重启**再验接口。

### P1 — 性能主力（预计 2~3 天，每项独立提交、可单独回滚）

1. **sharp 0.34.5 → 0.35.5**：跑一次全库缩略图基准（改造 `tool/_*.js` 脚本，真库真文件，≥500 张），对比耗时与内存峰值。
2. **onnxruntime-node 1.20.0 → 1.30.0**：
   - 先 `node -e "console.log(require('onnxruntime-node').listSupportedBackends())"` 确认仍返回 `dml`；
   - 再跑人脸 / OCR / 场景三条队列，对比单张耗时与 `gen_*` 归零速度；
   - 若 DML 丢失，退回 1.20 或改用 `onnxruntime-node` 的 DML 专用构建。
3. `knex` 3.1.0 → 3.3.0（顺带）。

**验收**：基准脚本输出的数字写进 `docs/WaterNasOS-图片库诊断与优化计划.md` 附录，不接受“应该更快”。

### P2 — 客户端大版本（预计 3~5 天，逐包单独提交）

1. `sqlite3` 2.9.4 → 3.7.1 + **移除 `sqlite3_flutter_libs`**（已 EOL）→ 本地库全链路回归（相册缓存、同步 baseline、播放进度）。
2. `image` override 解禁验证（4.10.1 → 4.12.0），Windows 编译过了才留。
3. plus 系六件套一起升（file_picker 13 / share_plus 13 / permission_handler 13 / connectivity_plus 7 / device_info_plus 13 / package_info_plus 10）。
4. C 组桌面组件（tray_manager / desktop_drop / wakelock_plus / flex_color_scheme / flutter_lyric / pdf / panorama_viewer / latlong2 / audio_session / flutter_local_notifications）。
5. `fvp` 0.38.1 → 0.39.1（影视库播放冒烟：H.264 / HEVC / fMP4 / 4K / 字幕）。

**验收**：win / mac / linux / android / web 五端构建通过 + 相册、影视、音乐、编辑器、足迹地图五项冒烟；`check_dart_brackets.py`、`check_dart_tr_keys.py` 全绿。

### P3 — 大版本攻坚（需单独窗口 + 全量备份，预计 3~5 天）

1. **Electron 37.9.0 → 44.9.0**（连带 Node 22 → 24）
   - `better-sqlite3` → 13.x、`node-pty`、`node-datachannel` 全部走 `@electron/rebuild`；
   - 复验 `tool/build_server_pack.bat` 整包链路；
   - **重点复验热更机制**：`dev_update.py` 只重写 asar 已有条目这一前提，在 Electron 44 的 asar 实现下是否仍然成立；
   - 复验单实例锁（`app.setPath` 必须在取锁前）、`onnx_models` 走 `extraFiles` 的路径回退。
   - 若上面任一项不通过，**停在 37.x 的最后一个 patch（37.10.3）** 也是可接受结果。
2. `otplib` 12 → 13（API 迁移，2FA 专项）。
3. `pac-proxy-agent` 7 → 9（全局/产品代理链路重验）。
4. Android TV：media3 1.11.1 + okhttp 5.x + coroutines 1.11。
5. **实验项**：`flutter build web --wasm`（当前是默认 dart2js）。skwasm 在渲染密集场景（瀑布流缩略图墙、地图）有明显收益，但要先验证 `webview_flutter` / `pdfrx` / `flutter_quill` 的 wasm 兼容性；不通过就放弃，不影响主线。

---

## 六、硬约束清单（做的时候必须记着）

- ⛔ **Express 4.22 的 `app._router`** 是 OpenAPI 导出的唯一抓手，Express 5 不动。
- ⛔ **纯 ESM 包不能进 CJS 服务端**：`uuid@14`、`archiver@8`（`"type":"module"` 且无 `require` 出口）。
- ⛔ **Electron 原生模块**（`better-sqlite3` / `node-pty` / `node-datachannel`）任何 Electron 变更都要重编，且**不能用系统 node 跑**（`ELECTRON_RUN_AS_NODE=1` + electron.exe）。
- ⛔ **asar 热更只重写已有条目**，新增 `.js` 必须整包；原地重写 asar 后**必须重启**（否则 `worker_threads` 读错位、接口 400）。
- ⛔ **`onnx_models` 在 extraFiles 不进 asar**，远端模式必须回退 `resolveBundledPath()`。
- ⛔ 升 `sqlite3` 3.x 会牵动 `sqlite3_flutter_libs` 的存在与打包方式（native assets），Android 派生端（`photo_client`）需重新 `flutter pub get` 且 bat 不能带 `--no-pub`。
- ⚠️ `sharp` 升级后 `sharpConfigured.js` 的 `cache` / `concurrency` 行为需复测（AI worker 里是 `concurrency(1)`）。

---

## 七、不建议做的

- 不追 Flutter beta 3.50（当前 3.47 已是最新 stable 线）。
- 不升 Express 5、不换 ORM、不换状态管理（`get` 518 处引用，收益不抵风险）。
- 不为“新”而升 `otplib` / `pac-proxy-agent`：这两个是功能面升级，不是性能升级，排到最后。
- 不在同一次提交里混“大版本升级”和“业务改动”。

---

## 八、收益排序（我的判断）

1. **onnxruntime-node 1.20 → 1.30** — 直接作用在四条 AI 队列，是全系统最重的 CPU 消耗点。
2. **sharp 0.34 → 0.35** — 缩略图是全站最高频 IO/CPU 操作。
3. **Electron 37 → 44** — web 端渲染（Chromium）与 Node 运行时整体抬升，但工程风险最高，收益是“面”不是“点”。
4. **客户端 sqlite3 2 → 3 + 去掉 EOL 包** — 解技术债，性能增量有限，但不做会挡住后续 Flutter 升级。
5. **plus 系大版本** — 体验与兼容性，不是性能。
6. **Flutter 3.47.5 → 3.47.7** — 几乎无感，但成本接近零。

---

# 执行记录（2026-10-17 第一批：P0 + P1）

> 结论先行：**P0 全部落地；P1 两项实测后全部回退**——都不是「升级有收益」，而是「升级有代价」。

## P0-A 删除客户端三条死依赖 ✅

`flutter_client/pubspec.yaml` 删除 `cached_network_image`、`cupertino_icons`、`unicode`。

`flutter pub get` 输出：`cached_network_image 3.4.1 / cached_network_image_platform_interface 4.1.1 / cached_network_image_web 1.3.1 / cupertino_icons 1.0.9 / lists 1.0.1 / octo_image 2.1.2` 全部移出依赖树，共 **6 个包**。

`dart analyze --no-fatal-warnings lib`：**74 issues，其中 error/warning = 0**（全是 info 级 lint）。

## P0-B 服务端小版本安全批量升级 ✅

升级 26 个纯 JS 包（运行时 20 + 开发 6），全部用 `--ignore-scripts` 装，避免触发根 `postinstall` 的 `@electron/rebuild`。

| 类型 | 包 |
|---|---|
| 运行时 | axios 1.13.2→**1.20.0**、knex 3.1.0→**3.3.0**、multer 2.0.2→**2.4.0**、node 生态 17 个（body-parser / compression / cors / express-static-gzip / express-validator / fast-xml-parser / fs-extra / i18n / jsonwebtoken / jszip / ngeohash / pinyin-pro / systeminformation / ua-parser-js / winston / watchpack / yjs） |
| 开发 | @electron/rebuild 4.0.1→**4.2.1**、electron-builder 26.0.12→**26.15.3**、prettier、terser、supertest |

**原生模块零改动**（升级前后 md5 逐字节一致）：

| 模块 | md5 |
|---|---|
| `better-sqlite3.node` | `ac1d8d0d3485576563c38f4fb5fd84ad` |
| `node-datachannel.node` | `8db4eb82d2d86070fd32a929a341cbea` |
| `nodejieba.node` | `f2d5bede98434907fafacdf469a10361` |

**冒烟 24/24 PASS**（`tool/_after_upgrade_smoke.js`，必须 `ELECTRON_RUN_AS_NODE` 跑）：每个包不只 require，还做了真实调用——JWT 签发+验签、geohash 编码、拼音转换、XML 解析、yjs 文本 CRDT、better-sqlite3 内存库读写、sharp 真跑一次 jpeg→webp 64x48→32x24。

**路由回归**：`tool/dump_openapi.js` 输出 **557 路径 / 34 模块**（较上次记录 553/33 多出的是后续新增的 plugin 等模块），Express 4.22.1 未被破坏。

## P0-C Flutter SDK 3.47.5 → 3.47.7 ✅

`flutter upgrade`（stable 分支）→ 3.47.7 / Dart 3.13.4。

`tool/build_web.bat` → **EXITCODE=0**，耗时 **2 分 6 秒**。
产物同步到 `electron_server/web/main`：**465 个文件，逐个 md5 校验 mismatch=0**。

> ⚠️ 新发现（不是本次引入，是 3.47.7 的告警）：`--pwa-strategy=none` 已被标记 **deprecated，未来版本会移除**。
> 到那天 `build_web.bat` 会直接报错（参数不可用），而不是自动忽略。届时改用 `web/index.html` 里的
> `flutter_bootstrap.js` 配置或直接删该参数（本仓库本来就不依赖 SW 缓存）。

## P1-A sharp 0.34.5 → 0.35.5 ❌ 回退

**先搞清了线上到底加载哪个 sharp**（这一步不做，后面全白测）：

`src/utils/sharpConfigured.js` 的加载顺序是 **① `libs/sharp/<platform>/<arch>`（源码构建，带 HEIC）→ ② npm 包**。
Windows 上 `libs/sharp/win/x64/package.json` 存在（version 0.34.5 / libvips 8.17.3），**所以 npm 包根本没被加载**。
`libs/sharp` 下只有 `win`，mac/linux 走 npm 包。

基准（`tool/_sharp_bench.js`，对齐 `genTinyFile` 真实管线：rotate + resize 640 inside + webp q70，400 张真实 JPEG，各 150 张）：

| 变体 | libvips | 串行 ms/张 | 并发4 张/秒 | RSS |
|---|---|---|---|---|
| npm 0.34.5 | 8.17.3 | 61.03 | 67.07 | 94 MB |
| npm 0.35.5 | 8.18.7 | 62.65 | **59.93** | 96 MB |
| **vendored 0.34.5（线上真实）** | 8.17.3 | 63.66 | 55.65 | 119 MB |

**判定**：0.35.5 串行慢 2.7%、并发吞吐低 10.6%，无任何收益；而 Windows 主平台压根不加载 npm 包。
⇒ **回退到 0.34.5**，`package.json` 恢复 `^0.34.5`。
> 想真正优化缩略图，方向不是升 npm sharp，而是**重新构建 `libs/sharp/win/x64`**（换 libvips 版本 / 开 HEIC 硬件加速），那才影响线上。

## P1-B onnxruntime-node 1.20.0 → 1.30.0 ❌ 回退（硬回归）

**先验包内容**：下载 1.30.0 tarball 确认 `bin/napi-v6/win32/x64/` 下 `DirectML.dll` + `dxcompiler.dll` + `dxil.dll` + `onnxruntime.dll` 齐全 ⇒ 后端没丢。

**但是升上去立刻炸两次**：

### 回归 1：`webgpu` 与 `dml` 互斥 ⇒ 所有会话创建失败

1.30 的 `listSupportedBackends()` 返回 **`cpu, dml, webgpu`**（1.20 只有 `cpu, dml`）。
而 `src/utils/onnxProviderUtil.js` 的 `getBestExecutionProviders()` 是「取所有非 cpu 后端 + cpu 兜底」⇒ 自动变成 **`[dml, webgpu, cpu]`**。
ORT 1.30 对此直接抛：**`DML EP can only be used with CPU EPs.`**
⇒ 人脸 / OCR / 场景 / 活动 / CLIP 检索 **全部 InferenceSession 创建失败**，AI 全链路停摆（不是变慢，是废掉）。

### 回归 2：CLIP 模型在 DML 上崩进程

排除 webgpu 后（只留 `dml,cpu`）单个模型实测：

| 模型 | ORT 1.20 | ORT 1.30 |
|---|---|---|
| DETR-R50-q4f16 | **57.9 ms** | 113.9 ms（**慢 97%**） |
| SigLIP2-base224-q4f16 | **72.1 ms** | 136.7 ms（**慢 90%**） |
| CLIP-vision | **38.5 ms** | **进程崩溃**（crashpad，无 JS 异常） |
| EdgeFace | **8.0 ms** | 未测（前一项已崩） |

⇒ **回退到 1.20.0**，`package.json` 恢复 `^1.20.0`。

**这不是「暂时不升」，是「1.30 在 Windows+DML 上有实质回归」**，将来要升必须先做三件事：
① `getBestExecutionProviders()` 显式排除 `webgpu`（或改成白名单）；② 用真实模型逐个跑通（CLIP 尤其）；
③ 有性能对比数据才允许上线。

## 本批实际改动文件

| 文件 | 改动 |
|---|---|
| `flutter_client/pubspec.yaml` | 删 3 个依赖 |
| `flutter_client/pubspec.lock` | 重新解析（被 .gitignore 忽略，不进 git） |
| `electron_server/package.json` | 26 个包版本号 |
| `electron_server/package-lock.json` | 随之更新 |
| `electron_server/web/main/**` | 新 SDK 编译产物（465 文件） |
| `tool/_after_upgrade_smoke.js` | 新增（24 项升级冒烟，可长期复用） |
| `tool/_sharp_bench.js` | 新增（缩略图基准，支持 `--module` 指定 vendored/npm） |
| `tool/_ort_bench.js` | 新增（真实模型推理基准，支持 `--probe` / `--only`） |

备份：`G:/work/_patch_backup/dep_upgrade_20261017/`（四个清单/锁文件 + 三组 sharp 基准 + 三组 ORT 基准 json）。

## 下一批（P2）待办

`plus` 系六件套、`fvp`、桌面组件 —— 未动。`sqlite3` 部分见下。

---

# 执行记录（2026-10-17 第二批：P2 的 sqlite3 EOL 迁移）

> 结论：**迁移完成，五端全部构建通过**。但过程中挖出两个比 sqlite3 本身更严重的构建隐患，都已处理。

## 一、依赖链比预想的长

直接改 `sqlite3: ^2.9.4 → ^3.7.1` 会解析失败，报：

```
Because every version of nascab_sync_core from path depends on sqlite3 ^2.9.4
and WaterNasOS depends on sqlite3 ^3.7.1, version solving failed.
```

三处联动，缺一不可：

| 位置 | 改动 |
|---|---|
| `packages/nascab_sync_core/pubspec.yaml` | `sqflite_common_ffi ^2.3.7→^2.4.4`、`sqlite3 ^2.9.4→^3.7.1`、SDK `>=3.4.0`→`>=3.12.0`（2.4.4 要求） |
| `flutter_client/pubspec.yaml` | 同上，**删除 `sqlite3_flutter_libs`** |
| `sync_client/pubspec.yaml` | 同上 + SDK 约束提到 `>=3.12.0` |

`photo_client` / `music_client` 是壳（`path: ../flutter_client`），自动继承。代码层**零改动**——全项目没有一处直接 `import 'package:sqlite3'`，都是走 `sqfliteFfiInit()` + `databaseFactoryFfi`，`dart analyze` error/warning = 0。

## 二、真正的坑：3.x 不再自己带二进制

`sqlite3_flutter_libs` 之所以 EOL，是因为 3.x 改用 **Dart build hooks** 产出原生库。但默认策略是**从 GitHub Releases 下载预编译 DLL**：

```
https://github.com/simolus3/sqlite3.dart/releases/download/sqlite3-3.7.1/sqlite3.x64.windows.dll
```

在这台机器上该地址**不可达**（代理只建立隧道、无实际响应），表现为：

```
Target build_hooks failed : error : Building native assets failed.
This failed (attempted to download .../sqlite3.x64.windows.dll)
```

### 解法：改为本地源码编译（已落地）

sqlite3 官方支持 `hooks.user_defines`，用仓库内的 amalgamation 源码编译：

```yaml
hooks:
  user_defines:
    sqlite3:
      source: source
      path: ../third_party/sqlite3/sqlite3.c
      defines:
        default_options: true
```

配套把官方 amalgamation 放进仓库：`third_party/sqlite3/sqlite3.c`（9.58 MB，SQLite **3.54.0**）+ `sqlite3.h`。
四个应用（`flutter_client` / `photo_client` / `music_client` / `sync_client`）的 pubspec 都加了这段——**hooks 配置在应用根 pubspec 生效，path 依赖不会继承**。

验证「真的走了源码编译」的证据：hooks 缓存目录里出现 `sqlite3.obj` / `sqlite3.lib` / `sqlite3.exp`（而非 `download-<hash>/`）。

## 三、⚠️ 顺带挖出的更严重隐患：`flutter clean` 之后可能直接编不了

`flutter clean` 会清掉 `.dart_tool/hooks_runner` 缓存。**`pdfium_dart` 的 hook 同样是硬编码从 GitHub 下载**（`bblanchon/pdfium-binaries`），且没有 user_defines 可配。

所以在本机网络下：

```
flutter clean  →  pdfium 缓存没了  →  GitHub 不通  →  Building native assets failed
```

第一次撞上时我以为是 sqlite3 的问题，实际失败的是 pdfium。当时靠 `music_client/.dart_tool` 里还留着的 `chromium_7811/win-x64/pdfium.dll` 拷回去才恢复。

**这意味着：这个项目当前在「GitHub 不通 + 已 clean」状态下无法构建。** 这次没做彻底修复（pdfium_dart 不支持本地源），但要记住这条：
- 非必要不要 `flutter clean`；
- 真要 clean，先把 `pdfium.dll` 备份出来；
- 长期解是 fork `pdfium_dart` 换下载源，或预置缓存脚本。

## 四、Flutter 3.47.7 的构建链硬要求（升级 SDK 的连带成本）

`flutter build apk` 在升 SDK 后连续卡了三关，每关都是硬校验：

| 关卡 | 要求 | 原值 | 已改为 |
|---|---|---|---|
| Gradle | ≥ 8.14.0 | 8.12 | **8.14**（走腾讯镜像 `mirrors.cloud.tencent.com/gradle`） |
| AGP | ≥ 8.11.1 | 8.9.1 | **8.11.1** |
| Kotlin | ≥ 2.2.20 | 2.1.0 | **2.2.20** |

三个客户端（`flutter_client` / `photo_client` / `music_client`）的 `gradle-wrapper.properties` 与 `settings.gradle.kts` 全部同步。

> 未来预警（下次升 SDK 会变成硬错误）：
> - Gradle 8.14 已被警告「support will soon be dropped」，届时要求 **≥ 9.1.0**
> - AGP 8.11.1 已被警告，届时要求 **≥ 9.0.1**，且 AGP 9 只读 **新 DSL**（`android.newDsl=false` 这个 opt-out 会失效，`build.gradle.kts` 要按新 DSL 重写）
>
> 也就是说 **AGP 9 是下一个真正的迁移工程**，不是改个版本号。

## 五、验证矩阵（都是实跑，不是「应该可以」）

| 端 | 结果 | 证据 |
|---|---|---|
| 纯 Dart 开库 | ✅ | `SQLITE_VERSION = 3.54.0`，建表/插入/查询通过 |
| `flutter_client` Windows | ✅ RC=0 (110.9s) | `Release/sqlite3.dll` 1,728,512 B；hooks 缓存含 `sqlite3.obj` |
| `photo_client` Windows | ✅ RC=0 (203.1s) | `NasCabPhoto.exe`；hooks 缓存含 `sqlite3.obj` |
| `music_client` Windows | ✅ RC=0 (158.0s) | `NasCabMusic.exe` |
| `sync_client` Windows | ✅ RC=0 (22.6s) | `WaterNasSync.exe`；hooks 缓存含 `sqlite3.obj/lib` |
| `flutter_client` Android | ✅ RC=0 (1501.8s) | `app-release.apk` 88.1MB，含 `lib/arm64-v8a/libsqlite3.so` 1,765,312 B |
| `photo_client` Android | ✅ RC=0 (636.6s) | `app-release.apk` 94.7MB，含 `lib/arm64-v8a/libsqlite3.so` |
| `music_client` Android | ⚠️ 未编译 | 配置同源、Windows 已过；如需发布前补一次 |

> Android 首次编译那 25 分钟里，大部分时间花在 Gradle 自动补装 **NDK 28.2.13676358 / Build-Tools 35 / Platform 32+36**（现在已装进系统 SDK，后续构建不需要了）。

## 六、本批改动文件

| 文件 | 改动 |
|---|---|
| `third_party/sqlite3/sqlite3.c` / `sqlite3.h` | **新增**，官方 3.54.0 amalgamation |
| `packages/nascab_sync_core/pubspec.yaml` | 依赖 + SDK 约束 |
| `flutter_client/pubspec.yaml` | 依赖 + `hooks` 段 |
| `photo_client/pubspec.yaml` / `music_client/pubspec.yaml` / `sync_client/pubspec.yaml` | `hooks` 段（sync_client 另含依赖） |
| 三个 `android/gradle/wrapper/gradle-wrapper.properties` | Gradle 8.12 → 8.14（腾讯镜像） |
| 三个 `android/settings.gradle.kts` | AGP 8.9.1 → 8.11.1、Kotlin 2.1.0 → 2.2.20 |

## 七、仍然待办

- `plus` 系六件套（file_picker 13 / share_plus 13 / permission_handler 13 / connectivity_plus 7 / device_info_plus 13 / package_info_plus 10）
- `fvp` 0.38.1 → 0.39.1、桌面组件（tray_manager / desktop_drop / wakelock_plus / flex_color_scheme / flutter_lyric / pdf / panorama_viewer / latlong2）
- Electron 44（P3）

---

# 执行记录（2026-10-17 第三批：AGP 9 评估 / video_thumbnail fork / 代理方案）

## 一、AGP 9 + Gradle 9 现在能做吗？→ **不能，而且不该做**

### 先确认版本不是问题
| | 现状 | 最新 |
|---|---|---|
| AGP | 8.11.1 | **9.4.1**（Google Maven 实测） |
| Gradle | 8.14 | **9.8.1** |

版本都很成熟了，所以问题不在“有没有”。

### 实测了 5 轮，逐层剥开阻碍

| 轮次 | 卡点 | 性质 |
|---|---|---|
| 1 | 腾讯镜像没有 `gradle-9.1-all.zip`（只同步了 9.5+） | 环境，换 9.5.0 |
| 2 | `video_thumbnail` 调用 `jcenter()` —— **Gradle 9 已彻底移除该方法** | 第三方插件（2019 年停更） |
| 3 | 同上：buildscript 里硬编码 `classpath 'com.android.tools.build:gradle:4.1.0'`，导致 `:video_thumbnail` 找不到 `com.android.library` | 第三方插件 |
| 4 | AGP 9 的 `checkReleaseAarMetadata` 要求每个 library 模块 `compileSdk ≥ 34`，老插件还写 32/33 | 生态普遍问题 |
| 5 | 想用根 `build.gradle.kts` 统一抬 `compileSdk`：写在 `plugins.withId` 里被插件自身的 `android{}` 覆盖；改到 `afterEvaluate` 则直接报 **`It is too late to set compileSdk`** | AGP 自身限制 |

### 决定性的一条

`flutter_client/android/gradle.properties` 里这两行是 **Flutter migrator 自己写进去的**：

```properties
android.builtInKotlin=false
android.newDsl=false
```

也就是说 **Flutter 3.47.7 自己还没完成 AGP 9 迁移**，它靠这两个 opt-out 维持对 AGP 8 的兼容。
即使我们逐个 fork 所有老插件把 AGP 9 编过，也必须继续留着 `newDsl=false` —— 那等于
**「用 AGP 9 跑旧 DSL」：只拿到版本号，风险全担，收益为零。**

⇒ **结论：现在不做。** 判据（什么时候可以动手）：
1. Flutter 的工程模板不再往 `gradle.properties` 注入 `android.newDsl=false`；
2. `DependencyVersionChecker` 的下限抬到 AGP 9；
3. 届时再按新 DSL 重写 `app/build.gradle.kts`（`kotlinOptions` → `kotlin.compilerOptions`、
   `packaging.jniLibs` 等的写法变化），并处理 `qr_code_scanner` / `zxing_android_embedded_patched` 的 compileSdk。

**已回退到 AGP 8.11.1 + Gradle 8.14**，并验证 Android 构建通过（RC=0，88.1MB）。

## 二、顺手拆掉一颗真雷：`video_thumbnail` fork

这是 28 个插件里**唯一**用 `jcenter()` 的，还硬编码 AGP 4.1.0 —— 不管升不升 AGP 9，它都是定时炸弹。

- 位置：`flutter_client/packages/video_thumbnail/`（与 `audio_service`、`dchs_motion_sensors` 同一套 fork 惯例）
- 改动**只限构建脚本**，Dart 与原生代码一字未动，API 完全不变：
  - 删掉整个 `buildscript { classpath AGP 4.1.0 }` 块 → 改用宿主工程的 AGP
  - 两处 `jcenter()` → `mavenCentral()`
  - `compileSdkVersion 33` → `36`（AGP 9 的 AAR 元数据检查需要 ≥34，现在改掉省得将来卡）
  - 包的 `environment.sdk` 从 `>=2.16.0 <3.0.0`（Dart 2 时代）→ `>=3.12.0 <4.0.0`
- `pubspec.yaml` 改为 `path: packages/video_thumbnail`
- 验证：`dart analyze` 0 error/warning；Android APK 构建 RC=0，日志里编译的路径确认是 `packages\video_thumbnail\...`，`jcenter` 报错 **0 次**

## 三、代理方案：`127.0.0.1` 本地代理能解决 pdfium 的死结

### 实测（用 21578 端口）
| 目标 | 结果 |
|---|---|
| `https://www.google.com` | 200 |
| sqlite3 预编译 DLL（GitHub Releases） | 200，1,728,512 B，≈193 KB/s |
| pdfium `chromium/7811` tgz | 200，3,718,879 B |

### 关键验证：删掉 pdfium 缓存后能否自动重建
```
rm -rf .dart_tool/hooks_runner/shared/pdfium_dart
HTTPS_PROXY=http://127.0.0.1:21578 flutter build apk --release
→ RC=0，三个 libpdfium.so 全部重新下载（20:37-20:39 时间戳）
```

⇒ **「`flutter clean` 之后就编不了」这个隐患解决了** —— 前提是构建时带上代理环境变量。
`pdfium_dart` 的 hook 用 `createProxyAwareHttpClient()`，读 `Platform.environment` 里的
`HTTPS_PROXY`/`HTTP_PROXY`，所以命令行 export 即可生效。

### 落地成工具：`tool/fix_native_assets.py`
```bash
python tool/fix_native_assets.py                    # 自动探测本机代理端口
python tool/fix_native_assets.py --proxy 21578      # 指定端口
python tool/fix_native_assets.py --target android   # 默认 windows
```
- 探测顺序：`--proxy` > 环境变量 > `21578/7890/10809/1080/61582` 逐个试；
- 探测方式不是“端口通不通”，而是**真的过代理 HEAD 一次 GitHub**（端口开着不代表能出网，今天就有个 502 的）；
- 构建完会列出 `hooks_runner/shared` 里落地的 pdfium/sqlite3 产物，方便确认。
- 实测：Windows 构建 1m56s，落地 `pdfium.dll` 7.0MB + `sqlite3.dll` 1.7MB + 3 个 Android `libpdfium.so` + 3 个 `libsqlite3.so`。

> `sqlite3` 不依赖网络（已改本地源码编译），这个脚本只为 `pdfium` 服务。

---

# 执行记录（2026-10-17 第四批：plus 系 + 桌面组件 + 两个大版本）

> 结论：**升级 12 个包、回退 4 个包**。三端（Windows / Android / Web）全部编译通过。
> 回退的 4 个都不是"偷懒"，是实测撞到硬墙，每条都记在这里免得下次重试。

## 一、plus 系被 `win32` 的 major 版本绑成两派 —— 只能整组升降

这是本轮最重要的发现。六个 plus 包 + `file_picker` 表面独立，实际被 `win32` 版本锁死：

| 派系 | 依赖 `win32 ^5` | 依赖 `win32 ^6` |
|---|---|---|
| 旧 | `file_picker 10`、`share_plus 10` | — |
| 新 | — | `file_picker 13`、`share_plus 13`、`package_info_plus 10`、`device_info_plus 13`、`connectivity_plus 7`、`permission_handler 13` |

试图只升 `share_plus` 或只升 `package_info_plus` 都会立刻解析失败：
```
Because share_plus 13.3.1 depends on win32 ^6.0.1 and file_picker >=8.3.3 <12.0.0-beta.1
depends on win32 ^5.9.0, version solving failed.
```
⇒ **要么整组升，要么整组留。** 最终选择整组升到 `win32 ^6`。

连带触发一处：`connectivity_plus 7` 要 `dbus ^0.8`，而 `flutter_local_notifications 21` 锁 `dbus ^0.7`
⇒ 通知包一起升到 **22.3.2**（本来也在待办清单里）。

## 二、`file_picker 13`：联邦化重写，实际改了 17 处调用点

12.0.0 就是那次 `federated` 重写（不是 13 才破），13.0.0 只是收尾。核心变化：

| 旧 API | 新 API |
|---|---|
| `FilePicker.platform.pickFiles(...)` → `FilePickerResult?` | `FilePicker.pickFiles(...)` → `List<PlatformFile>` |
| `FilePicker.platform.pickFile(...)` | `FilePicker.pickFile(...)` → `PlatformFile?` |
| `result.files` / `result.paths` | 直接就是 List |
| `allowMultiple:` / `withData:` / `withReadStream:` | **全部移除**（单选用 `pickFile`） |
| `PlatformFile.size`（int） | `lengthSync()`（int?，无 IO）/ `length()`（Future） |
| `PlatformFile.bytes`（可缓存） | `readAsBytes()`（Future，总是可读） |
| `PlatformFile.identifier` | **移除**，改用 `uri` |

实际改动：**13 个文件 / 17 个调用点 / 删除 23 行参数 / 16 处返回值改造 / 8 处 bytes+identifier**。

几处语义拿捏（不是机械替换）：
- `notes_api_service.uploadAsset`：原来靠 `file.bytes != null` 判断走内存还是走文件。新 API 没有缓存位，
  改成 **`filePath.isNotEmpty` 走 `MultipartFile.fromFile`，否则（web/blob）才 `readAsBytes()`**
  —— 保持"有本地文件时不把整份读进内存"的原行为。
- `notes_controller.insertImageFromPicker`：`file?.files.single` → `files.length == 1 ? files.first : null`，
  空判断从 `bytes == null` 改为 `(await readAsBytes()).isEmpty`。
- `upload_center` 的 `identifier` → `uri.toString()`，因为 `_extractNameFromIdentifier` 本身就是按 URI 解析的，完全兼容。

## 三、回退的四个（每条都有实测原因）

### 1. `tray_manager 0.8` ❌ 回退 0.5.2 —— 构建卡死 26 分钟
0.8 底层整个换成 `nativeapi` + `cnativeapi`（C++ 核心）。官方给了 `legacy.dart` 兼容桥，一行 import 就能编过 analyze。
但真正 `flutter build windows` 时**卡在 "Building Windows application..." 26 分钟无任何产物变化**，终止。
托盘只是"关窗最小化 + 托盘菜单"，不值得为它引入一条新的原生构建链。
> 若将来要做：需先确认 `cnativeapi` 在本机的 C++ 构建耗时，并纳入构建时间预算。

### 2. `fvp 0.39.1` ❌ 回退 0.38.1 —— SourceForge 下载 mdk-sdk
```
Failed to download
  https://sourceforge.net/projects/mdk-sdk/files/nightly/mdk-sdk-windows-x64.7z
  cmake/deps.cmake:310 (_fvp_prepare_mdk_sdk)
```
CMake 阶段下载**不走 HTTP 代理**，即使配了 `HTTPS_PROXY` 也无效。0.38.1 用项目 `libs/` 里已有的 mdk，不需联网。

### 3. `flex_color_scheme 9.0.0` ❌ 回退 8.4.0 —— Material 类型不兼容
9.0 改用 Flutter 3.47 新拆分出的独立 `material_ui` 包，它返回的 `ThemeData` 与
`package:flutter/material.dart` 里的 **是两个不同类型**：
```
The argument type 'ThemeData (material_ui-1.7.0)' can't be assigned to
the parameter type 'ThemeData (flutter/lib/src/material/theme_data.dart)'
```
升它 = 把整个 Material 层迁到 `material_ui`，那是另一场迁移，不是依赖升级。

### 4. `flutter_lyric 4.1.0` ❌ 回退 3.0.2 —— 视图层换 preset 体系
模型类还在（`LyricLine` / `LyricWord`），但：
- 内部路径从 `core/*` 移到 `src/*`（顶层导出变了）
- `LyricModel` → `LyricDocument`
- `LrcParser.extractLine` **移除**（只剩实例 `parse`）
- `LyricStyle` 被 preset 体系（`LyricPreset` / `lyric_presets`）取代，`loadLyricModel` → `loadDocument`

歌词全屏是音乐端核心视觉功能，重写有回归风险、收益为零 ⇒ 保留 3.0.2。

## 四、最终版本（三端编译通过的这一套）

| 包 | 版本 | 备注 |
|---|---|---|
| `file_picker` | **13.1.0** | 17 处调用点已适配 |
| `share_plus` | **13.3.1** | 代码零改动 |
| `permission_handler` | **13.0.2** | 代码零改动 |
| `connectivity_plus` | **7.3.2** | 代码零改动 |
| `device_info_plus` | **13.3.0** | 代码零改动 |
| `package_info_plus` | **10.2.2** | 代码零改动 |
| `flutter_local_notifications` | **22.3.2** | 连带 `dbus 0.8` |
| `wakelock_plus` | **1.8.1** | 自动随之解析 |
| `pdf` | **3.13.1** | |
| `latlong2` | **0.10.1** | |
| `audio_session` | **0.2.4** | |
| `panorama_viewer` | **3.0.0** | 无 API 破坏 |
| `cross_file` | 0.3.5+5 | 不能到 0.4（share_plus 13 要 ^0.3.5+2） |
| `flex_color_scheme` | 8.4.0 | ⛔ 9.0 需迁 material_ui |
| `flutter_lyric` | 3.0.2 | ⛔ 4.x 换 preset 体系 |
| `tray_manager` | 0.5.2 | ⛔ 0.8 构建卡死 |
| `fvp` | 0.38.1 | ⛔ 0.39 需 SourceForge |

## 五、验证（三端全过）

| 端 | 结果 |
|---|---|
| `dart analyze --no-fatal-warnings lib` | **0 error / 0 warning** |
| Windows release | ✅ RC=0（112.3s）→ `WaterNasClient.exe` |
| Android release | ✅ RC=0（344.7s）→ `app-release.apk` 87.8MB |
| Web release | ✅ `EXITCODE=0`（1m51s），产物同步 `electron_server/web/main` 456 文件 md5 全一致 |

> Android 构建时 Gradle 提示某依赖建议 `compileSdk = 37`，当前 36 仍可编过，仅提示。

## 六、改动文件

- `flutter_client/pubspec.yaml`：12 个包版本 + 4 条回退原因注释
- 13 个 Dart 文件：`file_picker 13` API 适配（详见第二节）
- `note`：`notes_api_service.dart` / `notes_controller.dart` 的 bytes 语义改动最需要回归测试

## 七、上线前建议重点回归

1. **文件选择全链路**（这是本轮改动最集中的地方）：上传文件/文件夹、下载保存、壁纸选择、笔记插图、
   加密空间上传、Transmission 种子选择、视频字幕选择。
2. **web 端的文件选择**（`path` 为 null、走 `readAsBytes` 的那条分支）。
3. 通知（`flutter_local_notifications 22`）。
4. 断网/切网检测（`connectivity_plus 7`）。
5. 分享（`share_plus 13`，虽然代码没改，但原生实现换了）。
