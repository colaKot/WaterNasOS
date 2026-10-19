'use strict';
/**
 * OpenAPI 3 规格生成（把「已注册的路由」变成单一真源）。
 *
 * 设计取舍（对标 Immich 的「OpenAPI 为单一真源、SDK 由它生成」，但代码一行没参考）：
 *   Immich 用 NestJS 装饰器在写接口时同时产出 schema。我们是 Express + 手写路由，
 *   逐条补 DTO 注解的工程量极大且容易半途而废。
 *   所以这里先做**能自动化的那部分**：从真实挂载的 Express 路由表里把
 *   「方法 + 路径 + 是否要求鉴权」抽出来，产出一份**合法的、可用的** OpenAPI 文档。
 *
 * 它现在已经能提供三件实事：
 *   1) 接口清单（http 方法 / 完整路径）—— 前后端对齐、写客户端 SDK 的骨架；
 *   2) **鉴权覆盖审计**：列出所有「没有 authenticateJWT」的接口。
 *      这正是我们踩过的坑（`appAccessGuard` 未登记前缀一律放行），
 *      有了清单就能定期核对，而不是出事才发现；
 *   3) 未来生成 Dart/TS 客户端的输入（补齐 DTO 后即可自动生成）。
 *
 * ⚠️ 明确没做的：请求体/响应体的 schema。那需要逐接口写注解，
 *    属于「后续增量」，本文件里用 `x-schema-status: todo` 显式标出来，
 *    ⛔ 不假装它已经有了。
 */

const LOGIN_REQUIRED = 'authenticateJWT';

/**
 * Express 4 把挂载路径编码在 layer.regexp 里，这里把它解回字符串。
 * 形如 `/^\/api\/auth\/?(?=\/|$)/i` → `/api/auth`
 */
function decodeMountPath(regexp) {
  if (!regexp) return '';
  let s = String(regexp.source || regexp);
  if (s === '^\\/?(?=\\/|$)' || s === '^/?(?=/|$)') return '';
  s = s.replace(/^\^/, '');
  s = s.replace(/\\\//g, '/');
  // 去掉结尾的 /?(?=/|$)
  s = s.replace(/\/\?\(\?=\/\|\$\)$/, '');
  s = s.replace(/\/\?\(\?=\\\/\|\$\)$/, '');
  s = s.replace(/\(\?=\/\|\$\)$/, '');
  s = s.replace(/\(\?=\\\/\|\$\)$/, '');
  s = s.replace(/\$$/, '');
  if (s === '/') return '';
  return s;
}

/** layer / route 上的处理函数名（用来判断有没有鉴权中间件） */
function handlerNames(stack) {
  const out = [];
  for (const layer of Array.isArray(stack) ? stack : []) {
    const h = layer && layer.handle;
    if (!h) continue;
    if (typeof h.name === 'string' && h.name) out.push(h.name);
  }
  return out;
}

/**
 * 递归收集路由。
 * @returns {Array<{method:string, path:string, handlers:string[], secured:boolean, source:string}>}
 */
function collectRoutes(router, prefix, out) {
  const layers = (router && router.stack) || [];
  for (const layer of layers) {
    if (!layer) continue;

    if (layer.route && layer.route.path !== undefined) {
      const handlers = handlerNames(layer.route.stack);
      const path = joinPath(prefix, layer.route.path);
      const methods = Object.keys(layer.route.methods || {}).filter((m) => layer.route.methods[m]);
      for (const method of methods) {
        out.push({
          method: method.toUpperCase(),
          path,
          handlers,
          secured: handlers.indexOf(LOGIN_REQUIRED) !== -1,
          source: 'route',
        });
      }
      continue;
    }

    // 挂载的子路由
    const sub = layer.handle && layer.handle.stack;
    if (Array.isArray(sub)) {
      const mount = decodeMountPath(layer.regexp);
      collectRoutes(layer.handle, joinPath(prefix, mount), out);
    }
  }
  return out;
}

function joinPath(a, b) {
  const left = String(a || '').replace(/\/+$/, '');
  const right = String(b || '');
  if (!right) return left || '/';
  if (right === '/') return left || '/';
  const merged = `${left}${right.startsWith('/') ? '' : '/'}${right}`;
  // 统一成 express 风格的 :param（{id} → :id）
  return merged.replace(/\{(\w+)\}/g, ':$1');
}

/** 把 express 的 :param 转成 OpenAPI 的 {param}，并抽出参数列表 */
function toOpenApiPath(p) {
  const params = [];
  const out = String(p).replace(/:([A-Za-z_]\w*)/g, (_, name) => {
    params.push({ name, in: 'path', required: true, schema: { type: 'string' } });
    return `{${name}}`;
  });
  // 通配符（如 /getDecodeFile*）没法表达成标准 path，标记出来而不是硬塞
  const wildcard = out.indexOf('*') !== -1;
  return { path: out, params, wildcard };
}

function tagFor(p) {
  const m = /^\/api\/([^/]+)/.exec(String(p));
  // 带点的段（如 openapi.json）不是业务模块，归到 meta
  if (m && m[1].indexOf('.') !== -1) return 'meta';
  if (m) return m[1];
  const m2 = /^\/([^/]+)/.exec(String(p));
  return m2 ? m2[1] : 'root';
}

/**
 * 构建 OpenAPI 3.0 文档。
 * @param {any} app express app
 * @param {{version?:string, title?:string, baseUrl?:string}} [meta]
 */
function buildSpec(app, meta = {}) {
  const router = app && app._router;
  const routes = collectRoutes(router, '', []);

  const paths = {};
  const unsecured = [];
  for (const r of routes) {
    const conv = toOpenApiPath(r.path);
    if (conv.wildcard) {
      // 通配路由（文件流之类）不进标准 path，单独列出来
      continue;
    }
    if (!paths[conv.path]) paths[conv.path] = {};
    const op = {
      tags: [tagFor(r.path)],
      operationId: `${r.method.toLowerCase()}_${conv.path.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '')}`,
      parameters: conv.params,
      responses: { 200: { description: '成功（响应体 schema 待补）' } },
      'x-auth-required': r.secured,
      'x-schema-status': 'todo',
    };
    if (r.secured) op.security = [{ bearerAuth: [] }];
    else unsecured.push(`${r.method} ${r.path}`);
    paths[conv.path][r.method.toLowerCase()] = op;
  }

  const sortedPaths = {};
  for (const k of Object.keys(paths).sort()) sortedPaths[k] = paths[k];

  const tags = [...new Set(Object.values(sortedPaths).flatMap((m) => Object.values(m).flatMap((o) => o.tags)))].sort();

  return {
    openapi: '3.0.3',
    info: {
      title: meta.title || 'WaterNasOS Server API',
      version: meta.version || '0.0.0',
      description:
        '由 `src/api/openapi.js` 从**真实挂载的 Express 路由表**自动生成。\n\n' +
        '· `x-auth-required` 表示该接口是否挂了 authenticateJWT（用于鉴权覆盖审计）\n' +
        '· `x-schema-status: todo` 表示请求/响应 schema 尚未补注解 —— 这是显式标注，不是遗漏\n',
    },
    servers: [{ url: meta.baseUrl || '/' }],
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      },
    },
    tags: tags.map((t) => ({ name: t })),
    paths: sortedPaths,
    'x-summary': {
      route_count: routes.length,
      path_count: Object.keys(sortedPaths).length,
      wildcard_skipped: routes.filter((r) => String(r.path).indexOf('*') !== -1).length,
      unsecured_count: unsecured.length,
      unsecured: unsecured.sort(),
    },
  };
}

/** Express 处理函数：GET /api/openapi.json */
function openApiHandler(req, res) {
  try {
    const app = req.app;
    const spec = buildSpec(app, {
      version: process.env.APP_VERSION || require('../../package.json').version || '0.0.0',
    });
    res.set('Cache-Control', 'no-store');
    return res.json(spec);
  } catch (err) {
    return res.status(500).json({ success: false, message: 'openapi build failed', code: 'OPENAPI_BUILD_FAILED' });
  }
}

module.exports = { buildSpec, openApiHandler, collectRoutes, decodeMountPath, toOpenApiPath };
