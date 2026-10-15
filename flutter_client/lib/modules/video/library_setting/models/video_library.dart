import 'package:flutter/material.dart';
import 'package:get/get.dart';

/// 影视库类型（创建后不可修改）
/// movie 电影 / tv 影视剧 / image 图片 / mixed 图片与影视混合
const List<String> kVideoLibTypes = <String>['movie', 'tv', 'image', 'mixed'];

class VideoLibrary {
  final int id;
  final String name;
  final String nameKey;
  final String libType;
  final bool isDefault;

  /// 是否在影视主页显示该库分类（只有内置电影/电视剧默认开启）
  final bool showInHome;

  /// 音频响度归一化：开启后扫描/重扫该库时测量音频响度，播放转码时对齐音量
  final bool audioNormalize;

  /// ⭐ 日本电影库（2026-10-12）。
  ///
  /// 开了以后：列表页封面右上角显示「中 / 无码」徽章，并开放
  /// 分辨率 / 无码 / 中文字幕 那组筛选。标记来自扫描时解析的文件名后缀
  /// （`-U` 无码 / `-C` 中文字幕 / `-UC` 两者）。
  final bool jpMovie;
  final int sort;
  final int sourceCount;
  final int movieCount;
  final int tvCount;
  final int imageCount;
  final int totalCount;

  const VideoLibrary({
    required this.id,
    required this.name,
    required this.nameKey,
    required this.libType,
    required this.isDefault,
    required this.showInHome,
    required this.audioNormalize,
    this.jpMovie = false,
    required this.sort,
    required this.sourceCount,
    required this.movieCount,
    required this.tvCount,
    required this.imageCount,
    required this.totalCount,
  });

  /// 内置库（未改名时）优先用多语言名，改名后 name_key 置空则用用户填的名字
  String get displayName {
    final k = nameKey.trim();
    if (k.isNotEmpty) {
      final translated = k.tr;
      if (translated.isNotEmpty && translated != k) return translated;
    }
    final n = name.trim();
    if (n.isNotEmpty) return n;
    return k;
  }

  bool get isImageOnly => libType == 'image';

  /// 图片与影视混合：列表里同时有图片和视频
  bool get isMixed => libType == 'mixed';

  /// 图片库和混合库都用「网格 + 竖向全屏浏览」的展示方式
  bool get isMediaGridLib => isImageOnly || isMixed;

  bool get isVideoLib => libType == 'movie' || libType == 'tv';

  /// ⭐ 局部更新（2026-10-09）。
  ///
  /// ⛔ 不要手写 `libraries[idx] = VideoLibrary(id: …, name: …)` 来改单个字段 ——
  /// 字段多起来必漏，而且漏一个就是静默 bug（用户已踩过：切「主页显示」
  /// 只改 showInHome，结果整条记录被清空）。
  VideoLibrary copyWith({
    int? id,
    String? name,
    String? nameKey,
    String? libType,
    bool? isDefault,
    bool? showInHome,
    bool? audioNormalize,
    bool? jpMovie,
    int? sort,
    int? sourceCount,
    int? movieCount,
    int? tvCount,
    int? imageCount,
    int? totalCount,
  }) {
    return VideoLibrary(
      id: id ?? this.id,
      name: name ?? this.name,
      nameKey: nameKey ?? this.nameKey,
      libType: libType ?? this.libType,
      isDefault: isDefault ?? this.isDefault,
      showInHome: showInHome ?? this.showInHome,
      audioNormalize: audioNormalize ?? this.audioNormalize,
      jpMovie: jpMovie ?? this.jpMovie,
      sort: sort ?? this.sort,
      sourceCount: sourceCount ?? this.sourceCount,
      movieCount: movieCount ?? this.movieCount,
      tvCount: tvCount ?? this.tvCount,
      imageCount: imageCount ?? this.imageCount,
      totalCount: totalCount ?? this.totalCount,
    );
  }

  factory VideoLibrary.fromJson(Map<String, dynamic> json) {
    final countsRaw = json['counts'];
    final counts = countsRaw is Map
        ? countsRaw.cast<String, dynamic>()
        : const <String, dynamic>{};
    int asInt(dynamic v) =>
        v is num ? v.toInt() : int.tryParse(v?.toString() ?? '') ?? 0;

    final isDefaultRaw = json['is_default'];
    final isDefault =
        isDefaultRaw == true || isDefaultRaw == 1 || isDefaultRaw == '1';

    final showInHomeRaw = json['show_in_home'];
    final showInHome = showInHomeRaw == true ||
        showInHomeRaw == 1 ||
        showInHomeRaw == '1';

    final audioNormalizeRaw = json['audio_normalize'];
    final audioNormalize = audioNormalizeRaw == true ||
        audioNormalizeRaw == 1 ||
        audioNormalizeRaw == '1';

    final jpMovieRaw = json['jp_movie'];
    final jpMovie =
        jpMovieRaw == true || jpMovieRaw == 1 || jpMovieRaw == '1';

    return VideoLibrary(
      id: asInt(json['id']),
      name: (json['name']?.toString() ?? '').trim(),
      nameKey: (json['name_key']?.toString() ?? '').trim(),
      libType: (json['lib_type']?.toString() ?? 'movie').trim(),
      isDefault: isDefault,
      showInHome: showInHome,
      audioNormalize: audioNormalize,
      jpMovie: jpMovie,
      sort: asInt(json['sort']),
      sourceCount: asInt(json['source_count']),
      movieCount: asInt(counts['movie']),
      tvCount: asInt(counts['tv']),
      imageCount: asInt(counts['image']),
      totalCount: asInt(counts['total']),
    );
  }
}

/// 影视库类型的展示名与图标由 UI 层按 key 翻译：[libTypeLabelKey]
String libTypeLabelKey(String libType) {
  switch (libType) {
    case 'tv':
      return 'video_library_type_tv';
    case 'image':
      return 'video_library_type_image';
    case 'mixed':
      return 'video_library_type_mixed';
    case 'movie':
    default:
      return 'video_library_type_movie';
  }
}

/// 左侧栏栏目图标
IconData libTypeIcon(String libType) {
  switch (libType) {
    case 'tv':
      return Icons.tv_outlined;
    case 'image':
      return Icons.image_outlined;
    case 'mixed':
      return Icons.collections_outlined;
    case 'movie':
    default:
      return Icons.movie_filter_outlined;
  }
}
