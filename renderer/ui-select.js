'use strict';
/**
 * ui-select.js — 全应用自绘下拉框（替代 macOS 原生 <select> 弹层）
 *
 * 为什么自己写：原生 <select> 在 macOS 上展开的是系统级弹出菜单，样式、
 * 圆角、行高、深浅主题都与本应用的暖纸 / 暖炭设计系统无关，而且没法在
 * 里面放分组标题、选中态、说明文字。这里用一个自定义元素提供同一套交互，
 * 表单侧仍保持 `.value` / `change` / `onchange` / `focus()` / `blur()` 语义，
 * 调用方几乎不用改。
 *
 * 安全：候选文本一律走 textContent（来源可能是 CLI 返回值），面板挂在
 * document.body 用 fixed 定位，避免被 overflow:hidden 的弹窗 / 侧栏裁掉；
 * 全局只用一个共享面板，任意时刻最多一个下拉处于打开态。
 */
(function () {
  const POP_ID = 'ui-select-pop';
  const MAX_POP_H = 272;

  let pop = null;
  let owner = null;         // 当前打开的 HermesSelect
  let docHooked = false;

  function ensurePop() {
    if (pop && pop.isConnected) return pop;
    pop = document.createElement('div');
    pop.id = POP_ID;
    pop.className = 'us-pop';
    pop.setAttribute('role', 'listbox');
    pop.hidden = true;
    document.body.appendChild(pop);
    if (!docHooked) {
      docHooked = true;
      // 捕获阶段：点到其它控件时先收起，再去处理那次点击
      document.addEventListener('pointerdown', (event) => {
        if (!owner) return;
        if (pop && pop.contains(event.target)) return;
        const t = event.target;
        if (t && t.closest && t.closest('hm-select') === owner) return;
        owner.close();
      }, true);
      window.addEventListener('resize', () => { if (owner) owner.close(); });
      // 祖先滚动会让 fixed 面板错位：重新贴一次。面板自己的滚动（键盘
      // scrollIntoView 触发）必须忽略，否则一按方向键下拉就自己关掉。
      window.addEventListener('scroll', (event) => {
        if (!owner || !pop || event.target === pop) return;
        place(pop, owner._trigger);
      }, true);
    }
    return pop;
  }

  /** 把静态 <option> / <optgroup> 解析成候选；保留分组标题（不可选）。 */
  function parseStatic(root) {
    const out = [];
    for (const node of Array.from(root.children)) {
      if (node.tagName === 'OPTGROUP') {
        out.push({ group: node.getAttribute('label') || '' });
        for (const o of Array.from(node.children)) {
          if (o.tagName === 'OPTION') {
            out.push({ value: o.getAttribute('value') || '', label: (o.textContent || '').trim() });
          }
        }
      } else if (node.tagName === 'OPTION') {
        out.push({ value: node.getAttribute('value') || '', label: (node.textContent || '').trim() });
      }
    }
    return out;
  }

  function place(p, trigger) {
    const r = trigger.getBoundingClientRect();
    const w = Math.max(r.width, 148);
    p.style.minWidth = Math.round(w) + 'px';
    p.style.left = Math.round(Math.max(4, Math.min(r.left, window.innerWidth - w - 4))) + 'px';
    const h = Math.min(p.scrollHeight || 0, MAX_POP_H);
    const below = window.innerHeight - r.bottom - 6;
    const above = r.top - 6;
    p.style.top = Math.round(below >= h || below >= above ? r.bottom + 4 : Math.max(4, r.top - h - 4)) + 'px';
    p.style.maxHeight = MAX_POP_H + 'px';
  }

  class HermesSelect extends HTMLElement {
    static get observedAttributes() { return ['disabled']; }

    constructor() {
      super();
      this._items = [];
      this._value = '';
      this._active = -1;
      this._typed = '';
      this._typedAt = 0;
      this._built = false;
    }

    connectedCallback() {
      if (this._built) return;
      this._built = true;
      // 动态创建的下拉可能在连接前就调过 setOptions()，此时不要再拿空壳的
      // 静态 <option> 覆盖掉调用方给的候选。
      if (!this._items.length) this._items = parseStatic(this);
      const initial = this.getAttribute('value');
      this._value = initial != null ? initial : (this._items.find((i) => !i.group)?.value ?? '');
      this._defaultValue = this._value;
      this.innerHTML = '';
      this.classList.add('ui-select');

      this._trigger = document.createElement('button');
      this._trigger.type = 'button';
      this._trigger.className = 'us-trigger';
      this._trigger.setAttribute('role', 'combobox');
      this._trigger.setAttribute('aria-haspopup', 'listbox');
      this._trigger.setAttribute('aria-expanded', 'false');
      if (this.getAttribute('aria-label')) this._trigger.setAttribute('aria-label', this.getAttribute('aria-label'));

      this._label = document.createElement('span');
      this._label.className = 'us-value';
      this._caret = document.createElement('span');
      this._caret.className = 'us-caret';
      this._caret.setAttribute('aria-hidden', 'true');
      this._caret.textContent = '⌄';
      this._trigger.append(this._label, this._caret);
      this.appendChild(this._trigger);

      this._trigger.addEventListener('click', () => (owner === this ? this.close() : this.open()));
      this._trigger.addEventListener('keydown', (e) => this._onKey(e));
      this._render();
    }

    attributeChangedCallback(name) {
      if (name === 'disabled' && this._trigger) {
        this._trigger.disabled = this.hasAttribute('disabled');
        if (this.hasAttribute('disabled') && owner === this) this.close();
      }
    }

    get value() { return this._value; }
    set value(v) {
      const s = String(v == null ? '' : v);
      if (s === this._value) return;
      this._value = s;
      this._render();
    }
    get disabled() { return this.hasAttribute('disabled'); }
    set disabled(on) { if (on) this.setAttribute('disabled', ''); else this.removeAttribute('disabled'); }

    /** 动态候选：items = [{value,label,group?,action?}] 或字符串数组；placeholder 生成空值项。
     *  action:true 的行是「动作」而不是取值（如「＋ 新建项目…」）：选中它不改变 value，
     *  只派发 select-action 事件，调用方自己接。 */
    setOptions(items, placeholder) {
      const ph = placeholder != null ? placeholder : (this.getAttribute('placeholder') || '');
      const list = (Array.isArray(items) ? items : []).map((x) => (typeof x === 'string'
        ? { value: x, label: x }
        : { value: String(x.value == null ? '' : x.value), label: String(x.label == null ? x.value : x.label),
          group: x.group || '', action: x.action === true }));
      this._items = (ph ? [{ value: '', label: ph }] : []).concat(list);
      if (!this._items.some((i) => !i.group && !i.action && i.value === this._value)) this._value = '';
      this._render();
      if (owner === this) this.open();
    }

    focus() { if (this._trigger) this._trigger.focus(); }
    blur() { if (owner === this) this.close(); if (this._trigger) this._trigger.blur(); }
    /** 自定义元素不参与 HTMLFormElement.reset()，弹窗每次打开时显式调用。 */
    reset() { if (owner === this) this.close(); this._value = this._defaultValue || ''; this._render(); }

    _labelFor() {
      const hit = this._items.find((i) => !i.group && !i.action && i.value === this._value);
      if (hit) return hit.label;
      if (this._value) return this._value;       // 自由值（受让人允许手填）
      const first = this._items.find((i) => !i.group && !i.action);
      return first ? first.label : '';
    }

    _render() {
      if (!this._trigger) return;
      this._label.textContent = this._labelFor();
      this._label.classList.toggle('is-placeholder', !this._value);
      this._trigger.setAttribute('aria-expanded', owner === this ? 'true' : 'false');
      if (this._trigger.disabled !== this.hasAttribute('disabled')) {
        this._trigger.disabled = this.hasAttribute('disabled');
      }
    }

    open() {
      if (!this._trigger || this.hasAttribute('disabled')) return;
      const p = ensurePop();
      if (owner && owner !== this) owner.close();
      owner = this;
      p.replaceChildren();
      const opts = this._items.filter((i) => !i.group);
      this._optItems = opts;
      this._active = Math.max(0, opts.findIndex((i) => i.value === this._value));
      const byValue = new Map();
      for (const it of this._items) {
        const row = document.createElement('div');
        if (it.group) {
          row.className = 'us-group';
          row.setAttribute('role', 'presentation');
          row.textContent = it.group || '';
        } else if (it.action) {
          // 动作行：不进 _value，也不显示勾选；视觉上跟候选分开一条线
          row.className = 'us-opt is-action';
          row.setAttribute('role', 'option');
          row.setAttribute('aria-selected', 'false');
          row.dataset.value = it.value;
          row.dataset.action = '1';
          const txt = document.createElement('span');
          txt.className = 'us-opt-label';
          txt.textContent = it.label;
          row.append(txt);
          row.addEventListener('pointerdown', (e) => e.preventDefault());
          row.addEventListener('click', () => this._pick(it));
          byValue.set(it.value, row);
        } else {
          row.className = 'us-opt';
          row.setAttribute('role', 'option');
          row.setAttribute('aria-selected', it.value === this._value ? 'true' : 'false');
          row.dataset.value = it.value;
          const txt = document.createElement('span');
          txt.className = 'us-opt-label';
          txt.textContent = it.label;
          const mark = document.createElement('span');
          mark.className = 'us-check';
          mark.setAttribute('aria-hidden', 'true');
          mark.textContent = '✓';
          row.append(txt, mark);
          row.addEventListener('pointerdown', (e) => e.preventDefault());
          row.addEventListener('click', () => this._pick(it));
          byValue.set(it.value, row);
        }
        p.appendChild(row);
      }
      this._optRows = Array.from(p.querySelectorAll('.us-opt'));
      p.hidden = false;
      this._trigger.classList.add('is-open');
      place(p, this._trigger);
      this._highlight();
      this._render();
    }

    close() {
      if (owner === this) owner = null;
      if (pop) pop.hidden = true;
      if (this._trigger) {
        this._trigger.classList.remove('is-open');
        this._trigger.setAttribute('aria-expanded', 'false');
      }
      this._active = -1;
    }

    _highlight() {
      if (!this._optRows) return;
      this._optRows.forEach((r, i) => {
        r.classList.toggle('is-active', i === this._active);
        if (i === this._active) r.scrollIntoView({ block: 'nearest' });
      });
    }

    _move(delta) {
      if (!this._optRows || !this._optRows.length) return;
      this._active = (this._active + delta + this._optRows.length) % this._optRows.length;
      this._highlight();
    }

    _pick(item) {
      const prev = this._value;
      this.close();
      // 动作行：只派发事件，绝不改 value —— 否则「新建项目」会被记成当前项目
      if (item && item.action) {
        if (this._trigger) this._trigger.focus();
        this.dispatchEvent(new CustomEvent('select-action', {
          bubbles: true, detail: { value: String(item.value == null ? '' : item.value) },
        }));
        return;
      }
      this._value = String(item.value == null ? '' : item.value);
      this._render();
      if (this._trigger) this._trigger.focus();
      if (prev !== this._value) {
        // 表单侧既有 onchange 也有 addEventListener('input'/'change')
        this.dispatchEvent(new Event('input', { bubbles: true }));
        this.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }

    _typeahead(ch) {
      const now = Date.now();
      this._typed = now - this._typedAt > 650 ? ch : this._typed + ch;
      this._typedAt = now;
      const q = this._typed.toLowerCase();
      const i = this._items.filter((x) => !x.group).findIndex((x) => x.label.toLowerCase().startsWith(q));
      if (i >= 0) { this._active = i; this._highlight(); }
    }

    _onKey(e) {
      if (this.hasAttribute('disabled')) return;
      const open = owner === this;
      switch (e.key) {
        case 'ArrowDown':
        case 'ArrowUp':
          e.preventDefault(); e.stopPropagation();
          if (!open) this.open(); else this._move(e.key === 'ArrowDown' ? 1 : -1);
          return;
        case 'Enter':
        case ' ':
          e.preventDefault(); e.stopPropagation();
          if (!open) this.open();
          else if (this._optItems && this._optItems[this._active]) this._pick(this._optItems[this._active]);
          return;
        case 'Home':
        case 'End':
          if (open) { e.preventDefault(); e.stopPropagation(); this._active = e.key === 'Home' ? 0 : this._optRows.length - 1; this._highlight(); }
          return;
        case 'Escape':
          // 开着时 Esc 只收起下拉；关闭态不拦截，交给表单 / 面板的
          // guardFieldKey 处理（否则 Esc 关不掉设置页 / 派发控制台）。
          if (open) { e.preventDefault(); e.stopPropagation(); this.close(); }
          return;
        case 'Tab':
          if (open) this.close();
          return;
        default:
          break;
      }
      if (open && e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault(); e.stopPropagation(); this._typeahead(e.key);
      }
    }
  }

  if (!customElements.get('hm-select')) customElements.define('hm-select', HermesSelect);
})();
