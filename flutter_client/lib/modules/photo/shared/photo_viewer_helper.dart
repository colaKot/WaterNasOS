import 'package:get/get.dart';

import 'package:WaterNasOS/modules/gallery/controllers/custom_gallery_controller.dart';
import 'package:WaterNasOS/modules/gallery/views/custom_gallery.dart';
import 'package:WaterNasOS/modules/home/views/pc_home_controller.dart';
import 'package:WaterNasOS/utils/device_utils.dart';

/// ⭐ 2026-10-18 相册各单位共用的「打开一组图片」。
///
/// 桌面走 PcHomeController 的看图窗，移动端走 CustomGallery —— 与时间线同一套，
/// 不在这里另写查看器。首页 / 票夹 / 记忆三个页都走这里，避免各抄一份。
void openPhotoImages(List<Map<String, dynamic>> images, int index) {
  final list = images
      .where((e) => (e['path']?.toString() ?? '').isNotEmpty)
      .toList();
  if (list.isEmpty) return;

  Future<bool> deleteHandler(Map<String, dynamic> item, int _) async => false;

  if (DeviceUtils.isDesktop && Get.isRegistered<PcHomeController>()) {
    Get.find<PcHomeController>().openImageViewer(
      list,
      index.clamp(0, list.length - 1),
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
  galleryCtrl.galleryItems = list;
  galleryCtrl.galleryInitialIndex.value = index.clamp(0, list.length - 1);
  Get.to(() => const CustomGallery());
}

/// 打开单张图片的便捷入口。
void openSinglePhoto(String path, String name) {
  if (path.isEmpty) return;
  openPhotoImages([
    {'type': 'image', 'path': path, 'name': name, 'photoId': 0},
  ], 0);
}
