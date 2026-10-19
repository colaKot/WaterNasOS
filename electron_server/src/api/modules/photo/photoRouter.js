const express = require('express');
const router = express.Router();
const { authenticateJWT, requireAdmin, requireSuperAdmin } = require('../../middleware/authMiddleware');
const { requirePermission } = require('../../middleware/permissionMiddleware');
const photoSourceController = require('./source/photoSourceController');
const photoConfigController = require('./config/photoConfigController');
const photoTimeLineController = require('./timeline/photoTimeLineController');
const photoAlbumController = require('./album/photoAlbumController');
const photoCollectionController = require('./collection/photoCollectionController');
const photoSmartAlbumController = require('./smartAlbum/photoSmartAlbumController');
const photoPropertiesController = require('./properties/photoPropertiesController');
const faceController = require('./face/faceController');
const placesController = require('./places/placesController');
const similarController = require('./similar/similarController');
const gpsSupplementController = require('./gps_add/gpsSupplementController');
const appAiController = require('./app_ai/appAiController');
const fileListController = require('../file/list/fileListController');

function createFileViewHandler(sourceType, action) {
  return (req, res) => {
    req.body = { ...(req.body || {}), sourceType };
    return fileListController[action](req, res);
  };
}
// 相册备份：跨相册源内容级去重（只读；只比对本人的相册源）
router.post('/backup/check_content', authenticateJWT, photoSourceController.checkBackupContent);
// 来源设置（按 owner 隔离：用户只能管理自己添加的源目录；管理员可用 body.uid 指定他人）
router.post('/source/list', authenticateJWT, photoSourceController.listSources);
router.post('/source/add', authenticateJWT, photoSourceController.addSource);
router.post('/source/delete', authenticateJWT, photoSourceController.deleteSource);
router.post('/source/update/:id', authenticateJWT, photoSourceController.updateSource);
router.post('/source/relocate/:id', authenticateJWT, photoSourceController.relocateSource);
router.post('/source/scan', authenticateJWT, photoSourceController.scanSource);
// 缩略图重建是全库级操作，仍限管理员
router.post('/source/regenerate_thumbnails', authenticateJWT, requireAdmin, photoSourceController.regenerateThumbnails);
//是否启用ocr
router.post('/setAiOcrEnable', authenticateJWT, requireSuperAdmin, photoConfigController.setAiOcrEnable);
router.post('/setAiPetEnable', authenticateJWT, requireSuperAdmin, photoConfigController.setAiPetEnable);
router.post('/setAiFaceEnable', authenticateJWT, requireSuperAdmin, photoConfigController.setAiFaceEnable);
router.post('/setAiFaceMinShowCount', authenticateJWT, requireSuperAdmin, photoConfigController.setAiFaceMinShowCount);
router.post('/setAiPlaceEnable', authenticateJWT, requireSuperAdmin, photoConfigController.setAiPlaceEnable);
router.post('/setAiActivityEnable', authenticateJWT, requireSuperAdmin, photoConfigController.setAiActivityEnable);
router.post('/setAiSimilarEnable', authenticateJWT, requireSuperAdmin, photoConfigController.setAiSimilarEnable);
router.post('/setAiGpuPrefer', authenticateJWT, requireSuperAdmin, photoConfigController.setAiGpuPrefer);
router.post('/getAiConfig', authenticateJWT, requireSuperAdmin, photoConfigController.getAiConfig);
router.post('/getPreviewConfig', authenticateJWT, photoConfigController.getPreviewConfig);
router.post('/setPreviewSize', authenticateJWT, photoConfigController.setPreviewSize);
 
// TimeLine
router.post('/timeline/count', authenticateJWT, photoTimeLineController.getPhotoTotalCount);
router.post('/timeline/dates', authenticateJWT, photoTimeLineController.getTimelineDateList);
router.post('/timeline/photos', authenticateJWT, photoTimeLineController.getTimelinePhotoList);
router.post('/timeline/years', authenticateJWT, photoTimeLineController.getTimelineYearList);
// places
router.post('/place/list', authenticateJWT, placesController.listPlaces);
router.post('/place/search', authenticateJWT, placesController.searchPlaces);
// ⭐ 2026-10-16 P0-1 只解析不查库：给时间轴搜索框回「已识别 / 未识别 / 活动命中」
router.post('/place/parse', authenticateJWT, placesController.parseQuery);
// ⭐ 2026-10-16 P0-3 以图搜图：file_hash | path | image_base64 → 可见范围内最像的 N 张
router.post('/place/search_image', authenticateJWT, placesController.searchImage);
// ⭐ 2026-10-16 P0-4 搜索联想聚合（人物/场景/活动/相机/文件名/OCR/年份）
router.post('/search/suggest', authenticateJWT, placesController.suggest);
// ⭐ 2026-10-18 搜索浮层推荐词（按当前用户自己的库算）
router.post('/search/hot', authenticateJWT, (req, res) => placesController.hot(req, res));
router.post('/place/status/set', authenticateJWT, requireAdmin, placesController.setPlaceStatus);
router.post('/place/reset', authenticateJWT, requireAdmin, placesController.resetPlaces);
router.post('/place/activity/reset', authenticateJWT, requireAdmin, placesController.resetActivity);

// map
router.post('/getBoundsPhoto', authenticateJWT, photoTimeLineController.getBoundsPhoto);

// Properties
router.post('/properties/get', authenticateJWT, requirePermission(['view'], { from: 'body.path' }), photoPropertiesController.get);

// Favorite
router.post('/favorite/toggle', authenticateJWT, photoTimeLineController.toggleFavorite);
router.post('/favorite/batch', authenticateJWT, photoTimeLineController.batchFavorite);
// 获取相册下载的所需信息
router.post('/download/info', authenticateJWT, photoAlbumController.getDownloadInfo);

// Album
router.post('/album/list', authenticateJWT, photoAlbumController.listAlbums);
router.post('/album/overview', authenticateJWT, photoAlbumController.getAlbumOverview);
router.post('/album/get', authenticateJWT, photoAlbumController.getAlbum);
router.post('/album/create', authenticateJWT, photoAlbumController.createAlbum);
router.post('/album/delete', authenticateJWT, photoAlbumController.deleteAlbum);
router.post('/album/update', authenticateJWT, photoAlbumController.updateAlbum);
router.post('/album/index/add', authenticateJWT, photoAlbumController.addAlbumIndexes);
router.post('/album/index/remove', authenticateJWT, photoAlbumController.removeAlbumIndexes);
router.post('/album/cover/set', authenticateJWT, photoAlbumController.setAlbumCover);
router.get('/album/download/:filename?', authenticateJWT, photoAlbumController.downloadAlbumPhotos);
// Collection
router.post('/collection/list', authenticateJWT, photoCollectionController.listCollections);
router.post('/collection/get', authenticateJWT, photoCollectionController.getCollection);
router.post('/collection/create', authenticateJWT, photoCollectionController.createCollection);
router.post('/collection/delete', authenticateJWT, photoCollectionController.deleteCollection);
router.post('/collection/update', authenticateJWT, photoCollectionController.updateCollection);

// Smart Album
router.post('/smart_album/list', authenticateJWT, photoSmartAlbumController.listSmartAlbums);
router.post('/smart_album/get', authenticateJWT, photoSmartAlbumController.getSmartAlbum);
router.post('/smart_album/create', authenticateJWT, photoSmartAlbumController.createSmartAlbum);
router.post('/smart_album/update', authenticateJWT, photoSmartAlbumController.updateSmartAlbum);
router.post('/smart_album/delete', authenticateJWT, photoSmartAlbumController.deleteSmartAlbum);

// Trash
router.post('/trash/add', authenticateJWT, photoTimeLineController.batchTrash);
router.post('/trash/list', authenticateJWT, photoTimeLineController.getTrashPhotoList);
router.post('/trash/restore', authenticateJWT, photoTimeLineController.restoreFromTrash);
router.post('/trash/delete', authenticateJWT, photoTimeLineController.deleteFromTrash);
router.post('/trash/empty', authenticateJWT, photoTimeLineController.emptyTrash);
// ⭐ 2026-10-16 P0-6 写操作「预演 → 执行 → 可撤销」
router.post('/trash/preview', authenticateJWT, photoTimeLineController.previewTrash);
router.post('/operation/undo', authenticateJWT, photoTimeLineController.undoOperation);
router.post('/operation/recent', authenticateJWT, photoTimeLineController.recentOperations);

// Face
router.post('/face/list', authenticateJWT, faceController.listFaces);
router.get('/face/download/:filename?', authenticateJWT, faceController.downloadFacePhotos);
router.post('/face/reset', authenticateJWT, requireAdmin, faceController.resetFaces);
router.post('/face/cover/set', authenticateJWT, requireAdmin, faceController.setFaceCover);
// 命名只是「给自己看」的标签，不影响聚类结果 ⇒ 所有登录用户可用（2026-10-13 用户要求）
router.post('/face/name/update', authenticateJWT, faceController.updateFaceName);
// 人脸聚类参数（严格度 / 最低质量 / 二次合并阈值），仅超管可调
router.post('/face/tuning/get', authenticateJWT, requireSuperAdmin, faceController.getFaceTuning);
router.post('/face/tuning/set', authenticateJWT, requireSuperAdmin, faceController.setFaceTuning);
// 人脸写操作（隐藏/合并/移动/移出）对所有登录用户开放（2026-10-13 用户要求：
// 每个人管理自己相册里的人脸）；服务端会校验目标人脸/照片在该用户可见范围内。
router.post('/face/merge', authenticateJWT, faceController.mergeFaces);
router.post('/face/status/set', authenticateJWT, faceController.setFaceStatus);
router.post('/face/photo/list', authenticateJWT, faceController.listPhotoFaces);
router.post('/face/photo/remove', authenticateJWT, faceController.removePhotoFromFace);
router.post('/face/photo/move', authenticateJWT, faceController.movePhotoToFace);
// 只重建「调用者可见范围内」照片的人脸（普通用户可用）；/face/reset 全库重建仍限管理员
router.post('/face/rescan', authenticateJWT, faceController.rescanFaces);
// ⭐ 2026-10-16 P0-7 重扫两阶段：先 preview 看差异（不写库），确认后再调 /face/rescan 执行
router.post('/face/rescan/preview', authenticateJWT, faceController.previewRescanFaces);
// ⭐ 2026-10-16 存量补扫：只把「已标记完成但无任何脸行」的照片重新入队（不清已有分组）
router.post('/face/rescan-missing', authenticateJWT, faceController.rescanMissingFaces);
// ⭐ 2026-10-16 全库「合并相似人物」：一次性归并分裂的碎片组（限超管，支持 dry_run）
router.post('/face/merge-similar', authenticateJWT, requireSuperAdmin, faceController.mergeSimilarFaces);
// 清理历史误检人脸（全局维护，限管理员）
router.post('/face/purge', authenticateJWT, requireSuperAdmin, faceController.purgeSuspiciousFaces);
router.get('/face/image', authenticateJWT, faceController.faceImageGet);
// ⭐ 2026-10-16 P0-2 合影组合相册：按「同框人脸组合」聚合（只算本人可见范围）
router.post('/face/group_combos', authenticateJWT, faceController.listPeerGroups);
// ⭐ 2026-10-16 P0-5 人物关系图谱：共同出现次数（边）+ 人物节点
router.post('/face/relations', authenticateJWT, faceController.listRelations);

// Similar
router.post('/similar/list', authenticateJWT, requireAdmin, similarController.listSimilarGroups);
router.post('/similar/delete', authenticateJWT, requireAdmin, similarController.batchDelete);
router.post('/similar/reset', authenticateJWT, requireAdmin, similarController.reset);

// GPS supplement
router.post('/gps_add/status', authenticateJWT, requireAdmin, gpsSupplementController.status);
router.post('/gps_add/start_scan', authenticateJWT, requireAdmin, gpsSupplementController.startScan);
router.post('/gps_add/apply', authenticateJWT, requireAdmin, gpsSupplementController.apply);
router.post('/gps_add/skip', authenticateJWT, requireAdmin, gpsSupplementController.skip);
router.post('/gps_add/reset', authenticateJWT, requireAdmin, gpsSupplementController.reset);

// App AI
router.post('/app_ai/overview', authenticateJWT, appAiController.overview);
// ⭐ 2026-10-16 P0-8 单张/多张「重新识别（分项）」：人脸 / OCR / 场景 / 活动 按需重跑
router.post('/app_ai/rerun', authenticateJWT, appAiController.rerun);
router.post('/app_ai/ocr/reset', authenticateJWT, requireAdmin, appAiController.resetOcr);
// ⭐ 2026-10-16 P1-9 AI 任务进度聚合（只读）
router.post('/app_ai/queue', authenticateJWT, appAiController.queue);
// ⭐ 2026-10-16 P2-18/P2-20 开放平台：模型 API（Agent 用，OpenAI 兼容）配置与连通性测试。
// 凭据属于系统级 ⇒ 仅超管可读写。
router.post('/app_ai/model_api/get', authenticateJWT, requireSuperAdmin, appAiController.modelApiGet);
router.post('/app_ai/model_api/set', authenticateJWT, requireSuperAdmin, appAiController.modelApiSet);
router.post('/app_ai/model_api/test', authenticateJWT, requireSuperAdmin, appAiController.modelApiTest);
// ⭐ 2026-10-16 P1/P2 智能发现批次（除记忆确认外全部只读）
// ⭐ 2026-10-17 修：原来是 `appAiController.timeCompare`（裸方法引用）⇒ `this` 丢失 ⇒
// 方法体内的 `this._scopeParams()` 抛 TypeError，接口恒 500。
// 项目约定是路由层包一层箭头（同 transmissionRouter / securityRouter）。
router.post('/app_ai/time_compare', authenticateJWT, (req, res) => appAiController.timeCompare(req, res));
// ⭐ 2026-10-17 修：原来是 `appAiController.dayFrames`（裸方法引用）⇒ `this` 丢失 ⇒
// 方法体内的 `this._scopeParams()` 抛 TypeError，接口恒 500。
// 项目约定是路由层包一层箭头（同 transmissionRouter / securityRouter）。
// ⭐⭐ 2026-10-18 相册 AI 问答（先算本地统计再交给模型；未配模型时用本地规则）
router.post('/app_ai/ask', authenticateJWT, (req, res) => appAiController.ask(req, res));

// ⭐ 2026-10-18 相册首页看板：我的照片 / 拍摄时光 / 足迹 / 镜头里的相伴（一次查完）
router.post('/app_ai/home_summary', authenticateJWT, (req, res) => appAiController.homeSummary(req, res));

router.post('/app_ai/day_frames', authenticateJWT, (req, res) => appAiController.dayFrames(req, res));
// ⭐ 2026-10-17 修：原来是 `appAiController.tickets`（裸方法引用）⇒ `this` 丢失 ⇒
// 方法体内的 `this._scopeParams()` 抛 TypeError，接口恒 500。
// 项目约定是路由层包一层箭头（同 transmissionRouter / securityRouter）。
router.post('/app_ai/tickets', authenticateJWT, (req, res) => appAiController.tickets(req, res));
// ⭐ 2026-10-17 修：原来是 `appAiController.memories`（裸方法引用）⇒ `this` 丢失 ⇒
// 方法体内的 `this._scopeParams()` 抛 TypeError，接口恒 500。
// 项目约定是路由层包一层箭头（同 transmissionRouter / securityRouter）。
router.post('/app_ai/memories', authenticateJWT, (req, res) => appAiController.memories(req, res));
router.post('/app_ai/memory_photos', authenticateJWT, (req, res) => appAiController.memoryPhotos(req, res));
// ⭐ 2026-10-19 人生章节书本：某一年每天的照片 + 地点 + 标签 + 已确认记忆文字（只读）
router.post('/app_ai/chapter_book', authenticateJWT, (req, res) => appAiController.chapterBook(req, res));
router.post('/app_ai/memory/save', authenticateJWT, appAiController.saveMemory);
router.post('/app_ai/memory/remove', authenticateJWT, appAiController.removeMemory);
// ⭐ 2026-10-19 记忆详情：把选中的照片移出记忆（只改记忆，不删原图；批量一次提交）
router.post('/app_ai/memory/exclude', authenticateJWT, (req, res) => appAiController.excludeMemoryPhotos(req, res));
// ⭐ 2026-10-18 记忆页：忽略 / 恢复候选
router.post('/app_ai/memory/ignore', authenticateJWT, appAiController.ignoreMemory);
router.post('/app_ai/memory/restore', authenticateJWT, appAiController.restoreIgnored);
// ⭐ 2026-10-17 修：原来是 `appAiController.duplicates`（裸方法引用）⇒ `this` 丢失 ⇒
// 方法体内的 `this._scopeParams()` 抛 TypeError，接口恒 500。
// 项目约定是路由层包一层箭头（同 transmissionRouter / securityRouter）。
router.post('/app_ai/duplicates', authenticateJWT, (req, res) => appAiController.duplicates(req, res));
// ⭐ 2026-10-17 P5：补齐 content_md5（只算 size 撞车的候选 ⇒ 省 86% 读盘）。
// ⚠️ 一律 `(req,res)=>controller.method(...)` 包一层：裸传方法引用会丢 `this`（本项目踩过 7 次）。
router.post('/app_ai/duplicates/backfill', authenticateJWT, (req, res) => appAiController.backfillDuplicates(req, res));
// ⭐ 2026-10-17 重复清理：合并元数据 + 回收站，一步到位且可撤销
router.post('/app_ai/duplicates/resolve', authenticateJWT, (req, res) => appAiController.resolveDuplicates(req, res));
router.post('/app_ai/models', authenticateJWT, appAiController.models);
// ⭐ 2026-10-17 修：原来是 `appAiController.yearReport`（裸方法引用）⇒ `this` 丢失 ⇒
// 方法体内的 `this._scopeParams()` 抛 TypeError，接口恒 500。
// 项目约定是路由层包一层箭头（同 transmissionRouter / securityRouter）。
router.post('/app_ai/year_report', authenticateJWT, (req, res) => appAiController.yearReport(req, res));
// ⭐ 2026-10-17 修：原来是 `appAiController.travelLines`（裸方法引用）⇒ `this` 丢失 ⇒
// 方法体内的 `this._scopeParams()` 抛 TypeError，接口恒 500。
// 项目约定是路由层包一层箭头（同 transmissionRouter / securityRouter）。
router.post('/app_ai/travel_lines', authenticateJWT, (req, res) => appAiController.travelLines(req, res));
router.post('/file_view/list', authenticateJWT, createFileViewHandler('photo', 'list'));
router.post('/file_view/search', authenticateJWT, createFileViewHandler('photo', 'globalSearch'));

module.exports = router;
