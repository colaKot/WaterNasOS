/// 时间轴日期item
class TimelineDateItem {
  final String originalDate;
  final int count;

  TimelineDateItem({required this.originalDate, required this.count});

  factory TimelineDateItem.fromJson(Map<String, dynamic> json) {
    return TimelineDateItem(
      originalDate: json['original_date'] ?? '',
      count: _asInt(json['date_photo_count']),
    );
  }

  static int _asInt(dynamic value) {
    if (value is int) return value;
    if (value is double) return value.toInt();
    return int.tryParse(value?.toString() ?? '') ?? 0;
  }
}

class TimelinePhotoItem {
  final int id;
  final String path;
  final String filename;
  final int size;
  final int isLvp;
  final int isMergeLvp;
  final int type;
  final int width;
  final int height;
  final String originalDate;
  final String originalTime;
  final String fullpath;
  final int duration;
  final String fileHash;
  final bool isFavorite;
  final String liveFilename;
  final String rawFilename;
  final String rawShowExt;

  TimelinePhotoItem({
    required this.id,
    required this.path,
    required this.filename,
    this.size = 0,
    required this.isLvp,
    this.isMergeLvp = 0,
    required this.type,
    required this.width,
    required this.height,
    required this.originalDate,
    required this.originalTime,
    required this.fullpath,
    required this.duration,
    required this.fileHash,
    required this.isFavorite,
    this.liveFilename = '',
    this.rawFilename = '',
    this.rawShowExt = '',
  });

  factory TimelinePhotoItem.fromJson(Map<String, dynamic> json) {
    return TimelinePhotoItem(
      id: TimelineDateItem._asInt(json['id']),
      path: json['path'] ?? '',
      filename: json['filename'] ?? '',
      size: TimelineDateItem._asInt(json['size'] ?? json['file_size']),
      isLvp: TimelineDateItem._asInt(json['is_lvp']),
      isMergeLvp: TimelineDateItem._asInt(json['is_merge_lvp']),
      type: TimelineDateItem._asInt(json['type']),
      width: TimelineDateItem._asInt(json['width']),
      height: TimelineDateItem._asInt(json['height']),
      originalDate: json['original_date'] ?? '',
      originalTime: json['original_time']?.toString() ?? '',
      fullpath: json['fullpath'] ?? '',
      duration: json['duration'] != null
          ? TimelineDateItem._asInt(json['duration'])
          : 0,
      fileHash: json['file_hash'] ?? '',
      isFavorite: TimelineDateItem._asInt(json['is_favorite']) == 1,
      liveFilename: json['live_filename'] ?? '',
      rawFilename: json['raw_filename'] ?? '',
      rawShowExt: json['raw_show_ext'] ?? '',
    );
  }

  TimelinePhotoItem copyWith({
    int? id,
    String? path,
    String? filename,
    int? size,
    int? isLvp,
    int? type,
    int? width,
    int? height,
    String? originalDate,
    String? originalTime,
    String? fullpath,
    int? duration,
    String? fileHash,
    bool? isFavorite,
    String? liveFilename,
    String? rawFilename,
    String? rawShowExt,
  }) {
    return TimelinePhotoItem(
      id: id ?? this.id,
      path: path ?? this.path,
      filename: filename ?? this.filename,
      size: size ?? this.size,
      isLvp: isLvp ?? this.isLvp,
      type: type ?? this.type,
      width: width ?? this.width,
      height: height ?? this.height,
      originalDate: originalDate ?? this.originalDate,
      originalTime: originalTime ?? this.originalTime,
      fullpath: fullpath ?? this.fullpath,
      duration: duration ?? this.duration,
      fileHash: fileHash ?? this.fileHash,
      isFavorite: isFavorite ?? this.isFavorite,
      liveFilename: liveFilename ?? this.liveFilename,
      rawFilename: rawFilename ?? this.rawFilename,
      rawShowExt: rawShowExt ?? this.rawShowExt,
    );
  }
}

class TimelinePathItem {
  final String path;
  final bool valid;

  TimelinePathItem({required this.path, required this.valid});

  factory TimelinePathItem.fromJson(Map<String, dynamic> json) {
    return TimelinePathItem(
      path: json['path'] ?? '',
      valid: json['valid'] ?? false,
    );
  }
}

class TimelineDetectedFaceItem {
  final int faceId;
  final int faceCount;
  final String? name;
  final bool isHide;

  TimelineDetectedFaceItem({
    required this.faceId,
    required this.faceCount,
    this.name,
    this.isHide = false,
  });

  factory TimelineDetectedFaceItem.fromJson(Map<String, dynamic> json) {
    return TimelineDetectedFaceItem(
      faceId: TimelineDateItem._asInt(json['face_id'] ?? json['faceId']),
      faceCount: TimelineDateItem._asInt(
        json['face_count'] ?? json['faceCount'],
      ),
      name: json['name']?.toString(),
      isHide: TimelineDateItem._asInt(json['is_hide'] ?? json['isHide']) == 1,
    );
  }
}

class TimelineDateListResult {
  final List<TimelineDateItem> items;
  final List<TimelinePathItem> validPaths;

  TimelineDateListResult({required this.items, required this.validPaths});
}

class TimelineDateInfo {
  final String originalDate;
  final String geo;
  final String camera;

  TimelineDateInfo({
    required this.originalDate,
    required this.geo,
    required this.camera,
  });

  factory TimelineDateInfo.fromJson(Map<String, dynamic> json) {
    return TimelineDateInfo(
      originalDate: json['original_date'] ?? '',
      geo: json['geo'] ?? '',
      camera: json['camera'] ?? '',
    );
  }
}

class TimelinePhotoListResult {
  final List<TimelinePhotoItem> photoList;
  final List<TimelineDateInfo> dateInfoList;

  TimelinePhotoListResult({
    required this.photoList,
    required this.dateInfoList,
  });
}

class TimelineYearItem {
  final int year;
  final int count;
  final TimelinePhotoItem cover;

  TimelineYearItem({
    required this.year,
    required this.count,
    required this.cover,
  });

  factory TimelineYearItem.fromJson(Map<String, dynamic> json) {
    return TimelineYearItem(
      year: TimelineDateItem._asInt(json['year']),
      count: TimelineDateItem._asInt(json['count']),
      cover: TimelinePhotoItem.fromJson(
        (json['cover'] as Map?)?.cast<String, dynamic>() ??
            const <String, dynamic>{},
      ),
    );
  }
}

class TimelineYearListResult {
  final List<TimelineYearItem> items;
  TimelineYearListResult({required this.items});
}

/// 单次拉取照片列表接口后的处理结果。
///
/// 该结果主要用于：
/// - 决定是否还有更多数据（根据 `incomingCount` 与分页大小对比）
/// - 识别本次是否真正“新增”了数据（`addedCount`），避免陷入重复拉取
class FetchResult {
  final bool hasData;
  final int incomingCount;
  final int addedCount;

  const FetchResult({
    required this.hasData,
    required this.incomingCount,
    required this.addedCount,
  });
}


/// ⭐ 2026-10-16 P0-1：搜索语义解析结果（**只解析、不查库**）。
///
/// 时间轴搜索框原本把关键词直接扔给服务端，用户看不到「系统猜到了什么」。
/// 语义是猜出来的：不把猜的过程摊开，用户搜不到时就无法判断
/// 「该换个说法」还是「库里确实没有」。这里承载提示条要用的三个列表。
class PhotoSearchActivity {
  final String actKey;
  final String actName;
  final int photoCount;

  const PhotoSearchActivity({
    required this.actKey,
    required this.actName,
    required this.photoCount,
  });

  factory PhotoSearchActivity.fromJson(Map<String, dynamic> json) {
    return PhotoSearchActivity(
      actKey: json['act_key']?.toString() ?? '',
      actName: json['act_name']?.toString() ?? '',
      photoCount: (json['photo_count'] as num?)?.toInt() ?? 0,
    );
  }
}

class PhotoSearchParseResult {
  /// 语义解析层（词表 / 短语嵌入）是否可用；不可用时只剩字面匹配。
  final bool available;
  final List<String> tags;
  final List<String> unmatched;

  /// 活动维度命中（独立于场景标签，见服务端 tablePhotoActivity.js）。
  final List<PhotoSearchActivity> activities;

  const PhotoSearchParseResult({
    required this.available,
    required this.tags,
    required this.unmatched,
    required this.activities,
  });

  static const PhotoSearchParseResult empty = PhotoSearchParseResult(
    available: false,
    tags: <String>[],
    unmatched: <String>[],
    activities: <PhotoSearchActivity>[],
  );

  bool get isEmpty =>
      tags.isEmpty && unmatched.isEmpty && activities.isEmpty;

  factory PhotoSearchParseResult.fromJson(Map<String, dynamic> json) {
    final tagsRaw = json['tags'];
    final unmatchedRaw = json['unmatched'];
    final actsRaw = json['activities'];
    return PhotoSearchParseResult(
      available: json['available'] == true,
      tags: tagsRaw is List
          ? tagsRaw
              .map((e) => e.toString())
              .where((e) => e.isNotEmpty)
              .toList()
          : <String>[],
      unmatched: unmatchedRaw is List
          ? unmatchedRaw
              .map((e) => e.toString())
              .where((e) => e.isNotEmpty)
              .toList()
          : <String>[],
      activities: actsRaw is List
          ? actsRaw
              .whereType<Map>()
              .map((e) =>
                  PhotoSearchActivity.fromJson(e.cast<String, dynamic>()))
              .toList()
          : <PhotoSearchActivity>[],
    );
  }
}

/// ⭐ 2026-10-16 P0-4：一条搜索联想建议。
///
/// `type` 取值：person / scene / activity / camera / filename / ocr / year。
/// 计数一律是**当前用户可见范围**内的张数（聚合表里的 photo_count 是全库口径，
/// 直接展示会把别人相册的规模漏给普通用户）。
class PhotoSearchSuggestion {
  final String type;
  final String label;
  final int count;
  final int? faceId;

  const PhotoSearchSuggestion({
    required this.type,
    required this.label,
    required this.count,
    this.faceId,
  });

  factory PhotoSearchSuggestion.fromJson(Map<String, dynamic> json) {
    final fid = json['face_id'];
    return PhotoSearchSuggestion(
      type: json['type']?.toString() ?? '',
      label: json['label']?.toString() ?? '',
      count: (json['count'] as num?)?.toInt() ?? 0,
      faceId: fid is num ? fid.toInt() : null,
    );
  }
}

/// ⭐ 2026-10-16 P0-2：一个「合影组合」——同一组人反复同框的照片堆。
class PhotoPeerGroup {
  final String comboKey;
  final List<int> memberFaceIds;
  final List<String> memberNames;
  final int namedCount;
  final int photoCount;
  final String coverFileHash;

  /// 封面图的完整路径（服务端直接给出，客户端拼缩略图 URL 用）。
  final String coverPath;

  const PhotoPeerGroup({
    required this.comboKey,
    required this.memberFaceIds,
    required this.memberNames,
    required this.namedCount,
    required this.photoCount,
    required this.coverFileHash,
    this.coverPath = '',
  });

  factory PhotoPeerGroup.fromJson(Map<String, dynamic> json) {
    final idsRaw = json['member_face_ids'];
    final namesRaw = json['member_names'];
    return PhotoPeerGroup(
      comboKey: json['combo_key']?.toString() ?? '',
      memberFaceIds: idsRaw is List
          ? idsRaw.map((e) => (e as num).toInt()).toList()
          : <int>[],
      memberNames: namesRaw is List
          ? namesRaw.map((e) => e.toString()).toList()
          : <String>[],
      namedCount: (json['named_count'] as num?)?.toInt() ?? 0,
      photoCount: (json['photo_count'] as num?)?.toInt() ?? 0,
      coverFileHash: json['cover_file_hash']?.toString() ?? '',
      coverPath: json['cover_path']?.toString() ?? '',
    );
  }

  /// 成员展示名：未命名的按「未命名」占位，但**同名要去重**，
  /// 否则会渲染出「未命名、未命名」这种没有信息量的标题。
  List<String> get displayNames {
    final seen = <String>{};
    final out = <String>[];
    for (var i = 0; i < memberFaceIds.length; i++) {
      final raw = i < memberNames.length ? memberNames[i].trim() : '';
      final label = raw.isEmpty ? '未命名' : raw;
      if (seen.add(label)) out.add(label);
    }
    return out;
  }
}

class PhotoPeerGroupResult {
  final List<PhotoPeerGroup> items;
  final int total;
  final bool faceEnable;

  const PhotoPeerGroupResult({
    required this.items,
    required this.total,
    this.faceEnable = true,
  });

  factory PhotoPeerGroupResult.fromJson(Map<String, dynamic> json) {
    final raw = json['items'];
    return PhotoPeerGroupResult(
      items: raw is List
          ? raw
              .whereType<Map>()
              .map((e) => PhotoPeerGroup.fromJson(e.cast<String, dynamic>()))
              .toList()
          : <PhotoPeerGroup>[],
      total: (json['total'] as num?)?.toInt() ?? 0,
      faceEnable: json['face_enable'] != 0,
    );
  }
}
