'use strict';

/**
 * 场景识别 v2 worker
 *
 * ⭐ 与 v1 的区别（2026-10-14）：
 * v1 = 单模型 ResNet50-Places365 → 闭集 365 类取 top-1 → 过 0.4 阈值就写入。
 * 结果是全库 top 标签「病房 1224 / 荒漠 1008 / 美容院 836 / 育婴室 835」——
 * 少数 hub 标签吞掉一切，且模型没把握时也硬塞一个标签。
 *
 * v2 = 「CLIP 开放词表零样本」+「Places365」双路 → 类先验校正 → 融合 →
 *      开放集门控（confident / ambiguous / unknown）→ 主标签 + 次标签 + 权重入库。
 *
 * 标定：每个标签的「系统性偏置」无法靠单张图判断，必须拿一批样张统计。
 * 本 worker 首次运行会随机抽 CALIB_SAMPLE 张照片跑双模型，算出：
 *   - 每个 CLIP 标签的 mean/std（z-score 校正用）
 *   - 每个 Places365 类的平均 logit（logit adjustment 用）
 * 结果缓存进 tableConfig（ai_place_calib），模型/词表变了会自动重建。
 */

const path = require('path');
const fs = require('fs');
const Logger = require('../../../utils/logger');
const dbUtil = require('../../../db/dbUtil');
const knexUtil = require('../../../db/knexUtil');
const tableConfig = require('../../../db/table/tableConfig');
const { predictPlaceFull, ensurePlaces365Ready, isRemoteModelError, isPermanentImageError } = require('./placesUtil');
const placesClipUtil = require('./placesClipUtil');
const fusion = require('./placesFusion');
// ⭐ 2026-10-15 活动维度（与场景并行、独立表、独立标志位，见 docs §8.22.7）
const activityUtil = require('./activityUtil');
const personGateUtil = require('./personGateUtil');
const fileService = require('../../../api/modules/file/core/fileService');
const sqliteVec = require('../../../utils/sqliteVecUtil');

const CALIB_CONFIG_KEY = 'ai_place_calib';

/** 活动/场景维度：同一张图最多尝试几次（瞬时错误才计数，永久错误直接放弃） */
const MAX_AI_ATTEMPTS = Math.max(1, Math.min(20, Number(process.env.PLACE_AI_MAX_ATTEMPTS ?? 3)));

/**
 * ⭐ 2026-10-17 判定「永久性图像错误」——重试一万次也不会成功的那类。
 *
 * 依据：这些都是 **sharp / libvips 在解码阶段**报的错，只与文件本身有关
 *（不是图片、或数据损坏），与模型、内存、并发都无关。
 *
 * ⛔ 反面清单（这些是**瞬时**错误，必须重试，绝不能当成永久失败）：
 *    · 模型/权重加载失败（isRemoteModelError 那条路径）
 *    · SQLITE_BUSY / 磁盘 IO 抖动 / ENOMEM
 *    所以这里**只按解码错误特征匹配**，不做「什么都算永久」的粗暴兜底。
 */
// 判定函数已挪到 placesUtil（纯函数、可单测），见那边的 isPermanentImageError
const CALIB_SAMPLE = Math.max(20, Math.min(1000, Number(process.env.PLACE_CALIB_SAMPLE || 200)));

/** 配置键 → 融合参数 */
const CFG_KEYS = {
  ai_place_conf_high: 'highThreshold',
  ai_place_conf_low: 'lowThreshold',
  ai_place_margin: 'marginThreshold',
  ai_place_topk: 'topK',
  ai_place_clip_weight: 'clipWeight',
  ai_place_places_temp: 'placesTemp',
  ai_place_clip_temp: 'clipTemp',
};

/** 活动维度的配置键（阈值可为浮点，与上面那个 Number 循环分开处理） */
const ACTIVITY_CFG_KEYS = {
  ai_activity_threshold: 'actThreshold',
  ai_activity_gate_upper: 'actGateUpper',
  ai_activity_person_threshold: 'personThreshold',
};

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

class PlacesWorker {
  constructor() {
    this.isRunning = false;
    this.batchSize = 10;
    this.config = Object.assign({}, fusion.DEFAULTS);
    this.calib = null;
    this.clipAvailable = false;
    // ⭐ 活动维度（2026-10-15，docs §8.22.7）
    this.activityReady = false;
    this.activityEnabled = false;
    this.activityConfig = Object.assign({}, activityUtil.DEFAULTS);
    this.personGateAvailable = false;
    this.init();
  }

  async init() {
    try {
      await knexUtil.init(dbUtil.DB_PATHS.PHOTO_DB);
      await knexUtil.init(dbUtil.DB_PATHS.MAIN_DB);
      this.knex = knexUtil.getInstance(dbUtil.DB_PATHS.PHOTO_DB);
      const enabled = await tableConfig.getConfigByKey('ai_place_enable').catch(() => '0');
      if (enabled !== '1') {
        process.exit(0);
      }

      Logger.info('[placesWorker] waiting for remote places365 model...');
      await ensurePlaces365Ready();
      Logger.info('[placesWorker] places365 model ready');

      this.clipAvailable = placesClipUtil.isAvailable();
      if (this.clipAvailable) {
        try {
          await placesClipUtil.ensureReady();
        } catch (err) {
          Logger.warn(`[placesWorker] CLIP 不可用，退回单模型模式: ${err && err.message ? err.message : err}`);
          this.clipAvailable = false;
        }
      } else {
        Logger.warn('[placesWorker] 未发现 CLIP 场景模型（onnx_models/clip），本次只跑 Places365');
      }

      // ⭐ 2026-10-15「我不知道」出口：可判性 head 是否就位（缺件只是门控不生效）
      const scorableHead = typeof placesClipUtil.getScorableHead === 'function'
        ? placesClipUtil.getScorableHead() : null;
      if (scorableHead) {
        const st = scorableHead.stats || {};
        Logger.info(`[placesWorker] 可判性 head 已加载：阈值 ${placesClipUtil.getScorableThreshold()}`
          + `，训练 ${st.trainedOn || '?'} 张，CV AUC ${st.oofAuc || '?'}`);
      } else {
        Logger.warn('[placesWorker] 未发现可判性 head（clip/scene_scorable_head.json）'
          + ' ⇒「我不知道」出口不生效，照片仍会 100% 拿到场景标签');
      }

      await this.loadConfig();
      await this.loadOrBuildCalibration();
      await this.initActivity();

      this.isRunning = true;

      await this.startLoop();
    } catch (err) {
      Logger.error('❌ Places Worker init failed:', err);
      process.exit(1);
    }
  }

  async loadConfig() {
    for (const [key, field] of Object.entries(CFG_KEYS)) {
      try {
        const raw = await tableConfig.getConfigByKey(key);
        if (raw === null || raw === undefined || raw === '') continue;
        const num = Number(raw);
        if (Number.isFinite(num)) this.config[field] = num;
      } catch (_) {}
    }
    // ⭐ 可判性出口开关与阈值
    //   阈值是浮点且**可以为负**，不能走上面那个 Number 循环（会被当成噪音数值直接写进去）
    try {
      const gateRaw = await tableConfig.getConfigByKey('ai_place_scorable_gate');
      if (gateRaw !== null && gateRaw !== undefined && gateRaw !== '') {
        const g = String(gateRaw).toLowerCase();
        this.config.scorableGate = !(g === '0' || g === 'false');
      }
    } catch (_) {}
    try {
      const thrRaw = await tableConfig.getConfigByKey('ai_place_scorable_threshold');
      if (thrRaw !== null && thrRaw !== undefined && thrRaw !== '') {
        const num = Number(thrRaw);
        if (Number.isFinite(num) && typeof placesClipUtil.setScorableThreshold === 'function') {
          Logger.info(`[placesWorker] 可判性阈值被配置覆盖为 ${placesClipUtil.setScorableThreshold(num)}`);
        }
      }
    } catch (_) {}
    Logger.info('[placesWorker] 融合参数', JSON.stringify(this.config));
  }

  /**
   * ⭐ 2026-10-15 活动维度初始化（docs §8.22.7）
   *
   * 与场景维度的关系：**并行、不共享标签空间、独立表、独立标志位**。
   *   - 场景：ResNet365 + CLIP → 融合 → 可判性 head → photo_places2filehash（gen_place）
   *   - 活动：SigLIP2 27 候选 → 事后阈值 → DETR 人物门控 → photo_activity2filehash（gen_activity）
   * 为什么必须独立：见 `tablePhotoActivity.js` 文件头（最要紧的一条是
   * **被可判性 head 拦下的人像/合影恰恰最需要活动标签**，挂在场景行上会一起丢）。
   *
   * 开关：`ai_activity_enable`（未设置 = 跟随场景开关，即默认开）。
   * 模型缺失时**整段跳过且不写 gen_activity** ⇒ 以后补上模型会自动重扫，不会被误标成已完成。
   */
  async initActivity() {
    this.activityConfig = Object.assign({}, activityUtil.DEFAULTS);

    let enabled = null;
    try {
      const raw = await tableConfig.getConfigByKey('ai_activity_enable');
      if (raw !== null && raw !== undefined && raw !== '') {
        const s = String(raw).toLowerCase();
        enabled = !(s === '0' || s === 'false');
      }
    } catch (_) {}
    this.activityEnabled = enabled === null ? true : enabled;

    if (!this.activityEnabled) {
      Logger.info('[placesWorker] 活动维度被配置关闭（ai_activity_enable=0）');
      return;
    }
    if (!activityUtil.isAvailable()) {
      Logger.warn('[placesWorker] 未发现活动模型（onnx_models/activity）⇒ 跳过活动维度，'
        + '也不会写 gen_activity（补上模型后会自动重扫）');
      return;
    }

    try {
      await activityUtil.ensureReady();
    } catch (err) {
      Logger.warn(`[placesWorker] 活动模型加载失败，跳过活动维度: ${err && err.message ? err.message : err}`);
      return;
    }
    // 人物门控是可选件：缺件只是门控不生效（拦下率回到 93.6%），不影响活动标签本身
    this.personGateAvailable = false;
    if (personGateUtil.isAvailable()) {
      try {
        await personGateUtil.ensureReady();
        this.personGateAvailable = true;
      } catch (err) {
        Logger.warn(`[placesWorker] 人物门控加载失败（活动标签仍可用）: ${err && err.message ? err.message : err}`);
      }
    } else {
      Logger.warn('[placesWorker] 未发现人物门控模型（onnx_models/person）⇒ 不确定带不做人物否决');
    }

    for (const [key, field] of Object.entries(ACTIVITY_CFG_KEYS)) {
      try {
        const raw = await tableConfig.getConfigByKey(key);
        if (raw === null || raw === undefined || raw === '') continue;
        const num = Number(raw);
        if (Number.isFinite(num)) this.activityConfig[field] = num;
      } catch (_) {}
    }

    this.activityReady = true;
    Logger.info(`[placesWorker] 活动维度已就绪：${activityUtil.getCount()} 个候选，`
      + `τ=${this.activityConfig.actThreshold}，人物门控=${this.personGateAvailable ? '开' : '关'}`);
  }

  /**
   * 抽样一批照片，跑双模型，得到每个标签的"基线分"。
   * 这是整套方案能治好 hub 标签的前提 —— 单张图看不出"这个标签对谁都给高分"。
   */
  async sampleRows(want) {
    const maxRow = await this.knex('photo_index').where({ is_file: 1, in_trash: 0 }).max({ m: 'id' }).first().catch(() => null);
    const maxId = maxRow && maxRow.m ? Number(maxRow.m) : 0;
    const pool = [];
    const seen = new Set();
    const rounds = maxId > 0 ? 6 : 1;
    for (let i = 0; i < rounds && pool.length < want * 4; i += 1) {
      const startId = maxId > 0 ? Math.floor(Math.random() * maxId) : 0;
      const rows = await this.knex('photo_index')
        .select('id', 'path', 'filename')
        .where('id', '>=', startId)
        .andWhere({ gen_place: 1, is_file: 1, in_trash: 0, type: 1 })
        .orderBy('id', 'asc')
        .limit(400)
        .catch(() => []);
      for (const r of rows) {
        if (seen.has(r.id)) continue;
        seen.add(r.id);
        pool.push(r);
      }
    }
    if (pool.length < want) {
      // 没有已识别的老照片（首次全量识别）→ 退回取任何照片
      const rows = await this.knex('photo_index')
        .select('id', 'path', 'filename')
        .where({ is_file: 1, in_trash: 0, type: 1 })
        .orderBy('id', 'asc')
        .limit(2000)
        .catch(() => []);
      for (const r of rows) {
        if (seen.has(r.id)) continue;
        seen.add(r.id);
        pool.push(r);
      }
    }
    for (let i = pool.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      const t = pool[i]; pool[i] = pool[j]; pool[j] = t;
    }
    return pool.slice(0, want);
  }

  async loadOrBuildCalibration() {
    let needBuild = true;
    try {
      const cached = await tableConfig.getJsonConfigByKey(CALIB_CONFIG_KEY);
      if (cached && cached.places && cached.places.count > 0) {
        const clipOk = !this.clipAvailable
          || (cached.clip && cached.clip.labels === placesClipUtil.getLabelCount());
        if (clipOk) {
          this.calib = cached;
          needBuild = false;
          Logger.info(`[placesWorker] 复用标定：Places365 ${cached.places.count} 张样张`
            + `（CLIP ${cached.clip ? cached.clip.labels : 0} 标签）`);
        } else {
          Logger.info('[placesWorker] 标定失效（CLIP 词表变了），重新标定');
        }
      }
    } catch (_) {}

    if (!needBuild) return;
    if (process.env.PLACE_CALIB_REBUILD === '0') {
      Logger.warn('[placesWorker] PLACE_CALIB_REBUILD=0，跳过标定（将不做类先验校正）');
      return;
    }

    const rows = await this.sampleRows(CALIB_SAMPLE);
    if (!rows.length) {
      Logger.warn('[placesWorker] 标定样本为空，跳过（将不做类先验校正）');
      return;
    }
    const simRows = [];
    const logitRows = [];
    let placesDim = 0;
    const t0 = Date.now();
    for (const row of rows) {
      const full = path.join(String(row.path || ''), String(row.filename || ''));
      if (!full || !fs.existsSync(full)) continue;
      try {
        const p = await predictPlaceFull(full);
        if (!p.logits || !p.logits.length) continue;
        placesDim = p.logits.length;
        logitRows.push(p.logits);
        if (this.clipAvailable) {
          const c = await placesClipUtil.scoreImage(full, { topK: 1 });
          simRows.push(Array.from(c.sims));
        }
      } catch (err) {
        if (isRemoteModelError(err)) throw err;
        // 单张失败不影响标定
      }
    }
    if (!logitRows.length) {
      Logger.warn('[placesWorker] 标定失败：没有可用样张');
      return;
    }

    const built = fusion.buildCalibration(this.clipAvailable ? simRows : null, logitRows);
    this.calib = {
      clip: built.clip ? Object.assign({ labels: placesClipUtil.getLabelCount() }, built.clip) : null,
      places: built.places ? Object.assign({ dim: placesDim }, built.places) : null,
      createdAt: new Date().toISOString(),
    };
    Logger.info(`[placesWorker] 标定完成：Places365 ${logitRows.length} 张 / ${Date.now() - t0}ms`
      + `（CLIP ${this.calib.clip ? this.calib.clip.labels : 0} 标签，Places365 ${placesDim} 类）`);
    try {
      await tableConfig.setJsonConfigByKey(CALIB_CONFIG_KEY, this.calib);
    } catch (err) {
      Logger.warn('[placesWorker] 标定结果持久化失败（不影响本次运行）', err);
    }
  }

  async startLoop() {
    await this.runScenePhase();
    await this.runActivityPhase();
    process.exit(0);
  }

  /**
   * 场景阶段（原逻辑，行为不变）—— 只是把「没活干了就退出」改成「返回」，
   * 好让活动阶段接手。⚠️ remoteModelError 的重试语义保持原样（break 出 for 再轮询）。
   */
  async runScenePhase() {
    while (this.isRunning) {
      try {
        const rows = await this.getNextBatch();
        if (!rows || rows.length === 0) {
          Logger.info('✅ No pending scene tasks, scene phase done');
          return;
        }

        for (const row of rows) {
          if (!this.isRunning) return;
          try {
            await this.processOne(row);
          } catch (err) {
            if (isRemoteModelError(err)) {
              Logger.warn('[placesWorker] model not ready, retry later', {
                error: err && err.message ? err.message : String(err),
              });
              await sleep(5000);
              break;
            }
            throw err;
          }
        }
      } catch (err) {
        if (isRemoteModelError(err)) {
          Logger.warn('[placesWorker] model not ready in loop, retry later', {
            error: err && err.message ? err.message : String(err),
          });
          await sleep(5000);
          continue;
        }
        Logger.error('❌ Places Worker loop error:', err);
        await sleep(1000);
      }
    }
  }

  /**
   * ⭐ 活动阶段（新增，docs §8.22.7）
   *
   * 独立查询 `gen_activity=0`（老数据默认 0 ⇒ 自动全量重扫，场景标签不受影响）。
   * 与场景阶段串行跑：先场景后活动，共用同一个 worker 进程与 knex 连接。
   * 本阶段的任何失败都**不写 gen_activity**，避免把未处理的照片标成已完成。
   */
  async runActivityPhase() {
    if (!this.activityReady || !this.isRunning) return;

    let done = 0;
    let tagged = 0;
    let gated = 0;
    let abandoned = 0; // ⭐ 2026-10-17 放弃计数：让「跑完了但有 N 张没成功」可见
    const t0 = Date.now();

    while (this.isRunning) {
      let rows = [];
      try {
        rows = await this.getNextActivityBatch();
      } catch (err) {
        Logger.error('❌ activity batch query failed:', err);
        return;
      }
      if (!rows || rows.length === 0) break;

      for (const row of rows) {
        if (!this.isRunning) return;
        try {
          const r = await this.processActivityOne(row);
          done += 1;
          if (r && r.tagged) tagged += 1;
          if (r && r.gated) gated += 1;
        } catch (err) {
          // ⭐ 2026-10-17 失败语义修复。原来这里**不写标志位** ⇒ 永久失败的文件（不是图片/
          //    已损坏）会被无限重试：实测 jpush_uid.png 重试 78 次、PA290862.JPG 39 次，
          //    而且 gen_activity 永远降不到 0（用户看到的「待处理」数字是假的）。
          //    现在：永久性解码错误**立即放弃并记录原因**；瞬时错误最多重试 MAX_AI_ATTEMPTS 次。
          const id = row && row.id ? Number(row.id) : 0;
          const name = row && row.filename ? row.filename : '(未知)';
          if (!id) {
            Logger.error(`❌ activity failed（无 id，无法记账）: ${name}`, err);
          } else {
            const attempts = await this.bumpActivityAttempts(id);
            const reason = err && err.message ? String(err.message).slice(0, 140) : String(err);
            if (isPermanentImageError(err)) {
              await this.markActivityDone(id);
              abandoned += 1;
              Logger.warn(`[activity] 放弃（图像不可解码，第 ${attempts} 次，以后不再重试）: ${name} —— ${reason}`);
            } else if (attempts >= MAX_AI_ATTEMPTS) {
              await this.markActivityDone(id);
              abandoned += 1;
              Logger.error(`[activity] 放弃（已尝试 ${attempts}/${MAX_AI_ATTEMPTS} 次）: ${name} —— ${reason}`);
            } else if (attempts <= 2 || attempts % 10 === 0) {
              Logger.warn(`[activity] 第 ${attempts}/${MAX_AI_ATTEMPTS} 次失败，将重试: ${name} —— ${reason}`);
            } else {
              Logger.debug(`[activity] 第 ${attempts} 次失败: ${name}`);
            }
          }
        }
        if (done > 0 && done % 500 === 0) {
          const s = (Date.now() - t0) / 1000;
          Logger.info(`[placesWorker] 活动维度进度：${done} 张，命中活动 ${tagged} 张，`
            + `跑过人物门控 ${gated} 张，均速 ${(s / done).toFixed(2)}s/张`);
        }
      }
    }

    if (done > 0) {
      const s = (Date.now() - t0) / 1000;
      Logger.info(`[placesWorker] ✅ 活动维度完成：${done} 张，命中活动 ${tagged} 张`
        + `（${(100 * tagged / done).toFixed(1)}%），跑过人物门控 ${gated} 张`
        + `（${(100 * gated / done).toFixed(1)}%），放弃 ${abandoned} 张（图像不可解码或多次失败），`
        + `耗时 ${(s / 60).toFixed(1)} 分钟`);
    } else {
      Logger.info('✅ No pending activity tasks, activity phase done');
    }
  }

  async getNextActivityBatch() {
    return this.knex('photo_index')
      .select('id', 'path', 'filename', 'file_hash', 'type')
      .where({ gen_activity: 0, is_file: 1, in_trash: 0 })
      .whereIn('type', [1, 2])
      .orderBy('id', 'asc')
      .limit(this.batchSize)
      .catch(() => []);
  }

  /**
   * 活动维度单张处理。
   * @returns {{tagged:boolean, gated:boolean}} tagged=写了活动标签；gated=跑过人物门控
   */
  async processActivityOne(row) {
    const id = row && row.id ? Number(row.id) : 0;
    if (!id) return { tagged: false, gated: false };

    const fileHash = row.file_hash ? String(row.file_hash) : '';
    if (!fileHash) {
      await this.markActivityDone(id);
      return { tagged: false, gated: false };
    }

    // ⚠️ 必须**先查是否已写过**再插入。原因：better-sqlite3 下
    //   `insert(...).onConflict(['file_hash']).ignore()` 命中冲突时返回的是 `[undefined]`，
    //   而 `Array.isArray(x) && x.length > 0` 会把它当成「插入成功」⇒ 聚合表计数被多算。
    //   （实测：重复 hash 提交 4 次，明细表只有 3 行但 photo_count = 3 而非 2。）
    //   场景维度一直是靠这个预检查规避的，活动维度照做。
    const existed = await this.knex('photo_activity2filehash')
      .where({ file_hash: fileHash })
      .first('id')
      .catch(() => null);
    if (existed && existed.id) {
      await this.markActivityDone(id);
      return { tagged: false, gated: false };
    }

    const fullPath = path.join(String(row.path || ''), String(row.filename || ''));
    if (!fullPath || !fs.existsSync(fullPath)) {
      await this.markActivityDone(id);
      return { tagged: false, gated: false };
    }

    // 视频用缩略图（与场景维度同一处理）
    const type = row && row.type ? Number(row.type) : 0;
    let imagePath = fullPath;
    if (type === 2) {
      try {
        imagePath = await fileService.getTinyImgByPath(fullPath, undefined, { deferSlowIo: false, deferImages: false });
      } catch (err) {
        Logger.error(`❌  video thumbnail failed (activity): ${fullPath}`, err);
        await this.markActivityDone(id);
        return { tagged: false, gated: false };
      }
    }
    if (!imagePath || !fs.existsSync(imagePath)) {
      await this.markActivityDone(id);
      return { tagged: false, gated: false };
    }

    const scored = await activityUtil.scoreImage(imagePath, { topK: 3 });

    // ⭐ 只在不确定带才跑 DETR（实测占 9.4% 照片），这是成本可控的关键
    let personProb = null;
    let gated = false;
    if (this.personGateAvailable && activityUtil.needPersonGate(scored.topScore, this.activityConfig)) {
      try {
        const pg = await personGateUtil.personProbability(imagePath);
        personProb = pg.personProb;
        gated = true;
      } catch (err) {
        Logger.warn(`[placesWorker] 人物门控失败，本张按无门控处理: ${err && err.message ? err.message : err}`);
      }
    }

    const verdict = activityUtil.decideActivity(scored.topScore, personProb, this.activityConfig);
    const primary = scored.top.length ? scored.top[0] : null;

    if (!verdict.activity || !primary || !primary.key) {
      // 无活动 ⇒ **不写行**（与场景维度「head 拦下不写行」同一思路）。
      // 97.1% 的照片走这条路，省掉大量无用行。
      await this.markActivityDone(id);
      return { tagged: false, gated };
    }

    const alts = scored.top.slice(1).map(t => ({ key: t.key, name: t.label, score: t.sim }));
    const score = Math.max(0, Math.min(1, Number(primary.sim) || 0));

    try {
      await this.knex.transaction(async trx => {
        // 聚合表：首次见到该活动就建行
        await trx('photo_activity')
          .insert({
            act_key: String(primary.key),
            act_name: String(primary.label || ''),
            photo_count: 0,
            score_sum: 0,
            count_high: 0,
            is_hide: 0,
            update_time: trx.fn.now(),
            create_time: trx.fn.now(),
          })
          .onConflict(['act_key'])
          .ignore();

        const inserted = await trx('photo_activity2filehash')
          .insert({
            act_key: String(primary.key),
            act_name: String(primary.label || ''),
            act_score: score,
            act_status: 'activity',
            act_alt: alts.length ? JSON.stringify(alts) : null,
            file_hash: fileHash,
            create_time: trx.fn.now(),
          })
          .onConflict(['file_hash'])
          .ignore();

        const didInsert = typeof inserted === 'number'
          ? inserted > 0
          : Array.isArray(inserted) ? inserted.length > 0 : !!inserted;
        if (didInsert) {
          await trx('photo_activity')
            .where({ act_key: String(primary.key) })
            .update({
              photo_count: trx.raw('photo_count + 1'),
              score_sum: trx.raw('score_sum + ?', [score]),
              count_high: score >= 0.2 ? trx.raw('count_high + 1') : trx.raw('count_high + 0'),
              update_time: trx.fn.now(),
            })
            .catch(() => {});
        }

        await trx('photo_index').where({ id }).update({ gen_activity: 1 });
      });
      return { tagged: true, gated };
    } catch (err) {
      Logger.error('❌  activity DB write failed:', err);
      // ⚠️ 写库失败**不置标志位**，下次会重试
      return { tagged: false, gated };
    }
  }

  async markActivityDone(id) {
    await this.knex('photo_index')
      .where({ id })
      .update({ gen_activity: 1 })
      .catch(() => {});
  }

  /**
   * ⭐ 2026-10-17 活动维度尝试次数 +1，返回自增后的值。
   * 用「先读后写」而不是 SQL 自增：better-sqlite3 + knex 下 `.increment()` 的返回语义不稳，
   * 而这里需要拿到**准确的新值**来做「是否达到上限」的判断。
   */
  async bumpActivityAttempts(id) {
    const numId = Number(id) || 0;
    if (!numId) return 0;
    try {
      const row = await this.knex('photo_index').where({ id: numId }).select('gen_activity_attempts').first();
      const next = Math.max(0, Number(row && row.gen_activity_attempts) || 0) + 1;
      await this.knex('photo_index').where({ id: numId }).update({ gen_activity_attempts: next });
      return next;
    } catch (_) {
      return 1;
    }
  }

  async getNextBatch() {
    return this.knex('photo_index')
      .select('id', 'path', 'filename', 'file_hash', 'type')
      .where({ gen_place: 0, is_file: 1, in_trash: 0 })
      .whereIn('type', [1, 2])
      .orderBy('id', 'asc')
      .limit(this.batchSize)
      .catch(() => []);
  }

  /**
   * 单张图：双模型打分 → 融合门控。
   * 实现体在 placesFusion.recognizeScene（离线校验脚本调的是同一个函数）。
   */
  async recognize(imagePath) {
    // ⭐ 2026-10-16 P0-3：顺手把 CLIP 图像嵌入留下来（以图搜图要用）。
    // 只在这一处捕获，并带上「当前照片 id」；写入时校验 id 一致，
    // 杜绝长驻 worker 里跨张复用字段导致的「上一张的向量写到这一张上」。
    this._clipEmb = null;
    const scoreClip = this.clipAvailable
      ? async (p) => {
        try {
          const scored = await placesClipUtil.scoreImage(p, { topK: 1 });
          if (scored && scored.emb) this._clipEmb = { id: this._clipTargetId, emb: scored.emb };
          return scored;
        } catch (err) {
          Logger.warn(`[placesWorker] CLIP 打分失败，本张只用 Places365: ${err && err.message ? err.message : err}`);
          return null;
        }
      }
      : null;
    return fusion.recognizeScene({
      imagePath,
      config: this.config,
      calib: this.calib,
      predictPlaces: predictPlaceFull,
      scoreClip,
    });
  }

  async processOne(row) {
    const id = row && row.id ? Number(row.id) : 0;
    if (!id) return;

    const fileHash = row.file_hash ? String(row.file_hash) : '';
    if (!fileHash) {
      await this.markIndexDone(id);
      return;
    }

    const existed = await this.knex('photo_places2filehash')
      .where({ file_hash: fileHash })
      .first('id')
      .catch(() => null);
    if (existed && existed.id) {
      await this.markIndexDone(id);
      return;
    }

    const fullPath = path.join(String(row.path || ''), String(row.filename || ''));
    if (!fullPath || !fs.existsSync(fullPath)) {
      await this.markIndexDone(id);
      return;
    }

    const type = row && row.type ? Number(row.type) : 0;
    let imagePath = fullPath;
    if (type === 2) {
      try {
        imagePath = await fileService.getTinyImgByPath(fullPath, undefined, { deferSlowIo: false, deferImages: false });
      } catch (err) {
        Logger.error(`❌  video thumbnail failed: ${fullPath}`, err);
        await this.markIndexDone(id);
        return;
      }
    }
    if (!imagePath || !fs.existsSync(imagePath)) {
      await this.markIndexDone(id);
      return;
    }

    let result = null;
    this._clipTargetId = id; // 供 scoreClip 记录「这一张」的向量归属
    try {
      result = await this.recognize(imagePath);
    } catch (err) {
      if (isRemoteModelError(err)) {
        throw err;
      }
      // ⭐ 2026-10-17 这里的「失败即完成」是**有意为之**（避免无限重试），保留；
      //    但原来连计数都没有 ⇒「跑完了但有 N 张没成功」完全不可见。补上：
      //    永久性解码错误单独计数，结束汇总里报出来。
      if (isPermanentImageError(err)) {
        this.abandonedCount = (this.abandonedCount || 0) + 1;
        if (this.abandonedCount <= 3 || this.abandonedCount % 100 === 0) {
          Logger.warn(`[scene] 放弃（图像不可解码，第 ${this.abandonedCount} 张）: ${imagePath} —— `
            + `${err && err.message ? String(err.message).slice(0, 120) : err}`);
        }
      } else {
        Logger.error(`❌  scene recognition failed: ${imagePath}`, err);
      }
      await this.markIndexDone(id);
      return;
    }

    const primary = result && result.primary ? result.primary : null;
    if (!primary || !primary.label) {
      // ⭐ 2026-10-15「我不知道」出口：head 认为这张照片不该给场景标签 ⇒ **不写任何场景行**。
      // 不写行（而不是写一行 unknown）的好处：它天然不进任何场景相册、也不会被场景搜索
      // 命中，**一行查询都不用改**；photo_places 的计数也不会被污染。
      if (result && result.blockedByScorable) {
        this.blockedCount = (this.blockedCount || 0) + 1;
        if (this.blockedCount === 1 || this.blockedCount % 200 === 0) {
          Logger.info(`[placesWorker] 已拦下 ${this.blockedCount} 张「不该判场景」的照片（不给场景标签）`);
        }
      }
      await this.markIndexDone(id);
      return;
    }

    // ⭐ 铁柱选定：低置信不丢，保留主标签但降权。
    // 权重 = 融合置信度（0~1），列表按 weight_sum 排序，低置信照片自然沉底。
    const placeName = String(primary.label);
    const weight = Math.max(0, Math.min(1, Number(primary.weight) || 0));
    const status = result.status || 'ambiguous';
    const altList = Array.isArray(result.alt) ? result.alt.filter(a => a && a.label) : [];
    const primaryAlt = altList.length ? String(altList[0].label) : '';
    const altsJson = altList.length ? JSON.stringify(altList) : null;

    const tagged = [{ label: placeName, weight }];
    for (const a of altList) {
      if (a.label && a.label !== placeName) tagged.push({ label: String(a.label), weight: Math.max(0, Number(a.weight) || 0) });
    }

    try {
      await this.knex.transaction(async trx => {
        for (const t of tagged) {
          await trx('photo_places')
            .insert({
              place_name: t.label,
              photo_count: 0,
              weight_sum: 0,
              count_high: 0,
              is_hide: 0,
              update_time: trx.fn.now(),
              create_time: trx.fn.now(),
            })
            .onConflict(['place_name'])
            .ignore();
        }

        const inserted = await trx('photo_places2filehash')
          .insert({
            place_name: placeName,
            alt_place_name: primaryAlt && primaryAlt !== placeName ? primaryAlt : null,
            place_score: weight,
            place_status: status,
            alt_labels: altsJson,
            file_hash: fileHash,
            create_time: trx.fn.now(),
          })
          .onConflict(['file_hash'])
          .ignore();

        const didInsert = typeof inserted === 'number'
          ? inserted > 0
          : Array.isArray(inserted) ? inserted.length > 0 : !!inserted;
        if (didInsert) {
          for (const t of tagged) {
            const isPrimary = t.label === placeName;
            await trx('photo_places')
              .where({ place_name: t.label })
              .update({
                photo_count: trx.raw('photo_count + 1'),
                weight_sum: trx.raw('weight_sum + ?', [t.weight]),
                count_high: isPrimary && status === 'confident'
                  ? trx.raw('count_high + 1')
                  : trx.raw('count_high + 0'),
                update_time: trx.fn.now(),
              })
              .catch(() => {});
          }
        }

        // ⭐ 被可判性 head 拦下的照片不给场景标签，但**向量照样留下** —— 以图搜图不该漏掉这些
        await trx('photo_index').where({ id }).update({ gen_place: 1, ...this.clipEmbColumn(id) });
        await this.syncVecEmb(trx, id);
      });
    } catch (err) {
      Logger.error('❌  scene DB write failed:', err);
      await this.markIndexDone(id);
    }
  }

  /**
   * ⭐ 2026-10-16 P0-3：把本轮算出的 CLIP 图像向量转成 update 片段。
   * 必须校验 id —— `_clipEmb` 是跨张复用的实例字段，不校验就会静默写错数据
   * （比「没有向量」更糟：以图搜图会返回一张毫不相干的图）。
   */
  clipEmbColumn(id) {
    const cached = this._clipEmb;
    if (!cached || !cached.emb || Number(cached.id) !== Number(id)) return {};
    try {
      const emb = cached.emb;
      // ⭐ 2026-10-17 同步记下塔标识，供检索时拒绝跨塔比较。
      return {
        clip_emb: Buffer.from(emb.buffer, emb.byteOffset, emb.byteLength),
        emb_model: placesClipUtil.getModelTag() || null,
      };
    } catch (_) {
      return {};
    }
  }

  /**
   * ⭐ 2026-10-17 把本轮的图像向量同步进 vec0 检索表（photo_emb）。
   * 与 clipEmbColumn 同一份数据、同一套 id 校验；失败只降级（旧的全表扫路径仍能跑）。
   * ⚠️ 不能并进 clipEmbColumn —— 后者返回的是 photo_index 的 update 片段，
   *   而 vec0 是另一张表，必须单独写。
   */
  async syncVecEmb(knexOrTrx, id) {
    const cached = this._clipEmb;
    if (!cached || !cached.emb || Number(cached.id) !== Number(id)) return;
    await sqliteVec.upsertEmb(knexOrTrx, id, cached.emb).catch(() => {});
  }

  async markIndexDone(id) {
    await this.knex('photo_index')
      .where({ id })
      .update({ gen_place: 1, ...this.clipEmbColumn(id) })
      .catch(() => {});
    await this.syncVecEmb(this.knex, id);
  }

  stop() {
    this.isRunning = false;
  }
}

const worker = new PlacesWorker();

process.on('message', message => {
  if (!message || !message.type) return;
  if (message.type === 'stop') worker.stop();
});

process.on('uncaughtException', err => {
  Logger.error('❌ places worker uncaughtException', err);
  process.exit(0);
});

process.on('unhandledRejection', reason => {
  Logger.error('❌ places worker unhandledRejection', reason);
  process.exit(0);
});
