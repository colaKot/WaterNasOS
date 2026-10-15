const { body, validationResult } = require('express-validator');
const { getLocalizedMessage } = require('../../../utils/i18nUtil');

const MODES = ['bidirectional', 'download_only', 'upload_only'];
const STATUSES = ['idle', 'running', 'paused', 'error'];

// 设备标识（v2 协议）：字符串 ≤128，不限定字符集——不同平台的机器标识
// 形态各异（win-<GUID> / mac-<UUID> / lnx-<machine-id> / web-<hex>）。
const DEVICE_ID_RULE = body('device_id').optional().isString().isLength({ min: 1, max: 128 }).withMessage('sync.DEVICE_ID_INVALID');
const DEVICE_BOUND_RULE = body('device_bound').optional().isBoolean().withMessage('validation.VALIDATION_ERROR');

function isManifestArray(value) {
  if (!Array.isArray(value)) return false;
  return value.every(v => v && typeof v === 'object' && typeof v.relPath === 'string');
}

const SyncValidation = {
  validateList() {
    return [
      body('page').optional().isInt({ min: 1 }).withMessage('validation.PAGE_NUMBER_INVALID'),
      body('pageSize').optional().isInt({ min: 1, max: 100 }).withMessage('validation.LIMIT_INVALID'),
      body('status').optional().isIn(STATUSES).withMessage('validation.VALIDATION_ERROR'),
      body('mode').optional().isIn(MODES).withMessage('validation.VALIDATION_ERROR'),
      body('keyword').optional().isString().isLength({ min: 1, max: 100 }).withMessage('validation.KEYWORD_LENGTH_INVALID'),
      body('sort_by').optional().isIn(['id', 'create_time', 'update_time', 'last_sync_time', 'name', 'status']).withMessage('validation.VALIDATION_ERROR'),
      body('sort_order').optional().isIn(['asc', 'desc']).withMessage('validation.VALIDATION_ERROR'),
      DEVICE_ID_RULE,
      DEVICE_BOUND_RULE,
    ];
  },

  validateSummary() {
    return [DEVICE_ID_RULE, DEVICE_BOUND_RULE];
  },

  validateGet() {
    return [
      body('id').notEmpty().isInt({ min: 1 }).withMessage('validation.ID_INVALID'),
      DEVICE_ID_RULE,
      DEVICE_BOUND_RULE,
    ];
  },

  validateUpsert() {
    return [
      body('id').optional().isInt({ min: 1 }).withMessage('validation.ID_INVALID'),
      body('name').notEmpty().isString().isLength({ min: 1, max: 32 }).withMessage('sync.TASK_NAME_INVALID'),
      body('mode').notEmpty().isIn(MODES).withMessage('sync.MODE_INVALID'),
      body('local_dir').notEmpty().isString().isLength({ min: 1, max: 1024 }).withMessage('sync.LOCAL_DIR_REQUIRED'),
      body('remote_dir').notEmpty().isString().isLength({ min: 1, max: 1024 }).withMessage('sync.REMOTE_DIR_REQUIRED'),
      body('filter_config').optional().isObject().withMessage('validation.VALIDATION_ERROR'),
      body('sync_config').optional().isObject().withMessage('validation.VALIDATION_ERROR'),
      DEVICE_ID_RULE,
      DEVICE_BOUND_RULE,
      body('device_name').optional().isString().isLength({ max: 128 }).withMessage('validation.VALIDATION_ERROR'),
    ];
  },

  validateDelete() {
    return [
      body('id').notEmpty().isInt({ min: 1 }).withMessage('validation.ID_INVALID'),
      DEVICE_ID_RULE,
      DEVICE_BOUND_RULE,
    ];
  },

  validateUpdateStatus() {
    return [
      body('id').notEmpty().isInt({ min: 1 }).withMessage('validation.ID_INVALID'),
      body('status').optional().isIn(STATUSES).withMessage('sync.STATUS_INVALID'),
      DEVICE_ID_RULE,
      DEVICE_BOUND_RULE,
    ];
  },

  validateListRecords() {
    return [
      body('id').notEmpty().isInt({ min: 1 }).withMessage('validation.ID_INVALID'),
      body('page').optional().isInt({ min: 1 }).withMessage('validation.PAGE_NUMBER_INVALID'),
      body('pageSize').optional().isInt({ min: 1, max: 100 }).withMessage('validation.LIMIT_INVALID'),
      DEVICE_ID_RULE,
      DEVICE_BOUND_RULE,
    ];
  },

  validateProbe() {
    return [body('path').notEmpty().isString().isLength({ min: 1, max: 1024 }).withMessage('sync.REMOTE_DIR_REQUIRED')];
  },

  validatePlan() {
    return [
      body('id').notEmpty().isInt({ min: 1 }).withMessage('validation.ID_INVALID'),
      body('local_files').optional().custom(isManifestArray).withMessage('sync.MANIFEST_INVALID'),
      body('baseline_files').optional().custom(isManifestArray).withMessage('sync.MANIFEST_INVALID'),
      body('max_list_per_type').optional().isInt({ min: 1, max: 200000 }).withMessage('validation.VALIDATION_ERROR'),
      DEVICE_ID_RULE,
      DEVICE_BOUND_RULE,
    ];
  },

  validateReport() {
    return [
      body('id').notEmpty().isInt({ min: 1 }).withMessage('validation.ID_INVALID'),
      body('status').optional().isIn(['success', 'failed', 'stopped']).withMessage('validation.VALIDATION_ERROR'),
      body('upload_count').optional().isInt({ min: 0 }).withMessage('validation.VALIDATION_ERROR'),
      body('download_count').optional().isInt({ min: 0 }).withMessage('validation.VALIDATION_ERROR'),
      body('delete_count').optional().isInt({ min: 0 }).withMessage('validation.VALIDATION_ERROR'),
      body('skip_count').optional().isInt({ min: 0 }).withMessage('validation.VALIDATION_ERROR'),
      body('fail_count').optional().isInt({ min: 0 }).withMessage('validation.VALIDATION_ERROR'),
      body('bytes_transferred').optional().isInt({ min: 0 }).withMessage('validation.VALIDATION_ERROR'),
      body('error_list').optional().isArray().withMessage('validation.VALIDATION_ERROR'),
      DEVICE_ID_RULE,
      DEVICE_BOUND_RULE,
    ];
  },

  validateDeleteRemote() {
    return [
      body('id').notEmpty().isInt({ min: 1 }).withMessage('validation.ID_INVALID'),
      body('rel_paths').notEmpty().isArray({ min: 1, max: 5000 }).withMessage('validation.VALIDATION_ERROR'),
      DEVICE_ID_RULE,
      DEVICE_BOUND_RULE,
    ];
  },

  validateMkdir() {
    return [
      body('id').notEmpty().isInt({ min: 1 }).withMessage('validation.ID_INVALID'),
      body('rel_path').notEmpty().isString().isLength({ min: 1, max: 1024 }).withMessage('sync.REL_PATH_INVALID'),
      DEVICE_ID_RULE,
      DEVICE_BOUND_RULE,
    ];
  },

  validateClaimLegacy() {
    return [
      body('device_id').notEmpty().withMessage('sync.DEVICE_ID_REQUIRED').isString().isLength({ min: 1, max: 128 }).withMessage('sync.DEVICE_ID_INVALID'),
      body('device_bound').optional().isBoolean().withMessage('validation.VALIDATION_ERROR'),
      body('device_name').optional().isString().isLength({ max: 128 }).withMessage('validation.VALIDATION_ERROR'),
    ];
  },

  handleValidationErrors(req, res, next) {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      const errorMessages = errors
        .array()
        .map(error => getLocalizedMessage(req, error.msg))
        .join(', ');
      return res.status(400).json({
        success: false,
        message: errorMessages,
      });
    }
    next();
  },
};

module.exports = SyncValidation;
