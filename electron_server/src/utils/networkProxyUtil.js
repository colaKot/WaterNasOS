'use strict';

/**
 * 全局网络代理工具。
 *
 * 抽出来给「影视刮削 / 元数据抓取」这类出站请求共用：TMDB 客户端（tmdbClient）、
 * 下载器（downloadUrlToFileWorker）、日本片识别抓取器（javScraper）都通过这里
 * 拿到统一的代理地址与 https.Agent，避免每个模块各自复制一份 CONNECT 隧道逻辑。
 *
 * 设计要点：
 * - 只接受 http / https 代理（不支持 socks），非法地址一律视为「未配置」。
 * - 代理开关与地址存在通用配置表（uid=0），键为 globalProxyEnable / globalProxyUrl。
 */

const http = require('http');
const https = require('https');
const tls = require('tls');
const { URL } = require('url');

const tableConfig = require('../db/table/tableConfig');

/** 去掉空白；没有协议头时补 `http://`。空串返回空串。 */
function normalizeProxyUrlString(proxyUrlStr) {
  const raw = String(proxyUrlStr || '').trim();
  if (!raw) return '';
  if (raw.includes('://')) return raw;
  return `http://${raw}`;
}

/** 校验并返回可用的 http/https 代理地址；非法返回空串。 */
function parseHttpProxyUrlOrEmpty(proxyUrlStr) {
  const normalized = normalizeProxyUrlString(proxyUrlStr);
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

function _buildProxyAuthHeader(proxyUrl) {
  const u = proxyUrl && typeof proxyUrl === 'object' ? proxyUrl : null;
  if (!u) return '';
  const user = u.username ? decodeURIComponent(u.username) : '';
  const pass = u.password ? decodeURIComponent(u.password) : '';
  if (!user && !pass) return '';
  return `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
}

/**
 * 构造一个走 HTTP CONNECT 隧道的 https.Agent。代理地址非法/为空时返回 null。
 * 与 tmdbClient 内部实现同源，供不便直接复用 TmdbClient 的模块使用。
 */
function createHttpsProxyAgent(proxyUrlStr) {
  const raw = normalizeProxyUrlString(proxyUrlStr);
  if (!raw) return null;

  let proxyUrl;
  try {
    proxyUrl = new URL(raw);
  } catch (_) {
    return null;
  }

  const isHttpsProxy = proxyUrl.protocol === 'https:';
  const isHttpProxy = proxyUrl.protocol === 'http:';
  if (!isHttpsProxy && !isHttpProxy) return null;

  const host = proxyUrl.hostname;
  const port = Number(proxyUrl.port || (isHttpsProxy ? 443 : 80)) || (isHttpsProxy ? 443 : 80);
  if (!host || !port) return null;

  const proxyAuth = _buildProxyAuthHeader(proxyUrl);

  const agent = new https.Agent({ keepAlive: true });

  // ⛔⛔ 必须**构造之后**把 createConnection 赋到实例上。
  //    写成 `new https.Agent({ keepAlive: true, createConnection })` 是**无效**的：
  //    Node 22 不会把构造参数里的 createConnection 变成实例自有属性，
  //    Agent 仍然走 https.Agent.prototype.createConnection —— 也就是**直连目标站**，
  //    代理被静默绕过。（2026-10-12 实测：javdb.com 直连被墙 ⇒ 请求挂到超时。）
  agent.createConnection = (options, callback) => {
    const targetHost = options.servername || options.host || options.hostname;
    const targetPort = Number(options.port || 443) || 443;
    const connectHeaders = { Host: `${targetHost}:${targetPort}` };
    if (proxyAuth) connectHeaders['Proxy-Authorization'] = proxyAuth;

    const req = (isHttpsProxy ? https : http).request({
      host,
      port,
      method: 'CONNECT',
      path: `${targetHost}:${targetPort}`,
      headers: connectHeaders,
    });
    req.once('connect', (res, socket) => {
      if (!res || res.statusCode !== 200) {
        try {
          socket.destroy();
        } catch (_) {}
        const err = new Error(`Proxy CONNECT failed (${res ? res.statusCode : 'no_status'})`);
        return callback(err);
      }
      const tlsSocket = tls.connect({
        socket,
        servername: targetHost,
        rejectUnauthorized: options.rejectUnauthorized !== false,
      });
      tlsSocket.once('secureConnect', () => callback(null, tlsSocket));
      tlsSocket.once('error', e => callback(e));
    });
    req.once('error', e => callback(e));
    req.end();
  };

  return agent;
}

/**
 * 读取全局代理配置。未开启 / 地址非法时返回空串（调用方按「不使用代理」处理）。
 * 每次调用都读库，避免长驻 worker 缓存到过期配置。
 */
async function resolveGlobalProxyUrl() {
  try {
    const [enableRaw, urlRaw] = await Promise.all([
      tableConfig.getConfigByKey(tableConfig.KEY_GLOBAL_PROXY_ENABLE),
      tableConfig.getConfigByKey(tableConfig.KEY_GLOBAL_PROXY_URL),
    ]);
    const enabled = enableRaw === '1' || enableRaw === 1 || enableRaw === true;
    if (!enabled) return '';
    return parseHttpProxyUrlOrEmpty(urlRaw);
  } catch (_) {
    return '';
  }
}

/**
 * 解析「元数据抓取」（TMDB 搜索/详情、日本片番号刮削）应当使用的代理地址。
 *
 * ⭐ 2026-10-12：影视设置里那个「启用代理刮削」开关已从界面移除，代理统一到
 *    「系统设置 → 网络代理」。为了让以前只配过影视代理的用户不至于突然失去代理
 *    （TMDB 直连在国内会失败），解析顺序为：
 *      ① 全局代理（总配置，首选）；
 *      ② 旧键 `tmdbProxyEnable` / `tmdbProxyUrl`（兜底，仅当全局没配时才用）。
 *    两者都拿不到 ⇒ 返回空串（不使用代理）。
 *
 * ⚠️ 所有出站刮削都必须走这里，**不能再各自读 tmdbProxy* 键** ——
 *    之前 `videoTmdbController`（手动「搜索影音信息」）就漏了全局回退，
 *    一旦影视代理被关掉，手动搜索会直接变成直连。
 *
 * @returns {Promise<string>} 可用代理地址；空串表示不走代理
 */
async function resolveMetadataProxyUrl() {
  try {
    const globalUrl = await resolveGlobalProxyUrl();
    if (globalUrl) return globalUrl;
  } catch (_) {}
  try {
    const [enableRaw, urlRaw] = await Promise.all([
      tableConfig.getConfigByKey('tmdbProxyEnable'),
      tableConfig.getConfigByKey('tmdbProxyUrl'),
    ]);
    const enabled = enableRaw === '1' || enableRaw === 1 || enableRaw === true;
    if (!enabled) return '';
    return parseHttpProxyUrlOrEmpty(urlRaw);
  } catch (_) {
    return '';
  }
}

module.exports = {
  normalizeProxyUrlString,
  parseHttpProxyUrlOrEmpty,
  createHttpsProxyAgent,
  resolveGlobalProxyUrl,
  resolveMetadataProxyUrl,
};
