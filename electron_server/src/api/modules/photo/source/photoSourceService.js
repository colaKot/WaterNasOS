const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// photo_index.content_md5 是否存在（进程内缓存；缺失时请求内自愈补列）
let _contentMd5ColumnReady = false;

class PhotoSourceService {
  constructor(knex) {
    this.knex = knex;
    this.tableName = 'photo_source';
  }

  normalizeUid(uid) {
    const n = Number(uid);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }

  /**
   * 确保 photo_index.content_md5 列存在。
   * 与服务端 /api/file/md5 使用同一套算法，用于「跨相册源内容去重」缓存。
   */
  async ensureContentMd5Column() {
    if (_contentMd5ColumnReady) return true;
    try {
      const info = await this.knex.raw(`PRAGMA table_info('photo_index')`);
      const rows = Array.isArray(info) ? info : ((info && info.rows) || []);
      const names = new Set((rows || []).map(r => (r && r.name ? String(r.name) : '')));
      if (!names.has('content_md5')) {
        await this.knex.raw('ALTER TABLE photo_index ADD COLUMN content_md5 TEXT');
      }
      _contentMd5ColumnReady = true;
      return true;
    } catch (_) {
      return false;
    }
  }

  /**
   * 内容 MD5：<阈值全量；>=阈值取头/尾各 chunkSize。
   * 必须与 fileListController.computeMd5Full / computeMd5HeadTail 逐字节一致，
   * 否则客户端本地算出的 MD5 永远对不上。
   */
  async computeContentMd5(filePath, fileSize, thresholdBytes = 50 * 1024 * 1024, chunkSizeBytes = 1024 * 1024) {
    try {
      const stat = await fs.promises.stat(filePath);
      if (!stat.isFile()) return '';
      const size = Number.isFinite(Number(fileSize)) && Number(fileSize) > 0 ? Number(fileSize) : stat.size;
      if (size <= 0) return '';

      if (size < thresholdBytes) {
        return await new Promise((resolve, reject) => {
          const hash = crypto.createHash('md5');
          const stream = fs.createReadStream(filePath, { highWaterMark: 1024 * 1024 });
          stream.on('data', chunk => hash.update(chunk));
          stream.on('error', reject);
          stream.on('end', () => resolve(hash.digest('hex')));
        });
      }

      const headLen = Math.min(chunkSizeBytes, size);
      const tailLen = Math.min(chunkSizeBytes, size);
      const headBuf = Buffer.allocUnsafe(headLen);
      const tailBuf = Buffer.allocUnsafe(tailLen);
      const fh = await fs.promises.open(filePath, 'r');
      try {
        const headRead = await fh.read(headBuf, 0, headLen, 0);
        const tailRead = await fh.read(tailBuf, 0, tailLen, Math.max(0, size - tailLen));
        const hash = crypto.createHash('md5');
        if (headRead && headRead.bytesRead > 0) hash.update(headBuf.subarray(0, headRead.bytesRead));
        if (tailRead && tailRead.bytesRead > 0) hash.update(tailBuf.subarray(0, tailRead.bytesRead));
        return hash.digest('hex');
      } finally {
        await fh.close().catch(() => {});
      }
    } catch (_) {
      return '';
    }
  }

  /** 该用户的相册源根目录（去重、去空） */
  async listSourceRoots(uid) {
    const rows = await this.knex(this.tableName)
      .where({ uid: this.normalizeUid(uid) })
      .select('path')
      .catch(() => []);
    return [
      ...new Set(
        (rows || []).map(r => (r && r.path ? String(r.path).trim() : '')).filter(Boolean)
      ),
    ];
  }

  /**
   * 跨相册源内容级去重（2026-10-13 增 size 预检 absent）。
   *
   * 语义：在该用户**全部相册源**（photo_source）范围内，查找是否存在内容完全相同的照片，
   * 不局限于「同一目标文件夹/同一文件名」。
   *
   * 做法：先用 photo_index.size 粗筛（size 已在库内，几乎零成本），
   * 再只对「大小相同」的极少数候选惰性计算内容 MD5，并把结果写回 photo_index.content_md5 缓存。
   * 因此不会为了去重去全量哈希整个图库。
   *
   * ⭐ size 预检（absent）：items 的 md5 现在**可选**。只带 size 的条目用于判定
   * 「这个 size 在我全部相册源里一个候选都没有」——absent 列表里的 size 意味着
   * **内容不可能已存在**（同内容必同 size），客户端可跳过本地 MD5 直接上传。
   * 老客户端（必带 md5）行为不变：matched 口径与此前完全一致，只是多返回 absent 字段。
   *
   * @param {number} uid 当前用户 id（可见性零角色例外：只比对本人的相册源）
   * @param {Array<{md5?: string, size: number}>} items 待上传条目（md5 可选）
   * @returns {Promise<{matched: string[], absent: number[], scanned: number, hashed: number}>}
   */
  async findExistingContent(uid, items) {
    const list = Array.isArray(items) ? items : [];
    const wantedBySize = new Map(); // size -> Set(md5)，只收集带了 md5 的条目
    const allMd5 = new Set();
    const requestedSizes = new Set();
    for (const it of list) {
      const size = Number(it && it.size);
      if (!Number.isFinite(size) || size <= 0) continue;
      requestedSizes.add(size);
      const md5 = String((it && it.md5) || '').trim().toLowerCase();
      if (!/^[0-9a-f]{32}$/.test(md5)) continue;
      if (!wantedBySize.has(size)) wantedBySize.set(size, new Set());
      wantedBySize.get(size).add(md5);
      allMd5.add(md5);
    }
    if (requestedSizes.size === 0) return { matched: [], absent: [], scanned: 0, hashed: 0 };

    const roots = await this.listSourceRoots(uid);
    if (roots.length === 0) {
      // 没有任何相册源：请求的 size 必然都不存在（matched 也必然为空）
      return { matched: [], absent: [...requestedSizes], scanned: 0, hashed: 0 };
    }
    if (!(await this.ensureContentMd5Column())) {
      // 没有 content_md5 列时无法做内容比对；但 size 存在性不依赖该列，absent 仍可信
      const presentNoColumn = await this.queryPresentSizes(roots, [...requestedSizes]);
      return {
        matched: [],
        absent: [...requestedSizes].filter((s) => !presentNoColumn.has(s)),
        scanned: 0,
        hashed: 0,
      };
    }

    // 1) size 存在性预检：哪些请求的 size 在图库里一个候选都没有
    const presentSizes = await this.queryPresentSizes(roots, [...requestedSizes]);
    const absent = [...requestedSizes].filter((s) => !presentSizes.has(s));

    // 2) 内容比对：只处理「size 有候选 且 客户端带了 md5」的部分
    const matched = new Set();
    let scanned = 0;
    let hashed = 0;
    const candidateSizes = [...wantedBySize.keys()].filter((s) => presentSizes.has(s));
    const SIZE_CHUNK = 300;

    for (let i = 0; i < candidateSizes.length; i += SIZE_CHUNK) {
      if (matched.size >= allMd5.size) break;
      const slice = candidateSizes.slice(i, i + SIZE_CHUNK);

      const query = this.knex('photo_index')
        .where({ is_file: 1, in_trash: 0 })
        .whereIn('size', slice)
        .select('id', 'path', 'filename', 'size', 'content_md5');
      query.where(qb => {
        for (const root of roots) {
          const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
          qb.orWhere('path', root).orWhere('path', 'like', `${prefix}%`);
        }
      });

      const rows = await query.catch(() => []);
      for (const row of rows || []) {
        const size = Number(row.size);
        const cands = wantedBySize.get(size);
        if (!cands || cands.size === 0) continue;
        scanned += 1;

        let md5 = row.content_md5 ? String(row.content_md5).trim().toLowerCase() : '';
        if (!md5 || !/^[0-9a-f]{32}$/.test(md5)) {
          const abs = path.join(String(row.path || ''), String(row.filename || ''));
          md5 = await this.computeContentMd5(abs, size);
          if (!md5) continue;
          hashed += 1;
          await this.knex('photo_index').where({ id: row.id }).update({ content_md5: md5 }).catch(() => {});
        }
        if (cands.has(md5)) matched.add(md5);
      }
    }

    return { matched: [...matched], absent, scanned, hashed };
  }

  /**
   * ⭐ 2026-10-17 P5：**候选限定**的 content_md5 补齐。
   *
   * 为什么需要：`photo_index.content_md5` 是惰性填充的（只有相册备份比对过才写），
   * 实测 61686 张里只有 5359 张有值 ⇒「重复照片清理」只能查出 1 组，功能等于废的。
   *
   * 为什么能只算一部分：**内容相同 ⇒ size 必相同** ⇒ 只有 size 与别人撞车的才可能重复。
   * 实测候选 9754 行 / 31 GiB，全量 219 GiB ⇒ 省掉 86% 的读盘。
   *
   * ⚠️ 算法直接复用本类的 computeContentMd5（与 fileListController / 客户端 /api/file/md5
   * 逐字节一致），绝不另写一份，否则客户端本地算出的 md5 永远对不上。
   *
   * @param {{limit?:number, pathPrefixes?:string[]}} options
   * @returns {Promise<{candidates:number, scanned:number, hashed:number, failed:number, remaining:number}>}
   */
  async backfillContentMd5(options = {}) {
    const limit = Math.max(1, Math.min(5000, Number(options.limit) || 500));
    const prefixes = Array.isArray(options.pathPrefixes) ? options.pathPrefixes.filter(Boolean) : [];
    await this.ensureContentMd5Column().catch(() => false);

    const buildCandidates = () => {
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
      if (prefixes.length > 0) {
        q.where(qb => {
          for (const root of prefixes) {
            const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
            qb.orWhere('p.path', root).orWhere('p.path', 'like', `${prefix}%`);
          }
        });
      }
      return q;
    };

    const candidates = await buildCandidates()
      .count({ n: 'p.id' })
      .first()
      .then(r => Number((r && r.n) || 0) || 0)
      .catch(() => 0);
    if (candidates <= 0) return { candidates: 0, scanned: 0, hashed: 0, failed: 0, remaining: 0 };

    const rows = await buildCandidates()
      .select('p.id', 'p.path', 'p.filename', 'p.size')
      .limit(limit)
      .catch(() => []);

    let hashed = 0;
    let failed = 0;
    for (const row of rows || []) {
      const abs = path.join(String(row.path || ''), String(row.filename || ''));
      const md5 = await this.computeContentMd5(abs, Number(row.size)).catch(() => '');
      if (!md5) {
        failed += 1;
        continue;
      }
      await this.knex('photo_index').where({ id: row.id }).update({ content_md5: md5 }).catch(() => {});
      hashed += 1;
    }

    const remaining = await buildCandidates()
      .count({ n: 'p.id' })
      .first()
      .then(r => Number((r && r.n) || 0) || 0)
      .catch(() => 0);

    return { candidates, scanned: (rows || []).length, hashed, failed, remaining };
  }

  /// 查询这批 size 里哪些在图库（该用户可见的源范围内）至少有一个候选行。  /// 查询这批 size 里哪些在图库（该用户可见的源范围内）至少有一个候选行。
  /// 只 select size，走索引，代价与 size 个数成正比、与库大小无关。
  async queryPresentSizes(roots, sizes) {
    const present = new Set();
    if (!sizes || sizes.length === 0) return present;
    const SIZE_CHUNK = 300;
    for (let i = 0; i < sizes.length; i += SIZE_CHUNK) {
      const slice = sizes.slice(i, i + SIZE_CHUNK);
      const query = this.knex('photo_index')
        .where({ is_file: 1, in_trash: 0 })
        .whereIn('size', slice)
        .distinct('size');
      query.where(qb => {
        for (const root of roots) {
          const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
          qb.orWhere('path', root).orWhere('path', 'like', `${prefix}%`);
        }
      });
      const rows = await query.catch(() => []);
      for (const row of rows || []) {
        const size = Number(row.size);
        if (Number.isFinite(size) && size > 0) present.add(size);
      }
    }
    return present;
  }

  /**
   * 列出源目录。传 uid 只列该用户自己的；传 null/undefined 列全部（仅内部/迁移使用）
   */
  async listSources(uid) {
    const query = this.knex(this.tableName).select('*').orderBy('id', 'asc');
    if (uid !== null && uid !== undefined) {
      query.where({ uid: this.normalizeUid(uid) });
    }
    return query;
  }

  /**
   * 校验源目录归属。非属主且非管理员时抛 403
   */
  assertOwner(row, uid, allowAnyOwner = false) {
    if (allowAnyOwner) return;
    if (this.normalizeUid(uid) !== this.normalizeUid(row && row.uid)) {
      const err = new Error('auth.PERMISSION_DENIED');
      err.statusCode = 403;
      throw err;
    }
  }

  normalizePath(inputPath) {
    const p = String(inputPath || '').trim();
    if (!p) return '';
    return path.resolve(p);
  }

  isParentPath(parentPath, childPath) {
    const parent = String(parentPath || '');
    const child = String(childPath || '');
    if (!parent || !child) return false;
    if (parent === child) return false;

    const parentWithSep = parent.endsWith(path.sep) ? parent : `${parent}${path.sep}`;
    return child.startsWith(parentWithSep);
  }

  isChildPath(parentPath, childPath) {
    return this.isParentPath(parentPath, childPath);
  }

  async addSource(inputPath, uid) {
    const owner = this.normalizeUid(uid);
    if (!owner) {
      throw new Error('validation.VALIDATION_ERROR');
    }

    const normalizedPath = this.normalizePath(inputPath);
    if (!normalizedPath) {
      throw new Error('validation.VALIDATION_ERROR');
    }

    // 父子目录冲突只在同一用户名下判断，不同用户各加各的互不影响
    const rows = await this.knex(this.tableName).where({ uid: owner }).select('id', 'path').orderBy('id', 'asc');

    const exact = rows.find(r => r.path === normalizedPath);
    if (exact) {
      throw new Error('photo.PHOTO_SOURCE_EXISTS');
    }

    const parentRow = rows.find(r => this.isParentPath(r.path, normalizedPath));
    if (parentRow) {
      const err = new Error('photo.PHOTO_SOURCE_PARENT_EXISTS');
      err.args = [normalizedPath, parentRow.path];
      throw err;
    }

    const childRows = rows.filter(r => this.isChildPath(normalizedPath, r.path));
    if (childRows.length > 0) {
      const keep = childRows[0];
      const removeIds = childRows.slice(1).map(r => r.id);

      const row = await this.knex.transaction(async trx => {
        await trx(this.tableName).where({ id: keep.id }).update({
          path: normalizedPath,
          scan_when_start: 1,
        });
        if (removeIds.length > 0) {
          await trx(this.tableName).whereIn('id', removeIds).delete();
        }
        return trx(this.tableName).where({ id: keep.id }).first();
      });

      return { row, action: 'update' };
    }

    const row = await this.knex.transaction(async trx => {
      const [id] = await trx(this.tableName).insert({
        path: normalizedPath,
        uid: owner,
        scan_when_start: 1,
        ctime: new Date(),
      });
      return trx(this.tableName).where({ id }).first();
    });

    return { row, action: 'insert' };
  }

  async deleteSource({ id, path: inputPath, uid, allowAnyOwner = false }) {
    const owner = this.normalizeUid(uid);
    const deleteById = Number(id);
    const deleteByPath = this.normalizePath(inputPath);
    const shouldDeleteById = Number.isFinite(deleteById) && deleteById > 0;
    const shouldDeleteByPath = !shouldDeleteById && !!deleteByPath;
    if (!shouldDeleteById && !shouldDeleteByPath) {
      throw new Error('validation.VALIDATION_ERROR');
    }

    return this.knex.transaction(async trx => {
      const target = shouldDeleteById
        ? await trx(this.tableName).where({ id: deleteById }).first('id', 'path', 'uid')
        : await trx(this.tableName).where({ path: deleteByPath, uid: owner }).first('id', 'path', 'uid');

      if (!target || !target.id) return 0;

      this.assertOwner(target, owner, allowAnyOwner);

      const affected = await trx(this.tableName).where({ id: target.id }).delete();
      if (!affected) return 0;

      const resolved = target.path ? String(target.path) : '';
      if (!resolved) return affected;

      // 隔离后同一物理路径可能被多个用户的源目录共同覆盖：
      // 只有「删完之后再没有任何 source 覆盖该路径」时才清理索引，避免误删别人的照片
      const remainingRows = await trx(this.tableName).select('path').catch(() => []);
      const remaining = (remainingRows || [])
        .map(r => (r && r.path ? String(r.path) : ''))
        .filter(Boolean);

      const scanPrefix = resolved.endsWith(path.sep) ? resolved : `${resolved}${path.sep}`;
      const indexQuery = trx('photo_index').where(qb => {
        qb.where('path', resolved).orWhere('path', 'like', `${scanPrefix}%`);
      });

      if (remaining.length > 0) {
        indexQuery.whereNot(qb => {
          for (const keep of remaining) {
            const keepPrefix = keep.endsWith(path.sep) ? keep : `${keep}${path.sep}`;
            qb.orWhere(function () {
              this.where('path', keep).orWhere('path', 'like', `${keepPrefix}%`);
            });
          }
        });
      }

      await indexQuery.delete().catch(() => {});

      //清除来源目录本身的索引
      const parentDir = path.dirname(resolved);
      const folderName = path.basename(resolved);
      if (parentDir && folderName) {
        await trx('photo_index')
          .where({ path: parentDir, filename: folderName })
          .delete()
          .catch(() => {});
      }
      return affected;
    });
  }

  async updateSource(id, payload = {}, uid, allowAnyOwner = false) {
    const sourceId = Number(id);
    if (!Number.isFinite(sourceId) || sourceId <= 0) {
      throw new Error('validation.VALIDATION_ERROR');
    }

    const existing = await this.knex(this.tableName).where({ id: sourceId }).first('id', 'uid');
    if (!existing || !existing.id) {
      throw new Error('common.NOT_FOUND');
    }
    this.assertOwner(existing, uid, allowAnyOwner);

    const data = {};

    if (payload.scan_when_start !== undefined) data.scan_when_start = Number(payload.scan_when_start);
    if (payload.scan_when_change !== undefined) data.scan_when_change = Number(payload.scan_when_change);
    if (payload.is_show !== undefined) data.is_show = Number(payload.is_show);
    if (payload.scan_interval !== undefined) data.scan_interval = Number(payload.scan_interval);
    if (payload.scan_interval_ms !== undefined) data.scan_interval_ms = Number(payload.scan_interval_ms);
    if (payload.scan_interval_config !== undefined) data.scan_interval_config = String(payload.scan_interval_config);
    if (payload.last_scan_time !== undefined) data.last_scan_time = Number(payload.last_scan_time);

    if (Object.keys(data).length === 0) {
      throw new Error('validation.VALIDATION_ERROR');
    }

    const affected = await this.knex(this.tableName).where({ id: sourceId }).update(data);
    if (!affected) {
      throw new Error('common.NOT_FOUND');
    }

    const row = await this.knex(this.tableName).where({ id: sourceId }).first();
    return row;
  }

  async relocateSource(id, newPath, uid, allowAnyOwner = false) {
    const sourceId = Number(id);
    if (!Number.isFinite(sourceId) || sourceId <= 0) {
      throw new Error('validation.VALIDATION_ERROR');
    }

    const normalizedNewPath = this.normalizePath(newPath);
    if (!normalizedNewPath) {
      throw new Error('validation.VALIDATION_ERROR');
    }

    return this.knex.transaction(async trx => {
      const source = await trx(this.tableName).where({ id: sourceId }).first('id', 'path', 'uid');
      if (!source || !source.id) {
        throw new Error('common.NOT_FOUND');
      }

      this.assertOwner(source, uid, allowAnyOwner);

      const oldPath = source.path ? this.normalizePath(source.path) : '';
      if (!oldPath) {
        throw new Error('validation.VALIDATION_ERROR');
      }

      if (oldPath === normalizedNewPath) {
        return { source_id: sourceId, old_path: oldPath, new_path: normalizedNewPath, updated: 0 };
      }

      // 冲突只在同一用户名下判断
      const rows = await trx(this.tableName).select('id', 'path', 'uid').orderBy('id', 'asc');
      const otherRows = (rows || []).filter(
        r => Number(r.id) !== sourceId && this.normalizeUid(r.uid) === this.normalizeUid(source.uid)
      );

      const exact = otherRows.find(r => r.path === normalizedNewPath);
      if (exact) {
        throw new Error('photo.PHOTO_SOURCE_EXISTS');
      }

      const parentRow = otherRows.find(r => this.isParentPath(r.path, normalizedNewPath));
      if (parentRow) {
        const err = new Error('photo.PHOTO_SOURCE_PARENT_EXISTS');
        err.args = [normalizedNewPath, parentRow.path];
        throw err;
      }

      const childRows = otherRows.filter(r => this.isChildPath(normalizedNewPath, r.path));
      if (childRows.length > 0) {
        const err = new Error('photo.PHOTO_SOURCE_PARENT_EXISTS');
        err.args = [childRows[0].path, normalizedNewPath];
        throw err;
      }

      await trx(this.tableName).where({ id: sourceId }).update({ path: normalizedNewPath });

      const oldPrefix = oldPath.endsWith(path.sep) ? oldPath : `${oldPath}${path.sep}`;
      const newPrefix = normalizedNewPath.endsWith(path.sep) ? normalizedNewPath : `${normalizedNewPath}${path.sep}`;

      // 若旧路径仍被别人的源目录覆盖，物理索引不能跟着改，否则会连带影响对方看到的照片
      const stillCovered = await trx(this.tableName)
        .whereNot({ id: sourceId })
        .where(qb => qb.where('path', oldPath).orWhere('path', 'like', `${oldPrefix}%`))
        .first('id')
        .catch(() => null);
      if (stillCovered && stillCovered.id) {
        return {
          source_id: sourceId,
          old_path: oldPath,
          new_path: normalizedNewPath,
          updated: 1,
          updated_index_paths: 0,
          updated_root_dir_index: 0,
        };
      }

      await trx('photo_scan_task')
        .where({ scan_path: oldPath })
        .update({ scan_path: normalizedNewPath })
        .catch(() => {});

      const now = Date.now();

      const updatedDirect = await trx('photo_index')
        .where({ path: oldPath })
        .update({ path: normalizedNewPath, check_time: now })
        .catch(() => 0);

      const startAt = oldPrefix.length + 1;
      const updatedSubtree = await trx('photo_index')
        .where('path', 'like', `${oldPrefix}%`)
        .update({
          path: trx.raw(`? || substr(path, ?)`, [newPrefix, startAt]),
          check_time: now,
        })
        .catch(() => 0);

      const oldParent = path.dirname(oldPath);
      const oldName = path.basename(oldPath);
      const newParent = path.dirname(normalizedNewPath);
      const newName = path.basename(normalizedNewPath);

      const updatedRootDirIndex = await trx('photo_index')
        .where({ path: oldParent, filename: oldName, is_file: 0 })
        .update({ path: newParent, filename: newName, check_time: now })
        .catch(() => 0);

      return {
        source_id: sourceId,
        old_path: oldPath,
        new_path: normalizedNewPath,
        updated: 1,
        updated_index_paths: Number(updatedDirect || 0) + Number(updatedSubtree || 0),
        updated_root_dir_index: Number(updatedRootDirIndex || 0),
      };
    });
  }
}

module.exports = PhotoSourceService;
