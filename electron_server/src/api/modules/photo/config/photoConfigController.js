const ResponseUtil = require('../../../apiUtils/responseUtil');
const tableConfig = require('../../../../db/table/tableConfig');

function parseEnable(body) {
  const v = body && body.enable;
  return v === 1 || v === '1' || v === true ? 1 : 0;
}

async function getEnableByKey(key) {
  const raw = await tableConfig.getConfigByKey(key);
  return raw === '1' ? 1 : 0;
}

// 读取开关值，未设置时默认为 1（开启）
async function getEnableByKeyDefault1(key) {
  const raw = await tableConfig.getConfigByKey(key);
  if (raw === null || raw === undefined) return 1;
  return raw === '0' ? 0 : 1;
}

function parseMinShowCount(body) {
  const raw = body && (body.min_show_count ?? body.minShowCount ?? body.value);
  const parsed = Math.floor(Number(raw));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

async function getMinShowCount() {
  // ⭐ 2026-10-17 与 faceService.listFaces 保持同一默认值（3），
  // 否则「设置页显示的 0」和「列表实际用的 3」会对不上，用户会以为设置没生效。
  const DEFAULT_MIN_SHOW_COUNT = 3;
  const raw = await tableConfig.getConfigByKey('ai_face_min_show_count');
  if (raw === null || raw === undefined || raw === '') return DEFAULT_MIN_SHOW_COUNT;
  const parsed = Math.floor(Number(raw));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function parseCount(v) {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function buildProgress(done, total) {
  const safeTotal = total > 0 ? total : 0;
  const safeDone = done > 0 ? Math.min(done, safeTotal) : 0;
  const percent = safeTotal > 0 ? Math.floor((safeDone * 100) / safeTotal) : 0;
  return { done: safeDone, total: safeTotal, percent };
}

function parseInt0(v) {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

const previewSizeConfigKey = 'photo_preview_size';
const allowedPreviewSizes = new Set(['origin', '8000', '7000', '6000', '5000', '4000', '3000', '2000', '1000']);

function normalizePreviewSizeStored(raw) {
  const s = raw == null ? '' : String(raw).trim();
  if (!s) return 'origin';
  if (s === 'origin') return 'origin';
  const n = Math.floor(Number(s));
  if (!Number.isFinite(n) || n <= 0) return 'origin';
  const normalized = String(n);
  return allowedPreviewSizes.has(normalized) ? normalized : 'origin';
}

function normalizePreviewSizeInput(body) {
  const raw = body && (body.size ?? body.previewSize ?? body.value);
  const s = raw == null ? '' : String(raw).trim();
  if (!s) return 'origin';
  const lower = s.toLowerCase();
  if (lower === 'origin' || lower === 'original') return 'origin';
  const n = Math.floor(Number(lower));
  if (!Number.isFinite(n) || n <= 0) return null;
  const normalized = String(n);
  return allowedPreviewSizes.has(normalized) ? normalized : null;
}

async function getAiProgress(knexPhoto) {
  if (!knexPhoto) {
    return {
      total: 0,
      face: buildProgress(0, 0),
      place: buildProgress(0, 0),
      activity: buildProgress(0, 0),
      ocr: buildProgress(0, 0),
    };
  }

  const row = await knexPhoto('photo_index')
    .where('is_file', 1)
    .andWhere('in_trash', 0)
    .select(
      knexPhoto.raw('COUNT(1) as total'),
      knexPhoto.raw('SUM(CASE WHEN gen_faces = 1 THEN 1 ELSE 0 END) as face_done'),
      knexPhoto.raw('SUM(CASE WHEN gen_place = 1 THEN 1 ELSE 0 END) as place_done'),
      knexPhoto.raw('SUM(CASE WHEN gen_ocr = 1 THEN 1 ELSE 0 END) as ocr_done')
    )
    .first();

  const total = parseCount(row && row.total);
  const faceDone = parseCount(row && row.face_done);
  const placeDone = parseCount(row && row.place_done);
  const ocrDone = parseCount(row && row.ocr_done);

  // ⭐ 活动维度进度（2026-10-15）。
  // ⚠️ 必须**单独查 + 降级**：`gen_activity` 是新增列，若某台机器上列迁移还没跑到
  //    （或迁移失败），把它并进上面那条 SQL 会让**整个 AI 进度接口**报错。
  //    这里失败就当 0，绝不影响既有四项。
  let activityDone = 0;
  try {
    const arow = await knexPhoto('photo_index')
      .where('is_file', 1)
      .andWhere('in_trash', 0)
      .select(knexPhoto.raw('SUM(CASE WHEN gen_activity = 1 THEN 1 ELSE 0 END) as activity_done'))
      .first();
    activityDone = parseCount(arow && arow.activity_done);
  } catch (_) {
    activityDone = 0;
  }

  return {
    total,
    face: buildProgress(faceDone, total),
    place: buildProgress(placeDone, total),
    activity: buildProgress(activityDone, total),
    ocr: buildProgress(ocrDone, total),
  };
}

async function getSimilarProgress(knexPhoto) {
  if (!knexPhoto) {
    return {
      scan: { running: false, ...buildProgress(0, 0) },
      compare: { running: false, ...buildProgress(0, 0) },
    };
  }

  const scanRow = await knexPhoto('photo_index')
    .where({ is_file: 1, in_trash: 0, type: 1 })
    .select(knexPhoto.raw('COUNT(1) as total'), knexPhoto.raw('SUM(CASE WHEN gen_phash >= 1 THEN 1 ELSE 0 END) as done'))
    .first()
    .catch(() => null);

  const scanTotal = parseInt0(scanRow && scanRow.total);
  const scanDone = parseInt0(scanRow && scanRow.done);

  const [scanRunningRaw, compareRunningRaw, compareTotalRaw, compareDoneRaw] = await Promise.all([
    tableConfig.getConfigByKey('ai_similar_scan_running').catch(() => '0'),
    tableConfig.getConfigByKey('ai_similar_compare_running').catch(() => '0'),
    tableConfig.getConfigByKey('ai_similar_compare_total').catch(() => '0'),
    tableConfig.getConfigByKey('ai_similar_compare_done').catch(() => '0'),
  ]);

  const compareTotal = parseInt0(compareTotalRaw);
  const compareDone = parseInt0(compareDoneRaw);

  return {
    scan: {
      running: String(scanRunningRaw) === '1',
      ...buildProgress(scanDone, scanTotal),
    },
    compare: {
      running: String(compareRunningRaw) === '1',
      ...buildProgress(compareDone, compareTotal),
    },
  };
}

class PhotoConfigController {
  async getAiConfig(req, res) {
    try {
      const [ocrEnable, petEnable, faceEnable, placeEnable, similarEnable, faceMinShowCount, aiProgress, similarProgress, gpuPrefer, activityEnable] = await Promise.all([
        getEnableByKey('ai_ocr_enable'),
        getEnableByKey('ai_pet_enable'),
        getEnableByKey('ai_face_enable'),
        getEnableByKey('ai_place_enable'),
        getEnableByKey('ai_similar_enable'),
        getMinShowCount(),
        getAiProgress(req && req.dbPhoto),
        getSimilarProgress(req && req.dbPhoto),
        getEnableByKeyDefault1('ai_gpu_prefer'),
        getEnableByKeyDefault1('ai_activity_enable'),
      ]);
      return ResponseUtil.success(
        req,
        res,
        {
          ocrEnable,
          petEnable,
          faceEnable,
          placeEnable,
          similarEnable,
          faceMinShowCount,
          aiProgress,
          similarProgress,
          gpuPrefer,
          activityEnable,
        },
        'common.SUCCESS',
        200
      );
    } catch (err) {
      return ResponseUtil.error(req, res, 'common.ERROR', 500);
    }
  }

  async setAiOcrEnable(req, res) {
    try {
      const enable = parseEnable(req && req.body);
      const ok = await tableConfig.setConfigByKey('ai_ocr_enable', String(enable));
      if (ok && process.send) {
        try {
          process.send({ type: 'toggleAiOcr', data: { enable } });
        } catch (_) {}
      }
      return ResponseUtil.success(req, res, { enable }, 'common.SUCCESS', 200);
    } catch (err) {
      return ResponseUtil.error(req, res, 'common.ERROR', 500);
    }
  }

  async setAiPetEnable(req, res) {
    try {
      const enable = parseEnable(req && req.body);
      const ok = await tableConfig.setConfigByKey('ai_pet_enable', String(enable));
      if (ok && process.send) {
        try {
          process.send({ type: 'toggleAiPet', data: { enable } });
        } catch (_) {}
      }
      return ResponseUtil.success(req, res, { enable }, 'common.SUCCESS', 200);
    } catch (err) {
      return ResponseUtil.error(req, res, 'common.ERROR', 500);
    }
  }

  async setAiFaceEnable(req, res) {
    try {
      const enable = parseEnable(req && req.body);
      const ok = await tableConfig.setConfigByKey('ai_face_enable', String(enable));
      if (ok && process.send) {
        try {
          process.send({ type: 'toggleAiFace', data: { enable } });
        } catch (_) {}
      }
      return ResponseUtil.success(req, res, { enable }, 'common.SUCCESS', 200);
    } catch (err) {
      return ResponseUtil.error(req, res, 'common.ERROR', 500);
    }
  }

  async setAiPlaceEnable(req, res) {
    try {
      const enable = parseEnable(req && req.body);
      const ok = await tableConfig.setConfigByKey('ai_place_enable', String(enable));
      if (ok && process.send) {
        try {
          process.send({ type: 'toggleAiPlace', data: { enable } });
        } catch (_) {}
      }
      return ResponseUtil.success(req, res, { enable }, 'common.SUCCESS', 200);
    } catch (err) {
      return ResponseUtil.error(req, res, 'common.ERROR', 500);
    }
  }

  /**
   * ⭐ 2026-10-16 活动维度开关（ai_activity_enable，未设置 = 开）。
   * ⚠️ 刻意**不发** toggleAiPlace 消息：活动与场景共用 placesWorker，
   *    写 config 即可（worker 每轮会自己读），避免把场景阶段一起停掉。
   */
  async setAiActivityEnable(req, res) {
    try {
      const enable = parseEnable(req && req.body);
      const ok = await tableConfig.setConfigByKey('ai_activity_enable', String(enable));
      return ResponseUtil.success(req, res, { enable: ok ? enable : 0 }, 'common.SUCCESS', 200);
    } catch (err) {
      return ResponseUtil.error(req, res, 'common.ERROR', 500);
    }
  }

  async setAiSimilarEnable(req, res) {
    try {
      const enable = parseEnable(req && req.body);
      const ok = await tableConfig.setConfigByKey('ai_similar_enable', String(enable));
      if (ok && process.send) {
        try {
          process.send({ type: 'toggleAiSimilar', data: { enable } });
        } catch (_) {}
      }
      return ResponseUtil.success(req, res, { enable }, 'common.SUCCESS', 200);
    } catch (err) {
      return ResponseUtil.error(req, res, 'common.ERROR', 500);
    }
  }

  async setAiFaceMinShowCount(req, res) {
    try {
      const minShowCount = parseMinShowCount(req && req.body);
      const ok = await tableConfig.setConfigByKey('ai_face_min_show_count', String(minShowCount));
      if (!ok) return ResponseUtil.error(req, res, 'common.ERROR', 500);
      return ResponseUtil.success(req, res, { faceMinShowCount: minShowCount }, 'common.SUCCESS', 200);
    } catch (err) {
      return ResponseUtil.error(req, res, 'common.ERROR', 500);
    }
  }

  async getPreviewConfig(req, res) {
    try {
      const uid = req && req.user && req.user.id ? Number(req.user.id) : 0;
      if (!uid) return ResponseUtil.error(req, res, 'common.ERROR', 401);
      const raw = await tableConfig.getConfigByKey(previewSizeConfigKey, uid).catch(() => null);
      const previewSize = normalizePreviewSizeStored(raw);
      return ResponseUtil.success(req, res, { previewSize }, 'common.SUCCESS', 200);
    } catch (err) {
      return ResponseUtil.error(req, res, 'common.ERROR', 500);
    }
  }

  async setPreviewSize(req, res) {
    try {
      const uid = req && req.user && req.user.id ? Number(req.user.id) : 0;
      if (!uid) return ResponseUtil.error(req, res, 'common.ERROR', 401);

      const normalized = normalizePreviewSizeInput(req && req.body);
      if (normalized == null) return ResponseUtil.error(req, res, 'common.ERROR', 400);

      if (normalized === 'origin') {
        await tableConfig.deleteConfigByKey(previewSizeConfigKey, uid).catch(() => {});
        return ResponseUtil.success(req, res, { previewSize: 'origin' }, 'common.SUCCESS', 200);
      }

      const ok = await tableConfig.setConfigByKey(previewSizeConfigKey, normalized, uid);
      if (!ok) return ResponseUtil.error(req, res, 'common.ERROR', 500);
      return ResponseUtil.success(req, res, { previewSize: normalized }, 'common.SUCCESS', 200);
    } catch (err) {
      return ResponseUtil.error(req, res, 'common.ERROR', 500);
    }
  }

  async setAiGpuPrefer(req, res) {
    try {
      const enable = parseEnable(req && req.body);
      const ok = await tableConfig.setConfigByKey('ai_gpu_prefer', String(enable));
      if (ok && process.send) {
        try {
          process.send({ type: 'toggleAiGpu', data: { enable } });
        } catch (_) {}
      }
      return ResponseUtil.success(req, res, { gpuPrefer: enable }, 'common.SUCCESS', 200);
    } catch (err) {
      return ResponseUtil.error(req, res, 'common.ERROR', 500);
    }
  }
}

module.exports = new PhotoConfigController();
