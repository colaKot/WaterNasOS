const tableConfig = require('../db/table/tableConfig');
const tableUser = require('../db/table/tableUser');

/**
 * 应用级访问控制
 *
 * 背景：项目原有的权限体系只到「文件路径」一级（user_permission），
 * 没有任何「按用户限制可用哪些应用」的机制。getApps 只是给普通用户少显示几个图标，
 * 客户端点击图标是纯本地路由，直接调 HTTP API 完全不受影响。
 *
 * 本模块补上服务端这一层：非管理员账号可被指定一组「可用应用」，
 * 不在白名单内的应用，其 API 请求一律 403。
 *
 * 存储：config 表的 userAllowedApps 键，按 uid 存 JSON 数组。
 * 语义：未配置（无记录） => 不限制，向后兼容；配置了数组 => 只允许数组内的应用。
 */

const CONFIG_KEY_ALLOWED_APPS = 'userAllowedApps';

/** appKey → 该应用使用的 API 前缀（与 src/api/app.js 的挂载路径对应） */
const APP_API_PREFIXES = {
  folder: ['/api/file', '/api/fileServer', '/api/editor'],
  movie: ['/api/video', '/api/videoPlayer'],
  photo: ['/api/photo', '/api/mapApi'],
  music: ['/api/music'],
  book: ['/api/book'],
  note: ['/api/notes'],
  encrypted: ['/api/encryptedSpace'],
  sync: ['/api/sync'],
  share: ['/api/quickShare'],
  mounts: ['/api/fileMount', '/api/openlistMount'],
  media_tool: ['/api/mediaTool'],
  docker: ['/api/docker'],
  transmission: ['/api/transmission'],
  nascab_service: ['/api/service'],
  security: ['/api/security'],
  // 「磁盘间备份」（appKey=backup），接口自带 requireAdmin，普通用户本就无权限
  backup: ['/api/fileBackup'],
};

/**
 * ⚠️ 未在上面登记 API 前缀的应用（upload / download / task_center / monitor / terminal /
 *    process / photo_backup / user 等）—— 它们要么复用 /api/file 前缀（由 folder 承载），
 *    要么只走 /api/hw、WebSocket 等公共通道，无法在 HTTP 路径层区分。
 *    这类应用的拦截主要靠 getApps 的「不下发图标」；若需要强隔离，应先给它们分配独立前缀。
 */

/**
 * 永远放行的基础前缀。
 * 这些接口是客户端启动、登录、渲染首页所必需的，或者内部自带管理员校验（如 /api/user 的管理类接口）。
 * ⚠️ 白名单拦截只对下面 APP_API_PREFIXES 里登记过的前缀生效，
 *    没登记的前缀一律放行 —— 所以新增 API 模块后，若希望它受应用白名单约束，
 *    必须同时在这里和 APP_API_PREFIXES 里登记；否则子账号可以直接调用它。
 */
const PUBLIC_API_PREFIXES = [
  '/api/auth',
  // MCP Server（P2-18）：自带 Bearer token 鉴权，与登录态无关，故不适合走应用白名单
  '/api/mcp',
  '/api/apps',
  '/api/home',
  '/api/message',
  '/api/appearance',
  '/api/hw',
  '/api/user',
  // loginConfig 无鉴权（登录页需要），其余接口自带 requireSuperAdmin / requireAdmin；
  // 整体放行是安全的，也意味着 appKey=setting 不需要在 APP_API_PREFIXES 里登记
  '/api/apiSetting',
  '/api/plugin',
];

const CACHE_TTL_MS = 3000;
const _allowedCache = new Map();

function invalidateCache(uid) {
  if (uid === undefined || uid === null) {
    _allowedCache.clear();
    return;
  }
  _allowedCache.delete(Number(uid));
}

function _parseAppList(raw) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(String(raw));
    if (!Array.isArray(parsed)) return null;
    return Array.from(new Set(parsed.map(v => String(v || '').trim()).filter(Boolean)));
  } catch (_) {
    return null;
  }
}

function _isPathUnderPrefix(apiPath, prefix) {
  if (!apiPath || !prefix) return false;
  if (apiPath === prefix) return true;
  return apiPath.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`);
}

function isPublicApiPath(apiPath) {
  const p = String(apiPath || '').trim();
  if (!p) return true;
  return PUBLIC_API_PREFIXES.some(prefix => _isPathUnderPrefix(p, prefix));
}

/** 解析一个请求路径属于哪个应用；返回 null 表示「未登记，不参与白名单判定」 */
function resolveAppKeyByPath(apiPath) {
  const p = String(apiPath || '').trim();
  if (!p) return null;
  for (const appKey of Object.keys(APP_API_PREFIXES)) {
    const prefixes = APP_API_PREFIXES[appKey] || [];
    if (prefixes.some(prefix => _isPathUnderPrefix(p, prefix))) return appKey;
  }
  return null;
}

/**
 * 读取用户的可用应用白名单
 * @returns {Promise<string[]|null>} null 表示未配置（不限制）
 */
async function getAllowedApps(uid) {
  const id = Number(uid);
  if (!Number.isFinite(id) || id <= 0) return null;

  const cached = _allowedCache.get(id);
  const now = Date.now();
  if (cached && now - cached.at < CACHE_TTL_MS) return cached.value;

  let value = null;
  try {
    const raw = await tableConfig.getConfigByKey(CONFIG_KEY_ALLOWED_APPS, id);
    value = _parseAppList(raw);
  } catch (_) {
    value = null;
  }
  _allowedCache.set(id, { at: now, value });
  return value;
}

/** 写入用户的可用应用白名单（覆盖式） */
async function setAllowedApps(uid, apps) {
  const id = Number(uid);
  if (!Number.isFinite(id) || id <= 0) throw new Error('validation.ID_INVALID');
  const list = Array.isArray(apps) ? apps : [];
  const normalized = Array.from(new Set(list.map(v => String(v || '').trim()).filter(Boolean)));
  const ok = await tableConfig.setJsonConfigByKey(CONFIG_KEY_ALLOWED_APPS, normalized, id);
  invalidateCache(id);
  return ok;
}

async function _resolveUserType(knex, user) {
  const fromToken = user && user.type ? String(user.type).trim().toLowerCase() : '';
  if (fromToken) return fromToken;
  const uid = Number(user && (user.id ?? user.userId ?? user.uid));
  if (!Number.isFinite(uid) || uid <= 0) return '';
  try {
    const row = await knex('user').where({ id: uid }).first('type');
    return row && row.type ? String(row.type).trim().toLowerCase() : '';
  } catch (_) {
    return '';
  }
}

/**
 * 校验请求是否被应用白名单放行
 * @returns {Promise<{allowed:boolean, appKey:string|null}>}
 */
async function checkAppAccess(knex, user, apiPath) {
  if (!knex || !user) return { allowed: true, appKey: null };

  const userType = await _resolveUserType(knex, user);
  if (userType === tableUser.TYPE_SUPER_ADMIN || userType === tableUser.TYPE_ADMIN) {
    return { allowed: true, appKey: null };
  }

  const uid = Number(user.id ?? user.userId ?? user.uid);
  if (!Number.isFinite(uid) || uid <= 0) return { allowed: true, appKey: null };

  if (isPublicApiPath(apiPath)) return { allowed: true, appKey: null };

  const appKey = resolveAppKeyByPath(apiPath);
  if (!appKey) return { allowed: true, appKey: null };

  const allowedApps = await getAllowedApps(uid);
  if (allowedApps === null) return { allowed: true, appKey };

  if (allowedApps.includes(appKey)) return { allowed: true, appKey };
  return { allowed: false, appKey };
}

module.exports = {
  CONFIG_KEY_ALLOWED_APPS,
  APP_API_PREFIXES,
  PUBLIC_API_PREFIXES,
  getAllowedApps,
  setAllowedApps,
  invalidateCache,
  resolveAppKeyByPath,
  isPublicApiPath,
  checkAppAccess,
};
