# 场景识别 v2 —— 多模型融合 + 开放集 + 类先验校正

日期：2026-10-14
状态：**服务端已改完并通过端到端验证；待整包重打（新增模型目录与 .js，热更进不去 asar）**
来源：铁柱提供的 DeepSeek 方案（[share/xvx3xijoyetvf1fkmv](https://chat.deepseek.com/share/xvx3xijoyetvf1fkmv)）+ 本工程实测改造

------------

## 一、先做诊断，再定方案（这次没直接照搬）

DeepSeek 给的是一套 5 模块级联（YOLO12n 物体检测 → DINOv2 特征 → MLP 融合头 →
置信度门控 → SigLIP2 多标签）。**照搬前我先用真实照片验了现有实现**，结论和
「模型不行」这个直觉不一样：

用 8 张内容已知的图跑现有 `resnet50_places365.onnx`（连同它的真实预处理与标签表）：

| 测试图 | 现有模型 top-1 | 判定 |
|---|---|---|
| 雪山 | `mountain snowy` 0.55 | ✅ |
| 办公室 | `home office` 0.51 → `office` 0.26 | ✅ |
| 教堂内部 | `church/indoor` 0.73 | ✅ |
| 泳池 | `underwater/ocean deep` 0.61 | ❌ 室内判成深海 |
| 海滩 | `conference center` 0.35 | ❌ 户外判成室内会议 |
| 病房 | `artists loft` 0.06 | ❌ 全平，等于没判断 |

⇒ **模型文件、预处理、365 类标签映射三件套都是对的**（否则不可能有三张判对）。
不存在标签错位那类系统性 bug。真身是两条：

1. **决策层是坏的**：闭集 365 类硬取 top-1，固定 `0.4` 阈值拍脑袋，没有「未知」出口。
   实测 top-1 概率普遍只有 `0.05~0.7`，室内场景大量落在 `0.06` 这种「完全没判断力」的区间。
2. **主干是 2017 年的 ResNet50-Places365**，对室内细粒度天然弱。

再看真实库的标签分布（`photo_places` 按 photo_count）：

```
病房 1224 | 荒漠 1008 | 美容院 836 | 育婴室 835 | 海滩 815
苔原 583 | 沙坑 526 | 更衣室 512 | 水族馆 477 | 幼儿园教室 431
```

个人相册里「病房 1224 张」「苔原 583 张」—— 这是典型的 **hub label 分布**：
少数「万金油」标签吞掉一切。随机抽 400 张照片复现，苔原一家占 6.8%。

**肉眼核验**（把模型判成 hub 标签的照片调出来看）：
- `P1120859.JPG`（两人在餐桌前）→ 模型判「美容院」❌
- `IMG_1253.JPG`（高原草甸 + 牦牛）→ 判「苔原」，勉强沾边

⇒ 结论：**根本问题是决策层 + 闭集，不是主干坏了。** 换掉主干之前，先把决策层修好。

------------

## 二、对 DeepSeek 方案的取舍（砍掉一半）

| DeepSeek 模块 | 我们的处置 | 理由 |
|---|---|---|
| A. YOLO12n 物体检测 | **不做** | 它的特征要喂给 C 模块才有意义，而 C 需要人工标注数据训练。现在库里一份人工标注都没有，做了也是空转 |
| C. MLP 融合分类头 | **不做** | 同上；离线 PyTorch 训练链与我们「零下载工具池」冲突，且收益依赖标注量 |
| B. 全局语义特征 | **换成 CLIP** | DINOv2 是纯视觉、无文本塔，做不了零样本；CLIP 双塔能直接把「病房/卧室」写成提示词比对，还自带开放词表 |
| D. 置信度门控 + 开放集 | **做，并加强** | 这是唯一零成本、直接治病的模块。在它基础上加了**类先验校正** |
| E. SigLIP2 多标签 | **用 CLIP 实现** | 同样零样本，且分词器（`vocab.json` + `merges.txt`）是 byte-level BPE，**纯 Node 就能复刻**，不用引入 Python/transformers |

关于模型获取：`huggingface.co` 被墙，铁柱给的代理 `127.0.0.1:21578` 可用
（出口 114.37.202.52），最终选用 `Xenova/clip-vit-base-patch32`。

**体积账**：CLIP 视觉塔 85MB 进包；文本塔与分词器**只在构建期用一次**，
产物 `text_embeds.bin` 只有 0.74MB。

------------

## 三、A/B 实测：CLIP 到底赢在哪

统一的 365 标签空间对撞（同一批对照图）：

| 测试图 | ResNet50-Places365 | CLIP 零样本 |
|---|---|---|
| 泳池 | `深海` 0.61 ❌ | **`室内游泳池` 0.44** ✅ |
| 病房 | `艺术工作室` 0.06 ❌ | **`病房` 0.28 / `手术室` 0.25** ✅ |
| 厨房（油画） | `乐池` ❌ | **`餐厅厨房` / `厨房` 进 top3** ✅ |
| 会堂 | `church/indoor` 0.73 ✅ | **`synagogue/outdoor` 0.248 / `church/indoor` 0.242** ✅ 更细 |
| 雪山 | `mountain snowy` 0.55 ✅ | `mountain snowy` / `mountain` ✅ |

**室内细粒度上 CLIP 是压倒性的**；户外大场景两者相当。

但 CLIP 也有自己的毛病，必须说清楚：
- 余弦相似度被压得极扁（0.14~0.32），top1 与 top2 中位差只有 **0.0049**，光靠 argmax 极脆；
- 自己有 hub：「亚洲寺庙」对**全部 400 张**的平均相似度都是 0.2299（全表最高），拿下 5% 的 top-1。

------------

## 四、三条对策（这才是"根本解决"的部分）

### A. 类先验校正（治 hub）

400 张样张 × 381 标签 × 365 类的分数全量落盘后离线比对四种校正法：

| 方法 | 不同标签数 | 熵 | 覆盖 50% 需 | 最大单标签占比 |
|---|---|---|---|---|
| 原始 | 160 | 4.71 | 31 | 5.0% |
| 减类均值 | 152 | 4.65 | 29 | 5.2% |
| CSLS 2s−r | 188 | 4.96 | 43 | 4.2% |
| **z-score** | **182** | **4.96** | **44** | **3.8%** |

选 **z-score**：`(sim − mean_L) / std_L`，mean/std 由样张统计得出。
「亚洲寺庙」从 20 次跌到 7 次，苔原/荒漠/美容院从此不再统治标签表。

### B. 两路分数先归到同一量纲（这一条是踩坑踩出来的）

朴素地把两路概率线性混合**没用**：Places365 的 softmax 极尖（一个类能到 0.9），
CLIP 极扁（top1 常 0.25）。ResNet 即使只占 35% 权重也能凭「尖」把 CLIP 压掉 ——
实测融合后「苔原」**回升到 7.3%**，等于白做。

修法：两边都先在**类间**做 z-score 再 softmax，权重才真正代表话语权。
改完之后四个融合方案熵全部从 4.79 抬到 **4.93**，hub 全部消失。

### C. 开放集门控 + 多标签带权重

阈值不是拍的，按 400 张回放出来的权重分位定（p50≈0.22 / p25≈0.14 / p10≈0.10）：
- `weight ≥ 0.20` 且 `主−次 ≥ 0.015` ⇒ **confident**
- `weight ≥ 0.10` ⇒ **ambiguous**
- 否则 ⇒ **unknown**

按铁柱选定的策略「**低置信保留最可能标签但降权**」：低置信照片不丢，权重照实入库，
相册列表按 `weight_sum` 排序，它们自然沉底。

------------

## 五、实测效果（生产同一条代码路径）

| 对照图 | v2 判定 | 状态 |
|---|---|---|
| 泳池 | `室内游泳池` 0.23 | confident |
| 病房 | `手术室` 0.55 | confident |
| 教堂内部 | `教堂内部` 0.42 | confident |
| 办公室 | `办公室` / `办公隔间` / `会议室` | ambiguous |
| 雪山 | `雪山` / `山` / `冰川` | ambiguous |
| 海滩 | `流水线` 0.08 | **unknown（拒绝作答）** |

最后一行是关键：旧实现会把这张图**高置信度**判成「会议中心」，
新实现承认「我不知道」—— 这比编一个错误答案有价值。

真实库抽样 120 张：`confident 60.0% / ambiguous 32.5% / unknown 7.5%`，
最大单标签占比从 6.8% 降到 5.0%，`苔原/荒漠/美容院` 的统治消失。

> 注意：这一段是 `clipWeight=0.65` 时的状态分布。最终默认值已按第十节的
> 人工标注评测改成 **0.55**，准确率数字以第九节为准。

性能：双模型约 **190ms/张**（ResNet ~40ms + CLIP ~70ms + 解码）。
53,335 张待处理 ⇒ 单线程约 2.8 小时（可参照 faceWorker 的 worker_threads 方案提速）。

------------

## 六、涉及文件

**新增模型资产**（`electron_server/onnx_models/clip/`，`package.json` 的 `onnx_models/**/*` 已覆盖）
- `vision_model.onnx` 85MB（CLIP ViT-B/32，QDQ 量化）
- `scene_tags.txt` 381 个中文场景标签（357 个 Places365 去重 + 24 个补充）
- `text_embeds.bin` 0.74MB（预计算标签嵌入）
- `text_embeds.json` 元信息（含 sha256）

**服务端新增**
- `src/utils/clipTokenizer.js` —— CLIP byte-level BPE 分词器，纯 Node
- `src/workers/ai/places/placesClipUtil.js` —— CLIP 视觉塔 + 预处理 + 打分
- `src/workers/ai/places/placesFusion.js` —— 决策层（校正 / 融合 / 门控 / recognizeScene）

**服务端改动**
- `placesUtil.js` —— 新增 `predictPlaceFull()`（暴露 365 维 logits）
- `placesWorker.js` —— 重写：双模型 → 融合 → 入库；新增标定流程
- `tablePhotoPlaces2Filehash.js` —— 新增 `place_score` / `place_status` / `alt_labels`
- `tablePhotoPlaces.js` —— 新增 `weight_sum` / `count_high`（老数据用 `photo_count` 回填）
- `placesService.js` —— 排序改用 `weight_sum`

**构建期工具**（`tool/`，不参与打包）
- `_build_clip_tags.js` —— 从词表 + 文本塔生成 `text_embeds.bin`
- `_scene_e2e.js` —— 端到端校验（走生产同一条路径）
- `_scene_bench_library.js` / `_scene_replay.js` —— 真实库基准与决策层离线回放
- `_clip_probe.js` / `_scene_diag.js` —— 单模型对照探针

备份：`G:/work/_patch_backup/20261014_scene_v2/`

------------

## 七、部署步骤

1. **整包重打**（新增了模型目录与 3 个 `.js`，热更进不去 asar）：
   `tool/build_server_pack.bat dist_v18`（同名 dist 会先清空 ⇒ 必须换新号）
2. 重启 app。首次启动会：
   - 跑 `photo_places` / `photo_places2filehash` 的列迁移（幂等，`weight_sum` 用 `photo_count` 回填）；
   - 场景识别 worker 启动时随机抽 200 张做标定（约 40s），结果存 `tableConfig.ai_place_calib`。
3. 想全库重跑：AI 场景页右上角清空图标 / AI 设置页「重置」按钮（都会全库重跑）。

如需关闭某个新特性（排查用）：
- `PLACE_CALIB_REBUILD=0` —— 跳过标定（不做类先验校正）
- `PLACE_CALIB_SAMPLE=400` —— 加大标定样本
- `FACE_THREADS` 同类的环境变量优先于 DB 配置

------------

## 八、已知限制 / 下一步

1. **CLIP 不是银弹**。肉眼核验里它也把「澳门大三巴」判成「亚洲寺庙」、
   把高原草甸判成「狩猎小屋」。真实水平见第九节（Top-1 ≈ 44%）。
2. **客户端 UI 未做**：融合参数（阈值/权重/topK）目前只能改 DB 配置键
   （`ai_place_conf_high` / `ai_place_conf_low` / `ai_place_clip_weight` / `ai_place_topk` …），
   AI 设置页还没加控件；场景列表也还没展示 `weight_sum` / `count_high`。
3. **推理还是单线程**。190ms/张，全库 2.8 小时。可照搬 `faceWorker` 的
   worker_threads 方案（串行启动，别并发初始化 ONNX）。
4. **升级路径已留好**：`placesClipUtil` 只认「视觉塔 ONNX + text_embeds.bin」，
   换成 SigLIP2 只需重新生成嵌入，决策层一行不用改
   （但 SigLIP2 用 SentencePiece，构建期得换分词器实现）。
5. **要不要再加 DINOv2**：现在双模型已经够用；等有了人工纠正样本，
   再上「DINOv2 特征 + 原型库 kNN」才有增益。

------------

## 九、准确率评测（150 张人工标注，2026-10-14）

### 9.1 怎么做的

随机抽 150 张（与第四节那 400 张基准**不重叠**），合成 5 张 6×5 拼图，由我逐张看图打标
→ `tool/_scene_gt_150.csv`。**铁柱逐张核对后改了 12 处**（含 5 个自己手填的标签），
已合入，本节数字全部基于**他确认过的标注**。
其中 **95 张「可评分」**（真实场景属于场景类别），55 张不计分
（人像/合影/物品/夜景/不确定）。标定用另外 150 张（与评测集不相交）。
命中判定用同一张等价标签表，**v1 与 v2 同一把尺子**。

核对页：`tool/_scene_eval_out/标注核对_150.html`（离线可看，改标注→底部实时出改动清单）。

### 9.2 结果（可评分 95 张）

| 方案 | 覆盖率 | Top-1 命中 | Top-3 命中 |
|---|---|---|---|
| **v1 线上（阈值 0.4，即现状）** | 36.8% | **23/95 = 24.2%** | — |
| v1 无阈值（纯 top-1 / top-2） | 100% | 44/95 = 46.3% | 53/95 = 55.8% |
| **v2 clipWeight=0.55（生产默认）** | 73.7% | **45/95 = 47.4%** | **62/95 = 65.3%** |

### 9.3 ⭐ 统计显著性（McNemar 精确检验）

**95 个样本上 1 张 ≈ 1.05%，光看百分比容易把噪声当结论**，所以做了配对检验：

| 比较 | 净胜 / 净负 | p 值 | 结论 |
|---|---|---|---|
| v2 Top-1 vs **v1 线上（0.4 阈值）** | +34 / −12 | **0.002** | ★ 显著更好 |
| v2 Top-3 vs **v1 线上（0.4 阈值）** | +41 / −2 | **0.000** | ★ 显著更好 |
| v2 Top-1 vs v1 纯 top-1 | +18 / −17 | 1.000 | **不显著** |
| v2 Top-3 vs v1 纯 top-2 | +19 / −10 | 0.136 | **不显著** |

⇒ **诚实的结论**：v2 相对**线上现状**是统计显著更好的（Top-1 24.2% → 47.4%，
Top-3 24.2% → 65.3%）。但这个提升**主要来自决策层**（放弃 0.4 硬阈值 + 多标签 +
类先验校正），**CLIP 融合的边际贡献落在噪声量级内** —— 相对"纯 ResNet 无阈值"，
Top-1 基本不变、Top-3 +9.5pp 但 p=0.136 不显著。

### 9.4 融合权重扫描（同一批图，只改 clipWeight）

| clipWeight | 覆盖率 | Top-1 | Top-3 | 高置信桶精确率 |
|---|---|---|---|---|
| 1.00（纯 CLIP） | 98.9% | 46.3% | 60.0% | 32/59 = 54.2% |
| 0.85 | 92.6% | 46.3% | 61.1% | 28/53 = 52.8% |
| 0.70 | 82.1% | 47.4% | 62.1% | 25/47 = 53.2% |
| **0.55（采用）** | 73.7% | 47.4% | 65.3% | 20/36 = 55.6% |
| 0.40 | 63.2% | 48.4% | 67.4% | 14/25 = 56.0% |
| 0.25 | 45.3% | 53.7% | 68.4% | 14/19 = 73.7% |
| 0.10 | 22.1% | 48.4% | 68.4% | 6/8 = 75.0% |
| **0.00（纯 ResNet，有校正）** | 16.8% | **43.2%** | **56.8%** | 6/8 = 75.0% |

两条要点：
1. **纯 ResNet（0.00）最差**（Top-1 43.2% / Top-3 56.8%）⇒ CLIP 确实在贡献，不是装饰。
2. **各权重之间 McNemar 检验全部不显著**（clip0.25 相对 0.55 是 +7/−1、p=0.070，
   已是全表最小 p 值）。⇒ **不要挑"最优档"，那是噪声**；保留 0.55 是因为它在
   Top-3 与覆盖率上均衡，不是因为它是赢家。

权重可信度也在三桶里单调递减（clip0.55：confident 55.6% / ambiguous 47.1% /
unknown 36.0%），说明**权重确实携带信息，降权不是白降**。

温度同样关键：`clipTemp=3.0` 会让 confident 冲到 92%、unknown 归零 —— 把噪声当把握。

### 9.5 仍然错的例子（诚实列出）

```
#1  泳池（人工：泳池）    → v2 判「深海」    confident 0.22
#11 街道/婚车            → v2 判「停车场」  confident 0.30
#32 梯田山谷（人工：山水）→ v2 判「葡萄园」  confident 0.27
#60 卧室床（人工：卧室）  → v2 判「牢房」
#81 室内就餐（人工：餐饮店）→ v2 判「婚礼现场」confident 0.55
```

⇒ **场景识别在这个库上的真实水平：Top-1 ≈ 47%、Top-3 ≈ 65%。**
再往上要走更强的视觉-语言模型（SigLIP2 / 更大的 CLIP），或做标签工程；
**决策层已经榨干了，调参不会再涨**。

### 9.6 复现

```bash
node tool/_scene_eval_run.js   # 跑模型，落盘 v1 + 10 组融合配置的预测（约 40s）
node tool/_scene_eval.js       # 对照 tool/_scene_gt_150.csv 出指标/显著性/错例
python tool/_scene_review_page.py   # 重新生成带图片的核对页
```

改标注：编辑 `tool/_scene_gt_150.csv`（或走核对页导出），重跑 `_scene_eval.js` 即可，
**不用重跑模型**。⛔ `tool/_scene_gt_build.py` 是种子脚本，检测到标注被手工改过会拒绝覆盖。

### 9.7 顺带发现（隐私）

抽样里出现了**身份证照片、票据**等。这不是 bug（都归到「平:文档」类），
但说明这个库里混着证件类图片 —— 如果以后要做场景相册的公开分享，
这类标签的相册建议默认不进入分享范围。

------------

## 十、复现命令

```bash
# 生成标签嵌入（需要 tool/_tmp/clip/ 下有 vocab.json / merges.txt / text_model_quantized.onnx）
node tool/_build_clip_tags.js --init-tags

# 端到端校验（标定 + 对照图 + 真实库抽样）
node electron_server/../tool/_scene_e2e.js

# 真实库基准（400 张，落盘全量分数）
node tool/_scene_bench_library.js

# 决策层参数离线回放（秒级，不用解码图片）
node tool/_scene_replay.js
```

------------

## 十一、发布记录（2026-10-14）

### 11.1 服务端 + web

| 项 | 结果 |
|---|---|
| 方式 | **整包重打**（`tool/build_server_pack.bat dist_v18`） |
| 为什么不用热更 | `dev_update.py` 只重写 asar index 里**已存在**的条目；本轮新增 3 个 `.js` + `onnx_models/clip/` 目录 ⇒ 热更后会 `MODULE_NOT_FOUND` |
| 结果 | `EXITCODE=0`，约 1.8 GB |
| web | **未重编** —— `electron_server/web/main/main.dart.js` 与 `flutter_client/build/web/` 大小+mtime 完全一致（13232251 字节），本轮无 Dart 改动 |

**打包后逐字节验证**（不是"看着在"）：
1. 解 asar 的 pickle 头取 index（共 7752 条目），确认 8 个改动文件条目都存在；
2. 按 `blob 基址 = 8 + headerSize` 读出包内内容，与源码做 sha256 比对 ⇒ **8/8 一致**。

### 11.2 客户端

| 端 | 结果 | 耗时 |
|---|---|---|
| 安卓主端 | `BUILD_OK main android`，APK 87.5 MB | 151.1 s |
| 安卓相册端 | `BUILD_OK photo android`，APK 95.6 MB | 121.5 s |
| 桌面主端 | `EXITCODE=0`，Release 490 文件 | 19.1 s |

⚠️ 桌面端 `WaterNasClient.exe` 与 `data/app.so` 的 mtime 未变 —— 这是**正常**的：
本轮没有任何 Dart 改动，AOT 快照被复用（`flutter_assets` 目录被 touch 到 16:10 可证明构建确实跑了）。
**下次看到这个别误判成"没重编"。**

### 11.3 发布产物（`G:\work\_dist\`）

```
WaterNasOS-Android-arm64-1.0.0-20261014-1618.apk        87.5 MB  sha256 a92a2a99…
WaterNasOS-Photo-Android-arm64-1.0.0-20261014-1618.apk  95.6 MB  sha256 76719ece…
WaterNasClient-win-x64-20261014.zip                    110.9 MB  490 条目，CRC 自检全过
```

### 11.4 本轮修掉的前置坑

**`flutter_client/android/local.properties` 的 `sdk.dir` 指错了** —— 它指向
`C:\Users\cola\AppData\Local\Android\sdk`，而**那个 SDK 里根本没有 `ndk` 目录**
（NDK 28.2.13676358 只装在 `G:\work\_toolchain\android-sdk`）。
`photo_client` 一直是对的，`flutter_client` 是错的 ⇒ 照原样构建**必失败**。
已改成 `_toolchain\android-sdk`（原文件备份在 `G:/work/_patch_backup/20261014_scene_v2/`）。

### 11.5 flutter 构建必须走外部桥接

实测三条路都不通（WorkBuddy 的 Job Object 限制 Dart 建带管道的子进程）：

| 方式 | 现象 |
|---|---|
| Bash 里 `flutter pub get` | 挂死，120 s 无任何输出被超时杀掉 |
| 集成终端直接跑 | exit 1，且 `.dart_tool/package_config.json` 时间戳没更新（等于没跑） |
| 后台作业 | 被安全策略拦下 |

正确做法：**由人在普通 cmd 窗口起 `python tool\build_bridge.py`**（不能在 WorkBuddy/IDE 的终端里起），
`/ping` 返回 `dart_named_pipe_read_ok: true` 之后才能干活。

⚠️ **桥接本身有个坑**：它的 cwd 是 `G:\work\nascab\tool`（不是仓库根），
所以 `bridge_cli.py run --shell "tool\build_main_android.bat"` 会返回
「系统找不到指定的路径」+ `rc=1 0.0s`（看起来像静默 no-op）。
**必须显式传 bat 的绝对路径 + cwd** —— 为此新增了 `tool/_run_builds.py`：
它直接 POST `/run`，并对每个构建做「日志是否增长 + 成功标记是否出现」双判定。
