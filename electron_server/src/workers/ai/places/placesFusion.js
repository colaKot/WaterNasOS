'use strict';

/**
 * 场景识别 v2 —— 决策层（融合 + 开放集门控 + 多标签）
 *
 * ⭐ 这个文件解决的是「根本问题」，不是换模型：
 * 实测（400 张真实照片）证明，ResNet50-Places365 的输出是**极度 hub 化**的 ——
 * 全库 top 标签是 病房 1224 / 荒漠 1008 / 美容院 836 / 育婴室 835，
 * 单张照片上甚至会把「两人餐桌」判成「美容院」并给出高置信度。
 * 这不是模型坏了（同一份模型对雪山/办公室/教堂都判对），而是：
 *   1) 闭集 365 类硬取 top-1，没有「我不知道」这个出口；
 *   2) 每个标签有各自的**系统性打分偏置**，少数"万金油"标签吞掉一切；
 *   3) 单标签输出 —— 一次判错就整张照片消失，没有第二机会。
 *
 * 三条对策，逐条对应：
 *   A. 类先验校正：对每个标签减去它在样本上的均值再除以标准差（z-score）。
 *      实测把 hub 打散：最大单标签占比 5.0% → 3.8%，覆盖 50% 需要 31 → 44 个标签。
 *   B. 开放集门控：置信度 + 与第二名的裕度双重门槛，低于下限标为「未识别」，
 *      不再硬塞一个标签给模型根本没看懂的图。
 *   C. 多标签 + 权重：主标签之外存 top-K 及其权重，界面上保留但降权（铁柱选定）。
 *
 * 融合口径：CLIP 走 z-score 后的 softmax，Places365 走温度标定后的 softmax，
 * 两者按权重线性混合到**统一的标签空间**（中文标签的并集）。
 *
 * 本文件是纯函数，不碰 DB / 模型，便于离线回放验证（见 tool/_scene_replay.js）。
 */

/** 默认参数；生产由 tableConfig 覆盖 */
const DEFAULTS = {
  // 阈值按 400 张真实照片回放出来的权重分位定：p50≈0.22 / p25≈0.14 / p10≈0.10
  highThreshold: 0.20,      // 主标签权重 >= 此值 ⇒ confident
  lowThreshold: 0.10,       // 主标签权重 >= 此值 ⇒ ambiguous，否则 unknown
  marginThreshold: 0.015,   // 主/次权重差 >= 此值才算有分辨力
  topK: 3,                  // 最多保留几个次标签
  altRatio: 0.30,           // 次标签权重 >= 主标签 * 此比例才收录
  clipTemp: 2.0,            // CLIP z-score 的 softmax 温度
  placesTemp: 1.0,          // Places365 校正后分数的 softmax 温度
  // ⭐ 2026-10-14 由 95 张人工标注样本扫出来的：权重在 0.40~1.00 之间 Top-1 基本不变
  // （41~44%，95 样本上差异不到 3 张，不显著）；真正有差别的是 Top-3 与覆盖率。
  // 取 0.55：Top-3 60.0%（v1 仅 53.7%），出标签覆盖 74.7%，unknown 18% 在可接受范围。
  clipWeight: 0.55,
  placesPriorBeta: 1.0,     // Places365 类先验校正强度（1=全减）
  acrossZscore: true,       // 两路分数先归到同一"标准差量纲"再融合（关掉 hub 会回来）
  // ⭐ 2026-10-15「我不知道」出口：由 clipRes.scorableBlocked 驱动（head 缺失时恒为 false）。
  // 关掉它就退回「100% 出标签」的老行为。实现见 placesClipUtil 的 scorable head。
  scorableGate: true,
};

const CALIB_SAMPLE_SIZE = 200;

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

/**
 * 把一组分数在**类间**做 z-score（减均值除标准差）。
 *
 * ⭐ 为什么必须有这一步：Places365 的 softmax 极度尖（一个类能到 0.9），
 * 而 CLIP 的相似度被压得极扁（top1 常只有 0.25）。两者直接按概率线性混合时，
 * ResNet 即使只占 35% 权重，也能凭"尖"把 CLIP 的意见压掉 ——
 * 实测融合后「苔原」这个 hub 标签会重新回升到 7.3%，等于白做。
 * 归到同一"标准差量纲"后，权重才真正代表"话语权"。
 */
function zscoreAcrossClasses(values) {
  const n = values.length;
  let mean = 0;
  for (let i = 0; i < n; i += 1) mean += values[i];
  mean /= n || 1;
  let varSum = 0;
  for (let i = 0; i < n; i += 1) { const d = values[i] - mean; varSum += d * d; }
  const std = Math.sqrt(varSum / (n || 1));
  const inv = std > 1e-6 ? 1 / std : 1;
  for (let i = 0; i < n; i += 1) values[i] = (values[i] - mean) * inv;
  return values;
}

function softmaxInPlace(values, temp) {
  let max = -Infinity;
  for (let i = 0; i < values.length; i += 1) if (values[i] > max) max = values[i];
  let sum = 0;
  for (let i = 0; i < values.length; i += 1) {
    const e = Math.exp((values[i] - max) * temp);
    values[i] = e;
    sum += e;
  }
  if (sum > 0) for (let i = 0; i < values.length; i += 1) values[i] /= sum;
  return values;
}

/**
 * 把 Places365 的 365 类概率合并到中文标签空间。
 * Places365 里 bedchamber 与 bedroom 都译作「卧室」，必须合并，
 * 否则同一场景被拆成多个相册（标签碎片化）。
 * @param {number[]} logits 365 维
 * @param {string[]} labelsZh 365 维中文标签（可能含空串）
 * @param {Float32Array|null} priorMean 365 维类均值（类先验校正用，可为空）
 * @param {number} beta 校正强度
 * @returns {Map<string, number>} 中文标签 → 概率
 */
function placesToLabelProbs(logits, labelsZh, priorMean, beta = 1.0, opts = {}) {
  const n = logits.length;
  const adjusted = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    const logit = Number(logits[i]) || 0;
    const prior = priorMean && priorMean.length === n ? Number(priorMean[i]) || 0 : 0;
    adjusted[i] = logit - beta * prior;
  }
  if (opts.acrossZscore !== false) zscoreAcrossClasses(adjusted);
  softmaxInPlace(adjusted, Number.isFinite(Number(opts.temp)) ? Number(opts.temp) : 1.0);
  const out = new Map();
  for (let i = 0; i < n; i += 1) {
    const label = labelsZh && labelsZh[i] ? String(labelsZh[i]) : '';
    if (!label) continue;
    out.set(label, (out.get(label) || 0) + adjusted[i]);
  }
  return out;
}

/**
 * CLIP 余弦相似度 → 中文标签概率。
 * 用 z-score 做类先验校正：labels 的 mean/std 来自同一批样张的统计。
 * @param {Float32Array|number[]} sims
 * @param {string[]} labels
 * @param {{mean:number[], std:number[]}|null} calib
 * @param {number} temp softmax 温度
 * @returns {Map<string, number>}
 */
function clipToLabelProbs(sims, labels, calib, temp = 2.0, opts = {}) {
  const n = sims.length;
  const z = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    const s = Number(sims[i]) || 0;
    const m = calib && calib.mean && calib.mean.length === n ? Number(calib.mean[i]) || 0 : 0;
    const sd = calib && calib.std && calib.std.length === n ? Number(calib.std[i]) || 0 : 0;
    z[i] = (s - m) / (sd > 1e-6 ? sd : 1e-6);
  }
  if (opts.acrossZscore !== false) zscoreAcrossClasses(z);
  softmaxInPlace(z, Number.isFinite(Number(temp)) ? Number(temp) : 2.0);
  const out = new Map();
  for (let i = 0; i < n; i += 1) {
    const label = labels && labels[i] ? String(labels[i]) : '';
    if (!label) continue;
    out.set(label, (out.get(label) || 0) + z[i]);
  }
  return out;
}

/**
 * 融合两路概率并做开放集门控。
 *
 * @param {object} input
 * @param {Map<string,number>} input.placesProbs
 * @param {Map<string,number>|null} input.clipProbs
 * @param {object} [input.config]
 * @returns {{
 *   status: 'confident'|'ambiguous'|'unknown',
 *   primary: {label:string, weight:number}|null,
 *   alt: Array<{label:string, weight:number}>,
 *   margin: number,
 *   table: Array<{label:string, weight:number, places:number, clip:number}>
 * }}
 */
function fuseAndGate(input) {
  const cfg = Object.assign({}, DEFAULTS, input && input.config ? input.config : {});
  const placesProbs = input && input.placesProbs ? input.placesProbs : new Map();
  const clipProbs = input && input.clipProbs ? input.clipProbs : null;
  const wClip = clipProbs ? clamp(Number(cfg.clipWeight), 0, 1) : 0;
  const wPlaces = 1 - wClip;

  const merged = new Map();
  const add = (label, value, key) => {
    if (!label) return;
    let rec = merged.get(label);
    if (!rec) { rec = { label, places: 0, clip: 0, weight: 0 }; merged.set(label, rec); }
    rec[key] += value;
  };
  for (const [label, p] of placesProbs.entries()) add(label, p, 'places');
  if (clipProbs) for (const [label, p] of clipProbs.entries()) add(label, p, 'clip');

  for (const rec of merged.values()) {
    rec.weight = wPlaces * rec.places + wClip * rec.clip;
  }

  const table = Array.from(merged.values()).sort((a, b) => b.weight - a.weight);
  if (table.length === 0) {
    return { status: 'unknown', primary: null, alt: [], margin: 0, table: [] };
  }

  const primary = table[0];
  const second = table[1] || null;
  const margin = second ? primary.weight - second.weight : primary.weight;

  let status = 'unknown';
  if (primary.weight >= cfg.highThreshold && margin >= cfg.marginThreshold) status = 'confident';
  else if (primary.weight >= cfg.lowThreshold) status = 'ambiguous';

  const altLimit = Math.max(0, Math.min(Number(cfg.topK) || 0, table.length - 1));
  const alt = [];
  for (let i = 1; i <= altLimit; i += 1) {
    const rec = table[i];
    if (!rec) break;
    if (rec.weight < primary.weight * Number(cfg.altRatio)) break;
    alt.push({ label: rec.label, weight: rec.weight });
  }

  return {
    status,
    primary: { label: primary.label, weight: primary.weight },
    alt,
    margin,
    table: table.slice(0, Math.max(1, altLimit + 1)).map(r => ({
      label: r.label, weight: r.weight, places: r.places, clip: r.clip,
    })),
  };
}

/**
 * 标定用：由样本统计每个 CLIP 标签的 mean/std，以及每个 Places365 类的平均 logit。
 * 统计量本身与内容无关，只是"这个标签对任意图都给多少分"的基线。
 * @param {number[][]} simRows 每张图的 CLIP 相似度向量
 * @param {number[][]} logitRows 每张图的 Places365 logits
 */
function buildCalibration(simRows, logitRows) {
  const out = { clip: null, places: null };
  if (Array.isArray(simRows) && simRows.length > 0) {
    const n = simRows.length;
    const dim = simRows[0].length;
    const mean = new Float64Array(dim);
    const std = new Float64Array(dim);
    for (const row of simRows) {
      for (let i = 0; i < dim; i += 1) mean[i] += row[i];
    }
    for (let i = 0; i < dim; i += 1) mean[i] /= n;
    for (const row of simRows) {
      for (let i = 0; i < dim; i += 1) {
        const d = row[i] - mean[i];
        std[i] += d * d;
      }
    }
    for (let i = 0; i < dim; i += 1) {
      std[i] = Math.sqrt(std[i] / n);
      if (!Number.isFinite(std[i])) std[i] = 0;
    }
    out.clip = { mean: Array.from(mean), std: Array.from(std), count: n };
  }
  if (Array.isArray(logitRows) && logitRows.length > 0) {
    const n = logitRows.length;
    const dim = logitRows[0].length;
    const mean = new Float64Array(dim);
    for (const row of logitRows) {
      for (let i = 0; i < dim; i += 1) mean[i] += row[i];
    }
    for (let i = 0; i < dim; i += 1) mean[i] /= n;
    out.places = { mean: Array.from(mean), count: n };
  }
  return out;
}

/**
 * 单张图的完整识别链：Places365 + CLIP → 类先验校正 → 融合门控。
 *
 * 模型调用用**依赖注入**（predictPlaces / scoreClip），这样：
 *   1) 生产 worker 与离线校验脚本调的是同一个函数，行为不会分叉；
 *   2) 以后换模型（DINOv2 / SigLIP2）只要换注入的实现，决策层不用动。
 *
 * @param {object} options
 * @param {string} options.imagePath
 * @param {(imagePath:string)=>Promise<{logits:number[],labelsZh:string[]}>} options.predictPlaces
 * @param {((imagePath:string)=>Promise<{sims:Float32Array|number[],labels:string[]}>|null)} [options.scoreClip]
 * @param {{clip?:object,places?:object}|null} [options.calib]
 * @param {object} [options.config]
 */
async function recognizeScene(options) {
  const opts = options || {};
  const cfg = Object.assign({}, DEFAULTS, opts.config || {});
  const places = await opts.predictPlaces(opts.imagePath);
  const priorMean = opts.calib && opts.calib.places ? opts.calib.places.mean : null;
  const placesProbs = placesToLabelProbs(
    places.logits, places.labelsZh, priorMean, cfg.placesPriorBeta,
    { acrossZscore: cfg.acrossZscore !== false, temp: cfg.placesTemp },
  );

  let clipProbs = null;
  let scorableBlocked = false;
  let scorableScore = null;
  if (typeof opts.scoreClip === 'function') {
    const clipRes = await opts.scoreClip(opts.imagePath);
    if (clipRes && clipRes.sims) {
      clipProbs = clipToLabelProbs(
        clipRes.sims, clipRes.labels,
        opts.calib && opts.calib.clip ? opts.calib.clip : null,
        cfg.clipTemp,
        { acrossZscore: cfg.acrossZscore !== false },
      );
      scorableBlocked = clipRes.scorableBlocked === true;
      scorableScore = Number.isFinite(Number(clipRes.scorableScore))
        ? Number(clipRes.scorableScore)
        : null;
    }
  }

  const fused = fuseAndGate({ placesProbs, clipProbs, config: cfg });

  // ⭐ 2026-10-15「我不知道」出口：head 判定这张照片**不该给场景标签**。
  // 实测（150 张人工标注）：误伤 5% 时可拦下 28% 的人像/合影/静物 ——
  // 而现有 weight 门控方向是反的（−24.6pp），调阈值只会更糟。
  // 拦下时 primary 置 null ⇒ worker 不写任何场景行 ⇒ 照片不进任何场景相册。
  if (cfg.scorableGate !== false && scorableBlocked) {
    return Object.assign({}, fused, {
      status: 'unknown',
      primary: null,
      alt: [],
      blockedByScorable: true,
      scorableScore,
    });
  }
  return Object.assign({}, fused, { blockedByScorable: false, scorableScore });
}

module.exports = {
  DEFAULTS,
  fuseAndGate,
  placesToLabelProbs,
  clipToLabelProbs,
  buildCalibration,
  recognizeScene,
};

