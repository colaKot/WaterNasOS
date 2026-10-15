# 影视库「图片 / 图片+影片混合」显示问题 · 诊断与优化计划

> 排查时间：2026-10-10 16:1x
> 排查对象：运行中的服务端 PID 2324（`dist_v14/win-unpacked/WaterNasOSServer.exe`），userData = `%APPDATA%\nascab_os_server`
> 结论一句话：**服务端、数据、接口、缩略图全部正常；看不到是"客户端跑的前端产物不是最新那份"。真正的技术债在缩略图链路与数据库设计。**

---

## 一、结论速览

| 层 | 状态 | 判定依据 |
|---|---|---|
| 扫描入库 | 正常 | `video_index` 里 `media_type='image'` 共 **74,718** 条 |
| 库列表接口 | 正常 | `POST /api/video/library/list` → 200，见下表 |
| 列表接口 | 正常 | `POST /api/video/list`（library_id=6）→ 200，total = **70,978** |
| 缩略图接口 | 正常 | `GET /api/file/tiny` → 200 `image/webp` 6.7 KB，0.79 s |
| 前端源码 | 完整 | `VideoMediaBrowserPage` / `VideoMediaGrid` / `isMediaGridLib` / 13 语言 key 齐全 |
| **前端产物** | **可疑** | `main.dart.js` 构建于 **15:53**，但源码 `video_list_controller.dart` 改于 **16:13** |

**⇒ 问题不在"怎么显示"，而在"显示的是哪一版"。** 功能代码已经在仓库里了，不需要照抄 Jellyfin 的展示逻辑；Jellyfin 值得借鉴的是**性能与数据结构**（见第五节）。

---

## 二、实测证据（可直接复现）

### 2.1 库列表（真实 API 响应）

| id | 名称 | lib_type | show_in_home | counts |
|---|---|---|---|---|
| 1 | 电影 | movie | 1 | movie 14 / total 14 |
| 2 | 电视剧 | tv | 1 | tv 18 / total 293 |
| 3 | 短剧 | movie | 0 | movie 666 / total 666 |
| 4 | down | movie | 0 | movie 90 / total 90 |
| **5** | **downother** | **mixed** | 0 | **movie 991 / image 3,740 / total 4,731** |
| **6** | **图片** | **image** | 0 | **image 70,978 / total 70,978** |

> 左侧栏的显示条件是 `totalCount > 0`（`video_left_menu.dart`）。库 5、库 6 的 total 都远大于 0，**按当前源码它们一定会出现在左侧栏**。

### 2.2 列表接口返回的真实条目

```json
{
  "id": 102678, "media_type": "image",
  "path": "F:\\picweb\\林星阑", "filename": "(356).JPG", "ext": ".jpg",
  "width": 9504, "height": 6336,
  "full_path": "F:\\picweb\\林星阑\\(356).JPG",
  "is_favorite": false
}
```

`pagination = { total: 70978, page: 1, limit: 3, totalPages: 23660 }`

### 2.3 数据库现状

`%APPDATA%\nascab_os_server\database\nascab_video.db` · 134 MB（另有 5.7 MB WAL）

`video_index` 单表 **76,772** 行：image 74,718 / movie 1,761 / episod 259 / tv 18 / season 16。

表上有 **10 个索引**：

```
uidx_video_index_path_filename                       (path, filename)              UNIQUE
idx_video_index_path_filename_media_type_create_time (path, filename, media_type, create_time)
idx_video_index_path_filename_media_type_view_time   (path, filename, media_type, view_time)
idx_video_index_path_filename_media_type_nfo_regions (path, filename, media_type, nfo_regions)
idx_video_index_path_filename_media_type_nfo_language(path, filename, media_type, nfo_language)
idx_video_index_path_filename_media_type_nfo_genres  (path, filename, media_type, nfo_genres)
idx_video_index_path_filename_media_type_nfo_release_date
idx_video_index_path_filename_media_type_nfo_score
idx_video_index_path_filename_media_type_nfo_director
idx_video_index_path_filename_media_type_nfo_actor
```

### 2.4 缩略图

* 缓存目录：`%APPDATA%\nascab_os_server\nascabos_cache\tinyCache`（已有 20,087 个文件）
* 缓存键：`sha256(文件名 + 字节数 + mtimeMs)` → `<hash>.webp`（参数化缓存，设计本身是对的）
* 单张首次生成耗时实测 **0.79 s**（原图 9504×6336）

---

## 三、为什么"看不到"——时间线与最可能原因

### 3.1 时间线

| 时间 | 事件 |
|---|---|
| 10-10 10:33 | `video_main_view.dart` 加入 `isMediaGridLib` 分支 |
| 10-10 13:40 | `video_left_menu.dart` 改为"只显示有内容的库" |
| 10-10 15:32 / 15:50 / 16:00 | 三次修缩略图裁切、backdrop 比例、fanart 候选名 |
| **10-10 15:53** | **`flutter build web` 产出 `main.dart.js`（13,021,170 B）** |
| 10-10 16:05 | `tool/dev_update.py` 同步 asar + web 两处（日志记载 14.8 s） |
| **10-10 16:13** | **`list/controller/video_list_controller.dart` 又被修改** |
| 10-10 16:09 | 用户测试；`F:\picweb` 扫描启动（74k 图片，未在日志中看到 scan done） |

### 3.2 最可能原因

**Electron 启动时只加载一次 `index.html` / `main.dart.js`，之后不会自动重新拉取。**
而 16:05 那次同步之后源码又动过（16:13），且今天前端改动极其密集（15:32~16:13 至少 6 个文件）。

⇒ 你现在看到的界面，很可能是**若干次修改之前的 JS**。

### 3.3 一分钟验证（请先做这一步）

1. **完全退出** WaterNasOSServer（任务栏图标右键退出，**不是**关闭窗口），再重新打开
2. 看左侧栏「影视库」分组里是否出现 **图片**、**downother** 两个栏目
3. 若还是没有 → 打开 F12：
   - **Network** 面板筛 `video`，看 `POST /api/video/library/list` 的状态码与响应体
   - **Console** 面板看有没有红色异常
   - 把这两块截图给我

> 若第 2 步就正常了，说明是产物版本问题，功能本身无恙，可以直接进入性能改造。

---

## 四、真正的性能问题（与"看不到"是两件事）

### 4.1 图片缩略图进不了队列 ← 头号问题

`electron_server/src/workers/tinyImageWorker.js`

```js
async getOneVideo() {
  return this.videoKnex('video_index')
    .select('id', 'path', 'filename', 'ext')
    .where({ is_file: 1 })
    .whereIn('ext', config.videoTypeList)      // ← 只认视频扩展名
    .andWhere(qb => qb.where('gen_tiny', 0).orWhereNull('gen_tiny'))
```

* 实测：`video_index` 里 image 行的 **`gen_tiny` 全部为 0**（74,718 / 74,718）。
* 相册模块走的是另一个分支 `getOnePhoto()`（查 `photo_index`），所以**相册快、影视库慢**。
* 后果：网格里每张图都靠 `/api/file/tiny` **现场同步生成**。单张 0.79 s、原图 9504×6336；
  首屏 30 张按 HTTP 并发 6 计算 ≈ **4 s 才能出齐**，滚动继续请求继续等。

### 4.2 数据库层

1. **写入放大**：9 个复合索引全部以 `(path, filename, media_type)` 打头，每张图片都要往 10 棵 B-tree 各插一条
   ⇒ 7.5 万图 ≈ **75 万个索引条目**，其中 8 个索引的后缀列（region / language / genres / release_date /
   score / director / actor）**对图片恒为空**，纯浪费。这是扫描慢 + 库文件 134 MB 的主因。
2. **`media_type` 排在第 3 位** ⇒ `WHERE media_type='image'` **用不上索引前缀**，只能按 path 范围扫再过滤。
3. **定位库靠 `LIKE 'F:\picweb\%'` 前缀匹配**（`videoVisibilityUtil.applyVisibleIndexFilter`），
   而不是等值 `library_id` ⇒ 库路径有重叠时无法区分。
4. **深分页 OFFSET**：`totalPages = 23,660`，翻到第 2000 页要 `OFFSET 60000`，SQLite 逐行丢弃。
5. **`video_index` 没有 `library_id` 列**（当初刻意不加）⇒ 每次查询都要拼"可见路径集合"。
6. **`create_time` 取的是 `stat.ctimeMs`**（文件系统时间），不是 EXIF 拍摄时间 ⇒ 排序不符合直觉。

### 4.3 前端

* 扁平网格 7 万张、30/页 ⇒ 翻到底要 **2,367 次**请求。
* 网格按 `size * 2` 请求（6 列 × 5 行 = 30 个并发图片请求）。
* 没有按文件夹 / 日期分组，也没有骨架占位。

---

## 五、Jellyfin 对标

| 维度 | Jellyfin | WaterNasOS 现状 | 差距 |
|---|---|---|---|
| 库类型 | `CollectionType.photos` | `lib_type='image'` | 等价 |
| 浏览结构 | **文件夹即相册**（`PhotoAlbumResolver`），顶层只渲染相册卡片，点进去看单张 | 70,978 张平铺网格 | **主要差距** |
| 排序时间 | **EXIF `DateTimeOriginal`**（TagLib 解析） | 文件 `ctimeMs` | 需补 |
| 缩略图生成 | 参数化 `maxWidth/maxHeight/quality`，**按 CPU 核数做 async 并发控制**，失败**回退原图** | 参数化 ✅，但**无并发控制**、失败返回 404/415 | 需补 |
| 缩略图缓存 | **参数组合的确定性 MD5 作文件名** | `sha256(名+大小+mtime)`，等价 ✅ | 等价 |
| 库内过滤 | 条目带 `TopParentId`(=库 id)，**等值索引** | 路径 `LIKE` 前缀 | 需补 |
| 支持格式 | jpg/png/tiff/webp/avif/**cr2** 等 | `config.imgTypeList` 11 种（含 heic/gif/bmp/svg，不含 RAW） | 基本够 |

> 注意：Jellyfin 的"相册优先"不是可选项，而是它能在几十万张图下保持流畅的**根本原因**——首屏永远只渲染几十个相册封面。
> WaterNasOS 的图片库结构（`F:\picweb\林星阑\`、`F:\picweb\manhua\...\70\`）天然就是这个层级，直接可以复用。

---

## 六、改造计划

### P0 · 先确认能看见（今天，0 改动）

1. 彻底退出 app 再启动（见 3.3）
2. 若仍不行，提供 F12 的 Network + Console 截图
3. 确认后重新构建一次前端（`tool/build_web.bat` → `tool/dev_update.py`），把 16:13 的改动带上

### P1 · 缩略图链路（收益最大、风险最低、可回滚）

| # | 改动 | 文件 |
|---|---|---|
| 1 | 让 tiny worker 认图片：新增 `getOneVideoImage()`，或在 `getOneVideo()` 里把条件放宽为「视频扩展名 ∪ `media_type='image'`」 | `src/workers/tinyImageWorker.js` |
| 2 | 给缩略图生成加**并发上限**（按 CPU 核数，参考 Jellyfin） | 同上 |
| 3 | 生成失败**回退原图**而不是 404/415 | `src/api/modules/file/tiny/fileTinyController.js` |
| 4 | 网格请求小图（160/320）、浏览页请求中图（640），**不要按原图尺寸缩放** | `video_media_grid.dart` |
| 5 | 扫描期即入队（`indexImageFile` 写库后 `gen_tiny=0` 就会被 worker 拾取，无需额外改动） | — |

> 预估：74,718 张图在后台按并发数渐进生成，首次浏览时大部分已有缓存。

### P2 · 数据库重构（需要你拍板，见第七节）

| # | 改动 | 收益 |
|---|---|---|
| 1 | **拆表**：`video_index` 只留影视；图片独立成表 | 索引互不干扰；扫描只需维护 3 棵树而非 10 棵 |
| 2 | 图片表只建 **3 个索引**：`(path)`、`(taken_at DESC, id DESC)`、`(path, filename)` UNIQUE | 写入放大从 10× 降到 3×，库体积与扫描时间显著下降 |
| 3 | 新增 `library_id` 列（或保留路径前缀，但配 `(library_id, ...)` 索引） | 库定位由 `LIKE` 变等值，可走索引 |
| 4 | 新增 `taken_at`（EXIF `DateTimeOriginal`） | 排序符合直觉；支撑时间轴视图 |
| 5 | 分页改**游标**：`WHERE (taken_at, id) < (?, ?) ORDER BY taken_at DESC, id DESC LIMIT 30` | 深分页从 O(n) 降到 O(log n) |
| 6 | PRAGMA：`synchronous=NORMAL`、`temp_store=MEMORY`、`mmap_size=256MB` | 读写提速 |
| 7 | 扫描写入**批量事务**（每 500~1000 行一次） | 避免逐行 autocommit |

> 迁移需要：`_patch_backup/` 全量备份 → 一次性迁移脚本 → 回滚脚本 → 迁移后校验计数一致。

### P3 · 浏览体验对齐 Jellyfin

1. 图片库顶层**按文件夹分组**成相册卡片，下钻再看单张
2. 增加「时间轴」视图（按 EXIF 月份分组）
3. 网格保留 sliver 虚拟化 + 加骨架占位

---

## 七、需要你决定的点

| 问题 | 选项 |
|---|---|
| 是否允许给 `video_index` 加 `library_id` 列？ | 记忆里当初是**刻意不加**的，P2 想加，需要你确认 |
| 图片索引是**拆独立表**还是**继续混在 `video_index`**？ | 拆表收益大，但要迁移；混着只需加部分索引（改动小、收益中等） |
| 是否要引入 EXIF 拍摄时间做排序 / 时间轴？ | 会改变现有排序表现 |
| 是否要先把 P1 单独上线验证？ | 推荐 ✅（只动 worker，风险最低） |

---

## 八、风险与回滚

| 项 | 风险 | 回滚 |
|---|---|---|
| P1 改 tiny worker | 低（只影响缩略图生成顺序） | 还原 `tinyImageWorker.js` 即可 |
| P2 拆表迁移 | 中（涉及数据搬迁） | 迁移前备份 `nascab_video.db`；保留旧表只读 |
| P3 前端 | 低（纯 UI） | 重新构建上一版 web |

> 全部改动前先 `cp` 到 `G:/work/_patch_backup/2026-10-10_图片库优化/`。

---

## 九、实施记录（2026-10-10 16:20 ~ 16:45）

> 用户决定：**按最优方案做，图片索引拆独立表**；目标是几十万张图不卡、打开不占满 CPU。

### 9.1 已完成

| # | 项 | 说明 |
|---|---|---|
| 1 | **新建 `image_index` 表** | 18 列，**只 4 个索引**（见下）。表定义放在 `tableVideoIndex.js` 内（`_ensureImageIndexTable` / `_ensureImageIndexIndexes`）——**不能单独开文件**：`tool/dev_update.py` 只重写 asar 里**已存在**的条目，新建源文件进不了归档，重启会 `MODULE_NOT_FOUND` |
| 2 | **数据迁移** | 74,718 行 → `image_index`（lib#6 图片 70,978 / lib#5 downother 3,740），耗时 **1.0s**；随后 purge 掉 `video_index` 里的图片行 |
| 3 | **扫描链路** | `buildImageIndexRow` / `upsertImageIndexBatch`（500 条一事务）/ `loadImageIndexMtimeMap`（内存比对，**文件没变就零写库**）/ `deleteImageIndexesNotSeen` |
| 4 | **查询链路** | `_listImageOnlyPaged`（图片库）、`_listMixedPaged`（混合库两表内存归并）、`_countImageLib`；库计数 / 首页 / 来源增删搬迁全部适配 |
| 5 | **缩略图** | worker 新增 `image_index` 队列（走部分索引）；前台 4 并发 / 后台 1 并发 + 60ms 限速；`getTinyImgByPath` 对图片改为**入队 + 202**，不再在 HTTP 线程同步解码 |
| 6 | **热更** | `tool/dev_update.py --no-web`（0.8s），并已从 asar 里读回代码逐项校验 |

**4 个索引**

```sql
uidx_image_index_path_filename   UNIQUE (path, filename)
idx_image_index_lib_taken        (library_id, taken_at DESC, id DESC)   -- 分页主索引
idx_image_index_lib_path         (library_id, path)                     -- 目录聚合/相册视图
idx_image_index_pending_tiny     (id) WHERE gen_tiny = 0                -- 缩略图队列(部分索引)
```

### 9.2 实测数据

| 场景 | 改造前 | 改造后 |
|---|---|---|
| 图片库首屏 `LIMIT 30` | 10 索引 + 路径 LIKE，`media_type` 吃不到索引前缀 | **0.03 ms**（`SEARCH ... USING INDEX idx_image_index_lib_taken`） |
| 深分页 OFFSET 60000 | 逐行丢弃，随 offset 线性变慢 | **2.03 ms** |
| 缩略图取队列 | 图片**根本进不了队列**，每张靠 HTTP 现场同步解码（0.79s/张） | **0.01 ms**（部分索引命中） |
| 打开图片库 CPU | 30 个并发 tiny 请求 = 30 个 sharp 同时解码 9504×6336 → **打满** | 后台受控并发（前台≤4 / 后台 1 + 限速），HTTP 侧只入队 |
| 新表体积 | video_index 内图片部分 + 10 个索引 | 表 11 MB + 索引 20 MB |

> 体积上 `idx_image_index_lib_path` 占 7.9 MB（存完整 path）较大，但换来目录聚合走 COVERING INDEX（9.5 ms）；如后续要压体积可改为 `(library_id, substr(path,1,N))`。

### 9.3 ✅ 收尾已完成（服务端进程已退出，趁独占窗口做完）

收尾时发现旧进程被关掉前**又往 `video_index` 回写了 6,195 条图片行**（旧代码扫描的结果）：

1. 再跑一次迁移合并 → **新增 0**，说明这 6,195 条与 `image_index` 里的
   `(path, filename)` 完全重合、只是重复扫描，**数据没有丢失**；随后 purge 删除。
2. `VACUUM` + `ANALYZE`：库文件 **158.1 MB → 41.5 MB（省 116.6 MB）**，耗时 0.7s
   —— 省下的正是那 74,718 行图片和它们各自的 10 份索引条目。
3. `video_index` 最终只剩 **2,054 行纯影视**（movie 1761 / episod 259 / tv 18 / season 16）。

**最终一致性（实跑确认）**

| 库 | counts |
|---|---|
| lib#1 电影 | movie 14 / total 14 |
| lib#2 电视剧 | tv 18 / total 293 |
| lib#3 短剧 | movie 666 / total 666 |
| lib#4 down | movie 90 / total 90 |
| **lib#5 downother (mixed)** | **movie 991 / image 3,740 / total 4,731** |
| **lib#6 图片 (image)** | **image 70,978 / total 70,978** |

### 9.4 只剩一件事：重启

**彻底退出并重新启动 WaterNasOSServer**（新代码在 asar 里，不重启不生效）。

重启后第一次扫描 `F:\picweb` 会把 7 万行的 `file_mtime` 刷新为真实文件 mtime
（迁移时用的是入库时间），预计 10~30 秒；之后扫描只剩 stat、不再逐行写库。
这是预期的一次性动作。

### 9.4 回滚

```bash
python tool/dev_update.py --restore                # 还原 app.asar（回到旧代码）
cp G:/work/_patch_backup/2026-10-10_图片库拆表/db/nascab_video.db \
   "C:/Users/cola/AppData/Roaming/nascab_os_server/database/nascab_video.db"
```
> 备份是 16:22 的一致性快照（134 MB），含当时 `video_index` 里的全部 74,718 条图片行。

### 9.5 已知取舍

* **图片收藏/影集暂不支持**：`video_favorite` 用的是 `video_index.id`，图片迁走后会串号。这类筛选请求会退回按 `video_index` 处理（当前这两张关联表都是 0 条，无实际影响）。后续要么给图片建独立收藏表，要么用 `(type, id)` 复合键。
* **`width/height` 不参与 merge**：扫描期不再逐张读 sharp 元数据（那是扫描最慢的一环），若把 0 写进去会覆盖迁移时保留下来的正确值。新图这两列为 0，网格布局不依赖精确宽高。
* **`taken_at` 用文件 mtime**：库内图片是下载图包，基本无 EXIF；mtime 是最接近拍摄时间的近似。
* **搜索 `LIKE '%x%'` 无法走索引**（实测 7 万行 23 ms，尚可）；几十万行后若变慢，再上 FTS5。

---

## 十、追查「库没显示」：根因是 `show_in_home`，不是拆表

重启后反馈「downother 还是没显示」。复查结论：**服务端与数据全部正常**
（`image_index` lib5=3740 / lib6=70978；`video_index` 已无图片行；用 Electron Node 跑真实
service 层，`listLibrariesWithCounts` 与 `listPaged` 返回的 counts 都对）。

### 10.1 真正的分界：主页 ≠ 左侧栏

| 位置 | 过滤条件 | 结果 |
|---|---|---|
| **主页**（`video_home_page.dart` 第 110 行 + 服务端 `_getRecentAddByLibrary` 的 `.where('show_in_home', 1)`） | **只显示 `show_in_home = 1` 的库** | downother / 图片 **不显示** |
| **左侧栏**（`video_left_menu.dart`） | **只看 `totalCount > 0`**，不看这个开关 | 应该显示 |

而实测 `video_library.show_in_home`：电影=1、电视剧=1，**短剧=0、down=0、downother=0、图片=0**
⇒ 主页只出现两个库，**完全符合设计**，不是 bug。

### 10.2 处理

把 **lib#5 downother 与 lib#6 图片的 `show_in_home` 改成 1**，并用 Electron Node 跑
`getHomeData` 验证，`recentAddByLib` 现在返回 **4 个分组**：

```
lib#1 电影     (movie)  3 条
lib#2 电视剧   (tv)     3 条
lib#5 downother(mixed)  3 条  ← 首条就是 image
lib#6 图片     (image)  3 条
```

### 10.3 顺手修掉一个由本次改造引入的副作用（第二批 6 个文件）

「图片缩略图一律 defer + 202」之后，**没有 202 重试能力的调用方**也会拿到
`file.TINY_PENDING` 异常，导致 error.log 刷屏、AI 分析失败。

**判据：调用方是否具备 202 重试能力。**

* ✅ 保留 defer（浏览器图片标签，前端有 5 次指数退避重试）：`fileTinyController`
* ❌ 必须传 `deferImages: false` 同步生成（6 处）：
  `workers/ai/ocr/ocrWorker.js`、`workers/ai/faces/faceWorker.js`、`workers/ai/places/placesWorker.js`、
  `api/modules/photo/face/faceService.js`、`api/modules/quickShare/quickSharePublicController.js`、
  `api/modules/video/detail/detailService.js`

已热更并回读 asar 逐文件确认。

### 10.4 排查姿势备忘

**沙箱里连不上宿主 6789**（直连 WinError 10061、走沙箱代理报 `upstream failed`），
所以别用 curl 打本地服务端。改用 **Electron Node 直接跑 service 层**，比打 API 更能定位到层：

```bash
cd electron_server
ELECTRON_RUN_AS_NODE=1 ./dist_v14/win-unpacked/WaterNasOSServer.exe G:/work/nascab/tool/_verify_home_image.js
ELECTRON_RUN_AS_NODE=1 ./dist_v14/win-unpacked/WaterNasOSServer.exe G:/work/nascab/tool/_verify_image_index.js
```



---

## 十一、缩略图实测 + GPU 结论 + 改为「按需生成」（2026-10-10 17:1x）

### 11.1 先纠正一个误判：`gen_tiny` 一直在正常回写

之前怀疑「队列被消费但 `gen_tiny` 不回写」，**是误判**，原因是只看了一小撮样例：

```
image_index 共 74,718 行   gen_tiny=1 → 6,805   gen_tiny=0 → 67,913
按库:  lib6(70,978) 已生成 3,066   lib5(3,740) 已生成 3,740 ← 整个库 100%
```

关键佐证：`max(id where gen_tiny=1)` **恒等于** `count(gen_tiny=1)` ⇒ 这是**按 id 顺序
无空洞推进**的后台补图，采样 60s 实测 **4.5~7.7 张/秒**稳定增长。也就是说运行中的
服务端（`dist_v14`，asar 17:06 已含新代码）一直在干活，链路是通的。

另外单独验证了 `_markTinyGenerated` 的 WHERE 前提：`path.dirname(full)` 与
`path.basename(full)` 和库里存的 `path`/`filename` **逐字符相同**，命中行数 = 1。
（顺带否掉一个怀疑：库里的 `path` 没有正斜杠、没有末尾分隔符。）

### 11.2 到底一张多大、多快、存哪（真实数据）

索引规模 **74,718 张 / 170.2 GB**：

| 扩展名 | 张数 | 平均 | 最大 |
|---|---|---|---|
| .jpg | 70,322 | 2.26 MB | 59 MB |
| .png | 3,645 | 3.65 MB | 115 MB |
| .jpeg | 611 | 2.65 MB | 9.5 MB |
| .gif / .webp / .bmp | 140 | — | 7.4 MB |

体积分档：`<100KB` 2,441 · `100–512KB` **35,747** · `512KB–2MB` 15,258 ·
`2–10MB` 17,832 · `10–50MB` 3,384 · `>50MB` 56。
**一半以上小于 512KB**，真正的大块头只有 3,440 张。

生成耗时（`tool/_bench_tiny2.js`，9 张样本 × 每变体 3 轮取 min，已预热）：

| 样本 | 现行管线 |
|---|---|
| PNG 9504×6336 / 115 MB | **~870 ms** |
| JPG 2560×1440 / 0.56 MB | 21～30 ms |
| JPG 1280×960 / 0.6 MB | 29 ms |
| JPG 640×480 / 0.05 MB | 4～22 ms |

汇总 9 张：现行 2736 ms · `webp effort:1` 2586 ms · `jpeg75` 2525 ms。
⇒ **`rotate()` 不是瓶颈**（去掉 rotate 只差 9 ms），**PNG 解码**才是：
9504×6336 的 PNG 不管怎么调都是 ~870 ms（PNG 没有 shrink-on-load）。
JPEG 这条线本来就够快，`fastShrinkOnLoad` 默认已开，没必要再折腾。

产物大小：缩略图 webp **13.9～48 KB**（640px，多数 20～30 KB）。
缓存位置：

```
C:/Users/cola/AppData/Roaming/nascab_os_server/nascabos_cache/tinyCache/<sha256>.webp
hash = sha256(path.basename(fullPath) + stat.size + stat.mtimeMs)
```

### 11.3 GPU 加速：不可行（结论，不是没试）

* 本机显卡 **AMD Radeon 780M（核显）**，CPU 16 线程 AMD ES。
* **libvips 是纯 CPU 库** —— 它的全部可选依赖清单里没有任何 GPU/CUDA/nvJPEG 项；
  sharp 只是它的 Node 绑定，所以 **sharp 无法 GPU 加速**（`sharp.versions.vips = 8.17.3`）。
* AMD 核显的硬件 JPEG 解码（VCN/AMF）**只服务于视频编解码，没有 still-image 解码 API**，
  而且没有 CUDA ⇒ nvJPEG 路线也不成立。
* 真要走 GPU 就得引入 CUDA/nvJPEG 原生扩展，代价远大于收益，且只对 3,440 张大图有意义。

⇒ **不引入 GPU。** 性价比正确的做法就是下面这条：别做全量预生成。

### 11.4 改动：默认「按需生成」

新增配置键 **`tinyPregenEnabled`**（`tableConfig.KEY_TINY_PREGEN_ENABLED`），
**无该行 / 值为 0 ⇒ 按需生成（默认）**；置 `'1'` 才恢复后台全量补图。

* `tinyImageWorker.startLoop()`：后台三个批次（`getPhotoBatch` / `getImageBatch` /
  `getVideoBatch`）被 `if (await this._refreshPregenFlag())` 包住。
  关掉后只剩优先级 1（`wait_gen_tiny` = 浏览器真的在看的图），「滚到哪生成到哪」。
* 开关带 **30 s TTL 缓存**，可运行时热切换，不必重启 worker；worker 仍**常驻**
  （这是 202 能及时响应、网格不再纯空白的前提，别退回 break）。
* 读不到配置时按「按需」处理 —— 那是 CPU 更安全的一侧。
* 已确认 **没有任何显示逻辑依赖 `gen_tiny`**（全仓库只有写入点），按需模式安全。

验证（`tool/_verify_ondemand.js`，走真实入队路径 `_deferTinyToWorker`）：

```
启动日志: TinyImage Worker startLoop (cpu=16, fg=4, bg=1, 后台预生成=关(按需))
测试前: image_index.gen_tiny = 0   wait_gen_tiny = 0
测试后: image_index.gen_tiny = 1   wait_gen_tiny = 0   ← 入队→生成→回写 全程通
```

> ⚠️ `_deferTinyToWorker()` 设计上**一定会抛** `file.TINY_PENDING`（给上层转 202 用），
> 直接调用要 try/catch，否则进程会当场挂掉（踩过）。

已 `dev_update.py --no-web` 热更 `dist_v14` 并回读 asar 校验
（`tinyPregenEnabled` / `getTinyPregenEnabled` / `_refreshPregenFlag` 均在）。

### 11.5 还剩什么

**重启应用**（`dist_v14\win-unpacked\WaterNasOSServer.exe`）后才会生效 ——
当前跑着的进程里还是旧 JS，它仍在按 7 张/秒烧 CPU 做全量补图，重启即停。
重启后 `gen_tiny=0` 会一直停在 6.7 万左右，**这是正常的**，不是没生成。

---

## 十二、ffmpeg 能不能顶替 sharp 做缩略图？（2026-10-10 17:2x 实测）

结论：**不行，而且 GPU 路线在这台机器上是净亏。**

### 12.1 项目里的 ffmpeg 能力盘点

`electron_server/libs/ffmpeg/bin/win/x64/ffmpeg.exe` = **Jellyfin 版 ffmpeg 8.1.1**，编得非常全：

```
-hwaccels : cuda dxva2 qsv d3d11va opencl vulkan d3d12va amf
decoders  : mjpeg(软) · mjpeg_cuvid(N卡) · mjpeg_qsv(Intel QSV)
filters   : scale_cuda · scale_d3d11 · scale_opencl · scale_vulkan · scale_qsv · vpp_qsv
```

**能硬解 JPEG 的只有两个，都要特定厂商的卡**：

| 解码器 | 要求 | 本机（AMD 780M） |
|---|---|---|
| `mjpeg_cuvid` | NVIDIA | ❌ 无 |
| `mjpeg_qsv` | Intel 核显 | ❌ 无 |

`-decoders | grep amf` 实测结果：**只有 `av1_amf` / `h264_amf` / `hevc_amf` / `vp9_amf`，
没有 JPEG/MJPEG** ⇒ AMD 的硬件 JPEG 解码在 ffmpeg 里根本没暴露。
再加一条更致命的：**没有任何 GPU API 能解 PNG**，而 PNG（9504×6336 ≈ 870 ms）正是最慢的那批。

### 12.2 同图对比（`tool/_bench_ffmpeg.js`，3 轮取 min）

| 图片 | sharp 现行 | ffmpeg 纯软解+缩放+webp |
|---|---|---|
| PNG 9504×6336 / 115 MB | **892 ms** | 2024 ms（慢 2.3×） |
| JPEG 2560×1440 / 0.56 MB | **32 ms** | 129 ms（慢 4.0×） |
| JPEG 640×480 / 0.07 MB | **27 ms** | 127 ms（慢 4.7×） |

外加 **ffmpeg 进程启动固定开销 ≈ 96 ms**（只跑 `-version`、啥都没干）。
⇒ 7 万张 JPEG 走 ffmpeg 会**显著变慢**，因为小图的总耗时本来只有 4~30 ms，光启动进程就 96 ms。

### 12.3 唯一的 GPU 路线也不划算

D3D11 设备确实能在 AMD 上打开（`-init_hw_device d3d11va` exit=0），
但 `-hwaccel d3d11va -hwaccel_output_format d3d11` + `scale_d3d11` 直接失败
（`Invalid argument` / `Nothing was written into output file`）—— 因为没有硬件 JPEG 解码器喂 d3d11 帧。

能真正跑起来的只有 OpenCL 缩放，于是拿合成图单独测「纯缩放」（排除解码干扰，4000×3000）：

| 路线 | 耗时 |
|---|---|
| ffmpeg 软件 `scale` | **767 ms** |
| ffmpeg `scale_opencl`（GPU） | **1201 ms ← 反而慢 1.57×** |

⚠️ 这**不是**配置错误，而是 GPU 卸载的固有特性：**加速赢在「大批量数据持续留在显存」**
（视频转码一帧接一帧、几万帧），而缩略图是**一次一张、上传再下载**，
一次性传输开销 > 缩放本身的计算量 ⇒ 净亏。

### 12.4 旁证：Jellyfin 自己也不这么干

Jellyfin 的图片处理后端是 **`Jellyfin.Drawing.Skia`（SkiaSharp，纯 CPU）**；
它的硬件加速（QSV / NVENC / VAAPI / AMF / CUDA / OpenCL）**全部只服务视频转码**，
图片缩略图没有任何 GPU 路径。参考项目都这么选，说明这不是我们漏看了什么。

### 12.5 所以

**保持 sharp（libvips）。** 真正的收益点不在「让单张更快」，而在「别做不必要的生成」——
即 §11.4 的按需生成。排序：① 按需生成（已做，省 CPU）→ ② 解码器本身已是最优（libvips）→ ③ GPU（不可行）。

---

## 十三、附：项目内 ffmpeg 的版本现状（2026-10-10 17:2x）

**结论：不旧，只落后 2 个补丁版；且这两版对我们（AMD + Windows）几乎零收益。**

### 13.1 现状

| 项 | 值 |
|---|---|
| 版本 | **8.1.1-Jellyfin**（`libavutil 60.26.101` / `libavcodec 62.28.101`，clang 22.1.7） |
| 文件 | `libs/ffmpeg/bin/win/x64/ffmpeg.exe`（92.0 MB）、`libs/ffprobe/bin/win/x64/ffprobe.exe`（91.9 MB） |
| 两者 | 配套同版本（ffprobe 也是 8.1.1-Jellyfin） |

⚠️ **注意是 "Jellyfin 版 ffmpeg" 而非上游原版** —— 它带 Jellyfin 自有补丁
（如 AMD hevc_vaapi extradata 覆盖、Windows MSDK hwupload 稳定性、Vulkan 回移）。
⇒ **要跟的是 `jellyfin/jellyfin-ffmpeg` 的版本，不是上游 FFmpeg 的版本。**

### 13.2 版本对照（2026-10-10 查）

| 来源 | 最新版 | libavutil |
|---|---|---|
| 上游 FFmpeg（9.0 分支） | 9.0.2（2026-09-18） | 61.x |
| 上游 FFmpeg（8.1 分支） | 8.1.3（2026-09-21） | 60.26.103 |
| **jellyfin-ffmpeg** | **8.1.3-1（2026-09-27）** | 60.26.x |
| 本项目 | 8.1.1-Jellyfin | 60.26.101 |

Jellyfin 仍停在 8.1 分支（没跟 9.0）⇒ 不是"旧"，是上游支持的组合。

### 13.3 8.1.1 → 8.1.3 改了什么（对我们是否有用）

* `New upstream version 8.1.3` —— 常规合并
* `Fix instability when using MSDK for hwupload on Windows` —— **Intel QSV 专用**，本机 AMD ⇒ 无关
* `Update backported vulkan fixes from upstream` —— 可能有微小相关
* （8.1.2 里）`Fix AMD hevc_vaapi encoder extradata` —— **Linux VAAPI**，本机 Windows + AMF ⇒ 无关
* `Drop support for EOL Debian Bullseye` —— 无关

⇒ **为了性能升级不值得**（没有任何解码/编码性能相关条目）。

### 13.4 若确实要升（方案，待定）

* 产物：`jellyfin-ffmpeg_8.1.3-1_portable_win64-clang-gpl.zip`（64.9 MB）
  `sha256 = 3691f8b2d4c39c511b5faff1c8c4687bd782dac823e63ba69f0755f7ce1af9ce`
  `https://github.com/jellyfin/jellyfin-ffmpeg/releases/download/v8.1.3-1/jellyfin-ffmpeg_8.1.3-1_portable_win64-clang-gpl.zip`
* 步骤：解压 → 取 `bin/ffmpeg.exe` 覆盖 `libs/ffmpeg/bin/win/x64/`、`bin/ffprobe.exe` 覆盖
  `libs/ffprobe/bin/win/x64/` → 备份旧的 → `build_server_pack.bat` 重打包（或热更不含 exe，**必须重打包**）。
* ⚠️ **`libs/ffmpeg/` 与 `libs/ffprobe/` 在 `.gitignore` 第 10/11 行 ⇒ 不入库、远端发行仓也没有**
  （`git ls-tree origin/main` 查无此文件）。所以换 exe 不影响 git，但也意味着**从仓库构建的人拿不到 ffmpeg** ——
  这是既有状态，不是本次引入。升级前务必 `cp` 备份两个 exe 到 `_patch_backup/`。
* ⚠️ 需要联网下载；已查本地三层（`_toolchain` / `%LOCALAPPDATA%\Programs\NasCabOSServer` / `node_modules`）**都没有现成构建**。

---

## 十、长期要点（2026-10-12 从 MEMORY.md 迁入，避免长期记忆超限被截断）

### 10.1 瀑布流（手写、零依赖）
* 组合 = `SliverCrossAxisGroup`（再套 `SliverList` 做列容器） + `SliverVariedExtentList`。
  ⛔ `SliverCrossAxisGroup` **恒把 N 列都发满**（高度取最高列，短列下方留空是正常表现，不是 bug）。
  ⛔ 不能用 `SliverList`（等高，得不到瀑布流效果）。
* ⛔ `SliverLayoutBuilder.builder` 跑在 **layout 阶段**（不是 build）⇒ 里面用到的 Rx 必须在
  外层 `Obx` 闭包内**先读一次**，否则不重建 / 抛 "setState during layout"。
* 尺寸基线（实测调优后）：瀑布流列宽 **430**；普通网格 **320 × (4:3)**、短边 **240**。

### 10.2 缩略图按需生成
* 开关 `tinyPregenEnabled`：**无该行 = 按需生成**（默认）。
* ⭐ **worker 必须常驻**（`IDLE_POLL_MS = 1500`）。worker 空闲退出后，接口返回的 202
  赶不上前端 **15.5s 重试**节奏 ⇒ 网格成片空白（看起来像"图片丢了"）。
* ⚠️ `_deferTinyToWorker()` 走「交给 worker」这条路时**必然抛 `file.TINY_PENDING`**，
  调用方要当正常分支接住，别当错误上报。

### 10.3 混合库分页（图片表 + 视频表归并）
* ✅ 最终方案：**把归并本身放进 SQL**（`_mixedUnionPage`）——
  手拼 `SELECT * FROM (…) UNION ALL SELECT * FROM (…) ORDER BY sort_key, src, uid LIMIT n+1`。
  统一 TEXT 排序键（时间列 `printf('%020d', COALESCE(col,0))`）⇒ SQLite 保证单调 ⇒ keyset 构造性正确。
* 踩过的坑：
  * ⛔ knex `unionAll` 会 emit `union all (select …)`，SQLite 遇尾随 ORDER BY/LIMIT 报 `near "(": syntax error` ⇒ 只能手拼 SQL 字符串。
  * ⛔ knex 里 `NULL as col` 会被当标识符引号化 ⇒ `no such column: NULL` ⇒ 必须 `knex.raw('NULL AS col')`。
  * ⛔ UNION ALL 按**位置**而非名字对齐 ⇒ 两侧必须显式别名投影（曾出现视频的 path 跑进 filename）。
  * 游标 = `key \u0001 src \u0001 sid`（文件名可能含 `|`，所以用 `\u0001`），必须正好 3 段。
  * 图片 id 加 `MIXED_IMAGE_ID_OFFSET = 1000000000` 再发前端（两表 id 都从 1 开始，会撞）。
  * `_mixedEffectiveSortBy()`：混合库把 `view_time`/`taken_at` 降级为 `create_time`（`video_index` 没有 `taken_at` 列）。
* ⚠️ 实测 `view_time` 两张表 **100% 全 NULL/0** ⇒ 按它排会退化成纯 id 序。**这是数据属性不是 bug**。
* ⭐ SQLite 是 **BINARY 序**（`_`=0x5F 排在字母**后**）⇒ 验证脚本别用 `localeCompare`，要按码点比。
* 分页验证口径：8 种排序组合 × 每组合走完 **76 页 / 3782 行**，零重复、零页边界错位。

### 10.4 前端加密与带 token 的 URL
* 算法：`key = sha256(serverId)`、`iv = sha256(jsonStr)[0:16]`、`base64(iv + 密文)`。
* ⭐ 只有 `getTinyUrl` **自动**带 accessToken；`getRawFileUrl` 默认 `false`，而
  `/api/file/rawFile` 挂在 `authenticateJWT` 之后 ⇒ 给 `<video>` 用必须显式
  `withAccessToken:true`，否则 401（现象是「点了不播」）。

### 10.5 GPU / ffmpeg 加速结论（已实测，别再折腾）
* libvips 纯 CPU；ffmpeg 硬解 JPEG 只有 cuvid / qsv（AMD `*_amf` 没有 JPEG 解码器）；
  **没有任何 GPU API 能解 PNG**；ffmpeg 软解比 sharp 慢 **2.3~4.7×**。
* 旁证：Jellyfin 的图片后端用 SkiaSharp，也是纯 CPU。⇒ 缩略图性能只能从并发/缓存/按需生成上找。
