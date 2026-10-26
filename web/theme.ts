const sun =
  '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/>';
const moon = '<path d="M20.8 13A9 9 0 0 1 11 3.2 9 9 0 1 0 20.8 13Z"/>';
export function themeControl() {
  return '<button class="quiet theme-toggle" id="theme" type="button" aria-label="Alternar tema" title="Alternar tema"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><path d="M20.8 13A9 9 0 0 1 11 3.2 9 9 0 1 0 20.8 13Z"/></svg></button>';
}
export function syncThemeControl() {
  const dark = document.documentElement.classList.contains('dark');
  document.querySelectorAll<HTMLButtonElement>('.theme-toggle').forEach((button) => {
    button.title = dark ? 'Usar tema claro' : 'Usar tema escuro';
    button.setAttribute('aria-pressed', String(dark));
    button.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true">${dark ? sun : moon}</svg>`;
  });
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', dark ? '#0c1424' : '#f5f7fb');
}
export function toggleTheme() {
  const dark = document.documentElement.classList.toggle('dark');
  try {
    localStorage.setItem('blackout.theme', dark ? 'dark' : 'light');
  } catch {
    /* Still works for this page. */
  }
  syncThemeControl();
}
