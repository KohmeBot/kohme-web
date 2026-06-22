// readme.js — 拉取并渲染插件 README（简介）。
//
// 后端约定（需后端配合提供，前端按此调用；缺失时静默降级为「无简介」）：
//   GET /api/plugins/{name}/doc/README.md
//        → 返回 kohme 仓库根目录 ./.docs/docs/{name}/README.md 的原文（text/markdown 或 text/plain）。
//          不存在时返回 404。
//   GET /api/plugins/{name}/doc/<相对路径>
//        → 返回 ./.docs/docs/{name}/ 目录下的静态资源（图片等，通常在其 docs/ 子目录）。
//
// README 里的相对图片/链接（如 docs/diagram.png、./docs/x.png）会基于
// README 的 URL 解析，自然落到 /api/plugins/{name}/doc/docs/... 上。
// 端点前缀集中在 DOC_BASE 一处，便于后端按实际路由调整。

import { el } from './dom.js';
import { renderMarkdown } from './markdown.js';

const DOC_BASE = (name) => '/api/plugins/' + encodeURIComponent(name) + '/doc/';
const README_URL = (name) => DOC_BASE(name) + 'README.md';

const cache = {};   // name -> { state:'ok'|'none'|'err', html?, msg? }

// 把 README 里的相对地址重写到后端静态资源 URL；绝对地址 / 锚点保持不变。
function resolverFor(name) {
  let base;
  try { base = new URL(README_URL(name), location.origin); }
  catch (e) { base = null; }
  return (src) => {
    if (!src) return src;
    if (/^(https?:|mailto:|tel:|data:|#)/i.test(src)) return src;
    if (!base) return src;
    try { return new URL(src, base).pathname + (new URL(src, base).search || ''); }
    catch (e) { return src; }
  };
}

export function clearReadmeCache(name) {
  if (name) delete cache[name];
  else for (const k in cache) delete cache[k];
}

export async function loadReadme(name) {
  if (cache[name]) return cache[name];
  try {
    const r = await fetch(README_URL(name), { credentials: 'include' });
    if (r.status === 401) {
      window.dispatchEvent(new CustomEvent('kohme:unauthorized'));
      return (cache[name] = { state: 'err', msg: '未授权' });
    }
    if (r.status === 404) return (cache[name] = { state: 'none' });
    if (!r.ok) return (cache[name] = { state: 'err', msg: 'HTTP ' + r.status });
    const ct = (r.headers.get('content-type') || '').toLowerCase();
    const body = await r.text();
    // 路由兜底：未实现该端点时可能回落到 SPA 的 index.html，按「无简介」处理，避免渲染垃圾。
    if (ct.includes('html') || /^\s*<!doctype html/i.test(body)) return (cache[name] = { state: 'none' });
    if (!body.trim()) return (cache[name] = { state: 'none' });
    const html = renderMarkdown(body, { resolveUrl: resolverFor(name) });
    return (cache[name] = { state: 'ok', html });
  } catch (e) {
    return (cache[name] = { state: 'err', msg: (e && e.message) || '加载失败' });
  }
}

// 渲染到指定容器，返回最终状态（'ok' | 'none' | 'err'），供调用方决定是否隐藏「简介」页签。
export async function renderReadmeInto(pane, name) {
  pane.textContent = '';
  pane.appendChild(el('div', { class: 'readme-state', text: '加载简介…' }));
  const res = await loadReadme(name);
  pane.textContent = '';
  if (res.state === 'ok') {
    const box = el('div', { class: 'readme markdown-body' });
    box.innerHTML = res.html;   // 安全：markdown.js 已转义正文、仅输出受控标签
    pane.appendChild(box);
  } else if (res.state === 'none') {
    pane.appendChild(el('div', { class: 'readme-state empty',
      text: '该插件未提供简介（README.md）。' }));
  } else {
    pane.appendChild(el('div', { class: 'readme-state empty',
      text: '简介加载失败：' + (res.msg || '请稍后重试') }));
  }
  return res.state;
}
