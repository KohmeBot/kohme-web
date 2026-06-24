// theme.js — 白天/黑夜主题切换。
// 初始主题由 index.html <head> 内联脚本在首帧前写入 <html data-theme>，避免闪烁；
// 这里只负责：绑定切换按钮、记住选择、切换时给一段平滑的整页色彩过渡。

import { $ } from './dom.js';

const KEY = 'kohme-theme';

function current() {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
}

function apply(theme) {
  const root = document.documentElement;
  root.classList.add('theme-transition');
  root.dataset.theme = theme;
  try { localStorage.setItem(KEY, theme); } catch (e) {}
  // 过渡结束后撤掉临时 class，避免常态交互也跟着做长过渡
  window.clearTimeout(apply._t);
  apply._t = window.setTimeout(() => root.classList.remove('theme-transition'), 540);
  syncLabels();
}

function syncLabels() {
  const dark = current() === 'dark';
  ['#themeToggle', '#themeToggleMini'].forEach(sel => {
    const b = $(sel);
    if (!b) return;
    b.setAttribute('aria-pressed', String(dark));
    b.setAttribute('title', dark ? '切换到白天模式' : '切换到黑夜模式');
    b.setAttribute('aria-label', dark ? '切换到白天模式' : '切换到黑夜模式');
  });
}

function toggle() { apply(current() === 'dark' ? 'light' : 'dark'); }

export function initTheme() {
  ['#themeToggle', '#themeToggleMini'].forEach(sel => {
    const b = $(sel);
    if (b) b.addEventListener('click', toggle);
  });

  // 若用户从未手动选择，跟随系统切换
  try {
    const mq = window.matchMedia('(prefers-color-scheme:dark)');
    mq.addEventListener('change', e => {
      if (!localStorage.getItem(KEY)) apply(e.matches ? 'dark' : 'light');
    });
  } catch (e) {}

  syncLabels();
}
