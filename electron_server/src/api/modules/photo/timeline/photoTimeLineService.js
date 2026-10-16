const knexUtil = require('../../../../db/knexUtil');
const dbUtil = require('../../../../db/dbUtil');
const path = require('path');
const fs = require('fs');
const config = require('../../../../config/config');
const userUtil = require('../../../../utils/userUtil');
const smartAlbumFilterUtil = require('../smartAlbum/photoSmartAlbumFilterUtil');
const photoPathQueryUtil = require('./photoPathQueryUtil');
const geohash = require('ngeohash');
const { createFavoriteOps } = require('./photoTimeLineFavoriteOps');
const { createTrashOps } = require('./photoTimeLineTrashOps');
const tableConfig = require('../../../../db/table/tableConfig');
const { ensureNodejiebaDictLoaded } = require('../../../../utils/nodejiebaInit');
const nodejieba = require('nodejieba');
const indexFields = [
  'id',
  'camera',
  'path',
  'filename',
  'is_file',
  'original_time',
  'original_date',
  'is_lvp',
  'is_merge_lvp',
  'live_filename',
  'raw_filename',
  'size',
  'type',
  'duration',
  'geohash',
  'geohash5',
  'ext',
  'file_hash',
  // ⭐ 2026-10-16：时间轴每个日期要显示地点名，反查时带上照片真实坐标才能取到
  // 「离这儿最近」的地名（只拿 geohash 格中心去猜，市区里会差出几公里，选错地名）。
  'latitude',
  'longitude',
];

function tokenizeForOcrMatch(text) {
  const raw = String(text || '').trim();
  if (!raw) return '';
  ensureNodejiebaDictLoaded();
  const tokens = nodejieba.cut(raw);
  if (!Array.isArray(tokens) || tokens.length === 0) return '';

  const uniq = [];
  const seen = new Set();
  for (const token of tokens) {
    const t = String(token || '')
      .replace(/[\s\u3000]+/g, '')
      .replace(/["']/g, '')
      .trim();
    if (!t) continue;
    if (!/[\p{L}\p{N}]/u.test(t)) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    uniq.push(t);
  }
  if (uniq.length === 0) return '';

  return uniq.map(t => `${t.replace(/\*+$/g, '')}*`).join(' AND ');
}
class PhotoTimeLineService {
  constructor() {
    this.dbPath = dbUtil.DB_PATHS.PHOTO_DB;
    this.favoriteOps = createFavoriteOps({ getKnex: () => this.getKnex() });
    this.trashOps = createTrashOps({
      getKnex: () => this.getKnex(),
      getValidPaths: user => this.getValidPaths(user),
      indexFields,
    });
  }

  getKnex() {
    return knexUtil.getInstance(this.dbPath);
  }

  parseTimeInput(value) {
    if (value === null || value === undefined || value === '') return null;
    if (value instanceof Date) {
      const t = value.getTime();
      return Number.isFinite(t) ? value : null;
    }
    if (typeof value === 'number') {
      const d = new Date(value);
      const t = d.getTime();
      return Number.isFinite(t) ? d : null;
    }
    const n = Number(value);
    if (Number.isFinite(n)) {
      const d = new Date(n);
      const t = d.getTime();
      return Number.isFinite(t) ? d : null;
    }
    const d = new Date(String(value));
    const t = d.getTime();
    return Number.isFinite(t) ? d : null;
  }

  /**
   * 获取用户可见的照片来源路径（按归属隔离）
   *
   * 规则：只返回「归属该用户自己」的源目录，无任何角色例外 ——
   * 管理员同样看不到别人的照片（刻意的隐私设计，不要加 isAdmin 分支）。
   * @param {Object} user 用户对象
   * @returns {Promise<string[]>} 路径列表
   */
  async getValidPaths(user) {
    const knex = this.getKnex();
    const uid = user && user.id ? Number(user.id) : 0;
    if (!Number.isFinite(uid) || uid <= 0) return [];

    const sources = await knex('photo_source').where({ uid }).select('path').catch(() => []);
    return [
      ...new Set(
        (sources || []).map(s => (s && s.path ? String(s.path).trim() : '')).filter(Boolean)
      ),
    ];
  }

  async getValidPathsByParams(params, user) {
    const validPaths = await this.getValidPaths(user);
    // 合集筛选 没有合集就返回有效路径
    const collectionId = Number(params && params.collection_id);
    if (!Number.isFinite(collectionId) || collectionId <= 0) return validPaths;
    const knex = this.getKnex();
    const collection = await knex('photo_collection').where({ id: collectionId }).first();
    if (!collection) {
      const err = new Error('common.NOT_FOUND');
      err.statusCode = 404;
      throw err;
    }

    const uid = user && user.id;
    if (user && !userUtil.isAdmin(user) && uid && Number(collection.uid) !== Number(uid)) {
      const err = new Error('auth.PERMISSION_DENIED');
      err.statusCode = 403;
      throw err;
    }

    const collectionPaths = photoPathQueryUtil.parsePathListText(collection.path_list);
    return photoPathQueryUtil.intersectPaths(validPaths, collectionPaths);
  }

  /**
   * 构建基础查询构建器
   * @param {Object} params 查询参数
   * @param {string[]} validPaths 有效路径列表
   * @returns {Promise<{query: Object}>} knex query builder wrapper
   */
  async buildBaseQuery(params, validPaths, user) {
    const knex = this.getKnex();
    const query = knex('photo_index').where('photo_index.is_file', 1).where('photo_index.in_trash', 0);
    const uid = user && user.id;

    const faceId = Number(params && params.face_id);
    if (Number.isFinite(faceId) && faceId > 0) {
      query
        .join('photo_face2filehash as pff', function () {
          this.on('photo_index.file_hash', '=', 'pff.file_hash');
        })
        .join('photo_faces as pf', 'pf.face_id', 'pff.face_id')
        .where('pf.face_id', faceId);
    }

    // ⭐ 2026-10-16 P0-2 合影组合过滤：`combo_face_ids` 是「这一组人」的根人脸 id 列表，
    // 语义是**交集**（每个成员都得在照片里出现），不是「命中任意一个」。
    // 每个成员加一个 whereExists，天然 AND；只认根人脸（与 photoSmartAlbumFilterUtil 同一口径），
    // 所以人脸合并之后组合会自动收敛，不会因为子脸 id 变了而失效。
    const comboIds = Array.isArray(params && params.combo_face_ids)
      ? params.combo_face_ids.map(v => Number(v)).filter(v => Number.isFinite(v) && v > 0)
      : [];
    const comboRoots = Array.from(new Set(comboIds));
    if (comboRoots.length > 0) {
      for (const rootId of comboRoots) {
        query.whereExists(function () {
          this.select(1)
            .from('photo_face2filehash as cf')
            .join('photo_faces as cpf', 'cpf.face_id', 'cf.face_id')
            .whereRaw('cf.file_hash = photo_index.file_hash')
            .where(function () {
              this.whereNull('cpf.belong_face_id').orWhere('cpf.belong_face_id', 0);
            })
            .where('cpf.face_id', rootId);
        });
      }
    }

    let placeName = params && (params.place_name ?? params.placeName) ? String(params.place_name ?? params.placeName).trim() : '';
    if (placeName) {
      query.join('photo_places2filehash as ppf', function () {
        this.on('photo_index.file_hash', '=', 'ppf.file_hash');
      });
      // ⭐ 2026-10-13 主场景或次场景命中都算（误判照片也有机会被翻出来）
      query.where(function () {
        this.where('ppf.place_name', placeName).orWhere('ppf.alt_place_name', placeName);
      });
    }

    // 收藏筛选
    if (params.list_type === 'favorite' && uid) {
      query.join('photo_favorite', 'photo_index.file_hash', 'photo_favorite.file_hash').where('photo_favorite.uid', uid);
    }

    // 普通相册筛选
    const albumId = Number(params.album_id);
    if (Number.isFinite(albumId) && albumId > 0) {
      query.join('photo_album_index as pai', function () {
        this.on('photo_index.file_hash', '=', 'pai.file_hash').andOnVal('pai.album_id', '=', albumId);
      });

      if (user && !userUtil.isAdmin(user) && uid) {
        query.whereExists(function () {
          this.select(1)
            .from('photo_album as pa')
            .where('pa.id', albumId)
            .where(qb => {
              qb.where('pa.uid', uid)
                .orWhere('pa.is_public', 1)
                .orWhereExists(function () {
                  this.select(1).from('photo_album_share as pas').whereRaw('pas.album_id = pa.id').where('pas.uid', uid);
                });
            });
        });
      }
    }

    // 路径过滤
    let finalPaths = validPaths;
    if (params.sourceList && Array.isArray(params.sourceList) && params.sourceList.length > 0) {
      finalPaths = photoPathQueryUtil.intersectPaths(validPaths, params.sourceList);
    }

    if (finalPaths.length === 0) {
      // 如果没有有效路径，这就应该返回空，这里用一个不可能的条件
      query.whereRaw('1 = 0');
    } else {
      photoPathQueryUtil.applyPathPrefixFilter(query, 'photo_index.path', finalPaths);
    }

    // 搜索过滤
    let searchRankExpr = null;
    if (params.search) {
      const search = params.search.trim();
      if (search) {
        const aiOcrEnable = await tableConfig.getConfigByKey('ai_ocr_enable');
        // ⭐ 场景识别开关：标签是 places365 的 115 类场景（已中文化）。
        // 注意：builder 回调是同步的，开关与语义解析必须在这里先做好。
        const aiPlaceEnable = await tableConfig.getConfigByKey('ai_place_enable').catch(() => null);
        // ⭐ 2026-10-16 P0-1：活动维度（SigLIP2 27 候选 + DETR 人物门控）与场景标签**互相独立**，
        // 表也独立（photo_activity2filehash）。开关语义与 placesWorker.initActivity() 一致：未设置 = 开。
        const aiActivityRaw = await tableConfig.getConfigByKey('ai_activity_enable').catch(() => null);
        const aiActivityEnable = !(aiActivityRaw !== null && aiActivityRaw !== undefined
          && ['0', 'false'].includes(String(aiActivityRaw).toLowerCase()));

        // ⭐ 2026-10-16 语义搜索接线（A）：
        // 旧版只把「标签名子串」并进主搜索框，于是「夕阳下的沙滩」逐字匹配不到任何标签 ⇒ 结果恒为空。
        // 这里先用 placesQuery 把自然语言解析成场景标签（「夕阳下的沙滩」→ 落日 + 海滩），再按标签精确命中。
        let semanticTags = [];
        if (aiPlaceEnable === '1') {
          try {
            const placesQuery = require('../../../../workers/ai/places/placesQuery');
            if (placesQuery.isAvailable()) {
              await placesQuery.ensureReady();
              const parsed = placesQuery.analyze(search, { topTags: 12 });
              if (parsed && parsed.ok && Array.isArray(parsed.tags)) {
                semanticTags = parsed.tags
                  .map(t => (t && t.label ? String(t.label).trim() : ''))
                  .filter(Boolean);
              }
            }
          } catch (err) {
            semanticTags = [];
          }
        }

        query.where(builder => {
          builder.where('photo_index.path', 'like', `%${search}%`).orWhere('photo_index.filename', 'like', `%${search}%`).orWhere('photo_index.camera', 'like', `%${search}%`);
          if (aiOcrEnable === '1') {
            const matchQuery = tokenizeForOcrMatch(search);
            const finalQuery =
              matchQuery ||
              `${String(search)
                .replace(/[\s\u3000]+/g, '')
                .replace(/["']/g, '')
                .trim()}*`;
            if (finalQuery !== '*') {
              console.log('finalQuery', finalQuery);
              builder.orWhereRaw('photo_index.file_hash IN (SELECT file_hash FROM photo_info_fts WHERE ocr MATCH ?)', [finalQuery]);
            }
          }
          // ⭐ 场景标签参与主搜索框：搜「海边 / 雪山 / 森林」能命中对应场景的照片。
          // 标签在写库时已中文化（placesUtil 把 labelByIndex 换成中文），所以中文直接可匹配。
          // 用 LIKE 而非等值，让「海」能同时命中「海滩 / 海岸 / 海滨小屋」。
          // 场景识别未开启时 photo_places2filehash 为空 ⇒ 子查询自然返回空，不会误伤结果。
          if (aiPlaceEnable === '1') {
            // ⭐ 2026-10-13 次可能场景（alt_place_name）也参与搜索
            builder.orWhereRaw(
              'photo_index.file_hash IN (SELECT file_hash FROM photo_places2filehash WHERE place_name LIKE ? OR alt_place_name LIKE ?)',
              [`%${search}%`, `%${search}%`]
            );
            // ⭐ 2026-10-16 语义标签精确命中：主场景 / 次场景 / alt_labels(JSON 多标签) 任一命中即算
            if (semanticTags.length > 0) {
              const inList = semanticTags.map(() => '?').join(',');
              const likeList = semanticTags.map(() => 'alt_labels LIKE ?').join(' OR ');
              builder.orWhereRaw(
                `photo_index.file_hash IN (SELECT file_hash FROM photo_places2filehash WHERE place_name IN (${inList}) OR alt_place_name IN (${inList}) OR ${likeList})`,
                [
                  ...semanticTags,
                  ...semanticTags,
                  ...semanticTags.map(t => `%"label":"${t}"%`),
                ]
              );
            }
          }
          // ⭐ 2026-10-16 P0-1：活动维度参与主搜索框。
          // 「游泳 / 露营 / 用餐 / 大笑」这类词可能只落在活动标签里（活动表与场景表是两套独立空间，
          // 见 tablePhotoActivity.js 文件头）。此前 photo_activity2filehash 只在「重置识别」时被清空，
          // 检索链路零引用 ⇒ 用户无论如何搜不到。表为空时子查询自然返回空，不会误伤结果。
          if (aiActivityEnable) {
            builder.orWhereRaw(
              'photo_index.file_hash IN (SELECT file_hash FROM photo_activity2filehash WHERE act_name LIKE ? OR act_key LIKE ?)',
              [`%${search}%`, `%${search}%`]
            );
            if (semanticTags.length > 0) {
              const inList = semanticTags.map(() => '?').join(',');
              builder.orWhereRaw(
                `photo_index.file_hash IN (SELECT file_hash FROM photo_activity2filehash WHERE act_name IN (${inList}) OR act_key IN (${inList}))`,
                [...semanticTags, ...semanticTags]
              );
            }
          }
        });

        // ⭐ 2026-10-16 排序优化（B）：多标签命中排前（「又夕又沙」先出），再按时间倒序。
        // 复用同一个标签集合算「本图命中了几个查询标签」，语义命中天然排在仅字面命中的前面。
        // ⭐ 2026-10-16 P0-1：活动命中同样加权（与场景同量级），活动照片也能前置。
        const rankParts = [];
        const rankParams = [];
        if (semanticTags.length > 0) {
          const qs = semanticTags.map(() => '?').join(',');
          rankParts.push(`COALESCE((SELECT (CASE WHEN p2.place_name IN (${qs}) THEN 1 ELSE 0 END) + (CASE WHEN p2.alt_place_name IN (${qs}) THEN 1 ELSE 0 END) FROM photo_places2filehash p2 WHERE p2.file_hash = photo_index.file_hash), 0)`);
          rankParams.push(...semanticTags, ...semanticTags);
          if (aiActivityEnable) {
            rankParts.push(`COALESCE((SELECT (CASE WHEN a2.act_name IN (${qs}) THEN 1 ELSE 0 END) FROM photo_activity2filehash a2 WHERE a2.file_hash = photo_index.file_hash), 0)`);
            rankParams.push(...semanticTags);
          }
        }
        if (aiActivityEnable) {
          rankParts.push(`COALESCE((SELECT (CASE WHEN a3.act_name LIKE ? OR a3.act_key LIKE ? THEN 1 ELSE 0 END) FROM photo_activity2filehash a3 WHERE a3.file_hash = photo_index.file_hash), 0)`);
          rankParams.push(`%${search}%`, `%${search}%`);
        }
        if (rankParts.length > 0) {
          searchRankExpr = knex.raw(rankParts.join(' + '), rankParams);
        }
      }
    }

    if (params.geohash) {
      const rawGeohash = String(params.geohash).trim();
      // ⭐ 2026-10-16 修复「足迹点开数量暴增」：
      // 足迹地图点开一个 marker 时，客户端传的是「该 marker 聚合到的**全部 geohash 格**」，
      // 用逗号分隔（各格同长度 ⇒ 同精度）。必须按格集合做**精确**匹配。
      // 旧写法把它当成一个前缀去做 LIKE，例如把 'ws0edu' 这一格当成 'ws0ed%' 去捞，
      // 范围一下子放大 32 倍 ⇒ 地图上 21 张、点进去几百张。
      if (rawGeohash.indexOf(',') > -1) {
        const cells = [];
        const seenCells = new Set();
        for (const piece of rawGeohash.split(',')) {
          const c = piece.trim();
          // geohash 字符集：0-9 b c d e f g h j k m n p q r s t u v w x y z（不含 a i l o）
          if (!c || !/^[0-9bcdefghjkmnpqrstuvwxyz]+$/.test(c)) continue;
          if (seenCells.has(c)) continue;
          seenCells.add(c);
          cells.push(c);
          // SQLite 变量上限 999，留足余量；一屏 marker 的格数远小于此
          if (cells.length >= 500) break;
        }
        // 所有格必须是同一精度，否则列对不上，直接不匹配（返回空列表好过返回错范围）
        const precision = cells.length > 0 ? cells[0].length : 0;
        const uniform = cells.length > 0 && cells.every(c => c.length === precision);
        if (uniform && precision >= 2 && precision <= 7) {
          query.whereIn(`photo_index.geohash${precision}`, cells);
        } else {
          query.whereRaw('1 = 0');
        }
      } else if (rawGeohash) {
        query.where('photo_index.geohash', 'like', `${rawGeohash}%`);
      }
    }

    // 类型筛选
    // type: 1=Photo, 2=Video
    // is_lvp: 1=LivePhoto
    if (params.fileType) {
      // fileType: 'photo', 'video', 'livephoto'
      if (params.fileType === 'photo') {
        query.where('photo_index.type', 1);
      } else if (params.fileType === 'video') {
        query.where('photo_index.type', 2);
      } else if (params.fileType === 'livephoto') {
        query.where('photo_index.is_lvp', 1);
      }
    }

    if (params.loadTheDay === true || params.loadTheDay === 1) {
      const now = new Date();
      const mm = String(now.getMonth() + 1).padStart(2, '0');
      const dd = String(now.getDate()).padStart(2, '0');
      query.where('photo_index.original_date', 'like', `%-${mm}-${dd}`);
    }

    const year = Number(params && params.year);
    if (Number.isFinite(year) && year > 0) {
      query.where('photo_index.original_date', 'like', `${year}-%`);
    }

    // 智能相册筛选
    const smartAlbumId = Number(params.smart_album_id);
    if (Number.isFinite(smartAlbumId) && smartAlbumId > 0) {
      const smartAlbum = await knex('photo_smart_album').where({ id: smartAlbumId }).first();
      if (!smartAlbum) {
        const err = new Error('common.NOT_FOUND');
        err.statusCode = 404;
        throw err;
      }
      if (user && !userUtil.isAdmin(user) && uid && Number(smartAlbum.uid) !== Number(uid)) {
        const err = new Error('auth.PERMISSION_DENIED');
        err.statusCode = 403;
        throw err;
      }

      const filterContent = smartAlbumFilterUtil.parseFilterContentText(smartAlbum.filter_content);
      smartAlbumFilterUtil.applySmartAlbumFilter(query, smartAlbum.type, filterContent, 'photo_index');
    }

    // ⭐ 2026-10-16：searchRankExpr 供列表排序用（语义命中数），其余调用方只取 query 不受影响
    return { query, searchRankExpr };
  }

  async getTimelineYearList(params, user) {
    const validPaths = await this.getValidPathsByParams(params, user);
    if (!validPaths || validPaths.length === 0) {
      return { items: [] };
    }

    const knex = this.getKnex();
    const { query } = await this.buildBaseQuery(params || {}, validPaths, user);
    const base = query.clone().clearSelect().clearOrder();

    base.whereNotNull('photo_index.original_date').andWhere('photo_index.original_date', '!=', '');

    const yearExpr = 'substr(photo_index.original_date, 1, 4)';
    const selectFields = indexFields.map(f => `photo_index.${f}`);

    base.select([
      knex.raw(`${yearExpr} as year`),
      knex.raw(`count(*) over (partition by ${yearExpr}) as year_photo_count`),
      ...selectFields,
      knex.raw(`row_number() over (partition by ${yearExpr} order by photo_index.original_time desc, photo_index.id desc) as rn`),
    ]);

    const rows = await knex.from(base.as('t')).select('*').where('rn', 1).orderByRaw('CAST(year as INTEGER) desc');

    const items = rows
      .filter(r => r && String(r.year || '').trim())
      .map(r => {
        const year = Number(r.year);
        const count = Number(r.year_photo_count);
        return {
          year: Number.isFinite(year) ? year : 0,
          count: Number.isFinite(count) ? count : 0,
          cover: {
            ...r,
            fullpath: path.join(r.path, r.filename),
          },
        };
      })
      .filter(e => e.year > 0);

    return { items };
  }

  async getVisiblePhotoTotalCount(params, user) {
    const validPaths = await this.getValidPathsByParams(params, user);
    if (!validPaths || validPaths.length === 0) {
      return { total: 0 };
    }

    const { query } = await this.buildBaseQuery(params || {}, validPaths, user);
    const row = await query.clone().count({ total: '*' }).first();
    const total = Number(row && row.total);
    return { total: Number.isFinite(total) ? total : 0 };
  }

  /**
   * 获取时间轴日期列表
   * @param {Object} params 参数
   * @param {Object} user 用户
   */
  async getTimelineDateList(params, user) {
    const validPaths = await this.getValidPathsByParams(params, user);
    if (validPaths.length === 0) {
      return { items: [], validPaths: [] };
    }

    const { query } = await this.buildBaseQuery(params, validPaths, user);

    // 按 original_date 分组
    // sort: 'asc' | 'desc'
    const sortOrder = params.sort === 'asc' ? 'asc' : 'desc';

    const result = await query.select('photo_index.original_date').count('* as date_photo_count').groupBy('photo_index.original_date').orderBy('photo_index.original_date', sortOrder);
    const items = result.filter(item => item.original_date); // 过滤掉日期为空的
    // 检测路径有效性
    const validPathsWithStatus = validPaths.map(p => ({
      path: p,
      valid: fs.existsSync(p),
    }));

    return { items, validPaths: validPathsWithStatus };
  }

  /**
   * 获取时间轴照片列表
   * @param {Object} params 参数
   * @param {Object} user 用户
   */
  /**
   * ⭐ 2026-10-16：多语言直编**召回**（不是重排）。给 SQL 臂召不回来的查询兜底。
   *
   * 阈值用**相对**口径（低于最优 cos - 0.05 的不召回），
   * ⛔ 不用绝对阈值 —— 本项目早在语义搜索实验里就实测过「CLIP 的绝对阈值不可靠」。
   * 代价：一次全库扫描（分批 4000，上限 20 万行）；只在 SQL 召回 < 20 时触发。
   */
  async _multilingualRecall(queryVec, validPaths, limit, winStart, winEnd) {
    if (!queryVec) return [];
    const knex = this.getKnex();
    const CHUNK = 4000;
    const MAX_SCAN = 200000;
    const scored = [];
    let offset = 0;
    let scanned = 0;
    for (;;) {
      const qb = knex('photo_index as p')
        .where('p.is_file', 1)
        .where('p.in_trash', 0)
        .whereNotNull('p.clip_emb')
        .select('p.file_hash', 'p.clip_emb')
        .orderBy('p.id', 'asc')
        .limit(CHUNK)
        .offset(offset);
      if (Array.isArray(validPaths) && validPaths.length > 0) {
        photoPathQueryUtil.applyPathPrefixFilter(qb, 'p.path', validPaths);
      } else {
        qb.whereRaw('1 = 0');
      }
      if (winStart && winEnd) {
        const s0 = winStart.getTime() <= winEnd.getTime() ? winStart : winEnd;
        const e0 = winStart.getTime() <= winEnd.getTime() ? winEnd : winStart;
        qb.whereBetween('p.original_time', [s0.getTime(), e0.getTime()]);
      } else if (winStart) {
        qb.where('p.original_time', '>=', winStart.getTime());
      } else if (winEnd) {
        qb.where('p.original_time', '<=', winEnd.getTime());
      }
      const rows = await qb.catch(() => []);
      if (!Array.isArray(rows) || rows.length === 0) break;
      for (const r of rows) {
        const raw = r && r.clip_emb ? (Buffer.isBuffer(r.clip_emb) ? r.clip_emb : Buffer.from(r.clip_emb)) : null;
        if (!raw) continue;
        const dim = Math.floor(raw.byteLength / 4);
        if (dim !== queryVec.length) continue;
        const vec = new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + dim * 4));
        let dot = 0;
        for (let d = 0; d < dim; d += 1) dot += vec[d] * queryVec[d];
        scored.push({ hash: String(r.file_hash), cos: dot });
      }
      scanned += rows.length;
      offset += rows.length;
      if (rows.length < CHUNK || scanned >= MAX_SCAN) break;
    }
    if (scored.length === 0) return [];
    scored.sort((a, b) => b.cos - a.cos);
    const floor = scored[0].cos - 0.05;
    return scored.filter(s => s.cos >= floor).slice(0, Math.max(1, Number(limit) || 60));
  }

  /**
   * ⭐ 2026-10-16 验证动作一（多语言 CLIP 文本塔 A/B）落地：**双路融合重排**。
   *
   * 为什么是融合而不是替换（实测依据见 docs/WaterNasOS-整合实施路线图.md §12.2）：
   *   23 条中文查询 / 95 张可评 / Top-5：
   *     词表路线 78.3%（MRR 0.684）｜ 中文直编 95.7%（MRR 0.804）｜ **融合 95.7%（MRR 0.841）**
   *   直编在「自然中文说法」上碾压词表（94.7% vs 73.7%，词表对「自然风光/纸质文件」根本解析不出标签），
   *   但裸标签查询两路都是 100% ⇒ 词表不该被砍掉，而应降级为「精排/绑定」。
   *
   * 口径：
   *   · 标签侧 = 该照片命中了几个查询标签（与 buildBaseQuery 的 searchRankExpr 同一语义，这里用 JS 复算）；
   *   · 向量侧 = cos(查询向量, 该照片 clip_emb)（P0-3 落库的 512 维向量）；
   *   · 两路各自 **z 归一化后等权相加**（量纲不同，不能直接加权）。
   * 优雅降级：没有向量的照片 cos 记 0；全批都没向量（回填未覆盖）时 z 恒为 0 ⇒ 顺序与原来基本一致。
   * 开关：配置键 `ai_multilingual_clip_enable=0` 可关掉。
   */
  async _fuseMultilingualRank(params, list, validPaths, user) {
    const search = params && params.search ? String(params.search).trim() : '';
    // ⛔ 这里**不能**用 list.length < 3 早退：词表解析不出标签时 SQL 召回就是 0 条，
    //    而那恰恰是最需要直编召回的场景（早退会让「自然风光」永远 0 结果）。
    if (!search || !Array.isArray(list)) return list;

    const flag = await tableConfig.getConfigByKey('ai_multilingual_clip_enable').catch(() => null);
    if (flag !== null && flag !== undefined && flag !== '' && ['0', 'false'].includes(String(flag).toLowerCase())) {
      return list;
    }

    const placesQuery = require('../../../../workers/ai/places/placesQuery');
    if (typeof placesQuery.encodeMultilingual !== 'function' || !placesQuery.isMultilingualAvailable()) return list;

    const queryVec = await placesQuery.encodeMultilingual(search);
    if (!queryVec) return list;

    const knex = this.getKnex();

    // ⭐⭐ 光重排不够：词表解析不出标签的查询（「自然风光」「纸质文件」）SQL 臂**召回就是 0**，
    //     再好的重排也无能为力（实测：这两个词在生产链路上仍然返回 0 条）。
    //     所以这里补一条**直编召回**：SQL 命中太少时，用查询向量在可见范围里按余弦捞一批补进来。
    //     ⚠️ 只在 SQL 召回不足时扫库，把开销限定在「词表失灵」的那些查询上。
    // 触发条件：SQL 臂**完全召回不到**（词表解析不出标签的典型情形）才扫库。
    // ⚠️ 代价声明：召回要扫全库带向量的照片（当前 2.6 万张 ≈ +1.7s；回填到 6.7 万张会到 ~3s）。
    //    所以默认只在「不召回就一定 0 结果」时才付这个代价；
    //    想更激进（例如 SQL 少于 N 条就召回）可把配置键 `ai_multilingual_recall_min` 调大。
    //    ⚠️ 后续优化方向：把向量放 sqlite-vec，或进程内缓存一次（67k×512×4B ≈ 137MB）。
    const recallMinRaw = await tableConfig.getConfigByKey('ai_multilingual_recall_min').catch(() => null);
    const MIN_SQL_RECALL = recallMinRaw === null || recallMinRaw === undefined || recallMinRaw === ''
      ? 1
      : Math.max(1, Number(recallMinRaw) || 1);
    const RECALL_LIMIT = 60;
    if (list.length < MIN_SQL_RECALL) {
      // ⚠️ 必须带上与本次请求**相同的时间窗**：时间轴是按窗口翻页的，
      //    召回若引入窗口外的照片，客户端会把它塞进不属于它的日期分组（分页语义就乱了）。
      const winStart = this.parseTimeInput(params && (params.startTime ?? params.originalTime));
      const winEnd = this.parseTimeInput(params && params.endTime);
      const recalled = await this._multilingualRecall(queryVec, validPaths, RECALL_LIMIT, winStart, winEnd);
      if (recalled.length > 0) {
        const have = new Set(list.map(x => x && x.file_hash ? String(x.file_hash) : ''));
        const missing = recalled.filter(h => !have.has(h.hash)).map(h => h.hash);
        if (missing.length > 0) {
          const uid = user && user.id ? user.id : 0;
          const fields = indexFields.map(f => `p.${f}`);
          const rq = knex('photo_index as p')
            .whereIn('p.file_hash', missing)
            .where('p.is_file', 1)
            .where('p.in_trash', 0)
            .select(fields);
          if (params && params.list_type === 'favorite') {
            rq.select(knex.raw('1 as is_favorite'));
          } else {
            rq.leftJoin('photo_favorite', function () {
              this.on('p.file_hash', '=', 'photo_favorite.file_hash').andOnVal('photo_favorite.uid', '=', uid);
            });
            rq.select(knex.raw('CASE WHEN photo_favorite.id IS NOT NULL THEN 1 ELSE 0 END as is_favorite'));
          }
          const rows = await rq.catch(() => []);
          if (Array.isArray(rows) && rows.length > 0) {
            list = list.concat(rows);
            console.log(`[search] 直编召回补入 ${rows.length} 张（SQL 臂只召回 ${Math.max(0, list.length - rows.length)} 张）`);
          }
        }
      }
    }

    const hashes = [];
    const seen = new Set();
    for (const item of list) {
      const h = item && item.file_hash ? String(item.file_hash) : '';
      if (h && !seen.has(h)) {
        seen.add(h);
        hashes.push(h);
      }
    }
    if (hashes.length === 0) return list;

    // 1) 查询标签（与主搜索同一套解析）
    let tags = [];
    try {
      const parsed = placesQuery.analyze(search, { topTags: 12 });
      if (parsed && parsed.ok && Array.isArray(parsed.tags)) {
        tags = parsed.tags.map(t => (t && t.label ? String(t.label) : '')).filter(Boolean);
      }
    } catch (_) {
      tags = [];
    }

    const CHUNK = 400;
    const tagHits = new Map();
    const cosMap = new Map();
    for (let i = 0; i < hashes.length; i += CHUNK) {
      const slice = hashes.slice(i, i + CHUNK);

      if (tags.length > 0) {
        const placeRows = await knex('photo_places2filehash')
          .whereIn('file_hash', slice)
          .select('file_hash', 'place_name', 'alt_place_name', 'alt_labels')
          .catch(() => []);
        for (const r of Array.isArray(placeRows) ? placeRows : []) {
          const h = String(r.file_hash);
          let hits = 0;
          for (const t of tags) {
            if (String(r.place_name || '') === t) hits += 1;
            else if (String(r.alt_place_name || '') === t) hits += 1;
            else if (r.alt_labels && String(r.alt_labels).indexOf('"label":"' + t + '"') > -1) hits += 1;
          }
          if (hits > 0) tagHits.set(h, Math.max(tagHits.get(h) || 0, hits));
        }
      }

      const embRows = await knex('photo_index')
        .whereIn('file_hash', slice)
        .whereNotNull('clip_emb')
        .select('file_hash', 'clip_emb')
        .catch(() => []);
      for (const r of Array.isArray(embRows) ? embRows : []) {
        const buf = r && r.clip_emb ? (Buffer.isBuffer(r.clip_emb) ? r.clip_emb : Buffer.from(r.clip_emb)) : null;
        if (!buf) continue;
        const dim = Math.floor(buf.byteLength / 4);
        if (dim !== queryVec.length) continue; // 维度不同 = 不是同一套图像塔，宁可不打分
        const vec = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + dim * 4));
        let dot = 0;
        for (let d = 0; d < dim; d += 1) dot += vec[d] * queryVec[d];
        cosMap.set(String(r.file_hash), dot);
      }
    }

    // 到这一步再判断值得不值得排序：候选太少、或几乎没有向量时保持原顺序
    if (list.length < 3 || cosMap.size < 3) return list;

    const n = list.length;
    const tagArr = new Float64Array(n);
    const cosArr = new Float64Array(n);
    for (let i = 0; i < n; i += 1) {
      const h = list[i] && list[i].file_hash ? String(list[i].file_hash) : '';
      tagArr[i] = tagHits.get(h) || 0;
      cosArr[i] = cosMap.get(h) || 0;
    }
    const zscore = arr => {
      let mean = 0;
      for (let i = 0; i < n; i += 1) mean += arr[i];
      mean /= n;
      let sd = 0;
      for (let i = 0; i < n; i += 1) sd += (arr[i] - mean) * (arr[i] - mean);
      sd = Math.sqrt(sd / n);
      const out = new Float64Array(n);
      for (let i = 0; i < n; i += 1) out[i] = sd > 1e-9 ? (arr[i] - mean) / sd : 0;
      return out;
    };
    const zTag = zscore(tagArr);
    const zCos = zscore(cosArr);
    const order = Array.from({ length: n }, (_, i) => i);
    order.sort((a, b) => (zTag[b] + zCos[b]) - (zTag[a] + zCos[a]));
    return order.map(i => list[i]);
  }

  async getTimelinePhotoList(params, user) {
    const validPaths = await this.getValidPathsByParams(params, user);
    if (validPaths.length === 0) {
      return { list: [], total: 0 };
    }

    const knex = this.getKnex();
    const uid = user.id;
    const { query, searchRankExpr } = await this.buildBaseQuery(params, validPaths, user);

    const startTime = this.parseTimeInput(params.startTime);
    const endTime = this.parseTimeInput(params.endTime);
    if (startTime && endTime) {
      const [start, end] = startTime.getTime() <= endTime.getTime() ? [startTime, endTime] : [endTime, startTime];
      query.whereBetween('photo_index.original_time', [start.getTime(), end.getTime()]);
    } else {
      console.log('缺少请求参数 startTime or endTime is null');
      return [];
    }

    // 排序：普通列表按拍摄时间排，收藏列表按收藏时间排（与影音库一致）
    const sortOrder = params.sort === 'asc' ? 'asc' : 'desc';
    // ⭐ 2026-10-16 语义搜索排序：命中查询标签数多的照片排前面（必须加在时间排序之前）
    if (searchRankExpr) {
      query.orderByRaw(`${searchRankExpr.toQuery()} DESC`);
    }
    if (params.list_type === 'favorite') {
      // 收藏列表：优先按收藏时间排序，其次按拍摄时间作为辅助排序
      query.orderBy('photo_favorite.create_time', sortOrder).orderBy('photo_index.original_time', sortOrder);
    } else {
      // 其它列表仍按拍摄时间排序
      query.orderBy('photo_index.original_time', sortOrder); // 辅助排序
    }

    const selectFields = indexFields.map(f => `photo_index.${f}`);

    if (params.list_type === 'favorite') {
      query.select([...selectFields, knex.raw('1 as is_favorite')]);
    } else {
      query.leftJoin('photo_favorite', function () {
        this.on('photo_index.file_hash', '=', 'photo_favorite.file_hash').andOnVal('photo_favorite.uid', '=', uid);
      });
      query.select([...selectFields, knex.raw('CASE WHEN photo_favorite.id IS NOT NULL THEN 1 ELSE 0 END as is_favorite')]);
    }
    let list = await query;
    // ⭐ 2026-10-16 验证动作一落地：中文直编 + 词表「双路融合」重排
    try {
      list = await this._fuseMultilingualRank(params, list, validPaths, user);
    } catch (err) {
      // 融合失败绝不能影响搜索本身：退回 SQL 原本的顺序
      console.warn('[search] 融合重排跳过：', err && err.message ? err.message : err);
    }
    console.log(query.toString());

    // 原始文件扩展名 + 原始文件扩展名（大写）用于前端展示
    function rawShowExt(item) {
      if (!item.ext) return '';
      //索引是单独的raw 返回raw扩展名
      if (config.rawImgTypeList.includes(item.ext)) {
        return item.ext.toUpperCase().replace('.', '');
      }
      if (item.raw_filename && item.raw_filename.length > 0 && item.raw_filename.indexOf('.') > -1) {
        //索引是jpg加raw 返回JPG+RAW
        return `${item.ext.toUpperCase().replace('.', '')} +${path.extname(item.raw_filename).toUpperCase().replace('.', '')}`;
      }
      return '';
    }
    // 最终返回的photoList
    let photoList = list.map(item => ({
      ...item,
      fullpath: path.join(item.path, item.filename), // 添加 fullpath
      raw_show_ext: rawShowExt(item),
    }));
    console.log("photoList",photoList.length)
    return photoList;
  }

  getBoundsPrecisionByZoom(zoom) {
    const z = Number(zoom);
    if (!Number.isFinite(z)) return 2;
    if (z <= 4) return 2;
    if (z <= 6) return 3;
    if (z <= 8) return 4;
    return 5;
  }

  normalizeBounds(params) {
    const minLat = Number(params && params.minLat);
    const minLng = Number(params && params.minLng);
    const maxLat = Number(params && params.maxLat);
    const maxLng = Number(params && params.maxLng);

    if (![minLat, minLng, maxLat, maxLng].every(Number.isFinite)) return null;

    const lowLat = Math.max(-90, Math.min(minLat, maxLat));
    const highLat = Math.min(90, Math.max(minLat, maxLat));
    const lowLng = Math.max(-180, Math.min(minLng, maxLng));
    const highLng = Math.min(180, Math.max(minLng, maxLng));

    return { minLat: lowLat, minLng: lowLng, maxLat: highLat, maxLng: highLng };
  }

  async getBoundsPhoto(params, user) {
    const bounds = this.normalizeBounds(params);
    if (!bounds) return { mapPhoto: [], precision: this.getBoundsPrecisionByZoom(params && params.zoom), hash_count: 0 };

    const requestedMaxReturnCount = Number(params && params.maxReturnCount);
    const maxReturnCount = Number.isFinite(requestedMaxReturnCount) && requestedMaxReturnCount > 0 ? Math.min(requestedMaxReturnCount, 2000) : 500;

    const validPaths = await this.getValidPathsByParams(params, user);
    if (!validPaths || validPaths.length === 0) {
      return { mapPhoto: [], precision: this.getBoundsPrecisionByZoom(params && params.zoom), hash_count: 0 };
    }

    let precision = this.getBoundsPrecisionByZoom(params && params.zoom);
    let hashes = geohash.bboxes(bounds.minLat, bounds.minLng, bounds.maxLat, bounds.maxLng, precision) || [];
    while (precision > 2 && hashes.length > maxReturnCount) {
      precision -= 1;
      hashes = geohash.bboxes(bounds.minLat, bounds.minLng, bounds.maxLat, bounds.maxLng, precision) || [];
    }

    const { query: baseQuery } = await this.buildBaseQuery(params, validPaths, user);
    const selectFields = [
      'photo_index.id',
      'photo_index.file_hash',
      'photo_index.path',
      'photo_index.filename',
      'photo_index.type',
      'photo_index.duration',
      'photo_index.original_time',
      'photo_index.geohash',
      'photo_index.latitude',
      'photo_index.longitude',
    ];

    const mapPhoto = [];
    const seenIds = new Set();
    const geoColumn = precision >= 2 && precision <= 6 ? `photo_index.geohash${precision}` : 'photo_index.geohash';

    for (const h of hashes) {
      if (mapPhoto.length >= maxReturnCount) break;
      const row = await baseQuery
        .clone()
        .whereNotNull(geoColumn)
        .andWhere(geoColumn, '!=', '')
        .andWhere(geoColumn, h)
        .andWhereRaw('NOT (photo_index.latitude = 0 AND photo_index.longitude = 0)')
        .orderBy('photo_index.original_time', 'desc')
        .orderBy('photo_index.id', 'desc')
        .select(selectFields)
        .first()
        .catch(() => null);

      if (!row || !row.id) continue;
      const id = Number(row.id);
      if (seenIds.has(id)) continue;
      seenIds.add(id);
      mapPhoto.push({ ...row, fullpath: path.join(row.path, row.filename) });
    }

    return { mapPhoto, precision, hash_count: hashes.length };
  }

  /**
   * 批量收藏/取消收藏
   * @param {Object} user 用户
   * @param {string[]} file_hashes 文件哈希列表
   * @param {boolean} is_favorite 目标状态：true=收藏，false=取消收藏
   */
  async batchFavorite(user, file_hashes, is_favorite) {
    return this.favoriteOps.batchFavorite(user, file_hashes, is_favorite);
  }

  /**
   * 切换收藏状态
   * @param {Object} user 用户
   * @param {string} file_hash 文件哈希
   */
  async toggleFavorite(user, file_hash) {
    return this.favoriteOps.toggleFavorite(user, file_hash);
  }

  /**
   * 批量将照片放入回收站或从回收站移出
   * @param {number[]} ids 照片ID列表
   * @param {boolean} in_trash 是否放入回收站
   * @param {Object} user 当前用户，用于非管理员的删除权限校验
   */
  async batchTrash(ids, in_trash, user) {
    return this.trashOps.batchTrash(ids, in_trash, user);
  }

  /** ⭐ 2026-10-16 P0-6：批量预演（只算代价，不写库） */
  async previewTrash(ids, in_trash, user) {
    return this.trashOps.previewTrash(ids, in_trash, user);
  }

  /** ⭐ 2026-10-16 P0-6：执行并留可撤销日志 */
  async batchTrashLogged(ids, in_trash, user) {
    return this.trashOps.batchTrashLogged(ids, in_trash, user);
  }

  /** ⭐ 2026-10-16 P0-6：最近可撤销操作 */
  async recentOperations(user, limit) {
    return this.trashOps.recentOperations(user, limit);
  }

  /** ⭐ 2026-10-16 P0-6：撤销一次操作 */
  async undoOperation(operationId, user) {
    return this.trashOps.undoOperation(operationId, user);
  }

  /**
   * 获取回收站内的照片列表
   * @param {Object} params 查询参数
   * @param {Object} user 用户
   */
  async getTrashPhotoList(params, user) {
    return this.trashOps.getTrashPhotoList(params, user);
  }

  /**
   * 从回收站中删除（物理删除）
   * @param {number[]} ids 照片ID列表
   * @param {boolean} recycle 是否放入系统回收站
   * @param {Object} user 用户信息
   * @param {Object} options 删除选项
   * @param {number} options.deleteLivePhotoFile 是否删除关联的livephoto文件
   * @param {number} options.deleteRawFile 是否删除关联的raw文件
   */
  async deleteFromTrash(ids, recycle = false, user, options = {}) {
    return this.trashOps.deleteFromTrash(ids, recycle, user, options);
  }

  /**
   * 从回收站中恢复
   * @param {number[]} ids 照片ID列表
   */
  async restoreFromTrash(ids) {
    return this.trashOps.restoreFromTrash(ids);
  }

  async restoreAllFromTrash(user) {
    return this.trashOps.restoreAllFromTrash(user);
  }

  /**
   * 清空回收站
   * @param {Object} user 用户
   * @param {boolean} recycle 是否放入系统回收站
   * @param {Object} options 删除选项
   * @param {number} options.deleteLivePhotoFile 是否删除关联的livephoto文件
   * @param {number} options.deleteRawFile 是否删除关联的raw文件
   */
  async emptyTrash(user, recycle = false, options = {}) {
    return this.trashOps.emptyTrash(user, recycle, options);
  }
}

module.exports = new PhotoTimeLineService();
