const path = require('path');
const os = require('os');
const fs = require('fs');

let packageJson = {};
try {
  packageJson = require(path.join(__dirname, '../../package.json'));
} catch (e) {
  // 忽略
}
let app = null;
let isElectronAvailable = false;
let isPackaged = false;

function isPackagedRuntimeDir(dir) {
  const normalized = path.normalize(String(dir || ''));
  if (!normalized) return false;
  if (normalized.includes(`app.asar${path.sep}`) || normalized.endsWith(`app.asar`)) {
    return true;
  }
  // 大小写不敏感匹配：macOS 打包后路径为 .../Contents/Resources/app/...（Resources 首字母大写），Windows/Linux 为小写 resources
  const lower = normalized.toLowerCase();
  return lower.includes(`${path.sep}resources${path.sep}app${path.sep}`);
}

// 安全地检测并使用 Electron
try {
  // 检测是否在 Electron 环境中运行
  if (typeof process !== 'undefined' && process.versions && process.versions.electron) {
    let elec = require('electron');
    app = elec.app;
    isElectronAvailable = true;
    isPackaged = app.isPackaged || false;
  }
} catch (err) {
  // Electron 不可用，运行在纯 Node.js 环境（如 Worker 线程）
  // 这是正常的，不需要报错
}

// 检测是否已打包（生产环境）
// 在 Worker 线程中，通过检查是否在 asar 包中来判断
if (!isElectronAvailable) {
  isPackaged = isPackagedRuntimeDir(__dirname);
}

// 环境配置
const env = process.env.NODE_ENV || 'development';
// ⭐ 2026-10-16 应用清单（唯一真源，各端都从服务端取）：
// 按用户要求隐藏 4 个「暂时用不上」的应用 —— 服务(nascab_service)、Docker、加密空间(encrypted)、笔记(note)。
// 只移除 ID，路由/数据/代码全保留，想恢复把 ID 加回来即可。
const defaultApps = [
  'folder',
  'photo',
  'movie',
  'book',
  'music',
  'media_tool',
  'user',
  'terminal',
  'mounts',
  'backup',
  'sync',
  'security',
  'share',
  'monitor',
  'task_center',
  'transmission',
  'setting',
  'process'
];
const normalUserNoShowApps = ['transmission','terminal', 'user', 'mounts', 'docker', 'nascab_service', 'monitor', 'process'];
const imgTypeList = ['.jpeg', '.jpg', '.png', '.heic', '.heif', '.hif', '.gif', '.webp', '.tiff', '.svg', '.bmp'];
const rawImgTypeList = ['.dng', '.cr2', '.nef', '.orf', '.raf', '.raw', '.x3f', '.rw2', '.nrw', '.arw'];
const videoTypeList = ['.mov', '.mp4', '.avi', '.rm', '.mkv', '.f4v', '.vob', '.mpg', '.rmvb', '.asf', '.mts', '.ts', '.wmv', '.m4v', '.m2ts', '.ogg', '.3gp', '.flv'];
const bookTypeList = ['.txt', '.epub', '.pdf', '.mobi', '.azw3', '.cbz', '.cbr', '.rar', '.zip'];
const musicTypeList = ['.mp3', '.flac', '.aac', '.wav', '.ogg', '.opus', '.wma', '.ape','.m4a'];
//禁用端口
let forbiddenPorts = [
  1, 7, 9, 11, 13, 15, 17, 19, 20, 23, 25, 37, 42, 43, 53, 77, 79, 87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 139, 143, 179, 389, 465, 512, 513, 514, 515, 526,
  530, 531, 532, 540, 556, 563, 587, 601, 636, 993, 995, 2049, 3659, 4045, 6000, 6665, 6666, 6667, 6668, 6669, 3389,
];
/**
 * 获取应用根目录
 */
function getRootPath() {
  let rootPath = '';

  if (isElectronAvailable && isPackaged) {
    // Electron 生产环境
    rootPath = path.dirname(app.getPath('exe'));
    // 兼容性适配：mac 的 appPath 在 MacOS 目录下，必须去父目录
    if (os.platform() == 'darwin') {
      rootPath = path.dirname(rootPath);
    }
  } else if (isPackaged) {
    // 生产环境 或 非主线程
    rootPath = path.join(__dirname, '../../../../');
  } else {
    // 开发环境
    rootPath = path.join(__dirname, '../../');
  }
  return rootPath;
}

/**
 * 获取 foliate-js-main 根目录（项目根目录下的 libs/foliate-js-main）
 */
function getFoliateRootPath() {
  return path.join(getRootPath(), 'libs', 'foliate-js-main');
}

/**
 * 非 Electron 环境下的默认用户数据目录（Worker / Docker / 纯 Node）
 */
function getDefaultNonElectronUserDataPath() {
  if (process.env['userDataFolder']) {
    return process.env['userDataFolder'];
  }
  // Docker 镜像内不能使用项目工作目录下的 data，改用根目录下的 /nascabos_data（便于挂载卷）
  if (packageJson.isDocker && os.platform() === 'linux') {
    const folder = path.join('/', 'nascabos_data');
    try {
      fs.mkdirSync(folder, { recursive: true });
    } catch (err) {
      console.warn('----------Create /nascabos_data Failed: ' + (err && err.message) + ' ----------');
    }
    console.log('----------Docker  userDataFolder : ' + folder + ' ----------');
    return folder;
  }
  const folder = path.join(process.cwd(), 'data');
  console.log('----------Not set userDataFolder, use default directory: ' + folder + ' ----------');
  return folder;
}

/**
 * 获取用户数据目录 如果 app 不存在则返回程序当前目录
 */
function getUserDataPath() {
  if (process.env['userDataFolder']) {
    return process.env['userDataFolder'];
  }
  if (isElectronAvailable && app && typeof app.getPath === 'function') {
    // Electron 环境
    return app.getPath('userData');
  } else {
    return getDefaultNonElectronUserDataPath();
  }
}

/** 远程资源下载已停用：onnx 模型与 sftpgo/rclone 等 libs 均打包在应用中 */
function shouldUseRemoteAssets() {
  return false;
}

function getRemoteAssetsManifestUrl() {
  return process.env.NASCAB_LIBS_MANIFEST_URL || 'https://download.nas.cab/libs/manifest.json';
}

// ============================ 缓存位置（可选自定义目录） ============================
// 说明：
//  - 缓存根目录固定命名为 nascabos_cache（保持目录语义与既有校验，便于识别与迁移）。
//  - 用户配置的是「缓存父目录」，实际缓存根 = 父目录 + /nascabos_cache。
//  - 配置文件必须放在 userData 根目录下（它就是定位锚点），因此不使用数据库存储：
//    数据库本身也在 userData 下，且本模块在数据库初始化之前就会被 require。
const CACHE_FOLDER_NAME = 'nascabos_cache';
const CACHE_LOCATION_FILE = 'cache_location.json';

/**
 * 缓存位置配置文件路径（固定位于 userData 根目录）
 */
function getCacheLocationConfigPath() {
  return path.join(getUserDataPath(), CACHE_LOCATION_FILE);
}

/**
 * 原子写入 JSON：先写临时文件再重命名，避免断电/异常产生半截文件
 */
function writeJsonAtomic(filePath, data) {
  const text = JSON.stringify(data, null, 2);
  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  } catch (_) {}
  const tmp = `${filePath}.tmp.${process.pid}`;
  try {
    fs.writeFileSync(tmp, text, 'utf8');
    fs.renameSync(tmp, filePath);
    return true;
  } catch (_) {
    try {
      fs.writeFileSync(filePath, text, 'utf8');
      return true;
    } catch (_) {
      return false;
    } finally {
      try {
        fs.unlinkSync(tmp);
      } catch (_) {}
    }
  }
}

/**
 * 读取缓存位置配置
 * @returns {{parent:string, effectiveParent:string, updatedAt:number}|null}
 *   parent          = 用户期望的缓存父目录（空字符串表示使用默认 userData）
 *   effectiveParent = 当前实际生效的缓存父目录（搬迁完成前保持旧目录）
 */
function readCacheLocationConfig() {
  try {
    const p = getCacheLocationConfigPath();
    if (!fs.existsSync(p)) return null;
    const raw = fs.readFileSync(p, 'utf8');
    if (!raw || !raw.trim()) return null;
    const json = JSON.parse(raw);
    const parent = json && typeof json.parent === 'string' ? json.parent.trim() : '';
    const effectiveParent =
      json && typeof json.effectiveParent === 'string' ? json.effectiveParent.trim() : '';
    if (!parent && !effectiveParent) return null;
    return {
      parent: parent ? path.resolve(parent) : '',
      effectiveParent: effectiveParent ? path.resolve(effectiveParent) : '',
      updatedAt: Number(json.updatedAt) || 0,
    };
  } catch (_) {
    // 配置损坏时按「未配置」处理，回退默认目录，不会影响服务启动
    return null;
  }
}

/**
 * 写入用户期望的缓存父目录（空字符串表示「回到默认 userData 目录」）。
 * 关键点：只更新 parent，effectiveParent 始终保留 —— 搬迁完成前一切照旧，
 * 这样「恢复默认」也会被识别为一次真实的搬迁（从旧位置搬回 userData）。
 */
function writeCacheLocationConfig(parent) {
  const prev = readCacheLocationConfig();
  const raw = parent === null || parent === undefined ? '' : String(parent).trim();
  const nextParent = raw ? path.resolve(raw) : '';
  const effectiveParent =
    (prev && prev.effectiveParent) || (prev && prev.parent) || path.resolve(getUserDataPath());
  writeJsonAtomic(getCacheLocationConfigPath(), {
    parent: nextParent,
    effectiveParent,
    updatedAt: Date.now(),
  });
  return nextParent;
}

/**
 * 标记缓存父目录已生效（搬迁成功、或无需搬迁时调用）
 */
function setCacheEffectiveParent(parent) {
  const raw = parent === null || parent === undefined ? '' : String(parent).trim();
  const next = raw ? path.resolve(raw) : path.resolve(getUserDataPath());
  const prev = readCacheLocationConfig();
  // 保留用户「期望位置」的原样（含「空 = 默认」的语义），避免恢复默认后又被写成显式路径
  const prevParent = prev ? prev.parent : undefined;
  writeJsonAtomic(getCacheLocationConfigPath(), {
    parent: prevParent !== undefined ? prevParent : next,
    effectiveParent: next,
    updatedAt: Date.now(),
  });
  return next;
}

/**
 * 当前实际生效的缓存父目录（搬迁未完成时仍指向旧目录）
 */
function getEffectiveCacheParent() {
  const cfg = readCacheLocationConfig();
  if (cfg && cfg.effectiveParent) return cfg.effectiveParent;
  if (cfg && cfg.parent) return cfg.parent;
  return getUserDataPath();
}

/**
 * 用户期望的缓存父目录（默认 = userData）
 */
function getConfiguredCacheParent() {
  const cfg = readCacheLocationConfig();
  if (cfg && cfg.parent) return cfg.parent;
  return getUserDataPath();
}

/**
 * 获取缓存目录
 * 解析优先级：
 *   ① process.env.PATH_CACHE —— 进程内已解析结果（主进程 initUtil 注入，worker 继承），
 *      保证主进程与各 worker 解析完全一致，也是「搬迁完成前仍用旧目录」的开关。
 *   ② 缓存位置配置的 effectiveParent（搬迁完成前 = 旧目录）
 *   ③ 默认 userData/nascabos_cache
 */
function getCachePath() {
  if (process.env.PATH_CACHE) return process.env.PATH_CACHE;
  return path.join(getEffectiveCacheParent(), CACHE_FOLDER_NAME);
}

/**
 * 缓存根目录名（供迁移器等外部模块复用）
 */
function getCacheFolderName() {
  return CACHE_FOLDER_NAME;
}
/**
 * 获取nfo头像目录
 */
function getNfoAvatarPath() {
  const nfoAvatarFolder = 'nfoAvatar';
  return path.join(getCachePath(), nfoAvatarFolder);
}
/**
 * 获取nfo海报目录
 */
function getNfoPosterPath() {
  const nfoPosterFolder = 'nfoPoster';
  return path.join(getCachePath(), nfoPosterFolder);
}
/**
 * 获取上传临时目录
 */
function getUploadTempDir() {
  const uploadTempFolder = 'uploadTemp';
  return path.join(getCachePath(), uploadTempFolder);
}
/**
 * 获取转码临时目录
 */
function getTranscodeTempPath() {
  const transcodeTempFolder = 'transcode';
  return path.join(getCachePath(), transcodeTempFolder);
}
/**
 * 获取压缩图片使用的临时目录
 */
function getZipImgTempPath() {
  const zipImgTempFolder = 'imgZipTmpUpload';
  const result = path.join(getCachePath(), zipImgTempFolder);
  const normalized = path.normalize(result);
  if (!normalized.includes('nascabos_cache') || !normalized.includes('imgZipTmpUpload')) {
    throw new Error(`Invalid zipImgTempPath: ${result}`);
  }
  return result;
}
function getTranscodeTempSafeFolderName() {
  return 'nascab_transcode_temp';
}
/**
 * 获取数据库目录
 */
function getDatabasePath() {
  const databaseFolder = 'database';
  return path.join(getUserDataPath(), databaseFolder);
}
/**
 * 获取缩略图缓存目录
 */
function getTinyCachePath() {
  const tinyFolder = 'tinyCache';
  return path.join(getCachePath(), tinyFolder);
}
/**
 * 获取音乐封面缓存目录
 */
function getMusicCoverCachePath() {
  const musicInnerCoverFolder = 'musicInnerCover';
  return path.join(getCachePath(), musicInnerCoverFolder);
}
/**
 * 获取缩略图生成临时文件的目录
 */
function getTinyCacheTempPath() {
  const tinyFolder = 'tinyCache';
  return path.join(getCachePath(), tinyFolder, 'temp');
}

function getSubtitleUploadPath() {
  const subtitleUploadPath = 'subtitleUpload';
  return path.join(getCachePath(), subtitleUploadPath);
}
/**
 * 获取自定义壁纸目录
 */
function getCustomWallpaperPath() {
  const customWallpaperFolder = 'customWallpaper';
  return path.join(getCachePath(), customWallpaperFolder);
}
/**
 * 获取地图瓦片缓存目录
 */
function getMapTileCachePath() {
  const mapTileFolder = 'mapTiles';
  return path.join(getCachePath(), mapTileFolder);
}

function getOpenListDataPath() {
  const openListFolder = 'openListData';
  return path.join(getUserDataPath(), openListFolder);
}
/**
 * 判断是否为图片文件
 */
function isImg(ext) {
  return imgTypeList.includes(ext) || rawImgTypeList.includes(ext);
}

let appRootPath = path.join(__dirname, '../../');
if (!appRootPath) {
  try {
    const { app } = require('electron');
    if (app && app.isPackaged) {
      appRootPath = path.dirname(app.getPath('exe'));
      //兼容性适配 mac的apppath在macos目录下 必须去父目录 否则崩溃
      if (os.platform() == 'darwin') {
        appRootPath = path.dirname(appRootPath);
      }
    } else {
      appRootPath = path.join(__dirname, '../../');
    }
  } catch (err) {}
}

/**
 * 获取文件类型
 */
function getFileType(ext) {
  if (imgTypeList.includes(ext)) return 'image';
  if (rawImgTypeList.includes(ext)) return 'raw';
  if (videoTypeList.includes(ext)) return 'video';
  return 'file';
}
/**
 * 获取默认的tmdb配置
 */
function getDefaultTmdbConfig() {
  return {
    tmdbApiToken:
      'eyJhbGciOiJIUzI1NiJ9.eyJhdWQiOiI0Njc2MGM2MjE0OWY2MDUxMDQ5ZTUwZDU2NDg1NWU2MiIsIm5iZiI6MTcyNjcxNTQwNC43NTM1NDMsInN1YiI6IjYyZjM3ZjdlMWY3NDhiMDA4MTE2Y2MyZSIsInNjb3BlcyI6WyJhcGlfcmVhZCJdLCJ2ZXJzaW9uIjoxfQ.3bjuEGwVsCjgrWHiFsta7NDsuRQG_9mX59ExRUWeeVY',
    tmdbApiUrl: 'https://api.tmdb.org',
  };
}
function getDefaultTileServer() {
  return [
    {
      name: 'GaoDe',
      server: 'https://webrd01.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=7&x={x}&y={y}&z={z}',
      maxLevel: 18,
      coordinate: 'GCJ-02',
    },
    {
      name: 'NasCab',
      isDefault: true,
      server: 'https://down.nascab.cn/mapTiles/{z}/{x}/{y}/tile.png',
      maxLevel: 12,
      coordinate: 'GCJ-02',
    },
    {
      name: 'ArcGIS',
      server: 'https://server.arcgisonline.com/arcgis/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}.png',
      maxLevel: 13,
      coordinate: 'WGS-84',
    },
  ];
}
const config = {
  getOpenListDataPath:getOpenListDataPath,//
  getSubtitleUploadPath:getSubtitleUploadPath, //字幕上传目录
  getDefaultTileServer: getDefaultTileServer, //默认的地图瓦片服务器
  getDefaultTmdbConfig: getDefaultTmdbConfig, //默认的tmdb配置
  getCustomWallpaperPath: getCustomWallpaperPath, //自定义壁纸目录
  getZipImgTempPath: getZipImgTempPath, //压缩图片使用的临时目录
  defaultApps: defaultApps, //默认应用
  normalUserNoShowApps: normalUserNoShowApps, //普通用户不显示的应用
  forbiddenPorts: forbiddenPorts, //禁用端口
  getMusicCoverCachePath: getMusicCoverCachePath, //音乐封面缓存目录
  getNfoPosterPath: getNfoPosterPath,
  getNfoAvatarPath: getNfoAvatarPath,
  getTinyCacheTempPath: getTinyCacheTempPath, //缩略图生成临时文件的目录
  appRootPath: appRootPath, //应用根目录
  getMapTileCachePath: getMapTileCachePath, //地图瓦片缓存目录
  getTranscodeTempPath: getTranscodeTempPath, //转码临时目录
  getTranscodeTempSafeFolderName: getTranscodeTempSafeFolderName,
  isImg: isImg, //判断是否为图片文件
  copyTempFilePrefix: '.copyTemp_', //复制临时文件前缀
  uploadTempFilePrefix: '.uploadTemp_', //上传临时文件前缀
  uploadTempPartPrefix: '.uploadTempPart_', //上传临时分块文件前缀
  getUploadTempDir: getUploadTempDir, //上传临时目录
  getRootPath: getRootPath, //获取应用根目录
  getFoliateRootPath: getFoliateRootPath, // foliate-js-main 根目录
  getFileType: getFileType, //获取文件类型
  getDatabasePath: getDatabasePath, //数据库目录
  getCachePath: getCachePath, //缓存目录
  getCacheFolderName: getCacheFolderName, //缓存根目录名（nascabos_cache）
  getCacheLocationConfigPath: getCacheLocationConfigPath, //缓存位置配置文件路径
  readCacheLocationConfig: readCacheLocationConfig, //读取缓存位置配置
  writeCacheLocationConfig: writeCacheLocationConfig, //写入期望的缓存父目录
  setCacheEffectiveParent: setCacheEffectiveParent, //标记缓存父目录已生效
  getEffectiveCacheParent: getEffectiveCacheParent, //当前实际生效的缓存父目录
  getConfiguredCacheParent: getConfiguredCacheParent, //用户期望的缓存父目录
  getUserDataPath: getUserDataPath, //用户数据目录
  shouldUseRemoteAssets: shouldUseRemoteAssets,
  getRemoteAssetsManifestUrl: getRemoteAssetsManifestUrl,
  getTinyCachePath: getTinyCachePath, //缩略图缓存目录
  appRootPath: getRootPath(),
  // 应用配置
  app: {
    port: process.env.PORT || 6789,
    httpsPort: process.env.HTTPS_PORT || 6799,
    env: env,
    isProduction: env === 'production',
    isDevelopment: env === 'development',
    isTest: env === 'test',
  },

  // JWT配置（密钥仅从 process.env.JWT_SECRET 读取，不在此暴露以防注入）
  jwt: {
    accessTokenExpiresIn: process.env.ACCESS_TOKEN_EXPIRES_IN || '12h',
    refreshTokenExpiresIn: process.env.REFRESH_TOKEN_EXPIRES_IN || '7d',
  },

  // 上传配置
  upload: {
    maxFileSize: process.env.MAX_FILE_SIZE || '100gb',
  },

  // 日志配置
  logging: {
    level: process.env.LOG_LEVEL || 'info',
    file: {
      enabled: true, //是否启用文件输出
      // ⭐ 2026-10-12：隔离模式下（设了 userDataFolder）日志也落到该目录，
      //    否则两个实例会写同一份 combined.log 互相覆盖/交错。
      //    普通用户不设 userDataFolder ⇒ 仍是原来的 <app>/logs，行为不变。
      path: process.env['userDataFolder']
        ? path.join(getUserDataPath(), 'logs')
        : path.join(getRootPath(), 'logs'),
    },
  },

  fileServer: {
    defaultPorts: {
      SFTP: { http_port: 2022, https_port: null },
      FTP: { http_port: 2121, https_port: null },
      WebDav: { http_port: 10080, https_port: 10443 },
    },
  },

  transmission: {
    defaultRpcPort: 52019,
    defaultPeerPort: 37291,
    defaultPeerLimitGlobal: 200,
    defaultPeerLimitPerTorrent: 50,
  },

  // File Types
  imgTypeList: imgTypeList,
  rawImgTypeList: rawImgTypeList,
  videoTypeList: videoTypeList,
  bookTypeList: bookTypeList,
  musicTypeList: musicTypeList,

  // 相册用户隔离：新建子账号时自动分配的私有相册目录根路径
  // 形如 <photoUserAutoDirRoot>/<用户名>/相册，并登记为该用户私有的相册源；留空 = 不自动创建
  photoUserAutoDirRoot: '',
};

// 开发环境特定配置
if (config.app.isDevelopment) {
  config.logging.level = 'debug';
  config.logging.file.enabled = false;
}

// 生产环境特定配置
if (config.app.isProduction) {
  config.logging.file.enabled = true;
}

module.exports = config;
