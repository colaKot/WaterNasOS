const ffmpeg = require('fluent-ffmpeg');
const { spawn } = require('child_process');
const ffmpegPath = require('../libsPath/ffmpegPath');
const ffprobePath = require('../libsPath/ffprobePath');

ffmpeg.setFfmpegPath(ffmpegPath.path);
ffmpeg.setFfprobePath(ffprobePath.path);

function _toInt(v) {
  const n = Number(v || 0) || 0;
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

function _extractFromMeta(meta) {
  const m = meta && typeof meta === 'object' ? meta : null;
  if (!m) {
    return {
      width: 0,
      height: 0,
      duration: 0,
      format: '',
      streams: [],
    };
  }

  let width = 0;
  let height = 0;
  const streams = Array.isArray(m.streams) ? m.streams : [];
  const videoStream = streams.find(s => s && s.codec_type === 'video');
  if (videoStream) {
    width = _toInt(videoStream.width);
    height = _toInt(videoStream.height);
  }

  let duration = 0;
  let format = '';
  const fmt = m.format && typeof m.format === 'object' ? m.format : null;
  if (fmt) {
    duration = Math.max(0, Math.floor(Number(fmt.duration || 0) || 0));
    format = fmt.format_name ? String(fmt.format_name) : '';
  }

  return { width, height, duration, format, streams };
}

function _safeJsonParse(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * 判断视频流是否为 Dolby Vision。
 * 仅依据 ffprobe 返回的流元数据（codec tag / side data / DOVI 配置），不使用文件名。
 */
function isDolbyVisionStream(videoStream) {
  if (!videoStream || typeof videoStream !== 'object') return false;
  const tag = String(videoStream.codec_tag_string || '').toLowerCase();
  if (tag === 'dvhe' || tag === 'dvh1') return true;
  const encoder = videoStream.tags && videoStream.tags.encoder ? String(videoStream.tags.encoder) : '';
  if (/dovi/i.test(encoder)) return true;
  // fluent-ffmpeg/ffprobe 常把 DOVI side data 平铺在 stream 上（MKV Profile 5 常见 hevc + side_data_type）
  const sideDataType = String(videoStream.side_data_type || '').toLowerCase();
  if (sideDataType.includes('dovi') || sideDataType.includes('dolby')) return true;
  const dvProfile = Number(videoStream.dv_profile);
  if (Number.isFinite(dvProfile) && dvProfile > 0) return true;
  if (Number(videoStream.rpu_present_flag) === 1) return true;
  const sideData = Array.isArray(videoStream.side_data_list) ? videoStream.side_data_list : [];
  for (const sd of sideData) {
    const t = String((sd && sd.side_data_type) || '').toLowerCase();
    if (t.includes('dovi') || t.includes('dolby')) return true;
    const profile = Number(sd && sd.dv_profile);
    if (Number.isFinite(profile) && profile > 0) return true;
  }
  return false;
}

/** 缓存的 stream 是否缺少 ffprobe 可提供的 DOVI 探测字段（需 live probe 补全，非文件名推断） */
function cachedVideoStreamMissingDoviProbeFields(videoStream) {
  if (!videoStream || typeof videoStream !== 'object') return false;
  if (isDolbyVisionStream(videoStream)) return false;
  const hasDoviSideData =
    videoStream.side_data_type ||
    videoStream.dv_profile ||
    (Array.isArray(videoStream.side_data_list) && videoStream.side_data_list.length > 0);
  if (hasDoviSideData) return false;
  const codec = String(videoStream.codec_name || '').toLowerCase();
  return codec === 'hevc' || codec === 'h265';
}

function normalizeCacheRow(row) {
  if (!row) return null;
  const widthFromCol = _toInt(row.width);
  const heightFromCol = _toInt(row.height);
  const durationFromCol = _toInt(row.duration);
  const formatFromCol = row.format ? String(row.format) : '';

  const playbackHints = (() => {
    // Preferred: JSON column.
    const jsonText = row.playback_hints != null ? String(row.playback_hints) : '';
    const parsed = _safeJsonParse(jsonText);
    if (parsed && typeof parsed === 'object') return parsed;

    // Backward-compat: older installs may have split columns.
    const majorBrand = row.playback_major_brand != null ? String(row.playback_major_brand) : '';
    const moovAtTail =
      row.playback_moov_at_tail != null ? _toInt(row.playback_moov_at_tail) === 1 : null;
    const preferRemuxMp4 =
      row.playback_prefer_remux_mp4 != null ? _toInt(row.playback_prefer_remux_mp4) === 1 : null;
    const preferredOriginalMode =
      row.playback_preferred_original_mode != null ? String(row.playback_preferred_original_mode) : '';
    const sourceType = row.playback_source_type != null ? String(row.playback_source_type) : '';
    const hasAny =
      !!majorBrand ||
      moovAtTail !== null ||
      preferRemuxMp4 !== null ||
      !!preferredOriginalMode ||
      !!sourceType;
    if (!hasAny) return null;
    return {
      majorBrand,
      moovAtTail: moovAtTail === true,
      preferRemuxMp4: preferRemuxMp4 === true,
      preferredOriginalMode:
        preferredOriginalMode || (preferRemuxMp4 === true ? 'remux_mp4' : 'raw'),
      sourceType,
    };
  })();

  const audioLoudness = (() => {
    const text = row.audio_loudness != null ? String(row.audio_loudness) : '';
    const parsedLoudness = _safeJsonParse(text);
    return parsedLoudness && typeof parsedLoudness === 'object' ? parsedLoudness : null;
  })();

  const rawStreams = row.streams ? String(row.streams) : '';
  const parsed = _safeJsonParse(rawStreams);

  if (Array.isArray(parsed)) {
    return {
      width: widthFromCol,
      height: heightFromCol,
      duration: durationFromCol,
      format: formatFromCol,
      streams: parsed,
      streamInfo: rawStreams,
      meta: null,
      fileHash: row.id ? String(row.id) : '',
      playbackHints,
      audioLoudness,
    };
  }

  if (parsed && typeof parsed === 'object') {
    const extracted = _extractFromMeta(parsed);
    return {
      width: widthFromCol || extracted.width,
      height: heightFromCol || extracted.height,
      duration: durationFromCol || extracted.duration,
      format: formatFromCol || extracted.format,
      streams: extracted.streams,
      streamInfo: rawStreams,
      meta: parsed,
      fileHash: row.id ? String(row.id) : '',
      playbackHints,
      audioLoudness,
    };
  }

  return {
    width: widthFromCol,
    height: heightFromCol,
    duration: durationFromCol,
    format: formatFromCol,
    streams: [],
    streamInfo: rawStreams,
    meta: null,
    fileHash: row.id ? String(row.id) : '',
    playbackHints,
  };
}

async function probeVideo(filePath) {
  const full = String(filePath || '');
  if (!full) {
    return {
      width: 0,
      height: 0,
      duration: 0,
      format: '',
      streams: [],
      streamInfo: '',
      meta: null,
    };
  }

  const meta = await new Promise(resolve => {
    ffmpeg.ffprobe(full, (err, data) => {
      if (err) return resolve(null);
      resolve(data);
    });
  });

  if (!meta) {
    return {
      width: 0,
      height: 0,
      duration: 0,
      format: '',
      streams: [],
      streamInfo: '',
      meta: null,
    };
  }

  const extracted = _extractFromMeta(meta);
  let streamInfo = '';
  try {
    streamInfo = JSON.stringify(meta);
  } catch {
    streamInfo = '';
  }

  return { ...extracted, streamInfo, meta };
}

async function upsertFfmpegVideoInfo(knex, fileHash, payload) {
  const k = knex;
  const id = fileHash ? String(fileHash) : '';
  if (!k || !id) return false;

  const v = payload && typeof payload === 'object' ? payload : {};
  // Important: only include keys provided in payload to avoid wiping older columns.
  const row = { id };
  if (v.streamInfo !== undefined) row.streams = v.streamInfo ? String(v.streamInfo) : '';
  if (v.duration !== undefined) row.duration = _toInt(v.duration);
  if (v.format !== undefined) row.format = v.format ? String(v.format) : '';
  if (v.size !== undefined) row.size = _toInt(v.size);
  if (v.mtime !== undefined) row.mtime = _toInt(v.mtime);
  if (v.width !== undefined) row.width = _toInt(v.width);
  if (v.height !== undefined) row.height = _toInt(v.height);
  if (v.create_time !== undefined) row.create_time = _toInt(v.create_time);

  if (v.playback_hints !== undefined) {
    row.playback_hints = v.playback_hints ? String(v.playback_hints) : '';
  }

  if (v.audioLoudness !== undefined) {
    row.audio_loudness =
      v.audioLoudness === null
        ? ''
        : typeof v.audioLoudness === 'string'
          ? v.audioLoudness
          : JSON.stringify(v.audioLoudness);
  }

  // Always set create_time on first insert; don't overwrite if not provided.
  if (row.create_time === undefined) row.create_time = _toInt(Date.now());

  await k('video_ffmpeg_info').insert(row).onConflict('id').merge(row);
  return true;
}

/** 响度测量超时（毫秒）：整片兜底测量用较长超时 */
const LOUDNESS_MEASURE_TIMEOUT_MS = 10 * 60 * 1000;
/** 单窗口采样超时：30 秒音频正常只需数秒，给足 seek/启动开销即可 */
const LOUDNESS_SAMPLE_TIMEOUT_MS = 2 * 60 * 1000;
/** 采样窗口时长（秒）与采样点占全片比例：避开片头片尾，多点取平均 */
const LOUDNESS_SAMPLE_WINDOW_SEC = 30;
const LOUDNESS_SAMPLE_RATIOS = [0.1, 0.3, 0.5, 0.7, 0.9];
const LOUDNESS_FILTER = 'loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json';

/** 从 ffmpeg loudnorm 的 stderr JSON 中解析两遍模式所需的测量字段 */
function _parseLoudnormOutput(stderrText) {
  const text = String(stderrText || '');
  const start = text.lastIndexOf('{');
  if (start < 0) return null;
  const end = text.indexOf('}', start);
  if (end < 0) return null;
  const parsed = _safeJsonParse(text.slice(start, end + 1));
  if (!parsed || typeof parsed !== 'object') return null;
  const num = k => {
    const n = Number(parsed[k]);
    return Number.isFinite(n) ? n : null;
  };
  const result = {
    input_i: num('input_i'),
    input_tp: num('input_tp'),
    input_lra: num('input_lra'),
    input_thresh: num('input_thresh'),
    target_offset: num('target_offset'),
  };
  return Object.values(result).every(v => v !== null) ? result : null;
}

/** 从 ffmpeg 头部输出解析总时长（秒），失败返回 null */
function _parseDurationFromStderr(stderrText) {
  const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(String(stderrText || ''));
  if (!m) return null;
  const sec = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  return Number.isFinite(sec) && sec > 0 ? sec : null;
}

/** 只读文件头获取时长（不解码），失败/超时返回 null */
function _probeDurationSec(filePath) {
  return new Promise(resolve => {
    let child;
    try {
      child = spawn(ffmpegPath.path, ['-hide_banner', '-i', filePath], { windowsHide: true });
    } catch (_) {
      return resolve(null);
    }
    let stderr = '';
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch (_) {}
      finish(null);
    }, 15000);
    if (child.stderr) child.stderr.on('data', d => (stderr += String(d)));
    child.on('error', () => finish(null));
    child.on('close', () => finish(_parseDurationFromStderr(stderr)));
  });
}

/**
 * 跑一次 loudnorm 测量；startSec 为 null 表示整片测量。
 * -ss 放在 -i 之前走容器索引快进，避免顺序读完整文件（这是提速的关键）。
 */
function _runLoudnormOnce(filePath, startSec, durSec, timeoutMs) {
  return new Promise(resolve => {
    const args = ['-hide_banner', '-nostats'];
    if (startSec !== null && startSec !== undefined) {
      args.push('-ss', String(startSec));
    }
    if (durSec !== null && durSec !== undefined) {
      args.push('-t', String(durSec));
    }
    args.push('-i', filePath, '-vn', '-af', LOUDNESS_FILTER, '-f', 'null', '-');
    let child;
    try {
      child = spawn(ffmpegPath.path, args, { windowsHide: true });
    } catch (_) {
      return resolve(null);
    }
    let stderr = '';
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch (_) {}
      finish(null);
    }, timeoutMs);
    if (child.stderr) child.stderr.on('data', d => (stderr += String(d)));
    child.on('error', () => finish(null));
    child.on('close', () => finish(_parseLoudnormOutput(stderr)));
  });
}

/** 对多个采样窗口的测量值取算术平均，全部无效返回 null */
function _aggregateLoudness(rows) {
  const keys = ['input_i', 'input_tp', 'input_lra', 'input_thresh', 'target_offset'];
  const out = {};
  for (const k of keys) {
    const vals = rows.map(r => r[k]).filter(v => Number.isFinite(v));
    if (!vals.length) return null;
    out[k] = vals.reduce((a, b) => a + b, 0) / vals.length;
  }
  return out;
}

/**
 * 测量音频响度，返回两遍线性模式所需参数。
 *
 * 性能优化：不再顺序读完整文件（2 小时片源约需 8 分钟），而是取整片时长后，
 * 在多个时间点各测 30 秒窗口再取平均，可把耗时压到几十秒。采样精度对
 * 「不同片源音量对齐」的需求完全够用。
 * 无法获取时长或片长过短时退化为整片测量。失败返回 null。
 */
async function measureAudioLoudness(filePath) {
  const full = String(filePath || '');
  if (!full) return null;

  const duration = await _probeDurationSec(full);
  const ratios = LOUDNESS_SAMPLE_RATIOS;
  const win = LOUDNESS_SAMPLE_WINDOW_SEC;

  // 短片或无法获取时长：直接整片测量（行为兜底）
  if (!duration || duration <= win * ratios.length) {
    return await _runLoudnormOnce(full, null, null, LOUDNESS_MEASURE_TIMEOUT_MS);
  }

  const rows = [];
  for (const r of ratios) {
    const start = Math.max(0, Math.min(duration - win - 1, duration * r));
    const one = await _runLoudnormOnce(full, start, win, LOUDNESS_SAMPLE_TIMEOUT_MS);
    if (one) rows.push(one);
  }
  if (!rows.length) return null;
  return _aggregateLoudness(rows);
}

module.exports = {
  normalizeCacheRow,
  probeVideo,
  upsertFfmpegVideoInfo,
  measureAudioLoudness,
  isDolbyVisionStream,
  cachedVideoStreamMissingDoviProbeFields,
};
