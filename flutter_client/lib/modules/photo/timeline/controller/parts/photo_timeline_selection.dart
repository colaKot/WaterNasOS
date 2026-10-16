part of '../photo_timeline_controller.dart';

/// 多选、批量操作、删除后数据同步等逻辑。
extension PhotoTimelineControllerSelection on PhotoTimelineController {
  void startDragSelection(Offset start, {double scrollOffset = 0}) {
    _dragStartViewport = start;
    _dragStartScrollOffset = scrollOffset;
    _dragSelectionBaseline = selectedItems.toSet();
    selectionRect.value = Rect.fromLTWH(start.dx, start.dy, 0, 0);
    selectionRectContent.value = Rect.fromLTWH(
      start.dx,
      start.dy + scrollOffset,
      0,
      0,
    );
  }

  void updateDragSelection(Offset current, {double scrollOffset = 0}) {
    final s = _dragStartViewport;
    if (s == null) return;
    final left = s.dx < current.dx ? s.dx : current.dx;
    final top = s.dy < current.dy ? s.dy : current.dy;
    final width = (s.dx - current.dx).abs();
    final height = (s.dy - current.dy).abs();
    selectionRect.value = Rect.fromLTWH(left, top, width, height);

    final startContentY = s.dy + _dragStartScrollOffset;
    final currentContentY = current.dy + scrollOffset;
    final topContent = startContentY < currentContentY
        ? startContentY
        : currentContentY;
    final heightContent = (startContentY - currentContentY).abs();
    selectionRectContent.value = Rect.fromLTWH(
      left,
      topContent,
      width,
      heightContent,
    );
  }

  void updateDragPreview(Set<int> hitIds, {required bool additive}) {
    final baseline = _dragSelectionBaseline ?? selectedItems.toSet();
    final next = additive ? (baseline.toSet()..addAll(hitIds)) : hitIds;
    selectedItems
      ..clear()
      ..addAll(next);
    selectedItems.refresh();
  }

  void applyDragSelection(
    Set<int> hitIds, {
    required bool multiModeAtStart,
    required bool additive,
  }) {
    final baseline = _dragSelectionBaseline ?? selectedItems.toSet();
    final next = additive ? (baseline.toSet()..addAll(hitIds)) : hitIds;
    selectedItems
      ..clear()
      ..addAll(next);
    selectedItems.refresh();
    if (next.isNotEmpty) {
      if (!isMultiSelectMode.value) isMultiSelectMode.value = true;
    }
    if (next.isEmpty && !multiModeAtStart) {
      isMultiSelectMode.value = false;
    }
  }

  void finishDragSelection() {
    selectionRect.value = null;
    selectionRectContent.value = null;
    _dragStartViewport = null;
    _dragStartScrollOffset = 0;
    _dragSelectionBaseline = null;
  }

  /// 切换多选模式（进入/退出）。
  ///
  /// 退出时会清空选中集合，避免 UI 状态与数据不同步。
  void toggleMultiSelectMode() {
    isMultiSelectMode.value = !isMultiSelectMode.value;
    if (!isMultiSelectMode.value) {
      selectedItems.clear();
    }
  }

  /// 强制退出多选模式并清空选中。
  void exitMultiSelectMode() {
    isMultiSelectMode.value = false;
    selectedItems.clear();
  }

  /// 将选中项转换为文件路径列表（去重、过滤空路径）。
  List<String> _selectedPaths() {
    if (selectedItems.isEmpty) return const [];
    final ids = selectedItems.toSet();

    // 遍历 photoItems 查找选中的 photos
    final paths = <String>{};
    for (final item in photoItems) {
      if (item is TimelineListPhoto) {
        if (ids.contains(item.photo.id)) {
          final p = item.photo.fullpath;
          if (p.trim().isNotEmpty) {
            paths.add(p);
          }
        }
      }
    }
    return paths.toList(growable: false);
  }

  /// 将选中项转换为文件哈希列表
  List<String> _selectedFileHashes() {
    if (selectedItems.isEmpty) return const [];
    final ids = selectedItems.toSet();

    // 遍历 photoItems 查找选中的 photos
    final hashes = <String>{};
    for (final item in photoItems) {
      if (item is TimelineListPhoto) {
        if (ids.contains(item.photo.id)) {
          final h = item.photo.fileHash;
          if (h.isNotEmpty) {
            hashes.add(h);
          }
        }
      }
    }
    return hashes.toList(growable: false);
  }

  List<TimelinePhotoItem> getSelectedPhotoItems() {
    if (selectedItems.isEmpty) return const [];
    final ids = selectedItems.toSet();
    final photos = <TimelinePhotoItem>[];
    for (final item in photoItems) {
      if (item is TimelineListPhoto && ids.contains(item.photo.id)) {
        photos.add(item.photo);
      }
    }
    return photos;
  }

  /// 批量下载选中项。
  Future<void> downloadSelected() async {
    final paths = _selectedPaths();
    if (paths.isEmpty) return;
    if (!Get.isRegistered<DownloadController>()) {
      Get.put(DownloadController(), permanent: true);
    }
    await Get.find<DownloadController>().handleDownload(paths);
  }

  /// 批量收藏选中项。
  Future<void> favoriteSelected() async {
    final hashes = _selectedFileHashes();
    if (hashes.isEmpty) return;
    try {
      final isFavoriteList = listType.value == 'favorite';
      // 如果当前是收藏列表，则执行取消收藏；否则执行添加收藏
      final targetState = !isFavoriteList;

      final ok = await _apiService.batchFavorite(hashes, targetState);
      ToastUtil.show(ok ? 'operation_success'.tr : 'operation_failed'.tr);

      if (ok) {
        if (isFavoriteList) {
          // 如果是收藏列表且执行了取消收藏，直接移除本地项
          // 1. 获取要移除的 ID
          final idsToRemove = selectedItems.toSet();

          // 2. 从 photoItems 中移除，并清理空日期
          _removeItemsAndCleanUp(idsToRemove);
        } else {
          // 如果是普通列表且执行了添加收藏，本地更新状态
          final idsToUpdate = selectedItems.toSet();
          for (int i = 0; i < photoItems.length; i++) {
            final item = photoItems[i];
            if (item is TimelineListPhoto &&
                idsToUpdate.contains(item.photo.id)) {
              final newPhoto = item.photo.copyWith(isFavorite: targetState);
              photoItems[i] = TimelineListPhoto(photo: newPhoto);
            }
          }
        }
      }
      exitMultiSelectMode();
    } catch (_) {
      ToastUtil.show('operation_failed'.tr);
    }
  }

  Future<void> addToAlbumSelected() async {
    final hashes = _selectedFileHashes();
    if (hashes.isEmpty) return;
    try {
      final context = Get.context;
      if (context == null) return;
      PhotoAlbumItem? album;
      if (DeviceUtils.isMobile) {
        album = await Navigator.of(context).push<PhotoAlbumItem>(
          MaterialPageRoute(
            builder: (_) =>
                const AppPhotoAlbumListPage(type: 'all', selectionMode: true),
          ),
        );
      } else {
        album = await showDialog<PhotoAlbumItem>(
          context: context,
          barrierDismissible: true,
          builder: (_) {
            return Dialog(
              insetPadding: const EdgeInsets.all(16),
              child: ConstrainedBox(
                constraints: const BoxConstraints(
                  maxWidth: 980,
                  maxHeight: 720,
                ),
                child: const PhotoAlbumListView(
                  type: 'all',
                  selectionMode: true,
                ),
              ),
            );
          },
        );
      }
      if (album == null) return;

      final res = await PhotoAlbumApiService().addAlbumIndexes(
        albumId: album.id,
        fileHashes: hashes,
      );
      if (res.success) {
        ToastUtil.show('operation_success'.tr);
        exitMultiSelectMode();
      } else {
        ToastUtil.show(res.message ?? 'operation_failed'.tr);
      }
    } catch (_) {
      ToastUtil.show('operation_failed'.tr);
    }
  }

  Future<void> removeFromAlbumSelected() async {
    final currentAlbumId = albumId.value;
    if (currentAlbumId == null) return;
    final hashes = _selectedFileHashes();
    if (hashes.isEmpty) return;
    try {
      final res = await PhotoAlbumApiService().removeAlbumIndexes(
        albumId: currentAlbumId,
        fileHashes: hashes,
      );
      if (res.success) {
        final ids = selectedItems.toSet();
        _removeItemsAndCleanUp(ids);
        exitMultiSelectMode();
        ToastUtil.show('operation_success'.tr);
      } else {
        ToastUtil.show(res.message ?? 'operation_failed'.tr);
      }
    } catch (_) {
      ToastUtil.show('operation_failed'.tr);
    }
  }

  /// 执行删除（放入回收站）并同步本地内存数据结构。
  ///
  /// 同步策略：
  /// 1) 先调用接口将照片放入回收站
  /// 2) 成功后，从 photoItems 中移除
  /// 3) 更新 `dateList` 中对应日期的 `count`（可能导致某天被移除）
  /// 4) 如果某天照片被清空，同时移除 photoItems 中的 header
  Future<void> deleteSelected() async {
    final ids = selectedItems.toList();
    if (ids.isEmpty) return;
    try {
      // ⭐ 2026-10-16 P0-6：先「预演」再执行。
      // 批量删除在 NAS 场景下一按就是几百上千张，此前是**直接执行**、删完就没了；
      // 现在先让用户看到「将移入回收站 N 张 · X MB」，并且执行后 7 天内可撤销。
      final preview = await _apiService.previewTrash(ids);
      final pv = preview.success ? (preview.data ?? <String, dynamic>{}) : <String, dynamic>{};
      final count = (pv['count'] as num?)?.toInt() ?? ids.length;
      final bytes = (pv['bytes'] as num?)?.toInt() ?? 0;
      final confirmed = await DialogUtil.showConfirmDialog(
        title: 'photo_delete_preview_title'.tr,
        content: [
          'photo_delete_preview_photos'.tr + '：' + '$count',
          'photo_delete_preview_size'.tr + '：' + _formatBytes(bytes),
        ].join('\n'),
        confirmText: 'ok'.tr,
        cancelText: 'cancel'.tr,
      );
      if (confirmed != true) return;

      final res = await _apiService.batchTrashLogged(ids);
      if (!res.success) {
        ToastUtil.show(
          (res.code == 403 ? 'permission_denied' : 'operation_failed').tr,
        );
        return;
      }

      final idsSet = selectedItems.toSet();
      final operationId = (res.data?['operationId'] as num?)?.toInt();

      _removeItemsAndCleanUp(idsSet);
      exitMultiSelectMode();

      if (operationId != null && operationId > 0) {
        // 带「撤销」按钮 —— 这是 NAS 场景最需要的安全网
        Get.snackbar(
          'photo_delete_preview_title'.tr,
          'photo_trashed_success'.tr,
          mainButton: TextButton(
            onPressed: () => undoOperation(operationId),
            child: Text('photo_undo'.tr),
          ),
          duration: const Duration(seconds: 8),
        );
      } else {
        ToastUtil.show('photo_trashed_success'.tr);
      }
    } catch (_) {
      ToastUtil.show('operation_failed'.tr);
    }
  }

  /// ⭐ 2026-10-16 P0-6：撤销一次操作（按 operation_id 回滚）。
  Future<void> undoOperation(int operationId) async {
    try {
      final res = await _apiService.undoOperation(operationId);
      if (!res.success) {
        final code = res.code;
        if (code == 409) {
          ToastUtil.show('photo_undo_expired'.tr);
        } else {
          ToastUtil.show('photo_undo_failed'.tr);
        }
        return;
      }
      ToastUtil.show('photo_undo_done'.tr);
      await refreshTimeline();
    } catch (_) {
      ToastUtil.show('photo_undo_failed'.tr);
    }
  }

  /// 把字节数格式化成肉眼可读（KB / MB / GB）。
  String _formatBytes(int bytes) {
    if (bytes <= 0) return '0 KB';
    const units = <String>['B', 'KB', 'MB', 'GB', 'TB'];
    double v = bytes.toDouble();
    int i = 0;
    while (v >= 1024 && i < units.length - 1) {
      v /= 1024;
      i += 1;
    }
    return '${v.toStringAsFixed(v >= 100 || i == 0 ? 0 : 1)} ${units[i]}';
  }


  /// ⭐ 2026-10-16 P1-11 时光对照：找**同一个地方、不同年份、长得像**的照片。
  /// 权重沿用公开口径：视觉相似度 0.7 + GPS 0.15 + 时间跨度 0.15（视觉那一路用 P0-3 落库的 clip_emb）。
  Future<void> timeCompareSelected() async {
    final selected = getSelectedPhotoItems();
    if (selected.length != 1) {
      ToastUtil.show('photo_search_by_image_need_one'.tr);
      return;
    }
    final src = selected.first;
    if (src.fileHash.trim().isEmpty) return;
    final res = await PhotoAiSettingsApiService.instance
        .getTimeCompare(src.fileHash);
    if (!res.success) {
      ToastUtil.show(res.message ?? 'operation_failed');
      return;
    }
    final items = ((res.data?['items'] as List?) ?? const [])
        .whereType<Map>()
        .map((e) => e.cast<String, dynamic>())
        .toList();
    if (items.isEmpty) {
      ToastUtil.show('photo_insight_no_compare'.tr);
      return;
    }
    exitMultiSelectMode();
    _openPhotoListByItems(items, title: 'photo_insight_time_compare'.tr);
  }

  /// ⭐ 2026-10-16 P0-3 以图搜图：拿选中的那张照片，找库里最像的 N 张。
  Future<void> searchByImageSelected() async {
    final selected = getSelectedPhotoItems();
    if (selected.isEmpty) return;
    if (selected.length > 1) {
      ToastUtil.show('photo_search_by_image_need_one'.tr);
      return;
    }
    await _searchByImageCore(selected.first);
  }

  /// ⭐ 2026-10-16 右键菜单：单张照片直接「以图搜图」（与多选栏共用同一实现）。
  Future<void> searchByImageForItem(TimelinePhotoItem item) async {
    await _searchByImageCore(item);
  }

  Future<void> _searchByImageCore(TimelinePhotoItem src) async {
    if (src.fileHash.trim().isEmpty) return;

    final res = await _apiService.searchByImage(fileHash: src.fileHash);
    if (!res.success) {
      ToastUtil.show(res.message ?? 'operation_failed');
      return;
    }
    final items = res.data ?? const <Map<String, dynamic>>[];
    if (items.isEmpty) {
      ToastUtil.show('photo_search_by_image_empty'.tr);
      return;
    }
    // 结果里通常含查询图自己（相似度 1.0），先剔除，避免「点开发现自己」
    final results = items
        .where((e) => (e['file_hash']?.toString() ?? '') != src.fileHash)
        .toList();
    final finalList = results.isEmpty ? items : results;
    exitMultiSelectMode();
    _openPhotoListByItems(finalList, title: 'photo_search_by_image'.tr);
  }

  /// 复用既有看图器（CustomGallery / 桌面看图窗）打开一组「按路径描述的照片」。
  /// 与相似照片页（ai_similar）打开预览的方式保持一致。
  void _openPhotoListByItems(
    List<Map<String, dynamic>> items, {
    required String title,
  }) {
    final images = items
        .where((e) => (e['fullpath']?.toString() ?? '').isNotEmpty)
        .map(
          (e) => <String, dynamic>{
            'type': (e['type'] as num?)?.toInt() == 2 ? 'video' : 'image',
            'path': e['fullpath']?.toString() ?? '',
            'name': e['filename']?.toString() ?? '',
            'photoId': 0,
          },
        )
        .toList();
    if (images.isEmpty) {
      ToastUtil.show('photo_search_by_image_empty'.tr);
      return;
    }

    Future<bool> deleteHandler(Map<String, dynamic> item, int _) async => false;

    if (DeviceUtils.isDesktop && Get.isRegistered<PcHomeController>()) {
      Get.find<PcHomeController>().openImageViewer(
        images,
        0,
        deleteHandler: deleteHandler,
      );
      return;
    }
    if (!Get.isRegistered<CustomGalleryController>()) {
      Get.put(CustomGalleryController());
    }
    final galleryCtrl = CustomGalleryController.instance;
    galleryCtrl.configure(deleteHandler: deleteHandler);
    galleryCtrl.isControlsVisible.value = true;
    galleryCtrl.galleryItems = images;
    galleryCtrl.galleryInitialIndex.value = 0;
    Get.to(() => const CustomGallery());
  }

  void removeTrashedFromMemory(Iterable<int> ids) {
    final idSet = ids.where((e) => e > 0).toSet();
    if (idSet.isEmpty) return;
    selectedItems.removeWhere((e) => idSet.contains(e));
    _removeItemsAndCleanUp(idSet);
    if (selectedItems.isEmpty && isMultiSelectMode.value) {
      exitMultiSelectMode();
    }
  }

  /// 单个 item 的选中/取消选中。
  ///
  /// 如果选中集合非空且当前不在多选模式，会自动进入多选模式，保证底部栏显示。
  void toggleSelection(int id) {
    if (selectedItems.contains(id)) {
      selectedItems.remove(id);
    } else {
      selectedItems.add(id);
    }
    if (selectedItems.isNotEmpty && !isMultiSelectMode.value) {
      isMultiSelectMode.value = true;
    }
    if (selectedItems.isEmpty) {
      exitMultiSelectMode();
    }
  }

  Future<void> downloadItem(TimelinePhotoItem item) async {
    selectedItems
      ..clear()
      ..add(item.id);
    await downloadSelected();
    selectedItems.clear();
  }

  Future<void> setFaceCoverItem(TimelinePhotoItem item) async {
    final fid = faceId.value;
    if (fid == null || fid <= 0) return;
    final hash = item.fileHash;
    if (hash.trim().isEmpty) return;

    try {
      final baseUrl = ApiController.instance.baseUrl;
      final token = ApiController.instance.accessToken;
      final res = await HttpUtil.post(
        '$baseUrl/api/photo/face/cover/set',
        headers: {
          'Content-Type': 'application/json',
          if (token != null) 'Authorization': 'Bearer $token',
        },
        body: jsonEncode({'face_id': fid, 'file_hash': hash}),
      );

      if (res.isOk) {
        ApiController.instance.refreshFaceImageTimestamp();
        ToastUtil.show('operation_success'.tr);
        return;
      }
      // ⭐ 2026-10-13：区分「这张照片里没有该人脸」（服务端 404）与其它失败，
      // 否则用户点了没反应也不知道为什么。
      final status = res.response?.statusCode ?? 0;
      if (status == 404 || (res.error ?? '').contains('NOT_FOUND')) {
        ToastUtil.show('face_cover_not_in_photo'.tr);
        return;
      }
    } catch (_) {}

    ToastUtil.show('operation_failed'.tr);
  }

  Future<void> showPhotoDetectedFaces(TimelinePhotoItem item) async {
    if (!FolderViewModuleType.photo.isServerVersionAtLeast(4)) {
      DialogUtil.showInfoDialog(
        title: 'tip'.tr,
        content: 'server_version_too_low'.tr,
      );
      return;
    }
    final hash = item.fileHash.trim();
    if (hash.isEmpty) {
      ToastUtil.show('operation_failed'.tr);
      return;
    }

    final res = await _apiService.listPhotoFaces(fileHash: hash);
    if (!res.success) {
      ToastUtil.show(res.message ?? 'operation_failed'.tr);
      return;
    }

    final faces = res.data ?? const <TimelineDetectedFaceItem>[];
    final ctx = Get.overlayContext;
    if (ctx == null || !ctx.mounted) return;

    await showDialog<void>(
      context: ctx,
      builder: (context) {
        return DialogUtil.createAlertDialog(
          title: Text('face_show_photo_faces'.tr),
          constraints: const BoxConstraints(maxWidth: 520, minWidth: 320),
          content: ConstrainedBox(
            constraints: const BoxConstraints(maxHeight: 420),
            child: faces.isEmpty
                ? Center(child: Text('face_photo_faces_empty'.tr))
                : SingleChildScrollView(
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      children: faces
                          .map(
                            (face) => Padding(
                              padding: const EdgeInsets.only(bottom: 12),
                              child: _PhotoTimelineDetectedFaceTile(
                                photo: item,
                                face: face,
                              ),
                            ),
                          )
                          .toList(),
                    ),
                  ),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.of(context).pop(),
              child: Text('ok'.tr),
            ),
          ],
        );
      },
    );
  }

  Future<AiFaceItem?> _pickTargetFaceForMove() async {
    final currentFaceId = faceId.value;
    if (currentFaceId == null || currentFaceId <= 0) return null;

    final res = await PhotoAiFacesApiService().listFaces(
      page: 1,
      pageSize: 500,
      status: 'all',
      keyword: '',
    );
    if (!res.success || res.data == null) {
      ToastUtil.show(res.message ?? 'operation_failed'.tr);
      return null;
    }

    final faces = res.data!.items
        .where((e) => e.faceId > 0 && e.faceId != currentFaceId)
        .toList(growable: false);
    if (faces.isEmpty) {
      DialogUtil.showInfoDialog(
        title: 'tip'.tr,
        content: 'face_move_target_empty'.tr,
      );
      return null;
    }

    final ctx = Get.overlayContext ?? Get.context;
    if (ctx == null || !ctx.mounted) return null;

    if (DeviceUtils.isMobile) {
      return showModalBottomSheet<AiFaceItem>(
        context: ctx,
        isScrollControlled: true,
        builder: (_) =>
            SafeArea(child: _TimelineFaceTargetPickerContent(items: faces)),
      );
    }

    return showDialog<AiFaceItem>(
      context: ctx,
      builder: (context) {
        return DialogUtil.createAlertDialog(
          title: Text('face_move_to_other_face'.tr),
          content: SizedBox(
            width: 420,
            child: _TimelineFaceTargetPickerContent(items: faces),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.of(context).pop(),
              child: Text('cancel'.tr),
            ),
          ],
        );
      },
    );
  }

  Future<void> moveSelectedToOtherFace() async {
    final currentFaceId = faceId.value;
    if (currentFaceId == null || currentFaceId <= 0) return;
    if (!FolderViewModuleType.photo.isServerVersionAtLeast(4)) {
      DialogUtil.showInfoDialog(
        title: 'tip'.tr,
        content: 'server_version_too_low'.tr,
      );
      return;
    }

    final hashes = _selectedFileHashes();
    if (hashes.isEmpty) return;

    final target = await _pickTargetFaceForMove();
    if (target == null) return;

    final res = await _apiService.movePhotoToFace(
      fromFaceId: currentFaceId,
      toFaceId: target.faceId,
      fileHashes: hashes,
    );
    if (!res.success) {
      ToastUtil.show(res.message ?? 'operation_failed'.tr);
      return;
    }

    final ids = selectedItems.toSet();
    _removeItemsAndCleanUp(ids);
    exitMultiSelectMode();
    ToastUtil.show('operation_success'.tr);
  }

  Future<void> moveItemToOtherFace(TimelinePhotoItem item) async {
    selectedItems
      ..clear()
      ..add(item.id);
    await moveSelectedToOtherFace();
    if (!isMultiSelectMode.value) {
      selectedItems.clear();
    }
  }

  Future<void> removeFromFaceAlbumSelected() async {
    final fid = faceId.value;
    if (fid == null || fid <= 0) return;
    if (!FolderViewModuleType.photo.isServerVersionAtLeast(4)) {
      DialogUtil.showInfoDialog(
        title: 'tip'.tr,
        content: 'server_version_too_low'.tr,
      );
      return;
    }

    final hashes = _selectedFileHashes();
    if (hashes.isEmpty) return;

    final ok = await DialogUtil.showConfirmDialog(
      title: 'need_confirm'.tr,
      content: 'face_remove_from_album_confirm'.tr,
      confirmText: 'ok'.tr,
      cancelText: 'cancel'.tr,
    );
    if (ok != true) return;

    var successCount = 0;
    for (final hash in hashes) {
      final res = await _apiService.removePhotoFromFace(
        faceId: fid,
        fileHash: hash,
      );
      if (res.success) successCount++;
    }
    if (successCount == 0) {
      ToastUtil.show('operation_failed'.tr);
      return;
    }

    final ids = selectedItems.toSet();
    _removeItemsAndCleanUp(ids);
    exitMultiSelectMode();
    ToastUtil.show('operation_success'.tr);
  }

  Future<void> removeFromFaceAlbumItem(TimelinePhotoItem item) async {
    selectedItems
      ..clear()
      ..add(item.id);
    await removeFromFaceAlbumSelected();
    if (!isMultiSelectMode.value) {
      selectedItems.clear();
    }
  }

  Future<void> setAlbumCoverItem(TimelinePhotoItem item) async {
    final currentAlbumId = albumId.value;
    if (currentAlbumId == null) return;
    final hash = item.fileHash;
    if (hash.trim().isEmpty) return;

    try {
      final res = await PhotoAlbumApiService().setAlbumCover(
        albumId: currentAlbumId,
        fileHash: hash,
      );
      if (res.success) {
        ToastUtil.show('operation_success'.tr);
        return;
      }
      ToastUtil.show(res.message ?? 'operation_failed'.tr);
    } catch (_) {
      ToastUtil.show('operation_failed'.tr);
    }
  }

  Future<void> favoriteItem(TimelinePhotoItem item) async {
    selectedItems
      ..clear()
      ..add(item.id);
    await favoriteSelected();
  }

  Future<void> addToAlbumItem(TimelinePhotoItem item) async {
    selectedItems
      ..clear()
      ..add(item.id);
    await addToAlbumSelected();
  }

  Future<void> removeFromAlbumItem(TimelinePhotoItem item) async {
    selectedItems
      ..clear()
      ..add(item.id);
    await removeFromAlbumSelected();
  }

  void confirmDeleteItem(TimelinePhotoItem item) {
    selectedItems
      ..clear()
      ..add(item.id);
    deleteSelected();
  }

  /// 判断某个日期下的所有已加载项是否“全选”。
  bool isDateSelected(String date) {
    // 找出该日期下所有的 Photo
    final photos = <TimelineListPhoto>[];
    bool foundDate = false;
    for (final item in photoItems) {
      if (item is TimelineListDateHeader && item.date == date) {
        foundDate = true;
        continue;
      }
      if (foundDate) {
        if (item is TimelineListPhoto) {
          photos.add(item);
        } else {
          // 遇到下一个 Header 或 Loading，停止
          break;
        }
      }
    }

    if (photos.isEmpty) return false;
    return photos.every((p) => selectedItems.contains(p.photo.id));
  }

  /// 切换某个日期组的全选/全不选。
  void toggleDateSelection(String date) {
    // 找出该日期下所有的 Photo
    final photos = <TimelineListPhoto>[];
    bool foundDate = false;
    for (final item in photoItems) {
      if (item is TimelineListDateHeader && item.date == date) {
        foundDate = true;
        continue;
      }
      if (foundDate) {
        if (item is TimelineListPhoto) {
          photos.add(item);
        } else {
          break;
        }
      }
    }

    if (photos.isEmpty) return;

    final allSelected = isDateSelected(date);
    if (allSelected) {
      for (final p in photos) {
        selectedItems.remove(p.photo.id);
      }
    } else {
      for (final p in photos) {
        selectedItems.add(p.photo.id);
      }
      isMultiSelectMode.value = true;
    }
    if (selectedItems.isEmpty) {
      exitMultiSelectMode();
    }
  }

  /// 移除指定 ID 的照片，并清理空的日期 Header 和更新 dateList 计数。
  void _removeItemsAndCleanUp(Set<int> ids) {
    // 统计删除的日期计数
    final removedCountByDate = <String, int>{};

    // 从 photoItems 中移除照片
    // 我们倒序遍历，方便删除
    for (int i = photoItems.length - 1; i >= 0; i--) {
      final item = photoItems[i];
      if (item is TimelineListPhoto) {
        if (ids.contains(item.photo.id)) {
          removedCountByDate[item.photo.originalDate] =
              (removedCountByDate[item.photo.originalDate] ?? 0) + 1;
          photoItems.removeAt(i);
        }
      }
    }

    // 检查是否有空的日期 Header，如果有则移除
    // 先更新 dateList
    for (final entry in removedCountByDate.entries) {
      final idx = dateList.indexWhere((d) => d.originalDate == entry.key);
      if (idx < 0) continue;
      final nextCount = dateList[idx].count - entry.value;
      if (nextCount <= 0) {
        dateList.removeAt(idx);
        // 移除 photoItems 中对应的 Header
        photoItems.removeWhere(
          (item) => item is TimelineListDateHeader && item.date == entry.key,
        );
      } else {
        dateList[idx] = TimelineDateItem(
          originalDate: dateList[idx].originalDate,
          count: nextCount,
        );
      }
    }

    // 额外清理：防止出现连续两个 Header (中间的照片被删完了)
    // 检查并清理：Header 后面紧跟着 Header 或 Loading/End
    for (int i = photoItems.length - 1; i >= 0; i--) {
      final item = photoItems[i];
      if (item is TimelineListDateHeader) {
        // 检查下一项
        if (i + 1 >= photoItems.length) {
          // Header 在末尾，且后面没有 Photo，移除
          photoItems.removeAt(i);
        } else {
          final next = photoItems[i + 1];
          if (next is! TimelineListPhoto) {
            // Header 后面不是 Photo (可能是另一个 Header 或 Loading)
            photoItems.removeAt(i);
          }
        }
      }
    }
  }

  /// ⭐ 2026-10-16 P0-8：对选中照片分项「重新识别」。
  ///
  /// 分项而不是「全部重来」：用户大多数时候只是某一张的 OCR 认错了、
  /// 或者人脸分组不对，没必要把已经跑好的场景/活动一起推翻。
  Future<void> rerunSelectedAi() async {
    final selected = getSelectedPhotoItems();
    if (selected.isEmpty) return;
    await rerunAiForItems(selected);
  }

  /// ⭐ 2026-10-16 右键菜单：单张照片「重新识别（人脸 / OCR / 场景 / 活动）」。
  Future<void> rerunAiForItem(TimelinePhotoItem item) async {
    await rerunAiForItems(<TimelinePhotoItem>[item]);
  }

  /// 多选栏与右键菜单共用的实现（弹窗选分项 → 按 file_hash 入队）。
  Future<void> rerunAiForItems(List<TimelinePhotoItem> items) async {
    final hashes = items
        .map((e) => e.fileHash)
        .where((e) => e.trim().isNotEmpty)
        .toList();
    if (hashes.isEmpty) return;

    const kinds = <String>['face', 'ocr', 'place', 'activity'];
    final picked = <String>{...kinds}; // 默认全选，用户按需取消

    String labelOf(String k) {
      switch (k) {
        case 'face':
          return 'photo_rerun_face'.tr;
        case 'ocr':
          return 'photo_rerun_ocr'.tr;
        case 'place':
          return 'photo_rerun_place'.tr;
        default:
          return 'photo_rerun_activity'.tr;
      }
    }

    final ok = await Get.dialog<bool>(
      AlertDialog(
        title: Text('photo_rerun_title'.tr),
        content: StatefulBuilder(
          builder: (ctx, setLocal) {
            final theme = Theme.of(ctx);
            return Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  'photo_rerun_hint'.tr,
                  style: theme.textTheme.bodySmall?.copyWith(
                    color: theme.colorScheme.onSurfaceVariant,
                  ),
                ),
                const SizedBox(height: 4),
                for (final k in kinds)
                  CheckboxListTile(
                    dense: true,
                    contentPadding: EdgeInsets.zero,
                    controlAffinity: ListTileControlAffinity.leading,
                    value: picked.contains(k),
                    title: Text(labelOf(k)),
                    onChanged: (v) {
                      setLocal(() {
                        if (v == true) {
                          picked.add(k);
                        } else {
                          picked.remove(k);
                        }
                      });
                    },
                  ),
              ],
            );
          },
        ),
        actions: [
          TextButton(
            onPressed: () => Get.back(result: false),
            child: Text('cancel'.tr),
          ),
          TextButton(
            onPressed: () => Get.back(result: true),
            child: Text('photo_rerun_start'.tr),
          ),
        ],
      ),
      barrierDismissible: true,
    );
    if (ok != true) return;
    if (picked.isEmpty) {
      ToastUtil.show('photo_rerun_none_selected'.tr);
      return;
    }

    final res = await _apiService.rerunAi(
      fileHashes: hashes,
      kinds: picked.toList(),
    );
    if (!res.success) {
      ToastUtil.show(res.message ?? 'network_failure');
      return;
    }
    ToastUtil.show('photo_rerun_queued'.tr);
    exitMultiSelectMode();
  }
}

class _PhotoTimelineDetectedFaceTile extends StatelessWidget {
  final TimelinePhotoItem photo;
  final TimelineDetectedFaceItem face;

  const _PhotoTimelineDetectedFaceTile({
    required this.photo,
    required this.face,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final name = (face.name ?? '').trim();
    final displayName = name.isNotEmpty ? name : '(${'face_unnamed'.tr})';
    final subtitle =
        '${'total_count'.trParams({'count': face.faceCount.toString()})}'
        '${face.isHide ? ' · ${'face_action_hide'.tr}' : ''}';
    const avatarSize = 44.0;

    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(12),
        color: theme.colorScheme.surfaceContainerHighest.withValues(
          alpha: 0.35,
        ),
      ),
      child: Row(
        children: [
          Container(
            width: avatarSize,
            height: avatarSize,
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              border: Border.all(
                color: theme.colorScheme.onSurface.withValues(alpha: 0.08),
              ),
            ),
            child: ClipOval(
              child: CustomExtendedImage(
                cache: false,
                imageUrl: ApiController.instance.getFaceImageUrl(
                  faceId: face.faceId,
                  fileHash: photo.fileHash,
                  size: 120,
                  quality: 85,
                ),
                width: avatarSize,
                height: avatarSize,
                fit: BoxFit.cover,
                borderRadius: avatarSize / 2,
                showLoading: false,
              ),
            ),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  displayName,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: theme.textTheme.titleSmall,
                ),
                const SizedBox(height: 4),
                Text(
                  subtitle,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: theme.textTheme.bodySmall?.copyWith(
                    color: theme.colorScheme.onSurface.withValues(alpha: 0.65),
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _TimelineFaceTargetPickerContent extends StatefulWidget {
  final List<AiFaceItem> items;

  const _TimelineFaceTargetPickerContent({required this.items});

  @override
  State<_TimelineFaceTargetPickerContent> createState() =>
      _TimelineFaceTargetPickerContentState();
}

class _TimelineFaceTargetPickerContentState
    extends State<_TimelineFaceTargetPickerContent> {
  final TextEditingController _searchController = TextEditingController();
  String _keyword = '';

  @override
  void dispose() {
    _searchController.dispose();
    super.dispose();
  }

  String _displayName(AiFaceItem face) {
    final name = (face.name ?? '').trim();
    return name.isNotEmpty ? name : '(${'face_unnamed'.tr})';
  }

  @override
  Widget build(BuildContext context) {
    final filtered = widget.items
        .where((face) {
          final keyword = _keyword.trim().toLowerCase();
          if (keyword.isEmpty) return true;
          final name = _displayName(face).toLowerCase();
          return name.contains(keyword) ||
              face.faceId.toString().contains(keyword);
        })
        .toList(growable: false);

    final content = ListView.separated(
      shrinkWrap: true,
      itemCount: filtered.length,
      separatorBuilder: (_, _) => const Divider(height: 1),
      itemBuilder: (context, index) {
        final face = filtered[index];
        return ListTile(
          leading: ClipOval(
            child: CustomExtendedImage(
              cache: false,
              imageUrl: ApiController.instance.getFaceImageUrl(
                faceId: face.faceId,
                size: 120,
                quality: 85,
              ),
              width: 36,
              height: 36,
              fit: BoxFit.cover,
              borderRadius: 18,
              showLoading: false,
            ),
          ),
          title: Text(
            _displayName(face),
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
          ),
          subtitle: Text(
            'total_count'.trParams({'count': '${face.faceCount}'}),
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
          ),
          onTap: () => Navigator.of(context).pop(face),
        );
      },
    );

    final searchBar = Padding(
      padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
      child: TextField(
        controller: _searchController,
        onChanged: (value) => setState(() => _keyword = value),
        decoration: InputDecoration(
          hintText: 'search'.tr,
          prefixIcon: const Icon(Icons.search),
          isDense: true,
          border: const OutlineInputBorder(),
        ),
      ),
    );

    final listContent = filtered.isEmpty
        ? Padding(
            padding: const EdgeInsets.all(24),
            child: Center(child: Text('no_data'.tr)),
          )
        : content;

    if (DeviceUtils.isMobile) {
      return SizedBox(
        height: 420,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 16, 16, 8),
              child: Text(
                'face_move_to_other_face'.tr,
                style: Theme.of(context).textTheme.titleMedium,
              ),
            ),
            searchBar,
            Expanded(child: listContent),
          ],
        ),
      );
    }

    return ConstrainedBox(
      constraints: const BoxConstraints(maxHeight: 420),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          searchBar,
          Flexible(child: listContent),
        ],
      ),
    );
  }
}
