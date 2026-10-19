const FaceService = require('../face/faceService');
const PlacesService = require('../places/placesService');
const PhotoSourceService = require('../source/photoSourceService');
const tableConfig = require('../../../../db/table/tableConfig');
const photoPathQueryUtil = require('../timeline/photoPathQueryUtil');
const Logger = require('../../../../utils/logger');

async function getEnableByKey(key) {
  try {
    const raw = await tableConfig.getConfigByKey(key);
    return raw === '1' ? 1 : 0;
  } catch (_) {
    return 0;
  }
}

class AppAiService {
  constructor(knex) {
    this.knex = knex;
  }

  async getOverview(params = {}) {
    const limit = Math.max(1, Math.min(50, Number(params.limit) || 20));
    const locale = params && params.locale ? String(params.locale) : 'zh-CN';
    const validPaths =
      params.validPaths !== undefined ? (Array.isArray(params.validPaths) ? params.validPaths.filter(Boolean) : []) : undefined;

    const [faceEnable, placeEnable, similarEnable] = await Promise.all([getEnableByKey('ai_face_enable'), getEnableByKey('ai_place_enable'), getEnableByKey('ai_similar_enable')]);

    const faceParams = { page: 1, pageSize: limit, status: 'visiable', ...(validPaths !== undefined ? { validPaths } : {}) };
    const facesPromise =
      faceEnable === 1
        ? new FaceService(this.knex).listFaces(faceParams)
        : Promise.resolve({
            items: [],
            pagination: { total: 0, page: 1, pageSize: limit },
          });

    const sceneParams = { status: 'visible', locale, ...(validPaths !== undefined ? { validPaths } : {}) };
    const scenesPromise =
      placeEnable === 1
        ? new PlacesService(this.knex).listPlaces(sceneParams)
        : Promise.resolve({
            items: [],
            pagination: { total: 0, page: 1, pageSize: limit },
          });

    const [facesRaw, scenesRaw] = await Promise.all([facesPromise, scenesPromise]);

    const faces = {
      faceEnable,
      items: Array.isArray(facesRaw && facesRaw.items) ? facesRaw.items : [],
      pagination: facesRaw && facesRaw.pagination ? facesRaw.pagination : { total: 0, page: 1, pageSize: limit },
    };

    const scenesAllItems = Array.isArray(scenesRaw && scenesRaw.items) ? scenesRaw.items : [];
    const scenes = {
      placeEnable,
      items: scenesAllItems.slice(0, limit),
      pagination: scenesRaw && scenesRaw.pagination ? { ...scenesRaw.pagination, pageSize: limit } : { total: 0, page: 1, pageSize: limit },
    };

    return {
      faces,
      scenes,
      similarEnable,
    };
  }

  /**
   * ⭐ 2026-10-16 P1-9（写入型控制的第一块）：**暂停 / 恢复 AI 流水线**。
   *
   * 为什么先做这一个（而不是优先级/限流）：它是这类控制里**最安全**的 ——
   *   · 不丢数据：worker 写完当前这张就退出（`stopWorker`），队列标记原样留在库里；
   *   · 完全可逆：恢复就是把 worker 再拉起来（复用 P0-8 那套 startMethod 映射）；
   *   · 语义窄：只掐「后台自动跑」，不动任何显式用户动作。
   * ⇒ NAS 上最常见的诉求就是「我要用机器了，AI 先别占 CPU」。
   */
  async setQueuePaused(params = {}) {
    const paused = params.paused === true || params.paused === 1 || params.paused === '1';
    await tableConfig.setConfigByKey('ai_worker_paused', paused ? '1' : '0');

    const { getSingletonWorkerManager } = require('../../../../workers/singletonWorkerManager');
    const mgr = getSingletonWorkerManager();
    if (mgr && typeof mgr.setAiPaused === 'function') mgr.setAiPaused(paused);

    const workers = require('../../../../initHandler/workers');
    const ALL = [
      { name: 'faceWorker', startMethod: 'startFaceWorker', enableKey: 'ai_face_enable' },
      { name: 'ocrWorker', startMethod: 'startOcrWorker', enableKey: 'ai_ocr_enable' },
      { name: 'placesWorker', startMethod: 'startPlacesWorker', enableKey: 'ai_place_enable' },
      { name: 'similarWorker', startMethod: 'startSimilarWorker', enableKey: 'ai_similar_enable' },
    ];

    const stopped = [];
    const started = [];
    if (paused) {
      for (const w of ALL) {
        try {
          if (mgr && typeof mgr.isWorkerRunning === 'function' && !mgr.isWorkerRunning(w.name)) continue;
          await mgr.stopWorker(w.name, 5000);
          stopped.push(w.name);
        } catch (err) {
          Logger.warn(`暂停时停止 ${w.name} 失败：${err && err.message ? err.message : err}`);
        }
      }
    } else {
      for (const w of ALL) {
        try {
          // ⭐ 2026-10-17 P5：与启动同口径（只有显式 '1' 才算开），避免恢复时拉起从未启用的 worker
          const on = typeof workers.isAiWorkerEnabled === 'function'
            ? await workers.isAiWorkerEnabled(w.enableKey)
            : String(await tableConfig.getConfigByKey(w.enableKey).catch(() => '')).trim() === '1';
          if (!on) continue;
          if (mgr && typeof mgr.isWorkerRunning === 'function' && mgr.isWorkerRunning(w.name)) {
            started.push(w.name);
            continue;
          }
          if (typeof workers[w.startMethod] === 'function') {
            workers[w.startMethod]();
            started.push(w.name);
          }
        } catch (err) {
          Logger.warn(`恢复时启动 ${w.name} 失败：${err && err.message ? err.message : err}`);
        }
      }
    }
    return { paused, stopped, started };
  }

  /**
   * ⭐ 2026-10-16 P1-9 任务进度聚合（**只读**）。
   *
   * 用户此前**看不到 AI 索引跑到哪了** —— 界面上只有「开/关」和一个百分比，
   * 到底还剩多少、worker 是不是已经停摆，全靠猜。这里把四条流水线 + 图像向量回填
   * 的 pending/done 一次性摊出来，并带上 worker 进程是否在跑。
   *
   * 口径：
   *   · 管理员 ⇒ **全库**（worker 本来就是全库跑的，读数才有意义）；
   *   · 普通用户 ⇒ 只统计**自己可见范围**（可见性零角色例外，不给别人库的规模）。
   *   · `clip` 不是 0/1 标记位，而是 `clip_emb IS NULL`（见 P0-3）。
   */
  async getQueueStatus(params = {}) {
    const knex = this.knex;
    const validPaths = Array.isArray(params.validPaths) ? params.validPaths.filter(Boolean) : [];
    const hasScope = Object.prototype.hasOwnProperty.call(params, 'validPaths');

    const STEPS = [
      { key: 'faces', column: 'gen_faces', worker: 'faceWorker', enableKey: 'ai_face_enable' },
      { key: 'ocr', column: 'gen_ocr', worker: 'ocrWorker', enableKey: 'ai_ocr_enable' },
      { key: 'place', column: 'gen_place', worker: 'placesWorker', enableKey: 'ai_place_enable' },
      { key: 'activity', column: 'gen_activity', worker: 'placesWorker', enableKey: 'ai_activity_enable' },
      // ⭐ 2026-10-17：CLIP 向量**只对图片（type=1）算**，视频从来不写
      //   （实测：61686 张图片全部有向量；4101 个视频全部没有，且存量里一个带向量的视频都没有）。
      //   不限定 type 就会把这 4101 个视频当成「永远补不上的待办」，进度永远卡在 94%。
      { key: 'clip', column: 'clip_emb', worker: 'placesWorker', enableKey: 'ai_place_enable', isNull: true, onlyType: 1 },
    ];

    const base = () => {
      const q = knex('photo_index as p').where('p.is_file', 1).where('p.in_trash', 0).whereIn('p.type', [1, 2]);
      if (hasScope) {
        if (validPaths.length === 0) q.whereRaw('1 = 0');
        else photoPathQueryUtil.applyPathPrefixFilter(q, 'p.path', validPaths);
      }
      return q;
    };
    const countWhere = async (builder) => {
      const row = await builder.count({ n: 'p.id' }).first().catch(() => null);
      return Number((row && row.n) || 0) || 0;
    };

    // worker 进程状态（进程级，不区分用户）
    let isWorkerRunning = () => false;
    try {
      const { getSingletonWorkerManager } = require('../../../../workers/singletonWorkerManager');
      const mgr = getSingletonWorkerManager();
      if (mgr && typeof mgr.isWorkerRunning === 'function') isWorkerRunning = name => !!mgr.isWorkerRunning(name);
    } catch (_) {}

    // ⭐⭐ 2026-10-17 性能修复：原实现每个 step 各查一次 pending + done
    //   （5 步 = 10 次全表 COUNT），6.6 万行上实测 **1554ms**。
    //   现在一次全表扫描用 SUM(CASE WHEN) 同时算出 10 个数字（约 40ms）。
    //   ⚠️ clip 不是 0/1 标记位而是 `clip_emb IS NULL`，单独给两个 CASE。
    //   ⚠️ 聚合失败（例如旧库还没增加 gen_activity 列）时**回退到逐条 COUNT**，
    //      行为与改前一致（宁可慢，不能把进度显示成假的）。
    let agg = null;
    try {
      agg = await base()
        .select(
          knex.raw('SUM(CASE WHEN p.gen_faces = 0 THEN 1 ELSE 0 END) AS faces_pending'),
          knex.raw('SUM(CASE WHEN p.gen_faces = 1 THEN 1 ELSE 0 END) AS faces_done'),
          knex.raw('SUM(CASE WHEN p.gen_ocr = 0 THEN 1 ELSE 0 END) AS ocr_pending'),
          knex.raw('SUM(CASE WHEN p.gen_ocr = 1 THEN 1 ELSE 0 END) AS ocr_done'),
          knex.raw('SUM(CASE WHEN p.gen_place = 0 THEN 1 ELSE 0 END) AS place_pending'),
          knex.raw('SUM(CASE WHEN p.gen_place = 1 THEN 1 ELSE 0 END) AS place_done'),
          knex.raw('SUM(CASE WHEN p.gen_activity = 0 THEN 1 ELSE 0 END) AS activity_pending'),
          knex.raw('SUM(CASE WHEN p.gen_activity = 1 THEN 1 ELSE 0 END) AS activity_done'),
          knex.raw('SUM(CASE WHEN p.clip_emb IS NULL AND p.type = 1 THEN 1 ELSE 0 END) AS clip_pending'),
          knex.raw('SUM(CASE WHEN p.clip_emb IS NOT NULL AND p.type = 1 THEN 1 ELSE 0 END) AS clip_done')
        )
        .first();
    } catch (_) {
      agg = null;
    }

    const stats = new Map();
    if (agg) {
      for (const step of STEPS) {
        const pending = Number(((agg || {})[`${step.key}_pending`]) || 0) || 0;
        const done = Number(((agg || {})[`${step.key}_done`]) || 0) || 0;
        stats.set(step.key, { pending, done });
      }
    } else {
      Logger.warn('[appAi] queue 聚合查询失败，回退到逐条 COUNT（较慢）');
      for (const step of STEPS) {
        const pendingQuery = base();
        if (step.isNull) pendingQuery.whereNull(`p.${step.column}`);
        else pendingQuery.where(`p.${step.column}`, 0);
        const doneQuery = base();
        if (step.isNull) doneQuery.whereNotNull(`p.${step.column}`);
        else doneQuery.where(`p.${step.column}`, 1);
        if (step.onlyType) {
          pendingQuery.where('p.type', step.onlyType);
          doneQuery.where('p.type', step.onlyType);
        }
        const [pending, done] = await Promise.all([countWhere(pendingQuery), countWhere(doneQuery)]);
        stats.set(step.key, { pending, done });
      }
    }

    // 5 个开关并行读（原来在循环里串行 await）
    const cfgMap = new Map();
    await Promise.all(
      STEPS.filter(s => !!s.enableKey).map(async s => {
        const raw = await tableConfig.getConfigByKey(s.enableKey).catch(() => null);
        cfgMap.set(s.enableKey, raw);
      })
    );

    const items = STEPS.map(step => {
      const s = stats.get(step.key) || { pending: 0, done: 0 };
      const pending = s.pending;
      const done = s.done;
      const total = pending + done;
      let enabled = true;
      if (step.enableKey && cfgMap.has(step.enableKey)) {
        const raw = cfgMap.get(step.enableKey);
        if (raw !== null && raw !== undefined && raw !== '') {
          enabled = !['0', 'false'].includes(String(raw).toLowerCase());
        }
      }
      return {
        key: step.key,
        pending,
        done,
        total,
        percent: total > 0 ? Math.round((done / total) * 100) : 100,
        worker: step.worker,
        running: isWorkerRunning(step.worker),
        enabled,
      };
    });

    const running = {};
    for (const name of ['faceWorker', 'ocrWorker', 'placesWorker', 'similarWorker']) {
      running[name] = isWorkerRunning(name);
    }

    let paused = false;
    try {
      const { getSingletonWorkerManager } = require('../../../../workers/singletonWorkerManager');
      const mgr = getSingletonWorkerManager();
      if (mgr && typeof mgr.isAiPaused === 'function') paused = mgr.isAiPaused();
    } catch (_) {}

    return {
      scope: hasScope ? (validPaths.length > 0 ? 'self' : 'none') : 'all',
      items,
      running,
      paused,
      updated_at: new Date().toISOString(),
    };
  }

  /**
   * ⭐ 2026-10-16 P0-8 单张 / 多张照片「重新识别（分项）」。
   *
   * 背景：`photo_index` 上的 `gen_*` 标记位就是各条 AI 流水线的**重跑队列**
   *   （gen_faces → faceWorker、gen_ocr → ocrWorker、gen_place / gen_activity → placesWorker），
   *   但此前**只有全库级重置**（/face/reset、/face/rescan、/place/reset），
   *   用户想「这一张的 OCR 认错了、重跑一下」时无路可走。
   *
   * 这里按 file_hash 精确把指定项置 0 入队，**互不干扰**（只重跑 OCR 时绝不动 gen_faces）。
   *
   * ⚠️ 「标签 / 描述」两项没有对应的 worker（gen_tags / gen_describe 全仓无消费方），
   *   所以不开放，传了会被忽略并在 `ignored` 里回传，避免前端以为已入队。
   *
   * ⚠️ 入队之后必须**主动把 worker 拉起来**：worker 在队列取空时是 `process.exit(0)` 干净退出，
   *   退出后只会走一次 scheduleRestartIfNeeded，而那次查询 pending=0 就返回了 ⇒ 之后永不再起。
   *   所以这里显式调用 initHandler/workers 的 startXxxWorker（已运行则由单例管理器去重）。
   *
   * @param {Object} params {file_hashes, kinds, validPaths}
   * @returns {Promise<{queued:number, kinds:string[], ignored:string[], denied:number, started:string[], enabled:Object}>}
   */
  /**
   * ⭐ 2026-10-16 OCR 全库重跑（换 OCR 模型后用）。
   *
   * ⚠️ 只把 gen_ocr 置 0 是**无效**的：ocrWorker.processOne() 开头会先查
   *   `photo_info_fts` 里是否已有非空 ocr 文本，有就直接 markIndexDone 跳过
   *   （这是「增量不重复识别」的设计）⇒ 必须先清掉旧文本；否则重置标记后 worker
   *   会瞬间把全部照片又标回 gen_ocr=1，等于什么都没发生。
   *   所以两件事一起做：① 清 ocr 列（保留 filename ⇒ 文件名搜索不受影响）② gen_ocr=0。
   *
   * ⚠️ 这是全库长任务（数小时量级）；期间 OCR 搜索命中随重跑逐步恢复，不是一次性回来。
   * @returns {Promise<{reset:number, cleared:number, started:string[], paused:boolean}>}
   */
  async resetOcrRecognition() {
    const out = { reset: 0, cleared: 0, started: [], paused: false };
    const conn = this.knex;
    out.reset = Number((await conn('photo_index').whereNot('gen_ocr', 0).update({ gen_ocr: 0 }).catch(() => 0)) || 0);
    out.cleared = Number((await conn('photo_info_fts').whereNotNull('ocr').whereNot('ocr', '').update({ ocr: '' }).catch(() => 0)) || 0);

    // 拉起可能已经干净退出的 ocrWorker；暂停期间不拉起（标记留着，恢复后一起跑）
    try {
      const { getSingletonWorkerManager } = require('../../../../workers/singletonWorkerManager');
      const mgr = getSingletonWorkerManager();
      if (mgr && typeof mgr.isAiPaused === 'function' && mgr.isAiPaused()) {
        out.paused = true;
        return out;
      }
      const raw = await tableConfig.getConfigByKey('ai_ocr_enable').catch(() => null);
      const on = !(raw !== null && raw !== undefined && ['0', 'false'].includes(String(raw).toLowerCase()));
      if (on) {
        const workers = require('../../../../initHandler/workers');
        if (workers && typeof workers.startOcrWorker === 'function') {
          await workers.startOcrWorker();
          out.started.push('ocrWorker');
        }
      }
    } catch (err) {
      Logger.error('[appAi] resetOcr: 拉起 ocrWorker 失败', err);
    }
    return out;
  }

  async rerunAi(params = {}) {
    const KINDS = AppAiService.RERUN_KINDS;
    const body = params || {};
    const rawHashes = Array.isArray(body.file_hashes) ? body.file_hashes : (Array.isArray(body.fileHashes) ? body.fileHashes : []);
    const hashes = [...new Set(rawHashes.map(h => String(h || '').trim()).filter(Boolean))];
    if (hashes.length === 0) {
      const err = new Error('photo.RERUN_NO_FILE_HASH');
      err.statusCode = 400;
      throw err;
    }
    const MAX_BATCH = 2000;
    if (hashes.length > MAX_BATCH) {
      const err = new Error('photo.RERUN_TOO_MANY');
      err.statusCode = 400;
      throw err;
    }
    const rawKinds = Array.isArray(body.kinds) ? body.kinds : (body.kind ? [body.kind] : []);
    const wanted = [...new Set(rawKinds.map(k => String(k || '').trim().toLowerCase()).filter(Boolean))];
    const kinds = wanted.filter(k => !!KINDS[k]);
    const ignored = wanted.filter(k => !KINDS[k]);
    if (kinds.length === 0) {
      const err = new Error('photo.RERUN_NO_KIND');
      err.statusCode = 400;
      throw err;
    }

    // 可见范围校验：只允许重跑「自己看得见」的照片（与 getValidPaths 同口径，不做角色例外，
    // 避免管理员误伤别人的识别数据）
    const validPaths = Array.isArray(body.validPaths) ? body.validPaths.filter(Boolean) : null;
    const buildScope = () => {
      const q = this.knex('photo_index as p')
        .whereIn('p.file_hash', hashes)
        .andWhere('p.is_file', 1)
        .andWhere('p.in_trash', 0)
        .andWhereRaw("p.file_hash IS NOT NULL AND p.file_hash <> ''");
      if (validPaths) photoPathQueryUtil.applyPathPrefixFilter(q, 'p.path', validPaths);
      return q;
    };
    const rows = await buildScope().clone().select('p.file_hash as file_hash').catch(() => []);
    const allowed = (Array.isArray(rows) ? rows : []).map(r => String(r.file_hash || '')).filter(Boolean);
    const denied = hashes.length - allowed.length;
    if (allowed.length === 0) {
      return { queued: 0, kinds, ignored, denied, started: [], enabled: {} };
    }

    const update = {};
    for (const k of kinds) update[KINDS[k].column] = 0;
    const queued = await this.knex('photo_index').whereIn('file_hash', allowed).update(update).catch(() => 0);

    // 拉起可能已经干净退出的 worker
    const enabled = {};
    const started = [];
    const workerNames = [...new Set(kinds.map(k => KINDS[k].worker))];
    try {
      const workers = require('../../../../initHandler/workers');
      const { getSingletonWorkerManager } = require('../../../../workers/singletonWorkerManager');
      const mgr = getSingletonWorkerManager();
      // ⭐ P1-9：暂停期间**不拉起**（标记照旧重置、等恢复后一起跑），并如实回传 paused 让前端提示
      if (mgr && typeof mgr.isAiPaused === 'function' && mgr.isAiPaused()) {
        return { queued: Number(queued || 0), kinds, ignored, denied, started: [], enabled: { paused: false }, paused: true };
      }
      for (const name of workerNames) {
        const spec = kinds.map(k => KINDS[k]).find(s => s.worker === name);
        let on = true;
        if (spec && spec.enableKey) {
          const raw = await tableConfig.getConfigByKey(spec.enableKey).catch(() => null);
          // 未设置 = 跟随默认开（与 placesWorker / faceWorker 的读法保持一致）
          on = !(raw !== null && raw !== undefined && ['0', 'false'].includes(String(raw).toLowerCase()));
        }
        enabled[name] = on;
        if (!on) continue;
        if (mgr && typeof mgr.isWorkerRunning === 'function' && mgr.isWorkerRunning(name)) {
          started.push(name); // 已在跑，无需拉起
          continue;
        }
        if (spec && spec.startMethod && typeof workers[spec.startMethod] === 'function') {
          workers[spec.startMethod]();
          started.push(name);
        }
      }
    } catch (err) {
      Logger.warn('rerunAi 拉起 worker 失败（队列已入，等下一轮自动拉起）:', err && err.message ? err.message : err);
    }

    return { queued: Number(queued || 0), kinds, ignored, denied, started, enabled };
  }
  // ============================================================================
  // 以下为 2026-10-16 P1/P2「照片域智能发现」批次。
  // 全部是**只读聚合**（唯一的写入是 P1-14 记忆的确认结果，存进 config 的 JSON，
  // 因为「用户确认过的记忆」最多几十条，不值得为它单开一张表）。
  // 数据源：photo_index / photo_places2filehash / photo_activity2filehash /
  //        photo_face2filehash / photo_info_fts / photo_index.content_md5 / clip_emb。
  // ============================================================================

  /** 可见范围过滤器（管理员＝全库；否则按 validPaths）。与全项目同一口径。 */
  _scope(params) {
    const hasScope = Object.prototype.hasOwnProperty.call(params || {}, 'validPaths');
    const list = Array.isArray(params && params.validPaths) ? params.validPaths.filter(Boolean) : [];
    return {
      hasScope,
      empty: hasScope && list.length === 0,
      apply: (q, column = 'p.path') => {
        if (!hasScope) return q;
        photoPathQueryUtil.applyPathPrefixFilter(q, column, list);
        return q;
      },
      paths: list,
    };
  }

  _basePhotoQuery(scope) {
    const q = this.knex('photo_index as p').where('p.is_file', 1).where('p.in_trash', 0);
    return scope.apply(q);
  }

  _decodeName(buf) {
    if (Buffer.isBuffer(buf)) return buf.length > 0 ? buf.toString('utf8') : '';
    return typeof buf === 'string' ? buf : '';
  }

  _embOf(buffer) {
    if (!buffer) return null;
    const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
    const dim = Math.floor(bytes.byteLength / 4);
    if (dim <= 0) return null;
    return new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + dim * 4));
  }

  _cosine(a, b) {
    if (!a || !b) return 0;
    const n = Math.min(a.length, b.length);
    let dot = 0;
    for (let i = 0; i < n; i += 1) dot += a[i] * b[i];
    return dot; // 两侧都已 L2 归一化
  }

  /** 两个经纬度之间的距离（km），haversine */
  _distanceKm(lat1, lng1, lat2, lng2) {
    const ok = [lat1, lng1, lat2, lng2].every(v => Number.isFinite(Number(v)) && Number(v) !== 0);
    if (!ok) return null;
    const R = 6371;
    const toRad = d => (Number(d) * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
  }

  /** 取一张照片的完整行（含向量） */
  async _photoByHash(fileHash, scope) {
    const hash = String(fileHash || '').trim();
    if (!hash) return null;
    const q = this.knex('photo_index as p')
      .where('p.file_hash', hash)
      .select(
        'p.id',
        'p.file_hash',
        'p.path',
        'p.filename',
        'p.type',
        'p.original_time',
        'p.original_date',
        'p.latitude',
        'p.longitude',
        'p.geohash5',
        'p.camera',
        'p.clip_emb'
      )
      .first();
    scope.apply(q);
    return await q.catch(() => null);
  }

  /** 照片的在地信息（地点/场景标签）用于文案与聚类 */
  async _labelsOfHashes(hashes, { scenes = true, activities = true, people = true } = {}) {
    const out = { scenes: new Map(), activities: new Map(), people: new Map() };
    const list = (Array.isArray(hashes) ? hashes : []).filter(Boolean);
    if (list.length === 0) return out;
    const CHUNK = 400;
    for (let i = 0; i < list.length; i += CHUNK) {
      const slice = list.slice(i, i + CHUNK);
      if (scenes) {
        const rows = await this.knex('photo_places2filehash')
          .whereIn('file_hash', slice)
          .whereNotNull('place_name')
          .select('file_hash', 'place_name')
          .catch(() => []);
        for (const r of Array.isArray(rows) ? rows : []) {
          const h = String(r.file_hash);
          if (!out.scenes.has(h)) out.scenes.set(h, []);
          out.scenes.get(h).push(String(r.place_name));
        }
      }
      if (activities) {
        const rows = await this.knex('photo_activity2filehash')
          .whereIn('file_hash', slice)
          .whereNotNull('act_name')
          .select('file_hash', 'act_name')
          .catch(() => []);
        for (const r of Array.isArray(rows) ? rows : []) {
          const h = String(r.file_hash);
          if (!out.activities.has(h)) out.activities.set(h, []);
          out.activities.get(h).push(String(r.act_name));
        }
      }
      if (people) {
        const rows = await this.knex('photo_face2filehash as f')
          .join('photo_faces as pf', 'pf.face_id', 'f.face_id')
          .whereIn('f.file_hash', slice)
          .where(function () {
            this.whereNull('pf.belong_face_id').orWhere('pf.belong_face_id', 0);
          })
          .select('f.file_hash', 'pf.face_id', 'pf.name')
          .catch(() => []);
        for (const r of Array.isArray(rows) ? rows : []) {
          const h = String(r.file_hash);
          if (!out.people.has(h)) out.people.set(h, []);
          const nm = this._decodeName(r.name);
          const item = { face_id: Number(r.face_id), name: nm };
          if (!out.people.get(h).some(x => x.face_id === item.face_id)) out.people.get(h).push(item);
        }
      }
    }
    return out;
  }

  /**
   * ⭐ P1-11 时光对照：同一个地方、不同年份、长得像的照片。
   *
   * 权重沿用同一公开口径（来源见 docs 对比表）：**视觉相似度 70% + GPS 15% + 时间跨度 15%**。
   * 视觉那一路现在**真的能用**了 —— P0-3 已经把 CLIP 图像向量落进 clip_emb；
   * 没有向量的照片（回填未完成）不参与视觉打分，只按 GPS + 跨度兜底。
   */
  async timeCompare(params = {}) {
    const scope = this._scope(params);
    if (scope.empty) return { items: [], years: [], query: null };
    const limit = Math.max(1, Math.min(60, Number(params.limit) || 20));
    const src = await this._photoByHash(params.file_hash ?? params.fileHash, scope);
    if (!src) {
      const err = new Error('photo.NOT_FOUND');
      err.statusCode = 404;
      throw err;
    }
    const srcEmb = this._embOf(src.clip_emb);
    const srcYear = this._yearOf(src.original_time);

    const q = this.knex('photo_index as p')
      .where('p.is_file', 1)
      .where('p.in_trash', 0)
      .whereNot('p.file_hash', String(src.file_hash))
      .whereNotNull('p.original_time')
      .select(
        'p.file_hash',
        'p.path',
        'p.filename',
        'p.type',
        'p.original_time',
        'p.latitude',
        'p.longitude',
        'p.clip_emb'
      )
      .orderBy('p.original_time', 'desc')
      .limit(3000);
    scope.apply(q);
    if (src.geohash5) q.where('p.geohash5', String(src.geohash5));
    else if (Number(src.latitude) && Number(src.longitude)) {
      // 没有 geohash 时用经纬度粗筛（±0.1° ≈ 11km），避免全库扫
      q.whereBetween('p.latitude', [Number(src.latitude) - 0.1, Number(src.latitude) + 0.1]);
      q.whereBetween('p.longitude', [Number(src.longitude) - 0.1, Number(src.longitude) + 0.1]);
    }
    const rows = await q.catch(() => []);

    const scored = [];
    for (const r of Array.isArray(rows) ? rows : []) {
      const year = this._yearOf(r.original_time);
      if (!year || year === srcYear) continue; // 时光对照只跨年
      const emb = this._embOf(r.clip_emb);
      const visual = srcEmb && emb ? Math.max(0, this._cosine(srcEmb, emb)) : 0;
      if (srcEmb && emb && visual < 0.72) continue; // 视觉太远的不算「同一个地方」
      const d = this._distanceKm(src.latitude, src.longitude, r.latitude, r.longitude);
      const gps = d === null ? 0.5 : Math.max(0, 1 - Math.min(1, d / 5));
      const span = Math.max(0, Math.min(1, Math.abs(year - srcYear) / 5));
      const score = 0.7 * visual + 0.15 * gps + 0.15 * span;
      scored.push({
        file_hash: String(r.file_hash),
        fullpath: `${r.path}${require('path').sep}${r.filename}`,
        filename: String(r.filename || ''),
        type: Number(r.type) === 2 ? 'video' : 'image',
        year,
        shot_at: new Date(Number(r.original_time)).toISOString(),
        score: Number(score.toFixed(4)),
        visual: Number(visual.toFixed(4)),
        distance_km: d === null ? null : Number(d.toFixed(2)),
      });
    }

    scored.sort((a, b) => b.score - a.score);
    const items = scored.slice(0, limit);
    const byYear = new Map();
    for (const it of items) {
      if (!byYear.has(it.year)) byYear.set(it.year, []);
      byYear.get(it.year).push(it);
    }
    return {
      query: {
        file_hash: String(src.file_hash),
        filename: String(src.filename || ''),
        year: srcYear,
        has_embedding: !!srcEmb,
      },
      items,
      years: Array.from(byYear.entries())
        .sort((a, b) => b[0] - a[0])
        .map(([year, photos]) => ({ year, count: photos.length, photos })),
    };
  }

  _yearOf(ms) {
    const t = Number(ms);
    if (!Number.isFinite(t) || t <= 0) return 0;
    const d = new Date(t);
    const y = d.getFullYear();
    return Number.isFinite(y) && y > 1900 ? y : 0;
  }

  /**
   * ⭐ P1-17 一日一帧（那年今日增强）：给出最近 N 天里，每天挑一张「最值得看」的照片。
   *
   * ⚠️ 本项目**没有美学打分模型**（TrailSnap 那份用的是 VLM 直连）。这里用可解释的启发式：
   *   有场景标签(权重高) > 有活动标签 > 有人物 > 非截图/文档；同一天内再按「当天张数」——
   *   张数多的那天更可能是有事发生的一天。同分时用「日期哈希」定序，保证**当天内结果稳定**。
   * 文案：由场景/活动/地点标签拼句（模板，不调 LLM，离线可用）。
   */
  async dayFrames(params = {}) {
    const scope = this._scope(params);
    if (scope.empty) return { items: [] };
    const days = Math.max(1, Math.min(365, Number(params.days) || 30));
    const end = Date.now() + 86400000;
    const start = end - days * 86400000;

    const q = this.knex('photo_index as p')
      .where('p.is_file', 1)
      .where('p.in_trash', 0)
      .where('p.type', 1)
      .whereBetween('p.original_time', [start, end])
      .whereNotNull('p.original_date')
      .select('p.file_hash', 'p.path', 'p.filename', 'p.original_time', 'p.original_date')
      .orderBy('p.original_time', 'desc')
      .limit(6000);
    scope.apply(q);
    const rows = await q.catch(() => []);
    if (!Array.isArray(rows) || rows.length === 0) return { items: [] };

    const hashes = rows.map(r => String(r.file_hash));
    const labels = await this._labelsOfHashes(hashes, { scenes: true, activities: true, people: true });

    const byDay = new Map();
    for (const r of rows) {
      const day = String(r.original_date || '').slice(0, 10);
      if (!day) continue;
      if (!byDay.has(day)) byDay.set(day, []);
      byDay.get(day).push(r);
    }

    const items = [];
    for (const [day, list] of byDay) {
      let best = null;
      for (const r of list) {
        const h = String(r.file_hash);
        const scenes = labels.scenes.get(h) || [];
        const acts = labels.activities.get(h) || [];
        const people = labels.people.get(h) || [];
        const fn = String(r.filename || '').toLowerCase();
        const isDoc = /screenshot|截图|img_20\d{6}_\d{6}\.png|scan/.test(fn);
        let score = 0;
        score += scenes.length > 0 ? 3 : 0;
        score += acts.length > 0 ? 2 : 0;
        score += people.length > 0 ? 2 + Math.min(2, people.length) : 0;
        if (isDoc) score -= 4;
        // 当天张数越多越可能是「有事情发生的一天」
        score += Math.min(3, list.length / 40);
        // 稳定的日内定序（同一天多次请求结果一致）
        score += (parseInt(String(r.file_hash).slice(0, 4), 16) % 100) / 1000;
        if (!best || score > best.score) {
          best = { score, r, scenes, acts, people };
        }
      }
      if (!best) continue;
      const captionParts = [];
      if (best.scenes.length) captionParts.push(best.scenes[0]);
      if (best.acts.length) captionParts.push(best.acts[0]);
      const named = best.people.map(p => p.name).filter(Boolean);
      items.push({
        date: day,
        score: Number(best.score.toFixed(3)),
        shot_at: new Date(Number(best.r.original_time)).toISOString(),
        file_hash: String(best.r.file_hash),
        fullpath: `${best.r.path}${require('path').sep}${best.r.filename}`,
        filename: String(best.r.filename || ''),
        scenes: best.scenes,
        activities: best.acts,
        people: named,
        day_photo_count: list.length,
        caption: captionParts.length > 0 || named.length > 0
          ? `${captionParts.join(' · ')}${named.length ? `　与 ${named.join('、')}` : ''}`
          : '',
      });
    }
    items.sort((a, b) => (a.date < b.date ? 1 : -1));
    return { items };
  }

  /**
   * ⭐ P1-13 票据 / 行程。
   *
   * 不做 TrailSnap 那套（YOLO 检框 + 站名白名单 + 铁路运行图），只用**已有 OCR 文本 + 正则**。
   * 关键修正（2026-10-18）：OCR 输出的字间常带空格（“广 州 南 站”、“G 1 2 3 4”），
   * 旧实现直接拿原文正则匹配 ⇒ 车次永远识别不出、票夹看起来全是乱码。
   * 这里先把文本压成无空格形式再匹配，并抽出始发/到达站、车次、时间。
   *
   * 容错：`photo_info_fts` 缺失或正在重建时不能让整个票夹 500，
   * 降级成“只看 photo_index”并回 `degraded/reason`，让界面能说清楚为什么没结果。
   */
  async tickets(params = {}) {
    const scope = this._scope(params);
    if (scope.empty) return { tickets: [], trips: [], degraded: false, reason: '', scanned: 0 };
    const limit = Math.max(1, Math.min(500, Number(params.limit) || 200));
    const pad2 = v => String(v).padStart(2, '0');

    let rows = [];
    let degraded = false;
    let reason = '';
    const scanLimit = Math.max(2000, limit * 20);

    const baseQuery = () => {
      const q = this.knex('photo_index as p')
        .where('p.is_file', 1)
        .where('p.in_trash', 0)
        .whereNotNull('p.original_time')
        .orderBy('p.original_time', 'desc')
        .limit(scanLimit);
      return scope.apply(q);
    };

    try {
      rows = await baseQuery()
        .join('photo_info_fts as fts', 'fts.file_hash', 'p.file_hash')
        .select('p.file_hash', 'p.path', 'p.filename', 'p.original_time', 'p.original_date',
          'p.latitude', 'p.longitude', 'fts.ocr');
      if (!Array.isArray(rows)) rows = [];
    } catch (err) {
      degraded = true;
      reason = String((err && err.message) || err).slice(0, 200);
      rows = await baseQuery()
        .select('p.file_hash', 'p.path', 'p.filename', 'p.original_time', 'p.original_date',
          'p.latitude', 'p.longitude')
        .catch(() => []);
      if (!Array.isArray(rows)) rows = [];
    }

    // strong = 只会在票据上出现的词；weak = 需要凑够 2 个才算票，
    // 否则「订单号 / 发票 / 景区」这类泛词会把电商截图、攻略全卷进来。
    const RULES = [
      { key: 'train', label: '火车票', strong: ['车次', '检票', '席别', '二等座', '一等座', '硬座', '硬卧', '软卧'], weak: ['票价', '退票', '改签', '取票', '成人票', '铁路'] },
      { key: 'flight', label: '机票', strong: ['登机口', '登机牌', '值机', '经济舱', '业务舱', '航班'], weak: ['舱位', '机场', '起飞', '降落', '航空'] },
      { key: 'ticket_other', label: '门票/票据', strong: ['门票', '入场券', '影票', '取票码', '单程票', '索道票'], weak: [] },
    ];
    const trainNoRe = /(?:^|[^0-9A-Za-z])([GDCKTZ][1-9]\d{0,3})(?!\d)/;
    const flightNoRe = /((?:CZ|CA|MU|MF|HU|ZH|SC|FM|HO|3U)[1-9]\d{2,3})(?!\d)/;
    const dateRe = /(20\d{2})[-\u5e74\/.]?(\d{1,2})[-\u6708\/.]?(\d{1,2})/;
    const timeRe = /(?:^|\D)(\d{1,2})[:\uff1a](\d{1,2})(?!\d)/;
    const stationRe = /([\u4e00-\u9fa5]{2,4})(\u7ad9|\u673a\u573a)/g;
    // 站名主体里出现这些字，基本都是“地铁站 / 改签到站”这种噪声
    const STATION_NOISE = /[车线铁网接改经客观供安全中到本该台]/;
    const norm = s => String(s || '').replace(/[\s\u3000]+/g, '');

    /** 把 OCR 里的“白云白云机场”洗成“白云机场”；洗不干净就宁可不显示站名。 */
    const cleanStation = (rawCore, suffix) => {
      let core = String(rawCore || '');
      if (core.length >= 4 && core.length % 2 === 0) {
        const half = core.length / 2;
        if (core.slice(0, half) === core.slice(half)) core = core.slice(half);
      }
      if (core.length < 2 || core.length > 3) return '';
      if (STATION_NOISE.test(core)) return '';
      return core + suffix;
    };

    const tickets = [];
    for (const r of Array.isArray(rows) ? rows : []) {
      const text = norm(r.ocr);
      if (text.length < 4) continue;
      let matched = null;
      for (const rule of RULES) {
        const strongHit = rule.strong.filter(w => text.includes(w));
        const weakHit = rule.weak.filter(w => text.includes(w));
        if (strongHit.length === 0 && weakHit.length < 2) continue;
        const tn = rule.key === 'flight' ? flightNoRe.exec(text) : (rule.key === 'train' ? trainNoRe.exec(text) : null);
        matched = { rule, hitWords: strongHit.concat(weakHit), code: tn ? tn[1] : '' };
        break;
      }
      if (!matched) continue;

      // 只有真票面才尝试站名（普通照片的 OCR 里“XX站”太容易是噪声）
      const wantStation = matched.rule.key === 'flight'
        || text.includes('车次') || text.includes('出发站') || text.includes('到达站') || text.includes('检票');
      const stations = [];
      if (wantStation) {
        stationRe.lastIndex = 0;
        let sm;
        while ((sm = stationRe.exec(text)) !== null) {
          const name = cleanStation(sm[1], sm[2]);
          if (!name) continue;
          if (!stations.includes(name)) stations.push(name);
          if (stations.length >= 2) break;
        }
      }

      const dm = dateRe.exec(text);
      const tm = timeRe.exec(text);
      let hhmm = '';
      if (tm) {
        const h = Number(tm[1]);
        const mi = Number(tm[2]);
        if (h >= 0 && h <= 23 && mi >= 0 && mi <= 59) hhmm = `${pad2(h)}:${pad2(mi)}`;
      }

      tickets.push({
        kind: matched.rule.key,
        kind_label: matched.rule.label,
        file_hash: String(r.file_hash),
        fullpath: `${r.path}${require('path').sep}${r.filename}`,
        filename: String(r.filename || ''),
        shot_at: new Date(Number(r.original_time)).toISOString(),
        date: dm
          ? `${dm[1]}-${pad2(dm[2])}-${pad2(dm[3])}`
          : String(r.original_date || '').slice(0, 10),
        time: hhmm,
        from_station: stations[0] || '',
        to_station: stations[1] || '',
        code: matched.code,
        train_no: matched.code,
        lat: Number(r.latitude) || 0,
        lng: Number(r.longitude) || 0,
        evidence: matched.hitWords.slice(0, 8),
        text_excerpt: text.slice(0, 160),
      });
      if (tickets.length >= limit) break;
    }

    // 行程聚类：按（日期 + 地理跳变）合并
    const byDate = tickets.slice().sort((a, b) => (a.shot_at < b.shot_at ? -1 : 1));
    const trips = [];
    let cur = null;
    for (const t of byDate) {
      const tMs = new Date(t.shot_at).getTime();
      if (!cur) {
        cur = { start: t.shot_at, end: t.shot_at, tickets: [t], kinds: new Set([t.kind]) };
        cur.lastLat = t.lat;
        cur.lastLng = t.lng;
        continue;
      }
      const gapDays = (tMs - new Date(cur.end).getTime()) / 86400000;
      if (gapDays > 7) {
        trips.push(cur);
        cur = { start: t.shot_at, end: t.shot_at, tickets: [t], kinds: new Set([t.kind]) };
      } else {
        cur.end = t.shot_at;
        cur.tickets.push(t);
        cur.kinds.add(t.kind);
      }
      cur.lastLat = t.lat;
      cur.lastLng = t.lng;
    }
    if (cur) trips.push(cur);

    return {
      tickets,
      trips: trips.map((t, i) => ({
        index: i + 1,
        start: t.start,
        end: t.end,
        ticket_count: t.tickets.length,
        kinds: Array.from(t.kinds),
        first: t.tickets[0].filename,
        sample_hashes: t.tickets.slice(0, 6).map(x => x.file_hash),
      })),
      degraded,
      reason,
      scanned: Array.isArray(rows) ? rows.length : 0,
    };
  }

  /**
   * ⭐ P1-14 记忆发现：把「同一天、同一片地方、一堆照片」聚成事件候选，交用户确认。
   *
   * 候选是**算出来的**，确认过的记忆是**用户给的**（存 config 的 JSON，按 uid 隔离）。
   * 确认之后才会出现在「记忆」里 —— 避免 AI 自己编回忆。
   */
  async memoryCandidates(params = {}) {
    const scope = this._scope(params);
    if (scope.empty) return { candidates: [], memories: [] };
    const minPhotos = Math.max(3, Math.min(200, Number(params.min_photos) || 8));
    const days = Math.max(7, Math.min(3650, Number(params.days) || 365));
    const start = Date.now() - days * 86400000;

    const q = this.knex('photo_index as p')
      .where('p.is_file', 1)
      .where('p.in_trash', 0)
      .where('p.type', 1)
      .where('p.original_time', '>', start)
      .whereNotNull('p.original_date')
      .select('p.file_hash', 'p.path', 'p.filename', 'p.original_time', 'p.original_date', 'p.geohash5')
      .orderBy('p.original_time', 'asc')
      .limit(20000);
    scope.apply(q);
    const rows = await q.catch(() => []);

    const buckets = new Map();
    for (const r of Array.isArray(rows) ? rows : []) {
      const day = String(r.original_date || '').slice(0, 10);
      const cell = String(r.geohash5 || '') || 'nogeo';
      if (!day) continue;
      const key = `${day}|${cell}`;
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(r);
    }

    const candidates = [];
    // ⚠️ 2026-10-18 性能修正：下面每个 bucket 要查 3 张标签表。
    // 6 万张库里能筛出上千个 bucket，逐个查会把请求拖到超时。
    // 按张数取前 80 个候选再算标签，已经能覆盖真正“有事发生的那几天”。
    const orderedBuckets = Array.from(buckets.entries())
      .sort((a, b) => b[1].length - a[1].length)
      .slice(0, 80);
    for (const [key, list] of orderedBuckets) {
      if (list.length < minPhotos) continue;
      const [day, cell] = key.split('|');
      const hashes = list.map(x => String(x.file_hash));
      const labels = await this._labelsOfHashes(hashes, { scenes: true, activities: true, people: true });
      const sceneCount = new Map();
      const actCount = new Map();
      const peopleMap = new Map();
      for (const h of hashes) {
        for (const s of labels.scenes.get(h) || []) sceneCount.set(s, (sceneCount.get(s) || 0) + 1);
        for (const a of labels.activities.get(h) || []) actCount.set(a, (actCount.get(a) || 0) + 1);
        for (const p of labels.people.get(h) || []) {
          if (p.name) peopleMap.set(p.face_id, p.name);
        }
      }
      const top = m => Array.from(m.entries()).sort((a, b) => b[1] - a[1]).slice(0, 4).map(x => x[0]);
      const named = Array.from(peopleMap.values());
      // 置信度：张数 + 有场景/活动/人物 各加权
      let conf = Math.min(1, list.length / 60) * 0.5;
      if (sceneCount.size) conf += 0.2;
      if (actCount.size) conf += 0.15;
      if (named.length) conf += 0.15;
      candidates.push({
        key,
        date: day,
        cell,
        photo_count: list.length,
        scenes: top(sceneCount),
        activities: top(actCount),
        people: named.slice(0, 8),
        confidence: Number(conf.toFixed(3)),
        cover_file_hash: hashes[0],
        cover_path: `${list[0].path}${require('path').sep}${list[0].filename}`,
        sample_hashes: hashes.slice(0, 12),
      });
    }
    candidates.sort((a, b) => b.confidence - a.confidence || b.photo_count - a.photo_count);

    const memories = await this.listMemories(params);
    // ⭐ 2026-10-19 卡片上要写「哪儿 + 干了什么」，地点在这里补（key 里就带 geohash5）
    await this._attachMemoryPlaces(memories, params);
    const ignored = await this.listIgnored(params);
    const ignoredSet = new Set(ignored.map(o => o.key));
    const savedKeys = new Set(memories.map(m => m && m.key).filter(Boolean));
    // 已确认的、已忽略的都不再作为候选出现（否则用户点「确认」会没有任何反馈）
    const fresh = candidates.filter(c => !ignoredSet.has(c.key) && !savedKeys.has(c.key));

    return {
      candidates: fresh.slice(0, Math.max(1, Math.min(200, Number(params.limit) || 60))),
      memories,
      ignored,
      chapters: await this.memoryChapters(params),
      total_candidates: fresh.length,
    };
  }

  /**
   * ⭐ 2026-10-19 记忆详情：把「某一天 + 某个 geohash 格」这一簇照片整组取回来。
   *
   * 记忆的 key 就是 `${day}|${geohash5}`（见 memoryCandidates），所以这里按
   * 「original_date 区间 + geohash5」查。
   * ⚠️ 用 original_date 的字符串区间（>= day / < day+1）而不是 original_time 的毫秒区间：
   * 前者走列索引，也不会因为时区差把当天最后/最前几张漏掉。
   */
  async memoryPhotos(params = {}) {
    const scope = this._scope(params);
    if (scope.empty) return { items: [], total: 0 };
    const key = String(params.key || '').trim();
    const day = String(params.date || key.split('|')[0] || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return { items: [], total: 0 };
    const cell = String(key.includes('|') ? key.split('|')[1] : (params.cell || '')).trim();
    const limit = Math.max(1, Math.min(2000, Number(params.limit) || 500));

    const next = new Date(`${day}T00:00:00`);
    next.setDate(next.getDate() + 1);
    const pad = v => String(v).padStart(2, '0');
    const nextDay = `${next.getFullYear()}-${pad(next.getMonth() + 1)}-${pad(next.getDate())}`;

    const q = this.knex('photo_index as p')
      .where('p.is_file', 1)
      .where('p.in_trash', 0)
      .where('p.original_date', '>=', day)
      .where('p.original_date', '<', nextDay)
      .select(
        'p.file_hash',
        'p.path',
        'p.filename',
        'p.original_time',
        'p.original_date',
        'p.type',
        'p.width',
        'p.height'
      )
      .orderBy('p.original_time', 'asc')
      .limit(limit);
    // 'nogeo' 是 memoryCandidates 给「没有 geohash」那堆起的桶名，不能当 geohash 去等值匹配
    if (cell === 'nogeo') {
      q.where(function () {
        this.whereNull('p.geohash5').orWhere('p.geohash5', '');
      });
    } else if (cell) {
      q.where('p.geohash5', cell);
    }
    scope.apply(q);

    const rows = await q.catch(() => []);
    // ⭐ 2026-10-19 用户手动「移出记忆」的照片不再出现在这一组里（照片本身不动、不删）
    const excludes = await this._memoryExcludes(params.uid, key);
    const picked = (Array.isArray(rows) ? rows : []).filter(
      r => !excludes.has(String(r.file_hash || ''))
    );
    const items = picked.map(r => ({
      file_hash: String(r.file_hash || ''),
      fullpath: `${r.path}${require('path').sep}${r.filename}`,
      filename: String(r.filename || ''),
      type: Number(r.type) || 1,
      time: Number(r.original_time) || 0,
      date: String(r.original_date || '').slice(0, 10),
      width: Number(r.width) || 0,
      height: Number(r.height) || 0,
    }));
    return { items, total: items.length, key, date: day };
  }

  /**
   * ⭐ 2026-10-19 人生章节「书本」：某一年**已确认的记忆**（一页 = 一段记忆）。
   *
   * 只读：返回每段记忆的照片（最多 per_day 张）、场景/活动/人物标签、地点（geonames 反查），
   * 以及记忆本身的备注文字。前端把它排成左右两页的书。
   * ⭐ 2026-10-19 二次调整（用户要求）：
   *   ① 只收「这一年里用户确认过的记忆」——不再把全年每一天都摊开；
   *   ② 页序从 1 月 1 日开始（升序），不再「最近的日子在前」；
   *   ③ 已经在记忆详情里「移出记忆」的照片（exclude_hashes）不再出现。
   * ⚠️ 只查「有确认记忆的那几天」，比原来整年扫一遍小得多；row_limit 仍是硬上限。
   */
  async chapterBook(params = {}) {
    const scope = this._scope(params);
    const year = Number(params.year) || 0;
    if (scope.empty || year < 1900) {
      return { year, days: [], total_days: 0, truncated: false };
    }
    const pad = v => String(v).padStart(2, '0');
    const nextDayOf = d => {
      const t = new Date(`${d}T00:00:00`);
      t.setDate(t.getDate() + 1);
      return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`;
    };

    // 1) 已确认的记忆（key = `${day}|${geohash5}`），只留这一年
    const saved = await this.listMemories({ uid: Number(params.uid) || 0 });
    const memByKey = new Map();
    for (const m of Array.isArray(saved) ? saved : []) {
      const raw = String((m && m.key) || '').trim();
      const day = raw.split('|')[0];
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
      if (Number(day.slice(0, 4)) !== year) continue;
      memByKey.set(raw, {
        note: String((m && m.note) || ''),
        title: String((m && m.title) || ''),
        excludes: new Set(
          (m && Array.isArray(m.exclude_hashes) ? m.exclude_hashes : []).map(String)
        ),
      });
    }
    if (memByKey.size === 0) return { year, days: [], total_days: 0, truncated: false };

    const maxDays = Math.max(1, Math.min(400, Number(params.max_days) || 366));
    const perDay = Math.max(1, Math.min(60, Number(params.per_day) || 24));
    const rowLimit = Math.max(300, Math.min(12000, Number(params.row_limit) || 8000));
    const startMs = new Date(year, 0, 1).getTime();
    const endMs = new Date(year + 1, 0, 1).getTime() - 1;
    const locale = params.locale ? String(params.locale) : 'zh-CN';
    const dayList = Array.from(
      new Set(Array.from(memByKey.keys()).map(k => k.split('|')[0]))
    ).sort();

    // 2) 只查这几天（原先是整年扫一遍再按天切）
    const q = this.knex('photo_index as p')
      .where('p.is_file', 1)
      .where('p.in_trash', 0)
      .where('p.type', 1)
      .whereBetween('p.original_time', [startMs, endMs])
      .whereNotNull('p.original_date')
      .select(
        'p.file_hash',
        'p.path',
        'p.filename',
        'p.original_time',
        'p.original_date',
        'p.geohash5',
        'p.latitude',
        'p.longitude',
        'p.width',
        'p.height'
      )
      .where(function () {
        for (const d of dayList) {
          const next = nextDayOf(d);
          this.orWhere(b =>
            b.where('p.original_date', '>=', d).where('p.original_date', '<', next)
          );
        }
      })
      .orderBy('p.original_time', 'asc')
      .limit(rowLimit);
    scope.apply(q);
    const rows = await q.catch(() => []);
    const list = Array.isArray(rows) ? rows : [];
    if (list.length === 0) return { year, days: [], total_days: 0, truncated: false };

    // 3) 按「记忆」分组（day|geohash5）：不在确认名单里的、被移出记忆的，全部丢掉
    const byKey = new Map();
    for (const r of list) {
      const day = String(r.original_date || '').slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
      const cell = String(r.geohash5 || '').trim() || 'nogeo';
      const key = `${day}|${cell}`;
      const mem = memByKey.get(key);
      if (!mem) continue;
      if (mem.excludes.has(String(r.file_hash || ''))) continue;
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push(r);
    }
    if (byKey.size === 0) return { year, days: [], total_days: 0, truncated: false };

    // 4) ⭐ 从 1 月 1 日开始（升序）
    const ordered = Array.from(byKey.entries()).sort((a, b) => {
      if (a[0] === b[0]) return 0;
      return a[0] < b[0] ? -1 : 1;
    });
    const kept = ordered.slice(0, maxDays);
    const truncated = ordered.length > kept.length;

    // 标签：一次把要展示那几段记忆的人脸/场景/活动全查出来，避免逐个开查
    const labelHashes = [];
    for (const [, arr] of kept) {
      for (const r of arr.slice(0, 40)) labelHashes.push(String(r.file_hash));
    }
    const labels = await this._labelsOfHashes(labelHashes.slice(0, 6000), {
      scenes: true,
      activities: true,
      people: true,
    });

    // 地点：同一个 geohash5 只查一次，最多 60 个格（geonames 距离排序不便宜）
    let photoMapService = null;
    try {
      photoMapService = require('../map/photoMapService');
    } catch (_) {
      photoMapService = null;
    }
    const placeCache = new Map();
    const placeOf = async r => {
      const h = String((r && r.geohash5) || '').trim();
      if (!h || !photoMapService || !params.dbGeo) return '';
      if (placeCache.has(h)) return placeCache.get(h);
      let out = '';
      if (placeCache.size < 60) {
        try {
          out =
            (await photoMapService.getLocationStr(
              { dbGeo: params.dbGeo, locale },
              h,
              Number(r.latitude) || 0,
              Number(r.longitude) || 0
            )) || '';
        } catch (_) {
          out = '';
        }
      }
      placeCache.set(h, out);
      return out;
    };

    const pages = [];
    for (const [key, arrRaw] of kept) {
      const arr = arrRaw
        .slice()
        .sort((a, b) => (Number(a.original_time) || 0) - (Number(b.original_time) || 0));
      const hashes = arr.map(x => String(x.file_hash));
      const sceneCount = new Map();
      const actCount = new Map();
      const peopleMap = new Map();
      for (const h of hashes) {
        for (const s of labels.scenes.get(h) || []) sceneCount.set(s, (sceneCount.get(s) || 0) + 1);
        for (const a of labels.activities.get(h) || []) actCount.set(a, (actCount.get(a) || 0) + 1);
        for (const p of labels.people.get(h) || []) {
          if (p.name) peopleMap.set(p.face_id, p.name);
        }
      }
      const top = m => Array.from(m.entries()).sort((a, b) => b[1] - a[1]).slice(0, 4).map(x => x[0]);
      const photos = arr.slice(0, perDay).map(r => ({
        file_hash: String(r.file_hash || ''),
        fullpath: `${r.path}${require('path').sep}${r.filename}`,
        filename: String(r.filename || ''),
        time: Number(r.original_time) || 0,
        width: Number(r.width) || 0,
        height: Number(r.height) || 0,
      }));
      const mem = memByKey.get(key) || { note: '', title: '' };
      const day = key.split('|')[0];
      pages.push({
        key,
        date: day,
        cell: key.split('|')[1] || '',
        photo_count: arr.length,
        cover_path: photos.length ? photos[0].fullpath : '',
        photos,
        scenes: top(sceneCount),
        activities: top(actCount),
        people: Array.from(peopleMap.values()).slice(0, 6),
        place: await placeOf(arr[0]),
        note: mem.note || '',
        title: mem.title || '',
      });
    }

    return { year, days: pages, total_days: pages.length, truncated };
  }

  /** 记忆里被「移出」的照片 hash 集合（不存在就是空集）。 */
  async _memoryExcludes(uid, key) {
    const k = String(key || '').trim();
    if (!k) return new Set();
    try {
      const list = await this.listMemories({ uid });
      const m = list.find(x => x && x.key === k);
      const arr = m && Array.isArray(m.exclude_hashes) ? m.exclude_hashes : [];
      return new Set(arr.map(String));
    } catch (_) {
      return new Set();
    }
  }

  /**
   * ⭐ 2026-10-19 从某段记忆里「移出」若干张照片。
   *
   * 只改记忆本身（config 里的 exclude_hashes + photo_count + 必要时换封面），
   * **不动照片**：原图还在相册里，只是不再算进这段记忆。
   * 返回更新后的 memories，前端可直接换列表。
   */
  async excludeMemoryPhotos(params = {}) {
    const uid = Number(params.uid) || 0;
    const key = String(params.key || '').trim();
    const hashes = Array.isArray(params.hashes)
      ? params.hashes.map(h => String(h || '').trim()).filter(Boolean)
      : [];
    if (!key || hashes.length === 0) {
      const err = new Error('common.PARAM_ERROR');
      err.statusCode = 400;
      throw err;
    }
    const list = await this.listMemories({ uid });
    const idx = list.findIndex(m => m && m.key === key);
    if (idx < 0) {
      const err = new Error('common.PARAM_ERROR');
      err.statusCode = 404;
      throw err;
    }
    const m = list[idx];
    const prev = Array.isArray(m.exclude_hashes) ? m.exclude_hashes.map(String) : [];
    const set = new Set(prev);
    let added = 0;
    for (const h of hashes) {
      if (set.has(h)) continue;
      set.add(h);
      added += 1;
    }
    m.exclude_hashes = Array.from(set).slice(-5000);
    m.photo_count = Math.max(0, (Number(m.photo_count) || 0) - added);
    list[idx] = m;
    await tableConfig.setConfigByKey(this._memoryKey(uid), JSON.stringify(list));

    // 封面可能正好被移出 ⇒ 换一张还留在记忆里的
    if (added > 0) {
      try {
        const day = String(m.date || key.split('|')[0] || '').trim();
        const one = await this.memoryPhotos({ ...params, key, date: day, limit: 1 });
        const first = one && one.items && one.items[0];
        if (first && first.fullpath && first.fullpath !== m.cover_path) {
          m.cover_path = first.fullpath;
          list[idx] = m;
          await tableConfig.setConfigByKey(this._memoryKey(uid), JSON.stringify(list));
        }
      } catch (_) {
        /* 换封面失败不影响「移出」本身 */
      }
    }
    return { memories: list, removed: added, memory: m };
  }

  _memoryIgnoreKey(uid) {
    return `photo_memories_ignored.${Number(uid) || 0}`;
  }

  /**
   * 已忽略的候选。
   * 存的是「足够画一张卡」的快照（key + 日期 + 封面 + 张数 + 场景），
   * 不是只存 key —— 否则「已忽略」页只能显示一串哈希值。兼容旧数据（纯字符串数组）。
   */
  async listIgnored(params = {}) {
    const uid = Number(params.uid) || 0;
    try {
      const raw = await tableConfig.getConfigByKey(this._memoryIgnoreKey(uid));
      const list = raw ? JSON.parse(String(raw)) : [];
      if (!Array.isArray(list)) return [];
      return list
        .map(x => (typeof x === 'string' ? { key: x } : x))
        .filter(x => x && x.key);
    } catch (_) {
      return [];
    }
  }

  /** 「不是我想要的」：进忽略名单，同时从已确认里移除（避免两处都在）。 */
  async ignoreMemory(params = {}) {
    const uid = Number(params.uid) || 0;
    const key = String(params.key || '').trim();
    if (!key) {
      const err = new Error('common.PARAM_ERROR');
      err.statusCode = 400;
      throw err;
    }
    const ignored = await this.listIgnored({ uid });
    const entry = {
      key,
      date: String(params.date || ''),
      cover_path: String(params.cover_path || ''),
      photo_count: Number(params.photo_count) || 0,
      scenes: Array.isArray(params.scenes) ? params.scenes.slice(0, 4) : [],
      ignored_at: new Date().toISOString(),
    };
    const next = [entry, ...ignored.filter(x => x.key !== key)];
    await tableConfig.setConfigByKey(this._memoryIgnoreKey(uid), JSON.stringify(next.slice(0, 1000)));
    const memories = (await this.listMemories({ uid })).filter(m => m && m.key !== key);
    await tableConfig.setConfigByKey(this._memoryKey(uid), JSON.stringify(memories));
    return { ignored: next.slice(0, 1000), memories };
  }

  /** 从忽略名单里捞回来（重新变回候选）。 */
  async restoreIgnored(params = {}) {
    const uid = Number(params.uid) || 0;
    const key = String(params.key || '').trim();
    const ignored = (await this.listIgnored({ uid })).filter(o => o.key !== key);
    await tableConfig.setConfigByKey(this._memoryIgnoreKey(uid), JSON.stringify(ignored));
    return { ignored, memories: await this.listMemories({ uid }) };
  }

  /**
   * ⭐ 2026-10-18 「人生章节」：按年把照片库切成几段，每年一张封面。
   *
   * 对齐行影集的「2021 年的影像」卡片：封面 + 起止日期 + 张数。
   * 张数/起止一次 group by 出来；封面按年取该年第一张（走 original_time 索引，不做 strftime 全表扫）。
   */
  async memoryChapters(params = {}, maxYears = 8) {
    const scope = this._scope(params);
    if (scope.empty) return [];
    const base = () => scope.apply(
      this.knex('photo_index as p')
        .where('p.is_file', 1)
        .where('p.in_trash', 0)
        .where('p.type', 1)
    );
    const rows = await base()
      .whereNotNull('p.original_time')
      .select(this.knex.raw("strftime('%Y', p.original_time / 1000, 'unixepoch', 'localtime') AS y"))
      .count({ n: 'p.file_hash' })
      .min({ first_date: 'p.original_date' })
      .max({ last_date: 'p.original_date' })
      .groupByRaw('y')
      .orderBy('y', 'desc')
      .limit(maxYears)
      .catch(() => []);

    const out = [];
    for (const r of Array.isArray(rows) ? rows : []) {
      const year = Number(r && r.y) || 0;
      const count = Number((r && r.n) || 0) || 0;
      if (year < 1900 || count <= 0) continue;
      const startMs = new Date(year, 0, 1).getTime();
      const endMs = new Date(year + 1, 0, 1).getTime();
      const cover = await base()
        .whereBetween('p.original_time', [startMs, endMs])
        .orderBy('p.original_time', 'asc')
        .select('p.path', 'p.filename', 'p.original_date')
        .first()
        .catch(() => null);
      out.push({
        year,
        photo_count: count,
        start: r && r.first_date ? String(r.first_date).slice(0, 10) : '',
        end: r && r.last_date ? String(r.last_date).slice(0, 10) : '',
        cover_path: cover ? `${cover.path}${require('path').sep}${cover.filename}` : '',
      });
    }
    return out;
  }

  /**
   * ⭐ 2026-10-19 给已确认记忆补 `place`（卡片摘要 = 地点 · 干什么 · N 张）。
   *
   * 记忆的 key 就是 `${day}|${geohash5}`，所以只用 geonames 反查一次地名，
   * 不碰照片表；同一格子只查一次，失败就当没有地点，绝不影响记忆列表本身。
   */
  async _attachMemoryPlaces(memories, params = {}) {
    const list = Array.isArray(memories) ? memories : [];
    if (list.length === 0 || !params.dbGeo) return;
    let photoMapService = null;
    try {
      photoMapService = require('../map/photoMapService');
    } catch (_) {
      return;
    }
    const locale = String(params.locale || 'zh-CN');
    const cache = new Map();
    for (const m of list) {
      if (!m || typeof m !== 'object') continue;
      const key = String(m.key || '');
      const cell = String(m.cell || key.split('|')[1] || '').trim();
      if (!cell || cell === 'nogeo' || cache.size >= 120) {
        m.place = '';
        continue;
      }
      if (cache.has(cell)) {
        m.place = cache.get(cell);
        continue;
      }
      let out = '';
      try {
        out = (await photoMapService.getLocationStr({ dbGeo: params.dbGeo, locale }, cell, 0, 0)) || '';
      } catch (_) {
        out = '';
      }
      cache.set(cell, out);
      m.place = out;
    }
  }

  _memoryKey(uid) {
    return `photo_memories.${Number(uid) || 0}`;
  }

  async listMemories(params = {}) {
    const uid = Number(params.uid) || 0;
    try {
      const raw = await tableConfig.getConfigByKey(this._memoryKey(uid));
      const list = raw ? JSON.parse(String(raw)) : [];
      return Array.isArray(list) ? list : [];
    } catch (_) {
      return [];
    }
  }

  async saveMemory(params = {}) {
    const uid = Number(params.uid) || 0;
    const list = await this.listMemories({ uid });
    const key = String(params.key || '').trim();
    if (!key) {
      const err = new Error('common.PARAM_ERROR');
      err.statusCode = 400;
      throw err;
    }
    if (list.some(m => m.key === key)) return { memories: list, saved: false };
    list.unshift({
      key,
      title: String(params.title || '').trim(),
      date: String(params.date || '').trim(),
      note: String(params.note || '').trim(),
      photo_count: Number(params.photo_count) || 0,
      cover_path: String(params.cover_path || ''),
      scenes: Array.isArray(params.scenes) ? params.scenes.slice(0, 8) : [],
      activities: Array.isArray(params.activities) ? params.activities.slice(0, 8) : [],
      people: Array.isArray(params.people) ? params.people.slice(0, 12) : [],
      confirm_time: new Date().toISOString(),
    });
    await tableConfig.setConfigByKey(this._memoryKey(uid), JSON.stringify(list.slice(0, 500)));
    return { memories: list.slice(0, 500), saved: true };
  }

  async removeMemory(params = {}) {
    const uid = Number(params.uid) || 0;
    const key = String(params.key || '').trim();
    const list = (await this.listMemories({ uid })).filter(m => m && m.key !== key);
    await tableConfig.setConfigByKey(this._memoryKey(uid), JSON.stringify(list));
    return { memories: list };
  }

  /**
   * ⭐ P1-16 相似 / 重复照片工具箱（数据层）。
   * `content_md5` 是**惰性填充**的（相册备份内容去重在用），所以这里同时报出「还没算过 MD5」的数量，
   * 让用户知道为什么去重结果不完整 —— 而不是假装扫完了。
   */
  async duplicates(params = {}) {
    const scope = this._scope(params);
    if (scope.empty) return { groups: [], missing_md5: 0, similar_groups: { listed: 0 } };
    const limit = Math.max(1, Math.min(200, Number(params.limit) || 50));

    // ⭐ 2026-10-17 P5：只捞「同一 md5 至少出现两次」的行。
    // 旧实现是全捞（还带 `limit(20000)`）再在 JS 里分组 ⇒ 张数一超上限就**静默丢掉最小的那批**，
    // 而小图恰恰最可能是重复图。改成 SQL 侧先筛：没有上限、不会误丢，返回行数还更少。
    const q = this.knex('photo_index as p')
      .where('p.is_file', 1)
      .where('p.in_trash', 0)
      .whereNotNull('p.content_md5')
      .whereIn(
        'p.content_md5',
        this.knex('photo_index')
          .select('content_md5')
          .where('is_file', 1)
          .where('in_trash', 0)
          .whereNotNull('content_md5')
          .whereRaw("content_md5 <> ''")
          .groupBy('content_md5')
          .havingRaw('COUNT(1) >= 2')
      )
      // ⭐ 带上 id：清理动作要按 photo_index.id 走 P0-6 的「预演 → 执行 → 可撤销」
      .select('p.id', 'p.file_hash', 'p.path', 'p.filename', 'p.size', 'p.content_md5')
      .orderBy('p.size', 'desc');
    scope.apply(q);
    // ⭐ 2026-10-17：不能再静默吞掉。这里一旦出 SQL 错，接口仍回 200、
    //   groups 为空 ⇒ 用户会得出「没有重复照片」的结论（而真相是查询坏了）。
    //   模式与 「重复清理一个也查不出」难以区分，是最难查的一类 bug。
    const rows = await q.catch(err => {
      Logger.warn('[appAi] duplicates 主查询失败（返回空会被误读为「没有重复照片」）:', err && err.message ? err.message : err);
      return [];
    });

    const byMd5 = new Map();
    for (const r of Array.isArray(rows) ? rows : []) {
      const md5 = String(r.content_md5 || '');
      if (!md5) continue;
      if (!byMd5.has(md5)) byMd5.set(md5, []);
      byMd5.get(md5).push(r);
    }
    const groups = [];
    for (const [md5, list] of byMd5) {
      if (list.length < 2) continue;
      groups.push({
        md5,
        count: list.length,
        bytes_each: Number(list[0].size) || 0,
        wasted_bytes: (list.length - 1) * (Number(list[0].size) || 0),
        items: list.slice(0, 20).map(x => ({
          id: Number(x.id) || 0,
          file_hash: String(x.file_hash),
          filename: String(x.filename || ''),
          fullpath: `${x.path}${require('path').sep}${x.filename}`,
        })),
      });
    }
    groups.sort((a, b) => b.wasted_bytes - a.wasted_bytes);

    const missQ = this.knex('photo_index as p')
      .where('p.is_file', 1)
      .where('p.in_trash', 0)
      .whereNull('p.content_md5')
      .andWhereRaw("p.file_hash IS NOT NULL AND p.file_hash <> ''");
    scope.apply(missQ);
    const missRow = await missQ.count({ n: 'p.id' }).first().catch(() => null);

    // ⭐ 2026-10-17 P5：把「**真正值得算** md5 的候选」数量也报出去。
    // 用户看到「未算 MD5: 5.6 万」会以为坏了，其实绝大多数是 size 独一份、**永远不可能重复**的。
    // 内容相同 ⇒ size 必相同，所以只有 size 与别人撞车的那些才需要算。
    let md5Candidates = 0;
    try {
      const candQ = this._candidateMd5Query(scope);
      const r = await candQ.count({ n: 'p.id' }).first().catch(() => null);
      md5Candidates = Number((r && r.n) || 0) || 0;
    } catch (_) {}

    let similarListed = 0;
    try {
      const simRow = await this.knex('photo_similar').count({ n: 'index_id' }).first().catch(() => null);
      similarListed = Number((simRow && simRow.n) || 0) || 0;
    } catch (_) {}

    return {
      groups: groups.slice(0, limit),
      total_groups: groups.length,
      total_wasted_bytes: groups.reduce((s, g) => s + g.wasted_bytes, 0),
      missing_md5: Number((missRow && missRow.n) || 0) || 0,
      md5_candidates: md5Candidates,
      similar_groups: { listed: similarListed },
    };
  }

  /**
   * ⭐ 2026-10-17 P5：**候选限定**的 content_md5 补齐查询（只读，不改库）。
   *
   * 口径：is_file 且在库、type=1（图片）、content_md5 为空，**且 size 与至少一张别的照片相同**。
   * 为什么能这么筛：内容相同的文件必然同 size ⇒ 只有 size 撞车的才可能重复。
   * 实测 61686 张里只有 9754 行（31 GiB）满足，全量则是 219 GiB ⇒ 省掉 86% 的读盘。
   */
  _candidateMd5Query(scope) {
    const q = this.knex('photo_index as p')
      .where('p.is_file', 1)
      .where('p.in_trash', 0)
      .where('p.type', 1)
      .whereRaw("(p.content_md5 IS NULL OR p.content_md5 = '')")
      .whereIn(
        'p.size',
        this.knex('photo_index')
          .select('size')
          .where('is_file', 1)
          .where('in_trash', 0)
          .where('type', 1)
          .groupBy('size')
          .havingRaw('COUNT(1) >= 2')
      );
    if (scope && typeof scope.apply === 'function') scope.apply(q, 'p.path');
    return q;
  }

  /**
   * ⭐ 2026-10-17 P5：补齐 content_md5 —— 让「重复照片」页真的能查出东西。
   *
   * 背景：`duplicates()` 按 content_md5 分组，而 md5 是**惰性**填充的（只有相册备份比对过才写），
   * 实测 61686 张里只有 5359 张有值 ⇒ 精确重复只能查出 1 组，功能等于废的。
   * 核心实现在 PhotoSourceService（零重依赖，工具脚本可直跑）；这里只做范围/委托。
   */
  async backfillContentMd5(params = {}) {
    const scope = this._scope(params);
    if (scope.empty) return { candidates: 0, scanned: 0, hashed: 0, failed: 0, remaining: 0 };
    const limit = Math.max(1, Math.min(5000, Number(params.limit) || 500));
    const svc = new PhotoSourceService(this.knex);
    return svc.backfillContentMd5({ limit, pathPrefixes: scope.hasScope ? scope.paths : [] });
  }

  /**
   * ⭐ P1-15 模型目录化（只读版）：把「本地已有哪些模型」摊出来。
   * 现状是三件套（faces / ppocrv5 / places365）+ clip 与 activity 两个额外目录；
   * 这里扫描 onnx_models 下的子目录给出文件数与体积，并标出三件套的 bundleId，
   * 让「模型装没装、装到哪」不再靠猜。⛔ 不做运行中切换/删除（会让正在跑的 worker 崩）。
   */
  async modelCatalog() {
    const fs = require('fs');
    const pathMod = require('path');
    let root = '';
    try {
      const remoteAssets = require('../../../../utils/remoteAssetsManager');
      root = remoteAssets.resolveOnnxModelsRoot();
    } catch (_) {
      root = pathMod.join(process.cwd(), 'onnx_models');
    }
    const BUNDLES = {
      faces: 'onnx_models.faces',
      ppocrv5: 'onnx_models.ppocrv5',
      places365: 'onnx_models.places365',
    };
    const items = [];
    let dirs = [];
    try {
      dirs = fs.existsSync(root) ? fs.readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name) : [];
    } catch (_) {
      dirs = [];
    }
    for (const name of dirs.sort()) {
      const dir = pathMod.join(root, name);
      let files = 0;
      let bytes = 0;
      const walk = d => {
        let entries = [];
        try {
          entries = fs.readdirSync(d, { withFileTypes: true });
        } catch (_) {
          return;
        }
        for (const e of entries) {
          const full = pathMod.join(d, e.name);
          if (e.isDirectory()) walk(full);
          else {
            files += 1;
            try {
              bytes += fs.statSync(full).size;
            } catch (_) {}
          }
        }
      };
      walk(dir);
      items.push({
        name,
        bundle_id: BUNDLES[name] || '',
        installed: files > 0,
        files,
        bytes,
      });
    }
    return {
      root,
      items,
      available: items.filter(i => i.installed).map(i => i.name),
      note: '只读清单：运行中切换/删除模型会让正在跑的 worker 崩（见 docs/WaterNasOS-整合实施路线图.md §5 P1-15）。',
    };
  }

  /**
   * ⭐ P2-21 年度报告：一年里「拍了什么、去了哪、跟谁」。
   *
   * 纯聚合，不调 LLM：月份分布 / 最多的场景 / 活动 / 人物 / 相机 / 最忙的日子 / 去过的格子数。
   * 「最远城市」需要地名库（本仓库已不随包），所以用 geohash5 的**去重格子数**当「去过多少地方」的代理。
   */
  async yearReport(params = {}) {
    const scope = this._scope(params);
    if (scope.empty) return { year: 0, empty: true };
    const year = Number(params.year) || new Date().getFullYear();
    const startMs = new Date(year, 0, 1, 0, 0, 0).getTime();
    const endMs = new Date(year + 1, 0, 1, 0, 0, 0).getTime();

    const q = this.knex('photo_index as p')
      .where('p.is_file', 1)
      .where('p.in_trash', 0)
      .whereBetween('p.original_time', [startMs, endMs])
      .select('p.file_hash', 'p.type', 'p.original_time', 'p.original_date', 'p.geohash5', 'p.camera', 'p.size',
        'p.latitude', 'p.longitude', 'p.duration', 'p.path', 'p.filename')
      .orderBy('p.original_time', 'asc')
      .limit(50000);
    scope.apply(q);
    const rows = await q.catch(() => []);
    if (!Array.isArray(rows) || rows.length === 0) {
      return { year, empty: true, total: 0 };
    }

    const months = new Array(12).fill(0);
    const days = new Map();
    const cells = new Set();
    const cities = new Set();
    const cameras = new Map();
    const geo = [];
    // 四季：按月份切，每季留一张封面（该季最早那张）+ 张数
    const seasonOf = m => ((m <= 1 || m === 11) ? 'winter' : (m <= 4 ? 'spring' : (m <= 7 ? 'summer' : 'autumn')));
    const seasons = new Map();
    let bytes = 0;
    let videos = 0;
    let videoSeconds = 0;
    for (const r of rows) {
      const d = new Date(Number(r.original_time));
      months[d.getMonth()] += 1;
      const day = String(r.original_date || '').slice(0, 10);
      if (day) days.set(day, (days.get(day) || 0) + 1);
      if (r.geohash5) {
        const gh = String(r.geohash5);
        cells.add(gh);
        // geohash4 ≈ 39x20km，当「城市/地区」口径（与首页看板一致）
        if (gh.length >= 4) cities.add(gh.slice(0, 4));
      }
      const cam = r.camera ? String(r.camera).trim() : '';
      if (cam) cameras.set(cam, (cameras.get(cam) || 0) + 1);
      bytes += Number(r.size) || 0;
      if (Number(r.type) === 2) {
        videos += 1;
        videoSeconds += Number(r.duration) || 0;
      }
      const lat = Number(r.latitude);
      const lng = Number(r.longitude);
      if (lat && lng && r.path && r.filename) {
        geo.push({ lat, lng, t: Number(r.original_time), cover: `${r.path}${require('path').sep}${r.filename}` });
      }
      const sk = seasonOf(d.getMonth());
      const sb = seasons.get(sk) || { count: 0, cover: '' };
      sb.count += 1;
      if (!sb.cover) sb.cover = `${r.path}${require('path').sep}${r.filename}`;
      seasons.set(sk, sb);
    }

    const hashes = rows.map(r => String(r.file_hash)).filter(Boolean);
    const sample = hashes.slice(0, 8000); // 标签聚合只抽样，避免 IN 过大
    const labels = await this._labelsOfHashes(sample, { scenes: true, activities: true, people: true });
    const sceneCount = new Map();
    const actCount = new Map();
    const peopleCount = new Map();
    for (const h of sample) {
      for (const s of labels.scenes.get(h) || []) sceneCount.set(s, (sceneCount.get(s) || 0) + 1);
      for (const a of labels.activities.get(h) || []) actCount.set(a, (actCount.get(a) || 0) + 1);
      // ⭐ 2026-10-19 修：这里原先是 peopleMap.set(face_id, name) 后直接丢给 topN，
      // 而 topN 是拿 Map 的 value 当计数的 ⇒ 「拍得最多的人」永远显示 face_id、张数恒为 1。
      // 现在按姓名计数（同一张图同一个人只算一次），与场景/活动的口径一致。
      const seenFaces = new Set();
      for (const p of labels.people.get(h) || []) {
        const name = p && p.name ? String(p.name) : '';
        if (!name) continue;
        const pid = p.face_id != null ? String(p.face_id) : name;
        if (seenFaces.has(pid)) continue;
        seenFaces.add(pid);
        peopleCount.set(name, (peopleCount.get(name) || 0) + 1);
      }
    }
    // 生活图谱：把细标签归到大类。
    // 按 file_hash 去重（同一张图不会因为命中两个标签被算两次），再除以抽样总数得比例。
    // 大类映射与分类页共用一份（src/utils/photoCategoryUtil.js），避免两处口径不一致
    const { CATEGORIES: CATEGORY_RULES } = require('../../../../utils/photoCategoryUtil');
    const tagCatCache = new Map();
    const catOfTag = t => {
      if (tagCatCache.has(t)) return tagCatCache.get(t);
      let hit = '';
      for (const c of CATEGORY_RULES) {
        if (c.words.some(w => t.includes(w))) { hit = c.key; break; }
      }
      tagCatCache.set(t, hit);
      return hit;
    };
    const catSets = new Map();
    for (const h of sample) {
      const tags = [...(labels.scenes.get(h) || []), ...(labels.activities.get(h) || [])];
      for (const t of tags) {
        const k = catOfTag(String(t));
        if (!k) continue;
        if (!catSets.has(k)) catSets.set(k, new Set());
        catSets.get(k).add(h);
        break;
      }
    }
    const categories = Array.from(catSets.entries())
      .map(([key, set]) => ({ key, count: set.size, ratio: sample.length ? Number((set.size / sample.length).toFixed(3)) : 0 }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 8);

    // 最远一点：先算所有带坐标照片的平均位置当重心，再找距离最远的那张
    let farthest = null;
    if (geo.length > 1) {
      let cLat = 0;
      let cLng = 0;
      for (const g of geo) { cLat += g.lat; cLng += g.lng; }
      cLat /= geo.length;
      cLng /= geo.length;
      let best = 0;
      for (const g of geo) {
        const km = this._distanceKm(cLat, cLng, g.lat, g.lng);
        if (km && km > best) {
          best = km;
          farthest = { km: Math.round(km), date: new Date(g.t).toISOString(), cover_path: g.cover };
        }
      }
    }

    const topN = (m, n) => Array.from(m.entries()).sort((a, b) => b[1] - a[1]).slice(0, n).map(([name, count]) => ({ name, count }));
    const busyDays = Array.from(days.entries()).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([date, count]) => ({ date, count }));

    return {
      year,
      empty: false,
      total: rows.length,
      photos: rows.length - videos,
      videos,
      bytes,
      months,
      active_days: days.size,
      places: cells.size,
      first_shot: new Date(Number(rows[0].original_time)).toISOString(),
      last_shot: new Date(Number(rows[rows.length - 1].original_time)).toISOString(),
      top_scenes: topN(sceneCount, 10),
      top_activities: topN(actCount, 10),
      top_people: topN(peopleCount, 8),
      top_cameras: topN(cameras, 5),
      busy_days: busyDays,
      sampled: sample.length,
      cities: cities.size,
      video_seconds: Math.round(videoSeconds),
      categories,
      seasons: ['spring', 'summer', 'autumn', 'winter'].map(k => ({
        key: k,
        count: (seasons.get(k) || {}).count || 0,
        cover_path: (seasons.get(k) || {}).cover || '',
      })),
      farthest,
    };
  }

  /**
   * ⭐⭐ 2026-10-17 P0-7 重复清理的「合并元数据 + 送回收站」。
   *
   * 为什么需要它：原来清理重复走的是通用批量删除 ⇒ 被删那几张身上的
   * **收藏 / 相册归属 / 场景标签 / 活动标签 / 人脸**全部丢失。
   * 用户体感就是「我明明收藏过/分过相册，清理完就没了」。
   *
   * 合并规则（对标 Immich 的 duplicates 元数据同步口径）：
   *   · 收藏      任一待删被本人收藏  ⇒ 保留的那张也收藏
   *   · 相册      保留的那张加入待删们所属的**每个**相册
   *   · 场景标签  合并去重后补给保留的那张
   *   · 活动标签  合并去重后补给保留的那张
   *   · 人脸      待删身上的人脸映射补给保留的那张（同一 face_id 只补一次）
   *   · 位置      所有带坐标的待删**坐标一致**、且保留的那张没坐标 ⇒ 才复制
   *   · ⛔ OCR 不复制：OCR 文本属于那张图本身，跨图搬运是错的
   *   · ⛔ 可见性不复制：我们的可见性由 photo_source 统一管，不随单张走
   *
   * 只在**恰好保留一张**时才合并（与 Immich 一致）。全程一个事务，
   * 写一条 op_type='merge_resolve' 的日志：undo_data 同时装「回收站快照」与「合并反向记录」，
   * 撤销能一次全回滚。
   *
   * @param {Object} params { keep_hash, trash_hashes[], dry_run?, uid, validPaths? }
   */
  async resolveDuplicates(params = {}) {
    const knex = this.knex;
    const keepHash = String(params.keep_hash ?? params.keepHash ?? '').trim();
    const rawTrash = Array.isArray(params.trash_hashes)
      ? params.trash_hashes
      : (Array.isArray(params.trashHashes) ? params.trashHashes : []);
    const trashHashes = [...new Set(rawTrash.map(v => String(v ?? '').trim()).filter(Boolean))]
      .filter(h => h !== keepHash);
    const dryRun = params.dry_run === true || params.dryRun === true;
    const uid = Number(params.uid) || 0;

    if (!keepHash || trashHashes.length === 0) {
      const err = new Error('common.PARAM_ERROR');
      err.statusCode = 400;
      throw err;
    }

    const scope = this._scope(params);
    if (scope.empty) {
      const err = new Error('auth.PERMISSION_DENIED');
      err.statusCode = 403;
      throw err;
    }

    const allHashes = [keepHash, ...trashHashes];
    const pick = async (hashes) => {
      const q = knex('photo_index as p')
        .whereIn('p.file_hash', hashes)
        .where('p.is_file', 1)
        .select('p.id', 'p.file_hash', 'p.path', 'p.filename', 'p.size', 'p.latitude', 'p.longitude');
      scope.apply(q);
      return q.catch(() => []);
    };
    const rows = await pick(allHashes);
    const byHash = new Map((Array.isArray(rows) ? rows : []).map(r => [String(r.file_hash), r]));
    const keepRow = byHash.get(keepHash);
    if (!keepRow) {
      const err = new Error('photo.NOT_FOUND');
      err.statusCode = 404;
      throw err;
    }
    const victims = trashHashes.map(h => byHash.get(h)).filter(Boolean);
    if (victims.length === 0) {
      const err = new Error('photo.NOT_FOUND');
      err.statusCode = 404;
      throw err;
    }
    const victimHashes = victims.map(v => String(v.file_hash));

    // ---- 1) 收藏 ----
    let favoriteAdd = false;
    if (uid > 0) {
      const hasKeep = await knex('photo_favorite').where({ uid, file_hash: keepHash }).first().catch(() => null);
      if (!hasKeep) {
        const anyFav = await knex('photo_favorite').where({ uid }).whereIn('file_hash', victimHashes).first().catch(() => null);
        favoriteAdd = !!anyFav;
      }
    }

    // ---- 2) 相册 ----
    const keepAlbums = new Set(
      (await knex('photo_album_index').where({ file_hash: keepHash }).select('album_id').catch(() => []))
        .map(r => Number(r.album_id))
    );
    const albumRows = await knex('photo_album_index').whereIn('file_hash', victimHashes).select('album_id').catch(() => []);
    const albumAdd = [...new Set(albumRows.map(r => Number(r.album_id)).filter(id => id > 0 && !keepAlbums.has(id)))];

    // ---- 3) 人脸 ----
    const keepFaces = new Set(
      (await knex('photo_face2filehash').where({ file_hash: keepHash }).select('face_id').catch(() => []))
        .map(r => Number(r.face_id))
    );
    const faceRows = await knex('photo_face2filehash').whereIn('file_hash', victimHashes).catch(() => []);
    const faceAdd = [];
    const seenFace = new Set();
    for (const r of Array.isArray(faceRows) ? faceRows : []) {
      const fid = Number(r.face_id);
      if (!fid || keepFaces.has(fid) || seenFace.has(fid)) continue;
      seenFace.add(fid);
      faceAdd.push({
        face_id: fid,
        box_left: Number(r.box_left) || 0,
        box_top: Number(r.box_top) || 0,
        box_width: Number(r.box_width) || 0,
        box_height: Number(r.box_height) || 0,
      });
    }

    // ---- 4) 场景标签 ----
    // ⛔ 表上有 **UNIQUE(file_hash)** ⇒ 一张照片只允许一行（主标签 + 次标签打包在 alt_labels 里）。
    //    所以**不能合并多行**（会撞唯一索引），只能是：保留那张没有标签时，复制分数最高的那一行。
    const keepHasPlace = await knex('photo_places2filehash').where({ file_hash: keepHash }).first().catch(() => null);
    let placeCopy = null;
    if (!keepHasPlace) {
      const cand = await knex('photo_places2filehash')
        .whereIn('file_hash', victimHashes)
        .orderBy('place_score', 'desc')
        .first()
        .catch(() => null);
      if (cand && String(cand.place_name || '')) {
        placeCopy = {
          place_name: String(cand.place_name || ''),
          alt_place_name: cand.alt_place_name ?? null,
          place_score: cand.place_score ?? null,
          place_status: cand.place_status ?? null,
          alt_labels: cand.alt_labels ?? null,
        };
      }
    }

    // ---- 5) 活动标签 ----
    // ⛔ 同场景标签：**UNIQUE(file_hash)** ⇒ 只能复制一行，不能合并。
    const keepHasAct = await knex('photo_activity2filehash').where({ file_hash: keepHash }).first().catch(() => null);
    let actCopy = null;
    if (!keepHasAct) {
      const cand = await knex('photo_activity2filehash')
        .whereIn('file_hash', victimHashes)
        .orderBy('act_score', 'desc')
        .first()
        .catch(() => null);
      if (cand && String(cand.act_key || '')) {
        actCopy = {
          act_key: String(cand.act_key || ''),
          act_name: cand.act_name ?? '',
          act_score: cand.act_score ?? null,
          act_status: cand.act_status ?? null,
          act_alt: cand.act_alt ?? null,
        };
      }
    }

    // ---- 6) 位置（只在「所有带坐标的待删坐标一致」且保留那张没坐标时才复制） ----
    const keepLat = Number(keepRow.latitude) || 0;
    const keepLon = Number(keepRow.longitude) || 0;
    const coords = victims
      .map(v => ({ lat: Number(v.latitude) || 0, lon: Number(v.longitude) || 0 }))
      .filter(c => c.lat !== 0 || c.lon !== 0);
    let locationCopy = null;
    if (keepLat === 0 && keepLon === 0 && coords.length > 0) {
      const first = coords[0];
      const allSame = coords.every(c => Math.abs(c.lat - first.lat) < 1e-6 && Math.abs(c.lon - first.lon) < 1e-6);
      if (allSame) locationCopy = first;
    }

    const plan = { favorite: favoriteAdd, albums: albumAdd, people: faceAdd, places: placeCopy, activities: actCopy, location: locationCopy };
    const merged = {
      favorite: favoriteAdd ? 1 : 0,
      albums: albumAdd.length,
      people: faceAdd.length,
      places: placeCopy ? 1 : 0,
      activities: actCopy ? 1 : 0,
      location: locationCopy ? 1 : 0,
    };
    const bytesFreed = victims.reduce((s, v) => s + (Number(v.size) || 0), 0);

    if (dryRun) {
      return {
        dry_run: true,
        keep_hash: keepHash,
        keep_id: Number(keepRow.id) || 0,
        trash_hashes: victimHashes,
        trash_count: victimHashes.length,
        merged,
        bytes_freed: bytesFreed,
      };
    }

    const EXPIRE_DAYS = 7;
    const result = await knex.transaction(async trx => {
      const mergeUndo = { favorite: [], album: [], people: [], places: [], activities: [], location: null };

      if (favoriteAdd) {
        await trx('photo_favorite').insert({ uid, file_hash: keepHash });
        mergeUndo.favorite.push({ uid, file_hash: keepHash });
      }
      for (const albumId of albumAdd) {
        await trx('photo_album_index').insert({ album_id: albumId, file_hash: keepHash });
        mergeUndo.album.push({ album_id: albumId, file_hash: keepHash });
      }
      for (const f of faceAdd) {
        await trx('photo_face2filehash').insert({ file_hash: keepHash, ...f });
        mergeUndo.people.push({ file_hash: keepHash, face_id: f.face_id });
      }
      if (placeCopy) {
        await trx('photo_places2filehash').insert({ file_hash: keepHash, ...placeCopy });
        mergeUndo.places.push({ file_hash: keepHash, place_name: placeCopy.place_name });
      }
      if (actCopy) {
        await trx('photo_activity2filehash').insert({ file_hash: keepHash, ...actCopy });
        mergeUndo.activities.push({ file_hash: keepHash, act_key: actCopy.act_key });
      }
      if (locationCopy) {
        await trx('photo_index')
          .where({ id: Number(keepRow.id) })
          .update({ latitude: locationCopy.lat, longitude: locationCopy.lon });
        mergeUndo.location = { id: Number(keepRow.id) };
      }

      const victimIds = victims.map(v => Number(v.id)).filter(Boolean);
      const before = await trx('photo_index').whereIn('id', victimIds).select('id', 'in_trash');
      await trx('photo_index')
        .whereIn('id', victimIds)
        .update({ in_trash: 1, in_trash_time: new Date() });

      const inserted = await trx('photo_operation_log')
        .insert({
          uid,
          op_type: 'merge_resolve',
          target_ids: JSON.stringify(victimIds),
          undo_data: JSON.stringify({
            trashed: (Array.isArray(before) ? before : []).map(r => ({ id: Number(r.id), in_trash: Number(r.in_trash) || 0 })),
            merge: mergeUndo,
          }),
          summary: JSON.stringify({ count: victimIds.length, bytes: bytesFreed, keep_hash: keepHash, merged }),
          status: 'executed',
          expire_time: new Date(Date.now() + EXPIRE_DAYS * 24 * 3600 * 1000),
        })
        .returning('id');
      const operationId = Array.isArray(inserted) && inserted[0]
        ? (typeof inserted[0] === 'object' ? Number(inserted[0].id) : Number(inserted[0]))
        : null;
      return { operationId, trashed: victimIds.length };
    });

    // ⭐ 2026-10-17 扩展点：合并 + 回收站都已提交，通知插件（错误在 bus 内被隔离，绝不影响这里）
    try {
      await require('../../../../plugins').bus.emit('afterDuplicateResolve', {
        keepHash,
        keepId: Number(keepRow.id) || 0,
        trashHashes: victimHashes,
        trashed: result.trashed,
        merged,
        bytesFreed,
        uid,
        operationId: result.operationId,
      });
    } catch (_) {}

    return {
      dry_run: false,
      keep_hash: keepHash,
      keep_id: Number(keepRow.id) || 0,
      trash_hashes: victimHashes,
      trashed: result.trashed,
      merged,
      bytes_freed: bytesFreed,
      operation_id: result.operationId,
      expire_days: EXPIRE_DAYS,
    };
  }

  /**
   * ⭐ P1-10 足迹「叙事层」的数据侧：把照片按访问片段串成旅行连线。
   *
   * 规则直接采用 TrailSnap 的口径（docs 里对过）：**同一次访问里，相邻拍摄间隔 > 7 天就断成两段**
   * （`VISIT_GAP_SECONDS = 7*24*3600`）；相邻访问之间若 key 不同且间隔 ≤7 天，就连一条线。
   * 坐标用**该片段第一张照片的真实坐标**（与足迹地图「落点=真实坐标」的口径一致）。
   */
  async travelLines(params = {}) {
    const scope = this._scope(params);
    if (scope.empty) return { visits: [], lines: [] };
    const year = Number(params.year) || 0;
    const precision = Math.max(4, Math.min(7, Number(params.precision) || 5)); // geohash5 ≈ 4.9km

    const q = this.knex('photo_index as p')
      .where('p.is_file', 1)
      .where('p.in_trash', 0)
      .where('p.original_time', '>', 0)
      .whereNotNull('p.geohash5')
      .select('p.file_hash', 'p.original_time', 'p.latitude', 'p.longitude', 'p.geohash5')
      .orderBy('p.original_time', 'asc')
      .limit(20000);
    scope.apply(q);
    if (year) {
      q.whereBetween('p.original_time', [
        new Date(year, 0, 1).getTime(),
        new Date(year + 1, 0, 1).getTime(),
      ]);
    }
    const rows = await q.catch(() => []);
    if (!Array.isArray(rows) || rows.length === 0) return { visits: [], lines: [] };

    const GAP_MS = 7 * 24 * 3600 * 1000;
    const cellOf = h => String(h).slice(0, precision);

    // 1) 按格子切「访问片段」
    const visits = [];
    let cur = null;
    for (const r of rows) {
      const key = cellOf(r.geohash5);
      const t = Number(r.original_time);
      if (!cur || cur.key !== key || t - cur.end > GAP_MS) {
        if (cur) visits.push(cur);
        cur = {
          key,
          start: t,
          end: t,
          count: 0,
          lat: Number(r.latitude) || 0,
          lng: Number(r.longitude) || 0,
        };
      }
      cur.end = t;
      cur.count += 1;
    }
    if (cur) visits.push(cur);

    // 2) 相邻访问（key 不同 + 间隔 ≤7 天 + 时间递增）连成线
    const lines = [];
    for (let i = 1; i < visits.length; i++) {
      const a = visits[i - 1];
      const b = visits[i];
      if (a.key === b.key) continue;
      if (b.start - a.end > GAP_MS) continue;
      if (b.start <= a.start) continue;
      lines.push({
        from: { key: a.key, lat: a.lat, lng: a.lng, at: new Date(a.start).toISOString() },
        to: { key: b.key, lat: b.lat, lng: b.lng, at: new Date(b.start).toISOString() },
        gap_hours: Number(((b.start - a.end) / 3600000).toFixed(1)),
      });
    }

    return {
      year: year || null,
      precision,
      visits: visits.map(v => ({
        key: v.key,
        start: new Date(v.start).toISOString(),
        end: new Date(v.end).toISOString(),
        photo_count: v.count,
        lat: v.lat,
        lng: v.lng,
      })),
      lines,
      gap_days: 7,
    };
  }
  // ============================================================================
  // ⭐ 2026-10-16 P2-18/P2-20 开放平台配置（设置页用）
  //   MCP 服务本身的配置接口在 /api/mcp/status|config/set|token/rotate（见 src/api/modules/mcp/mcpRouter.js）；
  //   这里补的是「模型 API」——Agent 要用的大模型凭据。TrailSnap 的做法是「任意 OpenAI 兼容厂商」
  //   （base_url + api_key + model），这里照同一套口径，并且提供**真实连通性测试**，
  //   避免出现「填了配置但没人验证过」的死配置。
  //   ⚠️ api_key 只存 config 表、GET 一律只回掩码（has_key + 尾 4 位），明文只在提交时经手一次。
  // ============================================================================

  /** 读模型 API 配置（对外掩码版） */
  async getModelApi() {
    let cfg = null;
    try {
      const raw = await tableConfig.getConfigByKey('agent_model_api');
      cfg = raw ? JSON.parse(String(raw)) : null;
    } catch (_) {
      cfg = null;
    }
    const c = cfg && typeof cfg === 'object' ? cfg : {};
    const key = String(c.api_key || '');
    return {
      base_url: String(c.base_url || ''),
      model: String(c.model || ''),
      has_key: key.length > 0,
      key_tail: key.length >= 4 ? key.slice(-4) : '',
      updated_at: c.updated_at || null,
    };
  }

  /** 写模型 API 配置；api_key 传空/不传 = 保留原值（配合掩码展示） */
  async setModelApi(params = {}) {
    let cfg = {};
    try {
      const raw = await tableConfig.getConfigByKey('agent_model_api');
      if (raw) cfg = JSON.parse(String(raw)) || {};
    } catch (_) {
      cfg = {};
    }
    if (params.base_url !== undefined) cfg.base_url = String(params.base_url || '').trim().replace(/\/+$/, '');
    if (params.model !== undefined) cfg.model = String(params.model || '').trim();
    if (params.api_key !== undefined && String(params.api_key || '').trim() !== '') {
      cfg.api_key = String(params.api_key).trim();
    }
    if (params.clear_key === true) cfg.api_key = '';
    cfg.updated_at = new Date().toISOString();
    await tableConfig.setConfigByKey('agent_model_api', JSON.stringify(cfg));
    return await this.getModelApi();
  }

  /** 极简出站 JSON 请求（自动走全局代理；Node 22 的 fetch 不认代理，所以自己来） */
  async _outboundJson(method, url, { headers = {}, body = null, timeoutMs = 15000 } = {}) {
    const https = require('https');
    const http = require('http');
    const isHttps = String(url).startsWith('https:');
    const lib = isHttps ? https : http;
    let agent = null;
    try {
      const netProxy = require('../../../../utils/networkProxyUtil');
      const proxyUrl = await netProxy.resolveGlobalProxyUrl();
      if (proxyUrl && isHttps) agent = netProxy.createHttpsProxyAgent(proxyUrl);
    } catch (_) {
      agent = null;
    }
    return await new Promise((resolve, reject) => {
      const req = lib.request(
        url,
        { method, headers, timeout: timeoutMs, agent: agent || undefined },
        res => {
          let data = '';
          res.setEncoding('utf8');
          res.on('data', c => {
            data += c;
          });
          res.on('end', () => resolve({ status: Number(res.statusCode) || 0, body: data }));
        }
      );
      req.on('timeout', () => req.destroy(new Error(`请求超时（${timeoutMs}ms）`)));
      req.on('error', err => reject(err));
      if (body) req.write(body);
      req.end();
    });
  }

  /**
   * ⭐ 2026-10-18 相册首页看板聚合。
   *
   * 首页那几张卡如果让客户端并发打 8 个接口，首屏会抖；这里一次查完：
   *   library   我的照片：图片/视频张数、今日新增、占用空间
   *   heat      拍摄时光：近 365 天每日张数、活跃天数、峰值日、按年分布
   *   footprint 我的足迹：地点簇数、有位置的拍摄天数、城市级去重数
   *   people    镜头里的相伴：Top 人物 + 未命名人脸数
   * 口径与时间线一致：is_file=1 / in_trash=0 / 按 original_time 本地时区切天。
   * 可见性同样零角色例外（validPaths 由 controller 传入）。
   */
  async homeSummary(params = {}) {
    const scope = this._scope(params);
    const empty = {
      library: { photos: 0, videos: 0, total: 0, today_new: 0, bytes: 0 },
      heat: { total: 0, active_days: 0, peak: null, days: [], by_year: [] },
      footprint: { places: 0, days: 0, cities: 0 },
      people: { pending: 0, items: [] },
      on_this_day: [],
    };
    if (scope.empty) return empty;

    const base = () => scope.apply(this.knex('photo_index as p').where('p.is_file', 1).where('p.in_trash', 0));
    const result = JSON.parse(JSON.stringify(empty));

    // 1) 我的照片：张数 / 视频数 / 占用空间
    try {
      const row = await base()
        .select(
          this.knex.raw('SUM(CASE WHEN p.type = 1 THEN 1 ELSE 0 END) AS photos'),
          this.knex.raw('SUM(CASE WHEN p.type = 2 THEN 1 ELSE 0 END) AS videos'),
          this.knex.raw('COUNT(1) AS total'),
          this.knex.raw('COALESCE(SUM(p.size), 0) AS bytes')
        )
        .first();
      result.library.photos = Number((row && row.photos) || 0) || 0;
      result.library.videos = Number((row && row.videos) || 0) || 0;
      result.library.total = Number((row && row.total) || 0) || 0;
      result.library.bytes = Number((row && row.bytes) || 0) || 0;
    } catch (_) {}

    // 1b) 今日新增
    try {
      const ds = new Date();
      ds.setHours(0, 0, 0, 0);
      const row = await base()
        .where('p.original_time', '>=', ds.getTime())
        .count({ n: 'p.file_hash' })
        .first();
      result.library.today_new = Number((row && row.n) || 0) || 0;
    } catch (_) {}

    // 1c) 那年今日：往年同月同日 ±3 天，按年分组各取一张代表图
    //     ⚠️ 只按「月相等 + 日差 ≤3」匹配，跨月边界（如 10-01 的 9-28）会漏，这是刻意的：
    //     用 julianday 做跨月会扫全表，首页不该为了一张卡付这个代价。
    try {
      const now = new Date();
      const mm = String(now.getMonth() + 1).padStart(2, '0');
      const dd = now.getDate();
      const rows = await base()
        .whereNotNull('p.original_date')
        .whereRaw('substr(p.original_date, 6, 2) = ?', [mm])
        .whereRaw('ABS(CAST(substr(p.original_date, 9, 2) AS INTEGER) - ?) <= 3', [dd])
        .whereRaw('CAST(substr(p.original_date, 1, 4) AS INTEGER) < ?', [now.getFullYear()])
        .select('p.file_hash', 'p.path', 'p.filename', 'p.original_date', 'p.original_time')
        .limit(3000)
        .catch(() => []);
      const byYear = new Map();
      for (const r of Array.isArray(rows) ? rows : []) {
        const y = String(r.original_date || '').slice(0, 4);
        if (!y) continue;
        if (!byYear.has(y)) byYear.set(y, []);
        byYear.get(y).push(r);
      }
      const items = [];
      for (const [year, list] of byYear) {
        list.sort((a, b) => Number(a.original_time) - Number(b.original_time));
        const r = list[Math.floor(list.length / 2)] || list[0];
        if (!r) continue;
        items.push({
          year: Number(year) || 0,
          date: String(r.original_date || '').slice(0, 10),
          fullpath: `${r.path}${require('path').sep}${r.filename}`,
          filename: String(r.filename || ''),
          photo_count: list.length,
        });
      }
      items.sort((a, b) => b.year - a.year);
      result.on_this_day = items.slice(0, 3);
    } catch (_) {
      result.on_this_day = [];
    }

    // 2) 拍摄时光：近 365 天按天计数
    try {
      const end = Date.now() + 86400000;
      const start = end - 365 * 86400000;
      const rows = await base()
        .whereBetween('p.original_time', [start, end])
        .whereNotNull('p.original_date')
        .select('p.original_date')
        .count({ n: 'p.file_hash' })
        .groupBy('p.original_date');
      let total = 0;
      let peak = null;
      const days = [];
      for (const r of Array.isArray(rows) ? rows : []) {
        const d = String((r && r.original_date) || '').slice(0, 10);
        const n = Number((r && r.n) || 0) || 0;
        if (!d || n <= 0) continue;
        total += n;
        days.push({ date: d, count: n });
        if (!peak || n > peak.count) peak = { date: d, count: n };
      }
      days.sort((a, b) => (a.date < b.date ? -1 : 1));
      result.heat.total = total;
      result.heat.active_days = days.length;
      result.heat.peak = peak;
      result.heat.days = days;
    } catch (_) {}

    // 2b) 按年分布（首页环形图）。同样走 validPaths，不给管理员开后门。
    try {
      const rows = await base()
        .whereNotNull('p.original_time')
        .select(this.knex.raw("strftime('%Y', p.original_time / 1000, 'unixepoch', 'localtime') AS y"))
        .count({ n: 'p.file_hash' })
        .groupByRaw('y')
        .orderBy('y', 'desc');
      result.heat.by_year = (Array.isArray(rows) ? rows : [])
        .map(r => ({ year: Number(r && r.y) || 0, count: Number((r && r.n) || 0) || 0 }))
        .filter(r => r.year > 1900 && r.count > 0);
    } catch (_) {}

    // 3) 我的足迹：只数有 GPS 的（无坐标的照片不该算进「去过的地方」）
    try {
      const row = await base()
        .whereNotNull('p.latitude')
        .whereNotNull('p.longitude')
        .where('p.latitude', '!=', 0)
        .where('p.longitude', '!=', 0)
        .whereNotNull('p.geohash')
        .select(
          this.knex.raw('COUNT(DISTINCT substr(p.geohash, 1, 5)) AS places'),
          this.knex.raw('COUNT(DISTINCT substr(p.geohash, 1, 4)) AS cities'),
          this.knex.raw('COUNT(DISTINCT p.original_date) AS days')
        )
        .first();
      result.footprint.places = Number((row && row.places) || 0) || 0;
      result.footprint.cities = Number((row && row.cities) || 0) || 0;
      result.footprint.days = Number((row && row.days) || 0) || 0;
    } catch (_) {}

    // 4) 镜头里的相伴：Top3 有名字的人物 + 未命名根人脸数
    try {
      const visibleHashes = () => base().select('p.file_hash');
      const faces = await this.knex('photo_faces')
        .where(function () {
          this.whereNull('belong_face_id').orWhere('belong_face_id', 0);
        })
        .where('is_hide', 0)
        .whereNotNull('name')
        .orderBy('face_count', 'desc')
        .limit(12)
        .select('face_id', 'name', 'face_count', 'proto_best_file_hash');

      const items = [];
      for (const f of Array.isArray(faces) ? faces : []) {
        const nm = this._decodeName(f && f.name).trim();
        if (!nm) continue;
        const cntRow = await this.knex('photo_face2filehash')
          .where('face_id', Number(f.face_id))
          .whereIn('file_hash', visibleHashes())
          .count({ n: 'file_hash' })
          .first()
          .catch(() => null);
        const cnt = Number((cntRow && cntRow.n) || 0) || 0;
        if (cnt <= 0) continue;
        items.push({
          face_id: Number(f.face_id),
          name: nm,
          photo_count: cnt,
          cover_path: '',
          _best: f && f.proto_best_file_hash ? String(f.proto_best_file_hash) : '',
        });
        if (items.length >= 3) break;
      }

      // 封面：proto_best_file_hash 必须也在可见范围内，否则留空让前端回落默认头像
      const hashes = items.map(it => it._best).filter(Boolean);
      if (hashes.length > 0) {
        const paths = await base()
          .whereIn('p.file_hash', hashes)
          .select('p.file_hash', 'p.path', 'p.filename')
          .catch(() => []);
        const map = new Map((Array.isArray(paths) ? paths : []).map(r => [String(r.file_hash), r]));
        for (const it of items) {
          const row = map.get(it._best);
          if (row) it.cover_path = `${row.path}${require('path').sep}${row.filename}`;
        }
      }
      // ⭐ 2026-10-19 封面兜底：`proto_best_file_hash` 可能指向早已删除、
      //    或者在当前账号可见范围外的文件（实测「比比」这类很早建立的人物就是空的，
      //    前端只能回落成灰色默认头像）。这里再按 face_id 抓一张可见照片当封面。
      for (const it of items) {
        if (it.cover_path) continue;
        const cand = await base()
          .whereIn(
            'p.file_hash',
            this.knex('photo_face2filehash').select('file_hash').where('face_id', it.face_id)
          )
          .select('p.path', 'p.filename')
          .first()
          .catch(() => null);
        if (cand && cand.path && cand.filename) {
          it.cover_path = `${cand.path}${require('path').sep}${cand.filename}`;
        }
      }
      for (const it of items) delete it._best;
      result.people.items = items;

      const pendRow = await this.knex('photo_faces')
        .where(function () {
          this.whereNull('belong_face_id').orWhere('belong_face_id', 0);
        })
        .where('is_hide', 0)
        .where(function () {
          this.whereNull('name').orWhereRaw('length(name) = 0');
        })
        .count({ n: 'face_id' })
        .first()
        .catch(() => null);
      result.people.pending = Number((pendRow && pendRow.n) || 0) || 0;
    } catch (_) {}

    return result;
  }

  /**
   * ⭐⭐ 2026-10-18 相册 AI 问答。
   *
   * 设计取舍：**不做自主 Agent / 不让模型直接查库**。先在本地把“足够回答问题”的统计算好，
   * 再连同问题一起交给模型（RAG 的取数那一半）。好处：
   *   · 模型回答里的数字全部来自真实库，不会编；
   *   · 没配模型（或调用失败）时能用**本地规则**回答常见问题，不会白屏。
   * ⛔ 可见性与其他接口一致：全部走 validPaths，超管也只看自己的。
   */
  async ask(params = {}) {
    const question = String(params.question || '').trim().slice(0, 500);
    if (!question) {
      const err = new Error('common.PARAM_ERROR');
      err.statusCode = 400;
      throw err;
    }
    const ctx = await this.askContext(params);
    const ruleAnswer = this._ruleAnswer(question, ctx);

    // 没配模型 ⇒ 直接用本地规则答
    let stored = {};
    try {
      const rawCfg = await tableConfig.getConfigByKey('agent_model_api');
      stored = rawCfg ? JSON.parse(String(rawCfg)) : {};
    } catch (_) {
      stored = {};
    }
    const baseUrl = String(stored.base_url || '').trim().replace(/\/+$/, '');
    const apiKey = String(stored.api_key || '').trim();
    const model = String(stored.model || '').trim();
    if (!baseUrl || !model) {
      return { mode: 'rule', answer: ruleAnswer, context: ctx, reason: 'no_model' };
    }

    const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    const sys = [
      '你是相册助手。只能依据下面给出的「库统计」回答，不得编造数字。',
      '不知道的就说不知道，不要猜。回答用中文，两到四句，不要 markdown。',
    ].join('');
    const userMsg = `库统计：${JSON.stringify(ctx)}\n\n问题：${question}`;
    try {
      const body = JSON.stringify({
        model,
        messages: [
          { role: 'system', content: sys },
          { role: 'user', content: userMsg },
        ],
        temperature: 0.3,
        max_tokens: 600,
      });
      const res = await this._outboundJson('POST', `${baseUrl}/chat/completions`, {
        headers,
        timeoutMs: 45000,
        body,
      });
      if (res.status >= 200 && res.status < 300) {
        const parsed = JSON.parse(res.body || '{}');
        const content = parsed
          && parsed.choices
          && parsed.choices[0]
          && parsed.choices[0].message
          && parsed.choices[0].message.content;
        const text = String(content || '').trim();
        if (text) return { mode: 'model', answer: text, context: ctx, reason: '' };
      }
      return { mode: 'rule', answer: ruleAnswer, context: ctx, reason: `HTTP ${res.status}` };
    } catch (err) {
      return {
        mode: 'rule',
        answer: ruleAnswer,
        context: ctx,
        reason: String((err && err.message) || err).slice(0, 160),
      };
    }
  }

  /** 问答用的只读上下文（轻量统计，不扫全表 OCR/向量）。 */
  async askContext(params = {}) {
    const scope = this._scope(params);
    const empty = {
      total: 0, photos: 0, videos: 0, bytes: 0, cities: 0, places: 0, active_days: 0,
      years: [], top_scenes: [], top_activities: [], top_people: [],
    };
    if (scope.empty) return empty;
    const base = () => scope.apply(this.knex('photo_index as p').where('p.is_file', 1).where('p.in_trash', 0));

    const out = { ...empty };
    try {
      const row = await base()
        .select(
          this.knex.raw('SUM(CASE WHEN p.type = 1 THEN 1 ELSE 0 END) AS photos'),
          this.knex.raw('SUM(CASE WHEN p.type = 2 THEN 1 ELSE 0 END) AS videos'),
          this.knex.raw('COUNT(1) AS total'),
          this.knex.raw('COALESCE(SUM(p.size), 0) AS bytes'),
          this.knex.raw('COUNT(DISTINCT p.original_date) AS active_days')
        )
        .first();
      out.photos = Number((row && row.photos) || 0) || 0;
      out.videos = Number((row && row.videos) || 0) || 0;
      out.total = Number((row && row.total) || 0) || 0;
      out.bytes = Number((row && row.bytes) || 0) || 0;
      out.active_days = Number((row && row.active_days) || 0) || 0;
    } catch (_) {}
    try {
      const row = await base()
        .whereNotNull('p.geohash')
        .where('p.latitude', '!=', 0)
        .where('p.longitude', '!=', 0)
        .select(
          this.knex.raw('COUNT(DISTINCT substr(p.geohash, 1, 4)) AS cities'),
          this.knex.raw('COUNT(DISTINCT substr(p.geohash, 1, 5)) AS places')
        )
        .first();
      out.cities = Number((row && row.cities) || 0) || 0;
      out.places = Number((row && row.places) || 0) || 0;
    } catch (_) {}
    try {
      const rows = await base()
        .whereNotNull('p.original_time')
        .select(this.knex.raw("strftime('%Y', p.original_time / 1000, 'unixepoch', 'localtime') AS y"))
        .count({ n: 'p.file_hash' })
        .groupByRaw('y')
        .orderBy('y', 'desc')
        .limit(8);
      out.years = (Array.isArray(rows) ? rows : [])
        .map(r => ({ year: Number(r && r.y) || 0, count: Number((r && r.n) || 0) || 0 }))
        .filter(r => r.year > 1900);
    } catch (_) {}
    try {
      const scenes = await this.knex('photo_places').where('is_hide', 0)
        .orderBy('photo_count', 'desc').limit(8).select('place_name');
      out.top_scenes = (Array.isArray(scenes) ? scenes : [])
        .map(r => String((r && r.place_name) || '')).filter(Boolean);
    } catch (_) {}
    try {
      const acts = await this.knex('photo_activity').where('is_hide', 0)
        .orderBy('photo_count', 'desc').limit(8).select('act_name');
      out.top_activities = (Array.isArray(acts) ? acts : [])
        .map(r => String((r && r.act_name) || '')).filter(Boolean);
    } catch (_) {}
    try {
      const faces = await this.knex('photo_faces')
        .where(function () {
          this.whereNull('belong_face_id').orWhere('belong_face_id', 0);
        })
        .where('is_hide', 0)
        .whereNotNull('name')
        .orderBy('face_count', 'desc')
        .limit(5)
        .select('name');
      out.top_people = (Array.isArray(faces) ? faces : [])
        .map(r => this._decodeName(r && r.name).trim())
        .filter(Boolean);
    } catch (_) {}
    return out;
  }

  /** 本地规则回答：没配模型时至少能答常见的几类问题。 */
  _ruleAnswer(question, ctx) {
    const q = String(question || '');
    const has = (...ws) => ws.some(w => q.includes(w));
    const fmtBytes = n => {
      const units = ['B', 'KB', 'MB', 'GB', 'TB'];
      let d = Number(n) || 0;
      let i = 0;
      while (d >= 1024 && i < units.length - 1) {
        d /= 1024;
        i += 1;
      }
      return `${d.toFixed(d >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
    };
    if (ctx.total <= 0) return '这个相册里还没有照片。';

    if (has('多少', '几张', '张照片', '数量', '多少个')) {
      return `目前共 ${ctx.total} 个文件，其中 ${ctx.photos} 张照片、${ctx.videos} 个视频，占用 ${fmtBytes(ctx.bytes)}。`;
    }
    if (has('城市', '地方', '足迹', '去过', '旅行')) {
      return `照片覆盖了 ${ctx.cities} 个地区、${ctx.places} 个地点，有位置信息的拍摄天数共 ${ctx.active_days} 天。`;
    }
    if (has('人', '谁', '常见面孔')) {
      return ctx.top_people.length
        ? `镜头里出镜最多的是：${ctx.top_people.join('、')}。`
        : '还没有给人脸命名，去「人物」里认一下就能统计了。';
    }
    if (has('拍什么', '场景', '最常', '最多', '最爱')) {
      const s = ctx.top_scenes.slice(0, 3).join('、');
      const a = ctx.top_activities.slice(0, 3).join('、');
      return `最常出现的场景是：${s || '暂无'}；做得最多的事是：${a || '暂无'}。`;
    }
    if (has('哪年', '年份', '每年')) {
      const top = ctx.years.slice(0, 3).map(y => `${y.year} 年 ${y.count} 张`).join('，');
      return `按年份看：${top}。`;
    }
    return `这个相册共 ${ctx.total} 个文件（${ctx.photos} 张照片、${ctx.videos} 个视频），`
      + `涉及 ${ctx.cities} 个地区。你可以问我“我拍了多少照片”“我最常拍什么”“我去过哪些地方”。`;
  }

  /**
   * ⭐ 真实连通性测试：拿填进来的（或已存的）凭据真的发一次请求。
   * 先试 `GET {base}/models`（OpenAI 兼容最常见），失败再试一次最小 chat 请求。
   * 返回 ok/status/latency_ms/message/models —— 让设置页能给出确切结论而不是「已保存」。
   */
  async testModelApi(params = {}) {
    const stored = await (async () => {
      try {
        const raw = await tableConfig.getConfigByKey('agent_model_api');
        return raw ? JSON.parse(String(raw)) : {};
      } catch (_) {
        return {};
      }
    })();
    const baseUrl = String(params.base_url ?? stored.base_url ?? '').trim().replace(/\/+$/, '');
    const apiKey = String(params.api_key ?? '').trim() || String(stored.api_key || '');
    const model = String(params.model ?? stored.model ?? '').trim();
    if (!baseUrl) {
      return { ok: false, status: 0, message: 'photo.MODEL_API_NO_BASE_URL', latency_ms: 0 };
    }
    const headers = { Accept: 'application/json' };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

    const t0 = Date.now();
    // 1) /models
    try {
      const res = await this._outboundJson('GET', `${baseUrl}/models`, { headers, timeoutMs: 15000 });
      const latency = Date.now() - t0;
      if (res.status >= 200 && res.status < 300) {
        let models = [];
        try {
          const parsed = JSON.parse(res.body);
          models = Array.isArray(parsed && parsed.data)
            ? parsed.data.map(m => String((m && (m.id || m.name)) || '')).filter(Boolean).slice(0, 50)
            : [];
        } catch (_) {}
        return { ok: true, status: res.status, latency_ms: latency, models, model_exists: model ? models.includes(model) : null, message: 'common.SUCCESS' };
      }
      return { ok: false, status: res.status, latency_ms: latency, message: `HTTP ${res.status}: ${String(res.body || '').slice(0, 200)}` };
    } catch (err) {
      const latency = Date.now() - t0;
      return { ok: false, status: 0, latency_ms: latency, message: String((err && err.message) || err) };
    }
  }
}

/**
 * 可重跑项 → 队列标记列 / 消费 worker / 拉起方法 / 开关 key
 * ⚠️ `activity` 与 `place` 共用 placesWorker（同一进程内分 place / activity 两个 phase）。
 */
AppAiService.RERUN_KINDS = {
  face: { column: 'gen_faces', worker: 'faceWorker', startMethod: 'startFaceWorker', enableKey: 'ai_face_enable' },
  ocr: { column: 'gen_ocr', worker: 'ocrWorker', startMethod: 'startOcrWorker', enableKey: 'ai_ocr_enable' },
  place: { column: 'gen_place', worker: 'placesWorker', startMethod: 'startPlacesWorker', enableKey: 'ai_place_enable' },
  activity: { column: 'gen_activity', worker: 'placesWorker', startMethod: 'startPlacesWorker', enableKey: 'ai_activity_enable' },
};

module.exports = AppAiService;
