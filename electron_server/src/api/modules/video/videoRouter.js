const express = require('express');
const router = express.Router();
const { authenticateJWT, requireAdmin, requireSuperAdmin } = require('../../middleware/authMiddleware');
const videoSourceController = require('./source/videoSourceController');
const videoLibraryController = require('./library/videoLibraryController');
const videoHomeController = require('./home/videoHomeController');
const videoDetailController = require('./detail/detailController');
const videoListController = require('./list/videoListController');
const videoFavoriteController = require('./favorite/videoFavoriteController');
const videoCollectionController = require('./collection/videoCollectionController');
const videoSmartAlbumController = require('./smartAlbum/videoSmartAlbumController');
const videoAlbumController = require('./album/videoAlbumController');
const videoConfigController = require('./config/videoConfigController');
const videoTmdbController = require('./tmdb/videoTmdbController');
const videoScrapeController = require('./scrape/videoScrapeController');
const fileListController = require('../file/list/fileListController');

function createFileViewHandler(sourceType, action) {
  return (req, res) => {
    req.body = { ...(req.body || {}), sourceType };
    return fileListController[action](req, res);
  };
}

// 影视库：列表所有登录用户可读（左侧栏需要），增删改仅管理员
router.post('/library/list', authenticateJWT, videoLibraryController.listLibraries);
router.post('/library/reorder', authenticateJWT, requireSuperAdmin, videoLibraryController.reorderLibraries);
router.post('/library/add', authenticateJWT, requireSuperAdmin, videoLibraryController.addLibrary);
router.post('/library/rename/:id', authenticateJWT, requireSuperAdmin, videoLibraryController.renameLibrary);
router.post('/library/show_in_home/:id', authenticateJWT, requireSuperAdmin, videoLibraryController.setShowInHome);
router.post('/library/audio_normalize/:id', authenticateJWT, requireSuperAdmin, videoLibraryController.setAudioNormalize);
// ⭐ 日本电影库开关（2026-10-12）：开启后列表显示「中/无码」徽章并开放对应筛选
router.post('/library/jp_movie/:id', authenticateJWT, requireSuperAdmin, videoLibraryController.setJpMovie);
router.post('/library/delete/:id', authenticateJWT, requireSuperAdmin, videoLibraryController.deleteLibrary);

router.post('/source/list', authenticateJWT, requireSuperAdmin, videoSourceController.listSources);
router.post('/source/add', authenticateJWT, requireSuperAdmin, videoSourceController.addSource);
router.post('/source/delete', authenticateJWT, requireSuperAdmin, videoSourceController.deleteSource);
router.post('/source/update/:id', authenticateJWT, requireSuperAdmin, videoSourceController.updateSource);
// 注意：来源的影视库类型创建后不可修改，原 /source/media_type/:id 已移除
router.post('/source/match_nfo/:id', authenticateJWT, requireSuperAdmin, videoSourceController.updateMatchNfo);
router.post('/source/relocate/:id', authenticateJWT, requireSuperAdmin, videoSourceController.relocateSource);
router.post('/source/scan', authenticateJWT, requireSuperAdmin, videoSourceController.scanSource);
router.post('/source/scan_index', authenticateJWT, requireSuperAdmin, videoSourceController.scanIndex);

router.post('/getTmdbConfig', authenticateJWT, requireSuperAdmin, videoConfigController.getTmdbConfig);
router.post('/setTmdbConfig', authenticateJWT, requireSuperAdmin, videoConfigController.setTmdbConfig);
router.post('/getTranscodeConfig', authenticateJWT, requireSuperAdmin, videoConfigController.getTranscodeConfig);
router.post('/setTranscodeConfig', authenticateJWT, requireSuperAdmin, videoConfigController.setTranscodeConfig);
router.post('/getSubtitleConfig', authenticateJWT, requireSuperAdmin, videoConfigController.getSubtitleConfig);
router.post('/setSubtitleConfig', authenticateJWT, requireSuperAdmin, videoConfigController.setSubtitleConfig);
// 默认播放画质：读取对所有登录用户开放（子账号的播放端也要遵守该默认值），写入仅管理员
router.post('/getPlayQuality', authenticateJWT, videoConfigController.getPlayQuality);
// ⭐ 不加 requireAdmin（2026-10-12）：播放设置是**每个用户自己的**偏好，
//    子账号也要能设自己的默认画质；管理员写入时落 uid=0，自动成为全局默认。
router.post('/setPlayQuality', authenticateJWT, videoConfigController.setPlayQuality);

router.post('/tmdb/search', authenticateJWT, videoTmdbController.search);
router.post('/scrape/start', authenticateJWT, requireSuperAdmin, videoScrapeController.start);
router.post('/scrape/cleanup', authenticateJWT, requireSuperAdmin, videoScrapeController.cleanup);

router.post('/home/data', authenticateJWT, videoHomeController.getHomeData);

router.post('/list', authenticateJWT, videoListController.list);
router.post('/list/count', authenticateJWT, videoListController.count);
// 图片库 / 混合库的文件夹层级（只列直接子文件夹；图片库浏览页用）
router.post('/image/folders', authenticateJWT, videoListController.imageFolders);
router.post('/history/list', authenticateJWT, videoListController.historyList);
router.post('/history/clear', authenticateJWT, videoListController.clearHistory);

router.post('/favorite/add', authenticateJWT, videoFavoriteController.add);
router.post('/favorite/remove', authenticateJWT, videoFavoriteController.remove);

router.post('/collection/list', authenticateJWT, videoCollectionController.listCollections);
router.post('/collection/get', authenticateJWT, videoCollectionController.getCollection);
router.post('/collection/create', authenticateJWT, videoCollectionController.createCollection);
router.post('/collection/delete', authenticateJWT, videoCollectionController.deleteCollection);
router.post('/collection/update', authenticateJWT, videoCollectionController.updateCollection);

router.post('/smart_album/list', authenticateJWT, videoSmartAlbumController.listSmartAlbums);
router.post('/smart_album/get', authenticateJWT, videoSmartAlbumController.getSmartAlbum);
router.post('/smart_album/create', authenticateJWT, videoSmartAlbumController.createSmartAlbum);
router.post('/smart_album/update', authenticateJWT, videoSmartAlbumController.updateSmartAlbum);
router.post('/smart_album/delete', authenticateJWT, videoSmartAlbumController.deleteSmartAlbum);

router.post('/album/list', authenticateJWT, videoAlbumController.listAlbums);
router.post('/album/overview', authenticateJWT, videoAlbumController.getAlbumOverview);
router.post('/album/get', authenticateJWT, videoAlbumController.getAlbum);
router.post('/album/create', authenticateJWT, videoAlbumController.createAlbum);
router.post('/album/update', authenticateJWT, videoAlbumController.updateAlbum);
router.post('/album/delete', authenticateJWT, videoAlbumController.deleteAlbum);
router.post('/album/index/add', authenticateJWT, videoAlbumController.addAlbumIndexes);
router.post('/album/index/remove', authenticateJWT, videoAlbumController.removeAlbumIndexes);
router.post('/album/cover/set', authenticateJWT, videoAlbumController.setAlbumCover);

router.get('/detail', authenticateJWT, videoDetailController.getDetail);
router.get('/episodes', authenticateJWT, videoDetailController.getEpisodes);
router.get('/tvPlayInfo', authenticateJWT, videoDetailController.getTvPlayInfo);
router.get('/discContents', authenticateJWT, videoDetailController.getDiscContents);
router.get('/discContents/thumb', authenticateJWT, videoDetailController.getDiscContentThumb);
router.post('/detail/open_skip/set', authenticateJWT, requireAdmin, videoDetailController.setOpenSkip);
router.get('/person/image', authenticateJWT, videoDetailController.getPersonImage);
router.get('/poster/image', authenticateJWT, videoDetailController.getPosterImage);
// ⭐ 日本片封面代理（2026-10-12）：日文站点图片有防盗链，客户端裸连 403，
//    改由服务端按番号抓取 + 缓存后回吐（与 /poster/image 不同，这里没有 tmdb_id 可用）。
router.get('/jav/cover', authenticateJWT, videoTmdbController.javCover);
router.post('/file_view/list', authenticateJWT, createFileViewHandler('video', 'list'));
router.post('/file_view/search', authenticateJWT, createFileViewHandler('video', 'globalSearch'));

module.exports = router;
