import 'package:flutter/material.dart';
import 'package:get/get.dart';

import '../controller/photo_ask_controller.dart';

/// ⭐ 2026-10-18 相册 AI 问答浮窗（右下角小球 → 展开面板）。
///
/// 挂在 PhotoHomeView 最外层，所以相册里任何页面都能随手问一句，不用跳走。
/// 面板不遮挡主要内容：贴右下角、宽度上限 380。
class PhotoAskOverlay extends StatefulWidget {
  const PhotoAskOverlay({super.key});

  @override
  State<PhotoAskOverlay> createState() => _PhotoAskOverlayState();
}

class _PhotoAskOverlayState extends State<PhotoAskOverlay> {
  late final PhotoAskController _ctrl;
  final TextEditingController _input = TextEditingController();
  final ScrollController _scroll = ScrollController();

  @override
  void initState() {
    super.initState();
    _ctrl = Get.isRegistered<PhotoAskController>()
        ? Get.find<PhotoAskController>()
        : Get.put(PhotoAskController());
  }

  @override
  void dispose() {
    _input.dispose();
    _scroll.dispose();
    super.dispose();
  }

  Future<void> _send([String? preset]) async {
    final q = preset ?? _input.text;
    if (q.trim().isEmpty) return;
    _input.clear();
    await _ctrl.ask(q);
    _scrollToBottom();
  }

  void _scrollToBottom() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!_scroll.hasClients) return;
      _scroll.animateTo(
        _scroll.position.maxScrollExtent,
        duration: const Duration(milliseconds: 220),
        curve: Curves.easeOut,
      );
    });
  }

  @override
  Widget build(BuildContext context) {
    return Obx(() {
      return _ctrl.expanded.value ? _buildPanel(context) : _buildFab(context);
    });
  }

  Widget _buildFab(BuildContext context) {
    final theme = Theme.of(context);
    return Tooltip(
      message: 'photo_ask_title'.tr,
      child: Material(
        color: theme.colorScheme.primary,
        shape: const CircleBorder(),
        elevation: 3,
        child: InkWell(
          customBorder: const CircleBorder(),
          onTap: () => _ctrl.toggle(),
          child: SizedBox(
            width: 48,
            height: 48,
            child: Icon(Icons.auto_awesome, size: 22, color: theme.colorScheme.onPrimary),
          ),
        ),
      ),
    );
  }

  Widget _buildPanel(BuildContext context) {
    final theme = Theme.of(context);
    final screen = MediaQuery.of(context).size;
    final width = screen.width < 420 ? screen.width - 32 : 380.0;
    final height = screen.height < 620 ? screen.height * 0.6 : 470.0;

    return SizedBox(
      width: width,
      height: height,
      child: Material(
        color: theme.colorScheme.surface,
        borderRadius: BorderRadius.circular(16),
        elevation: 6,
        child: Column(
          children: [
            _buildHeader(context),
            Divider(
              height: 1,
              color: theme.colorScheme.outlineVariant.withValues(alpha: 0.4),
            ),
            Expanded(child: _buildMessages(context)),
            _buildInput(context),
          ],
        ),
      ),
    );
  }

  Widget _buildHeader(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.fromLTRB(14, 10, 6, 10),
      child: Row(
        children: [
          Icon(Icons.auto_awesome, size: 17, color: theme.colorScheme.primary),
          const SizedBox(width: 8),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  'photo_ask_title'.tr,
                  style: theme.textTheme.titleSmall
                      ?.copyWith(fontWeight: FontWeight.w700),
                ),
                Text(
                  'photo_ask_subtitle'.tr,
                  style: theme.textTheme.labelSmall?.copyWith(
                    color: theme.colorScheme.onSurfaceVariant,
                  ),
                ),
              ],
            ),
          ),
          IconButton(
            tooltip: 'clear'.tr,
            onPressed: _ctrl.messages.isEmpty ? null : _ctrl.clear,
            icon: const Icon(Icons.restart_alt, size: 18),
            visualDensity: VisualDensity.compact,
          ),
          IconButton(
            tooltip: 'close'.tr,
            onPressed: _ctrl.close,
            icon: const Icon(Icons.close, size: 18),
            visualDensity: VisualDensity.compact,
          ),
        ],
      ),
    );
  }

  Widget _buildMessages(BuildContext context) {
    final theme = Theme.of(context);
    final list = _ctrl.messages;
    if (list.isEmpty && !_ctrl.sending.value) {
      final presets = [
        'photo_ask_q1'.tr,
        'photo_ask_q2'.tr,
        'photo_ask_q3'.tr,
        'photo_ask_q4'.tr,
      ];
      return SingleChildScrollView(
        padding: const EdgeInsets.all(14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              'photo_ask_presets'.tr,
              style: theme.textTheme.labelSmall?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
              ),
            ),
            const SizedBox(height: 10),
            for (final p in presets)
              Padding(
                padding: const EdgeInsets.only(bottom: 8),
                child: InkWell(
                  onTap: () => _send(p),
                  borderRadius: BorderRadius.circular(10),
                  child: Container(
                    width: double.infinity,
                    padding:
                        const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
                    decoration: BoxDecoration(
                      color: theme.colorScheme.surfaceContainerHighest
                          .withValues(alpha: 0.4),
                      borderRadius: BorderRadius.circular(10),
                    ),
                    child: Text(p, style: theme.textTheme.bodySmall),
                  ),
                ),
              ),
          ],
        ),
      );
    }
    return ListView.builder(
      controller: _scroll,
      padding: const EdgeInsets.fromLTRB(14, 12, 14, 8),
      itemCount: list.length + (_ctrl.sending.value ? 1 : 0),
      itemBuilder: (context, i) {
        if (i >= list.length) {
          return Padding(
            padding: const EdgeInsets.only(bottom: 10),
            child: Row(
              children: [
                const SizedBox(
                  width: 14,
                  height: 14,
                  child: CircularProgressIndicator(strokeWidth: 2),
                ),
                const SizedBox(width: 8),
                Text(
                  'photo_ask_thinking'.tr,
                  style: theme.textTheme.labelSmall?.copyWith(
                    color: theme.colorScheme.onSurfaceVariant,
                  ),
                ),
              ],
            ),
          );
        }
        final m = list[i];
        final isUser = m.role == 'user';
        return Align(
          alignment: isUser ? Alignment.centerRight : Alignment.centerLeft,
          child: Container(
            margin: const EdgeInsets.only(bottom: 10),
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 9),
            constraints: const BoxConstraints(maxWidth: 290),
            decoration: BoxDecoration(
              color: isUser
                  ? theme.colorScheme.primary.withValues(alpha: 0.10)
                  : theme.colorScheme.surfaceContainerHighest
                      .withValues(alpha: 0.5),
              borderRadius: BorderRadius.circular(12),
            ),
            child: Text(
              m.text,
              style: theme.textTheme.bodySmall?.copyWith(
                height: 1.55,
                color: m.failed ? theme.colorScheme.error : null,
              ),
            ),
          ),
        );
      },
    );
  }

  Widget _buildInput(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.fromLTRB(10, 6, 10, 10),
      child: Column(
        children: [
          if (_ctrl.ruleMode.value)
            Padding(
              padding: const EdgeInsets.only(bottom: 6),
              child: Row(
                children: [
                  Icon(Icons.info_outline,
                      size: 12, color: theme.colorScheme.onSurfaceVariant),
                  const SizedBox(width: 5),
                  Expanded(
                    child: Text(
                      'photo_ask_rule_mode'.tr,
                      style: theme.textTheme.labelSmall?.copyWith(
                        color: theme.colorScheme.onSurfaceVariant,
                        fontSize: 10,
                      ),
                    ),
                  ),
                ],
              ),
            ),
          Row(
            children: [
              Expanded(
                child: TextField(
                  controller: _input,
                  onSubmitted: (_) => _send(),
                  decoration: InputDecoration(
                    hintText: 'photo_ask_placeholder'.tr,
                    hintStyle: theme.textTheme.bodySmall?.copyWith(
                      color: theme.colorScheme.onSurfaceVariant,
                    ),
                    isDense: true,
                    contentPadding:
                        const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
                    border: OutlineInputBorder(
                      borderRadius: BorderRadius.circular(20),
                      borderSide: BorderSide(
                        color: theme.colorScheme.outlineVariant
                            .withValues(alpha: 0.6),
                      ),
                    ),
                    enabledBorder: OutlineInputBorder(
                      borderRadius: BorderRadius.circular(20),
                      borderSide: BorderSide(
                        color: theme.colorScheme.outlineVariant
                            .withValues(alpha: 0.6),
                      ),
                    ),
                  ),
                ),
              ),
              const SizedBox(width: 8),
              Material(
                color: theme.colorScheme.primary,
                shape: const CircleBorder(),
                child: InkWell(
                  customBorder: const CircleBorder(),
                  onTap: () => _send(),
                  child: SizedBox(
                    width: 36,
                    height: 36,
                    child: Icon(Icons.arrow_upward,
                        size: 18, color: theme.colorScheme.onPrimary),
                  ),
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }
}
