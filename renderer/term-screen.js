'use strict';
/**
 * term-screen.js — 终端输出的小型字符屏幕（消除 pty 原始字节造成的「乱码」）
 *
 * 之前 renderer 直接 `textContent += data`，于是 zsh / CLI 输出里的 ANSI
 * 转义序列（SGR 颜色、清行 \x1b[K、光标移动 \x1b[...、OSC 标题、\r 覆盖、
 * 退格）全都当成可见字符画进 <pre>，表现就是方块、乱码符号和重复提示符。
 *
 * 这里实现一个够用的终端状态机：按行列缓冲可打印字符，解释光标 / 擦除
 * 类控制序列，忽略颜色与模式类序列，输出纯文本。不做 256 色 / 真彩渲染
 * （那需要 innerHTML，会引入 XSS 面并挑战既有 CSP），换来的是零依赖、
 * 可数值单测、明暗主题下都干净。
 *
 * 转义序列可能跨 IPC chunk 被切开，未解析完的尾部存进 _pending 等下一片。
 */
const TERM_MAX_LINES = 1200;

/** 解析一条 ESC 开头的序列；返回 {len, kind, params, final} 或 null（还没收齐）。 */
function parseEscape(rest) {
  if (rest.length < 2) return null;
  const head = rest[1];
  if (head === '[') {
    // CSI：参数字节 0x30–0x3F，中间字节 0x20–0x2F，终结字节 0x40–0x7E
    let i = 2;
    while (i < rest.length) {
      const c = rest.charCodeAt(i);
      if (c >= 0x40 && c <= 0x7e) {
        return { len: i + 1, kind: 'csi', params: rest.slice(2, i), final: rest[i] };
      }
      i += 1;
    }
    return null;
  }
  if (head === ']') {
    // OSC：以 BEL 或 ESC \ (ST) 结束；内容一律忽略（标题 / 超链接 / 调色板）
    for (let i = 2; i < rest.length; i += 1) {
      if (rest[i] === '\x07') return { len: i + 1, kind: 'ignore' };
      if (rest[i] === '\x1b' && rest[i + 1] === '\\') return { len: i + 2, kind: 'ignore' };
    }
    return null;
  }
  // ESC 后跟单字符（ESC 7/8 保存恢复光标、ESC = 小键盘等）：忽略
  return { len: 2, kind: 'ignore' };
}

class TermScreen {
  constructor(opts = {}) {
    this.maxLines = Number(opts.maxLines) > 0 ? Number(opts.maxLines) : TERM_MAX_LINES;
    this.reset();
  }

  reset() {
    this.lines = [''];
    this.row = 0;
    this.col = 0;
    this._pending = '';
    this._saved = null;
    return this;
  }

  _line(row) {
    while (this.lines.length <= row) this.lines.push('');
    return this.lines[row];
  }

  _setLine(row, chars) {
    while (this.lines.length <= row) this.lines.push('');
    this.lines[row] = chars.join('');
  }

  _put(ch) {
    const chars = Array.from(this._line(this.row));
    while (chars.length < this.col) chars.push(' ');
    chars[this.col] = ch;
    this._setLine(this.row, chars);
    this.col += 1;
  }

  _eraseLine(mode) {
    const chars = Array.from(this._line(this.row));
    if (mode === 2) {
      this._setLine(this.row, []);
    } else if (mode === 1) {
      for (let i = 0; i <= this.col && i < chars.length; i += 1) chars[i] = ' ';
      this._setLine(this.row, chars);
    } else {
      this._setLine(this.row, chars.slice(0, this.col));
    }
  }

  _eraseDisplay(mode) {
    if (mode === 2 || mode === 3) {
      this.lines = [''];
      this.row = 0;
      this.col = 0;
      return;
    }
    this._eraseLine(0);
    if (mode === 0) this.lines.length = this.row + 1;
  }

  _trim() {
    if (this.lines.length <= this.maxLines) return;
    const drop = this.lines.length - this.maxLines;
    this.lines.splice(0, drop);
    this.row = Math.max(0, this.row - drop);
  }

  _csi(params, final) {
    const raw = params.replace(/^\?/, '');
    const nums = raw.split(';').map((x) => (x === '' ? 0 : parseInt(x, 10) || 0));
    const n = Math.max(1, nums[0] || 1);
    switch (final) {
      case 'm':      // SGR 颜色 / 粗体：纯文本模式忽略
      case 'h': case 'l':  // ?25l/h 光标显隐、括号粘贴模式等
      case 'r': case 's': case 'u':
        if (final === 's') this._saved = { row: this.row, col: this.col };
        if (final === 'u' && this._saved) { this.row = this._saved.row; this.col = this._saved.col; }
        return;
      case 'A': this.row = Math.max(0, this.row - n); return;
      case 'B': this.row += n; this._line(this.row); return;
      case 'C': this.col += n; return;
      case 'D': this.col = Math.max(0, this.col - n); return;
      case 'E': this.row += n; this.col = 0; this._line(this.row); return;
      case 'F': this.row = Math.max(0, this.row - n); this.col = 0; return;
      case 'G': this.col = Math.max(0, n - 1); return;
      case 'H': case 'f':
        this.row = Math.max(0, (nums[0] || 1) - 1);
        this.col = Math.max(0, (nums[1] || 1) - 1);
        this._line(this.row);
        return;
      case 'K': this._eraseLine(nums[0] || 0); return;
      case 'J': this._eraseDisplay(nums[0] || 0); return;
      case 'P': case 'X': {
        const chars = Array.from(this._line(this.row));
        if (final === 'P') chars.splice(this.col, n);
        else for (let i = this.col; i < this.col + n && i < chars.length; i += 1) chars[i] = ' ';
        this._setLine(this.row, chars);
        return;
      }
      case '@': {
        const chars = Array.from(this._line(this.row));
        for (let i = 0; i < n; i += 1) chars.splice(this.col, 0, ' ');
        this._setLine(this.row, chars);
        return;
      }
      default: return;
    }
  }

  _plain(ch) {
    if (ch === '\r') { this.col = 0; return; }
    if (ch === '\n') { this.row += 1; this._line(this.row); return; }
    if (ch === '\b') { this.col = Math.max(0, this.col - 1); return; }
    if (ch === '\t') { this.col = (Math.floor(this.col / 8) + 1) * 8; return; }
    const code = ch.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) return;   // BEL / 其它 C0 控制符
    this._put(ch);
  }

  /** 吃一片输出，返回当前整屏纯文本（renderer 直接赋给 textContent）。 */
  push(chunk) {
    const s = this._pending + String(chunk == null ? '' : chunk);
    this._pending = '';
    let i = 0;
    while (i < s.length) {
      if (s[i] === '\x1b') {
        const rest = s.slice(i);
        const seq = parseEscape(rest);
        if (!seq) { this._pending = rest; break; }
        if (seq.kind === 'csi') this._csi(seq.params, seq.final);
        i += seq.len;
        continue;
      }
      // 代理对（emoji / 部分 CJK 扩展字）当一个字符写，避免拆成两个豆腐块
      const code = s.charCodeAt(i);
      const wide = code >= 0xd800 && code <= 0xdbff && i + 1 < s.length
        && s.charCodeAt(i + 1) >= 0xdc00 && s.charCodeAt(i + 1) <= 0xdfff;
      this._plain(wide ? s.slice(i, i + 2) : s[i]);
      i += wide ? 2 : 1;
    }
    this._trim();
    return this.text();
  }

  text() {
    return this.lines.join('\n');
  }
}

if (typeof module !== 'undefined' && module.exports) module.exports = { TermScreen, parseEscape };
if (typeof window !== 'undefined') window.TermScreen = TermScreen;
