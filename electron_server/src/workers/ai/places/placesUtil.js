'use strict';

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

const IMAGENET_MEAN = [0.485, 0.456, 0.406];
const IMAGENET_STD = [0.229, 0.224, 0.225];

/**
 * ⭐ 2026-10-13 场景模型路径：优先用更大的 ResNet152（准确率约 +2%），
 * 没有就回退 ResNet50。与 faces/edgeface 的探测回退同一套路：
 * 用户想换更大的模型时，只要把同名 onnx 丢进 places365 目录即可，无需改代码。
 * 预处理两者完全一致（ImageNet 归一化 + 224 中心裁剪），换模型不用改参数。
 */
const PLACES365_MODEL_CANDIDATES = ['resnet152_places365.onnx', 'resnet50_places365.onnx'];
const MODEL_PATH = () => {
  const dir = remoteAssets.resolveOnnxModelsRoot();
  for (const name of PLACES365_MODEL_CANDIDATES) {
    const p = path.resolve(dir, 'places365', name);
    try {
      if (fs.existsSync(p)) return p;
    } catch (_) {}
  }
  return path.resolve(dir, 'places365', 'resnet50_places365.onnx');
};
const LABELS_PATH = () => path.resolve(remoteAssets.resolveOnnxModelsRoot(), 'places365', 'categories_places365.txt');
/**
 * 场景标签的中文映射（每行 `<英文标签>\t<中文>`）。
 *
 * ⭐ 为什么需要：原始标签是英文（beach / mountain_snowy ...），
 * 而用户搜的是中文 ⇒ 场景识别结果根本没法被中文搜索命中。
 * 有了它，labelByIndex 直接返回中文，存储/展示/搜索三处一起变中文。
 * 文件缺失时自动降级为英文，不会报错。
 */
const ZH_LABELS_PATH = () => path.resolve(remoteAssets.resolveOnnxModelsRoot(), 'places365', 'categories_places365.zh.txt');
const PLACES365_BUNDLE_ID = 'onnx_models.places365';

let _labels = null;
let _zhLabelMap = null;
let _sessionPromise = null;
let _places365ReadyPromise = null;
let _inputName = null;
let _outputName = null;

async function ensurePlaces365Ready() {
  if (!_places365ReadyPromise) {
    _places365ReadyPromise = remoteAssets.ensureBundle(PLACES365_BUNDLE_ID);
  }
  return _places365ReadyPromise;
}

function isRemoteModelError(err) {
  const code = err && err.code ? String(err.code) : '';
  const msg = err && err.message ? String(err.message) : String(err || '');
  return (
    code === 'ENOENT' &&
    (msg.includes('onnx_models') || msg.includes('remote_assets'))
  );
}

function createSharpFromConverted(converted) {
  if (converted && typeof converted === 'object' && !Buffer.isBuffer(converted) && converted.input && converted.options) {
    return sharp(converted.input, converted.options);
  }
  return sharp(converted, { failOnError: false });
}

function _parsePlaces365Categories(text) {
  const labelByIndex = Array.from({ length: 365 }, () => null);
  const canonicalIdByIndex = Array.from({ length: 365 }, () => null);
  const canonicalByLabel = new Map();
  const lines = String(text || '').split(/\r?\n/);
  for (const raw of lines) {
    const line = String(raw || '').trim();
    if (!line) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 2) continue;
    let name = parts[0];
    const idx = Number.parseInt(parts[1], 10);
    if (!Number.isFinite(idx) || idx < 0 || idx >= 365) continue;
    if (name.startsWith('/') && name.length >= 3 && name[2] === '/') {
      name = name.slice(3);
    }
    name = name.replace(/^\/+/, '').replace(/_/g, ' ').trim();
    if (!name) continue;
    labelByIndex[idx] = name;
    const prev = canonicalByLabel.get(name);
    if (prev === undefined || idx < prev) {
      canonicalByLabel.set(name, idx);
    }
  }
  for (let i = 0; i < 365; i++) {
    const label = labelByIndex[i];
    if (!label) continue;
    const cid = canonicalByLabel.get(label);
    if (cid === undefined) continue;
    canonicalIdByIndex[i] = cid;
  }
  return { labelByIndex, canonicalIdByIndex };
}

/**
 * 读中文映射表。失败或文件不存在时返回空 Map（调用方降级为英文，不抛错）。
 * key 统一成「下划线原样」，因为磁盘上的标签文件就是下划线写法。
 */
async function _loadZhLabelMap() {
  if (_zhLabelMap) return _zhLabelMap;
  const map = new Map();
  try {
    const text = await fs.promises.readFile(ZH_LABELS_PATH(), 'utf8');
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const tab = line.indexOf('\t');
      if (tab <= 0) continue;
      const key = line.slice(0, tab).trim();
      const zh = line.slice(tab + 1).trim();
      if (key && zh) map.set(key, zh);
    }
    Logger.info(`[placesUtil] 场景标签中文映射已加载: ${map.size} 条`);
  } catch (e) {
    Logger.warn(`[placesUtil] 中文标签映射不可用，回退英文: ${e && e.message ? e.message : e}`);
  }
  _zhLabelMap = map;
  return _zhLabelMap;
}

async function getPlaces365Labels() {
  if (_labels) return _labels;
  await ensurePlaces365Ready();
  const text = await fs.promises.readFile(LABELS_PATH(), 'utf8');
  const parsed = _parsePlaces365Categories(text);

  // ⭐ 把英文标签换成中文。enLabelByIndex 保留英文，供英文搜索/兼容旧数据。
  const zhMap = await _loadZhLabelMap();
  const labelByIndex = Array.isArray(parsed.labelByIndex) ? parsed.labelByIndex.slice() : [];
  const enLabelByIndex = Array.isArray(parsed.labelByIndex) ? parsed.labelByIndex.slice() : [];
  let translated = 0;
  for (let i = 0; i < labelByIndex.length; i += 1) {
    const en = enLabelByIndex[i];
    if (!en) continue;
    // 解析后的标签是「空格」形式（beach house），映射文件用「下划线」（beach_house）
    const key = String(en).trim().replace(/\s+/g, '_');
    const zh = zhMap.get(key);
    if (zh) {
      labelByIndex[i] = zh;
      translated += 1;
    }
  }
  if (translated > 0) {
    Logger.info(`[placesUtil] 场景标签已中文化: ${translated} 个`);
  }

  _labels = {
    labelByIndex,
    enLabelByIndex,
    canonicalIdByIndex: parsed.canonicalIdByIndex,
  };
  return _labels;
}

async function getPlacesSession() {
  if (_sessionPromise) return _sessionPromise;
  _sessionPromise = (async () => {
    await ensurePlaces365Ready();
    const modelPath = MODEL_PATH();
    Logger.info(`[placesUtil] scene model: ${path.basename(modelPath)}`);
    const sessionOptions = {
      executionProviders: getBestExecutionProviders(),
      enableCpuMemArena: false,
      enableMemPattern: false,
      graphOptimizationLevel: 'all',
    };
    const sess = await ort.InferenceSession.create(modelPath, sessionOptions);
    Logger.info(`[placesUtil] Selected providers: ${sessionOptions.executionProviders.join(', ')}`);
    Logger.info(`[placesUtil] Loaded backends: ${getLoadedBackends()}`);
    _inputName = Array.isArray(sess.inputNames) && sess.inputNames.length > 0 ? sess.inputNames[0] : null;
    _outputName = Array.isArray(sess.outputNames) && sess.outputNames.length > 0 ? sess.outputNames[0] : null;
    if (!_inputName) {
      throw new Error('Places365 model input name not found');
    }
    if (!_outputName) {
      throw new Error('Places365 model output name not found');
    }
    return sess;
  })();
  return _sessionPromise;
}

async function _preprocessToChwFloat32(imagePath, inputSize = 224, resizeShorter = 256) {
  const converted = await sharpUtils.transSpcielFormat(imagePath);
  const img = createSharpFromConverted(converted).rotate().toColorspace('srgb').removeAlpha();
  const meta = await img.metadata();
  // .rotate() 按 EXIF 自动旋转；metadata() 的 width/height 是旋转前尺寸，
  // 90°/270°(orientation 5-8) 旋转后宽高互换，须用 autoOrient 的真实旋转后尺寸。
  const oriented = meta && meta.autoOrient;
  const w = Number(oriented && oriented.width) || Number(meta.width) || 0;
  const h = Number(oriented && oriented.height) || Number(meta.height) || 0;
  if (w <= 0 || h <= 0) throw new Error('Invalid image size');

  let newW = 0;
  let newH = 0;
  if (w < h) {
    newW = resizeShorter;
    newH = Math.round(h * (resizeShorter / w));
  } else {
    newH = resizeShorter;
    newW = Math.round(w * (resizeShorter / h));
  }
  newW = Math.max(newW, inputSize);
  newH = Math.max(newH, inputSize);

  const left = Math.floor((newW - inputSize) / 2);
  const top = Math.floor((newH - inputSize) / 2);

  const { data, info } = await img
    .resize(newW, newH, { fit: 'fill', kernel: sharp.kernel.cubic })
    .extract({ left, top, width: inputSize, height: inputSize })
    .raw()
    .toBuffer({ resolveWithObject: true });

  // 强制检查 buffer 长度是否符合预期 (h * w * 3)
  const expected = info.height * info.width * 3;
  if (data.length !== expected) {
    throw new Error(`places preprocess buffer mismatch: got ${data.length}, expected ${expected} (h=${info.height}, w=${info.width}, c=3)`);
  }

  // Use Buffer.from to ensure safe memory
  const safeData = Buffer.from(data);
  const channels = 3; // We forced srgb so it's always 3

  const hw = inputSize * inputSize;
  const out = new Float32Array(3 * hw);
  for (let i = 0; i < hw; i++) {
    const base = i * channels;
    const r = safeData[base] / 255;
    const g = safeData[base + 1] / 255;
    const b = safeData[base + 2] / 255;

    out[i] = (r - IMAGENET_MEAN[0]) / IMAGENET_STD[0];
    out[hw + i] = (g - IMAGENET_MEAN[1]) / IMAGENET_STD[1];
    out[2 * hw + i] = (b - IMAGENET_MEAN[2]) / IMAGENET_STD[2];
  }
  return out;
}

function _topKSoftmax(logits, k = 2) {
  const arr = ArrayBuffer.isView(logits) ? logits : Float32Array.from(logits || []);
  if (!arr || arr.length === 0) return [];
  let max = -Infinity;
  for (let i = 0; i < arr.length; i++) {
    if (arr[i] > max) max = arr[i];
  }
  let sum = 0;
  const exps = new Array(arr.length);
  for (let i = 0; i < arr.length; i++) {
    const e = Math.exp(arr[i] - max);
    exps[i] = e;
    sum += e;
  }
  const idxs = [];
  for (let i = 0; i < arr.length; i++) idxs.push(i);
  idxs.sort((a, b) => exps[b] - exps[a]);
  const out = [];
  const n = Math.max(1, Math.min(k, idxs.length));
  for (let i = 0; i < n; i++) {
    const idx = idxs[i];
    out.push({ index: idx, prob: sum > 0 ? exps[idx] / sum : 0 });
  }
  return out;
}

/**
 * ⭐ 2026-10-14 场景识别 v2：暴露**完整 logits**（365 维），供决策层做类先验校正与融合。
 * 旧的 predictPlace 只返回 top-2 概率，信息量不足以支撑融合 —— 类先验校正必须
 * 拿到全量 logits 才能"按类"减均值。
 * @returns {Promise<{logits:number[], labelsZh:string[]}>}
 */
async function predictPlaceFull(imagePath) {
  const fullPath = String(imagePath || '');
  if (!fullPath) throw new Error('Invalid image path');

  await ensurePlaces365Ready();
  const [sess, labels] = await Promise.all([getPlacesSession(), getPlaces365Labels()]);
  const chw = await _preprocessToChwFloat32(fullPath);
  const input = new ort.Tensor('float32', chw, [1, 3, 224, 224]);
  const out = await sess.run({ [_inputName]: input });
  const tensor = out[_outputName];
  const logits = tensor && tensor.data ? Array.from(tensor.data) : [];
  const labelsZh = labels && Array.isArray(labels.labelByIndex) ? labels.labelByIndex.slice() : [];
  return { logits, labelsZh };
}

async function predictPlace(imagePath) {
  const fullPath = String(imagePath || '');
  if (!fullPath) throw new Error('Invalid image path');

  await ensurePlaces365Ready();
  const [sess, labels] = await Promise.all([getPlacesSession(), getPlaces365Labels()]);
  const chw = await _preprocessToChwFloat32(fullPath);
  const input = new ort.Tensor('float32', chw, [1, 3, 224, 224]);
  const out = await sess.run({ [_inputName]: input });
  const logitsTensor = out[_outputName];
  const logits = logitsTensor && logitsTensor.data ? logitsTensor.data : null;
  // ⭐ 2026-10-13 取 top-2：室内场景（病房/卧室/育婴室…）top-1 置信度虚高，
  // 第二名往往更接近真实场景，存下来给搜索/相册第二次命中机会。
  const top2 = _topKSoftmax(logits, 2);
  if (top2.length === 0) return { index: 0, label: '', prob: 0, alt: null };
  const first = top2[0];
  const label = labels && labels.labelByIndex ? labels.labelByIndex[first.index] || '' : '';
  const canonicalId = labels && labels.canonicalIdByIndex ? labels.canonicalIdByIndex[first.index] : null;
  const mappedIndex = Number.isFinite(Number(canonicalId)) ? Number(canonicalId) : first.index;

  let alt = null;
  if (top2.length > 1 && top2[1].index !== first.index) {
    const altLabel = labels && labels.labelByIndex ? labels.labelByIndex[top2[1].index] || '' : '';
    if (altLabel && altLabel !== label) {
      alt = { label: altLabel, prob: top2[1].prob };
    }
  }
  return { index: label ? mappedIndex : first.index, label, prob: first.prob, alt };
}

/**
 * ⭐ 2026-10-17 判定「永久性图像错误」——重试一万次也不会成功的那类。
 *
 * 依据：这些都是 **sharp / libvips 在解码阶段**报的错，只与文件本身有关
 *（不是图片、或数据损坏），与模型、内存、并发都无关。
 *
 * ⛔ 反面清单（这些是**瞬时**错误，必须重试，绝不能当成永久失败）：
 *    · 模型/权重加载失败（走 isRemoteModelError 那条路径）
 *    · SQLITE_BUSY / 磁盘 IO 抖动 / ENOMEM
 *    所以这里**只按解码错误特征匹配**，不做「什么都算永久」的粗暴兜底。
 *
 * 放在这里而不是 worker 入口，是为了能单测：worker 入口 require 即启动进程。
 */
const PERMANENT_IMAGE_ERROR_RE = [
  /unsupported image format/i,
  /Input (file|buffer) contains unsupported/i,
  /VipsJpeg/i,
  /VipsPng/i,
  /VipsForeign/i,
  /Corrupt (JPEG|PNG|image)/i,
  /premature end of data/i,
  /unsupported file type/i,
  /Not a valid/i,
  /VipsError/i,
];

function isPermanentImageError(err) {
  if (!err) return false;
  const msg = `${err.message || ''} ${err.code || ''} ${err.name || ''}`;
  return PERMANENT_IMAGE_ERROR_RE.some(re => re.test(msg));
}

module.exports = {
  predictPlace,
  predictPlaceFull,
  getPlaces365Labels,
  getPlacesSession,
  ensurePlaces365Ready,
  isRemoteModelError,
  isPermanentImageError,
};
