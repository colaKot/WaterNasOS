'use strict';

const Logger = require('../../../utils/logger');
const { VideoLoudnessRunner } = require('./videoLoudnessRunner');

class VideoLoudnessWorker {
  constructor() {
    this.runner = new VideoLoudnessRunner();
    this.init();
  }

  async init() {
    try {
      await this.runner.init();
      const enabledLibraryIds = await this.runner.getEnabledLibraryIds();
      if (enabledLibraryIds.length === 0) {
        Logger.info('🔊 audio loudness normalize disabled (no library enabled), worker exiting');
        process.exit(0);
        return;
      }
      await this.runUntilEmpty();
      process.exit(0);
    } catch (err) {
      Logger.error('❌ videoLoudnessWorker init failed:', err);
      process.exit(1);
    }
  }

  async runUntilEmpty() {
    while (true) {
      const { processed, disabled, noAvailableSources } = await this.runner.runOnce();
      if (disabled) {
        Logger.info('🔊 audio loudness normalize disabled during run, worker exiting');
        return;
      }
      if (noAvailableSources) {
        Logger.info('🔊 loudness scan: no mounted video sources, worker exiting');
        return;
      }
      if (!processed) {
        Logger.info('✅ No pending loudness tasks, worker exiting');
        return;
      }
    }
  }
}

new VideoLoudnessWorker();

process.on('message', message => {
  if (message && message.type === 'stop') {
    process.exit(0);
  }
});

process.on('uncaughtException', err => {
  Logger.error('❌ videoLoudnessWorker uncaughtException', err);
  process.exit(0);
});

process.on('unhandledRejection', reason => {
  Logger.error('❌ videoLoudnessWorker unhandledRejection', reason);
  process.exit(0);
});