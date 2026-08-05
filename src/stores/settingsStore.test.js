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

// Task 16: security-relevant default (remote images in newsletter bodies
// are a tracking-pixel vector — InboxMessagePage.jsx blocks them unless
// this is explicitly opted into), persisted like the theme/fontSize
// siblings above.
describe('alwaysLoadRemoteImages', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('defaults to false with no localStorage value', () => {
    useSettingsStore.getState().initFromStorage();
    expect(useSettingsStore.getState().alwaysLoadRemoteImages).toBe(false);
  });

  it('setAlwaysLoadRemoteImages(true) updates state and persists to localStorage', () => {
    useSettingsStore.getState().setAlwaysLoadRemoteImages(true);
    expect(useSettingsStore.getState().alwaysLoadRemoteImages).toBe(true);
    expect(localStorage.getItem('masthead-alwaysLoadRemoteImages')).toBe('true');
  });

  it('initFromStorage restores a persisted true value', () => {
    localStorage.setItem('masthead-alwaysLoadRemoteImages', 'true');
    useSettingsStore.getState().initFromStorage();
    expect(useSettingsStore.getState().alwaysLoadRemoteImages).toBe(true);
  });

  it('setAlwaysLoadRemoteImages(false) flips it back off and persists', () => {
    localStorage.setItem('masthead-alwaysLoadRemoteImages', 'true');
    useSettingsStore.getState().initFromStorage();
    useSettingsStore.getState().setAlwaysLoadRemoteImages(false);
    expect(useSettingsStore.getState().alwaysLoadRemoteImages).toBe(false);
    expect(localStorage.getItem('masthead-alwaysLoadRemoteImages')).toBe('false');
  });
});
