'use strict';
/**
 * 极简插件（扩展点）机制。
 *
 * ⭐ 定位（设计取向参考 Immich 的插件/扩展点思路，代码未参考其实现）：
 *    Immich 用 Extism/WASM 跑插件，换来**沙箱隔离**，代价是插件要编译成 wasm、
 *    宿主需要一套宿主函数 ABI —— 那是个大工程，不适合现在就上。
 *    这里先做**最小的那一层**：显式钩子 + 目录扫描 + 错误隔离。
 *    它解决的是「内核里到处都是硬编码的 if 分支」这个真问题，
 *    而不是「让第三方安全地跑代码」那个问题。
 *
 * ⛔⛔ 安全边界（必须说清楚，不许含糊）：
 *    · **没有沙箱**。插件就是普通的 Node 模块，`require` 得到，等同于在服务端进程里跑代码。
 *    · 因此默认**全局关闭**（配置键 `plugin_enable`，缺省 0）。开启 = 你信任 plugins/ 目录里的代码。
 *    · 不要把它当成「用户可上传插件」的功能来做 —— 那需要 WASM 级别的隔离，这里没有。
 *
 * 插件目录布局（`<根目录>/plugins/<id>/`）：
 *    plugin.json   { "id": "...", "name": "...", "version": "1.0.0", "description": "...",
 *                    "hooks": ["afterDuplicateResolve"] }
 *    index.js      module.exports = { afterDuplicateResolve: async (payload) => { ... } }
 *
 * ⛔ 铁律：**钩子名必须是 HOOKS 白名单里的**。写错的钩子名一律报错，
 *    而不是静默不生效 —— 静默不生效是插件系统最难查的一类问题。
 */

const fs = require('fs');
const path = require('path');
const Logger = require('../utils/logger');
const tableConfig = require('../db/table/tableConfig');

/**
 * 允许的钩子名（白名单）。
 * 新增钩子要同时：①加到这里 ②在内核里 emit 它 ③更新本文档注释。
 */
const HOOKS = [
  // 重复清理「合并元数据 + 送回收站」完成之后
  // payload: { keepHash, keepId, trashHashes, trashed, merged, bytesFreed, uid, operationId }
  'afterDuplicateResolve',
];

const PLUGIN_DIR_NAME = 'plugins';

function resolvePluginRoot() {
  try {
    const config = require('../config/config');
    return path.join(config.getRootPath(), PLUGIN_DIR_NAME);
  } catch (_) {
    return path.join(__dirname, '..', '..', PLUGIN_DIR_NAME);
  }
}

/** 插件是否被允许加载（默认关） */
async function isEnabled() {
  try {
    const raw = await tableConfig.getConfigByKey('plugin_enable');
    return String(raw) === '1';
  } catch (_) {
    return false;
  }
}

function readManifest(dir) {
  const file = path.join(dir, 'plugin.json');
  if (!fs.existsSync(file)) return { error: '缺少 plugin.json' };
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    return { error: `plugin.json 不是合法 JSON：${err.message}` };
  }
  const id = String(raw.id || '').trim();
  if (!id) return { error: 'plugin.json 缺少 id' };
  if (id !== path.basename(dir)) return { error: `id(${id}) 与目录名(${path.basename(dir)}) 不一致` };
  const hooks = Array.isArray(raw.hooks) ? raw.hooks.map(String) : [];
  const unknown = hooks.filter((h) => HOOKS.indexOf(h) === -1);
  if (unknown.length > 0) {
    return { error: `未知钩子：${unknown.join(', ')}（白名单：${HOOKS.join(', ')}）` };
  }
  return {
    meta: {
      id,
      name: String(raw.name || id),
      version: String(raw.version || '0.0.0'),
      description: String(raw.description || ''),
      hooks,
      dir,
    },
  };
}

class PluginBus {
  constructor() {
    this.root = resolvePluginRoot();
    this.loaded = [];
    this.errors = [];
    this.loadedAt = null;
    this.enabled = false;
  }

  /**
   * 懒加载：只在第一次真正需要时才扫目录/require 插件。
   * ⭐ 这样**不需要改服务端启动流程** —— 少动启动链路就少一分把服务搞起不来的风险。
   */
  async ensureLoaded() {
    if (this.loadedAt) return this;
    await this.load();
    return this;
  }

  /** 扫描目录并（在启用时）加载插件。可重复调用（会先清空）。 */
  async load(force = false) {
    this.enabled = force ? true : await isEnabled();
    this.loaded = [];
    this.errors = [];
    this.loadedAt = new Date().toISOString();

    if (!fs.existsSync(this.root)) return { enabled: this.enabled, loaded: [], errors: [] };

    let dirs = [];
    try {
      dirs = fs
        .readdirSync(this.root, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => path.join(this.root, d.name));
    } catch (err) {
      this.errors.push({ dir: this.root, error: `读取插件目录失败：${err.message}` });
      return { enabled: this.enabled, loaded: [], errors: this.errors };
    }

    for (const dir of dirs) {
      const { meta, error } = readManifest(dir);
      if (error) {
        this.errors.push({ dir, error });
        continue;
      }
      const entry = { ...meta, handlers: {}, loadError: null };
      if (!this.enabled) {
        // 未启用：只登记元数据，**不 require**（绝不执行未授权代码）
        this.loaded.push(entry);
        continue;
      }
      try {
        // ⚠️ 必须先清 require 缓存 —— 否则 `reload` 端点刷不到改过的插件代码
        //    （Node 的 require 是带缓存的，第二次 require 直接返回旧模块）。
        const entryPath = path.join(dir, 'index.js');
        try {
          delete require.cache[require.resolve(entryPath)];
        } catch (_) {}
        const mod = require(entryPath);
        for (const hook of meta.hooks) {
          const fn = mod && mod[hook];
          if (typeof fn !== 'function') {
            entry.handlers[hook] = null;
            entry.loadError = `index.js 未导出钩子实现：${hook}`;
            continue;
          }
          entry.handlers[hook] = fn;
        }
        if (!entry.loadError) Logger.info(`[plugin] 已加载 ${meta.id}@${meta.version}（${meta.hooks.join(', ')}）`);
      } catch (err) {
        entry.loadError = err && err.message ? err.message : String(err);
        Logger.error(`[plugin] 加载失败 ${meta.id}: ${entry.loadError}`);
      }
      this.loaded.push(entry);
    }

    if (this.errors.length > 0) {
      for (const e of this.errors) Logger.warn(`[plugin] 跳过 ${e.dir}：${e.error}`);
    }
    return { enabled: this.enabled, loaded: this.loaded, errors: this.errors };
  }

  /**
   * 触发钩子。
   * ⛔ 错误必须隔离：**任何一个插件抛错都不能影响宿主**（这是插件系统的基本契约）。
   * @returns {Promise<{hook:string, called:number, failed:number}>}
   */
  async emit(hook, payload) {
    if (HOOKS.indexOf(hook) === -1) {
      Logger.warn(`[plugin] emit 了白名单外的钩子：${hook}（已忽略）`);
      return { hook, called: 0, failed: 0 };
    }
    await this.ensureLoaded();
    if (!this.enabled) return { hook, called: 0, failed: 0 };
    let called = 0;
    let failed = 0;
    for (const p of this.loaded) {
      const fn = p.handlers && p.handlers[hook];
      if (typeof fn !== 'function') continue;
      try {
        await fn(payload);
        called += 1;
      } catch (err) {
        failed += 1;
        Logger.error(`[plugin] ${p.id}.${hook} 抛错（已隔离，不影响宿主）：${err && err.message ? err.message : err}`);
      }
    }
    return { hook, called, failed };
  }

  /** 供 API 展示 */
  status() {
    return {
      enabled: this.enabled,
      root: this.root,
      loaded_at: this.loadedAt,
      available_hooks: HOOKS,
      count: this.loaded.length,
      plugins: this.loaded.map((p) => ({
        id: p.id,
        name: p.name,
        version: p.version,
        description: p.description,
        hooks: p.hooks,
        handlers_bound: Object.values(p.handlers || {}).filter((f) => typeof f === 'function').length,
        load_error: p.loadError,
      })),
      errors: this.errors,
    };
  }
}

const bus = new PluginBus();

module.exports = { HOOKS, bus, resolvePluginRoot, isEnabled };
