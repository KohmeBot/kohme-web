// auth.js — 登录 / 首次设置 / 退出 / 修改密码。监听 api 派发的 'kohme:unauthorized'。

import { $, toast } from './dom.js';
import { rawPost } from './api.js';

let authConfigured = true;
let onAuthed = () => {};

export function initAuth(cb) {
  onAuthed = cb || (() => {});
  window.addEventListener('kohme:unauthorized', showAuth);

  // 登录弹窗
  $('#authBtn').addEventListener('click', submitAuth);
  ['#aTok', '#aUser', '#aPass'].forEach(sel =>
    $(sel).addEventListener('keydown', e => { if (e.key === 'Enter') submitAuth(); }));

  // 改密弹窗
  $('#pwSubmit').addEventListener('click', submitChangePw);
  $('#pwCancel').addEventListener('click', () => $('#pwOverlay').classList.add('hide'));
  ['#pwOld', '#pwNew'].forEach(sel =>
    $(sel).addEventListener('keydown', e => { if (e.key === 'Enter') submitChangePw(); }));
}

export async function showAuth() {
  try { authConfigured = !!(await fetch('/api/auth/state').then(r => r.json())).configured; }
  catch (e) { authConfigured = true; }
  const setup = !authConfigured;
  $('#authTitle').textContent = setup ? '首次设置账户' : '登录';
  $('#authHint').textContent = setup
    ? '还没有账户。用后台启动时终端打印的初始化口令，创建你的账号和密码。' : '';
  $('#setupToken').classList.toggle('hide', !setup);
  $('#authBtn').textContent = setup ? '创建账户并进入' : '进入';
  $('#authErr').textContent = '';
  $('#overlay').classList.remove('hide');
  (setup ? $('#aTok') : $('#aUser')).focus();
}

async function submitAuth() {
  const user = $('#aUser').value.trim(), pass = $('#aPass').value;
  $('#authErr').textContent = '';
  try {
    if (!authConfigured) {
      await rawPost('/api/auth/setup', { token: $('#aTok').value, username: user, password: pass });
    } else {
      await rawPost('/api/login', { username: user, password: pass });
    }
    $('#overlay').classList.add('hide');
    $('#aPass').value = '';
    onAuthed();
  } catch (e) { $('#authErr').textContent = e.message || '失败，请重试'; }
}

export async function logout() {
  try { await rawPost('/api/logout', {}); } catch (e) {}
  location.reload();
}

export function openChangePw() {
  $('#pwOld').value = ''; $('#pwNew').value = ''; $('#pwErr').textContent = '';
  $('#pwOverlay').classList.remove('hide');
  $('#pwOld').focus();
}

async function submitChangePw() {
  const oldp = $('#pwOld').value, newp = $('#pwNew').value;
  $('#pwErr').textContent = '';
  if (!newp) { $('#pwErr').textContent = '请输入新密码'; return; }
  try {
    await rawPost('/api/auth/change', { oldPassword: oldp, newPassword: newp });
    $('#pwOverlay').classList.add('hide');
    toast('密码已修改，下次登录请用新密码', 'ok');
  } catch (e) { $('#pwErr').textContent = '修改失败：' + (e.message || '请重试'); }
}
