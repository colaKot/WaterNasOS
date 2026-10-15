import 'api.dart';

/// NAS 侧目录浏览。只用到「列目录」这一件事，直接复用主客户端的 `/api/file/list`：
///
/// - `path` 传空 ⇒ 返回**当前账号可见的根目录**（授权路径 ∪ 用户共享文件夹 ∪ 自定义路径），
///   权限过滤在服务端完成，不会泄露别人的目录；
/// - `path` 传具体目录 ⇒ 返回其子目录。
///
/// 同步任务里的「NAS 目录」就是这个接口给出的路径，选中后由 `/api/sync/probe` 或保存时的
/// upsert 去校验存在性与权限。
class FileApiService {
  FileApiService._();

  static final FileApiService instance = FileApiService._();

  /// 列出 [path] 下的子文件夹；[path] 为空表示取账号的根目录列表。
  Future<ApiResponse<DirListing>> listDirs({String path = ''}) async {
    final res = await SyncHttp.post(
      '/api/file/list',
      body: {'path': path, 'onlyDir': 'true'},
    );
    if (!res.success) {
      return ApiResponse<DirListing>.failure(
        res.message ?? 'operation_failed',
        code: res.code,
        apiErrorKey: res.apiErrorKey,
      );
    }
    return ApiResponse<DirListing>(
      success: true,
      data: DirListing.fromData(res.data ?? const <String, dynamic>{}),
      code: res.code,
    );
  }
}

/// 一次目录列出的结果。
class DirListing {
  const DirListing({required this.base, required this.sep, required this.dirs});

  /// 当前所在目录；根列表时为空串。
  final String base;

  /// 服务端路径分隔符（Windows 下为 `\`）。
  final String sep;

  /// 子目录（已按名称排序，服务端排好的）。
  final List<DirEntry> dirs;

  bool get isRoot => base.isEmpty;

  factory DirListing.fromData(Map<String, dynamic> data) {
    final rawItems = data['items'];
    final entries = <DirEntry>[];
    if (rawItems is List) {
      for (final it in rawItems) {
        if (it is! Map) continue;
        // 只收目录：服务端 type 为 'dir' 表示文件夹，其余是文件类型（pdf/mp4…）
        if (it['type']?.toString() != 'dir') continue;
        final p = it['path']?.toString() ?? '';
        if (p.isEmpty) continue;
        entries.add(DirEntry(name: it['name']?.toString() ?? p, path: p));
      }
    }
    final rawSep = data['sep']?.toString() ?? '';
    return DirListing(
      base: data['base']?.toString() ?? '',
      sep: rawSep.isEmpty ? '\\' : rawSep,
      dirs: entries,
    );
  }

  /// 上一级目录路径。
  ///
  /// 返回空串表示「回到根列表」，返回 `null` 表示当前已经在根列表（没有上一级）。
  String? parent() {
    var b = base;
    if (b.isEmpty) return null;
    // 去掉结尾的分隔符，避免 `C:\` 这种被拆成空串
    while (b.isNotEmpty && b.endsWith(sep)) {
      b = b.substring(0, b.length - sep.length);
    }
    final idx = b.lastIndexOf(sep);
    if (idx < 0) return ''; // 例如 `C:` 或 `/mnt` ⇒ 回到根列表
    var up = b.substring(0, idx);
    if (up.isEmpty) return '';
    if (up.endsWith(':')) up = '$up$sep'; // `C:` ⇒ `C:\`
    return up;
  }
}

/// 目录条目。
class DirEntry {
  const DirEntry({required this.name, required this.path});

  final String name;
  final String path;
}
