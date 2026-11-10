// 客户端版本自动识别测试：合成 asar 头部 + 真实安装包（若存在）
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readAsarPackageVersion, detectClientVersion } from '../lib/codefree-app.mjs';
import { loadConfig } from '../lib/config.mjs';

/** 构造最小 asar（与 Electron asar 头布局一致：16 字节 pickle + JSON + padding + data） */
function buildAsar(pkg) {
  const pkgBuf = Buffer.from(JSON.stringify(pkg), 'utf8');
  const header = JSON.stringify({ files: { 'package.json': { size: pkgBuf.length, offset: 0 } } });
  const jsonLen = Buffer.byteLength(header);
  const dataStart = 16 + Math.ceil(jsonLen / 4) * 4;
  const buf = Buffer.alloc(dataStart + pkgBuf.length);
  buf.writeUInt32LE(4, 0);
  buf.writeUInt32LE(dataStart - 8, 4);
  buf.writeUInt32LE(dataStart - 12, 8);
  buf.writeUInt32LE(jsonLen, 12);
  buf.write(header, 16, 'utf8');
  pkgBuf.copy(buf, dataStart);
  return buf;
}

test('readAsarPackageVersion 读取 app.asar 内 package.json 版本', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cf-asar-test-'));
  const file = path.join(dir, 'app.asar');
  try {
    writeFileSync(file, buildAsar({ name: 'codefree-o', version: '9.9.9' }));
    const r = readAsarPackageVersion(file);
    assert.equal(r.version, '9.9.9');
    assert.equal(r.name, 'codefree-o');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('detectClientVersion 支持 CODEFREE_APP_ASAR 指定 / 读取失败返回 null', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cf-asar-test-'));
  const file = path.join(dir, 'app.asar');
  try {
    writeFileSync(file, buildAsar({ name: 'codefree-o', version: '1.10.1' }));
    const detected = detectClientVersion({ env: { CODEFREE_APP_ASAR: file } });
    assert.equal(detected?.version, '1.10.1');

    const bad = path.join(dir, 'bad.asar');
    writeFileSync(bad, Buffer.from('not-an-asar'));
    assert.equal(detectClientVersion({ env: { CODEFREE_APP_ASAR: bad } }), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadConfig 自动识别版本（优先于配置默认值）', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cf-config-test-'));
  const file = path.join(dir, 'app.asar');
  try {
    writeFileSync(file, buildAsar({ name: 'codefree-o', version: '1.11.3' }));
    const cfg = loadConfig({ cwd: dir, env: { CODEFREE_APP_ASAR: file, CODEFREE_CONFIG: '' } });
    assert.equal(cfg.upstream.version, '1.11.3');
    assert.equal(cfg.upstream.versionSource, 'app-asar');
    // 显式环境变量优先
    const cfg2 = loadConfig({ cwd: dir, env: { CODEFREE_APP_ASAR: file, CODEFREE_VERSION: '1.9.0' } });
    assert.equal(cfg2.upstream.version, '1.9.0');
    assert.equal(cfg2.upstream.versionSource, 'env');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('本机真实安装包可识别（若存在）', (t) => {
  const real =
    process.env.CODEFREE_APP_ASAR ||
    (process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, 'Programs', 'codefree-desktop', 'resources', 'app.asar')
      : path.join(os.homedir(), '.codefree-o', 'app.asar'));
  if (!existsSync(real)) return t.skip('本机未安装 CodeFree-O');
  const detected = detectClientVersion({ env: { CODEFREE_APP_ASAR: real } });
  assert.ok(detected, '未能识别真实安装包版本');
  assert.match(detected.version, /^\d+\.\d+\.\d+/);
});
