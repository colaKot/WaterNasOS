import 'dart:io' show Platform;
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:get/get.dart';
import 'package:photo_manager/photo_manager.dart' as pm;
import 'package:wechat_assets_picker/wechat_assets_picker.dart'
    show PathWrapper, SortPathDelegate;

import '../controller/photo_backup_controller.dart';

/// 相册备份：**多选**相册页。
///
/// - 默认全选（本机所有相册）；
/// - 顶部「全选」一键全选 / 全不选；
/// - 返回 null 表示用户取消；返回空列表等价于「全部」。
class PhotoBackupAlbumPickerPage extends StatefulWidget {
  /// 当前已选相册 id；为空表示「全部」（进入即全选）。
  final List<String> selectedIds;

  const PhotoBackupAlbumPickerPage({
    super.key,
    this.selectedIds = const <String>[],
  });

  @override
  State<PhotoBackupAlbumPickerPage> createState() =>
      _PhotoBackupAlbumPickerPageState();
}

Future<List<pm.AssetPathEntity>> _loadAlbumPaths() async {
  if (Platform.isAndroid) {
    return pm.PhotoManager.getAssetPathList(
      type: pm.RequestType.common,
      hasAll: true,
      onlyAll: false,
      filterOption: pm.AdvancedCustomFilter(
        orderBy: [pm.OrderByItem.desc(pm.CustomColumns.android.modifiedDate)],
      ),
    );
  }
  return pm.PhotoManager.getAssetPathList(
    type: pm.RequestType.common,
    hasAll: true,
    onlyAll: false,
  );
}

class _AlbumPreview {
  const _AlbumPreview({required this.count, this.thumbBytes});

  final int count;
  final Uint8List? thumbBytes;
}

Future<_AlbumPreview> _loadAlbumPreview(pm.AssetPathEntity path) async {
  final count = await path.assetCountAsync;
  Uint8List? thumb;
  if (count > 0) {
    final assets = await path.getAssetListRange(start: 0, end: 1);
    if (assets.isNotEmpty) {
      final a = assets.single;
      if (a.type == pm.AssetType.image || a.type == pm.AssetType.video) {
        thumb = await a.thumbnailDataWithSize(
          const pm.ThumbnailSize.square(240),
        );
      }
    }
  }
  return _AlbumPreview(count: count, thumbBytes: thumb);
}

class _PhotoBackupAlbumPickerPageState
    extends State<PhotoBackupAlbumPickerPage> {
  late final Future<List<PathWrapper<pm.AssetPathEntity>>> _pathsFuture;
  final Set<String> _selected = <String>{};
  List<pm.AssetPathEntity> _all = const <pm.AssetPathEntity>[];
  bool _selectAll = true;

  @override
  void initState() {
    super.initState();
    _pathsFuture = _preparePaths();
  }

  Future<List<PathWrapper<pm.AssetPathEntity>>> _preparePaths() async {
    // 没有相册权限时 getAssetPathList 只会返回空列表，用户会以为「啥都没有」，
    // 所以先交互式要一次权限，再列相册（2026-10-15）。
    await PhotoBackupController.ensurePhotoPermissionInteractive();
    if (!mounted) return const <PathWrapper<pm.AssetPathEntity>>[];
    final raw = await _loadAlbumPaths();
    final wrappers =
        raw.map((p) => PathWrapper<pm.AssetPathEntity>(path: p)).toList();
    SortPathDelegate.common.sort(wrappers);
    _all = wrappers.map((e) => e.path).toList(growable: false);
    // 默认全选；已选则按已选回显
    if (widget.selectedIds.isEmpty) {
      _selected
        ..clear()
        ..addAll(_all.map((e) => e.id));
      _selectAll = true;
    } else {
      final valid = _all.map((e) => e.id).toSet();
      _selected
        ..clear()
        ..addAll(widget.selectedIds.where(valid.contains));
      _selectAll = _all.isNotEmpty && _selected.length == _all.length;
    }
    return wrappers;
  }

  void _toggleAll() {
    setState(() {
      _selectAll = !_selectAll;
      _selected.clear();
      if (_selectAll) {
        _selected.addAll(_all.map((e) => e.id));
      }
    });
  }

  void _toggleOne(String id) {
    setState(() {
      if (_selected.contains(id)) {
        _selected.remove(id);
      } else {
        _selected.add(id);
      }
      _selectAll = _all.isNotEmpty && _selected.length == _all.length;
    });
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Scaffold(
      appBar: AppBar(
        title: Text('photo_backup_album_select_multi'.tr),
        actions: [
          TextButton(
            onPressed: _toggleAll,
            child: Text(
              _selectAll
                  ? 'photo_backup_unselect_all'.tr
                  : 'photo_backup_select_all'.tr,
            ),
          ),
        ],
      ),
      body: FutureBuilder<List<PathWrapper<pm.AssetPathEntity>>>(
        future: _pathsFuture,
        builder: (context, snapshot) {
          if (snapshot.connectionState != ConnectionState.done) {
            return const Center(child: CircularProgressIndicator());
          }
          if (snapshot.hasError) {
            return Center(
              child: Padding(
                padding: const EdgeInsets.all(24),
                child: Text('${snapshot.error}', textAlign: TextAlign.center),
              ),
            );
          }
          final paths = snapshot.data ?? [];
          if (paths.isEmpty) {
            return Center(child: Text('photo_album_empty'.tr));
          }
          return Column(
            children: [
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 10, 16, 0),
                child: Row(
                  children: [
                    Expanded(
                      child: Text(
                        'photo_backup_selected_count'.trParams({
                          'count': '${_selected.length}',
                        }),
                        style: theme.textTheme.bodySmall?.copyWith(
                          color: theme.colorScheme.onSurfaceVariant,
                        ),
                      ),
                    ),
                  ],
                ),
              ),
              Expanded(
                child: GridView.builder(
                  padding: const EdgeInsets.fromLTRB(12, 8, 12, 24),
                  gridDelegate:
                      const SliverGridDelegateWithFixedCrossAxisCount(
                        crossAxisCount: 2,
                        mainAxisSpacing: 10,
                        crossAxisSpacing: 10,
                        childAspectRatio: 0.82,
                      ),
                  itemCount: paths.length,
                  itemBuilder: (context, index) {
                    final path = paths[index].path;
                    return _AlbumGridTile(
                      path: path,
                      theme: theme,
                      selected: _selected.contains(path.id),
                      onTap: () => _toggleOne(path.id),
                    );
                  },
                ),
              ),
            ],
          );
        },
      ),
      bottomNavigationBar: SafeArea(
        top: false,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(12, 8, 12, 12),
          child: FilledButton(
            onPressed: () {
              final picked = _all
                  .where((e) => _selected.contains(e.id))
                  .toList(growable: false);
              Navigator.of(context).pop(picked);
            },
            child: Text('save'.tr),
          ),
        ),
      ),
    );
  }
}

class _AlbumGridTile extends StatefulWidget {
  const _AlbumGridTile({
    required this.path,
    required this.theme,
    required this.selected,
    required this.onTap,
  });

  final pm.AssetPathEntity path;
  final ThemeData theme;
  final bool selected;
  final VoidCallback onTap;

  @override
  State<_AlbumGridTile> createState() => _AlbumGridTileState();
}

class _AlbumGridTileState extends State<_AlbumGridTile> {
  late final Future<_AlbumPreview> _previewFuture = _loadAlbumPreview(
    widget.path,
  );

  @override
  Widget build(BuildContext context) {
    final theme = widget.theme;
    final selected = widget.selected;
    return Material(
      color: theme.colorScheme.surfaceContainerHighest.withOpacity(0.35),
      borderRadius: BorderRadius.circular(12),
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: widget.onTap,
        child: Stack(
          fit: StackFit.expand,
          children: [
            FutureBuilder<_AlbumPreview>(
              future: _previewFuture,
              builder: (context, snap) {
                final preview = snap.data;
                final bytes = preview?.thumbBytes;
                final countLabel = preview == null ? '…' : '${preview.count}';
                return Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    Expanded(
                      child: bytes != null && bytes.isNotEmpty
                          ? Image.memory(
                              bytes,
                              fit: BoxFit.cover,
                              gaplessPlayback: true,
                            )
                          : ColoredBox(
                              color:
                                  theme.colorScheme.surfaceContainerHighest,
                              child: Icon(
                                Icons.photo_album_outlined,
                                size: 40,
                                color: theme.colorScheme.outline,
                              ),
                            ),
                    ),
                    Padding(
                      padding: const EdgeInsets.fromLTRB(8, 6, 8, 8),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            widget.path.name,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: theme.textTheme.titleSmall?.copyWith(
                              fontWeight: FontWeight.w600,
                            ),
                          ),
                          const SizedBox(height: 2),
                          Text(
                            countLabel,
                            style: theme.textTheme.bodySmall?.copyWith(
                              color: theme.colorScheme.onSurfaceVariant,
                            ),
                          ),
                        ],
                      ),
                    ),
                  ],
                );
              },
            ),
            if (selected)
              Container(
                decoration: BoxDecoration(
                  border: Border.all(
                    color: theme.colorScheme.primary,
                    width: 2,
                  ),
                  borderRadius: BorderRadius.circular(12),
                ),
              ),
            Positioned(
              top: 6,
              right: 6,
              child: Container(
                width: 24,
                height: 24,
                decoration: BoxDecoration(
                  shape: BoxShape.circle,
                  color: selected
                      ? theme.colorScheme.primary
                      : Colors.black.withOpacity(0.25),
                  border: Border.all(color: Colors.white, width: 1.5),
                ),
                child: selected
                    ? const Icon(Icons.check, size: 16, color: Colors.white)
                    : null,
              ),
            ),
          ],
        ),
      ),
    );
  }
}
