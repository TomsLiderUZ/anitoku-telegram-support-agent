/**
 * Theme is stored per browser and applied to <html data-theme>, which is what
 * the colour tokens key off. Dark is the default: this panel is watched at
 * night and a bright surface in a dark room is what people complain about.
 */
const KEY = 'anitoku.theme';

export const ThemeManager = {
  get() {
    try {
      return localStorage.getItem(KEY) || 'dark';
    } catch {
      return 'dark';
    }
  },
  set(theme) {
    const t = theme === 'light' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', t);
    try {
      localStorage.setItem(KEY, t);
    } catch {
      /* private mode — the choice simply will not persist */
    }
    return t;
  },
  toggle() {
    return ThemeManager.set(ThemeManager.get() === 'dark' ? 'light' : 'dark');
  },
  init() {
    return ThemeManager.set(ThemeManager.get());
  },
};
