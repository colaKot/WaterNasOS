function _isDateString(s) {
  if (!s || typeof s !== 'string') return false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return Number.isFinite(d.getTime());
}

function _escapeLike(s) {
  return String(s).replace(/[\\%_]/g, m => `\\${m}`);
}

/**
 * ⭐ 2026-10-13 人脸条件：value 为人名（如「铁柱」）或 `#<face_id>`（未命名人物）。
 * 通过 whereExists 关联 photo_face2filehash + photo_faces（根人脸）：
 *   - 人名匹配 ⇒ 之后新识别出的人物若被合并/命名到该名字，照片自动进入相册；
 *   - #id 匹配 ⇒ 精确到某个人脸分组（未命名时使用）。
 * 合并人脸时 f2 行会整体搬到目标根人脸，所以按人名匹配天然「跟随合并」。
 */
function _applyFaceCondition(qb, value, tableAlias) {
  const v = value == null ? '' : String(value).trim();
  if (!v) return;
  const m = /^#(\d+)$/.exec(v);
  const faceId = m ? Math.max(0, Number(m[1]) || 0) : 0;
  qb.whereExists(function () {
    this.select(1)
      .from('photo_face2filehash as f2')
      .join('photo_faces as pf', 'pf.face_id', 'f2.face_id')
      .whereRaw(`f2.file_hash = ${tableAlias}.file_hash`)
      .where(function () {
        // 只认根人脸（belong_face_id 为 NULL 或 0）
        this.whereNull('pf.belong_face_id').orWhere('pf.belong_face_id', 0);
      })
      .where(function () {
        if (faceId > 0) {
          this.where('pf.face_id', faceId);
          return;
        }
        this.whereRaw("CAST(pf.name AS TEXT) LIKE ? ESCAPE '\\'", [`%${_escapeLike(v)}%`]);
      });
  });
}

function parseFilterContentText(text) {
  try {
    const parsed = JSON.parse(String(text || '{}'));
    if (!parsed || typeof parsed !== 'object') return {};
    return parsed;
  } catch (_) {
    return {};
  }
}

function _normalizeCondition(cond, tableAlias) {
  if (!cond || typeof cond !== 'object') return null;
  const field = String(cond.field || '').trim();
  const operator = String(cond.operator || '').trim();
  const value = cond.value;

  const fieldMap = {
    filename: { column: `${tableAlias}.filename`, type: 'text' },
    path: { column: `${tableAlias}.path`, type: 'text' },
    camera: { column: `${tableAlias}.camera`, type: 'text' },
    size_mb: { column: `${tableAlias}.size`, type: 'number', scale: 1024 * 1024 },
    duration_min: { column: `${tableAlias}.duration`, type: 'number', scale: 60 },
    width: { column: `${tableAlias}.width`, type: 'number', scale: 1 },
    height: { column: `${tableAlias}.height`, type: 'number', scale: 1 },
    // ⭐ 2026-10-13 人脸条件（人名 / #face_id）
    face: { type: 'face' },
  };
  const meta = fieldMap[field];
  if (!meta) return null;

  // 人脸条件：值是人名或 #id，走 whereExists
  if (meta.type === 'face') {
    if (operator !== 'contains') return null;
    const v = value == null ? '' : String(value).trim();
    if (!v) return null;
    return { type: 'face', value: v };
  }

  if (meta.type === 'text') {
    if (operator !== 'contains') return null;
    const s = String(value || '').trim();
    if (!s) return null;
    return { column: meta.column, operator: 'contains', value: s };
  }

  if (operator !== 'gt' && operator !== 'eq' && operator !== 'lt') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return { column: meta.column, operator, value: n * meta.scale };
}

function _applySingleCondition(qb, condition, tableAlias) {
  if (condition.type === 'face') {
    _applyFaceCondition(qb, condition.value, tableAlias);
    return;
  }
  if (condition.operator === 'contains') {
    qb.where(condition.column, 'like', `%${condition.value}%`);
    return;
  }
  if (condition.operator === 'gt') {
    qb.where(condition.column, '>', condition.value);
    return;
  }
  if (condition.operator === 'eq') {
    qb.where(condition.column, '=', condition.value);
    return;
  }
  if (condition.operator === 'lt') {
    qb.where(condition.column, '<', condition.value);
  }
}

function applyConditionFilter(query, filterContent, tableAlias) {
  const logic = String(filterContent.logic || 'and').toLowerCase() === 'or' ? 'or' : 'and';
  const conditions = Array.isArray(filterContent.conditions) ? filterContent.conditions : [];
  const mapped = conditions.map(c => _normalizeCondition(c, tableAlias)).filter(Boolean);
  if (mapped.length === 0) return;

  if (logic === 'or') {
    query.where(builder => {
      for (const c of mapped) {
        builder.orWhere(b => _applySingleCondition(b, c, tableAlias));
      }
    });
    return;
  }

  for (const c of mapped) {
    _applySingleCondition(query, c, tableAlias);
  }
}

function applySmartDateFilter(query, filterContent, tableAlias) {
  const mode = String(filterContent.mode || '').trim();
  if (mode === 'anniversary') {
    const repeat = String(filterContent.repeat || '').trim();
    const month = Number(filterContent.month);
    const day = Number(filterContent.day);
    if (repeat === 'year' && Number.isFinite(month) && Number.isFinite(day)) {
      const mm = String(Math.max(1, Math.min(12, month))).padStart(2, '0');
      const dd = String(Math.max(1, Math.min(31, day))).padStart(2, '0');
      query.whereRaw(`strftime('%m-%d', ${tableAlias}.original_date) = ?`, [`${mm}-${dd}`]);
    } else if (repeat === 'month' && Number.isFinite(day)) {
      const dd = String(Math.max(1, Math.min(31, day))).padStart(2, '0');
      query.whereRaw(`strftime('%d', ${tableAlias}.original_date) = ?`, [dd]);
    }
    return;
  }

  if (mode === 'fixed') {
    const date = String(filterContent.date || '').trim();
    const operator = String(filterContent.operator || 'on').trim();
    if (!_isDateString(date)) return;
    if (operator === 'before') {
      query.where(`${tableAlias}.original_date`, '<=', date);
    } else if (operator === 'after') {
      query.where(`${tableAlias}.original_date`, '>=', date);
    } else {
      query.where(`${tableAlias}.original_date`, date);
    }
    return;
  }

  if (mode === 'range') {
    const start = String(filterContent.start || '').trim();
    const end = String(filterContent.end || '').trim();
    if (!_isDateString(start) || !_isDateString(end)) return;
    const [s, e] = start <= end ? [start, end] : [end, start];
    query.whereBetween(`${tableAlias}.original_date`, [s, e]);
  }
}

function applySmartAlbumFilter(query, type, filterContent, tableAlias) {
  const t = String(type || 'condition').trim();
  if (t === 'smart_date') {
    applySmartDateFilter(query, filterContent, tableAlias);
    return;
  }
  applyConditionFilter(query, filterContent, tableAlias);
}

module.exports = {
  parseFilterContentText,
  applySmartAlbumFilter,
  applySmartDateFilter,
  applyConditionFilter,
};
