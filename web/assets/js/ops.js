// ops.js — 操作弹窗：展示构建 / 启停 / 重启等操作的实时输出。
// 构建输出经 SSE 的 "op" 流流入（见 stream.js 调用 appendOpLog）。

import { $, el } from './dom.js';

let opActive = false;

function openOp(title) {
  opActive = true;
  $('#opTitle').textContent = title;
  $('#opLog').innerHTML = '';
  $('#opState').textContent = '进行中…';
  $('#opState').className = 'opstate running';
  $('#opSpin').classList.remove('hide');
  $('#opClose').disabled = true;
  $('#opOverlay').classList.remove('hide');
}

function finishOp(ok, msg) {
  opActive = false;
  $('#opSpin').classList.add('hide');
  $('#opClose').disabled = false;
  $('#opState').textContent = msg || (ok ? '完成' : '失败');
  $('#opState').className = 'opstate ' + (ok ? 'ok' : 'err');
}

export function closeOp() {
  if (opActive) return;            // 操作进行中不允许关闭
  $('#opOverlay').classList.add('hide');
}

// 实时追加一行操作输出
export function appendOpLog(e) {
  const log = $('#opLog');
  const div = el('div', { class: 'l' }, [
    el('span', { class: 't', text: e.time || '' }),
    el('span', { class: 'line', text: e.line || '' }),
  ]);
  log.appendChild(div);
  while (log.childNodes.length > 3000) log.removeChild(log.firstChild);
  log.scrollTop = log.scrollHeight;
}

// runOp(title, fn)：打开弹窗 → 执行 fn（会触发后端构建/重启）→ 落地成功/失败。
// 返回是否成功。失败时后端已回滚配置，构建错误已在弹窗内显示。
export async function runOp(title, fn) {
  openOp(title);
  try {
    await fn();
    finishOp(true, '完成');
    return true;
  } catch (e) {
    finishOp(false, e.message || '失败');
    return false;
  }
}

// 绑定弹窗关闭按钮
export function initOps() {
  $('#opClose').addEventListener('click', closeOp);
}
