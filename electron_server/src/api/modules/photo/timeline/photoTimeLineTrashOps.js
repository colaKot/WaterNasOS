const knexUtil = require('../../../../db/knexUtil');
const dbUtil = require('../../../../db/dbUtil');
const path = require('path');
const Logger = require('../../../../utils/logger');
const tableFileLog = require('../../../../db/table/tableFileLog');
const { hasPermission } = require('../../../../utils/permissionUtil');
const FileUtil = require('../../../../utils/fileUtil');
const userUtil = require('../../../../utils/userUtil');
const { applyPathPrefixFilter } = require('./photoPathQueryUtil');

function createTrashOps({ getKnex, getValidPaths, indexFields }) {
  async function batchTrash(ids, in_trash, user) {
    if (!ids || ids.length === 0) return;

    const knex = getKnex();
    let idsToUpdate = ids;

    if (in_trash && user && !userUtil.isAdmin(user)) {
      const mainKnex = knexUtil.getInstance(dbUtil.DB_PATHS.MAIN_DB);
      const rows = await knex('photo_index').whereIn('id', ids).select('id', 'path', 'filename');
      const allowedIds = [];
      for (const row of rows) {
        const fullPath = path.join(row.path, row.filename);
        if (FileUtil.isProtectedPath(fullPath)) continue;
        const canDelete = await hasPermission(mainKnex, user, 'delete', fullPath);
        if (canDelete) allowedIds.push(row.id);
      }
      if (ids.length > 0 && allowedIds.length === 0) {
        const err = new Error('auth.PERMISSION_DENIED');
        err.statusCode = 403;
        throw err;
      }
      idsToUpdate = allowedIds;
      if (idsToUpdate.length === 0) return;
    }

    const updateData = {
      in_trash: in_trash ? 1 : 0,
    };

    if (in_trash) {
      updateData.in_trash_time = new Date();
    }

    await knex('photo_index').whereIn('id', idsToUpdate).update(updateData);
  }

  async function getTrashPhotoList(params, user) {
    const validPaths = await getValidPaths(user);
    if (validPaths.length === 0) {
      return { list: [], total: 0 };
    }

    const knex = getKnex();
    const query = knex('photo_index').where('photo_index.is_file', 1).where('photo_index.in_trash', 1);

    applyPathPrefixFilter(query, 'photo_index.path', validPaths);

    if (params.search) {
      const search = String(params.search || '').trim();
      if (search) {
        query.where(builder => {
          builder.where('photo_index.path', 'like', `%${search}%`).orWhere('photo_index.filename', 'like', `%${search}%`);
        });
      }
    }

    if (params.fileType) {
      if (params.fileType === 'photo') {
        query.where('photo_index.type', 1);
      } else if (params.fileType === 'video') {
        query.where('photo_index.type', 2);
      } else if (params.fileType === 'livephoto') {
        query.where('photo_index.is_lvp', 1);
      }
    }

    const sortField = params.sortField || 'in_trash_time';
    const sortOrder = params.sortOrder === 'asc' ? 'asc' : 'desc';
    query.orderBy(`photo_index.${sortField}`, sortOrder);

    const page = params.page || 1;
    const pageSize = params.pageSize || 20;
    const offset = (page - 1) * pageSize;

    const totalQuery = query.clone();
    const total = await totalQuery.count('* as count');

    const selectFields = indexFields.map(f => `photo_index.${f}`);
    query.select([...selectFields, 'photo_index.in_trash_time']);
    query.limit(pageSize).offset(offset);

    const list = await query;
    const result = list.map(item => ({
      ...item,
      fullpath: path.join(item.path, item.filename),
    }));

    return {
      list: result,
      total: total[0].count,
    };
  }

  async function deleteFromTrash(ids, recycle = false, user, options = {}) {
    if (!ids || ids.length === 0) return;

    const knex = getKnex();
    const mainKnex = knexUtil.getInstance(dbUtil.DB_PATHS.MAIN_DB);
    const fileService = require('../../file/core/fileService');
    const { deleteLivePhotoFile = 0, deleteRawFile = 0 } = options;

    const filesToDelete = await knex('photo_index').whereIn('id', ids).where('in_trash', 1).select('id', 'path', 'filename', 'live_filename', 'raw_filename');

    if (user && !userUtil.isAdmin(user) && filesToDelete.length > 0) {
      for (const file of filesToDelete) {
        const fullPath = path.join(file.path, file.filename);
        if (FileUtil.isProtectedPath(fullPath)) {
          const err = new Error('auth.PERMISSION_DENIED');
          err.statusCode = 403;
          throw err;
        }
        const canDelete = await hasPermission(mainKnex, user, 'delete', fullPath);
        if (!canDelete) {
          const err = new Error('auth.PERMISSION_DENIED');
          err.statusCode = 403;
          throw err;
        }
      }
    }

    const pathsToDelete = [];
    for (const file of filesToDelete) {
      const fullPath = path.join(file.path, file.filename);

      if (FileUtil.isProtectedPath(fullPath)) {
        Logger.warn(`Skipping protected file: ${fullPath}`);
        continue;
      }

      const canDelete = await hasPermission(mainKnex, user, 'delete', fullPath);
      if (!canDelete) {
        Logger.warn(`Skipping file due to permission: ${fullPath}`);
        continue;
      }

      pathsToDelete.push(fullPath);

      if (deleteLivePhotoFile && file.live_filename) {
        const liveFullPath = path.join(file.path, file.live_filename);
        if (!FileUtil.isProtectedPath(liveFullPath) && (await hasPermission(mainKnex, user, 'delete', liveFullPath))) {
          pathsToDelete.push(liveFullPath);
        }
      }

      if (deleteRawFile && file.raw_filename) {
        const rawFullPath = path.join(file.path, file.raw_filename);
        if (!FileUtil.isProtectedPath(rawFullPath) && (await hasPermission(mainKnex, user, 'delete', rawFullPath))) {
          pathsToDelete.push(rawFullPath);
        }
      }
    }

    // 索引行只删除已通过权限校验的条目，避免无权用户顺手删掉他人目录的索引记录
    const allowedIndexIds = [];
    for (const file of filesToDelete) {
      const fullPath = path.join(file.path, file.filename);
      if (FileUtil.isProtectedPath(fullPath)) continue;
      if (pathsToDelete.includes(fullPath)) allowedIndexIds.push(file.id);
    }
    if (allowedIndexIds.length > 0) {
      await knex('photo_index').whereIn('id', allowedIndexIds).where('in_trash', 1).del();
    }

    if (pathsToDelete.length > 0) {
      await fileService.deleteEntries(pathsToDelete, recycle);

      const uid = user && user.id;
      await fileService.addFileLog(uid, tableFileLog.TYPE_DELETE, pathsToDelete, null, tableFileLog.STATE_SUCCESS, recycle ? 'RECYCLE' : 'DELETE');
    }
  }

  async function restoreFromTrash(ids, user) {
    if (!ids || ids.length === 0) return;

    const knex = getKnex();
    const query = knex('photo_index').whereIn('id', ids).where('in_trash', 1);

    // 路径级鉴权：只能恢复自己有权访问的目录下的条目，避免枚举 id 篡改他人数据
    if (user && !userUtil.isAdmin(user)) {
      const validPaths = await getValidPaths(user);
      if (validPaths.length === 0) return;
      applyPathPrefixFilter(query, 'path', validPaths);
    }

    await query.update({
      in_trash: 0,
      in_trash_time: null,
    });
  }

  async function restoreAllFromTrash(user) {
    const validPaths = await getValidPaths(user);
    if (validPaths.length === 0) return;

    const knex = getKnex();
    const query = knex('photo_index').where('is_file', 1).where('in_trash', 1);
    applyPathPrefixFilter(query, 'path', validPaths);

    await query.update({
      in_trash: 0,
      in_trash_time: null,
    });
  }

  async function emptyTrash(user, recycle = false, options = {}) {
    const validPaths = await getValidPaths(user);
    if (validPaths.length === 0) return;

    const knex = getKnex();
    const mainKnex = knexUtil.getInstance(dbUtil.DB_PATHS.MAIN_DB);
    const fileService = require('../../file/core/fileService');
    const { deleteLivePhotoFile = 0, deleteRawFile = 0 } = options;

    const query = knex('photo_index').where('is_file', 1).where('in_trash', 1);
    applyPathPrefixFilter(query, 'path', validPaths);

    const filesToDelete = await query.select('path', 'filename', 'live_filename', 'raw_filename');

    const pathsToDelete = [];
    for (const file of filesToDelete) {
      const fullPath = path.join(file.path, file.filename);

      if (FileUtil.isProtectedPath(fullPath)) {
        Logger.warn(`Skipping protected file: ${fullPath}`);
        continue;
      }

      const canDelete = await hasPermission(mainKnex, user, 'delete', fullPath);
      if (!canDelete) {
        Logger.warn(`Skipping file due to permission: ${fullPath}`);
        continue;
      }

      pathsToDelete.push(fullPath);

      if (deleteLivePhotoFile && file.live_filename) {
        const liveFullPath = path.join(file.path, file.live_filename);
        if (!FileUtil.isProtectedPath(liveFullPath) && (await hasPermission(mainKnex, user, 'delete', liveFullPath))) {
          pathsToDelete.push(liveFullPath);
        }
      }

      if (deleteRawFile && file.raw_filename) {
        const rawFullPath = path.join(file.path, file.raw_filename);
        if (!FileUtil.isProtectedPath(rawFullPath) && (await hasPermission(mainKnex, user, 'delete', rawFullPath))) {
          pathsToDelete.push(rawFullPath);
        }
      }
    }

    if (user && !userUtil.isAdmin(user) && filesToDelete.length > 0 && pathsToDelete.length === 0) {
      const err = new Error('auth.PERMISSION_DENIED');
      err.statusCode = 403;
      throw err;
    }

    await query.del();

    if (pathsToDelete.length > 0) {
      await fileService.deleteEntries(pathsToDelete, recycle);

      const uid = user && user.id;
      await fileService.addFileLog(uid, tableFileLog.TYPE_DELETE, pathsToDelete, null, tableFileLog.STATE_SUCCESS, recycle ? 'RECYCLE' : 'DELETE');
    }
  }

  /**
   * ⭐ 2026-10-16 P0-6 批量「预演」：只算代价（多少张 / 多少字节），**不写任何业务表**。
   * 与 batchTrash 同一套权限口径，但只读 —— 用户先看到「将移入回收站 128 张 · 1.2 GB」再决定。
   */
  async function previewTrash(ids, in_trash, user) {
    const idsArr = Array.isArray(ids) ? ids.filter(v => Number.isFinite(Number(v))).map(Number) : [];
    const empty = { count: 0, bytes: 0, blocked: 0 };
    if (idsArr.length === 0) return empty;

    const knex = getKnex();
    const rows = await knex('photo_index')
      .whereIn('id', idsArr)
      .select('id', 'path', 'filename', 'size', 'in_trash')
      .catch(() => []);

    let count = 0;
    let bytes = 0;
    let blocked = 0;
    const mainKnex = knexUtil.getInstance(dbUtil.DB_PATHS.MAIN_DB);
    for (const row of Array.isArray(rows) ? rows : []) {
      if (in_trash && Number(row.in_trash) === 1) continue; // 已在回收站里的不算
      const fullPath = path.join(String(row.path || ''), String(row.filename || ''));
      if (FileUtil.isProtectedPath(fullPath)) {
        blocked += 1;
        continue;
      }
      if (in_trash && user && !userUtil.isAdmin(user)) {
        const canDelete = await hasPermission(mainKnex, user, 'delete', fullPath);
        if (!canDelete) {
          blocked += 1;
          continue;
        }
      }
      count += 1;
      bytes += Number(row.size || 0) || 0;
    }
    return { count, bytes, blocked };
  }

  /**
   * ⭐ 2026-10-16 P0-6：执行批量删除并**留下可撤销的日志**。
   * undo_data 只存业务层快照（哪些 id、原 in_trash 值），撤销时按 id 回滚索引，不动文件。
   * @returns {Promise<{operationId:number|null, count:number, bytes:number, expireDays:number}>}
   */
  async function batchTrashLogged(ids, in_trash, user) {
    const preview = await previewTrash(ids, in_trash, user);
    const before = await getKnex()('photo_index')
      .whereIn('id', Array.isArray(ids) ? ids.map(Number).filter(Number.isFinite) : [])
      .select('id', 'in_trash')
      .catch(() => []);

    await batchTrash(ids, in_trash, user);

    const uid = user && user.id ? Number(user.id) : 0;
    const EXPIRE_DAYS = 7;
    let operationId = null;
    try {
      const inserted = await getKnex()('photo_operation_log')
        .insert({
          uid,
          op_type: in_trash ? 'trash' : 'untrash',
          target_ids: JSON.stringify((Array.isArray(before) ? before : []).map(r => Number(r.id))),
          undo_data: JSON.stringify((Array.isArray(before) ? before : []).map(r => ({ id: Number(r.id), in_trash: Number(r.in_trash) || 0 }))),
          summary: JSON.stringify({ count: preview.count, bytes: preview.bytes }),
          status: 'executed',
          expire_time: new Date(Date.now() + EXPIRE_DAYS * 24 * 3600 * 1000),
        })
        .returning('id');
      operationId = Array.isArray(inserted) && inserted[0]
        ? (typeof inserted[0] === 'object' ? Number(inserted[0].id) : Number(inserted[0]))
        : null;
    } catch (err) {
      // 日志写失败不能让删除结果丢失 —— 只是这次不可撤销
      Logger.error('operation log insert failed:', err);
    }

    return { operationId, count: preview.count, bytes: preview.bytes, expireDays: EXPIRE_DAYS };
  }

  /** 当前用户最近可撤销的操作（管理员看全部，普通用户只看自己的） */
  async function recentOperations(user, limit = 20) {
    const knex = getKnex();
    const uid = user && user.id ? Number(user.id) : 0;
    const q = knex('photo_operation_log')
      .where('status', 'executed')
      .orderBy('create_time', 'desc')
      .limit(Math.max(1, Math.min(50, Number(limit) || 20)));
    if (!(user && userUtil.isAdmin(user))) q.where('uid', uid);
    const rows = await q.catch(() => []);
    return {
      items: (Array.isArray(rows) ? rows : []).map(r => {
        const summary = (() => {
          try {
            return JSON.parse(String(r.summary || '{}'));
          } catch (_) {
            return {};
          }
        })();
        return {
          id: Number(r.id),
          op_type: String(r.op_type || ''),
          count: Number(summary.count || 0),
          bytes: Number(summary.bytes || 0),
          status: String(r.status || ''),
          create_time: r.create_time || null,
          expire_time: r.expire_time || null,
        };
      }),
    };
  }

  /**
   * ⭐ 2026-10-17 回滚「重复清理」合并过的元数据。
   * 只删**自己加进去的那些**（按 (file_hash, 业务键) 精确定位），不做范围删除，
   * 避免把用户后来自己加的东西一起干掉。
   * @returns {Promise<number>} 回滚的条目数
   */
  async function revertMergedMetadata(knex, merge) {
    let n = 0;
    for (const f of Array.isArray(merge.favorite) ? merge.favorite : []) {
      n += await knex('photo_favorite').where({ uid: Number(f.uid) || 0, file_hash: String(f.file_hash) }).del().catch(() => 0);
    }
    for (const a of Array.isArray(merge.album) ? merge.album : []) {
      n += await knex('photo_album_index').where({ album_id: Number(a.album_id) || 0, file_hash: String(a.file_hash) }).del().catch(() => 0);
    }
    for (const p of Array.isArray(merge.people) ? merge.people : []) {
      n += await knex('photo_face2filehash').where({ file_hash: String(p.file_hash), face_id: Number(p.face_id) || 0 }).del().catch(() => 0);
    }
    for (const p of Array.isArray(merge.places) ? merge.places : []) {
      n += await knex('photo_places2filehash').where({ file_hash: String(p.file_hash), place_name: String(p.place_name) }).del().catch(() => 0);
    }
    for (const a of Array.isArray(merge.activities) ? merge.activities : []) {
      n += await knex('photo_activity2filehash').where({ file_hash: String(a.file_hash), act_key: String(a.act_key) }).del().catch(() => 0);
    }
    if (merge.location && Number(merge.location.id) > 0) {
      // 位置无法知道「原来是多少」⇒ 只能回到 0（无坐标）。这是可接受的降级：
      // 合并前那次判定要求保留的那张**本来就没有坐标**。
      await knex('photo_index').where({ id: Number(merge.location.id) }).update({ latitude: 0, longitude: 0 }).catch(() => {});
      n += 1;
    }
    return n;
  }

  /**
   * ⭐ 2026-10-16 P0-6 撤销：按 undo_data 回滚索引层。
   * 只认 status='executed' + 未过期 + 本人（或管理员）；重复撤销直接拒绝，不做幂等吞掉
   * —— 让用户明确知道「这次没生效」比悄悄成功更安全。
   */
  async function undoOperation(operationId, user) {
    const id = Number(operationId);
    if (!Number.isFinite(id) || id <= 0) {
      const err = new Error('common.PARAM_ERROR');
      err.statusCode = 400;
      throw err;
    }
    const knex = getKnex();
    const row = await knex('photo_operation_log').where({ id }).first().catch(() => null);
    if (!row) {
      const err = new Error('common.NOT_FOUND');
      err.statusCode = 404;
      throw err;
    }
    const uid = user && user.id ? Number(user.id) : 0;
    if (Number(row.uid) !== uid && !(user && userUtil.isAdmin(user))) {
      const err = new Error('auth.PERMISSION_DENIED');
      err.statusCode = 403;
      throw err;
    }
    if (String(row.status) !== 'executed') {
      const err = new Error('photo.UNDO_NOT_AVAILABLE');
      err.statusCode = 409;
      throw err;
    }
    if (row.expire_time && new Date(row.expire_time).getTime() < Date.now()) {
      await knex('photo_operation_log').where({ id }).update({ status: 'expired' }).catch(() => {});
      const err = new Error('photo.UNDO_EXPIRED');
      err.statusCode = 409;
      throw err;
    }

    // ⭐ 2026-10-17 两种 undo_data 形状都要认：
    //   数组  = 老的「批量删除」（只含 {id, in_trash}）
    //   对象  = 新的「重复清理合并」{ trashed: [...], merge: {...} }
    //   ⛔ 老形状的行为一个字都不能变。
    let undoList = [];
    let mergeUndo = null;
    try {
      const parsed = JSON.parse(String(row.undo_data || '[]'));
      if (Array.isArray(parsed)) {
        undoList = parsed;
      } else if (parsed && typeof parsed === 'object') {
        undoList = Array.isArray(parsed.trashed) ? parsed.trashed : [];
        mergeUndo = parsed.merge && typeof parsed.merge === 'object' ? parsed.merge : null;
      }
    } catch (_) {
      undoList = [];
    }
    const restoreToTrash = undoList.filter(e => e && Number(e.in_trash) === 1).map(e => Number(e.id));
    const restoreOutOfTrash = undoList.filter(e => e && Number(e.in_trash) === 0).map(e => Number(e.id));

    if (restoreToTrash.length > 0) {
      await knex('photo_index').whereIn('id', restoreToTrash).update({ in_trash: 1, in_trash_time: new Date() });
    }
    if (restoreOutOfTrash.length > 0) {
      await knex('photo_index').whereIn('id', restoreOutOfTrash).update({ in_trash: 0, in_trash_time: null });
    }

    // ⭐ 2026-10-17 合并过的元数据也要回滚（把「搬过去的」再删掉 / 复原坐标）
    let mergeReverted = 0;
    if (mergeUndo) {
      try {
        mergeReverted = await revertMergedMetadata(knex, mergeUndo);
      } catch (err) {
        // 元数据回滚失败不能让回收站回滚也失败：明确的日志 + 继续
        Logger.error('undo merge revert failed:', err);
      }
    }

    await knex('photo_operation_log')
      .where({ id })
      .update({ status: 'undone', undone_time: new Date() })
      .catch(() => {});

    return { undone: undoList.length, operationId: id, mergeReverted };
  }

  return {
    batchTrash,
    previewTrash,
    batchTrashLogged,
    recentOperations,
    undoOperation,
    getTrashPhotoList,
    deleteFromTrash,
    restoreFromTrash,
    restoreAllFromTrash,
    emptyTrash,
  };
}

module.exports = { createTrashOps };
