'use strict';

/**
 * 场景识别 v2 —— CLIP 开放词表零样本打分（运行时）
 *
 * ⭐ 为什么要引入它（2026-10-14 实测结论）：
 * 原方案只有 ResNet50-Places365（2017 年的闭集 365 类分类器）。用真实照片实测：
 *   泳池   → ResNet「深海 0.61」❌   CLIP「室内泳池 0.44」✅
 *   病房   → ResNet「艺术工作室 0.06」❌ CLIP「病房 0.28 / 手术室 0.25」✅
 *   厨房   → ResNet「乐池」❌        CLIP「餐厅厨房 / 厨房」进 top3 ✅
 * 即：**室内细粒度场景上 CLIP 零样本是压倒性的**，户外大场景两者相当。
 *
 * 设计要点：
 * - 运行时只加载**视觉塔**（约 85MB）。文本塔与分词器只在构建期用一次，
 *   产出的标签文本嵌入是 text_embeds.bin（0.7MB），随包发布。
 * - 标签空间是**开放**的，来自 scene_tags.txt，不受 Places365 的 365 类限制
 *   （补充了卫生间/阳台/儿童房/手机截图/文档照片等 Places365 给不出的标签）。
 * - 模型文件缺失时 isAvailable() 返回 false，上层自动退回纯 ResNet 行为，
 *   与 resnet152 的「丢文件即升级」是同一套探测回退思路。
 */

const fs = require('fs');
const path = require('path');
const sharp = require('../../../utils/sharpConfigured');
const ort = require('onnxruntime-node');
const sharpUtils = require('../../../utils/sharpUtils');
const remoteAssets = require('../../../utils/remoteAssetsManager');
const { getBestExecutionProviders, getLoadedBackends } = require('../../../utils/onnxProviderUtil');
const Logger = require('../../../utils/logger');

try {
  sharp.cache(false);
  sharp.concurrency(1);
} catch (_) {}

// CLIP 官方预处理参数（与 preprocessor_config.json 一致）
const CLIP_MEAN = [0.48145466, 0.4578275, 0.40821073];
const CLIP_STD = [0.26862954, 0.26130258, 0.27577711];
const CLIP_INPUT_SIZE = 224;

/** 视觉塔候选：把更强的同结构模型丢进目录即可自动升级，无需改代码 */
const VISION_MODEL_CANDIDATES = ['vision_model.onnx', 'vision_model_int8.onnx', 'vision_model_quantized.onnx'];

const CLIP_DIR = () => path.resolve(remoteAssets.resolveOnnxModelsRoot(), 'clip');
const BIN_PATH = () => path.resolve(CLIP_DIR(), 'text_embeds.bin');
const META_PATH = () => path.resolve(CLIP_DIR(), 'text_embeds.json');
// ⭐ 2026-10-15「可判性」head：判断「这张照片该不该给场景标签」（方案文档第 8 节）
// ⚠️ 必须带回退：远端资源模式下 resolveOnnxModelsRoot() 指向
//    <userData>/remote_assets/files/onnx_models，而本文件只随包发布、不属于任何
//    bundle（ONNX_BUNDLE_IDS 里没有 clip）⇒ 不兜底会让门控被静默关掉。
const HEAD_PATH = () => {
  const primary = path.resolve(CLIP_DIR(), 'scene_scorable_head.json');
  try {
    if (fs.existsSync(primary)) return primary;
  } catch (_) {}
  try {
    const bundled = path.resolve(remoteAssets.resolveBundledPath('onnx_models'), 'clip', 'scene_scorable_head.json');
    if (bundled !== primary && fs.existsSync(bundled)) return bundled;
  } catch (_) {}
  return primary;
};

let _readyPromise = null;
let _tagTablePromise = null;
let _session = null;
let _textEmbeds = null; // Float32Array(count * dim)
let _labels = [];       // 与 text_embeds 行一一对应
let _dim = 0;
let _count = 0;
let _inputName = null;
let _outputName = null;
let _availableCache = null;
let _head = null;                  // { dim, w: Float32Array, b, threshold, stats }
let _headPromise = null;
let _headThresholdOverride = null; // 运行时可覆盖（tableConfig ai_place_scorable_threshold）

function resolveVisionModelPath() {
  const dir = CLIP_DIR();
  for (const name of VISION_MODEL_CANDIDATES) {
    const p = path.resolve(dir, name);
    try {
      if (fs.existsSync(p)) return p;
    } catch (_) {}
  }
  return null;
}

/** 模型与嵌入文件是否就位（不做加载，供上层决定要不要走融合） */
function isAvailable() {
  if (_availableCache !== null) return _availableCache;
  try {
    _availableCache = !!(resolveVisionModelPath() && fs.existsSync(BIN_PATH()) && fs.existsSync(META_PATH()));
  } catch (_) {
    _availableCache = false;
  }
  return _availableCache;
}

/**
 * ⭐ 2026-10-15「可判性」head（判断「这张照片该不该给场景标签」）
 *
 * 为什么需要它（实测，见 docs/WaterNasOS-场景语义搜索与识别精度方案.md 第 8 节）：
 *   - 现有 weight 阈值门控**方向是反的**：人工标「可评」的照片 unknown 33.7%，
 *     人工标「不可评」的只有 9.1%（差 −24.6pp）。人像因为「背景像室内场景」拿到高权重，
 *     被自信地判成美容院 / 服装店 / 婚礼现场。
 *   - 6 种零样本判据全部不达标（CLIP 非场景锚点 / z 校正 / 场景归属 margin / 熵 / 人脸占比）
 *     ⇒ 单变量阈值提不出这个信号，必须多变量线性组合。
 *   - 训练 head：CV AUC 0.8074（95 张可评 / 55 张不可评），误伤 5% 时拦下 28% 的
 *     「不该判场景」照片，分离度 +23pp。**唯一达标方案。**
 *
 * 权重由 tool/_train_scorable_head.js 离线产出（512 个数 ≈ 5.8KB，随包发布）。
 * ⚠️ 文件缺失 ⇒ 返回 false，门控自动失效，绝不影响原有行为。
 */
async function ensureScorableHead() {
  if (_headPromise) return _headPromise;
  _headPromise = (async () => {
    const p = HEAD_PATH();
    if (!fs.existsSync(p)) return false;
    const raw = JSON.parse(await fs.promises.readFile(p, 'utf8'));
    const dim = Number(raw.dim) || 0;
    if (!Array.isArray(raw.w) || raw.w.length !== dim || dim <= 0) {
      throw new Error(`scorable head 权重长度异常: ${raw.w ? raw.w.length : 'n/a'} != ${dim}`);
    }
    if (_dim && dim !== _dim) {
      throw new Error(`scorable head 维度 ${dim} 与 CLIP 嵌入维度 ${_dim} 不一致`);
    }
    if (raw.modelKey && _labels && _dim && raw.modelKey !== 'b32') {
      // 只做提示，不阻断（换塔时权重可能仍可用）
      Logger.warn(`[placesClip] scorable head 由 ${raw.modelKey} 训练，当前词表 ${_dim} 维`);
    }
    const w = new Float32Array(dim);
    for (let i = 0; i < dim; i += 1) w[i] = Number(raw.w[i]) || 0;
    _head = {
      dim,
      w,
      b: Number(raw.b) || 0,
      threshold: Number(raw.threshold),
      stats: raw.stats || null,
      trainedOn: raw.createdAt || '',
    };
    return true;
  })().catch((err) => { _headPromise = null; throw err; });
  return _headPromise;
}

function getScorableHead() {
  return _head;
}

function isScorableHeadAvailable() {
  try {
    return fs.existsSync(HEAD_PATH());
  } catch (_) {
    return false;
  }
}

/** 运行时覆盖阈值（来自 tableConfig）；传 NaN/undefined 则恢复用产物自带阈值 */
function setScorableThreshold(v) {
  const n = Number(v);
  _headThresholdOverride = Number.isFinite(n) ? n : null;
  return getScorableThreshold();
}

function getScorableThreshold() {
  if (_headThresholdOverride !== null) return _headThresholdOverride;
  return _head && Number.isFinite(_head.threshold) ? _head.threshold : -Infinity;
}

function createSharpFromConverted(converted) {
  if (converted && typeof converted === 'object' && !Buffer.isBuffer(converted) && converted.input && converted.options) {
    return sharp(converted.input, converted.options);
  }
  return sharp(converted, { failOnError: false });
}

/**
 * CLIP 图像预处理：短边缩放到 224 → 中心裁剪 224×224 → RGB → CLIP 均值方差归一化 → CHW。
 * 注意与 Places365 的预处理不同（那边是短边 256 再裁 224，且用 ImageNet 均值方差）。
 */
async function _preprocess(imagePath, size = CLIP_INPUT_SIZE) {
  const converted = await sharpUtils.transSpcielFormat(imagePath);
  const img = createSharpFromConverted(converted).rotate().toColorspace('srgb').removeAlpha();
  const meta = await img.metadata();
  const oriented = meta && meta.autoOrient;
  const w = Number(oriented && oriented.width) || Number(meta.width) || 0;
  const h = Number(oriented && oriented.height) || Number(meta.height) || 0;
  if (w <= 0 || h <= 0) throw new Error('Invalid image size');

  let newW;
  let newH;
  if (w < h) {
    newW = size;
    newH = Math.round((h * size) / w);
  } else {
    newH = size;
    newW = Math.round((w * size) / h);
  }
  newW = Math.max(newW, size);
  newH = Math.max(newH, size);
  const left = Math.floor((newW - size) / 2);
  const top = Math.floor((newH - size) / 2);

  const { data, info } = await img
    .resize(newW, newH, { fit: 'fill', kernel: sharp.kernel.cubic })
    .extract({ left, top, width: size, height: size })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const expected = info.height * info.width * 3;
  if (data.length !== expected) {
    throw new Error(`clip preprocess buffer mismatch: got ${data.length}, expected ${expected}`);
  }
  const safe = Buffer.from(data);
  const hw = size * size;
  const out = new Float32Array(3 * hw);
  for (let i = 0; i < hw; i += 1) {
    const base = i * 3;
    out[i] = (safe[base] / 255 - CLIP_MEAN[0]) / CLIP_STD[0];
    out[hw + i] = (safe[base + 1] / 255 - CLIP_MEAN[1]) / CLIP_STD[1];
    out[2 * hw + i] = (safe[base + 2] / 255 - CLIP_MEAN[2]) / CLIP_STD[2];
  }
  return out;
}

/**
 * ⭐ 2026-10-14 拆出来：只加载**标签嵌入表**（0.7MB），不碰 85MB 视觉塔。
 *
 * 为什么要拆：语义搜索（placesQuery）只需要标签嵌入表来做
 * 「查询短语嵌入 ↔ 标签嵌入」比对，根本不需要跑图；
 * 若强行走 ensureReady()，就把 85MB 视觉塔的加载与内存占用绑进了搜索路径 ——
 * 在没开场景识别的机器上搜索会直接失败，离线脚本里也更容易踩到原生崩溃。
 */
async function ensureTagTable() {
  if (_tagTablePromise) return _tagTablePromise;
  _tagTablePromise = (async () => {
    const meta = JSON.parse(await fs.promises.readFile(META_PATH(), 'utf8'));
    const bin = await fs.promises.readFile(BIN_PATH());
    const dim = Number(meta.dim) || 512;
    const count = Number(meta.count) || 0;
    if (!count || dim <= 0) throw new Error('clip text embeddings meta invalid');
    const ab = bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength);
    _textEmbeds = new Float32Array(ab);
    if (_textEmbeds.length !== count * dim) {
      throw new Error(`clip text embeddings size mismatch: ${_textEmbeds.length} != ${count * dim}`);
    }
    _labels = Array.isArray(meta.labels) ? meta.labels.map(v => String(v)) : [];
    _dim = dim;
    _count = count;
    return true;
  })().catch((err) => { _tagTablePromise = null; throw err; });
  return _tagTablePromise;
}

async function ensureReady() {
  if (_readyPromise) return _readyPromise;
  _readyPromise = (async () => {
    if (!isAvailable()) throw new Error('clip scene model not available');
    const modelPath = resolveVisionModelPath();
    Logger.info(`[placesClip] scene model: ${path.basename(modelPath)}`);

    await ensureTagTable();

    const sessionOptions = {
      executionProviders: getBestExecutionProviders(),
      enableCpuMemArena: false,
      enableMemPattern: false,
      graphOptimizationLevel: 'all',
    };
    _session = await ort.InferenceSession.create(modelPath, sessionOptions);
    Logger.info(`[placesClip] Selected providers: ${sessionOptions.executionProviders.join(', ')}`);
    Logger.info(`[placesClip] Loaded backends: ${getLoadedBackends()}`);
    _inputName = _session.inputNames && _session.inputNames.length ? _session.inputNames[0] : null;
    _outputName = _session.outputNames && _session.outputNames.length ? _session.outputNames[0] : null;
    if (!_inputName || !_outputName) throw new Error('clip vision model io name not found');
    // ⭐ 可判性 head 是可选件：加载失败只是门控不生效，不能拖垮主链路
    try {
      await ensureScorableHead();
    } catch (err) {
      Logger.warn(`[placesClip] 可判性 head 加载失败（门控不生效）: ${err && err.message ? err.message : err}`);
    }
    Logger.info(`[placesClip] ready: ${_count} labels, dim=${_dim}`
      + (_head ? `，可判性 head 阈值 ${getScorableThreshold().toFixed(4)}` : '，无可判性 head'));
    return true;
  })().catch((err) => {
    _readyPromise = null;
    throw err;
  });
  return _readyPromise;
}

function _l2norm(vec) {
  let sum = 0;
  for (let i = 0; i < vec.length; i += 1) sum += vec[i] * vec[i];
  const n = Math.sqrt(sum) || 1;
  const out = new Float32Array(vec.length);
  for (let i = 0; i < vec.length; i += 1) out[i] = vec[i] / n;
  return out;
}

/**
 * 对单张图做零样本打分。
 * @param {string} imagePath
 * @param {object} [opts]
 * @param {number} [opts.topK] 只返回前 K 个（默认全量分数也一并返回）
 * @returns {Promise<{sims: Float32Array, labels: string[], top: Array<{label:string, sim:number, index:number}>}>}
 */
async function scoreImage(imagePath, opts = {}) {
  await ensureReady();
  const chw = await _preprocess(imagePath);
  const tensor = new ort.Tensor('float32', chw, [1, 3, CLIP_INPUT_SIZE, CLIP_INPUT_SIZE]);
  const out = await _session.run({ [_inputName]: tensor });
  const raw = out[_outputName].data;
  const emb = _l2norm(Float32Array.from(raw));

  const sims = new Float32Array(_count);
  const dim = _dim;
  for (let i = 0; i < _count; i += 1) {
    let dot = 0;
    const base = i * dim;
    for (let d = 0; d < dim; d += 1) dot += emb[d] * _textEmbeds[base + d];
    sims[i] = dot;
  }

  const k = Math.max(1, Math.min(Number(opts.topK) || 5, _count));
  const order = Array.from({ length: _count }, (_, i) => i).sort((a, b) => sims[b] - sims[a]).slice(0, k);

  // ⭐ 可判性评分（head 缺失 ⇒ null ⇒ 上层门控不生效，行为与旧版一致）
  let scorableScore = null;
  let scorableBlocked = false;
  if (_head) {
    let s = Number(_head.b) || 0;
    for (let d = 0; d < _head.dim; d += 1) s += emb[d] * _head.w[d];
    scorableScore = s;
    scorableBlocked = s < getScorableThreshold();
  }

  return {
    sims,
    labels: _labels,
    emb,
    scorableScore,
    scorableBlocked,
    top: order.map(i => ({ label: _labels[i] || '', sim: sims[i], index: i })),
  };
}

/** 供上层做「每个中文标签一行分数」的映射用 */
function getLabelCount() {
  return _count;
}

/**
 * ⭐ 2026-10-14 语义搜索用：把标签嵌入表暴露出去。
 * placesQuery 需要在**同一个 512 维空间**里把「查询短语嵌入」与「标签嵌入」比对，
 * 而这份嵌入表本来就是 CLIP 文本塔编出来的 —— 复用它可以保证两边量纲一致，
 * 也避免再加载一份副本。
 * @returns {string[]} 标签数组（与 getTextEmbeds 的行一一对应）
 */
function getLabels() {
  return _labels;
}

/** @returns {Float32Array|null} N×dim 行主序，已 L2 归一化 */
function getTextEmbeds() {
  return _textEmbeds;
}

/** @returns {number} 每个标签嵌入的维度 */
function getDim() {
  return _dim;
}

/**
 * ⭐ 2026-10-17 塔标识：用实际加载的视觉模型文件名（去扩展名）当作「向量空间指纹」。
 * 换塔 / 换量化版本都会变 ⇒ 用来拒绝跨塔比较（见 photo_index.emb_model）。
 */
function getModelTag() {
  try {
    const p = resolveVisionModelPath();
    return p ? path.basename(p).replace(/\.[^.]+$/, '') : '';
  } catch (_) {
    return '';
  }
}

module.exports = {
  isAvailable,
  ensureReady,
  ensureTagTable,
  scoreImage,
  getLabelCount,
  getLabels,
  getTextEmbeds,
  getDim,
  resolveVisionModelPath,
  getModelTag,
  CLIP_DIR,
  // ⭐ 2026-10-15「可判性」head
  ensureScorableHead,
  getScorableHead,
  isScorableHeadAvailable,
  getScorableThreshold,
  setScorableThreshold,
  HEAD_PATH,
};
