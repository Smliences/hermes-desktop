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

t('已移除 node-pty 原生依赖且保持 npmRebuild: false', () => {
  assert(!/node-pty/.test(yml), 'electron-builder.yml 不应再引用 node-pty');
  assert(!pkg.optionalDependencies || !pkg.optionalDependencies['node-pty'], 'package.json 不应再保留 node-pty');
  assert(/npmRebuild:\s*false/.test(yml), 'npmRebuild 应保持 false');
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

t('HTML 入口引用的本地脚本 / 样式 / 图片都存在，且无孤立静态资源', () => {
  const refs = new Set();
  for (const page of ['renderer/index.html', 'renderer/orb.html', 'renderer/orb-chat.html']) {
    assert(exists(page), '缺少渲染层入口页面：' + page);
    const html = read(page);
    const localRefs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1])
      .filter((u) => !/^(https?:|data:|#|blob:|mailto:)/.test(u));
    for (const r of localRefs) {
      const rel = path.normalize(path.join('renderer', r.replace(/^\.\//, '')));
      assert(exists(rel), `${page} 引用了不存在的资源：${r}`);
      refs.add(rel);
    }
  }
  const assetsDir = path.join(ROOT, 'renderer/assets');
  if (fs.existsSync(assetsDir)) {
    const codeText = [...fs.readdirSync(path.join(ROOT, 'renderer/chat'))].map((f) => read(path.join('renderer/chat', f))).join('\n')
      + read('renderer/app.js');
    for (const name of fs.readdirSync(assetsDir)) {
      const rel = path.join('renderer/assets', name);
      assert(refs.has(rel) || codeText.includes(`assets/${name}`), '存在未被引用的孤立资源：' + rel);
    }
  }
});

t('mac 打包目标与产物目录配置齐全，且产物不进仓库', () => {
  assert(/output:\s*release/.test(yml), 'directories.output 不是 release');
  assert(/target:\s*[\s\S]{0,80}dmg/.test(yml), 'mac target 未配置 dmg');
  assert(/identity:\s*null/.test(yml), '未显式关闭签名（本地开发包应写 identity: null）');
  assert(/^release\//m.test(read('.gitignore')), '.gitignore 缺少 release/');
});

t('mac.target 不写死多架构（本地只有一份 Electron，会打出名字对、二进制错的假包）', () => {
  // 先剥掉注释：文档里会写「不要用 arch: [arm64, x64]」这种反面例子，吃掉注释才不会误报。
  const bare = yml.split('\n').map((l) => l.replace(/(^|\s)#.*$/, '')).join('\n');
  const macStart = bare.indexOf('\nmac:');
  const winStart = bare.indexOf('\nwin:');
  const targetBlock = bare.slice(macStart, winStart > macStart ? winStart : undefined);

  // 反面证据：electron-builder 25 遇到 arch:[arm64, x64] + electronDist（单一架构）时，
  // 不下载、不报错，只把文件名改成 -arm64.dmg，里面躺着 x86_64 的 Mach-O（实测）。
  assert(!/arch:\s*\[[^\]]*\]/.test(targetBlock),
    'mac.target 里写死了 arch 列表 —— electronDist 只有一份架构时，electron-builder 会生成\n'
    + '      名字是 -arm64、二进制却是 x64 的假包（Apple Silicon 上不装 Rosetta 打不开）。\n'
    + '      要么删掉 arch 只打当前架构，要么先 npm i -D electron --arch=arm64。');
});

t('打包脚本走 scripts/dist.js（直接调 electron-builder 会被 NODE_OPTIONS 的 fs 代理搞挂）', () => {
  for (const name of ['dist', 'dist:mac', 'dist:win', 'dist:linux']) {
    assert(pkg.scripts && typeof pkg.scripts[name] === 'string', '缺少 npm 脚本 ' + name);
    assert(pkg.scripts[name].includes('scripts/dist.js'),
      `${name} 没走 scripts/dist.js —— 宿主注入的 NODE_OPTIONS（fs 代理 shim）会让 electron-builder`
      + ' 在搬运 Electron.app 时以 "Invalid package default_app.asar" 失败');
  }
  const dist = read('scripts/dist.js');
  assert(dist.includes('delete env.NODE_OPTIONS'), 'dist.js 没有摘掉 NODE_OPTIONS');
  assert(dist.includes("execFileSync('lipo'"), 'dist.js 没有用 lipo 核对架构（会放过假包）');
});

console.log(`\n打包自检：${pass} 通过 / ${fail} 失败`);
if (fail) process.exitCode = 1;
