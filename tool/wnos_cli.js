#!/usr/bin/env node
/**
 * ⭐ 2026-10-16 P2-19：WaterNasOS 无头 CLI（Agent 友好）。
 *
 * 设计要点：
 *   1) **不依赖 Electron / 不直连数据库** —— 纯 Node 标准库，通过 HTTP 调服务端的 MCP 端点。
 *      这样它能跑在任意机器上（CI、手机 Termux、Agent 沙箱），只要有 Node ≥ 18（自带 fetch）。
 *   2) 输出格式可选 `json / pretty / table / ndjson / csv`，方便管道进 jq / 表格工具。
 *   3) 与 MCP 共用同一只读 token（同一个攻击面、同一套可见性规则）。
 *   4) 只读：本 CLI 不做任何写操作（写操作仍走 App / 未来的 Agent 写计划通道）。
 *
 * 用法：
 *   export WNOS_URL=http://127.0.0.1:6789
 *   export WNOS_TOKEN=wnos_xxxxxxxx
 *   node tool/wnos_cli.js stats
 *   node tool/wnos_cli.js search "夕阳下的沙滩" --limit 20 --format table
 *   node tool/wnos_cli.js recent --days 7 --format ndjson
 *   node tool/wnos_cli.js image <file_hash> --limit 30
 *   node tool/wnos_cli.js scenes --limit 100 --format csv
 *   node tool/wnos_cli.js people
 *   node tool/wnos_cli.js rpc tools/list        # 原始透传，便于调试 MCP 客户端
 */
'use strict';

const CMD_TO_TOOL = {
  search: 'photos_search',
  recent: 'photos_recent',
  scenes: 'photos_scenes',
  people: 'photos_people',
  stats: 'photos_stats',
  image: 'photos_search_by_image',
};

const FORMATS = ['json', 'pretty', 'table', 'ndjson', 'csv'];

function usage() {
  console.log(`WaterNasOS CLI（只读）\n
用法: wnos_cli.js [全局选项] <命令> [参数]\n
命令:
  search <查询词>        按自然语言/关键词搜照片（场景/活动/OCR/文件名）
  recent [--days 7]      最近 N 天的照片
  scenes                 场景相册列表
  people                 人物（人脸分组）列表
  stats                  照片库概览
  image <file_hash>      以图搜图（CLI 版）
  rpc <method> [json]    原始 MCP JSON-RPC 透传（如 tools/list）
  tools                  列出服务端可用工具

全局选项:
  --url <base>          服务端地址，默认 $WNOS_URL 或 http://127.0.0.1:6789
  --token <token>       MCP token，默认 $WNOS_TOKEN
  --format <fmt>        ${FORMATS.join(' | ')}（默认 pretty；list 型命令默认 table）
  --limit <n>           条数上限
  --days <n>            recent 的天数
  -h, --help            帮助`);
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') {
      out.help = true;
      continue;
    }
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        out[key] = next;
        i += 1;
      } else {
        out[key] = true;
      }
      continue;
    }
    out._.push(a);
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (args.help || args._.length === 0) {
  usage();
  process.exit(args.help ? 0 : 1);
}

const base = String(args.url || process.env.WNOS_URL || 'http://127.0.0.1:6789').replace(/\/+$/, '');
const token = String(args.token || process.env.WNOS_TOKEN || '').trim();
if (!token) {
  console.error('缺少 token：用 --token 或设置环境变量 WNOS_TOKEN（App 里「设置 → AI → MCP」查看）');
  process.exit(2);
}

async function rpc(method, params) {
  const res = await fetch(`${base}/api/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch (_) {}
  if (res.status === 401) throw new Error('token 无效（401）');
  if (res.status === 403) throw new Error('MCP 服务已关闭（403）');
  if (!json) throw new Error(`服务端返回非 JSON（HTTP ${res.status}）：${text.slice(0, 200)}`);
  if (json.error) throw new Error(`JSON-RPC 错误 ${json.error.code}: ${json.error.message}`);
  return json.result;
}

async function callTool(name, toolArgs) {
  const result = await rpc('tools/call', { name, arguments: toolArgs });
  const text = result && result.content && result.content[0] ? result.content[0].text : '';
  if (result && result.isError) throw new Error(text || '工具执行失败');
  try {
    return JSON.parse(text);
  } catch (_) {
    return text;
  }
}

function flatten(kind, payload) {
  if (kind === 'search' || kind === 'recent') {
    return {
      rows: (payload.photos || []).map(p => ({
        filename: p.filename,
        shot_at: p.shot_at || '',
        type: p.type,
        path: p.fullpath,
      })),
      meta: {
        total: payload.total,
        returned: payload.returned !== undefined ? payload.returned : (payload.photos || []).length,
        recognized: payload.recognized || null,
      },
    };
  }
  if (kind === 'scenes') return { rows: payload.scenes || [], meta: { total: payload.total } };
  if (kind === 'people') return { rows: payload.people || [], meta: { total: payload.total } };
  if (kind === 'image') {
    return {
      rows: (payload.photos || []).map(p => ({
        file_hash: p.file_hash,
        filename: p.filename,
        similarity: p.similarity,
        type: p.type,
        path: p.fullpath,
      })),
      meta: { available: payload.available, scanned: payload.scanned },
    };
  }
  return { rows: [], meta: payload };
}

function printRaw(payload, opts) {
  const compact = String(opts.format || '') === 'json';
  console.log(JSON.stringify(payload, null, compact ? 0 : 2));
}

function printTable(rows) {
  if (!rows.length) {
    console.log('(空)');
    return;
  }
  const cols = Object.keys(rows[0]);
  const width = {};
  for (const c of cols) {
    width[c] = Math.max(c.length, ...rows.map(r => String(r[c] === undefined || r[c] === null ? '' : r[c]).length));
  }
  const line = c => String(c).padEnd(width[c]);
  console.log(cols.map(line).join('  '));
  console.log(cols.map(c => '-'.repeat(width[c])).join('  '));
  for (const r of rows) console.log(cols.map(c => line(r[c] === undefined || r[c] === null ? '' : r[c])).join('  '));
}

function csvEscape(v) {
  const s = String(v === undefined || v === null ? '' : v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function main() {
  const cmd = args._[0];
  const limit = args.limit ? Number(args.limit) : undefined;

  if (cmd === 'tools') {
    printRaw(await rpc('tools/list'), args);
    return;
  }

  if (cmd === 'rpc') {
    const method = args._[1];
    if (!method) throw new Error('rpc 需要 method，例如：rpc tools/list');
    let params;
    if (args._[2]) {
      try {
        params = JSON.parse(args._[2]);
      } catch (e) {
        throw new Error('第三个参数必须是合法 JSON');
      }
    }
    printRaw(await rpc(method, params), args);
    return;
  }

  const tool = CMD_TO_TOOL[cmd];
  if (!tool) throw new Error(`未知命令：${cmd}（用 --help 看用法）`);

  const toolArgs = {};
  if (cmd === 'search' || cmd === 'image') {
    const q = args._[1];
    if (!q) throw new Error(`${cmd} 需要参数：${cmd === 'search' ? '<查询词>' : '<file_hash>'}`);
    if (cmd === 'search') toolArgs.query = q;
    else toolArgs.file_hash = q;
  }
  if (limit) toolArgs.limit = limit;
  if (cmd === 'recent' && args.days) toolArgs.days = Number(args.days);

  const payload = await callTool(tool, toolArgs);
  const { rows, meta } = flatten(cmd, payload);
  const format = String(args.format || (rows.length ? 'table' : 'pretty'));

  if (format === 'json') {
    console.log(JSON.stringify(payload));
  } else if (format === 'pretty') {
    console.log(JSON.stringify(payload, null, 2));
  } else if (format === 'ndjson') {
    for (const r of rows) console.log(JSON.stringify(r));
  } else if (format === 'csv') {
    if (!rows.length) {
      console.log('');
    } else {
      const cols = Object.keys(rows[0]);
      console.log(cols.join(','));
      for (const r of rows) console.log(cols.map(c => csvEscape(r[c])).join(','));
    }
  } else {
    printTable(rows);
  }

  // 表格/CSV 模式下把元信息丢到 stderr，避免污染管道
  if (!['json', 'pretty'].includes(format) && meta) {
    const brief = JSON.stringify(meta);
    if (brief !== '{}') console.error(`# ${brief}`);
  }
}

main().catch(err => {
  console.error(`错误：${err && err.message ? err.message : err}`);
  process.exit(1);
});
