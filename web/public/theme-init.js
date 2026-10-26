// Runs before the page renders, including before the main application loads.
(() => {
  let preference;
  try {
    preference = localStorage.getItem('blackout.theme');
  } catch {
    /* Storage is optional. */
  }
  const dark =
    preference === 'dark' ||
    (preference !== 'light' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.classList.toggle('dark', dark);
})();
