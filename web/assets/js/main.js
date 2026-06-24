// main.js — 入口：装配各模块、绑定交互、启动。

import { $, $$ } from './dom.js';
import { api } from './api.js';
import { runOp, initOps } from './ops.js';
import { initAuth, logout, openChangePw, showAuth } from './auth.js';
import { loadSchemas, load, saveGlobal, saveDriver } from './config.js';
import * as Plugins from './plugins.js';
import { connect } from './stream.js';
import { initTheme } from './theme.js';

// 注入插件模块所需的重载依赖（打破循环依赖）
Plugins.bind({ load, loadSchemas });

// ---- 运行控制（构建/重启/启停）----
const ACTION_TITLES = { rebuild: '重新构建并重启', restart: '重启 bot', start: '启动 bot', stop: '停止 bot' };
async function action(kind, btn) {
  btn.disabled = true;
  try { await runOp(ACTION_TITLES[kind] || kind, () => api('POST', '/api/actions/' + kind)); }
  finally { setTimeout(() => { btn.disabled = false; }, 400); }
}

function wireEvent() {
  $('#btnRebuild').addEventListener('click', e => action('rebuild', e.currentTarget));
  $('#btnRestart').addEventListener('click', e => action('restart', e.currentTarget));
  $('#btnStart').addEventListener('click', e => action('start', e.currentTarget));
  $('#btnStop').addEventListener('click', e => action('stop', e.currentTarget));

  $('#saveGlobal').addEventListener('click', e => saveGlobal(e.currentTarget));
  $('#saveDriver').addEventListener('click', e => saveDriver(e.currentTarget));

  $('#savePlugins').addEventListener('click', e => Plugins.save(e.currentTarget));
  $('#discardPlugins').addEventListener('click', () => Plugins.discard());

  $('#addPlugin').addEventListener('click', () => {
    const ok = Plugins.add({
      name: $('#nName').value.trim(),
      repo: $('#nRepo').value.trim(),
      version: $('#nVer').value.trim(),
    });
    if (ok) { $('#nName').value = $('#nRepo').value = $('#nVer').value = ''; }
  });

  $('#nName').addEventListener('input',()=>{
    const name = nName.value.trim();
    if (name) {
      nRepo.placeholder = `github.com/kohmebot/${name}`;
    } else {
      nRepo.placeholder = '';
    }
  });

  $('#changePw').addEventListener('click', openChangePw);
  $('#logout').addEventListener('click', logout);

  $('#clearLog').addEventListener('click', () => {
    $('#log').innerHTML = '<div class="l empty">等待 bot 输出…</div>';
  });
  $('#consoleToggle').addEventListener('click', () => {
    document.body.classList.toggle('console-collapsed');
  });
}

// ---- 移动端抽屉：汉堡开 / 遮罩·关闭按钮·Esc 关，点导航后自动收起 ----
function initDrawer() {
  const open  = () => document.body.classList.add('drawer-open');
  const close = () => document.body.classList.remove('drawer-open');
  $('#drawerToggle') && $('#drawerToggle').addEventListener('click', open);
  $('#drawerClose')  && $('#drawerClose').addEventListener('click', close);
  $('#scrim')        && $('#scrim').addEventListener('click', close);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });
  // 抽屉内任意导航链接（区块链接 / 插件子导航）点击后收起，露出内容
  const side = $('.sidebar');
  if (side) side.addEventListener('click', e => { if (e.target.closest('a')) close(); });
}

// ---- 主视图路由：全局设置 / 驱动配置 / 插件（按插件分页）/ 添加插件 ----
// 顶层导航与插件子导航都通过 showView() 切换；任一时刻只显示一个视图。
function setTopNavActive(view) {
  const key = (view === 'add') ? 'plugins' : view;   // 添加插件归属「插件」
  $$('.nav > a').forEach(a => a.classList.toggle('active', a.dataset.view === key));
}

function showView(view, detail = {}) {
  const views = $$('.view');
  if (!views.some(v => v.dataset.view === view)) view = 'global';
  views.forEach(v => v.classList.toggle('is-active', v.dataset.view === view));
  setTopNavActive(view);
  if (view === 'plugins') {
    const name = detail.plugin || Plugins.selectedName() || Plugins.firstName();
    if (name) Plugins.select(name);
  }
  // 切视图回到顶部；移动端切完顺手收起抽屉
  window.scrollTo(0, 0);
  document.body.classList.remove('drawer-open');
}

function initNav() {
  $$('.nav > a').forEach(a => {
    a.addEventListener('click', e => { e.preventDefault(); showView(a.dataset.view); });
  });
  window.addEventListener('kohme:view', e => showView(e.detail.view, e.detail));
}

// ---- 启动 ----
async function boot() {
  try { await loadSchemas(); await load(); }
  catch (e) { if (e.message === '未授权') return; }
  // 选择初始视图：有插件就直接进入插件页，否则落到全局设置
  const first = Plugins.firstName();
  showView(first ? 'plugins' : 'global', first ? { plugin: first } : {});
  try {
    const st = await fetch('/api/auth/state', { credentials: 'include' }).then(r => r.json());
    if (st.username) {
      $('#acctName').textContent = st.username;
      $('#acctAvatar').textContent = (st.username[0] || '?').toUpperCase();
      $('#account').classList.remove('hide');
    }
  } catch (e) {}
  connect();
}

function start() {
  initTheme();
  initOps();
  initAuth(boot);
  wireEvent();
  initNav();
  initDrawer();

  // 移动端默认收起底部日志台，避免吃掉过多竖向空间（用户可随时点按展开）
  if (window.matchMedia && window.matchMedia('(max-width:600px)').matches) {
    document.body.classList.add('console-collapsed');
  }

  // 先探测是否已登录
  fetch('/api/config', { credentials: 'include' })
    .then(r => { if (r.status === 401) showAuth(); else boot(); })
    .catch(() => showAuth());
}

start();
