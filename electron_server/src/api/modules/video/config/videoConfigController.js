const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const ResponseUtil = require('../../../apiUtils/responseUtil');
const tableConfig = require('../../../../db/table/tableConfig');
const dbUtil = require('../../../../db/dbUtil');
const knexUtil = require('../../../../db/knexUtil');
const userUtil = require('../../../../utils/userUtil');
const nascabAccountUtil = require('../../service/utils/nascabAccountUtil');
const { TmdbClient } = require('../../../../workers/videoIndex/nfoFetchWorker/tmdbClient');
const config = require('../../../../config/config');
const {
  buildAvailableHwAccelList,
  combineHwAccelEntryToConfig,
  findAvailableHwAccelEntry,
  getHwAccelGroupMeta,
  normalizeAvailableHwAccelList,
  pickEffectiveHwAccelConfig,
} = require('../../../../utils/transcodeHwAccelUtil');
// 默认播放画质白名单。必须与客户端 `flutter_client/lib/modules/video/base/video_utils/play_quality.dart`
// 的 `PlayQuality.options` 保持一致（客户端那边是唯一真源，改档位要两边同一次改完）：
// 键格式为 `<分辨率>_<码率>`，客户端按 `_` 拆分后换算成 transcode 接口的 width / bitrate。
// ⭐ 码率档位按输出编码分组（2026-10-15）：H.265/AV1 同码率可比 H.264 支撑更高分辨率
// （H.265 约省 40% 码率、AV1 更省），因此额外提供 4K 低码率与 1440p 系列档位。
const PLAY_QUALITY_OPTIONS_H264 = [
  'original',
  '4k_20m',
  '4k_15m',
  '4k_10m',
  '1080p_8m',
  '1080p_5m',
  '1080p_3m',
  '1080p_2m',
  '720p_3m',
  '720p_2m',
  '720p_1m',
  '480p_1m',
];
const PLAY_QUALITY_OPTIONS_HEVC = [
  'original',
  '4k_20m',
  '4k_15m',
  '4k_10m',
  '4k_6m',
  '1440p_10m',
  '1440p_8m',
  '1440p_5m',
  '1440p_3m',
  '1080p_5m',
  '1080p_3m',
  '1080p_2m',
  '720p_2m',
  '720p_1m',
  '480p_1m',
];
// 白名单用两套并集（校验入库默认值），选项按输出编码取对应一套。
const PLAY_QUALITY_OPTIONS = Array.from(new Set(PLAY_QUALITY_OPTIONS_H264.concat(PLAY_QUALITY_OPTIONS_HEVC)));

function playQualityOptionsForCodec(codec) {
  const v = String(codec === undefined || codec === null ? '' : codec).trim().toLowerCase();
  return (v === 'h265' || v === 'hevc' || v === 'av1')
    ? PLAY_QUALITY_OPTIONS_HEVC
    : PLAY_QUALITY_OPTIONS_H264;
}

// 配置键（通用配置 uid=0）
const KEY_VIDEO_DEFAULT_PLAY_QUALITY = 'videoDefaultPlayQuality';
// 音频降混：开启后每次转码都把非双声道的音轨降混成双声道（默认关闭，保持源声道数）
const KEY_VIDEO_AUDIO_DOWNMIX = 'videoAudioDownmix';
// ⭐ 输出视频编码方式（2026-10-13）：h264 / h265 / av1，默认 h264（兼容性最好）。
// 同样按 `<base>.<clientType>` + uid 隔离，与默认播放画质/音频降混共用一套口径。
const KEY_VIDEO_DEFAULT_VIDEO_CODEC = 'videoDefaultVideoCodec';
const VIDEO_CODEC_OPTIONS = ['h264', 'h265', 'av1'];

// ⭐⭐「按端隔离」的播放设置（2026-10-12）
//
// 需求：安卓端设了默认画质，不能把 web 端一起改掉。做法是把配置键按**客户端类型**分叉：
//   videoDefaultPlayQuality.android / .web / .ios / .desktop
// uid 维度沿用 tableConfig：
//   - 管理员写入 uid=0 ⇒ 该端对所有用户生效（作为全局默认）；
//   - 普通用户写入自己的 uid ⇒ 只覆盖自己。
// 读取按「窄 → 宽」逐级回退，保证老数据（无后缀的旧键 videoDefaultPlayQuality）
// 以及对端未设置时都能拿到合理值。
const CLIENT_TYPE_KEYS = ['web', 'android', 'ios', 'desktop'];

function _normalizeClientType(raw) {
  const v = String(raw === undefined || raw === null ? '' : raw).trim().toLowerCase();
  if (!v) return '';
  if (CLIENT_TYPE_KEYS.includes(v)) return v;
  // 兼容各种平台自称
  if (v === 'windows' || v === 'win' || v === 'mac' || v === 'macos' || v === 'linux' || v === 'pc') {
    return 'desktop';
  }
  if (v === 'harmony' || v === 'harmonyos') return 'android';
  return '';
}

// 取请求里的客户端类型：优先 body，其次自定义头
function _clientTypeOf(req) {
  const body = (req && req.body) || {};
  const fromBody = body.clientType ?? body.client_type;
  const fromHeader = req && typeof req.get === 'function' ? req.get('X-Client-Type') : '';
  return _normalizeClientType(fromBody !== undefined && fromBody !== null && fromBody !== ''
    ? fromBody
    : fromHeader);
}

function _scopedKey(baseKey, clientType) {
  return clientType ? `${baseKey}.${clientType}` : baseKey;
}

// 逐级回退读：本用户本端 → 本用户无端(旧数据) → 全局本端 → 全局无端(旧数据)
async function _readScopedConfig(baseKey, uid, clientType) {
  const chain = [];
  if (clientType) chain.push([_scopedKey(baseKey, clientType), uid]);
  chain.push([baseKey, uid]);
  if (uid !== 0 && clientType) chain.push([_scopedKey(baseKey, clientType), 0]);
  if (uid !== 0) chain.push([baseKey, 0]);
  for (const [key, u] of chain) {
    const v = await tableConfig.getConfigByKey(key, u);
    if (v !== undefined && v !== null && String(v).trim() !== '') return v;
  }
  return null;
}

function _parseBoolTo01(v) {
  return v === 1 || v === '1' || v === true ? 1 : 0;
}

// ⭐ 默认字幕语言（2026-10-15）：播放时按该语言自动匹配字幕。
//   ''     = 自动（沿用旧行为，取第一条字幕）
//   'none' = 不自动加载字幕
//   其余为规范语言码，与客户端 subtitle_language.dart 保持一致
const SUBTITLE_DEFAULT_LANGUAGE_OPTIONS = ['', 'none', 'zh-CN', 'zh-TW', 'en', 'ja', 'ko'];
const KEY_SUBTITLE_DEFAULT_LANGUAGE = 'subtitleDefaultLanguage';

function _normalizeSubtitleLanguage(raw) {
  const v = String(raw === undefined || raw === null ? '' : raw).trim();
  if (!v) return '';
  // 兼容别名
  const alias = {
    'zh': 'zh-CN', 'chs': 'zh-CN', 'cn': 'zh-CN', 'zh-cn': 'zh-CN', 'zh-hans': 'zh-CN',
    'cht': 'zh-TW', 'zh-tw': 'zh-TW', 'zh-hk': 'zh-TW', 'zh-hant': 'zh-TW',
    'eng': 'en', 'jpn': 'ja', 'kor': 'ko',
    'off': 'none', 'no': 'none', 'disable': 'none',
  };
  const low = v.toLowerCase();
  if (alias[low]) return alias[low];
  return SUBTITLE_DEFAULT_LANGUAGE_OPTIONS.includes(v) ? v : '';
}

// 归一化默认播放画质：空/非法一律回退 'original'（原画）。
function _normalizePlayQuality(raw) {
  const v = raw === undefined || raw === null ? '' : String(raw).trim();
  if (!v) return 'original';
  return PLAY_QUALITY_OPTIONS.includes(v) ? v : '';
}

// 归一化输出视频编码：返回 'h264' | 'h265' | 'av1' | ''（空串＝非法）
function _normalizeVideoCodec(raw) {
  const v = raw === undefined || raw === null ? '' : String(raw).trim().toLowerCase();
  if (!v) return '';
  if (v === 'h265' || v === 'hevc' || v === 'h.265') return 'h265';
  if (v === 'av1') return 'av1';
  if (v === 'h264' || v === 'avc' || v === 'h.264') return 'h264';
  return '';
}

// 探测 ffmpeg 自带的软件编码器（进程内缓存一次；ffmpeg 二进制运行期不会变）。
let _softCodecCache = null;
function _probeFfmpegSoftEncoders() {
  if (_softCodecCache) return Promise.resolve(_softCodecCache);
  return new Promise(resolve => {
    let ffmpegPath = '';
    try {
      ffmpegPath = require('../../../../libsPath/ffmpegPath').path || '';
    } catch (_) {
      ffmpegPath = '';
    }
    const done = result => {
      _softCodecCache = result;
      resolve(result);
    };
    if (!ffmpegPath) {
      // 探测不到二进制时保守假设三编码软编都在（Jellyfin ffmpeg 默认全带）
      return done({ h264: true, h265: true, av1: true });
    }
    try {
      execFile(
        ffmpegPath,
        ['-hide_banner', '-encoders'],
        { timeout: 20000, maxBuffer: 8 * 1024 * 1024 },
        (err, stdout) => {
          const out = String(stdout || '');
          const has = name => new RegExp('\\b' + name + '\\b').test(out);
          done({ h264: has('libx264'), h265: has('libx265'), av1: has('libsvtav1') });
        }
      );
    } catch (_) {
      done({ h264: true, h265: false, av1: false });
    }
  });
}

// 汇总「服务端是否支持某编码」：软编（ffmpeg 自带）+ 硬编（转码硬件探测缓存）。
async function _getServerCodecCapability() {
  const soft = await _probeFfmpegSoftEncoders();
  const hw = { h264: false, h265: false, av1: false };
  try {
    const selectedRaw = await tableConfig.getConfigByKey('transcode_hwaccel_selected');
    const selected = selectedRaw ? JSON.parse(String(selectedRaw)) : null;
    const profiles =
      selected && selected.profiles && typeof selected.profiles === 'object' ? selected.profiles : null;
    if (profiles) {
      hw.h264 = !!(profiles.h264 && profiles.h264.encoder);
      hw.h265 = !!(profiles.h265 && profiles.h265.encoder);
      hw.av1 = !!(profiles.av1 && profiles.av1.encoder);
    }
  } catch (_) {}
  const build = key => ({ soft: !!soft[key], hw: !!hw[key], supported: !!(soft[key] || hw[key]) });
  return { h264: build('h264'), h265: build('h265'), av1: build('av1') };
}

function _parseText(v) {
  const s = v === undefined || v === null ? '' : String(v).trim();
  return s;
}

function _safeJsonParse(raw) {
  if (!raw) return null;
  const v = String(raw).trim();
  if (!v) return null;
  try {
    return JSON.parse(v);
  } catch (_) {
    return null;
  }
}

async function _repairTranscodeHwAccelConfigIfNeeded() {
  const [reportRaw, availableRaw, selectedRaw, preferredRaw] = await Promise.all([
    tableConfig.getConfigByKey('transcode_hwaccel_report'),
    tableConfig.getConfigByKey('transcode_hwaccel_available'),
    tableConfig.getConfigByKey('transcode_hwaccel_selected'),
    tableConfig.getConfigByKey('transcode_hwaccel_preferred'),
  ]);

  const report = _safeJsonParse(reportRaw);
  const candidates = report && Array.isArray(report.candidates) ? report.candidates : [];
  if (candidates.length === 0) return;

  const existingAvailable = normalizeAvailableHwAccelList(availableRaw);
  const derivedAvailable =
    existingAvailable.length > 0
      ? existingAvailable
      : normalizeAvailableHwAccelList(report && report.available ? report.available : null);
  const available = derivedAvailable.length > 0 ? derivedAvailable : buildAvailableHwAccelList(candidates);

  const savePairs = [];
  if (existingAvailable.length === 0 && available.length > 0) {
    savePairs.push(tableConfig.setConfigByKey('transcode_hwaccel_available', JSON.stringify(available)));
  }

  const preferredKey = preferredRaw ? String(preferredRaw).trim() : '';
  const preferredExists = preferredKey ? !!findAvailableHwAccelEntry(available, preferredKey) : false;
  const nextPreferredKey = preferredExists ? preferredKey : '';
  if (nextPreferredKey !== preferredKey) {
    savePairs.push(tableConfig.setConfigByKey('transcode_hwaccel_preferred', nextPreferredKey));
  }

  const selectedParsed = _safeJsonParse(selectedRaw);
  const selectedHasKey =
    selectedParsed && typeof selectedParsed === 'object' && typeof selectedParsed.key === 'string' && selectedParsed.key.trim();
  if (!selectedHasKey) {
    const reportSelected = report && report.selected && typeof report.selected === 'object' ? report.selected : null;
    const profiles = reportSelected && reportSelected.profiles && typeof reportSelected.profiles === 'object' ? reportSelected.profiles : null;
    const baseProfile =
      (profiles && profiles.h264 && typeof profiles.h264 === 'object' ? profiles.h264 : null) ||
      (profiles && profiles.h265 && typeof profiles.h265 === 'object' ? profiles.h265 : null) ||
      reportSelected;
    if (baseProfile) {
      const groupMeta = getHwAccelGroupMeta(baseProfile);
      const entryKey = groupMeta && groupMeta.key ? String(groupMeta.key) : '';
      const entry = entryKey ? findAvailableHwAccelEntry(available, entryKey) : null;
      const nextSelected = entry ? combineHwAccelEntryToConfig(entry) : null;
      if (nextSelected) {
        if (profiles) {
          nextSelected.profiles = {
            h264: profiles.h264 && typeof profiles.h264 === 'object' ? profiles.h264 : null,
            h265: profiles.h265 && typeof profiles.h265 === 'object' ? profiles.h265 : null,
          };
        }
        savePairs.push(tableConfig.setConfigByKey('transcode_hwaccel_selected', JSON.stringify(nextSelected)));
      }
    }
  }

  if (savePairs.length > 0) {
    await Promise.all(savePairs);
  }
}

async function _testWritableDir(dirPath) {
  const raw = String(dirPath || '').trim();
  if (!raw) return { ok: true, resolved: '' };
  const resolved = path.resolve(raw);
  const safeFolderName = config.getTranscodeTempSafeFolderName();
  let st;
  try {
    st = await fs.promises.stat(resolved);
  } catch (_) {
    return { ok: false, code: 'video.TRANSCODE_TEMP_DIR_NOT_EXIST' };
  }
  if (!st || !st.isDirectory()) {
    return { ok: false, code: 'video.TRANSCODE_TEMP_DIR_NOT_DIR' };
  }
  try {
    await fs.promises.access(resolved, fs.constants.W_OK);
  } catch (_) {
    return { ok: false, code: 'video.TRANSCODE_TEMP_DIR_NOT_WRITABLE' };
  }

  const safeDir = path.join(resolved, safeFolderName);
  try {
    await fs.promises.mkdir(safeDir, { recursive: true });
    await fs.promises.access(safeDir, fs.constants.W_OK);
  } catch (_) {
    return { ok: false, code: 'video.TRANSCODE_TEMP_DIR_NOT_WRITABLE' };
  }

  const name = `.nascabos_write_test_${Date.now()}_${Math.random().toString(16).slice(2)}.tmp`;
  const p = path.join(safeDir, name);
  try {
    await fs.promises.writeFile(p, 'ok', 'utf8');
    await fs.promises.unlink(p);
  } catch (_) {
    try {
      await fs.promises.unlink(p);
    } catch (_) {}
    return { ok: false, code: 'video.TRANSCODE_TEMP_DIR_NOT_WRITABLE' };
  }
  return { ok: true, resolved };
}

function _normalizeProxyUrlString(proxyUrlStr) {
  const raw = String(proxyUrlStr || '').trim();
  if (!raw) return '';
  if (raw.includes('://')) return raw;
  return `http://${raw}`;
}

function _parseHttpProxyUrlOrEmpty(proxyUrlStr) {
  const normalized = _normalizeProxyUrlString(proxyUrlStr);
  if (!normalized) return '';
  let u;
  try {
    u = new URL(normalized);
  } catch (_) {
    return '';
  }
  const isHttpsProxy = u.protocol === 'https:';
  const isHttpProxy = u.protocol === 'http:';
  if (!isHttpsProxy && !isHttpProxy) return '';
  if (!u.hostname) return '';
  const port = Number(u.port || (isHttpsProxy ? 443 : 80)) || (isHttpsProxy ? 443 : 80);
  if (!port) return '';
  return normalized;
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

function _normalizeApiUrlString(apiUrlStr) {
  const raw = String(apiUrlStr || '').trim();
  if (!raw) return '';
  if (raw.includes('://')) return raw;
  return `https://${raw}`;
}

async function _resolveTmdbApiUrl() {
  const knex = knexUtil.getInstance(dbUtil.DB_PATHS.MAIN_DB);
  const fromDb = await nascabAccountUtil.getDecryptedConfigValue(knex, tableConfig, 'tmdbApiUrl');
  const apiUrl = fromDb ? _normalizeApiUrlString(fromDb) : '';
  if (apiUrl) return apiUrl;
  const defaults = config.getDefaultTmdbConfig();
  return defaults.tmdbApiUrl ? String(defaults.tmdbApiUrl).trim() : '';
}

async function _resolveTmdbToken(overrideToken = '') {
  const t = String(overrideToken || '').trim();
  if (t) return t;
  const knex = knexUtil.getInstance(dbUtil.DB_PATHS.MAIN_DB);
  const [fromUserToken, fromDefaultToken] = await Promise.all([
    nascabAccountUtil.getDecryptedConfigValue(knex, tableConfig, 'tmdbApiToken'),
    nascabAccountUtil.getDecryptedConfigValue(knex, tableConfig, 'tmdbApiTokenDefault'),
  ]);
  const userToken = fromUserToken ? String(fromUserToken).trim() : '';
  if (userToken) return userToken;
  const defaultToken = fromDefaultToken ? String(fromDefaultToken).trim() : '';
  if (defaultToken) return defaultToken;
  const defaults = config.getDefaultTmdbConfig();
  return defaults.tmdbApiToken ? String(defaults.tmdbApiToken).trim() : '';
}

async function _testTmdbConnection({ accessToken, proxyUrl }) {
  const apiUrl = await _resolveTmdbApiUrl();
  const apiToken = await _resolveTmdbToken(accessToken);
  console.log('[TMDB proxy test] apiUrl=', apiUrl ? `${apiUrl.slice(0, 50)}...` : '(empty)', 'proxyUrl=', proxyUrl ? `${proxyUrl.slice(0, 60)}...` : '(none)', 'hasToken=', !!apiToken);
  if (!apiToken) return false;
  const client = new TmdbClient({ apiUrl, apiToken, proxyUrl });
  try {
    await client.requestJson('/3/configuration/languages', null);
    return { ok: true, reason: '' };
  } catch (e) {
    console.log('[TMDB proxy test] request failed:', e && e.code, e && e.message);
    let reason = '';
    const statusCode = e && e.statusCode ? Number(e.statusCode) : 0;
    if (statusCode) {
      try {
        const json = e && e.body ? JSON.parse(String(e.body || '')) : null;
        const msg = json && json.status_message ? String(json.status_message) : '';
        reason = msg ? `HTTP ${statusCode} ${msg}` : `HTTP ${statusCode}`;
      } catch (_) {
        reason = `HTTP ${statusCode}`;
      }
    } else if (e && e.code) {
      reason = String(e.code);
      if (e.message) reason += ` ${String(e.message)}`;
    } else if (e && e.message) {
      reason = String(e.message);
    }
    reason = reason.trim();
    if (reason.length > 200) reason = reason.slice(0, 200);
    return { ok: false, reason };
  }
}

async function _loadTranscodeHwAccelState() {
  await _repairTranscodeHwAccelConfigIfNeeded();
  const [availableRaw, preferredRaw, selectedRaw] = await Promise.all([
    tableConfig.getConfigByKey('transcode_hwaccel_available'),
    tableConfig.getConfigByKey('transcode_hwaccel_preferred'),
    tableConfig.getConfigByKey('transcode_hwaccel_selected'),
  ]);
  const available = normalizeAvailableHwAccelList(availableRaw);
  const preferredKey = preferredRaw ? String(preferredRaw).trim() : '';
  const effective = pickEffectiveHwAccelConfig({
    availableList: available,
    preferredKey,
    autoSelected: selectedRaw ? _safeJsonParse(selectedRaw) : null,
  });
  return {
    available,
    preferredKey: findAvailableHwAccelEntry(available, preferredKey) ? preferredKey : '',
    effective,
  };
}

class VideoConfigController {
  async getTmdbConfig(req, res) {
    try {
      const knex = knexUtil.getInstance(dbUtil.DB_PATHS.MAIN_DB);
      // 远程默认 token（加密存储）不应返回给前端展示/回填
      // 兼容旧版本：若 token 曾被远程加密写入到 tmdbApiToken，也一并隐藏
      const [tokenRaw, tokenDec, proxyEnable, proxyUrl, language] = await Promise.all([
        tableConfig.getConfigByKey('tmdbApiToken'),
        nascabAccountUtil.getDecryptedConfigValue(knex, tableConfig, 'tmdbApiToken'),
        tableConfig.getConfigByKey('tmdbProxyEnable'),
        tableConfig.getConfigByKey('tmdbProxyUrl'),
        tableConfig.getConfigByKey('tmdbLanguage'),
      ]);
      const isEncryptedToken = tokenRaw ? String(tokenRaw).trim().startsWith('enc.') : false;
      const token = isEncryptedToken ? '' : tokenDec ? String(tokenDec) : '';

      return ResponseUtil.success(
        req,
        res,
        {
          accessToken: token ? String(token) : '',
          proxyEnable: proxyEnable === '1' || proxyEnable === 1 ? 1 : 0,
          proxyUrl: proxyUrl ? String(proxyUrl) : '',
          language: language ? String(language) : '',
        },
        'common.SUCCESS',
        200
      );
    } catch (_) {
      return ResponseUtil.error(req, res, 'common.ERROR', 500);
    }
  }

  async getTranscodeConfig(req, res) {
    try {
      const [tempDir, hwState] = await Promise.all([tableConfig.getConfigByKey('transcodeTempDir'), _loadTranscodeHwAccelState()]);
      return ResponseUtil.success(
        req,
        res,
        {
          tempDir: tempDir ? String(tempDir) : '',
          preferredHwDecoder: hwState.preferredKey,
          availableHwDecoders: hwState.available.map(item => ({
            key: item.key,
            label: item.label,
            kind: item.kind,
            codecs: item.codecs,
          })),
          effectiveHwDecoder: hwState.effective
            ? {
                key: hwState.effective.key || '',
                label: hwState.effective.displayName || hwState.effective.name || hwState.effective.encoder || '',
              }
            : null,
        },
        'common.SUCCESS',
        200
      );
    } catch (_) {
      return ResponseUtil.error(req, res, 'common.ERROR', 500);
    }
  }

  async setTmdbConfig(req, res) {
    try {
      const body = req.body || {};
      const accessToken = _parseText(body.accessToken ?? body.tmdbAccessToken ?? body.tmdb_access_token);
      const proxyEnable = _parseBoolTo01(body.proxyEnable ?? body.enableProxy ?? body.proxy_enable);
      const proxyUrlRaw = _parseText(body.proxyUrl ?? body.tmdbProxyUrl ?? body.proxy_url);
      const languageRaw = _parseText(body.language ?? body.tmdbLanguage ?? body.tmdb_language);
      const language = _normalizeToTmdbLanguage(languageRaw);

      // ⭐ 2026-10-12：影视设置里的代理开关已从界面移除，代理统一到「系统设置 → 网络代理」。
      //    所以只有请求**显式带了**代理字段时才去校验/写入，否则保持库里原样不动
      //    （既不会把用户以前的代理清空，也让 resolveMetadataProxyUrl 的兜底继续有效）。
      const hasProxyFields = ['proxyEnable', 'enableProxy', 'proxy_enable', 'proxyUrl', 'tmdbProxyUrl', 'proxy_url'].some(
        k => Object.prototype.hasOwnProperty.call(body, k)
      );

      if (languageRaw && !language) {
        return ResponseUtil.error(req, res, 'common.PARAM_ERROR', 400);
      }

      if (hasProxyFields) {
        const proxyUrl = proxyEnable === 1 ? _parseHttpProxyUrlOrEmpty(proxyUrlRaw) : '';
        if (proxyEnable === 1) {
          console.log('[setTmdbConfig] proxyEnable=1 proxyUrlRaw=', proxyUrlRaw, 'parsed proxyUrl=', proxyUrl || '(empty)');
        }
        if (proxyEnable === 1 && !proxyUrl) {
          return ResponseUtil.error(req, res, 'video.TMDB_PROXY_REQUIRED', 400);
        }
        if (proxyEnable === 1 && proxyUrlRaw && !proxyUrl) {
          return ResponseUtil.error(req, res, 'video.TMDB_PROXY_INVALID', 400);
        }

        if (proxyEnable === 1) {
          const test = await _testTmdbConnection({ accessToken, proxyUrl });
          if (!test || !test.ok) {
            const reason = test && test.reason ? String(test.reason) : '';
            if (reason) {
              return ResponseUtil.errorWithArgs(req, res, 'video.TMDB_PROXY_TEST_FAILED_DETAIL', [reason], 400);
            }
            return ResponseUtil.error(req, res, 'video.TMDB_PROXY_TEST_FAILED', 400);
          }
        }

        const results = await Promise.all([
          tableConfig.setConfigByKey('tmdbApiToken', accessToken),
          tableConfig.setConfigByKey('tmdbProxyEnable', String(proxyEnable)),
          tableConfig.setConfigByKey('tmdbProxyUrl', proxyEnable === 1 ? proxyUrl : ''),
          tableConfig.setConfigByKey('tmdbLanguage', language),
        ]);
        if (!results.every(Boolean)) return ResponseUtil.error(req, res, 'common.ERROR', 500);
        return ResponseUtil.success(
          req,
          res,
          { accessToken, proxyEnable, proxyUrl: proxyEnable === 1 ? proxyUrl : '', language },
          'video.TMDB_CONFIG_SAVED',
          200
        );
      }

      const results = await Promise.all([
        tableConfig.setConfigByKey('tmdbApiToken', accessToken),
        tableConfig.setConfigByKey('tmdbLanguage', language),
      ]);
      if (!results.every(Boolean)) return ResponseUtil.error(req, res, 'common.ERROR', 500);

      // 回显当前库里生效的代理，方便前端提示「代理由系统设置统一管理」
      const [proxyEnableDb, proxyUrlDb] = await Promise.all([
        tableConfig.getConfigByKey('tmdbProxyEnable'),
        tableConfig.getConfigByKey('tmdbProxyUrl'),
      ]);
      return ResponseUtil.success(
        req,
        res,
        {
          accessToken,
          language,
          proxyEnable: _parseBoolTo01(proxyEnableDb),
          proxyUrl: proxyUrlDb ? String(proxyUrlDb).trim() : '',
          proxyManagedGlobally: true,
        },
        'video.TMDB_CONFIG_SAVED',
        200
      );
    } catch (_) {
      return ResponseUtil.error(req, res, 'common.ERROR', 500);
    }
  }

  async getSubtitleConfig(req, res) {
    try {
      const raw = await tableConfig.getConfigByKey('subtitlePreExtractEnable');
      let preExtractEnable = 1;
      if (raw !== null && raw !== undefined && String(raw).trim() !== '') {
        preExtractEnable = _parseBoolTo01(raw);
      }
      const langRaw = await tableConfig.getConfigByKey(KEY_SUBTITLE_DEFAULT_LANGUAGE);
      const defaultSubtitleLanguage = _normalizeSubtitleLanguage(langRaw);
      return ResponseUtil.success(
        req,
        res,
        {
          preExtractEnable,
          defaultSubtitleLanguage,
          defaultSubtitleLanguageOptions: SUBTITLE_DEFAULT_LANGUAGE_OPTIONS,
        },
        'common.SUCCESS',
        200
      );
    } catch (_) {
      return ResponseUtil.error(req, res, 'common.ERROR', 500);
    }
  }

  async setSubtitleConfig(req, res) {
    try {
      const body = req.body || {};
      const preExtractEnable = _parseBoolTo01(
        body.preExtractEnable ?? body.subtitlePreExtractEnable ?? body.subtitle_pre_extract_enable
      );
      const ok = await tableConfig.setConfigByKey('subtitlePreExtractEnable', String(preExtractEnable));
      if (!ok) return ResponseUtil.error(req, res, 'common.ERROR', 500);
      let defaultSubtitleLanguage = null;
      if (body.defaultSubtitleLanguage !== undefined) {
        defaultSubtitleLanguage = _normalizeSubtitleLanguage(body.defaultSubtitleLanguage);
        const ok2 = await tableConfig.setConfigByKey(KEY_SUBTITLE_DEFAULT_LANGUAGE, defaultSubtitleLanguage);
        if (!ok2) return ResponseUtil.error(req, res, 'common.ERROR', 500);
      }
      return ResponseUtil.success(
        req,
        res,
        { preExtractEnable, defaultSubtitleLanguage },
        'video.SUBTITLE_CONFIG_SAVED',
        200
      );
    } catch (_) {
      return ResponseUtil.error(req, res, 'common.ERROR', 500);
    }
  }

  /**
   * 读取「默认播放画质」（**按端 + 按用户隔离**，2026-10-12）。
   * 注意：该接口不加 requireAdmin —— 每个播放端都需要读到自己的设置，
   * 服务端会按 (uid, clientType) 逐级回退，读不到时落回旧的全量配置或 original。
   * body: { clientType: 'web' | 'android' | 'ios' | 'desktop' }
   */
  async getPlayQuality(req, res) {
    try {
      const uid = req.user && req.user.id ? Number(req.user.id) : 0;
      const clientType = _clientTypeOf(req);
      const [raw, downmixRaw, codecRaw, codecCapability, subtitleLangRaw] = await Promise.all([
        _readScopedConfig(KEY_VIDEO_DEFAULT_PLAY_QUALITY, uid, clientType),
        _readScopedConfig(KEY_VIDEO_AUDIO_DOWNMIX, uid, clientType),
        _readScopedConfig(KEY_VIDEO_DEFAULT_VIDEO_CODEC, uid, clientType),
        _getServerCodecCapability(),
        tableConfig.getConfigByKey(KEY_SUBTITLE_DEFAULT_LANGUAGE),
      ]);
      const quality = _normalizePlayQuality(raw) || 'original';
      const codecOut = _normalizeVideoCodec(codecRaw) || 'h264';
      return ResponseUtil.success(
        req,
        res,
        {
          quality,
          // 未配置过时默认关闭（保持源声道数）
          audioDownmix: _parseBoolTo01(downmixRaw),
          // ⭐ 可选档位随输出编码变化（2026-10-15）
          options: playQualityOptionsForCodec(codecOut),
          clientType: clientType || '',
          // ⭐ 输出视频编码方式（2026-10-13）：默认 h264；同时回吐服务端支持能力供前端置灰
          codec: codecOut,
          codecOptions: VIDEO_CODEC_OPTIONS,
          codecCapability,
          // ⭐ 默认字幕语言（2026-10-15）：随播放画质一并回吐，让所有端（含普通用户）
          // 播放时都能拿到，无需额外去读 requireSuperAdmin 的字幕配置接口。
          defaultSubtitleLanguage: _normalizeSubtitleLanguage(subtitleLangRaw),
        },
        'common.SUCCESS',
        200
      );
    } catch (_) {
      return ResponseUtil.error(req, res, 'common.ERROR', 500);
    }
  }

  /**
   * 保存「默认播放画质」（**按端 + 按用户隔离**，2026-10-12）。
   *
   * 落库目标 uid：管理员 ⇒ 0（全局默认，所有用户继承）；普通用户 ⇒ 自己。
   * 键带 `<base>.<clientType>` 后缀，所以安卓端保存不会动到 web 端。
   * body: { quality, audioDownmix?, clientType }
   */
  async setPlayQuality(req, res) {
    try {
      const body = req.body || {};
      const uid = req.user && req.user.id ? Number(req.user.id) : 0;
      const isAdmin = !!(req.user && userUtil.isAdmin(req.user));
      const targetUid = isAdmin ? 0 : uid;
      const clientType = _clientTypeOf(req);

      const raw = _parseText(body.quality ?? body.playQuality ?? body.play_quality);
      const quality = _normalizePlayQuality(raw);
      if (!quality) return ResponseUtil.error(req, res, 'common.PARAM_ERROR', 400);
      // ⭐ 输出视频编码（可选字段）：老客户端不带时不动已有配置。
      // 若服务端根本不支持该编码（既无软编也无硬编），直接拒绝，避免选出必然失败的编码。
      const hasCodecField =
        Object.prototype.hasOwnProperty.call(body, 'codec') ||
        Object.prototype.hasOwnProperty.call(body, 'videoCodec') ||
        Object.prototype.hasOwnProperty.call(body, 'video_codec');
      let videoCodec = null;
      if (hasCodecField) {
        const parsedCodec = _normalizeVideoCodec(body.codec ?? body.videoCodec ?? body.video_codec);
        if (!parsedCodec) return ResponseUtil.error(req, res, 'common.PARAM_ERROR', 400);
        const capability = await _getServerCodecCapability();
        if (capability[parsedCodec] && capability[parsedCodec].supported === false) {
          return ResponseUtil.error(req, res, 'video.CODEC_NOT_SUPPORTED_BY_SERVER', 400);
        }
        videoCodec = parsedCodec;
      }
      // audioDownmix 为可选字段：老客户端不带该字段时不改动已有配置
      const hasDownmixField =
        Object.prototype.hasOwnProperty.call(body, 'audioDownmix') ||
        Object.prototype.hasOwnProperty.call(body, 'videoAudioDownmix') ||
        Object.prototype.hasOwnProperty.call(body, 'audio_downmix');
      const audioDownmix = hasDownmixField
        ? _parseBoolTo01(body.audioDownmix ?? body.videoAudioDownmix ?? body.audio_downmix)
        : null;

      const savePairs = [
        tableConfig.setConfigByKey(
          _scopedKey(KEY_VIDEO_DEFAULT_PLAY_QUALITY, clientType),
          quality,
          targetUid
        ),
      ];
      if (audioDownmix !== null) {
        savePairs.push(
          tableConfig.setConfigByKey(
            _scopedKey(KEY_VIDEO_AUDIO_DOWNMIX, clientType),
            String(audioDownmix),
            targetUid
          )
        );
      }
      if (videoCodec !== null) {
        savePairs.push(
          tableConfig.setConfigByKey(
            _scopedKey(KEY_VIDEO_DEFAULT_VIDEO_CODEC, clientType),
            videoCodec,
            targetUid
          )
        );
      }
      const results = await Promise.all(savePairs);
      if (!results.every(Boolean)) return ResponseUtil.error(req, res, 'common.ERROR', 500);
      const payload = { quality, clientType: clientType || '', scope: targetUid === 0 ? 'global' : 'user' };
      if (audioDownmix !== null) payload.audioDownmix = audioDownmix;
      if (videoCodec !== null) payload.codec = videoCodec;
      return ResponseUtil.success(req, res, payload, 'video.PLAY_QUALITY_CONFIG_SAVED', 200);
    } catch (_) {
      return ResponseUtil.error(req, res, 'common.ERROR', 500);
    }
  }

  async setTranscodeConfig(req, res) {
    try {
      const body = req.body || {};
      const tempDirRaw = _parseText(body.tempDir ?? body.transcodeTempDir ?? body.transcode_temp_dir);
      const hasPreferredField =
        Object.prototype.hasOwnProperty.call(body, 'preferredHwDecoder') ||
        Object.prototype.hasOwnProperty.call(body, 'transcodeHwDecoder') ||
        Object.prototype.hasOwnProperty.call(body, 'preferred_hw_decoder');
      const preferredHwDecoder = hasPreferredField ? _parseText(body.preferredHwDecoder ?? body.transcodeHwDecoder ?? body.preferred_hw_decoder) : null;
      const test = await _testWritableDir(tempDirRaw);
      if (!test.ok) {
        return ResponseUtil.error(req, res, test.code || 'common.PARAM_ERROR', 400);
      }
      const tempDir = test.resolved || '';
      let nextPreferredKey = null;
      if (hasPreferredField) {
        const available = normalizeAvailableHwAccelList(await tableConfig.getConfigByKey('transcode_hwaccel_available'));
        if (preferredHwDecoder && !findAvailableHwAccelEntry(available, preferredHwDecoder)) {
          return ResponseUtil.error(req, res, 'common.PARAM_ERROR', 400);
        }
        nextPreferredKey = preferredHwDecoder || '';
      }

      const savePairs = [tableConfig.setConfigByKey('transcodeTempDir', tempDir)];
      if (hasPreferredField) {
        savePairs.push(tableConfig.setConfigByKey('transcode_hwaccel_preferred', nextPreferredKey));
      }
      const results = await Promise.all(savePairs);
      if (!results.every(Boolean)) return ResponseUtil.error(req, res, 'common.ERROR', 500);

      return ResponseUtil.success(
        req,
        res,
        { tempDir, preferredHwDecoder: hasPreferredField ? nextPreferredKey : undefined },
        'video.TRANSCODE_CONFIG_SAVED',
        200
      );
    } catch (_) {
      return ResponseUtil.error(req, res, 'common.ERROR', 500);
    }
  }
}

module.exports = new VideoConfigController();
