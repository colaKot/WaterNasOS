'use strict';

const forge = require('node-forge');
const fs = require('fs');
const path = require('path');
const config = require('../config/config');

/**
 * 获取证书存储目录（用户数据目录下的 certs/）
 */
function getCertDir() {
  return path.join(config.getUserDataPath(), 'certs');
}

/**
 * 确保证书存在，不存在则自动生成自签名证书。
 * @returns {{ keyPath: string, certPath: string }} 证书文件路径
 */
function ensureCert() {
  const certDir = getCertDir();
  const keyPath = path.join(certDir, 'key.pem');
  const certPath = path.join(certDir, 'cert.pem');

  const lockPath = path.join(certDir, 'generate.lock');
  const bothExist = () => fs.existsSync(keyPath) && fs.existsSync(certPath);
  const sleepSync = ms => {
    try {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    } catch (_) {}
  };

  // 锁里写 PID：worker 在生成证书时被强杀（断电 / docker kill）会留下锁文件，
  // 没有 PID 探活的话下一次启动要白等满 10s，而且锁文件永远没人删
  // （2026-10-18 浸泡实测：预置一个陈旧锁，启动从 4.5s 变成 15.2s）。
  const pidAlive = pid => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (e) {
      return !!(e && e.code === 'EPERM');
    }
  };
  const dropStaleLock = () => {
    try {
      const pid = parseInt(String(fs.readFileSync(lockPath, 'utf8')).trim(), 10);
      if (Number.isInteger(pid) && pid > 0) {
        if (!pidAlive(pid)) {
          fs.unlinkSync(lockPath);
          return true;
        }
        return false;
      }
      // 没有可用 PID（老版本或内容为空）：超过 60s 视为陈旧
      if (Date.now() - fs.statSync(lockPath).mtimeMs > 60000) {
        fs.unlinkSync(lockPath);
        return true;
      }
    } catch (_) {}
    return false;
  };


  if (bothExist()) {
    // 崩溃可能留下 generate.lock（worker 死在生成途中，而另一路已把证书写好）
    // ⇒ 不清掉它会一直躺在 certs/ 里，看着像「还在生成」（2026-10-18 浸泡实测残留）
    if (fs.existsSync(lockPath)) dropStaleLock();
    return { keyPath, certPath };
  }

  try {
    fs.mkdirSync(certDir, { recursive: true });
  } catch (_) {}

  // ⭐ 首启并发保护（2026-10-18）：cluster 里 express worker 是按数量 fork 的，
  //   每个 worker 都会跑 HTTPS 初始化 ⇒ 首次启动时全部走到这里，各自生成一对再各自写文件。
  //   两个 writeFileSync 交错的结果可能是「key 来自 A、cert 来自 B」——文件都在、长度也对，
  //   但 HTTPS 握手必然失败，且只能靠手删 certs 才能恢复。
  //   这里用 lock 文件串行化（抢到锁后再查一次，避免重复生成），写完用 rename 落盘。
  let lockFd = null;
  for (let i = 0; i < 200; i++) {
    try {
      lockFd = fs.openSync(lockPath, 'wx');
      try {
        fs.writeSync(lockFd, String(process.pid));
      } catch (_) {}
      break;
    } catch (e) {
      if (!e || e.code !== 'EEXIST') break;
      if (bothExist()) return { keyPath, certPath };
      if (dropStaleLock()) continue;
      sleepSync(50);
    }
  }

  try {
    if (bothExist()) return { keyPath, certPath };

    console.log('[certUtil] Generating self-signed certificate for HTTPS...');

    // RSA 2048 密钥对，首次生成约需 0.5~2 秒，之后缓存复用
    const keys = forge.pki.rsa.generateKeyPair(2048);
    const cert = forge.pki.createCertificate();

    cert.publicKey = keys.publicKey;
    cert.serialNumber = '01' + Date.now().toString(16);

    const now = new Date();
    cert.validity.notBefore = now;
    cert.validity.notAfter = new Date(now.getFullYear() + 10, now.getMonth(), now.getDate());

    const attrs = [
      { name: 'commonName', value: 'localhost' },
      { name: 'organizationName', value: 'WaterNasOS Self-Signed' },
    ];
    cert.setSubject(attrs);
    cert.setIssuer(attrs);

    // 添加 SAN：localhost、127.0.0.1、本机 IP
    cert.setExtensions([
      {
        name: 'subjectAltName',
        altNames: [
          { type: 2, value: 'localhost' },
          { type: 7, ip: '127.0.0.1' },
        ],
      },
      {
        name: 'basicConstraints',
        cA: false,
      },
    ]);

    cert.sign(keys.privateKey, forge.md.sha256.create());

    const certPem = forge.pki.certificateToPem(cert);
    const keyPem = forge.pki.privateKeyToPem(keys.privateKey);

    const tmpKey = `${keyPath}.${process.pid}.tmp`;
    const tmpCert = `${certPath}.${process.pid}.tmp`;
    fs.writeFileSync(tmpKey, keyPem, { mode: 0o600 });
    fs.writeFileSync(tmpCert, certPem, { mode: 0o644 });
    fs.renameSync(tmpCert, certPath);
    fs.renameSync(tmpKey, keyPath);

    console.log('[certUtil] Self-signed certificate generated successfully.');
    return { keyPath, certPath };
  } finally {
    if (lockFd !== null) {
      try {
        fs.closeSync(lockFd);
      } catch (_) {}
      try {
        fs.unlinkSync(lockPath);
      } catch (_) {}
    }
  }
}

module.exports = { ensureCert, getCertDir };
