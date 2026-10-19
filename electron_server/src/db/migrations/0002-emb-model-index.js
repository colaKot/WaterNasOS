'use strict';
/**
 * 给 photo_index.emb_model 补索引。
 *
 * 背景：向量召回改走 sqlite-vec 后，`emb_model`（塔标识）会被用来做
 * 「跨塔一致性检查」和「按塔统计向量覆盖率」——两者都是按该列过滤。
 * 列本身由 `tablePhotoIndex.ensureColumns()` 补上（那属于迁移机制上线前的历史路径），
 * 这条迁移只补索引。
 */
module.exports = {
  name: '0002-emb-model-index',
  async up({ knexPhoto }) {
    await knexPhoto.raw('CREATE INDEX IF NOT EXISTS idx_photo_index_emb_model ON photo_index (emb_model)');
  },
};
