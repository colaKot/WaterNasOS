const express = require('express');
const router = express.Router();
const { authenticateJWT, requireAdmin } = require('../../middleware/authMiddleware');
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
router.post('/library/add', authenticateJWT, requireAdmin, videoLibraryController.addLibrary);
router.post('/library/rename/:id', authenticateJWT, requireAdmin, videoLibraryController.renameLibrary);
router.post('/library/show_in_home/:id', authenticateJWT, requireAdmin, videoLibraryController.setShowInHome);
router.post('/library/audio_normalize/:id', authenticateJWT, requireAdmin, videoLibraryController.setAudioNormalize);
router.post('/library/delete/:id', authenticateJWT, requireAdmin, videoLibraryController.deleteLibrary);

router.post('/source/list', authenticateJWT, requireAdmin, videoSourceController.listSources);
router.post('/source/add', authenticateJWT, requireAdmin, videoSourceController.addSource);
router.post('/source/delete', authenticateJWT, requireAdmin, videoSourceController.deleteSource);
router.post('/source/update/:id', authenticateJWT, requireAdmin, videoSourceController.updateSource);
// 注意：来源的影视库类型创建后不可修改，原 /source/media_type/:id 已移除
router.post('/source/match_nfo/:id', authenticateJWT, requireAdmin, videoSourceController.updateMatchNfo);
router.post('/source/relocate/:id', authenticateJWT, requireAdmin, videoSourceController.relocateSource);
router.post('/source/scan', authenticateJWT, requireAdmin, videoSourceController.scanSource);
router.post('/source/scan_index', authenticateJWT, requireAdmin, videoSourceController.scanIndex);

router.post('/getTmdbConfig', authenticateJWT, requireAdmin, videoConfigController.getTmdbConfig);
router.post('/setTmdbConfig', authenticateJWT, requireAdmin, videoConfigController.setTmdbConfig);
router.post('/getTranscodeConfig', authenticateJWT, requireAdmin, videoConfigController.getTranscodeConfig);
router.post('/setTranscodeConfig', authenticateJWT, requireAdmin, videoConfigController.setTranscodeConfig);
router.post('/getSubtitleConfig', authenticateJWT, requireAdmin, videoConfigController.getSubtitleConfig);
router.post('/setSubtitleConfig', authenticateJWT, requireAdmin, videoConfigController.setSubtitleConfig);
// 默认播放画质：读取对所有登录用户开放（子账号的播放端也要遵守该默认值），写入仅管理员
router.post('/getPlayQuality', authenticateJWT, videoConfigController.getPlayQuality);
router.post('/setPlayQuality', authenticateJWT, requireAdmin, videoConfigController.setPlayQuality);

router.post('/tmdb/search', authenticateJWT, videoTmdbController.search);
router.post('/scrape/start', authenticateJWT, requireAdmin, videoScrapeController.start);
router.post('/scrape/cleanup', authenticateJWT, requireAdmin, videoScrapeController.cleanup);

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
router.post('/file_view/list', authenticateJWT, createFileViewHandler('video', 'list'));
router.post('/file_view/search', authenticateJWT, createFileViewHandler('video', 'globalSearch'));

module.exports = router;
