'use strict';
/* dist — 打包统一入口。npm run dist:mac / dist:win / dist:linux 都走这里。
 *
 * 不直接调 electron-builder，是因为有两件宿主环境的事必须先处理，而它们的报错
 * 都指不到真正的原因：
 *
 * 1) NODE_OPTIONS 被注入了 fs 代理 shim（node-language-shim.cjs → 所有 fs 调用转给
 *    broker 进程）。electron-builder 打包时要搬运/删除 Electron.app 里几万个文件，
 *    走代理后会以 `Invalid package …/default_app.asar` 失败，看起来像 Electron 坏了，
 *    实际上跟 Electron 无关。这里 spawn 子进程时把 NODE_OPTIONS 摘掉。
 *
 * 2) electronDist 固定指向 node_modules/electron/dist，里面只有**一份架构**的 Electron。
 *    请求另一架构时 electron-builder 不报错、不下载，只把产物名改成 -arm64，而里面
 *    躺着的还是 x86_64 可执行文件（实测 100MB 的「arm64.dmg」）。这种包在 Apple
 *    Silicon 上不装 Rosetta 直接打不开，是最难排查的一类。这里用 lipo 核对，对不上
 *    直接退出并给出修法，绝不生成假包。
 */
const { spawnSync, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ARGS = process.argv.slice(2);

function die(msg) {
  console.error('\n✗ 打包中止：' + msg + '\n');
  process.exit(1);
}

/** electron-builder.yml 里 electronDist 的绝对路径；没配（走联网下载）时返回 null。 */
function readElectronDist() {
  const yml = fs.readFileSync(path.join(ROOT, 'electron-builder.yml'), 'utf8');
  const m = yml.match(/^electronDist:[ \t]*(.+)$/m);
  if (!m) return null;
  const raw = m[1].split('#')[0].trim().replace(/^['"]|['"]$/g, '');
  return raw ? path.resolve(ROOT, raw) : null;
}

/** lipo -archs 读 Mach-O 架构；不是 Mach-O 或工具缺失时返回 []。 */
function binArchs(p) {
  try {
    return execFileSync('lipo', ['-archs', p], { encoding: 'utf8' }).trim().split(/\s+/).filter(Boolean);
  } catch {
    return [];
  }
}

const PLATFORM_FLAG = (ARGS.find((a) => /^--(mac|win|linux)$/.test(a)) || '').replace('--', '');
const ARCH_FLAG = (ARGS.find((a) => /^--(x64|arm64|ia32|universal)$/.test(a)) || '').replace('--', '');

// Node 的 process.arch 用 x64 / ia32，Mach-O（lipo）用 x86_64 / i386，两边必须换算再比。
const LIPO_NAME = { x64: 'x86_64', ia32: 'i386', arm64: 'arm64' };

const platformMap = { darwin: 'mac', win32: 'win', linux: 'linux' };
const targetPlatform = PLATFORM_FLAG || platformMap[process.platform];
if (!targetPlatform) die('认不出目标平台，请显式传 --mac / --win / --linux');

// ---- 架构核对（只对 macOS 逐字节校验；其它平台只要有 electronDist 就必然打坏）----
const dist = readElectronDist();
if (dist) {
  if (targetPlatform !== 'mac') {
    die(`electron-builder.yml 里 electronDist 指向 ${path.relative(ROOT, dist)}，那是 macOS 版的 \
Electron，打 ${targetPlatform} 包得不到可用产物（缺 .exe / AppImage 运行所需文件）。
要么临时注释掉 electronDist 让 electron-builder 联网下载对应平台的 Electron，
要么先 npm i -D electron@<version> --platform=${targetPlatform === 'win' ? 'win32' : 'linux'}。`);
  }
  const bin = path.join(dist, 'Electron.app', 'Contents', 'MacOS', 'Electron');
  if (!fs.existsSync(bin)) die(`electronDist 里找不到 ${path.relative(ROOT, bin)}，手动删掉 node_modules/electron 重装。`);

  const have = binArchs(bin);
  const want = ARCH_FLAG || process.arch;
  const wantLipo = LIPO_NAME[want] || want;
  if (ARCH_FLAG === 'universal') {
    if (!(have.includes('x86_64') && have.includes('arm64'))) {
      die(`要打 universal 包，electronDist 里的 Electron 必须是 universal（当前只有：${have.join(', ') || '未知'}）。
先 npm i -D electron@33.4.11 --arch=universal。`);
    }
  } else if (have.length && !have.includes(wantLipo)) {
    die(`请求的是 ${want}（Mach-O 里叫 ${wantLipo}），但 electronDist 里的 Electron 是 ${have.join(', ')}。
electron-builder 不会因此报错，只会打出名字叫 -${want} 而二进制为 ${have.join('/')} 的假包。
修法：
    npm i -D electron@33.4.11 --arch=${want}        # 装上对应架构
或不带架构参数，只打当前机器（${process.arch}）。`);
  }
}

// ---- 转交 electron-builder（摘掉 NODE_OPTIONS 里的 fs 代理）----
const env = { ...process.env };
delete env.NODE_OPTIONS;
delete env.ELECTRON_RUN_AS_NODE;

const cli = require.resolve('electron-builder/cli.js');
console.log(`\n打包：platform=${targetPlatform} arch=${ARCH_FLAG || process.arch}（NODE_OPTIONS 已从子进程环境移除）\n`);
const r = spawnSync(process.execPath, [cli, ...ARGS], { cwd: ROOT, env, stdio: 'inherit' });
process.exit(r.status == null ? 1 : r.status);
