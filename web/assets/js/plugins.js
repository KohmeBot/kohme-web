// plugins.js — 插件区控制器（每个插件一个独立页面）。
//
// 视图结构（②）：左侧「插件」子导航列出全部插件（含「＋ 添加插件」入口），点击切换到
// 对应插件页；每个插件页有「简介 / 配置」两个页签——简介展示该插件的 README（见 readme.js），
// 配置即原来的表单卡片。任一时刻只显示选中的那一页，但所有插件页始终挂载在 DOM 中，
// 因此暂存收集 / diff / 保存逻辑与原瀑布流完全一致。
//
// 暂存语义：所有增删改都在前端「暂存」为页面状态，最后点「保存并…」一次性提交
// （PUT /api/plugins）。只有「新增 / 删除」插件才需要重新构建（rebuild=true）；仅修改配置
// （含改顺序 seq、改 conf）只需重启（rebuild=false）。
//
// 排序：桌面端可在左侧导航拖拽；移动端用插件页内的 ▲▼ 按钮上/下移。core 钉在最前、seq=0。
//
// 依赖通过 bind() 注入 load / loadSchemas，避免与 config 模块循环依赖。

import { $, $$, el, toast } from './dom.js';
import { api } from './api.js';
import { runOp } from './ops.js';
import { buildForm, resolveSchema } from './schema-form.js';
import { PLUGIN_COMMON_SCHEMA } from './schema-defaults.js';
import { renderReadmeInto, clearReadmeCache } from './readme.js';

let schemas = {};
let committedJSON = '[]';
let deps = { load: async () => {}, loadSchemas: async () => {} };
let dndReady = false;
let selected = null;   // 当前选中的插件名

export function bind(d) { deps = { ...deps, ...d }; }

const cssId = (s) => 'plugin-' + String(s).replace(/[^a-zA-Z0-9_-]/g, '_');
const corePage = () => $('#plugins').querySelector('.plugin-page[data-builtin="1"]');
const pages = () => [...$('#plugins').querySelectorAll('.plugin-page')];

// 请求切换主视图（由 main.js 的路由统一处理）
function requestView(view, plugin) {
  window.dispatchEvent(new CustomEvent('kohme:view', { detail: { view, plugin } }));
}

// 去掉 schema 里由别处管理的字段（name/seq 始终去；core 再去掉这几个无意义字段）
function commonSchemaFor(builtin) {
  const base = (schemas && schemas['kohme-plugin']) || PLUGIN_COMMON_SCHEMA;
  const root = base || {};
  const top = resolveSchema(root, root);
  const props = { ...(top.properties || {}) };
  ['name', 'seq'].forEach(k => delete props[k]);
  if (builtin) ['repo', 'version', 'disable', 'exclude'].forEach(k => delete props[k]);
  return { ...top, properties: props };
}

// ---- 单个插件页面（head + 简介/配置两页签）----
function pluginPage(p, opts = {}) {
  const isNew = !!opts.isNew;
  const builtin = p.name === 'core';
  const schema = isNew ? null : (schemas || {})[p.name];
  const showConf = !isNew;

  const page = el('div', { class: 'plugin-page' + (isNew ? ' isnew' : '') });
  page.id = cssId(p.name);
  page.dataset.name = p.name;
  page.dataset.builtin = builtin ? '1' : '0';
  page._isNew = isNew;
  page._deleted = false;
  page._seq = builtin ? 0 : (p.seq || 0);
  page._tab = 'config';            // 默认页签，简介加载成功后会切到 readme
  page._readmeLoaded = false;
  page._hasReadme = undefined;

  // ===== 页头：标题行 + 页签 =====
  const head = el('div', { class: 'pp-head' });

  const titleRow = el('div', { class: 'pp-titlerow' });
  titleRow.appendChild(el('span', { class: 'pp-name', text: p.name }));
  const statusTag = el('span', { class: 'tag' + (p.disable ? ' off' : ' ok'), text: p.disable ? '功能已禁用' : '已启用' });
  page._statusTag = statusTag;
  titleRow.appendChild(statusTag);
  if (p.exclude) titleRow.appendChild(el('span', { class: 'tag off', text: '不编译' }));
  if (builtin)   titleRow.appendChild(el('span', { class: 'tag off', text: '内置' }));
  if (isNew)     titleRow.appendChild(el('span', { class: 'tag new', text: '新增 · 未保存' }));
  const delTag = el('span', { class: 'tag del-tag', style: 'display:none', text: '待删除 · 保存后生效' });
  titleRow.appendChild(delTag);

  titleRow.appendChild(el('span', { class: 'spacer' }));

  if (!builtin) {
    const up = el('button', { class: 'btn btn--ghost btn--sm pp-move', title: '上移加载顺序', 'aria-label': '上移', text: '▲' });
    const down = el('button', { class: 'btn btn--ghost btn--sm pp-move', title: '下移加载顺序', 'aria-label': '下移', text: '▼' });
    up.onclick = () => movePage(page, -1);
    down.onclick = () => movePage(page, 1);
    titleRow.append(up, down);
  }
  const seqBadge = el('span', { class: 'seqbox', text: builtin ? '顺序 0' : '顺序 —' });
  seqBadge.title = '加载顺序 seq';
  page._seqBadge = seqBadge;
  titleRow.appendChild(seqBadge);
  head.appendChild(titleRow);

  // 页签
  const tabs = el('div', { class: 'pp-tabs' });
  const tabReadme = el('button', { class: 'pp-tab', 'data-tab': 'readme', text: '简介' });
  const tabConfig = el('button', { class: 'pp-tab', 'data-tab': 'config', text: '配置' });
  tabs.append(tabReadme, tabConfig);
  head.appendChild(tabs);
  page._tabs = { readme: tabReadme, config: tabConfig };
  page.appendChild(head);

  // ===== 简介页（懒加载）=====
  const readmePane = el('div', { class: 'plugin-pane', 'data-pane': 'readme' });
  page._readmePane = readmePane;
  page.appendChild(readmePane);

  // ===== 配置页（原卡片）=====
  const configPane = el('div', { class: 'plugin-pane', 'data-pane': 'config' });
  const card = el('div', { class: 'card' });

  // 公共字段（schema 驱动；name/seq 已剥离）
  const commonForm = buildForm(commonSchemaFor(builtin), p);
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

  // 行内操作（删除 / 撤销删除）
  const actions = el('div', { class: 'row-actions' });
  let delBtn = null, undelBtn = null;
  if (!builtin) {
    delBtn   = el('button', { class: 'btn btn--danger btn--sm', text: '删除插件' });
    undelBtn = el('button', { class: 'btn btn--ghost btn--sm', style: 'display:none', text: '撤销删除' });
    actions.append(delBtn, undelBtn);
  }
  card.appendChild(actions);
  configPane.appendChild(card);
  page.appendChild(configPane);

  // ---- DTO ----
  page._getDTO = function () {
    const common = commonForm.getValue();
    delete common.name; delete common.seq;
    const dto = { name: p.name, seq: builtin ? 0 : (Number(page._seq) || 0), ...common };
    if (showConf) {
      if (confGetter) dto.confValue = confGetter();
      else if (card._confTextarea) dto.confYaml = card._confTextarea.value;
    }
    return dto;
  };

  page.addEventListener('input', refreshDirty);
  page.addEventListener('change', refreshDirty);

  // ---- 页签切换 ----
  page._selectTab = function (which) {
    page._tab = which;
    tabReadme.classList.toggle('active', which === 'readme');
    tabConfig.classList.toggle('active', which === 'config');
    readmePane.classList.toggle('show', which === 'readme');
    configPane.classList.toggle('show', which === 'config');
    if (which === 'readme') ensureReadme(page);
  };
  tabReadme.onclick = () => page._selectTab('readme');
  tabConfig.onclick = () => page._selectTab('config');

  // ---- 删除 / 撤销 ----
  const setDisabled = (on) => page.querySelectorAll(
    'input,textarea,select,button.chip-x,button.arr-add,button.arr-del,button.map-add,button.map-del,.secret-toggle'
  ).forEach(x => x.disabled = on);

  if (delBtn) delBtn.onclick = () => {
    if (isNew) {
      const wasSelected = selected === page.dataset.name;
      page.remove(); renumber(); rebuildNav(); refreshDirty();
      if (wasSelected) { const f = firstName(); if (f) requestView('plugins', f); else requestView('add'); }
      return;
    }
    page._deleted = true;
    page.classList.add('pending-del');
    delTag.style.display = '';
    delBtn.style.display = 'none';
    undelBtn.style.display = '';
    setDisabled(true);
    renumber(); rebuildNav(); refreshDirty();
  };
  if (undelBtn) undelBtn.onclick = () => {
    page._deleted = false;
    page.classList.remove('pending-del');
    delTag.style.display = 'none';
    delBtn.style.display = '';
    undelBtn.style.display = 'none';
    setDisabled(false);
    renumber(); rebuildNav(); refreshDirty();
  };

  return page;
}

// 懒加载简介；若无 README 则隐藏「简介」页签并回落到配置页。
async function ensureReadme(page) {
  if (page._readmeLoaded) return;
  page._readmeLoaded = true;
  const name = page.dataset.name;
  const state = await renderReadmeInto(page._readmePane, name);
  page._hasReadme = state === 'ok';
  if (state !== 'ok') {
    page._tabs.readme.classList.add('hide');     // 没有简介就不展示该页签
    if (page._tab === 'readme') page._selectTab('config');
  }
}

// ---- 排序 ----
function movePage(page, dir) {
  const list = $('#plugins');
  const movable = pages().filter(p => p.dataset.builtin !== '1' && !p._deleted);
  const i = movable.indexOf(page);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= movable.length) return;
  const target = movable[j];
  if (dir < 0) list.insertBefore(page, target);
  else list.insertBefore(target, page);
  renumber(); rebuildNav(); refreshDirty();
}

// 顺序由 DOM 位置决定：core 钉第一、seq=0；其余非删除页按位置编号 1..n。
function renumber() {
  const list = $('#plugins');
  const core = corePage();
  if (core && list.firstElementChild !== core) list.insertBefore(core, list.firstElementChild);
  let n = 0;
  pages().forEach(page => {
    if (page.dataset.builtin === '1') {
      page._seq = 0;
      if (page._seqBadge) page._seqBadge.textContent = '顺序 0';
      return;
    }
    if (page._deleted) { if (page._seqBadge) page._seqBadge.textContent = '顺序 —'; return; }
    n++;
    page._seq = n;
    if (page._seqBadge) page._seqBadge.textContent = '顺序 ' + n;
  });
}

// 按给定名字顺序重排（导航栏拖动用）：core 强制第一
function applyOrder(names) {
  const list = $('#plugins');
  const byName = {};
  pages().forEach(c => { byName[c.dataset.name] = c; });
  const seen = {}; const ordered = [];
  const core = byName['core'];
  if (core) { ordered.push(core); seen['core'] = 1; }
  names.forEach(n => { if (byName[n] && !seen[n]) { ordered.push(byName[n]); seen[n] = 1; } });
  pages().forEach(c => { if (!seen[c.dataset.name]) { ordered.push(c); seen[c.dataset.name] = 1; } });
  ordered.forEach(c => list.appendChild(c));
  renumber(); rebuildNav(); refreshDirty();
}

// 容器级导航拖拽只装一次
function initDnd() {
  if (dndReady) return;
  dndReady = true;
  const nav = $('#pluginNav');
  if (!nav) return;
  nav.addEventListener('dragover', (e) => {
    const dragging = nav.querySelector('.nav-sub-link.dragging');
    if (!dragging) return;
    e.preventDefault();
    let after = getAfter(nav, e.clientY, '.nav-sub-link[data-name]:not(.dragging)');
    const coreLink = nav.querySelector('.nav-sub-link[data-name="core"]');
    if (after === coreLink) after = coreLink ? coreLink.nextElementSibling : null;
    if (after == null) nav.appendChild(dragging);
    else nav.insertBefore(dragging, after);
  });
  nav.addEventListener('drop', (e) => { e.preventDefault(); });
}

function getAfter(container, y, sel) {
  const els = [...container.querySelectorAll(sel)];
  let best = { offset: -Infinity, el: null };
  for (const child of els) {
    const box = child.getBoundingClientRect();
    const offset = y - box.top - box.height / 2;
    if (offset < 0 && offset > best.offset) best = { offset, el: child };
  }
  return best.el;
}

// ---- 左侧插件子导航 ----
function rebuildNav() {
  const nav = $('#pluginNav');
  if (!nav) return;
  nav.textContent = '';

  // ＋ 添加插件
  const addLink = el('a', { class: 'nav-sub-link nav-sub-add', href: '#' });
  addLink.appendChild(el('span', { class: 'nav-sub-name', text: '＋ 添加插件' }));
  addLink.addEventListener('click', e => { e.preventDefault(); requestView('add'); });
  nav.appendChild(addLink);

  pages().forEach(page => {
    const name = page.dataset.name;
    const builtin = page.dataset.builtin === '1';
    const a = el('a', { class: 'nav-sub-link', href: '#' + page.id });
    a.dataset.name = name;
    if (!builtin) {
      a.draggable = true;
      a.addEventListener('dragstart', () => a.classList.add('dragging'));
      a.addEventListener('dragend', () => {
        a.classList.remove('dragging');
        const order = [...nav.querySelectorAll('.nav-sub-link[data-name]')].map(x => x.dataset.name);
        applyOrder(order);
      });
      a.appendChild(el('span', { class: 'nav-grip', text: '⠿' }));
    }
    a.appendChild(el('span', { class: 'nav-sub-name', text: name }));
    if (page._deleted) a.classList.add('is-del');
    if (name === selected) a.classList.add('active');
    a.addEventListener('click', e => { e.preventDefault(); requestView('plugins', name); });
    nav.appendChild(a);
  });
}

// ---- 选中并显示某个插件页 ----
export function select(name) {
  const list = $('#plugins');
  if (!list) return;
  const all = pages();
  if (!all.length) { selected = null; return; }
  let target = all.find(p => p.dataset.name === name) || all.find(p => p.dataset.name === selected) || all[0];
  selected = target.dataset.name;
  all.forEach(p => p.classList.toggle('is-active', p === target));
  $$('#pluginNav .nav-sub-link').forEach(a =>
    a.classList.toggle('active', a.dataset.name === selected));
  target._selectTab(target._tab || 'readme');
  // 首次进入默认尝试简介；ensureReadme 若发现没有 README 会自动回落到配置
  if (!target._readmeLoaded) target._selectTab('readme');
}

export function firstName() {
  const p = $('#plugins') && $('#plugins').querySelector('.plugin-page');
  return p ? p.dataset.name : null;
}
export function selectedName() { return selected; }

// ---- 暂存收集 / diff / 脏状态 ----
function collectWork() {
  const out = [];
  pages().forEach(page => { if (!page._deleted) out.push(page._getDTO()); });
  return out;
}

function pluginDiff() {
  let committed = [];
  try { committed = JSON.parse(committedJSON); } catch (e) {}
  const byName = {};
  committed.forEach(p => { byName[p.name] = JSON.stringify(p); });
  let added = 0, modified = 0, removed = 0;
  pages().forEach(page => {
    const dto = page._getDTO();
    if (page._deleted) { if (dto.name in byName) removed++; return; }
    if (!(dto.name in byName)) added++;
    else if (JSON.stringify(dto) !== byName[dto.name]) modified++;
  });
  return { added, modified, removed, total: added + modified + removed };
}
export function diffTotal() { return pluginDiff().total; }

function refreshDirty() {
  const d = pluginDiff();
  const bar = $('#pluginDirty');
  if (!bar) return;
  if (d.total > 0) {
    const needBuild = d.added > 0 || d.removed > 0;
    $('#pluginDirtyText').textContent =
      `有未保存的插件更改：新增 ${d.added}，修改 ${d.modified}，删除 ${d.removed}。`
      + (needBuild ? '保存后将重新构建并重启。' : '保存后只需重启（无需重新构建）。');
    bar.classList.add('show');
  } else {
    bar.classList.remove('show');
  }
}

// ---- 渲染（由 config.load 调用）----
export function render(plugins, sch) {
  schemas = sch || {};
  initDnd();
  const list = $('#plugins');
  const prev = selected;
  list.innerHTML = '';
  (plugins || []).slice()
    .sort((a, b) => ((a.name === 'core' ? -1 : a.seq) - (b.name === 'core' ? -1 : b.seq)) || a.name.localeCompare(b.name))
    .forEach(p => list.appendChild(pluginPage(p, {})));
  renumber();
  committedJSON = JSON.stringify(collectWork());
  rebuildNav();
  refreshDirty();

  const names = pages().map(p => p.dataset.name);
  const empty = $('#pluginEmpty');
  if (empty) empty.classList.toggle('hide', names.length > 0);

  selected = (prev && names.includes(prev)) ? prev : (names[0] || null);
  if (selected) select(selected);
}

// ---- 保存 / 放弃 / 添加 ----
export async function save(btn) {
  const d = pluginDiff();
  const needBuild = d.added > 0 || d.removed > 0;
  if (btn) btn.disabled = true;
  const ok = await runOp(needBuild ? '保存插件更改并重新构建' : '保存插件更改并重启', () =>
    api('PUT', '/api/plugins?rebuild=' + (needBuild ? 'true' : 'false'), { plugins: collectWork() }));
  if (btn) btn.disabled = false;
  if (ok) {
    clearReadmeCache();           // 可能拉取了新版本插件，简介随之更新
    await deps.loadSchemas();
    await deps.load();
    toast(needBuild ? '插件已保存并重新构建' : '插件已保存并重启', 'ok');
  }
}

export function discard() {
  if (pluginDiff().total > 0 && !confirm('放弃所有未保存的插件更改？')) return;
  deps.load();
}

// 暂存一个新插件。未填 repo/version 时给默认值。新插件接在末尾，顺序由位置决定。
export function add({ name, repo, version }) {
  if (!name) { toast('请填写插件名', 'err'); return false; }
  let dup = false;
  pages().forEach(page => { if (!page._deleted && page.dataset.name === name) dup = true; });
  if (dup) { toast(`插件 ${name} 已在列表中`, 'err'); return false; }

  const finalRepo = (repo && repo.trim()) ? repo.trim() : `github.com/kohmebot/${name}`;
  const finalVer  = (version && version.trim()) ? version.trim() : 'latest';

  const p = { name, repo: finalRepo, version: finalVer, groups: [], disable: false, exclude: false };
  const page = pluginPage(p, { isNew: true });
  page._tab = 'config';           // 新插件还没 README，直接停在配置
  $('#plugins').appendChild(page);
  renumber(); rebuildNav(); refreshDirty();
  requestView('plugins', name);   // 跳到新插件页
  return true;
}
