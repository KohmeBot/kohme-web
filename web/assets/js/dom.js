// dom.js — 通用 DOM 小工具与轻量通知（toast）。无依赖。

export const $  = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

// el('div', {class:'x', onclick:fn}, [child, 'text']) → HTMLElement
export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c == null) continue;
    node.append(c.nodeType ? c : document.createTextNode(c));
  }
  return node;
}

// 行内“已保存”反馈
export function flash(node) {
  if (!node) return;
  node.classList.add('show');
  setTimeout(() => node.classList.remove('show'), 1600);
}

// ---- toast ----
let toastHost = null;
function host() {
  if (!toastHost) {
    toastHost = el('div', { class: 'toasts', 'aria-live': 'polite' });
    document.body.appendChild(toastHost);
  }
  return toastHost;
}

// toast(message, kind?) — kind: 'ok' | 'err' | ''（默认）
export function toast(message, kind = '', ms = 3200) {
  const t = el('div', { class: 'toast' + (kind ? ' ' + kind : ''), role: 'status', text: message });
  host().appendChild(t);
  const close = () => {
    t.classList.add('leaving');
    t.addEventListener('animationend', () => t.remove(), { once: true });
    setTimeout(() => t.remove(), 400);
  };
  setTimeout(close, ms);
  t.addEventListener('click', close);
  return t;
}
