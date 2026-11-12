'use strict';
/* 打包前静态自检。
 *
 * 为什么需要：electron-builder 打出来的包「能构建」不等于「能启动」，最容易踩的三件事
 *   1) files 白名单漏了某个目录 → 运行时 xxx not found
 *   2) native 依赖没进 asarUnpack → asar 里的 .node 无法 dlopen，终端直接崩
 *   3) 某个包被写进 devDependencies → 本地能跑，打包后 require 失败
 * 这些都能只读文件就查出来，不必真跑一次构建（沙箱里也跑不了构建）。
 */
const fs = require('fs');
const path = require('path');
const Module = require('module');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const exists = (p) => fs.existsSync(path.join(ROOT, p));

let pass = 0;
let fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); } catch (e) {
    fail++; console.log('  ✗ ' + name + '\n      ' + String(e.message || e).split('\n').join('\n      '));
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

const yml = read('electron-builder.yml');
const pkg = JSON.parse(read('package.json'));

console.log('\n打包产物静态自检');

t('图标存在（buildResources 指向 build/，缺图标会退回 Electron 默认图标）', () => {
  assert(/buildResources:\s*build/.test(yml), 'directories.buildResources 不是 build');
  assert(exists('build/icon.icns'), '缺少 build/icon.icns');
  assert(fs.statSync(path.join(ROOT, 'build/icon.icns')).size > 10000, 'icon.icns 过小，大概率只有单一尺寸');
});

t('files 白名单覆盖 main / preload / renderer / package.json', () => {
  for (const p of ['main/**/*', 'preload/**/*', 'renderer/**/*', 'package.json']) {
    assert(yml.includes('- ' + p), 'files 缺少 ' + p);
  }
});

t('node-pty 在 asarUnpack 里，且有 darwin-x64 二进制', () => {
  assert(/asarUnpack:[\s\S]{0,160}node-pty/.test(yml), 'asarUnpack 未包含 node-pty（asar 内的 .node 无法加载）');
  const ok = exists('node_modules/node-pty/prebuilds/darwin-x64/pty.node')
    || exists('node_modules/node-pty/build/Release/pty.node');
  assert(ok, 'node-pty 没有可用的 darwin-x64 二进制（打包后终端会降级成普通管道）');
  // spawn-helper 是独立可执行文件，必须一起 unpack 并保留执行位
  const helper = path.join(ROOT, 'node_modules/node-pty/prebuilds/darwin-x64/spawn-helper');
  if (fs.existsSync(helper)) {
    const mode = fs.statSync(helper).mode & 0o777;
    assert(mode & 0o111, 'spawn-helper 丢失执行位，伪终端会启动失败');
  }
});

t('主进程 require 的第三方包都在 dependencies（devDependencies 不进包）', () => {
  const prod = new Set([...Object.keys(pkg.dependencies || {}), ...Object.keys(pkg.optionalDependencies || {})]);
  const builtin = new Set([...Module.builtinModules, 'electron']);
  const files = [];
  (function walk(dir) {
    for (const name of fs.readdirSync(path.join(ROOT, dir))) {
      const rel = path.join(dir, name);
      if (fs.statSync(path.join(ROOT, rel)).isDirectory()) walk(rel);
      else if (name.endsWith('.js')) files.push(rel);
    }
  })('main');
  const bad = new Set();
  for (const f of files) {
    for (const m of read(f).matchAll(/require\(['"]([^'"]+)['"]\)/g)) {
      const spec = m[1];
      if (spec.startsWith('.') || spec.startsWith('/')) continue;
      if (spec.startsWith('node:') || builtin.has(spec)) continue;
      const name = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
      if (!prod.has(name)) bad.add(name + '（' + f + '）');
    }
  }
  assert(bad.size === 0, '这些包不在 prod 依赖里，打包后 require 会失败：\n' + [...bad].join('\n'));
});

t('主进程 / preload 的相对 require 目标都存在', () => {
  const files = [];
  (function walk(dir) {
    for (const name of fs.readdirSync(path.join(ROOT, dir))) {
      const rel = path.join(dir, name);
      if (fs.statSync(path.join(ROOT, rel)).isDirectory()) walk(rel);
      else if (name.endsWith('.js')) files.push(rel);
    }
  })('main');
  for (const f of fs.readdirSync(path.join(ROOT, 'preload'))) {
    if (f.endsWith('.js')) files.push(path.join('preload', f));
  }
  const missing = [];
  for (const f of files) {
    for (const m of read(f).matchAll(/require\(['"](\.[^'"]+)['"]\)/g)) {
      const target = path.resolve(path.dirname(path.join(ROOT, f)), m[1]);
      if (!exists(path.relative(ROOT, target)) && !exists(path.relative(ROOT, target) + '.js')
        && !exists(path.relative(ROOT, path.join(target, 'index.js')))) {
        missing.push(m[1] + '（' + f + '）');
      }
    }
  }
  assert(missing.length === 0, '相对 require 目标不存在：\n' + missing.join('\n'));
});

t('package.json main 指向真实入口', () => {
  assert(pkg.main && exists(pkg.main), 'main 入口不存在：' + pkg.main);
});

t('index.html 引用的本地脚本 / 样式 / 图片都存在', () => {
  const html = read('renderer/index.html');
  const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1])
    .filter((u) => !/^(https?:|data:|#|blob:|mailto:)/.test(u));
  for (const r of refs) {
    const rel = path.join('renderer', r.replace(/^\.\//, ''));
    assert(exists(rel), 'index.html 引用了不存在的资源：' + r);
  }
});

t('mac 打包目标与产物目录配置齐全，且产物不进仓库', () => {
  assert(/output:\s*release/.test(yml), 'directories.output 不是 release');
  assert(/target:\s*[\s\S]{0,80}dmg/.test(yml), 'mac target 未配置 dmg');
  assert(/identity:\s*null/.test(yml), '未显式关闭签名（本地开发包应写 identity: null）');
  assert(/^release\//m.test(read('.gitignore')), '.gitignore 缺少 release/');
});

console.log(`\n打包自检：${pass} 通过 / ${fail} 失败`);
if (fail) process.exitCode = 1;
