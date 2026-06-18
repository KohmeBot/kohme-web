// config.js — 全局设置、驱动配置（config.json · ZeroBot）的读写，
// 以及 load()（拉取 /api/config 并交给 plugins 渲染）、loadSchemas()。
// 驱动配置改为 schema 驱动：用 /api/schemas 里的保留键 kohme-zerobot 渲染表单，
// 后端未提供时回退到 schema-defaults 里的默认 schema。

import { $, flash } from './dom.js';
import { api, parseGroups } from './api.js';
import { runOp } from './ops.js';
import { buildForm } from './schema-form.js';
import { ZEROBOT_SCHEMA } from './schema-defaults.js';
import * as Plugins from './plugins.js';

let schemas = {};
let driverGetter = null;   // 当前驱动表单的取值函数

export async function loadSchemas() {
  try { schemas = await api('GET', '/api/schemas') || {}; }
  catch (e) { schemas = {}; }
  return schemas;
}
export function currentSchemas() { return schemas; }

export async function load() {
  const c = await api('GET', '/api/config');
  $('#gPath').value = c.path || '';
  $('#gGroups').value = (c.groups || []).join(', ');
  try { await loadDriver(); } catch (e) { /* config.json 可缺省 */ }
  Plugins.render(c.plugins || [], schemas);
}

// ---- 全局设置 ----
export async function saveGlobal(btn) {
  btn.disabled = true;
  const ok = await runOp('保存全局设置并构建', () =>
    api('PUT', '/api/global', {
      path: $('#gPath').value.trim(),
      groups: parseGroups($('#gGroups').value),
    }));
  if (ok) flash(btn.parentNode.querySelector('.saved'));
  btn.disabled = false;
}

// ---- 驱动配置（schema 驱动）----
function driverSchema() { return schemas['kohme-zerobot'] || ZEROBOT_SCHEMA; }

export async function loadDriver() {
  let value = {};
  try { value = await api('GET', '/api/driver') || {}; }
  catch (e) { value = {}; /* config.json 可缺省 */ }
  const host = $('#driverForm');
  host.textContent = '';
  const form = buildForm(driverSchema(), value);
  host.appendChild(form.el);
  driverGetter = form.getValue;
}

export async function saveDriver(btn) {
  if (!driverGetter) return;
  btn.disabled = true;
  const ok = await runOp('保存驱动配置并构建', () =>
    api('PUT', '/api/driver', driverGetter()));
  if (ok) flash(btn.parentNode.querySelector('.saved'));
  btn.disabled = false;
}
