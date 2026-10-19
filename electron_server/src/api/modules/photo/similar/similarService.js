const path = require('path');
const config = require('../../../../config/config');
const SimilarRepository = require('../../../../repositories/similarRepository');

function parseCount(row) {
  if (!row) return 0;
  const v = row.count ?? row['count(*)'] ?? row['COUNT(*)'] ?? row.total ?? row['total'];
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function parseFileHashArray(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.map(v => String(v)).filter(Boolean);
  try {
    const parsed = JSON.parse(String(raw));
    if (!Array.isArray(parsed)) return [];
    return parsed.map(v => String(v)).filter(Boolean);
  } catch (_) {
    return [];
  }
}

function rawShowExt(item) {
  if (!item || !item.ext) return '';
  const ext = String(item.ext || '');
  if (config.rawImgTypeList && config.rawImgTypeList.includes(ext)) {
    return ext.toUpperCase().replace('.', '');
  }
  const rawFilename = item.raw_filename ? String(item.raw_filename) : '';
  if (rawFilename && rawFilename.includes('.')) {
    return `${ext.toUpperCase().replace('.', '')} +${path.extname(rawFilename).toUpperCase().replace('.', '')}`;
  }
  return '';
}

/**
 * 相似（重复候选）组业务层。
 *
 * ⭐ 2026-10-17 Repository 层试点：SQL 全部下沉到 `src/repositories/similarRepository.js`，
 *    本层只留下「校验 → 组装返回结构」。
 *    好处是过滤口径（is_file / in_trash / type）只在一处定义，不会再漂。
 */
class SimilarService {
  constructor(knex) {
    this.knex = knex;
    this.repo = new SimilarRepository(knex);
  }

  async listSimilarGroups(params = {}) {
    const page = Math.max(1, Number(params.page) || 1);
    const pageSize = Math.max(1, Math.min(200, Number(params.pageSize ?? params.page_size) || 20));
    const offset = (page - 1) * pageSize;

    const total = parseCount(await this.repo.countGroups());
    const rows = await this.repo.listGroups({ limit: pageSize, offset });

    const items = [];
    for (const r of rows) {
      const id = Number(r && r.id) || 0;
      if (!id) continue;

      const fileHashes = parseFileHashArray(r && r.similar_file_hash);
      if (fileHashes.length === 0) {
        await this.repo.deleteGroup(id);
        continue;
      }

      const photoRows = await this.repo.loadPhotosByHashes(fileHashes);
      if (!photoRows || photoRows.length < 2) {
        await this.repo.deleteGroup(id);
        continue;
      }

      const photos = photoRows.map(p => ({
        ...p,
        fullpath: path.join(p.path, p.filename),
        is_favorite: 0,
        raw_show_ext: rawShowExt(p),
      }));

      items.push({
        id,
        index_id: Number(r && r.index_id) || 0,
        file_hashes: fileHashes,
        photos,
        create_time: r && r.create_time ? r.create_time : null,
      });
    }

    return {
      items,
      pagination: {
        total,
        page,
        pageSize,
      },
    };
  }

  async batchDeleteSimilarRecords(ids = []) {
    const cleanIds = (Array.isArray(ids) ? ids : []).map(v => Number(v)).filter(v => Number.isFinite(v) && v > 0);
    if (cleanIds.length === 0) return 0;
    return Number(await this.repo.deleteGroupsByIds(cleanIds)) || 0;
  }

  async resetSimilarScan() {
    await this.knex.transaction(async trx => {
      await this.repo.clearAllGroups(trx);
      await this.repo.markAllPhashPending(trx);
      await this.repo.markMissingPhashPending(trx);
    });
    return true;
  }
}

module.exports = SimilarService;
