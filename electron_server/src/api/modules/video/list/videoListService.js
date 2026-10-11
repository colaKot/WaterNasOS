const path = require('path');
const fs = require('fs');
const VideoSourceService = require('../source/videoSourceService');
const userUtil = require('../../../../utils/userUtil');
const Logger = require('../../../../utils/logger');
const { intersectPaths, parsePathListText } = require('../../photo/timeline/photoPathQueryUtil');
const smartAlbumFilterUtil = require('../smartAlbum/videoSmartAlbumFilterUtil');
const { applyVisibleIndexFilter, escapeLikeValue, LIKE_ESCAPE } = require('../videoVisibilityUtil');

/**
 * 列表页的可见性过滤。
 *
 * ⭐ 已改为委托共用模块 `videoVisibilityUtil.applyVisibleIndexFilter` ——
 * 原来这份实现是「前缀 + 带分隔符边界 + 目录行特判」，
 * 而库计数（`library/videoLibraryService._applyIndexPathFilter`）漏了目录行特判、
 * 详情鉴权（`detail/detailController._ensureIndexAccess`）又用完全不同的单向下沉匹配，
 * 三处口径不一致 ⇒ 出现「列表能看、点详情 403」和「列表有片子但库计数为 0」。
 * 现在统一到一处，后续只维护 videoVisibilityUtil。
 */
function _applyVideoIndexPathPrefixFilter(query, paths) {
  applyVisibleIndexFilter(query, paths, { alias: 'v' });
}

function _resolveArtworkAbsolute({ baseDir, maybeRelative }) {
  const p = maybeRelative === undefined || maybeRelative === null ? '' : String(maybeRelative).trim();
  if (!p) return '';
  if (path.isAbsolute(p)) return p;
  const base = baseDir === undefined || baseDir === null ? '' : String(baseDir).trim();
  if (!base) return '';
  return path.resolve(base, p);
}

/* ==========================================================================
 * 同名图片兜底封面（2026-10-10）
 *
 * 需求：图片视频混合库、以及普通影视库里，如果目录里存在**与视频同名的图片**，
 *      这张图片就是这个视频的封面图 / 缩略图；如果既没有封面图也没有缩略图，
 *      那么不管前端选「封面图」还是「缩略图」，都显示这张同名图片。
 *
 * 扫描期其实已经做过这件事 —— workers/videoIndex/videoIndexIndexUtil.js 的
 * `resolveArtworkPaths` 会把 `videoBase` 本身放进 poster 候选列表。但它只在
 * **扫描那一刻**生效：若同名图片是后来才放进目录的（或视频先被扫到、图片后到），
 * `poster_path` 就一直空着。所以列表返回前这里再兜底一次。
 *
 * ⚠️ 只在 poster_path 与 fanart_path **都为空**时才填，并且**两个一起填**：
 *    抢已有封面（比如 TMDB 刮下来的 poster.jpg）会很难解释；
 *    而只填一个的话，另一种模式仍然空白，就不满足「不管选哪个都显示它」。
 *
 * 成本：一页至多 pageSize 个目录，每目录 1 次 readdir，按目录缓存 60s。
 * ========================================================================*/
const _SAME_NAME_IMAGE_TTL_MS = 60 * 1000;
const _SAME_NAME_IMAGE_CACHE_MAX = 2000;
/** dir → { at, map }；map: 归一化基名 → 文件名 */
const _sameNameImageDirCache = new Map();

function _isSameNameImageExt(ext) {
  const e = String(ext || '').toLowerCase();
  return (
    e === '.jpg' ||
    e === '.jpeg' ||
    e === '.png' ||
    e === '.webp' ||
    e === '.gif' ||
    e === '.bmp' ||
    e === '.avif'
  );
}

/** 与扫描期 `_normalizeSimpleName` 完全同一套规则（lower + 去空白 + 去 _-），
 *  否则「扫描期认得出、列表期认不出」会变成最难查的那种不一致。 */
function _normalizeSameNameKey(s) {
  return String(s || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[_-]+/g, '');
}

/* ==========================================================================
 * 同名图片「隐身」（2026-10-11）
 *
 * 需求：图片视频混合库里，如果某张图片与同目录下的**影片同名**，这张图片就
 *      不再单独出现在列表里 —— 它已经作为那张影片的封面 / 缩略图了
 *      （扫描期 `resolveArtworkPaths` 就把 `videoBase` 当 poster 候选，
 *        列表期 `_fillSameNameImageFallback` 再兜一次底）。
 *      否则同一张图会出现两次：一次是图片卡片、一次是影片的封面。
 *
 * 实现要点：
 *  * 判定放在 **SQL 里**（`NOT EXISTS`），不能只在 JS 里过滤已经取回的那一页 ——
 *    那样 `total` 会偏大、而且每页会少若干条，翻页时数量对不上。
 *  * 视频侧的 scope 与混合库取数**共用同一套**（exactPaths / prefixPaths）：
 *    只有在影片真的会展示出来时才藏图片，否则图片会凭空消失、又没有影片顶上。
 *  * SQL 与 JS 的归一化必须**结果一致**（同一个 `_normalizeSameNameKey` 语义），
 *    否则会出现「列表里藏了图、文件夹卡片还在数它」这种最难查的一类不一致。
 *
 * 成本：`image_index` 每行一次 `v.path = i.path` 索引查找（走
 *      `uidx_video_index_path_filename` 前缀）+ 一次归一化比较。
 *      实测库5（991 影片 / 3740 图）`count(*)` ≈ 74ms（后缀表按命中率排序后
 *      从 102ms 降下来；不排序分支平均要跑 11 次 LIKE，排完只要 3~4 次）。
 * ========================================================================*/

/** 判「同名」时剥掉的后缀。**按实际命中率排序** —— SQLite 的 CASE 是按顺序
 *  求值的，把 .jpg/.png/.mp4 放前面能显著减少 LIKE 次数（实测 102ms → 74ms）。
 *  ⚠️ 不要加入含 LIKE 通配符（`%` / `_`）的后缀。 */
const _SAME_NAME_STRIP_EXTS = [
  '.jpg',
  '.png',
  '.mp4',
  '.jpeg',
  '.webp',
  '.gif',
  '.bmp',
  '.mov',
  '.m4v',
  '.mkv',
  '.avi',
  '.avif',
  '.wmv',
  '.flv',
  '.webm',
  '.mpg',
  '.mpeg',
  '.3gp',
  '.ts',
  '.m2ts',
  '.rmvb',
  '.rm',
  '.heic',
];

/** SQL 侧「剥掉一个后缀 + 归一化」表达式，等价于 JS 的
 *  `_normalizeSameNameKey(path.basename(name, path.extname(name)))`。 */
function _normBaseSqlExpr(col) {
  const cases = _SAME_NAME_STRIP_EXTS.map(
    ext => `WHEN lower(${col}) LIKE '%${ext}' THEN substr(${col}, 1, length(${col}) - ${ext.length})`
  ).join(' ');
  const stripped = `CASE ${cases} ELSE ${col} END`;
  return `replace(replace(replace(lower(${stripped}), ' ', ''), '_', ''), '-', '')`;
}

/** 给图片查询加上「与影片同名 ⇒ 不出现」的过滤。
 *  scope 形状与 `_resolveFolderScope` 的返回值一致：(exactPaths | prefixPaths) */
function _applyHideSameNameImageFilter(query, knex, scope) {
  const exprI = _normBaseSqlExpr('i.filename');
  const exprV = _normBaseSqlExpr('v.filename');
  const exact = scope ? scope.exactPaths : null;
  const prefix = scope ? scope.prefixPaths : null;

  query.whereNotExists(function () {
    this.select(knex.raw('1')).from('video_index as v');
    this.whereIn('v.media_type', VIDEO_INDEX_MEDIA_TYPES);
    if (Array.isArray(exact)) {
      if (exact.length > 0) this.whereIn('v.path', exact);
      else this.whereRaw('1 = 0');
    } else if (Array.isArray(prefix) && prefix.length > 0) {
      applyVisibleIndexFilter(this, prefix, { alias: 'v' });
    } else {
      this.whereRaw('1 = 0');
    }
    this.whereRaw('v.path = i.path');
    this.whereRaw(`${exprV} = ${exprI}`);
  });
  return query;
}

function _readDirImageBaseMap(dir) {
  const key = String(dir || '');
  if (!key) return null;
  const now = Date.now();
  const hit = _sameNameImageDirCache.get(key);
  if (hit && now - hit.at < _SAME_NAME_IMAGE_TTL_MS) return hit.map;

  const map = new Map();
  try {
    const entries = fs.readdirSync(key, { withFileTypes: true });
    for (const ent of entries || []) {
      if (!ent || !ent.isFile()) continue;
      const name = ent.name;
      if (name.startsWith('.')) continue;
      // ⚠️ 剥后缀必须用**原样大小写**的 ext：`path.basename('a.JPG', '.jpg')`
      //    返回的是 'a.JPG'（不剥），于是归一化键变成 'ajpg'、永远匹配不上。
      const extRaw = path.extname(name);
      if (!_isSameNameImageExt(extRaw)) continue;
      const norm = _normalizeSameNameKey(path.basename(name, extRaw));
      if (!norm) continue;
      if (!map.has(norm)) map.set(norm, name);
    }
  } catch (_) {
    // 目录不可读（挂载掉线 / 权限）⇒ 缓存一张空表，避免每页都去 stat 同一批目录
  }

  if (_sameNameImageDirCache.size >= _SAME_NAME_IMAGE_CACHE_MAX) {
    _sameNameImageDirCache.clear();
  }
  _sameNameImageDirCache.set(key, { at: now, map });
  return map;
}

/** 就地给一页视频行补「同名图片」，返回补上的条数（仅用于日志/自检） */
function _fillSameNameImageFallback(items) {
  const list = Array.isArray(items) ? items : [];
  let filled = 0;
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    if (item.media_type === 'image') continue; // 图片自己不需要封面
    const poster = item.poster_path ? String(item.poster_path).trim() : '';
    const fanart = item.fanart_path ? String(item.fanart_path).trim() : '';
    if (poster || fanart) continue; // 已有封面 / 缩略图：不抢
    const dir = item.path ? String(item.path).trim() : '';
    const name = item.filename ? String(item.filename).trim() : '';
    if (!dir || !name) continue;
    const base = _normalizeSameNameKey(path.basename(name, path.extname(name)));
    if (!base) continue;
    const map = _readDirImageBaseMap(dir);
    const hit = map ? map.get(base) : '';
    if (!hit) continue;
    // 绝对路径：_normalizeListRow 的 _resolveArtworkAbsolute 对绝对路径原样返回
    const abs = path.join(dir, hit);
    item.poster_path = abs;
    item.fanart_path = abs;
    filled += 1;
  }
  return filled;
}

function _normalizeListRow(row) {
  if (!row || typeof row !== 'object') return row;
  const baseDir = row.path === undefined || row.path === null ? '' : String(row.path).trim();
  const poster = _resolveArtworkAbsolute({ baseDir, maybeRelative: row.poster_path });
  const fanart = _resolveArtworkAbsolute({ baseDir, maybeRelative: row.fanart_path });
  const logo = _resolveArtworkAbsolute({ baseDir, maybeRelative: row.logo_path });
  const fullPath = baseDir && row.filename ? path.join(baseDir, String(row.filename)) : '';
  const playRelPath = row.play_rel_path === undefined || row.play_rel_path === null ? '' : String(row.play_rel_path).trim();
  const playFilePath = row && (row.media_type === 'bdmv' || row.media_type === 'video_ts') && fullPath && playRelPath ? path.resolve(fullPath, playRelPath) : '';
  return {
    ...row,
    poster_path: poster,
    fanart_path: fanart,
    logo_path: logo,
    full_path: fullPath,
    play_file_path: playFilePath,
    first_file_path: row && (row.media_type === 'bdmv' || row.media_type === 'video_ts') && playFilePath ? playFilePath : row.first_file_path,
  };
}

async function _getFirstEpisodeRowUnderFolder({ knex, rootFolder }) {
  const resolved = rootFolder ? path.resolve(String(rootFolder)) : '';
  if (!resolved) return null;
  const prefix = resolved.endsWith(path.sep) ? resolved : `${resolved}${path.sep}`;

  return await knex('video_index')
    .where({ is_file: 1, media_type: 'episod' })
    .andWhere(qb => {
      qb.where('path', resolved).orWhere('path', 'like', `${prefix}%`);
    })
    .orderBy('episod_num', 'asc')
    .orderBy('id', 'asc')
    .first('path', 'filename')
    .catch(() => null);
}

async function _fillFirstFilePathForTvRows({ knex, rows }) {
  const list = Array.isArray(rows) ? rows : [];
  const tvRows = list.filter(r => r && r.media_type === 'tv');
  if (tvRows.length === 0) return;

  await Promise.all(
    tvRows.map(async r => {
      const poster = r.poster_path ? String(r.poster_path).trim() : '';
      const fanart = r.fanart_path ? String(r.fanart_path).trim() : '';
      if (poster || fanart) return;
      const baseDir = r.path ? String(r.path).trim() : '';
      const name = r.filename ? String(r.filename).trim() : '';
      if (!baseDir || !name) return;
      const showFolder = path.join(baseDir, name);

      const first = await _getFirstEpisodeRowUnderFolder({
        knex,
        rootFolder: showFolder,
      });
      const epPath = first && first.path ? String(first.path).trim() : '';
      const epName = first && first.filename ? String(first.filename).trim() : '';
      if (!epPath || !epName) return;
      r.first_file_path = path.join(epPath, epName);
    })
  );
}

function _normalizeKeyList(input) {
  if (Array.isArray(input)) {
    return input.map(v => String(v || '').trim()).filter(Boolean);
  }
  const s = input === undefined || input === null ? '' : String(input).trim();
  if (!s) return [];
  if (s.startsWith('[')) {
    try {
      const arr = JSON.parse(s);
      return Array.isArray(arr) ? arr.map(v => String(v || '').trim()).filter(Boolean) : [];
    } catch (_) {
      return [];
    }
  }
  return s
    .split(',')
    .map(v => String(v || '').trim())
    .filter(Boolean);
}

function _escapeLikeValue(input) {
  return String(input || '')
    .replaceAll('\\', '\\\\')
    .replaceAll('%', '\\%')
    .replaceAll('_', '\\_');
}

function _applyCommaSeparatedFieldExactContains(query, columnName, value) {
  const v = String(value || '').trim();
  if (!v) return;
  const escaped = _escapeLikeValue(v);
  const pattern = `%,${escaped},%`;
  query.andWhereRaw(`(',' || replace(replace(replace(${columnName}, '，', ','), ', ', ','), ' ,', ',') || ',') LIKE ? ESCAPE '\\'`, [pattern]);
}

function _normalizeIntList(input) {
  if (Array.isArray(input)) {
    const nums = input
      .map(v => Number(v || 0) || 0)
      .map(v => Math.trunc(v))
      .filter(v => v > 0);
    return [...new Set(nums)];
  }
  const s = input === undefined || input === null ? '' : String(input).trim();
  if (!s) return [];
  if (s.startsWith('[')) {
    try {
      const arr = JSON.parse(s);
      if (!Array.isArray(arr)) return [];
      const nums = arr
        .map(v => Number(v || 0) || 0)
        .map(v => Math.trunc(v))
        .filter(v => v > 0);
      return [...new Set(nums)];
    } catch (_) {
      return [];
    }
  }
  const nums = s
    .split(',')
    .map(v => Number(String(v || '').trim() || 0) || 0)
    .map(v => Math.trunc(v))
    .filter(v => v > 0);
  return [...new Set(nums)];
}

/* =========================================================================
 * 文件夹视图（图片库 / 混合库）用的路径工具
 * -------------------------------------------------------------------------
 * ⚠️ 这里的「本级」口径与 `photoPathQueryUtil.intersectPaths` 那套
 *    「前缀 = 整棵子树」是**两回事**，不要混用：
 *      * 前缀口径 → 搜索 / 来源筛选 / 平铺视图（要看子孙）
 *      * 本级口径 → 文件夹列表 + 目录内文件（只看直接子项，
 *                   否则点进上层目录会把几万张子孙图片一次性倒出来）
 * =======================================================================*/
function _stripTrailingSep(input) {
  let s = input === undefined || input === null ? '' : String(input).trim();
  while (s.length > 1 && (s.endsWith('/') || s.endsWith('\\'))) {
    if (/^[a-zA-Z]:[\\/]$/.test(s)) break; // 保留盘符根 "D:\"，否则会变成 "D:"
    s = s.slice(0, -1);
  }
  return s;
}

/** Windows 下盘符与大小写不敏感，Linux/macOS 严格区分 —— 三种比较都要走这里 */
function _pathEquals(a, b) {
  return process.platform === 'win32'
    ? String(a).toLowerCase() === String(b).toLowerCase()
    : String(a) === String(b);
}

/** child 是否位于 parent 之内（含两者相等） */
function _isPathInside(child, parent) {
  const c = _stripTrailingSep(child);
  const p = _stripTrailingSep(parent);
  if (!c || !p) return false;
  if (_pathEquals(c, p)) return true;
  const rootWithSep = p.endsWith('/') || p.endsWith('\\') ? p : `${p}${path.sep}`;
  if (c.length <= rootWithSep.length) return false;
  return _pathEquals(c.slice(0, rootWithSep.length), rootWithSep);
}

/** dir 相对 root 的路径：'' = 就是 root 本身；null = 不在 root 内 */
function _relToRoot(dir, root) {
  const d = _stripTrailingSep(dir);
  const r = _stripTrailingSep(root);
  if (!d || !r) return null;
  if (_pathEquals(d, r)) return '';
  const rootWithSep = r.endsWith('/') || r.endsWith('\\') ? r : `${r}${path.sep}`;
  if (d.length <= rootWithSep.length) return null;
  if (!_pathEquals(d.slice(0, rootWithSep.length), rootWithSep)) return null;
  return d.slice(rootWithSep.length);
}

/** 在 roots 里挑出包含 target 的**最长**根（多个来源相互嵌套时的正确归属） */
function _matchRoot(target, roots) {
  let best = null;
  for (const r of roots || []) {
    if (!_isPathInside(target, r)) continue;
    if (!best || _stripTrailingSep(r).length > _stripTrailingSep(best).length) best = r;
  }
  return best;
}

// 列表层支持的 media_type：movie/tv 为影视，image 为图片（图片库 / 混合库使用）
const LIST_MEDIA_TYPES = ['movie', 'tv', 'image'];
const VIDEO_INDEX_MEDIA_TYPES = ['movie', 'tv', 'bdmv', 'video_ts'];
const SEASON_MEDIA_TYPES = ['movie', 'tv', 'season', 'bdmv', 'video_ts'];

function _normalizeMediaType(input) {
  const v = String(input || '')
    .trim()
    .toLowerCase();
  if (LIST_MEDIA_TYPES.includes(v)) return v;
  return '';
}

function _normalizeMediaTypeList(input) {
  if (Array.isArray(input)) {
    const list = input.map(v => _normalizeMediaType(v)).filter(Boolean);
    return [...new Set(list)];
  }
  const s = input === undefined || input === null ? '' : String(input).trim();
  if (!s) return [];
  if (s.startsWith('[')) {
    try {
      const arr = JSON.parse(s);
      if (!Array.isArray(arr)) return [];
      const list = arr.map(v => _normalizeMediaType(v)).filter(Boolean);
      return [...new Set(list)];
    } catch (_) {
      return [];
    }
  }
  const single = _normalizeMediaType(s);
  return single ? [single] : [];
}

function _normalizeSortBy(input) {
  const v = String(input || '')
    .trim()
    .toLowerCase();
  // ⭐ 'taken_at'（拍摄时间）2026-10-12 加入白名单：图片库 / 混合库默认排它。
  //    不加的话会被下面的兜底改成 create_time，前端选了"拍摄时间"却没反应。
  if (v === 'taken_at' || v === 'year' || v === 'score' || v === 'create_time' || v === 'name' || v === 'favorite_time' || v === 'view_time') return v;
  return 'create_time';
}

function _normalizeSortOrder(input) {
  const v = String(input || '')
    .trim()
    .toLowerCase();
  return v === 'asc' ? 'asc' : 'desc';
}

/**
 * ⭐ 混合库的排序键映射（2026-10-12）。
 *
 * 视频侧没有 `taken_at`（拍摄时间），只有 `create_time`（入库时间）。
 * 若图片侧按 taken_at、视频侧按 create_time，两侧就是**两个不同的时钟** ——
 * 表现为混排序列里图片和视频各占一段，而不是真交错。
 * 所以混合库里把 `taken_at` 统一降到 `create_time`：
 *   · 图片库（纯 image_index）：仍走 `taken_at`，真实拍摄时间有意义
 *   · 混合库：两侧都走 `create_time`，口径一致
 * 前端菜单文案仍是「拍摄时间」，服务端做映射，前端无需感知。
 */
function _mixedEffectiveSortBy(sortBy) {
  return sortBy === 'taken_at' ? 'create_time' : sortBy;
}

/**
 * 混合库「图片侧条目 id」的命名空间偏移量（2026-10-12）。
 *
 * image_index 与 video_index 的 id 各自从 1 自增 ⇒ **会撞号**。混合库把两类
 * 条目放在同一个 `items` 数组里给前端，撞号会导致 ValueKey 冲突 / 按 id 定位
 * 跳错条。这里给图片侧 id 加上一个足够大的常量偏移，保证：
 *   · 与 video_index 的 id 空间不重叠（video_index 实测 max ≈ 3.3e5）
 *   · 与原 image_index id 不重叠（实测 max ≈ 7.5e4）
 * 取值 1e9 留出两个数量级余量；响应里另有 `image_id` 保留原始 id。
 */
const MIXED_IMAGE_ID_OFFSET = 1000000000;

/**
 * 混合库 keyset 分页游标编解码（2026-10-12）。
 *
 * 游标 = 「上一页最后一条的**排序键** + 来源侧 + 表内 id」，格式：
 *   `${sortKey}\u0001${src}\u0001${sid}`
 *     sortKey: 统一投影成 TEXT 的排序键（name → lower(name)；
 *              时间 → printf('%020d', …)）
 *     src    : 0 = image_index，1 = video_index
 *     sid    : 该表内的 id（两表 id 会撞号 ⇒ 必须配 src 才唯一）
 *
 * ⚠️ 分隔符用 \u0001 而不是 `|`：排序键是**任意文件名**，完全可能包含 `|`，
 *    用 `|` 会把游标切错（实测文件名里带 `|` 的并不罕见）。
 * ⚠️ JSON 会转义反斜杠，中文与反斜杠都安全；但为了和 SQL 里 `lower()`
 *    的结果逐字节一致，这里**不做任何 URL/JSON 包装**，原样存原样比。
 */
function _encodeMixedCursor(sortKey, src, sid) {
  return `${sortKey === undefined || sortKey === null ? '' : sortKey}\u0001${Number(src) || 0}\u0001${Number(sid) || 0}`;
}

function _decodeMixedCursor(raw) {
  const s = String(raw == null ? '' : raw);
  if (!s) return null;
  const parts = s.split('\u0001');
  if (parts.length !== 3) return null;
  const src = Number(parts[1]);
  const sid = Number(parts[2]);
  if (!Number.isFinite(src) || !Number.isFinite(sid)) return null;
  return { key: parts[0], src, sid };
}

/** image_index 的主排序列表达式（必须与 _makeImageQuery 的 ORDER BY 一字不差） */
function _imageSortColumnExpr(sortBy) {
  // ⭐ name 走 natural_name（数字段补零后的 lower(filename)）而不是 lower(filename)：
  //    后者是逐字符文本序 ⇒ 1,10,11,2,20…；前者是自然序 ⇒ 1,2,10,11,20…
  //    见 utils/firstLetterUtil.getNaturalSortKey。
  if (sortBy === 'name') return 'i.natural_name';
  if (sortBy === 'view_time') return 'i.view_time';
  if (sortBy === 'create_time') return 'i.create_time';
  return 'i.taken_at';
}

/** video_index 的主排序列表达式（与 _listMixedPaged 里视频侧 ORDER BY 一致） */
function _videoSortColumnExpr(sortBy) {
  // ⭐ 同图片侧：name 走 natural_name（自然序），不是 lower(nfo_name) 文本序
  if (sortBy === 'name') return 'v.natural_name';
  if (sortBy === 'view_time') return 'v.view_time';
  return 'v.create_time';
}

/**
 * 在 query 上加 keyset 条件：只保留「排在 (key, id) 之后」的行。
 *
 * 二元组比较，方向随 `order`：
 *   asc : (col > key) OR (col = key AND id > id)
 *   desc: (col < key) OR (col = key AND id < id)
 *
 * ⚠️ `idCol` 必须传**当前查询用的表别名**（图片侧 `i.id`、视频侧 `v.id`）——
 *    写死 `i.id` 会让视频侧的条件恒真（`v.id` 与 `i.id` 无关），表现为
 *    「翻页时视频侧每次都从第一条重新来」。
 * ⚠️ `col = key` 对字符串列必须成立 —— name 走的是 `lower()` 表达式，
 *    所以比较的是「同样 lower 之后的值」，与游标里存的小写一致。
 */
function _applyKeysetAfter(q, { columnExpr, idCol, key, id, order }) {
  const asc = order === 'asc';
  const op = asc ? '>' : '<';
  const idOp = asc ? '>' : '<';
  const idExpr = idCol || 'i.id';
  if (key === null || key === undefined) {
    // 键为空的边界：空键在同方向下要么全在最前、要么全在最后，用 IS NULL 处理
    q.andWhere(b => {
      b.whereRaw(`${columnExpr} IS NULL AND ${idExpr} ${idOp} ?`, [id]);
      b.orWhereRaw(`${columnExpr} IS NOT NULL`);
    });
    return;
  }
  q.andWhere(b => {
    b.whereRaw(`${columnExpr} ${op} ?`, [key]);
    b.orWhereRaw(`(${columnExpr} = ? AND ${idExpr} ${idOp} ?)`, [key, id]);
  });
}

class VideoListService {
  constructor(knexVideo) {
    this.knexVideo = knexVideo;
  }

  async _getFilterOptions(baseQuery) {
    const idsSubQuery = baseQuery.clone().clearSelect().clearOrder().select('v.id');

    const yearRows = await baseQuery
      .clone()
      .clearSelect()
      .clearOrder()
      .distinct({ year: 'v.nfo_year' })
      .whereNotNull('v.nfo_year')
      .andWhere('v.nfo_year', '>', 0)
      .orderBy('v.nfo_year', 'desc')
      .limit(200)
      .catch(() => []);
    const years = (yearRows || [])
      .map(r => Number(r && (r.year ?? r.nfo_year)) || 0)
      .map(v => Math.trunc(v))
      .filter(v => v > 0);

    const regionRows = await this.knexVideo('video_index2key as k')
      .distinct('k.key')
      .whereIn('k.index_id', idsSubQuery)
      .andWhere('k.key_type', 'region')
      .orderBy('k.key', 'asc')
      .limit(500)
      .catch(() => []);
    const regions = (regionRows || []).map(r => (r && r.key ? String(r.key).trim() : '')).filter(Boolean);

    const genreRows = await this.knexVideo('video_index2key as k')
      .distinct('k.key')
      .whereIn('k.index_id', idsSubQuery)
      .andWhere('k.key_type', 'genres')
      .orderBy('k.key', 'asc')
      .limit(500)
      .catch(() => []);
    const genres = (genreRows || []).map(r => (r && r.key ? String(r.key).trim() : '')).filter(Boolean);

    return {
      years,
      regions,
      genres,
    };
  }

  async getValidPaths(user, libraryId = 0) {
    const sourceService = new VideoSourceService(this.knexVideo);
    return await sourceService.getValidPaths(user, libraryId);
  }

  async _ensureLibraryExists(libraryId) {
    const id = Number(libraryId || 0) || 0;
    if (!id) return null;
    const row = await this.knexVideo('video_library').where({ id }).first('id', 'name', 'lib_type').catch(() => null);
    if (!row) {
      const err = new Error('video.VIDEO_LIBRARY_NOT_FOUND');
      err.statusCode = 404;
      throw err;
    }
    return row;
  }

  // 允许的 media_type 集合：图片库/混合库要放行 image
  _resolveAllowedMediaTypes({ includeSeason, library, mediaTypeList }) {
    const base = includeSeason ? SEASON_MEDIA_TYPES : VIDEO_INDEX_MEDIA_TYPES;
    const libType = library && library.lib_type ? String(library.lib_type) : '';
    const allowImage = libType === 'image' || libType === 'mixed' || (Array.isArray(mediaTypeList) && mediaTypeList.includes('image'));
    return allowImage ? [...base, 'image'] : base;
  }

  /* ==========================================================================
   * 图片库 / 混合库：走独立的 image_index 表
   *
   * 拆表理由与表结构见 db/table/tableImageIndex.js。
   * 这里的关键差异：
   *   * 用 `library_id` **等值**过滤（不再靠 `path LIKE '前缀%'`）
   *   * 排序主键是 `taken_at` + `id`，配 (library_id, taken_at DESC, id DESC) 走索引
   *     ⇒ 实测 7 万条深分页 2ms（原来 OFFSET 到 6 万要扫全表）
   *   * 混合库把图片和视频**各自取够页数后在内存归并**（两边都有序，成本很低）
   * ========================================================================*/

  /** 图片表的路径可见性过滤。
   *  ⚠️ 不能复用 applyVisibleIndexFilter：它带「目录行特判」，会引用 image_index
   *     并不存在的 `is_file` 列 → SQL 直接报错。 */
  _applyImagePathPrefixFilter(query, paths, alias = 'i') {
    const list = Array.isArray(paths) ? paths.map(p => String(p || '').trim()).filter(Boolean) : [];
    if (list.length === 0) {
      query.whereRaw('1 = 0');
      return query;
    }
    const sep = path.sep;
    query.where(builder => {
      for (const p of list) {
        const prefix = p.endsWith(sep) ? p : `${p}${sep}`;
        builder.orWhere(function () {
          this.where(`${alias}.path`, p).orWhereRaw('?? LIKE ? ESCAPE ?', [
            `${alias}.path`,
            `${escapeLikeValue(prefix)}%`,
            LIKE_ESCAPE,
          ]);
        });
      }
    });
    return query;
  }

  _applyImageSearch(query, search, alias = 'i') {
    const s = String(search === undefined || search === null ? '' : search).trim();
    if (!s) return query;
    const isSingleLetterFilter = s.length === 1 && (s === '#' || /^[a-zA-Z]$/.test(s));
    if (isSingleLetterFilter) {
      query.andWhere(`${alias}.filename_fl`, s.toUpperCase());
    } else {
      query.andWhere(`${alias}.filename`, 'like', `%${s}%`);
    }
    return query;
  }

  /** 仅匹配**目录自身**（不含任何子目录）的图片行。
   *  与 _applyImagePathPrefixFilter（前缀 = 整棵子树）互补：文件夹视图里
   *  「这个目录里有哪些文件」必须用这个，否则会把所有子孙目录的图一起倒出来。
   *  走 idx_image_index_lib_path (library_id, path) 索引，whereIn 成本很低。 */
  _applyImageExactPathFilter(query, paths, alias = 'i') {
    const list = Array.isArray(paths) ? paths.map(p => String(p || '').trim()).filter(Boolean) : [];
    if (list.length === 0) {
      query.whereRaw('1 = 0');
      return query;
    }
    query.whereIn(`${alias}.path`, list);
    return query;
  }

  /** 把「文件夹浏览」参数解析成实际查询口径。
   *  folderMode:
   *    'exact'   → 只看本目录自身的文件（folderPath 为空 = 各来源根目录自身）
   *    'subtree' → 看整棵子树（搜索用；folderPath 为空 = 整库）
   *    其他/缺省 → 完全保持原行为（整库前缀过滤，即平铺视图）—— 向后兼容
   *  ⚠️ folderPath 必须落在 validPaths 之内，否则直接 403：
   *     这是防「拿任意路径去探库」的唯一一道闸门。 */
  _resolveFolderScope({ folderPath, folderMode, validPaths }) {
    const mode = String(folderMode || '').trim().toLowerCase();
    const cur = _stripTrailingSep(folderPath);
    if (mode !== 'exact' && mode !== 'subtree') {
      return { exactPaths: null, prefixPaths: validPaths };
    }
    if (!cur) {
      if (mode === 'exact') {
        const roots = Array.isArray(validPaths)
          ? validPaths.map(p => _stripTrailingSep(p)).filter(Boolean)
          : [];
        return { exactPaths: roots, prefixPaths: validPaths };
      }
      return { exactPaths: null, prefixPaths: validPaths };
    }
    if (!_matchRoot(cur, validPaths)) {
      const err = new Error('auth.PERMISSION_DENIED');
      err.statusCode = 403;
      throw err;
    }
    return mode === 'exact'
      ? { exactPaths: [cur], prefixPaths: validPaths }
      : { exactPaths: null, prefixPaths: [cur] };
  }

  /** 构造图片查询（每次调用返回全新 query，便于 count / select 各用一份）。
   *  `hideSameNameVideo` 非空时（混合库）：与影片同名的图片不再出现。 */
  _makeImageQuery({ libraryId, search, sortBy, sortOrder, paths, exactPaths, hideSameNameVideo, afterKey, afterId }) {
    const q = this.knexVideo('image_index as i').where('i.library_id', Number(libraryId) || 0);
    this._applyImageSearch(q, search);
    if (Array.isArray(exactPaths)) {
      this._applyImageExactPathFilter(q, exactPaths);
    } else {
      this._applyImagePathPrefixFilter(q, paths);
    }
    if (hideSameNameVideo) {
      _applyHideSameNameImageFilter(q, this.knexVideo, hideSameNameVideo);
    }

    const order = sortOrder === 'asc' ? 'asc' : 'desc';
    // ⭐ keyset 分页（2026-10-12）：给一张/混合库翻页用。传了 afterKey/afterId
    //    就只取「在 (afterKey, afterId) 之后」的行 —— 二元组比较，同键行
    //    跨页不会重复或漏。详见 _listMixedPaged 的游标说明。
    if (afterKey !== undefined && afterKey !== null) {
      _applyKeysetAfter(q, {
        columnExpr: _imageSortColumnExpr(sortBy),
        idCol: 'i.id',
        key: afterKey,
        id: Number(afterId) || 0,
        order,
      });
    }
    if (sortBy === 'name') {
      // ⭐ 必须与 _imageSortColumnExpr 一致（自然序，不是 lower(filename) 文本序）
      q.orderBy('i.natural_name', order);
    } else if (sortBy === 'view_time') {
      q.orderBy('i.view_time', order);
    } else if (sortBy === 'create_time') {
      // ⭐ 2026-10-12：原来落进 else ⇒ 按 taken_at（拍摄时间）排。但「添加时间」是
      //    create_time（扫描入库时间），两者在截图 / 下载图里能差好几年。
      q.orderBy('i.create_time', order);
    } else {
      // 默认 / 'taken_at'：拍摄时间
      q.orderBy('i.taken_at', order);
    }
    // ⭐ 末位 id 必须与主排序**同向**：混合库在 JS 里归并时要靠这个顺序
    //    保证「同键」项在两侧各自稳定，否则同一张图在翻页时会重复 / 漏。
    q.orderBy('i.id', order);
    return q;
  }

  /** image_index 行 → 与 video_index 行同构的结构（前端 VideoHomeItemBean 直接复用） */
  _imageRowToListItem(row) {
    const pathDir = row && row.path ? String(row.path) : '';
    const name = row && row.filename ? String(row.filename) : '';
    return {
      id: Number(row && row.id) || 0,
      media_type: 'image',
      path: pathDir,
      filename: name,
      ext: row && row.ext ? String(row.ext) : '',
      is_file: 1,
      width: Number(row && row.width) || 0,
      height: Number(row && row.height) || 0,
      duration: 0,
      nfo_name: name,
      nfo_year: 0,
      nfo_score: 0,
      nfo_regions: '',
      nfo_genres: '',
      poster_path: '',
      fanart_path: '',
      logo_path: '',
      play_rel_path: '',
      view_time: row ? row.view_time : null,
      create_time: row ? row.create_time : null,
      taken_at: Number(row && row.taken_at) || 0,
      size: Number(row && row.size) || 0,
      full_path: pathDir && name ? path.join(pathDir, name) : '',
      play_file_path: '',
    };
  }

  _imageSelectColumns() {
    return [
      'i.id',
      'i.path',
      'i.filename',
      'i.ext',
      'i.width',
      'i.height',
      'i.size',
      'i.taken_at',
      'i.view_time',
      'i.create_time',
      'i.is_favorite',
    ];
  }

  /** 图片库（lib_type = 'image'）：整库只查 image_index */
  async _listImageOnlyPaged({ library, safePage, safeLimit, offset, search, sortBy, sortOrder, uid, validPaths, sourceList, folderPath, folderMode }) {
    const libId = Number(library && library.id) || 0;
    let paths = validPaths;
    if (Array.isArray(sourceList) && sourceList.length > 0) {
      paths = intersectPaths(paths, sourceList);
    }
    const scope = this._resolveFolderScope({ folderPath, folderMode, validPaths: paths });
    const imgArgs = {
      libraryId: libId,
      search,
      sortBy,
      sortOrder,
      paths: scope.prefixPaths,
      exactPaths: scope.exactPaths,
    };

    const countRow = await this._makeImageQuery(imgArgs)
      .clearSelect()
      .clearOrder()
      .count({ cnt: '*' })
      .first()
      .catch(() => null);
    const total = Math.max(0, Number(countRow && (countRow.cnt ?? countRow['count(*)'])) || 0);

    const rows = await this._makeImageQuery(imgArgs)
      .select(this._imageSelectColumns())
      .limit(safeLimit)
      .offset(offset)
      .catch(() => []);

    const items = (rows || []).map(r => _normalizeListRow(this._imageRowToListItem(r)));

    if (uid && items.length > 0) {
      const ids = items.map(r => Number(r && r.id) || 0).filter(v => v > 0);
      const favSet = await this._loadImageFavoriteSet(ids);
      for (const item of items) {
        item.is_favorite = favSet.has(Number(item.id) || 0);
      }
    } else {
      for (const item of items) item.is_favorite = false;
    }

    const totalPages = Math.ceil(total / safeLimit);
    return {
      items,
      filters: { years: [], regions: [], genres: [] },
      validPaths: (validPaths || []).map(p => ({ path: p, valid: fs.existsSync(p) })),
      pagination: {
        total,
        page: safePage,
        limit: safeLimit,
        totalPages,
        hasNextPage: safePage < totalPages,
        hasPrevPage: safePage > 1,
      },
    };
  }

  /** 混合库（lib_type = 'mixed'）：图片与视频各取够页数后在内存归并 */
  async _listMixedPaged({ library, safePage, safeLimit, offset, search, sortBy, sortOrder, uid, validPaths, sourceList, folderPath, folderMode, cursorRaw }) {
    const libId = Number(library && library.id) || 0;
    const knex = this.knexVideo;
    let paths = validPaths;
    if (Array.isArray(sourceList) && sourceList.length > 0) {
      paths = intersectPaths(paths, sourceList);
    }
    const scope = this._resolveFolderScope({ folderPath, folderMode, validPaths: paths });
    // ⭐ 混合库归并排序的方向（图片侧在 _makeImageQuery 里另算一次，口径一致）
    const order = sortOrder === 'asc' ? 'asc' : 'desc';
    // ⭐ 混合库里 taken_at 统一降到 create_time：视频侧没有拍摄时间，
    //    两侧必须同一个时钟才可能真交错（详见 _mixedEffectiveSortBy）。
    const mixedSortBy = _mixedEffectiveSortBy(sortBy);
    // ⭐ 混合库里「与影片同名的图片」不再单独出现（需求 2026-10-11）：
    //    它已经作为那张影片的封面 / 缩略图了。判定走 SQL，口径与视频侧完全一致。
    const imgArgs = {
      libraryId: libId,
      search,
      sortBy: mixedSortBy,
      sortOrder,
      paths: scope.prefixPaths,
      exactPaths: scope.exactPaths,
      hideSameNameVideo: { exactPaths: scope.exactPaths, prefixPaths: scope.prefixPaths },
    };

    // ---- 分页策略：**游标 + 单条 UNION 归并**（2026-10-12 重写 第 3 版）----
    //
    // 走过的坑（都实测复现过）：
    //   ① 原始实现：两侧各取前 take 条 → JS 归并 → slice(offset)。take 被
    //      MERGE_CAP=3000 封顶 ⇒ 深分页整页重复（3782 行只有 3294 个唯一 id）。
    //   ② JS 里"两侧各取 window 条候选再归并"：**永远无法保证窗口够大**。
    //      实测图片名普遍排在视频名之前 ⇒ 图片侧把窗口全部占满，视频侧的候选
    //      根本没进窗口，`merged[limit]` 落在一个视频上，游标就在两个值之间
    //      来回震荡（p1 与 p3 的 nextCursor 完全相同）。
    //
    // ✅ 现方案：把**归并本身交给 SQL**（UNION ALL + 统一排序键列），
    //    这样 keyset 游标由 SQLite 自己保证单调，不再依赖 JS 侧窗口够不够。
    //    两侧键类型不同（图片按 filename、视频按 nfo_name||filename；时间列
    //    也都是整数），所以 UNION 时把排序键统一成 **TEXT** 形式：
    //        · name       : lower(名字)
    //        · 时间类      : printf('%020d', 时间列) —— 补零后字符串序 == 数值序
    //    再配 `src`（0=图片 / 1=视频）与各自 id 做完整 tiebreak。
    //    ⚠️ 时间列可能为 NULL ⇒ COALESCE(...,0)，否则 printf 出 NULL 会排乱。
    //
    // 实际实现见 _mixedUnionPage：它把「原样返回给前端的列」与「排序键」分开，
    // 只用后者排序 / seek，避免把排序键混进响应。
    const cursor = _decodeMixedCursor(cursorRaw);
    const pageLimit = Math.max(1, Math.min(safeLimit, 200));

    const imgCountRow = await this._makeImageQuery(imgArgs)
      .clearSelect()
      .clearOrder()
      .count({ cnt: '*' })
      .first()
      .catch(() => null);
    const imageTotal = Math.max(0, Number(imgCountRow && (imgCountRow.cnt ?? imgCountRow['count(*)'])) || 0);

    // ---- 视频侧 base（沿用原有可见性 / 搜索条件）----
    const vidBase = () => {
      const q = knex('video_index as v').whereIn('v.media_type', VIDEO_INDEX_MEDIA_TYPES);
      if (Array.isArray(scope.exactPaths)) {
        // 本级：只取直接放在这些目录里的视频（与图片侧口径一致）
        if (scope.exactPaths.length > 0) q.whereIn('v.path', scope.exactPaths);
        else q.whereRaw('1 = 0');
      } else if (scope.prefixPaths && scope.prefixPaths.length > 0) {
        applyVisibleIndexFilter(q, scope.prefixPaths, { alias: 'v' });
      } else {
        q.whereRaw('1 = 0');
      }
      if (search) {
        const s = String(search).trim();
        const isSingleLetterFilter = s.length === 1 && (s === '#' || /^[a-zA-Z]$/.test(s));
        if (isSingleLetterFilter) q.andWhere(b => b.where('v.nfo_name_fl', s.toUpperCase()).orWhere('v.filename_fl', s.toUpperCase()));
        else q.andWhere(b => b.where('v.nfo_name', 'like', `%${s}%`).orWhere('v.filename', 'like', `%${s}%`));
      }
      return q;
    };

    const vidCountRow = await vidBase().clearSelect().clearOrder().countDistinct({ cnt: 'v.id' }).first().catch(() => null);
    const videoTotal = Math.max(0, Number(vidCountRow && (vidCountRow.cnt ?? vidCountRow['count(*)'])) || 0);

    // ---- 一把 SQL 完成「两侧归并 + 游标 + 取 limit」----
    const rows = await this._mixedUnionPage({
      imgQuery: this._makeImageQuery(imgArgs).select(this._imageSelectColumns()),
      vidQuery: vidBase().select(
        'v.id', 'v.media_type', 'v.path', 'v.filename', 'v.ext', 'v.is_file', 'v.width', 'v.height',
        'v.duration', 'v.nfo_name', 'v.nfo_year', 'v.nfo_score', 'v.nfo_regions', 'v.nfo_genres',
        'v.poster_path', 'v.fanart_path', 'v.logo_path', 'v.play_rel_path', 'v.view_time', 'v.create_time',
      ),
      sortBy: mixedSortBy,
      order,
      cursor,
      pageLimit,
    });

    const pageEntries = rows.slice(0, pageLimit);
    const last = pageEntries.length > 0 ? pageEntries[pageEntries.length - 1] : null;
    const nextCursor = last ? _encodeMixedCursor(last.sortKey, last.kind === 'img' ? 0 : 1, last.sid) : null;

    const pageSlice = pageEntries.map(e => {
      const c = { ...e.row };
      if (e.kind === 'img') {
        // ⛔ 混合库里 image_index.id 与 video_index.id **会撞号**（各表独立自增，
        //    实测两张表都有 id=1..5）。而前端的 items 会被当成一个列表用
        //    （GetX 的 `items` + `ValueKey(id)`），id 撞号 ⇒ 列表项渲染错乱、
        //    右侧导航按 id 定位会跳错条。
        //    所以混合库里给图片侧的 id 打上命名空间；原 id 留在 image_id 里，
        //    需要回查图片表的场景（缩略图 / 头像）用 image_id。
        c.image_id = Number(e.row && e.row.id) || 0;
        c.id = MIXED_IMAGE_ID_OFFSET + (Number(e.row && e.row.id) || 0);
        c.media_type = c.media_type || 'image';
      }
      return _normalizeListRow(c);
    });

    // 视频侧没有封面 / 缩略图时，用同目录的同名图片兜底（见 _fillSameNameImageFallback）
    _fillSameNameImageFallback(pageSlice);

    const total = imageTotal + videoTotal;

    if (uid && pageSlice.length > 0) {
      const favSet = await this._loadImageFavoriteSet(pageSlice.filter(r => r.media_type === 'image').map(r => Number(r.id) || 0));
      for (const item of pageSlice) {
        if (item.media_type === 'image') item.is_favorite = favSet.has(Number(item.id) || 0);
      }
    }

    // ⚠️ 游标模式下「有没有下一页」以 SQL 是否多返回了一条为准（pageLimit+1），
    //    不能靠 safePage < totalPages 推 —— total 是全量过滤计数。
    const hasMoreByCursor = rows.length > pageEntries.length;
    const totalPages = Math.ceil(total / safeLimit);
    return {
      items: pageSlice,
      filters: { years: [], regions: [], genres: [] },
      validPaths: (validPaths || []).map(p => ({ path: p, valid: fs.existsSync(p) })),
      pagination: {
        total,
        page: safePage,
        limit: safeLimit,
        totalPages,
        hasNextPage: hasMoreByCursor,
        hasPrevPage: safePage > 1,
        // 前端翻下一页时原样回传；为空串表示已到末页
        nextCursor: hasMoreByCursor && nextCursor ? nextCursor : '',
      },
    };
  }

  /**
   * 混合库「两侧归并 + 游标 seek + 取一页」的**单条 SQL**实现（2026-10-12）。
   *
   * 为什么不在 JS 里归并：见 `_listMixedPaged` 顶部注释 —— JS 侧候选窗口
   * 永远无法保证够大（一侧可能把窗口占满），实测游标会在两个值间震荡。
   * 交给 SQLite 后，排序与游标 seek 由同一把比较器完成，天然单调。
   *
   * 实现要点：
   *   · 两侧各包一层子查询，把「排序键」统一投影成 **TEXT**：
   *       name        → lower(名字)
   *       时间类       → printf('%020d', COALESCE(时间列, 0))   （补零 ⇒ 字符串序 == 数值序）
   *     ⚠️ 不能用数字列直接 UNION：图片/视频两侧的时间列都可能有 NULL，
   *        且 SQLite 里 TEXT 与 INTEGER 混合排序会按类型分堆，结果不可预期。
   *   · 统一加 `src`（0=图片 / 1=视频）、`sid`（表内 id）作为 tiebreak，
   *     保证**全序唯一**，page 边界不会重复或漏。
   *   · 游标 = (sortKey, src, sid) 三元组的 keyset 比较。
   *   · 外层 `limit pageLimit+1` —— 多取一条用来判断还有没有下一页。
   */
  async _mixedUnionPage({ imgQuery, vidQuery, sortBy, order, cursor, pageLimit }) {
    const knex = this.knexVideo;
    const dir = order === 'asc' ? 'asc' : 'desc';
    const isName = sortBy === 'name';
    const isView = sortBy === 'view_time';

    // 排序键统一投影成 TEXT：
    //   name    → lower(名字)
    //   时间类   → printf('%020d', COALESCE(时间列, 0))
    //             （补零 ⇒ 定宽 ⇒ 字符串序 == 数值序；NULL 兜成 0）
    const keySql = (nameExpr, timeCol) =>
      isName
        ? nameExpr
        : `printf('%020d', COALESCE(${isView ? 'view_time' : timeCol}, 0))`;

    // ⛔ UNION ALL 是按**位置**对齐列的，不是按名字。两侧列名/列数都不一样
    //    （图片 11 列、视频 20 列），直接 select 数组会整体错位 ——
    //    实测视频行的 `filename` 里塞进了 `path`，`path` 里塞进了 `media_type`。
    // ✅ 所以两侧都显式 `AS` 成同一套**统一列名**，再 UNION。
    //    两边不会同时为真的字段用 NULL 占位，最后按 `src` 还原。
    const U = {
      id: 'uid',                 // 各自表内 id（= 排序用的 sid）
      media_type: 'umedia_type',
      path: 'upath',
      filename: 'ufilename',
      ext: 'uext',
      width: 'uwidth',
      height: 'uheight',
      size: 'usize',
      taken_at: 'utaken_at',
      view_time: 'uview_time',
      create_time: 'ucreate_time',
      is_favorite: 'uis_favorite',
      // 视频专属
      is_file: 'uis_file',
      duration: 'uduration',
      nfo_name: 'unfo_name',
      nfo_year: 'unfo_year',
      nfo_score: 'unfo_score',
      nfo_regions: 'unfo_regions',
      nfo_genres: 'unfo_genres',
      poster_path: 'uposter_path',
      fanart_path: 'ufanart_path',
      logo_path: 'ulogo_path',
      play_rel_path: 'uplay_rel_path',
    };
    const IMG_COL = {
      id: 'i.id', media_type: null, path: 'i.path', filename: 'i.filename', ext: 'i.ext',
      width: 'i.width', height: 'i.height', size: 'i.size', taken_at: 'i.taken_at',
      view_time: 'i.view_time', create_time: 'i.create_time', is_favorite: 'i.is_favorite',
    };
    const VID_COL = {
      id: 'v.id', media_type: 'v.media_type', path: 'v.path', filename: 'v.filename', ext: 'v.ext',
      width: 'v.width', height: 'v.height', size: null, taken_at: null,
      view_time: 'v.view_time', create_time: 'v.create_time', is_favorite: null,
      is_file: 'v.is_file', duration: 'v.duration', nfo_name: 'v.nfo_name',
      nfo_year: 'v.nfo_year', nfo_score: 'v.nfo_score', nfo_regions: 'v.nfo_regions',
      nfo_genres: 'v.nfo_genres', poster_path: 'v.poster_path', fanart_path: 'v.fanart_path',
      logo_path: 'v.logo_path', play_rel_path: 'v.play_rel_path',
    };
    // ⚠️ 为 NULL 占位列必须用 knex.raw —— 传字符串 'NULL' 会被 knex 当成
    //    **列名**加反引号（实测报 `no such column: NULL`）。
    const projCols = map =>
      Object.keys(U).map(k =>
        map[k] ? `${map[k]} AS ${U[k]}` : knex.raw(`NULL AS ${U[k]}`),
      );

    // keyset：游标三元组 (sortKey, src, sid)
    // 条件： (k OP ck) OR (k = ck AND (src OP cs OR (src = cs AND sid OP cid)))
    // ⚠️ src 与 sid 分别用**字面量**比较（不是列比较），所以这边按两侧各自
    //    展开成一个布尔式，避免 SQLite 把 `0 >= 1` 之类当列引用。
    const applyCursor = (q, isImg) => {
      if (!cursor) return q;
      const ck = `${cursor.key}`;
      const cs = Number(cursor.src) || 0;
      const cid = Number(cursor.sid) || 0;
      const src = isImg ? 0 : 1;
      const op = order === 'asc' ? '>' : '<';
      const keyExpr = keySql(
        isImg ? 'i.natural_name' : 'v.natural_name',
        isImg ? 'i.create_time' : 'v.create_time',
      );
      const idExpr = isImg ? 'i.id' : 'v.id';
      // 本侧是否可能排在同键游标之后：
      //   asc  : src > cs           → 本侧(src)更大即可
      //          src == cs          → 再看 id > cid
      //   desc : src < cs           → 本侧(src)更小即可
      //          src == cs          → 再看 id < cid
      const afterBySrc = op === '>' ? src > cs : src < cs;
      const sameSrc = src === cs;
      let tail;
      if (afterBySrc) tail = '1 = 1';
      else if (sameSrc) tail = `${idExpr} ${op} ${cid}`;
      else tail = '1 = 0';
      return q.whereRaw(`(${keyExpr} ${op} ? OR (${keyExpr} = ? AND (${tail})))`, [ck, ck]);
    };

    const imgRaw = imgQuery
      .clone()
      .clearSelect()
      .clearOrder()
      .select(projCols(IMG_COL, true))
      .select(knex.raw(`${keySql('i.natural_name', 'i.create_time')} AS sort_key`))
      .select(knex.raw('0 AS src'));

    const vidRaw = vidQuery
      .clone()
      .clearSelect()
      .clearOrder()
      .select(projCols(VID_COL, false))
      .select(knex.raw(`${keySql('v.natural_name', 'v.create_time')} AS sort_key`))
      .select(knex.raw('1 AS src'));

    const imgSql = applyCursor(imgRaw, true).toSQL();
    const vidSql = applyCursor(vidRaw, false).toSQL();
    // ⛔ 不能用 knex 的 unionAll() —— 它会把两侧各包一层括号生成
    //    `union all (select ...) union all (select ...)`，SQLite 在带
    //    尾部 ORDER BY / LIMIT 时对这种写法直接报 `near "(": syntax error`
    //    （实测）。所以自己拼字符串，两侧都用裸 SELECT。
    const sql = `SELECT * FROM (${imgSql.sql}) UNION ALL SELECT * FROM (${vidSql.sql}) ORDER BY sort_key ${dir}, src ${dir}, ${U.id} ${dir} LIMIT ${Number(pageLimit) + 1}`;

    let rows;
    try {
      rows = await knex.raw(sql, [...imgSql.bindings, ...vidSql.bindings]);
    } catch (e) {
      // 兜底：宁可少一页，也不要 500
      rows = [];
    }

    return (rows || []).map(r => {
      const isImg = Number(r.src) === 0;
      // 按统一列名还原成「该侧原本的行结构」（前端 VideoHomeItemBean 认这套字段）
      const row = {};
      for (const k of Object.keys(U)) {
        if (k === 'id') continue; // id 交给调用方按 src 决定是否加偏移
        row[k] = r[U[k]];
      }
      row.id = Number(r[U.id]) || 0;
      if (isImg) row.media_type = 'image';
      return {
        kind: isImg ? 'img' : 'vid',
        sortKey: r.sort_key,
        sid: Number(r[U.id]) || 0,
        row,
      };
    });
  }

  /** 图片收藏集合（video_favorite 仍按 index_id 存，图片 id 与 video_index id 可能撞号，
   *  所以这一版**不做图片收藏**，统一返回空集合，等设计好独立收藏表再开。 */
  async _loadImageFavoriteSet(_ids) {
    return new Set();
  }
  /* =======================================================================
   * 文件夹视图（图片库 / 混合库）：只列**直接子文件夹** + 本级文件数
   * -----------------------------------------------------------------------
   * 先按目录 GROUP BY 把整棵子树压成「一行一目录」，再在内存里上卷到直接
   * 子文件夹 —— 成本与**目录数**同阶，而不是与文件数同阶
   * （实测库6：70,978 张图只对应 1,242 个目录）。
   * 封面用每个目录的 min(id) 再一次性回查，不做 N+1。
   * ===================================================================== */
  async listImageFolders(params, user) {
    const libraryId = Number(params && (params.library_id ?? params.libraryId)) || 0;
    const library = await this._ensureLibraryExists(libraryId);
    const libType = library && library.lib_type ? String(library.lib_type).trim().toLowerCase() : '';
    const libId = Number(library && library.id) || 0;
    const validPaths = await this.getValidPaths(user, libId);
    const roots = (validPaths || []).map(p => _stripTrailingSep(p)).filter(Boolean);

    const rawPath = String((params && (params.folderPath ?? params.folder_path ?? params.path)) || '').trim();
    const currentPath = _stripTrailingSep(rawPath);
    // ⭐ 唯一一道「不许拿任意路径来探库」的闸门
    if (currentPath && !_matchRoot(currentPath, roots)) {
      const err = new Error('auth.PERMISSION_DENIED');
      err.statusCode = 403;
      throw err;
    }

    const matchedRoot = currentPath ? _matchRoot(currentPath, roots) : null;
    const atRoot = !currentPath || (matchedRoot && _pathEquals(currentPath, matchedRoot));
    const parentPath = atRoot ? null : path.dirname(currentPath);

    const base = {
      path: currentPath,
      parentPath,
      segments: [],
      roots,
      folders: [],
      selfCount: 0,
      selfImageCount: 0,
      selfVideoCount: 0,
      hasSubFolders: false,
    };

    // 非图片 / 混合库：本接口不适用。**刻意不抛错** ——
    // `video.VIDEO_LIBRARY_TYPE_UNSUPPORTED` 在客户端没有对应翻译，
    // 抛出去只会把原始 key 甩到用户脸上；这里记日志并返回空结果，
    // 让前端自然退化成它原来的视图。
    if (libType !== 'image' && libType !== 'mixed') {
      Logger.warn('[video/image/folders] 非图片/混合库，返回空结果', { libraryId: libId, libType });
      return base;
    }
    if (roots.length === 0) return base;

    const scopeRoots = currentPath ? [currentPath] : roots;
    const sep = path.sep;

    // ---- ① 图片侧：每个目录一行（数量 + 该目录的最小 id 当封面）----
    // ⭐ 混合库要跟列表页同一口径：与影片同名的图片**不计入**，否则文件夹卡片
    //    上的数量会比点进去看到的多，而且多出来的正好是「已经当封面那张图」。
    const imageDirsQuery = this.knexVideo('image_index as i')
      .where('i.library_id', libId)
      .modify(qb => this._applyImagePathPrefixFilter(qb, scopeRoots));
    if (libType === 'mixed') {
      _applyHideSameNameImageFilter(imageDirsQuery, this.knexVideo, { prefixPaths: scopeRoots });
    }
    const imageDirs = await imageDirsQuery
      .select('i.path')
      .count({ cnt: '*' })
      .min({ coverId: 'i.id' })
      .groupBy('i.path')
      .orderBy('i.path', 'asc')
      .catch(() => []);

    // ---- ② 视频侧（仅混合库）----
    let videoDirs = [];
    if (libType === 'mixed') {
      videoDirs = await this.knexVideo('video_index as v')
        .whereIn('v.media_type', VIDEO_INDEX_MEDIA_TYPES)
        .modify(qb => {
          if (scopeRoots.length > 0) applyVisibleIndexFilter(qb, scopeRoots, { alias: 'v' });
          else qb.whereRaw('1 = 0');
        })
        .select('v.path')
        .count({ cnt: '*' })
        .min({ coverId: 'v.id' })
        .groupBy('v.path')
        .orderBy('v.path', 'asc')
        .catch(() => []);
    }

    const folderMap = new Map(); // childPath -> entry
    const imageCoverIds = [];
    const videoCoverIds = [];
    let selfImageCount = 0;
    let selfVideoCount = 0;

    // dirRows 已按 path 升序，所以「第一个非 0 的 coverId」是确定性的，
    // 不会因为扫描顺序变化导致封面来回跳。
    const fold = (dirRows, kind) => {
      for (const r of dirRows || []) {
        const dir = _stripTrailingSep(r && r.path);
        const count = Number(r && r.cnt) || 0;
        if (!dir || count <= 0) continue;
        const root = _matchRoot(dir, scopeRoots);
        if (!root) continue;
        const rel = _relToRoot(dir, root);
        if (rel === null) continue;
        if (rel === '') {
          // 直接躺在当前目录（或来源根）里的文件 —— 不算子文件夹
          if (kind === 'image') selfImageCount += count;
          else selfVideoCount += count;
          continue;
        }
        const seg = rel.split(sep).filter(Boolean)[0];
        if (!seg) continue;
        const childPath = path.join(currentPath || root, seg);
        let entry = folderMap.get(childPath);
        if (!entry) {
          entry = {
            name: seg,
            path: childPath,
            imageCount: 0,
            videoCount: 0,
            coverKind: kind,
            coverId: 0,
          };
          folderMap.set(childPath, entry);
        }
        if (kind === 'image') entry.imageCount += count;
        else entry.videoCount += count;
        const coverId = Number(r && r.coverId) || 0;
        if (entry.coverId <= 0 && coverId > 0) {
          entry.coverId = coverId;
          entry.coverKind = kind;
          if (kind === 'image') imageCoverIds.push(coverId);
          else videoCoverIds.push(coverId);
        }
      }
    };
    fold(imageDirs, 'image');
    fold(videoDirs, 'video');

    // ---- ③ 封面回查：两张表各一次 whereIn，不做 N+1 ----
    const coverOf = new Map();
    const loadCovers = async (ids, kind) => {
      const uniq = [...new Set(ids.filter(v => v > 0))];
      if (uniq.length === 0) return;
      const isImage = kind === 'image';
      const rows = await this.knexVideo(isImage ? 'image_index' : 'video_index')
        .whereIn('id', uniq)
        .select(
          isImage
            ? ['id', 'path', 'filename', 'ext', 'width', 'height', 'taken_at', 'view_time', 'create_time', 'size']
            : ['id', 'media_type', 'path', 'filename', 'ext', 'is_file', 'width', 'height', 'duration', 'nfo_name', 'nfo_year', 'nfo_score', 'nfo_regions', 'nfo_genres', 'poster_path', 'fanart_path', 'logo_path', 'play_rel_path', 'view_time', 'create_time'],
        )
        .catch(() => []);
      for (const row of rows || []) coverOf.set(`${kind}:${Number(row.id)}`, row);
    };
    await loadCovers(imageCoverIds, 'image');
    await loadCovers(videoCoverIds, 'video');

    const folders = [];
    for (const entry of folderMap.values()) {
      const row = coverOf.get(`${entry.coverKind}:${entry.coverId}`) || null;
      let cover = null;
      if (row) {
        cover = entry.coverKind === 'image'
          ? _normalizeListRow(this._imageRowToListItem(row))
          : _normalizeListRow(row);
      }
      folders.push({
        name: entry.name,
        path: entry.path,
        count: entry.imageCount + entry.videoCount,
        imageCount: entry.imageCount,
        videoCount: entry.videoCount,
        cover,
      });
    }
    folders.sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh'));

    // ---- ④ 面包屑：从所属来源根一层层走到当前目录 ----
    const segments = [];
    if (currentPath && matchedRoot) {
      const rel = _relToRoot(currentPath, matchedRoot);
      if (rel !== null) {
        let acc = _stripTrailingSep(matchedRoot);
        for (const seg of rel.split(sep).filter(Boolean)) {
          acc = path.join(acc, seg);
          segments.push({ name: seg, path: acc });
        }
      }
    }

    return {
      path: currentPath,
      parentPath,
      segments,
      roots,
      folders,
      selfCount: selfImageCount + selfVideoCount,
      selfImageCount,
      selfVideoCount,
      hasSubFolders: folders.length > 0,
    };
  }

  async getVisibleIndexCounts(params, user) {
    const libraryId = Number(params && (params.library_id ?? params.libraryId)) || 0;
    let library = null;
    if (libraryId > 0) library = await this._ensureLibraryExists(libraryId);
    const validPaths = await this.getValidPaths(user, libraryId);
    let finalPaths = validPaths;
    const knex = this.knexVideo;
    const uid = user && user.id ? Number(user.id) : 0;

    const albumId = Number(params && (params.album_id ?? params.albumId));
    if (Number.isFinite(albumId) && albumId > 0) {
      const album = await knex('video_album').where({ id: albumId }).first();
      if (!album) {
        const err = new Error('common.NOT_FOUND');
        err.statusCode = 404;
        throw err;
      }
      if (!userUtil.isAdmin(user) && uid && Number(album.uid) !== Number(uid) && Number(album.is_public) !== 1) {
        const err = new Error('auth.PERMISSION_DENIED');
        err.statusCode = 403;
        throw err;
      }
    }

    const sourceList = Array.isArray(params && params.sourceList) ? params.sourceList : Array.isArray(params && params.source_list) ? params.source_list : null;
    if (sourceList && sourceList.length > 0) {
      finalPaths = intersectPaths(finalPaths, sourceList);
    }

    if (!finalPaths || finalPaths.length === 0) {
      return { movie: 0, tv: 0, image: 0, total: 0 };
    }

    // ⭐ 图片库 / 混合库：图片数量从 image_index 取（video_index 里已不再写图片行）
    const countLibType = library && library.lib_type ? String(library.lib_type).trim().toLowerCase() : '';
    if (countLibType === 'image' || countLibType === 'mixed') {
      const imgQ = knex('image_index as i').where('i.library_id', libraryId);
      this._applyImagePathPrefixFilter(imgQ, finalPaths);
      // 影集（album）目前不支持图片，带了就当 0，避免多算
      if (Number.isFinite(albumId) && albumId > 0) imgQ.whereRaw('1 = 0');
      const imgRow = await imgQ.count({ cnt: '*' }).first().catch(() => null);
      const imageCount = Math.max(0, Number(imgRow && (imgRow.cnt ?? imgRow['count(*)'])) || 0);

      let movie = 0;
      let tv = 0;
      if (countLibType === 'mixed') {
        const vRows = await knex('video_index as v')
          .whereIn('v.media_type', VIDEO_INDEX_MEDIA_TYPES)
          .modify(qb => _applyVideoIndexPathPrefixFilter(qb, finalPaths))
          .groupBy('v.media_type')
          .select('v.media_type')
          .count({ total: '*' })
          .catch(() => []);
        for (const r of vRows || []) {
          const mt = r && r.media_type ? String(r.media_type).trim() : '';
          const v = Number(r && r.total) || 0;
          if (mt === 'movie' || mt === 'bdmv' || mt === 'video_ts') movie += v;
          if (mt === 'tv') tv += v;
        }
      }
      return { movie, tv, image: imageCount, total: movie + tv + imageCount };
    }

    const rows = await knex('video_index as v')
      .whereIn('v.media_type', [...VIDEO_INDEX_MEDIA_TYPES, 'image'])
      .modify(qb => {
        if (!Number.isFinite(albumId) || albumId <= 0) return;
        qb.join('video_album_index as ai', function () {
          this.on('ai.index_id', '=', 'v.id').andOn('ai.album_id', '=', knex.raw('?', [albumId]));
        });
      })
      .modify(qb => _applyVideoIndexPathPrefixFilter(qb, finalPaths))
      .groupBy('v.media_type')
      .select('v.media_type')
      .count({ total: '*' })
      .catch(() => []);

    let movie = 0;
    let tv = 0;
    let image = 0;
    for (const r of rows || []) {
      const mt = r && r.media_type ? String(r.media_type).trim() : '';
      const cnt = Number(r && r.total);
      const v = Number.isFinite(cnt) ? cnt : Number(String(r && r.total ? r.total : 0)) || 0;
      if (mt === 'movie' || mt === 'bdmv' || mt === 'video_ts') movie += v;
      if (mt === 'tv') tv = v;
      if (mt === 'image') image += v;
    }
    return { movie, tv, image, total: movie + tv + image };
  }

  async listPaged(params, user) {
    const uid = user && user.id ? Number(user.id) : 0;
    const safePage = Math.max(1, Number(params.page || 1) || 1);
    const safeLimit = Math.min(200, Math.max(1, Number(params.page_size ?? params.pageSize ?? 30) || 30));
    const offset = (safePage - 1) * safeLimit;

    const search = params.search === undefined || params.search === null ? '' : String(params.search).trim();
    const mediaTypeList = _normalizeMediaTypeList(params.media_type ?? params.mediaType);
    const rawSortBy = params.sort_by ?? params.sortBy;
    const rawSortOrder = params.sort_order ?? params.sortOrder;
    let sortBy = _normalizeSortBy(rawSortBy);
    let sortOrder = _normalizeSortOrder(rawSortOrder);
    const genres = _normalizeKeyList(params.genres);
    const regions = _normalizeKeyList(params.regions ?? params.region);
    const actors = _normalizeKeyList(params.actors ?? params.actor ?? params.nfo_actor ?? params.nfoActor);
    const directors = _normalizeKeyList(params.directors ?? params.director ?? params.nfo_director ?? params.nfoDirector);
    const years = _normalizeIntList(params.years ?? params.year);
    const listType = String(params.listType ?? params.list_type ?? '')
      .trim()
      .toLowerCase();
    const isFavoriteList = listType === 'favorite';

    const hasSortByParam = rawSortBy !== undefined && rawSortBy !== null && String(rawSortBy).trim() !== '';
    const hasSortOrderParam = rawSortOrder !== undefined && rawSortOrder !== null && String(rawSortOrder).trim() !== '';
    if (isFavoriteList) {
      if (!hasSortByParam) sortBy = 'favorite_time';
      if (!hasSortOrderParam) sortOrder = 'desc';
    }

    const libraryId = Number(params && (params.library_id ?? params.libraryId)) || 0;
    let library = null;
    if (libraryId > 0) library = await this._ensureLibraryExists(libraryId);

    const validPaths = await this.getValidPaths(user, libraryId);
    let finalPaths = validPaths;

    // ⭐ 图片库 / 混合库：走独立的 image_index 表（见 db/table/tableImageIndex.js）。
    //    收藏 / 影集 / 智能影集是影视专属筛选，图片侧尚未实现 —— 带了这些参数就
    //    退回原 video_index 逻辑，避免"筛选后一片空白"这种更难排查的现象。
    const earlyLibType = library && library.lib_type ? String(library.lib_type).trim().toLowerCase() : '';
    const earlyListType = String((params && (params.listType ?? params.list_type)) || '').trim().toLowerCase();
    const wantsSpecialFilter =
      Number(params && (params.album_id ?? params.albumId)) > 0 ||
      Number(params && (params.collection_id ?? params.collectionId)) > 0 ||
      Number(params && (params.smart_album_id ?? params.smartAlbumId)) > 0 ||
      earlyListType === 'favorite';
    if ((earlyLibType === 'image' || earlyLibType === 'mixed') && !wantsSpecialFilter) {
      const earlySourceList = Array.isArray(params && params.sourceList)
        ? params.sourceList
        : Array.isArray(params && params.source_list)
          ? params.source_list
          : null;
      const folderPath = String((params && (params.folderPath ?? params.folder_path)) || '').trim();
      const folderMode = String((params && (params.folderMode ?? params.folder_mode)) || '').trim();
      const common = {
        library,
        safePage,
        safeLimit,
        offset,
        search,
        sortBy,
        sortOrder,
        uid,
        validPaths,
        sourceList: earlySourceList,
        // 文件夹视图：exact = 只看本目录自身，subtree = 看整棵子树（搜索用）
        folderPath,
        folderMode,
        // ⭐ 混合库翻页游标（2026-10-12）：由上一页响应的 pagination.nextCursor 回传。
        //    空串 / 不传 = 第一页。图片库不走游标（单表 offset 分页没有归并问题）。
        cursorRaw: String(params && (params.cursor ?? params.nextCursor ?? params.next_cursor) || ''),
      };
      if (earlyLibType === 'image') return await this._listImageOnlyPaged(common);
      return await this._listMixedPaged(common);
    }

    const albumId = Number(params && (params.album_id ?? params.albumId));
    if (Number.isFinite(albumId) && albumId > 0) {
      const album = await this.knexVideo('video_album').where({ id: albumId }).first();
      if (!album) {
        const err = new Error('common.NOT_FOUND');
        err.statusCode = 404;
        throw err;
      }
      if (!userUtil.isAdmin(user) && uid && Number(album.uid) !== Number(uid) && Number(album.is_public) !== 1) {
        const err = new Error('auth.PERMISSION_DENIED');
        err.statusCode = 403;
        throw err;
      }
    }

    const collectionId = Number(params && (params.collection_id ?? params.collectionId));
    if (Number.isFinite(collectionId) && collectionId > 0) {
      const collection = await this.knexVideo('video_collection').where({ id: collectionId }).first();
      if (!collection) {
        const err = new Error('common.NOT_FOUND');
        err.statusCode = 404;
        throw err;
      }
      const uid = user && user.id ? Number(user.id) : 0;
      if (user && !userUtil.isAdmin(user) && uid && Number(collection.uid) !== Number(uid)) {
        const err = new Error('auth.PERMISSION_DENIED');
        err.statusCode = 403;
        throw err;
      }
      const collectionPaths = parsePathListText(collection.path_list);
      finalPaths = intersectPaths(finalPaths, collectionPaths);
    }

    const sourceList = Array.isArray(params.sourceList) ? params.sourceList : Array.isArray(params.source_list) ? params.source_list : null;
    if (sourceList && sourceList.length > 0) {
      finalPaths = intersectPaths(finalPaths, sourceList);
    }
    const validPathsWithStatus = (validPaths || []).map(p => ({
      path: p,
      valid: fs.existsSync(p),
    }));

    const knex = this.knexVideo;
    const includeSeason = isFavoriteList || (Number.isFinite(albumId) && albumId > 0);
    const allowedMediaTypes = this._resolveAllowedMediaTypes({ includeSeason, library, mediaTypeList });
    const baseQuery = knex('video_index as v')
      .whereIn('v.media_type', allowedMediaTypes)
      .modify(qb => {
        if (isFavoriteList) {
          qb.join('video_favorite as fav', function () {
            this.on('fav.index_id', '=', 'v.id').andOn('fav.uid', '=', knex.raw('?', [uid]));
          });
        }
      })
      .modify(qb => {
        if (!Number.isFinite(albumId) || albumId <= 0) return;
        qb.join('video_album_index as ai', function () {
          this.on('ai.index_id', '=', 'v.id').andOn('ai.album_id', '=', knex.raw('?', [albumId]));
        });
      })
      .modify(qb => {
        if (mediaTypeList.length > 0)
          qb.andWhere(function () {
            if (includeSeason && mediaTypeList.includes('tv') && !mediaTypeList.includes('season')) {
              this.whereIn('v.media_type', ['tv', 'season']);
            } else if (mediaTypeList.includes('movie') && !mediaTypeList.includes('bdmv') && !mediaTypeList.includes('video_ts')) {
              this.whereIn('v.media_type', ['movie', 'bdmv', 'video_ts']);
            } else {
              this.whereIn('v.media_type', mediaTypeList);
            }
          });
      });

    if (finalPaths.length === 0) {
      baseQuery.whereRaw('1 = 0');
    } else {
      _applyVideoIndexPathPrefixFilter(baseQuery, finalPaths);
    }

    const effectiveSearch = typeof search === 'string' ? search.trim() : '';
    if (effectiveSearch) {
      const isSingleLetterFilter = effectiveSearch.length === 1 && (effectiveSearch === '#' || /^[a-zA-Z]$/.test(effectiveSearch));
      if (isSingleLetterFilter) {
        const fl = effectiveSearch.toUpperCase();
        baseQuery.andWhere(builder => {
          builder.where({ 'v.nfo_name_fl': fl }).orWhere({ 'v.filename_fl': fl });
        });
      } else {
        baseQuery.andWhere(builder => {
          builder.where('v.nfo_name', 'like', `%${effectiveSearch}%`).orWhere('v.filename', 'like', `%${effectiveSearch}%`);
        });
      }
    }

    for (const a of actors) {
      _applyCommaSeparatedFieldExactContains(baseQuery, 'v.nfo_actor', a);
    }

    for (const d of directors) {
      _applyCommaSeparatedFieldExactContains(baseQuery, 'v.nfo_director', d);
    }

    for (const g of genres) {
      baseQuery.whereExists(function () {
        this.select(1).from('video_index2key as k').whereRaw('k.index_id = v.id').andWhere('k.key_type', 'genres').andWhere('k.key', g);
      });
    }

    for (const r of regions) {
      baseQuery.whereExists(function () {
        this.select(1).from('video_index2key as k').whereRaw('k.index_id = v.id').andWhere('k.key_type', 'region').andWhere('k.key', r);
      });
    }

    if (years.length > 0) {
      baseQuery.andWhere(builder => builder.whereIn('v.nfo_year', years));
    }

    const smartAlbumId = Number(params && (params.smart_album_id ?? params.smartAlbumId));
    if (Number.isFinite(smartAlbumId) && smartAlbumId > 0) {
      const smartAlbum = await this.knexVideo('video_smart_album').where({ id: smartAlbumId }).first();
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
      smartAlbumFilterUtil.applySmartAlbumFilter(baseQuery, smartAlbum.type, filterContent, 'v');
    }

    const countRow = await baseQuery
      .clone()
      .clearSelect()
      .clearOrder()
      .countDistinct({ cnt: 'v.id' })
      .first()
      .catch(() => null);
    const total = Math.max(0, Number((countRow && (countRow.cnt ?? countRow['count(`v`.`id`)'] ?? countRow['count(*)'])) || 0) || 0);

    const filters = await this._getFilterOptions(baseQuery);

    const query = baseQuery
      .clone()
      .select(
        'v.id',
        'v.media_type',
        'v.path',
        'v.filename',
        'v.ext',
        'v.is_file',
        'v.width',
        'v.height',
        'v.duration',
        'v.nfo_name',
        'v.nfo_year',
        'v.nfo_score',
        'v.nfo_regions',
        'v.nfo_genres',
        'v.poster_path',
        'v.fanart_path',
        'v.logo_path',
        'v.play_rel_path',
        'v.view_time',
        'v.create_time'
      );

    if (sortBy === 'favorite_time' && isFavoriteList) {
      query.orderBy('fav.create_time', sortOrder);
      query.orderBy('fav.id', 'desc');
    } else if (sortBy === 'view_time') {
      query.orderBy('v.view_time', sortOrder);
    } else if (sortBy === 'year') {
      query.orderBy('v.nfo_year', sortOrder);
    } else if (sortBy === 'score') {
      query.orderBy('v.nfo_score', sortOrder);
    } else if (sortBy === 'name') {
      // ⭐ 2026-10-12：改用 natural_name（自然序，1,2,10,11）保持一致。
      //    原来是 lower(case when nfo_name…) 文本序 ⇒ 1,10,11,2。
      query.orderBy('v.natural_name', sortOrder);
    } else {
      query.orderBy('v.create_time', sortOrder);
    }
    query.orderBy('v.id', 'desc');

    const rows = await query
      .limit(safeLimit)
      .offset(offset)
      .catch(() => []);
    const items = (rows || []).map(r => _normalizeListRow(r));
    // 普通影视库同样兜底：视频没有封面 / 缩略图时用同目录同名图片顶上
    _fillSameNameImageFallback(items);
    if (isFavoriteList) {
      for (const item of items) {
        if (item && typeof item === 'object') item.is_favorite = true;
      }
    } else if (uid && items.length > 0) {
      for (const item of items) {
        if (item && typeof item === 'object') item.is_favorite = false;
      }
      const ids = items.map(r => Number(r && r.id) || 0).filter(v => v > 0);
      if (ids.length > 0) {
        const favRows = await knex('video_favorite')
          .where({ uid })
          .whereIn('index_id', ids)
          .select('index_id')
          .catch(() => []);
        const favSet = new Set((favRows || []).map(r => Number(r && r.index_id) || 0).filter(v => v > 0));
        for (const item of items) {
          const id = Number(item && item.id) || 0;
          if (item && typeof item === 'object') item.is_favorite = favSet.has(id);
        }
      }
    }
    await _fillFirstFilePathForTvRows({ knex: this.knexVideo, rows: items });
    const totalPages = Math.ceil(total / safeLimit);
    return {
      items,
      filters,
      validPaths: validPathsWithStatus,
      pagination: {
        total,
        page: safePage,
        limit: safeLimit,
        totalPages,
        hasNextPage: safePage < totalPages,
        hasPrevPage: safePage > 1,
      },
    };
  }

  async listHistory(user) {
    const uid = user && user.id ? Number(user.id) : 0;
    if (!uid) return { items: [] };

    const validPaths = await this.getValidPaths(user);
    if (!validPaths || validPaths.length === 0) return { items: [] };

    const prefRows = await this.knexVideo('video_play_preference as p')
      .join('video_index as v', 'v.file_hash', 'p.file_hash')
      .where('p.uid', uid)
      .modify(qb => _applyVideoIndexPathPrefixFilter(qb, validPaths))
      .orderBy('p.last_watched_at', 'desc')
      .orderBy('p.id', 'desc')
      .limit(200)
      .select(
        'p.last_watched_at',
        'p.playback_position',
        'p.file_hash',
        'v.id',
        'v.is_file',
        'v.media_type',
        'v.path',
        'v.filename',
        'v.nfo_name',
        'v.nfo_year',
        'v.nfo_score',
        'v.nfo_regions',
        'v.nfo_genres',
        'v.poster_path',
        'v.fanart_path',
        'v.logo_path',
        'v.play_rel_path',
        'v.view_time',
        'v.create_time',
        'v.duration'
      )
      .catch(() => []);

    const episodeFolders = new Set();
    for (const r of prefRows || []) {
      const mt = r && r.media_type ? String(r.media_type).trim() : '';
      if (mt === 'episod') {
        const epFolder = r.path ? String(r.path).trim() : '';
        if (epFolder) episodeFolders.add(epFolder);
      }
    }

    const seasonPairs = [];
    const tvPairs = [];
    for (const f of episodeFolders) {
      const parent = path.dirname(f);
      const name = path.basename(f);
      if (!parent || !name) continue;
      seasonPairs.push({ path: parent, filename: name });

      tvPairs.push({ path: parent, filename: name });
      const showFolder = parent;
      const showParent = showFolder ? path.dirname(showFolder) : '';
      const showName = showFolder ? path.basename(showFolder) : '';
      if (showParent && showName) {
        tvPairs.push({ path: showParent, filename: showName });
      }
    }

    const seasonMap = new Map();
    const tvMap = new Map();

    if (seasonPairs.length > 0) {
      const rows = await this.knexVideo('video_index as v')
        .where({ 'v.is_file': 0, 'v.media_type': 'season' })
        .modify(qb => {
          qb.andWhere(builder => {
            for (const p of seasonPairs) {
              builder.orWhere(function () {
                this.where('v.path', p.path).andWhere('v.filename', p.filename);
              });
            }
          });
        })
        .modify(qb => _applyVideoIndexPathPrefixFilter(qb, validPaths))
        .select(
          'v.id',
          'v.media_type',
          'v.path',
          'v.filename',
          'v.nfo_name',
          'v.nfo_year',
          'v.nfo_score',
          'v.nfo_regions',
          'v.nfo_genres',
          'v.poster_path',
          'v.fanart_path',
          'v.logo_path',
          'v.view_time',
          'v.create_time',
          'v.duration'
        )
        .catch(() => []);

      for (const r of rows || []) {
        const k = `${r.path}||${r.filename}`;
        seasonMap.set(k, r);
      }
    }

    if (tvPairs.length > 0) {
      const rows = await this.knexVideo('video_index as v')
        .where({ 'v.is_file': 0, 'v.media_type': 'tv' })
        .modify(qb => {
          qb.andWhere(builder => {
            for (const p of tvPairs) {
              builder.orWhere(function () {
                this.where('v.path', p.path).andWhere('v.filename', p.filename);
              });
            }
          });
        })
        .modify(qb => _applyVideoIndexPathPrefixFilter(qb, validPaths))
        .select(
          'v.id',
          'v.media_type',
          'v.path',
          'v.filename',
          'v.nfo_name',
          'v.nfo_year',
          'v.nfo_score',
          'v.nfo_regions',
          'v.nfo_genres',
          'v.poster_path',
          'v.fanart_path',
          'v.logo_path',
          'v.view_time',
          'v.create_time',
          'v.duration'
        )
        .catch(() => []);

      for (const r of rows || []) {
        const k = `${r.path}||${r.filename}`;
        tvMap.set(k, r);
      }
    }

    const out = [];
    const seen = new Set();

    for (const r of prefRows || []) {
      const mt = r && r.media_type ? String(r.media_type).trim() : '';
      let item = r;
      if (mt === 'episod') {
        const folder = r.path ? String(r.path).trim() : '';
        const parent = folder ? path.dirname(folder) : '';
        const name = folder ? path.basename(folder) : '';
        const k1 = parent && name ? `${parent}||${name}` : '';

        const showFolder = parent;
        const showParent = showFolder ? path.dirname(showFolder) : '';
        const showName = showFolder ? path.basename(showFolder) : '';
        const k2 = showParent && showName ? `${showParent}||${showName}` : '';

        item = (k1 && seasonMap.has(k1) ? seasonMap.get(k1) : null) || (k1 && tvMap.has(k1) ? tvMap.get(k1) : null) || (k2 && tvMap.has(k2) ? tvMap.get(k2) : null);
      } else if (mt !== 'movie' && mt !== 'tv' && mt !== 'season' && mt !== 'bdmv' && mt !== 'video_ts') {
        item = null;
      }

      if (!item || !item.id) continue;
      const id = Number(item.id) || 0;
      if (!id || seen.has(id)) continue;
      seen.add(id);

      const duration = item.duration === undefined || item.duration === null ? 0 : Number(item.duration);
      const playback_position = r.playback_position === undefined || r.playback_position === null ? 0 : Number(r.playback_position);
      let progress = 0;
      if (duration > 0 && playback_position > 0) {
        progress = Number((Math.min(playback_position, duration) / duration).toFixed(2));
      }

      out.push(
        _normalizeListRow({
          ...item,
          last_watched_at: r.last_watched_at,
          playback_position: r.playback_position,
          progress: progress >= 0 && progress <= 1 ? progress : 0,
        })
      );
    }

    await _fillFirstFilePathForTvRows({ knex: this.knexVideo, rows: out });
    return { items: out };
  }

  async clearHistory(user) {
    const uid = user && user.id ? Number(user.id) : 0;
    if (!uid) return { deleted: 0 };
    const deleted = await this.knexVideo('video_play_preference')
      .where({ uid })
      .del()
      .catch(() => 0);
    return { deleted: Number(deleted) || 0 };
  }
}

module.exports = VideoListService;
