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
}

module.exports = PlacesService;
