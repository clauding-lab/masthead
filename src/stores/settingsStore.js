import { create } from 'zustand';

function getInitialTheme() {
  if (typeof window === 'undefined') return 'light';
  const stored = localStorage.getItem('masthead-theme');
  if (stored) return stored;
  return 'light'; // light-first by design
}

function applyTheme(theme) {
  const root = document.documentElement;
  if (theme === 'system') {
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    root.className = prefersDark ? 'dark' : '';
  } else if (theme === 'dark') {
    root.className = 'dark';
  } else {
    root.className = '';
  }
}

const useSettingsStore = create((set) => ({
  theme: getInitialTheme(),
  fontSize: 18,
  disabledSources: [],

  setTheme: (theme) => {
    localStorage.setItem('masthead-theme', theme);
    applyTheme(theme);
    set({ theme });
  },

  setFontSize: (fontSize) => {
    localStorage.setItem('masthead-fontSize', String(fontSize));
    set({ fontSize });
  },

  toggleSource: (sourceId) => {
    set((state) => {
      const disabled = state.disabledSources.includes(sourceId)
        ? state.disabledSources.filter((id) => id !== sourceId)
        : [...state.disabledSources, sourceId];
      localStorage.setItem('masthead-disabledSources', JSON.stringify(disabled));
      return { disabledSources: disabled };
    });
  },

  initFromStorage: () => {
    const theme = localStorage.getItem('masthead-theme') || 'light';
    const fontSize = parseInt(localStorage.getItem('masthead-fontSize') || '18', 10);
    const disabledSources = JSON.parse(
      localStorage.getItem('masthead-disabledSources') || '[]'
    );
    applyTheme(theme);
    set({ theme, fontSize, disabledSources });
  },
}));

export default useSettingsStore;
