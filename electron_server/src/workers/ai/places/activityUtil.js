'use strict';

/**
 * 活动识别 —— SigLIP 2 开放词汇打分（运行时）
 *
 * ⭐ 为什么用 SigLIP 2 而不是 CLIP（实测结论，见 docs 场景识别精度方案 §8.15~§8.17）：
 *   - CLIP 零样本在**动作/活动**上完全不工作：15 张人工真值 Top-1 **0/15**、Top-3 2/15，
 *     Top1−Top5 间距仅 0.025，连静物都被判成「切蛋糕」。
 *     （CLIP 的标签空间是「地点」，没有动作语义。）
 *   - 专用闭集动作模型也不行：15 类动作模型整图 0/15（闭集无拒答）；
 *     400 类 TimeSformer 定性最像样，但 **cc-by-nc-4.0 不能商用** ⇒ 出局。
 *   - SigLIP 2 base-224（**apache-2.0**）同一套真值 **Top-1 60% / Top-3 86.7%**，
 *     相近活动区分 5/5（badminton>volleyball>tennis、hiking≫cycling>swimming）。
 *   - ⛔ 不要上 so400m-384：英文 Top-1 与 base-224 **持平**，代价 98ms → 2075ms（21×）。
 *
 * ⭐ 与场景维度的关系：**并行、不共享标签空间**。
 *   活动标签写 `photo_places2filehash` 的独立列（act_name / act_score / act_alt），
 *   绝不并进 place_name —— placesFusion 的两处归一化都是**跨类**的
 *   （zscoreAcrossClasses + softmax 分母为全体指数和），
 *   多一个类别旧类别的票就被稀释（实测 Top-1 47.4% → 40.0%，p=0.0156）。
 *
 * ⚠️ 语言：**只走英文**。SigLIP 2 中文明显弱于英文（Top-1 60% → 40%、拒识 3/3 → 1/3）。
 *   `act_candidates.json` 里的中文只做展示名。
 *
 * ⚠️ 拒识：**不用锚点候选**（`unrelated` 当候选参选会变 hub：抢 11/26 张 Top-1、
 *   其中 7 张判错，§8.18.3）。改用「先只在活动候选里排序 → 再看分数」的事后阈值，
 *   外加 DETR 人物门控处理「活动关联物体」造成的假阳性（§8.19~§8.22）。
 *
 * ⚠️ 覆盖文件：`onnx_models/activity/` **不在** remoteAssetsManager 的 ONNX_BUNDLE_IDS 里
 *   （那份清单只有 faces / ppocrv5 / places365），远端资源模式下它会指向
 *   <userData>/remote_assets/files/onnx_models —— 那里没有 activity
 *   ⇒ 必须回退到包内路径，否则整个活动维度被静默关掉。与 placesClipUtil 的 HEAD_PATH 同一手法。
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

// SigLIP 2 官方预处理：mean/std 均 0.5（与 CLIP 不同，别抄错）
const SIGLIP_MEAN = 0.5;
const SIGLIP_STD = 0.5;
const INPUT_SIZE = 224;

/** 视觉塔候选：把更好的同结构模型丢进目录即可自动升级 */
const VISION_CANDIDATES = ['siglip2_vision_q4f16.onnx', 'siglip2_vision_int8.onnx', 'siglip2_vision_fp16.onnx'];

/**
 * ⭐ 阈值（docs §8.22.4，217 张人工标注 / k 折 CV 定出来的）
 *   τ  = 0.078  英文活动分阈值，5% 误伤下拦下 93.6% 的「无活动」照片
 *   τp = 1.0    DETR 人物概率门限（宽松档）
 *   1.3τ        不确定带上界；≥ 此值直接判有活动，不必跑 DETR
 * 实测宽松档：拦下 93.6% → 96.6%（+3.0pp），正样本只掉 0.2pp；只有 9.4% 照片需跑门控。
 */
const DEFAULTS = {
  actThreshold: 0.078,
  actGateUpper: 1.3,
  personThreshold: 1.0,
};

let _readyPromise = null;
let _session = null;
let _inputName = null;
let _outputName = null;
let _embeds = null;   // Float32Array(count * dim)，已 L2 归一化
let _keys = [];
let _labels = [];
let _dim = 0;
let _count = 0;
let _availableCache = null;

function activityDir() {
  const primary = path.resolve(remoteAssets.resolveOnnxModelsRoot(), 'activity');
  try {
    if (fs.existsSync(path.join(primary, 'act_candidates.json'))) return primary;
  } catch (_) {}
  try {
    const bundled = path.resolve(remoteAssets.resolveBundledPath('onnx_models'), 'activity');
    if (bundled !== primary && fs.existsSync(path.join(bundled, 'act_candidates.json'))) return bundled;
  } catch (_) {}
  return primary;
}

const META_PATH = () => path.resolve(activityDir(), 'act_candidates.json');
const BIN_PATH = () => path.resolve(activityDir(), 'act_text_embeds.bin');

function resolveVisionModelPath() {
  const dir = activityDir();
  for (const name of VISION_CANDIDATES) {
    const p = path.resolve(dir, name);
    try {
      if (fs.existsSync(p)) return p;
    } catch (_) {}
  }
  return null;
}

/** 模型与嵌入是否就位（不加载，供上层决定要不要启用活动维度） */
function isAvailable() {
  if (_availableCache !== null) return _availableCache;
  try {
    _availableCache = !!(resolveVisionModelPath() && fs.existsSync(BIN_PATH()) && fs.existsSync(META_PATH()));
  } catch (_) {
    _availableCache = false;
  }
  return _availableCache;
}

function createSharpFromConverted(converted) {
  if (converted && typeof converted === 'object' && !Buffer.isBuffer(converted) && converted.input && converted.options) {
    return sharp(converted.input, converted.options);
  }
  return sharp(converted, { failOnError: false });
}

/**
 * SigLIP 2 图像预处理：整图缩放到 224×224（fit: cover）→ RGB → (px/255−0.5)/0.5 → CHW。
 * ⚠️ 与评测脚本 `tool/_siglip_bench.js` 的 toCHW **逐字一致**，否则 τ=0.078 不可比。
 */
async function _preprocess(imagePath, size = INPUT_SIZE) {
  const converted = await sharpUtils.transSpcielFormat(imagePath);
  const { data, info } = await createSharpFromConverted(converted)
    .rotate()
    .resize(size, size, { fit: 'cover' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const hw = info.height * info.width;
  if (data.length !== hw * 3) {
    throw new Error(`activity preprocess buffer mismatch: got ${data.length}, expected ${hw * 3}`);
  }
  const out = new Float32Array(3 * hw);
  for (let i = 0; i < hw; i += 1) {
    const base = i * 3;
    out[i] = (data[base] / 255 - SIGLIP_MEAN) / SIGLIP_STD;
    out[hw + i] = (data[base + 1] / 255 - SIGLIP_MEAN) / SIGLIP_STD;
    out[2 * hw + i] = (data[base + 2] / 255 - SIGLIP_MEAN) / SIGLIP_STD;
  }
  return out;
}

async function ensureReady() {
  if (_readyPromise) return _readyPromise;
  _readyPromise = (async () => {
    if (!isAvailable()) throw new Error('activity (siglip2) model not available');

    const meta = JSON.parse(await fs.promises.readFile(META_PATH(), 'utf8'));
    const bin = await fs.promises.readFile(BIN_PATH());
    const dim = Number(meta.dim) || 0;
    const count = Number(meta.count) || 0;
    if (!count || dim <= 0) throw new Error('activity text embeddings meta invalid');
    const ab = bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength);
    _embeds = new Float32Array(ab);
    if (_embeds.length !== count * dim) {
      throw new Error(`activity text embeddings size mismatch: ${_embeds.length} != ${count * dim}`);
    }
    _keys = Array.isArray(meta.keys) ? meta.keys.map(String) : [];
    _labels = Array.isArray(meta.labels) ? meta.labels.map(String) : [];
    _dim = dim;
    _count = count;

    const modelPath = resolveVisionModelPath();
    Logger.info(`[activity] siglip2 whole vision tower: ${path.basename(modelPath)}`);
    const sessionOptions = {
      executionProviders: getBestExecutionProviders(),
      enableCpuMemArena: false,
      enableMemPattern: false,
      graphOptimizationLevel: 'all',
    };
    _session = await ort.InferenceSession.create(modelPath, sessionOptions);
    _inputName = _session.inputNames && _session.inputNames.length ? _session.inputNames[0] : null;
    // ⚠️ 取**池化**输出：视觉塔另有 last_hidden_state（逐 patch），拿错就是 [N, dim] 矩阵
    _outputName = (_session.outputNames || []).find(n => /pooler|image_embeds|embeds/i.test(n))
      || (_session.outputNames && _session.outputNames[_session.outputNames.length - 1]);
    if (!_inputName || !_outputName) throw new Error('siglip2 vision model io name not found');

    Logger.info(`[activity] ready: ${_count} candidates, dim=${_dim}`
      + `，providers=${sessionOptions.executionProviders.join(',')}，backends=${getLoadedBackends()}`);
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
 * 对单张图做活动零样本打分。
 * @returns {Promise<{top:Array<{key:string,label:string,sim:number}>, topScore:number, sims:Float32Array}>}
 */
async function scoreImage(imagePath, opts = {}) {
  await ensureReady();
  const chw = await _preprocess(imagePath);
  const tensor = new ort.Tensor('float32', chw, [1, 3, INPUT_SIZE, INPUT_SIZE]);
  const out = await _session.run({ [_inputName]: tensor });
  const emb = _l2norm(Float32Array.from(out[_outputName].data));

  const sims = new Float32Array(_count);
  const dim = _dim;
  for (let i = 0; i < _count; i += 1) {
    let dot = 0;
    const base = i * dim;
    for (let d = 0; d < dim; d += 1) dot += emb[d] * _embeds[base + d];
    sims[i] = dot;
  }

  const k = Math.max(1, Math.min(Number(opts.topK) || 3, _count));
  const order = Array.from({ length: _count }, (_, i) => i).sort((a, b) => sims[b] - sims[a]).slice(0, k);
  const top = order.map(i => ({ key: _keys[i] || '', label: _labels[i] || '', sim: sims[i] }));

  return { top, topScore: top.length ? top[0].sim : 0, sims };
}

/** 该分数是否落在「不确定带」（需要跑人物门控才对） */
function needPersonGate(topScore, cfg) {
  const c = Object.assign({}, DEFAULTS, cfg || {});
  return topScore >= c.actThreshold && topScore < c.actThreshold * c.actGateUpper;
}

/**
 * 活动判定（文档 §8.22.7 的流程）
 * @param {number} topScore    Top-1 活动分
 * @param {number|null} personProb  DETR 人物概率；null = 未跑门控
 * @returns {{activity:boolean, needGate:boolean, reason:string}}
 */
function decideActivity(topScore, personProb, cfg) {
  const c = Object.assign({}, DEFAULTS, cfg || {});
  const s = Number(topScore) || 0;
  if (s < c.actThreshold) return { activity: false, needGate: false, reason: 'low-score' };
  if (s >= c.actThreshold * c.actGateUpper) return { activity: true, needGate: false, reason: 'high-score' };
  // 不确定带
  if (personProb === null || personProb === undefined || !Number.isFinite(Number(personProb))) {
    return { activity: true, needGate: true, reason: 'band-without-gate' };
  }
  if (Number(personProb) < c.personThreshold) return { activity: false, needGate: false, reason: 'person-gate' };
  return { activity: true, needGate: false, reason: 'band' };
}

function getKeys() { return _keys; }
function getLabels() { return _labels; }
function getCount() { return _count; }
function getDim() { return _dim; }

module.exports = {
  DEFAULTS,
  isAvailable,
  ensureReady,
  scoreImage,
  needPersonGate,
  decideActivity,
  getKeys,
  getLabels,
  getCount,
  getDim,
  resolveVisionModelPath,
  activityDir,
  META_PATH,
  BIN_PATH,
};
