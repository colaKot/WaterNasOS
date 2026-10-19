'use strict';
/**
 * 基线迁移：什么也不做。
 *
 * 本仓库过去的 schema 演进全靠 `dbUtil.createAllTablesAndIndexes()` 里的
 * `createTable()` / `ensureColumns()` 隐式完成 —— 也就是说
 * 「迁移机制上线之前就已存在的一切」统称基线。
 *
 * 这条记录的唯一作用是把基线**登记进 schema_migrations**；
 * 从此往后的每一次结构变更都必须走迁移文件（`src/db/migrations/NNNN-xxx.js`），
 * 并在 `_order.js` 里登记。
 */
module.exports = {
  name: '0001-baseline',
  async up() {
    // 故意留空：基线就是「已经在那儿的那些表与列」
  },
};
