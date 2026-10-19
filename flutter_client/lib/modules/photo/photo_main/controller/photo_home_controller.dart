import 'package:get/get.dart';
import '../../../../utils/dialog_util.dart';
import '../../../folder_view/folder_view_module_type.dart';
import '../service/photo_home_api_service.dart';

class PhotoHomeController extends GetxController {
  // ⭐ 2026-10-18 进相册先看「首页」（我的照片 / 拍摄时光 / 足迹 / 人物聚合），
  // 时间线仍在左侧菜单第二项，一点就到。
  final RxString currentPageKey = 'home'.obs;
  final RxDouble leftWidth = 160.0.obs;
  final RxBool sidebarCollapsed = false.obs;

  final RxBool isAllExpanded = true.obs;
  final RxBool isMemoryExpanded = true.obs;
  final RxBool isAlbumExpanded = true.obs;
  final RxBool isAiExpanded = true.obs;
  final RxBool isSettingsExpanded = true.obs;
  // 照片总数
  final RxInt totalCount = 0.obs;

  final PhotoHomeApiService _apiService = PhotoHomeApiService.instance;

  @override
  void onInit() {
    super.onInit();
    fetchTotalCount();
  }

  Future<void> fetchTotalCount() async {
    final res = await _apiService.getTotalCount();
    if (res.success && res.data != null) {
      totalCount.value = res.data!;
    }
  }

  /// ⭐ 2026-10-19 相册的「根层级」：只有这两个页面点窗口 X 才算真的要关相册。
  /// 之前从首页点「我的足迹 / 相册 / AI / 回忆」等子页后，右上角 X 直接把整个
  /// 相册关掉，用户必须先重开再找时间轴 —— 这里把关闭拆成两层。
  static bool isRootPage(String key) => key == 'home' || key == 'all.timeline';

  bool get isRootPageNow => isRootPage(currentPageKey.value);

  /// 回到时间轴（供侧栏「返回」按钮与窗口关闭共用）。
  void backToTimeline() {
    if (currentPageKey.value == 'all.timeline') return;
    currentPageKey.value = 'all.timeline';
  }

  /// 窗口右上角 X 的拦截口。
  /// @returns true = 本次关闭已被消费（只退一层），调用方不要再关窗。
  bool interceptWindowClose() {
    if (isRootPageNow) return false;
    backToTimeline();
    return true;
  }

  /// ⭐ 2026-10-19 首页大搜索栏：把关键词交给时间线。
  /// 存在普通字段（不是 Rx）里 —— 时间线首次构建时取一次就清空，
  /// 期间任何 Obx 重建都不会把它弄丢，也不会触发额外刷新。
  String? _pendingSearch;

  String? takePendingSearch() {
    final q = _pendingSearch;
    _pendingSearch = null;
    return q;
  }

  void openSearch(String keyword) {
    final q = keyword.trim();
    if (q.isEmpty) return;
    _pendingSearch = q;
    selectPage('all.timeline');
  }

  void selectPage(String key) {
    if (key == 'ai.gps_supplement' &&
        !FolderViewModuleType.photo.isServerVersionAtLeast(5)) {
      DialogUtil.showInfoDialog(
        title: 'tip'.tr,
        content: 'server_version_too_low'.tr,
      );
      return;
    }
    currentPageKey.value = key;
  }
}
