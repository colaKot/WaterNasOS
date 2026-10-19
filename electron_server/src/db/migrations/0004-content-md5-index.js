'use strict';
/**
 * 给 photo_index.content_md5 补索引。
 *
 * 背景：「重复照片清理」（`/photo/app_ai/duplicates`）的取数方式是
 *   `WHERE content_md5 IN (SELECT content_md5 ... GROUP BY content_md5 HAVING COUNT(1) >= 2)`，
 *   没有索引时 6.6 万行走**全表扫描 + 临时 B 树**，实测整个接口 **1427ms**。
 *
 * 实测（本机 65787 行 / 219.76 GiB 库）：
 *   · 建索引 317ms，索引约占 2~3 MB；
 *   · duplicates() 1427ms → **924ms**（-35%）；
 *   · 返回的 `total_groups=4570`、`total_wasted_bytes=16431795185` 与建索引前**逐字节一致**；
 *   · `EXPLAIN QUERY PLAN` 确认由 `SCAN` 变为 `SEARCH ... USING INDEX idx_photo_index_content_md5`。
 *
 * 附带收益：「候选限定」查询（未算 md5 且 size 撞车）也按 content_md5 过滤，一并受益。
 *
 * ⚠️ 只加索引，不动数据；`IF NOT EXISTS` 保证重跑幂等
 *    （本机曾为验证收益手动建过一次，迁移在这里是 no-op）。
 */
module.exports = {
  name: '0004-content-md5-index',
  async up({ knexPhoto }) {
    await knexPhoto.raw('CREATE INDEX IF NOT EXISTS idx_photo_index_content_md5 ON photo_index (content_md5)');
  },
};
