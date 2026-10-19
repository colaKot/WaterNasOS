'use strict';
/**
 * 照片「相似/重复候选」组的数据访问层（Repository 层试点）。
 *
 * ⭐ 为什么要单独一层（分层思路借鉴 Immich 的 hexagonal：`repositories` 只管技术实现、
 *    `services` 只管业务逻辑；代码未参考其实现）：
 *    本仓库此前把 SQL 直接写在 Service 里，实际遇到的问题有：
 *      · 同一张表的查询散落多处，**过滤条件口径容易漂**（`is_file=1` / `in_trash=0`
 *        这种条件漏写一次就是「删掉的照片又冒出来」）；
 *      · 想加缓存或换存储，必须动业务代码；
 *      · 单测业务逻辑也得拖着一个真库。
 *
 * ⛔ 本层的纪律（新代码请照此办理）：
 *    · 只收发**原始行**；不认识 DTO、不做权限判断、不抛业务错误、不组装响应结构；
 *    · 参数一律用**命名对象**，避免位置参数错位；
 *    · 需要事务的写操作，接受调用方传进来的 `trx`（不自己开事务）。
 *
 * ⚠️ 老代码是**增量迁移**，不做一次性大重构 —— 大重构会打断构建与热更链路，
 *    收益却只是「结构更干净」，不划算。所以现在只有这一个模块在试点。
 */
class SimilarRepository {
  /**
   * @param {any} knex better-sqlite3 的 knex 实例（Photo 库）
   */
  constructor(knex) {
    this.knex = knex;
  }

  /** 相似组总数 */
  async countGroups() {
    const row = await this.knex('photo_similar').count({ count: '*' }).first().catch(() => null);
    return row;
  }

  /**
   * 分页取相似组原始行。
   * @param {{limit:number, offset:number}} p
   */
  async listGroups({ limit, offset }) {
    return this.knex('photo_similar')
      .select('id', 'index_id', 'similar_file_hash', 'create_time')
      .orderBy('id', 'desc')
      .limit(limit)
      .offset(offset)
      .catch(() => []);
  }

  /**
   * 按 file_hash 批量取「可用于展示的照片行」。
   * ⚠️ 过滤口径固定在这里：`is_file=1 AND in_trash=0 AND type=1`（图片）。
   *    这是本层存在的最大理由之一 —— 口径只写一次。
   */
  async loadPhotosByHashes(fileHashes) {
    if (!Array.isArray(fileHashes) || fileHashes.length === 0) return [];
    return this.knex('photo_index')
      .whereIn('file_hash', fileHashes)
      .andWhere({ is_file: 1, in_trash: 0, type: 1 })
      .select(
        'id', 'path', 'filename', 'size', 'is_lvp', 'type', 'width', 'height',
        'original_date', 'original_time', 'duration', 'file_hash', 'live_filename', 'raw_filename', 'ext'
      )
      .orderBy('original_time', 'desc')
      .orderBy('id', 'desc')
      .catch(() => []);
  }

  /** 删掉一个相似组记录（组内容已失效时用） */
  async deleteGroup(id) {
    return this.knex('photo_similar').where({ id }).del().catch(() => 0);
  }

  /** 批量删相似组记录 */
  async deleteGroupsByIds(ids) {
    if (!Array.isArray(ids) || ids.length === 0) return 0;
    return this.knex('photo_similar').whereIn('id', ids).del().catch(() => 0);
  }

  /** 清空全部相似组（重扫前） */
  async clearAllGroups(trx = this.knex) {
    return trx('photo_similar').del().catch(() => 0);
  }

  /** 已有 phash 的照片标记为「待重新扫描」 */
  async markAllPhashPending(trx = this.knex) {
    return trx('photo_index')
      .where({ type: 1, is_file: 1, in_trash: 0 })
      .whereNotNull('phash')
      .andWhere('phash', '!=', '')
      .update({ gen_phash: 1 })
      .catch(() => 0);
  }

  /** 没有 phash 的照片标记为「未生成」 */
  async markMissingPhashPending(trx = this.knex) {
    return trx('photo_index')
      .where({ type: 1, is_file: 1, in_trash: 0 })
      .where((b) => b.whereNull('phash').orWhere('phash', ''))
      .update({ gen_phash: 0 })
      .catch(() => 0);
  }
}

module.exports = SimilarRepository;
