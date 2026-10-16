const express = require('express');
const crypto = require('crypto');
const Logger = require('../../../utils/logger');
const knexUtil = require('../../../db/knexUtil');
const dbUtil = require('../../../db/dbUtil');
const tableConfig = require('../../../db/table/tableConfig');
const photoPathQueryUtil = require('../photo/timeline/photoPathQueryUtil');
const photoTimeLineService = require('../photo/timeline/photoTimeLineService');
const PlacesService = require('../photo/places/placesService');
const FaceService = require('../photo/face/faceService');
const ResponseUtil = require('../../apiUtils/responseUtil');
const { authenticateJWT, requireSuperAdmin } = require('../../middleware/authMiddleware');

/**
 * ⭐ 2026-10-16 P2-18：MCP Server（只读）。
 *
 * 目的：把本机的照片库**以只读方式**暴露给 Agent（Claude Code / OpenClaw / Pi 等 MCP 客户端），
 * 让它能"看"到用户的照片，而不是把 NAS 变成一个可被 AI 乱改的库。
 *
 * 设计上沿用同一类硬约束（出处与对比见 docs/WaterNasOS-整合实施路线图.md §5 P2-18）：
 *   1) **只读**：六个工具全是查询，没有任何写/删/移动；MCP 侧连"提议写操作"都不给（那属于 P2-20）。
 *   2) **独立 token**：`wnos_` 前缀 + scope（默认 `photos:read`），与登录 JWT 完全分离；
 *      泄漏一个 token 不等于泄漏账号（不能改密码、不能访问别的模块）。
 *   3) **可见性零角色例外**：token 绑定一个 uid，工具一律按该 uid 的 photo_source 过滤，
 *      `isAdmin` 在这里没有任何特殊待遇 —— 与相册读取层同一口径。
 *   4) **无状态**：一次 POST 一个 JSON-RPC（MCP Streamable HTTP 允许直接返回 JSON）。
 *
 * 传输：`POST /api/mcp`（JSON-RPC 2.0）。
 * 鉴权：`Authorization: Bearer <token>`（管理接口走 JWT，见文件末尾的 /status 等）。
 * 协议版本：2024-11-05。
 */
const CONFIG_KEY = 'mcp_server_config';
const PROTOCOL_VERSION = '2024-11-05';
const SERVER_NAME = 'WaterNasOS';
const SERVER_VERSION = '1.0.0';
const TOKEN_PREFIX = 'wnos_';
const DEFAULT_SCOPES = ['photos:read'];

function newToken() {
  return TOKEN_PREFIX + crypto.randomBytes(24).toString('base64url');
}

function maskToken(token) {
  const t = String(token || '');
  if (t.length <= 12) return t ? '****' : '';
  return `${t.slice(0, 8)}…${t.slice(-4)}`;
}

async function readConfig() {
  try {
    const raw = await tableConfig.getConfigByKey(CONFIG_KEY);
    if (!raw) return null;
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch (_) {
    return null;
  }
}

async function saveConfig(cfg) {
  await tableConfig.setConfigByKey(CONFIG_KEY, JSON.stringify(cfg || {}));
  return cfg;
}

/** 默认归属：第一个超管（这样开箱即用就能看到全部照片源） */
async function defaultOwnerUid() {
  try {
    const knex = knexUtil.getInstance(dbUtil.DB_PATHS.MAIN_DB);
    const row = await knex('user').where({ type: 'super_admin' }).orderBy('id', 'asc').first();
    return row && row.id ? Number(row.id) : 0;
  } catch (_) {
    return 0;
  }
}

/** 首次访问自动建配置（默认 enabled=true，方便用户复制 token 去配置客户端） */
async function ensureConfig() {
  let cfg = await readConfig();
  if (cfg && cfg.token) return cfg;
  cfg = {
    enabled: true,
    token: newToken(),
    uid: await defaultOwnerUid(),
    scopes: DEFAULT_SCOPES,
    create_time: new Date().toISOString(),
  };
  await saveConfig(cfg);
  Logger.info(`[mcp] 已自动生成只读 token（uid=${cfg.uid}）；在「AI 设置」或 GET /api/mcp/status 里查看`);
  return cfg;
}

/** 构造一个"该 token 代表谁"的用户对象（type 从库里查，不写死成 admin） */
async function buildUser(cfg) {
  const uid = Number(cfg && cfg.uid) || 0;
  let type = 'super_admin';
  try {
    const knex = knexUtil.getInstance(dbUtil.DB_PATHS.MAIN_DB);
    const row = await knex('user').where({ id: uid }).first();
    if (row && row.type) type = String(row.type);
  } catch (_) {}
  return { id: uid, type, username: `mcp#${uid}` };
}

function photoKnex() {
  return knexUtil.getInstance(dbUtil.DB_PATHS.PHOTO_DB);
}

function toMs(v) {
  if (v === undefined || v === null || v === '') return 0;
  if (typeof v === 'number') return v;
  const n = Number(v);
  if (Number.isFinite(n)) return n;
  const d = new Date(String(v));
  return Number.isFinite(d.getTime()) ? d.getTime() : 0;
}

const mapPhoto = item => ({
  filename: item && item.filename ? String(item.filename) : '',
  fullpath: item && item.path ? `${item.path}${require('path').sep}${item.filename}` : '',
  shot_at: item && item.original_time ? new Date(Number(item.original_time)).toISOString() : null,
  type: Number(item && item.type) === 2 ? 'video' : 'image',
});

// ------------------------------------------------------------------ 六个只读工具

const TOOL_DEFS = [
  {
    name: 'photos_search',
    description:
      '按自然语言或关键词搜索照片/视频。支持场景标签（如"海边""雪山""日落"）、活动标签（如"游泳""大笑""合影"）、OCR 文字（票面/截图/路牌上的字）、文件名、路径与相机型号。返回最相关的条目。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '查询词或一句自然语言，如「夕阳下的沙滩」' },
        limit: { type: 'integer', description: '返回条数，默认 20，最大 100' },
      },
      required: ['query'],
    },
  },
  {
    name: 'photos_search_by_image',
    description:
      '以图搜图：给一张库内照片的 file_hash，返回视觉上最相似的其它照片（CLIP 图像嵌入余弦）。',
    inputSchema: {
      type: 'object',
      properties: {
        file_hash: { type: 'string', description: '库内照片的 file_hash（可由 photos_search 得到）' },
        limit: { type: 'integer', description: '返回条数，默认 20，最大 100' },
      },
      required: ['file_hash'],
    },
  },
  {
    name: 'photos_recent',
    description: '列出最近 N 天的照片/视频（按拍摄时间倒序）。',
    inputSchema: {
      type: 'object',
      properties: {
        days: { type: 'integer', description: '最近多少天，默认 7，最大 3650' },
        limit: { type: 'integer', description: '返回条数，默认 30，最大 100' },
      },
    },
  },
  {
    name: 'photos_scenes',
    description: '列出场景相册（场景识别结果）及各自的照片数。',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: '返回条数，默认 50，最大 200' },
      },
    },
  },
  {
    name: 'photos_people',
    description: '列出已识别的人物（人脸分组）及各自的照片数；未命名人物返回 name 为空。',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: '返回条数，默认 50，最大 200' },
      },
    },
  },
  {
    name: 'photos_stats',
    description: '照片库概览：照片/视频数量、占用空间、时间跨度、场景数、人物数、活动数。',
    inputSchema: { type: 'object', properties: {} },
  },
];

function clampLimit(v, def, max) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.min(max, Math.floor(n));
}

async function callTool(name, args, cfg) {
  const user = await buildUser(cfg);
  const validPaths = await photoTimeLineService.getValidPaths(user);
  const a = args || {};

  if (name === 'photos_search') {
    const query = String(a.query || '').trim();
    if (!query) throw new Error('query 不能为空');
    const limit = clampLimit(a.limit, 20, 100);
    // 语义解析（只解析不查库）：让 Agent 知道"系统把这句话理解成了什么"
    let parsed = { tags: [], unmatched: [], activities: [] };
    try {
      parsed = await new PlacesService(photoKnex()).parseQuery({ query });
    } catch (_) {}
    const res = await photoTimeLineService.getTimelinePhotoList(
      {
        search: query,
        startTime: 1,
        endTime: Date.now() + 86400000,
        sort: 'desc',
        page: 1,
        pageSize: limit,
      },
      user
    );
    // ⚠️ 服务层的 getTimelinePhotoList 返回的是**数组**（分页在控制器/客户端做），不是 {list,total}；
    // 只有 validPaths 为空时才返回 {list:[],total:0}。两种都得接。
    const all = Array.isArray(res) ? res : (Array.isArray(res && res.list) ? res.list : []);
    const photos = all.slice(0, limit);
    return {
      query,
      recognized: {
        scenes: parsed.tags || [],
        activities: (parsed.activities || []).map(x => x.act_name).filter(Boolean),
        unmatched: parsed.unmatched || [],
      },
      total: all.length,
      returned: photos.length,
      photos: photos.map(mapPhoto),
    };
  }

  if (name === 'photos_search_by_image') {
    const fileHash = String(a.file_hash || '').trim();
    if (!fileHash) throw new Error('file_hash 不能为空');
    const limit = clampLimit(a.limit, 20, 100);
    const out = await new PlacesService(photoKnex()).searchByImage({
      file_hash: fileHash,
      limit,
      validPaths,
    });
    return {
      available: !!(out && out.available),
      scanned: Number(out && out.scanned) || 0,
      photos: ((out && out.items) || []).map(x => ({
        file_hash: x.file_hash,
        filename: x.filename,
        fullpath: x.fullpath,
        type: Number(x.type) === 2 ? 'video' : 'image',
        similarity: x.score,
      })),
    };
  }

  if (name === 'photos_recent') {
    const days = clampLimit(a.days, 7, 3650);
    const limit = clampLimit(a.limit, 30, 100);
    const end = Date.now() + 86400000;
    const start = end - days * 86400000;
    const res = await photoTimeLineService.getTimelinePhotoList(
      { startTime: start, endTime: end, sort: 'desc', page: 1, pageSize: limit },
      user
    );
    const all = Array.isArray(res) ? res : (Array.isArray(res && res.list) ? res.list : []);
    return {
      days,
      total: all.length,
      photos: all.slice(0, limit).map(mapPhoto),
    };
  }

  if (name === 'photos_scenes') {
    const limit = clampLimit(a.limit, 50, 200);
    const out = await new PlacesService(photoKnex()).listPlaces({
      status: 'visible',
      validPaths,
    });
    const items = ((out && out.items) || []).slice(0, limit).map(x => ({
      scene: x.place_name,
      photo_count: Number(x.photo_count) || 0,
    }));
    return { total: Number((out && out.pagination && out.pagination.total) || items.length), scenes: items };
  }

  if (name === 'photos_people') {
    const limit = clampLimit(a.limit, 50, 200);
    const out = await new FaceService(photoKnex()).listFaces({
      page: 1,
      pageSize: limit,
      status: 'visiable',
      validPaths,
    });
    const items = ((out && out.items) || []).map(x => ({
      face_id: Number(x.faceId || x.face_id) || 0,
      name: x.name || '',
      photo_count: Number(x.faceCount || x.face_count) || 0,
    }));
    return { total: Number((out && out.pagination && out.pagination.total) || items.length), people: items };
  }

  if (name === 'photos_stats') {
    const knex = photoKnex();
    const scope = () => {
      const q = knex('photo_index as p').where('p.is_file', 1).where('p.in_trash', 0);
      if (validPaths.length > 0) photoPathQueryUtil.applyPathPrefixFilter(q, 'p.path', validPaths);
      else q.whereRaw('1 = 0');
      return q;
    };
    const one = async (q) => {
      const r = await q.count({ n: 'p.id' }).first().catch(() => null);
      return Number((r && r.n) || 0) || 0;
    };
    const photos = await one(scope().clone().where('p.type', 1));
    const videos = await one(scope().clone().where('p.type', 2));
    const bytesRow = await scope()
      .clone()
      .sum({ s: 'p.size' })
      .first()
      .catch(() => null);
    const rangeRow = await scope()
      .clone()
      .where('p.original_time', '>', 0)
      .min({ mn: 'p.original_time' })
      .max({ mx: 'p.original_time' })
      .first()
      .catch(() => null);
    const sceneRow = await knex('photo_places')
      .where('is_hide', 0)
      .where('photo_count', '>', 0)
      .count({ n: 'place_name' })
      .first()
      .catch(() => null);
    const peopleRow = await knex('photo_faces')
      .where(function () {
        this.whereNull('belong_face_id').orWhere('belong_face_id', 0);
      })
      .where('is_hide', 0)
      .count({ n: 'face_id' })
      .first()
      .catch(() => null);
    const activityRow = await knex('photo_activity').where('is_hide', 0).count({ n: 'act_key' }).first().catch(() => null);
    return {
      photos,
      videos,
      bytes: Number((bytesRow && bytesRow.s) || 0) || 0,
      earliest: rangeRow && rangeRow.mn ? new Date(toMs(rangeRow.mn)).toISOString() : null,
      latest: rangeRow && rangeRow.mx ? new Date(toMs(rangeRow.mx)).toISOString() : null,
      scenes: Number((sceneRow && sceneRow.n) || 0) || 0,
      activities: Number((activityRow && activityRow.n) || 0) || 0,
      people: Number((peopleRow && peopleRow.n) || 0) || 0,
    };
  }

  throw new Error(`未知工具：${name}`);
}

function hasScope(cfg, scope) {
  const scopes = Array.isArray(cfg && cfg.scopes) ? cfg.scopes : DEFAULT_SCOPES;
  return scopes.includes(scope);
}

// ------------------------------------------------------------------ 路由

const router = express.Router();

/** MCP 专用鉴权：Bearer token（不是 JWT，也不碰 appAccessGuard） */
async function mcpAuth(req, res, next) {
  try {
    const cfg = await ensureConfig();
    if (!cfg.enabled) {
      return res.status(403).json({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'MCP server disabled' } });
    }
    const auth = String(req.headers.authorization || '');
    const token = auth.replace(/^Bearer\s+/i, '').trim() || String(req.headers['x-mcp-token'] || '').trim();
    if (!token || token !== String(cfg.token)) {
      return res.status(401).json({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'invalid or missing token' } });
    }
    req.mcpConfig = cfg;
    next();
  } catch (err) {
    Logger.error('[mcp] auth error', err);
    return res.status(500).json({ jsonrpc: '2.0', id: null, error: { code: -32603, message: 'internal error' } });
  }
}

router.get('/', (req, res) => {
  res.setHeader('Allow', 'POST');
  res.status(405).json({
    error: 'MCP 端点只接受 POST（JSON-RPC 2.0）。管理接口见 /api/mcp/status',
  });
});

router.post('/', mcpAuth, async (req, res) => {
  const body = req.body || {};
  const hasId = Object.prototype.hasOwnProperty.call(body, 'id') && body.id !== null;

  // 通知类消息（没有 id）按 JSON-RPC 规范不回包
  if (!hasId) return res.status(202).end();

  const { id, method, params } = body;
  const cfg = req.mcpConfig;

  try {
    if (method === 'initialize') {
      res.setHeader('Mcp-Session-Id', crypto.randomBytes(12).toString('hex'));
      return res.json({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
          instructions:
            'WaterNasOS 照片库（只读）。六个工具全部是查询，没有任何写操作；所有结果都限制在 token 绑定用户自己的照片源内。',
        },
      });
    }

    if (method === 'ping') {
      return res.json({ jsonrpc: '2.0', id, result: {} });
    }

    if (method === 'tools/list') {
      return res.json({ jsonrpc: '2.0', id, result: { tools: TOOL_DEFS } });
    }

    if (method === 'tools/call') {
      const name = params && params.name ? String(params.name) : '';
      if (!hasScope(cfg, 'photos:read')) {
        return res.json({
          jsonrpc: '2.0',
          id,
          result: {
            isError: true,
            content: [{ type: 'text', text: 'token 缺少 photos:read scope' }],
          },
        });
      }
      try {
        const payload = await callTool(name, params && params.arguments, cfg);
        return res.json({
          jsonrpc: '2.0',
          id,
          result: { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] },
        });
      } catch (err) {
        // 工具级错误按 MCP 约定返回 isError，而不是 JSON-RPC error（让模型能看到并自我修正）
        return res.json({
          jsonrpc: '2.0',
          id,
          result: {
            isError: true,
            content: [{ type: 'text', text: `工具 ${name} 执行失败：${err && err.message ? err.message : err}` }],
          },
        });
      }
    }

    return res.json({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
  } catch (err) {
    Logger.error('[mcp] dispatch error', err);
    return res.json({ jsonrpc: '2.0', id, error: { code: -32603, message: String((err && err.message) || err) } });
  }
});

// ------------------------------------------------------------------ 管理接口（走登录 JWT，仅超管）

router.get('/status', authenticateJWT, requireSuperAdmin, async (req, res) => {
  try {
    const cfg = await ensureConfig();
    return ResponseUtil.success(
      req,
      res,
      {
        enabled: cfg.enabled !== false,
        tokenMasked: maskToken(cfg.token),
        uid: Number(cfg.uid) || 0,
        scopes: Array.isArray(cfg.scopes) ? cfg.scopes : DEFAULT_SCOPES,
        endpoint: '/api/mcp',
        protocol: PROTOCOL_VERSION,
        tools: TOOL_DEFS.map(t => t.name),
      },
      'common.SUCCESS',
      200
    );
  } catch (err) {
    Logger.error('[mcp] status error', err);
    return ResponseUtil.error(req, res, 'common.ERROR', 500);
  }
});

router.post('/config/set', authenticateJWT, requireSuperAdmin, async (req, res) => {
  try {
    const cfg = await ensureConfig();
    const body = req.body || {};
    if (body.enabled !== undefined) cfg.enabled = body.enabled === true || body.enabled === 1 || body.enabled === '1';
    if (body.uid !== undefined) {
      const uid = Number(body.uid);
      if (Number.isFinite(uid) && uid >= 0) cfg.uid = uid;
    }
    if (Array.isArray(body.scopes) && body.scopes.length > 0) cfg.scopes = body.scopes.map(String);
    await saveConfig(cfg);
    return ResponseUtil.success(req, res, { enabled: cfg.enabled, uid: cfg.uid, scopes: cfg.scopes }, 'common.SUCCESS', 200);
  } catch (err) {
    Logger.error('[mcp] config/set error', err);
    return ResponseUtil.error(req, res, 'common.ERROR', 500);
  }
});

/** 轮换 token：旧 token 立刻失效（泄漏时的应急动作） */
router.post('/token/rotate', authenticateJWT, requireSuperAdmin, async (req, res) => {
  try {
    const cfg = await ensureConfig();
    cfg.token = newToken();
    cfg.rotate_time = new Date().toISOString();
    await saveConfig(cfg);
    // 只在轮换这一刻明文返回一次，之后只能用 status 看掩码
    return ResponseUtil.success(req, res, { token: cfg.token }, 'common.SUCCESS', 200);
  } catch (err) {
    Logger.error('[mcp] rotate error', err);
    return ResponseUtil.error(req, res, 'common.ERROR', 500);
  }
});

module.exports = router;
// 供离线测试脚本直接调工具实现（见 tool/_mcp_e2e.js）
module.exports.__test = { callTool, TOOL_DEFS, ensureConfig, readConfig, TOOL_NAMES: TOOL_DEFS.map(t => t.name) };
