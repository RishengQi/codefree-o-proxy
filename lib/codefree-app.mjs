// 检测本机安装的 CodeFree-O 客户端版本（读取 resources/app.asar 内的 package.json）
// 用途：模型发现路径 /api/acbackend/modelmgr/v1/clients/codefree-o/versions/<VERSION>
// 与 clientVersion 请求头必须与安装的客户端版本一致；客户端自动升级后无需手工改配置。
import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs';
import path from 'node:path';

/** 常见安装路径（按优先级） */
export function candidateAsarPaths(env = process.env) {
  const out = [];
  if (env.CODEFREE_APP_ASAR) out.push(env.CODEFREE_APP_ASAR);
  const local = env.LOCALAPPDATA;
  if (local) {
    out.push(
      path.join(local, 'Programs', 'codefree-desktop', 'resources', 'app.asar'),
      path.join(local, 'Programs', 'CodeFree-O', 'resources', 'app.asar'),
      path.join(local, 'Programs', 'codefree-o', 'resources', 'app.asar'),
    );
  }
  if (env.ProgramFiles) out.push(path.join(env.ProgramFiles, 'CodeFree-O', 'resources', 'app.asar'));
  if (env['ProgramFiles(x86)']) out.push(path.join(env['ProgramFiles(x86)'], 'CodeFree-O', 'resources', 'app.asar'));
  return out;
}

function readAt(fd, offset, length) {
  const buf = Buffer.alloc(length);
  const n = readSync(fd, buf, 0, length, offset);
  return buf.subarray(0, n);
}

/**
 * 解析 asar 头，返回 { header, dataStart }。
 * asar 布局：u32(4) | u32(headerSize) | u32(headerSize-4) | u32(jsonLen) | JSON | padding | data
 * 其中 dataStart = 8 + u32@4（实测 1.10.1: 8 + 1296560 = 1296568）。
 */
export function readAsarHeader(fd) {
  const prefix = readAt(fd, 0, 16);
  if (prefix.length < 16) throw new Error('asar 文件过短');
  const headerSize = prefix.readUInt32LE(4);
  const jsonLen = prefix.readUInt32LE(12);
  if (!jsonLen || jsonLen > 512 * 1024 * 1024) throw new Error(`asar header JSON 长度异常：${jsonLen}`);
  const jsonBuf = readAt(fd, 16, jsonLen);
  const header = JSON.parse(jsonBuf.toString('utf8'));
  const dataStart = 8 + headerSize;
  if (!Number.isFinite(dataStart) || dataStart < 16) throw new Error('asar dataStart 异常');
  return { header, dataStart };
}

/** 读取 asar 内的 package.json 版本号 */
export function readAsarPackageVersion(file) {
  const fd = openSync(file, 'r');
  try {
    const { header, dataStart } = readAsarHeader(fd);
    const entry = header?.files?.['package.json'];
    if (!entry || typeof entry.offset !== 'string' && typeof entry.offset !== 'number') {
      throw new Error('asar 内未找到 package.json 条目');
    }
    const offset = dataStart + Number(entry.offset);
    const size = Number(entry.size || 0);
    if (!Number.isFinite(offset) || !Number.isFinite(size) || size <= 0 || size > 8 * 1024 * 1024) {
      throw new Error(`asar package.json 偏移/大小异常：offset=${entry.offset} size=${entry.size}`);
    }
    const pkg = JSON.parse(readAt(fd, offset, size).toString('utf8'));
    const version = typeof pkg.version === 'string' ? pkg.version.trim() : '';
    if (!/^\d+\.\d+\.\d+/.test(version)) throw new Error(`package.json 版本号非法：${version}`);
    return { version, appAsar: file, name: pkg.name || 'codefree-o' };
  } finally {
    closeSync(fd);
  }
}

/**
 * 自动检测本机 CodeFree-O 版本。
 * @returns {{version:string, appAsar:string, name:string}|null} 失败返回 null（不抛错，走配置/默认值兜底）
 */
export function detectClientVersion({ env = process.env, logger } = {}) {
  const tried = [];
  for (const file of candidateAsarPaths(env)) {
    if (!file) continue;
    tried.push(file);
    try {
      if (!existsSync(file)) continue;
      const st = statSync(file);
      if (!st.isFile() || st.size < 64) continue;
      const detected = readAsarPackageVersion(file);
      logger?.info?.('已从安装目录识别 CodeFree-O 版本', { version: detected.version, appAsar: file });
      return detected;
    } catch (e) {
      logger?.debug?.('读取 CodeFree-O 安装包版本失败，尝试下一个候选', { file, error: e.message });
    }
  }
  logger?.debug?.('未找到可识别的 CodeFree-O 安装包', { tried });
  return null;
}
