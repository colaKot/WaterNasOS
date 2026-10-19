const ResponseUtil = require('../../../apiUtils/responseUtil');
const fileService = require('../core/fileService');
const fs = require('fs');

async function getTiny(req, res) {
  // console.log('tiny tiny', req.query.path, req.query.size);
  try {
    const { path: filePath, size } = req.query;
    if (!filePath) return ResponseUtil.error(req, res, 'file.INVALID_PATH', 400);
    const targetPath = await fileService.getTinyImgByPath(filePath, size);
    if (fs.existsSync(targetPath)) {
      return await res.sendFile(targetPath);
    } else {
      return res.sendStatus(404);
    }
  } catch (err) {
    const msg = String((err && err.message) || '');
    // ⚠️ fileService 抛的是 `file.UNSUPPORTED_TYPE:<ext>`（带后缀），
    //    原来用全等比较永远匹配不上 ⇒ 不支持的类型也被当成 500 打回去。
    const unsupported = msg.startsWith('file.UNSUPPORTED_TYPE');
    // ⭐ 2026-10-19 源文件本身就解不开（实测：44 字节的“png”其实是 base64 文本、
    //    扩展名是 .png 的网页缓存），重试一万次也是同一个结果。
    //    这类一律回 404 让前端落占位图，不再 500 + 无限重试刷屏。
    const brokenSource =
      /unsupported image format|Input buffer contains|Input file is missing|premature end|VipsJpeg|corrupt/i.test(
        msg
      );
    if (msg !== 'file.TINY_PENDING' && !unsupported && !brokenSource) {
      console.log(err, req.query.path);
    }
    if (msg === 'file.NOT_FOUND') return res.sendStatus(404);
    if (msg === 'file.TINY_PENDING') return res.status(202).set('Retry-After', '2').end();
    if (unsupported) return res.sendStatus(415);
    if (brokenSource) return res.sendStatus(404);
    return ResponseUtil.error(req, res, 'file.TINY_FAILED', 500, { error: msg });
  }
}

module.exports = {
  getTiny,
};
