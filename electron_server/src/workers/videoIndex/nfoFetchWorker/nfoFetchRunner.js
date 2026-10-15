'use strict';

const fs = require('fs');
const path = require('path');
const sharp = require('../../../utils/sharpConfigured');

const Logger = require('../../../utils/logger');
const FileUtil = require('../../../utils/fileUtil');
const dbUtil = require('../../../db/dbUtil');
const knexUtil = require('../../../db/knexUtil');
const tableConfig = require('../../../db/table/tableConfig');
const tableVideoSource = require('../../../db/table/tableVideoSource');
const config = require('../../../config/config');
const nascabAccountUtil = require('../../../api/modules/service/utils/nascabAccountUtil');
const networkProxyUtil = require('../../../utils/networkProxyUtil');

const { TmdbClient } = require('./tmdbClient');
const { buildMovieNfo, buildTvShowNfo, buildSeasonNfo, buildEpisodeNfo, writeTextIfChanged } = require('./jellyfinNfo');
const videoIndexIndexUtil = require('../videoIndexIndexUtil');
const { readAndParseNfo, hasValidNfo } = require('../nfoParser');
const { parseSeasonNumberFromName, parseEpisodeFromName, normalizeNameForNfoGuess } = require('../videoIndexUtil');
const tmdbUtil = require('./tmdbUtil');
const javNfoFallback = require('../javFetchWorker/javNfoFallback');
// ⭐ 番号提取（2026-10-12）：日本电影库要据此判断「值不值得先走番号刮削」
const { extractAvId } = require('../javFetchWorker/avIdExtractor');
const javScraper = require('../javFetchWorker/javScraper');
function _pickYearFromText(s) {
  const m = String(s || '').match(/\b(19|20)\d{2}\b/);
  const y = m ? Number(m[0]) : 0;
  return y >= 1900 && y <= 2100 ? y : 0;
}

function _cleanSearchText(text) {
  const raw = String(text || '').trim();
  if (!raw) return '';
  const tokens = tmdbUtil.getSearchTokens(raw).tokens || [];
  if (tokens.length > 0) return tokens.join(' ').trim();
  return raw.replace(/\s+/g, ' ').trim();
}

function _normalizeSearchTitleFromFileName(filename) {
  const base = path.parse(String(filename || '')).name;
  const norm = normalizeNameForNfoGuess(base);
  return norm || base;
}

const _SKIP_NAME_HINTS = ['img_', 'video_', 'vid_', 'samsung_', 'short_', 'clip_', 'weixin_', 'wx_', 'dsc_', 'douyin_', 'xiaohongshu_', 'baiduyun_', 'mmexport'];

function _hasSkipNameHint(filename) {
  const s = String(filename || '').toLowerCase();
  if (!s) return false;
  return _SKIP_NAME_HINTS.some(t => s.includes(t));
}

function _shouldSkipByDurationSeconds(duration) {
  const d = Number(duration || 0) || 0;
  return d > 0 && d < 20 * 60;
}

function _isPureNumberText(text) {
  const s = String(text || '').trim();
  if (!s) return false;
  return /^\d+$/.test(s);
}

/**
 * 判断一条 TMDB 结果是不是「垃圾条目」。
 *
 * TMDB 上有一批人为建的空壳条目：标题就是别人的搜索词、简介是 111111111111、
 * 没有封面、没有上映日期。SNOS-403 就是被这么一条叫 `snos102` 的条目套住的 ——
 * 搜到了、写进 NFO、标记成已刮削，然后永远不再重试。
 *
 * 判据（全部满足才算垃圾，避免误伤冷门正经电影）：
 *   - 既无海报也无背景图；
 *   - 没有上映日期；
 *   - 标题与本次搜索词（或库里已有的名字）一字不差。
 */
function _looksJunkTmdbMatch(details, queries) {
  const m = details && typeof details === 'object' ? details : null;
  if (!m) return true;
  if (m.poster_path || m.backdrop_path) return false;
  if (m.release_date) return false;
  const title = String(m.title || m.name || '').trim().toLowerCase();
  if (!title) return true;
  return (Array.isArray(queries) ? queries : []).some(q => {
    const s = String(q || '').trim().toLowerCase();
    return !!s && s === title;
  });
}

/**
 * 读「日本片站点地址」覆盖配置（设置里可逐站点填，留空走内置默认）。
 * @returns {Promise<Record<string,string>|null>} 形如 { javdb: 'https://javdb.com' }
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

function _buildQueryAttemptsFromText(text) {
  const { tokens, year } = tmdbUtil.getSearchTokens(text);
  if (tokens.length === 0) return [];

  const seen = new Set();
  const out = [];
  const push = (q, y) => {
    const query = String(q || '').trim();
    const yr = Number(y || 0) || 0;
    if (!query) return;
    const key = `${query}||${yr || ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ query, year: yr });
  };

  for (let i = tokens.length; i >= 1; i -= 1) {
    const q = tokens.slice(0, i).join(' ').trim();
    if (!q || q.length < 2) continue;
    if (year) push(q, year);
    push(q, 0);
  }

  return out;
}

/** 与前端国际化 13 种语言一致，将 locale 规范为 TMDB 的 language 格式 */
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

function _pickList(arr, mapper, max = 0) {
  const list = Array.isArray(arr) ? arr : [];
  const out = [];
  for (const it of list) {
    const v = mapper(it);
    if (!v) continue;
    out.push(v);
    if (max > 0 && out.length >= max) break;
  }
  return out;
}

function _tmdbImageUrl(client, filePath) {
  if (!client) return '';
  return client.buildImageUrl(filePath);
}

/**
 * 把 TMDB 图片地址统一到 w500（详情页取头像用的就是 w500 档）。
 * 头像缓存文件名是 `<id>_w500.jpg`，预下载也按同一档下，才能被直接命中。
 */
function _tmdbThumbToW500(url) {
  return String(url || '').replace(/\/t\/p\/[^/]+\//i, '/t/p/w500/');
}

/**
 * 刮削时顺便把演员/导演头像下载进服务端头像缓存目录。
 *
 * 详情页演员头像走 `/api/video/detail/person-image`，无 tmdbId 的日本片演员
 * 靠 NFO 里的 `<thumb>` 找头像；这里提前下好，用户点进详情页就有图，
 * 不必等首次请求现下（日本站点头像带防盗链，只有这里带 Referer 能下到）。
 * 已存在的文件会立刻跳过，重复刮削不产生额外请求。单条最多下 20 个。
 */
async function _downloadPeopleAvatars(people, proxyUrl = '') {
  const list = Array.isArray(people) ? people : [];
  let done = 0;
  for (const p of list) {
    const raw = p && p.thumb ? String(p.thumb).trim() : '';
    if (!raw || !/^https?:\/\//i.test(raw)) continue;
    const thumb = raw.includes('image.tmdb.org') ? _tmdbThumbToW500(raw) : raw;
    try {
      await javNfoFallback.downloadActorAvatarToCache({
        tmdbId: p && p.tmdbId ? String(p.tmdbId) : '',
        thumbUrl: thumb,
        proxyUrl,
      });
    } catch (_) {}
    done += 1;
    if (done >= 20) break;
  }
}

function _mapCreditsToPeople({ client, credits }) {
  const cast = credits && Array.isArray(credits.cast) ? credits.cast : [];
  const crew = credits && Array.isArray(credits.crew) ? credits.crew : [];

  const actors = _pickList(
    cast,
    c => {
      const name = c && c.name ? String(c.name).trim() : '';
      if (!name) return null;
      const role = c && c.character ? String(c.character).trim() : '';
      const tmdbId = c && c.id ? String(c.id) : '';
      const thumb = c && c.profile_path ? _tmdbImageUrl(client, c.profile_path) : '';
      return { name, role, tmdbId, thumb };
    },
    30
  );

  const directors = _pickList(
    crew.filter(c => c && String(c.job || '').toLowerCase() === 'director'),
    c => {
      const name = c && c.name ? String(c.name).trim() : '';
      if (!name) return null;
      const tmdbId = c && c.id ? String(c.id) : '';
      const thumb = c && c.profile_path ? _tmdbImageUrl(client, c.profile_path) : '';
      return { name, tmdbId, thumb };
    },
    10
  );

  return { actors, directors };
}

function _mapMovieToNfo({ client, movie }) {
  const m = movie && typeof movie === 'object' ? movie : {};
  const { actors, directors } = _mapCreditsToPeople({ client, credits: m.credits });
  const genres = _pickList(m.genres, g => (g && g.name ? String(g.name) : ''), 0);
  const countries = _pickList(m.production_countries, c => (c && c.name ? String(c.name) : ''), 0);
  const languages = _pickList(m.spoken_languages, l => (l && l.english_name ? String(l.english_name) : l && l.name ? String(l.name) : ''), 0);
  const year = _pickYearFromText(m.release_date);
  const imdbId = m.external_ids && m.external_ids.imdb_id ? String(m.external_ids.imdb_id) : '';
  return {
    title: m.title || m.name || '',
    originalTitle: m.original_title || '',
    sortTitle: '',
    year,
    premiered: m.release_date || '',
    plot: m.overview || '',
    rating: m.vote_average ? Number(m.vote_average) : 0,
    genres,
    tags: [],
    countries,
    languages,
    tmdbId: m.id ? String(m.id) : '',
    imdbId,
    actors,
    directors,
  };
}

function _mapTvToNfo({ client, tv }) {
  const t = tv && typeof tv === 'object' ? tv : {};
  const { actors, directors } = _mapCreditsToPeople({ client, credits: t.credits });
  const genres = _pickList(t.genres, g => (g && g.name ? String(g.name) : ''), 0);
  const countries = _pickList(t.origin_country, c => (c ? String(c) : ''), 0);
  const languages = _pickList(t.languages, l => (l ? String(l) : ''), 0);
  const year = _pickYearFromText(t.first_air_date);
  const imdbId = t.external_ids && t.external_ids.imdb_id ? String(t.external_ids.imdb_id) : '';
  const studio = _pickList(t.networks, n => (n && n.name ? String(n.name) : ''), 1)[0] || '';
  return {
    title: t.name || '',
    originalTitle: t.original_name || '',
    sortTitle: '',
    year,
    premiered: t.first_air_date || '',
    plot: t.overview || '',
    rating: t.vote_average ? Number(t.vote_average) : 0,
    genres,
    tags: [],
    countries,
    languages,
    studio,
    tmdbId: t.id ? String(t.id) : '',
    imdbId,
    actors,
    directors,
  };
}

function _mapSeasonToNfo({ client, tvId, season }) {
  const s = season && typeof season === 'object' ? season : {};
  const { actors, directors } = _mapCreditsToPeople({ client, credits: s.credits });
  const year = _pickYearFromText(s.air_date);
  return {
    title: s.name || `Season ${s.season_number || ''}`,
    seasonNumber: Number(s.season_number || 0) || 0,
    year,
    premiered: s.air_date || '',
    plot: s.overview || '',
    rating: s.vote_average ? Number(s.vote_average) : 0,
    tmdbId: s.id ? String(s.id) : tvId ? `${tvId}:${s.season_number || ''}` : '',
    actors,
    directors,
  };
}

function _mapEpisodeToNfo({ client, episode }) {
  const e = episode && typeof episode === 'object' ? episode : {};
  const { actors, directors } = _mapCreditsToPeople({ client, credits: e.credits });
  return {
    title: e.name || '',
    seasonNumber: Number(e.season_number || 0) || 0,
    episodeNumber: Number(e.episode_number || 0) || 0,
    aired: e.air_date || '',
    plot: e.overview || '',
    rating: e.vote_average ? Number(e.vote_average) : 0,
    tmdbId: e.id ? String(e.id) : '',
    actors,
    directors,
  };
}

function _pickLogoPathFromImages(images) {
  const logos = images && Array.isArray(images.logos) ? images.logos : [];
  if (!logos || logos.length === 0) return '';
  const pick = logos.find(l => l && String(l.iso_639_1 || '').toLowerCase() === 'zh') || logos.find(l => l && String(l.iso_639_1 || '').toLowerCase() === 'en') || logos[0];
  return pick && pick.file_path ? String(pick.file_path) : '';
}

/**
 * TMDB 的 `backdrop_path` 有为空的情况（用户库里就有几部片因此没有 fanart）。
 * 详情请求已经带了 `append_to_response=images`，这里从图集里补一张背景图，
 * 让「自动刮削后缺横版图」的情况尽可能少。按语言偏好挑，挑不到取第一张。
 */
function _pickBackdropPathFromImages(images) {
  const list = images && Array.isArray(images.backdrops) ? images.backdrops : [];
  if (!list || list.length === 0) return '';
  const pick = list.find(b => b && String(b.iso_639_1 || '').toLowerCase() === 'zh')
    || list.find(b => b && !b.iso_639_1)
    || list.find(b => b && String(b.iso_639_1 || '').toLowerCase() === 'en')
    || list[0];
  return pick && pick.file_path ? String(pick.file_path) : '';
}

async function _ensureDownloaded(client, baseDir, fileName, filePath) {
  const fp = String(filePath || '').trim();
  const out = path.join(String(baseDir || ''), String(fileName || ''));
  if (!fp || !out) return false;
  try {
    if (fs.existsSync(out) && fs.statSync(out).isFile()) return false;
  } catch (_) {}

  const url = client.buildImageUrl(fp);
  if (!url) return false;

  const tmp = `${out}.${Date.now()}.tmp`;
  const ok = await client.downloadToFile(url, tmp);
  if (!ok) return false;
  try {
    await sharp(tmp)
      .jpeg({ quality: 85 })
      .toFile(out);
    try { fs.unlinkSync(tmp); } catch (_) {}
    return true;
  } catch (_) {
    try { fs.unlinkSync(tmp); } catch (_) {}
    try { fs.unlinkSync(out); } catch (_) {}
    return false;
  }
}

async function _ensureDownloadedJpeg(client, baseDir, fileName, filePath) {
  const fp = String(filePath || '').trim();
  const out = path.join(String(baseDir || ''), String(fileName || '')).trim();
  if (!fp || !out) return false;
  try {
    if (fs.existsSync(out) && fs.statSync(out).isFile()) return false;
  } catch (_) {}

  const url = client.buildImageUrl(fp);
  if (!url) return false;

  const tmp = `${out}.${Date.now()}.tmp`;
  const ok = await client.downloadToFile(url, tmp);
  if (!ok) return false;
  try {
    await sharp(tmp)
      .jpeg({ quality: 85 })
      .toFile(out);
    try { fs.unlinkSync(tmp); } catch (_) {}
    return true;
  } catch (_) {
    try { fs.unlinkSync(tmp); } catch (_) {}
    try { fs.unlinkSync(out); } catch (_) {}
    return false;
  }
}

async function _ensureDownloadedPng(client, baseDir, fileName, filePath) {
  const fp = String(filePath || '').trim();
  const out = path.join(String(baseDir || ''), String(fileName || '')).trim();
  if (!fp || !out) return false;
  try {
    if (fs.existsSync(out) && fs.statSync(out).isFile()) return false;
  } catch (_) {}

  const url = client.buildImageUrl(fp);
  if (!url) return false;

  const tmp = `${out}.${Date.now()}.tmp`;
  const ok = await client.downloadToFile(url, tmp);
  if (!ok) return false;
  try {
    await sharp(tmp)
      .png()
      .toFile(out);
    try { fs.unlinkSync(tmp); } catch (_) {}
    return true;
  } catch (_) {
    try { fs.unlinkSync(tmp); } catch (_) {}
    try { fs.unlinkSync(out); } catch (_) {}
    return false;
  }
}

async function _updateIndexFromNfoAndArtwork({ knex, row, baseDir, searchDir, nfoPath, videoBaseName = '', onlyVideoBase = false, seasonNumber = 0 }) {
  const r = row && typeof row === 'object' ? row : {};
  if (!r.id) return false;

  const parsed = nfoPath ? await readAndParseNfo(nfoPath) : null;
  const nfoFields = videoIndexIndexUtil.buildNfoFieldsFromParsed(parsed) || { nfo_get_state: 1 };

  const current = await knex('video_index')
    .where({ id: r.id })
    .first('poster_path', 'fanart_path', 'logo_path')
    .catch(() => null);

  const artwork = await videoIndexIndexUtil.resolveArtworkPaths({ baseDir, searchDir, current, videoBaseName, onlyVideoBase, seasonNumber });

  const patch = { ...nfoFields, ...artwork, view_time: new Date() };
  await knex('video_index')
    .where({ id: r.id })
    .update(patch)
    .catch(() => {});

  const hasKeyFields = nfoFields && (Object.prototype.hasOwnProperty.call(nfoFields, 'nfo_regions') || Object.prototype.hasOwnProperty.call(nfoFields, 'nfo_genres'));
  if (hasKeyFields) {
    await videoIndexIndexUtil.syncVideoIndex2KeyFromNfoFields({
      knex,
      indexId: r.id,
      mediaType: r.media_type,
      nfoRegions: nfoFields.nfo_regions,
      nfoGenres: nfoFields.nfo_genres,
    });
  }
  return true;
}

class NfoFetchRunner {
  constructor() {
    this.knexVideo = null;
    this.tmdb = null;
    this.proxyUrl = '';
    this.javFallbackEnabled = false;
    // ⭐ 日本片站点地址覆盖（2026-10-12）：javbus/avsox 这些域名常年失效，
    //    允许在设置里按站点改地址，留空用内置默认（见 javScraper.SITE_BASE）。
    this.javSiteBases = null;
    // ⭐ 日本电影库来源根路径缓存（2026-10-12，见 _isJpMoviePath）
    this._jpMovieRoots = null;
    this._jpRootsCachedAt = 0;
  }

  async init() {
    await knexUtil.init(dbUtil.DB_PATHS.MAIN_DB);
    await knexUtil.init(dbUtil.DB_PATHS.VIDEO_DB);
    this.knexVideo = knexUtil.getInstance(dbUtil.DB_PATHS.VIDEO_DB);

    const knex = knexUtil.getInstance(dbUtil.DB_PATHS.MAIN_DB);
    const [tmdbApiTokenDec, tmdbApiTokenDefaultDec, tmdbApiUrlDec, tmdbLanguage, uiLanguage, javFallbackEnable] = await Promise.all([
      nascabAccountUtil.getDecryptedConfigValue(knex, tableConfig, 'tmdbApiToken'),
      nascabAccountUtil.getDecryptedConfigValue(knex, tableConfig, 'tmdbApiTokenDefault'),
      nascabAccountUtil.getDecryptedConfigValue(knex, tableConfig, 'tmdbApiUrl'),
      tableConfig.getConfigByKey('tmdbLanguage'),
      tableConfig.getConfigByKey(tableConfig.KEY_SERVER_UI_LANGUAGE),
      tableConfig.getConfigByKey(tableConfig.KEY_JAV_FALLBACK_ENABLE),
    ]);
    let apiToken = tmdbApiTokenDec ? String(tmdbApiTokenDec).trim() : '';
    if (!apiToken && tmdbApiTokenDefaultDec) apiToken = String(tmdbApiTokenDefaultDec).trim();
    let apiUrl = tmdbApiUrlDec ? String(tmdbApiUrlDec).trim() : '';
    // 代理：统一走「系统设置 → 网络代理」（旧键 tmdbProxy* 仅作兜底），
    // 见 networkProxyUtil.resolveMetadataProxyUrl。影视设置里那个代理开关已从界面去掉。
    this.proxyUrl = (await networkProxyUtil.resolveMetadataProxyUrl()) || '';
    this.javFallbackEnabled = javFallbackEnable === '1' || javFallbackEnable === 1 || javFallbackEnable === true;
    this.javSiteBases = await _loadJavSiteBases();
    const preferred = tmdbLanguage ? String(tmdbLanguage).trim() : '';
    const effectiveLanguage = _normalizeToTmdbLanguage(preferred) || _normalizeToTmdbLanguage(uiLanguage) || _normalizeToTmdbLanguage(_getSystemLocale()) || 'en-US';

    if (!apiToken || !apiUrl) {
      const defaults = config.getDefaultTmdbConfig();
      if (!apiToken && defaults.tmdbApiToken) apiToken = String(defaults.tmdbApiToken).trim();
      if (!apiUrl && defaults.tmdbApiUrl) apiUrl = String(defaults.tmdbApiUrl).trim();
    }

    this.tmdb = new TmdbClient({ apiUrl, apiToken, proxyUrl: this.proxyUrl, language: effectiveLanguage });
  }

  async getPendingRoots(limit = 5) {
    const matchRoots = await tableVideoSource.getMatchNfoPaths({ knex: this.knexVideo });
    const enabledRoots = (matchRoots || []).map(p => (p ? path.resolve(String(p)) : '')).filter(Boolean);
    if (enabledRoots.length === 0) return [];
    console.log('enabledRoots', enabledRoots);
    const rows = await this.knexVideo('video_index')
      .select('id', 'path', 'filename', 'media_type', 'is_file', 'nfo_name', 'nfo_get_state', 'duration')
      .where({ nfo_get_state: 0 })
      .whereIn('media_type', ['tv', 'movie', 'bdmv', 'video_ts'])
      .andWhere(qb => {
        qb.where(inner => {
          for (const root of enabledRoots) {
            const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
            inner.orWhere('path', root).orWhere('path', 'like', `${prefix}%`);
            inner.orWhere({ path: path.dirname(root), filename: path.basename(root) });
          }
        });
      })
      .orderBy('id', 'asc')
      .limit(Math.max(1, Math.min(50, Number(limit || 0) || 5)))
      .catch(() => []);
    return rows || [];
  }

  async markSkipped(row) {
    if (!row || !row.id) return;
    await this.knexVideo('video_index')
      .where({ id: row.id })
      .update({ nfo_get_state: 1 })
      .catch(() => {});
  }

  async markFailed(row) {
    if (!row || !row.id) return;
    console.log('nfo获取失败', row.id, row.path, row.filename);
    await this.knexVideo('video_index')
      .where({ id: row.id })
      .update({ nfo_get_state: 1 })
      .catch(() => {});
  }

  async processMovieRow(row) {
    const dirPath = row && row.path ? String(row.path) : '';
    const filename = row && row.filename ? String(row.filename) : '';
    if (!dirPath || !filename) return false;
    const mediaType = row && row.media_type ? String(row.media_type).trim() : '';
    const isDiscFolderMovie = mediaType === 'bdmv' || mediaType === 'video_ts';
    const movieFolder = isDiscFolderMovie ? path.join(dirPath, filename) : '';

    if (FileUtil.shouldSkipIndexingFilename(filename) || _hasSkipNameHint(path.parse(filename).name) || _shouldSkipByDurationSeconds(row && row.duration)) {
      await this.markSkipped(row);
      return true;
    }

    // ⭐⭐ 日本片优先（2026-10-12 用户要求）：开了「日本电影」开关的库，
    //    先用番号去日本站点搜，搜到就直接收工，不再碰 TMDB。
    //
    // ⚠️ 这里**不再**要求 javFallbackEnabled：「日本电影」是**按库**勾的显式声明，
    //    勾了就表示这个库就该按日本片刮；全局开关只保留它原本的语义 ——
    //    「TMDB / IMDb 都识别失败时，再按番号兜底」（见下面 TMDB 匹配失败的分支）。
    //    两者都要求的话，用户明明勾了库却因为一个藏在设置里的开关没开而毫无反应，
    //    这就是「SNOS-403 怎么都刮不出来」的成因之一。
    const jpMoviePath = await this._isJpMoviePath(dirPath);
    const earlyAvId = extractAvId(path.parse(filename).name);

    // ⚠️ 搜索词**不能**用库里存的 `nfo_name`：
    //    对日本片来说它可能是一轮旧刮削的结果（甚至是错配），拿它当搜索词会自我污染 ——
    //    SNOS-403 就是被一条叫 "snos102" 的 TMDB 垃圾条目反复套住的。
    //    所以日本片一律以**文件名**推出来的词为准；普通影片维持原样（尊重已有 NFO / 手动改名）。
    const storedTitle = (row.nfo_name ? String(row.nfo_name) : '').trim();
    const fallbackTitle = _normalizeSearchTitleFromFileName(filename);
    const preferTitle = jpMoviePath || earlyAvId ? fallbackTitle : storedTitle;
    const rawTitle = preferTitle || storedTitle || fallbackTitle;

    const numericCheck = _cleanSearchText(rawTitle) || String(rawTitle || '').trim();
    if (_isPureNumberText(numericCheck) && numericCheck !== '1946') {
      await this.markSkipped(row);
      return true;
    }

    try {
      const st = await fs.promises.stat(isDiscFolderMovie ? movieFolder : path.join(dirPath, filename));
      if (isDiscFolderMovie ? !st.isDirectory() : !st.isFile()) return false;
    } catch (_) {
      return false;
    }

    const yearFromFilename = _pickYearFromText(filename);
    const attempts = _buildQueryAttemptsFromText(rawTitle);
    if (attempts.length === 0) {
      const q = _cleanSearchText(rawTitle);
      if (q) attempts.push({ query: q, year: yearFromFilename || 0 });
    }

    // ⭐ 日本电影库**优先**走番号刮削（2026-10-12）。
    //
    // 原来是「TMDB 匹配失败才兜底」；用户开了「日本电影」开关的库，期待的是
    // 「就按日本片来刮」。所以提到 TMDB 之前，命中即收工。
    //
    // ⚠️ 两个前置条件，缺一不可：
    //   ① 该文件所在库开了 jp_movie（没开的库行为完全不变）；
    //   ② 文件名里**抠得出番号** —— 普通日本电影（《七武士》这种）抠不出番号，
    //      就该照常走 TMDB，不能被这条分支拦住、也不该白跑一次日文站点请求。
    if (jpMoviePath && earlyAvId) {
      const javOk = await this._tryJavFallback(row, {
        dirPath,
        filename,
        isDiscFolderMovie,
        movieFolder,
      });
      if (javOk) return true;
    }

    let tmdbId = 0;
    let matchedQuery = '';
    for (const a of attempts) {
      const q = a && a.query ? String(a.query) : '';
      const y = a && a.year ? Number(a.year) : 0;
      if (!q) continue;
      const results = await this.tmdb.searchMovie({ query: q, year: y || yearFromFilename || 0 });
      const picked = results && results[0] ? results[0] : null;
      const id = picked && picked.id ? Number(picked.id) : 0;
      if (id) {
        tmdbId = id;
        matchedQuery = q;
        break;
      }
    }
    if (!tmdbId) {
      // TMDB 匹配不到时，如果用户开启了「日本片兜底识别」，再尝试按番号抓取。
      if (!this.javFallbackEnabled) return false;
      return await this._tryJavFallback(row, { dirPath, filename, isDiscFolderMovie, movieFolder });
    }

    const details = await this.tmdb.getMovieDetails(tmdbId);
    if (!details) return false;

    // ⭐ TMDB 上有一批人为建的空壳条目（标题就是搜索词、简介是 111111、没封面没日期）。
    //    命中这种条目不算「刮到了」—— 丢掉它，改按番号再兜底一次，
    //    否则会把错标题写进 NFO 并且标记成「已刮削」，从此不再重试。
    if (_looksJunkTmdbMatch(details, [matchedQuery, rawTitle, storedTitle])) {
      Logger.info(
        `⚠️ skip junk TMDB match (id=${tmdbId}, title=${String(details.title || '')}) <- ${filename}`
      );
      if (!this.javFallbackEnabled) return false;
      return await this._tryJavFallback(row, { dirPath, filename, isDiscFolderMovie, movieFolder });
    }

    const nfoData = _mapMovieToNfo({ client: this.tmdb, movie: details });
    const baseName = path.parse(filename).name;
    const nfoPath = isDiscFolderMovie ? path.join(movieFolder, 'movie.nfo') : path.join(dirPath, `${baseName}.nfo`);
    await writeTextIfChanged(nfoPath, buildMovieNfo(nfoData));

    if (details.poster_path) await _ensureDownloadedJpeg(this.tmdb, isDiscFolderMovie ? movieFolder : dirPath, isDiscFolderMovie ? 'poster.jpg' : `${baseName}-post.jpg`, details.poster_path);
    const fanartPath = details.backdrop_path || _pickBackdropPathFromImages(details.images);
    if (fanartPath) await _ensureDownloadedJpeg(this.tmdb, isDiscFolderMovie ? movieFolder : dirPath, isDiscFolderMovie ? 'fanart.jpg' : `${baseName}-fanart.jpg`, fanartPath);
    const logo = _pickLogoPathFromImages(details.images);
    if (logo) {
      await _ensureDownloadedPng(this.tmdb, isDiscFolderMovie ? movieFolder : dirPath, isDiscFolderMovie ? 'logo.png' : `${baseName}-logo.png`, logo);
      const legacy = path.join(isDiscFolderMovie ? movieFolder : dirPath, isDiscFolderMovie ? 'logo.jpg' : `${baseName}-logo.jpg`);
      try {
        if (fs.existsSync(legacy) && fs.statSync(legacy).isFile()) fs.unlinkSync(legacy);
      } catch (_) {}
    }

    // 演员头像：刮削时一并下载（详情页直接命中缓存）。
    await _downloadPeopleAvatars(nfoData.actors, this.proxyUrl || '');

    await _updateIndexFromNfoAndArtwork({
      knex: this.knexVideo,
      row,
      baseDir: dirPath,
      searchDir: isDiscFolderMovie ? movieFolder : dirPath,
      nfoPath,
      videoBaseName: isDiscFolderMovie ? '' : baseName,
      onlyVideoBase: false,
      seasonNumber: 0,
    });

    return true;
  }

  /**
   * 该路径是否属于「日本电影库」（`video_library.jp_movie = 1`）。
   *
   * ⚠️ `video_index` **刻意没有 library_id**，只能靠 `video_source.path` 前缀反查
   *    —— 与库计数、可见性判定同一口径。
   *
   * 结果缓存 60s：一轮刮削会问几十上百次，不能每次都打两条 SQL；
   * 又要让用户在界面上改完开关后能较快生效，所以带个短 TTL 而不是永久缓存。
   */
  async _isJpMoviePath(dirPath) {
    const target = String(dirPath || '').trim();
    if (!target) return false;
    try {
      const now = Date.now();
      if (!this._jpRootsCachedAt || now - this._jpRootsCachedAt > 60 * 1000) {
        const libs = await this.knexVideo('video_library')
          .where({ jp_movie: 1 })
          .select('id')
          .catch(() => []);
        const ids = (libs || [])
          .map(r => Number(r && r.id) || 0)
          .filter(v => v > 0);
        let roots = [];
        if (ids.length > 0) {
          const rows = await this.knexVideo('video_source')
            .whereIn('library_id', ids)
            .select('path')
            .catch(() => []);
          roots = (rows || [])
            .map(r => (r && r.path ? path.resolve(String(r.path)) : ''))
            .filter(Boolean);
        }
        this._jpMovieRoots = roots;
        this._jpRootsCachedAt = now;
      }
      const list = this._jpMovieRoots || [];
      if (list.length === 0) return false;
      const resolved = path.resolve(target);
      return list.some(
        root =>
          resolved === root ||
          resolved.startsWith(root.endsWith(path.sep) ? root : root + path.sep)
      );
    } catch (_) {
      return false;
    }
  }

  /**
   * 日本片兜底识别：从番号抓取日文站点信息，写 NFO + 封面并回填索引。
   *
   * ⚠️ 这里**不管开关**，开关由调用方决定（三个调用点的语义各不相同）：
   *    - 日本电影库优先刮削：勾了库就跑，不看全局开关；
   *    - TMDB 匹配失败 / 命中垃圾条目后的兜底：调用方先判 javFallbackEnabled；
   *    - 手动选中番号结果：用户显式选择，直接跑。
   *
   * @param {object} row 索引记录
   * @param {{dirPath: string, filename: string, isDiscFolderMovie: boolean, movieFolder: string}} ctx
   * @param {string} [dvdId] 显式番号（手动「搜索影音信息」里用户选中的那条结果）
   * @returns {Promise<boolean>} 是否成功
   */
  async _tryJavFallback(row, { dirPath, filename, isDiscFolderMovie, movieFolder }, dvdId = '') {
    let meta = null;
    try {
      meta = await javNfoFallback.fetchJavMeta({
        filename,
        folderName: dirPath,
        nfoName: row && row.nfo_name ? String(row.nfo_name) : '',
        dvdId,
        proxyUrl: this.proxyUrl || '',
        siteBases: this.javSiteBases || null,
      });
    } catch (err) {
      Logger.error('❌ JAV fallback fetch failed', err && err.message ? err.message : err);
      return false;
    }
    if (!meta) return false;

    const nfoData = javNfoFallback.buildJavNfoData(meta);
    if (!nfoData.title) nfoData.title = String(meta.dvdid || '').trim();
    if (!nfoData.title && !meta.coverUrl) return false;

    const baseName = path.parse(filename).name;
    const searchDir = isDiscFolderMovie ? movieFolder : dirPath;
    const nfoPath = isDiscFolderMovie ? path.join(movieFolder, 'movie.nfo') : path.join(dirPath, `${baseName}.nfo`);
    await writeTextIfChanged(nfoPath, buildMovieNfo(nfoData));

    // ⭐ 多图落盘（2026-10-12 第三轮）：对齐本库既有命名 —— 一部片三张图，同源：
    //    横版缩略图 `<base>-backdrop.jpg`（站点原始封面）+
    //    竖版封面图 `<base>-poster.jpg`（**右对齐**裁 2:3）+ 16:9 `<base>-landscape.jpg`。
    //    ⚠️ 第一轮用 `-post`/`-fanart`/`-thumb`：`-post` 里存的是横版封面，竖版封面位
    //    就拿到了横图（用户反馈「没有封面、只有缩略图」）；`-fanart` 的匹配优先级又高于
    //    `-backdrop`，会一直盖住新图。碟目录（videoBase 为空）用不带前缀的固定名。
    //    ⚠️ 第二轮用**居中**裁切 → 切在站点横版封面（左封底+右封面展开图）的拼接缝上，
    //    用户反馈「封面明显不行」。第三轮按库内既有图反推出的偏移改成右对齐。
    //    ⚠️ 样品图（extrafanart）已去掉：本库没有这个惯例，且影片直接放在库根目录时
    //    多部片会共用同一个 `extrafanart/`，第二部片起因「文件已存在」被静默跳过而串图。
    const javProxyUrl = this.proxyUrl || '';
    const nameOf = suffix => (isDiscFolderMovie ? `${suffix}.jpg` : `${baseName}-${suffix}.jpg`);
    const backdropPath = path.join(searchDir, nameOf('backdrop'));
    if (meta.coverUrl) {
      await javNfoFallback.downloadCoverToJpeg({
        url: meta.coverUrl,
        targetPath: backdropPath,
        proxyUrl: javProxyUrl,
      });
    }
    // 另两张由刚落盘的横版原图本地裁，避免同一张封面重复请求站点。
    // poster 取右侧（库内既有图反推：横版封面是「左封底+右封面」，右半才是封面）；
    // landscape 取全宽居中裁高到 16:9。
    if (fs.existsSync(backdropPath)) {
      await javNfoFallback.cropJpegToAspect({
        srcPath: backdropPath,
        targetPath: path.join(searchDir, nameOf('poster')),
        aspect: 2 / 3,
        align: 'right',
      });
      await javNfoFallback.cropJpegToAspect({
        srcPath: backdropPath,
        targetPath: path.join(searchDir, nameOf('landscape')),
        aspect: 16 / 9,
      });
    }

    // ⭐ 演员头像（2026-10-12）：详情页要有头像。这里把站点头像下载进服务端
    //    头像缓存（已存在则跳过），并把地址写进 NFO 的 `<thumb>`（buildJavNfoData 里做）。
    await _downloadPeopleAvatars(nfoData.actors, javProxyUrl);

    await _updateIndexFromNfoAndArtwork({
      knex: this.knexVideo,
      row,
      baseDir: dirPath,
      searchDir,
      nfoPath,
      videoBaseName: isDiscFolderMovie ? '' : baseName,
      onlyVideoBase: false,
      seasonNumber: 0,
    });

    Logger.info(`✅ JAV fallback matched: ${meta.dvdid || ''} (${meta.source || ''}) <- ${filename}`);
    return true;
  }

  /**
   * 手动指定番号刮削：「搜索影音信息」里选中日本片结果后点「应用」走这条。
   * 与自动路径共用 `_tryJavFallback`，区别只是番号由用户指定、且不受开关限制。
   */
  async _processMovieRowByDvdId(row, dvdId) {
    const dirPath = row && row.path ? String(row.path) : '';
    const filename = row && row.filename ? String(row.filename) : '';
    const id = String(dvdId || '').trim();
    if (!dirPath || !filename || !id) return false;
    const mediaType = row && row.media_type ? String(row.media_type).trim() : '';
    const isDiscFolderMovie = mediaType === 'bdmv' || mediaType === 'video_ts';
    const movieFolder = isDiscFolderMovie ? path.join(dirPath, filename) : '';
    return await this._tryJavFallback(
      row,
      { dirPath, filename, isDiscFolderMovie, movieFolder },
      id
    );
  }

  async getSeasonsUnderShow(showFolder) {
    const resolved = path.resolve(String(showFolder || ''));
    if (!resolved) return [];
    const rows = await this.knexVideo('video_index')
      .select('id', 'path', 'filename', 'media_type', 'is_file', 'nfo_get_state')
      .where({ path: resolved, is_file: 0, media_type: 'season', nfo_get_state: 0 })
      .orderBy('id', 'asc')
      .catch(() => []);
    return rows || [];
  }

  async getSeasonsWithPendingEpisodesUnderShow(showFolder) {
    const resolved = path.resolve(String(showFolder || ''));
    if (!resolved) return [];
    const prefix = resolved.endsWith(path.sep) ? resolved : `${resolved}${path.sep}`;

    const episodeFolders = await this.knexVideo('video_index')
      .distinct('path')
      .where({ is_file: 1, media_type: 'episod', nfo_get_state: 0 })
      .andWhere('path', 'like', `${prefix}%`)
      .catch(() => []);

    const seasonNames = new Set();
    for (const r of episodeFolders || []) {
      const episodeDir = r && r.path ? String(r.path) : '';
      if (!episodeDir) continue;
      const rel = path.relative(resolved, episodeDir);
      if (!rel || rel.startsWith('..')) continue;
      const first = rel.split(path.sep).filter(Boolean)[0] || '';
      if (first) seasonNames.add(first);
    }
    const names = Array.from(seasonNames);
    if (names.length === 0) return [];

    const rows = await this.knexVideo('video_index')
      .select('id', 'path', 'filename', 'media_type', 'is_file', 'nfo_get_state')
      .where({ path: resolved, is_file: 0, media_type: 'season' })
      .whereIn('filename', names)
      .orderBy('id', 'asc')
      .catch(() => []);
    return rows || [];
  }

  async getSeasonsNeedingWork(showFolder) {
    const list = [];
    const a = await this.getSeasonsUnderShow(showFolder);
    const b = await this.getSeasonsWithPendingEpisodesUnderShow(showFolder);
    for (const r of a || []) list.push(r);
    for (const r of b || []) list.push(r);
    const seen = new Set();
    const out = [];
    for (const r of list) {
      const id = r && r.id ? Number(r.id) : 0;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push(r);
    }
    out.sort((x, y) => Number(x.id || 0) - Number(y.id || 0));
    return out;
  }

  async getEpisodesUnderFolder(seasonFolder) {
    const resolved = path.resolve(String(seasonFolder || ''));
    if (!resolved) return [];
    const prefix = resolved.endsWith(path.sep) ? resolved : `${resolved}${path.sep}`;
    const rows = await this.knexVideo('video_index')
      .select('id', 'path', 'filename', 'media_type', 'is_file', 'nfo_get_state', 'duration')
      .where({ is_file: 1, nfo_get_state: 0 })
      .andWhere('media_type', 'in', ['episod'])
      .andWhere(qb => {
        qb.where('path', resolved).orWhere('path', 'like', `${prefix}%`);
      })
      .orderBy('id', 'asc')
      .catch(() => []);
    return rows || [];
  }

  async getEpisodesInFolder(folder) {
    const resolved = path.resolve(String(folder || ''));
    if (!resolved) return [];
    const rows = await this.knexVideo('video_index')
      .select('id', 'path', 'filename', 'media_type', 'is_file', 'nfo_get_state', 'duration')
      .where({ is_file: 1, nfo_get_state: 0, path: resolved })
      .andWhere('media_type', 'in', ['episod'])
      .orderBy('id', 'asc')
      .catch(() => []);
    return rows || [];
  }

  async processTvRow(row) {
    const parentDir = row && row.path ? String(row.path) : '';
    const folderName = row && row.filename ? String(row.filename) : '';
    if (!parentDir || !folderName) return false;

    if (FileUtil.shouldSkipIndexingFilename(folderName)) {
      await this.markSkipped(row);
      return true;
    }

    const showFolder = path.join(parentDir, folderName);
    try {
      const st = await fs.promises.stat(showFolder);
      if (!st.isDirectory()) return false;
    } catch (_) {
      return false;
    }

    const nfoPath = path.join(showFolder, 'tvshow.nfo');
    if (await hasValidNfo(nfoPath, 'tvshow')) {
      const parsed = await readAndParseNfo(nfoPath);
      const tmdbId = parsed && parsed.tmdbId ? Number(parsed.tmdbId) : 0;
      if (tmdbId) {
        await _updateIndexFromNfoAndArtwork({
          knex: this.knexVideo,
          row,
          baseDir: parentDir,
          searchDir: showFolder,
          nfoPath,
          onlyVideoBase: false,
          seasonNumber: 0,
        });

        const seasons = await this.getSeasonsNeedingWork(showFolder);
        for (const sRow of seasons) {
          await this.processSeasonRow({ tvId: tmdbId, showFolder, showParentDir: parentDir, seasonRow: sRow });
        }

        const episodesInShowFolder = await this.getEpisodesInFolder(showFolder);
        if (episodesInShowFolder && episodesInShowFolder.length > 0) {
          const seasonDetails = await this.tmdb.getSeasonDetails(tmdbId, 1).catch(() => null);
          const episodeDetailsByNumber = new Map();
          const episodes = seasonDetails && Array.isArray(seasonDetails.episodes) ? seasonDetails.episodes : [];
          for (const e of episodes) {
            const en = e && e.episode_number ? Number(e.episode_number) : 0;
            if (en > 0) episodeDetailsByNumber.set(en, e);
          }
          for (const eRow of episodesInShowFolder) {
            const filename = eRow && eRow.filename ? String(eRow.filename) : '';
            const parsedEp = parseEpisodeFromName(filename);
            const episodeNumber = parsedEp && parsedEp.episode ? Number(parsedEp.episode) : 0;
            const preFetched = episodeNumber > 0 ? episodeDetailsByNumber.get(episodeNumber) : null;
            await this.processEpisodeRow({ tvId: tmdbId, seasonNumber: 1, episodeRow: eRow, episodeDetails: preFetched });
          }
        }

        return true;
      }
    }

    const preferTitle = (row.nfo_name ? String(row.nfo_name) : '').trim();
    const fallbackTitle = normalizeNameForNfoGuess(folderName) || folderName;
    const rawTitle = preferTitle || fallbackTitle;

    const attempts = _buildQueryAttemptsFromText(rawTitle);
    if (attempts.length === 0) {
      const q = _cleanSearchText(rawTitle);
      if (q) attempts.push({ query: q, year: 0 });
    }

    let tmdbId = 0;
    for (const a of attempts) {
      const q = a && a.query ? String(a.query) : '';
      if (!q) continue;
      const results = await this.tmdb.searchTv({ query: q });
      const picked = results && results[0] ? results[0] : null;
      const id = picked && picked.id ? Number(picked.id) : 0;
      if (id) {
        tmdbId = id;
        break;
      }
    }
    if (!tmdbId) return false;

    const details = await this.tmdb.getTvDetails(tmdbId);
    if (!details) return false;

    const nfoData = _mapTvToNfo({ client: this.tmdb, tv: details });
    await writeTextIfChanged(nfoPath, buildTvShowNfo(nfoData));

    if (details.poster_path) await _ensureDownloaded(this.tmdb, showFolder, 'poster.jpg', details.poster_path);
    const fanartPath = details.backdrop_path || _pickBackdropPathFromImages(details.images);
    if (fanartPath) await _ensureDownloaded(this.tmdb, showFolder, 'fanart.jpg', fanartPath);
    const logo = _pickLogoPathFromImages(details.images);
    if (logo) await _ensureDownloadedPng(this.tmdb, showFolder, 'logo.png', logo);

    // 演员头像：刮削时一并下载（详情页直接命中缓存）。
    await _downloadPeopleAvatars(nfoData.actors, this.proxyUrl || '');

    await _updateIndexFromNfoAndArtwork({
      knex: this.knexVideo,
      row,
      baseDir: parentDir,
      searchDir: showFolder,
      nfoPath,
      onlyVideoBase: false,
      seasonNumber: 0,
    });

    const seasons = await this.getSeasonsNeedingWork(showFolder);
    for (const sRow of seasons) {
      await this.processSeasonRow({ tvId: tmdbId, showFolder, showParentDir: parentDir, seasonRow: sRow });
    }

    const episodesInShowFolder = await this.getEpisodesInFolder(showFolder);
    if (episodesInShowFolder && episodesInShowFolder.length > 0) {
      const seasonDetails = await this.tmdb.getSeasonDetails(tmdbId, 1).catch(() => null);
      const episodeDetailsByNumber = new Map();
      const episodes = seasonDetails && Array.isArray(seasonDetails.episodes) ? seasonDetails.episodes : [];
      for (const e of episodes) {
        const en = e && e.episode_number ? Number(e.episode_number) : 0;
        if (en > 0) episodeDetailsByNumber.set(en, e);
      }
      for (const eRow of episodesInShowFolder) {
        const filename = eRow && eRow.filename ? String(eRow.filename) : '';
        const parsedEp = parseEpisodeFromName(filename);
        const episodeNumber = parsedEp && parsedEp.episode ? Number(parsedEp.episode) : 0;
        const preFetched = episodeNumber > 0 ? episodeDetailsByNumber.get(episodeNumber) : null;
        await this.processEpisodeRow({ tvId: tmdbId, seasonNumber: 1, episodeRow: eRow, episodeDetails: preFetched });
      }
    }

    return true;
  }

  async processSeasonRow({ tvId, showFolder, showParentDir, seasonRow }) {
    const seasonName = seasonRow && seasonRow.filename ? String(seasonRow.filename) : '';
    const seasonFolder = path.join(showFolder, seasonName);
    const seasonNumber = parseSeasonNumberFromName(seasonName);
    if (!seasonNumber) return false;
    try {
      const st = await fs.promises.stat(seasonFolder);
      if (!st.isDirectory()) return false;
    } catch (_) {
      return false;
    }

    const nfoPath = path.join(seasonFolder, 'season.nfo');
    const hasSeasonNfo = await hasValidNfo(nfoPath, 'season');

    let seasonDetails = null;
    if (hasSeasonNfo) {
      await _updateIndexFromNfoAndArtwork({
        knex: this.knexVideo,
        row: seasonRow,
        baseDir: showFolder,
        searchDir: seasonFolder,
        nfoPath,
        onlyVideoBase: false,
        seasonNumber,
      });
      seasonDetails = await this.tmdb.getSeasonDetails(tvId, seasonNumber).catch(() => null);
    } else {
      seasonDetails = await this.tmdb.getSeasonDetails(tvId, seasonNumber);
      if (!seasonDetails) return false;

      const nfoData = _mapSeasonToNfo({ client: this.tmdb, tvId: String(tvId), season: seasonDetails });
      await writeTextIfChanged(nfoPath, buildSeasonNfo(nfoData));

      if (seasonDetails.poster_path) await _ensureDownloaded(this.tmdb, seasonFolder, 'poster.jpg', seasonDetails.poster_path);

      await _updateIndexFromNfoAndArtwork({
        knex: this.knexVideo,
        row: seasonRow,
        baseDir: showFolder,
        searchDir: seasonFolder,
        nfoPath,
        onlyVideoBase: false,
        seasonNumber,
      });
    }

    const episodeDetailsByNumber = new Map();
    const episodeList = seasonDetails && Array.isArray(seasonDetails.episodes) ? seasonDetails.episodes : [];
    for (const e of episodeList) {
      const en = e && e.episode_number ? Number(e.episode_number) : 0;
      if (en > 0) episodeDetailsByNumber.set(en, e);
    }

    const episodes = await this.getEpisodesUnderFolder(seasonFolder);
    for (const eRow of episodes) {
      const filename = eRow && eRow.filename ? String(eRow.filename) : '';
      const parsedEp = parseEpisodeFromName(filename);
      const episodeNumber = parsedEp && parsedEp.episode ? Number(parsedEp.episode) : 0;
      const seasonFromName = parsedEp && parsedEp.season ? Number(parsedEp.season) : 0;
      const sn = seasonFromName || Number(seasonNumber || 0) || 1;
      const preFetched = sn === seasonNumber && episodeNumber > 0 ? episodeDetailsByNumber.get(episodeNumber) : null;
      await this.processEpisodeRow({ tvId, seasonNumber, episodeRow: eRow, episodeDetails: preFetched });
    }

    return true;
  }

  async processEpisodeRow({ tvId, seasonNumber, episodeRow, episodeDetails }) {
    const dirPath = episodeRow && episodeRow.path ? String(episodeRow.path) : '';
    const filename = episodeRow && episodeRow.filename ? String(episodeRow.filename) : '';
    if (!dirPath || !filename) return false;

    if (FileUtil.shouldSkipIndexingFilename(filename) || _hasSkipNameHint(path.parse(filename).name) || _shouldSkipByDurationSeconds(episodeRow && episodeRow.duration)) {
      await this.markSkipped(episodeRow);
      return true;
    }

    const full = path.join(dirPath, filename);
    try {
      const st = await fs.promises.stat(full);
      if (!st.isFile()) return false;
    } catch (_) {
      return false;
    }

    let ep = parseEpisodeFromName(filename);
    const episodeNumber = ep && ep.episode ? Number(ep.episode) : 0;
    const seasonFromName = ep && ep.season ? Number(ep.season) : 0;
    const sn = seasonFromName || Number(seasonNumber || 0) || 1;
    if (!sn || !episodeNumber) return false;

    const preFetched = episodeDetails && typeof episodeDetails === 'object' ? episodeDetails : null;
    const preSeason = preFetched && preFetched.season_number ? Number(preFetched.season_number) : 0;
    const preEpisode = preFetched && preFetched.episode_number ? Number(preFetched.episode_number) : 0;
    const details = preFetched && preSeason === sn && preEpisode === episodeNumber ? preFetched : await this.tmdb.getEpisodeDetails(tvId, sn, episodeNumber);
    if (!details) return false;

    const nfoData = _mapEpisodeToNfo({ client: this.tmdb, episode: details });
    const baseName = path.parse(filename).name;
    const nfoPath = path.join(dirPath, `${baseName}.nfo`);
    await writeTextIfChanged(nfoPath, buildEpisodeNfo(nfoData));

    if (details.still_path) {
      await _ensureDownloadedJpeg(this.tmdb, dirPath, `${baseName}.jpg`, details.still_path);
    }

    await _updateIndexFromNfoAndArtwork({
      knex: this.knexVideo,
      row: episodeRow,
      baseDir: dirPath,
      searchDir: dirPath,
      nfoPath,
      videoBaseName: baseName,
      onlyVideoBase: true,
      seasonNumber: 0,
    });

    return true;
  }

  async _processMovieRowByTmdbId(row, tmdbId) {
    const dirPath = row && row.path ? String(row.path) : '';
    const filename = row && row.filename ? String(row.filename) : '';
    if (!dirPath || !filename) return false;
    const mediaType = row && row.media_type ? String(row.media_type).trim() : '';
    const isDiscFolderMovie = mediaType === 'bdmv' || mediaType === 'video_ts';
    const movieFolder = isDiscFolderMovie ? path.join(dirPath, filename) : '';

    if (FileUtil.shouldSkipIndexingFilename(filename) || _hasSkipNameHint(path.parse(filename).name) || _shouldSkipByDurationSeconds(row && row.duration)) {
      await this.markSkipped(row);
      return true;
    }

    try {
      const st = await fs.promises.stat(isDiscFolderMovie ? movieFolder : path.join(dirPath, filename));
      if (isDiscFolderMovie ? !st.isDirectory() : !st.isFile()) return false;
    } catch (_) {
      return false;
    }

    const details = await this.tmdb.getMovieDetails(tmdbId);
    if (!details) return false;

    const nfoData = _mapMovieToNfo({ client: this.tmdb, movie: details });
    const baseName = path.parse(filename).name;
    const nfoPath = isDiscFolderMovie ? path.join(movieFolder, 'movie.nfo') : path.join(dirPath, `${baseName}.nfo`);
    await writeTextIfChanged(nfoPath, buildMovieNfo(nfoData));

    if (details.poster_path) await _ensureDownloadedJpeg(this.tmdb, isDiscFolderMovie ? movieFolder : dirPath, isDiscFolderMovie ? 'poster.jpg' : `${baseName}-post.jpg`, details.poster_path);
    const fanartPath = details.backdrop_path || _pickBackdropPathFromImages(details.images);
    if (fanartPath) await _ensureDownloadedJpeg(this.tmdb, isDiscFolderMovie ? movieFolder : dirPath, isDiscFolderMovie ? 'fanart.jpg' : `${baseName}-fanart.jpg`, fanartPath);
    const logo = _pickLogoPathFromImages(details.images);
    if (logo) {
      await _ensureDownloadedPng(this.tmdb, isDiscFolderMovie ? movieFolder : dirPath, isDiscFolderMovie ? 'logo.png' : `${baseName}-logo.png`, logo);
      const legacy = path.join(isDiscFolderMovie ? movieFolder : dirPath, isDiscFolderMovie ? 'logo.jpg' : `${baseName}-logo.jpg`);
      try {
        if (fs.existsSync(legacy) && fs.statSync(legacy).isFile()) fs.unlinkSync(legacy);
      } catch (_) {}
    }

    // 演员头像：刮削时一并下载（详情页直接命中缓存）。
    await _downloadPeopleAvatars(nfoData.actors, this.proxyUrl || '');

    await _updateIndexFromNfoAndArtwork({
      knex: this.knexVideo,
      row,
      baseDir: dirPath,
      searchDir: isDiscFolderMovie ? movieFolder : dirPath,
      nfoPath,
      videoBaseName: isDiscFolderMovie ? '' : baseName,
      onlyVideoBase: false,
      seasonNumber: 0,
    });

    return true;
  }

  async _processTvRowByTmdbId(row, tvId) {
    const parentDir = row && row.path ? String(row.path) : '';
    const folderName = row && row.filename ? String(row.filename) : '';
    if (!parentDir || !folderName) return false;

    if (FileUtil.shouldSkipIndexingFilename(folderName)) {
      await this.markSkipped(row);
      return true;
    }

    const showFolder = path.join(parentDir, folderName);
    try {
      const st = await fs.promises.stat(showFolder);
      if (!st.isDirectory()) return false;
    } catch (_) {
      return false;
    }

    const details = await this.tmdb.getTvDetails(tvId);
    if (!details) return false;

    const nfoPath = path.join(showFolder, 'tvshow.nfo');
    const nfoData = _mapTvToNfo({ client: this.tmdb, tv: details });
    await writeTextIfChanged(nfoPath, buildTvShowNfo(nfoData));

    if (details.poster_path) await _ensureDownloaded(this.tmdb, showFolder, 'poster.jpg', details.poster_path);
    const fanartPath = details.backdrop_path || _pickBackdropPathFromImages(details.images);
    if (fanartPath) await _ensureDownloaded(this.tmdb, showFolder, 'fanart.jpg', fanartPath);
    const logo = _pickLogoPathFromImages(details.images);
    if (logo) await _ensureDownloadedPng(this.tmdb, showFolder, 'logo.png', logo);

    // 演员头像：刮削时一并下载（详情页直接命中缓存）。
    await _downloadPeopleAvatars(nfoData.actors, this.proxyUrl || '');

    await _updateIndexFromNfoAndArtwork({
      knex: this.knexVideo,
      row,
      baseDir: parentDir,
      searchDir: showFolder,
      nfoPath,
      onlyVideoBase: false,
      seasonNumber: 0,
    });

    const seasons = await this.getSeasonsNeedingWork(showFolder);
    for (const sRow of seasons) {
      await this.processSeasonRow({ tvId, showFolder, showParentDir: parentDir, seasonRow: sRow });
    }

    return true;
  }

  async _resolveTvIdFromShowFolder(showFolder) {
    const resolved = path.resolve(String(showFolder || ''));
    if (!resolved) return 0;
    const nfoPath = path.join(resolved, 'tvshow.nfo');
    if (!(await hasValidNfo(nfoPath, 'tvshow'))) return 0;
    const parsed = await readAndParseNfo(nfoPath);
    const tvId = parsed && parsed.tmdbId ? Number(parsed.tmdbId) : 0;
    return tvId > 0 ? tvId : 0;
  }

  async scrapeByIndexId({ indexId, tmdbId = 0, dvdId = '' } = {}) {
    const id = Number(indexId || 0) || 0;
    if (!id) return { ok: false };
    const row = await this.knexVideo('video_index')
      .where({ id })
      .first('id', 'path', 'filename', 'media_type', 'is_file', 'nfo_name', 'nfo_get_state', 'duration')
      .catch(() => null);
    if (!row) return { ok: false };

    const mediaType = row.media_type ? String(row.media_type).trim() : '';
    const override = Number(tmdbId || 0) || 0;

    try {
      // ⭐ 手动指定了番号（用户在日本片搜索结果里选的）：movie / bdmv / video_ts / episod
      //    都直接按番号刮，绕开 TMDB 那条路。
      const javDvdId = String(dvdId || '').trim();
      if (javDvdId && (mediaType === 'movie' || mediaType === 'bdmv' || mediaType === 'video_ts' || mediaType === 'episod')) {
        const done = await this._processMovieRowByDvdId(row, javDvdId);
        if (!done) await this.markFailed(row);
        return { ok: !!done };
      }

      if (mediaType === 'movie' || mediaType === 'bdmv' || mediaType === 'video_ts') {
        const done = override ? await this._processMovieRowByTmdbId(row, override) : await this.processMovieRow(row);
        if (!done) await this.markFailed(row);
        return { ok: !!done };
      }
      if (mediaType === 'tv') {
        const done = override ? await this._processTvRowByTmdbId(row, override) : await this.processTvRow(row);
        if (!done) await this.markFailed(row);
        return { ok: !!done };
      }
      if (mediaType === 'season') {
        const showFolder = row.path ? String(row.path) : '';
        const seasonNumber = parseSeasonNumberFromName(row.filename);
        if (!showFolder || !seasonNumber) return { ok: false };
        const tvId = override || (await this._resolveTvIdFromShowFolder(showFolder));
        if (!tvId) return { ok: false };
        const done = await this.processSeasonRow({
          tvId,
          showFolder,
          showParentDir: path.dirname(showFolder),
          seasonRow: row,
        });
        if (!done) await this.markFailed(row);
        return { ok: !!done };
      }
      if (mediaType === 'episod') {
        const dirPath = row.path ? String(row.path) : '';
        if (!dirPath) return { ok: false };
        const seasonNumber = parseSeasonNumberFromName(path.basename(dirPath));
        let tvId = override;
        if (!tvId) {
          let cursor = path.resolve(dirPath);
          let found = '';
          for (let i = 0; i < 6; i += 1) {
            const candidate = path.join(cursor, 'tvshow.nfo');
            if (fs.existsSync(candidate)) {
              found = cursor;
              break;
            }
            const next = path.dirname(cursor);
            if (!next || next === cursor) break;
            cursor = next;
          }
          tvId = found ? await this._resolveTvIdFromShowFolder(found) : 0;
        }
        if (!tvId) return { ok: false };
        const done = await this.processEpisodeRow({ tvId, seasonNumber, episodeRow: row });
        if (!done) await this.markFailed(row);
        return { ok: !!done };
      }
      return { ok: false };
    } catch (err) {
      Logger.error('❌ scrapeByIndexId failed', err && err.message ? err.message : err);
      await this.markFailed(row);
      return { ok: false };
    }
  }

  async runOnce({ limit = 5 } = {}) {
    const roots = await this.getPendingRoots(limit);
    if (!roots || roots.length === 0) return { processed: 0, ok: 0 };
    let ok = 0;
    let processed = 0;
    for (const r of roots) {
      console.log('开始获取nfo信息', r.path, r.filename);
      processed += 1;
      try {
        if (r.media_type === 'movie' || r.media_type === 'bdmv' || r.media_type === 'video_ts') {
          const done = await this.processMovieRow(r);
          if (done) ok += 1;
          if (!done) await this.markFailed(r);
        } else if (r.media_type === 'tv') {
          const done = await this.processTvRow(r);
          if (done) ok += 1;
          if (!done) await this.markFailed(r);
        }
      } catch (err) {
        Logger.error('❌ nfoFetch handle failed', err && err.message ? err.message : err);
        await this.markFailed(r);
      }
    }
    return { processed, ok };
  }
}

module.exports = {
  NfoFetchRunner,
};
