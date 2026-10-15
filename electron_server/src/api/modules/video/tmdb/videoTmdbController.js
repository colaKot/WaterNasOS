const fs = require('fs');
const path = require('path');
const ResponseUtil = require('../../../apiUtils/responseUtil');
const dbUtil = require('../../../../db/dbUtil');
const knexUtil = require('../../../../db/knexUtil');
const tableConfig = require('../../../../db/table/tableConfig');
const nascabAccountUtil = require('../../service/utils/nascabAccountUtil');
const config = require('../../../../config/config');
const networkProxyUtil = require('../../../../utils/networkProxyUtil');
const { TmdbClient } = require('../../../../workers/videoIndex/nfoFetchWorker/tmdbClient');
const javScraper = require('../../../../workers/videoIndex/javFetchWorker/javScraper');
const javNfoFallback = require('../../../../workers/videoIndex/javFetchWorker/javNfoFallback');
const { extractAvId } = require('../../../../workers/videoIndex/javFetchWorker/avIdExtractor');

/**
 * 「番号 → 封面直链」的内存负缓存。
 *
 * 日文站点的图片有防盗链（裸连 403），客户端只能通过本文件的 javCover 代理取图。
 * 但抓封面直链本身要走一次站点请求（javdb 偶尔几百毫秒、也可能几秒），
 * 抓不到时若无缓存会被前端反复打爆，所以这里连「抓不到」也缓存一段时间。
 */
const _javCoverUrlCache = new Map();
const _JAV_COVER_URL_TTL = 10 * 60 * 1000;

/** 番号对应的封面缓存文件路径（与 NFO 海报同目录，随缓存清理一起淘汰）。 */
function _javCoverCachePath(dvdId) {
  const safe = String(dvdId || '')
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, '_')
    .slice(0, 80);
  if (!safe) return '';
  return path.join(config.getNfoPosterPath(), `jav_${safe}.jpg`);
}

function _normalizeToTmdbLanguage(locale) {
  const raw = String(locale || '').trim();
  if (!raw || raw === 'system') return '';
  const primary = raw.split(/[-_]/)[0].toLowerCase();
  const map = {
    zh: 'zh-CN',
    en: 'en-US',
    es: 'es-ES',
    fr: 'fr-FR',
    de: 'de-DE',
    ja: 'ja-JP',
    pt: 'pt-BR',
    ru: 'ru-RU',
    ar: 'ar-SA',
    ko: 'ko-KR',
    th: 'th-TH',
    vi: 'vi-VN',
    id: 'id-ID',
  };
  if (map[primary]) return map[primary];
  if (/^[a-z]{2}-[A-Z]{2}$/.test(raw)) return raw;
  return '';
}

function _getSystemLocale() {
  try {
    const v = Intl.DateTimeFormat().resolvedOptions().locale;
    return String(v || '').trim();
  } catch (_) {
    return '';
  }
}

let _tmdbClientPromise = null;
let _tmdbClientConfigKey = '';

async function _getTmdbClient() {
  const knex = knexUtil.getInstance(dbUtil.DB_PATHS.MAIN_DB);
  const [tmdbApiTokenDec, tmdbApiTokenDefaultDec, tmdbApiUrlDec, tmdbLanguage, uiLanguage] = await Promise.all([
    nascabAccountUtil.getDecryptedConfigValue(knex, tableConfig, 'tmdbApiToken'),
    nascabAccountUtil.getDecryptedConfigValue(knex, tableConfig, 'tmdbApiTokenDefault'),
    nascabAccountUtil.getDecryptedConfigValue(knex, tableConfig, 'tmdbApiUrl'),
    tableConfig.getConfigByKey('tmdbLanguage'),
    tableConfig.getConfigByKey(tableConfig.KEY_SERVER_UI_LANGUAGE),
  ]);

  let apiToken = tmdbApiTokenDec ? String(tmdbApiTokenDec).trim() : '';
  if (!apiToken && tmdbApiTokenDefaultDec) apiToken = String(tmdbApiTokenDefaultDec).trim();
  let apiUrl = tmdbApiUrlDec ? String(tmdbApiUrlDec).trim() : '';
  // ⭐⭐ 代理统一走「系统设置 → 网络代理」（旧键仅兜底）。
  //    以前这里只读 tmdbProxy* 键、没有全局回退 —— 影视里那个代理开关一关，
  //    手动「搜索影音信息」就会变成直连（TMDB 在国内直连基本必挂）。
  const proxyUrl = (await networkProxyUtil.resolveMetadataProxyUrl()) || '';
  const preferred = tmdbLanguage ? String(tmdbLanguage).trim() : '';
  const effectiveLanguage = _normalizeToTmdbLanguage(preferred) || _normalizeToTmdbLanguage(uiLanguage) || _normalizeToTmdbLanguage(_getSystemLocale()) || 'en-US';

  if (!apiToken || !apiUrl) {
    const defaults = config.getDefaultTmdbConfig();
    if (!apiToken && defaults.tmdbApiToken) apiToken = String(defaults.tmdbApiToken).trim();
    if (!apiUrl && defaults.tmdbApiUrl) apiUrl = String(defaults.tmdbApiUrl).trim();
  }

  const key = `${apiUrl}||${apiToken}||${proxyUrl}||${effectiveLanguage}`;
  if (_tmdbClientPromise && _tmdbClientConfigKey === key) {
    return await _tmdbClientPromise;
  }
  _tmdbClientConfigKey = key;
  _tmdbClientPromise = Promise.resolve(new TmdbClient({ apiUrl, apiToken, proxyUrl, language: effectiveLanguage }));
  return await _tmdbClientPromise;
}

/**
 * 读「日本片站点地址」覆盖配置（设置里可逐站点填，留空走内置默认）。
 * 与 nfoFetchRunner 里那份保持同一口径。
 */
async function _loadJavSiteBases() {
  const out = {};
  try {
    const keyMap = javScraper.SITE_BASE_KEY || {};
    const names = Object.keys(keyMap);
    const values = await Promise.all(names.map(n => tableConfig.getConfigByKey(keyMap[n]).catch(() => '')));
    names.forEach((n, i) => {
      const v = values[i] ? String(values[i]).trim() : '';
      if (v) out[n] = v;
    });
  } catch (_) {}
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * 该索引条目是否属于「日本电影库」（`video_library.jp_movie = 1`）。
 *
 * ⚠️ `video_index` 刻意没有 library_id，只能靠 `video_source.path` 前缀反查
 *    —— 与自动刮削的判定（nfoFetchRunner._isJpMoviePath）同一口径。
 */
async function _isJpMovieIndexId(knexVideo, indexId) {
  const id = Number(indexId || 0) || 0;
  if (!id || !knexVideo) return false;
  try {
    const row = await knexVideo('video_index').where({ id }).first('path').catch(() => null);
    const dirPath = row && row.path ? path.resolve(String(row.path)) : '';
    if (!dirPath) return false;

    const libs = await knexVideo('video_library').where({ jp_movie: 1 }).select('id').catch(() => []);
    const libIds = (libs || []).map(r => Number(r && r.id) || 0).filter(v => v > 0);
    if (libIds.length === 0) return false;

    const sources = await knexVideo('video_source').whereIn('library_id', libIds).select('path').catch(() => []);
    return (sources || []).some(s => {
      const root = s && s.path ? path.resolve(String(s.path)) : '';
      if (!root) return false;
      return dirPath === root || dirPath.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
    });
  } catch (_) {
    return false;
  }
}

/** 从发布日期里取年份。 */
function _pickYearFromJavDate(dateStr) {
  const m = String(dateStr || '').match(/\b(19|20)\d{2}\b/);
  const y = m ? Number(m[0]) : 0;
  return y >= 1900 && y <= 2100 ? y : 0;
}

/** 「日本片识别兜底」总开关（与自动刮削读的是同一个键）。 */
async function _isJavFallbackEnabled() {
  try {
    const v = await tableConfig.getConfigByKey(tableConfig.KEY_JAV_FALLBACK_ENABLE);
    return v === '1' || v === 1 || v === true;
  } catch (_) {
    return false;
  }
}

/**
 * 按番号去日文站点抓一条结果。
 *
 * @returns {Promise<object|null>} 与 _mapMovieResult 同构的结果项，额外带 source / dvd_id
 */
async function _scrapeJavItem({ query, mediaType }) {
  try {
    const avId = extractAvId(query);
    if (!avId) return null;

    const proxyUrl = (await networkProxyUtil.resolveMetadataProxyUrl()) || '';
    const siteBases = await _loadJavSiteBases();
    // 手动搜索要尽快出结果，单站超时压到 8s（自动刮削那边是 15s）
    const meta = await javScraper
      .scrapeByDvdId(avId, { proxyUrl, siteBases, timeoutMs: 8000 })
      .catch(() => null);
    if (!meta) return null;

    const dvdId = String(meta.dvdid || avId).trim();
    const title = String(meta.title || '').trim() || dvdId;
    const coverUrl = String(meta.coverUrl || '').trim();

    // ⭐ 顺手预热封面缓存：搜索结果里那张图客户端会再请求一次 javCover，
    //    这里先把直链记进内存、并在后台把图片落盘，客户端拿图就不用再等一次站点请求。
    if (coverUrl) {
      _javCoverUrlCache.set(dvdId.toUpperCase(), { url: coverUrl, at: Date.now() });
      const coverPath = _javCoverCachePath(dvdId);
      if (coverPath) {
        javNfoFallback
          .downloadCoverToJpeg({ url: coverUrl, targetPath: coverPath, proxyUrl })
          .catch(() => {});
      }
    }

    return {
      id: 0,
      media_type: mediaType,
      title,
      original_title: '',
      overview: '',
      year: _pickYearFromJavDate(meta.publishDate),
      poster_url: coverUrl,
      backdrop_url: '',
      vote_average: 0,
      actors: (Array.isArray(meta.actresses) ? meta.actresses : []).filter(Boolean).map(s => String(s).trim()),
      genres: (Array.isArray(meta.genres) ? meta.genres : []).filter(Boolean).map(s => String(s).trim()),
      source: 'jav',
      dvd_id: dvdId,
    };
  } catch (_) {
    return null;
  }
}

function _pickYearFromDate(dateStr) {
  const s = String(dateStr || '').trim();
  const m = s.match(/^(\d{4})/);
  const y = m ? Number(m[1]) : 0;
  return y > 0 ? y : 0;
}

function _pickActorsFromCredits(credits, limit = 6) {
  const l = Math.max(0, Number(limit || 0) || 0);
  const cast = credits && Array.isArray(credits.cast) ? credits.cast : [];
  const out = [];
  const seen = new Set();
  for (const c of cast) {
    const name = c && c.name ? String(c.name).trim() : '';
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
    if (l > 0 && out.length >= l) break;
  }
  return out;
}

function _pickGenresFromDetail(genres, limit = 6) {
  const l = Math.max(0, Number(limit || 0) || 0);
  const list = Array.isArray(genres) ? genres : [];
  const out = [];
  const seen = new Set();
  for (const g of list) {
    const name = g && g.name ? String(g.name).trim() : '';
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
    if (l > 0 && out.length >= l) break;
  }
  return out;
}

function _mapMovieResult(tmdb, r) {
  const title = (r && (r.title || r.name) ? String(r.title || r.name) : '').trim();
  const originalTitle = (r && r.original_title ? String(r.original_title) : '').trim();
  const overview = (r && r.overview ? String(r.overview) : '').trim();
  const posterPath = r && r.poster_path ? String(r.poster_path) : '';
  const backdropPath = r && r.backdrop_path ? String(r.backdrop_path) : '';
  return {
    id: r && r.id ? Number(r.id) : 0,
    media_type: 'movie',
    title,
    original_title: originalTitle,
    overview,
    year: _pickYearFromDate(r && r.release_date ? r.release_date : ''),
    poster_url: posterPath ? tmdb.buildImageUrl(posterPath) : '',
    backdrop_url: backdropPath ? tmdb.buildImageUrl(backdropPath) : '',
    vote_average: r && r.vote_average ? Number(r.vote_average) : 0,
    actors: _pickActorsFromCredits(r && r.credits ? r.credits : null),
    genres: _pickGenresFromDetail(r && r.genres ? r.genres : null),
  };
}

function _mapTvResult(tmdb, r) {
  const title = (r && (r.name || r.title) ? String(r.name || r.title) : '').trim();
  const originalTitle = (r && r.original_name ? String(r.original_name) : '').trim();
  const overview = (r && r.overview ? String(r.overview) : '').trim();
  const posterPath = r && r.poster_path ? String(r.poster_path) : '';
  const backdropPath = r && r.backdrop_path ? String(r.backdrop_path) : '';
  return {
    id: r && r.id ? Number(r.id) : 0,
    media_type: 'tv',
    title,
    original_title: originalTitle,
    overview,
    year: _pickYearFromDate(r && r.first_air_date ? r.first_air_date : ''),
    poster_url: posterPath ? tmdb.buildImageUrl(posterPath) : '',
    backdrop_url: backdropPath ? tmdb.buildImageUrl(backdropPath) : '',
    vote_average: r && r.vote_average ? Number(r.vote_average) : 0,
    actors: _pickActorsFromCredits(r && r.credits ? r.credits : null),
    genres: _pickGenresFromDetail(r && r.genres ? r.genres : null),
  };
}

async function _enrichResults(tmdb, mediaType, results) {
  const list = Array.isArray(results) ? results : [];
  if (!tmdb || (mediaType !== 'movie' && mediaType !== 'tv') || list.length === 0) return list;

  const queue = list.map(r => r).filter(r => r && r.id);
  const concurrency = 4;

  const workers = Array.from({ length: Math.min(concurrency, queue.length) }).map(async () => {
    while (queue.length > 0) {
      const item = queue.shift();
      if (!item || !item.id) continue;

      const hasActors = Array.isArray(item.actors) && item.actors.length > 0;
      const hasGenres = Array.isArray(item.genres) && item.genres.length > 0;
      if (hasActors && hasGenres) continue;

      const details = mediaType === 'movie' ? await tmdb.getMovieDetails(item.id).catch(() => null) : await tmdb.getTvDetails(item.id).catch(() => null);
      if (!details) continue;

      item.actors = _pickActorsFromCredits(details.credits);
      item.genres = _pickGenresFromDetail(details.genres);
    }
  });

  await Promise.all(workers);
  return list;
}

class VideoTmdbController {
  async search(req, res) {
    try {
      const uid = req.user && req.user.id ? Number(req.user.id) : 0;
      if (!uid) return ResponseUtil.unauthorized(req, res);

      const body = req.body || {};
      const mediaType = String(body.media_type ?? body.mediaType ?? '').trim();
      const searchMode = String(body.search_mode ?? body.searchMode ?? 'keyword').trim();
      const query = String(body.query ?? body.keyword ?? '').trim();
      const tmdbId = String(body.tmdb_id ?? body.tmdbId ?? '').trim();
      const indexId = Number(body.index_id ?? body.indexId ?? 0) || 0;
      const page = Math.max(1, Number(body.page ?? 1) || 1);

      if (mediaType !== 'movie' && mediaType !== 'tv') {
        return ResponseUtil.error(req, res, 'common.PARAM_ERROR', 400);
      }

      const tmdb = await _getTmdbClient();
      if (!tmdb) return ResponseUtil.error(req, res, 'common.ERROR', 500);

      if (searchMode === 'tmdb_id') {
        const idNum = Number(tmdbId || 0) || 0;
        if (!idNum) return ResponseUtil.success(req, res, { page: 1, total_pages: 0, results: [] }, 'common.SUCCESS', 200);
        const details = mediaType === 'movie' ? await tmdb.getMovieDetails(idNum) : await tmdb.getTvDetails(idNum);
        if (!details) return ResponseUtil.success(req, res, { page: 1, total_pages: 0, results: [] }, 'common.SUCCESS', 200);
        const item = mediaType === 'movie' ? _mapMovieResult(tmdb, details) : _mapTvResult(tmdb, details);
        return ResponseUtil.success(req, res, { page: 1, total_pages: 1, results: [item].filter(e => e && e.id) }, 'common.SUCCESS', 200);
      }

      if (!query) return ResponseUtil.success(req, res, { page: 1, total_pages: 0, results: [] }, 'common.SUCCESS', 200);

      // ⭐ 日本片优先（2026-10-12 用户要求）：日本电影库里的条目，先用番号去日文站点搜，
      //    命中即收工、不再碰 TMDB —— 与自动刮削的优先级完全一致。
      //    只在第一页做，翻页时不再重复打日文站点。
      const canJavSearch = indexId > 0 && page <= 1;
      if (canJavSearch && (await _isJpMovieIndexId(req.dbVideo, indexId))) {
        const javItem = await _scrapeJavItem({ query, mediaType });
        if (javItem) {
          return ResponseUtil.success(req, res, { page: 1, total_pages: 1, results: [javItem] }, 'common.SUCCESS', 200);
        }
      }

      const endpoint = mediaType === 'movie' ? '/3/search/movie' : '/3/search/tv';
      const raw = await tmdb.requestJson(endpoint, {
        query,
        include_adult: 'false',
        language: tmdb.language,
        page,
      });

      const resultsRaw = Array.isArray(raw && raw.results) ? raw.results : [];
      const totalPages = Math.max(0, Number(raw && raw.total_pages ? raw.total_pages : 0) || 0);

      let results = resultsRaw.map(r => (mediaType === 'movie' ? _mapMovieResult(tmdb, r) : _mapTvResult(tmdb, r))).filter(e => e && e.id);
      // results = await _enrichResults(tmdb, mediaType, results);

      // TMDB 一条都没搜到、且用户开了「日本片识别兜底」时，再按番号兜一次
      // —— 与自动刮削「TMDB 匹配不到 → 按番号抓」的顺序一致。
      if (results.length === 0 && canJavSearch && (await _isJavFallbackEnabled())) {
        const javItem = await _scrapeJavItem({ query, mediaType });
        if (javItem) results = [javItem];
      }

      return ResponseUtil.success(req, res, { page, total_pages: totalPages, results }, 'common.SUCCESS', 200);
    } catch (e) {
      console.log(e);
      const msgKey = e && e.message ? e.message : 'common.ERROR';
      const statusCode = e && e.statusCode ? Number(e.statusCode) : 500;
      return ResponseUtil.error(req, res, msgKey, statusCode);
    }
  }

  /**
   * 日本片封面代理：`GET /api/video/jav/cover?dvd_id=SNOS-403`
   *
   * 为什么不能直接把日文站的封面直链丢给客户端：那些站点对图片做了防盗链，
   * 客户端裸连一律 403（在「搜索影音信息」里表现为「信息出来了、图是空的」）。
   * 这里由服务端带上 UA + Referer 去取、转成 jpg 落到 NFO 海报目录缓存，
   * 之后同一番号再请求就直接吐本地文件。
   */
  async javCover(req, res) {
    try {
      const uid = req.user && req.user.id ? Number(req.user.id) : 0;
      if (!uid) return res.status(401).end();

      const q = req.query || {};
      const raw = String(q.dvd_id ?? q.dvdId ?? q.dvdid ?? '').trim();
      if (!raw) return res.status(400).end();

      const avId = extractAvId(raw) || raw;
      const filePath = _javCoverCachePath(avId);
      if (!filePath) return res.status(400).end();

      const sendCached = async () => {
        try {
          const st = await fs.promises.stat(filePath);
          if (st && st.isFile() && Number(st.size || 0) > 0) {
            res.set('Content-Type', 'image/jpeg');
            res.sendFile(filePath);
            return true;
          }
        } catch (_) {}
        return false;
      };

      // ① 命中缓存：直接吐文件，不再出网
      if (await sendCached()) return;

      // ② 拿封面直链（带负缓存，抓不到时不至于被前端反复打爆）
      const key = avId.toUpperCase();
      const memo = _javCoverUrlCache.get(key);
      const proxyUrl = (await networkProxyUtil.resolveMetadataProxyUrl()) || '';

      let coverUrl = '';
      if (memo && Date.now() - memo.at < _JAV_COVER_URL_TTL) {
        coverUrl = memo.url || '';
      } else {
        const siteBases = await _loadJavSiteBases();
        const meta = await javScraper
          .scrapeByDvdId(avId, { proxyUrl, siteBases, timeoutMs: 15000 })
          .catch(() => null);
        coverUrl = meta && meta.coverUrl ? String(meta.coverUrl).trim() : '';
        _javCoverUrlCache.set(key, { url: coverUrl, at: Date.now() });
      }
      if (!coverUrl) return res.status(404).end();

      // ③ 落盘（downloadCoverToJpeg 内部已带 UA/Referer/代理，并做 jpg 转码）
      await fs.promises.mkdir(path.dirname(filePath), { recursive: true }).catch(() => {});
      await javNfoFallback
        .downloadCoverToJpeg({ url: coverUrl, targetPath: filePath, proxyUrl, timeoutMs: 20000 })
        .catch(() => false);

      if (await sendCached()) return;
      return res.status(404).end();
    } catch (_) {
      return res.status(404).end();
    }
  }
}

module.exports = new VideoTmdbController();
