# WaterNasOS 整合实施路线图（TrailSnap 借鉴项落地）

> 分析日期：2026-10-16
> 代码基线：`83f4c99`（v1.1.0），工作区无未提交改动
> 上游输入：[docs/WaterNasOS-TrailSnap功能分析与整合建议.md](WaterNasOS-TrailSnap功能分析与整合建议.md)
> **本文定位**：那份文档回答「抄什么」（源码实读的能力对比），本文回答「怎么抄、抄在哪、怎么验收」。
> 所有落点路径均为**实读复核**结果，§1 列出对分析文档的 7 处勘误。

---

## 0. 怎么读这份文档

| 你想知道 | 看哪一节 |
|---|---|
| 分析文档哪几条结论是错的 | §1 勘误 |
| 战略上到底整合什么 | §2 三块整合价值 |
| 每项改造改哪些文件、怎么验收 | §3 P0 施工卡、§4 P1、§5 P2 |
| 两个必须做的实验怎么做 | §6 实验协议 |
| 先做哪个、依赖关系 | §7 排期与依赖 |
| 改完必须过哪些闸门 | §8 验证闸门 |
| 明确不做什么 | §9 不做清单 |

**与既有工程文档的分工**（冲突时以本文为准，本文以代码实读为准）：

| 主题 | 权威文档 |
|---|---|
| 场景语义搜索 / 识别精度 / 评测集 | `docs/WaterNasOS-场景语义搜索与识别精度方案.md` |
| 场景识别升级（SigLIP2 + DETR 门控） | `docs/WaterNasOS-场景识别升级方案.md` |
| 人脸合并与识别多线程 | `docs/人脸合并修复与识别多线程说明.md` |
| 相册备份与刮削 | `docs/WaterNasOS-相册备份与刮削要点.md` |
| 相册用户隔离 | `docs/WaterNasOS-相册用户隔离方案.md` |
| 构建 / 发布 / 闸门 | `docs/WaterNasOS-构建与发布.md`、`docs/WaterNasOS-开发速查.md` |
| **借鉴项施工图（本文）** | `docs/WaterNasOS-整合实施路线图.md` |

优先级图例：**P0** 低成本高收益、立刻可做；**P1** 需要设计、中等成本；**P2** 架构级、长期战略。

---

## 1. 分析文档勘误（实读复核）

分析文档有几处「猜测」与代码不符，**这会直接改变工作量估计**。开工前必须替换这 7 条：

| # | 分析文档的结论 | 实读真相（含落点证据） | 对施工的影响 |
|---|---|---|---|
| 1 | ⭐「时间轴搜索没接语义 —— 这是你最该补的漏」 | **服务端其实已经接了**：`photoTimeLineService.buildBaseQuery()`（L219-301）在 `ai_place_enable==='1'` 时调 `placesQuery.analyze(search)` 取语义标签，命中 `photo_places2filehash.place_name / alt_place_name / alt_labels`，OCR 走 `photo_info_fts WHERE ocr MATCH ?`（`ai_ocr_enable`），`getTimelinePhotoList` 还用 `searchRankExpr`（L496-498）按命中标签数重排 | 工作性质从「做语义」变成「**客户端接线 + 补活动维度**」。成本仍是低，但**价值点变了**：真正缺的是「用户看不到识别到了什么」 |
| 2 | 「以图搜图入口：你已有 CLIP 图像嵌入，**调一下就能用**」 | ⛔ **图像嵌入从未落库**。`placesClipUtil.scoreImage()` 返回的 512 维 `emb` 只用于与 `text_embeds.bin` 做点积，算完即丢；库里只有场景标签（`photo_places2filehash`），没有任何向量列 | 成本 **低 → 中**：需新增向量存储（列或表）+ 存量回填 + 上传推理接口 + 余弦检索。⚠️ 不要照抄 pgvector/HNSW（单机 SQLite 不适用），走全量余弦（参照 TrailSnap 的 SQLite 分支做法） |
| 3 | 「人物关系图 …… 你**已经有图谱类 UI**」 | 全仓 grep `graph / relation / radial / ForceDirected` 只命中地理聚类（`photo_footprint_map_view.dart` 的 `_ClusterCountBadge`、`photo_map_models.dart` 的 `PhotoMapCluster`），**没有任何人物关系图/放射布局组件** | 前端需**从零新建** CustomPaint 图谱组件（不复杂，但不能按「已有」估工） |
| 4 | 「批量操作预演 + 撤销」 | 批量接口齐全（`/trash/add`、`/favorite/batch`、`/album/index/remove`、`/face/photo/move\|remove`、`/similar/delete`），但 **全栈零 undo**：无操作日志表、无 `undo_data`、前端 `_removeItemsAndCleanUp()` 只清内存 | 需新建**操作日志表**（新表文件 ⇒ 热更进不了 asar，必须整包重打） |
| 5 | （未提） | **活动标签尚未接入任何搜索链路**：`photo_activity` / `photo_activity2filehash` 只在 `placesService.resetPlacesRecognition()`（L391-399）重置时被清空，搜索侧零引用 | ⭐ **纯增量缺口、成本极低** —— 把 SigLIP2 活动维度接进搜索，是 P0-1 里性价比最高的一步 |
| 6 | 「合影组合相册：你的 `photo_face2filehash` 已有关系」 | ✅ 属实。补充：**不存在 `photo_person` 表**，「人物」= `photo_faces` 中 `belong_face_id` 为空/0 的根行；同框数据 = `photo_face2filehash(file_hash, face_id, box_*, is_cover)` | 合影相册确实「纯 SQL」可做，见 P0-2 施工卡 |
| 7 | 「搜索联想 8 类聚合」 | 属实但更麻烦：服务端**完全没有 suggest/autocomplete 接口**；客户端 `CustomExpandableSearchBar` 只有 500ms 防抖防抖，**无联想下拉、无搜索历史**（服务端也无 `search_history` 表） | 联想接口从零新建；数据源全部现成（`photo_faces` / `photo_places` / `photo_activity` / `photo_info_fts` / `photo_index`），唯「标签」类无独立检索（`photo_info_fts.tags` 列存在但无写入） |

**复核结论**：P0 八项里，**只有 P0-2（合影组合相册）、P0-7（重扫两阶段）、P0-8（单张重识别）是「已有数据/机制 + 加一层」**；P0-3 被低估、P0-4/P0-5/P0-6 全是新建。排期时不要按「八项都很容易」来估。

---

## 2. 战略前提

### 2.1 不 1:1 整合

TrailSnap 是「AI 相册 App」（Vue3 + FastAPI + PG/pgvector + 独立 AI 微服务），WaterNasOS 是「NAS 操作系统」（Flutter + Node/Express + SQLite）。
**把 TrailSnap 当「照片域的产品化参照系」**：抄产品化程度（任务面板、进度可视化、写操作可撤销、叙事层、开放平台），**不抄底层 AI 能力**（本仓库人脸模型体积 1/50、速度 16×、许可可商用；场景识别 408 类 + 拒识 head + 活动维度，全面领先）。

### 2.2 真正有整体整合价值的只有三块

| 优先级 | 块 | 为什么 | 本文对应项 |
|---|---|---|---|
| ⭐⭐ | **Agent / MCP 开放平台** | 投入最小（MCP 只读 6 工具）、战略价值最大（Agent 时代入口）。它的「只读 + scope」设计可直接照抄 | P2-18 / 19 / 20 |
| ⭐ | **票据 / 行程线** | 它唯一的护城河，且与本仓库「备份 / 出行照片」场景天然契合；建议**降级实现** | P1-13 |
| ⭐ | **记忆 / 报告叙事层** | 已有 `the_day` 模块，扩展一步就到位，情感价值高 | P1-14 / 17、P2-21 |

### 2.3 两个验证动作必须先做

见 §6。**结论会影响 P1/P2 的选型**（多语言 CLIP 塔若可用，整套 512 短语词表可退役；OCR 版本若落后，后续 OCR 相关项全部要重估）。

---

## 3. P0 施工卡（八项）

> 每项格式：**现状 → 落点（文件:函数:表） → 改动清单 → 验收标准 → 风险**。
> ⚠️ 通用约束：**能只改既有文件就别建新文件**（新增 `.js` 热更进不了 asar，必须整包重打）；被注册的控制器方法**一律不要用 `this`**（裸路由引用），写成箭头函数属性。

### P0-1 ⭐ 时间轴搜索「语义接线」+ 活动维度接入

**现状**（实读）：服务端语义已在（见 §1 第 1 条），客户端不消费；活动标签完全没进搜索。

**落点**

| 层 | 文件 | 关键点 |
|---|---|---|
| 服务端检索 | `electron_server/src/api/modules/photo/timeline/photoTimeLineService.js` | `buildBaseQuery()` L152，搜索分支 L219-301，`searchRankExpr` 在 `getTimelinePhotoList` L496-498 |
| 服务端语义解析 | `electron_server/src/workers/ai/places/placesQuery.js` | `analyze(text)` → `{normalized, components, tags, unmatched}` |
| 活动数据 | 表 `photo_activity`(act_key/act_name/photo_count/score_sum/is_hide)、`photo_activity2filehash`(act_key/act_name/file_hash) | 写入方 `placesWorker.js` L534/548/565；标记位 `photo_index.gen_activity` |
| 客户端控制器 | `flutter_client/lib/modules/photo/timeline/controller/photo_timeline_controller.dart` | `searchKeyword`(L155)、`onSearchChanged`(L401，500ms 防抖)、`clearSearch`(L409) |
| 客户端接口 | `flutter_client/lib/modules/photo/timeline/service/photo_timeline_api_service.dart` | `getTimelineDateList`/`getTimelinePhotoList`（`search` 参数已透传） |
| 可复用样板 | `flutter_client/lib/modules/photo/ai_scenes/`（controller/service/models/view） | `searchScenes`(L59) → `POST /api/photo/place/search`；`AiSceneSearchResult(rawNames/tags/unmatched/semantic)`；`AiScenesSearchSummary` 提示条("已识别/未识别") |
| 搜索框组件 | `flutter_client/lib/modules/base/components/custom_expandable_search_bar.dart` | 三处复用：`photo_timeline_control_bar.dart` L278、`app_photo_timeline_view.dart` L302、`app_photo_timeline_view_year.dart` L539 |

**改动清单**

1. **服务端**（既有文件内改，不新增文件）：
   - `buildBaseQuery()` 的搜索分支加 **活动分支**：命中 `photo_activity2filehash.act_name`（`IN` 语义 tags 或 `LIKE` 原文）。
   - `searchRankExpr` 把活动命中计入权重（与场景标签同量级）。
   - `getTimelineDateList` 同步带上活动过滤（保持角标口径一致）。
2. **客户端**：
   - `photo_timeline_controller.dart` 搜索时**并发**调一次 `POST /api/photo/place/search`（复用 AI 场景页那套），把 `rawNames/tags/unmatched` 落到新状态字段。
   - 控制栏顶部复用 `AiScenesSearchSummary` 样式显示「已识别：雪景 / 滑雪　·　未识别：……」提示条。
   - 无匹配时给出**可操作提示**（而不是空列表）：列出未识别词 + 「试试这些标签」。
3. **不要做**：⛔ 不要在客户端重写一套语义解析（服务端 `placesQuery` 是唯一真源）；⛔ 不要改 `applyCursor` 的 keyExpr（须与排序键一字不差）。

**验收标准**

- 搜「滑雪」「做饭」「日出」在时间轴能出结果；命中来源分别覆盖 活动 / 场景 / 属性 三类。
- 搜索提示条的标签与结果集**完全一致**（标签张数 == 列表张数）。
- 未识别词有明确提示，不出现「静默空列表」。
- 普通用户（非管理员）结果仍受 `PhotoTimeLineService.getValidPaths(user)` 约束（可见性零角色例外）。

**风险**：`buildBaseQuery` 是时间轴/日期/计数三个接口的公共路径，改动后必须回归「无搜索词」路径，避免拖慢默认时间轴。

---

### P0-2 合影组合相册

**现状**：数据齐备（`photo_face2filehash` 有 `file_hash` + `face_id` + `box_*` + `is_cover`），无接口、无页面。

**落点**

| 层 | 文件 | 关键点 |
|---|---|---|
| 服务端 | `electron_server/src/api/modules/photo/face/faceController.js` + `faceService.js` | 新增 `listPeerGroups()`（同框组合）；路由挂 `photoRouter.js` 人脸段 L104-128 |
| 可见性 | `PhotoTimeLineService.getValidPaths(user)` | 组合与照片列表都必须先过这层 |
| 前端落点 | `flutter_client/lib/modules/photo/album/view/app_photo_album_home_page.dart` | 三段式 `_Section`（自建相册 / 智能相册 / 照片合集）L322-410 → 再加一个 `_Section` |
| 列表容器 | `flutter_client/lib/modules/photo/timeline/view/app_photo_album_timeline_page.dart` | `AppPhotoAlbumTimelineType`（album/smartAlbum/collection）→ 复用时间轴容器 |

**改动清单**

1. 服务端新增接口（如 `POST /api/photo/face/group_combos`）：
   - 同框筛选：`SELECT file_hash FROM photo_face2filehash GROUP BY file_hash HAVING COUNT(DISTINCT face_id) >= 2`；
   - 组合签名：按 `file_hash` 上的 `face_id` 集合排序后拼 key 分组；
   - 输出：`{combo_key, member_face_ids, member_names, cover_file_hash, photo_count}`，按 `photo_count` 降序，`photo_count` 只统计**可见**照片；
   - 成员名取 `photo_faces.name`，未命名显示「未命名人物」；排除 `is_hide=1` 的根人脸。
2. 前端：新增「合影」`_Section` + 组合列表页（3:4 封面，标题为成员名顿号分隔）；点开走时间轴容器，按组合的 `file_hash` 集合取列表。
3. i18n：多语言扁平 map **13 个文件全加**，改完跑 `tool/check_dart_tr_keys.py`（尽量复用既有键）。

**验收标准**

- 组合标题 == 成员名顿号分隔；`photo_count` == 点开后列表张数。
- 未命名人物不产生「未命名、未命名」这类退化标题（同一人重复出现要去重）。
- 合并人脸后组合自动重算（不出现已合并的旧组合）。

**风险**：`GROUP BY` 同框在十万级 `photo_face2filehash` 上需实测耗时；可用 `COUNT(DISTINCT face_id)>=2` 子查询 + 索引 `(file_hash)` 收敛。

---

### P0-3 以图搜图入口

**现状**：⛔ **无图像嵌入存储**（见 §1 第 2 条），无一图搜图接口。

**落点**

| 层 | 文件 | 关键点 |
|---|---|---|
| 图像推理 | `electron_server/src/workers/ai/places/placesClipUtil.js` | `scoreImage(imagePath)` 已返回 512 维 `emb`（现被丢弃）；`ensureReady()` 加载视觉塔（`onnx_models/clip/vision_model.onnx`） |
| 写入方 | `electron_server/src/workers/ai/places/placesWorker.js` | 场景识别时顺带落库向量 |
| 建列机制 | `electron_server/src/db/dbUtil.js` 的 `ensureColumns` / `addColumn` | 新列走增量加列，无需迁移框架 |
| 主表 | 表 `photo_index`（`src/db/table/tablePhotoIndex.js`） | 加 `clip_emb BLOB` |
| 路由 | `electron_server/src/api/modules/photo/photoRouter.js` | 新增 `POST /api/photo/place/search_image` |

**改动清单**

1. `photo_index` 加 `clip_emb BLOB`（+ 可选 `gen_clip` 标记用于回填）；`placesClipUtil.scoreImage()` 返回值落到调用方，由 `placesWorker` 写入。
2. 存量回填：写一次性脚本（`tool/_backfill_clip_emb.js` 形态），按 `gen_place=1` 且 `clip_emb IS NULL` 批量跑。
3. 新接口：上传/指定一张图 → `scoreImage(tempFile)` → 读全量可见照片的 `clip_emb` → **numpy 全量余弦**（不引入 sqlite-vec 前先这样，实测再决定要不要加速）→ Top-N + 阈值门控。
4. 前端：AI 场景页搜索框旁加「以图搜图」入口（复用现有选图能力）。

**验收标准**

- 用同一张库内照片发起检索，**自己在 Top-1**；Top-20 人工抽检相关性合理。
- 无结果时明确提示阈值，不返回随机结果。
- 可见性仍受 `getValidPaths(user)` 约束。

**风险与注意**

- ⛔ 不要照抄 pgvector / HNSW（PG 专有）；⛔ 不要引入新的原生依赖（需要重建 Electron ABI）。
- ⚠️ `onnx_models` 在 **extraFiles 不进 asar** ⇒ 必要时回退 `resolveBundledPath('onnx_models')`。
- 存储成本：512 × float32 ≈ 2KB/张 ⇒ 十万张约 200MB，可接受；若要省，存 int8 并在检索时反量化（精度损失需实测）。

---

### P0-4 搜索联想聚合

**现状**：服务端零 suggest 接口；客户端无联想下拉、无搜索历史。

**落点**：数据源全部现成 —— 人物 `photo_faces.name`、场景 `photo_places`、活动 `photo_activity`、OCR/文件名 `photo_info_fts`、日期 `photo_index.original_date`、相机 `photo_index.camera`；可复用 `placesService.listPlaces()`（自带 `photo_count`）与 `photoTimeLineService.tokenizeForOcrMatch()`（L40）。

**改动清单**

1. 新接口（挂在既有 `places` 或 `timeline` 模块，不新增文件）：`POST /api/photo/search/suggest`，入参 `{q, limit}`；并行聚合 **人物 / 场景 / 活动 / 地点 / OCR / 文件名 / 相机 / 日期** 八类，各取 ≤8 条，按 `photo_count` 排序；返回每类带 `type` 与 `count` 供前端分组渲染。
2. 前缀/分词策略：人物与场景用 `LIKE 'q%'`，OCR 走 `photo_info_fts MATCH`（unicode61 分词，需先 `tokenizeForOcrMatch`）。
3. 前端：`custom_expandable_search_bar.dart` 增加下拉建议面板（分组 + 角标）；点击建议 = 直接把该关键词写进搜索（或按类型下钻）。
4. 搜索历史（可选，成本极低）：可参照 `tableMusicLyricSearchLog.js` 的做法加一张日志表；⚠️ 新表文件 ⇒ 需整包重打。

**验收标准**：输入 1~2 个字 200ms 内出建议；八类各能命中（无数据的类不渲染空分组）；联想命中数与点开结果数一致。

---

### P0-5 人物关系图（共同出现 + 证据）

**现状**：无接口、**无图谱组件**（见 §1 第 3 条）。

**落点**：服务端 `faceService.js`（新增 `listRelations()`）+ `photoRouter.js`；前端新建 `flutter_client/lib/modules/photo/ai_faces/view/parts/person_relation_graph.dart`。

**改动清单**

1. 服务端：基于 `photo_face2filehash` **自连接**算共现次数 —— `SELECT a.face_id, b.face_id, COUNT(DISTINCT a.file_hash) FROM photo_face2filehash a JOIN photo_face2filehash b ON a.file_hash=b.file_hash AND a.face_id<b.face_id GROUP BY 1,2`；再叠**证据**：共同出现的场景/活动标签、最早/最近共同日期；支撑 `photo_faces.belong_face_id`（合并后统一指向根）。
2. 前端：`CustomPaint` 放射布局（中心人物 + 邻居按共现次数决定半径/连线粗细）；点击邻居跳人物详情；连线 tooltip 显示「同框 N 张」与证据标签。
3. 图谱组件做成**独立 widget**，方便后续移植到 P1-14 记忆图谱。

**验收标准**：合并人脸后关系图立即收敛（不出现指向已合并子节点的孤立点）；共现次数 == 两人同框照片数。

---

### P0-6 批量操作预演 + 撤销

**现状**：⛔ 无 undo、无操作日志、**无「批量移动照片到文件夹」接口**。

**落点**：写操作入口 `photoTimeLineTrashOps.js`、`photoTimeLineFavoriteOps.js`、`photoAlbumController.removeAlbumIndexes`、`faceController.movePhotoToFace/removePhotoFromFace`、`similarService.batchDeleteSimilarRecords`；前端 `photo_timeline_selection.dart`（`deleteSelected`/`favoriteSelected`/`moveSelectedToOtherFace`/`removeFromFaceAlbumSelected`）、`app_photo_timeline_multiselect_bar.dart`。

**改动清单**

1. 新增操作日志表（**新表文件 ⇒ 必须整包重打**，务必写进发布说明）：`photo_operation_log(id, uid, op_type, target_count, target_ids(JSON), undo_data(JSON), status[proposed|executed|undone|expired], create_time, expire_time)`。
2. 服务端把「预演 → 执行 → 撤销」做成三步：
   - `preview`：只算「将影响 N 张 / 将释放 X MB」，**不写业务表**，写一条 `proposed` 日志；
   - `execute`：执行时按 `log_id` 二次确认（幂等：已是 `executed` 直接返回），写 `undo_data`（原 `in_trash` / 原相册归属 / 原人脸归属 + box）；
   - `undo`：按 `undo_data` 回写，7 天 TTL，过期置 `expired`。
3. 前端：删除/移动确认弹窗显示预演结果 + 「7 天内可在任务中心撤销」；操作完成 Toast 带「撤销」按钮。
4. 顺带补「批量移动照片到目标文件夹」接口（当前完全缺失）。

**验收标准**：删除 100 张 → 撤销 → 100 张全部回到原位置且**原相册归属不丢**；重复点撤销不产生副作用；过期撤销被拒绝且提示清晰。

**风险**：撤销必须落在**业务层快照**而不是文件系统层；⛔ 不碰密码/加密空间数据。

---

### P0-7 人脸重扫两阶段（preview → apply）

**现状**：`faceService.rescanFaces({validPaths})`（L410-454）是「删可见范围 `photo_face2filehash` → `photo_index.gen_faces=0` → 清空壳组」，**直接执行**。已有 dry_run 概念的两个：`rescanMissingFaces({dryRun})`（L467-493）、`mergeSimilarFaces`（有完整 preview）。

**改动清单**

1. `faceService.js` 抽出 `previewRescan({validPaths})`：只统计「将移除的脸行数 / 将重新入队的照片数 / 将清理的空壳组数 / 预计耗时量级」，不写库。可在**既有文件**内新增方法。
2. `photoRouter.js` 人脸段新增 `POST /api/photo/face/rescan/preview`；`face/rescan` 语义改为 apply（保持向后兼容：不传 `preview_token` 时行为不变）。
3. 前端 `ai_faces_controller.dart` 的 `confirmAndRescanFaces`（L432）改为「先 preview 弹窗展示差异 → 用户确认 → apply」。

**验收标准**：preview 不产生任何表写入（可用 `changes()` / 前后行数对比验证）；取消不改变任何数据；apply 后行为与旧接口一致。

---

### P0-8 单张照片「重新识别」分项菜单

**现状**：标记位都在 `photo_index`（`gen_faces / gen_ocr / gen_place / gen_activity / gen_tags / gen_describe`），消费方 `faceWorker.js` / `ocrWorker.js` / `placesWorker.js`；但**只有全库级重置**（`face/reset`、`face/rescan`、`place/reset`），**无按单张重跑单项的接口**。

**改动清单**

1. 新接口（既有文件内加）：`POST /api/photo/ai/rerun`，body `{file_hashes:[], kinds:['face','ocr','place','activity','describe']}` → 逐项置对应 `gen_* = 0` 入队；返回入队条数。
2. ⚠️ 注意各 worker 的**重启语义**：worker 干净退出走 `onStop`，只有带 `signal` 才走 `onError`；「按需自动重启」必须两处都调（参照 `startOcrWorker` / `startFaceWorker` 的 `scheduleRestartIfNeeded`），且先看 `shuttingDown` —— 否则用户点「重新识别」后任务会一直晾着。
3. 前端：照片详情页 / 灯箱加「重新识别」菜单（人脸 / OCR / 场景 / 活动 / 描述 分项勾选）；提交后显示入队提示，可跳任务中心。

**验收标准**：只重跑 OCR 时不动 `gen_faces`（互不干扰）；重跑后结果确实更新（改前/改后对比同一张的 `photo_info_fts.ocr`）；worker 已退出时能自动拉起。

---

## 4. P1 九项（需要设计，中等成本）

| # | 项 | 成本 | 关键落点 / 做法 |
|---|---|---|---|
| 9 | ⭐ **任务系统工程化**（进度面板 + 暂停/恢复 + 优先级 + 限流） | 中高 | 现状是「按需启动 + 空闲退出」，**用户看不到 AI 索引跑到哪**。可借鉴 TrailSnap 的 `TaskManager`(生产) + `TaskWorker`(消费) + **DB 表当持久化队列** + 三优先级队列 + AIMD 自适应并发；本仓库落地口径：先做**只读进度聚合接口**（人脸/OCR/场景/活动 四条 worker 队列的 `gen_*=0` 计数 + 速率），前端做进度面板，再逐步加暂停/优先级 |
| 10 | 足迹地图「叙事层」：旅程回放 + 七天断线 + 旅行连线 + 年份巡游 | 中 | 聚合口径已对（见 `docs/足迹地图与人脸GPU改动说明.md`）；缺的是这一层。`VISIT_GAP_SECONDS = 7*24*3600`（同地点连续拍摄间隔 >7 天开启新访问片段）；连线条件 = key 不同 + 间隔 ≤7 天 + 时间递增；**抽样时绝不把被跳过的片段拼成新线**；回放 = 播放器 + 进度条 + 1×/2×/4× |
| 11 | 时光对照（同地点跨年） | 中 | 权重可直接借：视觉相似度 70% + GPS 15% + 时间跨度 15%。本仓库 GPS 与照片坐标已有（足迹地图在用） |
| 12 | 离线快照（localStorage） | 低 | 命名空间 = `server+user+year`；最多 5 份；1 天 TTL；断网时标注快照时间 |
| 13 | ⭐ **票据 / 行程轻量版** | 中 | 见 §3.6 降级方案：① 复用 `photo_info_fts.ocr` 已有分词文本，用**规则判定**「这是不是票据」（车次/票价/元/站/检票/席别 + 日期形状）② 命中照片按日期 + 地理跳跃聚成「行程候选」③ 在足迹地图标注 ④ 只存原始文本 + 轻量站名表，**不做完整铁路库、不做 YOLO 检框** |
| 14 | 记忆发现（时间+地点+人物聚成事件候选 → 用户确认） | 中 | 已有 `the_day`，扩展一步。⚠️ 需要 P0-5 的图谱组件做可视化 |
| 15 | 模型目录化 + 运行时切换/下载/删除 | 中 | `remoteAssetsManager`（faces / ppocr3 / places365 三个 bundleId）已有雏形 ⇒ 扩展成 `model_catalog` 式「可选模型」（参照 TrailSnap `model_catalog.json` 13 个模型的分档思路）。⚠️ 删被选中模型前必须先切到替代品 |
| 16 | 相似/重复照片工具箱 | 中 | 已有 `similar` worker（phash），缺产品化：MD5 去重 + 聚类 + 并排对比 + 低分模糊清理。⚠️ `FileUtil.getFileHash` = md5(名\_大小\_创建时间) **不能做内容去重**；内容级去重只能靠 `content_md5`（惰性算） |
| 17 | 那年今日增强 → 一日一帧 / 朋友圈文案 | 中 | 已有 `the_day` 模块；文案走 LLM（可选，注意离线可用性） |

---

## 5. P2 五项（架构级，长期战略）

| # | 项 | 成本 | 说明 |
|---|---|---|---|
| 18 | ⭐⭐ **MCP Server（只读，6 个工具）** | **低** | 把照片检索暴露给 Claude Code / OpenClaw / Pi。**投入小、声量大**。直接照抄 TrailSnap 的「只读 + scope」设计：`photos:read` / `albums:read` / `people:read` / `albums:propose`，`ts_` 前缀 token；⚠️ **MCP 侧只给 propose，不给 execute/undo** |
| 19 | CLI | 中 | Agent 友好的无头接口；子命令划分可参照 `photos / albums / people / locations / tasks / toolbox / folders`；输出格式 `json / pretty / table / ndjson / csv` |
| 20 | Agent 对话（三阶段：只读工具 → 写操作计划 → Skill 编排） | 高 | 最大工程量。**必须在 P0-6（写操作预演+撤销）完成之后再做**，否则写操作没有安全网 |
| 21 | 年度报告 | 中 | 纯数据聚合 + 前端叙事，情感/传播价值高；数据全部本地可得（拍摄时间/地点/分类/活动/最远城市/季节） |
| 22 | 需求交付平台（Agent 编码闭环） | 高 | ⛔ **独开一个仓库做，别塞进主仓** |

---

## 6. 两个验证动作的实验协议

### 6.0 铁律（所有 A/B 通用）

> ⛔ **绝不能拿模型输出改真值、再用同一模型评估。** 之前踩过：这样做的 AUC 会被刷成 1.000，实验完全失效。
> 真值一旦标注，**只允许人工修正**，且修正记录必须独立留痕。
> 对比必须用**同一评测集、同一评测脚本、同一判据**，并做显著性检验（本项目已有 McNemar 精确检验的用法，见 `docs/WaterNasOS-场景语义搜索与识别精度方案.md`）。

### 6.1 动作一：多语言 CLIP 文本塔 A/B

**问题**：本仓库 CLIP 词表 49408 token 里 **0 个 CJK** ⇒ 中文必须先翻英文，为此维护「512 短语最大匹配 + 有序绑定 + 迟到融合」整套链路。
TrailSnap 用的是**多语言蒸馏文本塔** `clip-ViT-B-32-multilingual-v1`（`SiYuan044/clip-ViT-B-32-multilingual-v1-onnx`，512 维，61.5MB，int8 后更小）⇒ 中文可**直接编码到图像空间**。
若它可用，本仓库可**省掉整套词表维护成本**。

| 项 | 内容 |
|---|---|
| 数据集 | 本仓库已有 **150 张人工标注评测集**（场景语义方案文档内） + **20~30 条真实中文查询**（必须来自真实使用，不要自己编） |
| 对照 | A = 现有链路（512 短语最大匹配 → 有序绑定 → 无绑定才嵌入最近邻 → 迟到融合 +35%）；B = 多语言塔直编 → 余弦 Top-N |
| 指标 | **Top-5 命中率**（主）、MRR、无结果率、单查询耗时 |
| 判据 | B 的 Top-5 ≥ 80% ⇒ 值得切换到直编；**< 现有链路 ⇒ 现有词表路线即正确护城河**，不必再试 |
| 注意 | 蒸馏塔对**图像塔**有配对要求（必须与同一图像塔配套，否则空间不对齐）；文本 `max_length=128` |

### 6.2 动作二：PP-OCRv6 vs 当前版本

**问题**：TrailSnap 用 **RapidOCR = PP-OCRv6（det+rec small）+ PP-OCRv4 cls**，可能比本仓库现用的代更新。

| 项 | 内容 |
|---|---|
| 第一步 | **核版本**：确认本仓库 `ocrOnnxUtil` / `onnx_models/ppocr3` 实际是哪一代（先查清再谈升级） |
| 第二步 | 若确实更新：用**真实库**（发票 / 菜单 / 路牌）跑 A/B；指标 = 文本召回率 + 关键字段（金额/日期/站名）准确率 + 单张耗时 |
| 必须规避的坑 | ① **OpenVINO `InferRequest.infer()` 非线程安全** —— 必须全局锁，否则报 "Infer Request is busy"；本项目已知「worker_thread 里第 2 个 **CPU** ONNX 会话段错误 rc=139」，升级时务必按串行起会话的既有约束来 ② **OCR 坐标是原图像素多边形、不归一化**（前端叠加需处理 DPR） |
| 决策 | 只升识别塔不动检测塔也是一种选择（成本更低），但需单独验证两者兼容 |

---

## 7. 排期与依赖

```
批次 A（无需新表、不动 asar 结构）          批次 B（需要新表 / 新向量存储）
├─ P0-1 时间轴语义接线 + 活动维度  ★先做     ├─ P0-3 以图搜图（photo_index 加列 + 回填）
├─ P0-7 重扫两阶段 preview→apply             ├─ P0-4 搜索联想聚合
├─ P0-8 单张重识别分项                       ├─ P0-5 人物关系图（新建图谱组件）
└─ P0-2 合影组合相册                         └─ P0-6 批量预演+撤销（新表 ⇒ 整包重打）
                                                        │
                                                        └─→ P2-20 Agent 对话（强制依赖）
```

**依赖关系**

- P0-1 是**所有搜索类项的地基**（P0-3 / P0-4 都往同一条检索链路上挂），先做。
- P0-5 产出的图谱组件被 P1-14（记忆图谱）复用 ⇒ 抽成独立 widget。
- **P2-20（Agent 对话）必须在 P0-6 之后**：没有写操作预演 + 撤销，让 Agent 直接改数据是危险的。
- P2-18（MCP 只读）**不依赖任何 P0**，可以并行启动，且是投入产出比最高的一项。

**发布影响**：批次 B 中 P0-3 加列（`ensureColumns` 可热更兼容）、P0-6 新表（**必须整包重打**）—— 都要在发布说明里写清。

---

## 8. 验证闸门（每项改动都必须过）

| 改动类型 | 必须过的闸门 |
|---|---|
| 服务端 `.js` | `node --check <file>`；改动涉及检索链路的，用真实库跑一次对照查询 |
| 客户端 Dart | `_toolchain/flutter-sdk/flutter/bin/cache/dart-sdk/bin/dart.exe analyze --no-fatal-warnings lib`（≈44s，**可直接跑，无需桥接**）；括号/多语言另跑 `tool/check_dart_brackets.py` + `tool/check_dart_tr_keys.py` |
| 前端产物 | ⭐⭐⭐ 唯一闸门 `tool/build_web.bat`（≈125s，看 `√ Built build\web` + `EXITCODE=0`）；⛔ `build bundle` **不是**闸门 |
| 服务端整包 | 只重写既有条目用 `tool/dev_update.py`（1~2s）；⚠️ **热更后必须重启服务端**（运行中进程 asar 索引失效、`worker_threads` 读错位 ⇒ 接口 400）；新增 `.js` / 新表 ⇒ `tool/build_server_pack.bat`（≈200s） |
| web 资源 | 改 web 后**整目录**拷两处：`<dist>/win-unpacked/web/main/` + `electron_server/web/main/`（只换 `main.dart.js` ⇒ 白屏） |
| 数据/模型 | 任何 A/B 必须遵守 §6.0 铁律 |

**开工前通用纪律**

- 批量改文件：先 `cp` 到 `G:/work/_patch_backup/` → 脚本「读→改→校验→通过才落盘」→ 精确替换配 `assert count` 双重校验；**任何一项 assert 失败必须直接抛错、绝不落盘**。
- ⛔ 绝不用 `git checkout -- <目录>` 回滚；⛔ 不改文件名红线（`nascab_os_server` / `com.nascabos.*` / 地图瓦片 `name` / 加密盐 iv / Flutter 包名 `WaterNasOS`）。
- ⚠️ 本仓 Dart/JS 源码多为 **CRLF** ⇒ Python 改多行文本必须写 `\r\n`；`docs/*.md`、`memory/*.md` 是 **LF**。

---

## 9. 明确不做清单

**继承自分析文档 §6（复核后依然成立）**

| 项 | 原因 |
|---|---|
| ⛔ 双份 alembic 迁移 | 本仓库无迁移机制（`addColumn`/`ensureColumns`），引入是纯负担 |
| ⛔ PostgreSQL / pgvector | 单机 NAS，SQLite 是对的；HNSW 只能在 PG 用 ⇒ 若要加速人脸检索应评估 `sqlite-vec` 而不是抄 pgvector |
| ⛔ sklearn DBSCAN 跑在服务进程里 | 本仓库 worker_thread 已踩过「第 2 个 CPU ONNX 会话 rc=139」；**抄算法可以，抄进程模型不行** |
| ⛔ InsightFace buffalo_l | 350MB + 非商用许可 + 慢，相对 EdgeFace 全面退步 |
| ⛔ 28 类闭集分类器 | 远弱于本仓库 408 类 + 拒识 head + 活动维度 |
| ⛔ i18n 硬编码 | 本仓库 13 文件多语言做得更好 |
| ⛔ 多层嵌套 Scaffold 的嵌入式写法 | 本仓库已定 `embedded: true` 规范 |
| ⚠️ Cesium 三维地形 | 好，但必须把 Workers/Widgets/纹理**随包分发**，不能依赖 ion 账号或 CDN；包体与复杂度要算清楚再上 |
| ⚠️ 它的代码工程质量 | 参考思路，**不要参考工程质量**（自训闭集分类器与遗留 `categories.json` CLIP 零样本方案并存、`yolo_ocr/` 目录已消失但注释还在） |

**本次复核新增**

| 项 | 原因 |
|---|---|
| ⛔ 直接照抄「图像嵌入用 pgvector 存」 | 本仓库是 SQLite；先落 BLOB + 全量余弦，实测瓶颈再决定是否引入 `sqlite-vec` |
| ⛔ 让 Agent/MCP 直接 execute | MCP 侧只给 **propose**；execute / undo 只保留在人机界面（取决于 P0-6 完成度） |
| ⛔ 在服务进程内跑自训模型推理 | 与既有 `worker_threads` + 串行建会话的约束冲突 |

---

## 附：本次复核用到的关键落点速查

| 域 | 路径 / 符号 |
|---|---|
| 时间轴检索 | `electron_server/src/api/modules/photo/timeline/photoTimeLineService.js:buildBaseQuery`、`:getTimelinePhotoList`、`:tokenizeForOcrMatch` |
| 语义解析 | `electron_server/src/workers/ai/places/placesQuery.js:analyze` |
| CLIP 视觉塔 | `electron_server/src/workers/ai/places/placesClipUtil.js:scoreImage`、`:ensureReady` |
| 场景融合/门控 | `electron_server/src/workers/ai/places/placesFusion.js:fuseAndGate`、`:buildCalibration` |
| 活动识别 | `electron_server/src/workers/ai/places/activityUtil.js`、`placesWorker.js`（L445 / 534 / 548 / 565 / 576） |
| 人脸 | `electron_server/src/api/modules/photo/face/faceService.js:rescanFaces`(L410) / `:rescanMissingFaces`(L467) / `:mergeSimilarFaces`(L511) |
| 人脸 worker | `electron_server/src/workers/ai/faces/faceWorker.js`（L786/793/1487） |
| OCR | `electron_server/src/workers/ai/ocr/ocrWorker.js`、`ocrOnnxUtil.js:getOcrEngine` |
| OCR FTS 表 | `electron_server/src/db/table/tablePhotoInfoFts.js`（列 `file_hash, filename, describe, tags, ocr`） |
| 批量写操作 | `photoTimeLineTrashOps.js`、`photoTimeLineFavoriteOps.js`、`similarService.batchDeleteSimilarRecords` |
| 路由注册 | `electron_server/src/api/app.js`（`/api/photo` 在 L275-276）；人脸段 `photoRouter.js` L104-128 |
| 客户端时间轴 | `flutter_client/lib/modules/photo/timeline/controller/photo_timeline_controller.dart`（L155/L401/L409） |
| 客户端场景搜索样板 | `flutter_client/lib/modules/photo/ai_scenes/{controller,service,models,view}` |
| 客户端人脸 | `flutter_client/lib/modules/photo/ai_faces/`（`ai_face_timeline_overlay.dart` 是 PC 人物详情浮层） |
| 相册首页分段 | `flutter_client/lib/modules/photo/album/view/app_photo_album_home_page.dart` L322-410 |
| 搜索框组件 | `flutter_client/lib/modules/base/components/custom_expandable_search_bar.dart` |

---

## 10. 施工进度（第一批：2026-10-16）

> **P0 八项全部端到端落地（前端 + 服务端）**，且都在真实库上跑过验证。
> 闸门：`dart analyze` **0 error**、`tool/build_web.bat` **`√ Built build\web` + `EXITCODE=0`**（205s）、全部改动 `.js` 过 `node --check`、
> 新 SQL 与关键链路在**真实库**（`%APPDATA%\nascab_os_server\database\nascab_photo.db`）跑通
> （脚本 `tool/_p0_verify.py`、`tool/_oplog_init.js`、`tool/_oplog_e2e.js`、`tool/_backfill_clip_emb.js`）。

| 项 | 服务端 | 客户端 | 实测证据 |
|---|---|---|---|
| **P0-1** 时间轴语义接线 + 活动维度 | ✅ `buildBaseQuery` 增加活动分支与排序加权 | ✅ 搜索提示条（已识别 / 未识别） | 「游泳」命中 565（仅活动表）→ **1620**（活动 + 场景 + 文件名）；排序表达式 3/3 行 rank=1 |
| **P0-2** 合影组合相册 | ✅ `POST /face/group_combos` + 时间轴 `combo_face_ids` 交集过滤 | ✅ 相册首页「合影」分段 + 组合页（点开复用时间轴） | 真实库算出 **4569 个组合**、9936 张同框照片；交集 57 张 vs 并集 696 张 ⇒ 语义正确 |
| **P0-4** 搜索联想聚合 | ✅ `POST /search/suggest`（人物/场景/活动/相机/文件名/OCR/年份 7 类） | ✅ 提示条内可点 chip（点了直接检索） | 7 类 SQL 全通，计数按可见范围重算 |
| **P0-7** 人脸重扫两阶段 | ✅ `POST /face/rescan/preview`（只算差异不写库） | ✅ 预览 → 确认 → apply | preview 四项统计：photos 67464 / faceRows 48920 / faces 2657 / samples 13719 |
| **P0-8** 单张重识别（分项） | ✅ `POST /app_ai/rerun`（face / ocr / place / activity） | ✅ 多选「更多」→ 重新识别（4 项勾选） | `photo_index` 标记列齐备；`gen_tags`/`gen_describe` **无消费 worker** ⇒ 不开放并在 `ignored` 回传 |
| **P0-5** 人物关系图 | ✅ `POST /face/relations` | ✅ `ai_face_relation_page.dart`（CustomPaint 放射布局，点人物进时间轴） | 真实库 **17649 条边**，Top 边 231 张共现 |
| **P0-3** 以图搜图 | ✅ `photo_index.clip_emb` + worker 落库 + `POST /place/search_image` | ✅ 多选「更多」→ 以图搜图（结果走既有看图器） | 冒烟回填 20 张：blob **2048 字节**、L2 范数 **1.000000**、**自匹配 Top-1 得分 1.0000**、异图余弦 0.72 |
| **P0-6** 批量预演 + 撤销 | ✅ 新表 `photo_operation_log` + `/trash/preview`、`/operation/undo`、`/operation/recent` | ✅ 删除先预演确认，完成后 Snackbar 带「撤销」 | **真跑**：preview 5 张 / 6.79 MB → 删除（in_trash=[1,1,1,1,1]）→ undo 全部回 `0`；重复撤销被拒 **409** |

### 新增接口（全部挂在既有模块 / 既有前缀内，**未新增任何 `.js` 文件** ⇒ 仍可走热更）

| 路由 | 作用 |
|---|---|
| `POST /api/photo/place/parse` | 只做语义解析（不查库），供提示条展示 |
| `POST /api/photo/search/suggest` | 搜索联想 7 类聚合 |
| `POST /api/photo/place/search_image` | **以图搜图**：`file_hash` / `path` / `image_base64` → 可见范围内最像的 N 张 |
| `POST /api/photo/face/group_combos` | 合影组合相册数据 |
| `POST /api/photo/face/relations` | 人物关系图谱（节点 + 边） |
| `POST /api/photo/face/rescan/preview` | 人脸重扫差异预览 |
| `POST /api/photo/app_ai/rerun` | 分项重新识别入队 + 主动拉起 worker |
| `POST /api/photo/trash/preview` | 批量预演（只算代价，不写库） |
| `POST /api/photo/operation/undo` | 按 `operation_id` 撤销一次批量写操作 |
| `POST /api/photo/operation/recent` | 最近可撤销操作列表 |

新增时间轴请求参数：`combo_face_ids: number[]`（组合脸交集过滤）。
`POST /api/photo/trash/add` 的返回体由 `null` 变为 `{operationId, count, bytes, expireDays}`（前端据此渲染「撤销」）。

### 改动文件清单

**服务端**（`electron_server/src/`）：`api/modules/photo/` 下 `photoRouter.js`、`timeline/{photoTimeLineService,photoTimeLineController,photoTimeLineTrashOps}.js`、`places/{placesService,placesController}.js`、`face/{faceService,faceController}.js`、`app_ai/{appAiService,appAiController}.js`；`db/dbUtil.js`、`db/table/tablePhotoIndex.js`、`workers/ai/places/placesWorker.js`

**客户端**（`flutter_client/lib/`）：`modules/photo/timeline/{models,service,controller,controller/parts,view,view/parts}`、`modules/photo/album/view/{app_photo_album_home_page.dart,app_photo_peer_group_page.dart}`、`modules/photo/ai_faces/{models,service,controller,view/parts}`、`core/languages/*.dart`（13 个语言包）

**新增文件**
- `electron_server/src/db/table/tablePhotoOperationLog.js`（操作日志表 ⇒ **必须整包重打**）
- `flutter_client/lib/modules/photo/timeline/view/parts/photo_timeline_search_summary.dart`
- `flutter_client/lib/modules/photo/album/view/app_photo_peer_group_page.dart`
- `flutter_client/lib/modules/photo/ai_faces/view/parts/ai_face_relation_page.dart`
- `tool/_backfill_clip_emb.js`（clip_emb 存量回填，天然可续跑）

**新增 i18n 键共 29 个**（13 个语言文件全部补齐，`check_dart_tr_keys.py` 缺失 0）：
`photo_peer_group`、`photo_rerun_*`（9）、`face_rescan_preview_*`（5）、`photo_face_relation*`（4）、`photo_search_by_image*`（3）、`photo_delete_preview_*`（3）、`photo_undo*`（4）

### 本批未做 / 未验的部分（诚实记录）

- ⏳ **`clip_emb` 只回填了 20 张做冒烟**：全库 61686 张待回填，需要跑
  `node_modules\electron\dist\electron.exe tool\_backfill_clip_emb.js`（设好 `PATH_DATABASE`），
  按 CLIP 实测速度估算约 **1~2 小时**；未回填前以图搜图只能命中已回填的照片。
  ⚠️ 视频（`type=2`）本轮不回填（要先抽缩略图），脚本只做静态照片。
- ⏳ **未跑** `tool/build_server_pack.bat`（整包重打）与 `tool/dev_update.py`（热更）：
  本批服务端改动**全在既有文件内**可热更，但新增了表 `tablePhotoOperationLog`
  （已用 `tool/_oplog_init.js` 在真实库上单独建好表+索引）⇒ 发布时仍需整包重打一次。
  ⚠️ **热更后必须重启服务端**（原地重写 asar 会让运行中进程的 asar 索引失效）。
- ⏳ **未把 web 产物拷两处**：`electron_server/web/main/` 与 `<dist>/win-unpacked/web/main/` 仍是旧产物，
  需要时按 §8 整目录拷贝（只换 `main.dart.js` 会白屏）。
- ⏳ 客户端改动**未上真机/浏览器点过**：目前只过了 `dart analyze`（0 error）与 `build_web`（成功），交互效果待实测
  （尤其是新画的关系图谱布局、以图搜图结果看图器、撤销 Snackbar）。

### 下一批建议

**P0 已闭环**，接下来按 §7 的顺序进 P1 / P2：

1. **P2-18 MCP Server（只读 6 工具）** —— 投入最小、战略价值最大，且**不依赖任何 P0**；P0-6 做完了，将来上「写操作」也有安全网。
2. **P1-9 任务系统工程化**（进度面板 + 暂停/恢复 + 优先级 + 限流）—— NAS 场景收益最大的一项，本批已经给 `rerun` 做了「主动拉起 worker」，可以顺势把队列可见性补齐。
3. **P1-13 票据 / 行程轻量版** —— 复用 `photo_info_fts.ocr` 已有分词文本做规则判定，成本比 TrailSnap 低一个数量级。
4. **P1-10 足迹地图叙事层**（旅程回放 + 七天断线 + 旅行连线）—— 纯前端，聚合口径已对。

---

## 11. 第二批：P1 / P2（2026-10-16 晚）

> 闸门同上一批：`dart analyze` **0 error**、`tool/build_web.bat` **`√ Built build\web` + `EXITCODE=0`**（210.9s）、
> 改动 `.js` 全过 `node --check`、语言键缺失 0、括号失败 0。
> 服务端新能力在真实库上逐条验过（`tool/_p1_verify.js` → `ALL P1/P2 CHECKS PASSED`；`tool/_mcp_e2e.js` → `ALL MCP CHECKS PASSED`）。

| 项 | 落地情况 | 实测证据 |
|---|---|---|
| **P2-18 MCP Server（只读 6 工具）** | ✅ 新建 `src/api/modules/mcp/mcpRouter.js`，挂 `/api/mcp`；独立 `wnos_` token + `photos:read` scope；管理接口 `/status`、`/config/set`、`/token/rotate` 走 JWT+超管 | `_mcp_e2e.js` **14 项全 PASS**：无/错 token 401、initialize、notification 202、tools/list 6 个、六工具实调（`photos_stats` 18929 张/2276 人/408 场景；`photos_search「游泳」` total=789 且识别出场景「室外游泳池」+活动「游泳」；以图搜图 scanned=1542） |
| **P2-19 CLI** | ✅ `tool/wnos_cli.js`（纯 Node，无依赖，走 MCP HTTP）：`search / recent / scenes / people / stats / image / tools / rpc`，输出 `json/pretty/table/ndjson/csv` | 全部子命令实跑：`search "夕阳下的沙滩"` 解析出 `日落·海滩`、861 张；`image` 返回 0.847/0.840/0.826 相似度；CSV/NDJSON 格式正常 |
| **P1-9 任务系统工程化** | ✅（只读部分）`POST /app_ai/queue` 聚合 5 条流水线 pending/done/percent + worker 运行态 + 开关；AI 设置页顶部新增「任务进度」卡片 | 真实数据一次性暴露问题：**活动识别只跑了 46%（36360 张待处理）**；可见范围口径 ver（self=45934 ≤ all=67464） |
| **P1-11 时光对照** | ✅ 服务端 `timeCompare`（视觉 0.7 + GPS 0.15 + 跨度 0.15）+ 多选「更多」入口 | 找到跨年同地相似照片：视觉 0.9083 / 0.8808 / 0.7778，分数 0.857/0.856/0.784 |
| **P1-13 票据 / 行程（轻量版）** | ✅ `tickets`：OCR 文本规则判定（车次/票价/检票/航班/登机口…）+ 按 7 天断线聚成行程；「智能发现」页展示 | 扫 2000 条 OCR → 命中 **49 张票据 / 14 段行程** |
| **P1-14 记忆发现** | ✅ `memoryCandidates`（日期×地理格 聚类 + 场景/活动/人物证据 + 置信度）+ 确认存 config（按 uid，JSON）；页面可「记下来 / 删除」 | 20 条候选；确认→写入→幂等→删除 全链路 ver |
| **P1-16 相似 / 重复工具箱** | ✅（数据层）`duplicates`：`content_md5` 分组 + 可回收字节 + **未算 MD5 数量**；页面列出分组 | 5 组重复、可回收 **66.0MB**、未算 MD5 **61413 张**（如实告知而不是假装扫完） |
| **P1-15 模型目录化** | ✅（只读）`modelCatalog` 扫描 `onnx_models/` 子目录 + 文件数/体积 + 三件套 bundleId | 列出 activity 52MB / clip 87MB / faces 30MB / person 56MB / places365 92MB / ppocrv5 21MB |
| **P2-21 年度报告** | ✅ `yearReport`（月份直方图 / 活跃天数 / 地点格数 / Top 场景·活动·人物·相机 / 最忙的日子）+ 页面 | 2023 年：9164 张（1028 视频）、活跃 307 天、152 个地点格、Top 场景「沙漠」1100 张 |
| **P1-10 足迹叙事层** | ✅（服务端 + 列表式回放）`travelLines`：按格子切访问片段、**>7 天断线**、相邻访问连线；页面可播放/停止 | 1630 个访问片段、1364 条连线（例：间隔 16.1h / 23.7h） |
| **P1-17 一日一帧** | ✅ `dayFrames`：每天挑一张（有场景>有活动>有人物>非截图，同分用哈希定序保证日内稳定）+ 标签拼句文案；页面展示 | 90 天得到 79 天结果，例：`2026-10-14[3.169]文档照片`、`2026-10-13[3.151]咖啡店` |
| **P1-12 离线快照** | ✅ 新 `photo_offline_snapshot.dart`（命名空间=服务端+uid+年份、5 份上限、1 天 TTL、单份 120 张）+ 时间轴首屏成功即落盘、失败即恢复并提示「离线快照 · 更新于 X」 | 静态检查通过（本地存储行为需真机断网点验） |

### 本批明确「未做」的部分（诚实记录）

| 项 | 状态 | 原因 |
|---|---|---|
| **P2-20 Agent 对话** | ⛔ **未开始** | 需要 LLM 供应商（API Key / 本地模型）与工具调用循环，本仓库目前**没有任何对话模型接入点**。这不是工作量问题，而是缺前置条件 —— 建议单独立项，且必须建在 P0-6 的写操作审计通道之上 |
| **P2-22 需求交付平台** | ⛔ 不做 | 路线图 §9 已定：**独开一个仓库**，不塞进主仓 |
| **P1-9 的暂停/恢复/优先级/限流** | ⏳ 只做了只读 | 这些是**写入型控制**（会改 worker 生命周期），需要和写操作审计一起设计；先把「看得见」做出来，避免用户在黑盒里点按钮 |
| **P1-15 的运行时切换/下载/删除** | ⏳ 只做了只读清单 | 删/换正在被 worker 加载的模型会直接崩（本仓库已踩过 ONNX 会话相关的坑），要配合「先停 worker 再换」 |
| **P1-16 的清理动作** | ⏳ 只做了数据层 | 删除/合并属于破坏性写操作，应走 P0-6 的「预演 → 确认 → 可撤销」通道再放出来 |
| **P1-10 的地图动画版回放** | ⏳ 只做了列表式 | 地图画线要动 `photo_footprint_map_view.dart`（聚簇/角标口径很敏感），风险与收益不成比例，等足迹叙事层单独排期 |
| **P1-13 的完整铁路库 / YOLO 检框** | ⛔ 不做 | 按 §3.6 的降级方案执行：只做「规则判定 + 行程聚类」，不引 3351 站白名单与检框模型 |

### 新增文件与接口（第二批）

**新增文件**
- `electron_server/src/api/modules/mcp/mcpRouter.js`（MCP Server）
- `tool/wnos_cli.js`（CLI）
- `flutter_client/lib/modules/photo/insight/{controller,view}/…`（智能发现页，2 个文件）
- `flutter_client/lib/modules/photo/timeline/service/photo_offline_snapshot.dart`（离线快照）

**新增接口**：`/api/mcp`（JSON-RPC）、`/api/mcp/status|config/set|token/rotate`、
`/api/photo/app_ai/{queue,time_compare,day_frames,tickets,memories,memory/save,memory/remove,duplicates,models,year_report,travel_lines}`（共 11 条）

**新增 i18n 键**：本批 42 个（任务进度 11 + 智能发现 31），13 个语言包全部补齐。

### 仍在后台跑的任务

- `tool/_backfill_clip_emb.js` 全量回填 **仍在运行**（实测 7.6 张/秒；启动时 61686 张待填，约需 2 小时）。
  回填比例直接影响：以图搜图命中率、时光对照的视觉打分覆盖率。
  ⚠️ 未回填的照片**不进视觉打分**（不是「给了 0 分」），所以早期结果偏少是正常的。

---

## 12. 两个「验证动作」的实测结论（2026-10-16 晚）

> 分析文档 §7 判断三点名「应该现在就做」的两件事，这里给出**本机实测**结果。
> 两件事都做了，而且都改掉了原有结论的措辞。

### 12.1 动作二：PP-OCRv6 核对与 A/B —— **确实更新一代，但不能直接换**

**核版本（结论明确）**：本仓库用的是 **PP-OCRv5**（`onnx_models/ppocrv5/{det,rec,cls}` + `ppocrv5_dict.txt`，字典 18384 行 ⇒ 加载后 18385 项）；
TrailSnap 用的是 **PP-OCRv6 small**。v6 是 2026 年 PaddleOCR 的新一代，官方分 **tiny / small / medium** 三档
（small：det 9.5MB + rec 20.3MB，字典 **18710** 项，官方 ONNX 已可获取，Apache-2.0）。
⇒ **「他用的可能更新一代」成立**，升级路径真实存在。

**A/B 设置**：v6 small（det+rec）+ v6 字典，**cls 方向分类器两版共用同一份**（否则不公平）；
12 张真实库照片（论文扫描 / 攻略长图 / 规划公示 / 合同翻拍 / 微博长文 / 保险单 / 多张截图），
同一份后处理代码、同一台机器、`filterResults=false` 保留原始行。

| 配置 | 行数 | 字数 | 低置信行(<0.6) | 总耗时 |
|---|---|---|---|---|
| **v5（现用，阈值 0.25/0.4）** | 689 | 13031 | 28 | 47.2s |
| **v6 small（沿用 v5 阈值）** | 673 | 12916 | **14** | **37.2s（快 21%）** |
| v6 small（阈值降到 0.15/0.25） | 821 | 14831 | 36 | 46.0s |

**逐张看质量（人工读图核对）**：v6 在**清晰文档/长文本**上确实更准 ——
- 规划公示：v5 读成「西至广满调，东座建设路，规划区国相4心平」，v6 读对「西至广清调预，东聚建设路」「图例」「本次规划调整将对原控规进行优化，以…为规划定位」，**多识别出 150 字**；
- 微博长文：v6 补上「sina 新浪博客」页眉，且把 v5 的「趾在桌子上」纠正为「**趴在**桌子上」。

**⚠️ 但发现一个必须处理的回归**：合同翻拍那张，v6 沿用 v5 阈值时 **整块漏检** ——
v5 读到 35 行 / 773 字，v6 只有 21 行 / 330 字（开头十行连同第 1~4 条全丢）。
把检测阈值降到 `DET_BIN_THRESH=0.15 / DET_BOX_SCORE_THRESH=0.25` 后 **恢复到 45 行 / 1080 字**（反超 v5）。
⇒ 说明漏检的根因是 **v6 的 det 概率图分布与 v5 不同，不能沿用 v5 标定的阈值**，不是模型能力问题；
但低阈值同时把噪声带进来（低置信行 14→36，另有一张字数异常暴涨 883→1554，疑为过度检测）。

**结论（照实说）**：
1. **值得升级**，但**不是换文件就能用**：必须①按 v6 重新标定 `DET_BIN_THRESH`/`DET_BOX_SCORE_THRESH`（并加置信度下限过滤），
   ②顺带核一下 det 的输入边长（`DET_LIMIT_SIDE_LEN`）是否也该跟着 v6 调；
2. 换模型**必须连字典一起换**：两版字符集不同（v5 18385 项 vs v6 18710 项），
   字典不匹配时代码会走 `if (dict.length !== recOut.dims[2]) return ''` **静默返回空串** —— 这种失败很难排查；
3. 本次**没有动生产模型**，只加了环境变量开关（`OCR_MODELS_DIR` / `OCR_DICT_PATH`）供离线 A/B；
   生产仍是 v5。要升级请按上面两点先做一次全库回归（尤其**照片类文档**）。

**复现命令**（先跑基线再跑 v6，结果落在 `tool/_tmp/ocr_ab_*.json`）：
```bat
set PATH_DATABASE=%APPDATA%\nascab_os_server\database
set ELECTRON_RUN_AS_NODE=1
set AB_TAG=v5
node_modules\electron\dist\electron.exe ..\tool\_ocr_ab_run.js

set AB_TAG=v6
set OCR_MODELS_DIR=G:\work\_toolchain\ppocrv6_models
set OCR_DICT_PATH=G:\work\_toolchain\ppocrv6\PP-OCRv6_rec_small_dict.txt
node_modules\electron\dist\electron.exe ..\tool\_ocr_ab_run.js
```

**顺带产出**：`tool/_toolchain/ppocrv6/` 已放好 v6 small 三件套（**SHA256 校验通过**），
`G:\work\_toolchain\ppocrv6_models\{det,rec,cls}` 已按本仓库目录约定摆好，随时可复跑。

### 12.2 动作一：多语言 CLIP 文本塔 A/B —— **直编可用，但结论是「融合」而不是「砍掉词表」**

**问题**：本仓库的中文语义搜索靠「512 短语最大匹配切分 → 有序绑定 → 无绑定才退嵌入最近邻 → 迟到融合」，
维护成本高；TrailSnap 用**多语言蒸馏文本塔** `clip-ViT-B-32-multilingual-v1`，中文可直接编码进图像空间。

**做到了什么**：
- 从 `hf-mirror.com` 取到该模型的 **ONNX 文本塔**（fp32 514MB）+ tokenizer + `1_Pooling`/`2_Dense` 权重；
- ⚠️ 该 ONNX **只输出 `last_hidden_state`**（[B,seq,768]），池化与投影在图外 ⇒ 必须自己按
  `1_Pooling/config.json`（**mean tokens**）与 `2_Dense/config.json`（**768→512、bias=false**）接两层，
  否则拿到的是 768 维序列而不是 512 维句子向量（第一版就是这么撞的 `matmul` 维度错）；
- **零图像推理**：两路共用 `tool/_tmp/scene_cache/b32/image_embeds.bin`（550 行，前 150 行 = 评测集），
  所以差异**只**来自查询侧编码 —— 这是这次 A/B 最关键的控制变量；
- 真值：`tool/_scene_gt_150.csv` 里 **95 张可评**照片；相关性由脚本内**一次性写死**的
  `CONCEPT_LABELS` 概念→GT 标签映射决定（两路共用同一把尺子）。

**结果（23 条中文查询 / 95 张可评 / Top-5）**

| 路 | 做法 | Top-5 命中率 | MRR |
|---|---|---|---|
| **A** | 现有词表路线（查询→标签→标签嵌入打分） | 78.3% | 0.684 |
| **B** | 多语言塔中文直编（→512 维→余弦） | **95.7%** | 0.804 |
| **C** | **双路融合**（A/B 各自 z 归一化后等权） | **95.7%** | **0.841** |

分层看（关键）：

| 查询类型 | 条数 | A | B | C |
|---|---|---|---|---|
| 自然中文说法（「家里的客厅」「纸质文件」「街道上的车」…） | 19 | 73.7% | **94.7%** | **94.7%** |
| 裸标签（「客厅」「泳池」「文档」「截图」） | 4 | **100%** | **100%** | **100%** |

**A 路完全失手的 4 条**：`自然风光`、`街道上的车`、`纸质文件`、`拍的文件` ——
根因在 `placesQuery.analyze` 里就能看到：这几句**解析不出任何标签**（`自然风光`/`纸质文件`/`拍的文件` 全进 unmatched），
零标签 ⇒ 零得分 ⇒ 必然不命中。**这就是「词表维护成本」在数据上的样子**：用户永远会说出词表没写进去的说法。
反过来，裸标签查询两路都是 100%，正说明词表**对已建模的场景类是很准的**。

**⚠️ 偏差与限制（必须一起读）**
1. 可评只有 **95 张**，且内容**偏场景**（文档自己早就标注过这个限制）；Top-5 在 95 张里分辨力有限，
   ±1 条查询就能动 ±4pp。**这不足以支撑「一刀切换掉」这种不可逆决定**。
2. 相关性来自 **GT 标签的一次性映射**，不是逐查询人工标注；映射两路共用所以比较公平，但它仍然是「标签命中」的代理指标。
3. B 路耗时 **5 ms/条**（CPU、fp32 514MB、未量化）；int8 版可到 ~130MB，工程上完全可接受。
4. 评测集里几乎没有「日落/雪山/猫」这类**属性/主体**概念（110 张里只有少数），
   而 A 路的 27 个属性标签恰恰是为它们加的 —— 这批查询没覆盖到，结论**不能外推到属性标签**。

**结论（按分析文档 §6.1 的判据走）**
- 判据是「B 的 Top-5 ≥ 80% ⇒ 值得切换」→ **95.7% 达标**，所以**方向确认：中文直编这条路是通的**；
- 但实测并不支持文档原来的措辞「若可用就**省掉整套** 512 短语词表」：
  **融合（C）才是最优** —— 命中率与直编持平，MRR 反而最高（0.841 > 0.804），
  且保留了词表路对已建模场景类的高精度（裸标签双双 100%，MRR 1.00）。
- **建议落地路径**：查询侧**双路并行**（多语言塔直编 + 现有词表解析）→ z 归一化等权融合 → 保留现有「迟到融合 + 有序绑定」用于标签精确命中的重排；
  词表**继续维护但降级为「精排/绑定」用途**，不再承担「唯一的召回通道」。
- **下一步（要更强结论需要做的事）**：把评测集扩到 400+ 张、且**补上属性/主体类概念**，
  再重复本 A/B（脚本已就位：`tool/_ab1_clip_ab.py` + `tool/_ab1_tags.js`，一行命令复跑）。

**复现**：
```bat
:: 1) 导出查询标签（Node 侧，走现有 placesQuery）
set ELECTRON_RUN_AS_NODE=1
node_modules\electron\dist\electron.exe ..\tool\_ab1_tags.js
:: 2) A/B/融合对比（Python 侧，零图像推理）
python tool\_ab1_clip_ab.py
```
模型与权重已就位：`G:\work\_toolchain\clip_multilingual\{model.onnx, tokenizer.json, 1_Pooling/, 2_Dense/}`。

### 12.3 两个验证动作的净结论

| 动作 | 原判断 | 实测后 | 该做什么 |
|---|---|---|---|
| 多语言 CLIP 文本塔 | 「若可用 ⇒ 省掉整套词表」 | 直编 95.7% vs 词表 78.3%；**融合 MRR 最高** | 走**双路融合**；词表降级为精排。**别一刀切砍掉** |
| PP-OCRv6 | 「可能更新一代，值得核」 | 确实是新一代（v5→v6）；**沿用旧阈值会整块漏检** | 升级前先**重新标定 det 阈值**（+核输入边长），并先跑全库回归。**别直接换** |

两件事的共同教训和分析文档 §6.0 的铁律一致：**别信直觉，也别信「换上去更好」的朴素预期** ——
两次都是「方向对、但具体做法要改」，而且两个坑（阈值不匹配、池化投影在图外）都属于**静默失败**。

---

### 12.4 采纳记录：**这两套新方案已经进生产代码了**（2026-10-16 晚）

> 依据：「如果更好的话，就用这个新的方案」。两件事的实测都指向同一个结论 ——
> **方向成立、但不能照搬原设计**。以下是实际改了什么、怎么验的、以及残留风险。

#### 12.4.1 OCR：已切到 PP-OCRv6 small（自动优先，缺失回退 v5）

**改了什么**（`electron_server/src/workers/ai/ocr/ocrOnnxUtil.js`）：
- 新增 `OCR_VARIANT()`：**只要 `onnx_models/ppocrv6/{det,rec}` 存在就用 v6，否则自动回退 v5**
  （远端模式/未升级环境行为不变）；
- 字典随版本走（`ppocrv6_dict.txt` / `ppocrv5_dict.txt`）—— ⛔ 这条不能省，否则静默返回空串；
- **检测阈值按版本取默认**：v6 用实测最优 `0.20 / 0.30`，v5 保持 `0.25 / 0.40`；
- 用 v6 时不再去拉 v5 的远端 bundle；启动日志打印「版本 / 模型目录 / 字典项数 / 阈值」，排查一眼可见。
- 模型已按目录约定放好：`onnx_models/ppocrv6/{det/det.onnx, rec/rec.onnx, cls/cls.onnx, ppocrv6_dict.txt}`
  （cls 复用 v5 的方向分类器，保证两版只差 det+rec）。

**生产路径验证**（不设任何环境变量，脚本 `tool/_ocr_ab_run.js`）：

| | v5（改造前） | v6 + 自动阈值（现在） |
|---|---|---|
| 字数（12 张真实照片） | 13031 | **14745（+13.2%）** |
| 行数 | 689 | 793 |
| 低置信行/百行 | 4.06 | **3.78** |
| 耗时 | 47.2s | **42.1s（-10.8%）** |
| 合同翻拍那张 | 773 字 | **1017 字**（不再整块漏检） |
| v5 长数字保持率 | — | 93% |

**残留风险 / 要知道的事**：
1. **已有 OCR 结果仍是 v5 的**（`gen_ocr=1` 的行不会自动重跑）。要重跑需重置 `gen_ocr`，
   全库 6.7 万张代价很大；建议按需用「重新识别」（P0-8）或等空闲时段批量重扫。
2. 阈值 0.20/0.30 是在**12 张照片**上选的，样本小；已把 `DET_BIN_THRESH`/`DET_BOX_SCORE_THRESH`
   留成环境变量，线上若发现漏检/噪声可即时调，不必改代码。
3. det 输入边长（`DET_LIMIT_SIDE_LEN=960`）**没动** —— 它可能是另一个待标定项，本轮未验。
4. 发布时记得把 `onnx_models/ppocrv6/` 打进包（约 30MB）。

#### 12.4.2 语义搜索：已上线「多语言直编 + 词表」双路融合（含直编召回）

**改了什么**：
- `placesQuery.js` += **多语言 CLIP 文本塔**（自实现 BERT WordPiece tokenizer + mean pooling + 768→512 投影）：
  `isMultilingualAvailable()` / `ensureMultilingualReady()` / `encodeMultilingual(text)`；
  产物 `onnx_models/clip_multilingual/{model.onnx, tokenizer.json, dense_w512x768.f32.bin}`（权重已离线转裸 float32）。
- `photoTimeLineService.js` += `_fuseMultilingualRank()`（融合重排）与 `_multilingualRecall()`（直编召回）：
  · **召回**：SQL 臂完全召回不到时（词表解析不出标签的典型情形），用查询向量在**同一时间窗 + 同一可见范围**内按余弦捞 60 张补进来；
  · **重排**：标签命中数（与 `searchRankExpr` 同语义）+ 向量余弦，各自 **z 归一化后等权相加**；
  · **降级**：塔缺失/加载失败/编码失败 → 原样返回 SQL 顺序（`try/catch` 包住，绝不影响搜索本身）。
- 开关：`ai_multilingual_clip_enable=0` 关融合；`ai_multilingual_recall_min=N` 调召回触发门限（默认 1 = 仅 0 命中时）。

**生产路径验证**（`tool/_fuse_e2e.js`，真实库，clip_emb 覆盖 2.6 万张）：

| 查询 | 关融合 | 开融合（现在） |
|---|---|---|
| 「自然风光」 | **0 张** | **60 张**（召回臂补入；Top-5 = 台风 / 风电场 / 阔叶林 / 风电场 / 日出） |
| 「纸质文件」 | **0 张** | **60 张**（Top-5 = 发票票据 / 文档照片 / 发票票据 / 发票票据 / 白板）⭐ 相当准 |
| 「街道上的车」 | 205 张，Top 有「住宅区」等无关项 | 205 张，**Top-3 全是「公路」**、第 4/5 是「街道」⭐ 明显更准 |
| 「家里的客厅」 | 123 张，Top 有「礼品店」「宿舍」 | 123 张，Top-1 是「客厅」，但 2~5 是「餐厅」⚠️ **这条没明显改善** |

**⚠️ 残留风险 / 已知代价（都留了退路）**：
1. **召回要扫全库向量**：当前 2.6 万张 ≈ +1.7s；回填满 6.7 万张会到 ~3s。
   所以默认**只在「不召回就一定 0 结果」时**才付这个代价；优化方向是 `sqlite-vec` 或进程内缓存（67k×512×4B ≈ 137MB）。
2. **重排路径很便宜**（+33~55ms），但「家里的客厅」这类**词表本来就能命中**的查询上，
   融合把「餐厅」提上来了 —— 说明**等权（0.5/0.5）不是普适最优**。
   考虑过改权重，但改动会破坏「离线 A/B 验证过的口径」，所以**先保持等权、把问题记录下来**：
   要用真实查询调权重，得有比 95 张更大的评测集（同 §12.2 的局限）。
3. **覆盖依赖回填**：`clip_emb` 只回填了 ~40%（2.6 万/6.7 万），未回填的照片不参与向量臂
   （不是打 0 分，是不参与）。回填跑完前，召回的结果集偏小。
4. 生产实现与 Python 参考实现**逐条对齐验过**：23 条查询的 token id 序列**完全一致**、向量余弦 **1.000000**
   （`tool/_mt_verify.js` + Python 对拍）—— 自实现的 tokenizer/池化/投影不是「差不多」，是等价。

#### 12.4.3 一句话总结这次采纳

| 方案 | 是否采纳 | 形态 |
|---|---|---|
| PP-OCRv6 small | ✅ 采纳 | 自动优先 + 回退 v5 + 按版本阈值；**改动集中在 1 个文件** |
| 多语言塔直编替代词表 | ⛔ **不采纳（实测不支持）** | 会丢掉裸标签的高精度 |
| **多语言直编 + 词表 融合** | ✅ 采纳 | 召回互补 + z 归一化重排，双开关可退 |

---

## 13. 开放平台设置界面（P2-18 / P2-20 的配置入口）

> 要求原话：「在设置里面加一个让我可以配 API 的接口就可以了。具体的内容，你看他怎么做的，你也就怎么做。」
> 位置：**相册 → 设置 → AI 设置**（该页本来就限超管，与接口的 `requireSuperAdmin` 一致）。

### 13.1 界面上能配什么

**卡片一：开放平台（MCP）** —— 对照 TrailSnap 的 MCP Server 口径（§5 P2-18）

| 项 | 说明 | 对应接口 |
|---|---|---|
| 启用开关 | 关掉后 `POST /api/mcp` 直接 403 | `POST /api/mcp/config/set` |
| 接入地址 | 只读展示 `<服务端地址>/api/mcp` + 协议版本 | `POST /api/mcp/status` |
| 访问令牌 | 显示掩码（`wnos_…abcd`）；**轮换**后明文只出现一次 | `POST /api/mcp/token/rotate` |
| 归属用户 | 下拉选（来自 `/api/user/list`）—— 决定这份令牌能看到**谁的照片源** | `POST /api/mcp/config/set` |
| 可用工具 | 6 个工具名摊开显示（全部只读） | `POST /api/mcp/status` |
| 复制客户端配置 | 一键把 Claude Code / 通用 MCP 客户端的 `mcpServers` 片段复制到剪贴板 | 前端拼接 |

**卡片二：模型 API（Agent 用）** —— 对照 TrailSnap 的「任意 OpenAI 兼容厂商」

- `base_url` / `api_key`（**留空 = 保留已保存的密钥**）/ `model`；
- **「测试连接」是真发请求**：服务端走全局代理去 `GET {base_url}/models`，
  成功则回延迟 + 可用模型数 + 你填的 model 是否在列表里；失败原样透出状态码与响应体。
  ⇒ 不会出现「填了配置但没人验证过」的死配置。

### 13.2 安全口径（三条，都照 TrailSnap 的做法）

1. **只读**：MCP 侧 6 个工具全是查询（搜索 / 以图搜图 / 最近照片 / 场景 / 人物 / 统计），
   没有任何写操作 —— 写操作要等 P2-20 的「预演 → 确认 → 可撤销」通道，MCP 侧只给 propose。
2. **独立令牌**：`wnos_` 前缀 + `photos:read` scope，与登录 JWT 完全分离；泄漏一个令牌 ≠ 泄漏账号。
3. **明文只出现一次**：轮换时返回、之后只回掩码；`api_key` 同样只回 `has_key` + 尾 4 位。
   所以「复制客户端配置」必须先轮换一次（界面会提示）。

### 13.3 验证

`tool/_modelapi_e2e.js`（真库 + 真出站）**10 项全 PASS**：
- 配置读写：尾斜杠归一化 / **api_key 只回掩码且响应体里不含明文** / 不传 key 时保留 / `clear_key` 能清空；
- **连通性测试真打到了 `api.deepseek.com`**：用假密钥拿回 `HTTP 401 … Your api key: ****1234 is invalid` ⇒ 出站 + 代理 + 错误透出全通；
- 错误主机名给明确失败（不抛异常）；空 base_url 走参数校验分支；
- MCP 侧：配置可读（token/uid/scopes）、工具清单 6 个。

闸门：`dart analyze` **0 error**、`build_web.bat` **`√ Built build\web` + `EXITCODE=0`**、
`check_dart_tr_keys.py` 缺失 0（本批 22 键 × 13 语言，累计 93 键）、`check_dart_brackets.py` 失败 0。

### 13.4 顺带修掉的两件事

- **多语言塔内存**：实测 fp32 塔常驻 **+437MB RSS**（96→522MB）。已加**空闲自动卸载**
  （默认 10 分钟，`MT_IDLE_UNLOAD_MS` 可调）：卸载后 RSS 回到 **152MB**，下次查询自动重载（实测通过）。
- **OCR 侧无回归**：本轮改动没有碰 OCR 路径，v6 优先策略不变。

**至此 P2-20（Agent 对话）只差最后一件事**：一个可用的对话模型。设置页现在**已经能配置并验证凭据**，
接下去就是「工具调用循环 + 写操作计划（复用 P0-6 的预演/撤销）」这一层 —— 那是一个独立的批次，
不建议和本轮的配置层混在一起做。

---

## 14. 第三批优化（2026-10-16 晚）

### 14.1 AI 流水线「暂停 / 恢复」（P1-9 写入型控制的第一块）

之前只做了 P1-9 的**只读**部分（进度聚合）。这次补上第一个**写入型**控制 ——
按 §11 的原则（写入型控制要谨慎），选的是其中最安全的一个：

- **不丢数据**：暂停就是把 worker 停掉（`stopWorker`），worker 写完当前这张就退出，**队列标记原样留在库里**；
- **完全可逆**：恢复就是把 worker 再拉起来（复用 P0-8 的 `startMethod` 映射）；
- **语义窄**：只掐「后台自动跑」，不动任何显式用户动作。

**实现要点**（改了 4 个既有文件，无新文件）：
| 文件 | 改动 |
|---|---|
| `singletonWorkerManager.js` | 新增 `aiPaused` 标志 + `setAiPaused/isAiPaused` |
| `initHandler/workers.js` | face / ocr 的**自动重启**闭包增加暂停守卫（places/similar 本来就不自动重启） |
| `initHandler/initMain.js` | 开机自启 4 个 AI worker 时增加 `!aiWorkerPaused` 门控 |
| `appAiService.js` | `setQueuePaused()`（写配置 + 停/起 worker）；`getQueueStatus` 透出 `paused`；暂停期 `rerunAi` **不拉起 worker 但照旧入队**，并如实回传 `paused:true` |

界面上：AI 设置页「任务进度」卡片新增**暂停/恢复**按钮 + 暂停横幅（红色提示「队列标记保留，恢复后继续」）。

**验证**：`tool/_pause_e2e.js` **12 项全 PASS** —— 暂停写入配置并生效、状态透出、暂停期 rerun 入队但不拉起且如实回传 paused、
恢复清除标志、配置回到 0。⛔ 测试用「临时把 enable 键置 0」的方式避免真的拉起模型进程，且**结束后原样还原**。

### 14.2 重复照片「清理动作」（P1-16 补齐执行侧）

之前只做了数据层（分组 + 可回收字节）。现在接上 P0-6 的安全通道：

- 服务端 `duplicates()` 的分组条目**带上 `photo_index.id`**（清理要按 id 走 `/trash` 的预演与撤销）；
- 客户端「智能发现 → 重复照片」每组出现「清理重复」按钮：
  **预演**（将影响 N 张 · X MB）→ 确认 → `batchTrashLogged` → Snackbar 带**撤销**（10 秒）。
- 规则是**保留第一张、其余进回收站**；只动索引，不动用户原始文件。

### 14.3 web 产物已部署（这步不做，界面改动在运行中的服务里看不到）

`tool/build_web.bat` 只产出 `flutter_client/build/web/`，服务端实际服务的是 `electron_server/web/main/`。
本批已按 §8 的口径**整目录拷贝**并核对：
- 改前 `main.dart.js` 13,251,091 字节 → 改后 **13,337,871 字节**；
- 在**部署产物**里 grep 到新代码的字面量（`app_ai/queue/pause` ×1、`photo_insight_dedupe` ×3）
  ⇒ 新界面确实进包了（dart2js 会 mangle 标识符，但字符串字面量能作为证据）。
  ⚠️ 浏览器需**硬刷新**（关标签页重开）才能摆脱旧的 service worker 缓存；有 dist 的话 `<dist>/win-unpacked/web/main/` 也要同步拷。

### 14.4 一条自我纠错（值得记）

`_pause_e2e.js` 的 finally 里我把 `ai_similar_enable` 从「**未设置**」还原成了 `'1'`，
而 `initMain.js` 判断的是 `=== '1'` ⇒ **会让相似照片 worker 开机自启**（原本不会）。
已用 `tool/_fix_config_row.js` 删除该行让它真正复原（config 表没有删除 API，直接按 key/uid 精确删一行）。
**教训**：拿「未设置/null」有语义的配置键做测试时，还原要还原到「没有这一行」，而不是还原成一个看起来等价的字符串。

### 14.5 本批闸门

| 闸门 | 结果 |
|---|---|
| `dart analyze` | **0 error**（74 条既有 info/warning） |
| `tool/build_web.bat` | **`√ Built build\web` + `EXITCODE=0`**（21:16:13） |
| `check_dart_tr_keys.py` | 缺失 **0**（本批 7 键 × 13 语言，累计 **100** 键） |
| `check_dart_brackets.py` | 失败 **0** / 36 文件 |
| 服务端 `node --check` | 本批改动的 7 个 `.js` 全过 |
| 端到端脚本 | `_pause_e2e.js` **12/12 PASS** |

⏳ 仍未跑：整包重打（`build_server_pack.bat`）、热更（`dev_update.py`）、有 dist 时的第二处 web 拷贝、真机点击。

---

*本文与 [WaterNasOS-TrailSnap功能分析与整合建议.md](WaterNasOS-TrailSnap功能分析与整合建议.md) 配套使用：前者是「借鉴什么」的对标报告，本文是「怎么落地」的施工图。*

---

## 15. 发布决策与 dist_v25 重打（2026-10-16 21:21）

### 15.1 多语言塔「不随包」的决策依据（用户拍板）

| 维度 | 结论 |
|---|---|
| 是否必要 | **不是必要，是可选增强**。作用只有一个：让中文**直接**编码进 CLIP 图像空间，给语义搜索做「召回补充 + 融合重排」。实测收益：Top-5 命中率 78.3%→95.7%，且「自然风光/纸质文件」这类词表解析不出标签的说法从 **0 结果 → 60 结果** |
| 不装会怎样 | **优雅降级**：`placesQuery.isMultilingualAvailable()` 返回 false ⇒ 搜索自动退回现有词表路线，行为与升级前完全一致、不报错 |
| 体积 | fp32 塔 **518MB**（整包 2.0GB → 约 2.55GB）。随包会让安装包涨 26%，对下载/分发不友好 |
| 内存 | 常驻 **+437MB RSS**（已加空闲卸载：10 分钟后 532→152MB，下次查询自动重载）。低配 NAS（2GB 内存）会与相册索引抢内存 |
| **int8 为什么不选** | ① **精度未验**（fp32 的 95.7% 是我实测的，int8 要重跑 A/B + JS/Python 一致性对拍才能用）；② 省的主要是磁盘与权重内存，ONNX Runtime 的运行时开销仍在；③ **指令集/架构兼容性风险**：`model_qint8_avx2.onnx` 依赖 **AVX2**，老 CPU（2013 前）与 ARM 机型（群晖/威联通 ARM、树莓派）可能跑不动或需**按架构分包**（HF 上另有 `model_qint8_arm64.onnx`），而 **fp32 兼容性最好** |

⇒ **结论**：塔做成**可选下载**（`tool/_fetch_clip_multilingual.py`，一条命令装到源码树或任意 dist 的
`onnx_models/clip_multilingual/`），包只 +31MB（OCR v6）。首发只提供 fp32；将来真有人反馈内存吃紧，
再评估 int8 —— 且**必须先在目标机型上量过**。

### 15.2 dist_v25 重打结果（`EXITCODE=0`，68s）

- 用了新编号 **dist_v25**（`dist_v24` 是你 16:34 自己打的老包，按「同名 dist 先清空」的规矩必须换号）；
- 打包前把 `onnx_models/clip_multilingual` **临时移出**打包范围（`G://work//_toolchain//clip_multilingual_src`），
  打完已核对：**v6 在包里、塔不在包里**、新 web 是 **13,337,871** 字节、asar 里带 `mcpRouter.js` 与
  `tablePhotoOperationLog.js`；
- **代码侧已核**（不启动也能核）：asar 内 `OCR_VARIANT` ×3、`clipEmbColumn` ×3、`setQueuePaused` ×2、
  `encodeMultilingual` ×5、`mcp_server_config` ×1，阈值串 `IS_V6() ? 0.2 : 0.25` / `0.3 : 0.4` 均在
  ⇒ 运行行为确定：**模型目录在 ⇒ 走 v6**；
- ⚠️ **运行时那一步我没做掉**：从 agent 后台任务里起 GUI/tray 型 Electron 起不来（进程卡在 39MB、无日志、端口不监听），
  已把该进程杀掉。**请你双击 `dist_v25\win-unpacked\WaterNasOSServer.exe` 启动**，
  启动后日志里应出现 `[ocrOnnx] 版本=v6 模型目录=...ppocrv6 字典=18710 项 det 阈值=0.2/0.3`；
  浏览器记得**硬刷新**。

### 15.3 决策变更：塔**打进包**，并顺手修掉一处 886MB 的历史浪费（21:42）

用户改主意：「那还是把这个语言包打进服务端吧，反正多个几百兆也无所谓。」⇒ 塔进包。执行中发现一个**与塔无关但更值钱的问题**：

| 包 | 内容 | 总计 | app.asar |
|---|---|---|---|
| v25 | 无塔（模型**也**在 asar 里） | 2.01 GB | 442 MB |
| v26 | 有塔（模型**也**在 asar 里） | 3.03 GB | 959 MB |
| **v27** | **有塔，模型只在 extraFiles** | **2.16 GB** | **73 MB** |

**根因**：`package.json` 的 `build.files[0].filter` 里早就排除着 `!web/*`、`!libs/**`、`!dist*/**/*`（大件一律走 `extraFiles`），
**唯独漏了 `!onnx_models/**`** ⇒ 每次打包都把 886MB 模型白塞一份进 asar。
而运行时 `config.getRootPath()` = `dirname(app.getPath('exe'))` = `win-unpacked/`，模型是从 `win-unpacked/onnx_models`（extraFiles 那份）读的
—— asar 里那份**从来没被读过**（`libs/sharp/**` 同样被排除却照常运行，就是这条路径成立的旁证）。

**改动**：`electron_server/package.json` 的 `files` 过滤追加 `!onnx_models/**`（一行，`extraFiles` 不动）。

**结果**：带着 518MB 塔的 **v27 反而比不带塔的 v25 还小 0.14GB**，比 v26 省 **886MB**；
asar 959MB → 73MB（已逐字节验过：里面剩下的 `onnx_models/clip_multilingual` 字样是**源码注释**，
`ppocrv6_dict.txt`/`vision_model.onnx`/`dense_w512x768` 是**代码里的字符串常量**，没有任何模型二进制）。

**核对**：v6 在包里（21,234,383 字节）、塔在包里（539,049,415 字节）、新 web 13,337,871、asar 内新代码全命中
（`OCR_VARIANT`×3 / `clipEmbColumn`×3 / `setQueuePaused`×2 / `encodeMultilingual`×5 / `mcp_server_config`×1）。

⇒ **请用 `dist_v27`**（v25/v26 都不必留；v26 是带重复模型的中间产物，可删）。

**代价（塔进包的后果，要记住）**：端上首次查询会多 **+437MB RSS**（10 分钟空闲后自动卸载回落到 ~152MB，
`MT_IDLE_UNLOAD_MS` 可调）；2GB 内存的低配 NAS 建议仍用「不装塔」的方式（删掉 dist 里的 `onnx_models/clip_multilingual` 即可，
代码会自动降级回词表路线，不报错）。
