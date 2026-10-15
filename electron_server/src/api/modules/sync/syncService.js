const tableSyncTask = require('../../../db/table/tableSyncTask');
const tableSyncRecord = require('../../../db/table/tableSyncRecord');
const syncUtil = require('./syncUtil');

function safeJsonParse(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (_) {
    return null;
  }
}

function normalizeString(v) {
  if (v === undefined || v === null) return '';
  return String(v).trim();
}

/// 设备归属前缀。
///
/// 服务端存库的 device_id 一律是 `m:<客户端机器标识>`；
/// 旧版本客户端写进去的是 NAS serverId / 随机 UUID / 空串（没有任何前缀），
/// 靠「有没有 m: 前缀」就能把「已绑定主机的任务」与「旧版未绑定任务」分开。
const DEVICE_KEY_PREFIX = 'm:';

function deviceKeyOf(deviceId) {
  const raw = normalizeString(deviceId);
  return raw ? `${DEVICE_KEY_PREFIX}${raw}` : '';
}

/// 是否按 v2（设备隔离）语义通信。
/// 旧客户端不会传 device_bound，据此明确区分，避免「upsert 带 device_id 的旧客户端」被误判。
function isDeviceBound(reqOrBody) {
  const b = reqOrBody && (reqOrBody.device_bound ?? reqOrBody.body?.device_bound);
  return b === true || b === 'true' || b === 1 || b === '1';
}

class SyncService {
  constructor(knexMain) {
    this.knexMain = knexMain;
    this.tableName = 'sync_task';
    this.recordTableName = 'sync_record';
  }

  _mapRow(row) {
    if (!row) return row;
    const filter = safeJsonParse(row.filter_config);
    const syncConfig = safeJsonParse(row.sync_config);
    let progress = null;
    const rawProgress = safeJsonParse(row.progress);
    if (rawProgress && typeof rawProgress === 'object') progress = rawProgress;
    return {
      ...row,
      filter_config: syncUtil.normalizeFilterConfig(filter),
      sync_config: syncUtil.normalizeSyncConfig(syncConfig),
      progress,
    };
  }

  /**
   * 任务可见范围（用户 2026-10-12 定的四条规则）：
   *   - v2 客户端：只有 (uid, m:<device_id>) 自己的任务；
   *   - 旧客户端（无 device_bound）：只能看到「未绑定主机」的旧任务（过渡期兼容），
   *     已被某台机器认领走的任务对它不可见。
   */
  _scopedQuery(uid, deviceId, deviceBound) {
    const uidNum = Number(uid) || 0;
    let q = this.knexMain(this.tableName).where({ uid: uidNum });
    if (deviceBound) {
      q = q.where({ device_id: deviceKeyOf(deviceId) });
    } else {
      q = q.andWhere(builder => {
        builder.where('device_id', '').orWhereNot('device_id', 'like', `${DEVICE_KEY_PREFIX}%`);
      });
    }
    return q;
  }

  /** 旧版「未绑定主机」任务数量（v2 客户端列表页据此提示认领）。 */
  async _countLegacyPending(uid) {
    const rows = await this.knexMain(this.tableName)
      .where({ uid: Number(uid) || 0 })
      .andWhere(builder => {
        builder.where('device_id', '').orWhereNot('device_id', 'like', `${DEVICE_KEY_PREFIX}%`);
      })
      .count({ c: '*' });
    return Number((rows && rows[0] && (rows[0].c ?? rows[0]['count(*)'])) || 0) || 0;
  }

  async list({ uid, page, pageSize, status, mode, keyword, sortBy, sortOrder, deviceId, deviceBound } = {}) {
    const uidNum = Number(uid) || 0;
    const pageNum = Number(page || 1) || 1;
    const hasPageSize = pageSize !== undefined && pageSize !== null;
    const limit = hasPageSize ? Number(pageSize || 20) || 20 : null;
    const offset = limit === null ? 0 : (pageNum - 1) * limit;

    const sortCol = ['id', 'create_time', 'update_time', 'last_sync_time', 'name', 'status'].includes(String(sortBy || 'id')) ? String(sortBy || 'id') : 'id';
    const sortDir = String(sortOrder || 'desc').toLowerCase() === 'asc' ? 'asc' : 'desc';

    let q = this._scopedQuery(uidNum, deviceId, deviceBound);
    let countQ = this._scopedQuery(uidNum, deviceId, deviceBound);

    if (status !== undefined && status !== null && String(status).trim()) {
      q = q.where({ status: String(status).trim() });
      countQ = countQ.where({ status: String(status).trim() });
    }
    if (mode !== undefined && mode !== null && String(mode).trim()) {
      q = q.where({ mode: String(mode).trim() });
      countQ = countQ.where({ mode: String(mode).trim() });
    }

    const kw = normalizeString(keyword);
    if (kw) {
      const like = `%${kw}%`;
      q = q.andWhere(builder => {
        builder.orWhere('name', 'like', like).orWhere('local_dir', 'like', like).orWhere('remote_dir', 'like', like);
      });
      countQ = countQ.andWhere(builder => {
        builder.orWhere('name', 'like', like).orWhere('local_dir', 'like', like).orWhere('remote_dir', 'like', like);
      });
    }

    const countRows = await countQ;
    const total = Number((countRows && countRows[0] && (countRows[0].c ?? countRows[0]['count(*)'])) || 0) || 0;

    const ordered = q.orderBy(sortCol, sortDir);
    const rows = limit === null ? await ordered : await ordered.limit(limit).offset(offset);

    // 仅 v2 客户端关心「还有没有旧版未认领任务」；旧客户端看到的就是未绑定桶本身，没有意义。
    const legacyPending = deviceBound ? await this._countLegacyPending(uidNum) : 0;

    return {
      page: limit === null ? 1 : pageNum,
      pageSize: limit === null ? total : limit,
      total,
      legacy_pending_count: legacyPending,
      items: rows.map(r => this._mapRow(r)),
    };
  }

  async get({ id, uid, deviceId, deviceBound } = {}) {
    const idNum = Number(id);
    if (!Number.isFinite(idNum) || idNum <= 0) throw syncUtil.buildHttpError('validation.ID_INVALID', 400);
    const row = await this._scopedQuery(uid, deviceId, deviceBound).where({ id: idNum }).first();
    if (!row) throw syncUtil.buildHttpError('common.NOT_FOUND', 404);
    return this._mapRow(row);
  }

  async upsert({ id, uid, name, mode, localDir, remoteDir, filterConfig, syncConfig, deviceId, deviceName, deviceBound } = {}) {
    const uidNum = Number(uid) || 0;
    if (!uidNum) throw syncUtil.buildHttpError('common.UNAUTHORIZED', 401);

    const idNum = id === undefined || id === null ? null : Number(id);
    const hasId = Number.isFinite(idNum) && idNum > 0;

    const taskName = normalizeString(name);
    const m = normalizeString(mode) || tableSyncTask.MODE_BIDIRECTIONAL;
    const remote = normalizeString(remoteDir);
    const local = normalizeString(localDir);

    if (!taskName || taskName.length > 32) throw syncUtil.buildHttpError('sync.TASK_NAME_INVALID', 400);
    if (!tableSyncTask.MODES.includes(m)) throw syncUtil.buildHttpError('sync.MODE_INVALID', 400);
    if (!remote) throw syncUtil.buildHttpError('sync.REMOTE_DIR_REQUIRED', 400);
    if (!local) throw syncUtil.buildHttpError('sync.LOCAL_DIR_REQUIRED', 400);

    // v2 客户端必须带设备标识，否则任务会掉进「未绑定桶」，设备隔离就漏了。
    const boundKey = deviceBound ? deviceKeyOf(deviceId) : '';
    if (deviceBound && !boundKey) throw syncUtil.buildHttpError('sync.DEVICE_ID_REQUIRED', 400);

    const remoteAbs = await syncUtil.resolveRemoteDir(remote, { requireExists: hasId ? false : true });

    const filterText = JSON.stringify(syncUtil.normalizeFilterConfig(filterConfig));
    const syncText = JSON.stringify(syncUtil.normalizeSyncConfig(syncConfig));
    const devName = normalizeString(deviceName);
    // 旧客户端兼容：存它上报的原始值（NAS serverId / 随机 UUID），后续可被认领收编。
    const legacyDevId = deviceBound ? boundKey : normalizeString(deviceId);

    if (hasId) {
      const existed = await this._scopedQuery(uidNum, deviceId, deviceBound).where({ id: idNum }).first();
      if (!existed) throw syncUtil.buildHttpError('common.NOT_FOUND', 404);

      await this.knexMain(this.tableName)
        .where({ id: idNum })
        .update({
          name: taskName,
          mode: m,
          local_dir: local,
          remote_dir: remoteAbs,
          filter_config: filterText,
          sync_config: syncText,
          // 设备归属不可改写：想换机器就删了重建，避免「任务被搬走」造成的基线错位。
          device_name: devName || existed.device_name,
          update_time: new Date(),
        });
      return { id: idNum };
    }

    const [newId] = await this.knexMain(this.tableName).insert({
      uid: uidNum,
      name: taskName,
      device_id: legacyDevId,
      device_name: devName,
      mode: m,
      local_dir: local,
      remote_dir: remoteAbs,
      filter_config: filterText,
      sync_config: syncText,
      status: tableSyncTask.STATUS_IDLE,
      progress: '',
      last_sync_time: null,
      last_error: null,
      create_time: new Date(),
      update_time: new Date(),
    });
    return { id: newId };
  }

  async remove({ id, uid, deviceId, deviceBound } = {}) {
    const idNum = Number(id);
    if (!Number.isFinite(idNum) || idNum <= 0) throw syncUtil.buildHttpError('validation.ID_INVALID', 400);
    const existed = await this._scopedQuery(uid, deviceId, deviceBound).where({ id: idNum }).first();
    if (!existed) throw syncUtil.buildHttpError('common.NOT_FOUND', 404);
    await this.knexMain(this.tableName).where({ id: idNum }).del();
    await this.knexMain(this.recordTableName).where({ task_id: idNum }).del();
    return { ok: true };
  }

  async updateStatus({ id, uid, status, progress, lastError, lastSyncTime, deviceId, deviceBound } = {}) {
    const idNum = Number(id);
    if (!Number.isFinite(idNum) || idNum <= 0) throw syncUtil.buildHttpError('validation.ID_INVALID', 400);

    // uid 必填。漏传会让 WHERE 退化成只按 id 命中，等于任何登录用户都能
    // 改写别人的同步任务状态。
    const uidNum = Number(uid);
    if (!Number.isFinite(uidNum) || uidNum <= 0) throw syncUtil.buildHttpError('common.UNAUTHORIZED', 401);

    const data = { update_time: new Date() };
    if (status !== undefined && status !== null && String(status).trim()) {
      const st = String(status).trim();
      if (!tableSyncTask.STATUSES.includes(st)) throw syncUtil.buildHttpError('sync.STATUS_INVALID', 400);
      data.status = st;
    }
    if (progress !== undefined) {
      data.progress = progress && typeof progress === 'object' ? JSON.stringify(progress) : normalizeString(progress);
    }
    if (lastError !== undefined) data.last_error = lastError === null ? null : normalizeString(lastError);
    if (lastSyncTime !== undefined && lastSyncTime !== null) data.last_sync_time = new Date(Number(lastSyncTime) || Date.now());

    const affected = await this._scopedQuery(uidNum, deviceId, deviceBound).where({ id: idNum }).update(data);
    if (!affected) throw syncUtil.buildHttpError('common.NOT_FOUND', 404);
    return { ok: true };
  }

  async addRecord({ taskId, uid, startTime, endTime, status, uploadCount, downloadCount, deleteCount, skipCount, failCount, bytesTransferred, errorList, durationMs, deviceId, deviceBound }) {
    const taskIdNum = Number(taskId);
    if (!Number.isFinite(taskIdNum) || taskIdNum <= 0) throw syncUtil.buildHttpError('validation.ID_INVALID', 400);

    const taskRow = await this._scopedQuery(uid, deviceId, deviceBound).where({ id: taskIdNum }).first();
    if (!taskRow) throw syncUtil.buildHttpError('common.NOT_FOUND', 404);

    const start = Number(startTime) || Date.now();
    const end = Number(endTime) || Date.now();
    const st = String(status || '').trim();
    const recordStatus = [tableSyncRecord.STATUS_SUCCESS, tableSyncRecord.STATUS_FAILED, tableSyncRecord.STATUS_STOPPED].includes(st)
      ? st
      : tableSyncRecord.STATUS_SUCCESS;

    const errors = Array.isArray(errorList) ? errorList.slice(0, 200).map(e => String(e || '')) : [];
    const safeInt = v => {
      const n = Number(v);
      return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
    };

    const up = safeInt(uploadCount);
    const down = safeInt(downloadCount);
    const del = safeInt(deleteCount);
    const failed = safeInt(failCount);

    // 「空轮次」不落记录：整轮没有任何实际动作（没传、没删、没失败）时，
    // 每 N 分钟一条的「上传 0 / 下载 0 / 跳过 2688」只会把同步记录刷屏。
    // ⚠️ 任务状态与 last_sync_time 照常更新（下面那段不受影响），
    // 所以「上次同步时间」仍是每轮都刷新，只是记录列表里只留真动过的轮次。
    // 失败/被中止的轮次一律保留，方便排查。
    const isEmptyRun = up === 0 && down === 0 && del === 0 && failed === 0 && recordStatus === tableSyncRecord.STATUS_SUCCESS;

    let recordId = null;
    if (!isEmptyRun) {
      const inserted = await this.knexMain(this.recordTableName).insert({
        task_id: taskIdNum,
        start_time: new Date(start),
        end_time: new Date(end),
        status: recordStatus,
        upload_count: up,
        download_count: down,
        delete_count: del,
        skip_count: safeInt(skipCount),
        fail_count: failed,
        bytes_transferred: safeInt(bytesTransferred),
        error_list: JSON.stringify(errors),
        duration_ms: Math.max(0, Math.floor(end - start)),
      });
      recordId = Array.isArray(inserted) ? inserted[0] : inserted;
      await this._pruneRecords(taskIdNum);
    }

    await this.knexMain(this.tableName).where({ id: taskIdNum, uid: Number(uid) || 0 }).update({ last_sync_time: new Date(start), update_time: new Date() });

    return { id: recordId, skipped: isEmptyRun };
  }

  async _pruneRecords(taskIdNum) {
    const max = tableSyncRecord.MAX_ROWS_PER_TASK;
    const rows = await this.knexMain(this.recordTableName).where({ task_id: taskIdNum }).orderBy('id', 'desc').limit(1).offset(max - 1);
    if (!rows || rows.length === 0) return;
    const thresholdId = rows[0].id;
    await this.knexMain(this.recordTableName).where({ task_id: taskIdNum }).andWhere('id', '<=', thresholdId).del();
  }

  _mapRecordRow(row) {
    if (!row) return row;
    const errors = safeJsonParse(row.error_list);
    return { ...row, error_list: Array.isArray(errors) ? errors : [] };
  }

  async listRecords({ taskId, uid, page, pageSize, deviceId, deviceBound } = {}) {
    const taskIdNum = Number(taskId);
    if (!Number.isFinite(taskIdNum) || taskIdNum <= 0) throw syncUtil.buildHttpError('validation.ID_INVALID', 400);
    const taskRow = await this._scopedQuery(uid, deviceId, deviceBound).where({ id: taskIdNum }).first();
    if (!taskRow) throw syncUtil.buildHttpError('common.NOT_FOUND', 404);

    const pageNum = Number(page || 1) || 1;
    const limit = Math.min(100, Math.max(1, Number(pageSize || 20) || 20));
    const offset = (pageNum - 1) * limit;

    const countRows = await this.knexMain(this.recordTableName).where({ task_id: taskIdNum }).count({ c: '*' });
    const total = Number((countRows && countRows[0] && (countRows[0].c ?? countRows[0]['count(*)'])) || 0) || 0;

    const rows = await this.knexMain(this.recordTableName).where({ task_id: taskIdNum }).orderBy('id', 'desc').limit(limit).offset(offset);

    return {
      page: pageNum,
      pageSize: limit,
      total,
      max_kept_per_task: tableSyncRecord.MAX_ROWS_PER_TASK,
      items: rows.map(r => this._mapRecordRow(r)),
    };
  }

  /** 统计本机（v2）或未绑定桶（旧客户端）的任务概况，供客户端首屏展示 */
  async summary({ uid, deviceId, deviceBound } = {}) {
    const rows = await this._scopedQuery(uid, deviceId, deviceBound).select('status');
    const result = { total: rows.length, idle: 0, running: 0, paused: 0, error: 0 };
    for (const r of rows) {
      const st = String(r.status || '');
      if (Object.prototype.hasOwnProperty.call(result, st)) result[st] += 1;
    }
    return result;
  }

  /**
   * 把本账号下「旧版未绑定主机」的任务认领到本机。
   *
   * 只会动 device_id 为空或不带 `m:` 前缀的任务；已被其它机器认领的（带 m: 前缀）
   * 不受影响，因此重复调用是安全的（第二次 claimed = 0）。
   * @returns {Promise<{claimed: number}>}
   */
  async claimLegacy({ uid, deviceId, deviceName } = {}) {
    const uidNum = Number(uid) || 0;
    const key = deviceKeyOf(deviceId);
    if (!uidNum || !key) throw syncUtil.buildHttpError('common.UNAUTHORIZED', 401);

    const claimed = await this.knexMain(this.tableName)
      .where({ uid: uidNum })
      .andWhere(builder => {
        builder.where('device_id', '').orWhereNot('device_id', 'like', `${DEVICE_KEY_PREFIX}%`);
      })
      .update({
        device_id: key,
        device_name: normalizeString(deviceName) || undefined,
        update_time: new Date(),
      });
    return { claimed: Number(claimed) || 0 };
  }
}

module.exports = { SyncService, deviceKeyOf, DEVICE_KEY_PREFIX };
