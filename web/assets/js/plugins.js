// plugins.js — 插件区控制器。
// 所有增删改都在前端“暂存”为卡片状态，最后点「保存并…」一次性提交（PUT /api/plugins）。
// 公共字段 schema 驱动（kohme-plugin，缺省回退默认 schema）；name 是身份、seq 由排序控件管理，
// 二者都从公共表单里剥离。内置插件 core 只保留必要字段，seq 固定 0 且不可改、不可拖动。
//
// 保存语义（④）：只有「新增 / 删除」插件才需要重新构建（rebuild=true）；仅修改配置（含改 seq、
// 改 conf）只需重启（rebuild=false）。
//
// 依赖通过 bind() 注入 load / loadSchemas，避免与 config 模块循环依赖。

import { $, el, toast } from './dom.js';
import { api } from './api.js';
import { runOp } from './ops.js';
import { buildForm,resolveSchema } from './schema-form.js';
import { PLUGIN_COMMON_SCHEMA } from './schema-defaults.js';


let schemas = {};
let committedJSON = '[]';
let deps = { load: async () => {}, loadSchemas: async () => {} };
let dndReady = false;

export function bind(d) { deps = { ...deps, ...d }; }

const cssId = (s) => 'plugin-' + String(s).replace(/[^a-zA-Z0-9_-]/g, '_');
const coreCard = () => $('#plugins').querySelector('.card[data-builtin="1"]');

// 去掉 schema 里由别处管理的字段（name/seq 始终去；core 再去掉这几个无意义字段）
function commonSchemaFor(builtin) {
  const base = (schemas && schemas['kohme-plugin']) || PLUGIN_COMMON_SCHEMA;
  const root = base || {};
  const top = resolveSchema(root, root);
  const props = { ...(top.properties || {}) };
  ['name', 'seq'].forEach(k => delete props[k]);
  if (builtin) ['repo', 'version', 'disable', 'exclude'].forEach(k => delete props[k]);   // ⑦
  return { ...top, properties: props };
}

// ---- 单个插件卡片 ----
function pluginCard(p, opts = {}) {
  const isNew = !!opts.isNew;
  const builtin = p.name === 'core';
  const schema = isNew ? null : (schemas || {})[p.name];
  const showConf = !isNew;

  const card = el('div', { class: 'card' + (isNew ? ' isnew' : '') + ' card--enter' });
  card.id = cssId(p.name);
  card.dataset.name = p.name;
  card.dataset.builtin = builtin ? '1' : '0';
  card._isNew = isNew;
  card._deleted = false;

  // 顶部：拖动柄 + 名称 + 状态标签 + 顺序控件
  const top = el('div', { class: 'top' });
  if (!builtin) {
    const grip = el('span', { class: 'grip', title: '拖动调整顺序', text: '⠿' });
    grip.draggable = true;
    wireCardDrag(grip, card);
    top.appendChild(grip);
  }
  top.appendChild(el('span', { class: 'name', text: p.name }));
  top.appendChild(el('span', { class: 'tag' + (p.disable ? ' off' : ' ok'), text: p.disable ? '功能已禁用' : '已启用' }));
  if (p.exclude) top.appendChild(el('span', { class: 'tag off', text: '不编译' }));
  if (builtin)   top.appendChild(el('span', { class: 'tag off', text: '内置' }));
  if (isNew)     top.appendChild(el('span', { class: 'tag new', text: '新增 · 未保存' }));
  const delTag = el('span', { class: 'tag del-tag', style: 'display:none', text: '待删除 · 保存后生效' });
  top.appendChild(delTag);

  // 顺序（seq = 加载顺序）：由卡片在列表中的位置决定（拖动调整），这里只读显示，core 固定 0
  top.appendChild(el('span', { class: 'spacer' }));
  const seqBadge = el('span', { class: 'seqbox', text: builtin ? '顺序 0' : '顺序 —' });
  seqBadge.title = '加载顺序 seq（拖动卡片或导航栏调整）';
  card._seqBadge = seqBadge;
  card._seq = builtin ? 0 : (p.seq || 0);
  top.appendChild(seqBadge);
  card.appendChild(top);

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

  // 行内操作
  const actions = el('div', { class: 'row-actions' });
  let delBtn = null, undelBtn = null;
  if (!builtin) {
    delBtn   = el('button', { class: 'btn btn--danger btn--sm', text: '删除' });
    undelBtn = el('button', { class: 'btn btn--ghost btn--sm', style: 'display:none', text: '撤销删除' });
    actions.append(delBtn, undelBtn);
  }
  card.appendChild(actions);

  card._getDTO = function () {
    const common = commonForm.getValue();
    delete common.name; delete common.seq;
    const dto = { name: p.name, seq: builtin ? 0 : (Number(card._seq) || 0), ...common };
    if (showConf) {
      if (confGetter) dto.confValue = confGetter();
      else if (card._confTextarea) dto.confYaml = card._confTextarea.value;
    }
    return dto;
  };

  card.addEventListener('input', refreshDirty);
  card.addEventListener('change', refreshDirty);

  if (delBtn) delBtn.onclick = () => {
    if (isNew) { card.remove(); renumber(); rebuildNav(); refreshDirty(); return; }
    card._deleted = true;
    card.classList.add('pending-del');
    delTag.style.display = '';
    delBtn.style.display = 'none';
    undelBtn.style.display = '';
    card.querySelectorAll('input,textarea,select,button.chip-x,button.arr-add,button.arr-del,button.map-add,button.map-del,.secret-toggle').forEach(x => x.disabled = true);
    renumber(); rebuildNav(); refreshDirty();
  };
  if (undelBtn) undelBtn.onclick = () => {
    card._deleted = false;
    card.classList.remove('pending-del');
    delTag.style.display = 'none';
    delBtn.style.display = '';
    undelBtn.style.display = 'none';
    card.querySelectorAll('input,textarea,select,button.chip-x,button.arr-add,button.arr-del,button.map-add,button.map-del,.secret-toggle').forEach(x => x.disabled = false);
    renumber(); rebuildNav(); refreshDirty();
  };

  return card;
}

// ---- 排序 / 拖动（⑩）----
let dragCard = null;

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

function wireCardDrag(grip, card) {
  grip.addEventListener('dragstart', (e) => {
    dragCard = card; card.classList.add('dragging');
    try { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', card.dataset.name); } catch (_) {}
  });
  grip.addEventListener('dragend', () => {
    card.classList.remove('dragging'); dragCard = null;
    renumber(); rebuildNav(); refreshDirty();
  });
}

// 顺序由 DOM 位置决定：core 钉在第一、seq=0；其余非删除卡片按位置编号 1..n。
// 把结果写进 card._seq 并刷新只读徽标。
function renumber() {
  const list = $('#plugins');
  const core = coreCard();
  if (core && list.firstElementChild !== core) list.insertBefore(core, list.firstElementChild);
  let n = 0;
  [...list.querySelectorAll('.card')].forEach(card => {
    if (card.dataset.builtin === '1') {
      card._seq = 0;
      if (card._seqBadge) card._seqBadge.textContent = '顺序 0';
      return;
    }
    if (card._deleted) return;                 // 待删除的不占编号，也不会被保存
    n++;
    card._seq = n;
    if (card._seqBadge) card._seqBadge.textContent = '顺序 ' + n;
  });
}

// 按给定名字顺序重排（导航栏拖动用）：core 强制第一，随后顺序重编号
function applyOrder(names) {
  const list = $('#plugins');
  const byName = {};
  [...list.querySelectorAll('.card')].forEach(c => { byName[c.dataset.name] = c; });
  const seen = {}; const ordered = [];
  const core = byName['core'];
  if (core) { ordered.push(core); seen['core'] = 1; }
  names.forEach(n => { if (byName[n] && !seen[n]) { ordered.push(byName[n]); seen[n] = 1; } });
  [...list.querySelectorAll('.card')].forEach(c => { if (!seen[c.dataset.name]) { ordered.push(c); seen[c.dataset.name] = 1; } });
  ordered.forEach(c => list.appendChild(c));
  renumber(); rebuildNav(); refreshDirty();
}

// 容器级 DnD 监听只装一次（render 清空的是 innerHTML，元素本身的监听不丢）
function initDnd() {
  if (dndReady) return;
  dndReady = true;
  const list = $('#plugins');
  if (list) list.addEventListener('dragover', (e) => {
    if (!dragCard) return;
    e.preventDefault();
    const core = coreCard();
    let after = getAfter(list, e.clientY, '.card:not(.dragging)');
    if (after === core) after = core ? core.nextElementSibling : null;   // 不得排到 core 之前
    if (after == null) list.appendChild(dragCard);
    else list.insertBefore(dragCard, after);
  });

  const nav = $('#pluginNav');
  if (nav) {
    nav.addEventListener('dragover', (e) => {
      const dragging = nav.querySelector('.nav-sub-link.dragging');
      if (!dragging) return;
      e.preventDefault();
      let after = getAfter(nav, e.clientY, '.nav-sub-link:not(.dragging)');
      const coreLink = nav.querySelector('.nav-sub-link[data-name="core"]');
      if (after === coreLink) after = coreLink ? coreLink.nextElementSibling : null;
      if (after == null) nav.appendChild(dragging);
      else nav.insertBefore(dragging, after);
    });
    nav.addEventListener('drop', (e) => { e.preventDefault(); });
  }
}

// ---- 侧栏插件导航（⑨）+ 滚动高亮 ----
let cardObs = null;
function rebuildNav() {
  const nav = $('#pluginNav');
  if (!nav) return;
  nav.textContent = '';
  const cards = [...$('#plugins').querySelectorAll('.card')];
  cards.forEach(card => {
    const name = card.dataset.name;
    const a = el('a', { class: 'nav-sub-link', href: '#' + card.id });
    a.dataset.name = name;
    const builtin = card.dataset.builtin === '1';
    if (!builtin) {
      a.draggable = true;
      a.addEventListener('dragstart', () => a.classList.add('dragging'));
      a.addEventListener('dragend', () => {
        a.classList.remove('dragging');
        const order = [...nav.querySelectorAll('.nav-sub-link')].map(x => x.dataset.name);
        applyOrder(order);
      });
      a.appendChild(el('span', { class: 'nav-grip', text: '⠿' }));
    }
    a.appendChild(el('span', { class: 'nav-sub-name', text: name }));
    if (card._deleted) a.classList.add('is-del');
    a.addEventListener('click', (e) => { e.preventDefault(); card.scrollIntoView({ behavior: 'smooth', block: 'start' }); });
    nav.appendChild(a);
  });
  observeCards(cards, nav);
}

function observeCards(cards, nav) {
  if (cardObs) cardObs.disconnect();
  if (!('IntersectionObserver' in window)) return;
  cardObs = new IntersectionObserver((ents) => {
    ents.forEach(en => {
      if (!en.isIntersecting) return;
      const links = [...nav.querySelectorAll('.nav-sub-link')];
      links.forEach(l => l.classList.remove('active'));
      const a = links.find(l => l.dataset.name === en.target.dataset.name);
      if (a) a.classList.add('active');
    });
  }, { rootMargin: '-45% 0px -50% 0px', threshold: 0 });
  cards.forEach(c => cardObs.observe(c));
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
  list.innerHTML = '';
  (plugins || []).slice()
    .sort((a, b) => ((a.name === 'core' ? -1 : a.seq) - (b.name === 'core' ? -1 : b.seq)) || a.name.localeCompare(b.name))
    .forEach(p => list.appendChild(pluginCard(p, {})));
  renumber();                       // 顺序归一为 0..n（顺序即 seq）
  committedJSON = JSON.stringify(collectWork());
  rebuildNav();
  refreshDirty();
}

// ---- 保存 / 放弃 / 添加 ----
export async function save(btn) {
  const d = pluginDiff();
  const needBuild = d.added > 0 || d.removed > 0;   // ④
  if (btn) btn.disabled = true;
  const ok = await runOp(needBuild ? '保存插件更改并重新构建' : '保存插件更改并重启', () =>
    api('PUT', '/api/plugins?rebuild=' + (needBuild ? 'true' : 'false'), { plugins: collectWork() }));
  if (btn) btn.disabled = false;
  if (ok) {
    await deps.loadSchemas();
    await deps.load();
    toast(needBuild ? '插件已保存并重新构建' : '插件已保存并重启', 'ok');
  }
}

export function discard() {
  if (pluginDiff().total > 0 && !confirm('放弃所有未保存的插件更改？')) return;
  deps.load();
}

// 暂存一个新插件。未填 repo/version 时给默认值（⑧）。新插件接在末尾，顺序（seq）由位置决定。
export function add({ name, repo, version }) {
  if (!name) { toast('请填写插件名', 'err'); return false; }
  let dup = false;
  $('#plugins').querySelectorAll('.card').forEach(card => {
    if (!card._deleted && card.dataset.name === name) dup = true;
  });
  if (dup) { toast(`插件 ${name} 已在列表中`, 'err'); return false; }

  const finalRepo = (repo && repo.trim()) ? repo.trim() : `github.com/kohmebot/${name}`;
  const finalVer  = (version && version.trim()) ? version.trim() : 'latest';

  const p = { name, repo: finalRepo, version: finalVer,
    groups: [], disable: false, exclude: false };
  const card = pluginCard(p, { isNew: true });
  $('#plugins').appendChild(card);
  renumber();                       // 追加在末尾 → 自动拿到最大的 seq
  rebuildNav();
  refreshDirty();
  card.scrollIntoView({ behavior: 'smooth', block: 'center' });
  return true;
}
