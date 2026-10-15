'use strict';

/**
 * CLIP 分词器（纯 Node 实现，无 Python / transformers 依赖）
 *
 * ⭐ 为什么要有这个文件：
 * 场景识别升级引入了 CLIP 视觉-语言模型（开放词表零样本）。要用它就必须能把
 * 文本标签编码成 token id。官方实现依赖 Python + transformers，而本工程铁律是
 * 「不引入新的下载/工具链」。好在 CLIP 的分词器只是 byte-level BPE，
 * 只要 vocab.json + merges.txt 两个文件就能在 Node 里完整复刻。
 *
 * 实现与 openai/CLIP 的 SimpleTokenizer 对齐：
 *   1) 白空格归一 + 小写；
 *   2) 正则切分（注意 's/'t/'re 等缩写与 \p{L}/\p{N} 字符类）；
 *   3) 每个片段按 UTF-8 字节映射到可见字符（GPT-2 的 bytes_to_unicode）；
 *   4) byte-level BPE 合并，词尾追加 '</w>'；
 *   5) 首尾包 <|startoftext|>(49406) / <|endoftext|>(49407)。
 *
 * 注：分词器只在「构建期」用于生成场景标签的文本嵌入，不进运行时包，
 * 因此这里对性能只做基础缓存，不做额外优化。
 */

const fs = require('fs');
const path = require('path');

const EOW = '</w>';
const SOT = 49406;
const EOT = 49407;
const PAIR_SEP = '\u0000';

const SPLIT_PATTERN = /<\|startoftext\|>|<\|endoftext\|>|'s|'t|'re|'ve|'m|'ll|'d|[\p{L}]+|[\p{N}]|[^\s\p{L}\p{N}]+/giu;

let _byteEncoderCache = null;

/** GPT-2 的 bytes_to_unicode：把 256 个字节映射到不会出现在原始文本里的可见字符 */
function bytesToUnicode() {
  if (_byteEncoderCache) return _byteEncoderCache;
  const bs = [];
  for (let i = 33; i <= 126; i += 1) bs.push(i);
  for (let i = 161; i <= 172; i += 1) bs.push(i);
  for (let i = 174; i <= 255; i += 1) bs.push(i);
  const cs = bs.slice();
  let n = 0;
  for (let b = 0; b < 256; b += 1) {
    if (bs.indexOf(b) < 0) {
      bs.push(b);
      cs.push(256 + n);
      n += 1;
    }
  }
  const map = new Map();
  for (let i = 0; i < bs.length; i += 1) map.set(bs[i], String.fromCodePoint(cs[i]));
  _byteEncoderCache = map;
  return map;
}

function whitespaceClean(text) {
  return String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
}

/** 极简版 basic_clean：CLIP 上游用 ftfy + 两轮 html.unescape，这里只处理常见实体 */
function basicClean(text) {
  return whitespaceClean(text)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

class ClipTokenizer {
  /**
   * @param {object} opts
   * @param {string} opts.vocabPath   vocab.json 路径
   * @param {string} opts.mergesPath  merges.txt 路径
   */
  constructor({ vocabPath, mergesPath }) {
    const vocabRaw = JSON.parse(fs.readFileSync(vocabPath, 'utf8'));
    this.encoder = new Map(Object.entries(vocabRaw));
    this.decoder = new Map();
    for (const [token, id] of this.encoder.entries()) this.decoder.set(id, token);

    this.ranks = new Map();
    const lines = fs.readFileSync(mergesPath, 'utf8').split(/\r?\n/);
    let start = 0;
    if (lines[0] && lines[0].startsWith('#version')) start = 1;
    for (let i = start; i < lines.length; i += 1) {
      const line = lines[i].trim();
      if (!line) continue;
      this.ranks.set(line, this.ranks.size);
    }
    this.byteEncoder = bytesToUnicode();
    this._cache = new Map();
    this.size = this.encoder.size;
  }

  static _getPairs(word) {
    const pairs = new Set();
    for (let i = 0; i < word.length - 1; i += 1) {
      pairs.add(word[i] + PAIR_SEP + word[i + 1]);
    }
    return pairs;
  }

  /** byte-level BPE 单片段合并（带缓存） */
  bpe(token) {
    const cached = this._cache.get(token);
    if (cached) return cached;
    let word = Array.from(token);
    if (word.length === 0) {
      this._cache.set(token, word);
      return word;
    }
    word[word.length - 1] = word[word.length - 1] + EOW;
    let pairs = ClipTokenizer._getPairs(word);
    if (pairs.size === 0) {
      this._cache.set(token, word);
      return word;
    }
    for (;;) {
      let best = null;
      let bestRank = Infinity;
      for (const pair of pairs) {
        const rank = this.ranks.get(pair.split(PAIR_SEP).join(' '));
        if (rank !== undefined && rank < bestRank) {
          bestRank = rank;
          best = pair;
        }
      }
      if (best === null) break;
      const [first, second] = best.split(PAIR_SEP);
      const merged = [];
      let i = 0;
      while (i < word.length) {
        if (word[i] === first && i + 1 < word.length && word[i + 1] === second) {
          merged.push(first + second);
          i += 2;
        } else {
          merged.push(word[i]);
          i += 1;
        }
      }
      word = merged;
      if (word.length === 1) break;
      pairs = ClipTokenizer._getPairs(word);
    }
    this._cache.set(token, word);
    return word;
  }

  /**
   * 文本 → token id 数组（含 SOT/EOT，不补 padding）
   * @param {string} text
   * @returns {number[]}
   */
  encode(text) {
    const cleaned = basicClean(text).toLowerCase();
    const pieces = cleaned.match(SPLIT_PATTERN) || [];
    const tokens = [];
    for (const piece of pieces) {
      const bytes = Buffer.from(piece, 'utf8');
      let mapped = '';
      for (const b of bytes) mapped += this.byteEncoder.get(b);
      for (const sub of this.bpe(mapped)) tokens.push(sub);
    }
    const ids = [SOT];
    for (const token of tokens) {
      const id = this.encoder.get(token);
      if (id !== undefined) ids.push(id);
    }
    ids.push(EOT);
    return ids;
  }

  /** token id → 文本（仅用于自检 / 调试） */
  decode(ids) {
    let out = '';
    for (const id of ids) {
      if (id === SOT || id === EOT) continue;
      out += this.decoder.get(id) || '';
    }
    return out.replace(/<\/w>/g, ' ').trim();
  }

  /**
   * 编码为定长 77 的输入张量（CLIP 的固定上下文长度）
   * @param {string} text
   * @returns {{ ids: BigInt64Array, mask: BigInt64Array, length: number }}
   */
  encodePadded(text, maxLength = 77) {
    const raw = this.encode(text);
    const length = Math.min(maxLength, raw.length);
    const ids = new BigInt64Array(maxLength);
    const mask = new BigInt64Array(maxLength);
    for (let i = 0; i < length; i += 1) {
      ids[i] = BigInt(raw[i]);
      mask[i] = 1n;
    }
    return { ids, mask, length };
  }
}

/**
 * 从目录加载分词器（目录内需有 vocab.json + merges.txt）
 * @param {string} dir
 * @returns {ClipTokenizer}
 */
function loadClipTokenizer(dir) {
  return new ClipTokenizer({
    vocabPath: path.join(dir, 'vocab.json'),
    mergesPath: path.join(dir, 'merges.txt'),
  });
}

module.exports = { ClipTokenizer, loadClipTokenizer, bytesToUnicode };
