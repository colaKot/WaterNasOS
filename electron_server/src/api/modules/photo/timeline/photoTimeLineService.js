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
        });

        // ⭐ 2026-10-16 排序优化（B）：多标签命中排前（「又夕又沙」先出），再按时间倒序。
        // 复用同一个标签集合算「本图命中了几个查询标签」，语义命中天然排在仅字面命中的前面。
        if (semanticTags.length > 0) {
          const qs = semanticTags.map(() => '?').join(',');
          searchRankExpr = knex.raw(
            `COALESCE((SELECT (CASE WHEN p2.place_name IN (${qs}) THEN 1 ELSE 0 END) + (CASE WHEN p2.alt_place_name IN (${qs}) THEN 1 ELSE 0 END) FROM photo_places2filehash p2 WHERE p2.file_hash = photo_index.file_hash), 0)`,
            [...semanticTags, ...semanticTags]
          );
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
    const list = await query;
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
