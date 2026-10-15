import 'package:flutter/material.dart';
import 'package:get/get.dart';

import '../core/file_api.dart';

/// 打开 NAS 目录选择器，返回选中的目录路径；用户取消则返回 null。
///
/// [initialPath] 非空时直接下钻到该目录，方便「编辑已有任务」时定位。
Future<String?> showRemoteDirPicker(
  BuildContext context, {
  String? initialPath,
}) {
  return showDialog<String>(
    context: context,
    builder: (_) =>
        _RemoteDirPickerDialog(initialPath: (initialPath ?? '').trim()),
  );
}

/// 逐级下钻的目录浏览器。
///
/// 数据全部来自 [FileApiService]（服务端 `/api/file/list`）：
/// 根列表 = 当前账号可见的目录，所以这里天然只出现「这个账号可用的地址」。
class _RemoteDirPickerDialog extends StatefulWidget {
  const _RemoteDirPickerDialog({required this.initialPath});

  final String initialPath;

  @override
  State<_RemoteDirPickerDialog> createState() => _RemoteDirPickerDialogState();
}

class _RemoteDirPickerDialogState extends State<_RemoteDirPickerDialog> {
  DirListing? _listing;
  bool _loading = true;
  String? _error;

  @override
  void initState() {
    super.initState();
    _load(widget.initialPath);
  }

  Future<void> _load(String path) async {
    setState(() {
      _loading = true;
      _error = null;
    });
    final res = await FileApiService.instance.listDirs(path: path);
    if (!mounted) return;
    setState(() {
      _loading = false;
      if (res.success && res.data != null) {
        _listing = res.data;
        _error = null;
      } else {
        _error = res.message ?? 'sync_browse_load_failed'.tr;
      }
    });
  }

  void _goUp() {
    final up = _listing?.parent();
    if (up == null) return;
    _load(up);
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final listing = _listing;
    final base = listing?.base ?? '';
    final canPick = base.isNotEmpty && !_loading && _error == null;

    return AlertDialog(
      title: Text('sync_browse_title'.tr),
      content: SizedBox(
        width: 540,
        height: 400,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                IconButton(
                  onPressed: _loading || listing == null || listing.isRoot
                      ? null
                      : _goUp,
                  icon: const Icon(Icons.arrow_upward, size: 18),
                  tooltip: 'sync_browse_parent'.tr,
                  visualDensity: VisualDensity.compact,
                ),
                const SizedBox(width: 4),
                Expanded(
                  child: Text(
                    base.isEmpty ? 'sync_remote_roots'.tr : base,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: theme.textTheme.bodyMedium?.copyWith(
                      fontWeight: FontWeight.w500,
                    ),
                  ),
                ),
              ],
            ),
            const Divider(height: 12),
            Expanded(child: _buildBody(theme, scheme)),
          ],
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(),
          child: Text('cancel'.tr),
        ),
        FilledButton(
          onPressed: canPick ? () => Navigator.of(context).pop(base) : null,
          child: Text('sync_select_this_dir'.tr),
        ),
      ],
    );
  }

  Widget _buildBody(ThemeData theme, ColorScheme scheme) {
    if (_loading) {
      return const Center(
        child: SizedBox(
          width: 22,
          height: 22,
          child: CircularProgressIndicator(strokeWidth: 2),
        ),
      );
    }

    if (_error != null) {
      return Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(
              _error!,
              textAlign: TextAlign.center,
              style: theme.textTheme.bodySmall?.copyWith(
                color: scheme.error,
              ),
            ),
            const SizedBox(height: 10),
            OutlinedButton.icon(
              onPressed: () => _load(_listing?.base ?? widget.initialPath),
              icon: const Icon(Icons.refresh, size: 16),
              label: Text('retry'.tr),
            ),
          ],
        ),
      );
    }

    final dirs = _listing?.dirs ?? const <DirEntry>[];
    if (dirs.isEmpty) {
      return Center(
        child: Text(
          'sync_browse_empty'.tr,
          style: theme.textTheme.bodySmall?.copyWith(
            color: scheme.onSurface.withOpacity(0.6),
          ),
        ),
      );
    }

    return ListView.builder(
      itemCount: dirs.length,
      itemBuilder: (context, index) {
        final dir = dirs[index];
        return ListTile(
          dense: true,
          leading: Icon(Icons.folder_outlined, size: 20, color: scheme.primary),
          title: Text(
            dir.name,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
          ),
          onTap: () => _load(dir.path),
        );
      },
    );
  }
}
