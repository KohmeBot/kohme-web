// api.js — 后端接口封装。401 时派发 'kohme:unauthorized' 事件，由 auth 模块接管，
// 避免 api 直接依赖 UI（解耦，无循环依赖）。

function unauthorized() {
  window.dispatchEvent(new CustomEvent('kohme:unauthorized'));
}

// api(method, path, body?) — 统一 JSON 接口；自动带 cookie。
export async function api(method, path, body) {
  const opt = { method, credentials: 'include', headers: {} };
  if (body !== undefined) {
    opt.headers['Content-Type'] = 'application/json';
    opt.body = JSON.stringify(body);
  }
  const r = await fetch(path, opt);
  if (r.status === 401) { unauthorized(); throw new Error('未授权'); }
  if (!r.ok) throw new Error((await r.text()).trim() || ('HTTP ' + r.status));
  const ct = r.headers.get('content-type') || '';
  return ct.includes('json') ? r.json() : r.text();
}

// rawPost — 用于登录/设置等无需在 401 时跳登录的端点。
export async function rawPost(path, body) {
  const r = await fetch(path, {
    method: 'POST', credentials: 'include',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error((await r.text()).trim() || ('HTTP ' + r.status));
  return r.json().catch(() => ({}));
}

// ---- 字段解析（与原后端约定一致）----
export function parseGroups(s) {
  return (s || '').split(/[,\s]+/).map(x => x.trim()).filter(Boolean)
    .map(Number).filter(n => !isNaN(n));
}
export function parseStrList(s) {
  return (s || '').split(/[,\n]/).map(x => x.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
}
