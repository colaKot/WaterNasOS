const path = require('path');
const { getTranslation } = require('../../../../utils/i18nUtil');
const photoPathQueryUtil = require('../timeline/photoPathQueryUtil');

class PlacesService {
  constructor(knex) {
    this.knex = knex;
  }

  async listPlaces(params = {}) {
    const status = params.status || params.filter || 'visible';
    const locale = params && params.locale ? String(params.locale) : 'zh-CN';
    const validPaths = Array.isArray(params.validPaths) ? params.validPaths.filter(Boolean) : [];

    if (Object.prototype.hasOwnProperty.call(params, 'validPaths') && validPaths.length === 0) {
      return {
        items: [],
        pagination: { total: 0, page: 1, pageSize: 0 },
      };
    }

    let rowsQuery = this.knex('photo_places').select('place_name', 'photo_count', 'is_hide', 'create_time', 'update_time', 'weight_sum', 'count_high');

    // ⭐ 2026-10-13：相册来源 = 主场景或次场景（alt_place_name）
    const buildAllowedNamesQuery = (column) => {
      const q = this.knex('photo_places2filehash as p2')
        .join('photo_index as p', 'p.file_hash', 'p2.file_hash')
        .where('p.is_file', 1)
        .where('p.in_trash', 0)
        .select(column === 'alt' ? 'p2.alt_place_name as place_name' : 'p2.place_name');
      photoPathQueryUtil.applyPathPrefixFilter(q, 'p.path', validPaths);
      return q;
    };

    if (validPaths.length > 0) {
      rowsQuery = rowsQuery.where(function () {
        this.whereIn('place_name', buildAllowedNamesQuery('primary')).orWhereIn(
          'place_name',
          buildAllowedNamesQuery('alt'),
        );
      });
    }

    if (status === 'visible' || status === 'visiable') {
      rowsQuery = rowsQuery.andWhere('is_hide', 0);
    } else if (status === 'hide' || status === 'hidden') {
      rowsQuery = rowsQuery.andWhere('is_hide', 1);
    }

    // ⭐ 2026-10-14 场景识别 v2：按「置信权重和」排序，低置信照片不再把相册顶到前排。
    // 老数据迁移时 weight_sum 已用 photo_count 回填，所以历史排序不会突变。
    const rows = await rowsQuery
      .orderBy([{ column: 'weight_sum', order: 'desc' }, { column: 'photo_count', order: 'desc' }])
      .catch(() => rowsQuery.orderBy('photo_count', 'desc').catch(() => []));

    const items = Array.isArray(rows) ? rows : [];
    const total = items.length;
    const placeNames = items
      .map(it => (it && it.place_name ? String(it.place_name) : ''))
      .map(n => n.trim())
      .filter(Boolean);
    const coverByPlaceKey = new Map();

    if (placeNames.length > 0) {
      let coverRows = [];
      if (validPaths.length > 0) {
        // 封面候选：主场景或次场景命中都算
        let qb = this.knex('photo_places2filehash as p2')
          .join('photo_index as p', 'p.file_hash', 'p2.file_hash')
          .andWhere('p.is_file', 1)
          .andWhere('p.in_trash', 0)
          .where(function () {
            this.whereIn('p2.place_name', placeNames).orWhereIn(
              'p2.alt_place_name',
              placeNames,
            );
          });
        photoPathQueryUtil.applyPathPrefixFilter(qb, 'p.path', validPaths);
        const allCoverCandidates = await qb
          .select(
            'p2.place_name as place_key',
            'p2.alt_place_name as alt_key',
            'p2.file_hash as file_hash',
            'p.path as path',
            'p.filename as filename',
            'p.original_time as original_time',
            'p.id as photo_id',
            'p2.id as p2_id'
          )
          .orderBy('p.original_time', 'desc')
          .orderBy('p.id', 'desc')
          .orderBy('p2.id', 'desc')
          .catch(() => []);
        for (const r of allCoverCandidates) {
          const keys = [r && r.place_key, r && r.alt_key]
            .map(k => (k === undefined || k === null ? '' : String(k)))
            .filter(Boolean);
          for (const key of keys) {
            if (!placeNames.includes(key)) continue;
            if (coverByPlaceKey.has(key)) continue;
            coverByPlaceKey.set(key, {
              file_hash: r && r.file_hash ? String(r.file_hash) : '',
              path: r && r.path ? String(r.path) : '',
              filename: r && r.filename ? String(r.filename) : '',
              fullpath: r && r.path && r.filename ? path.join(r.path, r.filename) : '',
            });
          }
        }
      } else {
        const placeholders = placeNames.map(() => '?').join(',');
        const keyColumn = 'place_name';
        // ⭐ 2026-10-13 主场景 + 次场景（alt_place_name）各取一张最新封面，主场景优先
        const sql = `
        SELECT place_key, file_hash, path, filename
        FROM (
          SELECT
            p2.place_name AS place_key,
            p2.file_hash AS file_hash,
            p.path AS path,
            p.filename AS filename,
            ROW_NUMBER() OVER (
              PARTITION BY p2.place_name
              ORDER BY p.original_time DESC, p.id DESC, p2.id DESC
            ) AS rn
          FROM photo_places2filehash AS p2
          JOIN photo_index AS p ON p.file_hash = p2.file_hash
          WHERE p2.place_name IN (${placeholders})
            AND p.is_file = 1
            AND p.in_trash = 0
          UNION ALL
          SELECT
            p2.alt_place_name AS place_key,
            p2.file_hash AS file_hash,
            p.path AS path,
            p.filename AS filename,
            ROW_NUMBER() OVER (
              PARTITION BY p2.alt_place_name
              ORDER BY p.original_time DESC, p.id DESC, p2.id DESC
            ) AS rn
          FROM photo_places2filehash AS p2
          JOIN photo_index AS p ON p.file_hash = p2.file_hash
          WHERE p2.alt_place_name IN (${placeholders})
            AND p.is_file = 1
            AND p.in_trash = 0
        )
        WHERE rn = 1
      `;
        const paramsList = [...placeNames, ...placeNames];
        try {
          const raw = await this.knex.raw(sql, paramsList);
          coverRows = Array.isArray(raw) ? raw : [];
        } catch (_) {
          let qb = this.knex('photo_places2filehash as p2').join('photo_index as p', 'p.file_hash', 'p2.file_hash').andWhere('p.is_file', 1).andWhere('p.in_trash', 0);

          qb = qb.where(function () {
            this.whereIn('p2.place_name', placeNames).orWhereIn('p2.alt_place_name', placeNames);
          });

          coverRows = await qb
            .select('p2.place_name as place_key', 'p2.alt_place_name as alt_key', 'p2.file_hash as file_hash', 'p.path as path', 'p.filename as filename', 'p.original_time as original_time', 'p.id as photo_id', 'p2.id as p2_id')
            .orderBy('p.original_time', 'desc')
            .orderBy('p.id', 'desc')
            .orderBy('p2.id', 'desc')
            .catch(() => []);
        }
        // 兜底查询可能带回 alt_key 行，统一展开成 place_key
        coverRows = (coverRows || []).flatMap(r => {
          const keys = [r && r.place_key, r && r.alt_key]
            .map(k => (k === undefined || k === null ? '' : String(k)))
            .filter(Boolean);
          if (keys.length <= 1 && r && r.alt_key === undefined) {
            return [r];
          }
          return keys.map(k => ({ ...r, place_key: k }));
        });
      }

      if (validPaths.length === 0) {
        for (const r of coverRows) {
          const key = r && r.place_key !== undefined && r.place_key !== null ? String(r.place_key) : '';
          if (!key) continue;
          if (coverByPlaceKey.has(key)) continue;
          const coverPath = r && r.path ? String(r.path) : '';
          const coverFilename = r && r.filename ? String(r.filename) : '';
          const fullpath = coverPath && coverFilename ? path.join(coverPath, coverFilename) : '';
          coverByPlaceKey.set(key, {
            file_hash: r && r.file_hash ? String(r.file_hash) : '',
            path: coverPath,
            filename: coverFilename,
            fullpath: fullpath || '',
          });
        }
      }
    }

    const enriched = items.map(it => {
      const { place_name: _pn, ...rest } = it || {};
      const rawName = it && it.place_name ? String(it.place_name) : '';
      const coverKey = rawName;
      const cover = coverByPlaceKey.get(coverKey) || null;
      const keyByName = rawName ? `places365.${rawName}` : '';
      const translatedByName = keyByName ? getTranslation(keyByName, locale) : '';
      const localizedName = (translatedByName && translatedByName !== keyByName ? translatedByName : '') || rawName;
      return {
        ...rest,
        place_name_raw: rawName,
        place_name: localizedName,
        is_hide: Number(it && it.is_hide ? it.is_hide : 0) || 0,
        cover,
      };
    });

    return {
      items: enriched,
      pagination: {
        total,
        page: 1,
        pageSize: total,
      },
    };
  }

  /**
   * ⭐ 2026-10-16 P0-1：**只做语义解析，不查库**。
   *
   * 给照片时间轴的搜索框提供「已识别：日落 · 海滩　未识别：xx」提示条。
   * 为什么不复用 searchPlaces：那条路会去 photo_places 里捞一遍相册并算可见性，
   * 对「只是想告诉用户我猜到了什么」来说太贵；解析层本身是纯内存计算（短语词表 + 短语嵌入）。
   *
   * 顺带把**活动标签**（photo_activity，独立于场景标签，见 tablePhotoActivity.js）的命中一并返回，
   * 因为「游泳 / 露营 / 大笑」这类词可能只落在活动维度里，用户看不到就会以为搜不到。
   *
   * @param {Object} params {query}
   * @returns {Promise<{available:boolean, tags:string[], unmatched:string[], activities:Array, parsed:Object|null}>}
   */
  async parseQuery(params = {}) {
    const query = params && params.query !== undefined ? String(params.query).trim() : '';
    if (!query) {
      return { available: false, tags: [], unmatched: [], activities: [], parsed: null };
    }

    let parsed = null;
    let available = false;
    try {
      const placesQuery = require('../../../../workers/ai/places/placesQuery');
      available = !!placesQuery.isAvailable();
      if (available) {
        await placesQuery.ensureReady();
        parsed = placesQuery.analyze(query, { topTags: 12 });
      }
    } catch (_) {
      parsed = null;
    }

    const ok = !!(parsed && parsed.ok);
    const tags = ok && Array.isArray(parsed.tags)
      ? parsed.tags.map(t => (t && t.label ? String(t.label).trim() : '')).filter(Boolean)
      : [];
    const unmatched = ok && Array.isArray(parsed.unmatched)
      ? parsed.unmatched.map(u => String(u || '').trim()).filter(Boolean)
      : [];

    // 活动标签命中（与场景标签互相独立）
    let activities = [];
    try {
      const like = '%' + query + '%';
      const rows = await this.knex('photo_activity')
        .select('act_key', 'act_name', 'photo_count')
        .where('is_hide', 0)
        .where(function () {
          this.where('act_name', 'like', like).orWhere('act_key', 'like', like);
          if (tags.length > 0) this.orWhereIn('act_name', tags);
        })
        .orderBy('photo_count', 'desc')
        .limit(8);
      activities = (Array.isArray(rows) ? rows : [])
        .map(r => ({
          act_key: r && r.act_key ? String(r.act_key) : '',
          act_name: r && r.act_name ? String(r.act_name) : '',
          photo_count: Number((r && r.photo_count) || 0) || 0,
        }))
        .filter(r => r.act_name);
    } catch (_) {
      activities = [];
    }

    return { available, tags, unmatched, activities, parsed: parsed || null };
  }

  /**
   * ⭐ 2026-10-16 P0-3 以图搜图：拿一张图的 CLIP 图像嵌入，在**可见范围内**找最像的 N 张。
   *
   * 为什么现在才做：`placesClipUtil.scoreImage` 一直在算 512 维图像向量，但**只用于和标签
   * 文本嵌入点积，算完即丢**；库里没有任何向量列 ⇒ 想以图搜图必须先加列 + 回填（见
   * `photo_index.clip_emb` 与 `tool/_backfill_clip_emb.js`）。
   *
   * 检索走**全量余弦**（两边都已 L2 归一化 ⇒ 退化为点积），分批扫描避免一次性把几十万行读进内存。
   * ⛔ 不引入 sqlite-vec / pgvector：单机 SQLite，先看实测瓶颈再决定要不要加速。
   *
   * @param {Object} params {file_hash?, path?, image_base64?, limit?, validPaths?}
   */
  async searchByImage(params = {}) {
    const fs = require('fs');
    const os = require('os');
    const pathMod = require('path');
    const limit = Math.max(1, Math.min(100, Number(params.limit) || 40));
    const fileHash = params.file_hash !== undefined ? String(params.file_hash).trim()
      : (params.fileHash !== undefined ? String(params.fileHash).trim() : '');
    const validPaths = Array.isArray(params.validPaths) ? params.validPaths.filter(Boolean) : [];

    // 1) 查询图落地成本地文件
    let queryPath = params.path ? String(params.path) : '';
    let tempFile = '';
    if (!queryPath && fileHash) {
      const row = await this.knex('photo_index')
        .where({ file_hash: fileHash })
        .select('path', 'filename')
        .first()
        .catch(() => null);
      if (row && row.path) queryPath = pathMod.join(String(row.path), String(row.filename || ''));
    }
    if (!queryPath && params.image_base64) {
      try {
        const raw = String(params.image_base64).replace(/^data:[^,]+,/, '');
        tempFile = pathMod.join(os.tmpdir(), `wnos_imgsearch_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.jpg`);
        fs.writeFileSync(tempFile, Buffer.from(raw, 'base64'));
        queryPath = tempFile;
      } catch (_) {
        queryPath = '';
      }
    }
    const cleanup = () => {
      if (tempFile) {
        try {
          fs.unlinkSync(tempFile);
        } catch (_) {}
      }
    };

    if (!queryPath || !fs.existsSync(queryPath)) {
      cleanup();
      const err = new Error('photo.IMG_SEARCH_NO_SOURCE');
      err.statusCode = 400;
      throw err;
    }

    const clip = require('../../../../workers/ai/places/placesClipUtil');
    if (!clip.isAvailable()) {
      cleanup();
      return { available: false, items: [], scanned: 0 };
    }

    let queryEmb = null;
    try {
      await clip.ensureReady();
      const scored = await clip.scoreImage(queryPath, { topK: 1 });
      queryEmb = scored && scored.emb ? scored.emb : null;
    } catch (err) {
      cleanup();
      const e = new Error('photo.IMG_SEARCH_FAILED');
      e.statusCode = 500;
      throw e;
    }
    cleanup();
    if (!queryEmb) {
      return { available: true, items: [], scanned: 0 };
    }

    // 2) 分批扫描候选（只读可见范围；已归一化 ⇒ 点积即余弦）
    const CHUNK = 4000;
    const MAX_SCAN = 300000;
    let offset = 0;
    let scanned = 0;
    const hits = []; // { i, score }
    const meta = []; // 与 hits 的 i 对应
    const scoresBuf = [];

    for (;;) {
      const qb = this.knex('photo_index as p')
        .where('p.is_file', 1)
        .where('p.in_trash', 0)
        .whereNotNull('p.clip_emb')
        .select('p.file_hash', 'p.path', 'p.filename', 'p.type', 'p.clip_emb')
        .orderBy('p.id', 'asc')
        .limit(CHUNK)
        .offset(offset);
      if (fileHash) qb.whereNot('p.file_hash', fileHash);
      if (validPaths.length > 0) photoPathQueryUtil.applyPathPrefixFilter(qb, 'p.path', validPaths);
      const rows = await qb.catch(() => []);
      if (!Array.isArray(rows) || rows.length === 0) break;

      for (const r of rows) {
        const buf = r && r.clip_emb;
        if (!buf) continue;
        const bytes = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
        const dim = Math.floor(bytes.byteLength / 4);
        if (dim <= 0) continue;
        const vec = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + dim * 4));
        let dot = 0;
        const n = Math.min(dim, queryEmb.length);
        for (let d = 0; d < n; d += 1) dot += vec[d] * queryEmb[d];
        scoresBuf.push({
          score: dot,
          file_hash: String(r.file_hash || ''),
          fullpath: pathMod.join(String(r.path || ''), String(r.filename || '')),
          filename: String(r.filename || ''),
          type: Number(r.type) || 1,
        });
      }
      scanned += rows.length;
      offset += rows.length;
      if (rows.length < CHUNK || scanned >= MAX_SCAN) break;
    }

    // 3) 排序取前 N
    scoresBuf.sort((a, b) => b.score - a.score);
    const items = scoresBuf.slice(0, limit).map(h => ({
      file_hash: h.file_hash,
      fullpath: h.fullpath,
      filename: h.filename,
      type: h.type,
      score: Number(h.score.toFixed(6)),
    }));

    return { available: true, items, scanned };
  }

  /**
   * ⭐ 2026-10-16 P0-4 搜索联想聚合（8 类里能落地的 7 类）。
   *
   * 数据源全部现成：人物 `photo_faces` / 场景 `photo_places` / 活动 `photo_activity` /
   * 相机与文件名 `photo_index` / OCR `photo_info_fts` / 年份 `photo_index.original_time`。
   *
   * ⚠️ 计数一律在**该用户可见范围内**重新算（可见性零角色例外）：
   *   聚合表里的 `photo_count` 是全库口径，直接展示等于把别人相册的规模漏给普通用户。
   *
   * ⚠️ `photo_faces.name` 是 BLOB ⇒ LIKE 必须 `CAST(name AS TEXT)`，并且转义 `% _ \`。
   *
   * @param {Object} params {q, limit, validPaths}
   */
  async suggest(params = {}) {
    const raw = params.q !== undefined ? params.q : (params.query !== undefined ? params.query : '');
    const q = String(raw === null || raw === undefined ? '' : raw).trim();
    const limit = Math.max(1, Math.min(20, Number(params.limit) || 8));
    if (!q) return { q: '', items: [] };

    const validPaths = Array.isArray(params.validPaths) ? params.validPaths.filter(Boolean) : [];
    const scopeEmpty = Object.prototype.hasOwnProperty.call(params, 'validPaths') && validPaths.length === 0;
    const escapeLike = s => String(s).replace(/[\\%_]/g, m => '\\' + m);
    const prefix = escapeLike(q) + '%';
    const contains = '%' + escapeLike(q) + '%';
    const items = [];

    // 可见范围子查询（各计数共用）
    const visibleHashes = () => {
      const sub = this.knex('photo_index as p')
        .select('p.file_hash')
        .where('p.is_file', 1)
        .where('p.in_trash', 0);
      if (validPaths.length > 0) photoPathQueryUtil.applyPathPrefixFilter(sub, 'p.path', validPaths);
      return sub;
    };
    const scopedCount = async (table, column, value) => {
      if (scopeEmpty) return 0;
      try {
        const row = await this.knex(table)
          .where(column, value)
          .whereIn('file_hash', visibleHashes())
          .count({ n: 'file_hash' })
          .first();
        return Number((row && row.n) || 0) || 0;
      } catch (_) {
        return 0;
      }
    };

    // 1) 人物（根人脸 + 未隐藏 + 名字前缀命中）
    try {
      const rows = await this.knex('photo_faces')
        .where(function () {
          this.whereNull('belong_face_id').orWhere('belong_face_id', 0);
        })
        .where('is_hide', 0)
        .andWhereRaw("CAST(name AS TEXT) LIKE ? ESCAPE '\\'", [prefix])
        .orderBy('face_count', 'desc')
        .limit(limit)
        .select('face_id', 'name');
      for (const r of Array.isArray(rows) ? rows : []) {
        const nm = Buffer.isBuffer(r && r.name)
          ? r.name.toString('utf8')
          : (typeof (r && r.name) === 'string' ? r.name : '');
        if (!nm) continue;
        const fid = Number(r && r.face_id);
        const count = await scopedCount('photo_face2filehash', 'face_id', fid);
        if (count <= 0) continue;
        items.push({ type: 'person', label: nm, count, face_id: fid });
      }
    } catch (_) {}

    // 2) 场景
    try {
      const rows = await this.knex('photo_places')
        .where('is_hide', 0)
        .where('place_name', 'like', prefix)
        .orderBy('photo_count', 'desc')
        .limit(limit)
        .select('place_name');
      for (const r of Array.isArray(rows) ? rows : []) {
        const nm = r && r.place_name ? String(r.place_name) : '';
        if (!nm) continue;
        const count = await scopedCount('photo_places2filehash', 'place_name', nm);
        if (count <= 0) continue;
        items.push({ type: 'scene', label: nm, count });
      }
    } catch (_) {}

    // 3) 活动（独立维度，见 tablePhotoActivity.js）
    try {
      const rows = await this.knex('photo_activity')
        .where('is_hide', 0)
        .andWhereRaw("(act_name LIKE ? ESCAPE '\\' OR act_key LIKE ? ESCAPE '\\')", [prefix, prefix])
        .orderBy('photo_count', 'desc')
        .limit(limit)
        .select('act_name');
      for (const r of Array.isArray(rows) ? rows : []) {
        const nm = r && r.act_name ? String(r.act_name) : '';
        if (!nm) continue;
        const count = await scopedCount('photo_activity2filehash', 'act_name', nm);
        if (count <= 0) continue;
        items.push({ type: 'activity', label: nm, count });
      }
    } catch (_) {}

    // 4) 相机：photo_index 里相机是自由文本，取「命中的相机名 + 张数」，按张数排序
    try {
      if (scopeEmpty) throw new Error('scope');
      const camQuery = this.knex('photo_index as p')
        .where('p.is_file', 1)
        .where('p.in_trash', 0)
        .whereNotNull('p.camera')
        .andWhere('p.camera', 'like', contains)
        .select('p.camera')
        .count({ n: 'p.file_hash' })
        .groupBy('p.camera')
        .orderBy('n', 'desc')
        .limit(3);
      if (validPaths.length > 0) photoPathQueryUtil.applyPathPrefixFilter(camQuery, 'p.path', validPaths);
      const rows = await camQuery;
      for (const r of Array.isArray(rows) ? rows : []) {
        const nm = r && r.camera ? String(r.camera).trim() : '';
        if (!nm) continue;
        items.push({ type: 'camera', label: nm, count: Number((r && r.n) || 0) || 0 });
      }
    } catch (_) {}

    // 5) 文件名：不列具体文件名（太长），给一个「按文件名搜索」的入口 + 命中张数
    try {
      if (scopeEmpty) throw new Error('scope');
      const row = await visibleHashes()
        .clone()
        .where('p.filename', 'like', contains)
        .count({ n: 'p.file_hash' })
        .first();
      const n = Number((row && row.n) || 0) || 0;
      if (n > 0) items.push({ type: 'filename', label: q, count: n });
    } catch (_) {}

    // 6) OCR / FTS 文本（票面、截图、路牌上的字）
    try {
      const aiOcrEnable = await tableConfig.getConfigByKey('ai_ocr_enable').catch(() => null);
      if (aiOcrEnable === '1' && !scopeEmpty) {
        const token = q.replace(/[\s\u3000]+/g, '').replace(/["'*]/g, '');
        if (token) {
          const row = await visibleHashes()
            .clone()
            .whereRaw('p.file_hash IN (SELECT file_hash FROM photo_info_fts WHERE ocr MATCH ?)', [token + '*'])
            .count({ n: 'p.file_hash' })
            .first();
          const n = Number((row && row.n) || 0) || 0;
          if (n > 0) items.push({ type: 'ocr', label: q, count: n });
        }
      }
    } catch (_) {}

    // 7) 年份
    const yearMatch = /^(\d{4})$/.exec(q);
    if (yearMatch) {
      try {
        const row = await visibleHashes()
          .clone()
          .whereRaw("strftime('%Y', p.original_time / 1000, 'unixepoch', 'localtime') = ?", [yearMatch[1]])
          .count({ n: 'p.file_hash' })
          .first();
        const n = Number((row && row.n) || 0) || 0;
        if (n > 0) items.push({ type: 'year', label: yearMatch[1], count: n });
      } catch (_) {}
    }

    return { q, items };
  }

  /**
   * ⭐ 2026-10-14 场景语义搜索：把「夕阳下的海滩」这类自然语言查询
   * 解析成场景标签再查库（解析层见 workers/ai/places/placesQuery.js）。
   * 解析层不可用（词表缺失 / 全部未识别）时退回标签名子串匹配，
   * 行为与旧版一致 —— 搜索不能因为新模块缺件而整体失效。
   */
  async searchPlaces(params = {}) {
    const query = params && params.query !== undefined ? String(params.query).trim() : '';
    const locale = params && params.locale ? String(params.locale) : 'zh-CN';
    const hasValidPaths = Object.prototype.hasOwnProperty.call(params, 'validPaths');
    const validPaths = Array.isArray(params.validPaths) ? params.validPaths.filter(Boolean) : [];
    if (!query || (hasValidPaths && validPaths.length === 0)) {
      return { items: [], pagination: { total: 0, page: 1, pageSize: 0 }, parsed: null, mode: 'empty' };
    }

    // 1) 语义解析：自然语言 → 场景标签
    let parsed = null;
    try {
      const placesQuery = require('../../../../workers/ai/places/placesQuery');
      if (placesQuery.isAvailable()) {
        await placesQuery.ensureReady();
        parsed = placesQuery.analyze(query, { topTags: 12 });
      }
    } catch (err) {
      parsed = null;
    }

    const scored = new Map();
    if (parsed && parsed.ok && Array.isArray(parsed.tags)) {
      for (const t of parsed.tags) {
        const name = t && t.label ? String(t.label) : '';
        if (!name) continue;
        scored.set(name, { score: Number(t.score) || 0, hits: Number(t.hits) || 0 });
      }
    }
    const mode = scored.size > 0 ? 'semantic' : 'substring';

    // 2) 取候选相册：语义命中的标签 ∪ 标签名子串命中
    const semanticNames = Array.from(scored.keys());
    let rowsQuery = this.knex('photo_places')
      .select('place_name', 'photo_count', 'is_hide', 'create_time', 'update_time', 'weight_sum', 'count_high');
    if (semanticNames.length > 0) {
      rowsQuery = rowsQuery.where(function () {
        this.whereIn('place_name', semanticNames).orWhere('place_name', 'like', '%' + query + '%');
      });
    } else {
      rowsQuery = rowsQuery.where('place_name', 'like', '%' + query + '%');
    }

    // 可见性：举派前只看本人源目录（与 listPlaces 同一口径，主/次场景都算）
    if (validPaths.length > 0) {
      const buildAllowed = column => {
        const q = this.knex('photo_places2filehash as p2')
          .join('photo_index as p', 'p.file_hash', 'p2.file_hash')
          .where('p.is_file', 1)
          .where('p.in_trash', 0)
          .select(column === 'alt' ? 'p2.alt_place_name as place_name' : 'p2.place_name');
        photoPathQueryUtil.applyPathPrefixFilter(q, 'p.path', validPaths);
        return q;
      };
      rowsQuery = rowsQuery.where(function () {
        this.whereIn('place_name', buildAllowed('primary')).orWhereIn('place_name', buildAllowed('alt'));
      });
    }

    const rows = await rowsQuery.catch(() => []);
    const items = (Array.isArray(rows) ? rows : []).map(row => {
      const rawName = row && row.place_name ? String(row.place_name) : '';
      const hit = scored.get(rawName) || null;
      const keyByName = rawName ? 'places365.' + rawName : '';
      const translated = keyByName ? getTranslation(keyByName, locale) : '';
      const localized = (translated && translated !== keyByName ? translated : '') || rawName;
      return {
        place_name_raw: rawName,
        place_name: localized,
        photo_count: Number(row && row.photo_count ? row.photo_count : 0) || 0,
        weight_sum: Number(row && row.weight_sum ? row.weight_sum : 0) || 0,
        count_high: Number(row && row.count_high ? row.count_high : 0) || 0,
        is_hide: Number(row && row.is_hide ? row.is_hide : 0) || 0,
        match: hit
          ? { score: hit.score, hits: hit.hits, exact: true }
          : { score: 0, hits: 0, exact: false },
      };
    });
    items.sort((a, b) => (b.match.hits - a.match.hits)
      || (b.match.score - a.match.score)
      || (b.weight_sum - a.weight_sum));

    return {
      items,
      pagination: { total: items.length, page: 1, pageSize: items.length },
      parsed: parsed
        ? {
          normalized: parsed.normalized,
          components: parsed.components,
          tags: parsed.tags,
          unmatched: parsed.unmatched,
        }
        : null,
      mode,
    };
  }

  async updatePlaceStatus(params = {}) {
    const rawPlaceName = params.place_name ?? params.placeName ?? params.place_name_raw;
    const placeName = rawPlaceName ? String(rawPlaceName).trim() : '';
    const rawStatus = params.status ?? params.state ?? params.is_hide ?? params.isHide;
    if (!placeName) {
      const err = new Error('common.PARAM_ERROR');
      err.statusCode = 400;
      throw err;
    }
    let isHide = null;
    if (rawStatus === 'hide' || rawStatus === 'hidden' || rawStatus === 1 || rawStatus === '1' || rawStatus === true) {
      isHide = 1;
    } else if (rawStatus === 'visible' || rawStatus === 'visiable' || rawStatus === 0 || rawStatus === '0' || rawStatus === false) {
      isHide = 0;
    }
    if (isHide === null) {
      const err = new Error('common.PARAM_ERROR');
      err.statusCode = 400;
      throw err;
    }
    const existed = await this.knex('photo_places')
      .where({ place_name: placeName })
      .first()
      .catch(() => null);
    if (!existed) {
      const err = new Error('common.NOT_FOUND');
      err.statusCode = 404;
      throw err;
    }
    const where = { place_name: placeName };
    await this.knex('photo_places')
      .where(where)
      .update({ is_hide: isHide, update_time: this.knex.fn.now() })
      .catch(() => {});
    return true;
  }

  /**
   * 重置全库识别（场景 + 活动两个维度）
   *
   * ⭐ 2026-10-15：活动维度也一起重置。
   *   理由：这是「重来一遍」语义的入口，活动维度必须能被重扫，否则用户没有别的入口。
   *   （活动维度与场景维度**互相独立**：不同表、不同标志位，所以整段都是幂等的。）
   * @param {{includeActivity?: boolean}} [opts] includeActivity=false 时只重置场景
   */
  async resetPlacesRecognition(opts = {}) {
    const includeActivity = opts.includeActivity !== false;
    return this.knex.transaction(async trx => {
      const resetCount = await trx('photo_index')
        .whereNot('gen_place', 0)
        .update({ gen_place: 0 })
        .catch(() => 0);
      const clearedRelationCount = await trx('photo_places2filehash')
        .del()
        .catch(() => 0);
      const clearedPlaceCount = await trx('photo_places')
        .del()
        .catch(() => 0);

      // ⭐ 活动维度（新表，老库首次运行时会由 dbUtil 建出来；建表前查不到就跳过）
      let activityResetCount = 0;
      let clearedActivityRelationCount = 0;
      let clearedActivityCount = 0;
      if (includeActivity) {
        activityResetCount = await trx('photo_index')
          .whereNot('gen_activity', 0)
          .update({ gen_activity: 0 })
          .catch(() => 0);
        clearedActivityRelationCount = await trx('photo_activity2filehash')
          .del()
          .catch(() => 0);
        clearedActivityCount = await trx('photo_activity')
          .del()
          .catch(() => 0);
      }

      return {
        resetCount: Number(resetCount) || 0,
        clearedRelationCount: Number(clearedRelationCount) || 0,
        clearedPlaceCount: Number(clearedPlaceCount) || 0,
        activityResetCount: Number(activityResetCount) || 0,
        clearedActivityRelationCount: Number(clearedActivityRelationCount) || 0,
        clearedActivityCount: Number(clearedActivityCount) || 0,
      };
    });
  }

  /**
   * ⭐ 2026-10-16 只重置**活动维度**（场景一概不动）。
   *
   * 场景已跑完、活动只跑到一半时，「重来一遍」不该连场景一起推倒 ——
   * `/place/reset` 是「两个维度都重扫」语义，没有「只重扫活动」的口子。
   * 活动与场景完全独立：不同表、不同标志位，所以这段是幂等且不碰场景的。
   */
  async resetActivityRecognition() {
    return this.knex.transaction(async trx => {
      const activityResetCount = await trx('photo_index')
        .whereNot('gen_activity', 0)
        .update({ gen_activity: 0 })
        .catch(() => 0);
      const clearedRelationCount = await trx('photo_activity2filehash').del().catch(() => 0);
      const clearedActivityCount = await trx('photo_activity').del().catch(() => 0);
      return {
        activityResetCount: Number(activityResetCount) || 0,
        clearedActivityRelationCount: Number(clearedRelationCount) || 0,
        clearedActivityCount: Number(clearedActivityCount) || 0,
      };
    });
  }
}

module.exports = PlacesService;
