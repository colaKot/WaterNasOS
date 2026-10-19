const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const geohash = require('ngeohash');
const config = require('../../../../config/config');
const dbUtil = require('../../../../db/dbUtil');
const knexUtil = require('../../../../db/knexUtil');
const tableConfig = require('../../../../db/table/tableConfig');
const nascabAccountUtil = require('../../service/utils/nascabAccountUtil');
const photoTimeLineService = require('../timeline/photoTimeLineService');
const defaultTileServerList = config.getDefaultTileServer();
const DEFAULT_MAX_MAP_LEVEL = 18;

function md5(text) {
  return crypto
    .createHash('md5')
    .update(String(text || ''))
    .digest('hex');
}

/** 两点球面距离（km）。用于地名反查时比较「谁离照片更近」。 */
function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * geohash 前缀格的几何中心。
 * ⚠️ ngeohash 的 decode() 返回的是标量对象 { latitude, longitude }，不是数组，
 *    这里两种形态都兼容一下，避免上游换版本时静默返回空。
 */
function ghCenter(prefix) {
  try {
    const d = geohash.decode(prefix);
    if (Array.isArray(d)) {
      const lat = Number(d[0]);
      const lng = Number(d[1]);
      if (Number.isFinite(lat) && Number.isFinite(lng)) return { lat, lng };
      return null;
    }
    if (d) {
      const lat = Number(d.latitude);
      const lng = Number(d.longitude);
      if (Number.isFinite(lat) && Number.isFinite(lng)) return { lat, lng };
    }
  } catch (_) {
    // 前缀非法（长度不足 / 含非法字符）时直接放弃这一级
  }
  return null;
}

function normalizeTileServer(input) {
  const obj = input && typeof input === 'object' ? input : null;
  if (!obj) return null;

  const name = String(obj.name || '').trim();
  const server = String(obj.server || '').trim();
  const coordinate = String(obj.coordinate || 'WGS-84').trim() || 'WGS-84';
  const maxLevelNum = Number(obj.maxLevel);

  if (!name || !server) return null;

  return {
    name,
    server,
    coordinate,
    maxLevel: Number.isFinite(maxLevelNum) && maxLevelNum > 0 ? maxLevelNum : DEFAULT_MAX_MAP_LEVEL,
    isDefault: obj.isDefault ? true : false,
  };
}

function parsePositiveInt(input, fallback) {
  const n = Number(input);
  if (!Number.isFinite(n)) return fallback;
  const t = Math.trunc(n);
  return t > 0 ? t : fallback;
}

function pickEvenly(list, maxCount) {
  const arr = Array.isArray(list) ? list : [];
  const n = parsePositiveInt(maxCount, 0);
  if (n <= 0) return [];
  if (arr.length <= n) return arr.slice();
  const out = [];
  const step = arr.length / n;
  for (let i = 0; i < n; i += 1) {
    const idx = Math.min(arr.length - 1, Math.floor(i * step));
    out.push(arr[idx]);
  }
  return out;
}

function thinPhotosByGrid(photos, bounds, maxCount) {
  const list = Array.isArray(photos) ? photos : [];
  const limit = parsePositiveInt(maxCount, 0);
  if (limit <= 0) return [];
  if (list.length <= limit) return list.slice();

  const minLat = bounds && Number.isFinite(bounds.minLat) ? bounds.minLat : null;
  const maxLat = bounds && Number.isFinite(bounds.maxLat) ? bounds.maxLat : null;
  const minLng = bounds && Number.isFinite(bounds.minLng) ? bounds.minLng : null;
  const maxLng = bounds && Number.isFinite(bounds.maxLng) ? bounds.maxLng : null;
  if ([minLat, maxLat, minLng, maxLng].some(v => v === null)) return pickEvenly(list, limit);

  const latSpan = Math.max(0, maxLat - minLat);
  const lngSpan = Math.max(0, maxLng - minLng);
  if (latSpan === 0 || lngSpan === 0) return pickEvenly(list, limit);

  const aspect = lngSpan / latSpan;
  let cols = Math.ceil(Math.sqrt(limit * aspect));
  cols = Math.max(1, Math.min(cols, limit));
  let rows = Math.ceil(limit / cols);
  rows = Math.max(1, Math.min(rows, limit));

  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  const timeScore = p => {
    const t = Number(p && p.original_time !== undefined ? p.original_time : 0);
    return Number.isFinite(t) ? t : 0;
  };
  const idScore = p => {
    const id = Number(p && p.id !== undefined ? p.id : 0);
    return Number.isFinite(id) ? id : 0;
  };

  const byCell = new Map();
  for (const p of list) {
    const lat = Number(p && p.latitude !== undefined ? p.latitude : NaN);
    const lng = Number(p && p.longitude !== undefined ? p.longitude : NaN);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    const x = clamp(Math.floor(((lng - minLng) / lngSpan) * cols), 0, cols - 1);
    const y = clamp(Math.floor(((lat - minLat) / latSpan) * rows), 0, rows - 1);
    const key = `${x},${y}`;
    const existing = byCell.get(key);
    if (!existing) {
      byCell.set(key, [p]);
      continue;
    }
    existing.push(p);
  }

  if (byCell.size === 0) return pickEvenly(list, limit);

  for (const bucket of byCell.values()) {
    bucket.sort((a, b) => timeScore(b) - timeScore(a) || idScore(b) - idScore(a));
  }

  const cellKeys = [];
  for (let y = 0; y < rows; y += 1) {
    if (y % 2 === 0) {
      for (let x = 0; x < cols; x += 1) cellKeys.push(`${x},${y}`);
    } else {
      for (let x = cols - 1; x >= 0; x -= 1) cellKeys.push(`${x},${y}`);
    }
  }

  const availableCellKeys = cellKeys.filter(k => byCell.has(k));
  if (availableCellKeys.length === 0) return pickEvenly(list, limit);

  if (availableCellKeys.length > limit) {
    const pickedKeys = pickEvenly(availableCellKeys, limit);
    const out = [];
    for (const k of pickedKeys) {
      const bucket = byCell.get(k);
      if (bucket && bucket.length > 0) out.push(bucket[0]);
      if (out.length >= limit) break;
    }
    return out.length > 0 ? out : pickEvenly(list, limit);
  }

  const out = [];
  for (const k of availableCellKeys) {
    const bucket = byCell.get(k);
    if (bucket && bucket.length > 0) out.push(bucket[0]);
    if (out.length >= limit) return out;
  }

  let round = 1;
  while (out.length < limit) {
    let added = 0;
    for (const k of availableCellKeys) {
      const bucket = byCell.get(k);
      if (!bucket || bucket.length <= round) continue;
      out.push(bucket[round]);
      added += 1;
      if (out.length >= limit) return out;
    }
    if (added === 0) break;
    round += 1;
  }

  return out;
}

class PhotoMapService {
  async getCurrentTileServer() {
    const knex = knexUtil.getInstance(dbUtil.DB_PATHS.MAIN_DB);
    const raw = await nascabAccountUtil.getDecryptedConfigValue(knex, tableConfig, 'mapTileServer');
    if (raw !== null && raw !== undefined && String(raw).trim()) {
      try {
        const parsed = JSON.parse(String(raw));
        const item = Array.isArray(parsed) ? parsed.find(p => p && p.isDefault) || parsed[0] : parsed;
        const normalized = normalizeTileServer(item);
        if (normalized) return normalized;
      } catch (_) {}
    }
    return defaultTileServerList.length > 0
      ? defaultTileServerList[0]
      : {
          name: 'GaoDe',
          server: 'https://webrd01.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=7&x={x}&y={y}&z={z}',
          maxLevel: 18,
          coordinate: 'GCJ-02',
        };
  }

  async getZoomInfo() {
    const tileServer = await this.getCurrentTileServer();
    return {
      zoomInfo: { minZoom: 2, maxZoom: Number(tileServer.maxLevel) || DEFAULT_MAX_MAP_LEVEL },
      tileServer,
    };
  }

  async getTileServerList() {
    let list = [];
    const rawList = await tableConfig.getConfigByKey('mapTileServerList', 0);
    if (rawList) {
      try {
        const parsed = JSON.parse(String(rawList));
        if (Array.isArray(parsed)) list = parsed;
      } catch (_) {}
    }
    if (list.length == 0) {
      list = defaultTileServerList;
    }
    // console.log('defaultTileServerList', defaultTileServerList);
    if (!Array.isArray(list)) list = [];

    const currentServer = await this.getCurrentTileServer();
    if (list.length === 0) list.push(currentServer);

    let customList = [];
    const rawCustom = await tableConfig.getConfigByKey('mapTileServerListCustom', 0);
    if (rawCustom) {
      try {
        const parsed = JSON.parse(String(rawCustom));
        if (Array.isArray(parsed)) customList = parsed;
      } catch (_) {}
    }
    if (!Array.isArray(customList)) customList = [];

    for (const s of customList) {
      if (s && typeof s === 'object') {
        s.isCustom = 1;
        list.push(s);
      }
    }

    const currentServerUrl = String(currentServer && currentServer.server ? currentServer.server : '');
    for (const s of list) {
      if (!s || typeof s !== 'object') continue;
      s.current = String(s.server || '') === currentServerUrl ? 1 : 0;
      if (!s.maxLevel) s.maxLevel = DEFAULT_MAX_MAP_LEVEL;
      if (!s.coordinate) s.coordinate = 'WGS-84';
    }

    return list;
  }

  async setTileServer(tileServer) {
    const normalized = normalizeTileServer(tileServer);
    if (!normalized) return false;
    await tableConfig.setConfigByKey('mapTileServer', JSON.stringify(normalized), 0);
    return true;
  }

  async addTileServer(tileServer) {
    const normalized = normalizeTileServer(tileServer);
    if (!normalized) return false;

    let customList = [];
    const rawCustom = await tableConfig.getConfigByKey('mapTileServerListCustom', 0);
    if (rawCustom) {
      try {
        const parsed = JSON.parse(String(rawCustom));
        if (Array.isArray(parsed)) customList = parsed;
      } catch (_) {}
    }
    if (!Array.isArray(customList)) customList = [];

    const serverUrl = String(normalized.server);
    if (!customList.some(s => s && String(s.server || '') === serverUrl)) {
      customList.push(normalized);
      await tableConfig.setConfigByKey('mapTileServerListCustom', JSON.stringify(customList), 0);
    }
    return true;
  }

  async deleteTileServer(tileServer) {
    const normalized = normalizeTileServer(tileServer);
    if (!normalized) return false;

    let customList = [];
    const rawCustom = await tableConfig.getConfigByKey('mapTileServerListCustom', 0);
    if (rawCustom) {
      try {
        const parsed = JSON.parse(String(rawCustom));
        if (Array.isArray(parsed)) customList = parsed;
      } catch (_) {}
    }
    if (!Array.isArray(customList)) customList = [];

    const serverUrl = String(normalized.server);
    const before = customList.length;
    customList = customList.filter(s => !(s && String(s.server || '') === serverUrl));
    if (customList.length !== before) {
      await tableConfig.setConfigByKey('mapTileServerListCustom', JSON.stringify(customList), 0);
    }
    return true;
  }

  async getTileFilePath({ zoom, x, y, baseServerUrl }) {
    const serverHash = md5(baseServerUrl);
    return path.join(config.getMapTileCachePath(), serverHash, String(zoom), String(x), String(y), 'tile.png');
  }

  async fetchToFile(url, filePath, timeoutMs = 10000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const resp = await fetch(url, { method: 'GET', signal: controller.signal });
      if (!resp.ok) return false;
      const ab = await resp.arrayBuffer();
      const buf = Buffer.from(ab);
      if (!buf || buf.length === 0) return false;
      await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
      await fs.promises.writeFile(filePath, buf);
      return true;
    } catch (_) {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  async ensureTileCached({ zoom, x, y }) {
    const tileServer = await this.getCurrentTileServer();
    const baseUrl = String(tileServer.server || '').trim();
    if (!baseUrl) return null;

    const url = baseUrl.replace('{z}', String(zoom)).replace('{x}', String(x)).replace('{y}', String(y));
    const filePath = await this.getTileFilePath({ zoom, x, y, baseServerUrl: baseUrl });
    try {
      const st = await fs.promises.stat(filePath);
      if (st && st.size > 0) return filePath;
    } catch (_) {}
    const ok = await this.fetchToFile(url, filePath, 10000);
    if (!ok) return null;
    return filePath;
  }

  /**
   * 可视范围 → geohash 聚合精度：取「格子数 <= cellTarget」的**最细**精度。
   *
   * ⭐⭐ 2026-10-16 改（用户拍板）：**聚合搬到客户端**做 —— 按世界像素距离把互相压盖的
   * marker 合成一个，落点仍是某张真实照片的坐标。所以服务端**不需要**再保证
   * 「格心间距 ≥ marker 直径」：那会让返回的点太粗，客户端反而没东西可聚、
   * 角标上的张数也失真。现在服务端只负责一件事：这一屏最多给 cellTarget 个格子。
   *
   * ⛔ 别改回「先 geohash.bboxes() 试算、超了就降精度」：视野大时 6 位会生成几十万个
   *    格子（z=7 时 ≈ 84 万个），那个数组直接打爆内存。这里用解析式先算格子数，
   *    bboxes() 只会在最终精度上调用一次。
   *
   * geohash 每字符 5 bit、经度占偶数位 ⇒ 精度 p 的经度位 = ceil(5p/2)、纬度位 = floor(5p/2)。
   */
  getBoundsPhotoPrecision(minLa, minLo, maxLa, maxLo, cellTarget) {
    const latSpan = Math.abs(Number(maxLa) - Number(minLa));
    const lngSpan = Math.abs(Number(maxLo) - Number(minLo));
    const target = parsePositiveInt(cellTarget, 600);
    if (!Number.isFinite(latSpan) || !Number.isFinite(lngSpan)) return 2;
    for (let p = 6; p > 2; p -= 1) {
      const latBits = Math.floor((5 * p) / 2);
      const lngBits = Math.ceil((5 * p) / 2);
      const cellLat = 180 / Math.pow(2, latBits);
      const cellLng = 360 / Math.pow(2, lngBits);
      const cells = Math.ceil(latSpan / cellLat + 1) * Math.ceil(lngSpan / cellLng + 1);
      if (cells <= target) return p;
    }
    return 2;
  }

  async getLocationStr({ dbGeo, locale }, geohash, lat, lng) {
    const rawHash = String(geohash || '').trim();
    if (!rawHash) return '';
    const hash8 = rawHash.length > 8 ? rawHash.slice(0, 8) : rawHash;

    let lang = 'en';
    if (locale.indexOf('-') > -1) {
      lang = locale.split('-')[0].toLowerCase();
    } else if (locale) {
      lang = locale.toLowerCase();
    }

    // ⭐ 2026-10-16 修复「地点对不上」：
    // 旧实现每一级都是 `ORDER BY g.geonameid ASC LIMIT 1`，等于「谁录入得早就归谁」。
    // geonames 里只有城市/村镇级点位，市区（如林和西，geohash5='ws0ed'）根本没有记录，
    // 于是逐级回退到 geohash4='ws0e'（36km×19.5km）后，永远命中 geonameid 最小的
    // 「鱼珠」——而鱼珠实际在 11km 外，最近的「五山」只有 2.9km。
    // 现在改为：按「与查询点的真实距离」升序取最近的一条，并加最大距离闸门。
    const qLat = Number(lat);
    const qLng = Number(lng);
    const hasPoint =
      Number.isFinite(qLat) &&
      Number.isFinite(qLng) &&
      Math.abs(qLat) <= 90 &&
      Math.abs(qLng) <= 180 &&
      !(qLat === 0 && qLng === 0);

    const geoColumnMap = {
      8: 'geohash',
      7: 'geohash7',
      6: 'geohash6',
      5: 'geohash5',
      4: 'geohash4',
      3: 'geohash3',
    };
    // 最近的地名点也超出这个距离 ⇒ 不采用（宁可显示通用的「位置」，也别显示 11km 外的错地名）
    const MAX_DISTANCE_KM = 30;

    for (let len = Math.min(8, hash8.length); len >= 3; len -= 1) {
      const prefix = hash8.slice(0, len);
      const geoColumn = geoColumnMap[len] || geoColumnMap[3];

      // 目标点：优先用调用方给的真实坐标；没给就用该前缀格的几何中心兜底
      let tLat = qLat;
      let tLng = qLng;
      if (!hasPoint) {
        const center = ghCenter(prefix);
        if (!center) continue;
        tLat = center.lat;
        tLng = center.lng;
      }

      // 平方距离排序（本地尺度足够，不追求大圆精确）；经度按 cos²(lat) 折算成等长
      const lngWeight = Math.cos((tLat * Math.PI) / 180) ** 2;
      const rows = await dbGeo
        .raw(
          `
          SELECT
            COALESCE(i_req.name, i_def.name) AS local_name,
            COALESCE(i_en.name, i_def.name, i_req.name) AS en_name,
            g.latitude AS latitude,
            g.longitude AS longitude,
            ((g.latitude - ?) * (g.latitude - ?) + (g.longitude - ?) * (g.longitude - ?) * ?) AS dist2
          FROM geonames g
          LEFT JOIN geoname_i18n i_req ON i_req.geonameid = g.geonameid AND i_req.lang = ?
          LEFT JOIN geoname_i18n i_en ON i_en.geonameid = g.geonameid AND i_en.lang = 'en'
          LEFT JOIN geoname_i18n i_def ON i_def.geonameid = g.geonameid AND i_def.lang = 'und'
          WHERE g.${geoColumn} = ?
          ORDER BY dist2 ASC
          LIMIT 5
          `,
          [tLat, tLat, tLng, tLng, lngWeight, lang, prefix]
        )
        .catch(() => null);

      if (!Array.isArray(rows) || rows.length === 0) continue;

      let rejectedByDistance = false;
      for (const row of rows) {
        const localName = row && row.local_name ? String(row.local_name).trim() : '';
        const enName = row && row.en_name ? String(row.en_name).trim() : '';
        if (!localName && !enName) continue;

        const dKm = haversineKm(tLat, tLng, Number(row.latitude), Number(row.longitude));
        if (Number.isFinite(dKm) && dKm > MAX_DISTANCE_KM) {
          rejectedByDistance = true;
          break;
        }
        // ⭐ 2026-10-19 只显示一种语言：本地名（中文）有就不拼英文，
        // 否则「广州 Guangzhou」这种双写在界面上很怪；没有本地名才退回英文名。
        return localName || enName;
      }
      // 这一级最近的一条都太远 ⇒ 更粗的格只会更远，不必再回退
      if (rejectedByDistance) break;
    }

    return '';
  }

  async getBoundsPhoto({ knexPhoto }, params, user) {
    const { minLat, minLng, maxLat, maxLng, zoom } = params || {};

    const la1 = Number(minLat);
    const lo1 = Number(minLng);
    const la2 = Number(maxLat);
    const lo2 = Number(maxLng);
    const z = Number(zoom);

    if (![la1, lo1, la2, lo2].every(Number.isFinite)) return { mapPhoto: [] };

    const minLa = Math.min(la1, la2);
    const maxLa = Math.max(la1, la2);
    const minLo = Math.min(lo1, lo2);
    const maxLo = Math.max(lo1, lo2);

    const requestedMax = parsePositiveInt((params && (params.maxReturnCount ?? params.maxCount ?? params.limit)) || 0, 150);
    const maxReturnCount = Math.max(1, Math.min(requestedMax, 2000));

    // 这一屏允许返回多少个 geohash 格子（客户端会再按屏幕距离把它们聚合成更少的 marker）
    // 允许的格子数上限。比 maxReturnCount 宽一个量级是有意的：先拿到足够细的格子，
    // 再由 thinPhotosByGrid 抽稀到 maxReturnCount；格子给得太粗，客户端就聚不出有意义的点。
    // ⚠️ geohash4/5/6 上都有索引（idx_photo_index_geohashN），单批 500 个 whereIn 没问题。
    const cellTarget = Math.max(maxReturnCount * 14, 2000);
    let precision = this.getBoundsPhotoPrecision(minLa, minLo, maxLa, maxLo, cellTarget);
    let boxes = [];
    // 兜底循环：正常情况下上面的解析式已经选对了精度，第一次就会 break。
    while (precision >= 2) {
      try {
        boxes = geohash.bboxes(minLa, minLo, maxLa, maxLo, precision) || [];
      } catch (_) {
        boxes = [];
      }
      if (Array.isArray(boxes) && boxes.length > 0) {
        if (boxes.length <= cellTarget || precision === 2) break;
      }
      precision -= 1;
    }
    if (!Array.isArray(boxes) || boxes.length === 0) return { mapPhoto: [] };

    const mapped = { ...(params || {}) };
    const validPaths = await photoTimeLineService.getValidPathsByParams(mapped, user);
    if (!validPaths || validPaths.length === 0) return { mapPhoto: [] };

    const { query: baseQuery } = await photoTimeLineService.buildBaseQuery(mapped, validPaths, user);
    baseQuery.andWhere('photo_index.is_file', 1).andWhere('photo_index.in_trash', 0);

    const geoColumnMap = {
      2: 'photo_index.geohash2',
      3: 'photo_index.geohash3',
      4: 'photo_index.geohash4',
      5: 'photo_index.geohash5',
      6: 'photo_index.geohash6',
    };
    const geoColumn = geoColumnMap[precision] || geoColumnMap[2];

    const uniqueCells = [];
    const seen = new Set();
    for (const cell of boxes) {
      const c = String(cell || '').trim();
      if (!c) continue;
      if (seen.has(c)) continue;
      seen.add(c);
      uniqueCells.push(c);
    }
    if (uniqueCells.length === 0) return { mapPhoto: [] };

    const maxQueryCells = Math.min(Math.max(maxReturnCount * 20, 800), 6000);
    const queryCells = uniqueCells.length > maxQueryCells ? pickEvenly(uniqueCells, maxQueryCells) : uniqueCells;

    // 为了避免一次性 whereIn 塞太多参数（SQLite 常见的变量上限是 999），把 cell 列表按固定大小切块分批查询。
    // chunkSize = 每批最多处理多少个 cell
    const chunkSize = 500;
    const mapByCell = new Map();
    const selectFields = [
      'photo_index.id as id',
      'photo_index.geohash as geohash',
      'photo_index.latitude as latitude',
      'photo_index.longitude as longitude',
      'photo_index.original_time as original_time',
      'photo_index.path as path',
      'photo_index.filename as filename',
      'photo_index.type as type',
      'photo_index.duration as duration',
    ];

    let batchOk = true;
    for (let i = 0; i < queryCells.length; i += chunkSize) {
      // chunk = 当前这一批要查询的 cell（uniqueCells 的一个切片）
      const chunk = queryCells.slice(i, i + chunkSize);
      try {
        // ⭐ 同时取「代表照片 id」和「该网格内的照片总数」。
        // 之前只取 max(id)，客户端拿不到数量 ⇒ marker 无法显示聚合角标、
        // 也无法按「本格照片数」决定粒度，缩放时只能靠换 geohash 列隐式合并。
        const picked = await baseQuery
          .clone()
          .clearSelect()
          .clearOrder()
          // 只查询当前 chunk 里的 cell，避免 whereIn 参数过多导致报错或性能抖动
          .whereIn(geoColumn, chunk)
          .select(
            knexPhoto.raw('?? as cell', [geoColumn]),
            knexPhoto.raw('max(photo_index.id) as id'),
            knexPhoto.raw('count(photo_index.id) as photo_count')
          )
          .groupBy(geoColumn)
          .catch(() => null);
        const ids = Array.isArray(picked) ? picked.map(r => Number(r && r.id ? r.id : 0)).filter(n => Number.isFinite(n) && n > 0) : [];
        if (ids.length === 0) continue;
        const rows = await knexPhoto('photo_index')
          .select(...selectFields)
          .whereIn('photo_index.id', ids)
          .catch(() => null);

        const rowById = new Map();
        if (Array.isArray(rows)) {
          for (const r of rows) {
            const id = Number(r && r.id ? r.id : 0);
            if (!Number.isFinite(id) || id <= 0) continue;
            if (!rowById.has(id)) rowById.set(id, r);
          }
        }

        for (const p of picked || []) {
          const cell = String(p && p.cell ? p.cell : '').trim();
          const id = Number(p && p.id ? p.id : 0);
          if (!cell) continue;
          if (!Number.isFinite(id) || id <= 0) continue;
          if (mapByCell.has(cell)) continue;
          const row = rowById.get(id);
          if (!row || !row.id) continue;
          const count = Number(p && p.photo_count ? p.photo_count : 0);
          mapByCell.set(cell, {
            ...row,
            photo_count: Number.isFinite(count) && count > 0 ? count : 1,
            cell_precision: precision,
            // ⭐ 2026-10-16：**不再**下发 cell_lat / cell_lng。
            // marker 一律用上面 row 里代表照片真实的 latitude/longitude，
            // 「重叠的合成一个」交给客户端按世界像素距离做（见 photo_footprint_map_controller.dart）。
            // ⛔ 别再拿 geohash.decode() 当数组解构去算格心：ngeohash 的 decode() 返回的是
            //    标量 {latitude,longitude}，那样写恒为空对象。
          });
        }
      } catch (_) {
        batchOk = false;
        break;
      }
    }

    const mapPhoto = [];
    if (batchOk && mapByCell.size > 0) {
      for (const c of queryCells) {
        const row = mapByCell.get(c);
        if (row && row.id) mapPhoto.push({ ...row, fullpath: path.join(row.path, row.filename) });
      }
      return { mapPhoto: thinPhotosByGrid(mapPhoto, { minLat: minLa, minLng: minLo, maxLat: maxLa, maxLng: maxLo }, maxReturnCount) };
    }

    const fallbackMaxFetch = Math.min(Math.max(maxReturnCount * 4, maxReturnCount), 800);
    for (const c of queryCells) {
      const row = await baseQuery
        .clone()
        .andWhere(geoColumn, c)
        .select(
          'photo_index.id',
          'photo_index.geohash',
          'photo_index.latitude',
          'photo_index.longitude',
          'photo_index.original_time',
          'photo_index.path',
          'photo_index.filename',
          'photo_index.type',
          'photo_index.duration'
        )
        .first()
        .catch(() => null);
      if (row && row.id) mapPhoto.push({ ...row, fullpath: path.join(row.path, row.filename) });
      if (mapPhoto.length >= fallbackMaxFetch) break;
    }

    return { mapPhoto: thinPhotosByGrid(mapPhoto, { minLat: minLa, minLng: minLo, maxLat: maxLa, maxLng: maxLo }, maxReturnCount) };
  }

  async getAlbumPhotoForMap({ knexPhoto }, params, user) {
    const maxReturnCount = 200;

    const mapped = { ...(params || {}) };
    if (mapped.ordinaryAlbumId !== undefined && mapped.album_id === undefined) mapped.album_id = mapped.ordinaryAlbumId;
    if (mapped.albumId !== undefined && mapped.smart_album_id === undefined) mapped.smart_album_id = mapped.albumId;
    if (mapped.libraryId !== undefined && mapped.collection_id === undefined) mapped.collection_id = mapped.libraryId;

    const validPaths = await photoTimeLineService.getValidPathsByParams(mapped, user);
    if (!validPaths || validPaths.length === 0) return { mapPhoto: [] };

    const { query: baseQuery } = await photoTimeLineService.buildBaseQuery(mapped, validPaths, user);
    baseQuery
      .andWhere('photo_index.is_file', 1)
      .andWhere('photo_index.in_trash', 0)
      .andWhereRaw('NOT (photo_index.latitude = 0 AND photo_index.longitude = 0)')
      .whereNotNull('photo_index.geohash')
      .andWhere('photo_index.geohash', '!=', '');

    const [{ count }] = await baseQuery.clone().clearSelect().clearOrder().count('* as count');
    const total = Number(count || 0);

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

    if (total > 0 && total < maxReturnCount) {
      const rows = await baseQuery.clone().select(selectFields).orderBy('photo_index.original_time', 'desc').orderBy('photo_index.id', 'desc');
      const mapPhoto = (rows || []).map(r => ({ ...r, fullpath: path.join(r.path, r.filename) }));
      return { mapPhoto };
    }

    const seenIds = new Set();
    let chosenPrefixes = [];
    let precision = 5;
    for (const p of [5, 4, 3, 2]) {
      const geoColumn = `photo_index.geohash${p}`;
      const rows = await baseQuery
        .clone()
        .clearSelect()
        .clearOrder()
        .whereNotNull(geoColumn)
        .andWhere(geoColumn, '!=', '')
        .select(knexPhoto.raw('?? as prefix', [geoColumn]))
        .groupBy(geoColumn);
      const prefixes = (rows || []).map(r => String(r.prefix || '')).filter(Boolean);
      if (prefixes.length > 0 && prefixes.length <= maxReturnCount) {
        chosenPrefixes = prefixes;
        precision = p;
        break;
      }
      if (p === 2) {
        chosenPrefixes = prefixes.slice(0, maxReturnCount);
        precision = 2;
      }
    }

    const mapPhoto = [];
    const chosenGeoColumn = `photo_index.geohash${precision}`;
    for (const pref of chosenPrefixes) {
      if (mapPhoto.length >= maxReturnCount) break;
      const row = await baseQuery
        .clone()
        .andWhere(chosenGeoColumn, pref)
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

    return { mapPhoto };
  }
}

module.exports = new PhotoMapService();
