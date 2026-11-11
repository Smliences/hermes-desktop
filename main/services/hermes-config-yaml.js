'use strict';
/**
 * hermes-config-yaml.js — 对 ~/.hermes/config.yaml 做「原格式行级列表编辑」
 *
 * 为什么不用 YAML 库整体序列化：config.yaml 含大量注释、嵌套段与手写缩进，
 * 整体 round-trip 会破坏格式甚至丢注释。这里只针对三个扁平列表
 *（plugins.enabled / plugins.disabled / skills.disabled）增删 `- name` 行，
 * 其余字节原封不动。
 *
 * 写操作为原子替换（临时文件 + rename），并经串行队列，避免并发开关互相覆盖。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const profile = require('./hermes-profile');
const cfgPath = () => profile.configPath();
const LISTS = [['plugins', 'enabled'], ['plugins', 'disabled'], ['skills', 'disabled']];

/** 顶层 section（无缩进 `name:`）的行范围；inline 值会抛错，绝不盲写。 */
function findSection(text, section) {
  const lines = text.split('\n');
  const re = new RegExp('^' + section + '\\s*:\\s*(.*)$');
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(re);
    if (!m) continue;
    const rest = m[1].replace(/\s+#.*$/, '').trim();
    if (rest) throw new Error(`${section}: 不是块结构，拒绝改写`);
    let end = lines.length;
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j];
      if (!l.trim() || /^\s*#/.test(l)) continue;
      if (!/^\s/.test(l)) { end = j; break; }
    }
    return { start: i, end, lines };
  }
  return null;
}

/** 在 section 内定位 `  key:` 列表；items 为 `- value` 行。 */
function findList(lines, sec, key) {
  const keyRe = new RegExp('^(\\s{1,4})' + key + '\\s*:\\s*(?:#.*)?$');
  for (let i = sec.start + 1; i < sec.end; i++) {
    const m = lines[i].match(keyRe);
    if (!m) continue;
    const keyIndent = m[1].length;
    const items = [];
    let end = sec.end;
    for (let j = i + 1; j < sec.end; j++) {
      const l = lines[j];
      if (!l.trim() || /^\s*#/.test(l)) continue;
      const indent = l.length - l.trimStart().length;
      if (indent <= keyIndent) { end = j; break; }
      const im = l.match(/^(\s*)-\s+(.+?)\s*$/);
      if (im) {
        let v = im[2].replace(/\s+#.*$/, '').trim();
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
        items.push({ line: j, value: v, indent: im[1].length });
      }
    }
    return { keyLine: i, end, keyIndent, items };
  }
  return null;
}

/** 读取三个列表的当前值（纯文本解析，零子进程）。 */
function readLists(text) {
  const src = text === undefined ? fs.readFileSync(cfgPath(), 'utf8') : text;
  const out = {};
  for (const [secName, key] of LISTS) {
    const keyFull = secName + '.' + key;
    const sec = findSection(src, secName);
    out[keyFull] = [];
    if (!sec) continue;
    const list = findList(sec.lines, sec, key);
    if (list) out[keyFull] = list.items.map((it) => it.value);
  }
  return out;
}

/** 生成编辑后的文本（不落盘，便于测试）：在指定列表里 add / remove 若干名字。 */
function transform(text, section, key, mutation = {}) {
  // 名字来自渲染层 / CLI manifest，写进 YAML 前必须收敛：禁止换行、缩进、
  // 前导 `-` 与 YAML 特殊字符，否则 `'    - ' + name` 可注入任意配置行。
  const safeName = (v) => {
    const s = String(v == null ? '' : v).trim();
    // 拒绝换行（唯一能新增 YAML 行的字符）、前导 `-`（会变成列表标记）、
    // shell/控制字符；中文与 @scope/name 等合法标识符保持可用。
    if (!s || s.length > 200) return null;
    if (s.startsWith('-') || /[\x00-\x1f\x7f`|&$<>]/.test(s)) return null;
    return s;
  };
  const add = (Array.isArray(mutation.add) ? mutation.add : []).map(safeName).filter(Boolean);
  const remove = (Array.isArray(mutation.remove) ? mutation.remove : [])
    .map(String).filter((s) => s && s.length <= 200 && !/[\r\n]/.test(s));
  const lines = text.split('\n');
  let sec = findSection(text, section);
  if (!sec) {
    const tail = lines.slice();
    while (tail.length && !tail[tail.length - 1].trim()) tail.pop();
    tail.push('', section + ':', '  ' + key + ':');
    for (const n of add) tail.push('    - ' + n);
    return { text: tail.join('\n') + '\n', changed: add.length > 0 };
  }
  sec = { start: sec.start, end: sec.end, lines };
  const list = findList(lines, sec, key);

  if (!list) {
    if (!add.length) return { text, changed: false };
    const ins = ['  ' + key + ':', ...add.map((n) => '    - ' + n)];
    lines.splice(sec.end, 0, ...ins);
    return { text: lines.join('\n'), changed: true };
  }

  const removeSet = new Set(remove.map(String));
  const have = new Set(list.items.map((it) => it.value));
  const toAdd = add.map(String).filter((n) => !have.has(n));
  const dropLines = new Set(list.items.filter((it) => removeSet.has(it.value)).map((it) => it.line));
  if (!toAdd.length && !dropLines.size) return { text, changed: false };

  // 插入锚点：列表最后一项之后；列表为空则是 `key:` 行之后
  const anchor = list.items.length ? list.items[list.items.length - 1].line : list.keyLine;
  const indent = list.items.length
    ? ' '.repeat(list.items[list.items.length - 1].indent)
    : ' '.repeat(Math.max(4, list.keyIndent + 2));
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (!dropLines.has(i)) out.push(lines[i]);
    if (i === anchor && toAdd.length) for (const n of toAdd) out.push(indent + '- ' + n);
  }
  return { text: out.join('\n'), changed: true };
}

let queue = Promise.resolve();

/** 串行执行一次「读-改-原子写」，返回改动后的三个列表。 */
function mutate(section, key, mutation) {
  const job = queue.then(() => {
    const file = cfgPath();
    const original = fs.readFileSync(file, 'utf8');
    const stat = fs.statSync(file);
    const { text, changed } = transform(original, section, key, mutation);
    if (changed) {
      // 唯一 tmp 名：进程内队列已串行，但不同桌面实例 / hermes CLI 可能并发写。
      // 写前再比对 mtime+size，发现外部改动就放弃本次写入，避免 lost update。
      const tmp = `${file}.hermes-desktop.${process.pid}.${Date.now()}.tmp`;
      try {
        fs.writeFileSync(tmp, text, { mode: stat.mode });
        const now = fs.statSync(file);
        if (now.mtimeMs !== stat.mtimeMs || now.size !== Buffer.byteLength(original)) {
          return { ok: false, error: '配置文件在写入期间被其他进程修改，请重试' };
        }
        fs.renameSync(tmp, file);
      } finally {
        try { fs.unlinkSync(tmp); } catch {}
      }
    }
    return { ok: true, changed, lists: readLists(text) };
  }).catch((err) => ({ ok: false, error: String((err && err.message) || err) }));
  queue = job.then(() => {}, () => {}); // 单次失败不中断队列
  return job;
}

/** 监视 config.yaml 的外部改动（原子替换会换 inode，因此监听目录）。
 *  多订阅：插件与技能各自注册回调，旧实现用单例 _watchCb，后者会覆盖前者，
 *  导致 config.yaml 外部改动后插件开关状态永远不刷新。 */
const _watchCbs = new Set();
let _unwatch = null;

function bindWatch() {
  if (_unwatch) { try { _unwatch(); } catch {} _unwatch = null; }
  if (!_watchCbs.size) return () => {};
  try {
    let t = null;
    const file = cfgPath();
    const dir = path.dirname(file);
    const base = path.basename(file);
    const w = fs.watch(dir, { persistent: false }, (_evt, filename) => {
      if (filename && String(filename) !== base && !String(filename).startsWith(base + '.')) return;
      clearTimeout(t);
      t = setTimeout(() => { for (const cb of _watchCbs) { try { cb(); } catch {} } }, 200);
    });
    _unwatch = () => { clearTimeout(t); try { w.close(); } catch {} };
    return _unwatch;
  } catch { return () => {}; }
}

/** 返回取消订阅函数；重复注册同一函数不会重复触发（Set）。 */
function watch(onChange) {
  if (typeof onChange === 'function') _watchCbs.add(onChange);
  bindWatch();
  return () => _watchCbs.delete(onChange);
}
/** 切换 profile 后重新绑定目录监听（旧 profile 的 watcher 必须释放）。 */
function rewatch() { return bindWatch(); }
/** 应用退出时释放 watcher，避免持住 fs 句柄。 */
function dispose() { _watchCbs.clear(); if (_unwatch) { try { _unwatch(); } catch {} _unwatch = null; } }

module.exports = { cfgPath, readLists, transform, mutate, watch, rewatch, dispose, findSection, findList };
