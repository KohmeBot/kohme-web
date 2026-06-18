// main.js — 入口：装配各模块、绑定交互、启动。

import { $, $$ } from './dom.js';
import { api } from './api.js';
import { runOp, initOps } from './ops.js';
import { initAuth, logout, openChangePw, showAuth } from './auth.js';
import { loadSchemas, load, saveGlobal, saveDriver } from './config.js';
import * as Plugins from './plugins.js';
import { connect } from './stream.js';

// 注入插件模块所需的重载依赖（打破循环依赖）
Plugins.bind({ load, loadSchemas });

// ---- 运行控制（构建/重启/启停）----
const ACTION_TITLES = { rebuild: '重新构建并重启', restart: '重启 bot', start: '启动 bot', stop: '停止 bot' };
async function action(kind, btn) {
  btn.disabled = true;
  try { await runOp(ACTION_TITLES[kind] || kind, () => api('POST', '/api/actions/' + kind)); }
  finally { setTimeout(() => { btn.disabled = false; }, 400); }
}

function wireButtons() {
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

  $('#changePw').addEventListener('click', openChangePw);
  $('#logout').addEventListener('click', logout);

  $('#clearLog').addEventListener('click', () => {
    $('#log').innerHTML = '<div class="l empty">等待 bot 输出…</div>';
  });
  $('#consoleToggle').addEventListener('click', () => {
    document.body.classList.toggle('console-collapsed');
  });
}

// ---- 侧栏导航：滚动高亮当前区块（仅顶层区块链接；插件子导航由 plugins.js 维护）----
function initNav() {
  const links = $$('.nav > a');
  const byId = {};
  links.forEach(a => { byId[a.getAttribute('href').slice(1)] = a; });
  const sections = $$('.section');
  if (!('IntersectionObserver' in window) || !sections.length) return;
  const obs = new IntersectionObserver(entries => {
    entries.forEach(en => {
      if (en.isIntersecting) {
        links.forEach(a => a.classList.remove('active'));
        const a = byId[en.target.id];
        if (a) a.classList.add('active');
      }
    });
  }, { rootMargin: '-45% 0px -50% 0px', threshold: 0 });
  sections.forEach(s => obs.observe(s));
}

// ---- 启动 ----
async function boot() {
  try { await loadSchemas(); await load(); }
  catch (e) { if (e.message === '未授权') return; }
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
  initOps();
  initAuth(boot);
  wireButtons();
  initNav();
  // 先探测是否已登录
  fetch('/api/config', { credentials: 'include' })
    .then(r => { if (r.status === 401) showAuth(); else boot(); })
    .catch(() => showAuth());
}

start();
