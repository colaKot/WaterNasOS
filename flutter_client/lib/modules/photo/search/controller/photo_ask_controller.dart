import 'package:get/get.dart';

import 'package:WaterNasOS/modules/photo/ai_setting/service/photo_ai_settings_api_service.dart';

/// 一条问答消息
class PhotoAskMessage {
  final String role; // user / assistant
  final String text;
  final String mode; // model / rule / ''
  final bool failed;

  const PhotoAskMessage({
    required this.role,
    required this.text,
    this.mode = '',
    this.failed = false,
  });
}

/// ⭐ 2026-10-18 相册 AI 问答控制器。
///
/// 服务端先算好本地统计，再决定用模型还是本地规则回答（见 `appAiService.ask`）。
/// 这里只负责会话状态 —— 不做多轮上下文：相册问答绝大多数是一问一答，
/// 硬塞历史反而会让「我拍了多少照片」这种问题被前面的话题带偏。
class PhotoAskController extends GetxController {
  PhotoAiSettingsApiService get _api => PhotoAiSettingsApiService.instance;

  final RxList<PhotoAskMessage> messages = <PhotoAskMessage>[].obs;
  final RxBool sending = false.obs;
  final RxBool expanded = false.obs;

  /// 最近一次回答是否走了本地规则（用于在气泡下方提示「未配置模型」）
  final RxBool ruleMode = false.obs;

  void toggle() => expanded.value = !expanded.value;

  void close() => expanded.value = false;

  Future<void> ask(String question) async {
    final q = question.trim();
    if (q.isEmpty || sending.value) return;
    messages.add(PhotoAskMessage(role: 'user', text: q));
    sending.value = true;
    try {
      final res = await _api.ask(q);
      if (res.success && res.data != null) {
        final data = res.data!;
        final mode = (data['mode'] ?? '').toString();
        final answer = (data['answer'] ?? '').toString().trim();
        ruleMode.value = mode == 'rule';
        messages.add(PhotoAskMessage(
          role: 'assistant',
          text: answer.isEmpty ? 'photo_ask_empty_answer'.tr : answer,
          mode: mode,
        ));
      } else {
        messages.add(PhotoAskMessage(
          role: 'assistant',
          text: 'operation_failed'.tr,
          failed: true,
        ));
      }
    } catch (_) {
      messages.add(PhotoAskMessage(
        role: 'assistant',
        text: 'operation_failed'.tr,
        failed: true,
      ));
    } finally {
      sending.value = false;
    }
  }

  void clear() {
    messages.clear();
    ruleMode.value = false;
  }
}
