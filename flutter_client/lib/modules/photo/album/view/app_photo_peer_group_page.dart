import 'package:flutter/material.dart';
import 'package:get/get.dart';

import '../../../../core/api/api_controller.dart';
import '../../../../core/theme/custom_colors.dart';
import '../../../base/components/custom_extended_image.dart';
import '../../timeline/models/photo_timeline_model.dart';
import '../../timeline/service/photo_timeline_api_service.dart';
import '../../timeline/view/app_photo_timeline_view.dart';

/// ⭐ 2026-10-16 P0-2 合影组合相册。
///
/// 「同一组人反复同框」这件事在库里本来就有（`photo_face2filehash` 的同框关系），
/// 缺的只是把它摆出来。这一页把组合按张数排开，点开任意一组就是**那几个人同框的照片**。
///
/// 点开走的是既有时间轴页（`comboFaceIds` 过滤），所以分页、日期分组、缩放全都不用重写。
class AppPhotoPeerGroupPage extends StatefulWidget {
  const AppPhotoPeerGroupPage({super.key});

  @override
  State<AppPhotoPeerGroupPage> createState() => _AppPhotoPeerGroupPageState();
}

class _AppPhotoPeerGroupPageState extends State<AppPhotoPeerGroupPage> {
  final PhotoTimelineApiService _api = PhotoTimelineApiService();
  List<PhotoPeerGroup> _items = const <PhotoPeerGroup>[];
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final res = await _api.listPeerGroups(limit: 200);
    if (!mounted) return;
    setState(() {
      _items = (res.success && res.data != null)
          ? res.data!.items
          : const <PhotoPeerGroup>[];
      _loading = false;
    });
  }

  void _open(PhotoPeerGroup g) {
    Navigator.of(context).push(
      MaterialPageRoute(
        builder: (_) => AppPhotoTimelineRoutePage(
          title: g.displayNames.join('、'),
          comboFaceIds: g.memberFaceIds,
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final customColors = Theme.of(context).extension<CustomColors>();
    return Scaffold(
      backgroundColor: customColors?.mainContentBgColor,
      appBar: AppBar(title: Text('photo_peer_group'.tr)),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : (_items.isEmpty
              ? Center(child: Text('no_data'.tr))
              : RefreshIndicator(
                  onRefresh: _load,
                  child: GridView.builder(
                    padding: const EdgeInsets.fromLTRB(12, 12, 12, 20),
                    gridDelegate:
                        const SliverGridDelegateWithMaxCrossAxisExtent(
                      maxCrossAxisExtent: 200,
                      childAspectRatio: 3 / 4,
                      crossAxisSpacing: 8,
                      mainAxisSpacing: 8,
                    ),
                    itemCount: _items.length,
                    itemBuilder: (_, i) => PhotoPeerGroupCard(
                      group: _items[i],
                      onTap: () => _open(_items[i]),
                    ),
                  ),
                )),
    );
  }
}

/// 相册首页「合影」分段用的横向条：只展示前 [maxItems] 组，避免首页被拉长。
class PhotoPeerGroupStrip extends StatefulWidget {
  final int maxItems;
  const PhotoPeerGroupStrip({super.key, this.maxItems = 12});

  @override
  State<PhotoPeerGroupStrip> createState() => _PhotoPeerGroupStripState();
}

class _PhotoPeerGroupStripState extends State<PhotoPeerGroupStrip> {
  final PhotoTimelineApiService _api = PhotoTimelineApiService();
  List<PhotoPeerGroup> _items = const <PhotoPeerGroup>[];
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    // 拉够一屏即可；「更多」进去才要全量
    final res = await _api.listPeerGroups(limit: 60);
    if (!mounted) return;
    setState(() {
      _items = (res.success && res.data != null)
          ? res.data!.items.take(widget.maxItems).toList()
          : const <PhotoPeerGroup>[];
      _loading = false;
    });
  }

  @override
  Widget build(BuildContext context) {
    if (_loading) {
      return const SizedBox(
        height: 150,
        child: Center(child: CircularProgressIndicator()),
      );
    }
    if (_items.isEmpty) {
      return SizedBox(
        height: 60,
        child: Center(
          child: Text('no_data'.tr, style: Theme.of(context).textTheme.bodySmall),
        ),
      );
    }
    return SizedBox(
      height: 168,
      child: ListView.separated(
        scrollDirection: Axis.horizontal,
        padding: const EdgeInsets.symmetric(horizontal: 2),
        itemCount: _items.length,
        separatorBuilder: (_, __) => const SizedBox(width: 8),
        itemBuilder: (context, i) {
          final g = _items[i];
          return SizedBox(
            width: 126,
            child: PhotoPeerGroupCard(
              group: g,
              onTap: () {
                Navigator.of(context).push(
                  MaterialPageRoute(
                    builder: (_) => AppPhotoTimelineRoutePage(
                      title: g.displayNames.join('、'),
                      comboFaceIds: g.memberFaceIds,
                    ),
                  ),
                );
              },
            ),
          );
        },
      ),
    );
  }
}

/// 单个组合卡片：3:4 封面 + 底部成员名 + 右上角张数。
class PhotoPeerGroupCard extends StatelessWidget {
  final PhotoPeerGroup group;
  final VoidCallback onTap;
  const PhotoPeerGroupCard({
    super.key,
    required this.group,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final names = group.displayNames;
    final title = names.isEmpty ? '—' : names.join('、');
    final url = group.coverPath.isEmpty
        ? ''
        : ApiController.instance.getTinyUrl(group.coverPath);

    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(14),
      child: ClipRRect(
        borderRadius: BorderRadius.circular(14),
        child: Stack(
          children: [
            Positioned.fill(
              child: url.isEmpty
                  ? Container(color: theme.colorScheme.surfaceContainerHighest)
                  : CustomExtendedImage(imageUrl: url, fit: BoxFit.cover),
            ),
            Positioned.fill(
              child: Align(
                alignment: Alignment.bottomCenter,
                child: Container(
                  height: 54,
                  decoration: const BoxDecoration(
                    gradient: LinearGradient(
                      begin: Alignment.bottomCenter,
                      end: Alignment.topCenter,
                      colors: [Color(0xCC000000), Color(0x00000000)],
                    ),
                  ),
                ),
              ),
            ),
            Positioned(
              left: 8,
              right: 8,
              bottom: 7,
              child: Text(
                title,
                style: theme.textTheme.labelMedium?.copyWith(
                  color: Colors.white,
                  fontWeight: FontWeight.w700,
                ),
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
              ),
            ),
            Positioned(
              right: 6,
              top: 6,
              child: Container(
                padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
                decoration: BoxDecoration(
                  color: Colors.black54,
                  borderRadius: BorderRadius.circular(9),
                ),
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    const Icon(Icons.groups_outlined, size: 11, color: Colors.white),
                    const SizedBox(width: 3),
                    Text(
                      '${group.memberFaceIds.length}',
                      style: theme.textTheme.labelSmall?.copyWith(color: Colors.white),
                    ),
                    const SizedBox(width: 6),
                    Text(
                      '${group.photoCount}',
                      style: theme.textTheme.labelSmall?.copyWith(color: Colors.white),
                    ),
                  ],
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
