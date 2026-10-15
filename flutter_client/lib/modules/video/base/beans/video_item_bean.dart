class VideoHomeItemBean {
  final int id;
  final String mediaType;
  final String path;
  final String filename;
  final String firstFilePath;
  final String nfoName;
  final int nfoYear;
  final double nfoScore;
  final String nfoRegions;
  final String nfoGenres;
  final String posterPath;
  final String fanartPath;
  final String logoPath;
  final double progress;
  final bool isFavorite;
  final String? viewTime;
  final String? createTime;
  final String fullPath;
  final String playFilePath;

  /// 图片库 / 混合库网格需要：扩展名、是否文件、原始宽高与时长
  final String ext;
  final bool isFile;
  final int width;
  final int height;
  final int duration;

  /// ⭐ 日本片标记（2026-10-12）。
  ///
  /// 服务端在写 `video_index` 时从**文件名后缀**解析：
  /// `-U` = 无码、`-C` = 中文字幕、`-UC` = 两者都有。
  /// 只有开了「日本电影」开关的库才在 UI 上显示对应徽章 / 筛选。
  final bool jpUncensored;
  final bool jpChineseSub;

  /// 图片条目：图片库与混合库里按图片渲染
  bool get isImage => mediaType == 'image';

  /// 是否有任何日本片标记（两个徽章一个都不显示时可以整块跳过）
  bool get hasJpTags => jpUncensored || jpChineseSub;

  const VideoHomeItemBean({
    required this.id,
    required this.mediaType,
    required this.path,
    required this.filename,
    required this.firstFilePath,
    required this.nfoName,
    required this.nfoYear,
    required this.nfoScore,
    required this.nfoRegions,
    required this.nfoGenres,
    required this.posterPath,
    required this.fanartPath,
    required this.logoPath,
    required this.progress,
    this.isFavorite = false,
    required this.viewTime,
    required this.createTime,
    required this.fullPath,
    this.playFilePath = '',
    this.ext = '',
    this.isFile = false,
    this.width = 0,
    this.height = 0,
    this.duration = 0,
    this.jpUncensored = false,
    this.jpChineseSub = false,
  });

  VideoHomeItemBean copyWith({
    int? id,
    String? mediaType,
    String? path,
    String? filename,
    String? firstFilePath,
    String? nfoName,
    int? nfoYear,
    double? nfoScore,
    String? nfoRegions,
    String? nfoGenres,
    String? posterPath,
    String? fanartPath,
    String? logoPath,
    double? progress,
    bool? isFavorite,
    String? viewTime,
    String? createTime,
    String? fullPath,
    String? playFilePath,
  }) {
    return VideoHomeItemBean(
      id: id ?? this.id,
      mediaType: mediaType ?? this.mediaType,
      path: path ?? this.path,
      filename: filename ?? this.filename,
      firstFilePath: firstFilePath ?? this.firstFilePath,
      nfoName: nfoName ?? this.nfoName,
      nfoYear: nfoYear ?? this.nfoYear,
      nfoScore: nfoScore ?? this.nfoScore,
      nfoRegions: nfoRegions ?? this.nfoRegions,
      nfoGenres: nfoGenres ?? this.nfoGenres,
      posterPath: posterPath ?? this.posterPath,
      fanartPath: fanartPath ?? this.fanartPath,
      logoPath: logoPath ?? this.logoPath,
      progress: progress ?? this.progress,
      isFavorite: isFavorite ?? this.isFavorite,
      viewTime: viewTime ?? this.viewTime,
      createTime: createTime ?? this.createTime,
      fullPath: fullPath ?? this.fullPath,
      playFilePath: playFilePath ?? this.playFilePath,
      ext: ext,
      isFile: isFile,
      width: width,
      height: height,
      duration: duration,
      jpUncensored: jpUncensored,
      jpChineseSub: jpChineseSub,
    );
  }

  factory VideoHomeItemBean.fromJson(Map<String, dynamic> json) {
    final rawFav = json['is_favorite'];
    final isFav = rawFav == true || rawFav == 1 || rawFav == '1';
    final rawIsFile = json['is_file'];
    return VideoHomeItemBean(
      id: (json['id'] as num?)?.toInt() ?? 0,
      mediaType: (json['media_type'] as String?) ?? '',
      path: (json['path'] as String?) ?? '',
      filename: (json['filename'] as String?) ?? '',
      firstFilePath:
          (json['first_file_path'] ?? json['firstFilePath'])?.toString() ?? '',
      fullPath: (json['full_path'] ?? json['full_path'])?.toString() ?? '',
      playFilePath:
          (json['play_file_path'] ?? json['playFilePath'])?.toString() ?? '',
      nfoName: (json['nfo_name'] as String?) ?? '',
      nfoYear: (json['nfo_year'] as num?)?.toInt() ?? 0,
      nfoScore: (json['nfo_score'] as num?)?.toDouble() ?? 0,
      nfoRegions: (json['nfo_regions'] as String?) ?? '',
      nfoGenres: (json['nfo_genres'] as String?) ?? '',
      posterPath: (json['poster_path'] as String?) ?? '',
      fanartPath: (json['fanart_path'] as String?) ?? '',
      logoPath: (json['logo_path'] as String?) ?? '',
      progress: (json['progress'] as num?)?.toDouble() ?? 0,
      isFavorite: isFav,
      viewTime: json['view_time']?.toString(),
      createTime: json['create_time']?.toString(),
      ext: (json['ext']?.toString() ?? '').trim(),
      isFile: rawIsFile == true || rawIsFile == 1 || rawIsFile == '1',
      width: (json['width'] as num?)?.toInt() ?? 0,
      height: (json['height'] as num?)?.toInt() ?? 0,
      duration: (json['duration'] as num?)?.toInt() ?? 0,
      jpUncensored: json['jp_uncensored'] == true ||
          json['jp_uncensored'] == 1 ||
          json['jp_uncensored'] == '1',
      jpChineseSub: json['jp_chinese_sub'] == true ||
          json['jp_chinese_sub'] == 1 ||
          json['jp_chinese_sub'] == '1',
    );
  }
}
