import { create } from 'zustand';
import sourcesData from '../../lib/sources.json';

function getInitialTheme() {
  if (typeof window === 'undefined') return 'light';
  const stored = localStorage.getItem('masthead-theme');
  if (stored) return stored;
  return 'light';
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

function loadSelectedSourceIds() {
  try {
    const stored = localStorage.getItem('masthead-selectedSources');
    if (stored) return new Set(JSON.parse(stored));
  } catch { /* ignore */ }
  // Default: all built-in sources selected
  return new Set(sourcesData.sources.map((s) => s.id));
}

function loadCustomSources() {
  try {
    const stored = localStorage.getItem('masthead-customSources');
    if (stored) return JSON.parse(stored);
  } catch { /* ignore */ }
  return [];
}

const useSettingsStore = create((set, get) => ({
  theme: getInitialTheme(),
  fontSize: 18,
  selectedSourceIds: loadSelectedSourceIds(),
  customSources: loadCustomSources(),

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
      const next = new Set(state.selectedSourceIds);
      if (next.has(sourceId)) {
        if (next.size <= 1) return state; // must keep at least 1
        next.delete(sourceId);
      } else {
        next.add(sourceId);
      }
      localStorage.setItem('masthead-selectedSources', JSON.stringify([...next]));
      return { selectedSourceIds: next };
    });
  },

  addCustomSource: (source) => {
    const id = `custom-${Date.now()}`;
    const newSource = { ...source, id };
    set((state) => {
      const customSources = [...state.customSources, newSource];
      const selectedSourceIds = new Set(state.selectedSourceIds);
      selectedSourceIds.add(id);
      localStorage.setItem('masthead-customSources', JSON.stringify(customSources));
      localStorage.setItem('masthead-selectedSources', JSON.stringify([...selectedSourceIds]));
      return { customSources, selectedSourceIds };
    });
    return id;
  },

  removeCustomSource: (sourceId) => {
    set((state) => {
      const customSources = state.customSources.filter((s) => s.id !== sourceId);
      const selectedSourceIds = new Set(state.selectedSourceIds);
      selectedSourceIds.delete(sourceId);
      localStorage.setItem('masthead-customSources', JSON.stringify(customSources));
      localStorage.setItem('masthead-selectedSources', JSON.stringify([...selectedSourceIds]));
      return { customSources, selectedSourceIds };
    });
  },

  // Returns the full source objects the user has enabled
  getEffectiveSources: () => {
    const { selectedSourceIds, customSources } = get();
    const defaults = sourcesData.sources.filter((s) => selectedSourceIds.has(s.id));
    const custom = customSources.filter((s) => selectedSourceIds.has(s.id));
    return [...defaults, ...custom];
  },

  // Returns ALL sources (enabled + disabled) for the settings UI
  getAllSources: () => {
    const { customSources } = get();
    return [...sourcesData.sources, ...customSources];
  },

  initFromStorage: () => {
    const theme = localStorage.getItem('masthead-theme') || 'light';
    const fontSize = parseInt(localStorage.getItem('masthead-fontSize') || '18', 10);
    const selectedSourceIds = loadSelectedSourceIds();
    const customSources = loadCustomSources();
    applyTheme(theme);
    set({ theme, fontSize, selectedSourceIds, customSources });
  },
}));

export default useSettingsStore;
