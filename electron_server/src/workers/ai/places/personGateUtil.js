'use strict';

/**
 * 人物门控 —— DETR-R50 检测「照片里到底有没有人」
 *
 * ⭐ 为什么需要它（docs §8.20.4 找到的根因）：
 *   图文模型匹配的是**物体**，不是**动作** —— 湖中小船 → kayaking、桌面棋盘 → playing cards、
 *   书本/白板 → 一堆活动、日落海滩 → posing。这是编码器的**结构性局限**，阈值有天花板。
 *   实测：真·无人的照片里，仍有 26 张的活动分高于正样本最低分。
 *
 * ⭐ 为什么不能用文本提示做门控（§8.20.5，已实测否掉）：
 *   `There is a person` vs `There is no person` 这一对，margin AUC 仅 **0.627**；
 *   门控+阈值虽然把拦下率提到 96%，但**丢掉一半正样本**（只留 52%）。得不偿失。
 *
 * ⭐ 为什么不能用现成的人脸检测：婴儿特写 / 戴口罩自拍 / 眼镜正脸**全部漏检**
 *   （实测 0 脸候选里这些一大把）⇒ 必须用真正的**人物检测器**。
 *
 * 模型：`facebook/detr-resnet-50`（**apache-2.0** ✅，COCO 91 类，person = id 1）
 *       ONNX 转换 `onnx-community/detr-resnet-50-ONNX`。
 *       ⛔ YOLO 系是 AGPL-3.0，本项目不用。
 *
 * ⭐ 量化版本：**q4f16（56MB）**。与 fp16（80MB）在同一批 217 张上对比：
 *   偏差中位 0.0028、p90 0.0879、只有 1 张（远景小人 0.858→0.238）差超 0.5；
 *   **门控结论逐位一致**（严格档 97.3% / 宽松档 96.6% / 误伤 89.0%·93.6% 全同）⇒ 省 24MB。
 *
 * ⭐ 成本控制：**只在活动分的不确定带里调用**（§8.21.2 实测占 9.4% 照片），
 *   不是每张都跑。全库 60k 张约 5.7k 次 × 373ms ≈ 36 分钟（一次性）。
 *
 * ⚠️ 覆盖文件：`onnx_models/person/` 不在 ONNX_BUNDLE_IDS ⇒ 与 activityUtil 同样做路径回退。
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

// DETR 用 ImageNet 均值方差（不是 0.5！与 SigLIP 不同，别抄错）
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];
const SHORT_SIDE = 640;
const NUM_QUERIES = 100;

const MODEL_CANDIDATES = ['detr_resnet50_q4f16.onnx', 'detr_resnet50_fp16.onnx'];

let _readyPromise = null;
let _session = null;
let _personIdx = 1;
let _availableCache = null;

function personDir() {
  const primary = path.resolve(remoteAssets.resolveOnnxModelsRoot(), 'person');
  try {
    if (fs.existsSync(path.join(primary, 'detr_config.json'))) return primary;
  } catch (_) {}
  try {
    const bundled = path.resolve(remoteAssets.resolveBundledPath('onnx_models'), 'person');
    if (bundled !== primary && fs.existsSync(path.join(bundled, 'detr_config.json'))) return bundled;
  } catch (_) {}
  return primary;
}

const CFG_PATH = () => path.resolve(personDir(), 'detr_config.json');

function resolveModelPath() {
  const dir = personDir();
  for (const name of MODEL_CANDIDATES) {
    const p = path.resolve(dir, name);
    try {
      if (fs.existsSync(p)) return p;
    } catch (_) {}
  }
  return null;
}

function isAvailable() {
  if (_availableCache !== null) return _availableCache;
  try {
    _availableCache = !!(resolveModelPath() && fs.existsSync(CFG_PATH()));
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
 * DETR 预处理：短边缩放到 640（保持比例，用 fit:fill 承载已算好的 w/h）→ RGB → ImageNet 归一化 → CHW。
 * ⚠️ 与 `tool/_person_gate_probe.js` 逐字一致（宽高都要取整到 32 的倍数，DETR 的 backbone 要求）。
 */
async function _preprocess(imagePath, shortSide = SHORT_SIDE) {
  const converted = await sharpUtils.transSpcielFormat(imagePath);
  const img = createSharpFromConverted(converted).rotate();
  const meta = await img.metadata();
  const w0 = Number(meta.width) || 1;
  const h0 = Number(meta.height) || 1;
  const sc = shortSide / Math.min(w0, h0);
  const w = Math.max(32, Math.round((w0 * sc) / 32) * 32);
  const h = Math.max(32, Math.round((h0 * sc) / 32) * 32);

  const { data } = await createSharpFromConverted(converted).rotate()
    .resize(w, h, { fit: 'fill' }).removeAlpha().raw()
    .toBuffer({ resolveWithObject: true });

  const px = new Float32Array(3 * h * w);
  const np = h * w;
  for (let i = 0; i < np; i += 1) {
    for (let c = 0; c < 3; c += 1) px[c * np + i] = (data[i * 3 + c] / 255 - MEAN[c]) / STD[c];
  }
  return { px, w, h };
}

async function ensureReady() {
  if (_readyPromise) return _readyPromise;
  _readyPromise = (async () => {
    if (!isAvailable()) throw new Error('person gate (detr-r50) model not available');

    try {
      const cfg = JSON.parse(await fs.promises.readFile(CFG_PATH(), 'utf8'));
      const id2label = cfg && cfg.id2label ? cfg.id2label : null;
      if (id2label) {
        const k = Object.keys(id2label).find(x => String(id2label[x]).toLowerCase() === 'person');
        if (k !== undefined) _personIdx = Number(k);
      }
    } catch (err) {
      Logger.warn(`[personGate] 读 config.json 失败，person 类沿用默认 id=${_personIdx}: ${err && err.message ? err.message : err}`);
    }

    const modelPath = resolveModelPath();
    Logger.info(`[personGate] DETR-R50: ${path.basename(modelPath)}，person 类 id=${_personIdx}`);
    const sessionOptions = {
      executionProviders: getBestExecutionProviders(),
      enableCpuMemArena: false,
      enableMemPattern: false,
      graphOptimizationLevel: 'all',
    };
    _session = await ort.InferenceSession.create(modelPath, sessionOptions);
    Logger.info(`[personGate] ready，providers=${sessionOptions.executionProviders.join(',')}，backends=${getLoadedBackends()}`);
    return true;
  })().catch((err) => {
    _readyPromise = null;
    throw err;
  });
  return _readyPromise;
}

/**
 * 单张图的「有人」概率。
 * @returns {Promise<{personProb:number, personCnt:number}>} personProb = 100 个 query 里 person 类的最大 sigmoid
 */
async function personProbability(imagePath, opts = {}) {
  await ensureReady();
  const { px, w, h } = await _preprocess(imagePath, Number(opts.shortSide) || SHORT_SIDE);
  const feed = {};
  feed[_session.inputNames[0]] = new ort.Tensor('float32', px, [1, 3, h, w]);
  if (_session.inputNames.length > 1) {
    // DETR 的 pixel_mask：全 1（无 padding）
    feed[_session.inputNames[1]] = new ort.Tensor('int64',
      BigInt64Array.from({ length: h * w }, () => 1n), [1, h, w]);
  }
  const res = await _session.run(feed);
  const key = (_session.outputNames || []).find(x => /logits/i.test(x)) || _session.outputNames[0];
  const logits = res[key];
  const dims = logits.dims;
  const C = dims[dims.length - 1];

  let best = -Infinity;
  let cnt = 0;
  for (let q = 0; q < Math.min(NUM_QUERIES, dims[dims.length - 2]); q += 1) {
    const v = logits.data[q * C + _personIdx];
    const p = 1 / (1 + Math.exp(-v));
    if (p > best) best = p;
    if (p > 0.5) cnt += 1;
  }
  // ⚠️⚠️ 必须与标定口径**逐字一致**：`tool/_person_gate_probe.js` 落盘时做了 `+best.toFixed(4)`。
  //   DETR 的 sigmoid 在有人图上会饱和到 0.9999x，若不归一化，τp=1.0 的判定会把
  //   0.99998 当成「没人」⇒ **正样本被大量误杀**（实测保留率 93.6% → 71.4%，6/21 假阴）。
  //   这是本轮集成唯一一个真 bug，改前先看这段注释。
  const prob = Number.isFinite(best) ? Number(best.toFixed(4)) : 0;
  return { personProb: prob, personCnt: cnt };
}

/** 释放会话（离线脚本反复加载时用；运行时不需要） */
async function dispose() {
  try { if (_session && typeof _session.dispose === 'function') await _session.dispose(); } catch (_) {}
  _session = null;
  _readyPromise = null;
  _availableCache = null;
}

module.exports = {
  isAvailable,
  ensureReady,
  personProbability,
  dispose,
  resolveModelPath,
  personDir,
  CFG_PATH,
  SHORT_SIDE,
};
