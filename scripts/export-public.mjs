#!/usr/bin/env node
// 生成「脱敏公开快照」：从本仓库 tracked 文件复制、替换敏感串、校验无泄漏，
// 然后初始化一个全新 git 仓库（单提交历史，避免私有历史中的密钥被公开）。
//
// 用法：
//   node scripts/export-public.mjs --out ..\codefree-o-proxy-public
//   node scripts/export-public.mjs --out <dir> --push --repo-url https://github.com/<owner>/<repo>.git
//
// 敏感替换规则放在 gitignored 的 scripts/export-public.local.json：
//   {
//     "excludedPrefixes": ["docs/private/"],
//     "replacements": [{ "from": "...", "to": "..." }],
//     "insertions": [{ "file": "README.md", "anchor": "...", "text": "..." }],
//     "forbidden": ["...", "..."],
//     "forbiddenPatterns": ["regex1", "regex2"],
//     "publicRepo": "https://github.com/<owner>/<repo>.git",
//     "description": "..."
//   }
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const args = process.argv.slice(2);
const getArg = (name, fallback = '') => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const hasFlag = (name) => args.includes(name);

const outDir = path.resolve(getArg('--out', path.join(repoRoot, '..', `${path.basename(repoRoot)}-public`)));
const configPath = path.resolve(getArg('--config', path.join(repoRoot, 'scripts', 'export-public.local.json')));
const push = hasFlag('--push');
const repoUrl = getArg('--repo-url', '');

if (!fs.existsSync(configPath)) {
  console.error(`缺少脱敏规则文件：${configPath}\n请先创建（参考 scripts/export-public.example.json），该文件已被 .gitignore 忽略。`);
  process.exit(1);
}
const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const replacements = (cfg.replacements || []).map((r) => ({ from: String(r.from), to: String(r.to) }));
const insertions = cfg.insertions || [];
const excludedPrefixes = cfg.excludedPrefixes || [];

const BINARY_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.ico', '.zip', '.bundle', '.woff', '.woff2', '.ttf', '.otf']);
const files = execFileSync('git', ['-c', 'core.quotepath=false', 'ls-files', '-z'], { cwd: repoRoot, encoding: 'buffer' })
  .toString('utf8')
  .split('\u0000')
  .filter(Boolean);

if (fs.existsSync(outDir)) fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

let copied = 0;
const skipped = [];
for (const rel of files) {
  if (excludedPrefixes.some((p) => rel === p || rel.startsWith(p.endsWith('/') ? p : `${p}/`))) {
    skipped.push(rel);
    continue;
  }
  const src = path.join(repoRoot, rel);
  const dst = path.join(outDir, rel);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  if (BINARY_EXT.has(path.extname(rel).toLowerCase())) {
    fs.copyFileSync(src, dst);
    copied++;
    continue;
  }
  let text = fs.readFileSync(src, 'utf8');
  for (const r of replacements) {
    if (r.from && text.includes(r.from)) text = text.split(r.from).join(r.to);
  }
  for (const ins of insertions) {
    if (ins.file !== rel) continue;
    if (ins.anchor && text.includes(ins.anchor)) text = text.replace(ins.anchor, `${ins.anchor}${ins.text}`);
    else if (!ins.anchor) text = `${ins.text}${text}`;
  }
  fs.writeFileSync(dst, text, 'utf8');
  copied++;
}

// ---- 泄漏校验 ----
function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}
const forbidden = (cfg.forbidden || []).map(String).filter(Boolean);
const forbiddenPatterns = (cfg.forbiddenPatterns || []).map((p) => new RegExp(p));
const violations = [];
for (const file of walk(outDir)) {
  if (BINARY_EXT.has(path.extname(file).toLowerCase())) continue;
  const text = fs.readFileSync(file, 'utf8');
  for (const f of forbidden) if (text.includes(f)) violations.push({ file, pattern: f.slice(0, 12) + '…' });
  for (const re of forbiddenPatterns) if (re.test(text)) violations.push({ file, pattern: re.source });
}
if (violations.length) {
  console.error('❌ 脱敏校验未通过，发现疑似敏感内容：');
  for (const v of violations.slice(0, 50)) console.error(` - ${path.relative(outDir, v.file)} :: ${v.pattern}`);
  process.exit(2);
}

// ---- 初始化公开历史（单提交） ----
execFileSync('git', ['init', '-b', 'main'], { cwd: outDir, stdio: 'ignore' });
execFileSync('git', ['config', 'user.name', process.env.GIT_AUTHOR_NAME || 'CodeFree-O Proxy'], { cwd: outDir });
execFileSync('git', ['config', 'user.email', process.env.GIT_AUTHOR_EMAIL || 'noreply@example.com'], { cwd: outDir });
execFileSync('git', ['add', '-A'], { cwd: outDir });
execFileSync('git', ['commit', '-m', 'public snapshot: CodeFree-O proxy (sanitized)'], { cwd: outDir, stdio: 'ignore' });

// ---- 推送到公开仓库（可选） ----
const targetRepo = repoUrl || cfg.publicRepo || '';
if (push) {
  if (!targetRepo) {
    console.error('缺少 --repo-url 或 cfg.publicRepo，无法推送');
    process.exit(1);
  }
  try {
    execFileSync('git', ['remote', 'add', 'origin', targetRepo], { cwd: outDir, stdio: 'ignore' });
  } catch {}
  execFileSync('git', ['push', '-u', 'origin', 'main', '--force'], { cwd: outDir, stdio: 'inherit' });
}

console.log(JSON.stringify({ ok: true, outDir, files: copied, skipped: skipped.length, pushed: push ? targetRepo : false }, null, 2));
