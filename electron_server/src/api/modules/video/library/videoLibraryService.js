const path = require('path');
const userUtil = require('../../../../utils/userUtil');
const Logger = require('../../../../utils/logger');
const VideoSourceService = require('../source/videoSourceService');
const videoIndexIndexUtil = require('../../../../workers/videoIndex/videoIndexIndexUtil');
const { applyVisibleIndexFilter, isPathVisibleTo, escapeLikeValue, LIKE_ESCAPE } = require('../videoVisibilityUtil');

// 影视库类型（创建后不可修改）
const LIB_TYPES = ['movie', 'tv', 'image', 'mixed'];

const VIDEO_MEDIA_TYPES = ['movie', 'bdmv', 'video_ts'];

/**
 * ⚠️ 已废弃：本文件不再使用它（可见性过滤统一到 `../videoVisibilityUtil`）。
 *
 * 这个实现**有 bug，别再抄**：它把反斜杠也翻倍（`\` → `\\`），
 * 而 SQLite 的 LIKE 默认不认 `\` 转义 ⇒ Windows 路径的前缀匹配会**静默失效**
 * （实测 `'E:\Media\sub' LIKE 'E:\\Media\\%'` = 0）。
 * 正确做法见 `videoVisibilityUtil.escapeLikeValue`：只转 `%` `_`，并用 `^` 作 ESCAPE 字符。
 */
function _escapeLikeValue(input) {
  return String(input || '')
    .replaceAll('\\', '\\\\')
    .replaceAll('%', '\\%')
    .replaceAll('_', '\\_');
}

class VideoLibraryService {
  constructor(knex) {
    this.knex = knex;
    this.tableName = 'video_library';
    this.sourceTable = 'video_source';
  }

  normalizeLibType(input) {
    const v = String(input || '')
      .trim()
      .toLowerCase();
    return LIB_TYPES.includes(v) ? v : '';
  }

  normalizeName(input) {
    return String(input === undefined || input === null ? '' : input).trim();
  }

  async listLibraries() {
    return await this.knex(this.tableName).select('*').orderBy('sort', 'asc').orderBy('id', 'asc').catch(() => []);
  }

  /**
   * 切换「日本电影库」（2026-10-12）。
   *
   * 开启后：列表页对该库显示「中 / 无码」徽章，并开放
   * 分辨率 / 无码 / 中文字幕 那组筛选。不做 lib_type 硬校验，
   * 免得以后类型扩展时反被挡住（前端只在 movie 类库上给这个开关）。
   */
  async setJpMovie(rawId, payload = {}) {
    const id = Number(rawId || 0) || 0;
    if (!id) throw new Error('validation.VALIDATION_ERROR');

    const lib = await this.getLibraryById(id);
    if (!lib) throw new Error('common.NOT_FOUND');

    const raw = payload.jp_movie ?? payload.jpMovie;
    const value = raw === true || raw === 1 || raw === '1' || raw === 'true' ? 1 : 0;

    const affected = await this.knex(this.tableName)
      .where({ id })
      .update({ jp_movie: value });
    if (!Number(affected)) {
      throw new Error('video.VIDEO_LIBRARY_UPDATE_FAILED');
    }

    // ⭐ 回填日本片标记（2026-10-12）：jp_uncensored / jp_chinese_sub 两列是后加的，
    //    老库补列后整列都是 0；且这两列与「是否展示」的开关无关。所以每次调用这个
    //    接口都用**已入库的文件名**重算一遍（开、关都跑）——
    //    用户只要点一下开关就等于"强制刷新一次标记"，不必整库重扫。
    //    异步后台执行，不阻塞本次响应；失败只记日志不影响开关状态。
    Promise.resolve()
      .then(() => videoIndexIndexUtil.refreshJpTagsForLibrary(this.knex, id))
      .then(count => {
        if (Number(count) > 0) {
          Logger.info(`✅ Refresh jp tags for library ${id}: ${count} rows updated`);
        }
      })
      .catch(err => {
        Logger.error('❌ refresh jp tags failed:', err && err.message ? err.message : err);
      });

    return await this.getLibraryById(id);
  }

  /**
   * 重排影视库顺序（2026-10-12）。
   *
   * `rawIds` 是用户在栏目条上拖出来的完整顺序。
   * ⚠️ 必须**整体重写** sort，不能只交换被拖动那两条：相邻互换时如果原本就存在
   * 重复的 sort 值，交换等于没动（列表顺序由 `orderBy sort, id` 决定，重复值会退化成按 id）。
   * 没出现在列表里的库（客户端拿的是旧列表 / 期间新建的）按原 sort 顺延排到最后，
   * 保证不会出现两库同 sort。
   */
  async reorderLibraries(rawIds) {
    const ids = (Array.isArray(rawIds) ? rawIds : [])
      .map(v => Number(v) || 0)
      .filter(v => v > 0);
    const unique = [...new Set(ids)];
    if (!unique.length) throw new Error('validation.VALIDATION_ERROR');

    const rest = await this.knex(this.tableName)
      .whereNotIn('id', unique)
      .orderBy('sort', 'asc')
      .orderBy('id', 'asc')
      .select('id')
      .catch(() => []);
    const ordered = unique.concat(
      (rest || []).map(r => Number(r && r.id) || 0).filter(v => v > 0)
    );

    await this.knex.transaction(async trx => {
      for (let i = 0; i < ordered.length; i++) {
        await trx(this.tableName).where({ id: ordered[i] }).update({ sort: i + 1 });
      }
    });
    return ordered;
  }

  async getLibraryById(rawId) {
    const id = Number(rawId || 0) || 0;
    if (!id) return null;
    const row = await this.knex(this.tableName).where({ id }).first().catch(() => null);
    return row || null;
  }

  async isNameTaken(name, excludeId = 0) {
    const target = this.normalizeName(name);
    if (!target) return false;
    const rows = await this.knex(this.tableName).where({ name: target }).select('id').catch(() => []);
    return (rows || []).some(r => Number(r && r.id) !== Number(excludeId || 0));
  }

  async addLibrary(payload = {}) {
    const name = this.normalizeName(payload.name);
    if (!name) throw new Error('validation.VALIDATION_ERROR');

    const libType = this.normalizeLibType(payload.lib_type ?? payload.libType);
    if (!libType) throw new Error('validation.VALIDATION_ERROR');

    if (await this.isNameTaken(name)) throw new Error('video.VIDEO_LIBRARY_NAME_EXISTS');

    const maxRow = await this.knex(this.tableName).max({ m: 'sort' }).first().catch(() => null);
    const sort = (Number(maxRow && maxRow.m) || 0) + 1;

    const row = await this.knex.transaction(async trx => {
      const [id] = await trx(this.tableName).insert({
        name,
        name_key: '',
        lib_type: libType,
        is_default: 0,
        show_in_home: 0,
        // ⭐ 日本电影库开关（2026-10-12）：创建时可带上，默认关
        jp_movie: payload.jp_movie === 1 || payload.jp_movie === '1' || payload.jp_movie === true ||
          payload.jpMovie === 1 || payload.jpMovie === '1' || payload.jpMovie === true ? 1 : 0,
        sort,
        create_time: new Date(),
      });
      return trx(this.tableName).where({ id }).first();
    });
    return row;
  }

  // 只允许改名，lib_type 创建后不可修改
  async renameLibrary(rawId, payload = {}) {
    const id = Number(rawId || 0) || 0;
    if (!id) throw new Error('validation.VALIDATION_ERROR');

    const name = this.normalizeName(payload.name);
    if (!name) throw new Error('validation.VALIDATION_ERROR');

    const lib = await this.getLibraryById(id);
    if (!lib) throw new Error('common.NOT_FOUND');

    if (await this.isNameTaken(name, id)) throw new Error('video.VIDEO_LIBRARY_NAME_EXISTS');

    await this.knex(this.tableName)
      .where({ id })
      .update({ name, name_key: '' })
      .catch(() => 0);
    return await this.getLibraryById(id);
  }

  // 切换「是否在主页显示该库分类」
  async setShowInHome(rawId, payload = {}) {
    const id = Number(rawId || 0) || 0;
    if (!id) throw new Error('validation.VALIDATION_ERROR');

    const lib = await this.getLibraryById(id);
    if (!lib) throw new Error('common.NOT_FOUND');

    const raw = payload.show_in_home ?? payload.showInHome;
    const showInHome =
      raw === true || raw === 1 || raw === '1' || raw === 'true' ? 1 : 0;

    // ⚠️ 2026-10-09：原来这里 `.catch(() => 0)`把写入异常吞掉了，
    // 表不存在/列缺失时接口照样返回 200，前端只能看到一个「改了没反应」的死开关，
    // 排查时完全没有线索。写失败必须抛出去，让前端提示「操作失败」。
    const affected = await this.knex(this.tableName)
      .where({ id })
      .update({ show_in_home: showInHome });
    if (!Number(affected)) {
      throw new Error('video.VIDEO_LIBRARY_UPDATE_FAILED');
    }

    return await this.getLibraryById(id);
  }

  // 切换「音频响度归一化」：开启后扫描/重扫时测量该库音频响度，播放转码时对齐音量
  async setAudioNormalize(rawId, payload = {}) {
    const id = Number(rawId || 0) || 0;
    if (!id) throw new Error('validation.VALIDATION_ERROR');

    const lib = await this.getLibraryById(id);
    if (!lib) throw new Error('common.NOT_FOUND');

    const raw = payload.audio_normalize ?? payload.audioNormalize;
    const value = raw === true || raw === 1 || raw === '1' || raw === 'true' ? 1 : 0;

    const affected = await this.knex(this.tableName)
      .where({ id })
      .update({ audio_normalize: value });
    if (!Number(affected)) {
      throw new Error('video.VIDEO_LIBRARY_UPDATE_FAILED');
    }

    return await this.getLibraryById(id);
  }

  // 该文件路径所属影视库是否开启响度归一化（按来源路径最长前缀匹配）
  async isAudioNormalizeEnabledForPath(filePath) {
    const resolved = filePath ? path.resolve(String(filePath)) : '';
    if (!resolved) return false;

    const rows = await this.knex(`${this.sourceTable} as s`)
      .leftJoin(`${this.tableName} as l`, 'l.id', 's.library_id')
      .select('s.path', 'l.audio_normalize')
      .catch(() => []);

    let best = null;
    for (const r of rows || []) {
      const root = r && r.path ? path.resolve(String(r.path)) : '';
      if (!root) continue;
      const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
      if (resolved !== root && !resolved.startsWith(prefix)) continue;
      if (!best || root.length > best.len) {
        best = { len: root.length, audio_normalize: r.audio_normalize };
      }
    }
    if (!best) return false;
    return Number(best.audio_normalize || 0) === 1;
  }

  async deleteLibrary(rawId) {
    const id = Number(rawId || 0) || 0;
    if (!id) throw new Error('validation.VALIDATION_ERROR');

    const lib = await this.getLibraryById(id);
    if (!lib) throw new Error('common.NOT_FOUND');
    if (Number(lib.is_default || 0) === 1) throw new Error('video.VIDEO_LIBRARY_BUILTIN_CANNOT_DELETE');

    const row = await this.knex(this.sourceTable)
      .where({ library_id: id })
      .count({ cnt: 'id' })
      .first()
      .catch(() => null);
    if (Number(row && row.cnt) > 0) throw new Error('video.VIDEO_LIBRARY_HAS_SOURCE');

    const affected = await this.knex(this.tableName).where({ id }).delete().catch(() => 0);
    return { affected: Number(affected) || 0 };
  }

  // 库 -> 来源路径
  async getSourcePathsByLibrary(rawId) {
    const id = Number(rawId || 0) || 0;
    if (!id) return [];
    const rows = await this.knex(this.sourceTable).where({ library_id: id }).select('path').catch(() => []);
    return (rows || []).map(r => (r && r.path ? String(r.path) : '')).filter(Boolean);
  }

  _applyIndexPathFilter(query, paths) {
    // ⭐ 统一口径：与列表页、详情鉴权共用同一份实现。
    // 原实现只有「前缀匹配」，**漏了目录行特判**（`is_file=0 且 path=父目录 且 filename=子目录名`），
    // 导致电视剧库那种「剧集文件夹」代表的整部剧不算进计数 ⇒ 库计数虚低、左侧栏显示 0。
    applyVisibleIndexFilter(query, paths);
  }

  /**
   * 图片表的路径可见性过滤。
   * ⚠️ 不能复用 applyVisibleIndexFilter：它带「目录行特判」，会引用 image_index
   *    并不存在的 `is_file` 列 → SQL 直接报错。图片行都是真实文件，本就无需该特判。
   */
  _applyImagePathFilter(query, paths, alias = '') {
    const list = Array.isArray(paths) ? paths.map(p => String(p || '').trim()).filter(Boolean) : [];
    if (list.length === 0) {
      query.whereRaw('1 = 0');
      return query;
    }
    const col = alias ? `${alias}.path` : 'path';
    const sep = path.sep;
    query.where(builder => {
      for (const p of list) {
        const prefix = p.endsWith(sep) ? p : `${p}${sep}`;
        builder.orWhere(function () {
          this.where(col, p).orWhereRaw('?? LIKE ? ESCAPE ?', [
            col,
            `${escapeLikeValue(prefix)}%`,
            LIKE_ESCAPE,
          ]);
        });
      }
    });
    return query;
  }

  // 每个库的可见条目数：库内来源路径 ∩ 用户可见路径
  async listLibrariesWithCounts(user) {
    const libraries = await this.listLibraries();
    if (!libraries || libraries.length === 0) return [];

    const sourceService = new VideoSourceService(this.knex);
    const validPaths = await sourceService.getValidPaths(user);

    const allSources = await this.knex(this.sourceTable).select('path', 'library_id').catch(() => []);
    const pathsByLib = new Map();
    for (const s of allSources || []) {
      const p = s && s.path ? String(s.path) : '';
      const libId = Number(s && s.library_id) || 0;
      if (!p || !libId) continue;
      if (!pathsByLib.has(libId)) pathsByLib.set(libId, []);
      pathsByLib.get(libId).push(p);
    }

    const out = [];
    for (const lib of libraries) {
      const libId = Number(lib && lib.id) || 0;
      const libPaths = pathsByLib.get(libId) || [];
      // ⭐ 原来这里是 `validSet.has(p)` 精确比对：只有当「来源路径」恰好等于某条
      // 「可见路径」时才算数。但 `getValidPaths` 返回的可能是更长的授权子路径
      // （授权 `…\TV\BreakingBad`、来源 `…\TV`），精确比对必然落空 ⇒ 库计数虚低。
      // 改用与 getValidPaths 同源的双向包含判断。
      const visiblePaths = libPaths.filter(p => isPathVisibleTo(p, validPaths));

      const counts = { movie: 0, tv: 0, image: 0, total: 0 };
      if (visiblePaths.length > 0) {
        const query = this.knex('video_index').select('media_type').count({ total: '*' });
        this._applyIndexPathFilter(query, visiblePaths);
        const rows = await query.groupBy('media_type').catch(() => []);
        for (const r of rows || []) {
          const mt = r && r.media_type ? String(r.media_type).trim() : '';
          const cnt = Number(r && r.total) || 0;
          // ⭐ total = 该库内**全部**可见索引行之和，**不按 media_type 白名单筛**。
          //   原来用 `counts.movie + counts.tv + counts.image` 求和，会把白名单
          //   （movie/bdmv/video_ts）之外的媒体类型整类漏算 ⇒ 库明明有条目却算成 0，
          //   被左侧栏当成「空库」隐藏。
          counts.total += cnt;
          if (VIDEO_MEDIA_TYPES.includes(mt)) counts.movie += cnt;
          if (mt === 'tv') counts.tv += cnt;
          if (mt === 'image') counts.image += cnt;
        }

        // ⭐ 图片改存独立表 image_index（video_index 里已不再写 image 行）。
        //    用 library_id 等值统计 + 路径可见性过滤，走 (library_id, path) 索引。
        const libTypeForCount = lib.lib_type ? String(lib.lib_type).trim().toLowerCase() : '';
        if (libTypeForCount === 'image' || libTypeForCount === 'mixed') {
          const imgQuery = this.knex('image_index').where('library_id', libId);
          this._applyImagePathFilter(imgQuery, visiblePaths);
          const imgRow = await imgQuery.count({ cnt: '*' }).first().catch(() => null);
          const imgCnt = Number(imgRow && (imgRow.cnt ?? imgRow['count(*)'])) || 0;
          counts.image += imgCnt;
          counts.total += imgCnt;
        }
      }

      out.push({
        id: libId,
        name: lib.name ? String(lib.name) : '',
        name_key: lib.name_key ? String(lib.name_key) : '',
        lib_type: lib.lib_type ? String(lib.lib_type) : 'movie',
        is_default: Number(lib.is_default || 0),
        show_in_home: Number(lib.show_in_home || 0),
        audio_normalize: Number(lib.audio_normalize || 0),
        jp_movie: Number(lib.jp_movie || 0),
        sort: Number(lib.sort || 0),
        source_count: libPaths.length,
        counts,
      });
    }
    return out;
  }
}

VideoLibraryService.LIB_TYPES = LIB_TYPES;
VideoLibraryService.VIDEO_MEDIA_TYPES = VIDEO_MEDIA_TYPES;

module.exports = VideoLibraryService;
