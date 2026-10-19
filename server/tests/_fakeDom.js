'use strict';
// Minimal fake DOM used by the UI smoke tests (no browser needed).
class Node_ { constructor(t) { this.tag = t; this.children = []; this.attrs = {}; this.listeners = {}; this.className = ''; this._text = ''; this.parent = null; this.style = {}; this.value = ''; this.disabled = false; this.classList = { toggle: (c, on) => { const s = new Set(this.className.split(/\s+/).filter(Boolean)); (on ? s.add(c) : s.delete(c)); this.className = [...s].join(' '); } }; }
  get id() { return this.attrs.id; } get isText() { return this.tag === '#text'; }
  setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'class') this.className = String(v); } getAttribute(k) { return this.attrs[k] == null ? null : this.attrs[k]; }
  appendChild(c) { c.parent = this; this.children.push(c); return c; } append(...cs) { cs.flat(Infinity).forEach(c => this.appendChild(typeof c === 'object' ? c : mkText(String(c)))); }
  prepend(c) { c.parent = this; this.children.unshift(c); } remove() { if (this.parent) this.parent.children = this.parent.children.filter(x => x !== this); }
  replaceChildren(...cs) { this.children = []; cs.forEach(c => this.appendChild(c)); } addEventListener(e, f) { (this.listeners[e] = this.listeners[e] || []).push(f); }
  set textContent(v) { this.children = [mkText(String(v))]; } get textContent() { return this.isText ? this._text : this.children.map(c => c.textContent).join(''); }
  matches(sel) { const m = /^([a-z0-9]*)(?:#([\w-]+))?(?:\.([\w-]+))?(?:\[name="?([\w-]+)"?\])?$/i.exec(sel.trim()); if (!m) return false; const [, t, id, cls, nm] = m;
    if (t && this.tag !== t) return false; if (id && this.attrs.id !== id) return false; if (cls && !this.className.split(/\s+/).includes(cls)) return false; if (nm && this.attrs.name !== nm) return false; return true; }
  walk(fn) { for (const c of this.children) { if (c.isText) continue; fn(c); c.walk(fn); } }
  querySelectorAll(sel) { const out = []; const parts = sel.split(',').map(s => s.trim()); this.walk(n => { for (const p of parts) { const segs = p.split(/\s+/), last = segs[segs.length - 1]; if (!n.matches(last)) continue;
    if (segs.length > 1) { let a = n.parent, ok = false; while (a) { if (a.matches && !a.isText && a.matches(segs[0])) { ok = true; break; } a = a.parent; } if (!ok) continue; } out.push(n); break; } }); return out; }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  setAttributeNS() {} get dataset() { return {}; }
}
function mkText(s) { const n = new Node_('#text'); n._text = s; return n; }

module.exports = { Node_, mkText };
