// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { buildCatalogIndex } from '../../lib/catalogIndex';
import sourcesData from '../../lib/sources.json';
import useSettingsStore, { healSelectedIds } from './settingsStore';
import { sourceKind } from '../lib/sourceKind';

describe('healSelectedIds', () => {
  const IDX = buildCatalogIndex({ sources: [{ id: 'new-slug', aliases: ['old-slug'] }] });
  it('rewrites aliased ids to canonical, 1:1', () => {
    expect(healSelectedIds(['old-slug', 'other'], IDX)).toEqual(['new-slug', 'other']);
  });
  it('returns the same reference when nothing changed', () => {
    const ids = ['new-slug', 'other'];
    expect(healSelectedIds(ids, IDX)).toBe(ids);
  });
});

describe('kind-aware defaults and selectors', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('default selection (no localStorage) is news-kind catalog only', () => {
    useSettingsStore.getState().initFromStorage();
    const ids = useSettingsStore.getState().selectedSourceIds;
    const newsIds = sourcesData.sources.filter((s) => sourceKind(s) === 'news').map((s) => s.id);
    expect(ids).toEqual(newsIds);
  });

  it('getEffectiveSourcesByKind splits enabled sources by kind', () => {
    const blogId = sourcesData.sources.find((s) => s.kind === 'blog').id;
    const socialId = sourcesData.sources.find((s) => s.kind === 'social').id;
    useSettingsStore.setState({
      selectedSourceIds: ['daily-star', blogId, socialId],
      customSources: [],
    });
    const byKind = (k) => useSettingsStore.getState().getEffectiveSourcesByKind(k).map((s) => s.id);
    expect(byKind('news')).toEqual(['daily-star']);
    expect(byKind('blog')).toEqual([blogId]);
    expect(byKind('social')).toEqual([socialId]);
  });

  it('a custom source without kind counts as news', () => {
    useSettingsStore.setState({
      selectedSourceIds: ['custom-1'],
      customSources: [{ id: 'custom-1', name: 'X', category: 'custom' }],
    });
    expect(useSettingsStore.getState().getEffectiveSourcesByKind('news').map((s) => s.id)).toEqual(['custom-1']);
  });
});
