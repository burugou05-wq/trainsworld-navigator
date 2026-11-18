export const language = (() => {
  if (typeof document === 'undefined') return 'ja';
  try {
    const preference = localStorage.getItem('navigator-language');
    if (preference === 'en' || preference === 'ja') return preference;
  } catch {}
  return navigator.language.toLowerCase().startsWith('ja') ? 'ja' : 'en';
})();

export const t = (ja, en) => language === 'ja' ? ja : en;

export function localizePage() {
  document.documentElement.lang = language;
  if (language === 'en') {
    for (const node of document.querySelectorAll('[data-en]')) node.textContent = node.dataset.en;
    for (const attribute of ['aria-label', 'title', 'placeholder']) {
      for (const node of document.querySelectorAll('[data-en-' + attribute + ']')) {
        node.setAttribute(attribute, node.getAttribute('data-en-' + attribute));
      }
    }
  }
  const control = document.getElementById('language');
  control.value = language;
  control.addEventListener('change', () => {
    try {
      localStorage.setItem('navigator-language', control.value);
      location.reload();
    } catch {
      control.value = language;
    }
  });
}
