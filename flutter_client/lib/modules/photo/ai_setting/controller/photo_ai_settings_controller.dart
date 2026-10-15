import 'dart:async';

import 'package:get/get.dart';
import '../service/photo_ai_settings_api_service.dart';
import '../../../../core/user/current_user_controller.dart';
import '../../../../utils/dialog_util.dart';
import '../../../../utils/toast_util.dart';

class PhotoAiSettingsController extends GetxController {
  final RxBool loading = false.obs;

  final RxBool ocrEnabled = false.obs;
  final RxBool petEnabled = false.obs;
  final RxBool faceEnabled = false.obs;
  final RxBool placeEnabled = false.obs;
  final RxBool similarEnabled = false.obs;
  final RxBool gpuPrefer = true.obs; // 默认开启
  final RxInt faceMinShowCount = 0.obs;

  /// 人脸聚类参数（2026-10-13 可调）：改完要点「重新聚类」才生效
  final RxDouble faceSimThresh = 0.45.obs;
  final RxInt faceMinQuality = 75.obs;
  final RxDouble faceSecondMergeThresh = 0.45.obs;
  /// 识别线程数（2026-10-13）：并行检测的工作线程，改后重启识别进程生效
  final RxInt faceThreads = 3.obs;

  final RxInt ocrProgress = 0.obs;
  final RxInt placeProgress = 0.obs;
  final RxInt faceProgress = 0.obs;
  final RxInt similarScanProgress = 0.obs;
  final RxInt similarCompareProgress = 0.obs;

  bool get canEdit => CurrentUserController.instance.isAdmin;

  final _api = PhotoAiSettingsApiService.instance;

  @override
  void onInit() {
    super.onInit();
    fetchSettings(showLoading: false);
  }

  Future<void> fetchSettings({bool showLoading = true}) async {
    if (loading.value) return;
    loading.value = true;
    try {
      final res = await _api.getAiConfig(showLoading: showLoading);
      if (!res.success) {
        ToastUtil.show(res.message ?? 'network_failure'.tr);
        return;
      }

      int parseInt(dynamic v) {
        if (v is int) return v;
        if (v is double) return v.floor();
        if (v is String) return int.tryParse(v) ?? 0;
        return 0;
      }

      final data = res.data ?? <String, dynamic>{};
      ocrEnabled.value = data['ocrEnable'] == 1 || data['ocrEnable'] == '1';
      petEnabled.value = data['petEnable'] == 1 || data['petEnable'] == '1';
      faceEnabled.value = data['faceEnable'] == 1 || data['faceEnable'] == '1';
      placeEnabled.value =
          data['placeEnable'] == 1 || data['placeEnable'] == '1';
      similarEnabled.value =
          data['similarEnable'] == 1 || data['similarEnable'] == '1';
      gpuPrefer.value =
          data['gpuPrefer'] == 1 || data['gpuPrefer'] == '1';
      final minCount = parseInt(data['faceMinShowCount']);
      faceMinShowCount.value = minCount > 0 ? minCount : 0;
      // 人脸聚类参数是独立接口（非超管 403，忽略）
      unawaited(loadFaceTuning());

      final aiProgress = data['aiProgress'];
      if (aiProgress is Map) {
        final face = aiProgress['face'];
        final place = aiProgress['place'];
        final ocr = aiProgress['ocr'];
        if (face is Map) {
          faceProgress.value = parseInt(face['percent']).clamp(0, 100);
        }
        if (place is Map) {
          placeProgress.value = parseInt(place['percent']).clamp(0, 100);
        }
        if (ocr is Map) {
          ocrProgress.value = parseInt(ocr['percent']).clamp(0, 100);
        }
      } else {
        faceProgress.value = 0;
        placeProgress.value = 0;
        ocrProgress.value = 0;
      }

      final similarProgress = data['similarProgress'];
      if (similarProgress is Map) {
        final scan = similarProgress['scan'];
        final compare = similarProgress['compare'];
        if (scan is Map) {
          similarScanProgress.value = parseInt(scan['percent']).clamp(0, 100);
        } else {
          similarScanProgress.value = 0;
        }
        if (compare is Map) {
          similarCompareProgress.value = parseInt(
            compare['percent'],
          ).clamp(0, 100);
        } else {
          similarCompareProgress.value = 0;
        }
      } else {
        similarScanProgress.value = 0;
        similarCompareProgress.value = 0;
      }
    } finally {
      loading.value = false;
    }
  }

  Future<void> toggleOcr(bool value) async {
    if (!canEdit) {
      ToastUtil.show('photo_ai_admin_only'.tr);
      return;
    }
    final prev = ocrEnabled.value;
    ocrEnabled.value = value;
    try {
      DialogUtil.showLoading(message: 'loading'.tr);
      final res = await _api.setAiOcrEnable(value, showLoading: false);
      if (!res.success) {
        ocrEnabled.value = prev;
        ToastUtil.show(res.message ?? 'network_failure'.tr);
      }
    } finally {
      DialogUtil.dismissLoading();
    }
  }

  Future<void> togglePet(bool value) async {
    if (!canEdit) {
      ToastUtil.show('photo_ai_admin_only'.tr);
      return;
    }
    final prev = petEnabled.value;
    petEnabled.value = value;
    try {
      DialogUtil.showLoading(message: 'loading'.tr);
      final res = await _api.setAiPetEnable(value, showLoading: false);
      if (!res.success) {
        petEnabled.value = prev;
        ToastUtil.show(res.message ?? 'network_failure'.tr);
      }
    } finally {
      DialogUtil.dismissLoading();
    }
  }

  Future<void> toggleFace(bool value) async {
    if (!canEdit) {
      ToastUtil.show('photo_ai_admin_only'.tr);
      return;
    }
    final prev = faceEnabled.value;
    faceEnabled.value = value;
    try {
      DialogUtil.showLoading(message: 'loading'.tr);
      final res = await _api.setAiFaceEnable(value, showLoading: false);
      if (!res.success) {
        faceEnabled.value = prev;
        ToastUtil.show(res.message ?? 'network_failure'.tr);
      }
    } finally {
      DialogUtil.dismissLoading();
    }
  }

  Future<void> togglePlace(bool value) async {
    if (!canEdit) {
      ToastUtil.show('photo_ai_admin_only'.tr);
      return;
    }
    final prev = placeEnabled.value;
    placeEnabled.value = value;
    try {
      DialogUtil.showLoading(message: 'loading'.tr);
      final res = await _api.setAiPlaceEnable(value, showLoading: false);
      if (!res.success) {
        placeEnabled.value = prev;
        ToastUtil.show(res.message ?? 'network_failure'.tr);
      }
    } finally {
      DialogUtil.dismissLoading();
    }
  }

  Future<void> toggleSimilar(bool value) async {
    if (!canEdit) {
      ToastUtil.show('photo_ai_admin_only'.tr);
      return;
    }
    final prev = similarEnabled.value;
    similarEnabled.value = value;
    try {
      DialogUtil.showLoading(message: 'loading'.tr);
      final res = await _api.setAiSimilarEnable(value, showLoading: false);
      if (!res.success) {
        similarEnabled.value = prev;
        ToastUtil.show(res.message ?? 'network_failure'.tr);
      }
    } finally {
      DialogUtil.dismissLoading();
    }
  }

  Future<void> resetSimilar() async {
    if (!canEdit) {
      ToastUtil.show('photo_ai_admin_only'.tr);
      return;
    }
    DialogUtil.showConfirmDialog(
      title: 'need_confirm'.tr,
      content: 'photo_ai_similar_reset_confirm'.tr,
      onConfirm: () async {
        try {
          DialogUtil.showLoading(message: 'loading'.tr);
          final res = await _api.resetSimilar(showLoading: false);
          if (!res.success) {
            ToastUtil.show(res.message ?? 'network_failure'.tr);
            return;
          }
          ToastUtil.show('operation_success'.tr);
        } finally {
          DialogUtil.dismissLoading();
        }
      },
      confirmText: 'ok'.tr,
      cancelText: 'cancel'.tr,
    );
  }

  /// 重置场景识别（/place/reset，管理员）
  ///
  /// 清空 photo_places / photo_places2filehash 与照片上的场景标签，
  /// 然后按当前开关状态重新识别。换模型或想刷新 alt 标签时用这个。
  Future<void> resetPlaces() async {
    if (!canEdit) {
      ToastUtil.show('photo_ai_admin_only'.tr);
      return;
    }
    DialogUtil.showConfirmDialog(
      title: 'need_confirm'.tr,
      content: 'scene_reset_confirm'.tr,
      onConfirm: () async {
        try {
          DialogUtil.showLoading(message: 'loading'.tr);
          final res = await _api.resetPlaces(showLoading: false);
          if (!res.success) {
            ToastUtil.show(res.message ?? 'network_failure'.tr);
            return;
          }
          ToastUtil.show('operation_success'.tr);
        } finally {
          DialogUtil.dismissLoading();
        }
      },
      confirmText: 'ok'.tr,
      cancelText: 'cancel'.tr,
    );
  }

  /// 读取人脸聚类参数（非超管会 403，忽略即可）
  Future<void> loadFaceTuning() async {
    if (!canEdit) return;
    try {
      final res = await _api.getFaceTuning();
      if (!res.success) return;
      final data = res.data ?? const {};
      double asDouble(dynamic v, double def) {
        if (v is num) return v.toDouble();
        final n = double.tryParse(v?.toString() ?? '');
        return n ?? def;
      }

      int asInt(dynamic v, int def) {
        if (v is num) return v.toInt();
        final n = int.tryParse(v?.toString() ?? '');
        return n ?? def;
      }

      faceSimThresh.value = asDouble(data['simThresh'], 0.45).clamp(0.2, 0.9);
      faceMinQuality.value = asInt(data['minQuality'], 75).clamp(40, 95);
      faceSecondMergeThresh.value =
          asDouble(data['secondMergeThresh'], 0.45).clamp(0.2, 0.9);
      faceThreads.value = asInt(data['threads'], 3).clamp(1, 8);
    } catch (_) {}
  }

  /// 清理历史误检人脸（按阈值删掉明显错的框 + 空壳分组）
  Future<void> purgeSuspiciousFaces() async {
    if (!canEdit) {
      ToastUtil.show('photo_ai_admin_only'.tr);
      return;
    }
    final confirmed = await DialogUtil.showConfirmDialog(
      title: 'face_purge_suspicious'.tr,
      content: 'face_purge_confirm_content'.tr,
      confirmText: 'ok'.tr,
      cancelText: 'cancel'.tr,
    );
    if (confirmed != true) return;
    try {
      DialogUtil.showLoading(message: 'loading'.tr);
      final res = await _api.purgeSuspiciousFaces();
      if (!res.success) {
        ToastUtil.show(res.message ?? 'network_failure'.tr);
        return;
      }
      final data = res.data ?? const {};
      ToastUtil.show(
        'face_purge_done'.trParams({
          'boxes': '${(data['removedBoxes'] as num?)?.toInt() ?? 0}',
          'faces': '${(data['removedFaces'] as num?)?.toInt() ?? 0}',
        }),
      );
      await fetchSettings(showLoading: false);
    } finally {
      DialogUtil.dismissLoading();
    }
  }

  /// 重新聚类：清空现有人脸分组并按当前参数重新扫描全库。
  /// 「我和儿子混在一起」这类过度合并，调完参数后靠它重算。
  Future<void> reclusterFaces() async {
    if (!canEdit) {
      ToastUtil.show('photo_ai_admin_only'.tr);
      return;
    }
    final confirmed = await DialogUtil.showConfirmDialog(
      title: 'photo_ai_face_recluster_confirm'.tr,
      content: 'photo_ai_face_recluster_confirm_content'.tr,
      confirmText: 'ok'.tr,
      cancelText: 'cancel'.tr,
    );
    if (confirmed != true) return;
    try {
      DialogUtil.showLoading(message: 'loading'.tr);
      final res = await _api.resetFaces();
      if (!res.success) {
        ToastUtil.show(res.message ?? 'network_failure'.tr);
        return;
      }
      ToastUtil.show('photo_ai_face_recluster_started'.tr);
      await fetchSettings(showLoading: false);
    } finally {
      DialogUtil.dismissLoading();
    }
  }

  /// 保存人脸聚类参数
  Future<void> saveFaceTuning() async {
    if (!canEdit) {
      ToastUtil.show('photo_ai_admin_only'.tr);
      return;
    }
    try {
      DialogUtil.showLoading(message: 'loading'.tr);
      final res = await _api.setFaceTuning(
        simThresh: faceSimThresh.value,
        minQuality: faceMinQuality.value,
        secondMergeThresh: faceSecondMergeThresh.value,
        threads: faceThreads.value,
        showLoading: false,
      );
      if (!res.success) {
        ToastUtil.show(res.message ?? 'network_failure'.tr);
      } else {
        // 线程数变化时服务端会自动重启识别进程
        final restarted = res.data?['restarted'] == true;
        ToastUtil.show(
          restarted ? 'photo_ai_face_threads_restarted'.tr : 'operation_success'.tr,
        );
      }
    } finally {
      DialogUtil.dismissLoading();
    }
  }

  Future<void> setFaceMinShowCount(int value) async {
    if (!canEdit) {
      ToastUtil.show('photo_ai_admin_only'.tr);
      return;
    }
    final next = value < 0 ? 0 : value;
    final prev = faceMinShowCount.value;
    faceMinShowCount.value = next;
    try {
      DialogUtil.showLoading(message: 'loading'.tr);
      final res = await _api.setAiFaceMinShowCount(next, showLoading: false);
      if (!res.success) {
        faceMinShowCount.value = prev;
        ToastUtil.show(res.message ?? 'network_failure'.tr);
      }
    } finally {
      DialogUtil.dismissLoading();
    }
  }

  Future<void> toggleGpu(bool value) async {
    if (!canEdit) {
      ToastUtil.show('photo_ai_admin_only'.tr);
      return;
    }
    final prev = gpuPrefer.value;
    gpuPrefer.value = value;
    try {
      DialogUtil.showLoading(message: 'loading'.tr);
      final res = await _api.setAiGpuPrefer(value, showLoading: false);
      if (!res.success) {
        gpuPrefer.value = prev;
        ToastUtil.show(res.message ?? 'network_failure'.tr);
      }
    } finally {
      DialogUtil.dismissLoading();
    }
  }
}
