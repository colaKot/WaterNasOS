import 'dart:async';
import 'package:flutter/material.dart';
import 'package:get/get.dart';
import '../../../../core/user/current_user_controller.dart';
import '../../../../utils/dialog_util.dart';
import '../../../../utils/device_utils.dart';
import '../../../../utils/toast_util.dart';
import '../../ai_setting/service/photo_ai_settings_api_service.dart';
import '../../timeline/view/app_photo_timeline_view.dart';
import '../models/ai_scenes_models.dart';
import '../service/photo_ai_scenes_api_service.dart';

class AiScenesController extends GetxController {
  final PhotoAiScenesApiService _api = PhotoAiScenesApiService();
  final PhotoAiSettingsApiService _settingsApi =
      PhotoAiSettingsApiService.instance;

  final RxBool isLoading = false.obs;
  final RxBool hasMore = false.obs;
  final RxList<AiSceneItem> items = <AiSceneItem>[].obs;
  final RxList<AiSceneItem> allItems = <AiSceneItem>[].obs;
  final Rxn<AiSceneItem> activeScene = Rxn<AiSceneItem>();
  final RxBool placeEnabled = true.obs;

  final RxString statusFilter = 'visiable'.obs;
  final RxString keyword = ''.obs;
  final TextEditingController searchController = TextEditingController();
  Timer? _searchDebounce;

  /// ---- 语义搜索状态（/api/photo/place/search）----
  /// 服务端按相关度返回的相册原名顺序；本地列表按它重排，封面/隐藏状态沿用原条目。
  final RxList<String> searchOrder = <String>[].obs;
  /// 已识别的场景标签，用于给用户看「已识别：日落 · 海滩」
  final RxList<String> searchTags = <String>[].obs;
  /// 词表没覆盖到的片段，用于提示「没听懂：xxx」
  final RxList<String> searchUnmatched = <String>[].obs;
  /// 是否走了语义解析（false = 退回标签名子串）
  final RxBool searchSemantic = false.obs;
  final RxBool isSearching = false.obs;
  /// 竞态保护：只接受最后一次请求的响应
  int _searchSeq = 0;

  final ScrollController scrollController = ScrollController();

  @override
  void onInit() {
    super.onInit();
    refreshScenes();
  }

  @override
  void onClose() {
    scrollController.dispose();
    searchController.dispose();
    _searchDebounce?.cancel();
    super.onClose();
  }

  Future<void> refreshScenes() async {
    if (scrollController.hasClients) {
      scrollController.jumpTo(0);
    }
    if (isLoading.value) return;
    isLoading.value = true;
    try {
      final res = await _api.listScenes(status: 'all');
      if (!res.success || res.data == null) return;
      final data = res.data!;
      placeEnabled.value = data.placeEnable;
      if (!placeEnabled.value) {
        activeScene.value = null;
        allItems.clear();
        items.clear();
        return;
      }
      allItems.assignAll(data.items);
      final q = keyword.value.trim();
      if (q.isEmpty) {
        _applyFilter();
      } else {
        // 列表刷新后，命中顺序要重新算（相册集合可能变了）
        await _runSearch(q);
      }
    } finally {
      isLoading.value = false;
    }
  }

  void _clearSearchState() {
    _searchSeq += 1;
    searchOrder.clear();
    searchTags.clear();
    searchUnmatched.clear();
    searchSemantic.value = false;
    isSearching.value = false;
  }

  void _applyFilter() {
    final filter = statusFilter.value;
    final q = keyword.value.trim().toLowerCase();

    bool matchStatus(AiSceneItem e) {
      if (filter == 'all') return true;
      if (filter == 'hide' || filter == 'hidden') return e.isHide;
      return !e.isHide;
    }

    if (q.isEmpty) {
      items.assignAll(allItems.where(matchStatus));
      return;
    }

    // 服务端没给命中顺序（接口不可用 / 还没返回）时退回本地子串，
    // 保证「搜不出东西」永远好过「搜错东西」。
    if (searchOrder.isEmpty) {
      items.assignAll(
        allItems.where(
          (e) => matchStatus(e) && e.placeName.toLowerCase().contains(q),
        ),
      );
      return;
    }

    final rank = <String, int>{};
    for (int i = 0; i < searchOrder.length; i++) {
      rank.putIfAbsent(searchOrder[i], () => i);
    }
    final hit = <AiSceneItem>[];
    for (final e in allItems) {
      if (!matchStatus(e)) continue;
      if (!rank.containsKey(e.placeNameRaw)) continue;
      hit.add(e);
    }
    hit.sort(
      (a, b) => (rank[a.placeNameRaw] ?? 0).compareTo(rank[b.placeNameRaw] ?? 0),
    );
    items.assignAll(hit);
  }

  /// 语义搜索：把关键词交给服务端解析，拿回「命中相册的顺序 + 已识别标签」
  Future<void> _runSearch(String q) async {
    final seq = ++_searchSeq;
    isSearching.value = true;
    try {
      final res = await _api.searchScenes(query: q);
      if (seq != _searchSeq || keyword.value.trim() != q) return; // 过期响应丢弃
      if (!res.success || res.data == null) {
        searchOrder.clear();
        searchTags.clear();
        searchUnmatched.clear();
        searchSemantic.value = false;
      } else {
        final d = res.data!;
        searchOrder.assignAll(d.rawNames);
        searchTags.assignAll(d.tags);
        searchUnmatched.assignAll(d.unmatched);
        searchSemantic.value = d.semantic;
      }
    } catch (_) {
      if (seq != _searchSeq) return;
      searchOrder.clear();
      searchTags.clear();
      searchUnmatched.clear();
      searchSemantic.value = false;
    } finally {
      if (seq == _searchSeq) isSearching.value = false;
    }
    if (seq != _searchSeq) return;
    closeScene();
    _applyFilter();
  }

  void setStatusFilter(String status) {
    if (statusFilter.value == status) return;
    statusFilter.value = status;
    closeScene();
    _applyFilter();
  }

  void updateKeyword(String value) {
    _searchDebounce?.cancel();
    _searchDebounce = Timer(const Duration(milliseconds: 300), () {
      final next = value.trim();
      if (keyword.value == next) return;
      keyword.value = next;
      closeScene();
      if (next.isEmpty) {
        _clearSearchState();
        _applyFilter();
        return;
      }
      _runSearch(next);
    });
  }

  void clearKeyword() {
    searchController.clear();
    if (keyword.value.isEmpty) return;
    keyword.value = '';
    _clearSearchState();
    closeScene();
    _applyFilter();
  }

  Future<void> enableSceneRecognition() async {
    if (!CurrentUserController.instance.isAdmin) {
      ToastUtil.show('photo_ai_admin_only'.tr);
      return;
    }
    final res = await _settingsApi.setAiPlaceEnable(true, showLoading: true);
    if (!res.success) {
      ToastUtil.show('operation_failed'.tr);
      return;
    }
    ToastUtil.show('operation_success'.tr);
    await refreshScenes();
  }

  Future<void> setSceneHidden(AiSceneItem scene, bool hide) async {
    final res = await _api.setSceneStatus(
      placeName: scene.placeNameRaw,
      isHide: hide,
    );
    if (!res.success) {
      ToastUtil.show('operation_failed'.tr);
      return;
    }
    for (int i = 0; i < allItems.length; i++) {
      final e = allItems[i];
      if (e.placeNameRaw != scene.placeNameRaw) continue;
      allItems[i] = AiSceneItem(
        placeName: e.placeName,
        placeNameRaw: e.placeNameRaw,
        photoCount: e.photoCount,
        isHide: hide,
        cover: e.cover,
      );
    }
    closeScene();
    _applyFilter();
    ToastUtil.show('operation_success'.tr);
  }

  Future<void> confirmAndResetScenes() async {
    final ok = await DialogUtil.showConfirmDialog(
      title: 'need_confirm'.tr,
      content: 'scene_reset_confirm'.tr,
      confirmText: 'ok'.tr,
      cancelText: 'cancel'.tr,
    );
    if (ok != true) return;

    void dismissLoading() {
      final ctx = Get.overlayContext;
      if (ctx == null) return;
      try {
        final nav = Navigator.of(ctx, rootNavigator: true);
        if (nav.canPop()) nav.pop();
      } catch (_) {}
    }

    DialogUtil.showLoadingDialog(
      message: 'scene_reset_loading'.tr,
      barrierDismissible: false,
    );
    await Future.delayed(Duration.zero);

    try {
      final res = await _api.resetScenes();
      if (!res.success) {
        ToastUtil.show('operation_failed'.tr);
        return;
      }
      activeScene.value = null;
      await refreshScenes();
      ToastUtil.show('operation_success'.tr);
    } finally {
      dismissLoading();
    }
  }

  void openScene(BuildContext context, AiSceneItem scene) {
    if (DeviceUtils.isMobile) {
      final name = scene.placeName.trim();
      final displayName = name.isNotEmpty ? name : 'scene_unnamed'.tr;
      Navigator.of(context).push(
        MaterialPageRoute(
          builder: (_) => AppPhotoTimelineRoutePage(
            title: "${"photo_menu_ai_scene".tr}-$displayName",
            listType: 'timeline',
            placeName: scene.placeNameRaw,
          ),
        ),
      );
      return;
    }
    activeScene.value = scene;
  }

  void closeScene() {
    activeScene.value = null;
  }
}
