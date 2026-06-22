// stream.js — SSE 实时流：状态、日志。
// "op" 流（构建/启停进度）→ 操作弹窗；"bot" 流（kohme 二进制输出）→ 底部运行日志台。

import { $, el } from './dom.js';
import { appendOpLog } from './ops.js';
import { loadSchemas, load } from './config.js';
import { diffTotal } from './plugins.js';

let es = null;
let lastRunning = false;

function renderStatus(s) {
  // 侧栏状态指示
  const wrap = $('#status');
  const state = s.building ? 'build' : (s.botRunning ? 'run' : 'stop');
  wrap.className = 'status ' + state;
  $('#statusMain').textContent = s.building ? '正在构建' : (s.botRunning ? '运行中' : '已停止');
  $('#statusSub').textContent  = s.building ? '请稍候…'  : (s.botRunning ? 'bot 正常运行' : 'bot 未运行');

  // 移动端细顶栏状态点
  const mini = $('#statusMini');
  if (mini) {
    mini.className = 'mh-status ' + state;
    const txt = $('#statusMiniTxt');
    if (txt) txt.textContent = s.building ? '构建中' : (s.botRunning ? '运行中' : '已停止');
  }

  // 顶栏按钮
  $('#btnRebuild').disabled = s.building;

  // 日志台实时指示
  $('#liveDot').classList.toggle('on', !!s.botRunning);

  // 提示横幅
  const b = $('#banner');
  if (s.building) {
    b.className = 'banner';
  } else if (s.needAction === 'rebuild') {
    b.innerHTML = '插件清单已变化，需要「重新构建并重启」才会生效。';
    b.className = 'banner show';
  } else if (s.lastBuild === 'failed') {
    b.innerHTML = '上次构建失败，请查看下方日志，bot 仍在用旧版本运行。';
    b.className = 'banner show';
  } else {
    b.className = 'banner';
  }

  if (s.botRunning && !lastRunning) scheduleSchemaRefresh();
  lastRunning = s.botRunning;
}

function appendLog(e) {
  if (e.stream === 'op') { appendOpLog(e); return; }   // 构建输出走操作弹窗
  const log = $('#log');
  const placeholder = log.querySelector('.empty');
  if (placeholder) placeholder.remove();
  const div = el('div', { class: 'l' }, [
    el('span', { class: 't', text: e.time || '' }),
    el('span', { class: 'bot', text: e.line || '' }),
  ]);
  log.appendChild(div);
  while (log.childNodes.length > 1200) log.removeChild(log.firstChild);
  if ($('#autoscroll').checked) log.scrollTop = log.scrollHeight;
}

// bot 重启后才写出 .schemas.json，写文件相对状态变更有延迟，
// 因此分几次拉取，确保新插件 schema 能被表单拾取。
// 注意：若此刻有未保存的暂存更改，只刷新 schema、不重渲染，避免冲掉正在编辑的内容。
function scheduleSchemaRefresh() {
  const refresh = () => loadSchemas().then(() => { if (diffTotal() === 0) load(); });
  setTimeout(refresh, 1000);
  setTimeout(refresh, 3000);
}

export function connect() {
  if (es) return;
  es = new EventSource('/api/stream', { withCredentials: true });
  es.onmessage = ev => {
    const e = JSON.parse(ev.data);
    if (e.type === 'status') renderStatus(e.status);
    else if (e.type === 'log') appendLog(e);
  };
  es.onerror = () => { /* EventSource 会自动重连 */ };
}
