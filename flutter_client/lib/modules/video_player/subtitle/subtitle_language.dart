/// 字幕语言识别（与服务端 videoPlayerService.inferSubtitleLanguage 保持一致）。
///
/// 把「字幕文件名后缀」或「内嵌字幕 language 标签」归一到规范语言码，
/// 供「默认字幕语言」设置做自动匹配。
///
/// 覆盖的常见标识（字幕文件命名千奇百怪，这里尽量都认）：
///   简体：cn / chs / chi / sc / sg / gb / gbk / zh-cn / hans，中文 简体 简中 中字
///   繁体：tw / hk / cht / tc / big5 / zh-tw / zh-hk / hant，繁体 繁中 繁體 正体
///   英文：en / eng / english / 英文 / 英语
///   日文：ja / jp / jpn / japanese / 日文 / 日语
///   韩文：ko / kr / kor / korean / 韩文 / 韩语
///
/// 判定顺序：**先繁体再简体** —— `zh` 单独出现按简体处理，`chi` 亦按简体。
class SubtitleLanguage {
  const SubtitleLanguage._();

  /// 自动（不干预，沿用旧行为：取第一条字幕）
  static const String auto = '';

  /// 不自动加载字幕
  static const String none = 'none';

  static const String zhCN = 'zh-CN';
  static const String zhTW = 'zh-TW';
  static const String en = 'en';
  static const String ja = 'ja';
  static const String ko = 'ko';

  /// 设置页可选值（顺序即 UI 顺序）
  static const List<String> options = <String>[
    auto,
    none,
    zhCN,
    zhTW,
    en,
    ja,
    ko,
  ];

  static final RegExp _extRe = RegExp(r'\.(srt|ass|ssa|vtt|sub|mks)$');
  static final RegExp _sepRe = RegExp(r'[^a-z0-9\u4e00-\u9fff]+');
  static final RegExp _twRe = RegExp(r'繁体|繁中|繁體|正体|正體');
  static final RegExp _cnRe = RegExp(r'简体|简中|简体中文|中字|中文');
  static final RegExp _enRe = RegExp(r'英文|英语');
  static final RegExp _jaRe = RegExp(r'日文|日语|日本語');
  static final RegExp _koRe = RegExp(r'韩文|韩语');

  /// 把服务端/历史写入的设置值归一到 [options] 之一（非法值落回 [auto]）。
  static String normalize(String? raw) {
    final v = (raw ?? '').trim();
    if (v.isEmpty) return auto;
    final low = v.toLowerCase();
    const alias = <String, String>{
      'zh': zhCN,
      'chs': zhCN,
      'cn': zhCN,
      'zh-cn': zhCN,
      'zh_cn': zhCN,
      'zh-hans': zhCN,
      'cht': zhTW,
      'zh-tw': zhTW,
      'zh_tw': zhTW,
      'zh-hk': zhTW,
      'zh_hk': zhTW,
      'zh-hant': zhTW,
      'eng': en,
      'jpn': ja,
      'kor': ko,
      'off': none,
      'no': none,
      'disable': none,
    };
    final mapped = alias[low];
    if (mapped != null) return mapped;
    return options.contains(v) ? v : auto;
  }

  /// 从字幕文件名 / 语言标签推断规范语言码；识别不出返回 [auto]。
  static String infer(String? rawName) {
    final raw = (rawName ?? '').toLowerCase().trim();
    if (raw.isEmpty) return auto;
    // 只剥离真正的字幕扩展名，保留 .chs / .eng 这类语言后缀
    final base = raw.replaceAll(_extRe, '');
    final tokens = base.split(_sepRe).where((t) => t.isNotEmpty).toSet();

    // 1) 繁体优先（避免 zh 被误判成简体）
    if (base.contains('hant') ||
        tokens.contains('cht') ||
        tokens.contains('tc') ||
        tokens.contains('big5') ||
        tokens.contains('tw') ||
        tokens.contains('hk') ||
        _twRe.hasMatch(base)) {
      return zhTW;
    }
    // 2) 简体
    if (base.contains('hans') ||
        tokens.contains('chs') ||
        tokens.contains('chi') ||
        tokens.contains('sc') ||
        tokens.contains('cn') ||
        tokens.contains('sg') ||
        tokens.contains('gb') ||
        tokens.contains('gbk') ||
        _cnRe.hasMatch(base)) {
      return zhCN;
    }
    // 3) 裸 zh / chinese（无法区分简繁，保守按简体）
    if (tokens.contains('zh') ||
        tokens.contains('zho') ||
        tokens.contains('chinese')) {
      return zhCN;
    }
    // 4) 英文
    if (tokens.contains('en') ||
        tokens.contains('eng') ||
        tokens.contains('english') ||
        _enRe.hasMatch(base)) {
      return en;
    }
    // 5) 日文
    if (tokens.contains('ja') ||
        tokens.contains('jp') ||
        tokens.contains('jpn') ||
        tokens.contains('japanese') ||
        _jaRe.hasMatch(base)) {
      return ja;
    }
    // 6) 韩文
    if (tokens.contains('ko') ||
        tokens.contains('kr') ||
        tokens.contains('kor') ||
        tokens.contains('korean') ||
        _koRe.hasMatch(base)) {
      return ko;
    }
    return auto;
  }

  /// 设置页下拉项展示文案的 i18n key。
  static String labelKey(String code) {
    switch (code) {
      case none:
        return 'video_subtitle_lang_none';
      case zhCN:
        return 'video_subtitle_lang_zh_cn';
      case zhTW:
        return 'video_subtitle_lang_zh_tw';
      case en:
        return 'video_subtitle_lang_en';
      case ja:
        return 'video_subtitle_lang_ja';
      case ko:
        return 'video_subtitle_lang_ko';
      default:
        return 'video_subtitle_lang_auto';
    }
  }
}
