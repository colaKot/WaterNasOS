import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:get/get.dart';

import '../../../../../core/theme/custom_colors.dart';
import '../../../timeline/models/photo_timeline_model.dart';
import '../../../timeline/view/app_photo_timeline_view.dart';
import '../../models/ai_faces_models.dart';
import '../../service/photo_ai_faces_api_service.dart';

/// ⭐ 2026-10-16 P0-5 人物关系图谱。
///
/// 数据只有两样：**共同出现的次数**（边）和人物（点），全部来自 photo_face2filehash 的同框关系，
/// 不需要任何新模型 —— 这里只是把「谁和谁总是一起出现」画出来。
///
/// 布局用**放射式**：出镜最多的人放圆心，其余按共现强度排布在外圈；
/// 连线粗细 ∝ 同框张数，最强的几条线上标注张数。点人物进入他/她的时间轴。
///
/// ⚠️ 这个项目此前**没有**任何图谱/关系可视化组件（地图那边的聚簇不算），所以这里是新建的
/// 通用 CustomPaint 画法，后续记忆图谱（P1-14）可以直接复用。
class AiFaceRelationPage extends StatefulWidget {
  const AiFaceRelationPage({super.key});

  @override
  State<AiFaceRelationPage> createState() => _AiFaceRelationPageState();
}

class _AiFaceRelationPageState extends State<AiFaceRelationPage> {
  final PhotoAiFacesApiService _api = PhotoAiFacesApiService();
  AiFaceRelationsResult _data = const AiFaceRelationsResult(
    nodes: <AiFaceRelationNode>[],
    edges: <AiFaceRelationEdge>[],
  );
  bool _loading = true;

  /// 布局结果：faceId -> 圆心坐标（在 layout 阶段算好，命中测试复用）
  final Map<int, Offset> _positions = <int, Offset>{};
  Size _canvasSize = Size.zero;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final res = await _api.listRelations();
    if (!mounted) return;
    setState(() {
      _data = (res.success && res.data != null)
          ? res.data!
          : const AiFaceRelationsResult(
              nodes: <AiFaceRelationNode>[],
              edges: <AiFaceRelationEdge>[],
            );
      _loading = false;
    });
  }

  void _openPerson(AiFaceRelationNode node) {
    Navigator.of(context).push(
      MaterialPageRoute(
        builder: (_) => AppPhotoTimelineRoutePage(
          title: node.displayName,
          faceId: node.faceId,
        ),
      ),
    );
  }

  /// 命中测试：找离点击点最近、且在半径内的节点。
  void _handleTap(Offset pos) {
    int? hit;
    double best = double.infinity;
    for (final node in _data.nodes) {
      final p = _positions[node.faceId];
      if (p == null) continue;
      final d = (p - pos).distance;
      if (d < 26 && d < best) {
        best = d;
        hit = node.faceId;
      }
    }
    if (hit == null) return;
    for (final node in _data.nodes) {
      if (node.faceId == hit) {
        _openPerson(node);
        return;
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final customColors = theme.extension<CustomColors>();
    return Scaffold(
      backgroundColor: customColors?.mainContentBgColor,
      appBar: AppBar(title: Text('photo_face_relations'.tr)),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : (_data.nodes.isEmpty || _data.edges.isEmpty
              ? Padding(
                  padding: const EdgeInsets.all(28),
                  child: Center(child: Text('photo_face_relations_empty'.tr)),
                )
              : Column(
                  children: [
                    Padding(
                      padding: const EdgeInsets.fromLTRB(16, 12, 16, 0),
                      child: Text(
                        'photo_face_relations_hint'.tr,
                        style: theme.textTheme.bodySmall?.copyWith(
                          color: theme.colorScheme.onSurfaceVariant,
                        ),
                      ),
                    ),
                    Expanded(
                      child: LayoutBuilder(
                        builder: (ctx, c) {
                          _canvasSize = Size(c.maxWidth, c.maxHeight);
                          _computeLayout(_canvasSize);
                          return GestureDetector(
                            onTapUp: (d) => _handleTap(d.localPosition),
                            child: CustomPaint(
                              size: Size.infinite,
                              painter: _FaceRelationPainter(
                                nodes: _data.nodes,
                                edges: _data.edges,
                                positions: _positions,
                                primary: theme.colorScheme.primary,
                                labelColor: theme.colorScheme.onSurface,
                                muted: theme.colorScheme.onSurfaceVariant,
                                surface: customColors?.mainContentBgColor ??
                                    theme.scaffoldBackgroundColor,
                                edgeLabel: 'photo_face_relation_together'.tr,
                                textDirection: Directionality.of(context),
                              ),
                            ),
                          );
                        },
                      ),
                    ),
                  ],
                )),
    );
  }

  /// 放射布局：中心=出镜最多的人，其余按共现强度排在外圈。
  void _computeLayout(Size size) {
    _positions.clear();
    if (size.width <= 0 || size.height <= 0) return;
    final nodes = List<AiFaceRelationNode>.from(_data.nodes)
      ..sort((a, b) => b.faceCount.compareTo(a.faceCount));
    if (nodes.isEmpty) return;

    final center = Offset(size.width / 2, size.height / 2);
    final ring = math.min(size.width, size.height) * 0.34;

    // 每个节点的共现总强度（决定角度排序，让关系近的挨着）
    final weightOf = <int, int>{};
    for (final e in _data.edges) {
      weightOf[e.a] = (weightOf[e.a] ?? 0) + e.count;
      weightOf[e.b] = (weightOf[e.b] ?? 0) + e.count;
    }

    final hub = nodes.first;
    _positions[hub.faceId] = center;

    final rest = nodes.skip(1).toList()
      ..sort((a, b) => (weightOf[b.faceId] ?? 0).compareTo(weightOf[a.faceId] ?? 0));
    final n = rest.length;
    for (var i = 0; i < n; i++) {
      final angle = (2 * math.pi * i) / math.max(1, n) - math.pi / 2;
      _positions[rest[i].faceId] = Offset(
        center.dx + ring * math.cos(angle),
        center.dy + ring * math.sin(angle),
      );
    }
  }
}

class _FaceRelationPainter extends CustomPainter {
  final List<AiFaceRelationNode> nodes;
  final List<AiFaceRelationEdge> edges;
  final Map<int, Offset> positions;
  final Color primary;
  final Color labelColor;
  final Color muted;
  final Color surface;
  final String edgeLabel;
  final TextDirection textDirection;

  _FaceRelationPainter({
    required this.nodes,
    required this.edges,
    required this.positions,
    required this.primary,
    required this.labelColor,
    required this.muted,
    required this.surface,
    required this.edgeLabel,
    required this.textDirection,
  });

  @override
  void paint(Canvas canvas, Size size) {
    if (positions.isEmpty) return;
    final maxCount = edges.isEmpty
        ? 1
        : edges.map((e) => e.count).reduce((a, b) => a > b ? a : b);
    final sortedEdges = List<AiFaceRelationEdge>.from(edges)
      ..sort((a, b) => b.count.compareTo(a.count));

    // 1) 连线
    for (final e in sortedEdges) {
      final p1 = positions[e.a];
      final p2 = positions[e.b];
      if (p1 == null || p2 == null) continue;
      final t = e.count / maxCount;
      final paint = Paint()
        ..color = primary.withValues(alpha: 0.12 + 0.42 * t)
        ..strokeWidth = 0.8 + 4.2 * t
        ..style = PaintingStyle.stroke;
      canvas.drawLine(p1, p2, paint);
    }

    // 2) 节点
    final maxFace = nodes.isEmpty
        ? 1
        : nodes.map((e) => e.faceCount).reduce((a, b) => a > b ? a : b);
    for (final node in nodes) {
      final p = positions[node.faceId];
      if (p == null) continue;
      final t = node.faceCount / maxFace;
      final r = 11 + 17 * math.sqrt(t.clamp(0.0, 1.0));
      canvas.drawCircle(p, r, Paint()..color = primary.withValues(alpha: 0.85));
      canvas.drawCircle(
        p,
        r,
        Paint()
          ..color = surface
          ..strokeWidth = 2
          ..style = PaintingStyle.stroke,
      );
      _drawText(
        canvas,
        node.displayName,
        Offset(p.dx, p.dy + r + 3),
        labelColor,
        11,
        maxWidth: 96,
      );
    }

    // 3) 最强前 5 条边上标张数
    for (final e in sortedEdges.take(5)) {
      final p1 = positions[e.a];
      final p2 = positions[e.b];
      if (p1 == null || p2 == null) continue;
      _drawText(
        canvas,
        '${e.count}',
        Offset((p1.dx + p2.dx) / 2, (p1.dy + p2.dy) / 2 - 9),
        muted,
        10,
        maxWidth: 60,
      );
    }
  }

  void _drawText(Canvas canvas, String text, Offset center, Color color, double size,
      {double maxWidth = 120}) {
    final tp = TextPainter(
      text: TextSpan(
        text: text,
        style: TextStyle(color: color, fontSize: size, fontWeight: FontWeight.w600),
      ),
      textDirection: textDirection,
      maxLines: 1,
      ellipsis: '…',
    )..layout(maxWidth: maxWidth);
    tp.paint(canvas, Offset(center.dx - tp.width / 2, center.dy));
  }

  @override
  bool shouldRepaint(covariant _FaceRelationPainter old) {
    return old.nodes != nodes || old.edges != edges || old.positions != positions;
  }
}
