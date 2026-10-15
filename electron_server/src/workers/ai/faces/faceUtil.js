'use strict';

const fs = require('fs');
const path = require('path');
const sharp = require('../../../utils/sharpConfigured');
const onnx = require('onnxruntime-node');
const sharpUtils = require('../../../utils/sharpUtils');
const Logger = require('../../../utils/logger');
const remoteAssets = require('../../../utils/remoteAssetsManager');
const { getBestExecutionProviders, getLoadedBackends } = require('../../../utils/onnxProviderUtil');
try {
  sharp.cache(false);
  sharp.concurrency(1);
} catch (_) {}

// 模型路径配置：默认放在 userData/onnx_models/faces 或安装包 onnx_models/faces。
const MODELS_DIR = () => path.join(remoteAssets.resolveOnnxModelsRoot(), 'faces');
const FACE_LMK_E2E_MODEL_PATH = () => path.join(MODELS_DIR(), 'faceLandMark', 'faceLandMark.onnx');
/**
 * 特征提取模型路径。
 *
 * ⭐ 默认 EdgeFace（Idiap 研究所，BSD-3-Clause，**允许商用**），112x112 输入 / 512 维输出。
 * 旧版本用的是 insightFace 的 ArcFace R50（249MB）：体积大 36 倍、慢 16 倍，
 * 且权重是「仅限非商用研究」许可。这里保留目录探测只是为了能一键回退：
 * 把 insightFace/model.onnx 放回去、删掉 edgeface 目录即可，预处理参数会自动跟着切。
 */
const FACE_FEAT_MODEL_PATH = () => {
  const edgeface = path.join(MODELS_DIR(), 'edgeface', 'model.onnx');
  try {
    if (fs.existsSync(edgeface)) return edgeface;
  } catch (_) {}
  return path.join(MODELS_DIR(), 'insightFace', 'model.onnx');
};

const E2E_INPUT_SIZE = Math.max(256, Number(process.env.FACE_LMK_E2E_INPUT_SIZE ?? 960));
// 检测置信度阈值：低于该 score 的候选框直接丢弃；越高越少误检，但也更容易漏检。
const DET_SCORE_THRESH = Math.max(0, Math.min(1, Number(process.env.FACE_DET_SCORE_THRESH ?? 0.8)));
// 人脸最小尺寸（像素）：过小的人脸通常特征不稳定，容易导致误分类/分裂。
// 该限制基于检测框的 width/height 的较小值。
const FACE_MIN_BOX_SIZE_PX = Math.max(0, Math.min(4096, Number(process.env.FACE_MIN_BOX_SIZE_PX ?? 80)));

// ⭐ 2026-10-13 误检治理（阈值来自真实库统计，见 tool/_diag_face_threshold.py）：
// 真实人脸框宽普遍是图宽的 3%~15%（单脸照片众数 11.9%），而规则纹理误检（条纹/栅格图案）
// 多在 1%~3%。取 1.5% 做下限：只砍掉极小的框，真实人脸误伤约 0.1%。
const FACE_MIN_BOX_WIDTH_RATIO = Math.max(0, Math.min(0.5, Number(process.env.FACE_MIN_BOX_WIDTH_RATIO ?? 0.015)));

// 单图人脸数上限：超过这个数基本是图案误检（真实合影超过 20 人的极少）。
// 真实库里 ≥20 脸的照片仅 64 张，且框宽均值只有 2%~3%；整张丢弃最干净。
const FACE_MAX_FACES_PER_IMAGE = Math.max(0, Math.min(200, Number(process.env.FACE_MAX_FACES_PER_IMAGE ?? 20)));

// 特征提取输入尺寸：EdgeFace 与 insightFace/arcface 都用 112x112 对齐人脸。
const FEAT_INPUT_SIZE = 112;

/**
 * ⭐ 预处理参数按「实际加载的模型」自动选择，避免换了模型却忘了改参数
 * （通道序或归一化不匹配会让相似度明显下降，且很难察觉）。
 *
 *   EdgeFace  : RGB + (x-127.5)/127.5   —— 官方 transforms.Normalize(mean=0.5,std=0.5)
 *   ArcFace   : BGR + (x-127.5)/128.0   —— InsightFace 系惯例
 *
 * 环境变量仍然可以覆盖（用于实验），不给就用模型对应的那套。
 * 实测（33 张真实人脸，同人扰动相似度）：
 *   EdgeFace XS + RGB/127.5 → mean 0.9930 / min 0.9520
 *   ArcFace R50 + BGR/128   → mean 0.9926 / min 0.9281
 */
function _resolveFeatProfile(modelPath) {
  const isEdgeFace = /edgeface/i.test(String(modelPath || ''));
  return isEdgeFace
    ? { order: 'RGB', mean: 127.5, std: 127.5 }
    : { order: 'BGR', mean: 127.5, std: 128.0 };
}

// 下面三个值在 FaceEngine.init() 里按模型确定；这里只给默认值。
let FEAT_MEAN = Number(process.env.FACE_FEAT_MEAN ?? 127.5);
let FEAT_STD = Number(process.env.FACE_FEAT_STD ?? 127.5);
let FEAT_ORDER = (process.env.FACE_FEAT_ORDER || 'RGB').toUpperCase() === 'RGB' ? 'RGB' : 'BGR';
const FEAT_LUMA_NORM_ENABLED = String(process.env.FACE_FEAT_LUMA_NORM ?? '1') !== '0';
const FEAT_LUMA_NORM_MODE = String(process.env.FACE_FEAT_LUMA_NORM_MODE ?? 'MEAN').toUpperCase();
const FEAT_LUMA_TARGET_MEAN = Number(process.env.FACE_FEAT_LUMA_TARGET_MEAN ?? 127.5);
const FEAT_LUMA_TARGET_STD = Number(process.env.FACE_FEAT_LUMA_TARGET_STD ?? 64.0);
const FEAT_LUMA_EPS = Number(process.env.FACE_FEAT_LUMA_EPS ?? 1e-6);

function createSharpFromConverted(converted) {
  if (converted && typeof converted === 'object' && !Buffer.isBuffer(converted) && converted.input && converted.options) {
    return sharp(converted.input, converted.options);
  }
  return sharp(converted);
}

function bgrToRgbUint8(data) {
  if (!data || data.length % 3 !== 0) return null;
  const out = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i += 3) {
    out[i] = data[i + 2];
    out[i + 1] = data[i + 1];
    out[i + 2] = data[i];
  }
  return out;
}

function rgbToBgrInplace(data) {
  if (!data || data.length % 3 !== 0) return null;
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  for (let i = 0; i < buf.length; i += 3) {
    const r = buf[i];
    buf[i] = buf[i + 2];
    buf[i + 2] = r;
  }
  return buf;
}

function _clampUint8(v) {
  if (v <= 0) return 0;
  if (v >= 255) return 255;
  return v & 255;
}

function lumaNormalizeRgbInplace(rgb, mode, targetMean, targetStd, eps) {
  if (!rgb || rgb.length % 3 !== 0) return rgb;
  const buf = Buffer.isBuffer(rgb) ? rgb : Buffer.from(rgb);
  const pixels = buf.length / 3;
  if (!pixels) return buf;

  let sum = 0;
  let sum2 = 0;
  let minY = 255;
  let maxY = 0;
  for (let i = 0; i < buf.length; i += 3) {
    const r = buf[i];
    const g = buf[i + 1];
    const b = buf[i + 2];
    const y = 0.299 * r + 0.587 * g + 0.114 * b;
    sum += y;
    sum2 += y * y;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }

  const meanY = sum / pixels;
  const safeEps = Number.isFinite(eps) && eps > 0 ? eps : 1e-6;
  let scale = 1;
  let offset = (Number.isFinite(targetMean) ? targetMean : 127.5) - meanY;

  const m = String(mode || '').toUpperCase();
  if (m === 'MEAN_STD') {
    const varY = Math.max(0, sum2 / pixels - meanY * meanY);
    const stdY = Math.sqrt(varY);
    const tStd = Number.isFinite(targetStd) && targetStd > 0 ? targetStd : 64.0;
    scale = tStd / (stdY + safeEps);
    offset = (Number.isFinite(targetMean) ? targetMean : 127.5) - scale * meanY;
  } else if (m === 'MINMAX') {
    const range = maxY - minY;
    if (range > safeEps) {
      scale = 255 / range;
      offset = -minY * scale;
    }
  }

  if (!Number.isFinite(scale) || !Number.isFinite(offset) || (scale === 1 && offset === 0)) return buf;

  for (let i = 0; i < buf.length; i++) {
    const v = Math.round(buf[i] * scale + offset);
    buf[i] = _clampUint8(v);
  }
  return buf;
}

function chwFromHwcUint8(data, h, w, order, mean, std, scale) {
  const hw = h * w;
  const out = new Float32Array(3 * hw);
  for (let i = 0; i < hw; i++) {
    const r = data[i * 3];
    const g = data[i * 3 + 1];
    const b = data[i * 3 + 2];
    const ch = order === 'BGR' ? [b, g, r] : [r, g, b];
    out[i] = (ch[0] * scale - mean[0]) / std[0];
    out[i + hw] = (ch[1] * scale - mean[1]) / std[1];
    out[i + 2 * hw] = (ch[2] * scale - mean[2]) / std[2];
  }
  return out;
}

function safeExtractBox(box, width, height) {
  const left = Math.max(0, Math.floor(box.left));
  const top = Math.max(0, Math.floor(box.top));
  const right = Math.min(width, Math.ceil(box.left + box.width));
  const bottom = Math.min(height, Math.ceil(box.top + box.height));
  const w = right - left;
  const h = bottom - top;
  if (w <= 1 || h <= 1) return null;
  return { left, top, width: w, height: h };
}

function isFaceBoxAcceptable(box, rotatedMeta) {
  if (!box || !rotatedMeta) return false;
  const ow = Number(rotatedMeta.ow) || 0;
  const oh = Number(rotatedMeta.oh) || 0;
  if (!ow || !oh) return false;
  const w = Number(box.width) || 0;
  const h = Number(box.height) || 0;
  if (!(w > 1 && h > 1)) return false;
  const minSide = Math.min(w, h);
  if (FACE_MIN_BOX_SIZE_PX > 0 && minSide < FACE_MIN_BOX_SIZE_PX) return false;
  // 相对图宽的下限：过滤「整张纹理里找到的极小伪脸」
  if (FACE_MIN_BOX_WIDTH_RATIO > 0 && ow > 0) {
    const ratio = Math.max(w, h) / Math.max(1, ow);
    if (ratio < FACE_MIN_BOX_WIDTH_RATIO) return false;
  }
  return true;
}

function normalizeL2(vec) {
  let sum = 0;
  for (let i = 0; i < vec.length; i++) sum += vec[i] * vec[i];
  const norm = Math.sqrt(sum) || 1;
  const out = new Float32Array(vec.length);
  for (let i = 0; i < vec.length; i++) out[i] = vec[i] / norm;
  return out;
}

function getNumericVal(arr, idx) {
  const val = arr[idx];
  return typeof val === 'bigint' ? Number(val) : val;
}

function bufferToFloat32(buf) {
  if (!buf || buf.length % 4 !== 0) return null;
  const view = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  return new Float32Array(view);
}

function float32ToBuffer(arr) {
  const f = arr instanceof Float32Array ? arr : new Float32Array(arr);
  return Buffer.from(f.buffer, f.byteOffset, f.byteLength);
}

function _toFinitePositiveInt(v, fallback = 0) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

function _dimIsThree(dim) {
  if (dim === 3) return true;
  if (typeof dim === 'bigint') return Number(dim) === 3;
  if (typeof dim === 'string') return Number(dim) === 3;
  return false;
}

function _hwcBgrToChwUint8(bgr, h, w) {
  const hh = _toFinitePositiveInt(h);
  const ww = _toFinitePositiveInt(w);
  const hw = hh * ww;
  const expected = hw * 3;
  if (!bgr || bgr.length !== expected) {
    throw new Error(`bad bgr buffer length, got=${bgr ? bgr.length : 0}, expected=${expected}`);
  }
  const out = new Uint8Array(expected);
  for (let i = 0; i < hw; i++) {
    const base = i * 3;
    out[i] = bgr[base];
    out[i + hw] = bgr[base + 1];
    out[i + 2 * hw] = bgr[base + 2];
  }
  return out;
}

function _hwcBgrToChwFloat32(bgr, h, w) {
  const hh = _toFinitePositiveInt(h);
  const ww = _toFinitePositiveInt(w);
  const hw = hh * ww;
  const expected = hw * 3;
  if (!bgr || bgr.length !== expected) {
    throw new Error(`bad bgr buffer length, got=${bgr ? bgr.length : 0}, expected=${expected}`);
  }
  const out = new Float32Array(expected);
  for (let i = 0; i < hw; i++) {
    const base = i * 3;
    out[i] = bgr[base];
    out[i + hw] = bgr[base + 1];
    out[i + 2 * hw] = bgr[base + 2];
  }
  return out;
}

function _hwcBgrToHwcFloat32(bgr, h, w) {
  const hh = _toFinitePositiveInt(h);
  const ww = _toFinitePositiveInt(w);
  const expected = hh * ww * 3;
  if (!bgr || bgr.length !== expected) {
    throw new Error(`bad bgr buffer length, got=${bgr ? bgr.length : 0}, expected=${expected}`);
  }
  const out = new Float32Array(expected);
  for (let i = 0; i < expected; i++) out[i] = bgr[i];
  return out;
}

function _getFirstName(arr, fallback) {
  if (Array.isArray(arr) && arr.length > 0 && arr[0]) return String(arr[0]);
  return fallback;
}

function _pickFeatOutputName(sess) {
  if (!sess) return null;
  const names = Array.isArray(sess.outputNames) ? sess.outputNames : [];
  if (names.includes('1333')) return '1333';
  return _getFirstName(names, null);
}

function _roundUpToMultiple(v, m) {
  const n = Math.max(0, Math.floor(Number(v) || 0));
  const mm = Math.max(1, Math.floor(Number(m) || 1));
  return Math.ceil(n / mm) * mm;
}

function _buildAlignInputTensor(sess, bgr, info, inputName) {
  const h = _toFinitePositiveInt(info && info.height ? info.height : 0);
  const w = _toFinitePositiveInt(info && info.width ? info.width : 0);
  if (!h || !w) throw new Error(`bad input image shape, h=${h}, w=${w}`);

  const meta = sess && sess.inputMetadata && inputName ? sess.inputMetadata[inputName] : null;
  const metaType = meta && meta.type ? String(meta.type) : 'uint8';
  const dimsTemplate = meta && Array.isArray(meta.dimensions) ? meta.dimensions : null;
  const dimsLen = dimsTemplate ? dimsTemplate.length : 0;

  let layout = 'HWC';
  if (dimsLen === 4) {
    layout = _dimIsThree(dimsTemplate[1]) ? 'NCHW' : 'NHWC';
  } else if (dimsLen === 3) {
    layout = _dimIsThree(dimsTemplate[0]) ? 'CHW' : 'HWC';
  }

  let tensorType = metaType;
  if (!['uint8', 'float32'].includes(tensorType)) tensorType = 'uint8';

  let data = null;
  let dims = null;

  if (layout === 'NCHW') {
    dims = [1, 3, h, w];
    data = tensorType === 'float32' ? _hwcBgrToChwFloat32(bgr, h, w) : _hwcBgrToChwUint8(bgr, h, w);
  } else if (layout === 'CHW') {
    dims = [3, h, w];
    data = tensorType === 'float32' ? _hwcBgrToChwFloat32(bgr, h, w) : _hwcBgrToChwUint8(bgr, h, w);
  } else {
    // NHWC or HWC
    dims = layout === 'NHWC' ? [1, h, w, 3] : [h, w, 3];
    if (tensorType === 'float32') {
      data = _hwcBgrToHwcFloat32(bgr, h, w);
    } else {
      // Validate buffer length for uint8 HWC/NHWC
      const expected = h * w * 3;
      if (!bgr || bgr.length !== expected) {
        throw new Error(`bad bgr buffer length for ${layout}, got=${bgr ? bgr.length : 0}, expected=${expected}`);
      }
      data = bgr;
    }
  }

  const tensor = new onnx.Tensor(tensorType, data, dims);
  return {
    tensor,
    debug: {
      inputName,
      metaType,
      tensorType,
      layout,
      dims,
      bufferLength: bgr ? bgr.length : 0,
      expectedLength: h * w * 3,
      isBuffer: Buffer.isBuffer(bgr),
    },
  };
}

class FaceEngine {
  constructor() {
    this._sessions = null;
    this._alignInputName = null;
    this._featInputName = null;
    this._featOutputName = null;
  }

  dispose() {
    const sess = this._sessions;
    this._sessions = null;
    this._alignInputName = null;
    this._featInputName = null;
    this._featOutputName = null;
    if (!sess) return;
    try {
      if (sess.align && typeof sess.align.release === 'function') sess.align.release();
    } catch {}
    try {
      if (sess.feat && typeof sess.feat.release === 'function') sess.feat.release();
    } catch {}
  }

  async init() {
    if (this._sessions) return;
    // ⚠️ 这里以前硬编码 ['cpu']，而 placesUtil / ocrOnnxUtil 早就用
    // getBestExecutionProviders() 了 —— 三处不一致，人脸是唯一没吃上 GPU 的。
    // 本机实测（onnxruntime-node 1.20.0 + DirectML）：
    //   EdgeFace XS 单张推理  CPU ~2.8ms  → DML 更快
    //   （旧 ArcFace R50 参考值：CPU 52.7ms → DML 24.7ms，快 2.1 倍）
    // 但 DML 首次建会话要多花约 1.2s，且在「无独立/核显驱动异常」的机器上可能直接抛异常。
    // ⇒ 优先 GPU，失败自动退回纯 CPU，绝不让 AI 功能整体挂掉。
    const buildSessions = async (providers) => {
      const sessionOptions = {
        executionProviders: providers,
        enableCpuMemArena: false,
        enableMemPattern: false,
        graphOptimizationLevel: 'all',
      };
      const [align, feat] = await Promise.all([
        onnx.InferenceSession.create(FACE_LMK_E2E_MODEL_PATH(), sessionOptions),
        onnx.InferenceSession.create(FACE_FEAT_MODEL_PATH(), sessionOptions),
      ]);
      return { align, feat, sessionOptions };
    };

    let loaded = null;
    const wanted = getBestExecutionProviders();
    if (wanted.length > 1) {
      try {
        loaded = await buildSessions(wanted);
      } catch (e) {
        Logger.warn(`[faceUtil] GPU providers failed (${wanted.join(',')}), fallback to CPU: ${e && e.message ? e.message : e}`);
        loaded = null;
      }
    }
    if (!loaded) {
      loaded = await buildSessions(['cpu']);
    }

    const { align, feat, sessionOptions } = loaded;
    this._sessions = { align, feat };

    // ⭐ 预处理参数跟着实际加载的特征模型走（EdgeFace=RGB/127.5，ArcFace=BGR/128）。
    // 环境变量显式给了就尊重环境变量，否则按模型自动选。
    const featPath = FACE_FEAT_MODEL_PATH();
    const profile = _resolveFeatProfile(featPath);
    if (process.env.FACE_FEAT_ORDER === undefined) FEAT_ORDER = profile.order;
    if (process.env.FACE_FEAT_MEAN === undefined) FEAT_MEAN = profile.mean;
    if (process.env.FACE_FEAT_STD === undefined) FEAT_STD = profile.std;

    Logger.info(`[faceUtil] Selected providers: ${sessionOptions.executionProviders.join(', ')}`);
    Logger.info(`[faceUtil] Loaded backends: ${getLoadedBackends()}`);
    Logger.info(`[faceUtil] Feature model: ${path.basename(path.dirname(featPath))} (${FEAT_ORDER}, mean=${FEAT_MEAN}, std=${FEAT_STD})`);
    this._alignInputName = _getFirstName(align && align.inputNames ? align.inputNames : null, 'input');
    this._featInputName = _getFirstName(feat && feat.inputNames ? feat.inputNames : null, 'input.1');
    this._featOutputName = _pickFeatOutputName(feat);

    try {

      if (align && align.inputMetadata && this._alignInputName && align.inputMetadata[this._alignInputName]) {
        Logger.info(`🧠 align input meta: ${JSON.stringify(align.inputMetadata[this._alignInputName])}`);
      }
      if (feat && feat.inputMetadata && this._featInputName && feat.inputMetadata[this._featInputName]) {
        Logger.info(`🧠 feat input meta: ${JSON.stringify(feat.inputMetadata[this._featInputName])}`);
      }
    } catch {}
  }

  async _preprocessE2E(imagePath) {
    const converted = await sharpUtils.transSpcielFormat(imagePath);
    const rotated = createSharpFromConverted(converted).rotate();
    const meta = await rotated.metadata();
    const orientedWidth = meta && meta.autoOrient ? Number(meta.autoOrient.width) || 0 : 0;
    const orientedHeight = meta && meta.autoOrient ? Number(meta.autoOrient.height) || 0 : 0;
    const ow = orientedWidth || Number(meta.width) || 0;
    const oh = orientedHeight || Number(meta.height) || 0;
    if (!ow || !oh) throw new Error('bad image metadata');
    const targetSize = Math.max(256, Math.min(E2E_INPUT_SIZE, _roundUpToMultiple(Math.max(ow, oh), 32)));
    const scale = Math.min(1, targetSize / ow, targetSize / oh);
    const newW = Math.max(1, Math.round(ow * scale));
    const newH = Math.max(1, Math.round(oh * scale));
    const padW = targetSize - newW;
    const padH = targetSize - newH;
    const padX = Math.floor(padW / 2);
    const padY = Math.floor(padH / 2);
    const padRight = padW - padX;
    const padBottom = padH - padY;
    const { data, info } = await rotated
      .clone()
      .resize(newW, newH, { fit: 'fill', kernel: sharp.kernel.cubic })
      .extend({ top: padY, bottom: padBottom, left: padX, right: padRight, background: { r: 0, g: 0, b: 0, alpha: 1 } })
      .toColorspace('srgb')
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    // 强制检查 buffer 长度是否符合预期 (h * w * 3)
    const expected = info.height * info.width * 3;
    if (data.length !== expected) {
      throw new Error(`preprocess buffer mismatch: got ${data.length}, expected ${expected} (h=${info.height}, w=${info.width}, c=3)`);
    }

    const bgr = rgbToBgrInplace(data);
    if (!bgr) throw new Error('bad e2e preprocess buffer');
    return { rotatedMeta: { ow, oh }, tensorInfo: { bgr, info }, affine: { scale, padX, padY, targetSize } };
  }

  _postprocessE2E(results, affine, rotatedMeta) {
    const bboxes = results && results.bboxes ? results.bboxes : null;
    const scores = results && results.scores ? results.scores : null;
    const alignImgs = results && results.align_imgs ? results.align_imgs : null;
    if (!bboxes || !bboxes.dims || bboxes.dims.length < 2) return [];
    const numFaces = Number(bboxes.dims[0]) || 0;
    if (!numFaces) return [];
    const faces = [];
    const padX = Number(affine && affine.padX ? affine.padX : 0) || 0;
    const padY = Number(affine && affine.padY ? affine.padY : 0) || 0;
    const scale = Number(affine && affine.scale ? affine.scale : 1) || 1;
    const alignW = alignImgs && alignImgs.dims && alignImgs.dims.length >= 4 ? Number(alignImgs.dims[1]) || 224 : 224;
    const alignH = alignImgs && alignImgs.dims && alignImgs.dims.length >= 4 ? Number(alignImgs.dims[2]) || 224 : 224;
    const alignC = alignImgs && alignImgs.dims && alignImgs.dims.length >= 4 ? Number(alignImgs.dims[3]) || 3 : 3;
    const alignSize = alignW * alignH * alignC;

    for (let i = 0; i < numFaces; i++) {
      const scoreRaw = scores && scores.data ? getNumericVal(scores.data, i) : 0;
      const score = Number(scoreRaw) || 0;
      if (!Number.isFinite(score) || score < DET_SCORE_THRESH) continue;

      const x1 = Number((getNumericVal(bboxes.data, i * 4 + 0) - padX) / scale) || 0;
      const y1 = Number((getNumericVal(bboxes.data, i * 4 + 1) - padY) / scale) || 0;
      const x2 = Number((getNumericVal(bboxes.data, i * 4 + 2) - padX) / scale) || 0;
      const y2 = Number((getNumericVal(bboxes.data, i * 4 + 3) - padY) / scale) || 0;
      const safe = safeExtractBox({ left: x1, top: y1, width: x2 - x1, height: y2 - y1 }, rotatedMeta.ow, rotatedMeta.oh);
      if (!safe) continue;
      if (!isFaceBoxAcceptable(safe, rotatedMeta)) continue;

      let alignedImage = null;
      if (alignImgs && alignImgs.data && alignImgs.data.length >= (i + 1) * alignSize) {
        const start = i * alignSize;
        const end = start + alignSize;
        alignedImage = alignImgs.data.slice(start, end);
      }

      faces.push({ box: { ...safe, score }, alignedImage, alignSize: { w: alignW, h: alignH, c: alignC } });
    }
    return faces;
  }

  async detectFaces(imagePath) {
    await this.init();
    let preprocess = await this._preprocessE2E(imagePath);
    const { rotatedMeta, tensorInfo, affine } = preprocess;

    let inputTensor = null;
    let out = null;
    try {
      const built = _buildAlignInputTensor(this._sessions.align, tensorInfo.bgr, tensorInfo.info, this._alignInputName);
      inputTensor = built.tensor;
      let startTime = Date.now();
      out = await this._sessions.align.run({ [this._alignInputName]: inputTensor });
      const memoryAfter = process.memoryUsage();
      // console.log('Face推理后堆内存：', (memoryAfter.heapUsed / 1024 / 1024).toFixed(2), 'mb', '总计可用', (memoryAfter.heapTotal / 1024 / 1024).toFixed(2), 'mb');
      // console.log('Face推理耗时：', Date.now() - startTime, 'ms');
    } catch (err) {
      console.error('❌ onnx align run error:', err);
      throw err;
    } finally {
      if (inputTensor) {
        try {
          inputTensor.dispose();
        } catch {}
        inputTensor = null;
      }
      if (preprocess && preprocess.tensorInfo) {
        preprocess.tensorInfo.bgr = null;
      }
      preprocess = null;
    }

    let faces = [];
    try {
      faces = this._postprocessE2E(out, affine, rotatedMeta);
    } finally {
      if (out != null) {
        try {
          Object.values(out).forEach(tensor => tensor.dispose());
        } catch {}
        out = null;
      }
    }

    return { rotatedMeta, faces };
  }

  async _extractAlignedFace112(face) {
    const alignedRaw = face && face.alignedImage ? face.alignedImage : null;
    const alignSize = face && face.alignSize ? face.alignSize : null;
    const aw = alignSize && Number(alignSize.w) ? Number(alignSize.w) : 224;
    const ah = alignSize && Number(alignSize.h) ? Number(alignSize.h) : 224;
    const ac = alignSize && Number(alignSize.c) ? Number(alignSize.c) : 3;
    if (!alignedRaw || alignedRaw.length < aw * ah * ac || ac !== 3) return null;

    const rgb224 = bgrToRgbUint8(alignedRaw);
    if (!rgb224) return null;
    const aligned = sharp(rgb224, { raw: { width: aw, height: ah, channels: 3 } });
    let data;
    let info;
    try {
      ({ data, info } = await aligned.clone().resize(FEAT_INPUT_SIZE, FEAT_INPUT_SIZE, { fit: 'cover', kernel: sharp.kernel.cubic }).raw().toBuffer({ resolveWithObject: true }));
    } catch {
      ({ data, info } = await aligned
        .clone()
        .resize(FEAT_INPUT_SIZE, FEAT_INPUT_SIZE, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 1 }, kernel: sharp.kernel.cubic })
        .raw()
        .toBuffer({ resolveWithObject: true }));
    }
    const rgb112 = data;
    if (FEAT_LUMA_NORM_ENABLED) {
      lumaNormalizeRgbInplace(rgb112, FEAT_LUMA_NORM_MODE, FEAT_LUMA_TARGET_MEAN, FEAT_LUMA_TARGET_STD, FEAT_LUMA_EPS);
    }
    const mean = [FEAT_MEAN, FEAT_MEAN, FEAT_MEAN];
    const std = [FEAT_STD, FEAT_STD, FEAT_STD];
    const chw = chwFromHwcUint8(rgb112, info.height, info.width, FEAT_ORDER, mean, std, 1);
    return { chw };
  }

  async extractFaceFeatures(imagePath) {
    await this.init();
    if (!imagePath || !fs.existsSync(imagePath)) return [];
    const { rotatedMeta, faces } = await this.detectFaces(imagePath);
    if (!faces || faces.length === 0) return [];
    // ⭐ 2026-10-13：单图脸数超上限 ⇒ 判定为图案误检，整张丢弃（不做部分保留，
    // 部分保留反而会造出一堆只含误检的「人脸相册」）。
    if (FACE_MAX_FACES_PER_IMAGE > 0 && faces.length > FACE_MAX_FACES_PER_IMAGE) {
      Logger.info(
        `⚠️ 疑似误检图案，整张丢弃：faces=${faces.length} > ${FACE_MAX_FACES_PER_IMAGE}`
      );
      return [];
    }
    const results = [];
    for (const face of faces) {
      const box = face && face.box ? face.box : null;
      if (!box) continue;
      if (!isFaceBoxAcceptable(box, rotatedMeta)) continue;
      let aligned;
      try {
        aligned = await this._extractAlignedFace112(face);
      } catch (err) {
        Logger.error('❌ Align face extract error:', err);
        aligned = null;
      }
      if (!aligned) continue;

      let featInput = null;
      let out = null;
      let emb = null;

      try {
        featInput = new onnx.Tensor('float32', aligned.chw, [1, 3, FEAT_INPUT_SIZE, FEAT_INPUT_SIZE]);
        const featInputName = this._featInputName || 'input.1';
        out = await this._sessions.feat.run({ [featInputName]: featInput });
        const outName = this._featOutputName || '1333';
        const vec = out && out[outName] && out[outName].data ? out[outName].data : null;
        if (vec && vec.length === 512) {
          emb = normalizeL2(vec);
        }
      } catch (err) {
        Logger.error('❌ Face feature extract error:', err);
      } finally {
        // 确保释放 featInput
        if (featInput) {
          try {
            featInput.dispose();
          } catch (e) {}
          featInput = null;
        }
        // 确保释放 out
        if (out) {
          try {
            Object.values(out).forEach(tensor => tensor.dispose());
          } catch (e) {}
          out = null;
        }
        // 释放 aligned 数据引用
        if (aligned) {
          aligned.chw = null;
          aligned = null;
        }
      }

      if (!emb) continue;
      const quality = Math.max(0, Math.min(100, Math.round((Number(box.score) || 0) * 100)));

      results.push({
        box,
        feature: emb,
        qualityScore: quality,
      });
    }
    return results;
  }
}

let singleton = null;
async function getFaceEngine() {
  if (singleton) return singleton;
  await remoteAssets.ensureBundle('onnx_models.faces');
  const eng = new FaceEngine();
  await eng.init();
  singleton = eng;
  return singleton;
}

/* ============================================================================
 * ⭐ 2026-10-14 聚类决策层（纯函数，不碰 DB / 模型，可离线单测）
 *
 * 背景（用户反馈「好多人的人脸混在了一起」）：原有实现有三处会在样本一多时
 * 把不同的人并到一组，全部集中在决策层，与模型精度无关：
 *   1) 只要「最近的原型」相似度 >= 阈值就认领，不看第二名有多近 ——
 *      两个人的原型都在阈值上方时，采样噪声就能把人判给错的那个；
 *   2) 原型权重里有个「多样性因子」：与近期样本**越不像**权重越大（最高 1.4×），
 *      方向正好相反 —— 它主动把最可疑（最不像本人）的样本拉进原型，
 *      让原型慢慢漂移到别人身上，再吸进更多人（hub 形成的主因之一）；
 *   3) 二次合并按相似度排序后贪心合并，没有传递性约束：
 *      A~B、B~C 就会把 A/B/C 三个人并成一组。
 * 下面三个函数分别给这三处提供可测的判定，调用点在 faceWorker.js。
 * ========================================================================== */

/** 与近期样本的相似度高于此值时，认为该样本是「本人同一种姿态/光照下的重复」*/
const PROTO_RECENT_HIGH_SIM = 0.95;
/** 新颖样本对原型拉扯的最大衰减（0.4 ⇒ 权重最低降到基准的 60%）*/
const PROTO_NOVELTY_DAMP_MAX = 0.4;

/**
 * 原型更新权重因子。
 *
 * ⭐ 方向必须是「越不像本人的样本，越不许拉扯原型」。
 * 返回区间 [1 - DAMP_MAX, 1]，**永不放大**。
 * @param {number} maxSimToRecent 该样本与原型近期样本的最大余弦相似度；无历史时传 null
 */
function protoWeightFactor(maxSimToRecent) {
  // ⚠️ null/undefined 表示「没有近期样本」，不能走 Number()（Number(null) === 0）
  if (maxSimToRecent === null || maxSimToRecent === undefined) return 1;
  const s = Number(maxSimToRecent);
  if (!Number.isFinite(s)) return 1;
  const novelty = Math.max(0, Math.min(1, (PROTO_RECENT_HIGH_SIM - s) / 0.25));
  return 1 - PROTO_NOVELTY_DAMP_MAX * novelty;
}

/**
 * 维护「按根人脸去重的 top2 相似度」小表。
 * 同一个根人脸（同一人物分组）只保留最高分，避免同一组内的多个原型把第二名位置占掉，
 * 导致「第二名」其实是同一个人，二义性判定失真。
 *
 * @param {Array<{rootId:number, sim:number}>} top 长度 <= 2、按 sim 降序、rootId 互不相同
 * @param {number} rootId
 * @param {number} sim
 * @returns {Array<{rootId:number, sim:number}>} 原地更新后的 top（便于链式使用）
 */
function pushTopRoot(top, rootId, sim) {
  const r = Number(rootId) || 0;
  const s = Number(sim);
  if (!Array.isArray(top) || !Number.isFinite(s)) return top;
  let hit = null;
  for (const t of top) {
    if (Number(t.rootId) === r) { hit = t; break; }
  }
  if (hit) {
    if (s <= hit.sim) return top;
    hit.sim = s;
  } else {
    top.push({ rootId: r, sim: s });
  }
  top.sort((a, b) => b.sim - a.sim);
  if (top.length > 2) top.length = 2;
  return top;
}

/**
 * 认领判定：最近原型是否足够可信。
 *
 * 规则：
 *  - bestSim < req                       ⇒ 拒绝（新建一个人脸组）
 *  - bestSim - secondSim < margin        ⇒ 拒绝（两个人难以区分，宁可分不可误合）
 *  - 其余                                ⇒ 接受
 * secondSim 用 -Infinity / null 表示「只有一个人脸组」。
 *
 * @param {{bestSim:number, secondSim:number, req:number, margin:number}} p
 * @returns {{accepted:boolean, ambiguous:boolean, gap:number}}
 */
function decideFaceAssignment(p) {
  const o = p || {};
  const best = Number(o.bestSim);
  const req = Number(o.req);
  const margin = Math.max(0, Number(o.margin) || 0);
  if (!Number.isFinite(best) || !Number.isFinite(req) || best < req) {
    return { accepted: false, ambiguous: false, gap: NaN };
  }
  const second = Number(o.secondSim);
  const gap = Number.isFinite(second) ? best - second : Infinity;
  const ambiguous = gap < margin;
  return { accepted: !ambiguous, ambiguous, gap };
}

/**
 * 二次合并的选择器：从候选相似度对里挑出「本轮真正要合并的」。
 *
 * 两条护栏，都是为了掐掉链式合并：
 *  1) **互为最近邻**（requireMutual，默认开）：只有 b 是 a 的最佳伙伴、且 a 也是 b 的最佳伙伴
 *     才允许合并。A~B、B~C 这种「桥」无法同时满足两边，于是不会把三个人串起来；
 *  2) **本轮一对一匹配**：每个人脸本轮最多参与一次合并，A 不会被并进 B 又并进 C。
 *     同一人物的多个碎片会在后续维护轮次里逐轮收敛（每轮至少消掉一半）。
 *
 * @param {Array<{a:number,b:number,sim:number,simBest:number,countA:number,countB:number,timeOk?:boolean}>} pairs
 * @param {object} [opts]
 * @param {number} [opts.limit] 本轮最多合并几对
 * @param {boolean} [opts.requireMutual] 是否要求互为最近邻（默认 true）
 * @param {Array<{name?:string, match:(p:object)=>boolean}>} [opts.tiers]
 *        按顺序尝试的「档位」，每档只处理还没被占用的人脸（对应原有「先合并小分组，再常规，再严格」）
 * @returns {Array<{keepId:number, dropId:number, a:number, b:number, score:number, tier:string}>}
 */
function selectMergePairs(pairs, opts = {}) {
  const limit = Math.max(0, Number(opts.limit) || 0);
  const requireMutual = opts.requireMutual !== false;
  const tiers = Array.isArray(opts.tiers) && opts.tiers.length > 0
    ? opts.tiers
    : [{ name: 'all', match: () => true }];

  const list = [];
  for (const raw of Array.isArray(pairs) ? pairs : []) {
    if (!raw) continue;
    const a = Number(raw.a) || 0;
    const b = Number(raw.b) || 0;
    if (!a || !b || a === b) continue;
    const sim = Number(raw.sim);
    const simBest = Number(raw.simBest);
    const score = Math.max(Number.isFinite(sim) ? sim : -1, Number.isFinite(simBest) ? simBest : -1);
    list.push({
      a, b, sim, simBest, score,
      countA: Math.max(0, Number(raw.countA) || 0),
      countB: Math.max(0, Number(raw.countB) || 0),
      timeOk: raw.timeOk === undefined ? true : !!raw.timeOk,
    });
  }
  if (list.length === 0 || limit === 0) return [];

  // 每个人的最佳伙伴（按 score）
  const bestPartner = new Map();
  for (const p of list) {
    const cur1 = bestPartner.get(p.a);
    if (!cur1 || p.score > cur1.score) bestPartner.set(p.a, { other: p.b, score: p.score });
    const cur2 = bestPartner.get(p.b);
    if (!cur2 || p.score > cur2.score) bestPartner.set(p.b, { other: p.a, score: p.score });
  }

  const used = new Set();
  const out = [];
  for (const tier of tiers) {
    if (out.length >= limit) break;
    const match = typeof tier.match === 'function' ? tier.match : () => true;
    const cands = list
      .filter(p => !used.has(p.a) && !used.has(p.b) && match(p))
      .filter(p => {
        if (!requireMutual) return true;
        const pa = bestPartner.get(p.a);
        const pb = bestPartner.get(p.b);
        return !!pa && !!pb && pa.other === p.b && pb.other === p.a;
      })
      .sort((x, y) => y.score - x.score);
    for (const p of cands) {
      if (out.length >= limit) break;
      if (used.has(p.a) || used.has(p.b)) continue;
      const keepId = p.countA >= p.countB ? p.a : p.b;
      const dropId = keepId === p.a ? p.b : p.a;
      used.add(p.a);
      used.add(p.b);
      out.push({
        keepId, dropId, a: p.a, b: p.b, score: p.score,
        tier: tier.name || 'tier',
      });
    }
  }
  return out;
}

module.exports = {
  getFaceEngine,
  bufferToFloat32,
  float32ToBuffer,
  normalizeL2,
  // 聚类决策层（纯函数）
  protoWeightFactor,
  pushTopRoot,
  decideFaceAssignment,
  selectMergePairs,
};
