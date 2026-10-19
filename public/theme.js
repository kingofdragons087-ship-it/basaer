(function () {
  const root = document.documentElement;
  const button = document.getElementById('themeToggle');
  const icon = document.getElementById('themeIcon');

  if (!button || !icon) return;

  function applyTheme(theme) {
    root.setAttribute('data-theme', theme);
    icon.textContent = theme === 'dark' ? '☀' : '☾';
    button.setAttribute(
      'aria-label',
      theme === 'dark' ? 'تفعيل الوضع الفاتح' : 'تفعيل الوضع الليلي'
    );

    try {
      localStorage.setItem('basaer-theme', theme);
    } catch (_) {}
  }

  let saved = 'light';
  try {
    saved = localStorage.getItem('basaer-theme') || 'light';
  } catch (_) {}

  applyTheme(saved);

  button.addEventListener('click', function () {
    const dark = root.getAttribute('data-theme') === 'dark';
    applyTheme(dark ? 'light' : 'dark');
  });
})();
