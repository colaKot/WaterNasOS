let pinyinPro;
try {
  pinyinPro = require('pinyin-pro');
} catch (_) {
  pinyinPro = null;
}

function _getPinyinFirstLetterChar(ch) {
  if (!pinyinPro) return '';
  try {
    const { firstLetter, pinyin } = pinyinPro;
    if (typeof firstLetter === 'function') {
      const fl = firstLetter(String(ch || ''), { toneType: 'none' });
      const c = Array.from(String(fl || '').trim())[0] || '';
      if (/[a-z]/i.test(c)) return c.toUpperCase();
    }
    if (typeof pinyin === 'function') {
      const fl = pinyin(String(ch || ''), { toneType: 'none', pattern: 'first', multiple: false });
      const c = Array.from(String(fl || '').trim())[0] || '';
      if (/[a-z]/i.test(c)) return c.toUpperCase();
    }
  } catch (_) {
    return '';
  }
  return '';
}

function getFirstLetter(input) {
  const s = input === undefined || input === null ? '' : String(input).trim();
  if (!s) return '#';
  const first = Array.from(s)[0] || '';
  if (!first) return '#';
  if (/[a-z]/i.test(first)) return first.toUpperCase();
  if (/[0-9]/.test(first)) return '#';
  const py = _getPinyinFirstLetterChar(first);
  if (py) return py;
  return '#';
}

/* ============================================================================
 * 自然排序键（Natural Sort）
 *
 * 背景：直接 `ORDER BY lower(filename)` 是**逐字符文本比较**，
 *   ⇒ '(1).jpg' < '(10).jpg' < '(100).jpg' < '(2).jpg'   （1,10,100,2 是错的）
 *   期望 '(1)' < '(2)' < '(10)' < '(100)'。
 *
 * 做法：把文件名里的**每个数字段左侧补零到 NATURAL_PAD 位**，其余字符原样保留（转小写）。
 *   补零后文本序 == 数值序，于是 `ORDER BY natural_name` 天然就是自然序，
 *   而且**可以用索引**（纯文本列，BINARY 排序）。
 *
 * 例：'(2).jpg'  → '(000000000002).jpg'
 *     '(10).jpg' → '(000000000010).jpg'
 *     'photo2.jpg' → 'photo000000000002.jpg'
 *     'a1b20c3.jpg' → 'a000000000001b000000000020c000000000003.jpg'
 *
 * ⚠️ 这是**唯一真源**：扫描入库（videoIndexIndexUtil）与历史回填脚本都必须
 *    调这个函数。SQL 侧不重算，只做 `ORDER BY natural_name`，
 *    所以任何改动都会让「已回填的旧行」与新行不一致 ⇒ 改算法必须重跑回填。
 *
 * ⚠️ 12 位补零 = 支持到 999_999_999_999（十万亿）。超过这个位数的数字段
 *    会退化成"更长的排后面"，现实中不存在，忽略。
 * ==========================================================================*/
const NATURAL_PAD = 12;
const NATURAL_NUM_RE = /(\d+)/;

function getNaturalSortKey(input) {
  const s = input === undefined || input === null ? '' : String(input);
  if (!s) return '';
  const lower = s.toLowerCase();
  // 用捕获组切分 ⇒ split 结果里奇数下标是数字段
  const parts = lower.split(NATURAL_NUM_RE);
  let out = '';
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (i % 2 === 1) {
      // 数字段：去掉前导零后补零（'007' 与 '7' 应视为相等，都变 000000000007）
      const trimmed = p.replace(/^0+/, '') || '0';
      out += trimmed.length >= NATURAL_PAD ? trimmed : '0'.repeat(NATURAL_PAD - trimmed.length) + trimmed;
    } else if (p) {
      out += p;
    }
  }
  return out;
}

module.exports = {
  getFirstLetter,
  getNaturalSortKey,
  NATURAL_PAD,
};
