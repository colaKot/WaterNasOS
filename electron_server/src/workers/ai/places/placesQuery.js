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

// ============================================================================
// ⭐ 2026-10-16 验证动作一实测结论落地：多语言 CLIP 文本塔（中文直编）
//
// A/B（23 条中文查询 / 95 张可评 / Top-5，零图像推理、两路共用同一份图像嵌入）：
//   现有词表路线 78.3% / MRR 0.684 ｜ 中文直编 95.7% / MRR 0.804 ｜ **双路融合 95.7% / MRR 0.841**
//   · 自然中文说法：词表 73.7% vs 直编 94.7%（词表对「自然风光/纸质文件/拍的文件」根本解析不出标签）
//   · 裸标签查询：两路都 100%（词表对已建模场景类很准）
// ⇒ 结论：**不替换**现有链路，而是给召回加一路「直编余弦」，把词表降级为「精排/绑定」。
//   本文件只负责**查询编码**；排序融合在 photoTimeLineService._fuseMultilingualRank。
//
// ⚠️ 两个必须自己接/自己实现的地方（都是「静默失败」的坑）：
//   1) 该 ONNX **只输出 last_hidden_state**（[1,seq,768]）：均值池化 + 768→512 投影**在图外**
//      （1_Pooling=mean_tokens、2_Dense=768→512 bias=false）。权重已离线转成裸 float32
//      `dense_w512x768.f32.bin`，Node 侧零依赖直接读。
//   2) tokenizer 是 **BERT WordPiece**（vocab 119547），不是 SentencePiece ⇒ 本文件自带
//      BertNormalizer + BertPreTokenizer + greedy WordPiece，零新依赖。
//
// 产物目录：onnx_models/clip_multilingual/{model.onnx, tokenizer.json, dense_w512x768.f32.bin}
// 环境变量 OCR_* 无关；融合可用配置键 `ai_multilingual_clip_enable=0` 关掉。
// ============================================================================

const MT_DIR = () => path.join(remoteAssets.resolveOnnxModelsRoot(), 'clip_multilingual');
const MT_MODEL = () => path.join(MT_DIR(), 'model.onnx');
const MT_TOKENIZER = () => path.join(MT_DIR(), 'tokenizer.json');
const MT_DENSE = () => path.join(MT_DIR(), 'dense_w512x768.f32.bin');
const MT_MAX_LEN = 128;
const MT_DIM = 512;
const MT_HIDDEN = 768;
// ⭐ 内存是硬成本：实测 fp32 塔常驻 **+437MB RSS**（96→522MB），而 API 进程要服务所有模块。
//    所以搜完一段空闲就**主动卸载**（释放 ONNX 会话、把内存交还），下次查询再懒加载（~0.5s）。
//    ⛔ 不做常驻：NAS 上为了搜一次照片长期多占 400MB 不划算。可用 MT_IDLE_UNLOAD_MS 调整（默认 10 分钟）。
// ⭐ 2026-10-17 默认从 10 分钟收到 5 分钟（对齐 Immich 的 model_ttl 默认 300s）：
//    重载代价只有 ~0.5s，而常驻成本是 +437MB ⇒ 早点还回去更划算。
const MT_IDLE_UNLOAD_MS = Math.max(1000, Number(process.env.MT_IDLE_UNLOAD_MS ?? 300000));
let _mtLastUse = 0;

let _mtAvailable = null;
let _mtReadyPromise = null;
let _mtReady = null;
let _mtFailed = false;
let _mtSession = null;
let _mtVocab = null;
let _mtDenseW = null;

function isMultilingualAvailable() {
  if (_mtAvailable !== null) return _mtAvailable;
  try {
    _mtAvailable = fs.existsSync(MT_MODEL()) && fs.existsSync(MT_TOKENIZER()) && fs.existsSync(MT_DENSE());
  } catch (_) {
    _mtAvailable = false;
  }
  return _mtAvailable;
}

/** BertNormalizer 用到的 CJK 区间（与 HF 的实现一致） */
const _MT_CJK_RANGES = [
  [0x4e00, 0x9fff],
  [0x3400, 0x4dbf],
  [0xf900, 0xfaff],
  [0x20000, 0x2a6df],
  [0x2a700, 0x2b73f],
  [0x2b740, 0x2b81f],
  [0x2b820, 0x2ceaf],
  [0x2f800, 0x2fa1f],
];

function _mtIsCjk(cp) {
  for (const [a, b] of _MT_CJK_RANGES) {
    if (cp >= a && cp <= b) return true;
  }
  return false;
}

function _mtIsControl(cp) {
  if (cp === 0 || cp === 0xfffd) return true;
  if (cp === 9 || cp === 10 || cp === 13) return false; // tab/lf/cr 先转空格
  return cp < 32 || (cp >= 0x7f && cp <= 0x9f);
}

function _mtIsPunct(cp) {
  return (
    (cp >= 33 && cp <= 47) ||
    (cp >= 58 && cp <= 64) ||
    (cp >= 91 && cp <= 96) ||
    (cp >= 123 && cp <= 126)
  );
}

/** BertNormalizer: clean_text + handle_chinese_chars（CJK 前后补空格 ⇒ 每个字单独成 token） */
function _mtNormalize(text) {
  const out = [];
  for (const ch of String(text || '')) {
    const cp = ch.codePointAt(0);
    if (_mtIsControl(cp)) continue;
    if (cp === 9 || cp === 10 || cp === 13 || ch === ' ') {
      out.push(' ');
      continue;
    }
    if (_mtIsCjk(cp)) {
      out.push(' ' + ch + ' ');
      continue;
    }
    out.push(ch);
  }
  return out.join('');
}

/** BertPreTokenizer: 空白切分 + 标点单独成 token */
function _mtPreTokenize(text) {
  const tokens = [];
  for (const chunk of String(text).split(/\s+/)) {
    if (!chunk) continue;
    let buf = '';
    for (const ch of chunk) {
      if (_mtIsPunct(ch.codePointAt(0))) {
        if (buf) {
          tokens.push(buf);
          buf = '';
        }
        tokens.push(ch);
      } else {
        buf += ch;
      }
    }
    if (buf) tokens.push(buf);
  }
  return tokens;
}

/** greedy longest-match WordPiece（与 HF 的 max_input_chars_per_word=100 一致） */
function _mtWordPiece(token) {
  const unk = _mtVocab.get('[UNK]');
  if (token.length > 100) return [unk];
  const ids = [];
  let start = 0;
  while (start < token.length) {
    let end = token.length;
    let cur = null;
    while (start < end) {
      let sub = token.slice(start, end);
      if (start > 0) sub = '##' + sub;
      const id = _mtVocab.get(sub);
      if (id !== undefined) {
        cur = id;
        break;
      }
      end -= 1;
    }
    if (cur === null) return [unk];
    ids.push(cur);
    start = end;
  }
  return ids;
}

function _mtEncodeIds(text) {
  const tokens = _mtPreTokenize(_mtNormalize(text));
  const body = [];
  for (const t of tokens) {
    const ids = _mtWordPiece(t);
    for (const id of ids) body.push(id);
  }
  const cls = _mtVocab.get('[CLS]');
  const sep = _mtVocab.get('[SEP]');
  if (body.length > MT_MAX_LEN - 2) body.length = MT_MAX_LEN - 2; // 给 CLS/SEP 留位（与 HF truncation 同口径）
  return [cls, ...body, sep];
}

async function ensureMultilingualReady() {
  if (_mtReady) return _mtReady;
  if (_mtFailed || !isMultilingualAvailable()) return null;
  if (_mtReadyPromise) return _mtReadyPromise;
  _mtReadyPromise = (async () => {
    try {
      const ort = require('onnxruntime-node');
      const { getBestExecutionProviders } = require('../../../utils/onnxProviderUtil');
      const tk = JSON.parse(fs.readFileSync(MT_TOKENIZER(), 'utf8'));
      const vocabObj = tk && tk.model && tk.model.vocab;
      if (!vocabObj || typeof vocabObj !== 'object') throw new Error('tokenizer.json 缺少 model.vocab');
      _mtVocab = new Map(Object.keys(vocabObj).map(k => [k, Number(vocabObj[k])]));
      if (!_mtVocab.has('[CLS]') || !_mtVocab.has('[SEP]')) throw new Error('词表缺少 [CLS]/[SEP]');
      const buf = fs.readFileSync(MT_DENSE());
      _mtDenseW = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
      if (_mtDenseW.length !== MT_DIM * MT_HIDDEN) {
        throw new Error(`dense 权重尺寸不对：期望 ${MT_DIM * MT_HIDDEN}，实际 ${_mtDenseW.length}`);
      }
      _mtSession = await ort.InferenceSession.create(MT_MODEL(), {
        executionProviders: getBestExecutionProviders(),
        graphOptimizationLevel: 'all',
      });
      _mtReady = { dim: MT_DIM, vocab: _mtVocab.size };
      Logger.info(`[placesQuery] 多语言塔就绪：vocab=${_mtVocab.size} dim=${MT_DIM}（中文直编参与融合重排）`);
      return _mtReady;
    } catch (err) {
      _mtFailed = true;
      Logger.warn(`[placesQuery] 多语言塔加载失败，融合重排不生效（搜索行为与以前一致）：${err && err.message ? err.message : err}`);
      return null;
    }
  })();
  return _mtReadyPromise;
}

/**
 * 把一句中文编码成 512 维单位向量（CLIP 图像空间的句子嵌入）。
 * @returns {Promise<Float32Array|null>} 不可用时返回 null（调用方必须容忍）
 */
/**
 * ⭐ 2026-10-17 查询嵌入 LRU 缓存（设计借鉴 Immich 的服务端嵌入缓存形态）。
 * 同一句搜索会被翻页 / 连续搜索反复问到，命中一次就省一次塔前向。
 * 只缓存**文本**嵌入（很小），不缓存图像。
 */
const MT_CACHE_MAX = Math.max(0, Number(process.env.MT_EMB_CACHE_MAX ?? 200));
const _mtEmbCache = new Map(); // text -> Float32Array
let _mtCacheHit = 0;
let _mtCacheMiss = 0;

function _mtCacheGet(text) {
  if (MT_CACHE_MAX <= 0) return null;
  const hit = _mtEmbCache.get(text);
  if (!hit) return null;
  // LRU：命中后挪到队尾（Map 保持插入序）
  _mtEmbCache.delete(text);
  _mtEmbCache.set(text, hit);
  _mtCacheHit += 1;
  return hit;
}

function _mtCacheSet(text, vec) {
  if (MT_CACHE_MAX <= 0 || !vec) return;
  _mtEmbCache.set(text, vec);
  while (_mtEmbCache.size > MT_CACHE_MAX) {
    const oldest = _mtEmbCache.keys().next();
    if (oldest.done) break;
    _mtEmbCache.delete(oldest.value);
  }
  _mtCacheMiss += 1;
  if ((_mtCacheHit + _mtCacheMiss) % 100 === 0) {
    Logger.info(`[placesQuery] 查询嵌入缓存 hit=${_mtCacheHit} miss=${_mtCacheMiss} size=${_mtEmbCache.size}`);
  }
}

async function encodeMultilingual(text) {
  const ready = await ensureMultilingualReady();
  if (!ready) return null;
  _mtLastUse = Date.now();
  _scheduleIdleUnload();
  const raw = String(text || '').trim();
  if (!raw) return null;
  const cachedEmb = _mtCacheGet(raw);
  if (cachedEmb) return cachedEmb;
  try {
    const ort = require('onnxruntime-node');
    const ids = _mtEncodeIds(raw);
    const seq = ids.length;
    const idsI64 = BigInt64Array.from(ids.map(v => BigInt(v)));
    const maskI64 = BigInt64Array.from(new Array(seq).fill(1n));
    const feeds = {};
    for (const name of _mtSession.inputNames) {
      if (name === 'input_ids') feeds[name] = new ort.Tensor('int64', idsI64, [1, seq]);
      else if (name === 'attention_mask') feeds[name] = new ort.Tensor('int64', maskI64, [1, seq]);
      else if (name === 'token_type_ids') feeds[name] = new ort.Tensor('int64', BigInt64Array.from(new Array(seq).fill(0n)), [1, seq]);
    }
    const out = await _mtSession.run(feeds);
    const last = out[_mtSession.outputNames[0]];
    const data = last.data;
    if (!data || data.length < seq * MT_HIDDEN) return null;

    // 均值池化（mask 全 1 ⇒ 直接按 token 数平均）
    const pooled = new Float32Array(MT_HIDDEN);
    for (let s = 0; s < seq; s += 1) {
      const base = s * MT_HIDDEN;
      for (let h = 0; h < MT_HIDDEN; h += 1) pooled[h] += data[base + h];
    }
    for (let h = 0; h < MT_HIDDEN; h += 1) pooled[h] /= seq;

    // 768 → 512 线性投影（bias=false）
    const vec = new Float32Array(MT_DIM);
    for (let o = 0; o < MT_DIM; o += 1) {
      const row = o * MT_HIDDEN;
      let acc = 0;
      for (let h = 0; h < MT_HIDDEN; h += 1) acc += _mtDenseW[row + h] * pooled[h];
      vec[o] = acc;
    }
    let norm = 0;
    for (let i = 0; i < MT_DIM; i += 1) norm += vec[i] * vec[i];
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < MT_DIM; i += 1) vec[i] /= norm;
    _mtCacheSet(raw, vec);
    return vec;
  } catch (err) {
    Logger.warn(`[placesQuery] 多语言编码失败（本条查询退回词表路线）：${err && err.message ? err.message : err}`);
    return null;
  }
}

/**
 * 空闲卸载：到点且确实没再被用过就释放会话。
 * ⛔ 只清会话与权重，不动 tokenizer 状态也没必要 —— 一起清最省内存（下次 ensure 会重建）。
 */
function _scheduleIdleUnload() {
  if (_mtIdleTimer) return;
  _mtIdleTimer = setTimeout(() => {
    _mtIdleTimer = null;
    if (!_mtSession) return;
    const idle = Date.now() - _mtLastUse;
    if (idle < MT_IDLE_UNLOAD_MS) {
      _scheduleIdleUnload();
      return;
    }
    try {
      if (typeof _mtSession.release === 'function') _mtSession.release();
    } catch (_) {}
    _mtSession = null;
    _mtReady = null;
    _mtReadyPromise = null;
    if (global.gc) {
      try {
        global.gc();
      } catch (_) {}
    }
    Logger.info('[placesQuery] 多语言塔空闲卸载（内存已交还；下次查询会重新加载）');
  }, MT_IDLE_UNLOAD_MS + 1000);
  if (_mtIdleTimer && typeof _mtIdleTimer.unref === 'function') _mtIdleTimer.unref();
}
let _mtIdleTimer = null;

/** 仅供测试/调试：重置多语言塔状态 */
function _mtReset() {
  _mtAvailable = null;
  _mtReadyPromise = null;
  _mtReady = null;
  _mtFailed = false;
  _mtSession = null;
  _mtVocab = null;
  _mtDenseW = null;
}

module.exports = {
  isMultilingualAvailable,
  ensureMultilingualReady,
  encodeMultilingual,
  _mtTokenizeForDebug: text => (_mtVocab ? _mtEncodeIds(text) : null),
  _mtNormalizeForDebug: _mtNormalize,
  _mtReset,
};

module.exports = {
  isAvailable,
  ensureReady,
  analyze,
  segment,
  _normalize,
  _reset,
  // ⭐ 2026-10-16 验证动作一落地：中文直编（多语言 CLIP 文本塔），供融合重排使用
  isMultilingualAvailable,
  ensureMultilingualReady,
  encodeMultilingual,
  _mtTokenizeForDebug: text => (_mtVocab ? _mtEncodeIds(text) : null),
  _mtNormalizeForDebug: _mtNormalize,
  _mtReset,
};
