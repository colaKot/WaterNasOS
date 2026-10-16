# TrailSnap（行影集）功能全景 × WaterNasOS 整合建议

> 分析日期：2026-10-16
> 仓库：`G:/work/TrailSnap` @ `9480b238`（master，已是最新）
> 许可证：**AGPL-3.0**（与你一致 ⇒ 代码可放心整合，无许可问题）
> 本文所有结论来自**源码实读**，不是 README 转述。带 ⚠️ 的是需要你实测确认的猜测。

---

## 0. 先说更新结果

```
git pull origin master → Already up to date.
git fetch --all --prune → origin/master = 9480b238 fix(requirements): extend agent lease to 30 minutes
```

本地已是最新，无新提交。远程另有两条未合并分支：`codex/release-0.17.0`、`codex/req-157-desktop-portable-paths`（都是发布/打包相关，与功能无关）。

---

## 1. 一句话定位差异（这决定了整合策略）

| | TrailSnap | WaterNasOS |
|---|---|---|
| 是什么 | **一个 AI 相册 App**（Web/PWA/手机/桌面，四端同一套 Vue 前端） | **一个 NAS 操作系统**（文件/影视/音乐/笔记/同步/相册/终端/离线下载…） |
| 技术栈 | Vue3 + FastAPI(Python) + PG/pgvector + 独立 AI 微服务 | Flutter + Node/Express + SQLite |
| 数据模型 | 照片是一等公民，一切围绕相册 | 照片只是十来个业务域之一 |
| 目标 | 把旅行从「拍过」变成「可留念、可展示、可分享」 | 把数据留在自己手里 |

**结论：不要 1:1 整合。** 应该把 TrailSnap 当作**「照片域的产品化参照系」**——
抄它的**产品化程度**（任务面板、进度可视化、写操作可撤销、叙事层、开放平台），
**不要抄它的底层 AI 能力**（你的 AI 明显更强，见第 3 节）。

---

## 2. TrailSnap 功能全景

### 2.1 照片基础

- **多数据源**：可添加多个外部文件夹；递归 `os.scandir`；支持命名正则/最小体积/排除文件夹（如 `@eaDir`）过滤
- **EXIF**：拍摄时间、相机品牌型号、拍摄参数、GPS；`LocationDetails` 反查国家/省/市/区/地址
- **缩略图/预览图多档可配**：缩略图 250/480/720/1080 + 质量；预览 720/1080/1440/2160 + 质量（改后跑任务重算）
- **Live Photo**：iPhone/vivo/oppo/小米；HEIC+MP4 / JPG+MOV 配对识别；Motion Photo 抽内嵌视频
- **视频**：Range 流式播放；xgplayer（倍速/截图/x5 内核适配）
- **时间轴**：月块→日块→**行级三级虚拟化**（缓冲 1000px）；右侧时间轴滑块（桌面刻度+tooltip，移动端擦洗条）；移动端**双指缩放调列数**（iOS 相册式，带 FLIP 动画 + 锚点定位）
- **4+1 种布局**：瀑布流 / 正方形 / 朋友圈(模拟微信) / 日记本 / 文件夹
- **上传**：普通 + 分片 + 断点续传；移动端备份去重（`backup_key` 唯一索引 + `check_content`）
- **回收站**：还原 / 彻底删除 / 清空；大批量走异步任务 + 进度轮询
- **批量操作**：改标签 / 加入相册 / 加入人物 / 改位置 / 移动复制 / 删除 / 下载
- **图片编辑器**：Fabric.js
- **存储中心**：按类型/设备/文件夹统计、可回收空间、截图归类、大文件 Top

### 2.2 AI 能力（8 条流水线）

| 能力 | 实现 | 关键参数 |
|---|---|---|
| **人脸识别** | InsightFace **buffalo_l**（`det_10g.onnx` 检测 + `w600k_r50.onnx` 512维） | 检测阈值 0.5；识别阈值 0.7；聚类 DBSCAN cosine **eps=0.4 / min_samples=5**；重扫三级阈值 0.35/0.45/0.52；人脸向量 **HNSW 索引**（`vector_cosine_ops`，仅 PG） |
| **智能分类** | **自训闭集 ONNX**（`photo-cls-general` + 按文件名发现的二级 `photo-cls-{cat}`） | 两级推理：general 阈值 0.5 → small 阈值 0.95；低于阈值 → `others`；**28 类中文标签**（动物/狗/猫/鸟/人像/儿童/自拍/风景/建筑/日落/夜景/月亮/文档/聊天消息/卡证/火车票/机票截图/电影票/美食/汽车/植物/电子产品/滑雪/游戏/截图） |
| **OCR** | **RapidOCR** = PP-OCRv6 检测/识别（small）+ PP-OCRv4 cls（180° 方向） | 纯中文（`LangDet.CH`）；**不做多语言、不做竖排**；未显式设阈值（走 RapidOCR 默认）；坐标为**原图像素多边形，不归一化** |
| **向量/语义搜索** | CLIP **ViT-B/32**；文本塔是**多语言蒸馏版**（`clip-ViT-B-32-multilingual-v1`）⇒ **中文可直接编码到图像空间** | 512 维，双塔 L2 归一化；文本 `max_length=128` |
| **情绪/颜色** | **纯颜色算法**（无模型）：缩放到 150px → 采样 1 万像素 → 自实现 KMeans k=5 | 输出主色 5 个 + 亮度 + 饱和度 + `emotion_hint`(vibrant/muted/warm/cool/neutral) + 粗场景（户外/人像/夜景/室内/日常） |
| **票据识别** | **YOLOv8s ONNX 检框**（火车票/机票）→ 裁剪 → 复用同一 RapidOCR → **纯正则解析** | YOLO 阈值 0.25 + NMS(0.25/0.45)；车次前缀 G/D/C/K/T/Z；**3351 个车站白名单**；站名靠几何排版（y 聚类阈值 45px）+ 位置惩罚 |
| **视觉描述/评分** | **LLM 直连**（不是微服务）：`ChatOpenAI` + VLM | 输出 JSON（description/tags/memory_score/beauty_score/reason/narrative）+ JSON 修复重试 |
| **本地 LLM** | **llama.cpp 子进程**（GGUF），OpenAI 兼容代理 `/v1/*` | 默认 **MiniCPM-V 4.6 Q4**（多模态）；`--image-min-tokens 1024`、`-c 8192`、`-n 1024`；空闲 300s 退出 |

> ⚠️ 注意：`app/data/categories.json`（37 类 CLIP 零样本 prompt 方案）在当前代码里**无人引用**，是遗留资产——
> **没有** SigLIP、**没有**开放词汇、**没有**拒识机制。低置信度一律丢进 `others`。

### 2.3 组织与发现

- **智能相册**：自然语言描述 → CLIP 文本嵌入存 `albums.query_embedding(512)` → 余弦匹配，阈值可调 **0.15~0.5（默认 0.25）**
- **条件相册**：文件夹树 + 时间范围 + 地点 + 人物（四维结构化条件）
- **普通相册**：共享用户（`album_shared_users`）+ 封面 + 计数
- **标签**：手动 + AI 自动（`photo_tags` / `photo_tag_relations` 带 confidence）
- **智能分类标签页** + **月迹**（被识别为「月亮」的照片按 8 种月相浏览）
- **位置相册 6 视图**：列表 / 地图 / 时间轴 / 轨迹 / 拼图 / 统计
- **3D 足迹地图**（见第 3.1 节详述）
- **时光对照**：同一地点跨年份对照，排序 = 视觉相似度 70% + GPS 15% + 时间跨度 15%
- **景区**：5A 级景区库（随包 CSV）；射线法多边形 + haversine 兜底
- **那年今日** / **一日一帧** / **朋友圈文案**（AI 生成 + 九宫格精选）
- **记忆系统**：自动发现候选事件（线索并集召回 + 证据 + 置信度）→ 用户确认 → 正式记忆；`memories` + `memory_photos/people/places/tickets/evidence/relations` 六张子表
- **人生章节**：章节书架 + 日记本（翻书交互）+ AI 日文案
- **关系探索图谱**：人物/地点/记忆/照片的图谱漫游（放射布局避让）
- **搜索**：联想（人物/地点/OCR/相册/文件名/文件夹/标签/景区/日期 **8 类聚合**）+ 文本搜索 + **以图搜图** + 结果无限滚动
- **猜城市小游戏**（Geoguessr 式，已定稿未实现）

### 2.4 工具箱（7 项）

重复照片(MD5)清理 / 相似照片聚类清理(阈值 0.9，≤4 张对比) / 低分模糊清理 /
图片整理(按时间·分类·人物·位置 → 移动·复制) / 批量重命名 / 文件名取时间(批量改 EXIF) /
**断舍离 swipe**（左滑删除右滑保留 + Ctrl+Z 撤销 + 离线队列后台同步）

### 2.5 报告与展示

- **年度报告**：10+ 章节（封面/照片墙/时间/高光/账户/分类/地点/最远城市/季节/消费/交通分析/行为/综合/寄语/彩蛋/结尾），滚动式「时光信笺」
- **AI 作品 artifact**：LLM 生成完整 HTML 页面 → 沙箱 CSP（`sandbox allow-scripts; default-src 'none'`）→ 分享 token（只存 SHA-256）→ 离线导出（照片内联 base64，≤30MB）
- **一日一帧影片作品**：不可变渲染产物

### 2.6 Agent / 开放平台（TrailSnap 最「超纲」的部分）

| 子系统 | 内容 |
|---|---|
| **站内 Agent** | LangGraph + 任意 OpenAI 兼容厂商 + reasoning 通道解析（含 `<think>` 标签）+ SSE 流式；**30+ 工具**；会话管理/置顶；上下文压缩为摘要（触发 30 条 / 保留最近 10 条） |
| **Agent 长期记忆** | **照片锚定抗幻觉**：白名单（本轮真实出现过的 photo_id）+ 向量检索 top-6（`MEMORY_MAX_DISTANCE=0.9`）+ 门槛 `memory_score ≥ 60` + 上限 30 条淘汰最旧 + 自愈清死引用 |
| **写操作安全** | `agent_action_plans` 表：**预演(proposed) → 用户确认 → 执行(executed) → 可撤销(undone)**；带 `preview` / `undo_data`；7 天 TTL；执行时行锁；5 种计划类型 |
| **主动消息** | 定时任务：那年今日 → LLM 问候（模板兜底）→ 3 个「点击即执行」的动作建议 → 高分照片沉淀为长期记忆 |
| **进程内 Skill** | 9 个：`album-doctor`/`album-organizer`/`memory-detective`/`nine-grid-selection`/`person-timeline`/`trailsnap-search`/`travel-album`/`travel-story` |
| **MCP Server** | Streamable HTTP；**6 个工具**；`ts_` 前缀 Agent Token；scopes：`photos:read`/`albums:read`/`people:read`/`albums:propose`；**MCP 侧只有 propose，没有 execute/undo** |
| **CLI** | `trailsnap-cli`：**20+ 子命令组**（photos/albums/people/locations/tasks/toolbox/medias/folders…）；输出格式 json/pretty/table/ndjson/csv；npm 安装器 + PyInstaller onefile 双分发 |
| **Pi 集成** | TS 扩展把远程 MCP 工具桥接为本地 `trailsnap_*` 工具（给不内置 MCP 客户端的 Agent 用） |
| **需求交付平台** | **同仓库独立部署**的子系统：FastAPI + Vue，**50+ 个 MCP 工具**，串起「用户反馈 → AI 分诊 → 规格+AC → 管理员批准 → 编码 Agent → 独立测试 Agent → 合并门禁 → 发布」 |

### 2.7 工程架构亮点（这些才是真正值得抄的）

| 亮点 | 具体做法 |
|---|---|
| **任务系统** | `TaskManager`(API 进程生产) + `TaskWorker`(**独立子进程**消费)，**DB 表当持久化队列**；CPU/IO/AI **三条优先队列**；20 种任务类型 + `DEFAULT_PRIORITIES`；`INTERACTIVE_TASK_PRIORITY=10000` 可越过分类暂停 |
| **自适应并发** | `AdaptiveResourceLimiter`（**AIMD** 加性增乘性减）+ psutil 采 CPU/内存 EMA(0.6/0.4) 高水位降并发 + 结果持久化到 `system_state` |
| **资源级限流** | 每类资源独立信号量（classification/ocr/face/face_cluster/embedding/tickets/visual_llm/local_llm/cpu/io） |
| **AI 阶段互斥** | `ai_phase_type` 保证同一时刻只跑一种 AI 类型（避免模型反复加载）；高优先级到达时**让出**（`_withdraw_ai_prefetch`） |
| **磁盘配额** | `DiskBudget` 按卷限流 + `budgeted_open` + `media_io` 装饰器 |
| **重试** | 指数退避 `min(120, 5*3^(n-1)+jitter)`；默认 3 次；模型下载中延迟 60s 且**不消耗次数** |
| **进度上报** | worker 经 `multiprocessing.Queue` → SSE；`/tasks/recent` 供断线补偿；节流存库（>5s 一次） |
| **暂停/恢复/取消** | `paused_categories` + 快速模式（限定任务类型集合）+ `request_drain()` 停止预取 + `await_owned` 等底层真正结束 |
| **空闲回收** | 池空闲 5min 释放；worker 空闲 5min 退出；**AI 微服务进程空闲 600s 自杀**（非 Win）+ **单模型空闲 300s 释放** + **单 family 驻留**（切 family 即释放其余）+ LLM 子进程空闲 300s 退出 |
| **准入控制** | `AdmissionGate`：信号量 + 队列上限 2 + 获取超时 10s → **HTTP 429 + Retry-After: 5** |
| **模型目录化** | `model_catalog.json` 声明 13 个模型（face 4 档 / OCR 3 档 / CLIP 2 档 / 分类 2 档 / LLM 2 档）；ModelScope 后台下载；**运行时可切换、可删除、可自动下载**；删被选中模型会先切到替代品 |
| **ONNX EP 探测** | 统一 `get_onnx_providers()`：CUDA > OpenVINO > CoreML > CPU；CoreML 会话创建失败进**黑名单**降级 |
| **双数据库** | PG + SQLite 通过 `db/types.py` 抽象（`GUID`/`DatabaseVector`）；**双份 alembic 迁移**（`alembic/` 46 版 + `alembic_sqlite/` 20 版）；SQLite 分支用 numpy 全量余弦 |
| **前端性能** | Web Worker（弧线坐标/省界简化、分块 SHA-256）；Cesium **显式导出裁剪** + 按需渲染；三级图片 URL（thumbnail/preview/url）+ 相邻图 n±1 挂载 n±2 预解码 |

---

## 3. 你点名的五项：逐项硬碰硬

### 3.1 足迹地图 —— **表现力他强，口径你强**

| 维度 | TrailSnap | WaterNasOS |
|---|---|---|
| 引擎 | **CesiumJS**（同一 Viewer 复用 2D/3D 模式） | 地图组件（自研聚合） |
| 视角 | **2D 俯视 / 3D 聚焦中国 / 地球**（可拖拽旋转） | 平面 + 缩放换挡 |
| 底图 | 天地图卫星影像（**服务端 map-proxy 注入 key**）；失败显示内置 Natural Earth | 天地图/瓦片源 |
| 地形 | **ArcGIS WorldElevation3D** 三维地形（按需开启） | ❌ |
| 边界 | 随包 GeoJSON：省 1.7MB / 市 4.3MB / **县 10MB**；支持按 `gb` 码下钻 | GeoJSON 省份边界 |
| 连线 | **旅行连线**：按拍摄时间推断城市访问顺序；同次访问用**稳定坐标**做进出共同锚点；**相邻 >7 天切分旅程** | 轨迹视图（GPS 轨迹，另一条线） |
| 回放 | **旅程回放**（按拍摄时间依次突出连线）+ 暂停/进度拖动/1×2×4×；**年份巡游** | ❌ |
| 图层 | 城市照片卡 / 旅行连线 / 照片热力(**径向渐变贴图**) / 省份边界 / 三维地形 | 照片 marker |
| 聚合口径 | 城市 key = `国家\0省\0市`（无城市用 **round(lat,1),round(lng,1) ≈10km 网格**）；城市坐标取**真实照片坐标**；默认最多 **800 城市 + 800 连线**，按视野补充加载 | geohash 网格 + **解析式选精度** + `count` 角标；**落点=簇种子**（最密那格）；点开范围 = marker 的**格集合**（`whereIn` 精确匹配）⇒ **角标 == 列表张数** |
| 离线 | localStorage 快照（最多 5 份 / 1 天，按 server+user+year 命名空间） | ❌ |
| 配套 | 足迹趋势图、热门打卡地排行（前 5 / 更多 100）、城市搜索、年份轴+统计柱状图、时光对照 | 列表/地图/时间轴/轨迹/拼图 6 视图、存储统计 |
| Worker | 弧线坐标（大圆插值 + 跨日界线 + 对跖点处理）+ 省界简化 | ❌ |

**判断**
- **他的强在「叙事与沉浸」**：真 3D 地球、地形、回放动画、连线讲故事、离线快照、时光对照——用户打开会「哇」。
- **你的强在「数学正确」**：`1.15×marker 直径` 阈值 + 落点=簇种子 ⇒ 聚合后不压盖、平移不重算、各端一致；点开范围 == 角标张数。**他的「城市坐标取真实照片坐标」这条你已经做到了，而且更严格**（他仍按 `photo_count desc` 截断，没有你那种「角标==列表」的强一致）。
- ⚠️ 一个细节差异：**他的城市位置是「最密那格」之外的另一种做法**（取该城市封面/代表照片的真实坐标），会出现「同一城市多个点」的分裂；**你的做法更收敛**。这项你不用改。

**可以抄的（按性价比）**
1. **旅程回放动画**（你已有轨迹视图，加播放器 + 进度条 + 速度档，纯前端）
2. **七天断线分段**（`VISIT_GAP_SECONDS = 7*24*3600`；同地点连续拍摄间隔 >7 天开启新访问片段）—— 你的连线逻辑可加这一条
3. **旅行连线**（相邻访问连线，条件：key 不同 + 间隔 ≤7 天 + 时间递增；**抽样时绝不把被跳过的片段拼成新线**）
4. **离线快照**（localStorage，命名空间 + 5 份上限 + 1 天 TTL + 断网时标注快照时间）
5. **时光对照**（同地点跨年对照；他的排序权重可直接借用）
6. **年份巡游 / 城市排行面板 / 按视野增量加载**
7. **三维地形**（如果你愿意背上 Cesium 的包体；⚠️ **不要**引入 Cesium ion 账号依赖——他是把 Workers/Widgets/纹理随包分发的）

### 3.2 人物识别 —— **模型你赢，产品他全**

| 维度 | TrailSnap | WaterNasOS |
|---|---|---|
| 模型 | InsightFace **buffalo_l**（350MB / 内存 1200MB）；推理 ~390ms/张 | **EdgeFace XS_0.6**（**6.94MB**，CPU 2.8ms，GPU(DML) 更快） |
| 许可 | ⛔ **InsightFace 权重非商用研究许可** | ✅ **BSD-3，可商用** |
| 精度 | LFW 99.83% / IJB-C 97.25% | LFW 99.73%，**同人相似度 min 0.9520 反超 ArcFace 0.9281** |
| 检测阈值 | InsightFace 默认 0.5（未覆盖） | `DET_SCORE_THRESH = 0.8`（**更严**） |
| 质量分 | 只用 `det_score` | `qualityScore = 检测置信度 × 100`（等价） |
| 聚类 | 服务端 sklearn **DBSCAN cosine eps=0.4 min_samples=5** + 簇合并（中心距 <0.48） | 并查集 + 阈值 **0.45**（ARI 对比验证过，与 ArcFace 分组一致）+ **防误合参数** |
| 索引 | **`faces.face_feature` HNSW 索引**（`vector_cosine_ops`） | 24 维符号签名分桶 + 512 维全量 |
| 并发 | 微服务内线程池（GPU 4 / CPU 8），但模型族互斥 ⇒ 同一时刻只有人脸在跑 | **worker_threads 多线程，默认 3**（踩过「串行起 + 第 2 个 CPU 会话 rc=139」的坑） |
| 人物页 | 个人/合影双视图、合并（批量选多人）、**封面**、隐藏/显示、删除、**重扫（preview → apply 两阶段）**、编辑人物信息 | 人脸网格、多选合并、时间轴浮层、质量分 |
| 合影组合相册 | ✅ **N 人同框**组合相册（3:4 封面，标题为成员名顿号分隔） | ❌ |
| 人物时间线 | ✅ + **可隐藏某段年份** | ✅ 时间轴浮层 |
| 人物关系图 | ✅ **共同出现 / 共同记忆 / 证据链**（`relations` 模块） | ❌ |
| 人脸框高亮 | ✅ 灯箱内按 `photo_id` 高亮人脸框 + 人名 + 置信度 | ⚠️ 需确认 |

**判断：模型和数据层你明显更强（体积 1/50、速度 16×、许可可商用），产品层他更完整。**

**可以抄的（都是纯 SQL + 前端，成本极低）**
1. **合影组合相册**：按「同框人脸组合」分组 → 你的 `photo_face2filehash` 已有关系，加一个 `GROUP BY 人脸组合` 即可
2. **人物关系图**：共同出现次数 + 共同记忆做边，放射布局图谱（你已经有图谱类 UI）
3. **重扫描两阶段**：`rescan/preview`（只算差异，返回将新增/将移除）→ `rescan/apply`。比直接应用安全得多
4. **隐藏人物时间线的某段年份**（`person_timeline_hides` 表）
5. **标记已命名 / 未命名 / 隐藏**三类筛选（他持久化到 localStorage）
6. **人脸框在灯箱里的高亮 + 人名标签**（体验弹点很高）

**不要抄的**
- ⛔ **绝对不要**把他们那种「在服务进程里跑 sklearn DBSCAN」搬过来——你现在是 worker_thread 跑，且已知「worker_thread 里第 2 个 CPU ONNX 会话段错误 rc=139」。抄算法可以，抄「在进程里跑 ML」不行。
- ⛔ 不要换 InsightFace（许可 + 体积 + 速度全面退步）。

### 3.3 智能分类（场景识别）—— **你甩他一条街**

| | TrailSnap | WaterNasOS |
|---|---|---|
| 方案 | **自训闭集 ONNX** 两级（general + 二级） | Places365 ResNet50 (365类) + **CLIP 多路融合**（zscore 跨类归一 + 类先验校正治 hub + **开放集门控** + 多标签带权重） |
| 标签数 | **28 类**（含文档/截图/卡证/票据等非场景） | **408 类**（381 场景 + 27 属性：日落/日出/黄昏/逆光/星空/雨天/雾天/航拍/剪影/黑白…） |
| 拒识 | ❌ 低置信 → `others` | ✅ **可判性 head（512 维二分类）**：CV AUC **0.913**，10.8% 照片不给标签，误伤 4.2% 拦下 36.4% |
| 活动维度 | ❌ | ✅ **SigLIP2 base224（英文候选 Top-1 60% / Top-3 86.7%）+ DETR-R50 人物门控 q4f16**；拦下率 **96.6%** 而正样本仅掉 0.2pp；活动标签**独立列** `act_name/act_score/act_alt` |
| 评测 | 无 | ✅ 150 张人工标注 + McNemar 精确检验 + 400 张库样本标定；**换塔已实测证伪** |
| 工程 | 阈值硬编码 0.5 / 0.95 | 标定文件 `ai_place_calib` 随标签表变化自动失效重建 |

**判断：不用犹豫，你的场景识别比他的强得多。** 他 28 类闭集、无拒识、无活动维度、无统计检验。
你花了几十个实验做出来的东西（多标签、开放集、拒识 head、人物门控、SigLIP 双通道、A/B 对照）**全面领先**。

**唯一值得借鉴的一点**：他把「**文档/聊天消息/卡证/火车票/机票/电影票/截图**」这类**非场景**也放进分类器，
并且**命中票据标签后自动触发下游票据识别任务**（`classification.py` L222-234）。
⇒ 你的场景工跑完是「终点」，他的场景工是「路由器」。**这个联动机制值得抄**：
比如「OCR 判定含车次+日期+票价」→ 自动生成一次「行程」候选，挂到足迹地图上。

### 3.4 OCR 识别 —— **能力对等，产品化他更完整**

| | TrailSnap | WaterNasOS |
|---|---|---|
| 模型 | **RapidOCR** = PP-OCRv6（det+rec small）+ PP-OCRv4 cls（180° 方向分类） | ONNX OCR（同样走 `getBestExecutionProviders()`） |
| 语言 | 纯中文（`LangDet.CH`）；**不支持多语言、不专门支持竖排** | 中文 |
| 坐标 | **原图像素多边形，不归一化**（前端直接叠加，注意 DPR） | — |
| 阈值 | 未显式设置，走 RapidOCR 默认 | — |
| 搜索集成 | ✅ `/search/text?type=ocr` + 联想直接查 `ocr_results.text` | ✅ 搜索走 `photo_info_fts WHERE ocr MATCH ?` |
| 前端 | ✅ **灯箱内 SVG polygon 叠加**（点击高亮）+ 右侧文本面板（点击复制，Clipboard → execCommand 降级） | ⚠️ 需确认是否有 polygon 可视化 |
| 任务化 | ✅ 独立 OCR 任务 + 增量重扫（`processed_tasks` 标记）+ 可单张重识别 | ✅ `gen_ocr` 标记 + worker |
| GPU/后端 | ONNX Runtime（CUDA / 自动切 OpenVINO，`openvino_infer_lock` 互斥） | ✅ DML（实测 `Selected providers: dml, cpu`） |

**判断：底层能力对等**（都是 PP-OCR 系 + ONNX + GPU），**他的产品化更细**（多边形可视化 + 单张重识别菜单 + 任务化）。

**可以抄的**
1. **前端 OCR 多边形可视化**（如果还没有）——你已经有 OCR 数据，灯箱叠 SVG 是纯前端活
2. **单张照片的「重新识别」子菜单**（人脸/OCR/分类/描述分项重跑）
3. ⚠️ **值得核一下版本**：他用 **PP-OCRv6 small**，比你现在的模型可能更新一代（你文档里没记具体版本）。如果要升级，注意他踩的两个坑：OpenVINO 的 `InferRequest.infer()` **非线程安全**（必须全局锁，否则 "Infer Request is busy"）；坐标**不归一化**。
4. ⭐ **真正的增量价值在「票据 OCR」**，不是纯文字 OCR —— 见 3.6 节。

### 3.5 智能搜索 —— **你这条路更深，但他有一条路你该验一下**

| | TrailSnap | WaterNasOS |
|---|---|---|
| 中文处理 | **多语言 CLIP 文本塔**（`clip-ViT-B-32-multilingual-v1` 蒸馏）⇒ **中文直接编码到图像空间** | ⛔ CLIP 词表 49408 token 里 **0 个 CJK** ⇒ **中文必须先翻英文** |
| 查询链路 | 一句话 → 文本嵌入 → `cosine_distance` | 中文 → **512 短语最大匹配切分** → **有序绑定**（猫→宠物特写 / 雪景→雪原）→ 无绑定才退回嵌入最近邻 → **迟到融合**（多短语命中的标签 +35%） |
| 混合检索 | ❌ **二选一**：带 `type` 走 ilike 关键词，不带 `type` 走纯向量（无 RRF / 无加权融合） | 关键词 + 场景标签 + OCR（三路 OR 并集，同一 SQL） |
| 阈值 | 默认 **0.2**（≈距离 ≤0.8）；以图搜图 0.0 | 你实测过**绝对阈值不可靠**，改用短语绑定 + 融合（这个判断是对的） |
| 以图搜图 | ✅ `/search/image`（调 `/classification/classify` 取 embedding） | ⚠️ 你有 CLIP 图像嵌入（场景识别在用），但**没做以图搜图入口** |
| 联想 | ✅ **8 类聚合**（人物/地点/OCR/相册/文件名/文件夹/标签/景区/日期），各取前若干 ≤20 条 | 搜索历史 |
| 多维融合 | ✅ 在 **Agent/MCP 侧**（时间+地点+OCR+媒体类型+朝向+是否有人+质量分+记忆分，向量与结构条件可叠加） | 场景条件 + 人脸条件（智能相册） |
| 覆盖范围 | 全局（时间轴/相册/搜索页都走同一套） | ⚠️ **只接了 AI 场景页，时间轴搜索没接**（记在 memory 里） |

**判断**
- **纯「中文语义搜索」的深度你更强**：你实测出了「CLIP 0 个 CJK」「组合语义会压平分数所以必须迟到融合」「绝对阈值不可靠」这些硬结论，他一条都没有（他直接依赖多语言蒸馏塔，遇到问题也没暴露）。
- ⭐ **但他有一条路你必须验**：`SiYuan044/clip-ViT-B-32-multilingual-v1-onnx` 这个**多语言蒸馏文本塔**。
  如果它的中文编码真的可用（哪怕弱于英文），你就能**省掉整个 512 短语词表 + 有序绑定 + 翻译层**，
  运行时只多一个文本塔（61.5MB，int8 后更小）。
  ⚠️ **这必须做 A/B 实测**（用你现有的 150 张评测集 + 真实查询），**不要凭直觉相信**——
  你自己的 2.4 节已经证明「中文直接编码退化」，但那是**原生 CLIP**，蒸馏版是另一回事。
  **建议动作**：拿 20~30 条真实中文查询，对比「现有链路」vs「多语言塔直编」的 Top-5 命中率。如果直编能到 80%+，你就砍掉了整套词表维护成本；如果不行，说明你的词表路线是正确的护城河。
- **他的产品化更完整**：8 类联想、以图搜图入口、8 类类型图标 + 日期自然语言解析。
- ⭐ **你的最大漏点**：**时间轴搜索没接语义** —— 你 408 类场景 + 活动维度 + 语义查询的能力，用户在主界面搜不到。**这是最高性价比的补漏**。

### 3.6 他没点名但你更该看的：**票据/行程识别（他的独有护城河）**

你没有这条线，他有完整闭环：

```
照片 → YOLOv8s 检框（火车票/机票，阈值 0.25+NMS）
     → 裁剪 → RapidOCR
     → 正则 + 几何排版解析（车次/站名/日期/座位/票价/姓名）
     → 查「铁路基础库」（3351 车站 / 车次 / 运行计划 / 时刻表）
     → 算出里程 / 运行时长 / 经停站
     → 存 train_tickets / flight_tickets（挂 photo_id）
     → 票夹（票 ↔ 相册 ↔ 记忆 多态关联）+ 交通统计 + 年度报告「消费/交通」章节
```

**为什么这对你特别有价值**：你的 NAS 本来就在管「备份 / 同步 / 出行照片」。
「识别车票 → 自动组织一次行程 → 在足迹地图上标注」是**你现有能力（足迹 + OCR + 相册）的自然延伸**，
而且市场上一片空白。

⚠️ 但**不要照抄全部**（铁路基础数据库 + YOLO 检框工程量很大）。
**建议的降级方案（成本低一个数量级）**：
1. 复用你已有的 OCR 结果，**用规则判定「这是不是一张票据」**（关键词：车次/票价/元/站/检票/席别 + 日期形状）
2. 命中的照片 → 自动聚类成「行程候选」（按日期 + 地理跳跃）
3. 在**足迹地图**上把行程标出来（你已有 map 模块）
4. 站名/车次不做完整铁路库，只存原始文本 + 一个轻量站名表

---

## 4. 总览对比表

| 域 | TrailSnap | WaterNasOS | 谁强 |
|---|---|---|---|
| 端 | Web/PWA/Capacitor(Android+iOS)/Tauri | Flutter(桌面/web/Android) + **鸿蒙** + **TV(Android/Apple)** + 摄影/音乐/同步派生端 | **你** |
| 存储/文件 | 相册为主 | 文件/影视/音乐/笔记/终端/离线下载/挂载/加密空间 | **你** |
| 多用户权限 | users + owner_id 隔离 + 共享相册 | **admin/super_admin/普通 三级 + 可见性零角色例外** | **你** |
| i18n | ❌ 硬编码中文 | ✅ 13 文件多语言 | **你** |
| 影视/音乐 | ❌ | ✅ 转码/HDR/杜比徽章/画质偏好 | **你** |
| 同步 | 手机相册备份 | **三向比对目录同步 + 相册备份 + 文件备份** | **你** |
| GPU 加速 | ONNX CUDA/OpenVINO/CoreML | ONNX **DirectML** | 平 |
| 人脸模型 | buffalo_l 350MB 非商用 | **EdgeFace 6.9MB BSD-3** | **你** |
| 场景识别 | 28 类闭集 | **408 类 + 拒识 head + 活动维度** | **你** |
| 中文语义搜索 | 多语言塔直编 | **短语词表 + 有序绑定 + 迟到融合** | **你**（但他那条路要验） |
| 足迹地图表现力 | **3D 地球 + 地形 + 回放** | 聚合口径严谨 + 6 视图 | 他叙事 / 你正确 |
| OCR 产品化 | **多边形可视化 + 单张重识别** | 搜索已接入 | 他略强 |
| 任务系统 | **DB 队列 + 三优先级 + AIMD + 限流 + SSE + 暂停** | worker 按需启动 + 重启兜底 | **他明显强** |
| 写操作可撤销 | ✅ agent_action_plans | ❌ | **他** |
| 票据/行程 | ✅ 完整闭环 | ❌ | **他** |
| 记忆/章节/报告 | ✅ 记忆 + 章节 + 年度报告 + 一日一帧 + 关系图 | 只有 the_day | **他** |
| 相似照片/去重工具 | ✅ 7 项工具箱 | 仅 similar worker | **他** |
| Agent/MCP/CLI | ✅ 全套 | ❌ | **他，碾压** |

---

## 5. 值得整合的清单（按优先级）

> ⚠️ **本节只是「抄什么」的优先级清单。每项的落点文件、改动清单、验收标准与依赖关系，见配套施工图：
> [docs/WaterNasOS-整合实施路线图.md](WaterNasOS-整合实施路线图.md)。**
> 该文档同时对本文的 7 处结论做了实读勘误（最重要的是：时间轴**服务端其实已接语义**、CLIP **图像嵌入并未落库**、
> **不存在**可复用的图谱组件），开工前请先读那一份。

### P0 — 低成本高收益，立刻可做

| # | 项 | 成本 | 为什么 |
|---|---|---|---|
| 1 | ⭐ **时间轴搜索接入语义** | 低 | 你 408 类 + 活动维度 + 语义查询的能力，主界面搜不到。**这是你最该补的漏** |
| 2 | **合影组合相册** | 极低（纯 SQL + 一个页面） | 你已有同框数据，他这块体验很好 |
| 3 | **以图搜图入口** | 低 | 你已有 CLIP 图像嵌入（场景识别在用），调一下就能用 |
| 4 | **搜索联想 8 类聚合** | 低 | 你已有 OCR/标签/场景/人物/地名，聚合起来体验提升明显 |
| 5 | **人物关系图**（共同出现 + 证据） | 低（纯 SQL + 图谱 UI） | 情感价值高，你有图谱组件基础 |
| 6 | **批量操作预演 + 撤销（undo_data）** | 中 | 你现在批量删除/移动是「直接执行」。这个模式对 NAS 尤其重要 |
| 7 | **人脸重扫两阶段（preview → apply）** | 低 | 比直接应用安全得多 |
| 8 | **单张照片「重新识别」分项菜单** | 低 | 人脸/OCR/分类/描述可单独重跑 |

### P1 — 需要设计，中等成本

| # | 项 | 成本 | 说明 |
|---|---|---|---|
| 9 | ⭐ **任务系统工程化**（进度面板 + 暂停/恢复 + 优先级 + 限流） | 中高 | 你现在是「按需启动 + 空闲退出」，用户**看不到 AI 索引跑到哪了**。这是 NAS 场景收益最大的一项 |
| 10 | **足迹地图「叙事层」**：旅程回放 + 七天断线 + 旅行连线 + 年份巡游 | 中 | 你的聚合口径已经对，缺的是这一层 |
| 11 | **时光对照**（同地点跨年） | 中 | 他权重可直接借：视觉相似度 70% + GPS 15% + 时间跨度 15% |
| 12 | **离线快照**（localStorage，命名空间 + 5 份 + 1 天 TTL） | 低 | 断网体验，成本极低 |
| 13 | ⭐ **票据/行程轻量版**（复用 OCR + 规则判定 + 行程聚类 + 地图标注） | 中 | 见 3.6 降级方案 |
| 14 | **记忆发现**（时间+地点+人物聚合成事件候选 → 用户确认） | 中 | 你已有 the_day，扩展一步就是「记忆」 |
| 15 | **模型目录化 + 运行时切换/下载/删除** | 中 | 你的 `remoteAssetsManager`（faces/ppocr3/places365 三个 bundleId）已有雏形，扩展成「可选模型」 |
| 16 | **相似/重复照片工具箱**（MD5 去重 + 聚类 + 对比 + 低分清理） | 中 | 你有 similar worker，缺产品化 |
| 17 | **那年今日增强 → 一日一帧 / 朋友圈文案** | 中 | 你已有 the_day 模块 |

### P2 — 架构级，长期战略

| # | 项 | 成本 | 说明 |
|---|---|---|---|
| 18 | ⭐⭐ **MCP Server（只读，6 个工具）** | **低** | 把 WaterNasOS 的照片检索暴露给 Claude Code / OpenClaw / Pi。**投入小、声量大**，是 Agent 时代的入口。MCP 的「只读 + scope」设计可以直接照抄 |
| 19 | **CLI** | 中 | Agent 友好的无头接口；他的子命令划分可以直接参照 |
| 20 | **Agent 对话**（分三阶段：只读工具 → 写操作计划 → Skill 编排） | 高 | 最大工程量 |
| 21 | **年度报告** | 中 | 纯数据聚合 + 前端叙事，情感/传播价值高 |
| 22 | **需求交付平台**（Agent 编码闭环） | 高 | 独开一个仓库做，别塞进主仓 |

---

## 6. 明确不要抄的

| 项 | 原因 |
|---|---|
| ⛔ **双份 alembic 迁移** | 你无迁移机制（`addColumn`/`ensureColumns`），引入是纯负担 |
| ⛔ **PostgreSQL / pgvector 依赖** | 你是单机 NAS，SQLite 是对的。**HNSW 索引只能在 PG 用** ⇒ 你想加速人脸检索要考虑 `sqlite-vec` 而不是抄 pgvector |
| ⛔ **sklearn DBSCAN 跑在服务进程里** | 你的 worker_thread 已踩过「第 2 个 CPU ONNX 会话 rc=139」。抄算法可以，抄进程模型不行 |
| ⛔ **InsightFace buffalo_l** | 350MB + 非商用许可 + 慢，全面退步 |
| ⛔ **28 类闭集分类器** | 远弱于你的 408 类 + 拒识 + 活动维度 |
| ⛔ **i18n 硬编码** | 你做得比他好 |
| ⛔ **多层嵌套 Scaffold 的嵌入式页面写法** | 你已定好 `embedded: true` 规范 |
| ⚠️ **Cesium 三维地形** | 好，但**必须把 Workers/Widgets/纹理随包分发**，不能依赖 ion 账号或 CDN（他是这么做的）。包体和复杂度要算清楚再上 |
| ⚠️ **他们的 Claude/AI 生成代码占比（自述 90%+）** | 代码注释与结构密度高但一致性差（比如「分类模型是自训闭集」和遗留的 `categories.json` CLIP 零样本方案并存、`yolo_ocr/` 目录已消失但注释还在）。**参考思路，不要参考工程质量** |

---

## 7. 三条战略判断

### 判断一：不要 1:1 整合，把他当「照片域产品化参照系」
他是「AI 相册 App」，你是「NAS OS」。**你的底层 AI 全面强于他**（人脸模型、场景识别、中文语义搜索），
你缺的是**产品化**：任务可见性、进度、撤销、叙事层、开放平台。

### 判断二：真正有「整体整合价值」的只有三块
1. ⭐⭐ **Agent / MCP 开放平台** —— 投入最小（MCP 只读 6 工具）、战略价值最大（Agent 时代入口）
2. ⭐ **票据 / 行程线** —— 他唯一的护城河，且和你的备份/出行场景天然契合（建议降级实现）
3. ⭐ **记忆 / 报告叙事层** —— 你已有 the_day，扩展一步就到位，情感价值高

### 判断三：有两个「验证动作」你应该现在就做
1. **多语言 CLIP 文本塔 A/B**（`clip-ViT-B-32-multilingual-v1`）
   —— 如果中文直编可用，你省掉整套 512 短语词表；如果不可用，说明你的词表路线是正确护城河。
   **用 20~30 条真实中文查询 + 你的 150 张评测集，实测对比 Top-5 命中率。别信直觉。**
2. **PP-OCRv6 vs 你现在用的版本**
   —— 他用 PP-OCRv6 small，可能比你更新的代。核版本 → 若更新，用你的真实库（发票/菜单/路牌）跑 A/B，
   注意他踩的坑：OpenVINO `InferRequest.infer()` 非线程安全（必须全局锁）、OCR 坐标不归一化。

---

## 附：关键文件速查（TrailSnap）

| 域 | 路径 |
|---|---|
| 足迹后端 | `package/server/app/crud/footprint.py`（`VISIT_GAP_SECONDS`、`_visits`、`_sample_routes`、`_place_expressions`） |
| 足迹前端 | `package/website/src/views/album/location/FootprintPage.vue` + `components/footprint/FootprintGlobe.vue` + `workers/footprintScene.worker.ts` |
| 搜索 | `package/server/app/api/search.py` + `app/crud/crud_vector.py` |
| 人脸聚类 | `package/server/app/service/face_cluster.py`（`SIMILARITY_THRESHOLD`/`DISTANCE_THRESHOLD`/`assign_face_to_identity`） |
| 任务系统 | `app/service/task_manager.py` + `task_worker.py` + `task_strategy.py` + `tasks/*.py` + `adaptive_limiter.py` + `disk_budget.py` |
| 写操作计划 | `app/service/agent/actions.py` + `app/db/models/agent_action.py` |
| MCP | `app/service/mcp_server.py` + `doc/mcp_server.md` |
| AI 模型清单 | `package/ai/app/model_catalog.json` |
| AI 服务 | `package/ai/app/services/{ocr,face,image_classification,embedding,ticket}_service.py` + `unified_model_manager.py` + `onnx_providers.py` + `core/{model_phase,admission}.py` |
| 配置阈值 | `package/server/app/core/config_manager.py` 的 `AISettings` |
| 票据 | `package/ai/app/services/{ticket_service,ticket_parser,fly_ticket_parser}.py` + `app/service/tasks/tickets.py` + `railway/` |
| 前端核心 | `src/components/{UnifiedPhotoPage,PhotoGallery,PhotoLightbox}.vue` + `composables/useVirtualLayout.ts` |
