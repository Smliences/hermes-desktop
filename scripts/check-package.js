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

t('node-pty 走 NAPI 预编译产物，且没被逼着重编译', () => {
  assert(/asarUnpack:[\s\S]{0,160}node-pty/.test(yml), 'asarUnpack 未包含 node-pty（asar 内的 .node 无法加载）');
  // 关掉重编译后完全依赖 prebuilds：这两个条件必须成对出现。若有人把 npmRebuild 改回
  // true，在 Python 3.12+（无 distutils）的机器上 node-gyp 会直接失败，包都打不出来。
  assert(/npmRebuild:\s*false/.test(yml),
    'npmRebuild 必须是 false —— node-pty 已带 NAPI prebuilds，重编译只会在缺编译链的机器上失败');
  const arch = `${process.platform}-${process.arch}`;
  const bin = `node_modules/node-pty/prebuilds/${arch}/pty.node`;
  assert(exists(bin), `关掉重编译后完全依赖预编译产物，缺 ${bin}`);
  // spawn-helper 是独立可执行文件，必须一起 unpack 并保留执行位
  const helper = path.join(ROOT, `node_modules/node-pty/prebuilds/${arch}/spawn-helper`);
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
