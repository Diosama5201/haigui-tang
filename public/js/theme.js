/**
 * 昼夜主题切换（开灯 / 关灯）
 * - 白天模式（默认）：右上角开关显示小月亮，点击「关灯」
 * - 黑夜模式：右上角开关显示发光小太阳，点击「开灯」
 * - 偏好持久化到 localStorage，页面加载前先设置 data-theme 避免闪白
 */
(function () {
  var KEY = 'ht_theme';
  var saved = 'light';
  try {
    saved = localStorage.getItem(KEY) === 'dark' ? 'dark' : 'light';
  } catch (e) { /* localStorage 不可用时保持白天模式 */ }

  function apply(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    var icon = document.getElementById('themeIcon');
    var btn = document.getElementById('themeToggle');
    if (icon) icon.textContent = theme === 'dark' ? '☀️' : '🌙';
    if (btn) btn.title = theme === 'dark' ? '开灯' : '关灯';
  }

  apply(saved);

  document.addEventListener('DOMContentLoaded', function () {
    var btn = document.getElementById('themeToggle');
    if (!btn) return;
    apply(document.documentElement.getAttribute('data-theme') || saved);
    btn.addEventListener('click', function () {
      var next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      try { localStorage.setItem(KEY, next); } catch (e) {}
      apply(next);
    });
  });
})();
