'use strict';

/**
 * ⭐ 2026-10-18 相册「大类」映射。
 *
 * 场景/活动模型（places365 / activity）吐出来的是**细标签**（室内游泳池、摆拍、食物特写…），
 * 几十上百个平铺在一起没法看。这里给一份「细标签 → 8 个大类」的映射，
 * 分类页的分组 chips 和年度总结的生活图谱用**同一套规则**，避免两处口径不一致。
 *
 * 匹配方式：标签名 `includes` 命中第一个大类即止（按下面的顺序优先）。
 * ⛔ 改顺序会改变归类结果 —— 「室内游泳池」既含"游泳"也不含别的，靠顺序稳定；
 *    但「海滨小屋」同时含"海"和"小屋"，放在 stay 之前就会被归到自然，所以 travel/stay 必须排在 nature 前。
 */

const CATEGORIES = [
  {
    key: 'food',
    words: ['食物', '餐', '饭', '菜', '面', '烧烤', '糖果', '咖啡', '茶', '酒', '厨房', '快餐', '甜品', '火锅'],
  },
  {
    key: 'travel',
    words: ['机场', '航站楼', '公交', '火车', '地铁', '车站', '船', '木筏', '汽车', '驾驶', '公路', '飞机',
      '车内', '机舱', '人行横道', '赛道', '停机坪', '候机'],
  },
  {
    key: 'stay',
    words: ['小屋', '酒店', '民宿', '卧室', '客厅', '房间', '露营', '帐篷', '宿舍', '客栈'],
  },
  {
    key: 'nature',
    words: ['海', '沙滩', '沙漠', '山', '森林', '雪', '湖', '河', '瀑布', '天空', '日落', '日出', '黄昏', '夜景',
      '云', '花', '草', '树', '苔原', '台风', '星空', '月',
      '荒漠', '冰架', '冰川', '晴天', '雾天', '彩虹', '雨', '沙坑', '田野', '草原', '火山', '峡谷'],
  },
  {
    key: 'architecture',
    words: ['塔', '寺', '教堂', '桥', '楼', '建筑', '博物馆', '城市', '广场', '公园', '城墙', '宫殿', '庭院',
      '纪念碑', '牌坊', '天桥', '牌楼'],
  },
  {
    key: 'sport',
    words: ['游泳', '健身', '溜冰', '球场', '运动', '跑步', '瑜伽', '骑', '登', '徒步', '球', '滑',
      '武术', '拳击', '马术', '攀岩', '武术馆', '体育场'],
  },
  {
    // 居家/室内生活场景（places365 里这一类特别多，不单列会全挤进「其他」）
    key: 'home',
    words: ['居家', '儿童房', '书房', '浴室', '卫生间', '育婴', '淋浴', '更衣', '养老', '书桌',
      '阳台', '厨房', '客厅', '卧室', '宿舍', '走廊', '楼梯', '地窖', '阁楼'],
  },
  {
    key: 'shopping',
    words: ['店', '商场', '超市', '市场', '售票', '美容', '百货', '五金', '药房', '集市'],
  },
  {
    key: 'fun',
    words: ['游戏厅', '游乐园', '水族馆', '演出', '马戏', '酒吧', '影院', '剧场', '竞技场', '展馆', '音乐会'],
  },
  {
    // 宠物单列：本机库里「宠物特写」有两百多张，塞进「其他」太浪费
    key: 'pet',
    words: ['宠物', '猫', '狗', '兔', '鸟', '仓鼠'],
  },
  {
    key: 'people',
    words: ['婚礼', '合影', '拥抱', '摆拍', '大笑', '跳舞', '唱歌', '微笑', '敬茶', '聚会', '派对', '宴会'],
  },
  {
    key: 'work',
    words: ['文档', '白板', '发票', '截图', '票据', '教室', '病房', '手术', '办公', '合同', '书籍'],
  },
];

const CATEGORY_KEYS = CATEGORIES.map(c => c.key);
const CATEGORY_RANK = new Map(CATEGORY_KEYS.map((k, i) => [k, i]));

const _cache = new Map();

/**
 * 细标签 → 大类 key。识别不出来返回 ''（归类到「其他」，不硬塞）。
 * @param {string} name 场景名或活动名（中文本地化后的）
 * @returns {string} food/travel/stay/nature/architecture/sport/people/work/''
 */
function categorize(name) {
  const key = String(name || '').trim();
  if (!key) return '';
  if (_cache.has(key)) return _cache.get(key);
  let hit = '';
  for (const cat of CATEGORIES) {
    if (cat.words.some(w => key.includes(w))) {
      hit = cat.key;
      break;
    }
  }
  _cache.set(key, hit);
  return hit;
}

/** 大类排序号（用于稳定排序，未知的排最后）。 */
function rankOf(key) {
  return CATEGORY_RANK.has(key) ? CATEGORY_RANK.get(key) : 999;
}

module.exports = { CATEGORIES, CATEGORY_KEYS, categorize, rankOf };
