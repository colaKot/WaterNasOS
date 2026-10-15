'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const Logger = require('../../../utils/logger');
const dbUtil = require('../../../db/dbUtil');
const knexUtil = require('../../../db/knexUtil');
const tableConfig = require('../../../db/table/tableConfig');
const { getFaceEngine, bufferToFloat32, float32ToBuffer, normalizeL2, protoWeightFactor, pushTopRoot, decideFaceAssignment, selectMergePairs } = require('./faceUtil');
const fileService = require('../../../api/modules/file/core/fileService');
const remoteAssets = require('../../../utils/remoteAssetsManager');
const { Worker: ThreadWorker, isMainThread, workerData: threadWorkerData } = require('worker_threads');

// ⭐ 2026-10-13 识别多线程：
// 实测单张「检测(960px E2E) ~300ms + 特征 ~6ms」，检测是绝对瓶颈，53,335 张待识别
// 单线程要跑 ~4.5 小时。现在 coordinator 进程内起 N 个 worker_thread 并行做
// 「检测+特征提取」，聚类与 DB 写入仍严格单线程顺序执行（原型 Map 不能并发改）。
// 线程数优先级：环境变量 FACE_THREADS > DB 配置 ai_face_threads > 默认 3。
const DEFAULT_FACE_THREADS = 3;
const MAX_FACE_THREADS = 8;
function clampThreadCount(n) {
  const v = Math.floor(Number(n));
  if (!Number.isFinite(v) || v < 1) return 1;
  return Math.min(MAX_FACE_THREADS, v);
}
let FACE_THREADS = clampThreadCount(process.env.FACE_THREADS || DEFAULT_FACE_THREADS);

// 人脸聚类/维护相关超参数（均可通过环境变量覆盖）。
// 说明约定：
// - 相似度/阈值一般指 embedding 的余弦相似度（越大越像，范围约 [-1, 1]，本项目通常在 [0, 1] 内工作）。
// - qualityScore 为 faceUtil 产出的综合质量分（0~100），会影响过滤、动态阈值、原型更新与维护策略。

// 基础匹配阈值：在动态阈值计算的“基线”。越大越严格（更少错分，但更容易分裂）。
let SIM_THRESH = Math.max(0, Math.min(1, Number(process.env.FACE_SIM_THRESH ?? 0.45)));

// 入库最低质量：低于该值的人脸不会参与聚类/入库（避免模糊、侧脸、截断等噪声造成错分与原型污染）。
let MIN_QUALITY = Math.max(0, Math.min(100, Number(process.env.FACE_MIN_QUALITY ?? 75)));

// 原型更新最低质量：匹配到已有 face 后，只有质量 >= 该值的样本才允许更新原型向量（低质只计数不改原型）。
const PROTO_UPDATE_MIN_QUALITY = Math.max(0, Math.min(100, Number(process.env.FACE_PROTO_UPDATE_MIN_QUALITY ?? 78)));

// 动态匹配阈值下界：动态阈值最终会被 clamp 到 [DYN_THRESH_MIN, DYN_THRESH_MAX]，避免过松或过严。
const DYN_THRESH_MIN = Math.max(0, Math.min(1, Number(process.env.FACE_DYN_THRESH_MIN ?? 0.28)));
// 动态匹配阈值上界：越小越不容易分裂，但更容易把无关人并到一起；越大相反。
const DYN_THRESH_MAX = Math.max(0, Math.min(1, Number(process.env.FACE_DYN_THRESH_MAX ?? 0.75)));

// 质量惩罚系数：质量越低，匹配所需阈值越高（更严格，抑制低质样本把错分“带进来”）。
// 计算大致为：req = SIM_THRESH + (1 - q/100) * DYN_QUALITY_PENALTY + ...
const DYN_QUALITY_PENALTY = Math.max(0, Math.min(0.3, Number(process.env.FACE_DYN_THRESH_QUALITY_PENALTY ?? 0.15)));

// 高质量阈值：当质量达到该值及以上，允许给予小幅“放宽”匹配阈值，以减少同人分裂。
const DYN_HIGH_QUALITY = Math.max(0, Math.min(100, Number(process.env.FACE_DYN_THRESH_HIGH_QUALITY ?? 80)));
// 高质量放宽幅度：仅在 q >= DYN_HIGH_QUALITY 时生效（req -= bonus）。数值越大越容易合并同人，也更可能引入错分。
const DYN_HIGH_QUALITY_BONUS = Math.max(0, Math.min(0.1, Number(process.env.FACE_DYN_THRESH_HIGH_QUALITY_BONUS ?? 0.02)));

// 原型更新质量权重：用于把“更好的样本”对原型的影响放大、低质量影响缩小。
// weight = base + (q/100) * scale；配合 PROTO_UPDATE_MIN_QUALITY 可进一步减少噪声污染。
const PROTO_QUALITY_WEIGHT_BASE = Math.max(0, Math.min(5, Number(process.env.FACE_PROTO_QUALITY_WEIGHT_BASE ?? 0.25)));
const PROTO_QUALITY_WEIGHT_SCALE = Math.max(0, Math.min(10, Number(process.env.FACE_PROTO_QUALITY_WEIGHT_SCALE ?? 1.75)));

// 维护触发频率（按处理图片数）：每处理 N 张 photo_index，就触发一次维护（原型重建、样本清理、二次合并）。
const MAINTENANCE_EVERY_IMAGES = Math.max(1, Math.min(1000000, Number(process.env.FACE_MAINTENANCE_EVERY_IMAGES ?? 200)));
// 维护触发频率（按时间）：距离上次维护超过该毫秒数，也会触发维护，避免长时间不重建导致分裂持续存在。
const MAINTENANCE_EVERY_MS = Math.max(1000, Math.min(7 * 24 * 60 * 60 * 1000, Number(process.env.FACE_MAINTENANCE_EVERY_MS ?? 10 * 60 * 1000)));
// 单次维护处理的 face 数量上限：越大越全面但更耗时；建议结合库规模调整。
const MAINTENANCE_FACE_LIMIT = Math.max(1, Math.min(500, Number(process.env.FACE_MAINTENANCE_FACE_LIMIT ?? 200)));

// 原型重建 TopN：从 photo_face_samples 中挑选该 face 的高质量前 N 个样本重算原型向量。
// N 太小：原型容易偏；N 太大：容易把边缘样本/噪声引入，且维护耗时上升。
const PROTO_REBUILD_TOPN = Math.max(1, Math.min(200, Number(process.env.FACE_PROTO_REBUILD_TOPN ?? 25)));

// 样本保留上限：每个 face 只保留高质量 TopK 样本（超过则删除），避免 photo_face_samples 无限增长占用空间。
// K 应 >= PROTO_REBUILD_TOPN，否则重建时可用样本不够。
const SAMPLES_KEEP_TOPN = Math.max(PROTO_REBUILD_TOPN, Math.min(1000, Number(process.env.FACE_SAMPLES_KEEP_TOPN ?? 30)));

// 样本最低质量下限：清理时优先保留质量 >= 该值的样本；低于该值的样本即使数量未超限也倾向被淘汰（减少噪声堆积）。
const SAMPLES_DELETE_BELOW_QUALITY = Math.max(0, Math.min(100, Number(process.env.FACE_SAMPLES_DELETE_BELOW_QUALITY ?? 80)));

// 二次合并开关：维护时尝试把“实际同一人但被分裂成多个 face”的原型合并。
const SECOND_MERGE_ENABLE = Number(process.env.FACE_SECOND_MERGE_ENABLE ?? 1) ? 1 : 0;
// 二次合并阈值（原型-原型）：两个 face 原型相似度达到该值时可直接合并。越小越积极，错合风险越高。
let SECOND_MERGE_THRESH = Math.max(0, Math.min(1, Number(process.env.FACE_SECOND_MERGE_THRESH ?? 0.45)));
// 二次合并阈值（最佳样本-最佳样本）：用于修复“原型被历史噪声拉偏”但最佳高质样本仍很像的情况。
const SECOND_MERGE_BEST_SAMPLE_THRESH = Math.max(0, Math.min(1, Number(process.env.FACE_SECOND_MERGE_BEST_SAMPLE_THRESH ?? 0.45)));
// 单次维护最多合并多少对 face：避免一次维护做太多合并造成长事务/卡顿，也降低误合并的爆炸半径。
const SECOND_MERGE_MAX = Math.max(0, Math.min(200, Number(process.env.FACE_SECOND_MERGE_MAX ?? 20)));
// 参与二次合并的最小 face_count：低样本 face 往往更不稳定，限制参与可降低误合并。
const SECOND_MERGE_MIN_FACE_COUNT = Math.max(1, Math.min(1000, Number(process.env.FACE_SECOND_MERGE_MIN_FACE_COUNT ?? 3)));

// ⭐ 2026-10-14 防误合护栏（用户报「好多人的人脸混在了一起」）
// 1) 认领裕度：最近原型必须比**第二名（另一个人）**明显更像，否则宁可新建人脸组。
//    0.04 只影响「两个人脸组难分伯仲」的边角样本，对真正同一人的高相似度样本无影响。
let ASSIGN_MARGIN = Math.max(0, Math.min(0.3, Number(process.env.FACE_ASSIGN_MARGIN ?? 0.04)));
// 2) 二次合并要求「互为最近邻」：掐掉 A~B、B~C 把三个人串成一组的链式合并。
const SECOND_MERGE_MUTUAL = Number(process.env.FACE_SECOND_MERGE_MUTUAL ?? 1) ? true : false;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function clampNumber(v, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function dot(a, b) {
  const n = Math.min(a.length, b.length);
  let s = 0;
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

/**
 * 从 tableConfig 读取人脸聚类参数（AI 设置页可调，2026-10-13）。
 * 优先级：DB 配置 > 环境变量 > 代码默认值。
 * 只在这里改写模块级 let，调用点见 startLoop / maybeRunMaintenance。
 */
async function applyFaceTuning() {
  const readNum = async (key, cur, lo, hi) => {
    try {
      const raw = await tableConfig.getConfigByKey(key);
      if (raw === null || raw === undefined || raw === '') return cur;
      const n = Number(raw);
      if (!Number.isFinite(n)) return cur;
      return Math.max(lo, Math.min(hi, n));
    } catch (_) {
      return cur;
    }
  };
  const prev = { sim: SIM_THRESH, minQ: MIN_QUALITY, merge2: SECOND_MERGE_THRESH, margin: ASSIGN_MARGIN, threads: FACE_THREADS };
  SIM_THRESH = await readNum('ai_face_sim_thresh', SIM_THRESH, 0.2, 0.9);
  MIN_QUALITY = await readNum('ai_face_min_quality', MIN_QUALITY, 40, 95);
  SECOND_MERGE_THRESH = await readNum('ai_face_second_merge_thresh', SECOND_MERGE_THRESH, 0.2, 0.9);
  // 认领裕度：目前只有 DB / 环境变量可调（AI 设置页暂无控件）
  ASSIGN_MARGIN = await readNum('ai_face_assign_margin', ASSIGN_MARGIN, 0, 0.3);
  // 线程数只在启动时生效（运行中改不热切换，避免半批任务线程数抖动）；
  // 环境变量显式给了则尊重环境变量。
  if (process.env.FACE_THREADS === undefined) {
    FACE_THREADS = clampThreadCount(await readNum('ai_face_threads', FACE_THREADS, 1, MAX_FACE_THREADS));
  }
  if (
    Math.abs(prev.sim - SIM_THRESH) > 1e-9 ||
    Math.abs(prev.minQ - MIN_QUALITY) > 1e-9 ||
    Math.abs(prev.merge2 - SECOND_MERGE_THRESH) > 1e-9 ||
    Math.abs(prev.margin - ASSIGN_MARGIN) > 1e-9 ||
    prev.threads !== FACE_THREADS
  ) {
    Logger.info(
      `[FaceTuning] 应用新参数 sim=${SIM_THRESH} minQuality=${MIN_QUALITY} secondMerge=${SECOND_MERGE_THRESH} assignMargin=${ASSIGN_MARGIN} threads=${FACE_THREADS}`
    );
  }
}

function computeDynamicMatchThresh(faceMeta) {
  const q = clampNumber(faceMeta && faceMeta.qualityScore, 0, 100);
  let req = SIM_THRESH + ((100 - q) / 100) * DYN_QUALITY_PENALTY;
  if (q >= DYN_HIGH_QUALITY) {
    const bonusScale = Math.min(1, (q - DYN_HIGH_QUALITY) / 10);
    req -= DYN_HIGH_QUALITY_BONUS * (1 + bonusScale);
  }
  return clampNumber(req, DYN_THRESH_MIN, DYN_THRESH_MAX);
}

function computeProtoUpdateWeight(qualityScore) {
  const q = clampNumber(qualityScore, 0, 100);
  return PROTO_QUALITY_WEIGHT_BASE + (q / 100) * PROTO_QUALITY_WEIGHT_SCALE;
}

/**
 * ⭐ 2026-10-14 修正方向（原来这里是「越不像权重越大」，等于主动把可疑样本拉进原型）：
 * 与近期样本**越不像** ⇒ 越可能是另一个人被吸进来 ⇒ **压低**它对原型的拉扯。
 * 纯函数在 faceUtil.protoWeightFactor（返回 [0.6, 1]，永不放大）。
 */
function computeRecentDiversityFactor(proto, emb) {
  const recent = proto && Array.isArray(proto.recentEmbs) ? proto.recentEmbs : null;
  if (!recent || recent.length === 0) return 1;
  let maxSim = -1;
  for (const r of recent) {
    if (!r) continue;
    const sim = dot(r, emb);
    if (sim > maxSim) maxSim = sim;
  }
  return protoWeightFactor(maxSim);
}

function pushRecentEmb(proto, emb) {
  if (!proto) return;
  if (!Array.isArray(proto.recentEmbs)) proto.recentEmbs = [];
  proto.recentEmbs.unshift(emb);
  if (proto.recentEmbs.length > 10) proto.recentEmbs.length = 10;
}

const SIGNATURE_DIMS = Object.freeze([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23]);

function computeSignSignature(vec) {
  let sig = 0;
  for (let i = 0; i < SIGNATURE_DIMS.length; i++) {
    const v = vec[SIGNATURE_DIMS[i]];
    if (v >= 0) sig |= 1 << i;
  }
  return sig >>> 0;
}

class FaceWorker {
  constructor() {
    this.isRunning = false;
    this.batchSize = Math.max(1, Math.min(50, Number(process.env.FACE_BATCH_SIZE ?? 5)));
    this.faceEngine = null; // 仅在线程全部不可用时的兜底（coordinator 自己推理）
    this.prototypes = new Map();
    this.rootCache = new Map();
    this.protoIds = [];
    this.protoVecs = [];
    this.protoIndexById = new Map();
    this.protoSigById = new Map();
    this.protoBucketToIdxSet = new Map();
    this.protoCountById = new Map();
    this.topCountIdxs = [];
    this.topCountDirty = true;
    this.topCountUpdateCounter = 0;
    this.scanMarkArr = null;
    this.scanMarkStamp = 0;
    this.processedImages = 0;
    this.lastMaintenanceAt = Date.now();
    // ⭐ 推理线程池（2026-10-13）
    this.inferThreads = []; // { worker, busy, ready }
    this.inferSeq = 0;
    this.inferPending = new Map(); // seq -> { resolve, reject, thread }
    this.threadsFailed = false; // 线程池整体不可用 ⇒ 回退 coordinator 内联推理
    this.init();
  }

  async init() {
    try {
      await knexUtil.init(dbUtil.DB_PATHS.PHOTO_DB);
      await knexUtil.init(dbUtil.DB_PATHS.MAIN_DB);
      this.knex = knexUtil.getInstance(dbUtil.DB_PATHS.PHOTO_DB);
      const enabled = await tableConfig.getConfigByKey('ai_face_enable').catch(() => '0');
      if (enabled !== '1') {
        process.exit(0);
      }
      // 模型包确保就绪（线程内各自建会话，但包只在这里确保一次）
      await remoteAssets.ensureBundle('onnx_models.faces').catch(err => {
        Logger.warn(`[faceWorker] ensureBundle failed (threads will retry): ${err && err.message ? err.message : err}`);
      });
      await applyFaceTuning().catch(() => {});
      Logger.info(`[faceWorker] starting with ${FACE_THREADS} infer thread(s), cpus=${os.cpus().length}`);
      await this.ensureInferThreads();
      await this.loadPrototypes();
      this.isRunning = true;
      // 批次至少覆盖线程数的 2 倍，减少调度空转
      this.batchSize = Math.max(this.batchSize, FACE_THREADS * 2);

      await this.startLoop();
    } catch (err) {
      Logger.error('❌ Face Worker init failed:', err);
      process.kill(process.pid, 'SIGTERM');
    }
  }

  /**
   * 起 N 个推理线程（同一文件，role=infer）。
   * 单个线程起失败不影响其他；全部失败则置 threadsFailed，回退内联推理。
   */
  async ensureInferThreads() {
    if (this.threadsFailed) return;
    const want = clampThreadCount(FACE_THREADS);
    while (this.inferThreads.length < want) {
      try {
        const t = new ThreadWorker(__filename, {
          workerData: { role: 'infer' },
        });
        const entry = { worker: t, busy: false, ready: false };
        t.on('message', msg => this._onThreadMessage(entry, msg));
        t.on('error', err => {
          Logger.error(`❌ infer thread error: ${err && err.message ? err.message : err}`);
          this._dropThread(entry);
        });
        t.on('exit', code => {
          if (code !== 0) Logger.warn(`⚠️ infer thread exited code=${code}`);
          this._dropThread(entry);
        });
        this.inferThreads.push(entry);
        // 等 ready（引擎加载完）再继续，避免首批任务白等
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            cleanup();
            reject(new Error('infer thread ready timeout'));
          }, 120000);
          const onMsg = msg => {
            if (msg && msg.type === 'ready') {
              cleanup();
              entry.ready = true;
              resolve();
            }
          };
          const cleanup = () => {
            clearTimeout(timer);
            t.off('message', onMsg);
          };
          t.on('message', onMsg);
        }).catch(err => {
          Logger.warn(`⚠️ infer thread not ready: ${err && err.message ? err.message : err}`);
          this._dropThread(entry);
        });
      } catch (e) {
        Logger.error(`❌ spawn infer thread failed: ${e && e.message ? e.message : e}`);
        break;
      }
    }
    if (this.inferThreads.length === 0) {
      this.threadsFailed = true;
      Logger.warn('[faceWorker] no infer thread available, fallback to inline inference');
    }
  }

  _onThreadMessage(entry, msg) {
    if (!msg || typeof msg.id !== 'number') return;
    const pending = this.inferPending.get(msg.id);
    if (!pending) return;
    this.inferPending.delete(msg.id);
    if (entry.worker && entry.busy) entry.busy = false;
    if (msg.ok) {
      pending.resolve(msg.faces || []);
    } else {
      pending.reject(new Error(msg.error || 'infer_failed'));
    }
  }

  _dropThread(entry) {
    const idx = this.inferThreads.indexOf(entry);
    if (idx >= 0) this.inferThreads.splice(idx, 1);
    entry.busy = false;
    // 该线程上未完成的任务全部按失败处理（调用方会 markIndexDone 跳过这张）
    for (const [seq, pending] of this.inferPending.entries()) {
      if (pending.thread === entry) {
        this.inferPending.delete(seq);
        pending.reject(new Error('infer_thread_died'));
      }
    }
    try {
      entry.worker.terminate();
    } catch (_) {}
  }

  /** 找空闲线程发任务；没有空闲就排队等最早空闲的（保持批次内并发≤线程数） */
  _pickIdleThread() {
    for (const t of this.inferThreads) {
      if (!t.busy && t.ready) return t;
    }
    return null;
  }

  async inferViaThread(imagePath) {
    if (this.threadsFailed || this.inferThreads.length === 0) {
      // 兜底：coordinator 自己推理（慢但保底）
      if (!this.faceEngine) this.faceEngine = await getFaceEngine();
      return this.faceEngine.extractFaceFeatures(imagePath);
    }
    if (this.inferThreads.every(t => !t.ready)) {
      await this.ensureInferThreads();
      if (this.threadsFailed || this.inferThreads.length === 0) {
        if (!this.faceEngine) this.faceEngine = await getFaceEngine();
        return this.faceEngine.extractFaceFeatures(imagePath);
      }
    }
    const seq = ++this.inferSeq;
    return new Promise((resolve, reject) => {
      const dispatch = () => {
        const t = this._pickIdleThread();
        if (!t) {
          // 稍等再试（线程完成时 _onThreadMessage 会把 busy 置 false）
          setTimeout(dispatch, 5);
          return;
        }
        t.busy = true;
        this.inferPending.set(seq, { resolve, reject, thread: t });
        try {
          t.worker.postMessage({ id: seq, imagePath });
        } catch (e) {
          this.inferPending.delete(seq);
          t.busy = false;
          reject(e);
        }
      };
      dispatch();
    });
  }

  async terminateInferThreads() {
    const threads = this.inferThreads.slice();
    this.inferThreads = [];
    for (const t of threads) {
      try {
        t.worker.terminate();
      } catch (_) {}
    }
  }

  async loadPrototypes() {
    // 已合并的人脸（belong_face_id 有值）仅保留并查集边，不加载 feature、不参与相似度索引，避免
    // 合并历史与无效行把 protoVecs / 桶索引撑爆（大图库下内存与 CPU 都会线性恶化）。
    const childRows = await this.knex('photo_faces')
      .whereNotNull('belong_face_id')
      .where('belong_face_id', '>', 0)
      .select('face_id', 'face_count', 'belong_face_id')
      .catch(() => []);
    const rootRows = await this.knex('photo_faces')
      .where(qb => {
        qb.whereNull('belong_face_id').orWhere('belong_face_id', 0);
      })
      .select('face_id', 'feature', 'face_count', 'belong_face_id')
      .catch(() => []);
    this.prototypes.clear();
    this.rootCache.clear();
    this.protoIds = [];
    this.protoVecs = [];
    this.protoIndexById.clear();
    this.protoSigById.clear();
    this.protoBucketToIdxSet.clear();
    this.protoCountById.clear();
    this.topCountIdxs = [];
    this.topCountDirty = true;
    this.topCountUpdateCounter = 0;
    this.scanMarkArr = null;
    this.scanMarkStamp = 0;
    for (const r of childRows || []) {
      const id = Number(r && r.face_id ? r.face_id : 0);
      if (!id) continue;
      const count = Number(r && r.face_count ? r.face_count : 0) || 0;
      const belongFaceId = r && r.belong_face_id ? Number(r.belong_face_id) : 0;
      if (!belongFaceId) continue;
      const proto = {
        vec: null,
        count: Math.max(0, count),
        belongFaceId,
        recentEmbs: [],
      };
      this.prototypes.set(id, proto);
      this.protoCountById.set(id, proto.count);
    }
    for (const r of rootRows || []) {
      const id = Number(r && r.face_id ? r.face_id : 0);
      const count = Number(r && r.face_count ? r.face_count : 0) || 0;
      if (!id) continue;
      const buf = r && r.feature ? Buffer.from(r.feature) : null;
      const vec = buf ? bufferToFloat32(buf) : null;
      if (!vec || vec.length !== 512) continue;
      const belongFaceId = r && r.belong_face_id ? Number(r.belong_face_id) : 0;
      const proto = {
        vec: normalizeL2(vec),
        count: Math.max(0, count),
        belongFaceId: belongFaceId > 0 ? belongFaceId : null,
        recentEmbs: [],
      };
      this.prototypes.set(id, proto);
      this.addProtoToSearchIndex(id, proto.vec);
      this.protoCountById.set(id, proto.count);
    }
    this.rebuildTopCountCache();
  }

  rebuildTopCountCache(limit = 20) {
    const ids = this.protoIds;
    if (!ids || ids.length === 0) {
      this.topCountIdxs = [];
      this.topCountDirty = false;
      return;
    }
    const cnt = this.protoCountById;
    const idxs = new Array(ids.length);
    for (let i = 0; i < ids.length; i++) idxs[i] = i;
    idxs.sort((a, b) => (cnt.get(ids[b]) || 0) - (cnt.get(ids[a]) || 0));
    const out = [];
    const max = Math.max(0, Math.min(ids.length, Number(limit) || 0));
    for (let i = 0; i < max; i++) out.push(idxs[i]);
    this.topCountIdxs = out;
    this.topCountDirty = false;
  }

  removeProtoFromSearchIndex(faceId) {
    const fid = Number(faceId) || 0;
    const idx = this.protoIndexById.get(fid);
    if (idx === undefined) return;
    const lastIdx = this.protoIds.length - 1;
    const oldSig = this.protoSigById.get(fid);
    if (oldSig !== undefined) {
      const oldSet = this.protoBucketToIdxSet.get(oldSig);
      if (oldSet) {
        oldSet.delete(idx);
        if (oldSet.size === 0) this.protoBucketToIdxSet.delete(oldSig);
      }
    }
    this.protoSigById.delete(fid);
    this.protoIndexById.delete(fid);

    if (idx !== lastIdx && lastIdx >= 0) {
      const lastId = this.protoIds[lastIdx];
      const lastSig = this.protoSigById.get(lastId);
      if (lastSig !== undefined) {
        const lastSet = this.protoBucketToIdxSet.get(lastSig);
        if (lastSet) {
          lastSet.delete(lastIdx);
          lastSet.add(idx);
        }
      }
      this.protoIds[idx] = lastId;
      this.protoVecs[idx] = this.protoVecs[lastIdx];
      this.protoIndexById.set(lastId, idx);
    }
    this.protoIds.pop();
    this.protoVecs.pop();
    this.topCountDirty = true;
  }

  addProtoToSearchIndex(faceId, vec) {
    const fid = Number(faceId) || 0;
    if (!fid || !vec) return;
    if (this.protoIndexById.has(fid)) return;
    const idx = this.protoIds.length;
    this.protoIds.push(fid);
    this.protoVecs.push(vec);
    this.protoIndexById.set(fid, idx);
    const sig = computeSignSignature(vec);
    this.protoSigById.set(fid, sig);
    let set = this.protoBucketToIdxSet.get(sig);
    if (!set) {
      set = new Set();
      this.protoBucketToIdxSet.set(sig, set);
    }
    set.add(idx);
  }

  updateProtoInSearchIndex(faceId, vec) {
    const fid = Number(faceId) || 0;
    const idx = this.protoIndexById.get(fid);
    if (idx === undefined) {
      this.addProtoToSearchIndex(fid, vec);
      return;
    }
    this.protoVecs[idx] = vec;
    const oldSig = this.protoSigById.get(fid);
    const newSig = computeSignSignature(vec);
    if (oldSig === newSig) return;
    this.protoSigById.set(fid, newSig);
    const oldSet = oldSig !== undefined ? this.protoBucketToIdxSet.get(oldSig) : null;
    if (oldSet) oldSet.delete(idx);
    let newSet = this.protoBucketToIdxSet.get(newSig);
    if (!newSet) {
      newSet = new Set();
      this.protoBucketToIdxSet.set(newSig, newSet);
    }
    newSet.add(idx);
  }

  async startLoop() {
    // 启动时先读一次 AI 设置里的人脸聚类参数（DB > env > 默认）
    await applyFaceTuning().catch(() => {});
    while (this.isRunning) {
      try {
        const rows = await this.getNextBatch();
        if (!rows || rows.length === 0) {
          await this.maybeRunMaintenance(true);
          Logger.info('✅ No pending face tasks, worker exiting');
          await this.terminateInferThreads();
          try {
            if (this.knex && typeof this.knex.destroy === 'function') await this.knex.destroy();
          } catch {}
          process.exit(0);
        }
        await this.processBatch(rows);
        await this.maybeRunMaintenance(false);
      } catch (err) {
        Logger.error('❌ Face Worker loop error:', err);
        await sleep(1000);
      }
    }
  }

  /**
   * ⭐ 2026-10-13 两阶段批处理：
   * Phase 1 并行推理（worker_threads 池，检测是瓶颈 ~300ms/张）；
   * Phase 2 顺序入库（prototypes Map / 事务只能单线程改，避免计数与原型竞争）。
   */
  async processBatch(rows) {
    const prepared = await Promise.all((rows || []).map(row => this.prepareInfer(row)));
    for (const item of prepared) {
      if (!this.isRunning) break;
      if (item.skip) {
        await this.markIndexDone(item.row.id);
        continue;
      }
      if (item.error) {
        Logger.error(`❌  face infer failed: ${item.imagePath || item.row.path}`, item.error);
        await this.markIndexDone(item.row.id);
        continue;
      }
      try {
        await this.applyFacesToDb(item.row, item.faces);
      } catch (err) {
        Logger.error('❌  face DB write failed:', err);
      }
      this.processedImages += 1;
    }
  }

  /** Phase 1：前置校验 + 缩略图 + 并行推理，返回 {row, faces} 或 {row, skip|error} */
  async prepareInfer(row) {
    const id = row && row.id ? Number(row.id) : 0;
    if (!id) return { row, skip: true };

    const fileHash = row.file_hash ? String(row.file_hash) : '';
    if (!fileHash) {
      return { row, skip: true };
    }

    const existed = await this.knex('photo_face2filehash')
      .where({ file_hash: fileHash })
      .first('id')
      .catch(() => null);
    if (existed && existed.id) {
      return { row, skip: true };
    }
    const fullPath = path.join(String(row.path || ''), String(row.filename || ''));
    if (!fullPath || !fs.existsSync(fullPath)) {
      return { row, skip: true };
    }

    const type = row && row.type ? Number(row.type) : 0;
    let imagePath = fullPath;
    if (type === 2) {
      try {
        imagePath = await fileService.getTinyImgByPath(fullPath, undefined, { deferSlowIo: false, deferImages: false });
      } catch (err) {
        Logger.error(`❌  video thumbnail failed: ${fullPath}`, err);
        return { row, skip: true };
      }
    }
    if (!imagePath || !fs.existsSync(imagePath)) {
      return { row, skip: true };
    }
    try {
      const faces = await this.inferViaThread(imagePath);
      return { row, faces: Array.isArray(faces) ? faces : [] };
    } catch (err) {
      return { row, error: err, imagePath };
    }
  }

  /** Phase 2：聚类 + 写库（与原 processOne 的事务体一致） */
  async applyFacesToDb(row, faces) {
    const id = row && row.id ? Number(row.id) : 0;
    if (!id) return;
    const fileHash = row.file_hash ? String(row.file_hash) : '';
    const list = Array.isArray(faces) ? faces : [];

    await this.knex.transaction(async trx => {
      const usedFaceIds = new Set();
      for (const f of list) {
        const emb = f && f.feature ? f.feature : null;
        if (!emb || emb.length !== 512) continue;
        const box = f && f.box ? f.box : null;
        if (!box) continue;
        const quality = Number(f.qualityScore) || 0;
        if (quality < MIN_QUALITY) continue;
        const faceMeta = { qualityScore: quality };
        const match = this.findBestPrototype(emb, faceMeta, usedFaceIds);
        const matchFaceId = match ? Number(match.faceId) || 0 : 0;
        const rootMatchFaceId = matchFaceId ? await this.getRootFaceId(trx, matchFaceId) : 0;
        const faceId = match ? await this.assignToFace(trx, rootMatchFaceId || matchFaceId, emb, { qualityScore: quality }) : await this.createNewFace(trx, emb, { fileHash, quality });
        if (!faceId) continue;
        const rootId = matchFaceId ? rootMatchFaceId : await this.getRootFaceId(trx, faceId);
        if (usedFaceIds.has(rootId)) continue;
        usedFaceIds.add(rootId);
        await this.insertFaceMapping(trx, fileHash, rootId, box);
        const sampleFaceId = matchFaceId || rootId;
        await this.upsertSample(trx, fileHash, sampleFaceId, emb, quality);
      }
      await trx('photo_index').where({ id }).update({ gen_faces: 1 });
    });
  }

  async getNextBatch() {
    return this.knex('photo_index')
      .select('id', 'path', 'filename', 'file_hash', 'type')
      .where({ gen_faces: 0, is_file: 1, in_trash: 0 })
      .whereIn('type', [1, 2])
      .orderBy('original_time', 'asc')
      .limit(this.batchSize)
      .catch(() => []);
  }

  async maybeRunMaintenance(force) {
    if (!this.isRunning) return;
    // 每次维护前刷新参数：调完「聚类严格度」后，重聚类/维护即刻用新值
    await applyFaceTuning().catch(() => {});
    const now = Date.now();
    const dueByCount = this.processedImages >= MAINTENANCE_EVERY_IMAGES;
    const dueByTime = now - this.lastMaintenanceAt >= MAINTENANCE_EVERY_MS;
    if (!force && !dueByCount && !dueByTime) return;
    this.processedImages = 0;
    this.lastMaintenanceAt = now;

    try {
      await this.knex.transaction(async trx => {
        const faceIds = await this.pickMaintenanceFaceIds(trx);
        if (faceIds.length > 0) {
          await this.rebuildPrototypesFromSamples(trx, faceIds);
          await this.pruneSamples(trx, faceIds);
        }
        if (SECOND_MERGE_ENABLE && SECOND_MERGE_MAX > 0) {
          await this.secondaryMerge(trx, faceIds);
        }
      });
    } catch (err) {
      Logger.error('❌  face maintenance failed:', err);
    }
  }

  async pickMaintenanceFaceIds(trx) {
    const rows = await trx('photo_faces as pf')
      .select('face_id')
      .where(qb => {
        qb.where('pf.face_count', '>=', 1).orWhereExists(function () {
          this.select(1).from('photo_face_samples as s').whereRaw('s.face_id = pf.face_id');
        });
      })
      .orderByRaw('proto_rebuild_time IS NOT NULL, proto_rebuild_time ASC')
      .orderBy('face_count', 'desc')
      .limit(MAINTENANCE_FACE_LIMIT)
      .catch(() => []);
    const ids = [];
    for (const r of rows || []) {
      const id = Number(r && r.face_id ? r.face_id : 0);
      if (!id) continue;
      ids.push(id);
    }
    return ids;
  }

  async rebuildPrototypesFromSamples(trx, faceIds) {
    const now = trx.fn.now();
    for (const faceId of faceIds) {
      const rows = await trx('photo_face_samples')
        .select('feature', 'quality_score')
        .where({ face_id: faceId })
        .orderBy('quality_score', 'desc')
        .orderBy('id', 'desc')
        .limit(PROTO_REBUILD_TOPN)
        .catch(() => []);
      if (!rows || rows.length === 0) continue;

      const acc = new Float32Array(512);
      let used = 0;
      for (const r of rows) {
        const buf = r && r.feature ? Buffer.from(r.feature) : null;
        const vec = buf ? bufferToFloat32(buf) : null;
        if (!vec || vec.length !== 512) continue;
        const q = clampNumber(r && r.quality_score, 0, 100);
        const w = computeProtoUpdateWeight(q);
        for (let i = 0; i < 512; i++) acc[i] += vec[i] * w;
        used += 1;
      }
      if (used <= 0) continue;
      const newVec = normalizeL2(acc);

      await trx('photo_faces')
        .where({ face_id: faceId })
        .update({
          feature: float32ToBuffer(newVec),
          proto_rebuild_time: now,
          proto_sample_count: used,
          update_time: now,
        })
        .catch(() => {});

      const proto = this.prototypes.get(faceId);
      if (proto) {
        proto.vec = newVec;
        this.prototypes.set(faceId, proto);
      }
    }
  }

  async pruneSamples(trx, faceIds) {
    for (const faceId of faceIds) {
      let keepRows = await trx('photo_face_samples')
        .select('id')
        .where({ face_id: faceId })
        .andWhere('quality_score', '>=', SAMPLES_DELETE_BELOW_QUALITY)
        .orderBy('quality_score', 'desc')
        .orderBy('id', 'desc')
        .limit(SAMPLES_KEEP_TOPN)
        .catch(() => []);
      if (!keepRows || keepRows.length === 0) {
        keepRows = await trx('photo_face_samples')
          .select('id')
          .where({ face_id: faceId })
          .orderBy('quality_score', 'desc')
          .orderBy('id', 'desc')
          .limit(Math.min(SAMPLES_KEEP_TOPN, 5))
          .catch(() => []);
      }
      const keepIds = (keepRows || []).map(r => Number(r && r.id ? r.id : 0)).filter(n => Number.isFinite(n) && n > 0);

      if (keepIds.length > 0) {
        await trx('photo_face_samples')
          .where({ face_id: faceId })
          .whereNotIn('id', keepIds)
          .del()
          .catch(() => {});
      }
    }
  }

  async secondaryMerge(trx, preferredFaceIds) {
    const candidates = [];
    const preferred = Array.isArray(preferredFaceIds) ? preferredFaceIds : [];
    for (const id of preferred) {
      const p = this.prototypes.get(id);
      if (!p || p.belongFaceId || !p.vec) continue;
      candidates.push({ id, count: Number(p.count) || 0 });
    }
    if (candidates.length < 2) {
      for (const [id, p] of this.prototypes.entries()) {
        if (!p || p.belongFaceId || !p.vec) continue;
        candidates.push({ id, count: Number(p && p.count ? p.count : 0) || 0 });
        if (candidates.length >= MAINTENANCE_FACE_LIMIT) break;
      }
    }
    candidates.sort((a, b) => (b.count || 0) - (a.count || 0));
    const candIds = candidates.map(c => c.id);
    const bestSampleByFaceId = await this.loadBestSamplesForFaces(trx, candIds);
    const timeRows = await trx('photo_faces')
      .select('face_id', 'create_time')
      .whereIn('face_id', candIds)
      .catch(() => []);
    const createMsById = new Map();
    for (const r of timeRows || []) {
      const id = Number(r && r.face_id ? r.face_id : 0);
      if (!id) continue;
      const ms = r && r.create_time ? new Date(r.create_time).getTime() : 0;
      createMsById.set(id, Number.isFinite(ms) ? ms : 0);
    }

    const pairs = [];
    for (let i = 0; i < candidates.length; i++) {
      for (let j = i + 1; j < candidates.length; j++) {
        const a = candidates[i];
        const b = candidates[j];
        const pa = this.prototypes.get(a.id);
        const pb = this.prototypes.get(b.id);
        if (!pa || !pb || !pa.vec || !pb.vec) continue;
        const sim = dot(pa.vec, pb.vec);
        const sa = bestSampleByFaceId.get(a.id);
        const sb = bestSampleByFaceId.get(b.id);
        const simBest = sa && sb ? dot(sa, sb) : -1;
        pairs.push({ a: a.id, b: b.id, sim, simBest });
      }
    }

    const timeWindowMs = 24 * 60 * 60 * 1000;
    const stage1ProtoThresh = Math.max(0, SECOND_MERGE_THRESH * 0.92);
    const stage1BestThresh = Math.max(0, SECOND_MERGE_BEST_SAMPLE_THRESH * 0.96);

    // ⭐ 2026-10-14 防链式合并：
    // 原来是「按相似度排序后贪心合并」，A~B、B~C 会把 A/B/C 三个人并成一组
    // （用户看到的「好多人的人脸混在了一起」很大一部分就是这么来的）。
    // 现在交给 faceUtil.selectMergePairs：要求互为最近邻 + 本轮一对一匹配，
    // 同一人物的碎片会在后续维护轮次里逐轮收敛，不会一轮串成一大团。
    const forSelect = pairs.map(p => {
      const countA = Number(this.prototypes.get(p.a)?.count) || 0;
      const countB = Number(this.prototypes.get(p.b)?.count) || 0;
      const tA = createMsById.get(p.a) || 0;
      const tB = createMsById.get(p.b) || 0;
      const timeOk = !(tA && tB && Math.abs(tA - tB) > timeWindowMs);
      return { a: p.a, b: p.b, sim: p.sim, simBest: p.simBest, countA, countB, timeOk };
    });

    const chosen = selectMergePairs(forSelect, {
      limit: SECOND_MERGE_MAX,
      requireMutual: SECOND_MERGE_MUTUAL,
      tiers: [
        {
          // 档 1：两边都是小分组（<=2 张）+ 时间接近，阈值略放宽
          name: 'small',
          match: p => p.countA <= 2 && p.countB <= 2 && p.timeOk
            && (p.sim >= stage1ProtoThresh || p.simBest >= stage1BestThresh),
        },
        {
          // 档 2：常规（要求两边样本数达标）
          name: 'normal',
          match: p => p.countA >= SECOND_MERGE_MIN_FACE_COUNT
            && p.countB >= SECOND_MERGE_MIN_FACE_COUNT
            && (p.sim >= SECOND_MERGE_THRESH || p.simBest >= SECOND_MERGE_BEST_SAMPLE_THRESH),
        },
        {
          // 档 3：严格（两个指标都要过 + 加码）
          name: 'strict',
          match: p => p.countA >= SECOND_MERGE_MIN_FACE_COUNT
            && p.countB >= SECOND_MERGE_MIN_FACE_COUNT
            && p.sim >= SECOND_MERGE_THRESH + 0.03
            && p.simBest >= SECOND_MERGE_BEST_SAMPLE_THRESH + 0.03,
        },
      ],
    });

    if (chosen.length < pairs.length) {
      Logger.info(
        `[faceCluster] 二次合并：候选 ${pairs.length} 对 → 实际合并 ${chosen.length} 对` +
        `（互为最近邻=${SECOND_MERGE_MUTUAL ? '开' : '关'}，上限 ${SECOND_MERGE_MAX}）`
      );
    }
    for (const c of chosen) {
      await this.mergeFaceInto(trx, c.dropId, c.keepId);
    }
  }

  async loadBestSamplesForFaces(trx, faceIds) {
    const out = new Map();
    for (const faceId of faceIds) {
      const r = await trx('photo_face_samples')
        .select('feature')
        .where({ face_id: faceId })
        .orderBy('quality_score', 'desc')
        .orderBy('id', 'desc')
        .first()
        .catch(() => null);
      const buf = r && r.feature ? Buffer.from(r.feature) : null;
      const vec = buf ? bufferToFloat32(buf) : null;
      if (!vec || vec.length !== 512) continue;
      out.set(faceId, normalizeL2(vec));
    }
    return out;
  }

  async mergeFaceInto(trx, fromFaceId, toFaceId) {
    if (!fromFaceId || !toFaceId || fromFaceId === toFaceId) return;

    const rootToFaceId = await this.getRootFaceId(trx, toFaceId);
    if (!rootToFaceId) return;
    if (rootToFaceId !== toFaceId) toFaceId = rootToFaceId;
    if (fromFaceId === toFaceId) return;

    const [fromRow, toRow] = await Promise.all([
      trx('photo_faces')
        .select('face_id', 'face_count', 'proto_best_quality_score', 'proto_best_file_hash', 'name')
        .where({ face_id: fromFaceId })
        .first()
        .catch(() => null),
      trx('photo_faces')
        .select('face_id', 'face_count', 'proto_best_quality_score', 'proto_best_file_hash', 'name')
        .where({ face_id: toFaceId })
        .first()
        .catch(() => null),
    ]);

    const fromCount = Math.max(0, Number(fromRow && fromRow.face_count ? fromRow.face_count : 0) || 0);
    const toCount = Math.max(0, Number(toRow && toRow.face_count ? toRow.face_count : 0) || 0);
    const isEmptyName = v => v == null || (Buffer.isBuffer(v) ? v.length === 0 : typeof v === 'string' ? v.length === 0 : false);
    const inheritName = isEmptyName(toRow && toRow.name) && !isEmptyName(fromRow && fromRow.name) ? fromRow.name : undefined;

    await trx
      .raw(
        `INSERT OR IGNORE INTO photo_face2filehash (file_hash, face_id, box_left, box_top, box_width, box_height, is_cover, create_time)
       SELECT file_hash, ?, box_left, box_top, box_width, box_height, is_cover, create_time FROM photo_face2filehash WHERE face_id = ?`,
        [toFaceId, fromFaceId]
      )
      .catch(() => {});
    await trx('photo_face2filehash')
      .where({ face_id: fromFaceId })
      .del()
      .catch(() => {});

    const bestFromQ = Math.max(0, Math.floor(Number(fromRow && fromRow.proto_best_quality_score ? fromRow.proto_best_quality_score : 0) || 0));
    const bestToQ = Math.max(0, Math.floor(Number(toRow && toRow.proto_best_quality_score ? toRow.proto_best_quality_score : 0) || 0));
    const bestFromHash = fromRow && fromRow.proto_best_file_hash ? String(fromRow.proto_best_file_hash) : '';
    const bestToHash = toRow && toRow.proto_best_file_hash ? String(toRow.proto_best_file_hash) : '';
    const mergedBestQ = bestFromQ > bestToQ ? bestFromQ : bestToQ;
    const mergedBestHash = bestFromQ > bestToQ ? bestFromHash : bestToHash;

    const protoFrom = this.prototypes.get(fromFaceId);
    const protoTo = this.prototypes.get(toFaceId);
    // 实际去重照片数（同照片含双方人脸时 INSERT OR IGNORE 会去重）
    const cntRow = await trx('photo_face2filehash')
      .where({ face_id: toFaceId })
      .countDistinct({ total: 'file_hash' })
      .first()
      .catch(() => null);
    const realCount = cntRow && Number.isFinite(Number(cntRow.total)) ? Math.max(0, Number(cntRow.total) || 0) : toCount + fromCount;
    if (protoFrom && protoTo && protoFrom.vec && protoTo.vec) {
      const mixed = new Float32Array(512);
      const a = Math.max(1, Number(protoTo.count) || toCount || 1);
      const b = Math.max(1, Number(protoFrom.count) || fromCount || 1);
      for (let i = 0; i < 512; i++) mixed[i] = protoTo.vec[i] * a + protoFrom.vec[i] * b;
      const newVec = normalizeL2(mixed);
      protoTo.vec = newVec;
      protoTo.count = a + b;
      const mergedRecent = [];
      if (Array.isArray(protoTo.recentEmbs)) mergedRecent.push(...protoTo.recentEmbs);
      if (Array.isArray(protoFrom.recentEmbs)) mergedRecent.push(...protoFrom.recentEmbs);
      protoTo.recentEmbs = mergedRecent.slice(0, 10);
      this.prototypes.set(toFaceId, protoTo);
      this.updateProtoInSearchIndex(toFaceId, newVec);
      this.protoCountById.set(toFaceId, protoTo.count);
      this.topCountDirty = true;
      const update = {
        feature: float32ToBuffer(newVec),
        face_count: realCount,
        proto_best_quality_score: mergedBestQ,
        proto_best_file_hash: mergedBestHash || null,
        update_time: trx.fn.now(),
      };
      if (inheritName !== undefined) update.name = inheritName;
      await trx('photo_faces')
        .where({ face_id: toFaceId })
        .update(update)
        .catch(() => {});
    } else {
      const update = {
        face_count: realCount,
        proto_best_quality_score: mergedBestQ,
        proto_best_file_hash: mergedBestHash || null,
        update_time: trx.fn.now(),
      };
      if (inheritName !== undefined) update.name = inheritName;
      await trx('photo_faces')
        .where({ face_id: toFaceId })
        .update(update)
        .catch(() => {});
    }

    this.removeProtoFromSearchIndex(fromFaceId);
    const pfMerged = this.prototypes.get(fromFaceId);
    if (pfMerged) {
      pfMerged.belongFaceId = toFaceId;
      pfMerged.count = 0;
      pfMerged.vec = null;
      pfMerged.recentEmbs = [];
      this.prototypes.set(fromFaceId, pfMerged);
      this.protoCountById.set(fromFaceId, 0);
    }

    await trx('photo_faces')
      .where({ face_id: fromFaceId })
      .update({ belong_face_id: toFaceId, face_count: 0, update_time: trx.fn.now() })
      .catch(() => {});

    await trx('photo_faces')
      .where({ belong_face_id: fromFaceId })
      .update({ belong_face_id: toFaceId, update_time: trx.fn.now() })
      .catch(() => {});

    for (const [id, p] of this.prototypes.entries()) {
      if (!p || !p.belongFaceId) continue;
      const belong = Number(p.belongFaceId) || 0;
      if (belong !== fromFaceId) continue;
      p.belongFaceId = toFaceId;
      this.prototypes.set(id, p);
    }
    this.rootCache.clear();
  }

  getRootFaceIdFromPrototypes(faceId) {
    const fid = Number(faceId) || 0;
    if (!fid) return 0;
    const cached = this.rootCache.get(fid);
    if (cached) return cached;

    let cur = fid;
    let hop = 0;
    const visited = [];
    while (cur > 0 && hop < 16) {
      const hit = this.rootCache.get(cur);
      if (hit) {
        cur = hit;
        break;
      }
      visited.push(cur);
      const p = this.prototypes.get(cur);
      const next = p && p.belongFaceId ? Number(p.belongFaceId) : 0;
      if (!next || next === cur) break;
      cur = next;
      hop += 1;
    }

    const root = cur > 0 ? cur : fid;
    for (const v of visited) this.rootCache.set(v, root);
    return root;
  }

  async getRootFaceId(trx, faceId) {
    const fid = Number(faceId) || 0;
    const proto = fid ? this.prototypes.get(fid) : null;
    if (proto) return this.getRootFaceIdFromPrototypes(fid);

    let cur = fid;
    let hop = 0;
    while (cur > 0 && hop < 16) {
      const row = await trx('photo_faces')
        .select('belong_face_id')
        .where({ face_id: cur })
        .first()
        .catch(() => null);
      const next = row && row.belong_face_id ? Number(row.belong_face_id) : 0;
      if (!next || next === cur) return cur;
      cur = next;
      hop += 1;
    }
    return Number(faceId) || 0;
  }

  /**
   * 找最可信的原型。
   *
   * ⭐ 2026-10-14 防误合改造（用户报「好多人的人脸混在了一起」）：
   * 1) 只维护「按根人脸去重的前二名」（另一个人的最高分）；
   * 2) 最近原型必须满足 best >= req **且** 与第二名拉开 ASSIGN_MARGIN，
   *    否则宁可新建一个人脸组 —— 两个人的原型都过阈值时不做二选一赌博；
   * 3) 去掉了原来的「提早返回」：提早返回只看了部分候选，第二名还没扫到就下结论，
   *    正是误合的来源之一。代价是每张脸多一次全量扫描（512 维点积），
   *    相对单张 ~300ms 的检测耗时可以忽略。
   */
  findBestPrototype(emb, faceMeta = null, excludeRootFaceIds = null) {
    const req = computeDynamicMatchThresh(faceMeta);
    const total = this.protoIds && this.protoIds.length ? this.protoIds.length : this.prototypes.size;
    const usePrefilter = total >= 400 && this.protoBucketToIdxSet && this.protoBucketToIdxSet.size > 0;

    const all = this.protoIds && this.protoIds.length ? this.protoIds.length : 0;
    if (!this.scanMarkArr || this.scanMarkArr.length !== all) {
      this.scanMarkArr = all > 0 ? new Uint32Array(all) : null;
      this.scanMarkStamp = 0;
    }
    if (this.scanMarkArr) {
      this.scanMarkStamp = (this.scanMarkStamp + 1) >>> 0;
      if (this.scanMarkStamp === 0) {
        this.scanMarkArr.fill(0);
        this.scanMarkStamp = 1;
      }
    }
    const stamp = this.scanMarkStamp;
    const scanMarkArr = this.scanMarkArr;

    // 前二名（rootId 去重）
    const topTwo = [];

    const scanIndices = (idxs, markVisited) => {
      for (const idx of idxs) {
        if (scanMarkArr && scanMarkArr[idx] === stamp) continue;
        if (scanMarkArr && markVisited) scanMarkArr[idx] = stamp;
        const id = this.protoIds[idx];
        if (!id) continue;
        const rootId = this.getRootFaceIdFromPrototypes(id);
        if (excludeRootFaceIds && excludeRootFaceIds.has(rootId)) continue;
        const v = this.protoVecs[idx];
        if (!v) continue;
        let s = 0;
        for (let i = 0; i < 512; i++) s += emb[i] * v[i];
        pushTopRoot(topTwo, rootId, s);
      }
    };

    if (this.topCountDirty) this.rebuildTopCountCache();
    if (this.topCountIdxs && this.topCountIdxs.length > 0) {
      scanIndices(this.topCountIdxs, true);
    }

    if (usePrefilter) {
      const sig = computeSignSignature(emb);
      const idxSet = this.protoBucketToIdxSet.get(sig);
      const maxCand = Math.max(300, Math.min(6000, Math.floor(total * 0.15)));
      const minCand = Math.max(80, Math.min(600, Math.floor(total * 0.01)));
      const candSets = [];
      let candCount = idxSet ? idxSet.size : 0;
      if (idxSet && idxSet.size > 0) candSets.push(idxSet);

      if (candCount > 0 && candCount <= maxCand && candCount < minCand) {
        for (let b = 0; b < SIGNATURE_DIMS.length && candCount < minCand && candCount <= maxCand; b++) {
          const s2 = (sig ^ (1 << b)) >>> 0;
          const set2 = this.protoBucketToIdxSet.get(s2);
          if (!set2 || set2.size === 0) continue;
          candSets.push(set2);
          candCount += set2.size;
        }
      }

      if (candCount > 0 && candCount <= maxCand) {
        // 只用来提前「登记」一批高分候选，【不再提早返回】
        for (const set of candSets) scanIndices(set, true);
      }
    }

    if (this.protoIds && this.protoVecs && this.protoIds.length === this.protoVecs.length && this.protoIds.length > 0) {
      for (let idx = 0; idx < all; idx++) {
        if (scanMarkArr && scanMarkArr[idx] === stamp) continue;
        const id = this.protoIds[idx];
        if (!id) continue;
        const rootId = this.getRootFaceIdFromPrototypes(id);
        if (excludeRootFaceIds && excludeRootFaceIds.has(rootId)) continue;
        const v = this.protoVecs[idx];
        if (!v) continue;
        let s = 0;
        for (let i = 0; i < 512; i++) s += emb[i] * v[i];
        pushTopRoot(topTwo, rootId, s);
      }
    } else {
      for (const [id, p] of this.prototypes.entries()) {
        if (!p || !p.vec) continue;
        const rootId = this.getRootFaceIdFromPrototypes(id);
        if (excludeRootFaceIds && excludeRootFaceIds.has(rootId)) continue;
        const sim = dot(emb, p.vec);
        pushTopRoot(topTwo, rootId, sim);
      }
    }

    const best = topTwo[0] || null;
    if (!best) return null;
    const second = topTwo[1] || null;
    const decision = decideFaceAssignment({
      bestSim: best.sim,
      secondSim: second ? second.sim : null,
      req,
      margin: ASSIGN_MARGIN,
    });
    if (!decision.accepted) {
      if (decision.ambiguous) {
        this.assignAmbiguousCount = (this.assignAmbiguousCount || 0) + 1;
        // 每 200 次打一行，避免刷屏；用于线上判断「是不是阈值太松/太严」
        if (this.assignAmbiguousCount % 200 === 0) {
          Logger.info(
            `[faceCluster] 认领被拒 x${this.assignAmbiguousCount}（最近两个人脸组难分伯仲：` +
            `best=${best.sim.toFixed(4)} second=${second ? second.sim.toFixed(4) : 'n/a'} ` +
            `gap=${Number.isFinite(decision.gap) ? decision.gap.toFixed(4) : 'n/a'} < margin=${ASSIGN_MARGIN} req=${req.toFixed(4)}）`
          );
        }
      }
      return null;
    }
    return { faceId: best.rootId, sim: best.sim, req };
  }

  async createNewFace(trx, emb, meta = null) {
    const now = trx.fn.now();
    const featureBuf = float32ToBuffer(emb);
    const fileHash = meta && meta.fileHash ? String(meta.fileHash) : '';
    const quality = Math.max(0, Math.floor(Number(meta && meta.quality ? meta.quality : 0) || 0));
    const insertRes = await trx('photo_faces')
      .insert({
        feature: featureBuf,
        name: Buffer.from(''),
        feature_dim: 512,
        belong_face_id: null,
        face_count: 1,
        create_time: now,
        update_time: now,
        proto_sample_count: 1,
        proto_rebuild_time: null,
        proto_best_quality_score: quality,
        proto_best_file_hash: fileHash || null,
      })
      .catch(() => null);
    const newId = Array.isArray(insertRes) ? Number(insertRes[0]) : Number(insertRes);
    if (!newId) return 0;
    this.prototypes.set(newId, { vec: emb, count: 1, belongFaceId: null, recentEmbs: [emb] });
    this.addProtoToSearchIndex(newId, emb);
    this.protoCountById.set(newId, 1);
    this.topCountDirty = true;
    return newId;
  }

  async assignToFace(trx, faceId, emb, meta = null) {
    const proto = this.prototypes.get(faceId);
    if (!proto || !proto.vec) return faceId;
    const oldCount = Number(proto.count) || 0;
    const newCount = oldCount + 1;
    const qualityScore = clampNumber(meta && meta.qualityScore, 0, 100);
    const canUpdateProto = qualityScore >= PROTO_UPDATE_MIN_QUALITY;
    let newVec = proto.vec;
    if (canUpdateProto) {
      const baseWeight = computeProtoUpdateWeight(qualityScore);
      const diversityFactor = computeRecentDiversityFactor(proto, emb);
      const effectiveWeight = baseWeight * diversityFactor;
      const maxAlpha = oldCount < 10 ? 0.35 : 0.2;
      const alpha = clampNumber(effectiveWeight / Math.max(1e-6, oldCount + effectiveWeight), 0.02, maxAlpha);
      const mixed = new Float32Array(512);
      for (let i = 0; i < 512; i++) mixed[i] = proto.vec[i] * (1 - alpha) + emb[i] * alpha;
      newVec = normalizeL2(mixed);
      proto.vec = newVec;
      pushRecentEmb(proto, emb);
      this.updateProtoInSearchIndex(faceId, newVec);
    }
    proto.count = newCount;
    this.prototypes.set(faceId, proto);
    this.protoCountById.set(faceId, newCount);
    this.topCountUpdateCounter += 1;
    if (this.topCountUpdateCounter % 200 === 0) this.topCountDirty = true;
    await trx('photo_faces')
      .where({ face_id: faceId })
      .update({
        ...(canUpdateProto ? { feature: float32ToBuffer(newVec) } : {}),
        face_count: newCount,
        update_time: trx.fn.now(),
        ...(canUpdateProto ? { proto_sample_count: trx.raw('proto_sample_count + 1') } : {}),
      })
      .catch(() => {});
    return faceId;
  }

  async insertFaceMapping(trx, fileHash, faceId, box) {
    const rootFaceId = await this.getRootFaceId(trx, faceId);
    const base = {
      file_hash: fileHash,
      face_id: rootFaceId,
      box_left: Math.max(0, Math.floor(Number(box.left) || 0)),
      box_top: Math.max(0, Math.floor(Number(box.top) || 0)),
      box_width: Math.max(0, Math.floor(Number(box.width) || 0)),
      box_height: Math.max(0, Math.floor(Number(box.height) || 0)),
      is_cover: 0,
      create_time: trx.fn.now(),
    };
    await trx('photo_face2filehash')
      .insert(base)
      .catch(async () => {
        const existed = await trx('photo_face2filehash')
          .where({ file_hash: fileHash, face_id: rootFaceId })
          .first('id')
          .catch(() => null);
        if (existed && existed.id) return;
      });
  }

  async upsertSample(trx, fileHash, faceId, emb, qualityScore) {
    const existed = await trx('photo_face_samples')
      .where({ face_id: faceId, file_hash: fileHash })
      .first('id', 'quality_score')
      .catch(() => null);
    if (existed && existed.id) {
      const oldQ = Number(existed.quality_score) || 0;
      if (qualityScore > oldQ) {
        await trx('photo_face_samples')
          .where({ id: existed.id })
          .update({ feature: float32ToBuffer(emb), quality_score: qualityScore })
          .catch(() => {});
        await this.updateProtoBest(trx, faceId, fileHash, qualityScore);
      }
      return;
    }
    await trx('photo_face_samples')
      .insert({
        face_id: faceId,
        file_hash: fileHash,
        feature: float32ToBuffer(emb),
        feature_dim: 512,
        quality_score: Math.max(0, Math.floor(Number(qualityScore) || 0)),
        create_time: trx.fn.now(),
      })
      .catch(() => {});
    await this.updateProtoBest(trx, faceId, fileHash, qualityScore);
  }

  async updateProtoBest(trx, faceId, fileHash, qualityScore) {
    const q = Math.max(0, Math.floor(Number(qualityScore) || 0));
    if (!q) return;
    const fh = fileHash ? String(fileHash) : '';
    await trx('photo_faces')
      .where({ face_id: faceId })
      .andWhere('proto_best_quality_score', '<', q)
      .update({ proto_best_quality_score: q, proto_best_file_hash: fh || null, update_time: trx.fn.now() })
      .catch(() => {});
  }

  async markIndexDone(id) {
    await this.knex('photo_index')
      .where({ id })
      .update({ gen_faces: 1 })
      .catch(() => {});
  }

  stop() {
    this.isRunning = false;
  }
}

/**
 * ⭐ 2026-10-13 推理线程入口（role=infer）：
 * 同一文件被 worker_threads 加载时只做「检测+特征提取」，不碰 DB / 聚类。
 * 每个线程有自己的人脸引擎实例（ONNX 会话不可跨线程共享）。
 */
async function startInferThread() {
  const { parentPort } = require('worker_threads');
  if (!parentPort) return;
  let engine = null;
  try {
    engine = await getFaceEngine();
  } catch (e) {
    Logger.error('❌ infer thread engine init failed:', e);
    try {
      parentPort.postMessage({ type: 'ready', ok: false, error: String((e && e.message) || e) });
    } catch (_) {}
    process.exit(1);
    return;
  }
  parentPort.on('message', async msg => {
    if (!msg || typeof msg.id !== 'number') return;
    try {
      const faces = await engine.extractFaceFeatures(msg.imagePath);
      const out = (faces || []).map(f => ({
        box: f.box,
        qualityScore: f.qualityScore,
        feature: Array.from(f.feature), // 512 维 float32（普通数组走结构化克隆）
      }));
      parentPort.postMessage({ id: msg.id, ok: true, faces: out });
    } catch (e) {
      try {
        parentPort.postMessage({ id: msg.id, ok: false, error: String((e && e.message) || e) });
      } catch (_) {}
    }
  });
  parentPort.postMessage({ type: 'ready', ok: true });
}

if (!isMainThread && threadWorkerData && threadWorkerData.role === 'infer') {
  startInferThread();
} else {
  const worker = new FaceWorker();

  process.on('message', message => {
    if (!message || !message.type) return;
    if (message.type === 'stop') {
      worker.stop();
      worker.terminateInferThreads();
    }
    if (message.type === 'maintenance') worker.maybeRunMaintenance(true);
  });

  process.on('uncaughtException', err => {
    Logger.error('❌ face worker uncaughtException', err);
    process.exit(0);
  });

  process.on('unhandledRejection', reason => {
    Logger.error('❌ face worker unhandledRejection', reason);
    process.exit(0);
  });
}
