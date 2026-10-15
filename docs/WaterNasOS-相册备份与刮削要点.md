# 相册备份 & 日本片刮削 —— 要点明细

> 从 `.workbuddy/memory/MEMORY.md` 迁出的长条目（2026-10-14）。
> MEMORY.md 有 ~14.5KB 注入截断上限，明细一律放 docs，主文件只留指针。

------------

## 一、相册备份（`flutter_client/lib/modules/photoBackup/`）

2026-10-13 改版。**photo_client 靠 path 依赖自动共享同一份代码**。

- **整机只有一份配置**（`getSingleTask`），入口直达备份页，
  ⛔没有「+ 新建任务」入口，别再找。
- `sourceIds` 空 = 全部相册。
- `saveType`：
  - `''` = 按相册（`<相册名>/文件名`）
  - `'month'` = 按年月
  - `'year'` = 按年
  - 服务端按拍摄时间归档并丢掉相册名 ⇒ 细节见上传控制器 `_getSaveTypeSubPath`。

### 跨相册源内容去重（绝不重复上传）

服务端：`POST /api/photo/backup/check_content`
→ `photoSourceService.findExistingContent`

1. 按 `photo_index.size` **粗筛**该用户全部 `photo_source`；
2. 只对同 size 的候选**惰性**算内容 MD5，并回写 `photo_index.content_md5`
   （列用 PRAGMA 自愈；算法同 `/api/file/md5`：<50MB 全量、≥50MB 头尾各 1MB）。

客户端：200/批查询，命中记 `skipped`；
接口不可用才回退「同路径同名 + 内容一致」（**fail-open ＝ 宁可多传**）。

本地还有两层：
- `listHandledUniqueIds`（历史 success 素材 id）
- 本次运行的 md5 集合

相关表：
- MD5 缓存表 `photo_backup_hash_cache`
- 任务表 **v4** 新增列
  `source_ids / source_names / enabled / only_photos / rename_by_date /
  use_cellular / saving_mode / keep_screen_on / device_name`
  （`keep_screen_on` 默认 1 以维持原 wakelock 行为）

### 验证 / 入口

### 权限与计数（2026-10-15 修）

- **权限**：`PhotoBackupController.ensurePhotoPermissionInteractive()`（静态）是唯一入口。
  打开开关、打开相册选择器都必须先过它；未授权弹系统框，仍拿不到就弹「去设置」
  （`PhotoManager.openSetting()`）。
  ⚠️ photo_manager 的 `PermissionState` **没有 `isPermanentlyDenied`**（那是 permission_handler 的
  `PermissionStatus`），别混用。
- **计数**：`uploadedFiles / skippedFiles` 必须**实时**累加，不能只在整轮结束赋值 ——
  否则进度走到几千、这两个数还是 0。「已备份素材的零 I/O 跳过」（`handledSkipped`）
  也算 skipped。
- **预计总数**：用 **`isAll` 相册的素材数**（设备内唯一素材数）。
  ⚠️ 绝不能把选中相册的 `assetCountAsync` 相加 —— Android 的相册**互相重叠**
  （「全部/最近」+「相机」+「截图」+「微信」…），求和会把同一张数成好几张。
- ⚠️ `rt.totalBytes` 目前**从未赋值**（UI 的 `bytesTotal` 恒为 `-`），界面上的体积是
  `doneBytes`（实际传输量）。

### 验证 / 入口

- 脚本 `tool/_verify_photo_content_dedup.js`（真实库 + 真实文件，
  须 `ELECTRON_RUN_AS_NODE=1 electron.exe` 跑）。
- 相册端：`photo_left_menu` 的 `settings.backup`
  → `AppPhotoBackupView(embedded: true)`
- 移动端主客户端：`app_monitor_card` → `/app_photo_backup`

------------

## 二、日本片刮削（`lib_type = jp_movie`）

### 文件名标记

- 识别 `parseJpTagsFromName`：文件名**结尾**的 `-U` / `-C` / `-UC`
- 写库收口：`upsertIndex._withJpTags`
- 剥标记（猜 NFO 前）：`normalizeNameForNfoGuess`

### 番号优先

jp_movie 库**优先按番号**走：`_isJpMoviePath` + `extractAvId`
⇒ 先 `_tryJavFallback`，失败才 TMDB。

- 番号源顺序：`[javdb, javbus, avsox]`
- javdb：按 `<strong>` 里的番号**精确比对**才进详情页（否则点错人）
- TMDB 陷阱：AV 条目通常没有，但有「标题 == 搜索词 + overview = 111…」
  的垃圾条目 ⇒ 由 `_looksJunkTmdbMatch` 丢弃
- 搜索词只取**文件名派生**，别带目录名
- ⚠️ `javScraper.js` 的 `module.exports` 必须列全
  （曾漏 `scrapeJavbus` ⇒ 点「应用」静默无下载，无报错）
- `match_nfo = 0` 的条目不进自动刮削队列
