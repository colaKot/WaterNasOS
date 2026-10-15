'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
const sharp = require('../../../utils/sharpConfigured');

const networkProxyUtil = require('../../../utils/networkProxyUtil');
const config = require('../../../config/config');
const { extractAvId } = require('./avIdExtractor');
const { scrapeByDvdId, scrapeJavbus, scrapeAvsox } = require('./javScraper');

/** 从扩展名去掉后缀。 */
function stripExt(name) {
  return String(name || '').replace(/\.[^.\\/]+$/, '');
}

/**
 * 从一条索引记录里推断番号：文件名 -> nfo_name -> 所在文件夹名，依次尝试。
 * @param {{filename?: string, path?: string, nfoName?: string, nfo_name?: string}} row
 * @returns {string} 番号，失败返回空串
 */
function extractAvIdFromRow(row) {
  const r = row && typeof row === 'object' ? row : {};
  const candidates = [stripExt(r.filename), stripExt(r.nfoName || r.nfo_name), path.basename(String(r.path || ''))];
  for (const c of candidates) {
    if (!c) continue;
    const id = extractAvId(c);
    if (id) return id;
  }
  return '';
}

/** 从发布日期里取年份。 */
function pickYear(dateStr) {
  const m = String(dateStr || '').match(/\b(19|20)\d{2}\b/);
  const y = m ? Number(m[0]) : 0;
  return y >= 1900 && y <= 2100 ? y : 0;
}

/**
 * 把抓取到的 meta 映射成 jellyfinNfo.buildMovieNfo 需要的结构。
 * 日文站点的信息偏少：没有剧情简介、没有评分，这里如实留空，不做编造。
 */
function buildJavNfoData(meta) {
  const m = meta && typeof meta === 'object' ? meta : {};
  const genres = Array.isArray(m.genres) ? m.genres.filter(Boolean) : [];
  const tags = [m.producer, m.publisher, m.serial].map(s => String(s || '').trim()).filter(Boolean);
  // ⭐ 演员头像（2026-10-12）：javbus / avsox 详情页的 `avatar-box` 里带演员小图，
  //    写进 NFO 的 `<thumb>` 后，客户端详情页就能显示头像（此前恒为空 → 日本片全无头像）。
  const pics = m.actressPics && typeof m.actressPics === 'object' ? m.actressPics : {};
  const actors = (Array.isArray(m.actresses) ? m.actresses : [])
    .filter(Boolean)
    .map(name => {
      const n = String(name).trim();
      return { name: n, role: '', thumb: String(pics[n] || '').trim(), tmdbId: '' };
    });
  const directors = m.director ? [{ name: String(m.director).trim(), thumb: '', tmdbId: '' }] : [];

  return {
    title: String(m.title || '').trim(),
    originalTitle: '',
    sortTitle: '',
    year: pickYear(m.publishDate),
    premiered: m.publishDate || '',
    plot: '',
    rating: 0,
    genres,
    tags,
    countries: ['Japan'],
    languages: ['Japanese'],
    tmdbId: '',
    imdbId: '',
    actors,
    directors,
  };
}

/**
 * 下载图片并转成 jpg。目标文件已存在则跳过。
 *
 * 复用同一个入口下载多种图（封面 / 背景），只是 targetPath 不同。
 * @param {{url: string, targetPath: string, proxyUrl?: string, timeoutMs?: number}} params
 * @returns {Promise<boolean>}
 */
async function downloadCoverToJpeg({ url, targetPath, proxyUrl = '', timeoutMs = 20000 }) {
  const src = String(url || '').trim();
  const out = String(targetPath || '').trim();
  if (!src || !out) return false;

  try {
    if (fs.existsSync(out) && fs.statSync(out).isFile()) return false;
  } catch (_) {}

  const agent = proxyUrl ? networkProxyUtil.createHttpsProxyAgent(proxyUrl) : null;
  let buffer = null;
  try {
    const res = await axios.get(src, {
      responseType: 'arraybuffer',
      timeout: timeoutMs,
      maxRedirects: 5,
      decompress: true,
      proxy: false,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36',
        Referer: `${new URL(src).origin}/`,
      },
      ...(agent ? { httpsAgent: agent, httpAgent: agent } : {}),
    });
    buffer = Buffer.from(res.data);
  } catch (_) {
    return false;
  }
  if (!buffer || buffer.length === 0) return false;

  const tmp = `${out}.${Date.now()}.tmp`;
  try {
    await fs.promises.writeFile(tmp, buffer);
    await sharp(tmp).jpeg({ quality: 85 }).toFile(out);
    try {
      fs.unlinkSync(tmp);
    } catch (_) {}
    return true;
  } catch (_) {
    try {
      fs.unlinkSync(tmp);
    } catch (_) {}
    try {
      fs.unlinkSync(out);
    } catch (_) {}
    return false;
  }
}

/**
 * 演员头像缓存键。
 *
 * ⚠️ 必须与 API 侧 `detailService._computePersonKey` 完全一致，否则刮削时下载好的
 *    头像在详情页按另一个键去找，就会「下载了但显示不出来」。
 */
function personAvatarCacheKey({ tmdbId = '', thumbUrl = '' } = {}) {
  const id = String(tmdbId || '').trim();
  if (/^\d+$/.test(id)) return id;
  const thumb = String(thumbUrl || '').trim();
  if (!thumb) return '';
  return `u${crypto.createHash('md5').update(thumb).digest('hex').slice(0, 16)}`;
}

/**
 * 把演员头像下载进服务端头像缓存目录（键与详情页取头像一致）。
 * 目标文件已存在则跳过，重复刮削不会重复请求站点。
 *
 * @param {{tmdbId?: string, thumbUrl?: string, proxyUrl?: string, size?: number}} params
 * @returns {Promise<boolean>}
 */
async function downloadActorAvatarToCache({ tmdbId = '', thumbUrl = '', proxyUrl = '', size = 500 } = {}) {
  const url = String(thumbUrl || '').trim();
  if (!/^https?:\/\//i.test(url)) return false;
  const key = personAvatarCacheKey({ tmdbId, thumbUrl: url });
  if (!key) return false;
  const root = typeof config.getNfoAvatarPath === 'function' ? config.getNfoAvatarPath() : '';
  if (!root) return false;
  const out = path.join(root, `${key}_w${Number(size) || 500}.jpg`);
  try {
    await fs.promises.mkdir(root, { recursive: true });
  } catch (_) {}
  return await downloadCoverToJpeg({ url, targetPath: out, proxyUrl });
}

/**
 * 走「日本片兜底识别」：提取番号 -> 抓取 -> 返回 meta。
 * 找不到番号或所有站点都抓不到时返回 null。
 * @param {{filename?: string, folderName?: string, nfoName?: string, dvdId?: string, proxyUrl?: string, timeoutMs?: number, siteBases?: object}} [params]
 *        `dvdId` 显式指定时优先使用（手动「搜索影音信息」里用户选中的那条番号结果）。
 */
async function fetchJavMeta({ filename, folderName, nfoName, dvdId = '', proxyUrl = '', timeoutMs, siteBases = null } = {}) {
  const explicit = String(dvdId || '').trim();
  const dvdid = explicit || extractAvIdFromRow({ filename, path: folderName, nfoName });
  if (!dvdid) return null;
  const meta = await scrapeByDvdId(dvdid, { proxyUrl, timeoutMs, siteBases }).catch(() => null);
  if (!meta) return null;

  // ⭐ 演员头像兜底（JavSP 思路：主源只给演员名时，再问带 avatar-box 的站点）：
  //    javdb 排在站点顺序第一位，但它的详情页只有演员名、没有头像图。
  //    命中这种情况时依次问 javbus（有码，信息最全）→ avsox（无码，javbus 没有页面时靠它）。
  //    纯增量、失败不影响主流程。
  const hasPics = meta.actressPics && Object.keys(meta.actressPics).length > 0;
  if (!hasPics && Array.isArray(meta.actresses) && meta.actresses.length > 0) {
    for (const scrapeSite of [scrapeJavbus, scrapeAvsox]) {
      if (typeof scrapeSite !== 'function') continue;
      const siteMeta = await scrapeSite(dvdid, { proxyUrl, timeoutMs, siteBases }).catch(() => null);
      if (siteMeta && siteMeta.actressPics && Object.keys(siteMeta.actressPics).length > 0) {
        meta.actressPics = siteMeta.actressPics;
        break;
      }
    }
  }
  return meta;
}

/**
 * 把一张本地图片按指定宽高比裁切，另存为 jpg。目标文件已存在则跳过。
 *
 * 库里既有命名是「三张图同源」：横版原图 `-backdrop.jpg` + 由它裁出的竖版 `-poster.jpg`
 * （2:3）与 `-landscape.jpg`（16:9），三张高度一致。这里就是那个裁切步骤，
 * 避免同一张封面重复下载三次。
 *
 * ⚠️ `align` 决定横向裁切位置，必须是「库内既有图反推出来的」而不是随手居中：
 *    实测用户库里 7 部片的 `-poster.jpg`（宽≈backdrop 宽 44.9% = 2:3）与 backdrop
 *    做模板匹配，最佳偏移一律是**右对齐**（x0 = w - cw，均差 1.5~3.6），中心裁切
 *    （x0≈29%）完全对不上 —— 站点横版封面是「左封底 + 右封面」的展开图，居中裁
 *    正好切在两页拼接缝上，就是用户说的「封面明显不行」。
 *
 * @param {{srcPath: string, targetPath: string, aspect: number, align?: 'center'|'right'|'left'}} params
 *        `aspect` = 宽/高；`align` 仅对横向裁切生效，默认 center
 * @returns {Promise<boolean>}
 */
async function cropJpegToAspect({ srcPath, targetPath, aspect, align = 'center' }) {
  const src = String(srcPath || '').trim();
  const out = String(targetPath || '').trim();
  const a = Number(aspect || 0) || 0;
  if (!src || !out || a <= 0) return false;

  try {
    if (fs.existsSync(out) && fs.statSync(out).isFile()) return false;
  } catch (_) {}

  try {
    const img = sharp(src);
    const meta = await img.metadata();
    const w = Number(meta.width || 0) || 0;
    const h = Number(meta.height || 0) || 0;
    if (!w || !h) return false;

    const cur = w / h;
    let cw = w;
    let ch = h;
    let left = 0;
    if (cur > a) {
      cw = Math.max(1, Math.round(h * a));
      left = align === 'right' ? w - cw : align === 'left' ? 0 : Math.floor((w - cw) / 2);
    } else if (cur < a) {
      ch = Math.max(1, Math.round(w / a));
    }

    if (cw === w && ch === h) {
      await fs.promises.copyFile(src, out);
      return true;
    }
    await img
      .extract({
        left,
        top: Math.floor((h - ch) / 2),
        width: cw,
        height: ch,
      })
      .jpeg({ quality: 85 })
      .toFile(out);
    return true;
  } catch (_) {
    try {
      fs.unlinkSync(out);
    } catch (_) {}
    return false;
  }
}

module.exports = {
  extractAvIdFromRow,
  buildJavNfoData,
  downloadCoverToJpeg,
  cropJpegToAspect,
  fetchJavMeta,
  personAvatarCacheKey,
  downloadActorAvatarToCache,
};
