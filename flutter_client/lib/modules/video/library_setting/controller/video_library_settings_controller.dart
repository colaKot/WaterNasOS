import 'package:get/get.dart';
import 'package:WaterNasOS/modules/video/library_setting/models/video_library.dart';
import 'package:WaterNasOS/modules/video/library_setting/service/video_library_api_service.dart';
import 'package:WaterNasOS/modules/video/video_main/controller/video_main_controller.dart';
import 'package:WaterNasOS/utils/dialog_util.dart';
import 'package:WaterNasOS/utils/toast_util.dart';

class VideoLibrarySettingsController extends GetxController {
  final RxList<VideoLibrary> libraries = <VideoLibrary>[].obs;
  final RxBool loading = false.obs;

  @override
  void onInit() {
    super.onInit();
    fetchLibraries();
  }

  Future<void> fetchLibraries({bool showLoading = false}) async {
    if (loading.value) return;
    loading.value = true;
    try {
      final list = await VideoLibraryApiService.instance.listLibraries(
        showLoading: showLoading,
      );
      libraries.assignAll(list);
    } finally {
      loading.value = false;
    }
  }

  /// 影视库变动后，左侧栏的栏目列表要同步刷新
  void _notifySidebar() {
    if (Get.isRegistered<VideoMainController>()) {
      Get.find<VideoMainController>().fetchLibraries();
    }
  }

  Future<bool> addLibrary(String name, String libType) async {
    final n = name.trim();
    if (n.isEmpty) {
      ToastUtil.show('video_library_name_required'.tr);
      return false;
    }
    if (!kVideoLibTypes.contains(libType)) return false;

    DialogUtil.showLoading(message: 'loading'.tr);
    try {
      final res = await VideoLibraryApiService.instance.addLibrary(
        n,
        libType: libType,
        showLoading: false,
      );
      DialogUtil.dismissLoading();
      if (!res.success) {
        ToastUtil.show(res.message ?? 'operation_failed'.tr);
        return false;
      }
      await fetchLibraries();
      _notifySidebar();
      ToastUtil.show('operation_success'.tr);
      return true;
    } catch (_) {
      DialogUtil.dismissLoading();
      ToastUtil.show('operation_failed'.tr);
      return false;
    }
  }

  Future<bool> renameLibrary(VideoLibrary library, String name) async {
    final n = name.trim();
    if (n.isEmpty) {
      ToastUtil.show('video_library_name_required'.tr);
      return false;
    }
    if (n == library.displayName) return false;

    DialogUtil.showLoading(message: 'loading'.tr);
    try {
      final res = await VideoLibraryApiService.instance.renameLibrary(
        library.id,
        n,
        showLoading: false,
      );
      DialogUtil.dismissLoading();
      if (!res.success) {
        ToastUtil.show(res.message ?? 'operation_failed'.tr);
        return false;
      }
      await fetchLibraries();
      _notifySidebar();
      ToastUtil.show('operation_success'.tr);
      return true;
    } catch (_) {
      DialogUtil.dismissLoading();
      ToastUtil.show('operation_failed'.tr);
      return false;
    }
  }

  /// 切换「是否在主页显示」：乐观更新，失败回滚
  ///
  /// ⚠️ 必须用 [RxList.refresh] 让 UI 重建（2026-10-09）：
  /// 只做 `libraries[idx] = ...` 时RxList **不会**通知监听者，
  /// 开关看起来纹丝不动；失败回滚同样不生效。
  /// ⚠️ 成功后必须 [_notifySidebar] —— 左侧栏栏目和主页分组都按
  /// `show_in_home` 过滤，不刷新就会与开关状态不一致（用户报的第二个问题）。
  Future<void> setShowInHome(VideoLibrary library, bool value) async {
    final idx = libraries.indexWhere((e) => e.id == library.id);
    if (idx < 0) return;

    final before = libraries[idx];
    if (before.showInHome == value) return;

    // 乐观更新：立刻反映到 UI
    libraries[idx] = before.copyWith(showInHome: value);
    libraries.refresh();

    try {
      final res = await VideoLibraryApiService.instance.setShowInHome(
        library.id,
        value,
        showLoading: false,
      );
      if (!res.success) {
        _rollback(before, idx);
        ToastUtil.show(res.message ?? 'operation_failed'.tr);
        return;
      }
      // 成功：把服务端返回的最新记录写回，并同步左侧栏/主页分组
      final dynamic updated = res.data;
      if (updated is Map) {
        final map = updated.cast<String, dynamic>();
        if (map.isNotEmpty) {
          final parsed = VideoLibrary.fromJson(map);
          // ⚠️ 服务端返回的记录若缺字段会退化成 id=0，别把正常数据覆盖坏
          if (parsed.id > 0) {
            libraries[idx] = parsed;
            libraries.refresh();
          }
        }
      }
      _notifySidebar();
    } catch (_) {
      _rollback(before, idx);
      ToastUtil.show('operation_failed'.tr);
    }
  }

  /// 切换「音频响度归一化」：乐观更新，失败回滚
  ///
  /// ⚠️ 与 [setShowInHome] 同理，必须用 [RxList.refresh] 让 UI 重建。
  /// 开启后服务端会自动启动响度测量进程，为库中已有文件补齐测量值。
  /// 切换「日本电影库」（2026-10-12）。
  ///
  /// 开了以后前端才显示「中 / 无码」徽章与那组筛选；服务端也会据此
  /// 决定 list 接口要不要把 jp_* 字段回给前端。
  Future<void> setJpMovie(VideoLibrary library, bool value) async {
    final idx = libraries.indexWhere((e) => e.id == library.id);
    if (idx < 0) return;

    final before = libraries[idx];
    if (before.jpMovie == value) return;

    libraries[idx] = before.copyWith(jpMovie: value);
    libraries.refresh();

    try {
      final res = await VideoLibraryApiService.instance.setJpMovie(
        library.id,
        value,
        showLoading: false,
      );
      if (!res.success) {
        _rollback(before, idx);
        ToastUtil.show(res.message ?? 'operation_failed'.tr);
        return;
      }
      final dynamic updated = res.data;
      if (updated is Map) {
        final map = updated.cast<String, dynamic>();
        if (map.isNotEmpty) {
          final parsed = VideoLibrary.fromJson(map);
          if (parsed.id > 0) {
            libraries[idx] = parsed;
            libraries.refresh();
          }
        }
      }
    } catch (_) {
      _rollback(before, idx);
    }
  }

  Future<void> setAudioNormalize(VideoLibrary library, bool value) async {
    final idx = libraries.indexWhere((e) => e.id == library.id);
    if (idx < 0) return;

    final before = libraries[idx];
    if (before.audioNormalize == value) return;

    libraries[idx] = before.copyWith(audioNormalize: value);
    libraries.refresh();

    try {
      final res = await VideoLibraryApiService.instance.setAudioNormalize(
        library.id,
        value,
        showLoading: false,
      );
      if (!res.success) {
        _rollback(before, idx);
        ToastUtil.show(res.message ?? 'operation_failed'.tr);
        return;
      }
      final dynamic updated = res.data;
      if (updated is Map) {
        final map = updated.cast<String, dynamic>();
        if (map.isNotEmpty) {
          final parsed = VideoLibrary.fromJson(map);
          if (parsed.id > 0) {
            libraries[idx] = parsed;
            libraries.refresh();
          }
        }
      }
    } catch (_) {
      _rollback(before, idx);
      ToastUtil.show('operation_failed'.tr);
    }
  }

  void _rollback(VideoLibrary before, int idx) {
    if (idx < 0 || idx >= libraries.length) return;
    libraries[idx] = before;
    libraries.refresh();
  }

  /// 内置库、仍有来源的库由服务端拦截，这里只负责把失败原因透出
  Future<void> deleteLibrary(VideoLibrary library) async {
    final confirmed = await DialogUtil.showConfirmDialog(
      title: 'need_confirm'.tr,
      content: 'video_library_delete_confirm'.trParams({
        'name': library.displayName,
      }),
      confirmText: 'confirm'.tr,
      cancelText: 'cancel'.tr,
    );
    if (confirmed != true) return;

    DialogUtil.showLoading(message: 'loading'.tr);
    try {
      final res = await VideoLibraryApiService.instance.deleteLibrary(
        library.id,
        showLoading: false,
      );
      DialogUtil.dismissLoading();
      if (!res.success) {
        ToastUtil.show(res.message ?? 'operation_failed'.tr);
        return;
      }
      await fetchLibraries();
      _notifySidebar();
      ToastUtil.show('operation_success'.tr);
    } catch (_) {
      DialogUtil.dismissLoading();
      ToastUtil.show('operation_failed'.tr);
    }
  }
}
