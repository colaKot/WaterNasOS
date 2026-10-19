part of '../photo_timeline_controller.dart';

/// 上/下分页拉取与数据合并逻辑。
extension PhotoTimelineControllerPagination on PhotoTimelineController {
  /// 根据滚动方向加载更多。
  Future<void> _loadMore({required bool up}) async {
    if (up) {
      if (isLoadingUp.value || !hasMoreUp.value) return;
      saveAnchorItem();
    } else {
      if (isLoadingDown.value || !hasMoreDown.value) return;
    }

    // 从 photoItems 中查找边界照片
    TimelinePhotoItem? boundaryPhoto;
    if (up) {
      for (final item in photoItems) {
        if (item is TimelineListPhoto) {
          boundaryPhoto = item.photo;
          break;
        }
      }
    } else {
      for (final item in photoItems.reversed) {
        if (item is TimelineListPhoto) {
          boundaryPhoto = item.photo;
          break;
        }
      }
    }

    if (boundaryPhoto == null) return;

    try {
      if (up) {
        isLoadingUp.value = true;
      } else {
        isLoadingDown.value = true;
      }

      final boundaryDate = boundaryPhoto.originalDate;
      final range = _buildFetchRangeByMinCount(
        anchorDate: boundaryDate,
        up: up,
        includeAnchor: false,
        minCount: PhotoTimelineController.minGetCount,
      );

      if (range == null) {
        if (up) {
          hasMoreUp.value = false;
        } else {
          hasMoreDown.value = false;
        }
        return;
      }

      final result = await _fetchAndProcessPhotos(
        startTime: range.startTime,
        endTime: range.endTime,
        isUp: up,
        clear: false,
      );

      if (!result.hasData) {
        if (up) {
          hasMoreUp.value = false;
        } else {
          hasMoreDown.value = false;
        }
        return;
      }

      if (up) {
        hasMoreUp.value = range.startIndex > 0;
      } else {
        hasMoreDown.value = range.endIndex < dateList.length - 1;
      }
    } catch (e) {
      print('加载更多错误: $e');
    } finally {
      if (up) {
        isLoadingUp.value = false;
        // 如果是向上加载 则跳转回加载之前的第一个可见组件
        if (photoItems.isNotEmpty) {
          restoreScrollPosition();
        }
      } else {
        isLoadingDown.value = false;
      }
    }
  }

  /// 拉取照片列表并合并到 photoItems。
  Future<FetchResult> _fetchAndProcessPhotos({
    required int startTime,
    required int endTime,
    required bool isUp,
    bool clear = false,
  }) async {
    final type = fileType.value == 'all' ? null : fileType.value;
    final requestSort = sortOrder.value;

    final res = await _apiService.getTimelinePhotoList(
      sort: requestSort,
      fileType: type,
      startTime: startTime,
      endTime: endTime,
      search: searchKeyword.value,
      geohash: geohashForRequest,
      sourceList: selectedPaths.isEmpty ? null : selectedPaths,
      listType: listType.value == 'favorite' ? 'favorite' : null,
      albumId: albumId.value,
      collectionId: collectionId.value,
      smartAlbumId: smartAlbumId.value,
      faceId: faceId.value,
      comboFaceIds: comboFaceIds.isEmpty ? null : comboFaceIds.toList(),
      placeName: placeName.value,
      loadTheDay: loadTheDay.value,
      year: year.value,
    );

    if (!res.success || res.data == null || res.data!.photoList.isEmpty) {
      _lastFetchResult = const FetchResult(
        hasData: false,
        incomingCount: 0,
        addedCount: 0,
      );
      return _lastFetchResult;
    }

    final payload = res.data!;

    if (clear) {
      dateInfoMap.clear();
    }
    for (final info in payload.dateInfoList) {
      final date = info.originalDate.trim();
      if (date.isEmpty) continue;
      dateInfoMap[date] = info;
    }

    var incoming = List<TimelinePhotoItem>.from(payload.photoList);
    incoming = _clusterSearchByDate(incoming);

    if (incoming.isEmpty) {
      _lastFetchResult = FetchResult(
        hasData: false,
        incomingCount: incoming.length,
        addedCount: 0,
      );
      return _lastFetchResult;
    }

    if (clear) {
      // 全量重建
      final newItems = <TimelineListItem>[];
      String? currentDate;
      final sparse = _searchSparseDates(incoming);

      for (final p in incoming) {
        if (p.originalDate != currentDate) {
          currentDate = p.originalDate;
          if (!sparse.contains(currentDate)) {
            newItems.add(TimelineListDateHeader(date: currentDate));
          }
        }
        newItems.add(TimelineListPhoto(photo: p));
      }
      photoItems.assignAll(newItems);
    } else {
      _mergeIncomingPhotos(incoming, isUp: isUp);
    }

    _lastFetchResult = FetchResult(
      hasData: true,
      incomingCount: incoming.length,
      addedCount: incoming.length,
    );
    return _lastFetchResult;
  }

  /// 将“新拉取的数据”合并到 photoItems。
  void _mergeIncomingPhotos(
    List<TimelinePhotoItem> photos, {
    required bool isUp,
  }) {
    if (photos.isEmpty) return;

    // ⭐ 2026-10-19 搜索结果按日期归并：跨页出现同一天时不再新起一个分组头，
    //    而是插回那一天的组里（否则同一天会被拆成好几段，每段一两张）。
    if (_isSearchResultMode) {
      _mergeSearchPhotos(photos, isUp: isUp);
      return;
    }

    // 构建新数据的 TimelineListItem 列表
    final newItems = <TimelineListItem>[];
    String? currentDate;
    // 预处理 newItems
    for (final p in photos) {
      if (p.originalDate != currentDate) {
        currentDate = p.originalDate;
        // 添加日期item
        newItems.add(TimelineListDateHeader(date: currentDate));
      }
      // 添加photo item
      newItems.add(TimelineListPhoto(photo: p));
    }

    // 确定插入位置和边界处理
    if (isUp) {
      // 向上加载：插入到头部
      int insertIndex = 0;

      // 检查边界：新数据的最后一天 vs 旧数据的第一天
      if (insertIndex < photoItems.length) {
        final firstExistingItem = photoItems[insertIndex]; // 应该是 Header
        if (firstExistingItem is TimelineListDateHeader) {
          final lastNewPhoto = photos.last;
          if (lastNewPhoto.originalDate == firstExistingItem.date) {
            // 日期重合，旧数据的这个 Header 是多余的，因为新数据里已经包含了这个日期的 Header（在中间或结尾）
            // 或者新数据结尾是该日期照片，旧数据开头是该日期 Header。
            // 应该移除旧数据的 Header，让新数据的照片与旧数据的照片连在一起。
            photoItems.removeAt(insertIndex);
          }
        }
      }

      photoItems.insertAll(insertIndex, newItems);
    } else {
      // 向下加载：追加到尾部
      int appendIndex = photoItems.length;

      // 检查边界：旧数据的最后一天 vs 新数据的第一天
      // 找到旧数据最后一个 Photo
      TimelinePhotoItem? lastExistingPhoto;
      for (int i = appendIndex - 1; i >= 0; i--) {
        final item = photoItems[i];
        if (item is TimelineListPhoto) {
          lastExistingPhoto = item.photo;
          break;
        }
      }

      if (lastExistingPhoto != null) {
        final firstNewPhoto = photos.first;
        if (lastExistingPhoto.originalDate == firstNewPhoto.originalDate) {
          // 日期重合，新数据的第一个 Header 是多余的
          if (newItems.isNotEmpty && newItems.first is TimelineListDateHeader) {
            newItems.removeAt(0);
          }
        }
      }

      photoItems.insertAll(appendIndex, newItems);
    }
  }

  /// 带节流的触发加载：防止滚动边界抖动时短时间内多次触发分页。
  Future<void> _triggerLoadMore({required bool up}) async {
    if (_scrollLoadLock) return;
    _scrollLoadLock = true;
    try {
      print("触发分页加载 ${up ? '上一页' : '下一页'}");
      await _loadMore(up: up);
    } finally {
      Future<void>.delayed(const Duration(milliseconds: 200), () {
        _scrollLoadLock = false;
      });
    }
  }

  /// 是否是「搜索结果」视图（搜索框有关键词）。
  bool get _isSearchResultMode => searchKeyword.value.trim().isNotEmpty;

  /// 搜索模式下，照片数少于该值的日期不再单独占一个分组头。
  /// 理由：搜索结果通常散落在几十天里，每天只命中一两张，
  /// 一天一个标题会把列表拉得极长（用户反馈「一行只有一两张、行数特别多」）。
  static const int _searchSparseDateMax = 2;

  /// 搜索结果按日期**聚拢**：同一天的照片连续排列，组间顺序沿用相关性顺序
  /// （即该日期第一次出现的位置），组内保持服务端返回的相似度顺序。
  List<TimelinePhotoItem> _clusterSearchByDate(List<TimelinePhotoItem> photos) {
    if (!_isSearchResultMode || photos.length < 2) return photos;
    final order = <String>[];
    final buckets = <String, List<TimelinePhotoItem>>{};
    for (final p in photos) {
      final d = p.originalDate;
      var list = buckets[d];
      if (list == null) {
        list = <TimelinePhotoItem>[];
        buckets[d] = list;
        order.add(d);
      }
      list.add(p);
    }
    if (order.length <= 1) return photos;
    final out = <TimelinePhotoItem>[];
    for (final d in order) {
      out.addAll(buckets[d]!);
    }
    return out;
  }

  /// 本批数据里「稀疏」的日期集合（不插分组头）。
  Set<String> _searchSparseDates(List<TimelinePhotoItem> photos) {
    if (!_isSearchResultMode) return const <String>{};
    final counts = <String, int>{};
    for (final p in photos) {
      counts[p.originalDate] = (counts[p.originalDate] ?? 0) + 1;
    }
    final out = <String>{};
    final order = <String>[];
    counts.forEach((date, n) {
      order.add(date);
      if (n <= _searchSparseDateMax) out.add(date);
    });
    // 全部日期都是稀疏组时只保留第一个日期做锚点（滚动定位也要一个起点），
    // 其余照旧并排，避免整屏一个分组头都没有、也不知道滑到哪段时间。
    if (out.length == counts.length && counts.length > 1) {
      out.remove(order.first);
    }
    return out;
  }

  /// 搜索结果的合并：能归到已有日期组就插回去，否则追加到当前端。
  void _mergeSearchPhotos(
    List<TimelinePhotoItem> photos, {
    required bool isUp,
  }) {
    final groups = <String, List<TimelinePhotoItem>>{};
    final order = <String>[];
    for (final p in photos) {
      final d = p.originalDate;
      var list = groups[d];
      if (list == null) {
        list = <TimelinePhotoItem>[];
        groups[d] = list;
        order.add(d);
      }
      list.add(p);
    }
    final pendingHead = <TimelineListItem>[];
    for (final date in order) {
      final list = groups[date]!;
      // TimelinePhotoItem 不是 TimelineListItem，插入 photoItems 前要包一层。
      final wrapped = list
          .map<TimelineListItem>((e) => TimelineListPhoto(photo: e))
          .toList();
      final headerIdx = photoItems.indexWhere(
        (e) => e is TimelineListDateHeader && e.date == date,
      );
      if (headerIdx < 0) {
        // 稀疏日期：与首屏策略保持一致，不新开分组头，直接接在当前端继续排，
        // 否则翻页时又会出现「一个标题底下一两张」。
        if (list.length <= _searchSparseDateMax) {
          if (isUp) {
            pendingHead.addAll(wrapped);
          } else {
            photoItems.addAll(wrapped);
          }
          continue;
        }
        final block = <TimelineListItem>[
          TimelineListDateHeader(date: date),
          ...wrapped,
        ];
        if (isUp) {
          pendingHead.addAll(block);
        } else {
          photoItems.addAll(block);
        }
        continue;
      }
      // 已有该日期：插到这一组的末尾（下一个 header 之前）
      var lastIdx = headerIdx;
      for (var i = headerIdx + 1; i < photoItems.length; i++) {
        if (photoItems[i] is TimelineListDateHeader) break;
        lastIdx = i;
      }
      photoItems.insertAll(lastIdx + 1, wrapped);
    }
    if (pendingHead.isNotEmpty) {
      photoItems.insertAll(0, pendingHead);
    }
  }

}
