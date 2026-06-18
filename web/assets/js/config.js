// config.js — 插件全局配置、驱动配置（config.json · ZeroBot）的读写，
// 以及 load()（拉取 /api/config 并交给 plugins 渲染）、loadSchemas()。
// 全局配置与驱动配置都改为 schema 驱动：分别用 /api/schemas 里的保留键
// kohme-plugin-global、kohme-zerobot 渲染表单，后端未提供时回退到 schema-defaults。
//
// 保存语义（④）：改配置只需重启，不必重新构建——全局/驱动保存一律带 ?rebuild=false，
// 后端据此只重启 bot、不重新编译。

import { $, flash } from './dom.js';
import { api } from './api.js';
import { runOp } from './ops.js';
import { buildForm } from './schema-form.js';
import { GLOBAL_SCHEMA, ZEROBOT_SCHEMA } from './schema-defaults.js';
import * as Plugins from './plugins.js';

let schemas = {};
let globalGetter = null;   // 当前全局配置表单的取值函数
let driverGetter = null;   // 当前驱动表单的取值函数

export async function loadSchemas() {
  try { schemas = await api('GET', '/api/schemas') || {}; }
  catch (e) { schemas = {}; }
  return schemas;
}
export function currentSchemas() { return schemas; }

export async function load() {
  const c = await api('GET', '/api/config');
  try { await loadGlobal(); } catch (e) { /* 兜底用空值渲染 */ }
  try { await loadDriver(); } catch (e) { /* config.json 可缺省 */ }
  Plugins.render(c.plugins || [], schemas);
}

// ---- 插件全局配置（schema 驱动）----
function globalSchema() { return schemas['kohme-plugin-global'] || GLOBAL_SCHEMA; }

export async function loadGlobal() {
  let value = {};
  try { value = await api('GET', '/api/global') || {}; }
  catch (e) { value = {}; }
  const host = $('#globalForm');
  host.textContent = '';
  const form = buildForm(globalSchema(), value);
  host.appendChild(form.el);
  globalGetter = form.getValue;
}

export async function saveGlobal(btn) {
  if (!globalGetter) return;
  btn.disabled = true;
  const ok = await runOp('保存全局配置并重启', () =>
    api('PUT', '/api/global?rebuild=false', globalGetter()));
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
  const ok = await runOp('保存驱动配置并重启', () =>
    api('PUT', '/api/driver?rebuild=false', driverGetter()));
  if (ok) flash(btn.parentNode.querySelector('.saved'));
  btn.disabled = false;
}
