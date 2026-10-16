const FaceService = require('../face/faceService');
const PlacesService = require('../places/placesService');
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
          const raw = await tableConfig.getConfigByKey(w.enableKey).catch(() => null);
          const on = !(raw !== null && raw !== undefined && ['0', 'false'].includes(String(raw).toLowerCase()));
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
      { key: 'clip', column: 'clip_emb', worker: 'placesWorker', enableKey: 'ai_place_enable', isNull: true },
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

    const items = [];
    for (const step of STEPS) {
      const pendingQuery = base();
      if (step.isNull) pendingQuery.whereNull(`p.${step.column}`);
      else pendingQuery.where(`p.${step.column}`, 0);
      const doneQuery = base();
      if (step.isNull) doneQuery.whereNotNull(`p.${step.column}`);
      else doneQuery.where(`p.${step.column}`, 1);

      const [pending, done] = await Promise.all([countWhere(pendingQuery), countWhere(doneQuery)]);
      const total = pending + done;

      let enabled = true;
      if (step.enableKey) {
        const raw = await tableConfig.getConfigByKey(step.enableKey).catch(() => null);
        if (raw !== null && raw !== undefined && raw !== '') {
          enabled = !['0', 'false'].includes(String(raw).toLowerCase());
        }
      }

      items.push({
        key: step.key,
        pending,
        done,
        total,
        percent: total > 0 ? Math.round((done / total) * 100) : 100,
        worker: step.worker,
        running: isWorkerRunning(step.worker),
        enabled,
      });
    }

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
   * ⭐ P1-13 票据 / 行程（轻量版）。
   *
   * 不做 TrailSnap 那套（YOLO 检框 + 3351 站白名单 + 铁路运行图），只用**已有 OCR 文本 + 正则**：
   *   1) 在 photo_info_fts.ocr 里找票据特征词（车次/票价/元/检票/席别/站/航班/登机口…）；
   *   2) 命中的照片按拍摄日期 + 地理位置跳变聚成「行程候选」；
   *   3) 只输出原始文本片段，站名/车次不做完整库。
   * 依据：这些照片的 OCR 早就跑完了，规则判定的边际成本≈0。
   */
  async tickets(params = {}) {
    const scope = this._scope(params);
    if (scope.empty) return { tickets: [], trips: [] };
    const limit = Math.max(1, Math.min(500, Number(params.limit) || 200));

    const q = this.knex('photo_index as p')
      .join('photo_info_fts as fts', function () {
        this.on('fts.file_hash', '=', 'p.file_hash');
      })
      .where('p.is_file', 1)
      .where('p.in_trash', 0)
      .whereNotNull('p.original_time')
      .select('p.file_hash', 'p.path', 'p.filename', 'p.original_time', 'p.original_date', 'p.latitude', 'p.longitude', 'fts.ocr')
      .orderBy('p.original_time', 'desc')
      .limit(Math.max(2000, limit * 20));
    scope.apply(q);
    const rows = await q.catch(() => []);

    const RULES = [
      { key: 'train', label: '火车票', words: ['车次', '票价', '席别', '检票', '出发站', '到达站', '成人票', '儿童票', '二等座', '一等座', '硬座', '硬卧', '软卧'] },
      { key: 'flight', label: '机票', words: ['航班', '登机口', '值机', '舱位', 'boarding', 'flight', 'gate', 'airline', '登机牌'] },
      { key: 'ticket_other', label: '门票/票据', words: ['门票', '入场券', '影票', '座位', '排', '取票码', '订单号', '发票'] },
    ];
    const trainNo = /\b([GDCKTZ]\d{1,4})\b/;
    const dateRe = /(20\d{2})[-年\/.](\d{1,2})[-月\/.](\d{1,2})/;

    const tickets = [];
    for (const r of Array.isArray(rows) ? rows : []) {
      const text = String(r.ocr || '');
      if (text.length < 4) continue;
      for (const rule of RULES) {
        const hitWords = rule.words.filter(w => text.includes(w));
        const m = trainNo.exec(text);
        if (hitWords.length === 0 && !m) continue;
        const dm = dateRe.exec(text);
        tickets.push({
          kind: rule.key,
          kind_label: rule.label,
          file_hash: String(r.file_hash),
          fullpath: `${r.path}${require('path').sep}${r.filename}`,
          filename: String(r.filename || ''),
          shot_at: new Date(Number(r.original_time)).toISOString(),
          date: dm ? `${dm[1]}-${String(dm[2]).padStart(2, '0')}-${String(dm[3]).padStart(2, '0')}` : String(r.original_date || '').slice(0, 10),
          train_no: m ? m[1] : '',
          lat: Number(r.latitude) || 0,
          lng: Number(r.longitude) || 0,
          evidence: hitWords.slice(0, 8),
          text_excerpt: text.slice(0, 200),
        });
        break; // 一张照片只归一类
      }
      if (tickets.length >= limit) break;
    }

    // 行程聚类：按（日期 + 地理跳变）合并
    const byDate = tickets
      .slice()
      .sort((a, b) => (a.shot_at < b.shot_at ? -1 : 1));
    const trips = [];
    let cur = null;
    for (const t of byDate) {
      const tMs = new Date(t.shot_at).getTime();
      if (!cur) {
        cur = { start: t.shot_at, end: t.shot_at, tickets: [t], kinds: new Set([t.kind]) };
        continue;
      }
      const gapDays = (tMs - new Date(cur.end).getTime()) / 86400000;
      const dKm = this._distanceKm(cur.lastLat, cur.lastLng, t.lat, t.lng);
      // 相邻票据：>7 天算新行程（与足迹「七天断线」同一口径）
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
      cur.lastJumpKm = dKm;
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
    for (const [key, list] of buckets) {
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

    return { candidates: candidates.slice(0, Math.max(1, Math.min(200, Number(params.limit) || 60))), memories: await this.listMemories(params) };
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

    const q = this.knex('photo_index as p')
      .where('p.is_file', 1)
      .where('p.in_trash', 0)
      .whereNotNull('p.content_md5')
      // ⭐ 带上 id：清理动作要按 photo_index.id 走 P0-6 的「预演 → 执行 → 可撤销」
      .select('p.id', 'p.file_hash', 'p.path', 'p.filename', 'p.size', 'p.content_md5')
      .orderBy('p.size', 'desc')
      .limit(20000);
    scope.apply(q);
    const rows = await q.catch(() => []);

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
      similar_groups: { listed: similarListed },
    };
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
      .select('p.file_hash', 'p.type', 'p.original_time', 'p.original_date', 'p.geohash5', 'p.camera', 'p.size')
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
    const cameras = new Map();
    let bytes = 0;
    let videos = 0;
    for (const r of rows) {
      const d = new Date(Number(r.original_time));
      months[d.getMonth()] += 1;
      const day = String(r.original_date || '').slice(0, 10);
      if (day) days.set(day, (days.get(day) || 0) + 1);
      if (r.geohash5) cells.add(String(r.geohash5));
      const cam = r.camera ? String(r.camera).trim() : '';
      if (cam) cameras.set(cam, (cameras.get(cam) || 0) + 1);
      bytes += Number(r.size) || 0;
      if (Number(r.type) === 2) videos += 1;
    }

    const hashes = rows.map(r => String(r.file_hash)).filter(Boolean);
    const sample = hashes.slice(0, 8000); // 标签聚合只抽样，避免 IN 过大
    const labels = await this._labelsOfHashes(sample, { scenes: true, activities: true, people: true });
    const sceneCount = new Map();
    const actCount = new Map();
    const peopleMap = new Map();
    for (const h of sample) {
      for (const s of labels.scenes.get(h) || []) sceneCount.set(s, (sceneCount.get(s) || 0) + 1);
      for (const a of labels.activities.get(h) || []) actCount.set(a, (actCount.get(a) || 0) + 1);
      for (const p of labels.people.get(h) || []) if (p.name) peopleMap.set(p.face_id, p.name);
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
      top_people: topN(peopleMap, 8),
      top_cameras: topN(cameras, 5),
      busy_days: busyDays,
      sampled: sample.length,
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
