import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:get/get.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:WaterNasOS/modules/photo/timeline/models/photo_timeline_model.dart';
import 'package:WaterNasOS/modules/photo/timeline/service/photo_timeline_api_service.dart';

const String _kRecentKey = 'photo_search_recent_v1';
const int _kRecentMax = 8;

/// ⭐ 2026-10-18 相册搜索入口按钮（点击打开搜索浮层）。
///
/// 为什么不在原地做成输入框：这一版搜索已经是「推荐词 + 联想 + 语义解析」三合一，
/// 塞进一条 200px 的工具条里必然挤成火柴盒。点开一个居中的浮层，
/// 推荐词、最近搜索、联想结果才有地方摆。
class PhotoSearchEntry extends StatelessWidget {
  final void Function(String query) onSubmit;
  final String hintText;

  const PhotoSearchEntry({
    super.key,
    required this.onSubmit,
    this.hintText = '',
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return InkWell(
      onTap: () => showPhotoSearchOverlay(context, onSubmit: onSubmit),
      borderRadius: BorderRadius.circular(16),
      child: Container(
        height: 32,
        padding: const EdgeInsets.symmetric(horizontal: 10),
        decoration: BoxDecoration(
          color: theme.colorScheme.surface,
          borderRadius: BorderRadius.circular(16),
          border: Border.all(
            color: theme.colorScheme.outlineVariant.withValues(alpha: 0.55),
          ),
        ),
        child: Row(
          children: [
            Icon(Icons.search, size: 16, color: theme.colorScheme.onSurfaceVariant),
            const SizedBox(width: 6),
            Expanded(
              child: Text(
                hintText.isEmpty ? 'search'.tr : hintText,
                style: theme.textTheme.bodySmall?.copyWith(
                  color: theme.colorScheme.onSurfaceVariant,
                ),
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
              ),
            ),
            Icon(Icons.auto_awesome,
                size: 14, color: theme.colorScheme.primary.withValues(alpha: 0.8)),
          ],
        ),
      ),
    );
  }
}

/// 打开搜索浮层；用户选中/提交后回调 query。
Future<void> showPhotoSearchOverlay(
  BuildContext context, {
  required void Function(String query) onSubmit,
}) async {
  final result = await showDialog<String>(
    context: context,
    barrierColor: Colors.black.withValues(alpha: 0.28),
    builder: (_) => const _PhotoSearchDialog(),
  );
  if (result != null && result.trim().isNotEmpty) {
    onSubmit(result.trim());
  }
}

class _PhotoSearchDialog extends StatefulWidget {
  const _PhotoSearchDialog();

  @override
  State<_PhotoSearchDialog> createState() => _PhotoSearchDialogState();
}

class _PhotoSearchDialogState extends State<_PhotoSearchDialog> {
  final TextEditingController _input = TextEditingController();
  final FocusNode _focus = FocusNode();
  final PhotoTimelineApiService _api = PhotoTimelineApiService();

  List<PhotoSearchSuggestion> _hot = const [];
  List<PhotoSearchSuggestion> _suggestions = const [];
  List<String> _recent = const [];
  bool _loadingHot = true;
  bool _searching = false;
  Timer? _debounce;
  int _seq = 0;

  @override
  void initState() {
    super.initState();
    _loadHot();
    _loadRecent();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) _focus.requestFocus();
    });
  }

  @override
  void dispose() {
    _debounce?.cancel();
    _input.dispose();
    _focus.dispose();
    super.dispose();
  }

  Future<void> _loadHot() async {
    try {
      final res = await _api.hotSearches();
      if (!mounted) return;
      setState(() {
        _hot = res.success ? (res.data ?? const []) : const [];
        _loadingHot = false;
      });
    } catch (_) {
      if (mounted) setState(() => _loadingHot = false);
    }
  }

  Future<void> _loadRecent() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      if (!mounted) return;
      setState(() => _recent = prefs.getStringList(_kRecentKey) ?? const []);
    } catch (_) {}
  }

  Future<void> _pushRecent(String q) async {
    final next = <String>[q, ..._recent.where((e) => e != q)].take(_kRecentMax).toList();
    setState(() => _recent = next);
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setStringList(_kRecentKey, next);
    } catch (_) {}
  }

  void _onChanged(String v) {
    _debounce?.cancel();
    final q = v.trim();
    if (q.isEmpty) {
      setState(() {
        _suggestions = const [];
        _searching = false;
      });
      return;
    }
    _debounce = Timer(const Duration(milliseconds: 260), () => _runSuggest(q));
  }

  Future<void> _runSuggest(String q) async {
    final seq = ++_seq;
    setState(() => _searching = true);
    try {
      final res = await _api.suggestSearch(query: q, limit: 12);
      if (!mounted || seq != _seq) return;
      setState(() {
        _suggestions = res.success ? (res.data ?? const []) : const [];
        _searching = false;
      });
    } catch (_) {
      if (mounted && seq == _seq) setState(() => _searching = false);
    }
  }

  void _submit(String q) {
    final value = q.trim();
    if (value.isEmpty) return;
    _pushRecent(value);
    Navigator.of(context).pop(value);
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final size = MediaQuery.of(context).size;
    final width = size.width < 680 ? size.width - 32 : 620.0;
    final hasQuery = _input.text.trim().isNotEmpty;

    return Dialog(
      backgroundColor: Colors.transparent,
      alignment: Alignment.topCenter,
      insetPadding: EdgeInsets.only(top: size.height * 0.12, left: 16, right: 16),
      child: ConstrainedBox(
        constraints: BoxConstraints(maxWidth: width, maxHeight: size.height * 0.68),
        child: Material(
          color: theme.colorScheme.surface,
          borderRadius: BorderRadius.circular(16),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              _buildInputRow(context),
              Divider(
                height: 1,
                color: theme.colorScheme.outlineVariant.withValues(alpha: 0.4),
              ),
              Flexible(
                child: SingleChildScrollView(
                  padding: const EdgeInsets.fromLTRB(16, 12, 16, 16),
                  child: hasQuery ? _buildSuggestions(context) : _buildIdle(context),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _buildInputRow(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.fromLTRB(14, 8, 8, 8),
      child: Row(
        children: [
          Icon(Icons.search, size: 18, color: theme.colorScheme.onSurfaceVariant),
          const SizedBox(width: 8),
          Expanded(
            child: Shortcuts(
              shortcuts: const {
                SingleActivator(LogicalKeyboardKey.enter): _SubmitIntent(),
              },
              child: Actions(
                actions: {
                  _SubmitIntent: CallbackAction<_SubmitIntent>(
                    onInvoke: (_) {
                      _submit(_input.text);
                      return null;
                    },
                  ),
                },
                child: TextField(
                  controller: _input,
                  focusNode: _focus,
                  onChanged: (v) {
                    setState(() {});
                    _onChanged(v);
                  },
                  textInputAction: TextInputAction.search,
                  onSubmitted: _submit,
                  decoration: InputDecoration(
                    hintText: 'photo_search_hint_full'.tr,
                    hintStyle: theme.textTheme.bodyMedium?.copyWith(
                      color: theme.colorScheme.onSurfaceVariant,
                    ),
                    border: InputBorder.none,
                    isDense: true,
                  ),
                ),
              ),
            ),
          ),
          if (_searching)
            const Padding(
              padding: EdgeInsets.only(right: 8),
              child: SizedBox(
                width: 14,
                height: 14,
                child: CircularProgressIndicator(strokeWidth: 2),
              ),
            ),
          TextButton(
            onPressed: () => Navigator.of(context).pop(),
            child: Text('cancel'.tr),
          ),
        ],
      ),
    );
  }

  Widget _buildIdle(BuildContext context) {
    final theme = Theme.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (_loadingHot)
          const Padding(
            padding: EdgeInsets.symmetric(vertical: 24),
            child: Center(child: CircularProgressIndicator()),
          )
        else if (_hot.isNotEmpty) ...[
          _sectionTitle(context, 'photo_search_recommend'.tr,
              'photo_search_recommend_sub'.tr),
          const SizedBox(height: 10),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              for (final s in _hot)
                _SuggestionChip(
                  label: s.label,
                  count: s.count,
                  icon: _iconOf(s.type),
                  onTap: () => _submit(s.label),
                ),
            ],
          ),
        ],
        if (_recent.isNotEmpty) ...[
          const SizedBox(height: 18),
          Row(
            children: [
              Expanded(child: _sectionTitle(context, 'photo_search_recent'.tr, null)),
              InkWell(
                onTap: () async {
                  setState(() => _recent = const []);
                  try {
                    final prefs = await SharedPreferences.getInstance();
                    await prefs.remove(_kRecentKey);
                  } catch (_) {}
                },
                child: Text(
                  'clear'.tr,
                  style: theme.textTheme.labelSmall?.copyWith(
                    color: theme.colorScheme.onSurfaceVariant,
                  ),
                ),
              ),
            ],
          ),
          const SizedBox(height: 8),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              for (final q in _recent)
                _SuggestionChip(
                  label: q,
                  count: 0,
                  icon: Icons.history,
                  onTap: () => _submit(q),
                ),
            ],
          ),
        ],
        const SizedBox(height: 18),
        Container(
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
          decoration: BoxDecoration(
            color: theme.colorScheme.primary.withValues(alpha: 0.06),
            borderRadius: BorderRadius.circular(10),
          ),
          child: Row(
            children: [
              Icon(Icons.tips_and_updates_outlined,
                  size: 15, color: theme.colorScheme.primary),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  'photo_search_tip'.tr,
                  style: theme.textTheme.labelSmall?.copyWith(
                    color: theme.colorScheme.onSurfaceVariant,
                    height: 1.5,
                  ),
                ),
              ),
            ],
          ),
        ),
      ],
    );
  }

  Widget _buildSuggestions(BuildContext context) {
    final theme = Theme.of(context);
    if (_suggestions.isEmpty) {
      if (_searching) return const SizedBox(height: 60);
      return Padding(
        padding: const EdgeInsets.symmetric(vertical: 20),
        child: Column(
          children: [
            Text(
              'photo_search_no_match'.tr,
              style: theme.textTheme.bodyMedium?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
              ),
            ),
            const SizedBox(height: 10),
            TextButton(
              onPressed: () => _submit(_input.text),
              child: Text('photo_search_search_anyway'.tr),
            ),
          ],
        ),
      );
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        _sectionTitle(context, 'photo_search_suggestions'.tr, null),
        const SizedBox(height: 6),
        for (final s in _suggestions)
          InkWell(
            onTap: () => _submit(s.label),
            borderRadius: BorderRadius.circular(8),
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 9),
              child: Row(
                children: [
                  Icon(_iconOf(s.type),
                      size: 16, color: theme.colorScheme.onSurfaceVariant),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Text(
                      s.label,
                      style: theme.textTheme.bodyMedium,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                    ),
                  ),
                  if (s.count > 0)
                    Text(
                      '${s.count}',
                      style: theme.textTheme.labelSmall?.copyWith(
                        color: theme.colorScheme.onSurfaceVariant,
                      ),
                    ),
                ],
              ),
            ),
          ),
      ],
    );
  }

  Widget _sectionTitle(BuildContext context, String title, String? sub) {
    final theme = Theme.of(context);
    return Row(
      crossAxisAlignment: CrossAxisAlignment.baseline,
      textBaseline: TextBaseline.alphabetic,
      children: [
        Text(
          title,
          style: theme.textTheme.labelLarge?.copyWith(
            fontWeight: FontWeight.w600,
            color: theme.colorScheme.onSurface,
          ),
        ),
        if (sub != null) ...[
          const SizedBox(width: 8),
          Flexible(
            child: Text(
              sub,
              style: theme.textTheme.labelSmall?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
              ),
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
            ),
          ),
        ],
      ],
    );
  }

  IconData _iconOf(String type) {
    switch (type) {
      case 'person':
        return Icons.person_outline;
      case 'scene':
        return Icons.landscape_outlined;
      case 'activity':
        return Icons.directions_run;
      case 'camera':
        return Icons.camera_alt_outlined;
      case 'filename':
        return Icons.description_outlined;
      case 'ocr':
        return Icons.text_fields;
      case 'year':
        return Icons.calendar_today_outlined;
      default:
        return Icons.search;
    }
  }
}

class _SubmitIntent extends Intent {
  const _SubmitIntent();
}

class _SuggestionChip extends StatelessWidget {
  final String label;
  final int count;
  final IconData icon;
  final VoidCallback onTap;

  const _SuggestionChip({
    required this.label,
    required this.count,
    required this.icon,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(18),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
        decoration: BoxDecoration(
          color: theme.colorScheme.surfaceContainerHighest.withValues(alpha: 0.45),
          borderRadius: BorderRadius.circular(18),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(icon, size: 13, color: theme.colorScheme.onSurfaceVariant),
            const SizedBox(width: 5),
            Text(label, style: theme.textTheme.bodySmall),
            if (count > 0) ...[
              const SizedBox(width: 5),
              Text(
                '$count',
                style: theme.textTheme.labelSmall?.copyWith(
                  color: theme.colorScheme.onSurfaceVariant,
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }
}
