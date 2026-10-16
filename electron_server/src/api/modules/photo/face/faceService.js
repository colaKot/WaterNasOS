const fs = require('fs');
const path = require('path');
const sharp = require('../../../../utils/sharpConfigured');
const sharpUtils = require('../../../../utils/sharpUtils');
const fileService = require('../../file/core/fileService');
const tableConfig = require('../../../../db/table/tableConfig');
const photoPathQueryUtil = require('../timeline/photoPathQueryUtil');

function clampNumber(v, min, max) {
  if (!Number.isFinite(v)) return min;
  return Math.max(min, Math.min(max, v));
}

function createSharpFromConverted(converted) {
  if (converted && typeof converted === 'object' && !Buffer.isBuffer(converted) && converted.input && converted.options) {
    return sharp(converted.input, converted.options);
  }
  return sharp(converted);
}

class FaceService {
  constructor(knex) {
    this.knex = knex;
  }

  async toggleAiFaceInMainProcess(enable, { timeoutMs = 15000 } = {}) {
    if (!process.send) {
      const err = new Error('common.ERROR');
      err.statusCode = 500;
      throw err;
    }

    const requestId = `toggleAiFace_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        process.off('message', handleResponse);
        reject(new Error('common.ERROR'));
      }, timeoutMs);

      const handleResponse = message => {
        if (!message || message.type !== 'toggleAiFaceResponse') return;
        const data = message.data || {};
        if (data.requestId !== requestId) return;
        clearTimeout(timeout);
        process.off('message', handleResponse);
        if (!data.ok) {
          const err = new Error('common.ERROR');
          err.statusCode = 500;
          reject(err);
          return;
        }
        resolve({
          enable: !!enable,
          running: data.running,
        });
      };

      process.on('message', handleResponse);
      try {
        process.send({
          type: 'toggleAiFace',
          data: {
            enable: enable ? 1 : 0,
            requestId,
          },
          timestamp: Date.now(),
        });
      } catch (e) {
        clearTimeout(timeout);
        process.off('message', handleResponse);
        reject(e);
      }
    });
  }

  async resetFaceRecognition() {
    await this.toggleAiFaceInMainProcess(false);

    await this.knex.transaction(async trx => {
      await trx('photo_face2filehash')
        .del()
        .catch(() => {});
      await trx('photo_face_samples')
        .del()
        .catch(() => {});
      await trx('photo_faces')
        .del()
        .catch(() => {});
      await trx('photo_index')
        .update({ gen_faces: 0 })
        .catch(() => {});
    });

    await this.toggleAiFaceInMainProcess(true);

    return true;
  }

  async getRootFaceId(faceId) {
    let cur = Number(faceId) || 0;
    let hop = 0;
    while (cur > 0 && hop < 16) {
      const row = await this.knex('photo_faces')
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

  async listFaces(params = {}) {
    const page = Math.max(1, Number(params.page) || 1);
    const pageSize = Math.max(1, Math.min(200, Number(params.pageSize ?? params.page_size) || 60));
    const offset = (page - 1) * pageSize;
    const status = params.status || params.filter || 'visiable';
    const keywordRaw = params.keyword ?? params.q ?? params.name ?? '';
    const keyword = typeof keywordRaw === 'string' ? keywordRaw.trim() : '';
    const escapeLike = s => String(s).replace(/[\\%_]/g, m => `\\${m}`);
    const validPaths = Array.isArray(params.validPaths) ? params.validPaths.filter(Boolean) : [];
    if (Object.prototype.hasOwnProperty.call(params, 'validPaths') && validPaths.length === 0) {
      return {
        items: [],
        pagination: { total: 0, page, pageSize },
      };
    }

    let minShowCount = 0;
    try {
      const raw = await tableConfig.getConfigByKey('ai_face_min_show_count');
      const parsed = Math.floor(Number(raw));
      minShowCount = Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
    } catch (_) {
      minShowCount = 0;
    }

    // ⭐ 2026-10-13 计数口径（用户报「列表显示 3300+ 张，点进去只有几十张」）：
    // 原来列表用的是 photo_faces.face_count（**全库**计数，不区分用户的相册源），
    // 而点进去的时间线按可见性过滤（只算该用户 photo_source 范围内的照片）⇒ 两个数字对不上。
    // 现在有 validPaths 时一律用「可见范围内实际去重照片数」作为计数/排序/最小显示数口径，
    // 与点进去看到的完全一致；不限路径（内部调用）时才回退到 face_count。
    const buildVisibleCountSub = () => {
      const sub = this.knex('photo_face2filehash as f2')
        .join('photo_index as p', 'p.file_hash', 'f2.file_hash')
        .where('p.is_file', 1)
        .where('p.in_trash', 0)
        .whereRaw('f2.face_id = photo_faces.face_id')
        .countDistinct({ cnt: 'f2.file_hash' });
      photoPathQueryUtil.applyPathPrefixFilter(sub, 'p.path', validPaths);
      return sub;
    };
    const visibleCountSub = validPaths.length > 0 ? buildVisibleCountSub() : null;
    // 可见范围里至少要有 1 张才值得展示（minShowCount 为 0 时也要挡掉 0 张的"空相册"）
    const minVisible = Math.max(1, minShowCount || 1);

    // ⭐ 2026-10-13：belong_face_id 为 NULL **或 0** 都算根人脸
    // （历史数据/部分迁移路径会写 0，只判 NULL 会漏掉整组）。
    const isRoot = qb => {
      qb.whereNull('belong_face_id').orWhere('belong_face_id', 0);
    };
    let totalQuery = this.knex('photo_faces').where(isRoot);
    let rowsQuery = this.knex('photo_faces')
      .select('face_id', 'face_count', 'belong_face_id', 'is_hide', 'name', 'create_time', 'update_time')
      .where(isRoot);

    if (visibleCountSub) {
      totalQuery = totalQuery.whereRaw('(?) >= ?', [visibleCountSub, minVisible]);
      rowsQuery = rowsQuery.whereRaw('(?) >= ?', [visibleCountSub, minVisible]);
      rowsQuery = rowsQuery.select(this.knex.raw('(?) as visible_count', [buildVisibleCountSub()]));
    } else {
      totalQuery = totalQuery.where('face_count', '>=', minShowCount);
      rowsQuery = rowsQuery.where('face_count', '>=', minShowCount);
    }

    if (status === 'visible' || status === 'visiable') {
      totalQuery = totalQuery.andWhere('is_hide', 0);
      rowsQuery = rowsQuery.andWhere('is_hide', 0);
    } else if (status === 'hide' || status === 'hidden') {
      totalQuery = totalQuery.andWhere('is_hide', 1);
      rowsQuery = rowsQuery.andWhere('is_hide', 1);
    }
    if (keyword) {
      const like = `%${escapeLike(keyword)}%`;
      totalQuery = totalQuery.andWhereRaw(`CAST(name AS TEXT) LIKE ? ESCAPE '\\'`, [like]);
      rowsQuery = rowsQuery.andWhereRaw(`CAST(name AS TEXT) LIKE ? ESCAPE '\\'`, [like]);
    }

    const totalRow = await totalQuery
      .count({ total: 'face_id' })
      .first()
      .catch(() => ({ total: 0 }));
    const total = Number(totalRow && totalRow.total ? totalRow.total : 0) || 0;

    const rowsQueryFinal = visibleCountSub
      ? rowsQuery.orderByRaw('visible_count desc')
      : rowsQuery.orderBy('face_count', 'desc');
    const rows = await rowsQueryFinal
      .orderBy('face_id', 'desc')
      .limit(pageSize)
      .offset(offset)
      .catch(() => []);

    const items = Array.isArray(rows) ? rows : [];
    const faceIds = items.map(it => Number(it.face_id)).filter(id => Number.isFinite(id) && id > 0);
    const coverByFaceId = new Map();

    if (faceIds.length > 0) {
      let coverQuery = this.knex('photo_face2filehash as f2')
        .join('photo_index as p', 'p.file_hash', 'f2.file_hash')
        .whereIn('f2.face_id', faceIds)
        .andWhere('p.is_file', 1)
        .andWhere('p.in_trash', 0)
        .select('f2.face_id as face_id', 'f2.file_hash as file_hash', 'p.original_time as original_time', 'p.id as photo_id', 'f2.id as f2_id')
        .orderBy('f2.is_cover', 'desc')
        // ⭐ 2026-10-13：本人脸框面积大的优先（主体更清晰、也顺带排除小框误检那张），
        // 再按拍摄时间倒序。
        .orderByRaw('(f2.box_width * f2.box_height) DESC')
        .orderBy('p.original_time', 'desc')
        .orderBy('p.id', 'desc')
        .orderBy('f2.id', 'desc');
      if (validPaths.length > 0) {
        photoPathQueryUtil.applyPathPrefixFilter(coverQuery, 'p.path', validPaths);
      }
      const coverRows = await coverQuery.catch(() => []);

      for (const r of coverRows) {
        const fid = Number(r && r.face_id ? r.face_id : 0);
        if (!Number.isFinite(fid) || fid <= 0) continue;
        if (coverByFaceId.has(fid)) continue;
        const hash = r && r.file_hash ? String(r.file_hash) : '';
        coverByFaceId.set(fid, hash || null);
      }
    }

    const enriched = items.map(it => {
      const fid = Number(it && it.face_id ? it.face_id : 0);
      const nameBuf = it && it.name ? it.name : null;
      const name = Buffer.isBuffer(nameBuf) && nameBuf.length > 0 ? nameBuf.toString('utf8') : typeof nameBuf === 'string' && nameBuf ? nameBuf : null;
      const isHide = Number(it && it.is_hide ? it.is_hide : 0) || 0;
      const { name: _name, visible_count: _visible, ...rest } = it || {};
      // 有可见计数时用它覆盖 face_count，保证列表数字 = 点进去的张照片数
      const visibleCount = Number(it && it.visible_count);
      const faceCount = Number.isFinite(visibleCount)
        ? visibleCount
        : Number(it && it.face_count ? it.face_count : 0) || 0;
      return {
        ...rest,
        face_count: faceCount,
        name,
        is_hide: isHide,
        cover_file_hash: coverByFaceId.get(fid) ?? null,
      };
    });

    return {
      items: enriched,
      pagination: {
        total,
        page,
        pageSize,
      },
    };
  }

  /**
   * ⭐ 可见性校验（2026-10-13）：人脸写操作放开给所有登录用户后，
   * 必须保证只能操作「自己相册源范围内」的人脸/照片 —— 沿用照片库的可见性口径，
   * **不做 isAdmin 例外**（超管也只对自己的相册操作）。
   * 没传 validPaths（内部调用/老调用方）时跳过校验，保持兼容。
   */
  async assertFaceVisible(faceId, validPaths) {
    if (!Array.isArray(validPaths)) return;
    if (validPaths.length === 0) {
      const err = new Error('common.NOT_FOUND');
      err.statusCode = 404;
      throw err;
    }
    const q = this.knex('photo_face2filehash as f2')
      .join('photo_index as p', 'p.file_hash', 'f2.file_hash')
      .where('f2.face_id', Number(faceId) || 0)
      .andWhere('p.is_file', 1)
      .andWhere('p.in_trash', 0)
      .first('f2.id');
    photoPathQueryUtil.applyPathPrefixFilter(q, 'p.path', validPaths);
    const row = await q.catch(() => null);
    if (!row) {
      const err = new Error('common.NOT_FOUND');
      err.statusCode = 404;
      throw err;
    }
  }

  /** 同上，但校验具体某张照片是否在可见范围内 */
  async assertPhotoVisible(fileHash, validPaths) {
    if (!Array.isArray(validPaths)) return;
    if (validPaths.length === 0 || !fileHash) {
      const err = new Error('common.NOT_FOUND');
      err.statusCode = 404;
      throw err;
    }
    const q = this.knex('photo_index as p')
      .where('p.file_hash', String(fileHash))
      .andWhere('p.is_file', 1)
      .andWhere('p.in_trash', 0)
      .first('p.id');
    photoPathQueryUtil.applyPathPrefixFilter(q, 'p.path', validPaths);
    const row = await q.catch(() => null);
    if (!row) {
      const err = new Error('common.NOT_FOUND');
      err.statusCode = 404;
      throw err;
    }
  }

  /**
   * 清理历史误检人脸（2026-10-13）：按与检测端同一套阈值把已经入库的垃圾框删掉。
   * 规则：①单图人脸数 > FACE_MAX_FACES_PER_IMAGE(20) ⇒ 整张丢弃
   *      ②框宽 < 图宽 * FACE_MIN_BOX_WIDTH_RATIO(1.5%) ⇒ 丢弃该框
   * 之后清理没有任何框的 photo_faces 空壳 + 其样本，并刷新受影响分组的 face_count。
   * @returns {{removedBoxes:number, removedFaces:number, touchedPhotos:number}}
   */
  async purgeSuspiciousFaces(params = {}) {
    const maxFaces = Math.max(0, Math.min(200, Number(params.maxFacesPerImage ?? 20)));
    const minRatio = Math.max(0, Math.min(0.5, Number(params.minBoxWidthRatio ?? 0.015)));

    const overCount = this.knex('photo_face2filehash as f2')
      .whereIn('f2.file_hash', function () {
        this.select('file_hash')
          .from('photo_face2filehash')
          .groupBy('file_hash')
          .havingRaw('COUNT(1) > ?', [maxFaces]);
      });
    // ⚠️ 不能用 JOIN 式 DELETE（SQLite 不支持，knex 会静默失败），必须走 id 子查询
    const tooSmall = this.knex('photo_face2filehash as f2')
      .whereIn('f2.id', function () {
        this.select('f2b.id')
          .from('photo_face2filehash as f2b')
          .join('photo_index as p', 'p.file_hash', 'f2b.file_hash')
          .where('p.is_file', 1)
          .andWhere('p.in_trash', 0)
          .andWhere('p.width', '>', 0)
          .whereRaw('(f2b.box_width * 1.0 / p.width) < ?', [minRatio]);
      });

    const affected = await this.knex('photo_face2filehash')
      .whereIn('file_hash', function () {
        this.select('file_hash')
          .from('photo_face2filehash')
          .groupBy('file_hash')
          .havingRaw('COUNT(1) > ?', [maxFaces]);
      })
      .orWhereIn('id', function () {
        this.select('f2.id')
          .from('photo_face2filehash as f2')
          .join('photo_index as p', 'p.file_hash', 'f2.file_hash')
          .where('p.is_file', 1)
          .andWhere('p.in_trash', 0)
          .where('p.width', '>', 0)
          .whereRaw('(f2.box_width * 1.0 / p.width) < ?', [minRatio]);
      })
      .select('face_id', 'file_hash')
      .catch(() => []);

    const faceIds = [...new Set((Array.isArray(affected) ? affected : []).map(r => Number(r.face_id) || 0).filter(Boolean))];
    const photos = new Set((Array.isArray(affected) ? affected : []).map(r => String(r.file_hash || '')).filter(Boolean));

    const removedBoxes = await overCount.del().catch(() => 0);
    const removedBoxes2 = await tooSmall.del().catch(() => 0);

    // 空壳分组 + 其样本
    const removedFaces = await this.knex('photo_faces as pf')
      .whereNotExists(function () {
        this.select(1).from('photo_face2filehash as f2').whereRaw('f2.face_id = pf.face_id');
      })
      .del()
      .catch(() => 0);
    await this.knex('photo_face_samples as ps')
      .whereNotExists(function () {
        this.select(1).from('photo_faces as pf').whereRaw('pf.face_id = ps.face_id');
      })
      .del()
      .catch(() => {});

    // 刷新受影响分组的计数与封面
    for (const fid of faceIds) {
      const stillExists = await this.knex('photo_face2filehash').where({ face_id: fid }).first('face_id').catch(() => null);
      if (!stillExists) continue;
      await this.knex.transaction(async trx => {
        await this.refreshFaceAggregateInTrx(trx, fid).catch(() => 0);
      }).catch(() => 0);
    }

    return {
      removedBoxes: Number(removedBoxes || 0) + Number(removedBoxes2 || 0),
      removedFaces: Number(removedFaces || 0),
      touchedPhotos: photos.size,
    };
  }

  /**
   * 只重建「调用者可见范围内」照片的人脸（2026-10-13）：
   * 删掉这些照片的 photo_face2filehash 行 + 把 photo_index.gen_faces 置 0，
   * 后台 worker 会自动重新检测并按当前聚类参数重新分组。
   * 别人的相册不受影响（/face/reset 才是全库重建，限管理员）。
   */
  async rescanFaces(params = {}) {
    const validPaths = (Array.isArray(params.validPaths) ? params.validPaths : []).filter(Boolean);
    if (validPaths.length === 0) {
      return { clearedHashes: 0, queuedPhotos: 0 };
    }
    const base = () => {
      const q = this.knex('photo_index as p').where('p.is_file', 1).andWhere('p.in_trash', 0);
      photoPathQueryUtil.applyPathPrefixFilter(q, 'p.path', validPaths);
      return q;
    };
    const hashRows = await base().clone().select('p.file_hash as file_hash').catch(() => []);
    const hashes = (Array.isArray(hashRows) ? hashRows : []).map(r => String(r.file_hash || '')).filter(Boolean);
    if (hashes.length === 0) {
      return { clearedHashes: 0, queuedPhotos: 0 };
    }
    // 分块删除，避免 SQLite 变量上限
    let cleared = 0;
    const CHUNK = 400;
    for (let i = 0; i < hashes.length; i += CHUNK) {
      const slice = hashes.slice(i, i + CHUNK);
      const del = await this.knex('photo_face2filehash')
        .whereIn('file_hash', slice)
        .del()
        .catch(() => 0);
      cleared += Number(del || 0);
    }
    const queued = await base()
      .clone()
      .update({ gen_faces: 0 })
      .catch(() => 0);
    // 没有任何人脸行残留的分组顺手清掉（连同样本），避免列表里堆空壳
    await this.knex('photo_faces as pf')
      .whereNotExists(function () {
        this.select(1).from('photo_face2filehash as f2').whereRaw('f2.face_id = pf.face_id');
      })
      .del()
      .catch(() => {});
    await this.knex('photo_face_samples as ps')
      .whereNotExists(function () {
        this.select(1).from('photo_faces as pf').whereRaw('pf.face_id = ps.face_id');
      })
      .del()
      .catch(() => {});
    return { clearedHashes: cleared, queuedPhotos: Number(queued || 0) };
  }

  /**
   * ⭐ 2026-10-16 存量补扫（F2，修「烧图」遗留，用户报「2000 张只剩 300 多」）：
   * 把「可见范围内、已被标记 gen_faces=1、但 photo_face2filehash 里没有任何人脸行」的照片
   * 重新置为 gen_faces=0，交给后台 worker 重新检测。
   *
   * 与 rescanFaces 的区别：**只动这些疑似被烧掉的行**，不动任何已有的人脸数据，
   * 成本低（只重跑没有脸的图），也不会重置已分好的组。
   *
   * @param {Object} params {validPaths, dryRun} dryRun 时只统计不写入
   * @returns {{queuedPhotos:number, wouldQueue?:number, dryRun:boolean}}
   */
  async rescanMissingFaces(params = {}) {
    const validPaths = (Array.isArray(params.validPaths) ? params.validPaths : []).filter(Boolean);
    const dryRun = params.dryRun === true || params.dry_run === true || params.dry_run === '1';
    if (validPaths.length === 0) {
      return { queuedPhotos: 0, wouldQueue: 0, dryRun };
    }
    const base = () => {
      const q = this.knex('photo_index as p')
        .where('p.is_file', 1)
        .andWhere('p.in_trash', 0)
        .andWhere('p.gen_faces', 1)
        .whereIn('p.type', [1, 2])
        .andWhereRaw("p.file_hash IS NOT NULL AND p.file_hash <> ''")
        .whereNotExists(function () {
          this.select(1).from('photo_face2filehash as f2').whereRaw('f2.file_hash = p.file_hash');
        });
      photoPathQueryUtil.applyPathPrefixFilter(q, 'p.path', validPaths);
      return q;
    };
    if (dryRun) {
      const row = await base().clone().count({ total: 'p.id' }).first().catch(() => null);
      const total = Number(row && row.total ? row.total : 0) || 0;
      return { queuedPhotos: 0, wouldQueue: total, dryRun: true };
    }
    const queued = await base().clone().update({ gen_faces: 0 }).catch(() => 0);
    return { queuedPhotos: Number(queued || 0), wouldQueue: 0, dryRun: false };
  }

  /**
   * ⭐ 2026-10-16 全库「合并相似人物」（F3，用户报「同一个人裂成几百个组」）。
   *
   * 维护任务里的二次合并每轮只处理有限数量，这里提供一个**一次性全库归并**动作
   * （管理员在 AI 设置页触发，可先 dryRun 预览）。
   *
   * 判定规则（与计划一致）：
   *   1) 只对「根人脸」（belong_face_id 为 NULL/0）且 feature 有效的组参与；
   *   2) 组原型余弦相似度 ≥ threshold（默认 0.60）；
   *   3) 互为最近邻（掐掉 A~B、B~C 的链式合并）；
   *   4) 任一侧与其「第二名」的裕度 < margin（默认 0.01）⇒ 不并（两个组难分伯仲，宁可分）；
   *   5) **两侧都已命名的组不自动并**（只计入 suggested，交人工）；
   *   6) 本轮一对一匹配（同一个人脸本轮最多参与一次合并，多轮逐步收敛）。
   *
   * @param {{threshold?:number, margin?:number, limit?:number, dryRun?:boolean}} params
   */
  async mergeSimilarFaces(params = {}) {
    const DIM = 512;
    // 注意：不能用 `Number(x) || 默认值` —— 显式传 0（如 margin=0）会被当成空值吞掉。
    const numOr = (v, def) => {
      if (v === undefined || v === null || v === '') return def;
      const n = Number(v);
      return Number.isFinite(n) ? n : def;
    };
    const threshold = Math.max(0.3, Math.min(0.95, numOr(params.threshold, 0.6)));
    // 裕度默认 0.01 而非 0.05：实测 0.05 会「互相卡死」——同一人被碎成几百个近乎副本的原型，
    // 彼此互为近邻且差距极小，裕度判定几乎全被否掉（4254 组里只剩 45 对可并）。
    // 真正防误合的是「0.60 阈值 + 互为最近邻 + 本轮一对一」，裕度只需一点点兜底。
    const margin = Math.max(0, Math.min(0.3, numOr(params.margin, 0.01)));
    const limit = Math.max(0, Math.min(5000, numOr(params.limit, 1000)));
    const dryRun = params.dryRun === true || params.dry_run === true || params.dry_run === '1';

    const rows = await this.knex('photo_faces')
      .select('face_id', 'feature', 'face_count', 'name')
      .where(qb => {
        qb.whereNull('belong_face_id').orWhere('belong_face_id', 0);
      })
      .andWhere('face_count', '>=', 1)
      .catch(() => []);

    const ids = [];
    const counts = [];
    const named = [];
    const vecs = [];
    for (const r of rows || []) {
      const buf = r && r.feature ? Buffer.from(r.feature) : null;
      if (!buf || buf.length !== DIM * 4) continue;
      const view = new Float32Array(buf.buffer, buf.byteOffset, DIM);
      let sum = 0;
      for (let d = 0; d < DIM; d++) sum += view[d] * view[d];
      const inv = 1 / Math.sqrt(sum || 1);
      const out = new Float32Array(DIM);
      for (let d = 0; d < DIM; d++) out[d] = view[d] * inv;
      const id = Number(r.face_id) || 0;
      if (!id) continue;
      const nameBuf = r && r.name ? r.name : null;
      const hasName = Buffer.isBuffer(nameBuf)
        ? nameBuf.length > 0
        : typeof nameBuf === 'string'
          ? nameBuf.trim().length > 0
          : false;
      ids.push(id);
      counts.push(Math.max(0, Number(r && r.face_count ? r.face_count : 0) || 0));
      named.push(hasName);
      vecs.push(out);
    }

    const n = ids.length;
    const emptyResult = {
      dryRun,
      threshold,
      margin,
      faceTotal: n,
      pairCount: 0,
      adoptable: 0,
      suggestedPairs: 0,
      merged: 0,
      samples: [],
    };
    if (n < 2) return emptyResult;

    // 扁平矩阵 + 后缀能量：只用于剪枝（剩余维度即使完全同向也够不到阈值就提前跳出），不会误判
    const mat = new Float32Array(n * DIM);
    const rem = new Float32Array(n * (DIM + 1));
    for (let i = 0; i < n; i++) {
      const v = vecs[i];
      mat.set(v, i * DIM);
      let acc = 0;
      for (let d = DIM - 1; d >= 0; d--) {
        acc += v[d] * v[d];
        rem[i * (DIM + 1) + d] = acc;
      }
    }

    const bestSim = new Float64Array(n).fill(-Infinity);
    const secondSim = new Float64Array(n).fill(-Infinity);
    const bestPartner = new Int32Array(n).fill(-1);
    const pairs = [];
    for (let i = 0; i < n; i++) {
      const oi = i * DIM;
      const ri = i * (DIM + 1);
      for (let j = i + 1; j < n; j++) {
        const oj = j * DIM;
        const rj = j * (DIM + 1);
        let s = 0;
        for (let d = 0; d < DIM; d++) {
          s += mat[oi + d] * mat[oj + d];
          if (s + Math.sqrt(rem[ri + d + 1] * rem[rj + d + 1]) < threshold) {
            s = -Infinity;
            break;
          }
        }
        if (!Number.isFinite(s) || s < threshold) continue;
        pairs.push({ ai: i, bi: j, sim: s });
        if (s > bestSim[i]) {
          secondSim[i] = bestSim[i];
          bestSim[i] = s;
          bestPartner[i] = j;
        } else if (s > secondSim[i]) {
          secondSim[i] = s;
        }
        if (s > bestSim[j]) {
          secondSim[j] = bestSim[j];
          bestSim[j] = s;
          bestPartner[j] = i;
        } else if (s > secondSim[j]) {
          secondSim[j] = s;
        }
      }
    }

    const gapOk = i => {
      const b = bestSim[i];
      const sec = secondSim[i];
      if (!Number.isFinite(b)) return false;
      if (!Number.isFinite(sec)) return true;
      return b - sec >= margin;
    };

    let suggestedPairs = 0;
    const candidates = [];
    for (const p of pairs) {
      // 规则 5：两侧都已命名 ⇒ 不自动并
      if (named[p.ai] && named[p.bi]) {
        suggestedPairs += 1;
        continue;
      }
      // 规则 4：互为最近邻 + 双方裕度达标
      if (bestPartner[p.ai] !== p.bi || bestPartner[p.bi] !== p.ai) continue;
      if (!gapOk(p.ai) || !gapOk(p.bi)) continue;
      candidates.push(p);
    }

    candidates.sort((x, y) => y.sim - x.sim);
    const used = new Set();
    const chosen = [];
    for (const p of candidates) {
      if (chosen.length >= limit) break;
      if (used.has(p.ai) || used.has(p.bi)) continue;
      used.add(p.ai);
      used.add(p.bi);
      // 保留张数多的那一组（并列取 id 大的，稳定）；没名字的一侧会被继承名字
      const keepIsA = counts[p.ai] > counts[p.bi] || (counts[p.ai] === counts[p.bi] && ids[p.ai] > ids[p.bi]);
      const keepFaceId = keepIsA ? ids[p.ai] : ids[p.bi];
      const dropFaceId = keepIsA ? ids[p.bi] : ids[p.ai];
      chosen.push({ keepFaceId, dropFaceId, sim: p.sim });
    }

    const samples = chosen.slice(0, 20).map(c => ({
      keep: c.keepFaceId,
      drop: c.dropFaceId,
      sim: Number(c.sim.toFixed(4)),
    }));

    if (dryRun) {
      return {
        dryRun: true,
        threshold,
        margin,
        faceTotal: n,
        pairCount: pairs.length,
        adoptable: chosen.length,
        suggestedPairs,
        merged: 0,
        samples,
      };
    }

    let merged = 0;
    const CHUNK = 25;
    for (let i = 0; i < chosen.length; i += CHUNK) {
      const slice = chosen.slice(i, i + CHUNK);
      try {
        await this.knex.transaction(async trx => {
          for (const c of slice) {
            await this.mergeTwoFacesInTrx(trx, c.dropFaceId, c.keepFaceId);
          }
        });
        merged += slice.length;
      } catch (_) {
        // 整块失败 ⇒ 退化成逐对提交，保证能并多少并多少
        for (const c of slice) {
          try {
            await this.knex.transaction(async trx => {
              await this.mergeTwoFacesInTrx(trx, c.dropFaceId, c.keepFaceId);
            });
            merged += 1;
          } catch (_) {}
        }
      }
    }

    return {
      dryRun: false,
      threshold,
      margin,
      faceTotal: n,
      pairCount: pairs.length,
      adoptable: chosen.length,
      suggestedPairs,
      merged,
      samples,
    };
  }

  async setFaceCover(params = {}) {
    const rawFaceId = Number(params.faceId ?? params.face_id);
    const fileHash = params.fileHash ?? params.file_hash;
    if (!Number.isFinite(rawFaceId) || rawFaceId <= 0 || !fileHash) {
      const err = new Error('common.PARAM_ERROR');
      err.statusCode = 400;
      throw err;
    }
    const faceId = await this.getRootFaceId(rawFaceId);
    const hash = String(fileHash);

    await this.knex.transaction(async trx => {
      await trx('photo_face2filehash')
        .where({ face_id: faceId })
        .update({ is_cover: 0 })
        .catch(() => {});
      const changed = await trx('photo_face2filehash')
        .where({ face_id: faceId, file_hash: hash })
        .update({ is_cover: 1 })
        .catch(() => 0);
      if (!changed) {
        const err = new Error('common.NOT_FOUND');
        err.statusCode = 404;
        throw err;
      }
    });

    return true;
  }

  async updateFaceName(params = {}) {
    const rawFaceId = Number(params.faceId ?? params.face_id);
    const name = params.name;
    if (!Number.isFinite(rawFaceId) || rawFaceId <= 0 || typeof name !== 'string') {
      const err = new Error('common.PARAM_ERROR');
      err.statusCode = 400;
      throw err;
    }
    const faceId = await this.getRootFaceId(rawFaceId);
    const buf = Buffer.from(String(name), 'utf8');
    // 2026-10-13：不再吞错 —— 以前写失败也返回 success，用户以为命名成功，
    // 后续合并时名字"凭空消失"，表现为「合并后名字丢了/合并失败」。
    await this.knex('photo_faces')
      .where({ face_id: faceId })
      .update({ name: buf, update_time: this.knex.fn.now() });
    return true;
  }

  async refreshFaceAggregateInTrx(trx, faceId, options = {}) {
    const rawFaceId = Number(faceId) || 0;
    if (!rawFaceId) return 0;

    const keepCoverHashRaw = options.keepCoverHash;
    const keepCoverHash = keepCoverHashRaw ? String(keepCoverHashRaw).trim() : '';

    const countRow = await trx('photo_face2filehash')
      .where({ face_id: rawFaceId })
      .countDistinct({ total: 'file_hash' })
      .first()
      .catch(() => ({ total: 0 }));
    const nextCount = Math.max(
      0,
      Number(countRow && countRow.total ? countRow.total : 0) || 0
    );

    await trx('photo_face2filehash')
      .where({ face_id: rawFaceId })
      .update({ is_cover: 0 })
      .catch(() => {});

    let coverHash = '';
    if (keepCoverHash) {
      const keepRow = await trx('photo_face2filehash')
        .where({ face_id: rawFaceId, file_hash: keepCoverHash })
        .first('file_hash')
        .catch(() => null);
      if (keepRow && keepRow.file_hash) {
        coverHash = String(keepRow.file_hash);
      }
    }

    if (!coverHash && nextCount > 0) {
      const coverRow = await trx('photo_face2filehash as f2')
        .join('photo_index as p', 'p.file_hash', 'f2.file_hash')
        .where('f2.face_id', rawFaceId)
        .andWhere('p.is_file', 1)
        .andWhere('p.in_trash', 0)
        .orderBy('p.original_time', 'desc')
        .orderBy('p.id', 'desc')
        .orderBy('f2.id', 'desc')
        .first('f2.file_hash as file_hash')
        .catch(() => null);
      if (coverRow && coverRow.file_hash) {
        coverHash = String(coverRow.file_hash);
      }
    }

    if (coverHash) {
      await trx('photo_face2filehash')
        .where({ face_id: rawFaceId, file_hash: coverHash })
        .update({ is_cover: 1 })
        .catch(() => {});
    }

    await trx('photo_faces')
      .where({ face_id: rawFaceId })
      .update({ face_count: nextCount, update_time: trx.fn.now() })
      .catch(() => {});

    return nextCount;
  }

  /**
   * 把 fromFaceId 合并进 toFaceId（同一事务内调用）。
   *
   * ⭐ 2026-10-13 修复（用户报「一个有名字一个没名字就合并失败」「合并后没反应」）：
   * 1. 关键 UPDATE 不再 `.catch(() => {})` 吞错 —— 以前任何一步静默失败，
   *    事务照样提交，客户端收到 success 但数据半新半旧，看起来就是"合并失败/没反应"。
   *    现在出错会抛穿事务回滚，客户端能拿到真实错误码。
   * 2. photo_face_samples 跟着迁移（以前不迁 ⇒ 被合并掉的人脸样本变成"僵尸样本"，
   *    维护任务会按样本把它重新养回来，用户看到人又"复活"分裂）。
   * 3. proto_best_* 取两者较优者，避免合并后最佳样本信息丢旧方的。
   * 4. 名字继承：目标没名字且来源有名字时继承（Buffer 原样透传，不重新编码）。
   */
  async mergeTwoFacesInTrx(trx, fromFaceId, toFaceId) {
    const [fromRow, toRow] = await Promise.all([
      trx('photo_faces')
        .select('face_id', 'face_count', 'name', 'proto_best_quality_score', 'proto_best_file_hash')
        .where({ face_id: fromFaceId })
        .first()
        .catch(() => null),
      trx('photo_faces')
        .select('face_id', 'face_count', 'name', 'proto_best_quality_score', 'proto_best_file_hash')
        .where({ face_id: toFaceId })
        .first()
        .catch(() => null),
    ]);
    if (!fromRow || !toRow) {
      const err = new Error('common.NOT_FOUND');
      err.statusCode = 404;
      throw err;
    }

    const isEmptyName = v => v == null || (Buffer.isBuffer(v) ? v.length === 0 : typeof v === 'string' ? v.length === 0 : false);
    const inheritName = isEmptyName(toRow && toRow.name) && !isEmptyName(fromRow && fromRow.name) ? fromRow.name : undefined;

    const toCover = await trx('photo_face2filehash')
      .where({ face_id: toFaceId, is_cover: 1 })
      .first('file_hash')
      .catch(() => null);
    const fromCover = await trx('photo_face2filehash')
      .where({ face_id: fromFaceId, is_cover: 1 })
      .first('file_hash')
      .catch(() => null);
    const keepCoverHash = (toCover && toCover.file_hash ? String(toCover.file_hash) : '') || (fromCover && fromCover.file_hash ? String(fromCover.file_hash) : '');

    // 1) 照片映射迁移（UNIQUE(file_hash, face_id) 保证 OR IGNORE 幂等）
    await trx.raw(
      `INSERT OR IGNORE INTO photo_face2filehash (file_hash, face_id, box_left, box_top, box_width, box_height, is_cover, create_time)
       SELECT file_hash, ?, box_left, box_top, box_width, box_height, 0 as is_cover, create_time FROM photo_face2filehash WHERE face_id = ?`,
      [toFaceId, fromFaceId]
    );
    await trx('photo_face2filehash')
      .where({ face_id: fromFaceId })
      .del();

    // 2) 样本迁移（photo_face_samples 无唯一索引，用 NOT EXISTS 防重复）
    await trx
      .raw(
        `INSERT OR IGNORE INTO photo_face_samples (face_id, file_hash, feature, feature_dim, quality_score, create_time)
         SELECT ?, file_hash, feature, feature_dim, quality_score, create_time FROM photo_face_samples WHERE face_id = ?
           AND NOT EXISTS (
             SELECT 1 FROM photo_face_samples e WHERE e.face_id = ? AND e.file_hash = photo_face_samples.file_hash
           )`,
        [toFaceId, fromFaceId, toFaceId]
      )
      .catch(() => {});
    await trx('photo_face_samples')
      .where({ face_id: fromFaceId })
      .del()
      .catch(() => {});

    // 3) 封面重置（保留优先生效的封面）
    await trx('photo_face2filehash')
      .where({ face_id: toFaceId })
      .update({ is_cover: 0 });
    if (keepCoverHash) {
      await trx('photo_face2filehash')
        .where({ face_id: toFaceId, file_hash: keepCoverHash })
        .update({ is_cover: 1 });
    }

    const fromCount = Math.max(0, Number(fromRow && fromRow.face_count ? fromRow.face_count : 0) || 0);
    const toCount = Math.max(0, Number(toRow && toRow.face_count ? toRow.face_count : 0) || 0);
    // 实际去重照片数（同一张照片同时含双方人脸时，INSERT OR IGNORE 会去重，
    // 直接 toCount + fromCount 会多算；这里按合并后的真实行数重算）
    const cntRow = await trx('photo_face2filehash')
      .where({ face_id: toFaceId })
      .countDistinct({ total: 'file_hash' })
      .first()
      .catch(() => null);
    const realCount = cntRow && Number.isFinite(Number(cntRow.total)) ? Math.max(0, Number(cntRow.total) || 0) : toCount + fromCount;
    const bestFromQ = Math.max(0, Math.floor(Number(fromRow && fromRow.proto_best_quality_score ? fromRow.proto_best_quality_score : 0) || 0));
    const bestToQ = Math.max(0, Math.floor(Number(toRow && toRow.proto_best_quality_score ? toRow.proto_best_quality_score : 0) || 0));
    const bestFromHash = fromRow && fromRow.proto_best_file_hash ? String(fromRow.proto_best_file_hash) : '';
    const bestToHash = toRow && toRow.proto_best_file_hash ? String(toRow.proto_best_file_hash) : '';
    const mergedBestQ = bestFromQ > bestToQ ? bestFromQ : bestToQ;
    const mergedBestHash = bestFromQ > bestToQ ? bestFromHash : bestToHash;

    const updateTo = {
      face_count: realCount,
      proto_best_quality_score: mergedBestQ,
      proto_best_file_hash: mergedBestHash || null,
      update_time: trx.fn.now(),
    };
    if (inheritName !== undefined) updateTo.name = inheritName;
    await trx('photo_faces').where({ face_id: toFaceId }).update(updateTo);

    await trx('photo_faces')
      .where({ face_id: fromFaceId })
      .update({ belong_face_id: toFaceId, face_count: 0, update_time: trx.fn.now() });

    await trx('photo_faces')
      .where({ belong_face_id: fromFaceId })
      .update({ belong_face_id: toFaceId, update_time: trx.fn.now() });

    return true;
  }

  async mergeFacesMultiple(params = {}) {
    const raw = params.faceIds ?? params.face_ids ?? [];
    if (!Array.isArray(raw) || raw.length < 2) {
      const err = new Error('common.PARAM_ERROR');
      err.statusCode = 400;
      throw err;
    }
    const ids = raw.map(v => Number(v)).filter(v => Number.isFinite(v) && v > 0);
    if (ids.length < 2) {
      const err = new Error('common.PARAM_ERROR');
      err.statusCode = 400;
      throw err;
    }
    const rootIdsRaw = await Promise.all(ids.map(id => this.getRootFaceId(id)));
    const rootIds = [];
    const seen = new Set();
    for (const id of rootIdsRaw) {
      const fid = Number(id) || 0;
      if (!fid) continue;
      if (seen.has(fid)) continue;
      seen.add(fid);
      rootIds.push(fid);
    }
    if (rootIds.length < 2) return true;

    const fileCountRows = await this.knex('photo_face2filehash')
      .whereIn('face_id', rootIds)
      .groupBy('face_id')
      .select('face_id')
      .countDistinct({ file_count: 'file_hash' })
      .catch(() => []);
    const fileCountById = new Map();
    for (const r of fileCountRows || []) {
      const fid = Number(r && r.face_id ? r.face_id : 0);
      const c = Number(r && r.file_count ? r.file_count : 0) || 0;
      if (fid) fileCountById.set(fid, c);
    }
    const faceCountRows = await this.knex('photo_faces')
      .whereIn('face_id', rootIds)
      .select('face_id', 'face_count')
      .catch(() => []);
    const faceCountById = new Map();
    for (const r of faceCountRows || []) {
      const fid = Number(r && r.face_id ? r.face_id : 0);
      const c = Number(r && r.face_count ? r.face_count : 0) || 0;
      if (fid) faceCountById.set(fid, c);
    }

    // 合并目标 = 照片数最多的那个人脸；并列时取 face_count 大的，再并列取 id 大的（稳定）
    let toFaceId = rootIds[0];
    for (const id of rootIds) {
      const a = fileCountById.get(id) ?? 0;
      const b = fileCountById.get(toFaceId) ?? 0;
      if (a > b) {
        toFaceId = id;
        continue;
      }
      if (a < b) continue;
      const fa = faceCountById.get(id) ?? 0;
      const fb = faceCountById.get(toFaceId) ?? 0;
      if (fa > fb) {
        toFaceId = id;
        continue;
      }
      if (fa < fb) continue;
      if (id > toFaceId) toFaceId = id;
    }

    try {
      await this.knex.transaction(async trx => {
        for (const fromFaceId of rootIds) {
          if (fromFaceId === toFaceId) continue;
          await this.mergeTwoFacesInTrx(trx, fromFaceId, toFaceId);
        }
      });
    } catch (e) {
      // 带上上下文再抛，控制器按 statusCode 映射；DB 锁竞争等瞬时错误走 500
      const msg = e && e.message ? String(e.message) : 'common.ERROR';
      if (msg === 'common.NOT_FOUND' || msg === 'common.PARAM_ERROR') throw e;
      const err = new Error('face.MERGE_FAILED');
      err.statusCode = 500;
      err.cause = e;
      throw err;
    }

    return true;
  }

  async mergeFaces(params = {}) {
    if (Array.isArray(params.validPaths)) {
      const ids = Array.isArray(params.faceIds ?? params.face_ids)
        ? params.faceIds ?? params.face_ids
        : [params.fromFaceId ?? params.from_face_id, params.toFaceId ?? params.to_face_id];
      for (const id of ids) {
        await this.assertFaceVisible(Number(id) || 0, params.validPaths);
      }
    }
    const faceIds = params.faceIds ?? params.face_ids;
    if (Array.isArray(faceIds) && faceIds.length > 0) {
      return this.mergeFacesMultiple({ faceIds });
    }
    const rawFromId = Number(params.fromFaceId ?? params.from_face_id);
    const rawToId = Number(params.toFaceId ?? params.to_face_id);
    if (!Number.isFinite(rawFromId) || rawFromId <= 0 || !Number.isFinite(rawToId) || rawToId <= 0 || rawFromId === rawToId) {
      const err = new Error('common.PARAM_ERROR');
      err.statusCode = 400;
      throw err;
    }

    const fromFaceId = await this.getRootFaceId(rawFromId);
    const toFaceId = await this.getRootFaceId(rawToId);
    if (!fromFaceId || !toFaceId || fromFaceId === toFaceId) return true;

    try {
      await this.knex.transaction(async trx => {
        await this.mergeTwoFacesInTrx(trx, fromFaceId, toFaceId);
      });
    } catch (e) {
      const msg = e && e.message ? String(e.message) : 'common.ERROR';
      if (msg === 'common.NOT_FOUND' || msg === 'common.PARAM_ERROR') throw e;
      const err = new Error('face.MERGE_FAILED');
      err.statusCode = 500;
      err.cause = e;
      throw err;
    }

    return true;
  }

  async updateFaceStatus(params = {}) {
    const rawFaceId = Number(params.faceId ?? params.face_id);
    await this.assertFaceVisible(rawFaceId, params.validPaths);
    const rawStatus = params.status ?? params.state ?? params.is_hide ?? params.isHide;
    if (!Number.isFinite(rawFaceId) || rawFaceId <= 0) {
      const err = new Error('common.PARAM_ERROR');
      err.statusCode = 400;
      throw err;
    }
    let isHide = null;
    if (rawStatus === 'hide' || rawStatus === 'hidden' || rawStatus === 1 || rawStatus === '1' || rawStatus === true) {
      isHide = 1;
    } else if (rawStatus === 'visible' || rawStatus === 'visiable' || rawStatus === 0 || rawStatus === '0' || rawStatus === false) {
      isHide = 0;
    }
    if (isHide === null) {
      const err = new Error('common.PARAM_ERROR');
      err.statusCode = 400;
      throw err;
    }
    const faceId = await this.getRootFaceId(rawFaceId);
    await this.knex('photo_faces')
      .where({ face_id: faceId })
      .update({ is_hide: isHide, update_time: this.knex.fn.now() })
      .catch(() => {});
    return true;
  }

  async listPhotoFaces(params = {}) {
    const fileHashRaw = params.fileHash ?? params.file_hash;
    const fileHash = fileHashRaw ? String(fileHashRaw).trim() : '';
    if (!fileHash) {
      const err = new Error('common.PARAM_ERROR');
      err.statusCode = 400;
      throw err;
    }

    const validPaths = Array.isArray(params.validPaths) ? params.validPaths.filter(Boolean) : [];
    if (Object.prototype.hasOwnProperty.call(params, 'validPaths') && validPaths.length === 0) {
      return [];
    }

    let query = this.knex('photo_face2filehash as f2')
      .join('photo_index as p', 'p.file_hash', 'f2.file_hash')
      .join('photo_faces as pf', 'pf.face_id', 'f2.face_id')
      .where('f2.file_hash', fileHash)
      .andWhere('p.is_file', 1)
      .andWhere('p.in_trash', 0)
      .select(
        'pf.face_id as face_id',
        'pf.face_count as face_count',
        'pf.is_hide as is_hide',
        'pf.name as name'
      )
      .orderBy('pf.face_count', 'desc')
      .orderBy('pf.face_id', 'desc');

    if (validPaths.length > 0) {
      photoPathQueryUtil.applyPathPrefixFilter(query, 'p.path', validPaths);
    }

    const rows = await query.catch(() => []);
    return (Array.isArray(rows) ? rows : []).map(row => {
      const nameBuf = row && row.name ? row.name : null;
      const name =
        Buffer.isBuffer(nameBuf) && nameBuf.length > 0
          ? nameBuf.toString('utf8')
          : typeof nameBuf === 'string' && nameBuf
            ? nameBuf
            : null;
      return {
        face_id: Number(row && row.face_id ? row.face_id : 0) || 0,
        face_count: Number(row && row.face_count ? row.face_count : 0) || 0,
        is_hide: Number(row && row.is_hide ? row.is_hide : 0) || 0,
        name,
      };
    });
  }

  async removePhotoFromFace(params = {}) {
    const rawFaceId = Number(params.faceId ?? params.face_id);
    const fileHashRaw = params.fileHash ?? params.file_hash;
    const fileHash = fileHashRaw ? String(fileHashRaw).trim() : '';
    if (fileHash) await this.assertPhotoVisible(fileHash, params.validPaths);
    if (!Number.isFinite(rawFaceId) || rawFaceId <= 0 || !fileHash) {
      const err = new Error('common.PARAM_ERROR');
      err.statusCode = 400;
      throw err;
    }

    const faceId = await this.getRootFaceId(rawFaceId);

    await this.knex.transaction(async trx => {
      const currentCover = await trx('photo_face2filehash')
        .where({ face_id: faceId, is_cover: 1 })
        .first('file_hash')
        .catch(() => null);
      const existed = await trx('photo_face2filehash as f2')
        .join('photo_index as p', 'p.file_hash', 'f2.file_hash')
        .where('f2.face_id', faceId)
        .andWhere('f2.file_hash', fileHash)
        .andWhere('p.is_file', 1)
        .andWhere('p.in_trash', 0)
        .first('f2.id as id')
        .catch(() => null);
      if (!existed || !existed.id) {
        const err = new Error('common.NOT_FOUND');
        err.statusCode = 404;
        throw err;
      }

      const removed = await trx('photo_face2filehash')
        .where({ face_id: faceId, file_hash: fileHash })
        .del()
        .catch(() => 0);
      if (!removed) {
        const err = new Error('common.NOT_FOUND');
        err.statusCode = 404;
        throw err;
      }

      await this.refreshFaceAggregateInTrx(trx, faceId, {
        keepCoverHash:
            currentCover && currentCover.file_hash !== fileHash
                ? currentCover.file_hash
                : '',
      });
    });

    return true;
  }

  async movePhotoToFace(params = {}) {
    const rawFromFaceId = Number(params.fromFaceId ?? params.from_face_id);
    const rawToFaceId = Number(params.toFaceId ?? params.to_face_id);
    const rawFileHashes = params.fileHashes ?? params.file_hashes ?? [];
    if (Array.isArray(params.validPaths)) {
      await this.assertFaceVisible(rawToFaceId, params.validPaths);
      const list = Array.isArray(rawFileHashes) ? rawFileHashes : [rawFileHashes];
      for (const h of list) {
        if (h) await this.assertPhotoVisible(String(h), params.validPaths);
      }
    }
    if (
      !Number.isFinite(rawFromFaceId) ||
      rawFromFaceId <= 0 ||
      !Number.isFinite(rawToFaceId) ||
      rawToFaceId <= 0
    ) {
      const err = new Error('common.PARAM_ERROR');
      err.statusCode = 400;
      throw err;
    }

    const fileHashes = (Array.isArray(rawFileHashes) ? rawFileHashes : [rawFileHashes])
      .map(v => (v == null ? '' : String(v).trim()))
      .filter(Boolean);
    const uniqueFileHashes = [...new Set(fileHashes)];
    if (uniqueFileHashes.length === 0) {
      const err = new Error('common.PARAM_ERROR');
      err.statusCode = 400;
      throw err;
    }

    const fromFaceId = await this.getRootFaceId(rawFromFaceId);
    const toFaceId = await this.getRootFaceId(rawToFaceId);
    if (!fromFaceId || !toFaceId) {
      const err = new Error('common.NOT_FOUND');
      err.statusCode = 404;
      throw err;
    }
    if (fromFaceId === toFaceId) return true;

    await this.knex.transaction(async trx => {
      const fromRow = await trx('photo_faces')
        .where({ face_id: fromFaceId })
        .first('face_id')
        .catch(() => null);
      const toRow = await trx('photo_faces')
        .where({ face_id: toFaceId })
        .first('face_id')
        .catch(() => null);
      if (!fromRow || !toRow) {
        const err = new Error('common.NOT_FOUND');
        err.statusCode = 404;
        throw err;
      }

      const currentCover = await trx('photo_face2filehash')
        .where({ face_id: fromFaceId, is_cover: 1 })
        .first('file_hash')
        .catch(() => null);
      const targetCover = await trx('photo_face2filehash')
        .where({ face_id: toFaceId, is_cover: 1 })
        .first('file_hash')
        .catch(() => null);

      const existedRows = await trx('photo_face2filehash as f2')
        .join('photo_index as p', 'p.file_hash', 'f2.file_hash')
        .where('f2.face_id', fromFaceId)
        .whereIn('f2.file_hash', uniqueFileHashes)
        .andWhere('p.is_file', 1)
        .andWhere('p.in_trash', 0)
        .select('f2.file_hash')
        .catch(() => []);
      const movableHashes = [...new Set((existedRows || []).map(row => (row && row.file_hash ? String(row.file_hash) : '')).filter(Boolean))];
      if (movableHashes.length === 0) {
        const err = new Error('common.NOT_FOUND');
        err.statusCode = 404;
        throw err;
      }

      const placeholders = movableHashes.map(() => '?').join(', ');
      await trx
        .raw(
          `INSERT OR IGNORE INTO photo_face2filehash (file_hash, face_id, box_left, box_top, box_width, box_height, is_cover, create_time)
           SELECT file_hash, ?, box_left, box_top, box_width, box_height, 0 as is_cover, create_time
           FROM photo_face2filehash
           WHERE face_id = ? AND file_hash IN (${placeholders})`,
          [toFaceId, fromFaceId, ...movableHashes]
        )
        .catch(() => {});

      await trx('photo_face2filehash')
        .where({ face_id: fromFaceId })
        .whereIn('file_hash', movableHashes)
        .del()
        .catch(() => 0);

      await this.refreshFaceAggregateInTrx(trx, fromFaceId, {
        keepCoverHash:
            currentCover && !movableHashes.includes(String(currentCover.file_hash || ''))
                ? currentCover.file_hash
                : '',
      });
      await this.refreshFaceAggregateInTrx(trx, toFaceId, {
        keepCoverHash:
            targetCover && targetCover.file_hash ? targetCover.file_hash : movableHashes.first,
      });
    });

    return true;
  }

  async getFaceImageBuffer(params = {}) {
    const rawFaceId = Number(params.faceId);
    if (!Number.isFinite(rawFaceId) || rawFaceId <= 0) {
      const err = new Error('common.PARAM_ERROR');
      err.statusCode = 400;
      throw err;
    }
    const faceId = await this.getRootFaceId(rawFaceId);

    const fileHash = params.fileHash ? String(params.fileHash) : '';
    const size = Number(params.size);
    const qualityNum = Number(params.quality);
    const quality = Number.isFinite(qualityNum) && qualityNum >= 1 && qualityNum <= 100 ? qualityNum : 85;
    const validPaths = Array.isArray(params.validPaths) ? params.validPaths.filter(Boolean) : [];

    let query = this.knex('photo_face2filehash')
      .join('photo_index', 'photo_index.file_hash', 'photo_face2filehash.file_hash')
      .select(
        'photo_face2filehash.file_hash as file_hash',
        'photo_face2filehash.box_left as box_left',
        'photo_face2filehash.box_top as box_top',
        'photo_face2filehash.box_width as box_width',
        'photo_face2filehash.box_height as box_height',
        'photo_index.path as path',
        'photo_index.filename as filename',
        'photo_index.type as type'
      )
      .where('photo_face2filehash.face_id', faceId)
      .andWhere('photo_index.is_file', 1)
      .andWhere('photo_index.in_trash', 0);

    if (validPaths.length > 0) {
      photoPathQueryUtil.applyPathPrefixFilter(query, 'photo_index.path', validPaths);
    }

    if (fileHash) {
      query = query.andWhere('photo_face2filehash.file_hash', fileHash);
    } else {
      query = query
        .orderBy('photo_face2filehash.is_cover', 'desc')
        // ⭐ 2026-10-13：优先用「本人脸框面积大」的 photo（主体清晰、排除小框误检），再按时间倒序
        .orderByRaw('(photo_face2filehash.box_width * photo_face2filehash.box_height) DESC')
        .orderByRaw(`CASE WHEN LOWER(COALESCE(photo_index.filename, '')) LIKE '%.jpg' OR LOWER(COALESCE(photo_index.filename, '')) LIKE '%.jpeg' THEN 1 ELSE 0 END DESC`)
        .orderBy('photo_index.original_time', 'desc')
        .orderBy('photo_index.id', 'desc');
    }

    const row = await query.first().catch(() => null);
    if (!row) {
      const err = new Error('common.NOT_FOUND');
      err.statusCode = 404;
      throw err;
    }

    const fullPath = path.join(String(row.path || ''), String(row.filename || ''));
    if (!fullPath || !fs.existsSync(fullPath)) {
      const err = new Error('common.NOT_FOUND');
      err.statusCode = 404;
      throw err;
    }

    const type = row && row.type ? Number(row.type) : 0;
    let sourcePath = fullPath;
    if (type === 2) {
      try {
        sourcePath = await fileService.getTinyImgByPath(fullPath, undefined, { deferImages: false });
      } catch (_) {
        const err = new Error('common.NOT_FOUND');
        err.statusCode = 404;
        throw err;
      }
    }
    if (!sourcePath || !fs.existsSync(sourcePath)) {
      const err = new Error('common.NOT_FOUND');
      err.statusCode = 404;
      throw err;
    }

    const converted = await sharpUtils.transSpcielFormat(sourcePath);
    let img = createSharpFromConverted(converted).rotate();

    const meta = await img.metadata();
    const w = Number(meta && meta.width ? meta.width : 0);
    const h = Number(meta && meta.height ? meta.height : 0);
    if (!w || !h) {
      const err = new Error('common.ERROR');
      err.statusCode = 500;
      throw err;
    }

    const leftRaw = Number(row.box_left);
    const topRaw = Number(row.box_top);
    const widthRaw = Number(row.box_width);
    const heightRaw = Number(row.box_height);

    const left = Number.isFinite(leftRaw) ? leftRaw : 0;
    const top = Number.isFinite(topRaw) ? topRaw : 0;
    const width = Number.isFinite(widthRaw) ? widthRaw : 0;
    const height = Number.isFinite(heightRaw) ? heightRaw : 0;

    const extend = clampNumber(Number(process.env.FACE_IMAGE_EXTEND ?? 0.2), 0, 1);
    const topExtra = clampNumber(Number(process.env.FACE_IMAGE_TOP_EXTRA ?? 0.12), 0, 1);

    const boxW = Math.max(2, Math.floor(width));
    const boxH = Math.max(2, Math.floor(height));
    const cx = left + boxW / 2;
    const cy = top + boxH / 2;
    const base = Math.max(boxW, boxH);

    let cropSize = Math.max(2, Math.round(base * (1 + extend * 2)));
    cropSize = Math.min(cropSize, Math.max(2, Math.min(w, h)));

    let cropLeft = Math.round(cx - cropSize / 2);
    let cropTop = Math.round(cy - cropSize / 2 - base * topExtra);
    cropLeft = Math.max(0, Math.min(w - cropSize, cropLeft));
    cropTop = Math.max(0, Math.min(h - cropSize, cropTop));

    const cropW = Math.max(2, Math.min(w - cropLeft, cropSize));
    const cropH = Math.max(2, Math.min(h - cropTop, cropSize));

    img = img.extract({ left: cropLeft, top: cropTop, width: cropW, height: cropH });
    if (Number.isFinite(size) && size > 0) {
      img = img.resize(size, size, { fit: 'inside' });
    }

    const buffer = await img.jpeg({ quality }).toBuffer();
    return { buffer, mime: 'image/jpeg' };
  }

  async listFacePhotoIndexRows(params = {}) {
    const rawFaceIds = params.faceIds ?? params.face_ids ?? params.faceId ?? params.face_id;
    const validPaths = Array.isArray(params.validPaths) ? params.validPaths : [];
    const faceIdsInput = Array.isArray(rawFaceIds) ? rawFaceIds : rawFaceIds === null || rawFaceIds === undefined ? [] : [rawFaceIds];
    const faceIds = [];
    for (const v of faceIdsInput) {
      if (v === null || v === undefined || v === '') continue;
      if (typeof v === 'string' && v.includes(',')) {
        for (const part of v.split(',')) {
          const id = Number(part);
          if (Number.isFinite(id) && id > 0) faceIds.push(id);
        }
        continue;
      }
      const id = Number(v);
      if (Number.isFinite(id) && id > 0) faceIds.push(id);
    }
    if (faceIds.length === 0) {
      const err = new Error('common.PARAM_ERROR');
      err.statusCode = 400;
      throw err;
    }

    const rootIds = [];
    for (const id of faceIds) {
      const root = await this.getRootFaceId(id);
      if (Number.isFinite(root) && root > 0) rootIds.push(root);
    }
    const uniqueRootIds = [...new Set(rootIds)];
    if (uniqueRootIds.length === 0) {
      const err = new Error('common.NOT_FOUND');
      err.statusCode = 404;
      throw err;
    }

    const query = this.knex('photo_face2filehash as f2')
      .join('photo_index as p', 'p.file_hash', 'f2.file_hash')
      .whereIn('f2.face_id', uniqueRootIds)
      .andWhere('p.is_file', 1)
      .andWhere('p.in_trash', 0)
      .orderBy('p.original_time', 'desc')
      .orderBy('p.id', 'desc');

    if (validPaths.length > 0) {
      photoPathQueryUtil.applyPathPrefixFilter(query, 'p.path', validPaths);
    }

    const rows = await query.select('p.id as photo_id', 'p.path as path', 'p.filename as filename', 'p.file_hash as file_hash', 'p.original_time as original_time').catch(() => []);

    return Array.isArray(rows) ? rows : [];
  }
}

module.exports = FaceService;
