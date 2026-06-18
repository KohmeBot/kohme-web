// plugins.js — 插件区控制器。
// 所有增删改都在前端“暂存”为卡片状态，最后点「保存并构建」一次性提交（PUT /api/plugins），
// 由后端统一构建并重启。新插件只显示公共配置（其 conf schema 要构建后才存在）。
//
// 依赖通过 bind() 注入 load / loadSchemas，避免与 config 模块循环依赖。

import { $, el, toast } from './dom.js';
import { api } from './api.js';
import { runOp } from './ops.js';
import { buildForm } from './schema-form.js';
import { PLUGIN_COMMON_SCHEMA } from './schema-defaults.js';

let schemas = {};
let committedJSON = '[]';   // 每次 render 后的基线快照，用于 like-for-like 脏检测
let deps = { load: async () => {}, loadSchemas: async () => {} };

export function bind(d) { deps = { ...deps, ...d }; }

// ---- 单个插件卡片 ----
function pluginCard(p, opts = {}) {
  const isNew = !!opts.isNew;
  const builtin = p.name === 'core';
  const schema = isNew ? null : (schemas || {})[p.name];
  const showConf = !isNew;   // 新插件构建前仅公共配置

  const card = el('div', { class: 'card' + (isNew ? ' isnew' : '') + ' card--enter' });
  card._isNew = isNew;
  card._deleted = false;

  // 顶部：名称 + 状态标签
  const top = el('div', { class: 'top' }, [
    el('span', { class: 'name', text: p.name }),
    el('span', { class: 'tag' + (p.disable ? ' off' : ' ok'), text: p.disable ? '功能已禁用' : '已启用' }),
  ]);
  if (p.exclude) top.appendChild(el('span', { class: 'tag off', text: '不编译' }));
  if (builtin)   top.appendChild(el('span', { class: 'tag off', text: '内置' }));
  if (isNew)     top.appendChild(el('span', { class: 'tag new', text: '新增 · 未保存' }));
  const delTag = el('span', { class: 'tag del-tag', style: 'display:none', text: '待删除 · 保存后生效' });
  top.appendChild(delTag);
  card.appendChild(top);

  // 公共字段（schema 驱动：kohme-plugin，后端未提供时回退默认 schema）。
  // 把整个 p 作为取值传入，buildForm 只渲染/读取 schema 声明的属性，多余字段忽略。
  const commonSchema = (schemas && schemas['kohme-plugin']) || PLUGIN_COMMON_SCHEMA;
  const commonForm = buildForm(commonSchema, p);
  card.appendChild(commonForm.el);

  // 自定义配置 conf
  let confGetter = null;
  if (showConf) {
    if (schema) {
      const f = buildForm(schema, p.confValue || {});
      const det = el('details', { open: '' }, [el('summary', { text: '插件配置 conf（表单）' })]);
      const box = el('div', { style: 'margin-top:8px' }); box.appendChild(f.el);
      det.appendChild(box);
      card.appendChild(det);
      confGetter = f.getValue;
    } else {
      const ta = el('textarea', { spellcheck: 'false', style: 'margin-top:8px' });
      const det = el('details', {}, [el('summary', { text: '插件配置 conf（YAML）' }), ta]);
      card.appendChild(det);
      card._confTextarea = ta;
    }
  } else {
    card.appendChild(el('div', { class: 'hint',
      text: '新插件的自定义配置 conf 需在保存构建、bot 生成 schema 之后才能编辑；此处仅设置公共配置。' }));
  }

  // 行内操作：删除 / 撤销删除
  const actions = el('div', { class: 'row-actions' });
  let delBtn = null, undelBtn = null;
  if (!builtin) {
    delBtn   = el('button', { class: 'btn btn--danger btn--sm', text: '删除' });
    undelBtn = el('button', { class: 'btn btn--ghost btn--sm', style: 'display:none', text: '撤销删除' });
    actions.append(delBtn, undelBtn);
  }
  card.appendChild(actions);

  // 收集当前卡片为 DTO（与 /api/config 返回、PUT /api/plugins 期望的结构一致）
  card._getDTO = function () {
    const common = commonForm.getValue();
    delete common.name;                 // name 是身份，不受公共表单影响
    const dto = { name: p.name, ...common };
    if (showConf) {
      if (confGetter) dto.confValue = confGetter();
      else if (card._confTextarea) dto.confYaml = card._confTextarea.value;
    }
    return dto;
  };

  // 任意字段改动都重新评估脏状态
  card.addEventListener('input', refreshDirty);
  card.addEventListener('change', refreshDirty);

  if (delBtn) delBtn.onclick = () => {
    if (isNew) { card.remove(); refreshDirty(); return; }   // 从未保存 → 直接丢弃
    card._deleted = true;
    card.classList.add('pending-del');
    delTag.style.display = '';
    delBtn.style.display = 'none';
    undelBtn.style.display = '';
    card.querySelectorAll('input,textarea,select').forEach(x => x.disabled = true);
    refreshDirty();
  };
  if (undelBtn) undelBtn.onclick = () => {
    card._deleted = false;
    card.classList.remove('pending-del');
    delTag.style.display = 'none';
    delBtn.style.display = '';
    undelBtn.style.display = 'none';
    card.querySelectorAll('input,textarea,select').forEach(x => x.disabled = false);
    refreshDirty();
  };

  return card;
}

// ---- 暂存收集 / diff / 脏状态 ----
function collectWork() {
  const out = [];
  $('#plugins').querySelectorAll('.card').forEach(card => {
    if (card._deleted) return;
    out.push(card._getDTO());
  });
  return out;
}

function pluginDiff() {
  let committed = [];
  try { committed = JSON.parse(committedJSON); } catch (e) {}
  const byName = {};
  committed.forEach(p => { byName[p.name] = JSON.stringify(p); });
  let added = 0, modified = 0, removed = 0;
  $('#plugins').querySelectorAll('.card').forEach(card => {
    const dto = card._getDTO();
    if (card._deleted) { if (dto.name in byName) removed++; return; }
    if (!(dto.name in byName)) added++;
    else if (JSON.stringify(dto) !== byName[dto.name]) modified++;
  });
  return { added, modified, removed, total: added + modified + removed };
}
export function diffTotal() { return pluginDiff().total; }

function refreshDirty() {
  const d = pluginDiff();
  const bar = $('#pluginDirty');
  if (d.total > 0) {
    $('#pluginDirtyText').textContent =
      `有未保存的插件更改：新增 ${d.added}，修改 ${d.modified}，删除 ${d.removed}。保存后将统一构建并重启。`;
    bar.classList.add('show');
  } else {
    bar.classList.remove('show');
  }
}

// ---- 渲染（由 config.load 调用）----
export function render(plugins, sch) {
  schemas = sch || {};
  const list = $('#plugins');
  list.innerHTML = '';
  (plugins || []).slice()
    .sort((a, b) => (a.seq - b.seq) || a.name.localeCompare(b.name))
    .forEach(p => list.appendChild(pluginCard(p, {})));
  committedJSON = JSON.stringify(collectWork());   // 基线快照
  refreshDirty();
}

// ---- 保存 / 放弃 / 添加 ----
export async function save(btn) {
  if (btn) btn.disabled = true;
  const ok = await runOp('保存插件更改并构建', () =>
    api('PUT', '/api/plugins', { plugins: collectWork() }));
  if (btn) btn.disabled = false;
  if (ok) {
    // 成功：拉取（可能因重启新生成的）schema 并以已提交状态重渲染。
    await deps.loadSchemas();
    await deps.load();
    toast('插件已保存并重新构建', 'ok');
  }
  // 失败：后端已回滚 plugins.yaml，弹窗已显示构建错误。
  // 这里特意不重载，保留暂存更改，便于修正后重试。
}

export function discard() {
  if (pluginDiff().total > 0 && !confirm('放弃所有未保存的插件更改？')) return;
  deps.load();
}

// 暂存一个新插件（不调后端、不构建）。重复名给出提示。返回是否成功。
export function add({ name, repo, version }) {
  if (!name) { toast('请填写插件名', 'err'); return false; }
  let dup = false;
  $('#plugins').querySelectorAll('.card').forEach(card => {
    if (!card._deleted && card._getDTO().name === name) dup = true;
  });
  if (dup) { toast(`插件 ${name} 已在列表中`, 'err'); return false; }
  const p = { name, repo: repo || '', version: version || 'latest',
    seq: 0, groups: [], disable: false, exclude: false };
  const card = pluginCard(p, { isNew: true });
  $('#plugins').appendChild(card);
  refreshDirty();
  card.scrollIntoView({ behavior: 'smooth', block: 'center' });
  return true;
}
