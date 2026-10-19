'use strict';
/**
 * 活动维度加「尝试次数」列：`photo_index.gen_activity_attempts`。
 *
 * 背景（2026-10-17 实测）：活动识别的单张失败处理原来是
 *   `catch (err) { Logger.error(...) }` —— **不写标志位**，
 * 于是永久失败的文件（根本不是图片 / 已损坏）会被**无限重试**：
 * 日志里 `jpush_uid.png` 重试 78 次、`PA290862.JPG` 39 次，
 * 而 `gen_activity` 永远降不到 0（用户看到的「待处理」数字是假的）。
 *
 * 有了这一列，worker 才能区分「还没跑」「跑失败了但还能再试」「试够次数了、放弃」三种状态。
 *
 * ⚠️ 这也是迁移机制上线后第一条**真实结构变更**（0002 只建索引），
 *    所以它同时也是对该机制的一次验证：列由迁移加，不再由 `ensureColumns` 加，
 *    避免「同一列两个来源」。
 */
module.exports = {
  name: '0003-gen-activity-attempts',
  async up({ knexPhoto }) {
    const info = await knexPhoto.raw("PRAGMA table_info('photo_index')");
    const rows = Array.isArray(info) ? info : (info && info.rows) || [];
    const has = rows.some((r) => r && r.name === 'gen_activity_attempts');
    if (has) return; // 幂等：手动补过列的环境不再重复 ALTER
    await knexPhoto.raw('ALTER TABLE photo_index ADD COLUMN gen_activity_attempts INTEGER NOT NULL DEFAULT 0');
  },
};
