const path = require('path');
const cluster = require('cluster');
const Logger = require('../utils/logger');
const hardwareUtil = require('../utils/hardwareUtil');
const dbUtil = require('../db/dbUtil');
const appUtil = require('../utils/appUtil');
const tableConfig = require('../db/table/tableConfig');
const config = require('../config/config');
let shell,app;

try {
  shell = require('electron').shell;
  app = require('electron').app;
} catch (e) {}

module.exports = {
  /**
   * 缓存目录搬迁（若配置了新的缓存目录）。
   * 必须在任何 worker / Express worker 启动之前执行：此时服务尚未对外提供 API，
   * 客户端连不上，等价于「搬迁期间不能操作」，不会出现「边写缓存边搬」的竞争。
   * 中途关闭服务后，下次启动会根据落盘状态自动接着搬（按文件大小比对跳过已完成的）。
   */
  async runCacheMigrationIfNeeded() {
    try {
      const cacheMigrator = require('../utils/cacheMigrator');
      const res = await cacheMigrator.runStartupMigration();
      if (res && res.ok && res.cachePath) {
        // 搬迁成功后 PATH_CACHE 已在 migrator 内更新，同步到实例属性
        // （worker 启动时读取 this.pathCache 作为环境变量）
        process.env.PATH_CACHE = res.cachePath;
        this.pathCache = res.cachePath;
        Logger.info('✅ 缓存目录已就绪', { cachePath: res.cachePath });
      } else if (res && !res.ok) {
        Logger.error('❌ 缓存目录搬迁失败，继续使用原缓存目录启动', { error: res.error });
      }
    } catch (err) {
      Logger.error('❌ 缓存目录搬迁异常，继续使用原缓存目录启动', err);
    }
  },

  async init() {
    Logger.debug('🚀 初始化主进程');

    // ① 先处理缓存目录搬迁（早于一切 worker / Express worker 的启动）
    await this.runCacheMigrationIfNeeded();

    const remoteAssets = require('../utils/remoteAssetsManager');
    if (remoteAssets.shouldUseRemoteAssets()) {
      Logger.info('[remoteAssets] startup sync before AI workers');
      void remoteAssets.syncOnnxModelsAtStartup().catch(err => {
        Logger.warn('[remoteAssets] startup ONNX sync failed', {
          error: err && err.message ? err.message : String(err),
        });
      });
    }

    const sysInfo = hardwareUtil.getHardwareInfo();

    await dbUtil.init(true);

    this.startFfmpegHwTestWorker();
    this.startPhotoWatchWorker();
    this.startVideoWatchWorker();
    this.startBookWatchWorker();
    this.startMusicWatchWorker();
    const fileAllIndexEnable = await tableConfig.getConfigByKey('file_all_index_enabled');
    if (fileAllIndexEnable === '1') {
      this.startFileAllIndexWorker();
    }

    // 重置所有待处理文件操作为失败
    await this.resetPendingFileOperations();
    // 扫描所有源
    await this.enqueueStartupPhotoScanTasks();
    await this.enqueueStartupVideoScanTasks();
    await this.enqueueStartupBookScanTasks();
    await this.enqueueStartupMusicScanTasks();
    // 读取 GPU 优先设置（默认为开启），在启动 AI worker 前设置环境变量
    const aiGpuPrefer = await tableConfig.getConfigByKey('ai_gpu_prefer');
    process.env.AI_GPU_PREFER = aiGpuPrefer === '0' ? '0' : '1';

    // 启动各 AI Worker：统一走 isAiWorkerEnabled（口径＝**只有显式 '1' 才算开**，见 workers.js）。
    // ⚠️ 2026-10-17 P5：原先是 `=== '1'`，而「暂停后恢复」那条路把「缺行」当成开 ⇒ 两套口径。
    if (await this.isAiWorkerEnabled('ai_ocr_enable')) this.startOcrWorker();
    if (await this.isAiWorkerEnabled('ai_face_enable')) this.startFaceWorker();
    if (await this.isAiWorkerEnabled('ai_place_enable')) this.startPlacesWorker();
    if (await this.isAiWorkerEnabled('ai_similar_enable')) this.startSimilarWorker();
    // 检查是否支持 shell
    const isShellSupported = !!shell;

    // 保存shell支持状态到数据库
    tableConfig.setConfigByKey('shell_supported', isShellSupported ? '1' : '0');

    const serverId = await tableConfig.ensureServerId();
    const jwtSecret = await tableConfig.ensureJWTSecret();
    await tableConfig.ensureTwoFASecret();
    process.env.SERVER_ID = process.env.SERVER_ID || serverId;
    process.env.JWT_SECRET = process.env.JWT_SECRET || jwtSecret;
    Logger.info(`🎯 Server id: ${serverId}`);

    if (remoteAssets.shouldUseRemoteAssets()) {
      void remoteAssets
        .syncMountLibsAtStartup()
        .then(() => {
          Logger.info('[remoteAssets] mount libs ready, restoring mount/share');
          return Promise.all([
            this.restoreFileServersOnStartup({ serverId }),
            this.restoreFileMountsOnStartup({ serverId }),
            this.restoreOpenlistMountsOnStartup({ serverId }),
          ]);
        })
        .catch(err => {
          Logger.warn('[remoteAssets] mount libs sync or restore failed', {
            error: err && err.message ? err.message : String(err),
          });
        });
    } else {
      await this.restoreFileServersOnStartup({ serverId });
      setTimeout(() => {
        this.restoreFileMountsOnStartup({ serverId });
      }, 5000);
      setTimeout(() => {
        this.restoreOpenlistMountsOnStartup({ serverId });
      }, 6000);
    }

    await this.ensureInitialSuperAdmin();
    setTimeout(async () => {
      try {
        const info = await this.getInitialSuperAdminInfo();
        if ((info && info.isInitialAdmin && info.username && info.password)) {
          Logger.info(`Default admin in use; change soon. \nusername:${info.username} \npassword:${info.password}`);
        } 
        await this.writeLinuxHeadlessAdminAccountFileIfNeeded();
      } catch {}
    }, 10000);

    setTimeout(() => {
      this.reloadFileBackupsScheduler({ serverId, reconcileRunning: true });
    }, 7000);
    setTimeout(() => {
      this.restoreTransmissionOnStartup({ serverId });
    }, 8000);

    const forbidden = new Set((config && config.forbiddenPorts) || []);
    const desiredHttp = await appUtil.getConfigApiPort(false);
    const desiredHttps = await appUtil.getConfigApiPort(true);
    const safeDesiredHttp = forbidden.has(desiredHttp) ? config.app.port : desiredHttp;
    const safeDesiredHttps = forbidden.has(desiredHttps) ? config.app.httpsPort : desiredHttps;

    const getFreeAllowedPort = async (basePort, avoidPorts = new Set()) => {
      let cursor = basePort;
      while (true) {
        const p = await appUtil.getFreePort(cursor);
        if (!p) return null;
        if (forbidden.has(p) || avoidPorts.has(p)) {
          cursor = p + 1;
          continue;
        }
        return p;
      }
    };

    const freeHttpPort = await getFreeAllowedPort(safeDesiredHttp);
    const freeHttpsPort = await getFreeAllowedPort(safeDesiredHttps, new Set([freeHttpPort]));
    Logger.info('Free ports:', { http: freeHttpPort, https: freeHttpsPort });

    const cpuCores = sysInfo.cpu.cores;
    const rawApiCount = await tableConfig.getConfigByKey(tableConfig.KEY_EXPRESS_API_COUNT, 0);
    let expressApiCount = this.getExpressApiCount(cpuCores, rawApiCount);
    //开发模式固定为1
    if (process.env.NODE_ENV === 'development') {
      expressApiCount = 1;
    }
    //cluster专门用于启用多个express worker进程
    cluster.setupPrimary({
      exec: path.resolve(__dirname, '..', 'workers', 'expressWorker.js'),
    });
    for (let i = 0; i < expressApiCount; i++) {
      this.startOneExpressWorker(freeHttpPort, freeHttpsPort, serverId, jwtSecret);
    }
    Logger.info(`🎯 Started ${expressApiCount} WaterNasOS API worker(s)`);
  },
};
