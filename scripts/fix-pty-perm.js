'use strict';
/* npm 解包 node-pty 的 prebuilds 时可能丢掉 spawn-helper 的执行位（实测 mac 上装成 644）。
   少了执行位，node-pty 拉起伪终端会 EACCES，终端页直接降级成普通管道。
   打包不会修权限：asarUnpack 只负责把文件拿出 asar。所以装完依赖就补上。 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', 'node_modules', 'node-pty', 'prebuilds');
const dirs = ['darwin-x64', 'darwin-arm64', 'linux-x64', 'linux-arm64'];
let fixed = 0;
for (const d of dirs) {
  const f = path.join(root, d, 'spawn-helper');
  try {
    if (!fs.existsSync(f)) continue;
    const mode = fs.statSync(f).mode & 0o777;
    if (mode & 0o111) continue;
    fs.chmodSync(f, 0o755);
    fixed++;
  } catch { /* 只读安装目录等场景忽略，打包自检会再提醒一次 */ }
}
if (fixed) console.log(`[fix-pty-perm] 已恢复 ${fixed} 个 spawn-helper 的执行位`);
