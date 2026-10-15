'use strict';

/**
 * 场景语义搜索 —— 查询解析层（运行时，纯函数 + 一次加载）
 *
 * ⭐ 要解决的问题（铁柱原话）：
 *   「我想要能通过语义来搜索，不是现在这样只能搜出场景，比如我想要 夕阳下的海滩」
 *   现状只能按「场景标签名」子串匹配，用户必须知道相册叫什么才能搜到。
 *
 * ⭐ 为什么是这个架构（2026-10-14 实测决定，证据见 docs/WaterNasOS-场景语义搜索方案.md）：
 *   1) CLIP 词表 49408 个 token 里**没有 CJK**，中文查询直接编码会退化成噪声
 *      （实测「夕阳下的海滩」→ top 全是 壁龛/驾驶舱/小岛，余弦全挤在 0.90~0.95）。
 *   2) 中文经「中文短语 → 英文提示词」翻译后再编码，语义是准的
 *      （"a photo of a beach at sunset." → 海滩 0.951 top-1）。
 *   3) 既然翻译这步无论如何都要做，就在**构建期**把短语嵌入算完
 *      （text 塔 61.5MB 不进运行时包，只发布 ~0.8MB 的 query_embeds.bin）。
 *   4) 实测「短语嵌入加权平均」≈「整句真实编码」（余弦 0.947~0.976，top-1 基本一致），
 *      所以用户自由拼词（"雨天的山村"）也能解析，不必提前穷举所有整句。
 *
 * ⭐ 关键设计：**迟到融合**，而不是先平均再比对。
 *   先平均会把分数压平（无关标签全挤到 0.95+），排名只靠 top-1 撑；
 *   改成「每个短语各自投票，被多个短语同时命中的标签加成」，才有「A 的 B」的 AND 语义。
 *
 * 依赖产物（构建期生成，见 tool/_build_clip_query_lexicon.js）：
 *   onnx_models/clip/query_lexicon.json  短语 → 英文提示词（+可选权威绑定标签）
 *   onnx_models/clip/query_embeds.bin    短语嵌入（N×512，L2 归一化）
 * 标签侧复用 placesClipUtil 已加载的 text_embeds。
 */

const fs = require('fs');
const path = require('path');
const remoteAssets = require('../../../utils/remoteAssetsManager');
const Logger = require('../../../utils/logger');
const placesClipUtil = require('./placesClipUtil');

const CLIP_DIR = () => path.resolve(remoteAssets.resolveOnnxModelsRoot(), 'clip');
const LEXICON_PATH = () => path.resolve(CLIP_DIR(), 'query_lexicon.json');
const EMBEDS_PATH = () => path.resolve(CLIP_DIR(), 'query_embeds.bin');

/** 未命中绑定标签时，用嵌入找最近邻：只保留「与最近邻差距 ≤ 此值」的候选 */
const FALLBACK_SIM_GAP = 0.03;
const FALLBACK_MAX_TAGS = 4;
/** 被多个短语同时命中的标签加成系数（「A 的 B」的 AND 语义） */
const MULTI_HIT_BONUS = 0.35;
/** 查询里的语气词 / 意图词，切词前先剥掉，避免干扰最大匹配 */
const LEADING_NOISE = /^(?:帮我|请|麻烦|我要|我想|想找|找一下|找找|查找|搜索|搜一下|搜索一下|搜|看看|来点|给我|找)+/;
const TRAILING_NOISE = /(?:的照片|的图片|的相片|的照片?|照片|图片|相片|图片集|的图)+$/;

let _ready = null;
let _available = null;
let _entries = [];
let _embeds = null;   // Float32Array(count * dim)
let _qDim = 0;
let _byLen = [];      // 短语按长度降序，供最大匹配

function isAvailable() {
  if (_available !== null) return _available;
  try {
    _available = fs.existsSync(LEXICON_PATH()) && fs.existsSync(EMBEDS_PATH());
  } catch (_) {
    _available = false;
  }
  return _available;
}

function ensureReady() {
  if (_ready) return _ready;
  _ready = (async () => {
    if (!isAvailable()) throw new Error('scene query lexicon not available');
    const meta = JSON.parse(await fs.promises.readFile(LEXICON_PATH(), 'utf8'));
    const entries = Array.isArray(meta.entries) ? meta.entries : [];
    const dim = Number(meta.dim) || 512;
    const buf = await fs.promises.readFile(EMBEDS_PATH());
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    const embeds = new Float32Array(ab);
    if (embeds.length !== entries.length * dim) {
      throw new Error(`scene query embeds size mismatch: ${embeds.length} != ${entries.length * dim}`);
    }
    // 标签侧：复用 CLIP 那套 text_embeds（同一个模型编出来的，同一空间）。
    // 只加载标签表本身（0.7MB），不拉 85MB 视觉塔 —— 搜索不需要跑图。
    await placesClipUtil.ensureTagTable();
    _entries = entries.map(e => ({
      key: String(e.key || '').trim(),
      prompt: String(e.prompt || '').trim(),
      binding: String(e.binding || '').trim(),
    })).filter(e => e.key && e.prompt);
    _embeds = embeds;
    _qDim = dim;
    _byLen = _entries
      .map((e, i) => ({ key: e.key, i }))
      .filter(x => x.key)
      .sort((a, b) => b.key.length - a.key.length);
    Logger.info(`[placesQuery] 语义查询词表就绪：${_entries.length} 条 / dim=${dim}`);
    return true;
  })().catch((err) => { _ready = null; throw err; });
  return _ready;
}

function _normalize(text) {
  let s = String(text == null ? '' : text).trim();
  if (!s) return '';
  // 全角 → 半角（ASCII 区），并统一大小写（英文别名按小写匹配）
  s = s.replace(/[\uFF01-\uFF5E]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
    .replace(/\u3000/g, ' ')
    .toLowerCase();
  s = s.replace(LEADING_NOISE, '').replace(TRAILING_NOISE, '').trim();
  return s;
}

/**
 * 最大匹配切分：从左到右，每次取「当前位置能匹配上的最长短语」。
 * 未被任何短语覆盖的字符记为未识别（用于给用户提示"没听懂这部分"）。
 * @returns {{components: Array<{key:string,index:number}>, unmatched: string[]}}
 */
function segment(query) {
  const q = _normalize(query);
  const components = [];
  const unmatched = [];
  const seen = new Set();
  let i = 0;
  let gap = '';
  while (i < q.length) {
    const ch = q[i];
    // 空白与常见分隔符直接跳过
    if (/[\s,，、。.。!！?？\/|+&;；:：\-_（）()\[\]【】"'"'']/.test(ch)) {
      i += 1;
      continue;
    }
    let hit = null;
    for (const cand of _byLen) {
      if (cand.key.length > q.length - i) continue;
      if (q.startsWith(cand.key, i)) { hit = cand; break; }
    }
    if (hit) {
      if (!seen.has(hit.key)) { seen.add(hit.key); components.push({ key: hit.key, index: hit.i }); }
      // 已覆盖的原始片段若之前有未识别的字符，先输出
      if (gap) { unmatched.push(gap); gap = ''; }
      i += hit.key.length;
    } else {
      gap += ch;
      i += 1;
    }
  }
  if (gap) unmatched.push(gap);
  return { components, unmatched };
}

function _componentWeight(key) {
  // 越长的短语越具体，话语权越大：1 字 1.0 → 6 字及以上 1.6 封顶
  return 1 + Math.min(0.6, Math.max(0, key.length - 1) * 0.2);
}

/** 取短语嵌入 */
function _embAt(idx) {
  const d = _qDim;
  return _embeds.subarray(idx * d, (idx + 1) * d);
}

/**
 * 解析查询 → 候选场景标签（含解释，便于前端展示「已识别：日落 + 海滩」）
 *
 * @param {string} text 用户输入
 * @param {object} [opts]
 * @param {number} [opts.topTags] 最多返回几个标签（默认 8）
 * @returns {{
 *   ok: boolean,
 *   normalized: string,
 *   components: Array<{key:string, binding:string, tag:string, via:'binding'|'embedding'}>,
 *   unmatched: string[],
 *   tags: Array<{label:string, score:number, hits:number, from:string[]}>,
 *   reason?: string
 * }}
 */
function analyze(text, opts = {}) {
  const normalized = _normalize(text);
  if (!normalized) return { ok: false, normalized: '', components: [], unmatched: [], tags: [], reason: 'empty' };
  if (!isAvailable()) return { ok: false, normalized, components: [], unmatched: [], tags: [], reason: 'lexicon_missing' };
  if (!_entries.length) return { ok: false, normalized, components: [], unmatched: [], tags: [], reason: 'not_ready' };

  const labels = placesClipUtil.getLabels();
  const tagEmbeds = placesClipUtil.getTextEmbeds();
  if (!labels || !labels.length || !tagEmbeds) {
    return { ok: false, normalized, components: [], unmatched: [], tags: [], reason: 'tag_table_missing' };
  }
  const dim = placesClipUtil.getDim();
  const labelIndex = new Map();
  for (let i = 0; i < labels.length; i += 1) if (labels[i]) labelIndex.set(String(labels[i]), i);

  const { components, unmatched } = segment(normalized);
  if (!components.length) {
    return { ok: false, normalized, components: [], unmatched, tags: [], reason: 'no_component' };
  }

  /** label -> {score, hits, from:Set} */
  const acc = new Map();
  const addScore = (label, value, fromKey, weight) => {
    if (!label) return;
    let rec = acc.get(label);
    if (!rec) { rec = { label, score: 0, hits: 0, from: new Set(), weight: 0 }; acc.set(label, rec); }
    rec.score += value * weight;
    rec.weight += weight;
    rec.hits += 1;
    rec.from.add(fromKey);
  };

  const resolved = [];
  for (const c of components) {
    const entry = _entries[c.index];
    const weight = _componentWeight(entry.key);
    // 1) 权威绑定优先：命中即直达该标签（比分最近邻更准）。
    //    ⭐ 支持「有序绑定」用 | 分隔（如 猫|宠物特写）：取第一个在当前标签空间里存在的。
    //    为什么需要：实测发现**嵌入回退不可靠** —— 标签空间里没有「猫」时，
    //    "a photo of a cat." 的最近邻是「地下墓穴(0.970)」这种噪声，
    //    因为 CLIP 文本相似度绝对值普遍很高且不具分辨力。
    const bindings = String(entry.binding || '').split('|').map(s => s.trim()).filter(Boolean);
    const hitBinding = bindings.find(b => labelIndex.has(b));
    if (hitBinding) {
      addScore(hitBinding, 1, entry.key, weight);
      resolved.push({ key: entry.key, binding: entry.binding, tag: hitBinding, via: 'binding' });
      continue;
    }
    if (bindings.length) {
      // 声明了绑定但目标都不在标签空间里 ⇒ **宁可不给标签，也不要给个错的**。
      resolved.push({ key: entry.key, binding: entry.binding, tag: '', via: 'binding_unavailable' });
      continue;
    }
    // 2) 本来就没绑定（氛围词 / 抽象词）→ 用短语嵌入找最近邻。
    //    只能按「与最近邻的差距」取舍，不能用绝对阈值（同上的绝对值不可用问题）。
    const qv = _embAt(c.index);
    const scored = [];
    for (let t = 0; t < labels.length; t += 1) {
      if (!labels[t]) continue;
      const base = t * dim;
      let s = 0;
      for (let d = 0; d < dim; d += 1) s += qv[d] * tagEmbeds[base + d];
      scored.push({ label: String(labels[t]), sim: s });
    }
    scored.sort((a, b) => b.sim - a.sim);
    const best = scored.length ? scored[0].sim : 0;
    let picked = 0;
    for (const s of scored) {
      if (picked >= FALLBACK_MAX_TAGS) break;
      if (best - s.sim > FALLBACK_SIM_GAP) break;
      addScore(s.label, s.sim, entry.key, weight);
      picked += 1;
    }
    resolved.push({
      key: entry.key,
      binding: entry.binding || '',
      tag: picked ? scored[0].label : '',
      via: 'embedding',
    });
  }

  const tags = Array.from(acc.values()).map(rec => {
    const base = rec.weight > 0 ? rec.score / rec.weight : 0;
    return {
      label: rec.label,
      score: base * (1 + MULTI_HIT_BONUS * Math.max(0, rec.hits - 1)),
      hits: rec.hits,
      from: Array.from(rec.from),
    };
  }).sort((a, b) => (b.hits - a.hits) || (b.score - a.score))
    .slice(0, Math.max(1, Number(opts.topTags) || 8));

  return { ok: tags.length > 0, normalized, components: resolved, unmatched, tags };
}

/** 仅供测试/调试：重置状态 */
function _reset() { _ready = null; _available = null; _entries = []; _embeds = null; _qDim = 0; _byLen = []; }

module.exports = {
  isAvailable,
  ensureReady,
  analyze,
  segment,
  _normalize,
  _reset,
};
